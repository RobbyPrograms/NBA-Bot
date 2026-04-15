#!/usr/bin/env python3
# ============================================================
#  RoliBot Grader  —  grades_picks.py
#  Run this the morning after each slate (or set as a cron)
#
#  Railway cron: 0 10 * * *  (10am ET daily)
#  This grades yesterday's picks using final NBA scores.
#
#  Required env vars:
#    SUPABASE_URL=https://xxxx.supabase.co
#    SUPABASE_SERVICE_KEY=eyJ...  (service role key — not anon)
#
#  What it does:
#  1. Finds all slates with PENDING picks
#  2. Pulls final scores from NBA API
#  3. Calls grade_slate() Supabase function
#  4. Updates graded_picks with WIN/LOSS/actual values
# ============================================================

import os, sys, json, time, urllib.request
from datetime import date, datetime, timedelta

try:
    from supabase import create_client
except ImportError:
    os.system("pip install supabase -q")
    from supabase import create_client

from nba_api.stats.endpoints import (
    scoreboardv2,
    boxscoretraditionalv2,
    leaguegamefinder,
)
from nba_api.stats.static import teams as nba_teams_static

# ─────────────────────────────────────────────────────────────
#  CONFIG
# ─────────────────────────────────────────────────────────────
SUPABASE_URL = os.environ.get("SUPABASE_URL","")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY","")  # service role!

if not SUPABASE_URL or not SUPABASE_KEY:
    raise SystemExit("Set SUPABASE_URL and SUPABASE_SERVICE_KEY env vars")

supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

team_list   = nba_teams_static.get_teams()
abbr_lookup = {t['id']: t['abbreviation'] for t in team_list}
id_lookup   = {t['abbreviation']: t['id'] for t in team_list}

# ─────────────────────────────────────────────────────────────
#  STEP 1 — Find slates that need grading
# ─────────────────────────────────────────────────────────────
def get_pending_slates():
    """Returns list of slate dates that have PENDING picks."""
    response = (
        supabase.table("graded_picks")
        .select("slate_date")
        .eq("result", "PENDING")
        .order("slate_date", desc=True)
        .execute()
    )
    dates = list({row['slate_date'] for row in response.data})
    return sorted(dates)

# ─────────────────────────────────────────────────────────────
#  STEP 2 — Get final scores for a date
# ─────────────────────────────────────────────────────────────
def get_final_scores(slate_date_str):
    """
    Pulls final scores from NBA API for a given date.
    Returns list of {home_abbr, away_abbr, home_score, away_score, game_id}
    """
    try:
        sb    = scoreboardv2.ScoreboardV2(game_date=slate_date_str)
        games = sb.game_header.get_data_frame()
        lines = sb.line_score.get_data_frame()

        if games.empty:
            return []

        results = []
        for _, game in games.iterrows():
            game_id   = game.get('GAME_ID','')
            status    = game.get('GAME_STATUS_TEXT','')
            home_id   = game.get('HOME_TEAM_ID')
            away_id   = game.get('VISITOR_TEAM_ID')
            home_abbr = abbr_lookup.get(home_id,'')
            away_abbr = abbr_lookup.get(away_id,'')

            # Only grade finished games
            if 'Final' not in str(status) and 'final' not in str(status).lower():
                print(f"  Skipping {away_abbr}@{home_abbr} — status: {status}")
                continue

            # Get scores from line score
            home_line = lines[lines['TEAM_ID'] == home_id]
            away_line = lines[lines['TEAM_ID'] == away_id]

            if home_line.empty or away_line.empty:
                continue

            home_pts = int(home_line.iloc[0].get('PTS', 0) or 0)
            away_pts = int(away_line.iloc[0].get('PTS', 0) or 0)

            results.append({
                'home_abbr':  home_abbr,
                'away_abbr':  away_abbr,
                'home_score': home_pts,
                'away_score': away_pts,
                'game_id':    game_id,
            })
            print(f"  {away_abbr} {away_pts}  @  {home_abbr} {home_pts}  ✓")

        return results
    except Exception as e:
        print(f"  ! Score fetch error: {e}")
        return []

