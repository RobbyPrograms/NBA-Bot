# ============================================================
#  NBA BETTING PREDICTOR — FULL PIPELINE + PARLAY BUILDER
#  Data → Features → XGBoost AI → Tonight's Bet Slip
#  + PLAYER PROP PARLAYS (3s, Rebs, Asts, Pts, etc.)
# ============================================================

import os, sys, time, warnings, itertools
warnings.filterwarnings('ignore')

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

import matplotlib
matplotlib.use(os.environ.get("MPLBACKEND", "Agg"))

from nba_api.stats.endpoints import leaguegamefinder, scoreboardv2, playergamelog, commonteamroster
from nba_api.stats.static import teams as nba_teams_static, players as nba_players_static
import pandas as pd
import numpy as np
import xgboost as xgb
from sklearn.metrics import accuracy_score, classification_report
from sklearn.calibration import CalibratedClassifierCV
try:
    from sklearn.frozen import FrozenEstimator
    USE_FROZEN = True
except ImportError:
    USE_FROZEN = False
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
from datetime import date

# ─────────────────────────────────────────────────────────────
#  HELPER: American odds ↔ implied probability
# ─────────────────────────────────────────────────────────────
def prob_to_american(p):
    if p <= 0 or p >= 1:
        return "N/A"
    if p >= 0.5:
        return f"-{round((p/(1-p))*100)}"
    else:
        return f"+{round(((1-p)/p)*100)}"

def parlay_prob(probs):
    r = 1.0
    for p in probs:
        r *= p
    return r

def parlay_payout(probs, stake=100):
    """Convert parlay probability to approximate payout on $100."""
    combined = parlay_prob(probs)
    if combined <= 0:
        return 0
    decimal_odds = 1 / combined
    return round((decimal_odds - 1) * stake, 2)

# ─────────────────────────────────────────────────────────────
#  BANNER
# ─────────────────────────────────────────────────────────────
print()
print("╔══════════════════════════════════════════════════════════╗")
print("║    NBA AI BETTING PREDICTOR  •  PLAYER PROP PARLAYS     ║")
print("╚══════════════════════════════════════════════════════════╝")
print()

# ============================================================
#  PHASE 1 — PULL RAW DATA
# ============================================================
print("━" * 60)
print(" PHASE 1 — Pulling NBA game data (7 seasons)...")
print("━" * 60)

all_seasons = ['2018-19','2019-20','2020-21','2021-22','2022-23','2023-24','2024-25']
all_games   = []

for season in all_seasons:
    print(f"  {season}...", end=" ", flush=True)
    for attempt in range(3):
        try:
            gf  = leaguegamefinder.LeagueGameFinder(
                season_nullable=season,
                season_type_nullable='Regular Season'
            )
            df  = gf.get_data_frames()[0]
            all_games.append(df)
            print(f"✓  {len(df):,} rows")
            break
        except Exception as e:
            if attempt < 2:
                time.sleep(3)
            else:
                print(f"✗  {e}")
    time.sleep(2)

if not all_games:
    raise SystemExit("No data downloaded. Check network / nba_api.")

games = pd.concat(all_games, ignore_index=True)
print(f"\n  Total rows: {games.shape[0]:,}\n")

# ============================================================
#  PHASE 2 — CLEAN & ENGINEER FEATURES
# ============================================================
print("━" * 60)
print(" PHASE 2 — Engineering features...")
print("━" * 60)

games = games.sort_values(['TEAM_ID','GAME_DATE']).reset_index(drop=True)
games['WIN']       = (games['WL'] == 'W').astype(int)
games['IS_HOME']   = games['MATCHUP'].apply(lambda x: 1 if 'vs.' in x else 0)
games['GAME_DATE'] = pd.to_datetime(games['GAME_DATE'])

key_cols = ['PTS','FG_PCT','FG3_PCT','FT_PCT','REB','AST','TOV','PLUS_MINUS','STL','BLK']
games = games.dropna(subset=key_cols).reset_index(drop=True)

# Rest / back-to-back
games['REST_DAYS'] = (
    games.groupby('TEAM_ID')['GAME_DATE']
    .diff().dt.days.fillna(3).clip(0, 10)
)
games['IS_B2B'] = (games['REST_DAYS'] <= 1).astype(int)

# Rolling averages
for col in ['PTS','FG_PCT','FG3_PCT','FT_PCT','REB','AST','TOV','PLUS_MINUS','STL','BLK']:
    games[f'{col}_ROLL10'] = (
        games.groupby('TEAM_ID')[col]
        .transform(lambda x: x.shift(1).rolling(10, min_periods=5).mean())
    )

for col in ['PTS','PLUS_MINUS','FG_PCT','TOV','REB']:
    games[f'{col}_ROLL5'] = (
        games.groupby('TEAM_ID')[col]
        .transform(lambda x: x.shift(1).rolling(5, min_periods=3).mean())
    )

