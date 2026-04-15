"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { DailyStatRow } from "@/lib/graded-stats-types";
import { getBrowserSupabase, isSupabaseBrowserConfigured } from "@/lib/supabase/browser-client";

type Row = DailyStatRow & { cumPnl: number; label: string };

export function DailyChart() {
  const [rows, setRows] = useState<DailyStatRow[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const sb = getBrowserSupabase();
    if (!sb) return;
    const { data, error } = await sb
      .from("daily_stats")
      .select("*")
      .order("slate_date", { ascending: false })
      .limit(30);
    if (error) setErr(error.message);
    else {
      setErr(null);
      setRows((data as DailyStatRow[]) ?? []);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const sb = getBrowserSupabase();
    if (!sb) return;
    const ch = sb
      .channel("daily_chart_refresh")
      .on("postgres_changes", { event: "*", schema: "public", table: "graded_picks" }, () => void load())
      .subscribe();
    return () => {
      void sb.removeChannel(ch);
    };
  }, [load]);

  const chartData = useMemo(() => {
    const asc = [...rows].reverse();
    let cum = 0;
    return asc.map((r) => {
      cum += Number(r.daily_pnl ?? 0);
      return {
        ...r,
        cumPnl: Math.round(cum * 100) / 100,
        label: String(r.slate_date).slice(5),
        hit: r.hit_rate == null ? 0 : Number(r.hit_rate),
      } as Row & { hit: number };
    });
  }, [rows]);

  if (!isSupabaseBrowserConfigured()) {
    return (
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-6">
        <p className="text-sm text-[var(--muted)]">Configure Supabase env to load daily performance.</p>
      </div>
    );
  }

  if (err) {
    return (
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-6">
        <p className="text-sm text-rose-600 dark:text-rose-400">{err}</p>
      </div>
    );
  }

  if (chartData.length === 0) {
    return (
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-6">
        <h3 className="text-lg font-bold text-[var(--text)]">Daily performance</h3>
        <p className="mt-2 text-sm text-[var(--muted)]">No graded days yet.</p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-4 shadow-[var(--shadow-card)] sm:p-6">
      <h3 className="text-lg font-bold text-[var(--text)]">Daily performance (30d)</h3>
      <p className="mt-1 text-xs text-[var(--muted)]">Bars = day hit rate % · line = cumulative P&amp;L ($100 flat model)</p>
      <div className="mt-4 h-[280px] w-full min-w-0">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-[var(--border)]" opacity={0.5} />
            <XAxis dataKey="label" tick={{ fill: "var(--muted)", fontSize: 10 }} />
            <YAxis
              yAxisId="hit"
              domain={[0, 100]}
              tick={{ fill: "var(--muted)", fontSize: 10 }}
              label={{ value: "Hit %", angle: -90, position: "insideLeft", fill: "var(--muted)", fontSize: 10 }}
            />
            <YAxis
              yAxisId="pnl"
              orientation="right"
              tick={{ fill: "var(--muted)", fontSize: 10 }}
              label={{ value: "Cum $", angle: 90, position: "insideRight", fill: "var(--muted)", fontSize: 10 }}
            />
            <Tooltip
              contentStyle={{
                background: "var(--card-inner)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                fontSize: 12,
              }}
              formatter={(value: number, name: string) => {
                if (name === "hit") return [`${value.toFixed(1)}%`, "Hit rate"];
                if (name === "cumPnl") return [`$${value.toFixed(2)}`, "Cumulative P&L"];
                return [value, name];
              }}
              labelFormatter={(_, payload) => (payload?.[0]?.payload?.slate_date as string) ?? ""}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Bar yAxisId="hit" dataKey="hit" name="Day hit %" radius={[4, 4, 0, 0]}>
              {chartData.map((entry) => (
                <Cell
                  key={entry.slate_date}
                  fill={entry.hit >= 50 ? "rgb(16, 185, 129)" : entry.hit < 50 ? "rgb(244, 63, 94)" : "rgb(113, 113, 122)"}
                />
              ))}
            </Bar>
            <Line yAxisId="pnl" type="monotone" dataKey="cumPnl" name="Cumulative P&L" stroke="var(--accent-2)" dot={false} strokeWidth={2} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
