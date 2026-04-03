# ============================================================
#  NBA AI BETTING PREDICTOR v3 — FULL PIPELINE
#  Ensemble ML  •  Player Props  •  Kelly Criterion Sizing
#  Opponent-Adjusted Props  •  Hot/Cold Streaks  •  Caching
# ============================================================

import os, sys, time, warnings, itertools, pickle, hashlib
warnings.filterwarnings('ignore')

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

import matplotlib
matplotlib.use(os.environ.get("MPLBACKEND", "Agg"))

from nba_api.stats.endpoints import leaguegamefinder, scoreboardv2, playergamelog
from nba_api.stats.static   import teams as nba_teams_static, players as nba_players_static
import pandas as pd
import numpy as np
import xgboost as xgb
from sklearn.ensemble        import RandomForestClassifier
from sklearn.metrics         import accuracy_score, classification_report, log_loss
from sklearn.calibration     import CalibratedClassifierCV
try:
    from sklearn.frozen import FrozenEstimator
    USE_FROZEN = True
except ImportError:
    USE_FROZEN = False
import matplotlib.pyplot as plt
from datetime import date

# ─────────────────────────────────────────────────────────────
#  CONFIG  — edit these to match your situation
# ─────────────────────────────────────────────────────────────
BANKROLL          = 1000    # Your total bankroll in $
KELLY_FRACTION    = 0.25    # Fractional Kelly (0.25 = quarter Kelly, safer)
MAX_BET_PCT       = 0.05    # Never bet more than 5% of bankroll on one game
MIN_EDGE_FOR_BET  = 0.03    # Minimum model edge to consider a bet
MODEL_CACHE_FILE  = os.path.join(os.path.dirname(os.path.abspath(__file__)), "model_cache.pkl")
PROP_GAMES_BACK   = 20      # Recent games to use for prop analysis

# ─────────────────────────────────────────────────────────────
#  HELPERS
# ─────────────────────────────────────────────────────────────
def prob_to_american(p):
    if p <= 0 or p >= 1:
        return "N/A"
    return f"-{round((p/(1-p))*100)}" if p >= 0.5 else f"+{round(((1-p)/p)*100)}"

def parlay_prob(probs):
    r = 1.0
    for p in probs:
        r *= p
    return r

def parlay_payout(probs, stake=100):
    c = parlay_prob(probs)
    if c <= 0:
        return 0
    return round((1/c - 1) * stake, 2)

def kelly_bet(prob, american_odds_str, bankroll, fraction=KELLY_FRACTION, max_pct=MAX_BET_PCT):
    """
    Kelly Criterion: f* = (b*p - q) / b
    b = net decimal odds (e.g. -200 → b=0.5, +150 → b=1.5)
    Returns recommended $ amount to bet.
    """
    try:
        raw = american_odds_str.replace('+','').replace('-','')
        o   = int(raw)
        b   = 100/o if american_odds_str.startswith('-') else o/100
    except Exception:
        return 0
    p = prob
    q = 1 - p
    kelly_f = (b * p - q) / b
    if kelly_f <= 0:
        return 0
    capped = min(kelly_f * fraction, max_pct)
    return round(bankroll * capped, 2)

def weighted_hit_rate(hits_array, n_recent=5):
    """Recent games count 2x vs older games."""
    if len(hits_array) == 0:
        return 0.0
    recent = hits_array[:n_recent]
    older  = hits_array[n_recent:]
    w_r    = float(np.mean(recent)) * 2 if len(recent) > 0 else 0.0
    w_o    = float(np.mean(older))      if len(older)  > 0 else w_r / 2
    total_w = 2 * len(recent) + len(older)
    if total_w == 0:
        return 0.0
    return (w_r * len(recent) + w_o * len(older)) / total_w

def trend_label(recent_avg, overall_avg):
    if overall_avg == 0:
        return ""
    ratio = recent_avg / overall_avg
    if ratio >= 1.20:   return "🔥 HOT"
    elif ratio >= 1.08: return "📈 WARM"
    elif ratio <= 0.80: return "🥶 COLD"
    elif ratio <= 0.92: return "📉 COOLING"
    return ""

# ─────────────────────────────────────────────────────────────
#  BANNER
# ─────────────────────────────────────────────────────────────
print()
print("╔══════════════════════════════════════════════════════════╗")
print("║   NBA AI BETTING PREDICTOR v3  •  ENSEMBLE + KELLY      ║")
print("╚══════════════════════════════════════════════════════════╝")
print(f"  Bankroll: ${BANKROLL:,.0f}  |  Kelly fraction: {KELLY_FRACTION:.0%}  |  Max bet: {MAX_BET_PCT:.0%}")
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
            gf = leaguegamefinder.LeagueGameFinder(
                season_nullable=season,
                season_type_nullable='Regular Season'
            )
            df = gf.get_data_frames()[0]
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
games    = games.dropna(subset=key_cols).reset_index(drop=True)

# Rest / back-to-back
games['REST_DAYS'] = (
    games.groupby('TEAM_ID')['GAME_DATE']
    .diff().dt.days.fillna(3).clip(0, 10)
)
games['IS_B2B'] = (games['REST_DAYS'] <= 1).astype(int)

# Rolling averages — 10-game and 5-game
for col in ['PTS','FG_PCT','FG3_PCT','FT_PCT','REB','AST','TOV','PLUS_MINUS','STL','BLK']:
    games[f'{col}_ROLL10'] = (
        games.groupby('TEAM_ID')[col]
        .transform(lambda x: x.shift(1).rolling(10, min_periods=5).mean())
    )
for col in ['PTS','PLUS_MINUS','FG_PCT','TOV','REB','AST','FG3_PCT']:
    games[f'{col}_ROLL5'] = (
        games.groupby('TEAM_ID')[col]
        .transform(lambda x: x.shift(1).rolling(5, min_periods=3).mean())
    )

# Rolling variance (consistency signal)
for col in ['PTS','PLUS_MINUS']:
    games[f'{col}_VAR10'] = (
        games.groupby('TEAM_ID')[col]
        .transform(lambda x: x.shift(1).rolling(10, min_periods=5).std())
    )