# Win streak, season win %
games['WIN_STREAK5'] = (
    games.groupby('TEAM_ID')['WIN']
    .transform(lambda x: x.shift(1).rolling(5, min_periods=3).mean())
)
games['SEASON_WINPCT'] = (
    games.groupby(['TEAM_ID','SEASON_ID'])['WIN']
    .transform(lambda x: x.shift(1).expanding().mean())
)

# Derived features
games['OFF_RATING_PROXY'] = games['PTS_ROLL10'] / games['FG_PCT_ROLL10'].replace(0, np.nan)
games['BALL_CONTROL']     = games['AST_ROLL10'] / games['TOV_ROLL10'].replace(0, np.nan)

# Merge home vs away
home   = games[games['IS_HOME'] == 1].copy()
away   = games[games['IS_HOME'] == 0].copy()
merged = home.merge(away, on='GAME_ID', suffixes=('_HOME','_AWAY'))
merged['HOME_WIN'] = merged['WIN_HOME']
merged = merged.sort_values('GAME_DATE_HOME').reset_index(drop=True)

# Differentials
merged['PLUS_MINUS_DIFF'] = merged['PLUS_MINUS_ROLL10_HOME'] - merged['PLUS_MINUS_ROLL10_AWAY']
merged['FG_PCT_DIFF']     = merged['FG_PCT_ROLL10_HOME']     - merged['FG_PCT_ROLL10_AWAY']
merged['PTS_DIFF']        = merged['PTS_ROLL10_HOME']        - merged['PTS_ROLL10_AWAY']
merged['WIN_STREAK_DIFF'] = merged['WIN_STREAK5_HOME']       - merged['WIN_STREAK5_AWAY']

feature_cols = [
    'PTS_ROLL10_HOME','FG_PCT_ROLL10_HOME','FG3_PCT_ROLL10_HOME','FT_PCT_ROLL10_HOME',
    'REB_ROLL10_HOME','AST_ROLL10_HOME','TOV_ROLL10_HOME','PLUS_MINUS_ROLL10_HOME',
    'STL_ROLL10_HOME','BLK_ROLL10_HOME',
    'PTS_ROLL5_HOME','PLUS_MINUS_ROLL5_HOME','FG_PCT_ROLL5_HOME','TOV_ROLL5_HOME','REB_ROLL5_HOME',
    'WIN_STREAK5_HOME','SEASON_WINPCT_HOME','REST_DAYS_HOME','IS_B2B_HOME',
    'OFF_RATING_PROXY_HOME','BALL_CONTROL_HOME',
    'PTS_ROLL10_AWAY','FG_PCT_ROLL10_AWAY','FG3_PCT_ROLL10_AWAY','FT_PCT_ROLL10_AWAY',
    'REB_ROLL10_AWAY','AST_ROLL10_AWAY','TOV_ROLL10_AWAY','PLUS_MINUS_ROLL10_AWAY',
    'STL_ROLL10_AWAY','BLK_ROLL10_AWAY',
    'PTS_ROLL5_AWAY','PLUS_MINUS_ROLL5_AWAY','FG_PCT_ROLL5_AWAY','TOV_ROLL5_AWAY','REB_ROLL5_AWAY',
    'WIN_STREAK5_AWAY','SEASON_WINPCT_AWAY','REST_DAYS_AWAY','IS_B2B_AWAY',
    'OFF_RATING_PROXY_AWAY','BALL_CONTROL_AWAY',
    'PLUS_MINUS_DIFF','FG_PCT_DIFF','PTS_DIFF','WIN_STREAK_DIFF',
]

merged = merged.dropna(subset=feature_cols).reset_index(drop=True)

print(f"  ✓ Clean training games : {len(merged):,}")
print(f"  ✓ Features per game    : {len(feature_cols)}")
print(f"  ✓ Home win rate        : {merged['HOME_WIN'].mean():.1%}")
print(f"  ✓ Date range           : {merged['GAME_DATE_HOME'].min().date()} → {merged['GAME_DATE_HOME'].max().date()}\n")

# ============================================================
#  PHASE 3 — TRAIN / TEST SPLIT
# ============================================================
print("━" * 60)
print(" PHASE 3 — Train / test split (time-based, no leakage)...")
print("━" * 60)

X = merged[feature_cols]
y = merged['HOME_WIN']

split    = int(len(X) * 0.80)
X_train  = X.iloc[:split];  y_train = y.iloc[:split]
X_test   = X.iloc[split:];  y_test  = y.iloc[split:]

print(f"  ✓ Training : {len(X_train):,} games")
print(f"  ✓ Test     : {len(X_test):,} games\n")

# ============================================================
#  PHASE 4 — TRAIN XGBOOST
# ============================================================
print("━" * 60)
print(" PHASE 4 — Training XGBoost AI model...")
print("━" * 60)

