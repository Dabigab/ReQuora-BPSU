-- ============================================================
-- ReQuora migration: appointment location (BPSU Main Campus only)
-- Run ONCE in: Supabase dashboard -> SQL Editor -> New query -> paste -> Run.
-- Safe to run more than once. It only adds a check constraint; it never deletes or rewrites rows.
-- ============================================================
-- The appointment place is stored in claims.extra as "appointmentLocation" (and a claimant's
-- change request as "appointmentRequest"), so no new column is needed.
-- Which places are approved is configuration (APPOINTMENT_LOCATIONS on the server), so the
-- database cannot hold that list. The server is the authority on "inside the Main Campus";
-- the constraint below only stops blank or oversized values from being stored by any other path.

begin;

alter table public.claims drop constraint if exists claims_appointment_location_check;
alter table public.claims add constraint claims_appointment_location_check check (
  not (extra ? 'appointmentLocation')
  or extra->>'appointmentLocation' is null
  or (char_length(btrim(extra->>'appointmentLocation')) between 3 and 150)
);

commit;

-- ROLLBACK:
-- alter table public.claims drop constraint if exists claims_appointment_location_check;
