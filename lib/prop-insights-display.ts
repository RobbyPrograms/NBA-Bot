/**
 * Display-only helpers for prop “notes” (stars, tiers, trends, opponent factor).
 * Does not change model math — only how strings and multipliers are shown.
 */

/** Remove asterisk runs used as internal star ratings; collapse whitespace. */
export function cleanInsightToken(input: string | undefined | null): string | undefined {
  if (input == null) return undefined;
  const t = input
    .replace(/\*+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > 0 ? t : undefined;
}

/** Join non-empty cleaned insight fragments with a middle dot. */
export function buildPropInsightHeadline(parts: (string | undefined | null)[]): string {
  return parts
    .map((p) => cleanInsightToken(typeof p === "string" ? p : undefined))
    .filter((x): x is string => Boolean(x))
    .join(" · ");
}

/**
 * `opp_factor` is a multiplier on the raw hit estimate vs this opponent (1.0 = neutral).
 * Shown as a percentage so it reads like “how hard this matchup is” without changing the number.
 */
export function formatOpponentWeightLine(mult: number): string {
  const pct = Math.round(mult * 100);
  return `Matchup weight ${pct}% (100% = average opponent)`;
}

/** Longer explanation for hover / title attributes. */
export function opponentWeightTitle(mult: number): string {
  const pct = Math.round(mult * 100);
  const delta = Math.round((mult - 1) * 100);
  const skew =
    delta === 0
      ? "neutral vs the model’s typical opponent."
      : delta < 0
        ? `about ${Math.abs(delta)}% stricter than an average matchup for this prop.`
        : `about ${delta}% more favorable than an average matchup for this prop.`;
  return `The pipeline scales the raw hit estimate by ${pct}% for this opponent — ${skew} Underlying multiplier in data: ${mult.toFixed(2)}.`;
}