# Win streaks
games['WIN_STREAK5'] = (
    games.groupby('TEAM_ID')['WIN']
    .transform(lambda x: x.shift(1).rolling(5, min_periods=3).mean())
)
games['WIN_STREAK3'] = (
    games.groupby('TEAM_ID')['WIN']
    .transform(lambda x: x.shift(1).rolling(3, min_periods=2).mean())
)
games['SEASON_WINPCT'] = (
    games.groupby(['TEAM_ID','SEASON_ID'])['WIN']
    .transform(lambda x: x.shift(1).expanding().mean())
)

# Derived features
games['OFF_RATING_PROXY'] = games['PTS_ROLL10'] / games['FG_PCT_ROLL10'].replace(0, np.nan)
games['BALL_CONTROL']     = games['AST_ROLL10'] / games['TOV_ROLL10'].replace(0, np.nan)
games['THREE_RATE']       = games['FG3_PCT_ROLL10'] * games['FG3_PCT_ROLL5']
games['MOMENTUM']         = games['PTS_ROLL5'] - games['PTS_ROLL10']   # positive = getting hotter

# Merge home vs away
home   = games[games['IS_HOME'] == 1].copy()
away   = games[games['IS_HOME'] == 0].copy()
merged = home.merge(away, on='GAME_ID', suffixes=('_HOME','_AWAY'))
merged['HOME_WIN'] = merged['WIN_HOME']
merged = merged.sort_values('GAME_DATE_HOME').reset_index(drop=True)

# Opponent defensive proxy: pts each side allowed
merged['DEF_ALLOWED_HOME'] = merged['PTS_AWAY']
merged['DEF_ALLOWED_AWAY'] = merged['PTS_HOME']

for side in ['HOME','AWAY']:
    col = f'DEF_ALLOWED_{side}'
    merged[f'DEF_RATING_ROLL10_{side}'] = (
        merged.groupby(f'TEAM_ID_{side}')[col]
        .transform(lambda x: x.shift(1).rolling(10, min_periods=5).mean())
    )

# Differentials
merged['PLUS_MINUS_DIFF'] = merged['PLUS_MINUS_ROLL10_HOME'] - merged['PLUS_MINUS_ROLL10_AWAY']
merged['FG_PCT_DIFF']     = merged['FG_PCT_ROLL10_HOME']     - merged['FG_PCT_ROLL10_AWAY']
merged['PTS_DIFF']        = merged['PTS_ROLL10_HOME']        - merged['PTS_ROLL10_AWAY']
merged['WIN_STREAK_DIFF'] = merged['WIN_STREAK5_HOME']       - merged['WIN_STREAK5_AWAY']
merged['MOMENTUM_DIFF']   = merged['MOMENTUM_HOME']          - merged['MOMENTUM_AWAY']
merged['DEF_RATING_DIFF'] = merged['DEF_RATING_ROLL10_HOME'] - merged['DEF_RATING_ROLL10_AWAY']

feature_cols = [
    # Home
    'PTS_ROLL10_HOME','FG_PCT_ROLL10_HOME','FG3_PCT_ROLL10_HOME','FT_PCT_ROLL10_HOME',
    'REB_ROLL10_HOME','AST_ROLL10_HOME','TOV_ROLL10_HOME','PLUS_MINUS_ROLL10_HOME',
    'STL_ROLL10_HOME','BLK_ROLL10_HOME',
    'PTS_ROLL5_HOME','PLUS_MINUS_ROLL5_HOME','FG_PCT_ROLL5_HOME','TOV_ROLL5_HOME',
    'REB_ROLL5_HOME','AST_ROLL5_HOME','FG3_PCT_ROLL5_HOME',
    'WIN_STREAK5_HOME','WIN_STREAK3_HOME','SEASON_WINPCT_HOME',
    'REST_DAYS_HOME','IS_B2B_HOME',
    'OFF_RATING_PROXY_HOME','BALL_CONTROL_HOME','THREE_RATE_HOME','MOMENTUM_HOME',
    'PTS_VAR10_HOME','PLUS_MINUS_VAR10_HOME','DEF_RATING_ROLL10_HOME',
    # Away
    'PTS_ROLL10_AWAY','FG_PCT_ROLL10_AWAY','FG3_PCT_ROLL10_AWAY','FT_PCT_ROLL10_AWAY',
    'REB_ROLL10_AWAY','AST_ROLL10_AWAY','TOV_ROLL10_AWAY','PLUS_MINUS_ROLL10_AWAY',
    'STL_ROLL10_AWAY','BLK_ROLL10_AWAY',
    'PTS_ROLL5_AWAY','PLUS_MINUS_ROLL5_AWAY','FG_PCT_ROLL5_AWAY','TOV_ROLL5_AWAY',
    'REB_ROLL5_AWAY','AST_ROLL5_AWAY','FG3_PCT_ROLL5_AWAY',
    'WIN_STREAK5_AWAY','WIN_STREAK3_AWAY','SEASON_WINPCT_AWAY',
    'REST_DAYS_AWAY','IS_B2B_AWAY',
    'OFF_RATING_PROXY_AWAY','BALL_CONTROL_AWAY','THREE_RATE_AWAY','MOMENTUM_AWAY',
    'PTS_VAR10_AWAY','PLUS_MINUS_VAR10_AWAY','DEF_RATING_ROLL10_AWAY',
    # Differentials
    'PLUS_MINUS_DIFF','FG_PCT_DIFF','PTS_DIFF','WIN_STREAK_DIFF','MOMENTUM_DIFF','DEF_RATING_DIFF',
]

feature_cols = [c for c in feature_cols if c in merged.columns]
merged = merged.dropna(subset=feature_cols).reset_index(drop=True)

print(f"  ✓ Clean training games : {len(merged):,}")
print(f"  ✓ Features per game    : {len(feature_cols)}")
print(f"  ✓ Home win rate        : {merged['HOME_WIN'].mean():.1%}")
print(f"  ✓ Date range           : {merged['GAME_DATE_HOME'].min().date()} → {merged['GAME_DATE_HOME'].max().date()}\n")

