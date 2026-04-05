import type { RolibotReport } from "./types";

/**
 * Shown in `npm run dev` when ROLI_REPORT_URL is unset and ROLI_FULL_MOCK is not 1.
 * Avoids misleading static LAC/SAS-style picks that look like "today's" NBA slate.
 */
export function buildDevPlaceholderReport(): RolibotReport {
  return {
    ok: true,
    brand: "RoliBot NBA",
    generated_at: new Date().toISOString(),
    slate_date: new Date().toISOString().slice(0, 10),
    slate_matchups: [],
    is_placeholder: true,
    bankroll: 1000,
    kelly_fraction: 0.25,
    max_bet_pct: 0.05,
    how_to_use: [
      "Create .env.local in the project root with ROLI_REPORT_URL=https://.../live-report.json (your hosted predictor output).",
      "Restart npm run dev after saving .env.local.",
      "Optional: ROLI_FULL_MOCK=1 in .env.local restores the old static UI sample (fictional teams — not the real slate).",
      "Never bet more than you can afford to lose.",
    ],
    model: {
      name: "— (no upstream run loaded)",
      accuracy: 0.524,
      logloss: 0.69,
      n_features: 0,
      cache_hit: false,
    },
    games: [],
    bet_slip: {
      strong: [],
      good: [],
      lean: [],
      skip: [],
      total_kelly: 0,
    },
    parlays: {
      mixed: [],
      safe_props: [],
      risky_props: [],
      sgp: [],
      hot: [],
      best_team: null,
      best_safe_prop: null,
      best_risky_prop: null,
    },
    props_summary: {
      n_safe: 0,
      n_strong: 0,
      n_risky: 0,
      best_prop: null,
    },
    disclaimer:
      "Local development: no live JSON loaded. Configure ROLI_REPORT_URL for real daily picks. Not betting advice.",
  };
}
