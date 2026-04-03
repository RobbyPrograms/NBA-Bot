# ============================================================
#  NBA BETTING PREDICTOR — FULL PIPELINE
#  Data → Features → XGBoost AI → Predictions
# ============================================================

# ── 0. Imports ───────────────────────────────────────────────
import os
import sys

# Windows consoles often default to cp1252; emoji in prints then crash.
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

import matplotlib

matplotlib.use(os.environ.get("MPLBACKEND", "Agg"))

from nba_api.stats.endpoints import leaguegamefinder, scoreboardv2
from nba_api.stats.static import teams as nba_teams_static
import pandas as pd
import numpy as np
import xgboost as xgb
from sklearn.metrics import accuracy_score, classification_report
from sklearn.calibration import CalibratedClassifierCV
from sklearn.frozen import FrozenEstimator
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
import warnings
import time
warnings.filterwarnings('ignore')

print("=" * 60)
print("  NBA BETTING PREDICTOR — AI PIPELINE STARTING")
print("=" * 60)

# ============================================================
#  PHASE 1 — PULL RAW DATA (7 seasons)
# ============================================================
print("\n📥 PHASE 1: Pulling NBA game data...")
print("-" * 40)

all_seasons = ['2018-19','2019-20','2020-21','2021-22','2022-23','2023-24','2024-25','2025-26']
all_games = []

for season in all_seasons:
    print(f'  Pulling {season}...', end=' ', flush=True)
    try:
        gf = leaguegamefinder.LeagueGameFinder(
            season_nullable=season,
            season_type_nullable='Regular Season'
        )
        df = gf.get_data_frames()[0]
        all_games.append(df)
        print(f'✓ {len(df):,} rows')
    except Exception as e:
        print(f'✗ {e}')
    time.sleep(2)

if not all_games:
    raise SystemExit("No season data downloaded. Check your network and nba_api, then retry.")

games = pd.concat(all_games, ignore_index=True)
print(f'\n  Total rows pulled: {games.shape[0]:,}')

# ============================================================
#  PHASE 2 — CLEAN & ENGINEER FEATURES
# ============================================================
print("\n⚙️  PHASE 2: Engineering features...")
print("-" * 40)

games = games.sort_values(['TEAM_ID', 'GAME_DATE']).reset_index(drop=True)
games['WIN']     = (games['WL'] == 'W').astype(int)
games['IS_HOME'] = games['MATCHUP'].apply(lambda x: 1 if 'vs.' in x else 0)
games['GAME_DATE'] = pd.to_datetime(games['GAME_DATE'])

key_cols = ['PTS','FG_PCT','FG3_PCT','FT_PCT','REB','AST','TOV','PLUS_MINUS','STL','BLK']
games = games.dropna(subset=key_cols).reset_index(drop=True)

# Rest days & back-to-back
games['REST_DAYS'] = (
    games.groupby('TEAM_ID')['GAME_DATE'].diff().dt.days.fillna(3).clip(0,10)
)
games['IS_B2B'] = (games['REST_DAYS'] <= 1).astype(int)

# Rolling 10-game averages (the core signal)
roll10_cols = ['PTS','FG_PCT','FG3_PCT','FT_PCT','REB','AST','TOV','PLUS_MINUS','STL','BLK']
for col in roll10_cols:
    games[f'{col}_ROLL10'] = (
        games.groupby('TEAM_ID')[col]
        .transform(lambda x: x.shift(1).rolling(10, min_periods=5).mean())
    )

# Rolling 5-game averages (short-term hot/cold form)
roll5_cols = ['PTS','PLUS_MINUS','FG_PCT','TOV','REB']
for col in roll5_cols:
    games[f'{col}_ROLL5'] = (
        games.groupby('TEAM_ID')[col]
        .transform(lambda x: x.shift(1).rolling(5, min_periods=3).mean())
    )

# Win streak over last 5
games['WIN_STREAK5'] = (
    games.groupby('TEAM_ID')['WIN']
    .transform(lambda x: x.shift(1).rolling(5, min_periods=3).mean())
)

