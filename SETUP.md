# The Cookbook — Setup

A static cookbook site where the **+** button commits new recipes (and images)
straight to your GitHub repo via a Netlify Function. The repo is the database.

## Files

```
.
├── index.html                          ← the front-end (read + write UI)
├── netlify.toml                        ← Netlify config
├── data/
│   └── recipes.json                    ← the recipe database (read by index.html, edited by the function)
├── images/                             ← image files created by the function on save
└── netlify/
    └── functions/
        └── save-recipe.js              ← the write proxy
```

## One-time setup

### 1. Create the repo

Push these files to a new GitHub repo. Branch can be `main` (the function defaults to it).

```bash
git init
git add .
git commit -m "Initial cookbook"
git branch -M main
git remote add origin git@github.com:<you>/<cookbook-repo>.git
git push -u origin main
```

### 2. Create a fine-grained GitHub token

GitHub → Settings → Developer settings → **Personal access tokens** → Fine-grained tokens → **Generate new token**.

- Token name: `cookbook-write`
- Expiration: your call (90 days is reasonable; you'll set a calendar reminder to rotate)
- Repository access: **Only select repositories** → pick your cookbook repo
- Repository permissions:
  - **Contents**: Read and write
  - (Metadata: Read-only is auto-included)

Generate and copy the token. You will not see it again.

### 3. Connect the repo to Netlify

Netlify → Add new site → **Import from Git** → choose your repo.

- Build command: *(leave empty)*
- Publish directory: `.`
- Functions directory: `netlify/functions` *(auto-detected from netlify.toml)*

### 4. Set environment variables

Netlify site → Site configuration → **Environment variables** → add:

| Key              | Value                                                    |
| ---------------- | -------------------------------------------------------- |
| `GITHUB_TOKEN`   | the PAT from step 2                                      |
| `GITHUB_REPO`    | `<you>/<cookbook-repo>` (owner/name, no URL, no `.git`)  |
| `GITHUB_BRANCH`  | `main` *(optional — this is the default)*                |
| `ADMIN_PASSWORD` | any passphrase you choose — this is what you'll type in the **+** form |

After saving the env vars, **trigger a redeploy** (Deploys tab → Trigger deploy → Deploy site) so the function picks them up.

### 5. (Optional) Custom subdomain

Domain management → Add custom domain → `cookbook.yourstudio.com`. Add a CNAME record at your DNS host pointing to `<site>.netlify.app`. HTTPS auto-provisions.

## Using it

- Visit the live URL — recipes load from `data/recipes.json`.
- Tap **+** to add. First save on a device prompts for `ADMIN_PASSWORD`; it's then cached in localStorage on that device until you tap **Sign out**.
- After hitting Save, the function makes one git commit (image + JSON together) and returns the updated array. The UI updates instantly; the live site catches up after Netlify's rebuild (~30–60s).
- Edit/Delete from any recipe view.
- **Export** downloads `data/recipes.json` for offline backup.

## How a save becomes a commit

1. Browser resizes image to ≤1100px, JPEG quality 0.82 → base64 data URL.
2. POST to `/api/save-recipe` with `{ recipe, imageDataUrl, password }`.
3. Function (`netlify/functions/save-recipe.js`) constant-time-compares the password against `ADMIN_PASSWORD`.
4. Function reads the current `data/recipes.json` from the repo and mutates the array in memory.
5. Function uses the GitHub **Git Data API** to:
   - Create a blob for the image at `images/<recipe-id>.jpg`
   - Create a blob for the new `data/recipes.json`
   - Build a tree containing both, parented on the current tree
   - Create a commit (`"Add recipe: <title>"`) on that tree
   - Fast-forward `refs/heads/main` to the new commit
6. One commit per save. Git history reads like a changelog of your kitchen.

## Security notes

- The site is publicly readable. Anyone with the URL can browse recipes — no auth.
- Writes require `ADMIN_PASSWORD`. The token never reaches the browser; it lives only in Netlify's env vars.
- 401 responses clear the cached password so a typo doesn't lock you in.
- Rotate `GITHUB_TOKEN` when it expires; update the env var; redeploy. No code change.

## Troubleshooting

- **"Server not configured"** → an env var is missing. Check all four are set, then redeploy.
- **"Bad password"** → `ADMIN_PASSWORD` doesn't match what you typed. Sign out and retry.
- **"GitHub 401/403"** in function logs → the PAT is wrong, expired, or doesn't have Contents: Write on the right repo.
- **"GitHub 404"** on `recipes.json` → first run with no file. The function handles this (starts with `[]`), but check `GITHUB_REPO` is exactly `owner/name`.
- **Saved but other devices still show old recipes** → wait for the Netlify rebuild (Deploys tab will show a build in progress). Your own device sees the change immediately via the local cache; it falls back to git after ~2 min.
- **Image upload fails with "Image too large"** → the client resize should keep things well under the limit; if it ever exceeds ~4MB encoded, the function rejects it. Shoot a smaller image or lower the quality in the `resizeImage(file, 1100, 0.82)` call in `index.html`.

## Growth notes

- Repo size: each recipe = ~150–300 KB image + ~1 KB JSON entry. A few hundred recipes is comfortable. If you cross several thousand, swap images to Netlify Blobs or an image CDN.
- Commit history: every save = one commit. After a few years that's still a small repo; git is fine with it.