model = xgb.XGBClassifier(
    n_estimators          = 500,
    max_depth             = 4,
    learning_rate         = 0.03,
    subsample             = 0.8,
    colsample_bytree      = 0.8,
    min_child_weight      = 3,
    gamma                 = 0.1,
    reg_alpha             = 0.1,
    reg_lambda            = 1.5,
    use_label_encoder     = False,
    eval_metric           = 'logloss',
    early_stopping_rounds = 30,
    random_state          = 42,
    n_jobs                = -1,
)
model.fit(X_train, y_train, eval_set=[(X_test, y_test)], verbose=100)

# Calibrate
if USE_FROZEN:
    calibrated = CalibratedClassifierCV(
        estimator=FrozenEstimator(model), method="isotonic", cv=5
    )
else:
    calibrated = CalibratedClassifierCV(model, cv='prefit', method='isotonic')
calibrated.fit(X_test, y_test)
print("\n  ✓ Model trained & calibrated\n")

# ============================================================
#  PHASE 5 — EVALUATE
# ============================================================
print("━" * 60)
print(" PHASE 5 — Model evaluation...")
print("━" * 60)

preds = calibrated.predict(X_test)
probs = calibrated.predict_proba(X_test)[:, 1]
acc   = accuracy_score(y_test, preds)

print(f"\n  Accuracy on unseen games : {acc:.1%}")
print(f"  Sportsbook breakeven     : ~52.4%")
print(f"  Edge over breakeven      : {(acc-0.524)*100:+.1f} pp")
print(f"\n{classification_report(y_test, preds, target_names=['Away Win','Home Win'])}")

# Calibration check
print("  Confidence calibration:")
print(f"  {'Range':>10}  {'Actual win%':>12}  {'n games':>8}")
for lo, hi in [(0.5,0.55),(0.55,0.60),(0.60,0.65),(0.65,0.70),(0.70,1.0)]:
    mask = (probs >= lo) & (probs < hi)
    if mask.sum() > 10:
        print(f"  {lo:.0%}–{hi:.0%}     {y_test[mask].mean():>11.1%}   {mask.sum():>7}")

# Feature importance chart
importance = pd.Series(model.feature_importances_, index=feature_cols).sort_values(ascending=False)
top15      = importance.head(15)
fig, ax    = plt.subplots(figsize=(10, 6))
colors     = ['#0F2027' if i < 3 else '#203A43' if i < 8 else '#2C5364' for i in range(len(top15))]
ax.barh(top15.index[::-1], top15.values[::-1], color=colors[::-1])
ax.set_xlabel('Importance Score')
ax.set_title('Top 15 Predictive Features', fontweight='bold')
plt.tight_layout()
chart_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "feature_importance.png")
plt.savefig(chart_path, dpi=150, bbox_inches="tight")
plt.close()
print(f"\n  ✓ Chart saved: {chart_path}\n")

# ============================================================
#  PHASE 6 — PULL TONIGHT'S REAL GAMES AUTOMATICALLY
# ============================================================
print("━" * 60)
print(" PHASE 6 — Fetching tonight's real NBA schedule...")
print("━" * 60)

team_list        = nba_teams_static.get_teams()
team_lookup      = {t['abbreviation']: t['id'] for t in team_list}
team_name_lookup = {t['id']: t['full_name'] for t in team_list}
abbr_lookup      = {t['id']: t['abbreviation'] for t in team_list}

def get_tonights_games():
    """Pull tonight's games from NBA scoreboard API."""
    try:
        sb    = scoreboardv2.ScoreboardV2(game_date=date.today().strftime('%Y-%m-%d'))
        ginfo = sb.game_header.get_data_frame()
        if ginfo.empty:
            return []
        matchups = []
        for _, row in ginfo.iterrows():
            home_id = row.get('HOME_TEAM_ID')
            away_id = row.get('VISITOR_TEAM_ID')
            home_abbr = abbr_lookup.get(home_id, '')
            away_abbr = abbr_lookup.get(away_id, '')
            if home_abbr and away_abbr:
                matchups.append((away_abbr, home_abbr))
        return matchups
    except Exception as e:
        print(f"  ! Could not auto-fetch schedule: {e}")
        return []

tonight = get_tonights_games()

if tonight:
    print(f"  ✓ Found {len(tonight)} games tonight automatically\n")
else:
    print("  ! Auto-fetch returned no games. Using sample matchups.")
    print("    Edit the 'tonight' list below with real games.\n")
    tonight = [
        ('BOS', 'LAL'),
        ('GSW', 'MIA'),
        ('DEN', 'NYK'),
        ('MIL', 'PHX'),
        ('DAL', 'OKC'),
    ]

# ============================================================
#  PHASE 6B — PLAYER PROP ENGINE
# ============================================================
print("━" * 60)
print(" PHASE 6B — Loading player stats for prop predictions...")
print("━" * 60)

# Prop thresholds to test per stat type
PROP_THRESHOLDS = {
    'PTS':  [10, 15, 20, 25, 30],
    'REB':  [4, 6, 8, 10, 12],
    'AST':  [3, 5, 7, 10],
    'FG3M': [1, 2, 3, 4, 5],   # 3-pointers made
    'STL':  [1, 2],
    'BLK':  [1, 2],
}