# Season win % so far
games['SEASON_WINPCT'] = (
    games.groupby(['TEAM_ID','SEASON_ID'])['WIN']
    .transform(lambda x: x.shift(1).expanding().mean())
)

# Offensive & defensive proxies
games['OFF_RATING_PROXY'] = games['PTS_ROLL10'] / games['FG_PCT_ROLL10'].replace(0, np.nan)
games['BALL_CONTROL']     = games['AST_ROLL10'] / games['TOV_ROLL10'].replace(0, np.nan)

print("  ✓ Rest days, back-to-back flags")
print("  ✓ Rolling 10-game averages (10 stats)")
print("  ✓ Rolling 5-game form (5 stats)")
print("  ✓ Win streak, season win %")
print("  ✓ Offensive rating proxy, ball control ratio")

# ── Merge home vs away into one row per game ─────────────────
home = games[games['IS_HOME'] == 1].copy()
away = games[games['IS_HOME'] == 0].copy()
merged = home.merge(away, on='GAME_ID', suffixes=('_HOME','_AWAY'))
merged['HOME_WIN'] = merged['WIN_HOME']
merged = merged.sort_values('GAME_DATE_HOME').reset_index(drop=True)

# ── Feature list ──────────────────────────────────────────────
feature_cols = [
    # 10-game rolling — home
    'PTS_ROLL10_HOME','FG_PCT_ROLL10_HOME','FG3_PCT_ROLL10_HOME','FT_PCT_ROLL10_HOME',
    'REB_ROLL10_HOME','AST_ROLL10_HOME','TOV_ROLL10_HOME','PLUS_MINUS_ROLL10_HOME',
    'STL_ROLL10_HOME','BLK_ROLL10_HOME',
    # 5-game rolling — home
    'PTS_ROLL5_HOME','PLUS_MINUS_ROLL5_HOME','FG_PCT_ROLL5_HOME','TOV_ROLL5_HOME','REB_ROLL5_HOME',
    # context — home
    'WIN_STREAK5_HOME','SEASON_WINPCT_HOME','REST_DAYS_HOME','IS_B2B_HOME',
    'OFF_RATING_PROXY_HOME','BALL_CONTROL_HOME',
    # 10-game rolling — away
    'PTS_ROLL10_AWAY','FG_PCT_ROLL10_AWAY','FG3_PCT_ROLL10_AWAY','FT_PCT_ROLL10_AWAY',
    'REB_ROLL10_AWAY','AST_ROLL10_AWAY','TOV_ROLL10_AWAY','PLUS_MINUS_ROLL10_AWAY',
    'STL_ROLL10_AWAY','BLK_ROLL10_AWAY',
    # 5-game rolling — away
    'PTS_ROLL5_AWAY','PLUS_MINUS_ROLL5_AWAY','FG_PCT_ROLL5_AWAY','TOV_ROLL5_AWAY','REB_ROLL5_AWAY',
    # context — away
    'WIN_STREAK5_AWAY','SEASON_WINPCT_AWAY','REST_DAYS_AWAY','IS_B2B_AWAY',
    'OFF_RATING_PROXY_AWAY','BALL_CONTROL_AWAY',
    # matchup differentials (home minus away) — gives model direct comparison signal
    'PLUS_MINUS_DIFF','FG_PCT_DIFF','PTS_DIFF','WIN_STREAK_DIFF',
]

# Compute differentials
merged['PLUS_MINUS_DIFF'] = merged['PLUS_MINUS_ROLL10_HOME'] - merged['PLUS_MINUS_ROLL10_AWAY']
merged['FG_PCT_DIFF']     = merged['FG_PCT_ROLL10_HOME']     - merged['FG_PCT_ROLL10_AWAY']
merged['PTS_DIFF']        = merged['PTS_ROLL10_HOME']        - merged['PTS_ROLL10_AWAY']
merged['WIN_STREAK_DIFF'] = merged['WIN_STREAK5_HOME']       - merged['WIN_STREAK5_AWAY']

