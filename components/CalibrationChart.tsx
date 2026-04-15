"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CartesianGrid,
  ComposedChart,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { CalibrationStatRow } from "@/lib/graded-stats-types";
import { getBrowserSupabase, isSupabaseBrowserConfigured } from "@/lib/supabase/browser-client";

const BUCKET_ORDER = ["50-55%", "55-60%", "60-65%", "65-70%", "70-75%", "75%+"];

function sortBuckets(rows: CalibrationStatRow[]): CalibrationStatRow[] {
  return [...rows].sort(
    (a, b) => BUCKET_ORDER.indexOf(String(a.confidence_bucket)) - BUCKET_ORDER.indexOf(String(b.confidence_bucket)),
  );
}

export function CalibrationChart() {
  const [rows, setRows] = useState<CalibrationStatRow[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const sb = getBrowserSupabase();
    if (!sb) return;
    const { data, error } = await sb.from("calibration_stats").select("*");
    if (error) setErr(error.message);
    else {
      setErr(null);
      setRows(sortBuckets((data as CalibrationStatRow[])?.filter((r) => r.confidence_bucket) ?? []));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const chartPoints = useMemo(
    () =>
      rows.map((r) => ({
        bucket: r.confidence_bucket,
        x: r.avg_model_confidence != null ? Number(r.avg_model_confidence) : 0,
        y: r.actual_hit_rate != null ? Number(r.actual_hit_rate) : 0,
        n: r.n_picks ?? 0,
      })),
    [rows],
  );

  if (!isSupabaseBrowserConfigured()) {
    return (
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-6">
        <p className="text-sm text-[var(--muted)]">Add public Supabase env vars to render calibration.</p>
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

  if (chartPoints.length === 0) {
    return (
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-6">
        <h3 className="text-lg font-bold text-[var(--text)]">Model calibration</h3>
        <p className="mt-2 text-sm text-[var(--muted)]">Not enough graded picks to build buckets yet.</p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-4 shadow-[var(--shadow-card)] sm:p-6">
      <h3 className="text-lg font-bold text-[var(--text)]">Model calibration</h3>
      <p className="mt-1 text-xs text-[var(--muted)]">
        Each point: average model confidence (X) vs actual hit rate (Y) for that bucket. Diagonal = perfect
        calibration (Kelly trustworthy when close).
      </p>
      <div className="mt-4 h-[300px] w-full min-w-0">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartPoints} margin={{ top: 8, right: 16, bottom: 48, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-[var(--border)]" opacity={0.5} />
            <XAxis
              type="number"
              dataKey="x"
              name="Avg model %"
              domain={[45, 95]}
              tick={{ fill: "var(--muted)", fontSize: 10 }}
              label={{ value: "Avg model confidence %", position: "bottom", offset: 28, fill: "var(--muted)", fontSize: 11 }}
            />
            <YAxis
              type="number"
              dataKey="y"
              domain={[40, 100]}
              tick={{ fill: "var(--muted)", fontSize: 10 }}
              label={{ value: "Actual hit %", angle: -90, position: "insideLeft", fill: "var(--muted)", fontSize: 11 }}
            />
            <Tooltip
              contentStyle={{
                background: "var(--card-inner)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                fontSize: 12,
              }}
              formatter={(v: number, name: string, props) => {
                if (name === "y") return [`${v.toFixed(1)}%`, "Actual hit rate"];
                if (name === "x") return [`${v.toFixed(1)}%`, "Avg model conf."];
                return [v, name];
              }}
              labelFormatter={(_, p) => (p?.[0]?.payload?.bucket as string) ?? ""}
            />
            <ReferenceLine
              segment={[
                { x: 50, y: 50 },
                { x: 92, y: 92 },
              ]}
              stroke="var(--muted)"
              strokeDasharray="5 5"
              strokeWidth={1.5}
            />
            <Scatter fill="var(--accent)" name="Buckets" />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <ul className="mt-2 grid gap-1 text-[11px] text-[var(--muted)] sm:grid-cols-2">
        {rows.map((r) => (
          <li key={String(r.confidence_bucket)}>
            <span className="font-mono text-[var(--text)]">{r.confidence_bucket}</span>: n={r.n_picks} · actual{" "}
            {r.actual_hit_rate != null ? `${r.actual_hit_rate}%` : "—"} · err{" "}
            {r.calibration_error != null ? `${r.calibration_error}%` : "—"}
          </li>
        ))}
      </ul>
    </div>
  );
}
