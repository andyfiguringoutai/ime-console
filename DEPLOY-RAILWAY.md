# Deploying to Railway

The app is a Docker container. Railway builds it from the `Dockerfile`
automatically. The database and uploaded documents live on a persistent volume,
so redeploys never lose data. Access requires a login.

The app **seeds itself** on first boot — there is no shell step, no manual
`seed` command. You set three environment variables, Railway deploys, and the
app creates the database, imports the bundled provider export, and creates your
admin login on its own.

---

## ⚠️ If you already deployed an earlier build — read this first

Earlier instructions said to mount the volume at `/app/data`. **That was the
cause of notes and contacts disappearing.** The app writes its database to
`/app/storage`, so if the volume is mounted at `/app/data` the database sits on
the container's temporary disk and is wiped on every redeploy or restart.

Fix it once: in the Railway dashboard → your service → **Settings → Volumes**,
change the mount path to **`/app/storage`** (detach the old one if needed), then
redeploy. From then on, everything you enter persists.

---

## 1. Deploy from GitHub

Push this folder to a GitHub repo, then in Railway: **New Project → Deploy from
GitHub repo** and pick it. Railway detects the `Dockerfile` and builds. The
first build takes a few minutes; when it finishes you get a URL.

(Every later `git push` to that repo auto-deploys.)

## 2. Add the persistent volume

In the Railway dashboard → your service → **Settings → Volumes → New Volume**:

- **Mount path: `/app/storage`**  ← this exact path matters
- Size: 1 GB is plenty

> Do **not** mount the volume at `/app/data`. That folder holds read-only map
> data baked into the image; a volume there hides it and the app can't start.

## 3. Set the environment variables

In the dashboard → your service → **Variables**, add:

```
NODE_ENV        = production
ADMIN_EMAIL     = you@occu-med.com
ADMIN_PASSWORD  = (pick a strong temporary password)
ADMIN_NAME      = Your Name
```

(Railway sets `PORT` itself — the app already reads it.)

## 4. Redeploy once

After the volume and variables are set, trigger a redeploy (push a commit, or
**Deployments → Redeploy**). On this first boot the app will:

- create the database on the volume at `/app/storage`,
- **restore your real data snapshot** — the 100 providers, addresses and
  contacts from the Nov 4 backup (not a generic starter list),
- create your admin account from `ADMIN_EMAIL` / `ADMIN_PASSWORD`.

You can confirm it in the deploy **logs** — look for:

```
[db] database at /app/storage/ime-network.db
[bootstrap] empty database — restoring bundled data snapshot…
[bootstrap] restored 100 providers from snapshot
[bootstrap] created admin you@occu-med.com
```

On every later restart the logs should instead say
`database already has N physicians — skipping seed`. If you ever see
"restoring…" again on a restart, the volume is not mounted at `/app/storage` —
fix the mount. (The snapshot only loads into an empty database, so once your
data is on the volume it is never overwritten by later deploys.)

## 5. You're live

Open the URL. Sign in with the admin email and the password you set, then change
the password from the account menu (top-right). Add teammates (Melanie) from the
same menu — each gets a temporary password to change on first login.

---

## Day-to-day

- **Refresh provider data:** drop a new `.xlsx` export in `data/`, commit, and
  push. (Re-importing is safe — nothing duplicates.) Ask me if you want the
  import wired to run automatically on deploy.
- **Back up:** the whole state is the `/app/storage` volume (the `.db` file plus
  `documents/`). Snapshot it in the Railway dashboard before any big change.
- **Never run `node db/seed.mjs --fresh` against the live service** — the
  `--fresh` flag deletes the database and starts over. The app seeds itself once
  automatically; you never need to run it by hand.

## Cost

For an app this small with a few daily users you'll sit inside Railway's
~$5/month usage. Nothing here needs a bigger instance.

## Later

When this folds into your main system, the login layer (`app_user`, `session`,
`src/auth.mjs`) is the part most likely to be replaced by your main system's own
auth. The schema, coverage engine, and API are built to port. Railway is a
bridge, not the destination.