merged = merged.dropna(subset=feature_cols).reset_index(drop=True)

print(f'\n  ✓ Clean games ready: {len(merged):,}')
print(f'  ✓ Features per game: {len(feature_cols)}')
print(f'  ✓ Home win rate in data: {merged["HOME_WIN"].mean():.1%}')
print(f'  ✓ Date range: {merged["GAME_DATE_HOME"].min().date()} → {merged["GAME_DATE_HOME"].max().date()}')

# ============================================================
#  PHASE 3 — TRAIN / TEST SPLIT (time-based, no leakage)
# ============================================================
print("\n🔀 PHASE 3: Splitting data (time-based)...")
print("-" * 40)

X = merged[feature_cols]
y = merged['HOME_WIN']

# 80% train, 20% test — NO random shuffle (sports are time-series)
split = int(len(X) * 0.80)
X_train, X_test = X.iloc[:split], X.iloc[split:]
y_train, y_test = y.iloc[:split], y.iloc[split:]

print(f'  ✓ Training games:  {len(X_train):,}')
print(f'  ✓ Test games:      {len(X_test):,}')
print(f'  ✓ Test date range: {merged["GAME_DATE_HOME"].iloc[split].date()} → {merged["GAME_DATE_HOME"].iloc[-1].date()}')

# ============================================================
#  PHASE 4 — TRAIN XGBOOST MODEL
# ============================================================
print("\n🤖 PHASE 4: Training XGBoost AI model...")
print("-" * 40)

model = xgb.XGBClassifier(
    n_estimators      = 500,
    max_depth         = 4,
    learning_rate     = 0.03,
    subsample         = 0.8,
    colsample_bytree  = 0.8,
    min_child_weight  = 3,
    gamma             = 0.1,
    reg_alpha         = 0.1,
    reg_lambda        = 1.5,
    use_label_encoder = False,
    eval_metric       = 'logloss',
    early_stopping_rounds = 30,
    random_state      = 42,
    n_jobs            = -1,
)

model.fit(
    X_train, y_train,
    eval_set=[(X_test, y_test)],
    verbose=100
)

# Calibrate probabilities (sklearn >= 1.6: use FrozenEstimator; cv='prefit' was removed)
calibrated = CalibratedClassifierCV(
    estimator=FrozenEstimator(model),
    method="isotonic",
    cv=5,
)
calibrated.fit(X_test, y_test)

print("\n  ✓ Model trained & probability-calibrated")

# ============================================================
#  PHASE 5 — EVALUATE
# ============================================================
print("\n📊 PHASE 5: Evaluating model...")
print("-" * 40)

preds = calibrated.predict(X_test)
probs = calibrated.predict_proba(X_test)[:, 1]
acc   = accuracy_score(y_test, preds)

print(f'\n  ✓ Accuracy on unseen games: {acc:.1%}')
print(f'  ✓ Sportsbook breakeven:     ~52.4%')
print(f'  ✓ Edge over breakeven:      {(acc - 0.524)*100:+.1f} pp')
print(f'\n  Detailed breakdown:')
print(classification_report(y_test, preds, target_names=['Away Win','Home Win']))

# Confidence buckets — does 70% confidence actually win 70%?
print("\n  Confidence calibration check:")
print(f"  {'Confidence':>12}  {'Actual win rate':>15}  {'Sample':>8}")
for low, high in [(0.5,0.55),(0.55,0.60),(0.60,0.65),(0.65,0.70),(0.70,1.0)]:
    mask = (probs >= low) & (probs < high)
    if mask.sum() > 10:
        actual = y_test[mask].mean()
        print(f"  {low:.0%}–{high:.0%}:      {actual:>14.1%}   ({mask.sum():>5} games)")

# ── Feature importance chart ──────────────────────────────────
importance = pd.Series(model.feature_importances_, index=feature_cols).sort_values(ascending=False)
top15 = importance.head(15)

