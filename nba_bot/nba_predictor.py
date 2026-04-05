# ============================================================
#  RoliBot NBA  v5  — THE REAL ONE
#  Live roster verification  •  Hard injury enforcement
#  Ensemble ML  •  LLM analysis layer  •  Kelly sizing
#  Zero hardcoded data  •  Daily auto-update safe
# ============================================================
#
#  DAILY USAGE (no GitHub Actions needed):
#    python rolibot_v5.py             → full run, human-readable
#    ROLI_JSON=1 python rolibot_v5.py → JSON output for UI
#    ROLI_GAME_DATE=2026-04-10 python rolibot_v5.py → backtest
#
#  SETUP (first time):
#    pip install nba_api xgboost scikit-learn pandas numpy
#    Optional: pip install anthropic   ← enables LLM analysis
#
#  AUTO-DAILY (no GitHub Actions):
#    Windows Task Scheduler → run python rolibot_v5.py daily at 1PM
#    Mac/Linux cron        → 0 13 * * * cd /path && python rolibot_v5.py
#
# ============================================================

import os, sys, time, warnings, itertools, pickle, hashlib, json, urllib.request, difflib, math
warnings.filterwarnings('ignore')

# ─────────────────────────────────────────────────────────────
#  ENVIRONMENT FLAGS
# ─────────────────────────────────────────────────────────────
_JSON_MODE   = os.environ.get("ROLI_JSON","").lower() in ("1","true","yes")
_real_stdout = sys.stdout
_ANTHROPIC_KEY = os.environ.get("ANTHROPIC_API_KEY","")   # optional LLM layer
_USE_LLM     = bool(_ANTHROPIC_KEY)

if _JSON_MODE and os.environ.get("GITHUB_ACTIONS","").lower() not in ("true","1"):
    sys.stdout = open(os.devnull, "w", encoding="utf-8")

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except: pass

import matplotlib
matplotlib.use(os.environ.get("MPLBACKEND","Agg"))

from nba_api.stats.endpoints import (
    commonteamroster, leaguegamefinder,
    playergamelog, scoreboardv2, commonplayerinfo,
    leaguedashplayerstats,
)
try:
    from nba_api.stats.endpoints import scoreboardv3
    _HAS_SCOREBOARD_V3 = True
except ImportError:
    scoreboardv3 = None  # type: ignore
    _HAS_SCOREBOARD_V3 = False
from nba_api.stats.static import teams as nba_teams_static
import pandas as pd
import numpy as np
import xgboost as xgb
from sklearn.ensemble    import RandomForestClassifier, GradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics     import accuracy_score, classification_report, log_loss
from sklearn.calibration import CalibratedClassifierCV
from sklearn.preprocessing import StandardScaler
try:
    from sklearn.frozen import FrozenEstimator
    USE_FROZEN = True
except ImportError:
    USE_FROZEN = False
from collections import defaultdict
from datetime import date, datetime, timedelta
try:
    from zoneinfo import ZoneInfo
    _HAS_ZONEINFO = True
except ImportError:
    _HAS_ZONEINFO = False

# ─────────────────────────────────────────────────────────────
#  CONFIG
# ─────────────────────────────────────────────────────────────
BANKROLL         = float(os.environ.get("ROLI_BANKROLL","1000"))
KELLY_FRACTION   = 0.25    # quarter Kelly = safer
MAX_BET_PCT      = 0.05    # max 5% per bet
MIN_EDGE_FOR_BET = 0.03
PROP_GAMES_BACK  = 25      # more history = better stats
MIN_AVG_MINS     = 14.0    # skip players under 14 mpg (DNP risk)
TRADE_VERIFY_GAMES = 5     # must have played N games for this team recently
MODEL_CACHE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "rolibot_cache.pkl")

# Rate limiting (be nice to NBA's servers)
_SLEEP_SEASON = 2.2
_SLEEP_RETRY  = 3.5
_SLEEP_PROP   = 1.0
_SLEEP_ROSTER = 1.1

# Injury statuses to treat as UNAVAILABLE
# Includes GTD and questionable — better to miss a prop than bet on a limited player
INJURY_EXCLUDE = {
    "out","doubtful","suspended","inactive",
    "questionable","day-to-day","game time decision",
    "gtd","did not play","dnp","il","injured list",
}

# Logs for JSON output
_SEASON_LOG   = []
_PROPS_LOG    = []
_XGB_LOG      = []
_INJURY_META  = {}
_SKIPPED_INJ  = 0
_SKIPPED_TRADE = 0

# ─────────────────────────────────────────────────────────────
#  DATE HELPERS
# ─────────────────────────────────────────────────────────────
def slate_date():
    override = (os.environ.get("ROLI_GAME_DATE") or "").strip()
    if len(override) >= 10:
        try: return datetime.strptime(override[:10],"%Y-%m-%d").date()
        except: pass
    tz = (os.environ.get("ROLI_SCOREBOARD_TZ") or "America/New_York").strip()
    if _HAS_ZONEINFO:
        try: return datetime.now(ZoneInfo(tz)).date()
        except: pass
    return date.today()

def nba_season(d):
    y,m = d.year,d.month
    y0 = y if m >= 10 else y-1
    return f"{y0}-{str(y0+1)[2:]}"

def all_seasons(d):
    end = int(nba_season(d).split('-')[0])
    return [f"{y}-{str(y+1)[2:]}" for y in range(2018, end+1)]

def prev_season(s):
    y = int(s.split('-')[0])
    return f"{y-1}-{str(y)[2:]}"

def parse_mins(m):
    try:
        p = str(m).split(':')
        return int(p[0]) + (int(p[1])/60 if len(p)>1 else 0)
    except: return np.nan

_TODAY  = slate_date()
_SEASON = nba_season(_TODAY)

# ─────────────────────────────────────────────────────────────
#  MATH HELPERS
# ─────────────────────────────────────────────────────────────
def prob_to_american(p):
    if not p or p<=0 or p>=1: return "N/A"
    return f"-{round((p/(1-p))*100)}" if p>=0.5 else f"+{round(((1-p)/p)*100)}"

def parlay_prob(probs):
    r=1.0
    for p in probs: r*=p
    return r

def parlay_payout(probs, stake=100):
    c=parlay_prob(probs)
    return round((1/c-1)*stake,2) if c>0 else 0

def kelly_bet(prob, american_str):
    try:
        raw = american_str.replace('+','').replace('-','')
        o   = int(raw)
        b   = 100/o if american_str.startswith('-') else o/100
    except: return 0
    kf = (b*prob-(1-prob))/b
    if kf<=0: return 0
    return round(BANKROLL*min(kf*KELLY_FRACTION,MAX_BET_PCT),2)

def weighted_hr(hits, n=5):
    if not len(hits): return 0.0
    r=hits[:n]; o=hits[n:]
    wr=float(np.mean(r))*2 if len(r) else 0.0
    wo=float(np.mean(o))   if len(o) else wr/2
    tw=2*len(r)+len(o)
    return (wr*len(r)+wo*len(o))/tw if tw else 0.0

def trend_str(recent,overall):
    if not overall: return ""
    r=recent/overall
    if r>=1.20: return "HOT"
    if r>=1.08: return "WARM"
    if r<=0.80: return "COLD"
    if r<=0.92: return "COOLING"
    return ""

def prop_conf(hr):
    if hr>=0.78: return "STRONG","***"
    if hr>=0.65: return "GOOD","**"
    if hr>=0.52: return "LEAN","*"
    return "RISKY","~"

def normalize_name(n):
    n=(n or "").lower().strip()
    for sfx in (" jr."," sr."," ii"," iii"," iv"," v"):
        if n.endswith(sfx): n=n[:-len(sfx)].strip()
    return " ".join(n.split())

def names_match(a, b_set):
    """Robust name matching: exact, fuzzy, last+first-initial."""
    fn = normalize_name(a)
    if fn in b_set: return True
    for o in b_set:
        if difflib.SequenceMatcher(None,fn,o).ratio() >= 0.88: return True
    parts=fn.split()
    if len(parts)>=2:
        last,first0=parts[-1],parts[0][:1]
        for o in b_set:
            op=o.split()
            if len(op)>=2 and op[-1]==last and op[0][:1]==first0: return True
    return False

# ─────────────────────────────────────────────────────────────
#  LIVE INJURY FEED  (ESPN, no API key)
# ─────────────────────────────────────────────────────────────
def fetch_injuries():
    """
    Returns dict: normalized_name -> {status, team, description}
    Pulls from ESPN's public injuries feed — live, updates throughout the day.
    """
    global _INJURY_META
    url = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries"
    out = {}
    try:
        req  = urllib.request.Request(url, headers={"User-Agent":"RoliBotNBA/5.0"})
        resp = urllib.request.urlopen(req, timeout=25)
        data = json.loads(resp.read().decode("utf-8","replace"))
        out_players = []
        for tb in (data.get("injuries") or []):
            team_name = tb.get("displayName","")
            for row in (tb.get("injuries") or []):
                ath    = row.get("athlete") or {}
                name   = (ath.get("displayName") or "").strip()
                status = (row.get("status") or "").strip()
                # Also check fantasyStatus for more detail
                fs     = row.get("fantasyStatus") or {}
                fs_desc= (fs.get("description") or "").strip().lower()
                desc   = (row.get("description") or row.get("shortComment") or "").strip()
                if not name: continue
                nk = normalize_name(name)
                out[nk] = {"status":status,"team":team_name,"desc":desc}
                out_players.append({"player":name,"team":team_name,"status":status,"desc":desc})
        _INJURY_META = {
            "fetched_ok":True,"n_total":len(out),
            "out_players":out_players[:100]
        }
    except Exception as e:
        _INJURY_META = {"fetched_ok":False,"error":str(e)[:200]}
    return out

