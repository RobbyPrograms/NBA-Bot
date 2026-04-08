/**
 * NBA same-day scoreboard for a calendar date (YYYY-MM-DD).
 * Used to grade moneyline picks after games go final.
 */

export type NbaBoardGame = {
  homeTricode: string;
  awayTricode: string;
  homeScore: number;
  awayScore: number;
  statusText: string;
  gameId?: string;
};

function normTri(s: string): string {
  return (s || "").trim().toUpperCase();
}

function parseScore(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return parseInt(v, 10);
  return null;
}

function extractGames(payload: unknown): NbaBoardGame[] {
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
    const statusText = String(game.gameStatusText ?? game.gameStatus ?? "");
    if (!homeTricode || !awayTricode || hs == null || as == null) continue;
    out.push({
      homeTricode,
      awayTricode,
      homeScore: hs,
      awayScore: as,
      statusText,
      gameId: game.gameId != null ? String(game.gameId) : undefined,
    });
  }
  return out;
}

/** slateDate: YYYY-MM-DD */
export async function fetchNbaScoreboardForDate(slateDate: string): Promise<NbaBoardGame[]> {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(slateDate.trim());
  if (!m) return [];
  const slug = `${m[1]}${m[2]}${m[3]}`;
  const url = `https://data.nba.com/prod/v1/${slug}/scoreboard.json`;
  const res = await fetch(url, {
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) return [];
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return [];
  }
  return extractGames(data);
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

export function winnerAbbr(g: NbaBoardGame): string | null {
  if (g.homeScore > g.awayScore) return g.homeTricode;
  if (g.awayScore > g.homeScore) return g.awayTricode;
  return null;
}

export function isFinalStatus(statusText: string): boolean {
  const s = statusText.toLowerCase();
  return s.includes("final");
}
