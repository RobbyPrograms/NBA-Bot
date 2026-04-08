-- Run once in Supabase → SQL Editor (free tier is fine).
-- Stores one full RoliBot JSON report per NBA slate date for history + grading.

create table if not exists public.slate_reports (
  slate_date date primary key,
  report jsonb not null,
  generated_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists slate_reports_created_at_idx
  on public.slate_reports (created_at desc);

alter table public.slate_reports enable row level security;

-- Read-only history for your site (anon key, server-side or RLS-safe client reads)
create policy "slate_reports_select_public"
  on public.slate_reports
  for select
  to anon, authenticated
  using (true);

-- Writes: use the service role from Railway (bypasses RLS). Do not expose service key in the browser.

comment on table public.slate_reports is 'Nightly RoliBot report JSON; keyed by slate_date from the report.';