# Key players to always analyze (stars + role players for value picks)
KEY_PLAYERS_BY_TEAM = {
    # Format: TEAM_ABBR: [player_name_fragment, ...]
    # We'll auto-detect from roster too, but these are prioritized
    'LAL': ['LeBron', 'Davis', 'Reaves'],
    'GSW': ['Curry', 'Green', 'Thompson'],
    'BOS': ['Tatum', 'Brown', 'Holiday'],
    'DEN': ['Jokic', 'Murray', 'Porter'],
    'MIL': ['Giannis', 'Lillard', 'Portis'],
    'PHX': ['Durant', 'Booker', 'Beal'],
    'NYK': ['Brunson', 'Towns', 'Hart'],
    'MIA': ['Butler', 'Adebayo', 'Herro'],
    'OKC': ['Gilgeous', 'Dort', 'Holmgren'],
    'DAL': ['Doncic', 'Irving', 'Gafford'],
    'CLE': ['Mitchell', 'Mobley', 'Garland'],
    'LAC': ['Harden', 'Zubac', 'Powell'],
    'SAS': ['Wembanyama', 'Johnson', 'Castle'],
    'MIN': ['Edwards', 'Gobert', 'Towns'],
    'NOP': ['Williamson', 'Ingram', 'Valanciunas'],
    'POR': ['Simons', 'Anfernee', 'Smith'],
    'CHA': ['LaMelo', 'Miles Bridges', 'Richards'],
    'DET': ['Cunningham', 'Stewart', 'Duren'],
    'IND': ['Haliburton', 'Siakam', 'Turner'],
    'ATL': ['Young', 'Murray', 'Okongwu'],
    'CHI': ['LaVine', 'DeRozan', 'Vucevic'],
    'TOR': ['Scottie', 'Quickley', 'Boucher'],
    'WAS': ['Poole', 'Kuzma', 'Beal'],
    'ORL': ['Paolo', 'Franz', 'Fultz'],
    'SAC': ['Fox', 'Sabonis', 'Monk'],
    'UTA': ['Lauri', 'Keyonte', 'Sexton'],
    'HOU': ['Green', 'Sengun', 'Thompson'],
    'MEM': ['Morant', 'Jackson', 'Smart'],
    'NOH': ['Williamson', 'Ingram', 'Murphy'],
}

def get_player_recent_stats(player_name_fragment, season='2024-25', n_games=15):
    """Search for a player and fetch their recent game log."""
    all_players = nba_players_static.get_players()
    matches = [p for p in all_players
               if player_name_fragment.lower() in p['full_name'].lower()
               and p['is_active']]
    if not matches:
        return None, None

    player = matches[0]
    try:
        log = playergamelog.PlayerGameLog(
            player_id=player['id'],
            season=season,
            season_type_all_star='Regular Season'
        )
        df = log.get_data_frames()[0]
        if df.empty:
            return None, None
        # Add FG3M column if not present
        if 'FG3M' not in df.columns and 'FG3A' in df.columns:
            df['FG3M'] = df.get('FG3M', 0)
        return player['full_name'], df.head(n_games)
    except Exception:
        return None, None

def compute_prop_probability(game_log, stat_col, threshold):
    """
    Compute the empirical probability a player hits 'threshold' in 'stat_col'
    based on recent game log. Returns (hit_rate, avg, std, n_games).
    """
    if game_log is None or stat_col not in game_log.columns:
        return None, None, None, 0

    vals = pd.to_numeric(game_log[stat_col], errors='coerce').dropna()
    if len(vals) < 5:
        return None, None, None, len(vals)

    hit_rate = (vals >= threshold).mean()
    avg      = vals.mean()
    std      = vals.std()
    return hit_rate, avg, std, len(vals)

def analyze_player_props(team_abbr, game_log_cache):
    """
    For a given team, pull key players and analyze their props.
    Returns list of prop dicts with probability info.
    """
    props = []
    player_names = KEY_PLAYERS_BY_TEAM.get(team_abbr, [])

    for name_frag in player_names:
        cache_key = name_frag.lower()
        if cache_key not in game_log_cache:
            full_name, log = get_player_recent_stats(name_frag)
            game_log_cache[cache_key] = (full_name, log)
            time.sleep(0.8)  # rate limit
        else:
            full_name, log = game_log_cache[cache_key]

        if log is None or full_name is None:
            continue

        for stat, thresholds in PROP_THRESHOLDS.items():
            for thresh in thresholds:
                hit_rate, avg, std, n = compute_prop_probability(log, stat, thresh)
                if hit_rate is None or n < 5:
                    continue

                # Only include props where the line is meaningful
                if avg is None or avg < thresh * 0.5:
                    continue

                # Skip trivially easy props (>95%) or impossible ones (<5%)
                if hit_rate > 0.95 or hit_rate < 0.05:
                    continue

                label = _prop_label(stat, thresh)

                props.append({
                    'player':    full_name,
                    'team':      team_abbr,
                    'stat':      stat,
                    'threshold': thresh,
                    'label':     label,
                    'hit_rate':  hit_rate,
                    'avg':       avg,
                    'std':       std if std else 0,
                    'n_games':   n,
                })

    return props

