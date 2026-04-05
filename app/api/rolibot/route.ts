import { NextResponse } from "next/server";
import { buildDevPlaceholderReport } from "@/lib/dev-placeholder-report";
import { mockReport } from "@/lib/mock-report";

export const runtime = "nodejs";

const NO_UPSTREAM_MSG =
  "Live report not configured. Set ROLI_REPORT_URL or ROLI_BACKEND_URL to your hosted predictor JSON (see project README).";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function secondsUntilNextRollover(
  tzName: string,
  hour: number,
  minute: number
): number {
  const now = Date.now();
  const limit = now + 49 * 3600 * 1000;
  let t = Math.ceil(now / 1000) * 1000;
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: tzName,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  while (t <= limit) {
    const parts = fmt.formatToParts(new Date(t));
    const h = parts.find((p) => p.type === "hour")?.value ?? "99";
    const m = parts.find((p) => p.type === "minute")?.value ?? "99";
    const s = parts.find((p) => p.type === "second")?.value ?? "99";
    if (
      parseInt(h, 10) === hour &&
      parseInt(m, 10) === minute &&
      s === "00" &&
      t > now
    ) {
      return Math.max(Math.floor((t - now) / 1000), 60);
    }
    t += 1000;
  }
  return 3600;
}

function sharedCacheSMaxAge(): number | null {
  const override = process.env.ROLI_S_MAXAGE?.trim() ?? "";
  if (override === "0") return null;
  if (/^\d+$/.test(override) && parseInt(override, 10) > 0) {
    return parseInt(override, 10);
  }

  const env = process.env.VERCEL_ENV ?? "";
  if (env !== "production" && env !== "preview") return null;

  const tzName = (process.env.ROLI_ROLLOVER_TZ || "America/New_York").trim();
  let h = 0;
  let m = 0;
  try {
    h = parseInt(process.env.ROLI_ROLLOVER_HOUR || "0", 10);
    m = parseInt(process.env.ROLI_ROLLOVER_MINUTE || "0", 10);
  } catch {
    h = 0;
    m = 0;
  }
  h = Math.max(0, Math.min(h, 23));
  m = Math.max(0, Math.min(m, 59));
  return secondsUntilNextRollover(tzName, h, m);
}

function cacheControlHeaders(): HeadersInit {
  const sm = sharedCacheSMaxAge();
  if (sm != null) {
    return {
      "Cache-Control": `public, max-age=0, s-maxage=${sm}`,
    };
  }
  return { "Cache-Control": "no-store, max-age=0" };
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

export async function GET() {
  const reportUrl = process.env.ROLI_REPORT_URL?.trim();
  const backendUrl = process.env.ROLI_BACKEND_URL?.trim();

  const tryFetch = async (url: string) => {
    const res = await fetch(url, { cache: "no-store" });
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error("Response is not valid JSON");
    }
    if (!res.ok || (body as { ok?: boolean }).ok === false) {
      const err = (body as { error?: string }).error || `HTTP ${res.status}`;
      throw new Error(err);
    }
    return NextResponse.json(body, {
      headers: { ...corsHeaders, ...cacheControlHeaders() },
    });
  };

  try {
    if (reportUrl) return await tryFetch(reportUrl);
    if (backendUrl) return await tryFetch(backendUrl);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Upstream fetch failed";
    return NextResponse.json(
      { ok: false, error: msg },
      {
        status: 502,
        headers: { ...corsHeaders, "Cache-Control": "no-store, max-age=0" },
      }
    );
  }

  const devOrDemoFallback =
    process.env.NODE_ENV === "development" || process.env.ROLI_DEMO_FALLBACK === "1";
  if (devOrDemoFallback) {
    const day = new Date().toISOString().slice(0, 10);
    const nowIso = new Date().toISOString();
    const fullMock = process.env.ROLI_FULL_MOCK === "1";

    const body = fullMock
      ? {
          ...mockReport,
          generated_at: nowIso,
          slate_date: day,
          is_placeholder: false,
          pipeline: mockReport.pipeline
            ? { ...mockReport.pipeline, slate_date: day, date_to: day }
            : undefined,
          brand: `${mockReport.brand} · local demo`,
        }
      : {
          ...buildDevPlaceholderReport(),
          generated_at: nowIso,
          slate_date: day,
          brand: "RoliBot NBA · local demo",
        };

    return NextResponse.json(body, {
      headers: { ...corsHeaders, ...cacheControlHeaders() },
    });
  }

  return NextResponse.json(
    { ok: false, error: NO_UPSTREAM_MSG },
    {
      status: 503,
      headers: { ...corsHeaders, "Cache-Control": "no-store, max-age=0" },
    }
  );
}
