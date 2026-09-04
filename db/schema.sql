-- ============================================================================
-- BAANDEK Vaccine Bot — Supabase Schema (normalized from 22 Google Sheets)
-- Target: Postgres 15 (Supabase).  Run in Supabase SQL editor or via migration.
-- Convention: snake_case, English identifiers, text-based natural keys kept
--             where the bot already relies on them (VaccineID, HN, RuleID...).
-- ============================================================================

create schema if not exists app;
set search_path = public;

-- ---------------------------------------------------------------------------
-- 0) Extensions + shared helpers
-- ---------------------------------------------------------------------------
create extension if not exists "pgcrypto";      -- gen_random_uuid()
create extension if not exists "pg_trgm";        -- fuzzy alias / purpose matching

-- updated_at auto-touch
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- 1) ENUM types
-- ---------------------------------------------------------------------------
do $$ begin
  create type appointment_status as enum ('scheduled','completed','cancelled','no_show');
exception when duplicate_object then null; end $$;

do $$ begin
  create type active_status as enum ('ACTIVE','INACTIVE');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- 2) CORE — patients (deduped from APPOINTMENTS by HN)
-- ---------------------------------------------------------------------------
create table if not exists patients (
  id            uuid primary key default gen_random_uuid(),
  hn            text unique not null,               -- hospital number (natural key)
  full_name     text not null,
  nickname      text,
  phone         text,                               -- E.164-ish, leading 0 restored by ETL
  phone_valid   boolean default false,              -- ETL flags 10-digit TH numbers
  address       text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_patients_phone on patients (phone);
create trigger trg_patients_updated before update on patients
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- 3) CORE — vaccines (VACCINES sheet)
-- ---------------------------------------------------------------------------
create table if not exists vaccines (
  vaccine_id     text primary key,                  -- e.g. HEXA, ROTARIX
  name           text,                              -- VaccineName (english/product)
  name_th        text,                              -- VaccineNameT
  age_group      text,                              -- AgeGroup (2M, 12M...)  -> age_guide.age_code
  category       text,                              -- REQUIRED / CHOICE_x
  price          numeric(10,2),
  status         active_status default 'ACTIVE',
  group_code     text,                              -- GROUP (DTP_POLIO_COMBO...)
  display_order  int default 999,
  dose_name      text,
  description    text,
  catch_up       text,
  recommendation text,
  warning        text,
  priority       text,
  product_code   text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists idx_vaccines_group on vaccines (group_code);
create index if not exists idx_vaccines_status on vaccines (status);
create trigger trg_vaccines_updated before update on vaccines
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- 4) CORE — vaccine_rules (VACCINE_RULES sheet — the good, data-driven engine)
-- ---------------------------------------------------------------------------
create table if not exists vaccine_rules (
  rule_id          text primary key,
  vaccine_group    text,
  product_code     text,
  min_age_months   numeric,
  max_age_months   numeric,
  primary_doses    int,
  interval_days    int,
  booster_rule     text,
  eligibility      text,
  requires_history boolean default false,
  doctor_review    text,
  display_message  text,
  status           active_status default 'ACTIVE',
  sort_order       int default 999,
  scenario_code    text
);
create index if not exists idx_rules_group on vaccine_rules (vaccine_group);
create index if not exists idx_rules_age on vaccine_rules (min_age_months, max_age_months);

-- ---------------------------------------------------------------------------
-- 5) CORE — disease_groups + vaccine_aliases
--    Split AI_ALIAS comma-string into one row per alias  -> proper intent match
-- ---------------------------------------------------------------------------
create table if not exists disease_groups (
  id             uuid primary key default gen_random_uuid(),
  vaccine        text,                              -- Vaccine (Hexa, Penta...)
  group_code     text,                              -- GROUP
  disease_group  text,                              -- DISEASE_GROUP (comma list of diseases)
  status         active_status default 'ACTIVE',
  display_order  int default 999
);
create index if not exists idx_disease_group_code on disease_groups (group_code);

