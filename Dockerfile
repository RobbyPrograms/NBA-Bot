# RoliBot predictor + tiny HTTP server for Railway (or any Docker host).
# Optional history: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY → upserts each successful report to Supabase.
FROM python:3.12-slim-bookworm

WORKDIR /app

# Default report path (override with ROLI_RAILWAY_REPORT_PATH). Mount a Railway volume on /data to survive redeploys.
RUN mkdir -p /data

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements-railway.txt requirements.txt ./
RUN pip install --no-cache-dir -r requirements-railway.txt

COPY nba_bot ./nba_bot
COPY railway_server.py ./

ENV PYTHONUNBUFFERED=1
# Longer NBA API reads from cloud IPs (override in Railway if needed)
ENV ROLI_NBA_TIMEOUT=240
ENV ROLI_RAILWAY_REPORT_PATH=/data/live-report.json

# Railway sets PORT at runtime; shell expands it here
CMD ["/bin/sh", "-c", "exec gunicorn --bind 0.0.0.0:${PORT:-8080} --workers 1 --threads 4 --timeout 120 railway_server:app"]
