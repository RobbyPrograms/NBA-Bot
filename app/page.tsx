"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { GameRow, HotPropParlay, MixedParlay, RolibotReport, RiskyPropParlay, SafePropParlay } from "@/lib/types";
import { mockReport } from "@/lib/mock-report";
import {
  collectReportTeamAbbrs,
  firstRiskyParlay,
  firstSafeParlay,
  injurySummary,
  modelEdgePp,
  modelNTrain,
  parlayHotList,
  parlayRiskyList,
  parlaySafeList,
  parlaySgpList,
  propsNSafe,
  slateDateDisplay,
} from "@/lib/report-helpers";
import {
  Card,
  NavHowItWorks,
  PageBackdrop,
  SectionHeading,
  SectionTitle,
  StatTile,
  ThemeToggle,
} from "@/components/rolibot-ui";
import { AiPropLiveBar } from "@/components/ai-prop-live-bar";
import { LiveNbaErrorBanner, LiveNbaProvider } from "@/components/live-nba-context";

const API_PATH = "/api/rolibot";

function pct(n: number) {
  return `${(n * 100).toFixed(1)}%`;
}

function ParlayLegMismatch({ declared, actual }: { declared: number; actual: number }) {
  if (declared === actual) return null;
  return (
    <p className="mb-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-100">
      Header says {declared}-leg but the payload has {actual} leg(s). Check the API response or mock data.
    </p>
  );
}

