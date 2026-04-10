"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type PropSlice = { hits: number; misses: number; total: number; pct: number | null };

type TrackPayload = {
  ok: boolean;
  configured?: boolean;
  ml?: { hits: number; misses: number; total: number; pct: number | null };
  team_parlay?: { hits: number; total: number; pct: number | null };
  props?: { lifetime: PropSlice; last7: PropSlice };
  slates_used?: number;
  disclaimer?: string;
};

function pctDisplay(p: number | null | undefined): string {
  if (p == null || Number.isNaN(p)) return "—";
  return `${(p * 100).toFixed(1)}%`;
}

export function LandingHero() {
  const [tr, setTr] = useState<TrackPayload | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/rolibot/track-record", { cache: "no-store" });
        const j = (await res.json()) as TrackPayload;
        if (!cancelled) setTr(j);
      } catch {
        if (!cancelled) setTr({ ok: false });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const ml = tr?.ml;
  const parlay = tr?.team_parlay;
  const propsLife = tr?.props?.lifetime;
  const props7 = tr?.props?.last7;
  const showStats =
    tr?.ok &&
    tr?.configured &&
    ((ml && ml.total > 0) ||
      (propsLife && propsLife.total > 0) ||
      (parlay && parlay.total > 0));

  return (
    <section
      className="relative overflow-hidden rounded-3xl border border-[var(--border)] bg-gradient-to-br from-[var(--card)] via-[var(--card-inner)] to-[var(--card)] p-6 shadow-[var(--shadow-md)] sm:p-10"
      aria-labelledby="hero-heading"
    >
      <div
        className="pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full bg-[var(--accent)]/15 blur-3xl"
        aria-hidden
      />
      <div
        className="pointer-events-none absolute -bottom-20 -left-20 h-56 w-56 rounded-full bg-[var(--accent-2)]/10 blur-3xl"
        aria-hidden
      />

      <div className="relative grid gap-10 lg:grid-cols-[1.15fr_1fr] lg:gap-12">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--accent-2)]">
            NBA · ensemble ML · live slate
          </p>
          <h2
            id="hero-heading"
            className="mt-3 text-3xl font-bold leading-tight tracking-tight text-[var(--text)] sm:text-4xl md:text-[2.5rem]"
          >
            Sharper picks.{" "}
            <span className="bg-gradient-to-r from-[var(--accent)] to-[var(--accent-2)] bg-clip-text text-transparent">
              Real math.
            </span>{" "}
            Tonight&apos;s edge.
          </h2>
          <p className="mt-4 max-w-xl text-base leading-relaxed text-[var(--muted)] sm:text-lg">
            Stack calibrated models on the full board—moneylines, props, optional book cross-checks—built for fans who
            want research-grade output, not hype posts.
          </p>

          <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
            <a
              href="#tonights-picks"
              className="inline-flex items-center justify-center rounded-xl bg-gradient-to-r from-[var(--accent)] to-[var(--accent-2)] px-6 py-3.5 text-sm font-semibold text-white shadow-lg shadow-[var(--accent)]/25 transition hover:opacity-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-2)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface-bg)]"
            >
              View tonight&apos;s picks
            </a>
            <Link
              href="/how-it-works#start-free"
              className="inline-flex items-center justify-center rounded-xl border-2 border-[var(--accent)]/50 bg-transparent px-6 py-3.5 text-sm font-semibold text-[var(--accent)] transition hover:bg-[var(--accent)]/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface-bg)]"
            >
              Start free trial
            </Link>
            <Link
              href="/history"
              className="text-center text-sm font-medium text-[var(--muted)] underline-offset-4 hover:text-[var(--accent-2)] hover:underline sm:text-left"
            >
              Past slates &amp; results →
            </Link>
          </div>
          <p className="mt-3 text-xs text-[var(--muted)]">
            Live board is free to browse. Trial section explains what&apos;s included today and what&apos;s next.
          </p>
        </div>

        <div className="flex flex-col gap-4">
          {showStats ? (
            <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface-bg)]/80 p-5 backdrop-blur-sm dark:bg-black/40">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">
                Graded track record
              </p>
              <div className="mt-4 grid grid-cols-2 gap-4">
                <div>
                  <p className="font-mono text-4xl font-bold tabular-nums text-[var(--accent)] sm:text-5xl">
                    {ml && ml.total > 0 ? pctDisplay(ml.pct) : "—"}
                  </p>
                  <p className="mt-1 text-xs font-medium text-[var(--text)]">ML pick accuracy</p>
                  <p className="mt-0.5 text-[11px] text-[var(--muted)]">
                    {ml && ml.total > 0
                      ? `${ml.hits}W · ${ml.misses}L · ${ml.total} picks`
                      : "No graded ML rows yet"}
                  </p>
                </div>
                <div>
                  <p className="font-mono text-2xl font-bold tabular-nums text-[var(--accent-2)] sm:text-3xl">
                    {parlay && parlay.total > 0 ? pctDisplay(parlay.pct) : "—"}
                  </p>
                  <p className="mt-1 text-xs font-medium text-[var(--text)]">Featured ML parlay</p>
                  <p className="mt-0.5 text-[11px] leading-snug text-[var(--muted)]">
                    {parlay && parlay.total > 0
                      ? `${parlay.hits}/${parlay.total} resolved (nightly best-team combo)`
                      : "Not enough graded parlays yet"}
                  </p>
                </div>
                <div>
                  <p className="font-mono text-2xl font-bold tabular-nums text-[var(--accent)] sm:text-3xl">
                    {propsLife && propsLife.total > 0 ? pctDisplay(propsLife.pct) : "—"}
                  </p>
                  <p className="mt-1 text-xs font-medium text-[var(--text)]">Props hit rate (lifetime)</p>
                  <p className="mt-0.5 text-[11px] text-[var(--muted)]">
                    {propsLife && propsLife.total > 0
                      ? `${propsLife.hits}H · ${propsLife.misses}M · ${propsLife.total} graded`
                      : "No resolved props in saved slates yet"}
                  </p>
                </div>
                <div>
                  <p className="font-mono text-2xl font-bold tabular-nums text-[var(--accent-2)] sm:text-3xl">
                    {props7 && props7.total > 0 ? pctDisplay(props7.pct) : "—"}
                  </p>
                  <p className="mt-1 text-xs font-medium text-[var(--text)]">Props (last 7 days)</p>
                  <p className="mt-0.5 text-[11px] text-[var(--muted)]">
                    {props7 && props7.total > 0
                      ? `${props7.hits}H · ${props7.misses}M · ${props7.total} graded`
                      : "Nothing final in this window yet"}
                  </p>
                </div>
              </div>
              {tr?.slates_used != null ? (
                <p className="mt-3 text-[10px] text-[var(--muted)]">Across {tr.slates_used} saved slate(s) in history.</p>
              ) : null}
            </div>
          ) : (
            <div className="rounded-2xl border border-dashed border-[var(--border)] bg-[var(--card-inner)]/50 p-5">
              <p className="text-sm font-medium text-[var(--text)]">Track record unlocks with history</p>
              <p className="mt-2 text-xs leading-relaxed text-[var(--muted)]">
                Once slates are saved to Supabase and games go final, we show graded accuracy here—moneylines vs finals,
                player props vs box scores, and the featured 2-leg ML parlay when it resolves.
              </p>
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-xl border border-[var(--border)] bg-[var(--card)]/90 p-4 shadow-[var(--shadow-sm)]">
              <p className="text-[11px] font-bold uppercase tracking-wide text-[var(--accent)]">What is this?</p>
              <p className="mt-2 text-sm leading-snug text-[var(--muted)]">
                A live NBA research desk: calibrated ensemble model, injury-filtered props, optional sportsbook
                validation—packaged for quick decisions.
              </p>
            </div>
            <div className="rounded-xl border border-[var(--border)] bg-[var(--card)]/90 p-4 shadow-[var(--shadow-sm)]">
              <p className="text-[11px] font-bold uppercase tracking-wide text-[var(--accent)]">Why trust it?</p>
              <p className="mt-2 text-sm leading-snug text-[var(--muted)]">
                Real league data, published methodology, and a running scoreboard of how picks performed after final
                buzzers—not vibes.
              </p>
            </div>
            <div className="rounded-xl border border-[var(--border)] bg-[var(--card)]/90 p-4 shadow-[var(--shadow-sm)]">
              <p className="text-[11px] font-bold uppercase tracking-wide text-[var(--accent)]">Why pay?</p>
              <p className="mt-2 text-sm leading-snug text-[var(--muted)]">
                Core slate stays free to explore. Paid tiers later can add alerts, deeper exports, and priority
                compute—see{" "}
                <Link href="/how-it-works#start-free" className="font-medium text-[var(--accent-2)] hover:underline">
                  Start free
                </Link>
                .
              </p>
            </div>
          </div>

          <p className="text-[11px] leading-relaxed text-[var(--muted)]">
            {tr?.disclaimer ??
              "Entertainment only. Not financial advice. Past performance does not guarantee future results."}
          </p>
        </div>
      </div>
    </section>
  );
}
