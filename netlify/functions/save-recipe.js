// netlify/functions/save-recipe.js
//
// One endpoint, three operations (decided by request body):
//   { recipe, password, imageDataUrl? }   → add or update
//   { deleteId, password }                → delete
//
// Auth: shared password compared in constant time against env var ADMIN_PASSWORD.
// Storage: data/recipes.json (the array) and images/<id>.<ext> (one file per photo),
// all committed to the configured repo + branch using the GitHub Git Data API so
// each save is a single commit containing all the changed files together.
//
// Required env vars:
//   GITHUB_TOKEN      Fine-grained PAT with Contents: Read+Write on the target repo.
//   GITHUB_REPO       owner/name, e.g.  starfish/cookbook
//   GITHUB_BRANCH     default: main
//   ADMIN_PASSWORD    the write password the front-end sends

import crypto from 'node:crypto';

const GH = 'https://api.github.com';

function eq(a, b) {
  const A = Buffer.from(String(a || ''));
  const B = Buffer.from(String(b || ''));
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

async function gh(token, path, init = {}) {
  const res = await fetch(`${GH}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'cookbook-fn',
      ...(init.headers || {})
    }
  });
  if (!res.ok) {
    const t = await res.text();
    const err = new Error(`GitHub ${res.status}: ${t.slice(0, 240)}`);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

function j(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function safeId(id) {
  return String(id).replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 80);
}

export default async (req) => {
  if (req.method !== 'POST') return j({ error: 'Method not allowed' }, 405);

  const {
    GITHUB_TOKEN,
    GITHUB_REPO,
    GITHUB_BRANCH = 'main',
    ADMIN_PASSWORD
  } = process.env;

  if (!GITHUB_TOKEN || !GITHUB_REPO || !ADMIN_PASSWORD) {
    return j({ error: 'Server not configured. Set GITHUB_TOKEN, GITHUB_REPO, ADMIN_PASSWORD in Netlify.' }, 500);
  }

  let body;
  try { body = await req.json(); }
  catch { return j({ error: 'Bad JSON' }, 400); }

  if (!eq(body.password, ADMIN_PASSWORD)) {
    return j({ error: 'Bad password' }, 401);
  }

  const { recipe, deleteId, imageDataUrl } = body;

  if (!deleteId && (!recipe || !recipe.id || !recipe.title)) {
    return j({ error: 'Missing recipe.id or recipe.title' }, 400);
  }
  // Hard ceiling on payload size. Netlify sync functions cap at ~6MB request.
  if (imageDataUrl && imageDataUrl.length > 4 * 1024 * 1024) {
    return j({ error: 'Image too large — resize on the client first.' }, 413);
  }

  // Retry on race conditions (someone else committed between our read and write).
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const out = await commit({
        token: GITHUB_TOKEN,
        repo: GITHUB_REPO,
        branch: GITHUB_BRANCH,
        recipe,
        deleteId,
        imageDataUrl
      });
      return j(out);
    } catch (e) {
      const retryable =
        e.status === 409 ||
        e.status === 422 ||
        /not a fast forward/i.test(e.message);
      if (attempt < 2 && retryable) {
        await new Promise(r => setTimeout(r, 300 + attempt * 400));
        continue;
      }
      console.error(e);
      return j({ error: e.message }, 500);
    }
  }
};

async function commit({ token, repo, branch, recipe, deleteId, imageDataUrl }) {
  // 1. Current tip of the branch
  const ref = await gh(token, `/repos/${repo}/git/refs/heads/${branch}`);
  const parentSha = ref.object.sha;
  const parentCommit = await gh(token, `/repos/${repo}/git/commits/${parentSha}`);
  const baseTreeSha = parentCommit.tree.sha;

  // 2. Read current recipes.json (404 = first run, start empty)
  let recipes = [];
  try {
    const file = await gh(token, `/repos/${repo}/contents/data/recipes.json?ref=${branch}`);
    recipes = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
    if (!Array.isArray(recipes)) recipes = [];
  } catch (e) {
    if (e.status !== 404) throw e;
  }

  const tree = [];
  let message;

  if (deleteId) {
    const found = recipes.find(r => r.id === deleteId);
    if (!found) throw new Error('Recipe not found');
    recipes = recipes.filter(r => r.id !== deleteId);
    message = `Delete recipe: ${found.title}`;
    // The orphan image stays in /images. Cheap to leave; cleanup is a separate task.
  } else {
    // Upload image (if any) as a blob, point recipe.image at it.
    if (imageDataUrl && /^data:image\//.test(imageDataUrl)) {
      const m = imageDataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
      if (m) {
        const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
        const path = `images/${safeId(recipe.id)}.${ext}`;
        const blob = await gh(token, `/repos/${repo}/git/blobs`, {
          method: 'POST',
          body: JSON.stringify({ content: m[2], encoding: 'base64' })
        });
        tree.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
        recipe.image = '/' + path;
      }
    }

    const i = recipes.findIndex(r => r.id === recipe.id);
    if (i >= 0) {
      // Preserve existing image if the edit didn't include a new one
      if (!recipe.image && recipes[i].image) recipe.image = recipes[i].image;
      recipes[i] = recipe;
      message = `Update recipe: ${recipe.title}`;
    } else {
      recipes.unshift(recipe);
      message = `Add recipe: ${recipe.title}`;
    }
  }

  // 3. Blob for the updated recipes.json
  const jsonBlob = await gh(token, `/repos/${repo}/git/blobs`, {
    method: 'POST',
    body: JSON.stringify({
      content: Buffer.from(JSON.stringify(recipes, null, 2)).toString('base64'),
      encoding: 'base64'
    })
  });
  tree.push({ path: 'data/recipes.json', mode: '100644', type: 'blob', sha: jsonBlob.sha });

  // 4. Tree → commit → update ref. One commit, all files.
  const newTree = await gh(token, `/repos/${repo}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({ base_tree: baseTreeSha, tree })
  });
  const newCommit = await gh(token, `/repos/${repo}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({ message, tree: newTree.sha, parents: [parentSha] })
  });
  await gh(token, `/repos/${repo}/git/refs/heads/${branch}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: newCommit.sha })
  });

  return { ok: true, recipes, commit: newCommit.sha };
}

export const config = { path: '/api/save-recipe' };
