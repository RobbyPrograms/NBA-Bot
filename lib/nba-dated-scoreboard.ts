/**
 * NBA same-day scoreboard for a calendar date (YYYY-MM-DD).
 * Used to grade moneyline picks after games go final.
 *
 * Primary source: stats.nba.com scoreboardv2 (works from Node/serverless with browser headers).
 * Legacy data.nba.com/prod/v1/{date}/scoreboard.json often returns S3 AccessDenied for non-browser clients.
 */

export type NbaBoardGame = {
  homeTricode: string;
  awayTricode: string;
  homeScore: number;
  awayScore: number;
  statusText: string;
  gameId?: string;
  /** stats.nba.com GameHeader GAME_STATUS_ID; 3 = Final (same as live box score). */
  gameStatusId?: number;
};

const NBA_STATS_FETCH_HEADERS: HeadersInit = {
  Accept: "application/json",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Referer: "https://www.nba.com/",
  Origin: "https://www.nba.com",
};

function normTri(s: string): string {
  return (s || "").trim().toUpperCase();
}

function parseScore(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return parseInt(v, 10);
  return null;
}

type ResultSet = { name?: string; headers?: string[]; rowSet?: unknown[][] };

function idx(headers: string[], name: string): number {
  const i = headers.indexOf(name);
  return i;
}

/** stats.nba.com/stats/scoreboardv2 — GameHeader + LineScore */
function extractGamesFromScoreboardV2(payload: unknown): NbaBoardGame[] {
  const root = payload as { resultSets?: ResultSet[] };
  const sets = root?.resultSets;
  if (!Array.isArray(sets)) return [];

  const gh = sets.find((s) => s.name === "GameHeader");
  const ls = sets.find((s) => s.name === "LineScore");
  if (!gh?.headers || !Array.isArray(gh.rowSet)) return [];

  const h = gh.headers;
  const gameIdI = idx(h, "GAME_ID");
  const statusI = idx(h, "GAME_STATUS_TEXT");
  const statusIdI = idx(h, "GAME_STATUS_ID");
  const homeIdI = idx(h, "HOME_TEAM_ID");
  const visIdI = idx(h, "VISITOR_TEAM_ID");
  if (gameIdI < 0 || statusI < 0 || homeIdI < 0 || visIdI < 0) return [];

  const lineByGame = new Map<string, Map<number, { abbr: string; pts: number }>>();
  if (ls?.headers && Array.isArray(ls.rowSet)) {
    const lh = ls.headers;
    const gI = idx(lh, "GAME_ID");
    const tI = idx(lh, "TEAM_ID");
    const aI = idx(lh, "TEAM_ABBREVIATION");
    const pI = idx(lh, "PTS");
    if (gI >= 0 && tI >= 0 && aI >= 0 && pI >= 0) {
      for (const row of ls.rowSet) {
        if (!Array.isArray(row)) continue;
        const gid = String(row[gI]);
        const tid = Number(row[tI]);
        const abbr = String(row[aI] ?? "");
        const pts = typeof row[pI] === "number" ? row[pI] : Number(row[pI]) || 0;
        const map = lineByGame.get(gid) ?? new Map();
        map.set(tid, { abbr, pts });
        lineByGame.set(gid, map);
      }
    }
  }

  const out: NbaBoardGame[] = [];
  for (const row of gh.rowSet) {
    if (!Array.isArray(row)) continue;
    const gameId = String(row[gameIdI]);
    const statusText = String(row[statusI] ?? "");
    const rawSid = statusIdI >= 0 ? row[statusIdI] : undefined;
    let gameStatusId: number | undefined;
    if (typeof rawSid === "number" && Number.isFinite(rawSid)) gameStatusId = rawSid;
    else if (typeof rawSid === "string" && /^\d+$/.test(rawSid)) {
      const n = parseInt(rawSid, 10);
      if (Number.isFinite(n)) gameStatusId = n;
    }
    const homeTid = Number(row[homeIdI]);
    const visTid = Number(row[visIdI]);
    const teams = lineByGame.get(gameId);
    if (!teams) continue;
    const home = teams.get(homeTid);
    const away = teams.get(visTid);
    if (!home || !away) continue;
    const homeTricode = normTri(home.abbr);
    const awayTricode = normTri(away.abbr);
    if (!homeTricode || !awayTricode) continue;
    out.push({
      homeTricode,
      awayTricode,
      homeScore: home.pts,
      awayScore: away.pts,
      statusText,
      gameId,
      gameStatusId,
    });
  }
  return out;
}