create table if not exists vaccine_aliases (
  id             uuid primary key default gen_random_uuid(),
  group_code     text not null,                     -- FK-ish to disease_groups.group_code
  alias          text not null,                     -- one alias per row (normalized lower)
  created_at     timestamptz not null default now()
);
create unique index if not exists uq_alias on vaccine_aliases (group_code, alias);
create index if not exists idx_alias_trgm on vaccine_aliases using gin (alias gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- 6) CORE — appointments  (APPOINTMENTS sheet — normalized)
-- ---------------------------------------------------------------------------
create table if not exists appointments (
  id             uuid primary key default gen_random_uuid(),
  patient_id     uuid references patients(id) on delete set null,
  hn             text,                              -- kept for traceability to source
  appt_date      date not null,
  time_slot      text,                              -- e.g. "9.00-10.00 น."
  vaccine_id     text references vaccines(vaccine_id), -- resolved from purpose_raw (best-effort)
  purpose_raw    text,                              -- original "นัดเพื่อ" free text
  status         appointment_status default 'scheduled',
  note           text,
  source         text default 'sheet_import',       -- sheet_import | line | messenger | dashboard
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists idx_appt_date on appointments (appt_date);
create index if not exists idx_appt_patient on appointments (patient_id);
create index if not exists idx_appt_status on appointments (status);
create trigger trg_appt_updated before update on appointments
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- 7) CONFIG — age_guide / clinic_hours / closures / clinic_config
-- ---------------------------------------------------------------------------
create table if not exists age_guide (
  age_code      text primary key,                   -- NB, 1M, 2M...
  display_name  text,
  sort_order    numeric default 999
);

create table if not exists clinic_hours (
  id            uuid primary key default gen_random_uuid(),
  day           text,                               -- Monday..Sunday
  session       int default 1,
  open_time     text,                               -- "9:00" or "-"
  close_time    text,
  status        text                                -- OPEN / CLOSED
);
create index if not exists idx_hours_day on clinic_hours (day);

create table if not exists closures (
  id            uuid primary key default gen_random_uuid(),
  start_date    date,
  end_date      date,
  reason        text,
  active        boolean default true,
  message       text,
  priority      int default 1,
  closure_type  text,                               -- CLOSE_ALL...
  period_code   text                                -- ALL...
);
create index if not exists idx_closures_active on closures (active, start_date, end_date);

-- Merge of BOT_SETTING + CLINIC_INFO + LINKS (key-value + category + source)
create table if not exists clinic_config (
  key           text primary key,
  value         text,
  category      text,                               -- GENERAL / CONTACT / BOT ...
  source_sheet  text,                               -- BOT_SETTING | CLINIC_INFO | LINKS (audit)
  updated_at    timestamptz not null default now()
);
create trigger trg_config_updated before update on clinic_config
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- 8) CONTENT — articles / faq / promotions(merged) / packages / services /
--              team / reviews / vaccine_news / leads
-- ---------------------------------------------------------------------------
create table if not exists articles (
  id                  uuid primary key default gen_random_uuid(),
  title               text,
  category            text,
  cover_image_url     text,
  content_type        text,                          -- comic-story / infographic...
  panel_images_folder text,
  published           boolean default false,
  body_content        text,
  display_order       int default 999,
  created_at          timestamptz not null default now()
);
create index if not exists idx_articles_pub on articles (published);

create table if not exists faq (
  id         uuid primary key default gen_random_uuid(),
  keyword    text,
  answer     text,
  category   text default 'GENERAL'
);

-- PROMOS (bot promos) + PROMOTIONS (landing banners) merged; `kind` distinguishes
create table if not exists promotions (
  id             uuid primary key default gen_random_uuid(),
  kind           text default 'bot',                -- bot | banner
  code           text,                              -- PromoID (bot promos)
  title          text,                              -- PromoName / Title
  description     text,
  vaccine_group  text,                              -- bot promos
  discount       text,                              -- bot promos
  condition      text,
  image_url      text,                              -- banners
  start_date     date,
  end_date       date,
  active         boolean default true,
  display_period text
);
create index if not exists idx_promo_active on promotions (active, start_date, end_date);

create table if not exists packages (
  package_id   text primary key,
  name         text,
  description  text,
  price        numeric(10,2),
  status       active_status default 'INACTIVE'
);

create table if not exists services (
  id            uuid primary key default gen_random_uuid(),
  title         text,
  description   text,
  icon          text,
  display_order int default 999,
  active        boolean default true
);

create table if not exists team (
  id            uuid primary key default gen_random_uuid(),
  name          text,
  role          text,
  photo_url     text,
  credentials   text,
  display_order int default 999,
  active        boolean default true
);

create table if not exists reviews (
  id                   uuid primary key default gen_random_uuid(),
  source               text,
  reviewer_name        text,
  text                 text,
  rating               int,
  screenshot_url       text,
  permission_confirmed boolean default false,
  review_count         int
);

create table if not exists vaccine_news (
  id            uuid primary key default gen_random_uuid(),
  vaccine_name  text,
  start_date    text,                                -- kept text: source has "เร็วๆ นี้"
  end_date      text,
  status        boolean default true,
  description   text
);

