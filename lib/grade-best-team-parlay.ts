import type { MlGradingResult } from "@/lib/grade-ml-picks";

type BestTeamLeg = { pick_abbr?: string };
export type BestTeamParlayInput = { legs?: BestTeamLeg[] } | null | undefined;

/**
 * Hit = every leg's team won as predicted; miss = any leg wrong when all resolved.
 * skip = not all legs could be graded (schedule mismatch, games not final, etc.)
 */
export function gradeBestTeamParlay(
  grading: MlGradingResult,
  bestTeam: BestTeamParlayInput,
): "hit" | "miss" | "skip" {
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