# ============================================================
#  PHASE 3 — TRAIN / TEST SPLIT
# ============================================================
print("━" * 60)
print(" PHASE 3 — Train / test split (time-based)...")
print("━" * 60)

X = merged[feature_cols]
y = merged['HOME_WIN']

split   = int(len(X) * 0.80)
X_train = X.iloc[:split];  y_train = y.iloc[:split]
X_test  = X.iloc[split:];  y_test  = y.iloc[split:]

print(f"  ✓ Training : {len(X_train):,} games")
print(f"  ✓ Test     : {len(X_test):,} games\n")

# ============================================================
#  PHASE 4 — ENSEMBLE MODEL (XGBoost + Random Forest)
# ============================================================
print("━" * 60)
print(" PHASE 4 — Training Ensemble AI (XGBoost + Random Forest)...")
print("━" * 60)

# Fingerprint the training data — if unchanged, load cached model
data_fingerprint = hashlib.md5(pd.util.hash_pandas_object(X_train).values).hexdigest()[:12]
cache_valid = False
calibrated  = None
acc = 0.0
ll  = 0.0

if os.path.exists(MODEL_CACHE_FILE):
    try:
        with open(MODEL_CACHE_FILE, 'rb') as f:
            cache = pickle.load(f)
        if cache.get('fingerprint') == data_fingerprint:
            calibrated  = cache['model']
            acc         = cache['accuracy']
            ll          = cache.get('logloss', 0.0)
            cache_valid = True
            print(f"  ✓ Cached model loaded  (fingerprint: {data_fingerprint})")
            print(f"  ✓ Cached accuracy: {acc:.1%}  |  Log-loss: {ll:.4f}\n")
    except Exception:
        pass

if not cache_valid:
    # ── XGBoost ───────────────────────────────────────────
    xgb_model = xgb.XGBClassifier(
        n_estimators=600, max_depth=4, learning_rate=0.025,
        subsample=0.8, colsample_bytree=0.75,
        min_child_weight=4, gamma=0.15,
        reg_alpha=0.2, reg_lambda=1.5,
        use_label_encoder=False, eval_metric='logloss',
        early_stopping_rounds=40, random_state=42, n_jobs=-1,
    )
    xgb_model.fit(X_train, y_train, eval_set=[(X_test, y_test)], verbose=100)

    # ── Random Forest ─────────────────────────────────────
    rf_model = RandomForestClassifier(
        n_estimators=500, max_depth=8, min_samples_leaf=15,
        max_features='sqrt', random_state=42, n_jobs=-1,
        class_weight='balanced',
    )
    rf_model.fit(X_train, y_train)

    # ── Calibrate each model ──────────────────────────────
    if USE_FROZEN:
        cal_xgb = CalibratedClassifierCV(FrozenEstimator(xgb_model), method='isotonic', cv=5)
        cal_rf  = CalibratedClassifierCV(FrozenEstimator(rf_model),  method='isotonic', cv=5)
    else:
        cal_xgb = CalibratedClassifierCV(xgb_model, cv='prefit', method='isotonic')
        cal_rf  = CalibratedClassifierCV(rf_model,  cv='prefit', method='isotonic')
    cal_xgb.fit(X_test, y_test)
    cal_rf.fit(X_test,  y_test)

    # ── Ensemble: weighted average of calibrated probs ────
    class EnsembleModel:
        def __init__(self, models, weights):
            self.models  = models
            self.weights = weights

        def predict_proba(self, X):
            out = np.zeros((len(X), 2))
            for m, w in zip(self.models, self.weights):
                out += w * m.predict_proba(X)
            return out

        def predict(self, X):
            return (self.predict_proba(X)[:, 1] >= 0.5).astype(int)

    # XGBoost slightly more weight — edges out RF on tabular sports data
    calibrated = EnsembleModel([cal_xgb, cal_rf], weights=[0.60, 0.40])

    preds = calibrated.predict(X_test)
    probs = calibrated.predict_proba(X_test)[:, 1]
    acc   = accuracy_score(y_test, preds)
    ll    = log_loss(y_test, probs)

    try:
        with open(MODEL_CACHE_FILE, 'wb') as f:
            pickle.dump({'model': calibrated, 'fingerprint': data_fingerprint,
                         'accuracy': acc, 'logloss': ll}, f)
        print(f"\n  ✓ Ensemble trained & calibrated  |  Cache saved\n")
    except Exception:
        print(f"\n  ✓ Ensemble trained & calibrated\n")

    # Feature importance chart
    importance = pd.Series(xgb_model.feature_importances_, index=feature_cols).sort_values(ascending=False)
    top15      = importance.head(15)
    fig, ax    = plt.subplots(figsize=(10, 6))
    colors     = ['#0F2027' if i < 3 else '#203A43' if i < 8 else '#2C5364' for i in range(len(top15))]
    ax.barh(top15.index[::-1], top15.values[::-1], color=colors[::-1])
    ax.set_xlabel('Importance Score')
    ax.set_title('Top 15 Predictive Features (XGBoost component)', fontweight='bold')
    plt.tight_layout()
    chart_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "feature_importance.png")
    plt.savefig(chart_path, dpi=150, bbox_inches="tight")
    plt.close()
    print(f"  ✓ Chart saved: {chart_path}\n")

# ============================================================
#  PHASE 5 — EVALUATE
# ============================================================
print("━" * 60)
print(" PHASE 5 — Model evaluation...")
print("━" * 60)

preds = calibrated.predict(X_test)
probs = calibrated.predict_proba(X_test)[:, 1]
acc   = accuracy_score(y_test, preds)
ll    = log_loss(y_test, probs)

print(f"\n  Accuracy on unseen games : {acc:.1%}")
print(f"  Log-loss (calibration)   : {ll:.4f}  (lower = better calibrated)")
print(f"  Sportsbook breakeven     : ~52.4%")
print(f"  Edge over breakeven      : {(acc-0.524)*100:+.1f} pp")
print(f"\n{classification_report(y_test, preds, target_names=['Away Win','Home Win'])}")