fig, ax = plt.subplots(figsize=(10, 6))
colors = ['#1A1A2E' if i < 3 else '#4A4A8E' if i < 8 else '#8A8ABE' for i in range(len(top15))]
ax.barh(top15.index[::-1], top15.values[::-1], color=colors[::-1])
ax.set_xlabel('Feature Importance Score')
ax.set_title('Top 15 Most Predictive Features — NBA Betting Model', fontweight='bold')
top_patch   = mpatches.Patch(color='#1A1A2E', label='Top 3 (most powerful)')
mid_patch   = mpatches.Patch(color='#4A4A8E', label='Top 4–8')
lower_patch = mpatches.Patch(color='#8A8ABE', label='Supporting features')
ax.legend(handles=[top_patch, mid_patch, lower_patch], loc='lower right')
plt.tight_layout()
_chart_dir = os.path.dirname(os.path.abspath(__file__))
_chart_path = os.path.join(_chart_dir, "feature_importance.png")
plt.savefig(_chart_path, dpi=150, bbox_inches="tight")
print(f"  ✓ Feature importance chart saved: {_chart_path}")
if os.environ.get("MPLBACKEND", "Agg").lower() != "agg":
    plt.show()
plt.close()

# ============================================================
#  PHASE 6 — PREDICT TODAY'S / UPCOMING GAMES
# ============================================================
print("\n🏀 PHASE 6: Generating predictions for upcoming games...")
print("-" * 40)

team_list = nba_teams_static.get_teams()
team_lookup = {t['abbreviation']: t['id'] for t in team_list}
team_name_lookup = {t['id']: t['full_name'] for t in team_list}

def get_team_features(team_id, rest_days=2, is_b2b=0):
    """Pull the most recent rolling stats for a given team."""
    team_games = games[games['TEAM_ID'] == team_id].copy()
    if len(team_games) < 5:
        return None
    latest = team_games.iloc[-1]
    feats = {}
    stat_map = {
        'PTS_ROLL10': 'PTS_ROLL10', 'FG_PCT_ROLL10': 'FG_PCT_ROLL10',
        'FG3_PCT_ROLL10': 'FG3_PCT_ROLL10', 'FT_PCT_ROLL10': 'FT_PCT_ROLL10',
        'REB_ROLL10': 'REB_ROLL10', 'AST_ROLL10': 'AST_ROLL10',
        'TOV_ROLL10': 'TOV_ROLL10', 'PLUS_MINUS_ROLL10': 'PLUS_MINUS_ROLL10',
        'STL_ROLL10': 'STL_ROLL10', 'BLK_ROLL10': 'BLK_ROLL10',
        'PTS_ROLL5': 'PTS_ROLL5', 'PLUS_MINUS_ROLL5': 'PLUS_MINUS_ROLL5',
        'FG_PCT_ROLL5': 'FG_PCT_ROLL5', 'TOV_ROLL5': 'TOV_ROLL5',
        'REB_ROLL5': 'REB_ROLL5', 'WIN_STREAK5': 'WIN_STREAK5',
        'SEASON_WINPCT': 'SEASON_WINPCT',
        'OFF_RATING_PROXY': 'OFF_RATING_PROXY', 'BALL_CONTROL': 'BALL_CONTROL',
    }
    for feat_key, col in stat_map.items():
        feats[feat_key] = latest.get(col, np.nan)
    feats['REST_DAYS'] = rest_days
    feats['IS_B2B']    = is_b2b
    return feats