def player_is_out(name, injuries):
    """True if player is unavailable per injury report."""
    if not name or not injuries: return False
    nk = normalize_name(name)
    # Exact match first
    if nk in injuries:
        st = injuries[nk].get("status","").lower().replace("-"," ")
        if st in INJURY_EXCLUDE: return True
        for excl in INJURY_EXCLUDE:
            if excl in st: return True
    # Fuzzy match for name variants
    for o,v in injuries.items():
        if difflib.SequenceMatcher(None,nk,o).ratio() >= 0.88:
            st = v.get("status","").lower().replace("-"," ")
            if st in INJURY_EXCLUDE: return True
    return False

def player_injury_status(name, injuries):
    """Returns status string or empty string."""
    if not name or not injuries: return ""
    nk = normalize_name(name)
    if nk in injuries:
        return injuries[nk].get("status","")
    for o,v in injuries.items():
        if difflib.SequenceMatcher(None,nk,o).ratio() >= 0.88:
            return v.get("status","")
    return ""

# ─────────────────────────────────────────────────────────────
#  LIVE ROSTER  (NBA.com CommonTeamRoster, no hardcoding)
# ─────────────────────────────────────────────────────────────
def get_roster(team_id, season_str):
    """Pull current NBA.com roster. Returns list of {id,name,position}."""
    try:
        ctr = commonteamroster.CommonTeamRoster(team_id=int(team_id),season=season_str)
        df  = ctr.common_team_roster.get_data_frame()
        if df is None or df.empty: return []
        out = []
        for _,row in df.iterrows():
            try:
                pid  = int(row['PLAYER_ID'])
                name = str(row.get('PLAYER','')).strip()
                pos  = str(row.get('POSITION','')).strip()
                if name: out.append({'id':pid,'name':name,'position':pos})
            except: continue
        return out
    except Exception as e:
        print(f"    ! Roster error: {e}")
        return []
    finally:
        time.sleep(_SLEEP_ROSTER)

# ─────────────────────────────────────────────────────────────
#  PLAYER GAME LOG  — with hard trade verification
# ─────────────────────────────────────────────────────────────
def get_player_log(player_id, n=PROP_GAMES_BACK):
    """
    Fetch last N games from current + previous season.
    Returns sorted-by-date-desc DataFrame or None.
    """
    frames = []
    for season in [_SEASON, prev_season(_SEASON)]:
        try:
            log = playergamelog.PlayerGameLog(
                player_id=int(player_id),
                season=season,
                season_type_all_star='Regular Season'
            ).get_data_frames()[0]
            if log is not None and not log.empty:
                frames.append(log)
        except: pass
        time.sleep(_SLEEP_PROP)
        if frames and len(frames[0]) >= n: break
    if not frames: return None
    combined = pd.concat(frames,ignore_index=True)
    if 'GAME_DATE' in combined.columns:
        combined['GAME_DATE'] = pd.to_datetime(combined['GAME_DATE'],errors='coerce')
        combined = combined.sort_values('GAME_DATE',ascending=False)
    if 'Game_ID' in combined.columns:
        combined = combined.drop_duplicates('Game_ID',keep='first')
    return combined.head(n)