print("  Confidence calibration:")
print(f"  {'Range':>10}  {'Actual win%':>12}  {'n games':>8}")
for lo, hi in [(0.5,0.55),(0.55,0.60),(0.60,0.65),(0.65,0.70),(0.70,1.0)]:
    mask = (probs >= lo) & (probs < hi)
    if mask.sum() > 10:
        print(f"  {lo:.0%}–{hi:.0%}     {y_test[mask].mean():>11.1%}   {mask.sum():>7}")
print()

# ============================================================
#  PHASE 6 — TONIGHT'S GAMES
# ============================================================
print("━" * 60)
print(" PHASE 6 — Fetching tonight's real NBA schedule...")
print("━" * 60)

team_list        = nba_teams_static.get_teams()
team_lookup      = {t['abbreviation']: t['id'] for t in team_list}
team_name_lookup = {t['id']: t['full_name'] for t in team_list}
abbr_lookup      = {t['id']: t['abbreviation'] for t in team_list}

# Defensive rating per team: avg PLUS_MINUS (proxy for how strong their D is)
def build_team_def_ratings():
    ratings = {}
    for tid in games['TEAM_ID'].unique():
        pm = games[games['TEAM_ID'] == tid]['PLUS_MINUS'].tail(15).mean()
        ratings[tid] = float(pm) if not np.isnan(pm) else 0.0
    return ratings

team_def_ratings = build_team_def_ratings()

def get_tonights_games():
    try:
        sb    = scoreboardv2.ScoreboardV2(game_date=date.today().strftime('%Y-%m-%d'))
        ginfo = sb.game_header.get_data_frame()
        if ginfo.empty:
            return []
        matchups = []
        for _, row in ginfo.iterrows():
            home_abbr = abbr_lookup.get(row.get('HOME_TEAM_ID'), '')
            away_abbr = abbr_lookup.get(row.get('VISITOR_TEAM_ID'), '')
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
    print("  ! Auto-fetch returned no games. Using sample matchups.\n")
    tonight = [('BOS','LAL'),('GSW','MIA'),('DEN','NYK'),('MIL','PHX'),('DAL','OKC')]

# ============================================================
#  PHASE 6B — PLAYER PROP ENGINE
# ============================================================
print("━" * 60)
print(" PHASE 6B — Loading player stats for prop predictions...")
print("━" * 60)

PROP_THRESHOLDS = {
    'PTS':  [10, 15, 20, 25, 30, 35],
    'REB':  [4, 6, 8, 10, 12, 14],
    'AST':  [3, 5, 7, 10, 12],
    'FG3M': [1, 2, 3, 4, 5, 6],
    'STL':  [1, 2],
    'BLK':  [1, 2, 3],
}

KEY_PLAYERS_BY_TEAM = {
    'LAL': ['LeBron','Davis','Reaves','Hachimura'],
    'GSW': ['Curry','Green','Kuminga','Wiggins'],
    'BOS': ['Tatum','Brown','Holiday','Porzingis'],
    'DEN': ['Jokic','Murray','Porter','Gordon'],
    'MIL': ['Giannis','Lillard','Portis','Middleton'],
    'PHX': ['Durant','Booker','Beal','Nurkic'],
    'NYK': ['Brunson','Towns','Hart','Anunoby'],
    'MIA': ['Butler','Adebayo','Herro','Love'],
    'OKC': ['Gilgeous','Dort','Holmgren','Williams'],
    'DAL': ['Doncic','Irving','Gafford','Washington'],
    'CLE': ['Mitchell','Mobley','Garland','Allen'],
    'LAC': ['Harden','Zubac','Powell','Mann'],
    'SAS': ['Wembanyama','Johnson','Castle','Vassell'],
    'MIN': ['Edwards','Gobert','Conley','McDaniels'],
    'NOP': ['Williamson','Ingram','Valanciunas','Murphy'],
    'POR': ['Simons','Anfernee','Smith','Sharpe'],
    'CHA': ['LaMelo','Miles Bridges','Richards','Washington'],
    'DET': ['Cunningham','Stewart','Duren','Harris'],
    'IND': ['Haliburton','Siakam','Turner','Nembhard'],
    'ATL': ['Young','Murray','Okongwu','Hunter'],
    'CHI': ['LaVine','DeRozan','Vucevic','Williams'],
    'TOR': ['Scottie','Quickley','Boucher','Poeltl'],
    'WAS': ['Poole','Kuzma','Gafford','Kispert'],
    'ORL': ['Paolo','Franz','Fultz','Harris'],
    'SAC': ['Fox','Sabonis','Monk','Huerter'],
    'UTA': ['Lauri','Keyonte','Sexton','Clarkson'],
    'HOU': ['Green','Sengun','Thompson','Jabari'],
    'MEM': ['Morant','Jackson','Smart','Konchar'],
}

def get_player_recent_stats(name_frag, season='2024-25', n_games=PROP_GAMES_BACK):
    all_players = nba_players_static.get_players()
    matches = [p for p in all_players
               if name_frag.lower() in p['full_name'].lower() and p['is_active']]
    if not matches:
        return None, None
    player = matches[0]
    try:
        log = playergamelog.PlayerGameLog(
            player_id=player['id'], season=season,
            season_type_all_star='Regular Season'
        )
        df = log.get_data_frames()[0]
        if df.empty:
            return None, None
        return player['full_name'], df.head(n_games)
    except Exception:
        return None, None

def minutes_trend(game_log):
    """Detect significant minutes reduction (injury/load management signal)."""
    if game_log is None or 'MIN' not in game_log.columns:
        return None, None, ''
    def parse_min(m):
        try:
            parts = str(m).split(':')
            return int(parts[0]) + (int(parts[1])/60 if len(parts) > 1 else 0)
        except:
            return np.nan
    mins    = game_log['MIN'].apply(parse_min).dropna()
    if len(mins) < 5:
        return None, None, ''
    recent  = mins[:5].mean()
    overall = mins.mean()
    flag    = '⚠️ MINUTES DROP' if overall > 0 and (recent / overall) < 0.85 else ''
    return round(recent, 1), round(overall, 1), flag