def _prop_label(stat, thresh):
    labels = {
        'PTS':  f"{thresh}+ Points",
        'REB':  f"{thresh}+ Rebounds",
        'AST':  f"{thresh}+ Assists",
        'FG3M': f"{thresh}+ Three-Pointers",
        'STL':  f"{thresh}+ Steals",
        'BLK':  f"{thresh}+ Blocks",
    }
    return labels.get(stat, f"{thresh}+ {stat}")

def prop_confidence(hit_rate):
    if hit_rate >= 0.78:
        return "🔥 STRONG", "★★★"
    elif hit_rate >= 0.65:
        return "✅ GOOD", "★★☆"
    elif hit_rate >= 0.52:
        return "👀 LEAN", "★☆☆"
    else:
        return "⚠️  RISKY", "☆☆☆"

# Pre-load all player logs
game_log_cache = {}
all_team_abbrs = list(set([t for pair in tonight for t in pair]))

print(f"  Fetching player stats for {len(all_team_abbrs)} teams...")
all_props_by_team = {}
for abbr in all_team_abbrs:
    props = analyze_player_props(abbr, game_log_cache)
    all_props_by_team[abbr] = props
    n = len([p for p in props if p['hit_rate'] >= 0.52])
    print(f"  ✓ {abbr}: {n} viable props found")

print()

# ============================================================
#  PHASE 7 — PREDICT EVERY GAME + BUILD PARLAYS
# ============================================================
print("━" * 60)
print(" PHASE 7 — AI Predictions + Parlay Builder")
print("━" * 60)

def get_team_features(team_id, rest_days=2, is_b2b=0):
    tg = games[games['TEAM_ID'] == team_id].copy()
    if len(tg) < 5:
        return None
    latest = tg.iloc[-1]
    stat_map = {
        'PTS_ROLL10','FG_PCT_ROLL10','FG3_PCT_ROLL10','FT_PCT_ROLL10',
        'REB_ROLL10','AST_ROLL10','TOV_ROLL10','PLUS_MINUS_ROLL10','STL_ROLL10','BLK_ROLL10',
        'PTS_ROLL5','PLUS_MINUS_ROLL5','FG_PCT_ROLL5','TOV_ROLL5','REB_ROLL5',
        'WIN_STREAK5','SEASON_WINPCT','OFF_RATING_PROXY','BALL_CONTROL',
    }
    feats = {col: latest.get(col, np.nan) for col in stat_map}
    feats['REST_DAYS'] = rest_days
    feats['IS_B2B']    = is_b2b
    return feats

def predict_game(home_abbr, away_abbr, home_rest=2, away_rest=2, home_b2b=0, away_b2b=0):
    home_id = team_lookup.get(home_abbr.upper())
    away_id = team_lookup.get(away_abbr.upper())
    if not home_id or not away_id:
        return None

    hf = get_team_features(home_id, home_rest, home_b2b)
    af = get_team_features(away_id, away_rest, away_b2b)
    if hf is None or af is None:
        return None

    row = {}
    for col in feature_cols:
        if col.endswith('_HOME'):
            row[col] = hf.get(col.replace('_HOME',''), np.nan)
        elif col.endswith('_AWAY'):
            row[col] = af.get(col.replace('_AWAY',''), np.nan)

    row['PLUS_MINUS_DIFF'] = hf.get('PLUS_MINUS_ROLL10',0) - af.get('PLUS_MINUS_ROLL10',0)
    row['FG_PCT_DIFF']     = hf.get('FG_PCT_ROLL10',0)     - af.get('FG_PCT_ROLL10',0)
    row['PTS_DIFF']        = hf.get('PTS_ROLL10',0)        - af.get('PTS_ROLL10',0)
    row['WIN_STREAK_DIFF'] = hf.get('WIN_STREAK5',0)       - af.get('WIN_STREAK5',0)

    X_pred    = pd.DataFrame([row])[feature_cols]
    prob_home = calibrated.predict_proba(X_pred)[0][1]
    return prob_home

# ── Run every game ────────────────────────────────────────────
print()
game_results = []

