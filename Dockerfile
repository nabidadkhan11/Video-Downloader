FROM python:3.11-slim

# ffmpeg is required for merging high-quality video streams and MP3 conversion
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV PORT=5000
EXPOSE 5000

# --workers 1 : the in-memory JOBS/progress dict is per-process, so keep a
#               single worker unless you move job state to Redis.
# --threads 8 : lets progress-polling requests run alongside a download.
# --timeout 180: video extraction/downloads can take longer than the
#               gunicorn default of 30s.
CMD ["sh", "-c", "gunicorn app:app --workers 1 --threads 8 --timeout 180 --bind 0.0.0.0:$PORT"]
