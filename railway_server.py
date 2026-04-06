"""
Railway / Docker entry: serve live-report.json and refresh via background schedule.

Set ROLI_REPORT_URL in Vercel to: https://<your-service>.up.railway.app/live-report.json
"""
from __future__ import annotations

import logging
import os
import subprocess
import sys
import threading
import time
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
REFRESH_SEC = int(os.environ.get("ROLI_REFRESH_SECONDS", str(6 * 3600)))
FIRST_DELAY_SEC = int(os.environ.get("ROLI_FIRST_RUN_DELAY_SECONDS", "0"))

app = Flask(__name__)
_run_lock = threading.Lock()
_last: dict = {"ok": False, "error": None, "finished_at": None}
_predictor_running = False


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
    else:
        tail = (cp.stderr or "")[-4000:] + (cp.stdout or "")[-4000:]
        _last["error"] = tail.strip() or f"exit code {cp.returncode}"
        LOG.error("Predictor failed: %s", _last["error"][:500])
    _last["finished_at"] = time.time()


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
