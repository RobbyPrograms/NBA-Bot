import { gradeBestTeamParlay } from "@/lib/grade-best-team-parlay";
import type { MlGradingResult } from "@/lib/grade-ml-picks";
import {
  findBoardGame,
  findBoardGameForTeam,
  gameRowIsFinal,
  winnerAbbr,
  type NbaBoardGame,
} from "@/lib/nba-dated-scoreboard";
import { fetchBoxscoreParsed } from "@/lib/historical-props-grade";
import { getPlayerStatFromBoxscore, isGameFinal, type ParsedBoxscoreGame } from "@/lib/nba-live";
import { propLiveSpec } from "@/lib/prop-live-parse";
import type { GameRow, MixedParlay, ParlaysBlock, PlayerProp } from "@/lib/types";

export type BetAgg = { hits: number; misses: number; total: number };

type PropLeg = { player: string; label: string; stat?: string; threshold?: number | null; team?: string };

type ParlaySlip = { legs?: PropLeg[] };

function addResult(agg: BetAgg, r: "hit" | "miss" | "skip") {
  if (r === "skip") return;
  agg.total++;
  if (r === "hit") agg.hits++;
  else agg.misses++;
}

function mergeMlResolved(agg: BetAgg, grading: MlGradingResult) {
  for (const g of grading.games) {
    if (g.pick_correct === true) {
      agg.hits++;
      agg.total++;
    } else if (g.pick_correct === false) {
      agg.misses++;
      agg.total++;
    }
  }
}

async function ensureBoxscore(
  gameId: string,
  cache: Map<string, ParsedBoxscoreGame | null>,
): Promise<ParsedBoxscoreGame | null> {
  if (cache.has(gameId)) return cache.get(gameId)!;
  const p = await fetchBoxscoreParsed(gameId);
  const ok = p && isGameFinal(p.gameStatus) ? p : null;
  cache.set(gameId, ok);
  return ok;
}

/** Load final boxscores for every finished game on the dated scoreboard (covers parlay legs on any team). */
export async function prefetchFinalBoxscoresForBoard(
  board: NbaBoardGame[],
  cache: Map<string, ParsedBoxscoreGame | null>,
): Promise<void> {
  const ids = [...new Set(board.filter((g) => g.gameId && gameRowIsFinal(g)).map((g) => g.gameId!))];
  await Promise.all(ids.map((id) => ensureBoxscore(id, cache)));
}

function gradePropLegAgainstBox(leg: PropLeg, box: ParsedBoxscoreGame): "hit" | "miss" | "skip" {
  const spec = propLiveSpec(leg);
  if (!spec) return "skip";
  const r = getPlayerStatFromBoxscore(
    box.homeTeam.players,
    box.awayTeam.players,
    leg.player,
    spec.stat,
  );
  if (!r) return "skip";
  return r.value >= spec.threshold ? "hit" : "miss";
}

async function gradePropParlaySlip(
  legs: PropLeg[] | undefined,
  board: NbaBoardGame[],
  cache: Map<string, ParsedBoxscoreGame | null>,
): Promise<"hit" | "miss" | "skip"> {
  if (!legs?.length) return "skip";
  let allHit = true;
  for (const leg of legs) {
    const team = (leg.team || "").trim();
    if (!team) return "skip";
    const bg = findBoardGameForTeam(board, team);
    if (!bg?.gameId || !gameRowIsFinal(bg)) return "skip";
    const box = await ensureBoxscore(bg.gameId, cache);
    if (!box) return "skip";
    const u = gradePropLegAgainstBox(leg, box);
    if (u === "skip") return "skip";
    if (u === "miss") allHit = false;
  }
  return allHit ? "hit" : "miss";
}

