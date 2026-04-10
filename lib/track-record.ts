import { gradeAllPublishedBetsForSlate } from "@/lib/all-bets-grade";
import { gradeBestTeamParlay } from "@/lib/grade-best-team-parlay";
import type { MlGradingResult } from "@/lib/grade-ml-picks";
import { gradeMlPicksWithBoard } from "@/lib/grade-ml-picks";
import { gradePropsForReportGamesFromCache } from "@/lib/historical-props-grade";
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
    /** Rows in saved reports (per game ML pick). */
    picks_tracked: number;
    /** Matched NBA schedule, game not final yet. */
    awaiting_final: number;
    /** No row on NBA scoreboard for that slate date + matchup. */
    unmatched_schedule: number;
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
  /**
   * Combined: game MLs + matchup props + each prop parlay slip (safe/SGP/risky/hot; identical leg-sets deduped)
   * + best_safe/best_risky + mixed slips + featured ML parlay. Matchup props still counted separately in `props`.
   */
  all_bets: {
    lifetime: PropTrackSlice;
    last7: PropTrackSlice;
  };
  slates_used: number;
  disclaimer: string;
};

function normalizeBase(u: string): string {
  return u.replace(/\/$/, "");
}

type BestTeam = { legs?: { pick_abbr?: string }[] } | null | undefined;

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
  if (!res.ok) {
    if (process.env.NODE_ENV === "development") {
      const t = await res.text();
      console.warn("[track-record] Supabase slate_reports:", res.status, t.slice(0, 300));
    }
    return [];
  }
  const rows = (await res.json()) as { slate_date?: string; report?: Record<string, unknown> }[];
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r) => r.slate_date && r.report && typeof r.report === "object")
    .map((r) => ({ slate_date: String(r.slate_date), report: r.report as Record<string, unknown> }));
}

export async function computeTrackRecord(limit = 40): Promise<TrackRecordPayload> {
  const disclaimer =
    "Track record uses saved slates in Supabase vs NBA finals: game MLs, matchup props, prop parlay slips (safe/SGP/risky/hot), mixed slips, and the featured ML parlay. Duplicate parlay cards with identical legs count once. Entertainment only—not financial advice.";

  const emptyProps: PropTrackSlice = { hits: 0, misses: 0, total: 0, pct: null };

  try {
    const rows = await fetchSlateRowsFromSupabase(limit);
    if (!rows.length) {
      return {
        ok: true,
        configured: false,
        ml: {
          hits: 0,
          misses: 0,
          total: 0,
          pct: null,
          picks_tracked: 0,
          awaiting_final: 0,
          unmatched_schedule: 0,
        },
        team_parlay: { hits: 0, total: 0, pct: null },
        props: { lifetime: emptyProps, last7: emptyProps },
        all_bets: { lifetime: emptyProps, last7: emptyProps },
        slates_used: 0,
        disclaimer,
      };
    }

    const propsBoxCache = new Map<string, ParsedBoxscoreGame | null>();
    const last7Min = minSlateDateForLastNDays(7);

    let mlHits = 0;
    let mlMiss = 0;
    let mlPicksTracked = 0;
    let mlAwaitingFinal = 0;
    let mlUnmatchedSchedule = 0;
    let parlayHits = 0;
    let parlayTotal = 0;
    let propLifeHits = 0;
    let propLifeMiss = 0;
    let prop7Hits = 0;
    let prop7Miss = 0;
    let allLifeHits = 0;
    let allLifeMiss = 0;
    let all7Hits = 0;
    let all7Miss = 0;

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

      mlPicksTracked += grading.games.length;
      for (const g of grading.games) {
        if (g.pick_correct === true) mlHits++;
        else if (g.pick_correct === false) mlMiss++;
        else if (g.home_score != null && g.away_score != null && !g.is_final) mlAwaitingFinal++;
        else if (g.home_score == null && g.away_score == null) mlUnmatchedSchedule++;
      }

      const parlays = row.report.parlays as { best_team?: BestTeam } | undefined;
      const pr = gradeBestTeamParlay(grading, parlays?.best_team);
      if (pr === "hit") {
        parlayHits++;
        parlayTotal++;
      } else if (pr === "miss") {
        parlayTotal++;
      }

      const allBetAgg = await gradeAllPublishedBetsForSlate(grading, row.report, board, propsBoxCache);
      allLifeHits += allBetAgg.hits;
      allLifeMiss += allBetAgg.misses;
      if (row.slate_date >= last7Min) {
        all7Hits += allBetAgg.hits;
        all7Miss += allBetAgg.misses;
      }

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

    const allLifeTotal = allLifeHits + allLifeMiss;
    const all7Total = all7Hits + all7Miss;

    return {
      ok: true,
      configured: true,
      ml: {
        hits: mlHits,
        misses: mlMiss,
        total: mlTotal,
        pct: mlPct,
        picks_tracked: mlPicksTracked,
        awaiting_final: mlAwaitingFinal,
        unmatched_schedule: mlUnmatchedSchedule,
      },
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
      all_bets: {
        lifetime: {
          hits: allLifeHits,
          misses: allLifeMiss,
          total: allLifeTotal,
          pct: allLifeTotal > 0 ? allLifeHits / allLifeTotal : null,
        },
        last7: {
          hits: all7Hits,
          misses: all7Miss,
          total: all7Total,
          pct: all7Total > 0 ? all7Hits / all7Total : null,
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
      ml: {
        hits: 0,
        misses: 0,
        total: 0,
        pct: null,
        picks_tracked: 0,
        awaiting_final: 0,
        unmatched_schedule: 0,
      },
      team_parlay: { hits: 0, total: 0, pct: null },
      props: { lifetime: emptyProps, last7: emptyProps },
      all_bets: { lifetime: emptyProps, last7: emptyProps },
      slates_used: 0,
      disclaimer,
    };
  }
}
