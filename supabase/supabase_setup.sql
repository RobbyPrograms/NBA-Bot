-- ============================================================
--  RoliBot Supabase Schema  —  Full grading + live stats
--  Run this entire file in Supabase SQL Editor
--  Safe to re-run (uses IF NOT EXISTS everywhere)
-- ============================================================


-- ─────────────────────────────────────────────────────────────
--  1. SLATE REPORTS  (already exists — keeping for reference)
--  Stores the full nightly JSON from your Python script
-- ─────────────────────────────────────────────────────────────
create table if not exists public.slate_reports (
  slate_date   date primary key,
  report       jsonb not null,
  generated_at timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists slate_reports_created_at_idx
  on public.slate_reports (created_at desc);

alter table public.slate_reports enable row level security;

drop policy if exists "slate_reports_select_public" on public.slate_reports;
create policy "slate_reports_select_public"
  on public.slate_reports for select
  to anon, authenticated using (true);


-- ─────────────────────────────────────────────────────────────
--  2. GRADED PICKS  —  one row per bet recommendation
--  This is what powers your track record / hit rate stats.
--
--  How it works:
--  Your nightly script stores predictions in slate_reports.
--  A separate grading job (runs next morning) reads the final
--  scores from NBA API, compares to predictions, and upserts
--  rows here with result = 'WIN' | 'LOSS' | 'PUSH'.
--
--  The UI reads FROM THIS TABLE for all stats.
-- ─────────────────────────────────────────────────────────────
create table if not exists public.graded_picks (
  id              bigserial primary key,
  slate_date      date not null references public.slate_reports(slate_date),
  
  -- Game info
  home_abbr       text not null,
  away_abbr       text not null,
  home_name       text,
  away_name       text,
  
  -- The pick
  pick_type       text not null,     -- 'ML' | 'PROP'
  pick_name       text not null,     -- team name or player name
  pick_side       text,              -- 'HOME' | 'AWAY' (for ML picks)
  pick_label      text,              -- e.g. "20+ Pts" (for props)
  pick_stat       text,              -- 'PTS' | 'REB' | 'AST' etc
  pick_threshold  numeric,           -- e.g. 20 for "20+ points"
  
  -- Model probabilities
  model_prob      numeric,           -- our model's probability (0-1)
  market_prob     numeric,           -- implied market probability (0-1)
  market_edge     numeric,           -- model_prob - market_prob
  market_line     integer,           -- American odds e.g. -150
  market_book     text,              -- which book had best line
  kelly_amt       numeric,           -- recommended bet size $
  confidence      text,              -- 'STRONG' | 'GOOD' | 'LEAN'
  stars           text,              -- '***' | '**' | '*'
  
  -- Actual result (filled in by grading job)
  result          text,              -- 'WIN' | 'LOSS' | 'PUSH' | 'PENDING'
  actual_value    numeric,           -- actual stat value (for props)
  home_score      integer,           -- final home score
  away_score      integer,           -- final away score
  actual_winner   text,              -- 'HOME' | 'AWAY'
  graded_at       timestamptz,
  
  -- Metadata
  hit_rate_at_time numeric,          -- model's hit rate when pick was made
  model_version   text,              -- 'v5' etc
  created_at      timestamptz not null default now(),
  
  unique (slate_date, pick_type, pick_name, pick_label, home_abbr, away_abbr)
);

create index if not exists graded_picks_slate_date_idx on public.graded_picks (slate_date desc);
create index if not exists graded_picks_result_idx     on public.graded_picks (result);
create index if not exists graded_picks_pick_type_idx  on public.graded_picks (pick_type);
create index if not exists graded_picks_pick_name_idx  on public.graded_picks (pick_name);

alter table public.graded_picks enable row level security;

drop policy if exists "graded_picks_select_public" on public.graded_picks;
create policy "graded_picks_select_public"
  on public.graded_picks for select
  to anon, authenticated using (true);


-- ─────────────────────────────────────────────────────────────
--  3. LIVE STATS VIEW
--  Pre-computed stats your UI reads directly.
--  No complex client-side math needed.
--  Updates automatically whenever graded_picks changes.
-- ─────────────────────────────────────────────────────────────
drop view if exists public.pick_stats;
create view public.pick_stats as
select
  -- Overall stats (all graded picks)
  count(*) filter (where result in ('WIN','LOSS','PUSH'))  as total_graded,
  count(*) filter (where result = 'WIN')                   as total_wins,
  count(*) filter (where result = 'LOSS')                  as total_losses,
  count(*) filter (where result = 'PUSH')                  as total_pushes,
  count(*) filter (where result = 'PENDING')               as total_pending,
  
  round(
    count(*) filter (where result = 'WIN')::numeric /
    nullif(count(*) filter (where result in ('WIN','LOSS')), 0) * 100,
    1
  ) as lifetime_hit_rate,

  -- ML picks only
  count(*) filter (where pick_type = 'ML' and result in ('WIN','LOSS'))  as ml_graded,
  round(
    count(*) filter (where pick_type = 'ML' and result = 'WIN')::numeric /
    nullif(count(*) filter (where pick_type = 'ML' and result in ('WIN','LOSS')), 0) * 100,
    1
  ) as ml_hit_rate,

  -- Props only
  count(*) filter (where pick_type = 'PROP' and result in ('WIN','LOSS')) as props_graded,
  round(
    count(*) filter (where pick_type = 'PROP' and result = 'WIN')::numeric /
    nullif(count(*) filter (where pick_type = 'PROP' and result in ('WIN','LOSS')), 0) * 100,
    1
  ) as props_hit_rate,

  -- Strong picks only (stars = ***)
  count(*) filter (where stars = '***' and result in ('WIN','LOSS'))  as strong_graded,
  round(
    count(*) filter (where stars = '***' and result = 'WIN')::numeric /
    nullif(count(*) filter (where stars = '***' and result in ('WIN','LOSS')), 0) * 100,
    1
  ) as strong_hit_rate,

  -- Last 7 days
  count(*) filter (
    where result in ('WIN','LOSS') and slate_date >= current_date - 7
  ) as last_7d_graded,
  round(
    count(*) filter (where result = 'WIN' and slate_date >= current_date - 7)::numeric /
    nullif(count(*) filter (where result in ('WIN','LOSS') and slate_date >= current_date - 7), 0) * 100,
    1
  ) as last_7d_hit_rate,

  -- Last 30 days
  count(*) filter (
    where result in ('WIN','LOSS') and slate_date >= current_date - 30
  ) as last_30d_graded,
  round(
    count(*) filter (where result = 'WIN' and slate_date >= current_date - 30)::numeric /
    nullif(count(*) filter (where result in ('WIN','LOSS') and slate_date >= current_date - 30), 0) * 100,
    1
  ) as last_30d_hit_rate,

  -- ROI (if you had bet $100 Kelly on every pick)
  -- Simplified: wins at market odds, losses at -$100
  round(
    sum(
      case
        when result = 'WIN'  then 100.0 / nullif(market_prob, 0) - 100
        when result = 'LOSS' then -100
        else 0
      end
    ) filter (where result in ('WIN','LOSS') and market_prob is not null),
    2
  ) as roi_flat_100,

  -- Best performing stat type for props
  mode() within group (order by pick_stat) filter (
    where pick_type = 'PROP' and result = 'WIN'
  ) as best_prop_stat

from public.graded_picks;


-- ─────────────────────────────────────────────────────────────
--  4. RECENT FORM VIEW  (last 10 graded picks for streak display)
-- ─────────────────────────────────────────────────────────────
drop view if exists public.recent_picks;
create view public.recent_picks as
select
  id, slate_date, pick_type, pick_name, pick_label,
  pick_side, home_abbr, away_abbr, home_name, away_name,
  model_prob, market_edge, market_line, market_book,
  kelly_amt, confidence, stars,
  result, actual_value, pick_threshold,
  graded_at, created_at
from public.graded_picks
where result in ('WIN','LOSS','PUSH','PENDING')
order by created_at desc
limit 50;


-- ─────────────────────────────────────────────────────────────
--  5. DAILY BREAKDOWN VIEW  (performance per day for chart)
-- ─────────────────────────────────────────────────────────────
drop view if exists public.daily_stats;
create view public.daily_stats as
select
  slate_date,
  count(*) filter (where result in ('WIN','LOSS'))  as graded,
  count(*) filter (where result = 'WIN')             as wins,
  count(*) filter (where result = 'LOSS')            as losses,
  round(
    count(*) filter (where result = 'WIN')::numeric /
    nullif(count(*) filter (where result in ('WIN','LOSS')), 0) * 100,
    1
  ) as hit_rate,
  round(
    sum(case
      when result = 'WIN'  then 100.0 / nullif(market_prob, 0) - 100
      when result = 'LOSS' then -100
      else 0
    end) filter (where result in ('WIN','LOSS') and market_prob is not null),
    2
  ) as daily_pnl
from public.graded_picks
group by slate_date
order by slate_date desc;


-- ─────────────────────────────────────────────────────────────
--  6. PLAYER PROP STATS VIEW  (per player accuracy)
-- ─────────────────────────────────────────────────────────────
drop view if exists public.player_prop_stats;
create view public.player_prop_stats as
select
  pick_name                                            as player_name,
  pick_stat                                            as stat_type,
  count(*) filter (where result in ('WIN','LOSS'))     as total_graded,
  count(*) filter (where result = 'WIN')               as wins,
  round(
    count(*) filter (where result = 'WIN')::numeric /
    nullif(count(*) filter (where result in ('WIN','LOSS')), 0) * 100,
    1
  ) as hit_rate,
  round(avg(model_prob) * 100, 1)                      as avg_model_confidence,
  round(avg(actual_value), 1)                          as avg_actual,
  round(avg(pick_threshold), 1)                        as avg_threshold
from public.graded_picks
where pick_type = 'PROP'
  and result in ('WIN','LOSS')
group by pick_name, pick_stat
having count(*) filter (where result in ('WIN','LOSS')) >= 3
order by hit_rate desc, total_graded desc;


-- ─────────────────────────────────────────────────────────────
--  7. CALIBRATION VIEW
--  Shows: does 70% confidence actually hit 70%?
--  This is the most important accuracy metric.
-- ─────────────────────────────────────────────────────────────
drop view if exists public.calibration_stats;
create view public.calibration_stats as
select
  case
    when model_prob >= 0.50 and model_prob < 0.55 then '50-55%'
    when model_prob >= 0.55 and model_prob < 0.60 then '55-60%'
    when model_prob >= 0.60 and model_prob < 0.65 then '60-65%'
    when model_prob >= 0.65 and model_prob < 0.70 then '65-70%'
    when model_prob >= 0.70 and model_prob < 0.75 then '70-75%'
    when model_prob >= 0.75                        then '75%+'
  end as confidence_bucket,
  count(*)                                             as n_picks,
  count(*) filter (where result = 'WIN')               as wins,
  round(
    count(*) filter (where result = 'WIN')::numeric /
    nullif(count(*) filter (where result in ('WIN','LOSS')), 0) * 100,
    1
  ) as actual_hit_rate,
  round(avg(model_prob) * 100, 1)                      as avg_model_confidence,
  -- If actual_hit_rate ≈ avg_model_confidence the model is well calibrated
  round(
    count(*) filter (where result = 'WIN')::numeric /
    nullif(count(*) filter (where result in ('WIN','LOSS')), 0) * 100 -
    avg(model_prob) * 100,
    1
  ) as calibration_error
from public.graded_picks
where result in ('WIN','LOSS')
  and model_prob is not null
group by confidence_bucket
order by confidence_bucket;


-- ─────────────────────────────────────────────────────────────
--  8. REAL-TIME SUBSCRIPTION SETUP
--  Enables Supabase Realtime so your UI updates instantly
--  when new grades come in — no polling needed.
-- ─────────────────────────────────────────────────────────────
alter publication supabase_realtime add table public.graded_picks;
alter publication supabase_realtime add table public.slate_reports;


-- ─────────────────────────────────────────────────────────────
--  9. HELPER FUNCTION — parse JSON report into graded_picks rows
--  Call this from your grading script or a Supabase Edge Function.
--
--  Usage:
--    select upsert_picks_from_report('2026-04-14');
--
--  This reads the stored JSON for that date and creates
--  PENDING rows in graded_picks for every pick recommendation.
--  The grading job later updates result to WIN/LOSS.
-- ─────────────────────────────────────────────────────────────
create or replace function public.upsert_picks_from_report(p_slate_date date)
returns integer
language plpgsql
security definer
as $$
declare
  v_report    jsonb;
  v_game      jsonb;
  v_pick      jsonb;
  v_prop      jsonb;
  v_inserted  integer := 0;
begin
  -- Get the stored report
  select report into v_report
  from public.slate_reports
  where slate_date = p_slate_date;

  if v_report is null then
    raise exception 'No report found for date %', p_slate_date;
  end if;

  -- Process ML game picks from bet_slip.strong + bet_slip.good
  for v_pick in
    select * from jsonb_array_elements(
      coalesce(v_report->'bet_slip'->'strong', '[]'::jsonb) ||
      coalesce(v_report->'bet_slip'->'good',   '[]'::jsonb) ||
      coalesce(v_report->'bet_slip'->'lean',   '[]'::jsonb)
    )
  loop
    -- Find the full game data for this pick
    select g into v_game
    from jsonb_array_elements(coalesce(v_report->'games', '[]'::jsonb)) g
    where g->>'pick_name' = v_pick->>'pick'
    limit 1;

    if v_game is null then continue; end if;

    insert into public.graded_picks (
      slate_date, home_abbr, away_abbr, home_name, away_name,
      pick_type, pick_name, pick_side,
      model_prob, market_prob, market_edge, market_line, market_book,
      kelly_amt, confidence, stars,
      result, model_version
    ) values (
      p_slate_date,
      v_game->>'home_abbr',
      v_game->>'away_abbr',
      v_game->>'home_name',
      v_game->>'away_name',
      'ML',
      v_pick->>'pick',
      v_game->>'pick_side',
      (v_game->>'pick_prob')::numeric,
      (v_game->>'market_prob')::numeric,
      (v_game->>'market_edge')::numeric,
      (v_pick->>'line')::integer,
      v_pick->>'book',
      (v_pick->>'kelly')::numeric,
      v_game->>'confidence',
      v_game->>'stars',
      'PENDING',
      v_report->>'brand'
    )
    on conflict (slate_date, pick_type, pick_name, pick_label, home_abbr, away_abbr)
    do update set
      model_prob   = excluded.model_prob,
      market_prob  = excluded.market_prob,
      market_edge  = excluded.market_edge,
      market_line  = excluded.market_line,
      market_book  = excluded.market_book,
      kelly_amt    = excluded.kelly_amt,
      confidence   = excluded.confidence;

    v_inserted := v_inserted + 1;
  end loop;

  -- Process prop picks from each game's top_props
  for v_game in select * from jsonb_array_elements(coalesce(v_report->'games','[]'::jsonb))
  loop
    for v_prop in select * from jsonb_array_elements(coalesce(v_game->'top_props','[]'::jsonb))
    loop
      -- Only insert if hit_rate >= 0.65 (strong/good props)
      if (v_prop->>'hit_rate')::numeric < 0.65 then continue; end if;

      insert into public.graded_picks (
        slate_date, home_abbr, away_abbr, home_name, away_name,
        pick_type, pick_name, pick_label, pick_stat, pick_threshold,
        model_prob, confidence, stars, result, model_version
      ) values (
        p_slate_date,
        v_game->>'home_abbr',
        v_game->>'away_abbr',
        v_game->>'home_name',
        v_game->>'away_name',
        'PROP',
        v_prop->>'player',
        v_prop->>'label',
        v_prop->>'stat',
        (v_prop->>'threshold')::numeric,
        (v_prop->>'hit_rate')::numeric,
        v_prop->>'confidence',
        v_prop->>'stars',
        'PENDING',
        v_report->>'brand'
      )
      on conflict (slate_date, pick_type, pick_name, pick_label, home_abbr, away_abbr)
      do update set
        model_prob  = excluded.model_prob,
        confidence  = excluded.confidence;

      v_inserted := v_inserted + 1;
    end loop;
  end loop;

  return v_inserted;
end;
$$;


-- ─────────────────────────────────────────────────────────────
--  10. GRADING FUNCTION
--  Call this the morning after with actual scores.
--  Your grading script passes final scores for each game.
--
--  Usage from Python:
--    supabase.rpc('grade_slate', {
--      'p_slate_date': '2026-04-14',
--      'p_results': [
--        {'home_abbr': 'LAL', 'away_abbr': 'BOS',
--         'home_score': 108, 'away_score': 112},
--        ...
--      ]
--    }).execute()
-- ─────────────────────────────────────────────────────────────
create or replace function public.grade_slate(
  p_slate_date date,
  p_results    jsonb   -- array of {home_abbr, away_abbr, home_score, away_score, player_stats}
)
returns integer
language plpgsql
security definer
as $$
declare
  v_result      jsonb;
  v_home_score  integer;
  v_away_score  integer;
  v_winner      text;
  v_graded      integer := 0;
  v_rowcount    integer;
  v_player_stat jsonb;
  v_actual_val  numeric;
begin
  for v_result in select * from jsonb_array_elements(p_results)
  loop
    v_home_score := (v_result->>'home_score')::integer;
    v_away_score := (v_result->>'away_score')::integer;
    v_winner := case when v_home_score > v_away_score then 'HOME' else 'AWAY' end;

    -- Grade ML picks for this game
    update public.graded_picks
    set
      result       = case
                       when pick_side = v_winner then 'WIN'
                       when pick_side is null    then 'PENDING'
                       else 'LOSS'
                     end,
      home_score   = v_home_score,
      away_score   = v_away_score,
      actual_winner = v_winner,
      graded_at    = now()
    where slate_date  = p_slate_date
      and pick_type   = 'ML'
      and home_abbr   = v_result->>'home_abbr'
      and away_abbr   = v_result->>'away_abbr'
      and result      = 'PENDING';

    get diagnostics v_rowcount = ROW_COUNT;
    v_graded := v_graded + coalesce(v_rowcount, 0);

    -- Grade prop picks using player_stats from the result
    -- player_stats: [{player: "Jokic", PTS: 28, REB: 12, AST: 8, FG3M: 2, STL: 1, BLK: 1}]
    for v_player_stat in
      select * from jsonb_array_elements(coalesce(v_result->'player_stats', '[]'::jsonb))
    loop
      update public.graded_picks gp
      set
        actual_value = (v_player_stat->>gp.pick_stat)::numeric,
        result = case
                   when (v_player_stat->>gp.pick_stat)::numeric >= gp.pick_threshold
                   then 'WIN'
                   else 'LOSS'
                 end,
        home_score  = v_home_score,
        away_score  = v_away_score,
        graded_at   = now()
      where gp.slate_date = p_slate_date
        and gp.pick_type  = 'PROP'
        and gp.home_abbr  = v_result->>'home_abbr'
        and gp.away_abbr  = v_result->>'away_abbr'
        and gp.pick_name  ilike '%' || (v_player_stat->>'player') || '%'
        and gp.result     = 'PENDING'
        and gp.pick_stat  is not null
        and (v_player_stat->>gp.pick_stat) is not null;

      get diagnostics v_rowcount = ROW_COUNT;
      v_graded := v_graded + coalesce(v_rowcount, 0);
    end loop;

  end loop;

  return v_graded;
end;
$$;


-- ─────────────────────────────────────────────────────────────
--  VERIFY SETUP — run these to confirm everything works
-- ─────────────────────────────────────────────────────────────

-- Check your views exist
select viewname from pg_views where schemaname = 'public'
order by viewname;

-- Check your functions exist  
select proname from pg_proc 
where pronamespace = 'public'::regnamespace
order by proname;

-- Check realtime is enabled
select * from pg_publication_tables 
where pubname = 'supabase_realtime'
  and tablename in ('graded_picks','slate_reports');

-- Once you have data, test the stats view:
-- select * from public.pick_stats;
-- select * from public.daily_stats limit 30;
-- select * from public.calibration_stats;