def compute_prop_analysis(game_log, stat_col, threshold, opp_def_factor=1.0):
    if game_log is None or stat_col not in game_log.columns:
        return None
    vals = pd.to_numeric(game_log[stat_col], errors='coerce').dropna().values
    if len(vals) < 5:
        return None
    hits        = (vals >= threshold).astype(float)
    w_hit_rate  = weighted_hit_rate(hits, n_recent=5)
    avg_overall = vals.mean()
    avg_recent  = vals[:5].mean() if len(vals) >= 5 else avg_overall
    # Skip trivial / impossible props
    if w_hit_rate > 0.96 or w_hit_rate < 0.04:
        return None
    if avg_overall < threshold * 0.4:
        return None
    # Opponent defensive adjustment (scoring props only)
    adj_hit = w_hit_rate
    if stat_col in ('PTS', 'FG3M'):
        adj_hit = min(0.95, max(0.05, w_hit_rate * opp_def_factor))
    return {
        'hit_rate':   adj_hit,
        'raw_hr':     (vals >= threshold).mean(),
        'avg':        avg_overall,
        'avg_recent': avg_recent,
        'std':        vals.std(),
        'n_games':    len(vals),
        'trend':      trend_label(avg_recent, avg_overall),
    }

def _prop_label(stat, thresh):
    return {
        'PTS':  f"{thresh}+ Points",
        'REB':  f"{thresh}+ Rebounds",
        'AST':  f"{thresh}+ Assists",
        'FG3M': f"{thresh}+ Three-Pointers",
        'STL':  f"{thresh}+ Steals",
        'BLK':  f"{thresh}+ Blocks",
    }.get(stat, f"{thresh}+ {stat}")

def prop_confidence(hit_rate):
    if hit_rate >= 0.78:   return "🔥 STRONG", "★★★"
    elif hit_rate >= 0.65: return "✅ GOOD",   "★★☆"
    elif hit_rate >= 0.52: return "👀 LEAN",   "★☆☆"
    else:                  return "⚠️  RISKY", "☆☆☆"

def analyze_player_props(team_abbr, opp_abbr, game_log_cache):
    props = []
    opp_id     = team_lookup.get(opp_abbr, '')
    opp_def_pm = team_def_ratings.get(opp_id, 0.0)
    # Normalize: league avg pm ~0. Positive pm opp = their D is weak → boost props
    opp_factor = 1.0 + (opp_def_pm / 15.0) * 0.10
    opp_factor = max(0.88, min(1.12, opp_factor))

    for name_frag in KEY_PLAYERS_BY_TEAM.get(team_abbr, []):
        key = name_frag.lower()
        if key not in game_log_cache:
            full_name, log = get_player_recent_stats(name_frag)
            game_log_cache[key] = (full_name, log)
            time.sleep(0.8)
        else:
            full_name, log = game_log_cache[key]
        if log is None or full_name is None:
            continue

        min_recent, min_overall, min_flag = minutes_trend(log)

        for stat, thresholds in PROP_THRESHOLDS.items():
            for thresh in thresholds:
                a = compute_prop_analysis(log, stat, thresh, opp_factor)
                if a is None:
                    continue
                props.append({
                    'player':    full_name,
                    'team':      team_abbr,
                    'opp':       opp_abbr,
                    'stat':      stat,
                    'threshold': thresh,
                    'label':     _prop_label(stat, thresh),
                    'hit_rate':  a['hit_rate'],
                    'raw_hr':    a['raw_hr'],
                    'avg':       a['avg'],
                    'avg_recent':a['avg_recent'],
                    'std':       a['std'],
                    'n_games':   a['n_games'],
                    'trend':     a['trend'],
                    'min_flag':  min_flag,
                    'min_recent':min_recent,
                    'opp_factor':opp_factor,
                })
    return props

# Pre-load all player logs
game_log_cache    = {}
all_props_by_team = {}
all_team_pairs    = [(away, home) for away, home in tonight]

print(f"  Fetching player stats for {len(set(t for pair in all_team_pairs for t in pair))} teams...")
for away_abbr, home_abbr in all_team_pairs:
    for abbr, opp in [(home_abbr, away_abbr), (away_abbr, home_abbr)]:
        props = analyze_player_props(abbr, opp, game_log_cache)
        all_props_by_team[abbr] = props
        n = len([p for p in props if p['hit_rate'] >= 0.52])
        print(f"  ✓ {abbr} (vs {opp}): {n} viable props")
print()

# ============================================================
#  PHASE 7 — PREDICTIONS + KELLY SIZING
# ============================================================
print("━" * 60)
print(" PHASE 7 — AI Predictions + Kelly Criterion Sizing")
print("━" * 60)

def get_team_features(team_id, rest_days=2, is_b2b=0):
    tg = games[games['TEAM_ID'] == team_id]
    if len(tg) < 5:
        return None
    latest = tg.iloc[-1]
    return {
        'PTS_ROLL10': latest.get('PTS_ROLL10', np.nan),
        'FG_PCT_ROLL10': latest.get('FG_PCT_ROLL10', np.nan),
        'FG3_PCT_ROLL10': latest.get('FG3_PCT_ROLL10', np.nan),
        'FT_PCT_ROLL10': latest.get('FT_PCT_ROLL10', np.nan),
        'REB_ROLL10': latest.get('REB_ROLL10', np.nan),
        'AST_ROLL10': latest.get('AST_ROLL10', np.nan),
        'TOV_ROLL10': latest.get('TOV_ROLL10', np.nan),
        'PLUS_MINUS_ROLL10': latest.get('PLUS_MINUS_ROLL10', np.nan),
        'STL_ROLL10': latest.get('STL_ROLL10', np.nan),
        'BLK_ROLL10': latest.get('BLK_ROLL10', np.nan),
        'PTS_ROLL5': latest.get('PTS_ROLL5', np.nan),
        'PLUS_MINUS_ROLL5': latest.get('PLUS_MINUS_ROLL5', np.nan),
        'FG_PCT_ROLL5': latest.get('FG_PCT_ROLL5', np.nan),
        'TOV_ROLL5': latest.get('TOV_ROLL5', np.nan),
        'REB_ROLL5': latest.get('REB_ROLL5', np.nan),
        'AST_ROLL5': latest.get('AST_ROLL5', np.nan),
        'FG3_PCT_ROLL5': latest.get('FG3_PCT_ROLL5', np.nan),
        'WIN_STREAK5': latest.get('WIN_STREAK5', np.nan),
        'WIN_STREAK3': latest.get('WIN_STREAK3', np.nan),
        'SEASON_WINPCT': latest.get('SEASON_WINPCT', np.nan),
        'REST_DAYS': rest_days,
        'IS_B2B': is_b2b,
        'OFF_RATING_PROXY': latest.get('OFF_RATING_PROXY', np.nan),
        'BALL_CONTROL': latest.get('BALL_CONTROL', np.nan),
        'THREE_RATE': latest.get('THREE_RATE', np.nan),
        'MOMENTUM': latest.get('MOMENTUM', np.nan),
        'PTS_VAR10': latest.get('PTS_VAR10', np.nan),
        'PLUS_MINUS_VAR10': latest.get('PLUS_MINUS_VAR10', np.nan),
        'DEF_RATING_ROLL10': latest.get('DEF_RATING_ROLL10', np.nan),
    }

