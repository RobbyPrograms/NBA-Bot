import { NextResponse } from "next/server";
import { NBA_CDN_FETCH_HEADERS } from "@/lib/nba-cdn-headers";

const GAME_ID_RE = /^\d{10}$/;

export async function GET(_req: Request, ctx: { params: Promise<{ gameId: string }> }) {
  const { gameId } = await ctx.params;
  if (!gameId || !GAME_ID_RE.test(gameId)) {
    return NextResponse.json({ error: "Invalid gameId (expected 10-digit NBA id)" }, { status: 400 });
  }
  const url = `https://cdn.nba.com/static/json/liveData/boxscore/boxscore_${gameId}.json`;
  try {
    const res = await fetch(url, {
      cache: "no-store",
      headers: NBA_CDN_FETCH_HEADERS,
    });
    if (!res.ok) {
      return NextResponse.json({ error: `NBA boxscore HTTP ${res.status}` }, { status: 502 });
    }
    const data: unknown = await res.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: "Failed to reach NBA boxscore" }, { status: 502 });
  }
}
