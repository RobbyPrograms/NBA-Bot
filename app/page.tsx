"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { GameRow, HotPropParlay, MixedParlay, RolibotReport, RiskyPropParlay, SafePropParlay } from "@/lib/types";
import { mockReport } from "@/lib/mock-report";
import {
  Card,
  NavHowItWorks,
  PageBackdrop,
  SectionHeading,
  SectionTitle,
  StatTile,
  ThemeToggle,
} from "@/components/rolibot-ui";

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
      {g.kelly_amt > 0 && (
        <p className="mt-2 font-mono text-xs text-[var(--accent)]">
          Kelly recommended: ${g.kelly_amt.toFixed(2)}
        </p>
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
                  {p.trend ? <span>{p.trend} </span> : null}
                  {Math.abs(p.opp_factor - 1) > 0.02 ? (
                    <span className="font-mono">[opp adj ×{p.opp_factor.toFixed(2)}]</span>
                  ) : null}
                </div>
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
      {p.kelly != null && p.kelly > 0 && (
        <p className="mt-1 font-mono text-xs text-[var(--accent)]">Kelly bet size ${p.kelly.toFixed(2)}</p>
      )}
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
              <div className="mt-1 font-mono text-sm text-[var(--accent)]">{pct(leg.hit_rate)}</div>
              <div className="mt-0.5 text-[13px] text-[var(--muted)]">
                {leg.stars ? <span>{leg.stars} </span> : null}
                {leg.confidence ? <span>{leg.confidence} </span> : null}
                {leg.trend ? <span>{leg.trend}</span> : null}
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
              <div className="mt-1 font-mono text-sm text-[var(--accent)]">
                {pct(leg.hit_rate)}
                <span className="ml-2 text-[var(--muted)]">
                  avg {typeof leg.avg === "number" ? leg.avg.toFixed(1) : "—"}
                </span>
              </div>
              {leg.trend ? <div className="mt-0.5 text-[13px] text-[var(--muted)]">{leg.trend}</div> : null}
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
  return (
    <Card className="w-full p-5">
      <p className="font-mono text-[11px] text-[var(--muted)]">Mixed #{i + 1}</p>
      <p className="mt-2 text-sm text-[var(--text)]">
        {m.team_pick.pick_name} ({m.team_pick.pick_side}) {pct(m.team_pick.pick_prob)} {m.team_pick.stars}
      </p>
      <p className="mt-1 text-sm text-[var(--muted)]">
        ▸ {m.prop.player} — {m.prop.label} {pct(m.prop.hit_rate)}
        {m.prop.trend ? ` ${m.prop.trend}` : ""}
      </p>
      {m.prop2 && (
        <p className="mt-1 text-sm text-[var(--muted)]">
          ▸ {m.prop2.player} — {m.prop2.label} {pct(m.prop2.hit_rate)}
          {m.prop2.trend ? ` ${m.prop2.trend}` : ""}
        </p>
      )}
      <p className="mt-3 font-mono text-xs text-[var(--muted)]">
        Combined {pct(m.combined)} · ~${m.payout} / $100
        {m.implied_american ? ` · ${m.implied_american}` : ""}
        {m.kelly != null && m.kelly > 0 ? ` · Kelly $${m.kelly.toFixed(2)}` : ""}
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
      setLoading(false);
      return;
    }
    try {
      const res = await fetch(API_PATH);
      if (res.status === 404) {
        setData(mockReport);
        setUsedMock(true);
        setLoading(false);
        return;
      }
      const json = (await res.json()) as RolibotReport & { error?: string };
      if (!res.ok || json.ok === false) {
        throw new Error(json.error || `HTTP ${res.status}`);
      }
      setData(json);
      setUsedMock(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
      setData(mockReport);
      setUsedMock(true);
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
            <NavHowItWorks />
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="roli-shell space-y-10 pb-14 pt-6 sm:pt-8">
        {!loading && r && (
          <p className="text-xs leading-relaxed text-[var(--muted)] sm:text-sm">
            Ensemble ML picks, props &amp; Kelly sizing — entertainment only. Season tables &amp; training details on{" "}
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

        {!loading && r && (
          <>
            {(error || usedMock) && (
              <Card className="w-full border-[var(--accent-2)]/30 bg-[var(--card-inner)] p-4">
                <p className="text-sm text-[var(--muted)]">
                  {error && (
                    <>
                      <span className="font-semibold text-[var(--text)]">API error.</span> {error} Showing demo data.
                    </>
                  )}
                  {!error && usedMock && (
                    <span>
                      Demo snapshot loaded. Deploy with <code className="font-mono text-[var(--accent)]">/api/rolibot</code> for
                      live runs.
                    </span>
                  )}
                </p>
              </Card>
            )}

            <div className="grid w-full grid-cols-1 gap-4 md:grid-cols-2">
              <Card className="flex min-h-[140px] flex-col p-6">
                <SectionTitle>Run summary</SectionTitle>
                <p className="mt-4 font-mono text-sm leading-relaxed text-[var(--text)]">
                  Bankroll ${r.bankroll.toLocaleString(undefined, { minimumFractionDigits: 2 })} · Kelly{" "}
                  {pct(r.kelly_fraction)} · Max bet {pct(r.max_bet_pct)}
                </p>
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
                <StatTile label="Edge vs breakeven" value={`+${r.model.edge_vs_book_pp.toFixed(1)} pp`} />
              </div>
              <p className="text-sm text-[var(--muted)]">
                Classification breakdown, calibration bins, XGBoost validation curves, and train/cache behavior live on{" "}
                <Link href="/how-it-works" className="font-medium text-[var(--accent)] underline-offset-2 hover:underline">
                  How it works
                </Link>
                .
              </p>
            </section>

            {pipe && (
              <section className="w-full space-y-4">
                <SectionHeading>Tonight&apos;s schedule</SectionHeading>
                <div className="grid w-full grid-cols-2 gap-3 lg:grid-cols-4">
                  <StatTile label="Games on slate" value={String(pipe.schedule_tonight)} />
                </div>
              </section>
            )}

            {pipe?.props_fetch && pipe.props_fetch.length > 0 && (
              <section className="w-full space-y-4">
                <SectionHeading>Viable props by team</SectionHeading>
                <p className="text-sm text-[var(--muted)]">
                  Player logs scanned for {pipe.props_teams_fetched ?? "—"} teams (Out list filtered when injury feed
                  loads).
                </p>
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
              <div className="grid w-full grid-cols-1 gap-5 lg:grid-cols-2">
                {r.games.map((g) => (
                  <GamePredictionCard key={`${g.home_abbr}-${g.away_abbr}`} g={g} />
                ))}
              </div>
            </section>

            <section className="w-full space-y-4">
              <div className="space-y-1">
                <SectionHeading>Props by matchup</SectionHeading>
                <p className="text-sm text-[var(--muted)]">Dense table view — same lines as the game cards above.</p>
              </div>
              {r.games.every((g) => (g.top_props?.length ?? 0) === 0 && (g.risky_props?.length ?? 0) === 0) ? (
                <p className="text-sm text-[var(--muted)]">No prop rows in this run.</p>
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
                                    <td className="py-2.5 pr-3 text-[var(--muted)]">{p.label}</td>
                                    <td className="py-2.5 pr-3 font-mono text-sm text-[var(--accent)]">{pct(p.hit_rate)}</td>
                                    <td className="py-2.5 text-[13px] text-[var(--muted)]">
                                      {[p.stars, p.trend, p.confidence_tier].filter(Boolean).join(" · ")}
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
                                    <td className="py-2.5 pr-3 text-[var(--muted)]">{p.label}</td>
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
              {r.parlays.safe_props.length > 0 && (
                <div className="space-y-3">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--accent)]">
                    Safe (high hit rate)
                  </p>
                  <div className="grid w-full grid-cols-1 gap-4 md:grid-cols-2">
                    {r.parlays.safe_props.map((p, i) => (
                      <SafeParlayCard key={i} p={p} i={i} />
                    ))}
                  </div>
                </div>
              )}
              {r.parlays.risky_props.length > 0 && (
                <div className="space-y-3">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--gold)]">
                    Risky (long shots)
                  </p>
                  <div className="grid w-full grid-cols-1 gap-4 md:grid-cols-2">
                    {r.parlays.risky_props.map((p, i) => (
                      <RiskyParlayCard key={i} p={p} i={i} />
                    ))}
                  </div>
                </div>
              )}
              {r.parlays.mixed.length > 0 && (
                <div className="space-y-3">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--accent-2)]">
                    Mixed (ML + props)
                  </p>
                  <div className="grid w-full grid-cols-1 gap-4 md:grid-cols-2">
                    {r.parlays.mixed.map((m, i) => (
                      <MixedParlayCard key={i} m={m} i={i} />
                    ))}
                  </div>
                </div>
              )}
              {r.parlays.hot.length > 0 && (
                <div className="space-y-3">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--accent-2)]">
                    Hot streak specials
                  </p>
                  <p className="text-xs text-[var(--muted)]">Recent form vs season baseline.</p>
                  <div className="grid w-full grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {r.parlays.hot.map((p, i) => (
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
                          {g.pick_name} ML {pct(g.pick_prob)} ({g.pick_odds}) Kelly ${g.kelly_amt.toFixed(2)}
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
                          {g.pick_name} ML {pct(g.pick_prob)} ({g.pick_odds}) Kelly ${g.kelly_amt.toFixed(2)}
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
                        <li key={g.home_abbr + g.away_abbr}>
                          {g.away_name} @ {g.home_name} (too close)
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <p className="border-t border-[var(--border)] pt-4 font-mono text-sm text-[var(--muted)]">
                  Total recommended (Kelly strong+good) ${r.bet_slip.total_kelly.toFixed(2)}
                  {r.bet_slip.total_kelly_pct_bankroll != null && (
                    <span> ({pct(r.bet_slip.total_kelly_pct_bankroll)} of bankroll)</span>
                  )}
                </p>
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
                </Card>
              )}
              {r.parlays.best_team && (
                <Card className="p-6">
                  <SectionTitle>Best team parlay</SectionTitle>
                  <p className="mt-3 text-[var(--text)]">{r.parlays.best_team.legs.map((l) => l.pick_name).join(" + ")}</p>
                  <p className="mt-2 font-mono text-sm text-[var(--muted)]">
                    {pct(r.parlays.best_team.combined)} · ${r.parlays.best_team.payout} / $100 · Kelly $
                    {r.parlays.best_team.kelly.toFixed(2)}
                  </p>
                </Card>
              )}
              {r.parlays.best_safe_prop && (
                <Card className="p-6 md:col-span-2">
                  <SectionTitle>Best prop parlay</SectionTitle>
                  <p className="mt-3 text-sm text-[var(--text)]">
                    {r.parlays.best_safe_prop.legs.map((l) => `${l.player} ${l.label}`).join(" · ")}
                  </p>
                  <p className="mt-2 font-mono text-sm text-[var(--muted)]">
                    {pct(r.parlays.best_safe_prop.combined)} · ${r.parlays.best_safe_prop.payout} / $100
                    {r.highlights?.best_prop_parlay_kelly != null && r.highlights.best_prop_parlay_kelly > 0 && (
                      <> · Kelly ${r.highlights.best_prop_parlay_kelly.toFixed(2)}</>
                    )}
                  </p>
                </Card>
              )}
              {r.parlays.best_risky_prop && (
                <Card className="p-6 md:col-span-2">
                  <SectionTitle>Best risky parlay</SectionTitle>
                  <p className="mt-3 text-sm text-[var(--text)]">
                    {r.parlays.best_risky_prop.legs.map((l) => `${l.player} ${l.label}`).join(" · ")}
                  </p>
                  <p className="mt-2 font-mono text-sm text-[var(--muted)]">
                    {pct(r.parlays.best_risky_prop.combined)} · ${r.parlays.best_risky_prop.payout} / $100 — cap stake
                  </p>
                </Card>
              )}
            </section>

            <Card className="w-full space-y-4 border-[var(--accent-2)]/25 p-6">
              <SectionTitle>Engine line</SectionTitle>
              <p className="font-mono text-xs leading-relaxed text-[var(--muted)]">
                {r.model.name}
                <br />
                Accuracy {pct(r.model.accuracy)} · Edge {r.model.edge_vs_book_pp >= 0 ? "+" : ""}
                {r.model.edge_vs_book_pp.toFixed(1)}pp · Log-loss {r.model.logloss.toFixed(4)}
                <br />
                Features {r.model.n_features} · Games trained {r.model.n_train_games.toLocaleString()} · Predictions{" "}
                {run?.games_predicted_tonight ?? r.games.length} tonight
                <br />
                Props {r.props_summary.n_safe} safe · {r.props_summary.n_risky} risky · Cache{" "}
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
        )}
      </main>
    </div>
  );
}
