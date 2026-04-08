"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Card, PageBackdrop, SectionHeading, ThemeToggle } from "@/components/rolibot-ui";
import type { MlGradingResult, MlPickGrade } from "@/lib/grade-ml-picks";

type SlateRow = { slate_date?: string; generated_at?: string | null };

function gradeLabel(g: MlPickGrade): string {
  if (g.pick_correct === true) return "Hit";
  if (g.pick_correct === false) return "Miss";
  return "—";
}

function gradeClass(g: MlPickGrade): string {
  if (g.pick_correct === true) return "text-emerald-600 dark:text-emerald-400";
  if (g.pick_correct === false) return "text-rose-600 dark:text-rose-400";
  return "text-[var(--muted)]";
}

export default function HistoryPage() {
  const [slates, setSlates] = useState<SlateRow[]>([]);
  const [date, setDate] = useState("");
  const [loadingList, setLoadingList] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [grading, setGrading] = useState<MlGradingResult | null>(null);
  const [noteProps, setNoteProps] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingList(true);
      setErr(null);
      try {
        const res = await fetch("/api/rolibot/history", { cache: "no-store" });
        const data = (await res.json()) as { ok?: boolean; slates?: SlateRow[]; error?: string };
        if (cancelled) return;
        if (!res.ok || !data.ok) {
          setErr(data.error || `HTTP ${res.status}`);
          setSlates([]);
          return;
        }
        const list = data.slates || [];
        setSlates(list);
        if (list[0]?.slate_date) setDate(list[0].slate_date);
      } catch {
        if (!cancelled) setErr("Failed to load slate list.");
      } finally {
        if (!cancelled) setLoadingList(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const loadDetail = useCallback(async (d: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
    setLoadingDetail(true);
    setErr(null);
    setGrading(null);
    setNoteProps(null);
    try {
      const res = await fetch(`/api/rolibot/history/${d}`, { cache: "no-store" });
      const data = (await res.json()) as {
        ok?: boolean;
        ml_grading?: MlGradingResult;
        note_props?: string;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        setErr(data.error || `HTTP ${res.status}`);
        return;
      }
      setGrading(data.ml_grading ?? null);
      setNoteProps(data.note_props ?? null);
    } catch {
      setErr("Failed to load that date.");
    } finally {
      setLoadingDetail(false);
    }
  }, []);

  useEffect(() => {
    if (date) void loadDetail(date);
  }, [date, loadDetail]);

  return (
    <div className="relative min-h-screen">
      <PageBackdrop />
      <header className="sticky top-0 z-20 border-b border-[var(--border)] bg-[var(--surface-bg)]/90 backdrop-blur-md">
        <div className="roli-shell flex h-14 items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <Link
              href="/"
              className="text-sm font-medium text-[var(--accent-2)] hover:underline"
            >
              ← Live slate
            </Link>
            <h1 className="truncate text-lg font-bold text-[var(--text)]">Past slates</h1>
          </div>
          <ThemeToggle />
        </div>
      </header>

      <main className="roli-shell space-y-8 pb-16 pt-6">
        <p className="text-sm text-[var(--muted)]">
          Saved reports from Supabase (after each successful Railway run). Moneyline picks are
          checked against NBA final scores for that calendar date. Entertainment only.
        </p>

        {loadingList && <p className="text-sm text-[var(--muted)]">Loading saved dates…</p>}
        {err && (
          <Card className="border-rose-500/40 bg-rose-500/10 p-4 text-sm text-rose-800 dark:text-rose-100">
            {err}
          </Card>
        )}

        {!loadingList && slates.length > 0 && (
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-xs text-[var(--muted)]">
              Slate date
              <select
                className="rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--text)]"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              >
                {slates.map((s) => (
                  <option key={s.slate_date} value={s.slate_date || ""}>
                    {s.slate_date}
                    {s.generated_at ? ` · ${s.generated_at.slice(0, 16)}` : ""}
                  </option>
                ))}
              </select>
            </label>
            {loadingDetail && (
              <span className="text-xs text-[var(--muted)]">Loading grades…</span>
            )}
          </div>
        )}

        {!loadingList && slates.length === 0 && !err && (
          <Card className="p-5 text-sm text-[var(--muted)]">
            No rows in <code className="text-[var(--accent)]">slate_reports</code> yet. Run the SQL
            in <code className="text-[var(--accent)]">supabase/slate_reports.sql</code>, set{" "}
            <code className="text-[var(--accent)]">SUPABASE_URL</code> +{" "}
            <code className="text-[var(--accent)]">SUPABASE_SERVICE_ROLE_KEY</code> on Railway (and{" "}
            <code className="text-[var(--accent)]">SUPABASE_URL</code> +{" "}
            <code className="text-[var(--accent)]">SUPABASE_ANON_KEY</code> on Vercel), then wait
            for the next successful predictor run.
          </Card>
        )}

        {grading && grading.games.length > 0 && (
          <section>
            <SectionHeading>ML picks vs results</SectionHeading>
            {noteProps && (
              <p className="mb-4 text-xs text-[var(--muted)]">{noteProps}</p>
            )}
            <p className="mb-3 text-xs text-[var(--muted)]">
              NBA scoreboard games loaded: {grading.board_games_found}
              {grading.scoreboard_error ? ` · ${grading.scoreboard_error}` : ""}
            </p>
            <div className="space-y-3">
              {grading.games.map((g) => (
                <Card key={`${g.away_abbr}-${g.home_abbr}`} className="p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-medium text-[var(--text)]">
                      {g.away_abbr} @ {g.home_abbr}
                      {g.home_score != null && g.away_score != null && (
                        <span className="ml-2 text-[var(--muted)]">
                          ({g.away_score}–{g.home_score})
                        </span>
                      )}
                    </p>
                    <span className={`text-sm font-semibold ${gradeClass(g)}`}>
                      {gradeLabel(g)}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-[var(--muted)]">
                    Pick: <span className="text-[var(--text)]">{g.pick_name || g.pick_abbr}</span>
                    {g.winner_abbr ? (
                      <>
                        {" "}
                        · Winner: <span className="text-[var(--text)]">{g.winner_abbr}</span>
                      </>
                    ) : null}
                  </p>
                  {g.note && <p className="mt-1 text-xs text-[var(--muted)]">{g.note}</p>}
                </Card>
              ))}
            </div>
          </section>
        )}

        {grading && grading.games.length === 0 && !loadingDetail && date && (
          <p className="text-sm text-[var(--muted)]">No games in that report to grade.</p>
        )}
      </main>
    </div>
  );
}
