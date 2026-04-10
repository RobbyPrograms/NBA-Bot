import { NextResponse } from "next/server";
import { unstable_cache } from "next/cache";
import { computeTrackRecord } from "@/lib/track-record";

export const runtime = "nodejs";

/** Scoreboards + many boxscore fetches on first cache fill. */
export const maxDuration = 120;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

const getCachedTrackRecord = unstable_cache(
  async () => computeTrackRecord(40),
  ["rolibot-track-record-v3-all-bets"],
  { revalidate: 3600 }
);

export async function GET() {
  try {
    // In dev, skip unstable_cache so SUPABASE_* changes in .env.local apply without waiting for revalidate.
    const body =
      process.env.NODE_ENV === "development"
        ? await computeTrackRecord(40)
        : await getCachedTrackRecord();
    return NextResponse.json(body, {
      headers: {
        ...corsHeaders,
        ...(process.env.NODE_ENV === "development"
          ? { "Cache-Control": "no-store" }
          : { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=7200" }),
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "error";
    return NextResponse.json(
      { ok: false, error: msg },
      { status: 500, headers: { ...corsHeaders, "Cache-Control": "no-store" } }
    );
  }
}
