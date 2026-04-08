export type ParlayStatType = "PTS" | "REB" | "AST" | "FG3M" | "STL" | "BLK";

export interface TrackedParlayLeg {
  id: string;
  playerName: string;
  /** NBA tricode, e.g. DEN — used with today’s scoreboard to resolve gameId */
  teamAbbr: string;
  stat: ParlayStatType;
  /** Over line: hit when live stat >= threshold (e.g. 10 for 10+ rebounds) */
  threshold: number;
}

export interface TrackedParlay {
  id: string;
  name: string;
  legs: TrackedParlayLeg[];
}

export const PARLAY_STAT_LABELS: Record<ParlayStatType, string> = {
  PTS: "Points",
  REB: "Rebounds",
  AST: "Assists",
  FG3M: "3-pointers made",
  STL: "Steals",
  BLK: "Blocks",
};
