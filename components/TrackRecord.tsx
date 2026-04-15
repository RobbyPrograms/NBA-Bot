"use client";

import { useCallback, useEffect, useState } from "react";
import type { PickStatsRow } from "@/lib/graded-stats-types";
import { getBrowserSupabase, isSupabaseBrowserConfigured } from "@/lib/supabase/browser-client";
import { formatHitRatePct, hitRateTonePct, toneText } from "@/lib/stats-format";

function StatBlock({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone: "good" | "mid" | "bad" | "muted";
}) {
  return (
    <div>
      <p className="text-[10px] font-bold uppercase tracking-wide text-[var(--accent-2)]">{label}</p>
      <p className={`font-mono text-2xl font-bold tabular-nums sm:text-3xl ${toneText[tone]}`}>{value}</p>
      {sub ? <p className="mt-0.5 text-[11px] text-[var(--muted)]">{sub}</p> : null}
    </div>
  );
}

export function TrackRecord() {
  const [stats, setStats] = useState<PickStatsRow | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const sb = getBrowserSupabase();
    if (!sb) {
      setLoadError("missing_env");
      setStats(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    const { data, error } = await sb.from("pick_stats").select("*").maybeSingle();
    if (error) {
      setLoadError(error.message);
      setStats(null);
    } else {
      setLoadError(null);
      setStats(data as PickStatsRow);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const sb = getBrowserSupabase();
    if (!sb) return;
    const channel = sb
      .channel("pick_stats_refresh")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "graded_picks" },
        () => {
          void load();
        },
      )
      .subscribe();
    return () => {
      void sb.removeChannel(channel);
    };
  }, [load]);

  if (!isSupabaseBrowserConfigured()) {
    return (
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface-bg)]/80 p-5 backdrop-blur-sm dark:bg-black/40">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">Graded track record</p>
        <p className="mt-2 text-sm text-[var(--muted)]">
          Add <code className="rounded bg-[var(--card-inner)] px-1 font-mono text-xs">NEXT_PUBLIC_SUPABASE_URL</code>{" "}
          and{" "}
          <code className="rounded bg-[var(--card-inner)] px-1 font-mono text-xs">NEXT_PUBLIC_SUPABASE_ANON_KEY</code>{" "}
          to your Vercel env to load live stats from <code className="font-mono text-xs">pick_stats</code>.
        </p>
      </div>
    );
  }

  if (loading && !stats) {
    return (
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface-bg)]/80 p-5 backdrop-blur-sm dark:bg-black/40">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">Graded track record</p>
        <p className="mt-3 text-sm text-[var(--muted)]">Loading stats…</p>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface-bg)]/80 p-5 backdrop-blur-sm dark:bg-black/40">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-200">
          Graded track record
        </p>
        <p className="mt-2 text-sm text-amber-800 dark:text-amber-200/90">Could not load pick_stats: {loadError}</p>
      </div>
    );
  }

  const resolved = (stats?.total_wins ?? 0) + (stats?.total_losses ?? 0);
  const lifetime = stats?.lifetime_hit_rate ?? null;
  const lifetimeTone = resolved === 0 ? "muted" : hitRateTonePct(lifetime);

  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface-bg)]/80 p-5 backdrop-blur-sm dark:bg-black/40">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">Graded track record</p>
      <p className="mt-1 text-[10px] text-[var(--muted)]">
        Live from Supabase · Results typically after morning grade (~10am ET)
      </p>

      {resolved === 0 ? (
        <p className="mt-3 text-sm text-[var(--muted)]">No graded picks yet (WIN/LOSS). Pending rows update after grading.</p>
      ) : null}

      <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-5">
        <div className="col-span-2 sm:col-span-1">
          <p className="text-[10px] font-bold uppercase tracking-wide text-[var(--accent-2)]">Lifetime</p>
          <p className={`font-mono text-4xl font-bold tabular-nums sm:text-5xl ${toneText[lifetimeTone]}`}>
            {resolved === 0 ? "—" : formatHitRatePct(lifetime)}
          </p>
          <p className="mt-1 text-xs font-medium text-[var(--text)]">Hit rate (ML + props, excl. pending)</p>
          <p className="mt-0.5 text-[11px] text-[var(--muted)]">
            {stats?.total_wins ?? 0}W · {stats?.total_losses ?? 0}L
            {(stats?.total_pushes ?? 0) > 0 ? ` · ${stats?.total_pushes} push` : ""}
            {` · ${resolved} graded`}
          </p>
        </div>

        <div className="col-span-2 sm:col-span-1">
          <StatBlock
            label="Last 7 days"
            value={(stats?.last_7d_graded ?? 0) === 0 ? "—" : formatHitRatePct(stats?.last_7d_hit_rate)}
            sub={
              (stats?.last_7d_graded ?? 0) === 0
                ? "No closed grades in this window"
                : `${stats?.last_7d_graded ?? 0} picks (7d)`
            }
            tone={(stats?.last_7d_graded ?? 0) === 0 ? "muted" : hitRateTonePct(stats?.last_7d_hit_rate)}
          />
        </div>

        <StatBlock
          label="ML only"
          value={(stats?.ml_graded ?? 0) === 0 ? "—" : formatHitRatePct(stats?.ml_hit_rate)}
          sub={(stats?.ml_graded ?? 0) === 0 ? "No ML grades" : `${stats?.ml_graded ?? 0} graded`}
          tone={(stats?.ml_graded ?? 0) === 0 ? "muted" : hitRateTonePct(stats?.ml_hit_rate)}
        />

        <StatBlock
          label="Props only"
          value={(stats?.props_graded ?? 0) === 0 ? "—" : formatHitRatePct(stats?.props_hit_rate)}
          sub={(stats?.props_graded ?? 0) === 0 ? "No prop grades" : `${stats?.props_graded ?? 0} graded`}
          tone={(stats?.props_graded ?? 0) === 0 ? "muted" : hitRateTonePct(stats?.props_hit_rate)}
        />

        <StatBlock
          label="Strong (***)"
          value={(stats?.strong_graded ?? 0) === 0 ? "—" : formatHitRatePct(stats?.strong_hit_rate)}
          sub={(stats?.strong_graded ?? 0) === 0 ? "No strong-tier grades" : `${stats?.strong_graded ?? 0} graded`}
          tone={(stats?.strong_graded ?? 0) === 0 ? "muted" : hitRateTonePct(stats?.strong_hit_rate)}
        />

        <div>
          <p className="text-[10px] font-bold uppercase tracking-wide text-[var(--accent-2)]">Graded picks</p>
          <p className="font-mono text-2xl font-bold tabular-nums text-[var(--text)] sm:text-3xl">
            {String(stats?.total_graded ?? 0)}
          </p>
          <p className="mt-0.5 text-[11px] text-[var(--muted)]">
            {(stats?.total_pending ?? 0) > 0 ? `${stats?.total_pending} still pending` : "Win + loss + push"}
          </p>
        </div>

        <div>
          <p className="text-[10px] font-bold uppercase tracking-wide text-[var(--accent-2)]">ROI (flat $100)</p>
          <p
            className={`font-mono text-2xl font-bold tabular-nums sm:text-3xl ${
              stats?.roi_flat_100 == null
                ? toneText.muted
                : Number(stats.roi_flat_100) >= 0
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-rose-600 dark:text-rose-400"
            }`}
          >
            {stats?.roi_flat_100 == null ? "—" : `$${Number(stats.roi_flat_100).toFixed(0)}`}
          </p>
          <p className="mt-0.5 text-[11px] text-[var(--muted)]">Model vs market_prob where set</p>
        </div>
      </div>

      {(stats?.last_30d_graded ?? 0) > 0 ? (
        <p className="mt-3 text-[11px] text-[var(--muted)]">
          Last 30d: {formatHitRatePct(stats?.last_30d_hit_rate)} on {stats?.last_30d_graded} picks
        </p>
      ) : null}

      <p className="mt-3 text-[10px] leading-relaxed text-[var(--muted)]">
        Entertainment only. Not financial advice. <code className="font-mono text-[9px]">graded_picks</code> +{" "}
        <code className="font-mono text-[9px]">pick_stats</code> view.
      </p>
    </div>
  );
}
