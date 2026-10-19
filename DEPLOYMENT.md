# Putting ReQuora online (Supabase + GitHub + Render)

**Architecture:** GitHub repository → **Render** (runs the Node server, which also serves the website pages) → **Supabase** (PostgreSQL database + Storage for photos).
Why: ReQuora is a Node/Express server, so GitHub Pages can't run it. Render's free plan can, but it **erases its own disk** whenever it restarts or redeploys — that is exactly why uploaded photos and records vanished. Supabase keeps them permanently.

Do the steps in order. Nothing here needs XAMPP or localhost.

---
## Step 1 — Create the database tables (Supabase)
1. Open https://supabase.com/dashboard → open your ReQuora project (or **New project**).
2. Left menu → **SQL Editor** → **New query**.
3. Open `supabase/schema.sql` from this project, copy **everything**, paste it, press **Run**.
4. Expected: "Success. No rows returned". Check: **Table Editor** shows `users`, `items`, `claims`, `notifications`; **Storage** shows a bucket named `item-images` marked *Public*.
   - Safe to run again later. It does not delete data.
   - If you get an error, copy the red message to me.

> **Already have tables from an older version?** Don't run over them blindly. Tell me the table names/columns (Table Editor) and I'll write a migration.

## Step 2 — Get your two Supabase values
- **Project URL:** Project Settings (gear) → **API** (or **Data API**) → *Project URL* (`https://xxxx.supabase.co`).
- **Secret key:** Project Settings → **API Keys** → the **service_role** key (or "secret" key). Click reveal and copy.
- ⚠ This key is a master password for your database. Only paste it into Render's settings. **Never** put it in a file, in GitHub, or in the frontend. (The *anon/publishable* key is **not** used by ReQuora.)

## Step 3 — Put the code on GitHub
Use your existing repository (don't create a new one). Replace its files with this project's files (keep your `.git` folder), then in a terminal inside the project folder:
```
git add .
git commit -m "Use Supabase for data and photos"
git push
```
`.gitignore` already keeps `.env`, `node_modules` and local data out of GitHub. **Check** on github.com that no `.env` file is listed.

## Step 4 — Settings on Render
Render dashboard → your service `bpsu-requora` → **Settings**:
- **Root Directory:** `backend`
- **Build Command:** `npm install`   **Start Command:** `node server.js`
- **Environment** tab → add (Add Environment Variable):

| Key | Value |
|---|---|
| `NODE_ENV` | `production` |
| `TRUST_PROXY` | `1` |
| `JWT_SECRET` | a long random text (32+ characters) |
| `ADMIN_EMAIL` | `admin@bpsu.edu.ph` (or yours) |
| `ADMIN_PASSWORD` | a strong password of your own |
| `SUPABASE_URL` | the Project URL from Step 2 |
| `SUPABASE_SERVICE_ROLE_KEY` | the secret key from Step 2 |
| `SUPABASE_BUCKET` | `item-images` |

Save → Render redeploys. Future `git push` redeploys automatically.

## Step 5 — Check that it really works
1. Open `https://bpsu-requora.onrender.com/api/health`. Expected: `"database":"supabase"` and `"photos":"supabase"`.
   If it says `json` / `local`, the Supabase variables are missing or misspelled.
2. In Render → **Logs** you should see `Database: supabase (… users, … reports …)`.
3. Log in as admin, report an item **with a photo**.
4. In Supabase: Table Editor → `items` shows the row (with an `image_url`), Storage → `item-images` shows the file.
5. In Render click **Manual Deploy → Deploy latest commit** (a restart). Reopen the site: the report and photo must still be there. Also open it on your phone.
6. Open the browser console (F12): no red errors.

## Moving old data (optional)
If you have a local `backend/data/db.json` with reports you want to keep: put `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in `backend/.env`, then in `backend`:
```
node scripts/migrate-to-supabase.js          (dry run, shows what would happen)
node scripts/migrate-to-supabase.js --apply  (copies; never deletes)
```
Photos that Render already erased can't be recovered; those reports are kept without a photo.

## Troubleshooting
| Symptom | Fix |
|---|---|
| Health shows `json` | Variables not set on Render (names are exact, case-sensitive). |
| Logs: `Supabase returned 401/403` | You pasted the anon key; use the service_role/secret key. |
| Logs: `returned 404 … schema.sql` | Step 1 not run in *this* project. |
| Photo upload says "could not be saved" | Bucket `item-images` missing; re-run Step 1. |
| First page load is slow | Render free sleeps after ~15 min idle; it wakes in ~30 s. |
| Login breaks after redeploy | `JWT_SECRET` changed; keep it fixed. |

## How the security works
- The browser never talks to Supabase directly. All requests go through the ReQuora server, which checks login and role (student/staff/admin) on every call.
- Row Level Security is **on** for every table with **no** public policies, so the public anon key can't read or change anything. Only the server's secret key can.
- Photos are publicly viewable by URL (needed to show them); only the server can upload or delete.

## What is and isn't verified (by me, offline)
Verified: the SQL runs (twice) on a real PostgreSQL and rows from the code fit it; the Supabase and Storage request code against a simulated Supabase; 112 automated tests.
**Not verified:** your actual Supabase project, GitHub and Render accounts — I can't reach them. Steps 1–5 are the proof.
Design note: the server loads the data into memory at start and writes every change through to Supabase, so run **one** Render instance (the free plan is one).