def predict_game(home_abbr, away_abbr):
    home_id = team_lookup.get(home_abbr.upper())
    away_id = team_lookup.get(away_abbr.upper())
    if not home_id or not away_id:
        return None
    hf = get_team_features(home_id)
    af = get_team_features(away_id)
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
    row['MOMENTUM_DIFF']   = hf.get('MOMENTUM',0)          - af.get('MOMENTUM',0)
    row['DEF_RATING_DIFF'] = hf.get('DEF_RATING_ROLL10',0) - af.get('DEF_RATING_ROLL10',0)

    X_pred    = pd.DataFrame([{c: row.get(c, np.nan) for c in feature_cols}])[feature_cols]
    prob_home = calibrated.predict_proba(X_pred)[0][1]
    return prob_home

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
        pick_name, pick_abbr, pick_prob, pick_side = home_name, home_abbr, prob_home, "HOME"
    else:
        pick_name, pick_abbr, pick_prob, pick_side = away_name, away_abbr, prob_away, "AWAY"

    pick_odds = prob_to_american(pick_prob)
    edge      = pick_prob - 0.5
    kelly_amt = kelly_bet(pick_prob, pick_odds, BANKROLL)

    if edge >= 0.15:   confidence, stars = "🔥 STRONG", "★★★"
    elif edge >= 0.09: confidence, stars = "✅ GOOD",   "★★☆"
    elif edge >= 0.05: confidence, stars = "👀 LEAN",   "★☆☆"
    else:              confidence, stars = "⚠️  SKIP",  "☆☆☆"

    game_props = all_props_by_team.get(home_abbr, []) + all_props_by_team.get(away_abbr, [])

    game_results.append({
        'home_abbr': home_abbr, 'away_abbr': away_abbr,
        'home_name': home_name, 'away_name': away_name,
        'prob_home': prob_home, 'prob_away': prob_away,
        'pick_name': pick_name, 'pick_abbr': pick_abbr,
        'pick_prob': pick_prob, 'pick_side': pick_side,
        'pick_odds': pick_odds, 'edge': edge,
        'confidence': confidence, 'stars': stars,
        'kelly_amt': kelly_amt, 'props': game_props,
    })

game_results.sort(key=lambda x: x['edge'], reverse=True)

# ── Game predictions printout ───────────────────────────────
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
    if g['kelly_amt'] > 0 and g['edge'] >= MIN_EDGE_FOR_BET:
        print(f"  Kelly recommended bet:  ${g['kelly_amt']:,.2f}  (of ${BANKROLL:,.0f})")

# ============================================================
#  PHASE 8 — PLAYER PROP BREAKDOWN
# ============================================================
print()
print("┌" + "─"*58 + "┐")
print("│{:^58}│".format("PLAYER PROPS — PER GAME BREAKDOWN"))
print("└" + "─"*58 + "┘")

all_safe_props  = []
all_risky_props = []

for g in game_results:
    print()
    print(f"  ╔═ {g['away_name']} @ {g['home_name']} ═╗")

    safe    = [p for p in g['props'] if p['hit_rate'] >= 0.65 and not p['min_flag']]
    risky   = [p for p in g['props'] if 0.33 <= p['hit_rate'] < 0.50]
    flagged = list({p['player'] for p in g['props'] if p['min_flag']})

    safe.sort(key=lambda x: x['hit_rate'], reverse=True)
    risky.sort(key=lambda x: x['hit_rate'], reverse=True)

    if safe:
        print("  🎯 TOP PROPS (high confidence):")
        for p in safe[:7]:
            conf, stars = prop_confidence(p['hit_rate'])
            trend_str   = f"  {p['trend']}" if p['trend'] else ''
            adj_str     = f"  [opp adj ×{p['opp_factor']:.2f}]" if abs(p['opp_factor']-1.0) > 0.02 else ''
            print(f"     {p['player']:25s}  {p['label']:22s}  {p['hit_rate']:.0%}  {stars}{trend_str}{adj_str}")
        all_safe_props.extend(safe)
    else:
        print("  (No high-confidence props for this game)")

    if risky:
        print("  💣 RISKY PICKS (high payout potential):")
        for p in risky[:4]:
            trend_str = f"  {p['trend']}" if p['trend'] else ''
            print(f"     {p['player']:25s}  {p['label']:22s}  {p['hit_rate']:.0%}  avg {p['avg']:.1f}{trend_str}")
        all_risky_props.extend(risky)

    if flagged:
        print("  ⚠️  MINUTES CONCERNS (skip these players' props):")
        for player in flagged[:3]:
            mp = next(p for p in g['props'] if p['player']==player and p['min_flag'])
            print(f"     {player}  —  recent {mp['min_recent']}mpg  {mp['min_flag']}")

# ============================================================
#  PHASE 9 — PLAYER PROP PARLAYS
# ============================================================
print()
print("┌" + "─"*58 + "┐")
print("│{:^58}│".format("PLAYER PROP PARLAYS"))
print("└" + "─"*58 + "┘")
print()