# ─────────────────────────────────────────────────────────────
#  STEP 3 — Get player box scores for a game
# ─────────────────────────────────────────────────────────────
def get_player_stats(game_id):
    """
    Pulls final player box scores for prop grading.
    Returns list of {player, PTS, REB, AST, FG3M, STL, BLK, MIN}
    """
    if not game_id:
        return []
    try:
        time.sleep(1)
        box = boxscoretraditionalv2.BoxScoreTraditionalV2(game_id=game_id)
        df  = box.player_stats.get_data_frame()
        if df.empty:
            return []

        players = []
        for _, row in df.iterrows():
            name = str(row.get('PLAYER_NAME','')).strip()
            if not name: continue

            # Parse minutes (format: "32:15")
            mins_raw = str(row.get('MIN','0'))
            try:
                parts = mins_raw.split(':')
                mins  = int(parts[0]) + (int(parts[1])/60 if len(parts)>1 else 0)
            except:
                mins = 0

            if mins < 5: continue  # skip DNPs

            players.append({
                'player': name,
                'PTS':    int(row.get('PTS',  0) or 0),
                'REB':    int(row.get('REB',  0) or 0),
                'AST':    int(row.get('AST',  0) or 0),
                'FG3M':   int(row.get('FG3M', 0) or 0),
                'STL':    int(row.get('STL',  0) or 0),
                'BLK':    int(row.get('BLK',  0) or 0),
                'MIN':    round(mins, 1),
            })
        return players
    except Exception as e:
        print(f"  ! Box score error for {game_id}: {e}")
        return []

# ─────────────────────────────────────────────────────────────
#  STEP 4 — Parse picks from stored report + create rows
# ─────────────────────────────────────────────────────────────
def upsert_picks_from_report(slate_date_str):
    """
    Reads the stored JSON report for this date and creates
    PENDING rows in graded_picks for every pick.
    Uses the Supabase SQL function we defined.
    """
    try:
        result = supabase.rpc(
            'upsert_picks_from_report',
            {'p_slate_date': slate_date_str}
        ).execute()
        n = result.data
        print(f"  Created {n} pick rows from report")
        return n
    except Exception as e:
        print(f"  ! upsert error: {e}")
        return 0

# ─────────────────────────────────────────────────────────────
#  STEP 5 — Grade a full slate
# ─────────────────────────────────────────────────────────────
def grade_slate(slate_date_str, scores):
    """
    Calls the Supabase grade_slate function with final scores + player stats.
    """
    results_payload = []

    for game in scores:
        game_id     = game.get('game_id','')
        player_stats= get_player_stats(game_id)

        results_payload.append({
            'home_abbr':    game['home_abbr'],
            'away_abbr':    game['away_abbr'],
            'home_score':   game['home_score'],
            'away_score':   game['away_score'],
            'player_stats': player_stats,
        })

        print(f"  {game['away_abbr']}@{game['home_abbr']}: "
              f"{len(player_stats)} player stats loaded")
        time.sleep(0.8)

    try:
        result = supabase.rpc('grade_slate', {
            'p_slate_date': slate_date_str,
            'p_results':    json.dumps(results_payload),
        }).execute()
        n = result.data
        print(f"  Graded {n} picks")
        return n
    except Exception as e:
        print(f"  ! grade_slate error: {e}")
        return 0

# ─────────────────────────────────────────────────────────────
#  MAIN
# ─────────────────────────────────────────────────────────────
def main():
    print()
    print("=" * 56)
    print("  RoliBot Grader  —  running")
    print(f"  Today: {date.today()}")
    print("=" * 56)
    print()

    # Also run upsert for today's report if it exists
    # (creates PENDING rows right after the nightly script runs)
    today_str = date.today().isoformat()
    print(f"  Upserting today's picks ({today_str})...")
    upsert_picks_from_report(today_str)
    print()

    # Grade yesterday and any other pending slates
    pending = get_pending_slates()
    yesterday = (date.today() - timedelta(days=1)).isoformat()

    to_grade = [d for d in pending if d <= yesterday]

    if not to_grade:
        print("  No pending slates to grade.")
        print("  (Picks from today are PENDING until tomorrow)")
        return

    total_graded = 0
    for slate_date_str in to_grade:
        print(f"\n  Grading slate: {slate_date_str}")
        print("  " + "-"*40)

        scores = get_final_scores(slate_date_str)
        if not scores:
            print(f"  ! No final scores found for {slate_date_str}")
            print(f"  (Game may not have finished yet)")
            continue

        n = grade_slate(slate_date_str, scores)
        total_graded += n
        time.sleep(2)

    print()
    print("=" * 56)
    print(f"  Done. Total picks graded: {total_graded}")
    print("=" * 56)

    # Print current overall stats
    try:
        stats = supabase.table("pick_stats").select("*").execute()
        if stats.data:
            s = stats.data[0]
            print(f"\n  OVERALL STATS:")
            print(f"  Lifetime hit rate: {s.get('lifetime_hit_rate','N/A')}%")
            print(f"  Total graded     : {s.get('total_graded','N/A')}")
            print(f"  ML hit rate      : {s.get('ml_hit_rate','N/A')}%")
            print(f"  Props hit rate   : {s.get('props_hit_rate','N/A')}%")
            print(f"  Last 7d hit rate : {s.get('last_7d_hit_rate','N/A')}%")
    except Exception as e:
        print(f"  ! Stats fetch error: {e}")

if __name__ == "__main__":
    main()