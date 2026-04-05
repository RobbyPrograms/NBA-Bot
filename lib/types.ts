export interface PlayerProp {
  player: string;
  team: string;
  label: string;
  stat?: string;
  threshold?: number | null;
  hit_rate: number;
  raw_hr?: number;
  avg: number;
  avg_recent: number;
  avg_recent3?: number | null;
  std?: number | null;
  n_games: number;
  trend: string;
  trend3?: string;
  min_flag: string;
  opp_factor: number;
  min_recent?: number | null;
  stars?: string;
  confidence_tier?: string;
  /** v5 JSON: tier string from prop_conf */
  confidence?: string;
  opp?: string;
  inj_status?: string;
}

export interface MinutesWarning {
  player: string;
  min_recent: number | null;
  min_flag: string;
}

export interface GameRow {
  home_abbr: string;
  away_abbr: string;
  home_name: string;
  away_name: string;
  prob_home: number;
  prob_away: number;
  pick_name: string;
  pick_abbr: string;
  pick_prob: number;
  pick_side: string;
  pick_odds: string;
  edge: number;
  confidence: string;
  stars: string;
  kelly_amt: number;
  props?: PlayerProp[];
  top_props?: PlayerProp[];
  risky_props?: PlayerProp[];
  minutes_warnings?: MinutesWarning[];
  /** v5: Claude or rules-based narrative */
  analysis?: string;
}

export interface SafeParlayLeg {
  player: string;
  label: string;
  hit_rate: number;
  trend: string;
  stars?: string;
  confidence?: string;
  team?: string;
  opp?: string;
}

export interface SafePropParlay {
  n: number;
  combined: number;
  payout: number;
  implied_american?: string;
  kelly?: number;
  legs: SafeParlayLeg[];
}

export interface RiskyParlayLeg {
  player: string;
  label: string;
  hit_rate: number;
  trend: string;
  avg?: number;
  team?: string;
  opp?: string;
}

export interface RiskyPropParlay {
  n: number;
  combined: number;
  payout: number;
  implied_american?: string;
  kelly?: number;
  legs: RiskyParlayLeg[];
}

export interface HotParlayLeg {
  player: string;
  label: string;
  hit_rate: number;
  trend: string;
  avg?: number;
  avg_recent?: number;
}

export interface HotPropParlay {
  n: number;
  combined: number;
  payout: number;
  implied_american?: string;
  legs: HotParlayLeg[];
}

export interface MixedParlay {
  n: number;
  combined: number;
  payout: number;
  implied_american?: string;
  kelly?: number;
  team_pick: {
    pick_name: string;
    pick_abbr?: string;
    pick_prob: number;
    pick_side?: string;
    stars?: string;
  };
  prop: PlayerProp;
  prop2?: PlayerProp;
}

export interface BetSlipSkipRow {
  home_name: string;
  away_name: string;
  home_abbr?: string;
  away_abbr?: string;
}

export interface SeasonPullRow {
  season: string;
  rows: number;
}

export interface PropsFetchRow {
  team: string;
  opponent: string;
  viable_props: number;
}

export interface XgbEvalRow {
  iteration: number;
  validation_logloss: number;
}

export interface InjuryReportRow {
  player: string;
  team: string;
  status: string;
}

export interface InjuryReportSummary {
  source?: string;
  fetched_ok?: boolean;
  n_out?: number;
  /** v5 */
  n_tracked?: number;
  n_excluded?: number;
  error?: string;
  out_players?: InjuryReportRow[];
}

export interface PipelineStats {
  season_pull?: SeasonPullRow[];
  current_nba_season?: string;
  raw_season_rows?: number;
  clean_merged_games: number;
  home_win_rate_merged?: number;
  date_from: string;
  date_to: string;
  train_games: number;
  test_games: number;
  schedule_tonight: number;
  slate_date?: string;
  slate_timezone?: string;
  props_fetch?: PropsFetchRow[];
  props_teams_fetched?: number;
  props_skipped_injury?: number;
  injury_report?: InjuryReportSummary;
}

export interface TrainingMeta {
  xgb_eval_log: XgbEvalRow[];
  from_cache: boolean;
  feature_importance_saved?: boolean;
  feature_importance_path?: string | null;
}

export interface RunMeta {
  cache_line: string;
  games_predicted_tonight: number;
  breakeven_note?: string;
}

export interface CalibrationBin {
  range: string;
  actual_win_rate: number;
  n_games: number;
}

export interface AccuracyNotes {
  traded_skipped?: number;
  injured_skipped?: number;
  trade_check?: string;
  injury_check?: string;
  activity_check?: string;
  minutes_check?: string;
}

export interface DailyUpdateInstructions {
  windows?: string;
  mac_linux?: string;
  json_mode?: string;
  backtest?: string;
  llm?: string;
  retrain?: string;
  no_github_actions_needed?: boolean;
}

export interface ParlaysBlock {
  safe_props?: SafePropParlay[];
  /** v5 */
  safe?: SafePropParlay[];
  risky_props?: RiskyPropParlay[];
  risky?: RiskyPropParlay[];
  /** v5 same-game parlays */
  sgp?: SafePropParlay[];
  mixed?: MixedParlay[];
  hot?: HotPropParlay[];
  best_team?: {
    legs: { pick_name: string; pick_abbr: string; pick_prob: number; pick_side: string }[];
    combined: number;
    payout: number;
    kelly: number;
  } | null;
  best_safe_prop?: SafePropParlay | null;
  best_risky_prop?: RiskyPropParlay | null;
}

export interface RolibotReport {
  ok: boolean;
  brand: string;
  generated_at: string;
  bankroll: number;
  kelly_fraction: number;
  max_bet_pct: number;
  how_to_use?: string[];
  /** v5 slate (also may live under pipeline in older JSON) */
  slate_date?: string;
  /** Exact AWAY @ HOME strings used for props (from scoreboard) */
  slate_matchups?: string[];
  llm_enabled?: boolean;
  injury_report?: InjuryReportSummary;
  accuracy_notes?: AccuracyNotes;
  daily_update_instructions?: DailyUpdateInstructions;
  pipeline?: PipelineStats;
  training?: TrainingMeta;
  run_meta?: RunMeta;
  model: {
    name: string;
    accuracy: number;
    logloss: number;
    edge_vs_book_pp?: number;
    edge_pp?: number;
    n_features: number;
    n_train_games?: number;
    n_train?: number;
    cache_hit: boolean;
  };
  evaluation?: {
    classification_report: Record<string, Record<string, number> | number>;
    calibration_bins: CalibrationBin[];
    sportsbook_breakeven?: number;
  };
  games: GameRow[];
  bet_slip: {
    strong: GameRow[];
    good: GameRow[];
    lean: GameRow[];
    skip: BetSlipSkipRow[];
    total_kelly: number;
    total_kelly_pct_bankroll?: number;
  };
  parlays: ParlaysBlock;
  highlights?: {
    best_prop_parlay_kelly: number;
  };
  props_summary: {
    n_safe?: number;
    n_strong?: number;
    n_risky: number;
    best_prop: {
      player: string;
      label: string;
      hit_rate: number;
      avg: number;
      n_games: number;
      trend: string;
    } | null;
  };
  disclaimer: string;
  error?: string;
  /** Dev API: empty slate placeholder (not fictional historical picks) */
  is_placeholder?: boolean;
}