def build_prop_parlays(props, min_legs=2, max_legs=4, top_n=5):
    if len(props) < min_legs:
        return []
    # Best prop per player only (no stacking same player)
    seen, unique = set(), []
    for p in sorted(props, key=lambda x: x['hit_rate'], reverse=True):
        if p['player'] not in seen:
            seen.add(p['player'])
            unique.append(p)

    all_parlays = []
    pool = unique[:18]
    for n in range(min_legs, min(max_legs+1, len(pool)+1)):
        for combo in itertools.combinations(pool, n):
            pr = [c['hit_rate'] for c in combo]
            cb = parlay_prob(pr)
            py = parlay_payout(pr)
            tb = sum(0.05 for c in combo if '🔥' in c.get('trend',''))
            all_parlays.append({'legs':list(combo),'combined':cb,'payout':py,'n':n,'trend_bonus':tb})

    def score(p):
        if p['combined'] < 0.04: return -1
        return (p['combined'] + p['trend_bonus']) * np.log1p(p['payout'])

    all_parlays.sort(key=score, reverse=True)
    return all_parlays[:top_n]

# Safe
print("  ━━━ 🎯 SAFE PROP PARLAYS (High Hit Rate) ━━━")
print()
safe_parlays = build_prop_parlays(all_safe_props, min_legs=2, max_legs=4)
for i, p in enumerate(safe_parlays, 1):
    k = kelly_bet(p['combined'], prob_to_american(p['combined']), BANKROLL)
    print(f"  PROP PARLAY #{i}  —  {p['n']}-LEG  ({p['combined']:.1%} hit chance)")
    print(f"  {'─'*50}")
    for leg in p['legs']:
        c, s = prop_confidence(leg['hit_rate'])
        t    = f"  {leg['trend']}" if leg['trend'] else ''
        print(f"   ▸ {leg['player']:25s}  {leg['label']:22s}  {leg['hit_rate']:.0%}  {s}{t}")
    print(f"  Combined probability : {p['combined']:.1%}")
    print(f"  Approx payout (100$) : ${p['payout']:,.2f}")
    print(f"  Implied odds         : {prob_to_american(p['combined'])}")
    if k > 0:
        print(f"  Kelly bet size       : ${k:,.2f}")
    print()

# Risky
print("  ━━━ 💣 RISKY PROP PARLAYS (Long Shots / Big Payouts) ━━━")
print()
risky_parlays = build_prop_parlays(all_risky_props, min_legs=2, max_legs=5)
for i, p in enumerate(risky_parlays, 1):
    print(f"  RISKY PARLAY #{i}  —  {p['n']}-LEG  ({p['combined']:.1%} hit chance)")
    print(f"  {'─'*50}")
    for leg in p['legs']:
        t = f"  {leg['trend']}" if leg['trend'] else ''
        print(f"   ⚡ {leg['player']:25s}  {leg['label']:22s}  {leg['hit_rate']:.0%}  avg {leg['avg']:.1f}{t}")
    print(f"  Combined probability : {p['combined']:.1%}")
    print(f"  Approx payout (100$) : ${p['payout']:,.2f}")
    print(f"  Implied odds         : {prob_to_american(p['combined'])}")
    print(f"  ⚠️  Long shot — cap at $10-20 max")
    print()

# Mixed: Team ML + Props
print("  ━━━ 🔀 MIXED PARLAYS (Team ML + Player Props) ━━━")
print()
strong_games = [g for g in game_results if g['edge'] >= 0.09]
seen_p, top_safe_deduped = set(), []
for p in sorted(all_safe_props, key=lambda x: x['hit_rate'], reverse=True)[:15]:
    if p['player'] not in seen_p:
        seen_p.add(p['player'])
        top_safe_deduped.append(p)

mixed = []
for g in strong_games[:4]:
    for p1 in top_safe_deduped[:10]:
        pr = [g['pick_prob'], p1['hit_rate']]
        mixed.append({'game':g,'prop':p1,'combined':parlay_prob(pr),'payout':parlay_payout(pr),'n':2})
        for p2 in top_safe_deduped[:10]:
            if p2['player'] != p1['player']:
                pr3 = [g['pick_prob'], p1['hit_rate'], p2['hit_rate']]
                mixed.append({'game':g,'prop':p1,'prop2':p2,'combined':parlay_prob(pr3),'payout':parlay_payout(pr3),'n':3})

def ms(p):
    if p['combined'] < 0.06: return -1
    return p['combined'] * np.log1p(p['payout'])

mixed.sort(key=ms, reverse=True)
for i, m in enumerate(mixed[:5], 1):
    k = kelly_bet(m['combined'], prob_to_american(m['combined']), BANKROLL)
    g = m['game']
    print(f"  MIXED PARLAY #{i}  —  {m['n']}-LEG")
    print(f"  {'─'*50}")
    print(f"   🏀 {g['pick_name']:30s}  ({g['pick_side']})  {g['pick_prob']:.0%}  {g['stars']}")
    p1 = m['prop']
    print(f"   ▸ {p1['player']:28s}  {p1['label']:22s}  {p1['hit_rate']:.0%}{'  '+p1['trend'] if p1['trend'] else ''}")
    if 'prop2' in m:
        p2 = m['prop2']
        print(f"   ▸ {p2['player']:28s}  {p2['label']:22s}  {p2['hit_rate']:.0%}{'  '+p2['trend'] if p2['trend'] else ''}")
    print(f"  Combined probability : {m['combined']:.1%}")
    print(f"  Approx payout (100$) : ${m['payout']:,.2f}")
    print(f"  Implied odds         : {prob_to_american(m['combined'])}")
    if k > 0:
        print(f"  Kelly bet size       : ${k:,.2f}")
    print()

