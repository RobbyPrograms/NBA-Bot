"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { ParsedBoxscoreGame, ScoreboardGameRow } from "@/lib/nba-live";
import { fetchLiveBoxscoresForAbbrs, makeGetPropLive, type LivePropUi } from "@/lib/live-nba-lookup";

const POLL_MS = 45_000;

export type LivePropInput = { label: string; stat?: string; threshold?: number | null };

type Ctx = {
  getPropLive: (player: string, teamAbbr: string, prop: LivePropInput) => LivePropUi;
  liveError: string | null;
  /** True when the report references at least one team (polling active). */
  livePulse: boolean;
};

const LiveNbaContext = createContext<Ctx | null>(null);

export function LiveNbaProvider({ teamAbbrs, children }: { teamAbbrs: string[]; children: ReactNode }) {
  const [sbGames, setSbGames] = useState<ScoreboardGameRow[]>([]);
  const [boxById, setBoxById] = useState<Map<string, ParsedBoxscoreGame>>(() => new Map());
  const [liveError, setLiveError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const key = useMemo(
    () =>
      [...new Set(teamAbbrs.map((a) => a.trim().toUpperCase()).filter(Boolean))]
        .sort()
        .join(","),
    [teamAbbrs],
  );

  const load = useCallback(async () => {
    const list = key ? key.split(",") : [];
    if (list.length === 0) {
      setSbGames([]);
      setBoxById(new Map());
      setLiveError(null);
      return;
    }
    const { sbGames: sg, boxById: bx, error } = await fetchLiveBoxscoresForAbbrs(list);
    setSbGames(sg);
    setBoxById(bx);
    setLiveError(error);
  }, [key]);

  useEffect(() => {
    void load();
  }, [load, tick]);

  useEffect(() => {
    if (!key) return;
    const id = window.setInterval(() => setTick((x) => x + 1), POLL_MS);
    return () => window.clearInterval(id);
  }, [key]);

  const getPropLive = useMemo(() => makeGetPropLive(sbGames, boxById), [sbGames, boxById]);
  const livePulse = key.length > 0;

  const value = useMemo(
    () => ({ getPropLive, liveError, livePulse }),
    [getPropLive, liveError, livePulse],
  );

  return <LiveNbaContext.Provider value={value}>{children}</LiveNbaContext.Provider>;
}

export function useLiveNbaOptional(): Ctx | null {
  return useContext(LiveNbaContext);
}

export function LiveNbaErrorBanner() {
  const ctx = useLiveNbaOptional();
  if (!ctx?.liveError) return null;
  return (
    <p className="rounded-lg border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-100">
      Live box scores: {ctx.liveError}
    </p>
  );
}
