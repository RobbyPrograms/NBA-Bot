import { NextResponse } from "next/server";
import { NBA_CDN_FETCH_HEADERS } from "@/lib/nba-cdn-headers";

const NBA_SCOREBOARD =
  "https://cdn.nba.com/static/json/liveData/scoreboard/todaysScoreboard_00.json";

export async function GET() {
  try {
    const res = await fetch(NBA_SCOREBOARD, {
      cache: "no-store",
      headers: NBA_CDN_FETCH_HEADERS,
    });
    if (!res.ok) {
      return NextResponse.json({ error: `NBA scoreboard HTTP ${res.status}` }, { status: 502 });
    }
    const data: unknown = await res.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: "Failed to reach NBA scoreboard" }, { status: 502 });
  }
}
