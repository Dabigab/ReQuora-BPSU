# Upgrade guide — multiple claimants, 24-hour claiming period, admin ownership review, Terms

This upgrade changes the existing ReQuora code (nothing was rebuilt) and adds **one SQL migration**.
Your existing users, reports, claims and notifications are kept.

## What changed (short)

| Area | How it works now |
|---|---|
| Claiming period | A **found** report gets `claimDeadline = published time + 24 h`, set by the server. Claims are refused after it, whatever the browser shows. A background job (every minute, started in `server.js`) and every main read/write endpoint also close expired periods. |
| Multiple claimants | Any number of people can claim one report, once each. Claiming never approves or closes anything. |
| After 24 h | Report becomes **Awaiting Admin Review** (it has claims) or **No Valid Claim** (it has none). Claimants, finder and admins are notified. |
| Admin review | Open the report → **Claim review**: every claim side by side (explanation, identifying details, contact, extra answers, history). Actions: mark under review, request more information, approve (one only), reject (reason required), mark handed over, reopen claiming (exception), private notes. |
| One winner | Approving a claim marks the report **Claim approved**, rejects the other open claims (with a notification that does not name the winner), and the handover step marks it **Resolved**. Enforced in code (single-threaded check-and-write) **and** by a unique database index. |
| My Reports / My Claims | Separate tabs (and menu entries). A finder only ever sees the report under **My Reports**. |
| Terms | Sign-up shows the Terms, requires the checkbox (browser **and** server). Acceptance, time and version are stored. Older accounts are asked to accept on their next visit. |

Status values (no duplicated fields — they extend the existing `status` columns):

* Report: `pending_verification`, `lost`/`found` (shown as *Open for Claims* while the window runs), `awaiting_review`, `under_verification`, `claimed` (*Claim Approved*), `returned` (*Resolved*), `no_valid_claim`, `closed`
* Claim: `pending`, `under_review`, `info_required`, `approved`, `rejected`, `completed` (handed over), `cancelled`

Design decisions you may want to know about:

* The report is "published" the moment it is created (that is already how the site behaved: it is visible and claimable immediately), so the 24 hours start at creation. Admin "Verify" no longer gates anything.
* Reports created **before** this upgrade, and all **lost** reports, have no deadline and keep working exactly as before.
* The appointment booking at claim time was removed from the claim form (booking before knowing the winner is not useful). The API still accepts an optional visit date.
* The handover step is the existing "Mark item handed over" button: approved → handed over → report **Resolved**.
* Accounts created before the upgrade are not blocked; they get a "please accept the Terms" dialog. Bump `TERMS_VERSION` in `backend/utils/constants.js` **and** `frontend/js/terms.js` (same value) to ask everyone again.
* The Terms text is a **proposal** and says so on screen; BPSU must review it.

## 1. Apply the Supabase migration (do this FIRST)

1. Supabase dashboard → your project → **SQL Editor → New query**.
2. Open `supabase/migrations/2026-10-23_multi_claimants_and_terms.sql`, copy all of it, paste, **Run**.
3. Expected: "Success". If a `NOTICE` says an index was SKIPPED, your old data had a duplicate; fix those rows and run the file again (it is safe to repeat).
4. Check: **Table Editor → items** now has `claim_deadline`; **users** has `terms_accepted`, `terms_accepted_at`, `terms_version`.

The migration only adds columns/indexes and widens two `status` checks. It deletes nothing. Row Level Security is unchanged (on, no public policies), so claim evidence is only reachable through your server.
(New empty project? Run `supabase/schema.sql` instead; it already contains everything.)

## 2. Test locally

```
cd backend
npm install
npm test          # 178 tests should pass
npm start         # open http://localhost:5000
```

Manual walk-through (use 3 browsers/profiles: finder, two claimants; admin is `admin@bpsu.edu.ph`):

1. Sign up without ticking the box → blocked. Tick it → account created.
2. Finder: **Report an Item** → "I found something". It appears under **My Reports** (with a countdown), not My Claims.
3. Claimant A and B: open the report → **Submit a Claim**. Both appear under **My Claims**; neither is approved; the finder sees "2 claimants" but no evidence.
4. Admin: open the report. While the countdown runs, Approve is disabled.
5. To skip the wait in a test database, stop the server and set that item's `claimDeadline` to a past time in `backend/data/db.json` (or just wait). Restart → report becomes *Awaiting Admin Review*.
6. Admin: compare the cards, **Request more information** from A (A sees it under My Claims and answers), then **Approve** B. A is told "not approved", report shows *Claim approved*; **Mark item handed over** → *Resolved*.

## 3. Update GitHub

```
git add .
git commit -m "Multiple claimants, 24-hour claiming period, admin review, Terms"
git push
```
`backend/.env` is never committed (it is in `.gitignore`); do not add it.

## 4. Railway variables

No new variables are needed. Keep what you already have: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_BUCKET`, `JWT_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `NODE_ENV=production`, `TRUST_PROXY=1`, `CORS_ORIGIN` (if the frontend is hosted separately).

**Run exactly one instance** of the service (replicas = 1). ReQuora keeps the database in memory and writes through to Supabase, and the 24-hour job runs inside that process. Railway restarts are fine: on start the job immediately closes anything that expired while the server was down.

## 5. Deploy

Push to GitHub (step 3); Railway builds and deploys automatically. Watch the deploy log for
`[ReQuora] Database: supabase (… users, … reports, … claims)`.

## 6. Test the live site

Repeat the manual walk-through on your Railway URL. Also open `/api/health` and `/terms.html`.

## 7. Roll back

* **Code:** Railway → Deployments → pick the previous deployment → *Redeploy*, or `git revert <commit>` and push.
* **Database:** you do not need to roll the database back; the old code ignores the new columns. Only reports/claims already using the new statuses (`awaiting_review`, `under_verification`, `no_valid_claim`, `under_review`, `info_required`) would confuse the old code. If you must go back, use the commented ROLLBACK section at the bottom of the migration file first.
* Back up before step 1 if you want extra safety: Supabase → Database → Backups (or export the three tables as CSV).

## What I could and could not verify

* Verified here: all backend tests (178, including new ones for multi-claim, deadline, concurrent approval, privacy, Terms), JavaScript syntax of every file, a real server start, and rendering of the new frontend screens in a headless VM.
* **Not verified:** the live Supabase migration and Railway (no access from here), and a click-through in a real browser (layout on phone/desktop and the countdown ticking). Please do the manual walk-through above once.