create table if not exists leads (
  id             uuid primary key default gen_random_uuid(),
  lead_date      date default current_date,
  name           text,
  phone          text,
  age            text,
  interest       text,                               -- สนใจวัคซีน
  channel        text,                               -- line | messenger
  created_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 9) OPS — incident_log (bot performance/telemetry)
-- ---------------------------------------------------------------------------
create table if not exists incident_log (
  id               bigint generated always as identity primary key,
  ts               timestamptz not null default now(),
  user_id          text,
  command          text,
  response_time_ms int,
  status           text                              -- ok | timeout | fail
);
create index if not exists idx_incident_ts on incident_log (ts desc);
create index if not exists idx_incident_status on incident_log (status);

-- ---------------------------------------------------------------------------
-- 9b) STOCK — stock_items (medicine/formula/vaccine inventory) + staff_roles
--   stock_items is synced daily from KallayaClinic.mdb (รายการยา) by
--   sync_mdb_stock(), but name/category/unit/min_threshold become
--   dashboard-owned once a row exists — sync only ever touches qty_on_hand
--   and last_synced_at on conflict, never overwriting a staff edit.
--
--   min_threshold nullable (chunk 3): a brand-new item sync discovers for the
--   first time is inserted with min_threshold = NULL ("รอตั้งค่า"/pending) —
--   deliberately ignoring the .mdb's own "จำนวนต่ำสุด" field, since that's
--   Doctor's own reorder point, not necessarily one Kallaya has ever reviewed.
--   A pending item shows no color/level and is excluded from getActiveStockItems()
--   (so also excluded from both the LINE alert and customer stock replies)
--   until a real threshold is set via the dashboard. `note` is a free-text
--   reason staff can attach when marking an item inactive ("เลิกใช้ถาวร" etc).
--
--   expiry_date (chunk 4) is sync-owned like qty_on_hand — overwritten from
--   Doctor's "วันหมดอายุ" field on every sync — for emergency drugs (e.g.
--   Adrenaline, Dexamethasone) that sit unused for long stretches and need
--   expiry watched instead of quantity. is_emergency is dashboard-owned like
--   note/min_threshold: sync never touches it once a row exists, and a new
--   row always inserts with is_emergency = false regardless of the payload.
-- ---------------------------------------------------------------------------
create table if not exists stock_items (
  id              uuid primary key default gen_random_uuid(),
  mdb_item_id     int unique,                        -- รหัสยา; null = dashboard-only item, never synced
  name            text not null,
  category        text not null,                     -- ยา | นม | วัคซีน ... free text, not an enum
  unit            text,
  qty_on_hand     int not null default 0,
  min_threshold   int,                                -- null = pending ("รอตั้งค่า"), not yet reviewed by staff
  active          boolean not null default true,
  note            text,                               -- staff-entered reason when active is toggled off
  expiry_date     date,                                -- synced from Doctor's "วันหมดอายุ"; null = not tracked/unknown
  is_emergency    boolean not null default false,      -- staff-tagged: watch expiry_date instead of qty_on_hand
  last_synced_at  timestamptz,
  updated_at      timestamptz not null default now()
);
create index if not exists idx_stock_items_category on stock_items (category);
create trigger trg_stock_items_updated before update on stock_items
  for each row execute function set_updated_at();

-- Upserts one sync batch from Doctor's [รายการยา] table (called by
-- StockSync/sync-stock.ps1, ~20:00 daily). Existing rows (matched by
-- mdb_item_id) only ever get qty_on_hand/expiry_date/last_synced_at touched —
-- name/category/unit/min_threshold/active/note/is_emergency stay
-- dashboard-owned. A new mdb_item_id creates a row with min_threshold = NULL
-- (pending) and is_emergency = false regardless of what the payload carries —
-- see comment above. payload rows carry an "expiry_date" key (ISO "YYYY-MM-DD"
-- or "" / absent when Doctor has no expiry on file for that item).
create or replace function public.sync_mdb_stock(payload jsonb)
returns table(inserted_count integer, updated_count integer)
language plpgsql
set search_path to 'public'
as $function$
declare
  v_inserted_count integer;
  v_updated_count integer;
begin
  with upserted as (
    insert into stock_items (mdb_item_id, name, category, unit, qty_on_hand, min_threshold, active, expiry_date, is_emergency, last_synced_at, updated_at)
    select
      (r->>'mdb_item_id')::int,
      r->>'name',
      r->>'category',
      nullif(r->>'unit',''),
      coalesce((r->>'qty_on_hand')::int, 0),
      null,
      true,
      nullif(r->>'expiry_date','')::date,
      false,
      now(),
      now()
    from jsonb_array_elements(payload) as r
    on conflict (mdb_item_id) do update set
      qty_on_hand    = excluded.qty_on_hand,
      expiry_date    = excluded.expiry_date,
      last_synced_at = now(),
      updated_at     = now()
    returning (xmax = 0) as was_insert
  )
  select
    count(*) filter (where was_insert),
    count(*) filter (where not was_insert)
  into v_inserted_count, v_updated_count
  from upserted;

  inserted_count := v_inserted_count;
  updated_count := v_updated_count;
  return next;
