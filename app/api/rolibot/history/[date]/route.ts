import { NextResponse } from "next/server";
import { gradeMlPicksForReport } from "@/lib/grade-ml-picks";

export const runtime = "nodejs";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function normalizeBase(u: string): string {
  return u.replace(/\/$/, "");
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

export async function GET(_req: Request, ctx: { params: Promise<{ date: string }> }) {
  const { date } = await ctx.params;
  if (!date || !DATE_RE.test(date)) {
    return NextResponse.json(
      { ok: false, error: "Invalid date (use YYYY-MM-DD)" },
      { status: 400, headers: { ...corsHeaders, "Cache-Control": "no-store" } }
    );
  }

  const rawUrl = process.env.SUPABASE_URL?.trim();
  const key =
    process.env.SUPABASE_ANON_KEY?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!rawUrl || !key) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "History not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY (or service role) on Vercel.",
      },
      { status: 503, headers: { ...corsHeaders, "Cache-Control": "no-store" } }
    );
  }

  const base = normalizeBase(rawUrl);
  const rowUrl = `${base}/rest/v1/slate_reports?slate_date=eq.${encodeURIComponent(date)}&select=report,generated_at,slate_date`;

  try {
    const res = await fetch(rowUrl, {
      cache: "no-store",
      headers: {
        Accept: "application/json",
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
    });
    if (!res.ok) {
      const t = await res.text();
      return NextResponse.json(
        { ok: false, error: `Supabase HTTP ${res.status}: ${t.slice(0, 200)}` },
        { status: 502, headers: { ...corsHeaders, "Cache-Control": "no-store" } }
      );
    }
    const rows = (await res.json()) as {
      slate_date?: string;
      generated_at?: string | null;
      report?: Record<string, unknown>;
    }[];
    if (!Array.isArray(rows) || rows.length === 0) {
      return NextResponse.json(
        { ok: false, error: `No saved report for ${date}.` },
        { status: 404, headers: { ...corsHeaders, "Cache-Control": "no-store" } }
      );
    }
    const row = rows[0];
    const report = row.report;
    const games = report?.games;
    const ml_grading = await gradeMlPicksForReport(date, games);

    return NextResponse.json(
      {
        ok: true,
        slate_date: row.slate_date ?? date,
        generated_at: row.generated_at ?? null,
        report,
        ml_grading,
        note_props:
          "Player props are not auto-graded yet (needs per-player box score stats). Moneyline picks are graded vs NBA final scores.",
      },
      { headers: { ...corsHeaders, "Cache-Control": "no-store, max-age=0" } }
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "fetch failed";
    return NextResponse.json(
      { ok: false, error: msg },
      { status: 502, headers: { ...corsHeaders, "Cache-Control": "no-store" } }
    );
  }
}
