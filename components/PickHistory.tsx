"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { RecentPickRow } from "@/lib/graded-stats-types";
import { getBrowserSupabase, isSupabaseBrowserConfigured } from "@/lib/supabase/browser-client";

type Filter = "all" | "ML" | "PROP" | "strong";

function gameLabel(p: RecentPickRow): string {
  const a = p.away_abbr || "?";
  const h = p.home_abbr || "?";
  return `${a} @ ${h}`;
}

function resultBadge(result: string) {
  if (result === "WIN")
    return (
      <span className="rounded-md bg-emerald-500/15 px-2 py-0.5 text-xs font-semibold text-emerald-700 dark:text-emerald-400">
        WIN
      </span>
    );
  if (result === "LOSS")
    return (
      <span className="rounded-md bg-rose-500/15 px-2 py-0.5 text-xs font-semibold text-rose-700 dark:text-rose-400">
        LOSS
      </span>
    );
  if (result === "PENDING")
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-zinc-500/15 px-2 py-0.5 text-xs font-semibold text-[var(--muted)]">
        <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--accent)]" />
        PENDING
      </span>
    );
  return (
    <span className="rounded-md bg-zinc-500/15 px-2 py-0.5 text-xs font-semibold text-[var(--muted)]">PUSH</span>
  );
}

export function PickHistory() {
  const [picks, setPicks] = useState<RecentPickRow[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
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
      .channel("pick_history_refresh")
      .on("postgres_changes", { event: "*", schema: "public", table: "graded_picks" }, () => void load())
      .subscribe();
    return () => {
      void sb.removeChannel(ch);
    };
  }, [load]);

  const filtered = useMemo(() => {
    let list = [...picks];
    if (filter === "ML") list = list.filter((p) => p.pick_type === "ML");
    if (filter === "PROP") list = list.filter((p) => p.pick_type === "PROP");
    if (filter === "strong") list = list.filter((p) => p.stars === "***");
    return list.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  }, [picks, filter]);

  if (!isSupabaseBrowserConfigured()) {
    return (
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-6">
        <p className="text-sm text-[var(--muted)]">Configure Supabase to show pick history.</p>
      </div>
    );
  }

  const tabs: { id: Filter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "ML", label: "ML" },
    { id: "PROP", label: "Props" },
    { id: "strong", label: "Strong only" },
  ];

  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-4 shadow-[var(--shadow-card)] sm:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h3 className="text-lg font-bold text-[var(--text)]">Pick history</h3>
        <div className="flex flex-wrap gap-1">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setFilter(t.id)}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                filter === t.id
                  ? "bg-[var(--accent)] text-white"
                  : "border border-[var(--border)] bg-[var(--surface-bg)] text-[var(--muted)] hover:border-[var(--accent)]/40"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <p className="mt-1 text-xs text-[var(--muted)]">Last 50 rows from recent_picks · newest first</p>
      {err ? <p className="mt-2 text-sm text-rose-600 dark:text-rose-400">{err}</p> : null}

      <div className="mt-4 overflow-x-auto rounded-xl border border-[var(--border)]">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="border-b border-[var(--border)] bg-[var(--card-inner)] text-[11px] font-semibold uppercase tracking-wide text-[var(--muted)]">
            <tr>
              <th className="px-3 py-2">Date</th>
              <th className="px-3 py-2">Game</th>
              <th className="px-3 py-2">Pick</th>
              <th className="px-3 py-2">Type</th>
              <th className="px-3 py-2">Model %</th>
              <th className="px-3 py-2">Edge</th>
              <th className="px-3 py-2">Line</th>
              <th className="px-3 py-2">Result</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)]">
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-[var(--muted)]">
                  No rows for this filter.
                </td>
              </tr>
            ) : (
              filtered.map((p) => {
                const modelPct =
                  p.model_prob != null && Number.isFinite(Number(p.model_prob))
                    ? `${(Number(p.model_prob) <= 1 ? Number(p.model_prob) * 100 : Number(p.model_prob)).toFixed(1)}%`
                    : "—";
                const edge =
                  p.market_edge != null && Number.isFinite(Number(p.market_edge))
                    ? `${(Number(p.market_edge) <= 1 ? Number(p.market_edge) * 100 : Number(p.market_edge)).toFixed(1)}pp`
                    : "—";
                const line =
                  p.market_line != null && Number.isFinite(Number(p.market_line)) ? String(p.market_line) : "—";
                const pickDisplay =
                  p.pick_type === "PROP"
                    ? `${p.pick_name}${p.pick_label ? ` · ${p.pick_label}` : ""}`
                    : p.pick_name;
                return (
                  <tr key={p.id} className="hover:bg-[var(--surface-bg)]/60">
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-[var(--muted)]">{p.slate_date}</td>
                    <td className="px-3 py-2 text-xs">{gameLabel(p)}</td>
                    <td className="max-w-[200px] truncate px-3 py-2 text-xs" title={pickDisplay}>
                      {pickDisplay}
                    </td>
                    <td className="px-3 py-2 text-xs">{p.pick_type}</td>
                    <td className="px-3 py-2 font-mono text-xs">{modelPct}</td>
                    <td className="px-3 py-2 font-mono text-xs">{edge}</td>
                    <td className="px-3 py-2 font-mono text-xs">{line}</td>
                    <td className="px-3 py-2">{resultBadge(p.result)}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