end;
$function$;

-- Minimal per-user role tag for restricting the dashboard UI (e.g. Kallaya's
-- stock-only account). No row = full access (existing accounts unaffected).
create table if not exists staff_roles (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  role       text not null,
  created_at timestamptz not null default now()
);

-- ============================================================================
-- 10) ROW LEVEL SECURITY
--   Model: backend (Hono) uses service_role key -> bypasses RLS.
--          Dashboard uses authenticated users. Landing page reads via a
--          read-only anon policy limited to PUBLISHED content only.
--   PII tables (patients, appointments, leads, incident_log): NO anon access.
-- ============================================================================
alter table patients        enable row level security;
alter table appointments    enable row level security;
alter table leads           enable row level security;
alter table incident_log    enable row level security;
alter table vaccines        enable row level security;
alter table vaccine_rules   enable row level security;
alter table disease_groups  enable row level security;
alter table vaccine_aliases enable row level security;
alter table age_guide       enable row level security;
alter table clinic_hours    enable row level security;
alter table closures        enable row level security;
alter table clinic_config   enable row level security;
alter table articles        enable row level security;
alter table faq             enable row level security;
alter table promotions      enable row level security;
alter table packages        enable row level security;
alter table services        enable row level security;
alter table team            enable row level security;
alter table reviews         enable row level security;
alter table vaccine_news    enable row level security;
alter table stock_items     enable row level security;
alter table staff_roles     enable row level security;

-- Authenticated (dashboard) = full CRUD on everything
do $$
declare t text;
begin
  foreach t in array array[
    'patients','appointments','leads','incident_log','vaccines','vaccine_rules',
    'disease_groups','vaccine_aliases','age_guide','clinic_hours','closures',
    'clinic_config','articles','faq','promotions','packages','services','team',
    'reviews','vaccine_news','stock_items'
  ] loop
    execute format(
      'create policy %I on %I for all to authenticated using (true) with check (true);',
      t||'_auth_all', t);
  end loop;
end $$;

-- staff_roles: a user may read only their own role tag (not everyone's) —
-- deliberately not part of the generic full-CRUD loop above.
create policy staff_roles_self_read on staff_roles
  for select to authenticated using (auth.uid() = user_id);

-- Anonymous (landing page) = read-only, published/active content ONLY.
create policy vaccines_anon_read     on vaccines      for select to anon using (status = 'ACTIVE');
create policy rules_anon_read        on vaccine_rules for select to anon using (status = 'ACTIVE');
create policy disease_anon_read      on disease_groups for select to anon using (status = 'ACTIVE');
create policy alias_anon_read        on vaccine_aliases for select to anon using (true);
create policy age_anon_read          on age_guide     for select to anon using (true);
create policy hours_anon_read        on clinic_hours  for select to anon using (true);
create policy closures_anon_read     on closures      for select to anon using (active = true);
-- CRUD_ADMIN_PASSWORD is excluded so the anon key (embedded in the dashboard
-- frontend) can never read it directly via PostgREST — only the
-- verify-admin-password Edge Function (service role) can see it.
create policy config_anon_read       on clinic_config for select to anon using (key <> 'CRUD_ADMIN_PASSWORD');
create policy articles_anon_read     on articles      for select to anon using (published = true);
create policy faq_anon_read          on faq           for select to anon using (true);
create policy promo_anon_read        on promotions    for select to anon using (active = true);
create policy packages_anon_read     on packages      for select to anon using (status = 'ACTIVE');
create policy services_anon_read     on services      for select to anon using (active = true);
create policy team_anon_read         on team          for select to anon using (active = true);
create policy reviews_anon_read      on reviews       for select to anon using (permission_confirmed = true);
create policy news_anon_read         on vaccine_news  for select to anon using (status = true);

-- NOTE: patients / appointments / leads / incident_log intentionally have NO anon
-- policy -> anon key cannot read PII. Backend uses service_role.

-- ============================================================================
-- 11) Convenience view for the bot: active alias -> group lookup
-- ============================================================================
create or replace view v_intent_aliases as
  select a.alias, a.group_code, d.disease_group
  from vaccine_aliases a
  left join disease_groups d on d.group_code = a.group_code and d.status = 'ACTIVE';
