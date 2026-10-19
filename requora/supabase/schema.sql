-- ============================================================
-- ReQuora — Supabase database setup  (safe to run more than once)
-- Where to run it: Supabase dashboard -> SQL Editor -> New query ->
-- paste this WHOLE file -> Run.  Expected result: "Success. No rows returned".
-- ============================================================

-- ---------- tables ----------
create table if not exists public.users (
  id            uuid primary key,
  name          text        not null,
  email         text        not null,
  student_id    text,
  password_hash text        not null,
  role          text        not null default 'student'
                check (role in ('student', 'faculty', 'staff', 'admin')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz,
  extra         jsonb       not null default '{}'::jsonb
);
create unique index if not exists users_email_key on public.users (lower(email));

create table if not exists public.items (
  id          uuid primary key,
  type        text        not null check (type in ('lost', 'found')),
  title       text        not null,
  category    text        not null,
  description text        not null default '',
  location    text        not null default '',
  date        text,                        -- the day it was lost/found (YYYY-MM-DD)
  status      text        not null default 'pending_verification'
              check (status in ('pending_verification', 'lost', 'found', 'claimed', 'returned', 'closed')),
  reported_by uuid        references public.users (id) on delete set null,
  image_url   text,                        -- public URL of the photo in Storage (or null)
  created_at  timestamptz not null default now(),
  updated_at  timestamptz,
  extra       jsonb       not null default '{}'::jsonb
);
create index if not exists items_status_idx      on public.items (status);
create index if not exists items_type_idx        on public.items (type);
create index if not exists items_category_idx    on public.items (category);
create index if not exists items_reported_by_idx on public.items (reported_by);
create index if not exists items_created_at_idx  on public.items (created_at desc);

create table if not exists public.claims (
  id          uuid primary key,
  item_id     uuid        not null references public.items (id) on delete cascade,
  claimant_id uuid        references public.users (id) on delete set null,
  status      text        not null default 'pending'
              check (status in ('pending', 'approved', 'rejected', 'completed', 'cancelled')),
  history     jsonb       not null default '[]'::jsonb,   -- every status change, for the progress timeline
  created_at  timestamptz not null default now(),
  updated_at  timestamptz,
  extra       jsonb       not null default '{}'::jsonb
);
create index if not exists claims_item_idx     on public.claims (item_id);
create index if not exists claims_claimant_idx on public.claims (claimant_id);
create index if not exists claims_status_idx   on public.claims (status);

create table if not exists public.notifications (
  id         uuid primary key,
  user_id    uuid        not null references public.users (id) on delete cascade,
  type       text        not null default 'info',
  title      text        not null,
  message    text        not null default '',
  link       text,
  read       boolean     not null default false,
  created_at timestamptz not null default now(),
  extra      jsonb       not null default '{}'::jsonb
);
create index if not exists notifications_user_idx on public.notifications (user_id, created_at desc);

-- ---------- Row Level Security ----------
-- ReQuora's website talks to the database ONLY through its own server
-- (which checks logins and roles). The server uses the service_role key, which
-- bypasses RLS. So we switch RLS ON for every table and add NO policies for
-- the public (anon) or logged-in (authenticated) Supabase roles: anyone holding
-- the public anon key can read or change nothing directly.
alter table public.users         enable row level security;
alter table public.items         enable row level security;
alter table public.claims        enable row level security;
alter table public.notifications enable row level security;

-- Belt and braces: also remove table privileges from the public roles.
revoke all on public.users, public.items, public.claims, public.notifications from anon, authenticated;

-- ---------- Storage bucket for item photos ----------
-- Public bucket: anyone can VIEW a photo if they have its URL (needed so the
-- website can show pictures). Nobody except the ReQuora server can upload or
-- delete, because no insert/update/delete policies exist for anon/authenticated.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('item-images', 'item-images', true, 5242880,
        array['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
on conflict (id) do update
  set public = true,
      file_size_limit = 5242880,
      allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
