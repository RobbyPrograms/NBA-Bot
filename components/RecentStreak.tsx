"use client";

import { useCallback, useEffect, useState } from "react";
import type { RecentPickRow } from "@/lib/graded-stats-types";
import { getBrowserSupabase, isSupabaseBrowserConfigured } from "@/lib/supabase/browser-client";

function circleClass(result: string): string {
  if (result === "WIN") return "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]";
  if (result === "LOSS") return "bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.4)]";
  if (result === "PUSH") return "bg-zinc-400 dark:bg-zinc-500";
  if (result === "PENDING")
    return "bg-zinc-300 dark:bg-zinc-600 animate-pulse ring-2 ring-[var(--accent)]/40";
  return "bg-zinc-300 dark:bg-zinc-600";
}

function computeStreak(picks: RecentPickRow[]): string {
  const resolved = picks.filter((p) => p.result === "WIN" || p.result === "LOSS");
  if (resolved.length === 0) return "—";
  const first = resolved[0].result;
  let n = 0;
  for (const p of resolved) {
    if (p.result !== first) break;
    n++;
  }
  return first === "WIN" ? `W${n}` : `L${n}`;
}

export function RecentStreak() {
  const [picks, setPicks] = useState<RecentPickRow[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const sb = getBrowserSupabase();
    if (!sb) return;
    const { data, error } = await sb.from("recent_picks").select("*").limit(50);
    if (error) setErr(error.message);
    else {
      setErr(null);
      setPicks((data as RecentPickRow[]) ?? []);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const sb = getBrowserSupabase();
    if (!sb) return;
    const ch = sb
      .channel("recent_streak_refresh")
      .on("postgres_changes", { event: "*", schema: "public", table: "graded_picks" }, () => void load())
      .subscribe();
    return () => {
      void sb.removeChannel(ch);
    };
  }, [load]);

  if (!isSupabaseBrowserConfigured()) return null;

  const display = picks.slice(0, 10);
  const streak = computeStreak(picks);

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--card)]/60 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">Recent form</p>
        <p className="font-mono text-sm font-bold text-[var(--text)]">
          Streak: <span className="text-[var(--accent)]">{streak}</span>
        </p>
      </div>
      {err ? <p className="mt-1 text-xs text-rose-600 dark:text-rose-400">{err}</p> : null}
      <div className="mt-2 flex flex-wrap items-center gap-1.5" aria-label="Last ten pick results">
        {display.length === 0 ? (
          <span className="text-xs text-[var(--muted)]">No picks yet</span>
        ) : (
          display.map((p) => (
            <span
              key={p.id}
              title={`${p.slate_date} ${p.pick_type} ${p.pick_name} ${p.result}`}
              className={`inline-block h-3 w-3 rounded-full ${circleClass(p.result)}`}
            />
          ))
        )}
      </div>
      <p className="mt-1 text-[10px] text-[var(--muted)]">Green win · red loss · gray push · pulse = in progress</p>
    </div>
  );
}