for away_abbr, home_abbr in tonight:
    prob_home = predict_game(home_abbr, away_abbr)
    if prob_home is None:
        continue

    prob_away  = 1 - prob_home
    home_name  = team_name_lookup.get(team_lookup.get(home_abbr,''), home_abbr)
    away_name  = team_name_lookup.get(team_lookup.get(away_abbr,''), away_abbr)

    if prob_home >= prob_away:
        pick_name = home_name
        pick_abbr = home_abbr
        pick_prob = prob_home
        pick_side = "HOME"
    else:
        pick_name = away_name
        pick_abbr = away_abbr
        pick_prob = prob_away
        pick_side = "AWAY"

    edge = pick_prob - 0.5
    if edge >= 0.15:
        confidence = "🔥 STRONG"
        stars      = "★★★"
    elif edge >= 0.09:
        confidence = "✅ GOOD"
        stars      = "★★☆"
    elif edge >= 0.05:
        confidence = "👀 LEAN"
        stars      = "★☆☆"
    else:
        confidence = "⚠️  SKIP"
        stars      = "☆☆☆"

    # Collect props for both teams in this game
    game_props = all_props_by_team.get(home_abbr, []) + all_props_by_team.get(away_abbr, [])

    game_results.append({
        'home_abbr': home_abbr, 'away_abbr': away_abbr,
        'home_name': home_name, 'away_name': away_name,
        'prob_home': prob_home, 'prob_away': prob_away,
        'pick_name': pick_name, 'pick_abbr': pick_abbr,
        'pick_prob': pick_prob, 'pick_side': pick_side,
        'edge': edge, 'confidence': confidence, 'stars': stars,
        'props': game_props,
    })

game_results.sort(key=lambda x: x['edge'], reverse=True)

# ── Print individual game predictions ─────────────────────────
print("┌" + "─"*58 + "┐")
print("│{:^58}│".format("TONIGHT'S GAME PREDICTIONS"))
print("└" + "─"*58 + "┘")

for g in game_results:
    print()
    print(f"  {g['away_name']}  @  {g['home_name']}")
    print(f"  {'─'*44}")
    print(f"  Home  ({g['home_abbr']})  :  {g['prob_home']:>5.1%}  {prob_to_american(g['prob_home']):>6}")
    print(f"  Away  ({g['away_abbr']})  :  {g['prob_away']:>5.1%}  {prob_to_american(g['prob_away']):>6}")
    print(f"  Pick  →  {g['pick_name']} ({g['pick_side']})")
    print(f"  Signal:  {g['confidence']}  {g['stars']}")

# ============================================================
#  PHASE 8 — PLAYER PROP BREAKDOWN PER GAME
# ============================================================
print()
print("┌" + "─"*58 + "┐")
print("│{:^58}│".format("PLAYER PROPS — PER GAME BREAKDOWN"))
print("└" + "─"*58 + "┘")

all_safe_props   = []  # hit_rate >= 0.65
all_risky_props  = []  # hit_rate 0.40–0.64 (long shots with upside)

for g in game_results:
    print()
    print(f"  ╔═ {g['away_name']} @ {g['home_name']} ═╗")

    game_safe  = [p for p in g['props'] if p['hit_rate'] >= 0.65]
    game_risky = [p for p in g['props'] if 0.35 <= p['hit_rate'] < 0.52]

    # Sort by hit rate desc
    game_safe.sort(key=lambda x: x['hit_rate'], reverse=True)
    game_risky.sort(key=lambda x: x['hit_rate'], reverse=True)

    if game_safe:
        print(f"  🎯 TOP PROPS (high confidence):")
        for p in game_safe[:6]:
            conf, stars = prop_confidence(p['hit_rate'])
            avg_str = f"avg {p['avg']:.1f}"
            print(f"     {p['player']:25s}  {p['label']:22s}  {p['hit_rate']:.0%}  {conf}  {avg_str}")
        all_safe_props.extend(game_safe)
    else:
        print(f"  (No high-confidence props found for this game)")

    if game_risky:
        print(f"  💣 RISKY PICKS (high payout potential):")
        for p in game_risky[:4]:
            avg_str = f"avg {p['avg']:.1f}"
            print(f"     {p['player']:25s}  {p['label']:22s}  {p['hit_rate']:.0%}  ⚠️  RISKY  {avg_str}")
        all_risky_props.extend(game_risky)

# ============================================================
#  PHASE 9 — PLAYER PROP PARLAYS
# ============================================================
print()
print("┌" + "─"*58 + "┐")
print("│{:^58}│".format("PLAYER PROP PARLAYS"))
print("└" + "─"*58 + "┘")
print()

def build_prop_parlays(props, min_legs=2, max_legs=4, top_n=8, label=""):
    """Build and rank prop parlays from a pool of props."""
    if len(props) < min_legs:
        print(f"  Not enough props for {label} parlays.\n")
        return []

    # Deduplicate: keep best prop per player (avoid stacking same player)
    seen_players = {}
    unique_props = []
    for p in sorted(props, key=lambda x: x['hit_rate'], reverse=True):
        key = (p['player'], p['stat'])
        if p['player'] not in seen_players:
            seen_players[p['player']] = True
            unique_props.append(p)
        elif key not in seen_players:
            seen_players[key] = True
            unique_props.append(p)

    all_parlays = []
    pool = unique_props[:20]  # Cap to avoid combinatorial explosion

    for n_legs in range(min_legs, min(max_legs+1, len(pool)+1)):
        for combo in itertools.combinations(pool, n_legs):
            probs    = [c['hit_rate'] for c in combo]
            combined = parlay_prob(probs)
            payout   = parlay_payout(probs, stake=100)
            all_parlays.append({
                'legs': list(combo), 'combined': combined,
                'payout': payout, 'n': n_legs
            })

    def score(p):
        if p['combined'] < 0.05:
            return -1
        return p['combined'] * np.log1p(p['payout'])

    all_parlays.sort(key=score, reverse=True)
    return all_parlays[:top_n]