function GamePredictionCard({ g }: { g: GameRow }) {
  const teamForProp = (p: { team?: string }) => (p.team ?? "").trim();
  const top = g.top_props ?? [];
  const risky = g.risky_props ?? [];
  const mins = g.minutes_warnings ?? [];

  return (
    <Card className="w-full p-5">
      <p className="text-center font-mono text-[11px] text-[var(--muted)]">
        {g.away_name} @ {g.home_name}
      </p>
      <div className="mt-4 grid grid-cols-2 gap-2">
        <StatTile label={`Home (${g.home_abbr})`} value={`${pct(g.prob_home)} ${probOdds(g.prob_home)}`} />
        <StatTile label={`Away (${g.away_abbr})`} value={`${pct(g.prob_away)} ${probOdds(g.prob_away)}`} />
      </div>
      <div className="mt-3 text-sm">
        <span className="text-[var(--muted)]">Pick →</span>{" "}
        <span className="font-semibold text-[var(--text)]">{g.pick_name}</span>{" "}
        <span className="text-[var(--muted)]">({g.pick_side})</span>
      </div>
      <p className="mt-1 text-sm text-[var(--muted)]">
        Signal: {g.confidence} {g.stars}
      </p>
      {g.analysis != null && g.analysis.trim() !== "" && (
        <div className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--card-inner)] p-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted)]">Game analysis</p>
          <p className="mt-2 text-sm leading-relaxed text-[var(--text)]">{g.analysis}</p>
          <p className="mt-2 text-[11px] text-[var(--muted)]">
            Rules-based or LLM narrative from the pipeline (not a sportsbook line).
          </p>
        </div>
      )}

      {top.length > 0 && (
        <div className="mt-5 border-t border-[var(--border)] pt-4">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted)]">
            Top props (high confidence)
          </p>
          <ul className="mt-2 space-y-3 text-[15px] leading-snug">
            {top.map((p) => (
              <li
                key={`${p.player}-${p.label}`}
                className="flex flex-col gap-1 border-b border-[var(--border)] pb-3 last:border-0"
              >
                <div className="flex flex-wrap justify-between gap-2">
                  <span className="text-[var(--text)]">
                    <span className="font-medium">{p.player}</span>{" "}
                    <span className="text-[var(--muted)]">{p.label}</span>
                  </span>
                  <span className="shrink-0 font-mono text-sm text-[var(--accent)]">{pct(p.hit_rate)}</span>
                </div>
                <div className="text-[13px] text-[var(--muted)]">
                  {p.stars ? <span>{p.stars} </span> : null}
                  {(p.confidence_tier ?? p.confidence) ? (
                    <span>{p.confidence_tier ?? p.confidence} </span>
                  ) : null}
                  {p.trend ? <span>{p.trend} </span> : null}
                  {p.trend3 ? <span>{p.trend3} </span> : null}
                  {p.opp ? <span className="font-mono">vs {p.opp} </span> : null}
                  {Math.abs(p.opp_factor - 1) > 0.02 ? (
                    <span className="font-mono">[opp adj ×{p.opp_factor.toFixed(2)}]</span>
                  ) : null}
                  {p.inj_status ? <span className="block text-[11px]">Inj: {p.inj_status}</span> : null}
                  {p.avg_recent3 != null ? (
                    <span className="block font-mono text-[11px]">L3 avg {p.avg_recent3.toFixed(1)}</span>
                  ) : null}
                </div>
                <AiPropLiveBar
                  player={p.player}
                  teamAbbr={teamForProp(p)}
                  label={p.label}
                  stat={p.stat}
                  threshold={p.threshold}
                />
              </li>
            ))}
          </ul>
        </div>
      )}

      {risky.length > 0 && (
        <div className="mt-4 border-t border-[var(--border)] pt-4">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted)]">
            Risky picks (high payout potential)
          </p>
          <ul className="mt-2 space-y-2.5 text-[15px] leading-snug">
            {risky.map((p) => (
              <li
                key={`r-${p.player}-${p.label}`}
                className="flex flex-wrap justify-between gap-2 border-b border-[var(--border)] pb-2 last:border-0"
              >
                <span className="text-[var(--text)]">
                  {p.player} <span className="text-[var(--muted)]">{p.label}</span>
                  {p.trend ? <span className="ml-1 text-[var(--muted)]">{p.trend}</span> : null}
                </span>
                <span className="shrink-0 font-mono text-sm text-[var(--muted)]">
                  {pct(p.hit_rate)} · avg {p.avg.toFixed(1)}
                </span>
                <AiPropLiveBar
                  player={p.player}
                  teamAbbr={teamForProp(p)}
                  label={p.label}
                  stat={p.stat}
                  threshold={p.threshold}
                />
              </li>
            ))}
          </ul>
        </div>
      )}

      {mins.length > 0 && (
        <div className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--card-inner)] p-3">
          <p className="text-[11px] font-semibold uppercase text-[var(--muted)]">Minutes concerns</p>
          <ul className="mt-2 space-y-1 text-xs text-[var(--muted)]">
            {mins.map((m) => (
              <li key={m.player}>
                {m.player} — recent {m.min_recent} mpg {m.min_flag}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

function probOdds(p: number): string {
  if (p <= 0 || p >= 1) return "";
  if (p >= 0.5) return `-${Math.round((p / (1 - p)) * 100)}`;
  return `+${Math.round(((1 - p) / p) * 100)}`;
}

function SafeParlayCard({ p, i }: { p: SafePropParlay; i: number }) {
  const nLegs = p.legs?.length ?? 0;
  return (
    <Card className="w-full p-5">
      <p className="font-mono text-[11px] text-[var(--muted)]">Safe prop parlay #{i + 1}</p>
      <p className="mt-1 text-sm text-[var(--text)]">
        {p.n}-leg · {pct(p.combined)} hit · ~${p.payout} / $100
        {p.implied_american ? ` · ${p.implied_american}` : ""}
      </p>
      <div className="mt-3 border-t border-[var(--border)] pt-3">
        <ParlayLegMismatch declared={p.n} actual={nLegs} />
        <ul className="space-y-3">
          {(p.legs ?? []).map((leg, j) => (
            <li
              key={j}
              className="border-l-2 border-[var(--accent)]/50 pl-3 text-[15px] leading-snug text-[var(--text)]"
            >
              <span className="font-mono text-xs text-[var(--muted)]">Leg {j + 1}</span>
              <div className="mt-0.5">
                <span className="font-medium text-[var(--text)]">{leg.player}</span>{" "}
                <span className="text-[var(--muted)]">{leg.label}</span>
              </div>
              <AiPropLiveBar
                player={leg.player}
                teamAbbr={(leg.team ?? "").trim()}
                label={leg.label}
                dense
              />
              <div className="mt-1 font-mono text-sm text-[var(--accent)]">{pct(leg.hit_rate)}</div>
              <div className="mt-0.5 text-[13px] text-[var(--muted)]">
                {leg.stars ? <span>{leg.stars} </span> : null}
                {leg.confidence ? <span>{leg.confidence} </span> : null}
                {leg.trend ? <span>{leg.trend}</span> : null}
                {leg.team != null && leg.team !== "" ? (
                  <span className="ml-1 font-mono text-[11px]">{leg.team}</span>
                ) : null}
                {leg.opp != null && leg.opp !== "" ? (
                  <span className="ml-1 font-mono text-[11px] text-[var(--muted)]">vs {leg.opp}</span>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

function RiskyParlayCard({ p, i }: { p: RiskyPropParlay; i: number }) {
  const nLegs = p.legs?.length ?? 0;
  return (
    <Card className="w-full p-5">
      <p className="font-mono text-[11px] text-[var(--muted)]">Risky parlay #{i + 1}</p>
      <p className="mt-1 text-sm text-[var(--text)]">
        {p.n}-leg · {pct(p.combined)} · ~${p.payout} / $100
        {p.implied_american ? ` · ${p.implied_american}` : ""}
      </p>
      <div className="mt-3 border-t border-[var(--border)] pt-3">
        <ParlayLegMismatch declared={p.n} actual={nLegs} />
        <ul className="space-y-3">
          {(p.legs ?? []).map((leg, j) => (
            <li
              key={j}
              className="border-l-2 border-[var(--gold)]/60 pl-3 text-[15px] leading-snug text-[var(--text)]"
            >
              <span className="font-mono text-xs text-[var(--muted)]">Leg {j + 1}</span>
              <div className="mt-0.5">
                <span className="font-medium text-[var(--text)]">{leg.player}</span>{" "}
                <span className="text-[var(--muted)]">{leg.label}</span>
              </div>
              <AiPropLiveBar
                player={leg.player}
                teamAbbr={(leg.team ?? "").trim()}
                label={leg.label}
                dense
              />
              <div className="mt-1 font-mono text-sm text-[var(--accent)]">
                {pct(leg.hit_rate)}
                <span className="ml-2 text-[var(--muted)]">
                  avg {typeof leg.avg === "number" ? leg.avg.toFixed(1) : "—"}
                </span>
              </div>
              {leg.trend ? <div className="mt-0.5 text-[13px] text-[var(--muted)]">{leg.trend}</div> : null}
              {leg.team != null && leg.team !== "" ? (
                <div className="mt-0.5 font-mono text-[11px] text-[var(--muted)]">
                  {leg.team}
                  {leg.opp != null && leg.opp !== "" ? ` vs ${leg.opp}` : ""}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
      <p className="mt-3 text-sm text-[var(--gold)]">Long shot — cap at $10–20 max.</p>
    </Card>
  );
}

function HotParlayCard({ p, i }: { p: HotPropParlay; i: number }) {
  const nLegs = p.legs?.length ?? 0;
  return (
    <Card className="w-full p-5">
      <p className="font-mono text-[11px] text-[var(--muted)]">Hot streak #{i + 1}</p>
      <p className="mt-1 text-sm text-[var(--text)]">
        {p.n}-leg · {pct(p.combined)} · ~${p.payout} / $100
        {p.implied_american ? ` · ${p.implied_american}` : ""}
      </p>
      <div className="mt-3 border-t border-[var(--border)] pt-3">
        <ParlayLegMismatch declared={p.n} actual={nLegs} />
        <ul className="space-y-3">
          {(p.legs ?? []).map((leg, j) => (
            <li
              key={j}
              className="border-l-2 border-[var(--accent-2)]/60 pl-3 text-[15px] leading-snug text-[var(--text)]"
            >
              <span className="font-mono text-xs text-[var(--muted)]">Leg {j + 1}</span>
              <div className="mt-0.5">
                <span className="font-medium text-[var(--text)]">{leg.player}</span>{" "}
                <span className="text-[var(--muted)]">{leg.label}</span>
              </div>
              <AiPropLiveBar
                player={leg.player}
                teamAbbr={(leg.team ?? "").trim()}
                label={leg.label}
                dense
              />
              <div className="mt-1 font-mono text-sm text-[var(--accent)]">{pct(leg.hit_rate)}</div>
              <div className="mt-1 text-[13px] text-[var(--muted)]">
                {leg.trend ? <span>{leg.trend} </span> : null}
                <span className="font-mono">
                  recent {typeof leg.avg_recent === "number" ? leg.avg_recent.toFixed(1) : "—"} vs season{" "}
                  {typeof leg.avg === "number" ? leg.avg.toFixed(1) : "—"}
                </span>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

function MixedParlayCard({ m, i }: { m: MixedParlay; i: number }) {
  const side = m.team_pick.pick_side;
  const stars = m.team_pick.stars;
  return (
    <Card className="w-full p-5">
      <p className="font-mono text-[11px] text-[var(--muted)]">Mixed #{i + 1}</p>
      <p className="mt-2 text-sm text-[var(--text)]">
        {m.team_pick.pick_name}
        {side != null && side !== "" ? ` (${side})` : ""} {pct(m.team_pick.pick_prob)}
        {stars != null && stars !== "" ? ` ${stars}` : ""}
      </p>
      <p className="mt-1 text-sm text-[var(--muted)]">
        ▸ {m.prop.player} — {m.prop.label} {pct(m.prop.hit_rate)}
        {m.prop.trend ? ` ${m.prop.trend}` : ""}
      </p>
      <AiPropLiveBar
        player={m.prop.player}
        teamAbbr={(m.prop.team ?? "").trim()}
        label={m.prop.label}
        stat={m.prop.stat}
        threshold={m.prop.threshold}
        dense
      />
      {m.prop2 && (
        <p className="mt-1 text-sm text-[var(--muted)]">
          ▸ {m.prop2.player} — {m.prop2.label} {pct(m.prop2.hit_rate)}
          {m.prop2.trend ? ` ${m.prop2.trend}` : ""}
        </p>
      )}
      {m.prop2 ? (
        <AiPropLiveBar
          player={m.prop2.player}
          teamAbbr={(m.prop2.team ?? "").trim()}
          label={m.prop2.label}
          stat={m.prop2.stat}
          threshold={m.prop2.threshold}
          dense
        />
      ) : null}
      <p className="mt-3 font-mono text-xs text-[var(--muted)]">
        Combined {pct(m.combined)} · ~${m.payout} / $100
        {m.implied_american != null && m.implied_american !== "" ? ` · ${m.implied_american}` : ""}
      </p>
    </Card>
  );
}

export default function Page() {
  const [data, setData] = useState<RolibotReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [usedMock, setUsedMock] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const useMock =
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("demo") === "1";
    if (useMock) {
      setData(mockReport);
      setUsedMock(true);
      setError(null);
      setLoading(false);
      return;
    }
    try {
      const res = await fetch(API_PATH);
      const json = (await res.json()) as RolibotReport & { error?: string };
      if (!res.ok || json.ok === false) {
        throw new Error(json.error || `HTTP ${res.status}`);
      }
      setData(json);
      setUsedMock(false);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
      setData(null);
      setUsedMock(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const r = data;
  const pipe = r?.pipeline;
  const run = r?.run_meta;
  const isDev = process.env.NODE_ENV === "development";

  return (
    <div className="relative min-h-screen">
      <PageBackdrop />
      <header className="sticky top-0 z-20 border-b border-[var(--border)] bg-[var(--surface-bg)]/90 backdrop-blur-md">
        <div className="roli-shell flex h-14 items-center justify-between gap-4">
          <div className="flex min-w-0 items-baseline gap-3">
            <h1 className="truncate bg-gradient-to-r from-[var(--text)] to-[var(--accent-2)] bg-clip-text text-lg font-bold tracking-tight text-transparent sm:text-xl">
              {r?.brand ?? "RoliBot NBA"}
            </h1>
            <span className="hidden text-[var(--muted)] sm:inline">·</span>
            <span className="hidden truncate text-xs text-[var(--muted)] sm:inline">Robby Rolison</span>
          </div>
          <div className="flex shrink-0 items-center gap-4">
            <Link
              href="/history"
              className="hidden text-sm font-medium text-[var(--accent-2)] hover:underline sm:inline"
            >
              History
            </Link>
            <NavHowItWorks />
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="roli-shell space-y-10 pb-14 pt-6 sm:pt-8">
        {!loading && r && (
          <p className="text-xs leading-relaxed text-[var(--muted)] sm:text-sm">
            Ensemble ML picks and props — entertainment only. Season tables &amp; training details on{" "}
            <Link href="/how-it-works" className="font-medium text-[var(--accent-2)] hover:underline">
              How it works
            </Link>
            .
          </p>
        )}
        {loading && (
          <div className="flex flex-col items-center gap-4 py-20">
            <div className="h-10 w-10 animate-spin rounded-full border-2 border-[var(--border)] border-t-[var(--accent)]" />
            <p className="text-sm font-medium text-[var(--muted)]">Loading model output…</p>
          </div>
        )}

        {!loading && !r && error && (
          <Card className="w-full border-amber-500/40 bg-[var(--card-inner)] p-6">
            <p className="font-semibold text-[var(--text)]">Could not load live report</p>
            <p className="mt-2 text-sm text-[var(--muted)]">{error}</p>
            {!isDev ? (
              <p className="mt-4 text-sm text-[var(--muted)]">
                Try again in a few minutes. If this keeps happening, the report service may be updating or temporarily
                unavailable.
              </p>
            ) : (
              <p className="mt-4 text-sm text-[var(--muted)]">
                Point <code className="font-mono text-[var(--accent)]">ROLI_REPORT_URL</code> or{" "}
                <code className="font-mono text-[var(--accent)]">ROLI_BACKEND_URL</code> at predictor JSON, or open with{" "}
                <code className="font-mono text-[var(--text)]">?demo=1</code> for a static sample.
              </p>
            )}
          </Card>
        )}

        {!loading && r && (
          <LiveNbaProvider teamAbbrs={collectReportTeamAbbrs(r)}>
            <>
            <LiveNbaErrorBanner />
            {usedMock && (
              <Card className="w-full border-[var(--accent-2)]/30 bg-[var(--card-inner)] p-4">
                <p className="text-sm text-[var(--muted)]">
                  <span className="font-semibold text-[var(--text)]">Demo mode</span> — static sample only (
                  <code className="font-mono text-[var(--accent)]">?demo=1</code>). Not live data.
                </p>
              </Card>
            )}

            {isDev && !usedMock && r.brand.includes("local demo") && (
              <Card className="w-full border-[var(--border)] bg-[var(--card-inner)] p-4">
                {r.is_placeholder ? (
                  <p className="text-sm leading-relaxed text-[var(--muted)]">
                    <span className="font-semibold text-[var(--text)]">Local dev — no live JSON</span> — You’re not
                    seeing old sample picks. The slate is empty until you point{" "}
                    <code className="font-mono text-[var(--accent)]">ROLI_REPORT_URL</code> (or{" "}
                    <code className="font-mono">ROLI_BACKEND_URL</code>) at real predictor output in{" "}
                    <code className="font-mono">.env.local</code>, then restart <code className="font-mono">npm run dev</code>
                    . For the fictional UI sample only, set{" "}
                    <code className="font-mono">ROLI_FULL_MOCK=1</code> in <code className="font-mono">.env.local</code>.
                  </p>
                ) : (
                  <p className="text-sm text-[var(--muted)]">
                    <span className="font-semibold text-[var(--text)]">Local dev</span> —{" "}
                    <code className="font-mono text-[var(--accent)]">ROLI_FULL_MOCK=1</code> is on:{" "}
                    <code className="font-mono">/api/rolibot</code> serves the static sample (not necessarily
                    today&apos;s NBA slate). Unset it and use <code className="font-mono">ROLI_REPORT_URL</code> for real
                    picks.
                  </p>
                )}
              </Card>
            )}

            <div className="grid w-full grid-cols-1 gap-4 md:grid-cols-2">
              <Card className="flex min-h-[140px] flex-col p-6">
                <SectionTitle>Run summary</SectionTitle>
                <p className="mt-4 text-sm leading-relaxed text-[var(--muted)]">
                  Slate and model run metadata (no bankroll sizing shown in this view).
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {typeof r.llm_enabled === "boolean" &&
                    (r.llm_enabled ? (
                      <span className="rounded-full border border-[var(--accent-2)]/40 bg-[var(--accent-2)]/10 px-2.5 py-0.5 text-[11px] font-medium text-[var(--accent-2)]">
                        LLM analysis on
                      </span>
                    ) : (
                      <span className="rounded-full border border-[var(--border)] px-2.5 py-0.5 text-[11px] text-[var(--muted)]">
                        {isDev
                          ? "LLM off — set ANTHROPIC_API_KEY for narratives"
                          : "Narrative layer off"}
                      </span>
                    ))}
                  {slateDateDisplay(r) != null && (
                    <span className="rounded-full border border-[var(--border)] px-2.5 py-0.5 font-mono text-[11px] text-[var(--muted)]">
                      Slate {slateDateDisplay(r)}
                    </span>
                  )}
                </div>
                <p className="mt-auto pt-4 text-sm text-[var(--muted)]">Generated {r.generated_at}</p>
              </Card>
              <Card className="flex min-h-[140px] flex-col justify-center p-6">
                <SectionTitle>Holdout snapshot</SectionTitle>
                <p className="mt-3 text-2xl font-bold text-[var(--accent)]">{pct(r.model.accuracy)}</p>
                <p className="text-xs text-[var(--muted)]">Accuracy · methodology on How it works</p>
              </Card>
            </div>

            {pipe && (
              <section className="w-full space-y-4">
                <SectionHeading>Feature matrix</SectionHeading>
                <p className="text-sm text-[var(--muted)]">
                  Rolling team signals used before each prediction (not raw box scores for tonight).
                </p>
                <div className="grid w-full grid-cols-2 gap-3 lg:grid-cols-4">
                  <StatTile label="Clean training games" value={pipe.clean_merged_games.toLocaleString()} />
                  <StatTile label="Features per game" value={String(r.model.n_features)} />
                  <StatTile
                    label="Home win rate (merged)"
                    value={pipe.home_win_rate_merged != null ? pct(pipe.home_win_rate_merged) : "—"}
                  />
                  <StatTile label="Date range (merged)" value={`${pipe.date_from} → ${pipe.date_to}`} />
                </div>
              </section>
            )}

            <section className="w-full space-y-4">
              <SectionHeading>Model quality (holdout)</SectionHeading>
              <div className="grid w-full grid-cols-2 gap-3 lg:grid-cols-4">
                <StatTile label="Accuracy" value={pct(r.model.accuracy)} />
                <StatTile label="Log-loss" value={r.model.logloss.toFixed(4)} />
                <StatTile
                  label="Sportsbook breakeven"
                  value={
                    r.evaluation?.sportsbook_breakeven != null ? pct(r.evaluation.sportsbook_breakeven) : "~52.4%"
                  }
                />
                <StatTile label="Edge vs breakeven" value={`+${modelEdgePp(r).toFixed(1)} pp`} />
              </div>
              <p className="text-sm text-[var(--muted)]">
                Classification breakdown, calibration, validation curves, and training details (when included in the
                report) are described on{" "}
                <Link href="/how-it-works" className="font-medium text-[var(--accent)] underline-offset-2 hover:underline">
                  How it works
                </Link>
                .
              </p>
            </section>

            {(pipe != null || slateDateDisplay(r) != null) && (
              <section className="w-full space-y-4">
                <SectionHeading>Tonight&apos;s schedule</SectionHeading>
                <p className="text-sm text-[var(--muted)]">
                  Scoreboard date follows NBA game-day (US Eastern by default), not your PC clock — see slate date below.
                </p>
                <div className="grid w-full grid-cols-2 gap-3 lg:grid-cols-4">
                  <StatTile
                    label="Games on slate"
                    value={String(pipe?.schedule_tonight ?? r.games.length)}
                  />
                  {slateDateDisplay(r) != null ? (
                    <StatTile label="Slate date" value={slateDateDisplay(r)!} />
                  ) : null}
                  {pipe?.slate_timezone != null && pipe.slate_timezone !== "" ? (
                    <StatTile label="Slate TZ" value={pipe.slate_timezone} />
                  ) : null}
                </div>
                {r.slate_matchups != null && r.slate_matchups.length > 0 && (
                  <Card className="w-full p-4">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted)]">
                      Teams in this run (props only from these games)
                    </p>
                    <ul className="mt-2 space-y-1 font-mono text-sm text-[var(--text)]">
                      {r.slate_matchups.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                    <p className="mt-3 text-xs text-[var(--muted)]">
                      If this list doesn&apos;t match your sportsbook, the slate date, timezone, or which games have
                      finished may differ from this run.
                    </p>
                  </Card>
                )}
              </section>
            )}

            {r.accuracy_notes != null && (
              <section className="w-full space-y-4">
                <SectionHeading>Accuracy guardrails</SectionHeading>
                <p className="text-sm text-[var(--muted)]">
                  Hard filters applied before props and parlays surface (traded players, injuries, activity, minutes).
                </p>
                <Card className="w-full space-y-3 p-5">
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    {r.accuracy_notes.traded_skipped != null && (
                      <StatTile label="Traded / team skips" value={String(r.accuracy_notes.traded_skipped)} />
                    )}
                    {r.accuracy_notes.injured_skipped != null && (
                      <StatTile label="Injury skips" value={String(r.accuracy_notes.injured_skipped)} />
                    )}
                  </div>
                  <ul className="space-y-2 text-sm text-[var(--muted)]">
                    {r.accuracy_notes.trade_check != null && r.accuracy_notes.trade_check !== "" && (
                      <li>
                        <span className="font-medium text-[var(--text)]">Roster vs logs: </span>
                        {r.accuracy_notes.trade_check}
                      </li>
                    )}
                    {r.accuracy_notes.injury_check != null && r.accuracy_notes.injury_check !== "" && (
                      <li>
                        <span className="font-medium text-[var(--text)]">Injuries: </span>
                        {r.accuracy_notes.injury_check}
                      </li>
                    )}
                    {r.accuracy_notes.activity_check != null && r.accuracy_notes.activity_check !== "" && (
                      <li>
                        <span className="font-medium text-[var(--text)]">Activity: </span>
                        {r.accuracy_notes.activity_check}
                      </li>
                    )}
                    {r.accuracy_notes.minutes_check != null && r.accuracy_notes.minutes_check !== "" && (
                      <li>
                        <span className="font-medium text-[var(--text)]">Minutes: </span>
                        {r.accuracy_notes.minutes_check}
                      </li>
                    )}
                  </ul>
                </Card>
              </section>
            )}

            {injurySummary(r) != null && (
              <section className="w-full space-y-4">
                <SectionHeading>Injury feed snapshot</SectionHeading>
                <div className="grid w-full grid-cols-2 gap-3 lg:grid-cols-4">
                  {injurySummary(r)!.n_tracked != null && (
                    <StatTile label="Players tracked" value={String(injurySummary(r)!.n_tracked)} />
                  )}
                  {(injurySummary(r)!.n_excluded != null || injurySummary(r)!.n_out != null) && (
                    <StatTile
                      label="Excluded from props"
                      value={String(injurySummary(r)!.n_excluded ?? injurySummary(r)!.n_out)}
                    />
                  )}
                  <StatTile
                    label="Feed OK"
                    value={injurySummary(r)!.fetched_ok === true ? "Yes" : injurySummary(r)!.fetched_ok === false ? "No" : "—"}
                  />
                </div>
                {injurySummary(r)!.out_players != null && injurySummary(r)!.out_players!.length > 0 && (
                  <Card className="max-h-72 w-full overflow-auto p-0">
                    <table className="w-full text-left text-sm">
                      <thead>
                        <tr className="sticky top-0 border-b border-[var(--border)] bg-[var(--card-inner)] roli-table-head">
                          <th className="px-4 py-2">Player</th>
                          <th className="px-4 py-2">Team</th>
                          <th className="px-4 py-2">Status</th>
                        </tr>
                      </thead>
                      <tbody className="text-[var(--text)]">
                        {injurySummary(r)!.out_players!.map((row, idx) => (
                          <tr key={`${row.player}-${idx}`} className="border-b border-[var(--border)]">
                            <td className="px-4 py-2">{row.player}</td>
                            <td className="px-4 py-2 text-[var(--muted)]">{row.team}</td>
                            <td className="px-4 py-2 font-mono text-xs">{row.status}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </Card>
                )}
              </section>
            )}

            {pipe?.props_fetch && pipe.props_fetch.length > 0 && (
              <section className="w-full space-y-4">
                <SectionHeading>Viable props by team</SectionHeading>
                <Card className="w-full overflow-hidden p-0">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-b border-[var(--border)] roli-table-head">
                        <th className="px-4 py-3">Team</th>
                        <th className="px-4 py-3">vs</th>
                        <th className="px-4 py-3 font-mono">Viable props</th>
                      </tr>
                    </thead>
                    <tbody className="text-[var(--text)]">
                      {pipe.props_fetch.map((row) => (
                        <tr key={`${row.team}-${row.opponent}`} className="border-b border-[var(--border)]">
                          <td className="px-4 py-2.5 font-mono font-semibold">{row.team}</td>
                          <td className="px-4 py-2.5 font-mono text-[var(--muted)]">{row.opponent}</td>
                          <td className="px-4 py-2.5 font-mono text-[var(--accent)]">{row.viable_props}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Card>
              </section>
            )}

            <section className="w-full space-y-4">
              <SectionHeading>Game predictions</SectionHeading>
              {r.games.length === 0 ? (
                <p className="text-sm text-[var(--muted)]">
                  No games on the slate for this run (off day or schedule not returned).
                </p>
              ) : (
                <div className="grid w-full grid-cols-1 gap-5 lg:grid-cols-2">
                  {r.games.map((g) => (
                    <GamePredictionCard key={`${g.home_abbr}-${g.away_abbr}`} g={g} />
                  ))}
                </div>
              )}
            </section>

            <section className="w-full space-y-4">
              <div className="space-y-1">
                <SectionHeading>Props by matchup</SectionHeading>
                <p className="text-[11px] text-[var(--muted)]">
                  Live bars use NBA.com box scores when today&apos;s slate matches (refreshes every 45s).
                </p>
              </div>
              {r.games.every((g) => (g.top_props?.length ?? 0) === 0 && (g.risky_props?.length ?? 0) === 0) ? (
                <p className="text-sm text-[var(--muted)]">No props on the slate for this run.</p>
              ) : (
                <div className="grid w-full grid-cols-1 gap-5">
                  {r.games.map((g) => {
                    const top = g.top_props ?? [];
                    const risky = g.risky_props ?? [];
                    if (top.length === 0 && risky.length === 0) return null;
                    return (
                      <Card key={`props-${g.home_abbr}-${g.away_abbr}`} className="w-full overflow-hidden p-0">
                        <div className="border-b border-[var(--border)] bg-[var(--card-inner)] px-4 py-4">
                          <p className="font-mono text-sm font-semibold text-[var(--accent)]">
                            {g.away_abbr} @ {g.home_abbr}
                          </p>
                          <p className="mt-0.5 text-xs text-[var(--muted)]">
                            {g.away_name} at {g.home_name}
                          </p>
                        </div>
                        {top.length > 0 && (
                          <div className="p-4">
                            <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted)]">
                              Top props
                            </p>
                            <table className="mt-2 w-full text-left text-[15px] text-[var(--text)]">
                              <thead>
                                <tr className="border-b border-[var(--border)] text-[11px] uppercase tracking-wide text-[var(--muted)]">
                                  <th className="pb-2 pr-3 font-medium">Player</th>
                                  <th className="pb-2 pr-3 font-medium">Prop</th>
                                  <th className="pb-2 pr-3 font-mono font-medium">Hit%</th>
                                  <th className="pb-2 font-medium">Notes</th>
                                </tr>
                              </thead>
                              <tbody>
                                {top.map((p) => (
                                  <tr key={`${p.player}-${p.label}`} className="border-b border-[var(--border)] align-top">
                                    <td className="py-2.5 pr-3 font-medium">{p.player}</td>
                                    <td className="py-2.5 pr-3 text-[var(--muted)]">
                                      <div>{p.label}</div>
                                      <AiPropLiveBar
                                        player={p.player}
                                        teamAbbr={(p.team ?? "").trim()}
                                        label={p.label}
                                        stat={p.stat}
                                        threshold={p.threshold}
                                        dense
                                      />
                                    </td>
                                    <td className="py-2.5 pr-3 font-mono text-sm text-[var(--accent)]">{pct(p.hit_rate)}</td>
                                    <td className="py-2.5 text-[13px] text-[var(--muted)]">
                                      {[p.stars, p.trend, p.confidence_tier ?? p.confidence].filter(Boolean).join(" · ")}
                                      {Math.abs(p.opp_factor - 1) > 0.02 ? (
                                        <span className="ml-1 font-mono">opp ×{p.opp_factor.toFixed(2)}</span>
                                      ) : null}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                        {risky.length > 0 && (
                          <div className={`p-4 ${top.length > 0 ? "border-t border-[var(--border)]" : ""}`}>
                            <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted)]">
                              Risky props
                            </p>
                            <table className="mt-2 w-full text-left text-[15px] text-[var(--text)]">
                              <thead>
                                <tr className="border-b border-[var(--border)] text-[11px] uppercase tracking-wide text-[var(--muted)]">
                                  <th className="pb-2 pr-3 font-medium">Player</th>
                                  <th className="pb-2 pr-3 font-medium">Prop</th>
                                  <th className="pb-2 pr-3 font-mono font-medium">Hit%</th>
                                  <th className="pb-2 font-medium">Avg</th>
                                  <th className="pb-2 font-medium">Trend</th>
                                </tr>
                              </thead>
                              <tbody>
                                {risky.map((p) => (
                                  <tr key={`r-${p.player}-${p.label}`} className="border-b border-[var(--border)] align-top">
                                    <td className="py-2.5 pr-3 font-medium">{p.player}</td>
                                    <td className="py-2.5 pr-3 text-[var(--muted)]">
                                      <div>{p.label}</div>
                                      <AiPropLiveBar
                                        player={p.player}
                                        teamAbbr={(p.team ?? "").trim()}
                                        label={p.label}
                                        stat={p.stat}
                                        threshold={p.threshold}
                                        dense
                                      />
                                    </td>
                                    <td className="py-2.5 pr-3 font-mono text-sm">{pct(p.hit_rate)}</td>
                                    <td className="py-2.5 pr-3 font-mono text-sm text-[var(--muted)]">{p.avg.toFixed(1)}</td>
                                    <td className="py-2.5 text-[13px] text-[var(--muted)]">{p.trend || "—"}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </Card>
                    );
                  })}
                </div>
              )}
            </section>

            <section className="w-full space-y-4">
              <div className="space-y-1">
                <SectionHeading>Prop parlays</SectionHeading>
                <p className="text-sm text-[var(--muted)]">
                  Leg probabilities multiply (independence shortcut); sportsbooks price same-game correlation.
                </p>
              </div>
              {parlaySafeList(r).length > 0 && (
                <div className="space-y-3">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--accent)]">
                    Safe (high hit rate)
                  </p>
                  <div className="grid w-full grid-cols-1 gap-4 md:grid-cols-2">
                    {parlaySafeList(r).map((p, i) => (
                      <SafeParlayCard key={i} p={p} i={i} />
                    ))}
                  </div>
                </div>
              )}
              {parlaySgpList(r).length > 0 && (
                <div className="space-y-3">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--accent-2)]">
                    Same-game parlays (SGP)
                  </p>
                  <div className="grid w-full grid-cols-1 gap-4 md:grid-cols-2">
                    {parlaySgpList(r).map((p, i) => (
                      <SafeParlayCard key={`sgp-${i}`} p={p} i={i} />
                    ))}
                  </div>
                </div>
              )}
              {parlayRiskyList(r).length > 0 && (
                <div className="space-y-3">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--gold)]">
                    Risky (long shots)
                  </p>
                  <div className="grid w-full grid-cols-1 gap-4 md:grid-cols-2">
                    {parlayRiskyList(r).map((p, i) => (
                      <RiskyParlayCard key={i} p={p} i={i} />
                    ))}
                  </div>
                </div>
              )}
              {(r.parlays.mixed ?? []).length > 0 && (
                <div className="space-y-3">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--accent-2)]">
                    Mixed (ML + props)
                  </p>
                  <div className="grid w-full grid-cols-1 gap-4 md:grid-cols-2">
                    {(r.parlays.mixed ?? []).map((m, i) => (
                      <MixedParlayCard key={i} m={m} i={i} />
                    ))}
                  </div>
                </div>
              )}
              {parlayHotList(r).length > 0 && (
                <div className="space-y-3">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--accent-2)]">
                    Hot streak specials
                  </p>
                  <p className="text-xs text-[var(--muted)]">Recent form vs season baseline.</p>
                  <div className="grid w-full grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {parlayHotList(r).map((p, i) => (
                      <HotParlayCard key={i} p={p} i={i} />
                    ))}
                  </div>
                </div>
              )}
            </section>

            <section className="w-full space-y-4">
              <SectionHeading>Bet slip</SectionHeading>
              <Card className="w-full space-y-5 p-6">
                {r.bet_slip.strong.length > 0 && (
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--accent)]">Strong</p>
                    <ul className="mt-2 space-y-1 text-sm text-[var(--text)]">
                      {r.bet_slip.strong.map((g) => (
                        <li key={g.pick_abbr}>
                          {g.pick_name} ML {pct(g.pick_prob)} ({g.pick_odds})
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {r.bet_slip.good.length > 0 && (
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--accent-2)]">Good</p>
                    <ul className="mt-2 space-y-1 text-sm text-[var(--text)]">
                      {r.bet_slip.good.map((g) => (
                        <li key={g.pick_abbr}>
                          {g.pick_name} ML {pct(g.pick_prob)} ({g.pick_odds})
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {r.bet_slip.lean.length > 0 && (
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">Lean</p>
                    <ul className="mt-2 space-y-1 text-sm text-[var(--muted)]">
                      {r.bet_slip.lean.map((g) => (
                        <li key={g.pick_abbr}>
                          {g.pick_name} ML {pct(g.pick_prob)} ({g.pick_odds})
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {r.bet_slip.skip.length > 0 && (
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">Skip</p>
                    <ul className="mt-2 space-y-1 text-sm text-[var(--muted)]">
                      {r.bet_slip.skip.map((g) => (
                        <li key={`${g.home_name}-${g.away_name}`}>
                          {g.away_name} @ {g.home_name} (too close)
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </Card>
            </section>

            <section className="grid w-full grid-cols-1 gap-5 md:grid-cols-2">
              {r.props_summary.best_prop && (
                <Card className="p-6">
                  <SectionTitle>Best player prop tonight</SectionTitle>
                  <p className="mt-3 text-[var(--text)]">
                    {r.props_summary.best_prop.player}{" "}
                    <span className="text-[var(--muted)]">{r.props_summary.best_prop.label}</span>
                  </p>
                  <p className="mt-2 font-mono text-sm text-[var(--muted)]">
                    {pct(r.props_summary.best_prop.hit_rate)} hit rate (avg {r.props_summary.best_prop.avg.toFixed(1)} / last{" "}
                    {r.props_summary.best_prop.n_games} games) {r.props_summary.best_prop.trend}
                  </p>
                  <AiPropLiveBar
                    player={r.props_summary.best_prop.player}
                    teamAbbr={(r.props_summary.best_prop.team ?? "").trim()}
                    label={r.props_summary.best_prop.label}
                    stat={r.props_summary.best_prop.stat}
                    threshold={r.props_summary.best_prop.threshold}
                  />
                </Card>
              )}
              {r.parlays.best_team != null && (
                <Card className="p-6">
                  <SectionTitle>Best team parlay</SectionTitle>
                  <p className="mt-3 text-[var(--text)]">{r.parlays.best_team.legs.map((l) => l.pick_name).join(" + ")}</p>
                  <p className="mt-2 font-mono text-sm text-[var(--muted)]">
                    {pct(r.parlays.best_team.combined)} · ${r.parlays.best_team.payout} / $100
                  </p>
                </Card>
              )}
              {firstSafeParlay(r) != null && (
                <Card className="p-6 md:col-span-2">
                  <SectionTitle>Best prop parlay</SectionTitle>
                  <p className="mt-3 text-sm text-[var(--text)]">
                    {firstSafeParlay(r)!.legs.map((l) => `${l.player} ${l.label}`).join(" · ")}
                  </p>
                  <p className="mt-2 font-mono text-sm text-[var(--muted)]">
                    {pct(firstSafeParlay(r)!.combined)} · ${firstSafeParlay(r)!.payout} / $100
                  </p>
                </Card>
              )}
              {(() => {
                const riskyHighlight = r.parlays.best_risky_prop ?? firstRiskyParlay(r);
                if (riskyHighlight == null) return null;
                return (
                  <Card className="p-6 md:col-span-2">
                    <SectionTitle>
                      {r.parlays.best_risky_prop != null ? "Best risky parlay" : "Top risky parlay"}
                    </SectionTitle>
                    <p className="mt-3 text-sm text-[var(--text)]">
                      {riskyHighlight.legs.map((l) => `${l.player} ${l.label}`).join(" · ")}
                    </p>
                    <p className="mt-2 font-mono text-sm text-[var(--muted)]">
                      {pct(riskyHighlight.combined)} · ${riskyHighlight.payout} / $100 — cap stake
                    </p>
                  </Card>
                );
              })()}
            </section>

            <Card className="w-full space-y-4 border-[var(--accent-2)]/25 p-6">
              <SectionTitle>Engine line</SectionTitle>
              <p className="font-mono text-xs leading-relaxed text-[var(--muted)]">
                {r.model.name}
                <br />
                Accuracy {pct(r.model.accuracy)} · Edge {modelEdgePp(r) >= 0 ? "+" : ""}
                {modelEdgePp(r).toFixed(1)}pp · Log-loss {r.model.logloss.toFixed(4)}
                <br />
                Features {r.model.n_features} · Games trained {modelNTrain(r).toLocaleString()} · Predictions{" "}
                {run?.games_predicted_tonight ?? r.games.length} tonight
                <br />
                Props {propsNSafe(r)} strong/safe · {r.props_summary.n_risky} risky · Cache{" "}
                {run?.cache_line ?? (r.model.cache_hit ? "HIT" : "MISS")}
                <br />
                {run?.breakeven_note}
              </p>
              <p className="border-t border-[var(--border)] pt-4 text-sm text-[var(--text)]">
                <span className="font-semibold text-[var(--accent)]">Robby Rolison</span> — I designed and built this
                stack end-to-end: data ingestion, ensemble training, prop/parlay engines, API, and UI. See{" "}
                <Link href="/how-it-works" className="text-[var(--accent)] underline-offset-2 hover:underline">
                  How it works
                </Link>{" "}
                for methodology and usage.
              </p>
              <p className="text-xs text-[var(--muted)]">{r.disclaimer}</p>
            </Card>
            </>
          </LiveNbaProvider>
        )}
      </main>
    </div>
  );
}
