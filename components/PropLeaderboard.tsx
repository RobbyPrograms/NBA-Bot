"use client";

import { useCallback, useEffect, useState } from "react";
import type { PlayerPropStatRow } from "@/lib/graded-stats-types";
import { getBrowserSupabase, isSupabaseBrowserConfigured } from "@/lib/supabase/browser-client";
import { formatHitRatePct, propHitTone, toneText } from "@/lib/stats-format";

export function PropLeaderboard() {
  const [rows, setRows] = useState<PlayerPropStatRow[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const sb = getBrowserSupabase();
    if (!sb) return;
    const { data, error } = await sb
      .from("player_prop_stats")
      .select("*")
      .gte("total_graded", 3)
      .order("hit_rate", { ascending: false })
      .limit(20);
    if (error) setErr(error.message);
    else {
      setErr(null);
      setRows((data as PlayerPropStatRow[]) ?? []);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const sb = getBrowserSupabase();
    if (!sb) return;
    const ch = sb
      .channel("prop_lb_refresh")
      .on("postgres_changes", { event: "*", schema: "public", table: "graded_picks" }, () => void load())
      .subscribe();
    return () => {
      void sb.removeChannel(ch);
    };
  }, [load]);

  if (!isSupabaseBrowserConfigured()) {
    return (
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-6">
        <p className="text-sm text-[var(--muted)]">Configure Supabase for prop leaderboard.</p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-4 shadow-[var(--shadow-card)] sm:p-6">
      <h3 className="text-lg font-bold text-[var(--text)]">Prop accuracy leaderboard</h3>
      <p className="mt-1 text-xs text-[var(--muted)]">Top 20 by hit rate · min 3 graded props per player/stat</p>
      {err ? <p className="mt-2 text-sm text-rose-600 dark:text-rose-400">{err}</p> : null}

      <div className="mt-4 overflow-x-auto rounded-xl border border-[var(--border)]">
        <table className="w-full min-w-[520px] text-left text-sm">
          <thead className="border-b border-[var(--border)] bg-[var(--card-inner)] text-[11px] font-semibold uppercase tracking-wide text-[var(--muted)]">
            <tr>
              <th className="px-3 py-2">Player</th>
              <th className="px-3 py-2">Stat</th>
              <th className="px-3 py-2">Hit rate</th>
              <th className="px-3 py-2">Graded</th>
              <th className="px-3 py-2">Avg model %</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)]">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-[var(--muted)]">
                  No prop stats yet.
                </td>
              </tr>
            ) : (
              rows.map((r, i) => {
                const tone = propHitTone(r.hit_rate);
                return (
                  <tr key={`${r.player_name}-${r.stat_type}-${i}`} className="hover:bg-[var(--surface-bg)]/60">
                    <td className="px-3 py-2 font-medium text-[var(--text)]">{r.player_name}</td>
                    <td className="px-3 py-2 text-xs text-[var(--muted)]">{r.stat_type ?? "—"}</td>
                    <td className={`px-3 py-2 font-mono text-sm font-semibold ${toneText[tone]}`}>
                      {formatHitRatePct(r.hit_rate)}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{r.total_graded ?? "—"}</td>
                    <td className="px-3 py-2 font-mono text-xs">
                      {r.avg_model_confidence != null ? `${Number(r.avg_model_confidence).toFixed(1)}%` : "—"}
                    </td>
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
