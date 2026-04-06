# RoliBot predictor + tiny HTTP server for Railway (or any Docker host).
FROM python:3.12-slim-bookworm

WORKDIR /app

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

# Railway sets PORT at runtime; shell expands it here
CMD ["/bin/sh", "-c", "exec gunicorn --bind 0.0.0.0:${PORT:-8080} --workers 1 --threads 4 --timeout 120 railway_server:app"]