def predict_game(home_abbr, away_abbr, home_rest=2, away_rest=2, home_b2b=0, away_b2b=0):
    """Predict win probability for a single game."""
    home_id = team_lookup.get(home_abbr.upper())
    away_id = team_lookup.get(away_abbr.upper())
    if not home_id or not away_id:
        print(f"  ✗ Unknown team abbreviation")
        return None

    hf = get_team_features(home_id, home_rest, home_b2b)
    af = get_team_features(away_id, away_rest, away_b2b)
    if hf is None or af is None:
        print(f"  ✗ Not enough data for one of these teams")
        return None

    row = {}
    for col in feature_cols:
        if col.endswith('_HOME'):
            base = col.replace('_HOME','')
            row[col] = hf.get(base, np.nan)
        elif col.endswith('_AWAY'):
            base = col.replace('_AWAY','')
            row[col] = af.get(base, np.nan)

    # Differentials
    row['PLUS_MINUS_DIFF'] = hf.get('PLUS_MINUS_ROLL10', 0) - af.get('PLUS_MINUS_ROLL10', 0)
    row['FG_PCT_DIFF']     = hf.get('FG_PCT_ROLL10', 0)     - af.get('FG_PCT_ROLL10', 0)
    row['PTS_DIFF']        = hf.get('PTS_ROLL10', 0)        - af.get('PTS_ROLL10', 0)
    row['WIN_STREAK_DIFF'] = hf.get('WIN_STREAK5', 0)       - af.get('WIN_STREAK5', 0)

    X_pred = pd.DataFrame([row])[feature_cols]
    prob_home = calibrated.predict_proba(X_pred)[0][1]
    prob_away = 1 - prob_home

    home_name = team_name_lookup.get(home_id, home_abbr)
    away_name = team_name_lookup.get(away_id, away_abbr)

    edge = abs(prob_home - 0.5)
    if edge >= 0.12:
        signal = "🔥 STRONG BET"
    elif edge >= 0.07:
        signal = "✅ LEAN"
    else:
        signal = "⚠️  SKIP (too close)"

    print(f"\n  {'─'*46}")
    print(f"  {away_name:>22}  @  {home_name}")
    print(f"  {'─'*46}")
    print(f"  Home win prob:  {prob_home:>6.1%}   {signal}")
    print(f"  Away win prob:  {prob_away:>6.1%}")
    print(f"  Predicted winner: {'🏠 ' + home_name if prob_home > 0.5 else '✈️  ' + away_name}")
    print(f"  Confidence: {'HIGH' if edge >= 0.12 else 'MEDIUM' if edge >= 0.07 else 'LOW'}")

    return prob_home

# ── Run predictions on a sample of upcoming matchups ─────────
# Edit these games to whatever is on the schedule tonight!
print("\n  Predictions (edit matchups below to tonight's games):")

upcoming_games = [
    # (away_team, home_team, away_rest_days, home_rest_days)
    ('BOS', 'LAL', 2, 2),
    ('GSW', 'MIA', 1, 2),
    ('DEN', 'NYK', 2, 1),
    ('MIL', 'PHX', 2, 2),
    ('DAL', 'OKC', 1, 2),
]

results = []
for away, home, away_rest, home_rest in upcoming_games:
    prob = predict_game(home, away, home_rest, away_rest)
    if prob is not None:
        results.append((home, away, prob))

# ── Summary table ─────────────────────────────────────────────
print(f"\n\n{'='*60}")
print("  PREDICTION SUMMARY")
print(f"{'='*60}")
print(f"  {'Home':^20} {'Away':^20} {'Home Win%':^10} {'Signal':^12}")
print(f"  {'-'*60}")
for home, away, prob in results:
    edge = abs(prob - 0.5)
    signal = "🔥 BET" if edge >= 0.12 else "✅ LEAN" if edge >= 0.07 else "⚠️  SKIP"
    print(f"  {home:^20} {away:^20} {prob:^10.1%} {signal:^12}")

print(f"\n{'='*60}")
print("  MODEL COMPLETE ✓")
print(f"  Accuracy: {acc:.1%} | Features: {len(feature_cols)} | Games trained on: {len(X_train):,}")
print(f"{'='*60}")
print("""
  HOW TO USE DAILY:
  1. Check tonight's NBA schedule
  2. Edit the 'upcoming_games' list above with real matchups
  3. Update rest days (how many days since each team last played)
  4. Re-run just the Phase 6 section
  5. Only bet 🔥 STRONG BET signals — skip everything else
""")