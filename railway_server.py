"""
Railway / Docker entry: serve live-report.json and refresh via background schedule.

Set ROLI_REPORT_URL in Vercel to: https://<your-service>.up.railway.app/live-report.json
"""
from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

from flask import Flask, Response, jsonify, request

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
LOG = logging.getLogger("roli.railway")

REPO_ROOT = Path(__file__).resolve().parent
PREDICTOR = REPO_ROOT / "nba_bot" / "nba_predictor.py"


def _resolve_report_path() -> Path:
    """
    Default file is /data/live-report.json with volume mount at /data only.
    If ROLI_RAILWAY_REPORT_PATH points at a directory (common mistake: volume
    mount path set to the same string as the intended file), write live-report.json inside it.
    """
    p = Path(
        os.environ.get("ROLI_RAILWAY_REPORT_PATH", "/data/live-report.json")
    )
    if p.exists() and p.is_dir():
        inner = p / "live-report.json"
        LOG.warning(
            "%s is a directory — volume mount should be /data, not the filename. Using %s",
            p,
            inner,
        )
        return inner
    return p


REPORT_PATH = _resolve_report_path()
# Default 6h — fine for batch “daily card.” For live slates, set e.g. ROLI_REFRESH_SECONDS=900 (15m) or 1800 (30m) on Railway.
REFRESH_SEC = int(os.environ.get("ROLI_REFRESH_SECONDS", str(6 * 3600)))
FIRST_DELAY_SEC = int(os.environ.get("ROLI_FIRST_RUN_DELAY_SECONDS", "0"))

app = Flask(__name__)
_run_lock = threading.Lock()
_last: dict = {"ok": False, "error": None, "finished_at": None}
_predictor_running = False
# Last Supabase snapshot attempt (visible on GET / for debugging).
_supabase_push: dict = {
    "ok": None,
    "slate_date": None,
    "error": None,
    "skipped_reason": "no_attempt_yet",
    "at": None,
}


def _run_predictor() -> subprocess.CompletedProcess[str]:
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env["ROLI_JSON"] = "1"
    env["ROLI_JSON_OUT"] = str(REPORT_PATH)
    LOG.info(
        "Starting predictor subprocess (often 30–60+ min first time) → %s",
        REPORT_PATH,
    )
    return subprocess.run(
        [sys.executable, str(PREDICTOR)],
        cwd=str(REPO_ROOT),
        env=env,
        capture_output=True,
        text=True,
        timeout=None,
    )


def _record(cp: subprocess.CompletedProcess[str]) -> None:
    _last["ok"] = cp.returncode == 0
    if cp.returncode == 0:
        _last["error"] = None
        LOG.info("Predictor finished OK → %s", REPORT_PATH)
        try:
            _maybe_push_supabase_snapshot()
        except Exception as e:
            LOG.warning("Supabase snapshot failed (non-fatal): %s", e)
    else:
        tail = (cp.stderr or "")[-4000:] + (cp.stdout or "")[-4000:]
        _last["error"] = tail.strip() or f"exit code {cp.returncode}"
        LOG.error("Predictor failed: %s", _last["error"][:500])
    _last["finished_at"] = time.time()


