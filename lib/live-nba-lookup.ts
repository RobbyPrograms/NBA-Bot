import {
  findGameRowForTeamAbbr,
  formatGameClockDisplay,
  getPlayerStatFromBoxscore,
  isGameFinal,
  parseBoxscoreGame,
  parseScoreboardGames,
  periodLabel,
  type ParsedBoxscoreGame,
  type ScoreboardGameRow,
} from "@/lib/nba-live";
import { propLiveSpec } from "@/lib/prop-live-parse";
import type { ParlayStatType } from "@/lib/live-parlay-types";

export type LivePropUi =
  | { kind: "hidden" }
  | {
      kind: "live";
      current: number | null;
      threshold: number;
      stat: ParlayStatType;
      hit: boolean;
      finalMiss: boolean;
      gameFinal: boolean;
      statusShort: string;
      loading: boolean;
    };

type PropInput = { label: string; stat?: string; threshold?: number | null };

export function makeGetPropLive(
  sbGames: ScoreboardGameRow[],
  boxById: Map<string, ParsedBoxscoreGame>,
): (player: string, teamAbbr: string, prop: PropInput) => LivePropUi {
  return (player: string, teamAbbr: string, prop: PropInput): LivePropUi => {
    const spec = propLiveSpec(prop);
    if (!spec) return { kind: "hidden" };

    const t = teamAbbr.trim().toUpperCase();
    if (!t) return { kind: "hidden" };

    const row = findGameRowForTeamAbbr(sbGames, t);
    if (!row) {
      return {
        kind: "live",
        current: null,
        threshold: spec.threshold,
        stat: spec.stat,
        hit: false,
        finalMiss: false,
        gameFinal: false,
        statusShort: "No game today",
        loading: false,
      };
    }

    const box = boxById.get(row.gameId);
    if (!box) {
      return {
        kind: "live",
        current: null,
        threshold: spec.threshold,
        stat: spec.stat,
        hit: false,
        finalMiss: false,
        gameFinal: isGameFinal(row.gameStatus),
        statusShort: row.gameStatusText ?? "Loading…",
        loading: true,
      };
    }

    const gameFinal = isGameFinal(box.gameStatus);
    const matched = getPlayerStatFromBoxscore(box.homeTeam.players, box.awayTeam.players, player, spec.stat);
    const current = matched?.value ?? null;
    const hit = current != null && current >= spec.threshold;
    const finalMiss = gameFinal && !hit;
    const clock = formatGameClockDisplay(box.gameClock, "");
    const periodStr = periodLabel(box.period, box.gameStatus);
    const statusShort = gameFinal ? "Final" : [periodStr, clock].filter(Boolean).join(" · ") || (box.gameStatusText ?? "");

    return {
      kind: "live",
      current,
      threshold: spec.threshold,
      stat: spec.stat,
      hit,
      finalMiss,
      gameFinal,
      statusShort,
      loading: false,
    };
  };
}

export async function fetchLiveBoxscoresForAbbrs(abbrs: string[]): Promise<{
  sbGames: ScoreboardGameRow[];
  boxById: Map<string, ParsedBoxscoreGame>;
  error: string | null;
}> {
  const uniq = [...new Set(abbrs.map((a) => a.trim().toUpperCase()).filter(Boolean))];
  if (uniq.length === 0) {
    return { sbGames: [], boxById: new Map(), error: null };
  }

  try {
    const sbRes = await fetch("/api/nba/scoreboard");
    const sbJson: unknown = await sbRes.json();
    if (!sbRes.ok) {
      return {
        sbGames: [],
        boxById: new Map(),
        error: (sbJson as { error?: string })?.error ?? `Scoreboard ${sbRes.status}`,
      };
    }
    const sbGames = parseScoreboardGames(sbJson);
    const gameIds = new Set<string>();
    for (const abbr of uniq) {
      const row = findGameRowForTeamAbbr(sbGames, abbr);
      if (row) gameIds.add(row.gameId);
    }
    const boxById = new Map<string, ParsedBoxscoreGame>();
    await Promise.all(
      [...gameIds].map(async (gid) => {
        try {
          const res = await fetch(`/api/nba/boxscore/${gid}`);
          const j: unknown = await res.json();
          if (!res.ok) return;
          const parsed = parseBoxscoreGame(j);
          if (parsed) boxById.set(gid, parsed);
        } catch {
          /* skip game */
        }
      }),
    );
    return { sbGames, boxById, error: null };
  } catch (e) {
    return {
      sbGames: [],
      boxById: new Map(),
      error: e instanceof Error ? e.message : "Live fetch failed",
    };
  }
}