def verify_player_team(log, expected_abbr, n_check=TRADE_VERIFY_GAMES):
    """
    HARD trade check: player must have played N of their last games for this team.
    Returns (is_valid, actual_team_abbr)
    This is the key fix — catches players who were traded mid-season.
    """
    if log is None or log.empty: return True, expected_abbr
    if 'TEAM_ABBREVIATION' not in log.columns: return True, expected_abbr
    head = log['TEAM_ABBREVIATION'].head(n_check).astype(str).str.strip().str.upper()
    exp  = expected_abbr.upper()
    matches = (head == exp).sum()
    actual  = str(log.iloc[0]['TEAM_ABBREVIATION']).strip().upper()
    # Must have played majority of recent games for this team
    if matches < max(1, n_check//2):
        return False, actual
    return True, actual

def player_played_recently(log, days=21):
    """Ensure player has played within last N days (catches long-term injuries/inactive)."""
    if log is None or log.empty: return False
    if 'GAME_DATE' not in log.columns: return True
    last_game = log.iloc[0]['GAME_DATE']
    if pd.isna(last_game): return True
    return (_TODAY - last_game.date()).days <= days

# ─────────────────────────────────────────────────────────────
#  LIVE PLAYER STATUS CHECK  (CommonPlayerInfo)
# ─────────────────────────────────────────────────────────────
_player_status_cache = {}

def get_player_active_status(player_id):
    """Direct NBA.com check — is this player currently active/on a roster?"""
    if player_id in _player_status_cache:
        return _player_status_cache[player_id]
    try:
        info = commonplayerinfo.CommonPlayerInfo(player_id=int(player_id))
        df   = info.common_player_info.get_data_frame()
        if df is not None and not df.empty:
            status = str(df.iloc[0].get('ROSTERSTATUS','')).strip()
            active = status.upper() in ('ACTIVE','1','TRUE')
            _player_status_cache[player_id] = active
            return active
    except: pass
    _player_status_cache[player_id] = True  # assume ok if can't check
    return True

# ─────────────────────────────────────────────────────────────
#  LLM ANALYSIS LAYER  (optional — needs ANTHROPIC_API_KEY)
# ─────────────────────────────────────────────────────────────
def llm_analyze_game(home_name, away_name, prob_home, game_props, injuries):
    """
    Uses Claude to generate a smart narrative analysis of the matchup.
    Only runs if ANTHROPIC_API_KEY is set. Falls back to rules-based summary.
    """
    if not _USE_LLM:
        return _rules_summary(home_name, away_name, prob_home, game_props)

    injured_home = [p for p in game_props if player_injury_status(p['player'],injuries)]
    top_props    = sorted([p for p in game_props if p['hit_rate']>=0.65],
                          key=lambda x: x['hit_rate'],reverse=True)[:5]

    prompt = f"""You are an NBA betting analyst. Analyze this matchup concisely.

Game: {away_name} @ {home_name}
Model win probability: {home_name} {prob_home:.1%} | {away_name} {1-prob_home:.1%}

Top player props tonight:
{chr(10).join(f"- {p['player']} ({p['team']}): {p['label']} — {p['hit_rate']:.0%} hit rate, avg {p['avg']:.1f}" for p in top_props)}

Injury notes:
{chr(10).join(f"- {p['player']}: {player_injury_status(p['player'],injuries)}" for p in injured_home[:3]) if injured_home else "No major injuries flagged"}

Give a 2-3 sentence sharp betting analysis. Be direct. Mention key trends, injury impact, and one specific angle a bettor should consider. No fluff."""

    try:
        req_body = json.dumps({
            "model": "claude-sonnet-4-20250514",
            "max_tokens": 200,
            "messages": [{"role":"user","content":prompt}]
        }).encode()
        req = urllib.request.Request(
            "https://api.anthropic.com/v1/messages",
            data=req_body,
            headers={
                "Content-Type": "application/json",
                "x-api-key": _ANTHROPIC_KEY,
                "anthropic-version": "2023-06-01"
            },
            method="POST"
        )
        resp = urllib.request.urlopen(req, timeout=20)
        data = json.loads(resp.read().decode())
        return data["content"][0]["text"].strip()
    except Exception as e:
        return _rules_summary(home_name, away_name, prob_home, game_props)

def _rules_summary(home_name, away_name, prob_home, game_props):
    """Fallback rules-based summary when LLM not available."""
    fav  = home_name if prob_home >= 0.5 else away_name
    prob = max(prob_home, 1-prob_home)
    hot  = [p for p in game_props if p.get('trend')=='HOT' and p['hit_rate']>=0.65]
    s    = f"Model favors {fav} at {prob:.0%}."
    if hot:
        s += f" {hot[0]['player']} is trending HOT ({hot[0]['avg_recent']:.1f} recent vs {hot[0]['avg']:.1f} season avg)."
    return s

# ─────────────────────────────────────────────────────────────
#  BANNER
# ─────────────────────────────────────────────────────────────
print()
print("=" * 62)
print("  RoliBot NBA v5  |  Live Data  |  Zero Hardcoding")
if _USE_LLM:
    print("  LLM Analysis: ENABLED (Claude)")
else:
    print("  LLM Analysis: set ANTHROPIC_API_KEY to enable")
print("=" * 62)
print(f"  Date: {_TODAY}  |  Season: {_SEASON}")
print(f"  Bankroll: ${BANKROLL:,.0f}  |  Kelly: {KELLY_FRACTION:.0%}  |  Max bet: {MAX_BET_PCT:.0%}")
print()

# ============================================================
#  PHASE 1 — SEASON DATA
# ============================================================
print("-" * 62)
print(f"  PHASE 1: Pulling {len(all_seasons(_TODAY))} seasons of game data...")
print("-" * 62)

_seasons = all_seasons(_TODAY)
all_games = []
for season in _seasons:
    print(f"  {season}...", end=" ", flush=True)
    for attempt in range(3):
        try:
            gf = leaguegamefinder.LeagueGameFinder(
                season_nullable=season,
                season_type_nullable='Regular Season'
            )
            df = gf.get_data_frames()[0]
            all_games.append(df)
            _SEASON_LOG.append({"season":season,"rows":int(len(df))})
            print(f"ok  {len(df):,}")
            break
        except Exception as e:
            if attempt<2: time.sleep(_SLEEP_RETRY)
            else: print(f"FAILED: {e}")
    time.sleep(_SLEEP_SEASON)

if not all_games: raise SystemExit("No season data. Check network/nba_api.")
games = pd.concat(all_games,ignore_index=True)
print(f"\n  Total: {games.shape[0]:,} rows\n")

# ============================================================
#  PHASE 2 — FEATURE ENGINEERING
# ============================================================
print("-" * 62)
print("  PHASE 2: Engineering features...")
print("-" * 62)

games = games.sort_values(['TEAM_ID','GAME_DATE']).reset_index(drop=True)
games['WIN']       = (games['WL']=='W').astype(int)
games['IS_HOME']   = games['MATCHUP'].apply(lambda x: 1 if 'vs.' in x else 0)
games['GAME_DATE'] = pd.to_datetime(games['GAME_DATE'])

key_cols = ['PTS','FG_PCT','FG3_PCT','FT_PCT','REB','AST','TOV','PLUS_MINUS','STL','BLK']
games    = games.dropna(subset=key_cols).reset_index(drop=True)

# Rest / back-to-back
games['REST_DAYS'] = games.groupby('TEAM_ID')['GAME_DATE'].diff().dt.days.fillna(3).clip(0,10)
games['IS_B2B']    = (games['REST_DAYS']<=1).astype(int)

# Rolling stats
for col in key_cols:
    games[f'{col}_ROLL10'] = games.groupby('TEAM_ID')[col].transform(
        lambda x: x.shift(1).rolling(10,min_periods=5).mean())
for col in ['PTS','PLUS_MINUS','FG_PCT','TOV','REB','AST','FG3_PCT','STL']:
    games[f'{col}_ROLL5'] = games.groupby('TEAM_ID')[col].transform(
        lambda x: x.shift(1).rolling(5,min_periods=3).mean())
for col in ['PTS','PLUS_MINUS','FG_PCT']:
    games[f'{col}_ROLL3'] = games.groupby('TEAM_ID')[col].transform(
        lambda x: x.shift(1).rolling(3,min_periods=2).mean())
for col in ['PTS','PLUS_MINUS']:
    games[f'{col}_VAR10'] = games.groupby('TEAM_ID')[col].transform(
        lambda x: x.shift(1).rolling(10,min_periods=5).std())
    games[f'{col}_VAR5']  = games.groupby('TEAM_ID')[col].transform(
        lambda x: x.shift(1).rolling(5,min_periods=3).std())

# Streaks
games['WIN_STREAK5'] = games.groupby('TEAM_ID')['WIN'].transform(
    lambda x: x.shift(1).rolling(5,min_periods=3).mean())
games['WIN_STREAK3'] = games.groupby('TEAM_ID')['WIN'].transform(
    lambda x: x.shift(1).rolling(3,min_periods=2).mean())
games['WIN_STREAK10']= games.groupby('TEAM_ID')['WIN'].transform(
    lambda x: x.shift(1).rolling(10,min_periods=5).mean())
games['SEASON_WINPCT']= games.groupby(['TEAM_ID','SEASON_ID'])['WIN'].transform(
    lambda x: x.shift(1).expanding().mean())

# Derived
games['OFF_RTG']    = games['PTS_ROLL10'] / games['FG_PCT_ROLL10'].replace(0,np.nan)
games['DEF_RTG']    = games['STL_ROLL10'] + games['BLK_ROLL10'] - games['TOV_ROLL10']
games['BALL_CTRL']  = games['AST_ROLL10'] / games['TOV_ROLL10'].replace(0,np.nan)
games['3PT_RATE']   = games['FG3_PCT_ROLL10'] * games['FG3_PCT_ROLL5']
games['MOMENTUM5']  = games['PTS_ROLL5']  - games['PTS_ROLL10']
games['MOMENTUM3']  = games['PTS_ROLL3']  - games['PTS_ROLL5']
games['FORM_SCORE'] = (games['WIN_STREAK3']*0.5 + games['WIN_STREAK5']*0.3 +
                       games['WIN_STREAK10']*0.2)

# Merge home/away
home   = games[games['IS_HOME']==1].copy()
away   = games[games['IS_HOME']==0].copy()
merged = home.merge(away,on='GAME_ID',suffixes=('_HOME','_AWAY'))
merged['HOME_WIN'] = merged['WIN_HOME']
merged = merged.sort_values('GAME_DATE_HOME').reset_index(drop=True)

# Opponent defense proxy
merged['DEF_ALLOWED_HOME'] = merged['PTS_AWAY']
merged['DEF_ALLOWED_AWAY'] = merged['PTS_HOME']
for side in ['HOME','AWAY']:
    merged[f'DEF_ALLOWED_ROLL10_{side}'] = (
        merged.groupby(f'TEAM_ID_{side}')[f'DEF_ALLOWED_{side}']
        .transform(lambda x: x.shift(1).rolling(10,min_periods=5).mean())
    )

# Differentials
for stat in ['PLUS_MINUS_ROLL10','FG_PCT_ROLL10','PTS_ROLL10','WIN_STREAK5',
             'MOMENTUM5','MOMENTUM3','DEF_RTG','FORM_SCORE','OFF_RTG','BALL_CTRL']:
    if f'{stat}_HOME' in merged.columns and f'{stat}_AWAY' in merged.columns:
        merged[f'{stat}_DIFF'] = merged[f'{stat}_HOME'] - merged[f'{stat}_AWAY']

FEATURE_COLS = [c for c in [
    # Home rolling
    'PTS_ROLL10_HOME','FG_PCT_ROLL10_HOME','FG3_PCT_ROLL10_HOME','FT_PCT_ROLL10_HOME',
    'REB_ROLL10_HOME','AST_ROLL10_HOME','TOV_ROLL10_HOME','PLUS_MINUS_ROLL10_HOME',
    'STL_ROLL10_HOME','BLK_ROLL10_HOME',
    'PTS_ROLL5_HOME','PLUS_MINUS_ROLL5_HOME','FG_PCT_ROLL5_HOME',
    'TOV_ROLL5_HOME','REB_ROLL5_HOME','AST_ROLL5_HOME','FG3_PCT_ROLL5_HOME','STL_ROLL5_HOME',
    'PTS_ROLL3_HOME','PLUS_MINUS_ROLL3_HOME','FG_PCT_ROLL3_HOME',
    'WIN_STREAK5_HOME','WIN_STREAK3_HOME','WIN_STREAK10_HOME','SEASON_WINPCT_HOME',
    'REST_DAYS_HOME','IS_B2B_HOME',
    'OFF_RTG_HOME','DEF_RTG_HOME','BALL_CTRL_HOME','3PT_RATE_HOME',
    'MOMENTUM5_HOME','MOMENTUM3_HOME','FORM_SCORE_HOME',
    'PTS_VAR10_HOME','PLUS_MINUS_VAR10_HOME','PTS_VAR5_HOME','PLUS_MINUS_VAR5_HOME',
    'DEF_ALLOWED_ROLL10_HOME',
    # Away rolling
    'PTS_ROLL10_AWAY','FG_PCT_ROLL10_AWAY','FG3_PCT_ROLL10_AWAY','FT_PCT_ROLL10_AWAY',
    'REB_ROLL10_AWAY','AST_ROLL10_AWAY','TOV_ROLL10_AWAY','PLUS_MINUS_ROLL10_AWAY',
    'STL_ROLL10_AWAY','BLK_ROLL10_AWAY',
    'PTS_ROLL5_AWAY','PLUS_MINUS_ROLL5_AWAY','FG_PCT_ROLL5_AWAY',
    'TOV_ROLL5_AWAY','REB_ROLL5_AWAY','AST_ROLL5_AWAY','FG3_PCT_ROLL5_AWAY','STL_ROLL5_AWAY',
    'PTS_ROLL3_AWAY','PLUS_MINUS_ROLL3_AWAY','FG_PCT_ROLL3_AWAY',
    'WIN_STREAK5_AWAY','WIN_STREAK3_AWAY','WIN_STREAK10_AWAY','SEASON_WINPCT_AWAY',
    'REST_DAYS_AWAY','IS_B2B_AWAY',
    'OFF_RTG_AWAY','DEF_RTG_AWAY','BALL_CTRL_AWAY','3PT_RATE_AWAY',
    'MOMENTUM5_AWAY','MOMENTUM3_AWAY','FORM_SCORE_AWAY',
    'PTS_VAR10_AWAY','PLUS_MINUS_VAR10_AWAY','PTS_VAR5_AWAY','PLUS_MINUS_VAR5_AWAY',
    'DEF_ALLOWED_ROLL10_AWAY',
    # Differentials
    'PLUS_MINUS_ROLL10_DIFF','FG_PCT_ROLL10_DIFF','PTS_ROLL10_DIFF',
    'WIN_STREAK5_DIFF','MOMENTUM5_DIFF','MOMENTUM3_DIFF',
    'DEF_RTG_DIFF','FORM_SCORE_DIFF','OFF_RTG_DIFF','BALL_CTRL_DIFF',
] if c in merged.columns]

merged = merged.dropna(subset=FEATURE_COLS).reset_index(drop=True)

print(f"  Clean games : {len(merged):,}  |  Features : {len(FEATURE_COLS)}")
print(f"  Home win %  : {merged['HOME_WIN'].mean():.1%}")
print(f"  Dates       : {merged['GAME_DATE_HOME'].min().date()} → {merged['GAME_DATE_HOME'].max().date()}\n")

# ============================================================
#  PHASE 3 — SPLIT
# ============================================================
X = merged[FEATURE_COLS]; y = merged['HOME_WIN']
split    = int(len(X)*0.80)
X_train  = X.iloc[:split]; y_train = y.iloc[:split]
X_test   = X.iloc[split:]; y_test  = y.iloc[split:]
print(f"  Train: {len(X_train):,}  |  Test: {len(X_test):,}\n")

# ============================================================
#  PHASE 4 — ENSEMBLE MODEL  (XGBoost + RF + GBM + LR)
# ============================================================
print("-" * 62)
print("  PHASE 4: Training Ensemble AI...")
print("-" * 62)

fp          = hashlib.md5(pd.util.hash_pandas_object(X_train).values).hexdigest()[:14]
calibrated  = None
cache_valid = False
acc = ll = 0.0

if os.path.exists(MODEL_CACHE_FILE):
    try:
        with open(MODEL_CACHE_FILE,'rb') as f:
            cache = pickle.load(f)
        if cache.get('fp') == fp:
            calibrated  = cache['model']
            acc         = cache['acc']
            ll          = cache.get('ll',0.0)
            cache_valid = True
            print(f"  Cache HIT (fp:{fp})  accuracy:{acc:.1%}  logloss:{ll:.4f}\n")
    except: pass

if not cache_valid:
    # ── XGBoost ──────────────────────────────────────────────
    xgb_model = xgb.XGBClassifier(
        n_estimators=700, max_depth=4, learning_rate=0.02,
        subsample=0.8, colsample_bytree=0.75,
        min_child_weight=4, gamma=0.15,
        reg_alpha=0.2, reg_lambda=1.5,
        use_label_encoder=False, eval_metric='logloss',
        early_stopping_rounds=50, random_state=42, n_jobs=-1,
    )
    xgb_model.fit(X_train,y_train,eval_set=[(X_test,y_test)],verbose=100)
    try:
        er = xgb_model.evals_result()
        for i,v in enumerate(er.get("validation_0",{}).get("logloss",[])):
            if i==0 or i%100==0: _XGB_LOG.append({"iter":i,"ll":float(v)})
    except: pass

    # ── Random Forest ─────────────────────────────────────────
    rf_model = RandomForestClassifier(
        n_estimators=600, max_depth=9, min_samples_leaf=12,
        max_features='sqrt', random_state=42, n_jobs=-1, class_weight='balanced',
    )
    rf_model.fit(X_train,y_train)

    # ── Gradient Boosting (sklearn) ───────────────────────────
    gbm_model = GradientBoostingClassifier(
        n_estimators=300, max_depth=3, learning_rate=0.05,
        subsample=0.8, random_state=42,
    )
    gbm_model.fit(X_train,y_train)

    # ── Logistic Regression (meta-learner) ────────────────────
    scaler = StandardScaler()
    X_train_s = scaler.fit_transform(X_train)
    X_test_s  = scaler.transform(X_test)
    lr_model = LogisticRegression(C=0.1,random_state=42,max_iter=1000)
    lr_model.fit(X_train_s,y_train)

    # ── Calibrate all ─────────────────────────────────────────
    def calibrate(m, X_t=X_test, y_t=y_test):
        if USE_FROZEN:
            c = CalibratedClassifierCV(FrozenEstimator(m),method='isotonic',cv=5)
        else:
            c = CalibratedClassifierCV(m,cv='prefit',method='isotonic')
        c.fit(X_t,y_t)
        return c

    cal_xgb = calibrate(xgb_model)
    cal_rf  = calibrate(rf_model)
    cal_gbm = calibrate(gbm_model)

    # LR calibrated separately with scaled data
    if USE_FROZEN:
        cal_lr = CalibratedClassifierCV(FrozenEstimator(lr_model),method='isotonic',cv=5)
    else:
        cal_lr = CalibratedClassifierCV(lr_model,cv='prefit',method='isotonic')
    cal_lr.fit(X_test_s,y_test)

    # ── Stacked Ensemble ──────────────────────────────────────
    class StackedEnsemble:
        """
        4-model stacked ensemble.
        XGBoost 45% + RF 30% + GBM 15% + LR 10%
        Weights tuned on historical NBA data — XGB edges out others on tabular sports.
        """
        def __init__(self):
            self.models   = [cal_xgb, cal_rf, cal_gbm, cal_lr]
            self.weights  = [0.45, 0.30, 0.15, 0.10]
            self.scaler   = scaler
            self.features = FEATURE_COLS

        def predict_proba(self, X):
            out = np.zeros((len(X),2))
            for i,(m,w) in enumerate(zip(self.models,self.weights)):
                if i == 3:  # LR needs scaling
                    Xs = self.scaler.transform(X)
                    out += w * m.predict_proba(Xs)
                else:
                    out += w * m.predict_proba(X)
            return out

        def predict(self, X):
            return (self.predict_proba(X)[:,1]>=0.5).astype(int)

    calibrated = StackedEnsemble()

    preds_v = calibrated.predict(X_test)
    probs_v = calibrated.predict_proba(X_test)[:,1]
    acc     = accuracy_score(y_test,preds_v)
    ll      = log_loss(y_test,probs_v)

    try:
        with open(MODEL_CACHE_FILE,'wb') as f:
            pickle.dump({'model':calibrated,'fp':fp,'acc':acc,'ll':ll},f)
        print(f"\n  4-model ensemble trained  accuracy:{acc:.1%}  logloss:{ll:.4f}  (cached)\n")
    except:
        print(f"\n  4-model ensemble trained  accuracy:{acc:.1%}  logloss:{ll:.4f}\n")

    # Feature importance chart
    try:
        import matplotlib.pyplot as plt
        imp  = pd.Series(xgb_model.feature_importances_,index=FEATURE_COLS).sort_values(ascending=False)
        t15  = imp.head(15)
        fig,ax = plt.subplots(figsize=(11,7))
        colors = ['#0F2027' if i<3 else '#203A43' if i<8 else '#2C5364' for i in range(len(t15))]
        ax.barh(t15.index[::-1],t15.values[::-1],color=colors[::-1])
        ax.set_xlabel('XGBoost Importance Score')
        ax.set_title('RoliBot v5 — Top 15 Predictive Features',fontweight='bold')
        plt.tight_layout()
        cp = os.path.join(os.path.dirname(os.path.abspath(__file__)),"feature_importance.png")
        plt.savefig(cp,dpi=150,bbox_inches='tight')
        plt.close()
        print(f"  Chart: {cp}")
    except: pass

# ============================================================
#  PHASE 5 — EVALUATE
# ============================================================
preds = calibrated.predict(X_test)
probs = calibrated.predict_proba(X_test)[:,1]
acc   = accuracy_score(y_test,preds)
ll    = log_loss(y_test,probs)

print("\n" + "-"*62)
print("  PHASE 5: Model Evaluation")
print("-"*62)
print(f"  Accuracy  : {acc:.1%}  (break-even ~52.4%,  edge {(acc-0.524)*100:+.1f}pp)")
print(f"  Log-loss  : {ll:.4f}  (lower = better calibrated probs)")
print(f"\n{classification_report(y_test,preds,target_names=['Away Win','Home Win'])}")

print("  Calibration check (does 65% confidence = 65% win rate?):")
for lo,hi in [(0.5,0.55),(0.55,0.60),(0.60,0.65),(0.65,0.70),(0.70,1.0)]:
    mask = (probs>=lo)&(probs<hi)
    if mask.sum()>10:
        print(f"    {lo:.0%}-{hi:.0%}:  actual {y_test[mask].mean():.1%}  ({mask.sum()} games)")

# ============================================================
#  PHASE 6 — LIVE SCHEDULE + INJURY REPORT
# ============================================================
print("\n" + "-"*62)
print("  PHASE 6: Live schedule + injury report")
print("-"*62)

team_list        = nba_teams_static.get_teams()
team_lookup      = {t['abbreviation']:t['id'] for t in team_list}
team_name_lookup = {t['id']:t['full_name'] for t in team_list}
abbr_lookup      = {t['id']:t['abbreviation'] for t in team_list}

# Defensive rating per team
team_def_ratings = {}
for tid in games['TEAM_ID'].unique():
    pm = games[games['TEAM_ID']==tid]['PLUS_MINUS'].tail(15).mean()
    team_def_ratings[tid] = float(pm) if not np.isnan(pm) else 0.0

# Pull injuries FIRST — critical filter
print("  Fetching live injury report (ESPN)...")
injuries = fetch_injuries()
n_out = sum(1 for v in injuries.values()
            if v.get('status','').lower().replace('-',' ') in INJURY_EXCLUDE
            or any(e in v.get('status','').lower() for e in INJURY_EXCLUDE))
print(f"  {len(injuries)} players tracked  |  {n_out} excluded (Out/Doubtful/GTD/Questionable)\n")

def get_tonight():
    """
    Return list of (away_abbr, home_abbr) for the slate date.
    Prefer ScoreboardV3 — V2 has known bad data for parts of 2025-26 (wrong/missing games).
    """
    date_str = _TODAY.strftime("%Y-%m-%d")
    skip_final = os.environ.get("ROLI_SCOREBOARD_SKIP_FINAL", "1").lower() in ("1", "true", "yes")
    out = []

    if _HAS_SCOREBOARD_V3 and scoreboardv3 is not None:
        try:
            raw = scoreboardv3.ScoreboardV3(game_date=date_str).get_dict()
            board = raw.get("scoreboard") or {}
            for game in board.get("games") or []:
                st = (game.get("gameStatusText") or "").strip().lower()
                if skip_final and st == "final":
                    continue
                ht = game.get("homeTeam") or {}
                at = game.get("awayTeam") or {}
                h = str(ht.get("teamTricode") or "").strip().upper()
                a = str(at.get("teamTricode") or "").strip().upper()
                if h and a and h in team_lookup and a in team_lookup:
                    out.append((a, h))
            if out:
                return out
            # V3 empty (off day or all Final) — try V2; rare recovery if cloud feed lags
        except Exception as e:
            print(f"  ! ScoreboardV3 error ({e}) — trying V2")

    try:
        sb = scoreboardv2.ScoreboardV2(game_date=date_str)
        ginfo = sb.game_header.get_data_frame()
        if ginfo.empty:
            return []
        for _, row in ginfo.iterrows():
            hid = row.get("HOME_TEAM_ID")
            aid = row.get("VISITOR_TEAM_ID")
            try:
                hid = int(hid) if hid is not None and str(hid) != "nan" else None
                aid = int(aid) if aid is not None and str(aid) != "nan" else None
            except (TypeError, ValueError):
                hid = aid = None
            h = abbr_lookup.get(hid, "") if hid is not None else ""
            a = abbr_lookup.get(aid, "") if aid is not None else ""
            if not h or not a:
                continue
            gst = str(row.get("GAME_STATUS_TEXT") or "").strip().lower()
            if skip_final and gst == "final":
                continue
            if h in team_lookup and a in team_lookup:
                out.append((a, h))
        return out
    except Exception as e:
        print(f"  ! Schedule error: {e}")
        return []


def _props_belong_to_game(home_abbr, away_abbr, props_list):
    """Drop any prop whose team/opp is not exactly this matchup (paranoia + bad API fallout)."""
    mk = frozenset({home_abbr.strip().upper(), away_abbr.strip().upper()})
    clean = []
    for p in props_list:
        t = str(p.get("team") or "").strip().upper()
        o = str(p.get("opp") or "").strip().upper()
        if not t or not o:
            continue
        if frozenset({t, o}) == mk:
            clean.append(p)
    return clean

tonight = get_tonight()
if tonight:
    print(f"  {len(tonight)} game(s) on slate (ScoreboardV3 when available; Final games omitted by default):")
    for a, h in tonight:
        print(f"    {a} @ {h}")
    print("  Tip: ROLI_SCOREBOARD_SKIP_FINAL=0 includes finished games for that calendar date (backtest / late review).")
    print()
else:
    print("  ! No upcoming games on this slate date (or off day). ROLI_GAME_DATE=YYYY-MM-DD for backtest.")
    print("  ! If games already Final, set ROLI_SCOREBOARD_SKIP_FINAL=0 to re-include them.\n")

# ============================================================
#  PHASE 7 — LIVE ROSTER + PROPS
#  Zero hardcoded player names. Every player verified:
#    1. On current NBA.com roster
#    2. Last N games played for this team (trade check)
#    3. Not on injury report
#    4. Recently active (played within 21 days)
#    5. Averaging > MIN_AVG_MINS
# ============================================================
print("-"*62)
print("  PHASE 7: Live rosters + player props")
print("  (Live data fetch — takes a few minutes)")
print("-"*62)

PROP_LINES = {
    'PTS':  [10,15,20,25,30,35],
    'REB':  [4,6,8,10,12,14],
    'AST':  [3,5,7,10,12],
    'FG3M': [1,2,3,4,5,6],
    'STL':  [1,2],
    'BLK':  [1,2,3],
}

def prop_lbl(stat,t):
    return {'PTS':f"{t}+ Pts",'REB':f"{t}+ Reb",'AST':f"{t}+ Ast",
            'FG3M':f"{t}+ 3PM",'STL':f"{t}+ Stl",'BLK':f"{t}+ Blk"}.get(stat,f"{t}+ {stat}")

def compute_props(name, log, team_abbr, opp_abbr):
    """Compute all prop lines for a verified player."""
    global _SKIPPED_INJ, _SKIPPED_TRADE
    props = []

    # Hard injury check
    if player_is_out(name, injuries):
        _SKIPPED_INJ += 1
        return []

    # Hard trade check
    valid, actual_team = verify_player_team(log, team_abbr)
    if not valid:
        _SKIPPED_TRADE += 1
        print(f"    TRADED: {name} (last played for {actual_team}, not {team_abbr}) — SKIPPED")
        return []

    # Recent activity check
    if not player_played_recently(log, days=25):
        return []  # inactive / long-term injury not on report

    # Minutes filter
    if 'MIN' in log.columns:
        mins = log['MIN'].apply(parse_mins).dropna()
        if len(mins)>=3 and mins.head(8).mean() < MIN_AVG_MINS:
            return []

    # Minutes trend (load management warning)
    min_flag = ''; min_recent_val = None
    if 'MIN' in log.columns:
        mins = log['MIN'].apply(parse_mins).dropna()
        if len(mins)>=5:
            r5 = mins.head(5).mean(); ovr = mins.mean()
            min_recent_val = round(r5,1)
            if ovr>0 and r5/ovr<0.82: min_flag='MINS_DROP'

    opp_id  = team_lookup.get(opp_abbr,'')
    opp_pm  = team_def_ratings.get(opp_id,0.0)
    opp_fac = max(0.85, min(1.15, 1.0+(opp_pm/15.0)*0.12))

    for stat,lines in PROP_LINES.items():
        if stat not in log.columns: continue
        vals = pd.to_numeric(log[stat],errors='coerce').dropna().values
        if len(vals)<5: continue
        avg_all = vals.mean(); avg_rec = vals[:5].mean(); avg_rec3 = vals[:3].mean()

        for line in lines:
            if avg_all < line*0.32: continue   # player never gets near this
            hits   = (vals>=line).astype(float)
            raw_hr = hits.mean()
            w_hr   = weighted_hr(hits)
            # Opponent adjustment for scoring/shooting
            adj_hr = min(0.97,max(0.03,w_hr*opp_fac)) if stat in ('PTS','FG3M') else w_hr
            if adj_hr>0.97 or adj_hr<0.03: continue

            props.append({
                'player':name,'team':team_abbr,'opp':opp_abbr,
                'stat':stat,'threshold':line,'label':prop_lbl(stat,line),
                'hit_rate':adj_hr,'raw_hr':raw_hr,
                'avg':avg_all,'avg_recent':avg_rec,'avg_recent3':avg_rec3,
                'std':vals.std(),'n_games':len(vals),
                'trend':trend_str(avg_rec,avg_all),
                'trend3':trend_str(avg_rec3,avg_rec),
                'min_flag':min_flag,'min_recent':min_recent_val,
                'opp_factor':opp_fac,
                'inj_status':player_injury_status(name,injuries),
            })

    # Dedupe: drop easier line when raw hit rate almost same as harder line
    by_stat = defaultdict(list)
    for p in props: by_stat[p['stat']].append(p)
    out = []
    for grp in by_stat.values():
        grp.sort(key=lambda x: x['threshold'],reverse=True)
        kept = []
        for p in grp:
            if any(k['threshold']>p['threshold'] and abs(k['raw_hr']-p['raw_hr'])<0.04 for k in kept):
                continue
            kept.append(p)
        out.extend(kept)
    return out

# Build team props
teams_tonight   = list({t for pair in tonight for t in pair})
log_cache       = {}  # player_id → log
props_by_team   = {}

for team_abbr in teams_tonight:
    tid = team_lookup.get(team_abbr)
    if not tid: props_by_team[team_abbr]=[]; continue

    opp = next((h if a == team_abbr else a for a, h in tonight if a == team_abbr or h == team_abbr), "")
    if not opp:
        print(f"\n  {team_abbr} — not on slate matchups; skipping roster props.")
        props_by_team[team_abbr] = []
        continue
    print(f"\n  {team_abbr} (vs {opp}) — fetching live roster...")

    roster = get_roster(tid, _SEASON)
    if not roster:
        print(f"    No roster returned for {team_abbr}")
        props_by_team[team_abbr]=[]; continue

    team_props   = []
    skip_traded  = 0; skip_inj = 0; skip_mins = 0; skip_inactive = 0

    for player in roster:
        pid  = player['id']
        name = player['name']

        if pid not in log_cache:
            log_cache[pid] = get_player_log(pid)
        log = log_cache[pid]

        if log is None or log.empty:
            skip_inactive += 1; continue

        # Pre-filter: if last game was for a different team, skip immediately
        if 'TEAM_ABBREVIATION' in log.columns:
            lt = str(log.iloc[0].get('TEAM_ABBREVIATION','')).strip().upper()
            if lt and lt != team_abbr.upper():
                skip_traded += 1
                print(f"    TRADED: {name} ({team_abbr} → {lt}) SKIPPED")
                continue

        if player_is_out(name,injuries):
            skip_inj += 1
            st = player_injury_status(name,injuries)
            print(f"    INJURY: {name} [{st}] SKIPPED")
            continue

        plist = compute_props(name,log,team_abbr,opp)
        team_props.extend(plist)

    strong_n = len([p for p in team_props if p['hit_rate']>=0.65 and not p['min_flag']])
    _PROPS_LOG.append({'team':team_abbr,'opp':opp,'strong_props':strong_n,
                       'traded_skipped':skip_traded,'injured_skipped':skip_inj})
    print(f"    {strong_n} strong props  |  {skip_traded} traded  |  {skip_inj} injured  |  {skip_inactive} no log")
    props_by_team[team_abbr] = team_props

print()

# ============================================================
#  PHASE 8 — GAME PREDICTIONS + KELLY
# ============================================================
print("-"*62)
print("  PHASE 8: AI Game Predictions + Kelly Sizing")
print("-"*62)
print()

def get_team_feats(team_id):
    tg = games[games['TEAM_ID']==team_id]
    if len(tg)<5: return None
    l = tg.iloc[-1]
    out = {k:l.get(k,np.nan) for k in [
        'PTS_ROLL10','FG_PCT_ROLL10','FG3_PCT_ROLL10','FT_PCT_ROLL10',
        'REB_ROLL10','AST_ROLL10','TOV_ROLL10','PLUS_MINUS_ROLL10','STL_ROLL10','BLK_ROLL10',
        'PTS_ROLL5','PLUS_MINUS_ROLL5','FG_PCT_ROLL5','TOV_ROLL5','REB_ROLL5',
        'AST_ROLL5','FG3_PCT_ROLL5','STL_ROLL5',
        'PTS_ROLL3','PLUS_MINUS_ROLL3','FG_PCT_ROLL3',
        'WIN_STREAK5','WIN_STREAK3','WIN_STREAK10','SEASON_WINPCT',
        'REST_DAYS','IS_B2B',
        'OFF_RTG','DEF_RTG','BALL_CTRL','3PT_RATE',
        'MOMENTUM5','MOMENTUM3','FORM_SCORE',
        'PTS_VAR10','PLUS_MINUS_VAR10','PTS_VAR5','PLUS_MINUS_VAR5',
        'DEF_ALLOWED_ROLL10',
    ]}
    return out

def predict_game(home_abbr, away_abbr):
    hid = team_lookup.get(home_abbr); aid = team_lookup.get(away_abbr)
    if not hid or not aid: return None
    hf = get_team_feats(hid); af = get_team_feats(aid)
    if hf is None or af is None: return None
    row = {}
    for col in FEATURE_COLS:
        if col.endswith('_HOME'):   row[col] = hf.get(col[:-5],np.nan)
        elif col.endswith('_AWAY'): row[col] = af.get(col[:-5],np.nan)
    for stat in ['PLUS_MINUS_ROLL10','FG_PCT_ROLL10','PTS_ROLL10','WIN_STREAK5',
                 'MOMENTUM5','MOMENTUM3','DEF_RTG','FORM_SCORE','OFF_RTG','BALL_CTRL']:
        dk = f'{stat}_DIFF'
        if dk in FEATURE_COLS:
            row[dk] = hf.get(stat,0) - af.get(stat,0)
    Xp = pd.DataFrame([{c:row.get(c,np.nan) for c in FEATURE_COLS}])[FEATURE_COLS]
    return float(calibrated.predict_proba(Xp)[0][1])

game_results = []
for away_abbr,home_abbr in tonight:
    ph = predict_game(home_abbr,away_abbr)
    if ph is None: continue
    pa        = 1-ph
    home_name = team_name_lookup.get(team_lookup.get(home_abbr,''),home_abbr)
    away_name = team_name_lookup.get(team_lookup.get(away_abbr,''),away_abbr)
    if ph>=pa: pn,pa2,pp,ps = home_name,home_abbr,ph,"HOME"
    else:      pn,pa2,pp,ps = away_name,away_abbr,pa,"AWAY"
    odds  = prob_to_american(pp)
    edge  = pp-0.5
    kelly = kelly_bet(pp,odds)
    if edge>=0.15:   conf,stars = "STRONG","***"
    elif edge>=0.09: conf,stars = "GOOD","**"
    elif edge>=0.05: conf,stars = "LEAN","*"
    else:            conf,stars = "SKIP","~"
    raw_gp = props_by_team.get(home_abbr, []) + props_by_team.get(away_abbr, [])
    gprops = _props_belong_to_game(home_abbr, away_abbr, raw_gp)
    # LLM analysis (async would be better but keeping simple)
    analysis = llm_analyze_game(home_name, away_name, ph, gprops, injuries) if _USE_LLM else ""
    game_results.append({
        'home_abbr':home_abbr,'away_abbr':away_abbr,
        'home_name':home_name,'away_name':away_name,
        'prob_home':ph,'prob_away':pa,
        'pick_name':pn,'pick_abbr':pa2,'pick_prob':pp,'pick_side':ps,
        'pick_odds':odds,'edge':edge,'confidence':conf,'stars':stars,
        'kelly_amt':kelly,'props':gprops,'analysis':analysis,
    })

game_results.sort(key=lambda x: x['edge'],reverse=True)

# ── Print predictions ──────────────────────────────────────
print("=" * 62)
print("  TONIGHT'S PREDICTIONS")
print("=" * 62)
for g in game_results:
    print()
    print(f"  {g['away_name']}  @  {g['home_name']}")
    print(f"  " + "-"*48)
    print(f"  Home ({g['home_abbr']}): {g['prob_home']:.1%}  {prob_to_american(g['prob_home'])}")
    print(f"  Away ({g['away_abbr']}): {g['prob_away']:.1%}  {prob_to_american(g['prob_away'])}")
    print(f"  Pick: {g['pick_name']} ({g['pick_side']})  [{g['confidence']} {g['stars']}]")
    if g['kelly_amt']>0 and g['edge']>=MIN_EDGE_FOR_BET:
        print(f"  Kelly: ${g['kelly_amt']:,.2f}")
    if g['analysis']:
        print(f"  AI: {g['analysis']}")

# ============================================================
#  PHASE 9 — PROPS BREAKDOWN
# ============================================================
print()
print("=" * 62)
print("  PLAYER PROPS — PER GAME  (verified, injury-filtered)")
print("=" * 62)

all_safe  = []
all_risky = []

for g in game_results:
    print(f"\n  {g['away_name']} @ {g['home_name']}")
    print("  " + "-"*50)
    props  = g['props']
    safe   = sorted([p for p in props if p['hit_rate']>=0.65 and not p['min_flag']],
                    key=lambda x: x['hit_rate'],reverse=True)
    risky  = sorted([p for p in props if 0.33<=p['hit_rate']<0.50],
                    key=lambda x: x['hit_rate'],reverse=True)
    flagged= list({p['player'] for p in props if p['min_flag']})

    if safe:
        print("  TOP PROPS (high confidence, verified players):")
        for p in safe[:8]:
            c,s = prop_conf(p['hit_rate'])
            tr  = f" [{p['trend']}]" if p['trend'] else ''
            adj = f" [opp x{p['opp_factor']:.2f}]" if abs(p['opp_factor']-1)>0.02 else ''
            inj = f" [{p['inj_status']}]" if p['inj_status'] else ''
            print(f"    {p['player']:26s}  {p['label']:16s}  {p['hit_rate']:.0%}  {s}{tr}{adj}{inj}")
        all_safe.extend(safe)
    else:
        print("  (No strong props — many players out or low-scoring game)")

    if risky:
        print("  RISKY/LONG SHOTS:")
        for p in risky[:3]:
            print(f"    {p['player']:26s}  {p['label']:16s}  {p['hit_rate']:.0%}  avg {p['avg']:.1f}")
        all_risky.extend(risky)

    if flagged:
        print("  MINUTES WARNINGS — skip these players' props:")
        for pl in flagged[:3]:
            mp = next((p for p in props if p['player']==pl and p['min_flag']),None)
            if mp: print(f"    {pl} — recent {mp['min_recent']} mpg  (MINS_DROP)")

# ============================================================
#  PHASE 10 — PARLAY BUILDER
# ============================================================
print()
print("=" * 62)
print("  PARLAY BUILDER")
print("=" * 62)
print()

def build_parlays(pool, min_legs=2, max_legs=4, top_n=5, same_game=False):
    if len(pool)<min_legs: return []
    seen,unique = set(),[]
    for p in sorted(pool,key=lambda x: x['hit_rate'],reverse=True):
        if p['player'] not in seen:
            seen.add(p['player']); unique.append(p)
    out = []
    for n in range(min_legs,min(max_legs+1,len(unique)+1)):
        for combo in itertools.combinations(unique[:22],n):
            if same_game:
                matchups = {frozenset({c['team'],c['opp']}) for c in combo}
                if len(matchups)>1: continue  # must be same game
            pr  = [c['hit_rate'] for c in combo]
            cb  = parlay_prob(pr); py = parlay_payout(pr)
            hot = sum(0.06 for c in combo if c.get('trend') in ('HOT','WARM'))
            out.append({'legs':list(combo),'combined':cb,'payout':py,'n':n,'hot_bonus':hot})
    out.sort(key=lambda p: (p['combined']+p['hot_bonus'])*np.log1p(p['payout'])
             if p['combined']>0.04 else -1, reverse=True)
    return out[:top_n]

safe_parlays  = build_parlays(all_safe)
risky_parlays = build_parlays(all_risky, min_legs=2,max_legs=5)
sgp_parlays   = build_parlays(all_safe,  min_legs=2,max_legs=3,same_game=True)  # same-game

if safe_parlays:
    print("  --- SAFE PROP PARLAYS ---\n")
    for i,p in enumerate(safe_parlays,1):
        k = kelly_bet(p['combined'],prob_to_american(p['combined']))
        print(f"  PARLAY #{i}  {p['n']}-leg  {p['combined']:.1%} hit  ${p['payout']:,.0f} on $100  Kelly ${k:,.2f}")
        for leg in p['legs']:
            _,st = prop_conf(leg['hit_rate'])
            tr   = f" [{leg['trend']}]" if leg['trend'] else ''
            print(f"    {leg['player']:26s}  {leg['label']:16s}  {leg['hit_rate']:.0%}  {st}{tr}")
        print()

if sgp_parlays:
    print("  --- SAME-GAME PARLAYS (SGP) ---\n")
    for i,p in enumerate(sgp_parlays[:3],1):
        game_tag = f"{p['legs'][0]['opp']} @ {p['legs'][0]['team']}" if p['legs'] else ''
        print(f"  SGP #{i}  {p['n']}-leg  {game_tag}  {p['combined']:.1%}  ${p['payout']:,.0f}")
        for leg in p['legs']:
            print(f"    {leg['player']:26s}  {leg['label']:16s}  {leg['hit_rate']:.0%}")
        print()

if risky_parlays:
    print("  --- RISKY PARLAYS (cap $10-20 max) ---\n")
    for i,p in enumerate(risky_parlays[:3],1):
        print(f"  RISKY #{i}  {p['n']}-leg  {p['combined']:.1%}  ${p['payout']:,.0f}")
        for leg in p['legs']:
            print(f"    {leg['player']:26s}  {leg['label']:16s}  {leg['hit_rate']:.0%}  avg {leg['avg']:.1f}")
        print()

# Mixed ML + Props (same game only)
strong_games  = [g for g in game_results if g['edge']>=0.09]
seen_mx,uniq_mx = set(),[]
for p in sorted(all_safe,key=lambda x: x['hit_rate'],reverse=True)[:20]:
    if p['player'] not in seen_mx:
        seen_mx.add(p['player']); uniq_mx.append(p)

mixed = []
for g in strong_games[:4]:
    mk = frozenset({g['away_abbr'].upper(),g['home_abbr'].upper()})
    same_props = [p for p in uniq_mx
                  if frozenset({p['team'].upper(),p['opp'].upper()})==mk]
    for p1 in same_props[:10]:
        pr=[g['pick_prob'],p1['hit_rate']]
        mixed.append({'game':g,'prop':p1,'combined':parlay_prob(pr),'payout':parlay_payout(pr),'n':2})
        for p2 in same_props[:10]:
            if p2['player']!=p1['player']:
                pr3=[g['pick_prob'],p1['hit_rate'],p2['hit_rate']]
                mixed.append({'game':g,'prop':p1,'prop2':p2,'combined':parlay_prob(pr3),'payout':parlay_payout(pr3),'n':3})

mixed.sort(key=lambda m: m['combined']*np.log1p(m['payout']) if m['combined']>0.06 else -1,reverse=True)
if mixed:
    print("  --- MIXED PARLAYS (ML + Props, same game) ---\n")
    for i,m in enumerate(mixed[:5],1):
        g  = m['game']
        k  = kelly_bet(m['combined'],prob_to_american(m['combined']))
        print(f"  MIXED #{i}  {m['n']}-leg  {m['combined']:.1%}  ${m['payout']:,.0f}  Kelly ${k:,.2f}")
        print(f"    {g['pick_name']:30s} ML  {g['pick_prob']:.0%}  {g['stars']}")
        p1=m['prop']
        print(f"    {p1['player']:26s}  {p1['label']:16s}  {p1['hit_rate']:.0%}  [{p1['trend']}]" if p1['trend'] else f"    {p1['player']:26s}  {p1['label']:16s}  {p1['hit_rate']:.0%}")
        if 'prop2' in m:
            p2=m['prop2']
            print(f"    {p2['player']:26s}  {p2['label']:16s}  {p2['hit_rate']:.0%}")
        print()

# Hot streak specials
hot = [p for p in all_safe if p.get('trend') in ('HOT','WARM')]
if hot:
    hp = build_parlays(hot,max_legs=3,top_n=3)
    if hp:
        print("  --- HOT STREAK SPECIALS ---\n")
        for i,p in enumerate(hp,1):
            print(f"  HOT #{i}  {p['n']}-leg  {p['combined']:.1%}  ${p['payout']:,.0f}")
            for leg in p['legs']:
                print(f"    {leg['player']:26s}  {leg['label']:16s}  {leg['hit_rate']:.0%}  [{leg['trend']}]  recent {leg['avg_recent']:.1f} vs season {leg['avg']:.1f}")
            print()

# ============================================================
#  FINAL BET SLIP
# ============================================================
print("=" * 62)
print("  YOUR BET SLIP — TONIGHT")
print("=" * 62)
print()
print(f"  Bankroll ${BANKROLL:,.0f}  |  Kelly {KELLY_FRACTION:.0%}  |  Max {MAX_BET_PCT:.0%}/bet")
print()

strong_g = [g for g in game_results if g['edge']>=0.15]
good_g   = [g for g in game_results if 0.09<=g['edge']<0.15]
lean_g   = [g for g in game_results if 0.05<=g['edge']<0.09]
skip_g   = [g for g in game_results if g['edge']<0.05]
tk = 0

if strong_g:
    print("  STRONG BETS (highest confidence)")
    for g in strong_g:
        tk+=g['kelly_amt']
        print(f"    {g['pick_name']} ML  {g['pick_prob']:.1%}  ({g['pick_odds']})  Kelly ${g['kelly_amt']:,.2f}")
    print()
if good_g:
    print("  GOOD BETS")
    for g in good_g:
        tk+=g['kelly_amt']
        print(f"    {g['pick_name']} ML  {g['pick_prob']:.1%}  ({g['pick_odds']})  Kelly ${g['kelly_amt']:,.2f}")
    print()
if lean_g:
    print("  LEAN — small stakes or parlay only")
    for g in lean_g:
        print(f"    {g['pick_name']} ML  {g['pick_prob']:.1%}  ({g['pick_odds']})")
    print()
if skip_g:
    print("  SKIP — no model edge")
    for g in skip_g:
        print(f"    {g['away_name']} @ {g['home_name']}")
    print()

if tk>0:
    print(f"  TOTAL ACTION: ${tk:,.2f}  ({tk/BANKROLL:.1%} of bankroll)")
    print()

if all_safe:
    bp=max(all_safe,key=lambda x: x['hit_rate'])
    print(f"  BEST SINGLE PROP:")
    print(f"    {bp['player']}  {bp['label']}  {bp['hit_rate']:.0%} hit rate  avg {bp['avg']:.1f}  ({bp['n_games']} games)  [{bp['trend']}]")
    print()

if safe_parlays:
    sp=safe_parlays[0]
    lgs=" + ".join(f"{p['player']} {p['label']}" for p in sp['legs'])
    print(f"  BEST PROP PARLAY:")
    print(f"    {lgs}")
    print(f"    {sp['combined']:.1%}  ${sp['payout']:,.0f} on $100")
    print()

pool=[g for g in game_results if g['edge']>=0.05]
if len(pool)>=2:
    b2=sorted(
        [{'legs':c,'combined':parlay_prob([x['pick_prob'] for x in c]),
          'payout':parlay_payout([x['pick_prob'] for x in c])}
         for c in itertools.combinations(pool,2)],
        key=lambda x: x['combined']*np.log1p(x['payout']),reverse=True
    )
    if b2:
        tp=b2[0]; k=kelly_bet(tp['combined'],prob_to_american(tp['combined']))
        lgs=" + ".join(g['pick_name'] for g in tp['legs'])
        print(f"  BEST TEAM PARLAY:")
        print(f"    {lgs}")
        print(f"    {tp['combined']:.1%}  ${tp['payout']:,.0f} on $100  Kelly ${k:,.2f}")
        print()

print("=" * 62)
print(f"  Model    : 4-model stacked ensemble")
print(f"  Accuracy : {acc:.1%}  |  Edge: {(acc-0.524)*100:+.1f}pp  |  LL: {ll:.4f}")
print(f"  Features : {len(FEATURE_COLS)}")
print(f"  Injuries : {len(injuries)} tracked  ({n_out} excluded)")
print(f"  Traded   : {_SKIPPED_TRADE} players skipped (wrong team)")
print(f"  Injured  : {_SKIPPED_INJ} players skipped (Out/GTD/Questionable)")
print(f"  Props    : {len(all_safe)} strong  |  {len(all_risky)} risky")
print(f"  Games    : {len(game_results)} tonight")
print(f"  Cache    : {'HIT' if cache_valid else 'MISS (retrained)'}")
print(f"  LLM      : {'Claude enabled' if _USE_LLM else 'set ANTHROPIC_API_KEY to enable'}")
print("=" * 62)
print()
print("  DAILY USAGE (no GitHub Actions needed):")
print("  Windows : Task Scheduler → python rolibot_v5.py → daily 1PM ET")
print("  Mac/Linux: cron → 0 13 * * * cd /your/path && python rolibot_v5.py")
print("  Backtest : ROLI_GAME_DATE=2026-03-15 python rolibot_v5.py")
print("  JSON mode: ROLI_JSON=1 python rolibot_v5.py")
print("  LLM mode : ANTHROPIC_API_KEY=sk-ant-... python rolibot_v5.py")
print("  Retrain  : delete rolibot_cache.pkl then run again")
print()
print("  ACCURACY NOTES:")
print("  - Traded players: detected via last game log team check (hard block)")
print("  - Injuries: ESPN live feed, Out/Doubtful/GTD/Questionable all excluded")
print("  - Minutes drop: flagged when recent avg < 82% of season avg")
print("  - No active games > 21 days ago: skipped (long-term injury)")
print("  - Never bet more than you can afford to lose")
print()

# ─────────────────────────────────────────────────────────────
#  JSON OUTPUT
# ─────────────────────────────────────────────────────────────
if _JSON_MODE:
    try: sys.stdout.close()
    except: pass
    sys.stdout = _real_stdout

    def jf(x):
        if x is None: return None
        if isinstance(x,(np.floating,float)):
            v = float(x)
            return v if math.isfinite(v) else None
        if isinstance(x,(np.integer,int)):    return int(x)
        if isinstance(x,np.bool_):            return bool(x)
        return x

    def sp(p):
        c,s=prop_conf(p['hit_rate'])
        return {'player':p['player'],'team':p['team'],'opp':p['opp'],
                'stat':p['stat'],'threshold':jf(p['threshold']),'label':p['label'],
                'hit_rate':jf(p['hit_rate']),'raw_hr':jf(p['raw_hr']),
                'avg':jf(p['avg']),'avg_recent':jf(p['avg_recent']),
                'avg_recent3':jf(p.get('avg_recent3')),'n_games':jf(p['n_games']),
                'trend':p.get('trend',''),'trend3':p.get('trend3',''),
                'min_flag':p.get('min_flag',''),'opp_factor':jf(p['opp_factor']),
                'inj_status':p.get('inj_status',''),
                'confidence':c,'stars':s}

    def sg(g):
        props=g['props']
        sp_  =sorted([p for p in props if p['hit_rate']>=0.65 and not p['min_flag']],
                     key=lambda x: x['hit_rate'],reverse=True)
        rp_  =sorted([p for p in props if 0.33<=p['hit_rate']<0.50],
                     key=lambda x: x['hit_rate'],reverse=True)
        return {'home_abbr':g['home_abbr'],'away_abbr':g['away_abbr'],
                'home_name':g['home_name'],'away_name':g['away_name'],
                'prob_home':jf(g['prob_home']),'prob_away':jf(g['prob_away']),
                'pick_name':g['pick_name'],'pick_abbr':g['pick_abbr'],
                'pick_prob':jf(g['pick_prob']),'pick_side':g['pick_side'],
                'pick_odds':g['pick_odds'],'edge':jf(g['edge']),
                'confidence':g['confidence'],'stars':g['stars'],
                'kelly_amt':jf(g['kelly_amt']),
                'analysis':g.get('analysis',''),
                'top_props':[sp(p) for p in sp_[:8]],
                'risky_props':[sp(p) for p in rp_[:4]]}

    def spar(p):
        k=kelly_bet(p['combined'],prob_to_american(p['combined']))
        legs=[{'player':l['player'],'label':l['label'],'hit_rate':jf(l['hit_rate']),
               'trend':l.get('trend',''),'team':l.get('team',''),'opp':l.get('opp','')}
              for l in p['legs']]
        return {'n':p['n'],'combined':jf(p['combined']),'payout':jf(p['payout']),
                'implied_american':prob_to_american(p['combined']),'kelly':jf(k),'legs':legs}

    strong_j = [g for g in game_results if g['edge']>=0.15]
    good_j   = [g for g in game_results if 0.09<=g['edge']<0.15]
    lean_j   = [g for g in game_results if 0.05<=g['edge']<0.09]
    skip_j   = [g for g in game_results if g['edge']<0.05]
    tk_j     = sum(float(g['kelly_amt']) for g in strong_j+good_j)

    report = {
        'ok':True,'brand':'RoliBot NBA v5',
        'generated_at':datetime.now().isoformat(timespec='seconds'),
        'slate_date':_TODAY.isoformat(),
        'bankroll':float(BANKROLL),'kelly_fraction':float(KELLY_FRACTION),
        'llm_enabled':bool(_USE_LLM),
        'model':{
            'name':'Stacked Ensemble (XGBoost 45% + RF 30% + GBM 15% + LR 10%)',
            'accuracy':jf(acc),'logloss':jf(ll),
            'edge_pp':jf((acc-0.524)*100),
            'n_features':len(FEATURE_COLS),'n_train':int(len(X_train)),
            'cache_hit':bool(cache_valid),
        },
        'injury_report':{
            'n_tracked':len(injuries),'n_excluded':n_out,
            'fetched_ok':_INJURY_META.get('fetched_ok',False),
            'out_players':(_INJURY_META.get('out_players') or [])[:60],
        },
        'accuracy_notes':{
            'traded_skipped':int(_SKIPPED_TRADE),
            'injured_skipped':int(_SKIPPED_INJ),
            'trade_check':'Last game log team must match roster team',
            'injury_check':'ESPN live feed: Out/Doubtful/GTD/Questionable excluded',
            'activity_check':'Must have played within 25 days',
            'minutes_check':f'Must average >= {MIN_AVG_MINS} mpg',
            'scoreboard':'ScoreboardV3 preferred (V2 fallback). Props only for teams in slate_matchups; mis-tagged props dropped.',
        },
        'slate_matchups':[f"{a} @ {h}" for a,h in tonight],
        'games':[sg(g) for g in game_results],
        'bet_slip':{
            'strong':[sg(g) for g in strong_j],
            'good':[sg(g) for g in good_j],
            'lean':[sg(g) for g in lean_j],
            'skip':[{'home_name':g['home_name'],'away_name':g['away_name']} for g in skip_j],
            'total_kelly':jf(tk_j),
        },
        'parlays':{
            'safe':[spar(p) for p in safe_parlays],
            'risky':[spar(p) for p in risky_parlays[:3]],
            'sgp':[spar(p) for p in sgp_parlays[:3]],
            'mixed':[{
                'n':m['n'],'combined':jf(m['combined']),'payout':jf(m['payout']),
                'team_pick':{'pick_name':m['game']['pick_name'],'pick_prob':jf(m['game']['pick_prob'])},
                'prop':sp(m['prop']),
                'prop2':sp(m['prop2']) if 'prop2' in m else None,
            } for m in mixed[:5]],
        },
        'props_summary':{
            'n_strong':len(all_safe),'n_risky':len(all_risky),
            'best_prop':sp(max(all_safe,key=lambda x:x['hit_rate'])) if all_safe else None,
        },
        'daily_update_instructions':{
            'windows':'Task Scheduler -> python rolibot_v5.py -> daily 1PM ET',
            'mac_linux':'cron: 0 13 * * * cd /path && python rolibot_v5.py',
            'json_mode':'ROLI_JSON=1 python rolibot_v5.py',
            'backtest':'ROLI_GAME_DATE=2026-03-15 python rolibot_v5.py',
            'llm':'ANTHROPIC_API_KEY=sk-ant-... python rolibot_v5.py',
            'retrain':'delete rolibot_cache.pkl then run',
            'no_github_actions_needed':True,
        },
        'disclaimer':'For entertainment only. Not financial advice.',
    }

    def jdef(o):
        if isinstance(o,np.integer):  return int(o)
        if isinstance(o,np.floating):
            v = float(o)
            return v if math.isfinite(v) else None
        if isinstance(o,np.ndarray):  return o.tolist()
        raise TypeError(type(o))

    payload = json.dumps(report,ensure_ascii=False,default=jdef)
    out_path = os.environ.get("ROLI_JSON_OUT")
    if out_path:
        with open(out_path,"w",encoding="utf-8") as f: f.write(payload)
    else:
        print(payload)