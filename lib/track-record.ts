import type { MlGradingResult } from "@/lib/grade-ml-picks";
import { gradeMlPicksWithBoard } from "@/lib/grade-ml-picks";
import {
  gradePropsForReportGamesFromCache,
  prefetchBoxscoresForReportGames,
} from "@/lib/historical-props-grade";
import { fetchNbaScoreboardForDate } from "@/lib/nba-dated-scoreboard";
import type { ParsedBoxscoreGame } from "@/lib/nba-live";

export type PropTrackSlice = {
  hits: number;
  misses: number;
  total: number;
  pct: number | null;
};

export type TrackRecordPayload = {
  ok: boolean;
  configured: boolean;
  error?: string;
  /** Graded moneyline picks vs NBA finals (only games with a clear W/L). */
  ml: {
    hits: number;
    misses: number;
    total: number;
    pct: number | null;
  };
  /** Featured 2-leg ML parlay from each saved report, when all legs resolved. */
  team_parlay: {
    hits: number;
    total: number;
    pct: number | null;
  };
  /** Player props from `top_props` / `risky_props` vs final box scores (resolved props only). */
  props: {
    lifetime: PropTrackSlice;
    last7: PropTrackSlice;
  };
  slates_used: number;
  disclaimer: string;
};

function normalizeBase(u: string): string {
  return u.replace(/\/$/, "");
}

type BestTeamLeg = { pick_abbr?: string };
type BestTeam = { legs?: BestTeamLeg[] } | null | undefined;

/**
 * Hit = every leg's team won as predicted; miss = any leg wrong when all resolved.
 * skip = not all legs could be graded (schedule mismatch, games not final, etc.)
 */
export function gradeBestTeamParlay(grading: MlGradingResult, bestTeam: BestTeam): "hit" | "miss" | "skip" {
  const legs = bestTeam?.legs;
  if (!legs?.length) return "skip";

  const byPick = new Map<string, boolean | null>();
  for (const game of grading.games) {
    const k = (game.pick_abbr || "").toUpperCase();
    if (k) byPick.set(k, game.pick_correct);
  }

  let resolved = true;
  let allHit = true;
  for (const leg of legs) {
    const ab = (leg.pick_abbr || "").toUpperCase();
    if (!ab) {
      resolved = false;
      break;
    }
    const c = byPick.get(ab);
    if (c === undefined) {
      resolved = false;
      break;
    }
    if (c === null) {
      resolved = false;
      break;
    }
    if (!c) allHit = false;
  }

  if (!resolved) return "skip";
  return allHit ? "hit" : "miss";
}

/** Inclusive calendar window: today and the prior `n - 1` UTC calendar days. */
function minSlateDateForLastNDays(nCalendarDays: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - (nCalendarDays - 1));
  return d.toISOString().slice(0, 10);
}

export async function fetchSlateRowsFromSupabase(
  limit: number
): Promise<{ slate_date: string; report: Record<string, unknown> }[]> {
  const rawUrl = process.env.SUPABASE_URL?.trim();
  const key =
    process.env.SUPABASE_ANON_KEY?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!rawUrl || !key) return [];

  const base = normalizeBase(rawUrl);
  const url = `${base}/rest/v1/slate_reports?select=slate_date,report&order=slate_date.desc&limit=${limit}`;
  const res = await fetch(url, {
    cache: "no-store",
    headers: {
      Accept: "application/json",
      apikey: key,
      Authorization: `Bearer ${key}`,
    },
  });
  if (!res.ok) return [];
  const rows = (await res.json()) as { slate_date?: string; report?: Record<string, unknown> }[];
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r) => r.slate_date && r.report && typeof r.report === "object")
    .map((r) => ({ slate_date: String(r.slate_date), report: r.report as Record<string, unknown> }));
}

export async function computeTrackRecord(limit = 40): Promise<TrackRecordPayload> {
  const disclaimer =
    "Track record uses saved slates in Supabase vs NBA final scores and box scores for props. Entertainment only—not financial advice. Sample grows as more nights are stored.";

  const emptyProps: PropTrackSlice = { hits: 0, misses: 0, total: 0, pct: null };

  try {
    const rows = await fetchSlateRowsFromSupabase(limit);
    if (!rows.length) {
      return {
        ok: true,
        configured: false,
        ml: { hits: 0, misses: 0, total: 0, pct: null },
        team_parlay: { hits: 0, total: 0, pct: null },
        props: { lifetime: emptyProps, last7: emptyProps },
        slates_used: 0,
        disclaimer,
      };
    }

    const propsBoxCache = new Map<string, ParsedBoxscoreGame | null>();
    const last7Min = minSlateDateForLastNDays(7);

    let mlHits = 0;
    let mlMiss = 0;
    let parlayHits = 0;
    let parlayTotal = 0;
    let propLifeHits = 0;
    let propLifeMiss = 0;
    let prop7Hits = 0;
    let prop7Miss = 0;

    for (const row of rows) {
      let board: Awaited<ReturnType<typeof fetchNbaScoreboardForDate>> = [];
      try {
        board = await fetchNbaScoreboardForDate(row.slate_date);
      } catch {
        board = [];
      }

      const grading: MlGradingResult = gradeMlPicksWithBoard(
        row.slate_date,
        row.report.games,
        board,
      );

      for (const g of grading.games) {
        if (g.pick_correct === true) mlHits++;
        else if (g.pick_correct === false) mlMiss++;
      }

      const parlays = row.report.parlays as { best_team?: BestTeam } | undefined;
      const pr = gradeBestTeamParlay(grading, parlays?.best_team);
      if (pr === "hit") {
        parlayHits++;
        parlayTotal++;
      } else if (pr === "miss") {
        parlayTotal++;
      }

      await prefetchBoxscoresForReportGames(row.report.games, board, propsBoxCache);
      const propAgg = gradePropsForReportGamesFromCache(row.report.games, board, propsBoxCache);

      propLifeHits += propAgg.hits;
      propLifeMiss += propAgg.misses;
      if (row.slate_date >= last7Min) {
        prop7Hits += propAgg.hits;
        prop7Miss += propAgg.misses;
      }
    }

    const mlTotal = mlHits + mlMiss;
    const mlPct = mlTotal > 0 ? mlHits / mlTotal : null;
    const parlayPct = parlayTotal > 0 ? parlayHits / parlayTotal : null;

    const propLifeTotal = propLifeHits + propLifeMiss;
    const prop7Total = prop7Hits + prop7Miss;

    return {
      ok: true,
      configured: true,
      ml: { hits: mlHits, misses: mlMiss, total: mlTotal, pct: mlPct },
      team_parlay: { hits: parlayHits, total: parlayTotal, pct: parlayPct },
      props: {
        lifetime: {
          hits: propLifeHits,
          misses: propLifeMiss,
          total: propLifeTotal,
          pct: propLifeTotal > 0 ? propLifeHits / propLifeTotal : null,
        },
        last7: {
          hits: prop7Hits,
          misses: prop7Miss,
          total: prop7Total,
          pct: prop7Total > 0 ? prop7Hits / prop7Total : null,
        },
      },
      slates_used: rows.length,
      disclaimer,
    };
  } catch (e) {
    return {
      ok: false,
      configured: true,
      error: e instanceof Error ? e.message : "track record failed",
      ml: { hits: 0, misses: 0, total: 0, pct: null },
      team_parlay: { hits: 0, total: 0, pct: null },
      props: { lifetime: emptyProps, last7: emptyProps },
      slates_used: 0,
      disclaimer,
    };
  }
}
