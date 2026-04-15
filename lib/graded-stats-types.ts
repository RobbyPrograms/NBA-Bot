/** Row shape from `pick_stats` view (Supabase). */
export type PickStatsRow = {
  total_graded: number | null;
  total_wins: number | null;
  total_losses: number | null;
  total_pushes: number | null;
  total_pending: number | null;
  lifetime_hit_rate: number | null;
  ml_graded: number | null;
  ml_hit_rate: number | null;
  props_graded: number | null;
  props_hit_rate: number | null;
  strong_graded: number | null;
  strong_hit_rate: number | null;
  last_7d_graded: number | null;
  last_7d_hit_rate: number | null;
  last_30d_graded: number | null;
  last_30d_hit_rate: number | null;
  roi_flat_100: number | null;
  best_prop_stat: string | null;
};

/** Row from `recent_picks` view. */
export type RecentPickRow = {
  id: number;
  slate_date: string;
  pick_type: string;
  pick_name: string;
  pick_label: string | null;
  pick_side: string | null;
  home_abbr: string;
  away_abbr: string;
  home_name: string | null;
  away_name: string | null;
  model_prob: number | null;
  market_edge: number | null;
  market_line: number | null;
  market_book: string | null;
  kelly_amt: number | null;
  confidence: string | null;
  stars: string | null;
  result: string;
  actual_value: number | null;
  pick_threshold: number | null;
  graded_at: string | null;
  created_at: string;
};

/** Row from `daily_stats` view. */
export type DailyStatRow = {
  slate_date: string;
  graded: number | null;
  wins: number | null;
  losses: number | null;
  hit_rate: number | null;
  daily_pnl: number | null;
};

/** Row from `player_prop_stats` view. */
export type PlayerPropStatRow = {
  player_name: string;
  stat_type: string | null;
  total_graded: number | null;
  wins: number | null;
  hit_rate: number | null;
  avg_model_confidence: number | null;
  avg_actual: number | null;
  avg_threshold: number | null;
};

/** Row from `calibration_stats` view. */
export type CalibrationStatRow = {
  confidence_bucket: string | null;
  n_picks: number | null;
  wins: number | null;
  actual_hit_rate: number | null;
  avg_model_confidence: number | null;
  calibration_error: number | null;
};
