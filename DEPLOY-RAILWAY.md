# Deploying to Railway

You already have a Railway account, so this is the short path — no GitHub, no new
signup. About 15 minutes, most of it waiting for the first build.

The app is a Docker container. Railway detects the `Dockerfile` automatically and
builds it. The database and uploaded documents live on a persistent volume, so
redeploys never lose data. Access requires a login.

---

## 1. Get the code onto your machine

Extract `ime-network.tar.gz` (double-click). You'll have a folder called
`ime-network` with a `Dockerfile` in it. That folder is what you deploy.

## 2. Install the Railway CLI (one command, one time)

```
# macOS
brew install railway
# Windows (PowerShell)
iwr https://railway.app/install.ps1 | iex
```

Then sign in — this opens your browser and uses your existing account:
```
railway login
```

## 3. Create the project and deploy

From **inside the `ime-network` folder**:
```
railway init          # names a new project — call it "ime-console" or similar
railway up            # uploads the folder, builds the Dockerfile, deploys
```
`railway up` reads the code straight from the folder. GitHub is never involved.

The first build takes a few minutes. When it finishes, the CLI prints a URL.

## 4. Add the persistent volume (so data survives redeploys)

In the Railway **dashboard** (railway.app → your project → the service):
- Click the service → **Variables / Settings → Volumes** → **New Volume**
- Mount path: `/app/data`
- Size: 1 GB is plenty

Redeploy once after adding it so it takes effect:
```
railway up
```

## 5. Set production mode

In the dashboard, service → **Variables** → add:
```
NODE_ENV = production
```
(Railway sets `PORT` itself — the app already reads it.)

## 6. Seed the data and create your login (one time)

Open a shell on the running service:
```
railway run bash
```
Then, inside it:
```
node db/seed.mjs --fresh
node db/import.mjs data/FFD_Provider_Directory_Export__1_.xlsx
node db/create-admin.mjs you@occu-med.com "Your Name"
exit
```
The last command prints a **temporary password**. Sign in with it, then change it
immediately from the account menu (top-right in the app).

> If `railway run bash` doesn't attach to the deployed container in your setup,
> use the dashboard: service → the running deployment → the shell/terminal panel,
> and run the same four commands there.

## 7. You're live

Open the URL from step 3. Sign in. Add teammates (Melanie) from the account menu
— each gets a temporary password to change on first login.

---

## Day-to-day

- **Refresh provider data:** copy a new export into `data/` and run
  `node db/import.mjs data/<file>.xlsx` in the service shell. Safe to re-run —
  nothing duplicates.
- **Back up:** the whole state is the `/app/data` volume (the `.db` file plus
  `documents/`). Snapshot it in the Railway dashboard before any big change.
- **Redeploy after code changes:** `railway up` again from the folder.

## Cost

For an app this small with a few daily users you'll sit inside Railway's ~$5/month
usage. Nothing here needs a bigger instance.

## Later

When this folds into your main system, the login layer (`app_user`, `session`,
`src/auth.mjs`) is the part most likely to be replaced by your main system's own
auth. The schema, coverage engine, and API are built to port. Railway is a
bridge, not the destination.
