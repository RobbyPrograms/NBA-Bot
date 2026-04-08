import type { ParlayStatType } from "@/lib/live-parlay-types";

const NBA_GAME_STATUS = {
  PREGAME: 1,
  LIVE: 2,
  FINAL: 3,
} as const;

export interface ScoreboardGameRow {
  gameId: string;
  gameStatus: number;
  gameStatusText?: string;
  period?: number;
  gameClock?: string;
  homeTeam: { teamTricode: string; teamName?: string; teamCity?: string };
  awayTeam: { teamTricode: string; teamName?: string; teamCity?: string };
}

export function parseScoreboardGames(payload: unknown): ScoreboardGameRow[] {
  const root = payload as { scoreboard?: { games?: unknown[] } };
  const games = root?.scoreboard?.games;
  if (!Array.isArray(games)) return [];
  return games.filter((g): g is ScoreboardGameRow => {
    const row = g as ScoreboardGameRow;
    return typeof row?.gameId === "string" && typeof row?.gameStatus === "number";
  });
}

/**
 * Resolve today’s game row for a team tricode (matches predictor `home_abbr` / `away_abbr`).
 * Returns the full scoreboard row so callers get gameId, clock, and status in one object.
 */
export function findGameRowForTeamAbbr(games: ScoreboardGameRow[], teamAbbr: string): ScoreboardGameRow | null {
  const t = teamAbbr.trim().toUpperCase();
  if (!t) return null;
  return games.find((g) => g.homeTeam?.teamTricode === t || g.awayTeam?.teamTricode === t) ?? null;
}

/** Today’s `gameId` for a team tricode (same abbreviations as predictor `home_abbr` / `away_abbr`). */
export function findGameIdForTeamAbbr(games: ScoreboardGameRow[], teamAbbr: string): string | null {
  return findGameRowForTeamAbbr(games, teamAbbr)?.gameId ?? null;
}

export function isGameFinal(gameStatus: number): boolean {
  return gameStatus === NBA_GAME_STATUS.FINAL;
}

/** ISO-8601 duration e.g. PT07M18.00S → "7:18" */
export function formatGameClockDisplay(iso: string | undefined, fallback: string): string {
  if (!iso || typeof iso !== "string" || !iso.startsWith("PT")) return fallback;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?/);
  if (!m) return fallback;
  const h = m[1] ? parseInt(m[1], 10) : 0;
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const secRaw = m[3] != null ? parseFloat(m[3]) : 0;
  const sec = Math.floor(secRaw);
  if (h > 0) return `${h}:${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${min}:${String(sec).padStart(2, "0")}`;
}

export function periodLabel(period: number | undefined, gameStatus: number): string {
  if (period == null) return "—";
  if (isGameFinal(gameStatus)) return "Final";
  if (period >= 5) return `OT${period - 4}`;
  return `Q${period}`;
}

export interface BoxscorePlayerRow {
  name?: string;
  firstName?: string;
  familyName?: string;
  statistics?: Record<string, unknown>;
}

function statFromBoxscore(stat: ParlayStatType, statistics: Record<string, unknown>): number {
  switch (stat) {
    case "PTS":
      return Number(statistics.points ?? 0);
    case "REB":
      return Number(statistics.reboundsTotal ?? 0);
    case "AST":
      return Number(statistics.assists ?? 0);
    case "FG3M":
      return Number(statistics.threePointersMade ?? 0);
    case "STL":
      return Number(statistics.steals ?? 0);
    case "BLK":
      return Number(statistics.blocks ?? 0);
    default:
      return 0;
  }
}

function foldName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(s: string): string[] {
  return foldName(s)
    .split(" ")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/** Fuzzy match user-entered name to NBA boxscore `name` / first+last */
export function getPlayerStatFromBoxscore(
  homePlayers: BoxscorePlayerRow[] | undefined,
  awayPlayers: BoxscorePlayerRow[] | undefined,
  query: string,
  stat: ParlayStatType,
): { value: number; matchedName: string } | null {
  const q = query.trim();
  if (!q) return null;
  const qTokens = tokens(q);
  const qFold = foldName(q);
  const all = [...(homePlayers ?? []), ...(awayPlayers ?? [])];

  let best: BoxscorePlayerRow | null = null;
  let bestScore = 0;
  for (const p of all) {
    const name = p.name ?? "";
    const first = p.firstName ?? "";
    const last = p.familyName ?? "";
    const full = foldName(name);
    const fl = foldName(`${first} ${last}`);
    let score = 0;
    if (full === qFold || fl === qFold) score = 100;
    else if (full.includes(qFold) && qFold.length >= 4) score = 80;
    else if (last && qFold.endsWith(foldName(last)) && foldName(last).length > 2) score = 70;
    else {
      const lastF = foldName(last);
      if (lastF && qTokens.some((t) => t === lastF)) score = 60;
      else if (qTokens.every((t) => full.includes(t) || fl.includes(t))) score = 50;
    }
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  if (!best || bestScore < 50) return null;
  const stats = best.statistics;
  if (!stats || typeof stats !== "object") return null;
  const value = statFromBoxscore(stat, stats);
  return { value, matchedName: best.name ?? `${best.firstName ?? ""} ${best.familyName ?? ""}`.trim() };
}

export interface ParsedBoxscoreGame {
  gameId: string;
  gameStatus: number;
  gameStatusText: string;
  period?: number;
  gameClock?: string;
  homeTeam: { teamTricode: string; players?: BoxscorePlayerRow[] };
  awayTeam: { teamTricode: string; players?: BoxscorePlayerRow[] };
}

export function parseBoxscoreGame(payload: unknown): ParsedBoxscoreGame | null {
  const root = payload as { game?: ParsedBoxscoreGame };
  const g = root?.game;
  if (!g || typeof g.gameId !== "string") return null;
  return g;
}
