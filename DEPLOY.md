# Deploying the IME Coverage Console

A small internal web app for a handful of daily users. These steps put it online
with logins, on the cheapest hosting that fits. Pick **one** of the two hosts
below — both run the same container.

Everything here is copy-paste. You'll need a credit card (there's a free/cheap
tier), about 20 minutes, and a terminal.

---

## What you're deploying

A Docker container. It carries the app, the database, and document storage. The
database and uploaded files live on a **persistent volume**, so redeploys and
restarts don't lose data. Access requires a login; there is no public data.

---

## Option A — Fly.io  (recommended: simplest persistent volume)

1. Install the CLI and sign in:
   ```
   # macOS
   brew install flyctl
   # Windows (PowerShell)
   iwr https://fly.io/install.ps1 -useb | iex

   fly auth signup      # or: fly auth login
   ```

2. From inside the project folder:
   ```
   fly launch --no-deploy
   ```
   Accept the defaults. When it asks about a database, say **no** — we use the
   built-in SQLite. It writes a `fly.toml`.

3. Create the persistent volume (1 GB is plenty):
   ```
   fly volumes create ime_data --size 1
   ```

4. Tell Fly to mount it. Open `fly.toml` and add:
   ```
   [mounts]
     source = "ime_data"
     destination = "/app/data"
   ```

5. Set a session secret and deploy:
   ```
   fly secrets set NODE_ENV=production
   fly deploy
   ```

6. Seed the data and create your login (one time), by opening a shell on the
   running machine:
   ```
   fly ssh console
   node db/seed.mjs --fresh
   node db/import.mjs data/FFD_Provider_Directory_Export__1_.xlsx
   node db/create-admin.mjs you@occu-med.com "Your Name"
   exit
   ```
   The admin command prints a temporary password. Sign in with it and change it
   immediately from the account menu.

7. `fly open` — that's your live URL. Add teammates from the account menu.

---

## Option B — Render  (nice dashboard, no CLI)

1. Push this project to a private GitHub repo.
2. At render.com → **New → Web Service** → connect the repo.
   - Environment: **Docker**
   - Instance type: the cheapest paid tier (the free tier sleeps and loses the
     disk — not suitable here)
   - Add a **Disk**: mount path `/app/data`, size 1 GB
   - Add env var: `NODE_ENV = production`
3. Deploy. When it's live, open the Render **Shell** tab and run the same four
   `node db/...` commands from Option A step 6.
4. Your URL is at the top of the service page.

---

## After it's live

- **Add teammates:** account menu (top right) → they appear only if you're an
  admin. Each gets a temporary password to change on first login.
- **Refresh the provider data:** open a shell (`fly ssh console` or Render Shell),
  upload/copy the new xlsx into `data/`, then
  `node db/import.mjs data/<file>.xlsx`. Safe to re-run; nothing duplicates.
- **Back up:** the entire state is the `/app/data` volume — the `.db` file plus
  `documents/`. Both hosts can snapshot a volume; do that before any big change.

## Cost

Both land around **$5–10/month** for this size. Fly's smallest machine and a 1 GB
volume, or Render's cheapest instance plus a small disk. Neither needs anything
bigger until you're well past a handful of users.

## When this folds into your main system

The login layer here (`app_user`, `session`, `src/auth.mjs`) is the piece most
likely to be replaced by your main system's own auth. Everything else — the
schema, the coverage engine, the API — is meant to port. This hosting is a
bridge, not a destination.
