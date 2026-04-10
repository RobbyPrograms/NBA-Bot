import { NBA_CDN_FETCH_HEADERS } from "@/lib/nba-cdn-headers";
import { findBoardGame, gameRowIsFinal, type NbaBoardGame } from "@/lib/nba-dated-scoreboard";
import {
  getPlayerStatFromBoxscore,
  isGameFinal,
  parseBoxscoreGame,
  type ParsedBoxscoreGame,
} from "@/lib/nba-live";
import { propLiveSpec } from "@/lib/prop-live-parse";
import type { GameRow, PlayerProp } from "@/lib/types";

export type PropGradingAgg = { hits: number; misses: number; total: number };

export async function fetchBoxscoreParsed(gameId: string): Promise<ParsedBoxscoreGame | null> {
  const url = `https://cdn.nba.com/static/json/liveData/boxscore/boxscore_${encodeURIComponent(gameId)}.json`;
  const res = await fetch(url, {
    cache: "no-store",
    headers: NBA_CDN_FETCH_HEADERS,
  });
  if (!res.ok) return null;
  let u: unknown;
  try {
    u = await res.json();
  } catch {
    return null;
  }
  return parseBoxscoreGame(u);
}

function propDedupeKey(p: PlayerProp, stat: string, threshold: number): string {
  return `${(p.player || "").trim()}|${(p.label || "").trim()}|${stat}|${threshold}`;
}

function collectPropsFromGame(g: GameRow): PlayerProp[] {
  const top = Array.isArray(g.top_props) ? g.top_props : [];
  const risky = Array.isArray(g.risky_props) ? g.risky_props : [];
  return [...top, ...risky];
}

/**
 * Ensure boxscores for every final game on `board` referenced by `games` are loaded into `cache`.
 */
export async function prefetchBoxscoresForReportGames(
  games: unknown,
  board: NbaBoardGame[],
  cache: Map<string, ParsedBoxscoreGame | null>,
): Promise<void> {
  if (!Array.isArray(games)) return;
  const gameRows = games as GameRow[];
  const ids = new Set<string>();
  for (const g of gameRows) {
    const bg = findBoardGame(board, g.home_abbr, g.away_abbr);
    if (!bg?.gameId || !gameRowIsFinal(bg)) continue;
    ids.add(bg.gameId);
  }
  await Promise.all(
    [...ids].map(async (gid) => {
      if (cache.has(gid)) return;
      const p = await fetchBoxscoreParsed(gid);
      cache.set(gid, p && isGameFinal(p.gameStatus) ? p : null);
    }),
  );
}

/**
 * Grade stored `top_props` / `risky_props` vs NBA finals. Call `prefetchBoxscoresForReportGames` first.
 */
export function gradePropsForReportGamesFromCache(
  games: unknown,
  board: NbaBoardGame[],
  cache: Map<string, ParsedBoxscoreGame | null>,
): PropGradingAgg {
  if (!Array.isArray(games)) return { hits: 0, misses: 0, total: 0 };

  const gameRows = games as GameRow[];
  let hits = 0;
  let misses = 0;
  const seenKeys = new Set<string>();

  for (const g of gameRows) {
    const bg = findBoardGame(board, g.home_abbr, g.away_abbr);
    if (!bg?.gameId) continue;
    const box = cache.get(bg.gameId);
    if (!box) continue;

    for (const prop of collectPropsFromGame(g)) {
      const spec = propLiveSpec(prop);
      if (!spec) continue;
      const dk = propDedupeKey(prop, spec.stat, spec.threshold);
      if (seenKeys.has(dk)) continue;
      seenKeys.add(dk);

      const r = getPlayerStatFromBoxscore(
        box.homeTeam.players,
        box.awayTeam.players,
        prop.player,
        spec.stat,
      );
      if (!r) continue;

      if (r.value >= spec.threshold) hits++;
      else misses++;
    }
  }

  return { hits, misses, total: hits + misses };
}
