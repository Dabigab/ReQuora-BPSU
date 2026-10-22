-- ============================================================
-- ReQuora migration: multiple claimants, 24-hour claiming period, Terms acceptance
-- Run ONCE in: Supabase dashboard -> SQL Editor -> New query -> paste -> Run.
-- Safe to run more than once. It only ADDS columns, loosens two status checks and
-- adds indexes. It never deletes, truncates or rewrites existing rows.
-- Run it BEFORE deploying the new server code (the new code writes the new columns).
-- ============================================================

begin;

-- 1) Terms and Conditions acceptance (users) -------------------------------
alter table public.users add column if not exists terms_accepted    boolean default false;
alter table public.users add column if not exists terms_accepted_at timestamptz;
alter table public.users add column if not exists terms_version      text;
-- Existing accounts keep terms_accepted = false/null; the website asks them to accept
-- the first time they log in (nothing is blocked in the database).

-- 2) Claiming deadline (items) ---------------------------------------------
-- Set by the server when a found-item report is published (publication time + 24 hours).
-- NULL for lost-item reports and for every report created before this migration, so
-- existing reports keep behaving exactly as before.
alter table public.items add column if not exists claim_deadline timestamptz;
create index if not exists items_claim_deadline_idx on public.items (claim_deadline) where claim_deadline is not null;

-- 3) New report statuses ------------------------------------------------------
-- awaiting_review, under_verification, no_valid_claim are new; the old values stay valid.
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.items'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%status%'
  loop
    execute format('alter table public.items drop constraint %I', c.conname);
  end loop;
end $$;
alter table public.items add constraint items_status_check check (status in (
  'pending_verification', 'lost', 'found', 'claimed', 'returned', 'closed',
  'awaiting_review', 'under_verification', 'no_valid_claim'));

-- 4) New claim statuses -------------------------------------------------------
-- under_review and info_required are new; the old values stay valid.
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.claims'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%status%'
  loop
    execute format('alter table public.claims drop constraint %I', c.conname);
  end loop;
end $$;
alter table public.claims add constraint claims_status_check check (status in (
  'pending', 'under_review', 'info_required', 'approved', 'rejected', 'completed', 'cancelled'));

-- 5) Database-level safeguards -------------------------------------------------
-- (a) Only ONE approved/completed claim per report, even if two admins act at the same instant.
-- (b) One claim per person per report (a cancelled claim does not count).
-- Each index is only created when your current data already satisfies the rule, so this
-- migration can never fail because of old rows. A NOTICE tells you if one was skipped.
do $$
begin
  if exists (select 1 from public.claims where status in ('approved', 'completed') group by item_id having count(*) > 1) then
    raise notice 'SKIPPED claims_one_approved_per_item: some report already has more than one approved/completed claim. Fix those rows, then run this migration again.';
  else
    create unique index if not exists claims_one_approved_per_item
      on public.claims (item_id) where status in ('approved', 'completed');
  end if;

  if exists (select 1 from public.claims where claimant_id is not null and status <> 'cancelled' group by item_id, claimant_id having count(*) > 1) then
    raise notice 'SKIPPED claims_one_per_claimant: someone already has two live claims on the same report. Cancel the extra ones, then run this migration again.';
  else
    create unique index if not exists claims_one_per_claimant
      on public.claims (item_id, claimant_id) where claimant_id is not null and status <> 'cancelled';
  end if;
end $$;

commit;

-- Row Level Security is unchanged and still protects the new columns: RLS is ON for every table
-- and there are NO policies for the public (anon) or logged-in (authenticated) Supabase roles,
-- so claim evidence and admin decisions can only be read through the ReQuora server
-- (which checks who is asking). Never put the service_role key in frontend files.

-- ============================================================
-- ROLLBACK (only if you must undo this migration; the new code needs these columns, so redeploy the
-- previous code version first). Nothing below deletes claims, reports or users.
-- ============================================================
-- drop index if exists public.claims_one_approved_per_item;
-- drop index if exists public.claims_one_per_claimant;
-- drop index if exists public.items_claim_deadline_idx;
-- -- Reports/claims already using the new statuses must be moved back first, e.g.:
-- --   update public.items  set status = found where status in ('awaiting_review','under_verification','no_valid_claim') and type = 'found';
-- --   update public.items  set status = lost  where status in ('awaiting_review','under_verification','no_valid_claim') and type = 'lost';
-- --   update public.claims set status = 'pending' where status in ('under_review','info_required');
-- -- then restore the old checks:
-- -- alter table public.items  drop constraint items_status_check;
-- -- alter table public.items  add constraint items_status_check check (status in ('pending_verification','lost','found','claimed','returned','closed'));
-- -- alter table public.claims drop constraint claims_status_check;
-- -- alter table public.claims add constraint claims_status_check check (status in ('pending','approved','rejected','completed','cancelled'));
-- -- The extra columns (terms_*, claim_deadline) can simply stay; the old code ignores them.
