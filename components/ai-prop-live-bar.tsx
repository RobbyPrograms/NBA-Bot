"use client";

import { useLiveNbaOptional } from "@/components/live-nba-context";

function statAbbrev(stat: string): string {
  switch (stat) {
    case "PTS":
      return "PTS";
    case "REB":
      return "REB";
    case "AST":
      return "AST";
    case "FG3M":
      return "3PM";
    case "STL":
      return "STL";
    case "BLK":
      return "BLK";
    default:
      return stat;
  }
}

/**
 * Live progress toward an AI prop line (NBA.com box score via app proxy). Renders nothing if the label
 * is not a supported over (e.g. unparseable) or live context is missing.
 */
export function AiPropLiveBar({
  player,
  teamAbbr,
  label,
  stat,
  threshold,
  dense = false,
}: {
  player: string;
  teamAbbr: string;
  label: string;
  stat?: string;
  threshold?: number | null;
  dense?: boolean;
}) {
  const ctx = useLiveNbaOptional();
  if (!ctx) return null;

  const ui = ctx.getPropLive(player, teamAbbr, { label, stat, threshold });
  if (ui.kind !== "live") return null;

  const { current, threshold: th, hit, finalMiss, statusShort, loading, stat: statKey } = ui;
  const pctFill =
    hit || finalMiss ? 100 : th > 0 && current != null ? Math.min(100, (current / th) * 100) : 0;
  const barColor = hit ? "bg-emerald-500" : finalMiss ? "bg-red-500" : "bg-emerald-500/90";
  const valueText = current == null ? "—" : String(current);

  const textCls = dense ? "text-[10px]" : "text-[11px]";
  const barH = dense ? "h-1.5" : "h-2";

  return (
    <div className={`mt-1.5 ${dense ? "max-w-[220px]" : "max-w-full"}`}>
      <div className={`flex flex-wrap items-center gap-2 ${textCls} text-[var(--muted)]`}>
        {ctx.livePulse ? (
          <span className="font-mono uppercase tracking-wide text-emerald-600 dark:text-emerald-400">Live</span>
        ) : null}
        <span className="font-mono tabular-nums text-[var(--text)]">
          {valueText}/{th} {statAbbrev(statKey)}
        </span>
        <span className="min-w-0 truncate font-mono text-[var(--muted)]">{statusShort}</span>
      </div>
      <div className={`mt-1 flex items-center gap-1.5 ${barH === "h-1.5" ? "" : ""}`}>
        <div
          className={`min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--border)] ${loading ? "animate-pulse" : ""}`}
        >
          <div
            className={`${barH} rounded-full transition-all duration-500 ease-out ${barColor}`}
            style={{ width: `${pctFill}%` }}
          />
        </div>
        {hit && (
          <span
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-[10px] font-bold text-white"
            aria-label="Line hit"
          >
            ✓
          </span>
        )}
      </div>
    </div>
  );
}