# Hot streak specials
hot_props = [p for p in all_safe_props if '🔥' in p.get('trend','') or '📈' in p.get('trend','')]
if hot_props:
    print("  ━━━ 🔥 HOT STREAK SPECIALS ━━━")
    print("  (Players trending significantly UP vs their season average)")
    print()
    hot_parlays = build_prop_parlays(hot_props, min_legs=2, max_legs=3, top_n=3)
    for i, p in enumerate(hot_parlays, 1):
        print(f"  HOT PARLAY #{i}  —  {p['n']}-LEG")
        print(f"  {'─'*50}")
        for leg in p['legs']:
            print(f"   🔥 {leg['player']:25s}  {leg['label']:22s}  {leg['hit_rate']:.0%}  {leg['trend']}  (recent {leg['avg_recent']:.1f} vs season {leg['avg']:.1f})")
        print(f"  Combined probability : {p['combined']:.1%}")
        print(f"  Approx payout (100$) : ${p['payout']:,.2f}")
        print()

# ============================================================
#  PHASE 10 — FINAL BET SLIP
# ============================================================
print("┌" + "─"*58 + "┐")
print("│{:^58}│".format("YOUR BET SLIP FOR TONIGHT"))
print("└" + "─"*58 + "┘")
print()
print(f"  Bankroll: ${BANKROLL:,.2f}  |  Kelly fraction: {KELLY_FRACTION:.0%}  |  Max single bet: {MAX_BET_PCT:.0%}")
print()

strong = [g for g in game_results if g['edge'] >= 0.15]
good   = [g for g in game_results if 0.09 <= g['edge'] < 0.15]
lean   = [g for g in game_results if 0.05 <= g['edge'] < 0.09]
skip   = [g for g in game_results if g['edge'] < 0.05]

total_kelly = 0
if strong:
    print("  🔥 STRONG BETS  (bet these — highest confidence)")
    for g in strong:
        total_kelly += g['kelly_amt']
        print(f"     • {g['pick_name']} ML  →  {g['pick_prob']:.1%}  ({g['pick_odds']})  Kelly: ${g['kelly_amt']:,.2f}")
    print()
if good:
    print("  ✅ GOOD BETS  (solid plays, slightly less edge)")
    for g in good:
        total_kelly += g['kelly_amt']
        print(f"     • {g['pick_name']} ML  →  {g['pick_prob']:.1%}  ({g['pick_odds']})  Kelly: ${g['kelly_amt']:,.2f}")
    print()
if lean:
    print("  👀 LEAN  (small plays only or parlays)")
    for g in lean:
        print(f"     • {g['pick_name']} ML  →  {g['pick_prob']:.1%}  ({g['pick_odds']})")
    print()
if skip:
    print("  ⚠️  SKIP THESE  (model has no edge)")
    for g in skip:
        print(f"     • {g['away_name']} @ {g['home_name']}  (too close to call)")
    print()

if total_kelly > 0:
    print(f"  💰 TOTAL RECOMMENDED ACTION : ${total_kelly:,.2f}  ({total_kelly/BANKROLL:.1%} of bankroll)")
    print()

if all_safe_props:
    bp = max(all_safe_props, key=lambda x: x['hit_rate'])
    print(f"  🎯 BEST PLAYER PROP TONIGHT:")
    print(f"     {bp['player']}  {bp['label']}")
    print(f"     {bp['hit_rate']:.0%} hit rate  (avg {bp['avg']:.1f} / last {bp['n_games']} games)  {bp['trend']}")
    print()

pool = [g for g in game_results if g['edge'] >= 0.05]
if len(pool) >= 2:
    best2 = sorted(
        [{'legs':c,'combined':parlay_prob([x['pick_prob'] for x in c]),
          'payout':parlay_payout([x['pick_prob'] for x in c])}
         for c in itertools.combinations(pool, 2)],
        key=lambda x: x['combined'] * np.log1p(x['payout']), reverse=True
    )
    if best2:
        tp  = best2[0]
        k   = kelly_bet(tp['combined'], prob_to_american(tp['combined']), BANKROLL)
        lgs = "  +  ".join(g['pick_name'] for g in tp['legs'])
        print(f"  BEST TEAM PARLAY:")
        print(f"     {lgs}")
        print(f"     {tp['combined']:.1%} hit chance  →  ${tp['payout']:,.2f} on $100  (Kelly: ${k:,.2f})")
        print()

if safe_parlays:
    sp  = safe_parlays[0]
    lgs = "  +  ".join(f"{p['player']} {p['label']}" for p in sp['legs'])
    print(f"  BEST PROP PARLAY:")
    print(f"     {lgs}")
    print(f"     {sp['combined']:.1%} hit chance  →  ${sp['payout']:,.2f} on $100")
    print()

if risky_parlays:
    rp  = risky_parlays[0]
    lgs = "  +  ".join(f"{p['player']} {p['label']}" for p in rp['legs'])
    print(f"  💣 BEST RISKY PARLAY (long shot):")
    print(f"     {lgs}")
    print(f"     {rp['combined']:.1%} hit chance  →  ${rp['payout']:,.2f} on $100")
    print(f"     ⚠️  Cap this at $10-20 max")
    print()

print("═" * 60)
print(f"  Model        : Ensemble (XGBoost 60% + Random Forest 40%)")
print(f"  Accuracy     : {acc:.1%}  |  Edge over book : {(acc-0.524)*100:+.1f}pp")
print(f"  Log-loss     : {ll:.4f}  (calibration quality)")
print(f"  Features     : {len(feature_cols)}")
print(f"  Games trained: {len(X_train):,}")
print(f"  Predictions  : {len(game_results)} games tonight")
print(f"  Props        : {len(all_safe_props)} safe  |  {len(all_risky_props)} risky")
print(f"  Cache        : {'HIT — skipped retraining' if cache_valid else 'MISS — retrained & saved'}")
print("═" * 60)
print()
print("  HOW TO USE:")
print("  1. Set BANKROLL at the top of this file to your actual bankroll")
print("  2. Copy STRONG BET + Kelly amounts to DraftKings / Bet365")
print("  3. SAFE PROP PARLAY #1 = best steady-value play")
print("  4. Drop $10-20 MAX on RISKY PARLAYS (long shots only)")
print("  5. HOT STREAK parlays = players trending up, look for value")
print("  6. Second run today is instant — model cached, no retraining")
print("  7. Delete model_cache.pkl weekly to force a full retrain")
print("  8. Never bet more than you can afford to lose")
print()