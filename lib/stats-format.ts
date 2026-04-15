/** pick_stats returns rates as 0–100 (e.g. 61.4), not 0–1. */
export function formatHitRatePct(n: number | null | undefined): string {
  if (n == null || Number.isNaN(Number(n))) return "—";
  return `${Number(n).toFixed(1)}%`;
}

export function hitRateTonePct(rate: number | null | undefined): "good" | "mid" | "bad" | "muted" {
  if (rate == null || Number.isNaN(Number(rate))) return "muted";
  const r = Number(rate);
  if (r > 55) return "good";
  if (r >= 50) return "mid";
  return "bad";
}

export function propHitTone(rate: number | null | undefined): "good" | "mid" | "bad" | "muted" {
  if (rate == null || Number.isNaN(Number(rate))) return "muted";
  const r = Number(rate);
  if (r >= 70) return "good";
  if (r >= 55) return "mid";
  return "bad";
}

export const toneText: Record<"good" | "mid" | "bad" | "muted", string> = {
  good: "text-emerald-600 dark:text-emerald-400",
  mid: "text-amber-600 dark:text-amber-300",
  bad: "text-rose-600 dark:text-rose-400",
  muted: "text-[var(--muted)]",
};
