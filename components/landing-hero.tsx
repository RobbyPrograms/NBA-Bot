"use client";

import Link from "next/link";
import { RecentStreak } from "@/components/RecentStreak";
import { TrackRecord } from "@/components/TrackRecord";

export function LandingHero() {
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
          <TrackRecord />
          <RecentStreak />

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
            Entertainment only. Not financial advice. Past performance does not guarantee future results.
          </p>
        </div>
      </div>
    </section>
  );
}
