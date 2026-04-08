import type { ParlayStatType } from "@/lib/live-parlay-types";

/** Map predictor JSON `stat` field to live box score stat. */
export function mapApiStatToLive(stat: string | undefined): ParlayStatType | null {
  if (!stat || typeof stat !== "string") return null;
  const u = stat.trim().toUpperCase();
  if (u === "PTS" || u === "POINTS") return "PTS";
  if (u === "REB" || u === "REBOUNDS") return "REB";
  if (u === "AST" || u === "ASSISTS") return "AST";
  if (u === "FG3M" || u === "3PM" || u === "3PT" || u === "3PTS") return "FG3M";
  if (u === "STL" || u === "STEALS") return "STL";
  if (u === "BLK" || u === "BLOCKS") return "BLK";
  return null;
}

function statFromLabelSuffix(rest: string): ParlayStatType | null {
  const x = rest.toLowerCase().replace(/\s+/g, " ").trim();
  if (/\b3[\s-]*pm\b/.test(x)) return "FG3M";
  if (x.includes("three") && (x.includes("pointer") || x.includes("point"))) return "FG3M";
  if (x.includes("reb")) return "REB";
  if (x.includes("ast")) return "AST";
  if (x.includes("stl")) return "STL";
  if (x.includes("blk")) return "BLK";
  if (x.includes("pts") || x.includes("point")) return "PTS";
  return null;
}

/** Parse labels like "10+ Pts", "15+ Points", "1+ 3PM", "4+ Reb". */
export function parsePropLabelForLive(label: string): { threshold: number; stat: ParlayStatType } | null {
  const m = label.trim().match(/^(\d+(?:\.\d+)?)\s*\+\s*(.+)$/i);
  if (!m) return null;
  const th = Number(m[1]);
  if (!Number.isFinite(th) || th < 0) return null;
  const threshold = Math.floor(th);
  const stat = statFromLabelSuffix(m[2].trim());
  if (!stat) return null;
  return { threshold, stat };
}

export function propLiveSpec(prop: {
  label: string;
  stat?: string;
  threshold?: number | null;
}): { threshold: number; stat: ParlayStatType } | null {
  const fromApi = mapApiStatToLive(prop.stat);
  if (fromApi != null && prop.threshold != null && Number.isFinite(Number(prop.threshold))) {
    return { stat: fromApi, threshold: Math.max(0, Math.floor(Number(prop.threshold))) };
  }
  return parsePropLabelForLive(prop.label);
}
