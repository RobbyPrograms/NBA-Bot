"""Vercel Python serverless: run RoliBot NBA pipeline and return JSON."""

from datetime import datetime, timedelta, time
from http.server import BaseHTTPRequestHandler
import json
import os
import runpy
import shutil

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover
    ZoneInfo = None  # type: ignore


def _seconds_until_next_rollover(tz_name: str, hour: int, minute: int) -> int:
    """Seconds until the next `hour:minute` in `tz_name` (e.g. 0,0 = local midnight)."""
    if ZoneInfo is None:
        return 3600
    try:
        tz = ZoneInfo(tz_name)
    except Exception:
        tz = ZoneInfo("America/New_York")
    now = datetime.now(tz)
    target_today = datetime.combine(now.date(), time(hour, minute, 0), tzinfo=tz)
    if now < target_today:
        nxt = target_today
    else:
        nxt = datetime.combine(now.date() + timedelta(days=1), time(hour, minute, 0), tzinfo=tz)
    sec = int((nxt - now).total_seconds())
    return max(sec, 60)


def _shared_cache_s_maxage() -> int | None:
    """
    CDN `s-maxage` in seconds, or None = do not cache at the edge.

    - ROLI_S_MAXAGE=0  → no shared cache (every request runs the pipeline).
    - ROLI_S_MAXAGE=N  → fixed N seconds (overrides midnight logic).
    - Production/preview on Vercel → cache until next rollover in ROLI_ROLLOVER_TZ
      (default America/New_York), time ROLI_ROLLOVER_HOUR:ROLI_ROLLOVER_MINUTE (default 0:0 = midnight).
    - Local / vercel dev → no shared cache unless ROLI_S_MAXAGE is set positive.

    No stale-while-revalidate: after midnight the previous response must not linger past TTL.
    """
    override = os.environ.get("ROLI_S_MAXAGE", "").strip()
    if override == "0":
        return None
    if override.isdigit() and int(override) > 0:
        return int(override)

    env = os.environ.get("VERCEL_ENV", "")
    if env not in ("production", "preview"):
        return None

    tz_name = (os.environ.get("ROLI_ROLLOVER_TZ") or "America/New_York").strip()
    try:
        h = int(os.environ.get("ROLI_ROLLOVER_HOUR", "0"))
        m = int(os.environ.get("ROLI_ROLLOVER_MINUTE", "0"))
    except ValueError:
        h, m = 0, 0
    h = max(0, min(h, 23))
    m = max(0, min(m, 59))
    return _seconds_until_next_rollover(tz_name, h, m)


class handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        return

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        os.chdir(root)
        os.environ["ROLI_JSON"] = "1"
        os.environ["VERCEL"] = "1"
        out_path = "/tmp/rolibot_report.json"
        os.environ["ROLI_JSON_OUT"] = out_path

        bundled = os.path.join(root, "nba_bot", "model_cache.pkl")
        tmp_cache = "/tmp/rolibot_model_cache.pkl"
        try:
            if os.path.isfile(bundled):
                shutil.copy2(bundled, tmp_cache)
            os.environ["MODEL_CACHE_PATH"] = tmp_cache
        except Exception:
            os.environ["MODEL_CACHE_PATH"] = bundled if os.path.isfile(bundled) else tmp_cache

        script = os.path.join(root, "nba_bot", "nba_predictor.py")
        if not os.path.isfile(script):
            self._json(500, {"ok": False, "error": "nba_predictor.py not found"})
            return

        try:
            runpy.run_path(script, run_name="__main__")
        except SystemExit:
            pass
        except Exception as e:
            self._json(500, {"ok": False, "error": str(e)})
            return

        if not os.path.isfile(out_path):
            self._json(500, {"ok": False, "error": "Pipeline did not write report (timeout or crash)."})
            return

        try:
            with open(out_path, "r", encoding="utf-8") as f:
                body = f.read()
            json.loads(body)
        except Exception as e:
            self._json(500, {"ok": False, "error": f"Invalid report JSON: {e}"})
            return

        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        sm = _shared_cache_s_maxage()
        if sm is not None:
            # max-age=0: browsers revalidate often; s-maxage: CDN serves one copy for everyone until TTL.
            self.send_header("Cache-Control", f"public, max-age=0, s-maxage={sm}")
        else:
            self.send_header("Cache-Control", "no-store, max-age=0")
        self.end_headers()
        self.wfile.write(body.encode("utf-8"))

    def _json(self, code, obj):
        raw = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.end_headers()
        self.wfile.write(raw)