def _maybe_push_supabase_snapshot() -> None:
    """
    Upsert full JSON report to Supabase for /history (free tier OK).
    Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (service role — never in browser).
    """
    global _supabase_push
    now = time.time()
    base = (os.environ.get("SUPABASE_URL") or "").strip().rstrip("/")
    key = (os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    if not base or not key:
        _supabase_push = {
            "ok": False,
            "slate_date": None,
            "error": None,
            "skipped_reason": "missing_env_set_SUPABASE_URL_and_SUPABASE_SERVICE_ROLE_KEY",
            "at": now,
        }
        LOG.warning(
            "Supabase upload skipped: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY on this Railway service "
            "(service role key from Supabase → Settings → API; anon key will not insert into slate_reports)."
        )
        return
    if not REPORT_PATH.is_file():
        _supabase_push = {
            "ok": False,
            "slate_date": None,
            "error": None,
            "skipped_reason": "report_file_missing",
            "at": now,
        }
        LOG.warning("Supabase upload skipped: report file not found at %s", REPORT_PATH)
        return
    raw = REPORT_PATH.read_text(encoding="utf-8")
    data = json.loads(raw)
    slate = data.get("slate_date")
    if isinstance(slate, str) and len(slate) >= 10:
        slate_date = slate[:10]
    else:
        gen = data.get("generated_at")
        if isinstance(gen, str) and len(gen) >= 10:
            slate_date = gen[:10]
        else:
            LOG.warning("Supabase: could not derive slate_date from report")
            _supabase_push = {
                "ok": False,
                "slate_date": None,
                "error": "could_not_derive_slate_date",
                "skipped_reason": None,
                "at": now,
            }
            return
    row = {
        "slate_date": slate_date,
        "report": data,
        "generated_at": data.get("generated_at"),
    }
    body = json.dumps(row, ensure_ascii=False).encode("utf-8")
    url = f"{base}/rest/v1/slate_reports"
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Prefer": "resolution=merge-duplicates",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=45) as resp:
            if resp.status not in (200, 201, 204):
                msg = f"unexpected_status_{resp.status}"
                _supabase_push = {
                    "ok": False,
                    "slate_date": slate_date,
                    "error": msg,
                    "skipped_reason": None,
                    "at": now,
                }
                LOG.warning("Supabase POST unexpected status %s", resp.status)
            else:
                _supabase_push = {
                    "ok": True,
                    "slate_date": slate_date,
                    "error": None,
                    "skipped_reason": None,
                    "at": now,
                }
                LOG.info("Supabase slate_reports upsert OK for slate_date=%s", slate_date)
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", "replace")[:500]
        _supabase_push = {
            "ok": False,
            "slate_date": slate_date,
            "error": f"HTTP {e.code}: {err_body}",
            "skipped_reason": None,
            "at": now,
        }
        LOG.warning("Supabase HTTP %s: %s", e.code, err_body)
    except Exception as e:
        _supabase_push = {
            "ok": False,
            "slate_date": slate_date,
            "error": str(e),
            "skipped_reason": None,
            "at": now,
        }
        LOG.warning("Supabase upload failed: %s", e)


def _refresh_loop() -> None:
    global _predictor_running
    time.sleep(max(0, FIRST_DELAY_SEC))
    while True:
        with _run_lock:
            _predictor_running = True
            try:
                _record(_run_predictor())
            except Exception as e:
                _last["ok"] = False
                _last["error"] = str(e)
                _last["finished_at"] = time.time()
                LOG.exception("Predictor exception")
            finally:
                _predictor_running = False
        time.sleep(max(120, REFRESH_SEC))


def _start_loop() -> None:
    if os.environ.get("ROLI_START_REFRESH_LOOP", "1").lower() not in (
        "1",
        "true",
        "yes",
    ):
        return
    t = threading.Thread(target=_refresh_loop, daemon=True, name="roli-refresh")
    t.start()
    LOG.info(
        "Background refresh every %ss (first run after %ss); report → %s",
        max(120, REFRESH_SEC),
        max(0, FIRST_DELAY_SEC),
        REPORT_PATH,
    )


_start_loop()


@app.get("/")
def health():
    return jsonify(
        ok=True,
        service="rolibot-railway",
        report=str(REPORT_PATH),
        report_ready=REPORT_PATH.is_file(),
        predictor_running=_predictor_running,
        last_run=_last,
        supabase_push=_supabase_push,
    )


@app.get("/live-report.json")
def live_report():
    if not REPORT_PATH.is_file():
        return (
            jsonify(
                ok=False,
                error="Report not ready yet (first run still running or failed). See GET / for last_run.",
            ),
            503,
        )
    try:
        body = REPORT_PATH.read_text(encoding="utf-8")
    except OSError as e:
        return jsonify(ok=False, error=str(e)), 500
    return Response(body, mimetype="application/json; charset=utf-8")


@app.post("/refresh")
def manual_refresh():
    secret = (os.environ.get("ROLI_REFRESH_SECRET") or "").strip()
    if not secret:
        return (
            jsonify(
                ok=False,
                error="Set ROLI_REFRESH_SECRET on the service to enable POST /refresh.",
            ),
            403,
        )
    if request.headers.get("X-Roli-Refresh-Secret") != secret:
        return jsonify(ok=False, error="Unauthorized"), 401

    def _job():
        global _predictor_running
        with _run_lock:
            _predictor_running = True
            try:
                try:
                    _record(_run_predictor())
                except Exception as e:
                    _last["ok"] = False
                    _last["error"] = str(e)
                    _last["finished_at"] = time.time()
            finally:
                _predictor_running = False

    threading.Thread(target=_job, daemon=True).start()
    return jsonify(ok=True, message="Refresh started in background"), 202