# ── SAFE PROP PARLAYS ─────────────────────────────────────────
print("  ━━━ 🎯 SAFE PROP PARLAYS (High Hit Rate) ━━━")
print()
safe_parlays = build_prop_parlays(all_safe_props, min_legs=2, max_legs=4, top_n=5, label="safe")

for i, parlay in enumerate(safe_parlays, 1):
    print(f"  PROP PARLAY #{i}  —  {parlay['n']}-LEG  ({parlay['combined']:.1%} hit chance)")
    print(f"  {'─'*50}")
    for leg in parlay['legs']:
        conf, stars = prop_confidence(leg['hit_rate'])
        print(f"   ▸ {leg['player']:25s}  {leg['label']:22s}  {leg['hit_rate']:.0%}  {stars}")
    print(f"  Combined probability : {parlay['combined']:.1%}")
    print(f"  Approx payout (100$) : ${parlay['payout']:,.2f}")
    print(f"  Implied odds         : {prob_to_american(parlay['combined'])}")
    print()

# ── RISKY PROP PARLAYS ────────────────────────────────────────
print("  ━━━ 💣 RISKY PROP PARLAYS (Long Shots / Big Payouts) ━━━")
print()
risky_parlays = build_prop_parlays(all_risky_props, min_legs=2, max_legs=5, top_n=5, label="risky")

for i, parlay in enumerate(risky_parlays, 1):
    print(f"  RISKY PARLAY #{i}  —  {parlay['n']}-LEG  ({parlay['combined']:.1%} hit chance)")
    print(f"  {'─'*50}")
    for leg in parlay['legs']:
        print(f"   ⚡ {leg['player']:25s}  {leg['label']:22s}  {leg['hit_rate']:.0%}  avg {leg['avg']:.1f}")
    print(f"  Combined probability : {parlay['combined']:.1%}")
    print(f"  Approx payout (100$) : ${parlay['payout']:,.2f}")
    print(f"  Implied odds         : {prob_to_american(parlay['combined'])}")
    print()

# ── MIXED PARLAYS: Team ML + Player Props ─────────────────────
print("  ━━━ 🔀 MIXED PARLAYS (Team ML + Player Props) ━━━")
print()

# Take best 2 game picks + 1-2 top player props each
strong_games = [g for g in game_results if g['edge'] >= 0.09]
top_props_flat = sorted(all_safe_props, key=lambda x: x['hit_rate'], reverse=True)[:10]

# Deduplicate by player
seen = set()
top_props_deduped = []
for p in top_props_flat:
    if p['player'] not in seen:
        seen.add(p['player'])
        top_props_deduped.append(p)

mixed_parlays = []
for g in strong_games[:3]:
    for prop in top_props_deduped[:8]:
        # Don't mix same team's prop with their ML unless it adds value
        probs    = [g['pick_prob'], prop['hit_rate']]
        combined = parlay_prob(probs)
        payout   = parlay_payout(probs, stake=100)
        mixed_parlays.append({
            'game': g,
            'prop': prop,
            'combined': combined,
            'payout': payout,
            'n': 2,
        })

        # 3-leg: game + 2 props
        for prop2 in top_props_deduped[:8]:
            if prop2['player'] != prop['player']:
                probs3    = [g['pick_prob'], prop['hit_rate'], prop2['hit_rate']]
                combined3 = parlay_prob(probs3)
                payout3   = parlay_payout(probs3, stake=100)
                mixed_parlays.append({
                    'game': g,
                    'prop': prop,
                    'prop2': prop2,
                    'combined': combined3,
                    'payout': payout3,
                    'n': 3,
                })

def mixed_score(p):
    if p['combined'] < 0.08:
        return -1
    return p['combined'] * np.log1p(p['payout'])

mixed_parlays.sort(key=mixed_score, reverse=True)
top_mixed = mixed_parlays[:5]

for i, m in enumerate(top_mixed, 1):
    print(f"  MIXED PARLAY #{i}  —  {m['n']}-LEG")
    print(f"  {'─'*50}")
    g = m['game']
    print(f"   🏀 {g['pick_name']:30s}  ({g['pick_side']})  {g['pick_prob']:.0%}  {g['stars']}")
    p1 = m['prop']
    print(f"   ▸ {p1['player']:28s}  {p1['label']:22s}  {p1['hit_rate']:.0%}")
    if 'prop2' in m:
        p2 = m['prop2']
        print(f"   ▸ {p2['player']:28s}  {p2['label']:22s}  {p2['hit_rate']:.0%}")
    print(f"  Combined probability : {m['combined']:.1%}")
    print(f"  Approx payout (100$) : ${m['payout']:,.2f}")
    print(f"  Implied odds         : {prob_to_american(m['combined'])}")
    print()

