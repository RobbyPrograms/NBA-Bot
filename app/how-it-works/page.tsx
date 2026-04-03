import type { Metadata } from "next";
import { DocsTopBar } from "@/components/docs-top-bar";
import { PageBackdrop } from "@/components/rolibot-ui";

export const metadata: Metadata = {
  title: "How it works — RoliBot NBA",
  description:
    "Technical overview of RoliBot NBA: custom ensemble ML, props engine, and how Robby Rolison built this AI betting research stack.",
};

export default function HowItWorksPage() {
  return (
    <div className="relative min-h-screen">
      <PageBackdrop />
      <header className="border-b border-[var(--border)] bg-[var(--surface-bg)]/90 backdrop-blur-md">
        <DocsTopBar />
      </header>

      <main className="mx-auto max-w-3xl space-y-10 px-4 py-10 sm:px-6">
        <div className="space-y-4">
          <h1 className="text-3xl font-bold tracking-tight text-[var(--text)] sm:text-4xl">
            How{" "}
            <span className="bg-gradient-to-r from-[var(--accent)] to-[var(--accent-2)] bg-clip-text text-transparent">
              RoliBot NBA
            </span>{" "}
            works
          </h1>
          <p className="text-lg leading-relaxed text-[var(--muted)]">
            This is a <strong className="text-[var(--text)]">custom end-to-end AI system I designed and built</strong>{" "}
            — not a generic chatbot wrapper. It ingests real NBA statistics, trains calibrated predictors, scores
            tonight&apos;s slate, and ranks player props with betting-math overlays (Kelly sizing, parlay math,
            opponent context).
          </p>
          <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-6 shadow-[var(--shadow-card)]">
            <p className="text-sm font-semibold uppercase tracking-wider text-[var(--accent)]">Author</p>
            <p className="mt-2 text-xl font-bold text-[var(--text)]">Robby Rolison</p>
            <p className="mt-2 text-sm leading-relaxed text-[var(--muted)]">
              I architected and implemented the full pipeline: feature engineering from team game logs, the ensemble
              model, the props / parlay engines, JSON API surface, and this dashboard. The stack is Python
              (pandas, scikit-learn, XGBoost) plus the public{" "}
              <code className="rounded bg-[var(--card-inner)] px-1.5 py-0.5 font-mono text-xs text-[var(--accent)]">
                nba_api
              </code>{" "}
              client for schedules and box-score-derived histories — wired to run in CI, locally, or on Vercel
              serverless.
            </p>
          </div>
        </div>

        <section className="space-y-4">
          <h2 className="text-xl font-bold text-[var(--text)]">Data &amp; seasons</h2>
          <p className="text-[var(--muted)] leading-relaxed">
            Regular-season team games are pulled season-by-season via{" "}
            <code className="font-mono text-sm text-[var(--accent)]">LeagueGameFinder</code>. The code automatically
            includes every season from <strong className="text-[var(--text)]">2018-19</strong> through the{" "}
            <strong className="text-[var(--text)]">current NBA season string</strong> (e.g. 2025-26), so the merged
            training frame always grows with the calendar — not a fixed &quot;2018–2025&quot; cap.
          </p>
          <p className="text-[var(--muted)] leading-relaxed">
            Each API/CLI run embeds a per-season row audit in the JSON at{" "}
            <code className="rounded bg-[var(--card-inner)] px-1.5 py-0.5 font-mono text-xs text-[var(--accent)]">
              pipeline.season_pull
            </code>
            , plus <code className="font-mono text-xs text-[var(--accent)]">date_from</code>,{" "}
            <code className="font-mono text-xs text-[var(--accent)]">date_to</code>, and{" "}
            <code className="font-mono text-xs text-[var(--accent)]">current_nba_season</code> for props — use that if
            you need the full table off the main dashboard.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-bold text-[var(--text)]">Model training</h2>
          <ul className="list-inside list-disc space-y-2 text-[var(--muted)] leading-relaxed">
            <li>
              <strong className="text-[var(--text)]">Features:</strong> rolling offensive/defensive proxies, rest and
              back-to-back flags, win-streak and momentum differentials, home/away splits merged into one row per game.
            </li>
            <li>
              <strong className="text-[var(--text)]">Split:</strong> strictly <strong>time-ordered</strong> 80% train /
              20% holdout (no random shuffle leakage).
            </li>
            <li>
              <strong className="text-[var(--text)]">Ensemble:</strong> XGBoost + Random Forest, each{" "}
              <strong className="text-[var(--text)]">probability-calibrated</strong> (isotonic), then blended 60/40.
            </li>
            <li>
              <strong className="text-[var(--text)]">Cache:</strong> a content fingerprint of the training matrix
              decides whether to reload weights from <code className="font-mono text-xs">model_cache.pkl</code> or
              retrain.
            </li>
            <li>
              <strong className="text-[var(--text)]">Evaluation:</strong> holdout accuracy, log-loss, classification
              report, and binned calibration curves — all surfaced on the main dashboard after each run.
            </li>
          </ul>
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-bold text-[var(--text)]">Props, parlays, injuries</h2>
          <p className="text-[var(--muted)] leading-relaxed">
            Props use <code className="font-mono text-xs text-[var(--accent)]">PlayerGameLog</code> for the current NBA
            season (with a previous-season merge early in the year when sample size is thin). Hit rates blend recent
            games heavier than older ones; opponent defensive context nudges scoring lines.{" "}
            <strong className="text-[var(--text)]">Players listed Out</strong> on ESPN&apos;s public injury JSON are
            stripped from prop and parlay pools so the model doesn&apos;t surface obvious DNPs. Parlay hit probabilities
            multiply single-leg estimates (independence shortcut — real books price same-game correlation).
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-bold text-[var(--text)]">How to use the dashboard</h2>
          <ol className="list-decimal space-y-3 pl-5 text-[var(--muted)] leading-relaxed">
            <li>Set your bankroll assumptions in the predictor config to match what you actually risk.</li>
            <li>Treat STRONG / GOOD sides plus printed Kelly amounts as templates, not guarantees.</li>
            <li>Safe prop parlays prioritize hit rate; risky ladders are for tiny stakes only.</li>
            <li>Hot-streak legs emphasize recent form vs season baseline — still statistical, not narrative.</li>
            <li>Re-run or deploy the API after the date rolls so the slate matches &quot;tonight.&quot;</li>
            <li>Invalidate or delete the model cache when you want a forced full retrain on fresh history.</li>
            <li>Never bet more than you can afford to lose — this stack is research and entertainment.</li>
          </ol>
        </section>

        <section className="rounded-2xl border border-[var(--gold)]/30 bg-[var(--card-inner)] p-6">
          <h2 className="text-lg font-bold text-[var(--text)]">Disclaimer</h2>
          <p className="mt-2 text-sm leading-relaxed text-[var(--muted)]">
            RoliBot NBA outputs probabilities and sizing math for education and entertainment. Past model performance
            does not predict future results. Sports betting carries financial and legal risk; comply with your
            jurisdiction.
          </p>
        </section>

        <p className="pb-8 text-center text-sm text-[var(--muted)]">
          — Built by <span className="font-semibold text-[var(--text)]">Robby Rolison</span> · custom AI / quant-style
          NBA stack —
        </p>
      </main>
    </div>
  );
}
