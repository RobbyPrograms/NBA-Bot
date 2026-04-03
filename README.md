# RoliBot NBA

Next.js UI + Python pipeline (`nba_bot/nba_predictor.py`) for ensemble game picks, props, and parlays.

## Local UI

```bash
npm install
npm run dev
```

With **no** env vars, `npm run dev` serves a **sample** JSON from `/api/rolibot` so the UI loads. That is **not** live model output.

## Deploy (Vercel) — live report required

The Next.js app **does not** run the Python stack on Vercel (ML deps are too heavy). Production **`/api/rolibot`** only **proxies** JSON from somewhere you host.

In the Vercel project → **Settings → Environment Variables**, set **one** of:

| Variable | Purpose |
|----------|---------|
| `ROLI_REPORT_URL` | Full `https://...` URL that returns **GET** → raw JSON (same shape as `nba_predictor.py` writes). |
| `ROLI_BACKEND_URL` | Same idea if you name your upstream differently (either URL works as the fetch target). |

If **neither** is set in production, the API returns **503** and the site shows *“Could not load live report”*.

### Producing the JSON

From the repo root (Python 3.12+ recommended), with dependencies in `requirements.txt`:

```bash
pip install -r requirements.txt
cd nba_bot
set ROLI_JSON=1
set ROLI_JSON_OUT=report.json
python nba_predictor.py
```

(On macOS/Linux use `export` instead of `set`.)

Then upload `report.json` to any **public HTTPS** host (S3, R2, Vercel Blob, GitHub raw gist, your own server) and set `ROLI_REPORT_URL` to that URL.

**Automation:** run the script on a schedule (GitHub Actions, Render cron, your PC + task scheduler) and **overwrite** the hosted file so the URL always returns the latest run.

### Automated with GitHub Actions (this repo)

A workflow **Publish live report** (`.github/workflows/publish-live-report.yml`) runs `nba_predictor.py` on a **cron** (twice daily) or **manually** (*Actions* tab → *Publish live report* → *Run workflow*).

1. Push this workflow to GitHub and run it once successfully.
2. Your JSON URL (public repo only) is:

   `https://raw.githubusercontent.com/<your-github-user>/<repo>/report-data/live-report.json`

3. In Vercel, set **`ROLI_REPORT_URL`** to that exact URL (replace placeholders). Redeploy.

**Private GitHub repo:** `raw.githubusercontent.com` is not anonymously readable; use Vercel Blob, R2, S3, or another public URL instead, or make the repo public.

**If the job fails** (NBA API limits, timeouts): open the failed run log; you may need a longer `timeout-minutes` or a runner closer to you.

### Optional cache headers

If you use a static file URL, you can still tune edge behavior with `ROLI_S_MAXAGE`, `ROLI_ROLLOVER_*` — see `app/api/rolibot/route.ts` and `nba_predictor.py` comments.

### Emergency demo on production (not recommended)

`ROLI_DEMO_FALLBACK=1` makes `/api/rolibot` return the bundled sample JSON even in production. Use only for demos, not real betting context.

## Python-only local run

```bash
pip install -r requirements.txt
python nba_bot/nba_predictor.py
```

Use `ROLI_JSON=1` and `ROLI_JSON_OUT` when you need machine-readable output for the UI.