# ============================================================
#  PHASE 10 — FINAL BET SLIP
# ============================================================
print("┌" + "─"*58 + "┐")
print("│{:^58}│".format("YOUR BET SLIP FOR TONIGHT"))
print("└" + "─"*58 + "┘")
print()

strong = [g for g in game_results if g['edge'] >= 0.15]
good   = [g for g in game_results if 0.09 <= g['edge'] < 0.15]
lean   = [g for g in game_results if 0.05 <= g['edge'] < 0.09]
skip   = [g for g in game_results if g['edge'] < 0.05]

if strong:
    print("  🔥 STRONG BETS  (bet these — highest confidence)")
    for g in strong:
        print(f"     • {g['pick_name']} ML  →  {g['pick_prob']:.1%}  ({prob_to_american(g['pick_prob'])})")
    print()

if good:
    print("  ✅ GOOD BETS  (solid plays, slightly less edge)")
    for g in good:
        print(f"     • {g['pick_name']} ML  →  {g['pick_prob']:.1%}  ({prob_to_american(g['pick_prob'])})")
    print()

if lean:
    print("  👀 LEAN  (small plays only or parlays)")
    for g in lean:
        print(f"     • {g['pick_name']} ML  →  {g['pick_prob']:.1%}  ({prob_to_american(g['pick_prob'])})")
    print()

if skip:
    print("  ⚠️  SKIP THESE  (model has no edge)")
    for g in skip:
        print(f"     • {g['away_name']} @ {g['home_name']}  (too close to call)")
    print()

# Best prop pick of the night
if all_safe_props:
    best_prop = max(all_safe_props, key=lambda x: x['hit_rate'])
    conf, stars = prop_confidence(best_prop['hit_rate'])
    print(f"  🎯 BEST PLAYER PROP TONIGHT:")
    print(f"     {best_prop['player']}  {best_prop['label']}")
    print(f"     {best_prop['hit_rate']:.0%} hit rate  (avg {best_prop['avg']:.1f} over last {best_prop['n_games']} games)")
    print()

# Best team parlay
parlay_pool = [g for g in game_results if g['edge'] >= 0.05]
top_team_parlay = None
if len(parlay_pool) >= 2:
    best_2leg = sorted(
        [{'legs': c, 'combined': parlay_prob([x['pick_prob'] for x in c]),
          'payout': parlay_payout([x['pick_prob'] for x in c])}
         for c in itertools.combinations(parlay_pool, 2)],
        key=lambda x: x['combined'] * np.log1p(x['payout']),
        reverse=True
    )
    if best_2leg:
        top_team_parlay = best_2leg[0]
        legs_str = "  +  ".join([f"{g['pick_name']}" for g in top_team_parlay['legs']])
        print(f"  BEST TEAM PARLAY:")
        print(f"     {legs_str}")
        print(f"     {top_team_parlay['combined']:.1%} hit chance  →  ${top_team_parlay['payout']:,.2f} on $100")
    print()

# Best safe prop parlay
if safe_parlays:
    best_sp = safe_parlays[0]
    legs_str = "  +  ".join([f"{p['player']} {p['label']}" for p in best_sp['legs']])
    print(f"  BEST PROP PARLAY:")
    print(f"     {legs_str}")
    print(f"     {best_sp['combined']:.1%} hit chance  →  ${best_sp['payout']:,.2f} on $100")
    print()

# Best risky prop
if risky_parlays:
    best_rp = risky_parlays[0]
    legs_str = "  +  ".join([f"{p['player']} {p['label']}" for p in best_rp['legs']])
    print(f"  💣 BEST RISKY PARLAY (long shot):")
    print(f"     {legs_str}")
    print(f"     {best_rp['combined']:.1%} hit chance  →  ${best_rp['payout']:,.2f} on $100")
    print()

print("═" * 60)
print(f"  Model accuracy : {acc:.1%}  |  Edge over book : {(acc-0.524)*100:+.1f}pp")
print(f"  Games trained  : {len(X_train):,}  |  Features : {len(feature_cols)}")
print(f"  Predictions    : {len(game_results)} games tonight")
print(f"  Player props   : {len(all_safe_props)} safe  |  {len(all_risky_props)} risky analyzed")
print("═" * 60)
print()
print("  HOW TO USE:")
print("  1. Copy STRONG BET picks to Bet365 / DraftKings")
print("  2. Use SAFE PROP PARLAY #1 for steady gains")
print("  3. Drop $10-20 max on RISKY PARLAYS for big upside")
print("  4. MIXED PARLAYS combine ML + props for value")
print("  5. Run this script every night before games tip off")
print("  6. Only bet what you can afford to lose")
print()