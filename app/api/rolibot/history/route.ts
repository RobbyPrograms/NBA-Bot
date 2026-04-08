import { NextResponse } from "next/server";

export const runtime = "nodejs";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

function normalizeBase(u: string): string {
  return u.replace(/\/$/, "");
}

export async function GET() {
  const rawUrl = process.env.SUPABASE_URL?.trim();
  if (!rawUrl) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "History not configured. Add SUPABASE_URL (+ SUPABASE_ANON_KEY or SUPABASE_SERVICE_ROLE_KEY) on Vercel.",
      },
      { status: 503, headers: { ...corsHeaders, "Cache-Control": "no-store" } }
    );
  }
  const key =
    process.env.SUPABASE_ANON_KEY?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!key) {
    return NextResponse.json(
      { ok: false, error: "Missing SUPABASE_ANON_KEY or SUPABASE_SERVICE_ROLE_KEY." },
      { status: 503, headers: { ...corsHeaders, "Cache-Control": "no-store" } }
    );
  }
  const base = normalizeBase(rawUrl);
  const listUrl = `${base}/rest/v1/slate_reports?select=slate_date,generated_at&order=slate_date.desc&limit=120`;
  try {
    const res = await fetch(listUrl, {
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
    const rows = (await res.json()) as { slate_date?: string; generated_at?: string | null }[];
    return NextResponse.json(
      { ok: true, slates: rows },
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