function extractGamesFromDataNba(payload: unknown): NbaBoardGame[] {
  if (!payload || typeof payload !== "object") return [];
  const o = payload as Record<string, unknown>;

  const rawList =
    (Array.isArray(o.games) ? o.games : null) ??
    (o.scoreboard && typeof o.scoreboard === "object"
      ? (o.scoreboard as { games?: unknown }).games
      : null);

  if (!Array.isArray(rawList)) return [];

  const out: NbaBoardGame[] = [];
  for (const g of rawList) {
    if (!g || typeof g !== "object") continue;
    const game = g as Record<string, unknown>;
    const ht = game.homeTeam as Record<string, unknown> | undefined;
    const at = game.awayTeam as Record<string, unknown> | undefined;
    if (!ht || !at) continue;
    const homeTricode = normTri(String(ht.teamTricode ?? ht.triCode ?? ""));
    const awayTricode = normTri(String(at.teamTricode ?? at.triCode ?? ""));
    const hs = parseScore(ht.score);
    const as = parseScore(at.score);
    const statusText = String(game.gameStatusText ?? "");
    const gs = game.gameStatus;
    const gameStatusId = typeof gs === "number" && Number.isFinite(gs) ? gs : undefined;
    if (!homeTricode || !awayTricode || hs == null || as == null) continue;
    out.push({
      homeTricode,
      awayTricode,
      homeScore: hs,
      awayScore: as,
      statusText,
      gameId: game.gameId != null ? String(game.gameId) : undefined,
      gameStatusId,
    });
  }
  return out;
}

function slateToStatsGameDate(slateDate: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(slateDate.trim());
  if (!m) return null;
  return `${m[2]}/${m[3]}/${m[1]}`;
}

async function fetchScoreboardStatsApi(slateDate: string): Promise<NbaBoardGame[]> {
  const gameDate = slateToStatsGameDate(slateDate);
  if (!gameDate) return [];
  const url = `https://stats.nba.com/stats/scoreboardv2?DayOffset=0&LeagueID=00&gameDate=${encodeURIComponent(gameDate)}`;
  const res = await fetch(url, { cache: "no-store", headers: NBA_STATS_FETCH_HEADERS });
  if (!res.ok) return [];
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return [];
  }
  return extractGamesFromScoreboardV2(data);
}

async function fetchScoreboardDataNba(slateDate: string): Promise<NbaBoardGame[]> {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(slateDate.trim());
  if (!m) return [];
  const slug = `${m[1]}${m[2]}${m[3]}`;
  const url = `https://data.nba.com/prod/v1/${slug}/scoreboard.json`;
  const res = await fetch(url, {
    cache: "no-store",
    headers: { Accept: "application/json", ...NBA_STATS_FETCH_HEADERS },
  });
  if (!res.ok) return [];
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return [];
  }
  return extractGamesFromDataNba(data);
}

/** slateDate: YYYY-MM-DD */
export async function fetchNbaScoreboardForDate(slateDate: string): Promise<NbaBoardGame[]> {
  const fromStats = await fetchScoreboardStatsApi(slateDate);
  if (fromStats.length > 0) return fromStats;
  return fetchScoreboardDataNba(slateDate);
}

export function findBoardGame(
  board: NbaBoardGame[],
  homeAbbr: string,
  awayAbbr: string
): NbaBoardGame | undefined {
  const h = normTri(homeAbbr);
  const a = normTri(awayAbbr);
  return board.find(
    (g) =>
      (g.homeTricode === h && g.awayTricode === a) ||
      (g.homeTricode === a && g.awayTricode === h)
  );
}

/** First scoreboard row where `teamAbbr` is home or away (for parlay legs tagged with `team`). */
export function findBoardGameForTeam(board: NbaBoardGame[], teamAbbr: string): NbaBoardGame | undefined {
  const t = normTri(teamAbbr);
  if (!t) return undefined;
  return board.find((g) => g.homeTricode === t || g.awayTricode === t);
}

export function winnerAbbr(g: NbaBoardGame): string | null {
  if (g.homeScore > g.awayScore) return g.homeTricode;
  if (g.awayScore > g.homeScore) return g.awayTricode;
  return null;
}

export function isFinalStatus(statusText: string): boolean {
  const s = statusText.toLowerCase();
  return s.includes("final");
}

/** Prefer stats `GAME_STATUS_ID` 3 = Final; else status text. */
export function gameRowIsFinal(g: NbaBoardGame): boolean {
  if (g.gameStatusId === 3) return true;
  return isFinalStatus(g.statusText);
}