function mergeMatchupProps(agg: BetAgg, games: unknown, board: NbaBoardGame[], cache: Map<string, ParsedBoxscoreGame | null>) {
  if (!Array.isArray(games)) return;
  const gameRows = games as GameRow[];
  const seenKeys = new Set<string>();

  for (const g of gameRows) {
    const bg = findBoardGame(board, g.home_abbr, g.away_abbr);
    if (!bg?.gameId) continue;
    const box = cache.get(bg.gameId);
    if (!box || !isGameFinal(box.gameStatus)) continue;

    const props: PlayerProp[] = [...(g.top_props ?? []), ...(g.risky_props ?? [])];
    for (const prop of props) {
      const spec = propLiveSpec(prop);
      if (!spec) continue;
      const dk = `${(prop.player || "").trim()}|${(prop.label || "").trim()}|${spec.stat}|${spec.threshold}`;
      if (seenKeys.has(dk)) continue;
      seenKeys.add(dk);
      const u = gradePropLegAgainstBox(prop as PropLeg, box);
      if (u === "skip") continue;
      addResult(agg, u);
    }
  }
}

function parlaySignature(legs: { player?: string; label?: string }[]): string {
  return legs
    .map((l) => `${(l.player || "").trim()}|${(l.label || "").trim()}`)
    .sort()
    .join(";");
}

async function gradeMixedSlip(
  m: MixedParlay,
  board: NbaBoardGame[],
  cache: Map<string, ParsedBoxscoreGame | null>,
): Promise<"hit" | "miss" | "skip"> {
  const ab = (m.team_pick?.pick_abbr || "").trim().toUpperCase();
  if (!ab) return "skip";
  const bg = findBoardGameForTeam(board, ab);
  if (!bg?.gameId || !gameRowIsFinal(bg)) return "skip";
  const win = winnerAbbr(bg);
  if (!win) return "skip";
  if (ab !== win) return "miss";

  const props: PlayerProp[] = [m.prop, m.prop2].filter((x): x is PlayerProp => x != null);
  for (const leg of props) {
    const team = (leg.team || "").trim();
    const tbg = team ? findBoardGameForTeam(board, team) : bg;
    if (!tbg?.gameId || !gameRowIsFinal(tbg)) return "skip";
    const box = await ensureBoxscore(tbg.gameId, cache);
    if (!box) return "skip";
    const u = gradePropLegAgainstBox(leg as PropLeg, box);
    if (u === "skip") return "skip";
    if (u === "miss") return "miss";
  }
  return "hit";
}

async function tryParlaySlip(
  agg: BetAgg,
  slip: ParlaySlip | null | undefined,
  seen: Set<string>,
  board: NbaBoardGame[],
  cache: Map<string, ParsedBoxscoreGame | null>,
) {
  if (!slip?.legs?.length) return;
  const sig = parlaySignature(slip.legs);
  if (seen.has(sig)) return;
  seen.add(sig);
  addResult(agg, await gradePropParlaySlip(slip.legs as PropLeg[], board, cache));
}

/**
 * Grades every published bet type in one nightly `report` vs `board` + boxscores.
 * Includes: game MLs, matchup props, each prop parlay slip (deduped by leg set), mixed slips, featured ML parlay.
 */
export async function gradeAllPublishedBetsForSlate(
  grading: MlGradingResult,
  report: Record<string, unknown>,
  board: NbaBoardGame[],
  cache: Map<string, ParsedBoxscoreGame | null>,
): Promise<BetAgg> {
  const agg: BetAgg = { hits: 0, misses: 0, total: 0 };

  await prefetchFinalBoxscoresForBoard(board, cache);

  mergeMlResolved(agg, grading);
  mergeMatchupProps(agg, report.games, board, cache);

  const parlays = report.parlays as ParlaysBlock | undefined;
  if (parlays) {
    const seenParlays = new Set<string>();

    const lists: ParlaySlip[] = [
      ...(parlays.safe ?? []),
      ...(parlays.safe_props ?? []),
      ...(parlays.risky ?? []),
      ...(parlays.risky_props ?? []),
      ...(parlays.sgp ?? []),
      ...(parlays.hot ?? []),
    ];
    for (const slip of lists) {
      await tryParlaySlip(agg, slip, seenParlays, board, cache);
    }

    await tryParlaySlip(agg, parlays.best_safe_prop ?? undefined, seenParlays, board, cache);
    await tryParlaySlip(agg, parlays.best_risky_prop ?? undefined, seenParlays, board, cache);

    for (const m of parlays.mixed ?? []) {
      addResult(agg, await gradeMixedSlip(m, board, cache));
    }

    addResult(agg, gradeBestTeamParlay(grading, parlays.best_team));
  }

  return agg;
}
