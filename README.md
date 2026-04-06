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

### Railway (one-click style hosting)

This repo includes a **Dockerfile** and `railway_server.py`: a small web process serves **`/live-report.json`** and regenerates the report on a **background schedule** (no self-hosted GitHub runner on your PC).

1. Create a project on [Railway](https://railway.app/) and **Deploy from GitHub** (this repo).
2. Railway should detect **`railway.toml`** and build with the Dockerfile. No start command override needed.
3. After deploy, open the service **URL** (e.g. `https://your-service.up.railway.app`) and wait for the first run (several minutes). **`/live-report.json`** returns **503** until the first successful run finishes.
4. In Vercel, set **`ROLI_REPORT_URL`** to `https://<your-railway-host>/live-report.json`.

**Useful variables** (Railway → service → **Variables**):

| Variable | Purpose |
|----------|---------|
| `ROLI_REFRESH_SECONDS` | Seconds between automatic runs (default **21600** = 6 hours; minimum sleep between runs is **120** seconds). |
| `ROLI_FIRST_RUN_DELAY_SECONDS` | Delay before the first run after boot (default **8**). |
| `ROLI_RAILWAY_REPORT_PATH` | Where the JSON file is written (default **`/tmp/roli-live-report.json`**). Use a [Railway volume](https://docs.railway.app/guides/volumes) mount path if you want the file to survive restarts (optional). |
| `ROLI_NBA_TIMEOUT` | NBA API read timeout in seconds (default **240** in the image). |
| `HTTPS_PROXY` / `HTTP_PROXY` | Same idea as GitHub Actions: if `stats.nba.com` blocks Railway’s IP, point traffic through a proxy that exits on a non-blocked network. |
| `ROLI_REFRESH_SECRET` | If set, you can **`POST /refresh`** with header **`X-Roli-Refresh-Secret: <same value>`** to kick a background refresh (returns **202**). |

**Note:** Like GitHub-hosted runners, some cloud IPs are **blocked or throttled** by NBA stats. If builds fail with timeouts, try a proxy (`HTTPS_PROXY`) or another host with a friendlier egress IP.

### Automated with GitHub Actions (this repo)

A workflow **Publish live report** (`.github/workflows/publish-live-report.yml`) runs `nba_predictor.py` on a **cron** (twice daily) or **manually** (*Actions* tab → *Publish live report* → *Run workflow*).

1. Push this workflow to GitHub and run it once successfully.
2. Your JSON URL (public repo only) is:

   `https://raw.githubusercontent.com/<your-github-user>/<repo>/report-data/live-report.json`

3. In Vercel, set **`ROLI_REPORT_URL`** to that exact URL (replace placeholders). Redeploy.

**Private GitHub repo:** `raw.githubusercontent.com` is not anonymously readable; use Vercel Blob, R2, S3, or another public URL instead, or make the repo public.

**If the job fails** (NBA API limits, timeouts): open the failed run log; you may need a longer `timeout-minutes` or a runner closer to you.

#### GitHub-hosted runners and `stats.nba.com`

Many people see **timeouts or hung requests** from **GitHub Actions** even with long `ROLI_NBA_TIMEOUT` values. A common reason is that **stats.nba.com** (used by `nba_api`) often **blocks or severely throttles traffic from known cloud/datacenter IP ranges**, including the Azure IPs used by **GitHub-hosted** runners. Custom headers alone usually do not fix an **IP-level** block.

**Practical options (pick one):**

1. **Self-hosted GitHub Actions runner** on your PC or home server (residential / non-blocked IP), then keep this same workflow.
2. **Run the predictor locally** (or on a small VPS that is not blocked), produce `live-report.json`, then push it to the `report-data` branch (same file path the workflow uses) or upload to any public URL you set as `ROLI_REPORT_URL`.
3. **HTTPS proxy** that exits through a **non-datacenter** network: create a repository secret **`ROLI_HTTPS_PROXY`** (for example `https://user:pass@host:port` if your provider uses that). The workflow sets `HTTPS_PROXY` / `HTTP_PROXY` only when that secret is non-empty so `requests` (inside `nba_api`) can use it.

Longer timeouts help when the server is **slow**; they do not replace a working network path if the NBA endpoint **drops** cloud traffic.

### Self-hosted runner (easiest fix for blocked NBA stats)

The workflow **Publish live report** is set to `runs-on: self-hosted` so jobs run on **your PC** (home IP) instead of GitHub’s cloud. Your machine must be **on** and the runner **running** when a job starts (scheduled times or when you click *Run workflow*).

#### One-time setup (Windows)

1. **Install Git** and **Python 3.12+** on the PC that will run jobs (if not already): [Git for Windows](https://git-scm.com/download/win), [python.org](https://www.python.org/downloads/) (check “Add python.exe to PATH”).
2. On GitHub open **`RobbyPrograms/NBA-Bot`** → **Settings** → **Actions** → **Runners** → **New self-hosted runner**.
3. Choose **Windows** and **x64**. GitHub shows commands — in short:
   - Create a folder, e.g. `C:\actions-runner`, download the zip, extract.
   - Run **`config.cmd`** (as admin if prompted).
   - When asked for the repo URL, use `https://github.com/RobbyPrograms/NBA-Bot` (HTTPS is fine).
   - Paste the **registration token** from the GitHub page (it expires quickly; generate a new one if needed).
   - Accept default runner group; give it a name like `home-pc`.
   - Optional: add a label when asked, or press Enter to skip.
4. Run **`run.cmd`** (same folder). Leave that window open, or install as a **Windows service** (GitHub’s docs: “Running as a service”) so it starts automatically.
5. On the **Runners** page you should see **Idle** with a green dot.

#### After you merge this repo’s workflow

- Push/pull the latest `publish-live-report.yml` (with `runs-on: self-hosted`).
- **Actions** → **Publish live report** → **Run workflow**. The job should pick your runner within a minute.
- First run installs pip deps and may take a long time; later runs reuse `rolibot_cache.pkl` when possible.

#### Important

- **Scheduled runs** (`cron`) only run if your PC is on and the runner is connected at that UTC time. Adjust cron in the workflow if you want a time when your PC is usually on, or rely on **Run workflow** manually.
- To go back to GitHub-hosted (not recommended for NBA pulls), change `runs-on: self-hosted` to `runs-on: ubuntu-latest` in `.github/workflows/publish-live-report.yml`.

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
