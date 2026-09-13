import os
import glob
import uuid
import shutil
import tempfile
import threading
import traceback
from datetime import datetime

from flask import Flask, render_template, request, jsonify, send_file, after_this_request

try:
    from yt_dlp import YoutubeDL
except ImportError:
    YoutubeDL = None

app = Flask(__name__)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# IMPORTANT: temporary per-job download files must NEVER live inside the
# project folder. Each job downloads its file to a subfolder here (the OS
# temp directory) and that subfolder is deleted right after the file is
# streamed to the browser (see cleanup_dir / api_fetch_file below). This
# guarantees nothing is ever left behind inside the project directory,
# even if a job errors out, is cancelled, or is never fetched by the user.
DOWNLOAD_DIR = os.path.join(tempfile.gettempdir(), "video_downloader_jobs")
os.makedirs(DOWNLOAD_DIR, exist_ok=True)


def cleanup_stale_job_dirs():
    """Remove any leftover job folders from previous runs (e.g. the app
    crashed, or was killed, before a job's own cleanup could run)."""
    if not os.path.isdir(DOWNLOAD_DIR):
        return
    for name in os.listdir(DOWNLOAD_DIR):
        path = os.path.join(DOWNLOAD_DIR, name)
        shutil.rmtree(path, ignore_errors=True) if os.path.isdir(path) else None


cleanup_stale_job_dirs()

# A normal desktop-browser User-Agent. Without this, Instagram/TikTok/X/
# Facebook frequently reject yt-dlp's default UA with 403s or empty
# responses (YouTube is more lenient, which is why "only YouTube works"
# is such a common symptom when this header is missing).
COMMON_HTTP_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
}


def base_ydl_opts():
    """
    Shared yt-dlp options for both the preview (/api/formats) and the actual
    download. Centralized so every platform gets the same resilience
    settings (headers/retries/timeouts) instead of only YouTube working
    reliably.
    """
    return {
        "http_headers": COMMON_HTTP_HEADERS,
        "geo_bypass": True,
        "nocheckcertificate": True,
        "retries": 5,
        "fragment_retries": 5,
        "extractor_retries": 3,
        "socket_timeout": 30,
    }


def find_ffmpeg():
    """
    Locate the ffmpeg executable. Tries the normal PATH lookup first; if that
    fails (common right after a fresh install on Windows, before the PATH
    change has propagated to every process), falls back to scanning the
    usual install locations for winget/choco/scoop/manual installs so the
    app still works without requiring a PC restart.
    Returns the directory containing ffmpeg.exe (for yt-dlp's
    "ffmpeg_location" option), or None if not found anywhere.
    """
    found = shutil.which("ffmpeg")
    if found:
        return os.path.dirname(found)

    if os.name == "nt":
        search_patterns = [
            os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\WinGet\Packages\**\ffmpeg.exe"),
            os.path.expandvars(r"%ProgramData%\chocolatey\bin\ffmpeg.exe"),
            os.path.expandvars(r"%USERPROFILE%\scoop\shims\ffmpeg.exe"),
            os.path.expandvars(r"%USERPROFILE%\scoop\apps\ffmpeg*\**\ffmpeg.exe"),
            r"C:\ffmpeg\bin\ffmpeg.exe",
            r"C:\ffmpeg\**\ffmpeg.exe",
        ]
    else:
        search_patterns = [
            "/usr/local/bin/ffmpeg",
            "/opt/homebrew/bin/ffmpeg",
            "/usr/bin/ffmpeg",
        ]

    for pattern in search_patterns:
        matches = glob.glob(pattern, recursive=True)
        if matches:
            return os.path.dirname(matches[0])

    return None


# Directory containing ffmpeg.exe/ffmpeg (for yt-dlp), or None if not found.
FFMPEG_DIR = find_ffmpeg()
FFMPEG_AVAILABLE = FFMPEG_DIR is not None

# Quality presets we try to offer for YouTube (height in pixels)
QUALITY_PRESETS = [144, 240, 360, 480, 720, 1080]

# Platforms that show manual quality-selection buttons. Everything else
# (Instagram, TikTok, Twitter/X, Facebook, and any other yt-dlp-supported
# site) auto-downloads at the best available quality.
MANUAL_QUALITY_PLATFORMS = {"youtube"}

PLATFORM_LABELS = {
    "youtube": "YouTube",
    "instagram": "Instagram",
    "tiktok": "TikTok",
    "twitter": "X (Twitter)",
    "facebook": "Facebook",
    "other": "Video",
}

# In-memory store for real-time download progress, keyed by job_id.
# Each job looks like:
# {
#   "status": "starting" | "downloading" | "processing" | "finished" | "error",
#   "percent": 0-100,
#   "speed": "1.2 MiB/s",
#   "eta": "00:12",
#   "downloaded": "5.1 MiB",
#   "total": "20.0 MiB",
#   "job_dir": "/.../downloads/<id>",
#   "filename": "video.mp4",
#   "error": None,
# }
JOBS = {}
JOBS_LOCK = threading.Lock()


def sizeof_fmt(num):
    if not num:
        return "?"
    for unit in ["B", "KiB", "MiB", "GiB"]:
        if abs(num) < 1024.0:
            return f"{num:3.1f} {unit}"
        num /= 1024.0
    return f"{num:.1f} TiB"


def format_view_count(n):
    """1234567 -> '1.2M views'"""
    try:
        n = int(n)
    except (TypeError, ValueError):
        return None
    if n <= 0:
        return None
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M views"
    if n >= 1_000:
        return f"{n / 1000:.1f}K views"
    return f"{n} views"


def format_relative_date(upload_date):
    """'20240102' -> '3 days ago' / '2 months ago' / '1 year ago'"""
    if not upload_date:
        return None
    try:
        d = datetime.strptime(str(upload_date), "%Y%m%d")
    except (ValueError, TypeError):
        return None
    days = (datetime.utcnow() - d).days
    if days <= 0:
        return "Today"
    if days == 1:
        return "1 day ago"
    if days < 30:
        return f"{days} days ago"
    months = days // 30
    if months < 12:
        return f"{months} month{'s' if months != 1 else ''} ago"
    years = days // 365
    return f"{years} year{'s' if years != 1 else ''} ago"


def format_duration_label(seconds):
    """125 -> '2:05', 3725 -> '1:02:05'"""
    try:
        seconds = int(seconds)
    except (TypeError, ValueError):
        return None
    if seconds <= 0:
        return None
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}"


def quality_label(height):
    if height >= 2160:
        return f"{height}p (4K)"
    if height == 1080:
        return "1080p (Full HD)"
    if height == 720:
        return "720p (HD)"
    return f"{height}p"


def _fmt_size(f):
    return f.get("filesize") or f.get("filesize_approx")


def estimate_audio_size(formats):
    """Best guess at the MP3/audio download size, in bytes."""
    audio_only = [
        f for f in formats
        if f.get("acodec") not in (None, "none")
        and f.get("vcodec") in (None, "none")
        and _fmt_size(f)
    ]
    if not audio_only:
        return None
    best = max(audio_only, key=lambda f: f.get("abr") or 0)
    return _fmt_size(best)


def estimate_video_size(formats, height=None):
    """Best guess at the merged video+audio download size, in bytes."""
    video_formats = [f for f in formats if f.get("vcodec") not in (None, "none")]
    if height:
        exact = [f for f in video_formats if f.get("height") == height]
        if exact:
            video_formats = exact

    # Prefer a format that's already muxed with audio and has a real size.
    combined = [f for f in video_formats if f.get("acodec") not in (None, "none") and _fmt_size(f)]
    if combined:
        best = max(combined, key=lambda f: f.get("height") or 0)
        return _fmt_size(best)

    # Otherwise sum the best video-only stream with the best audio-only stream.
    video_only = [f for f in video_formats if _fmt_size(f)]
    if not video_only:
        return None
    best_v = max(video_only, key=lambda f: f.get("height") or 0)
    vsize = _fmt_size(best_v)
    asize = estimate_audio_size(formats) or 0
    return vsize + asize


def detect_platform(url: str) -> str:
    """Detect the source platform from the URL."""
    url = url.lower()
    if "youtube.com" in url or "youtu.be" in url:
        return "youtube"
    if "instagram.com" in url:
        return "instagram"
    if "tiktok.com" in url:
        return "tiktok"
    if "twitter.com" in url or "x.com" in url:
        return "twitter"
    if "facebook.com" in url or "fb.watch" in url:
        return "facebook"
    return "other"


def friendly_extract_error(raw_error: str, platform: str) -> str:
    """Turn a raw yt-dlp exception message into something a user can act on."""
    low = raw_error.lower()
    label = PLATFORM_LABELS.get(platform, "This platform")
    if "login" in low or "rate-limit" in low or "private" in low:
        return (f"{label} is asking for a login/verification to view this link. "
                f"Try a public post/video URL instead.")
    if "unsupported url" in low:
        return "This link isn't supported. Please paste a direct video/reel/post URL."
    if "403" in low or "forbidden" in low:
        return (f"{label} blocked the request (403). This usually means yt-dlp needs "
                f"an update — run: pip install -U yt-dlp")
    return f"Could not fetch video info: {raw_error}"


def make_job_dir() -> str:
    job_id = uuid.uuid4().hex
    job_dir = os.path.join(DOWNLOAD_DIR, job_id)
    os.makedirs(job_dir, exist_ok=True)
    return job_dir


def cleanup_dir(path: str):
    try:
        shutil.rmtree(path, ignore_errors=True)
    except Exception:
        pass


@app.route("/")
def index():
    return render_template("index.html", ffmpeg_available=FFMPEG_AVAILABLE)


@app.route("/api/formats", methods=["POST"])
def api_formats():
    """
    Inspects the link and returns a rich preview (title, thumbnail, duration,
    views, upload date) for every platform.

    For YouTube: also returns which of our preset qualities (144-1080p)
    actually exist for this video, each with an estimated file size.
    For Instagram/TikTok/X/Facebook/other: returns a single estimated size
    for the best-available auto download, plus an MP3 size estimate.
    """
    data = request.get_json(silent=True) or {}
    url = (data.get("url") or "").strip()

    if not url:
        return jsonify({"error": "No link found. Please paste a video/reel link first."}), 400

    if YoutubeDL is None:
        return jsonify({"error": "yt-dlp is not installed. Please install requirements.txt."}), 500

    platform = detect_platform(url)

    ydl_opts = {
        **base_ydl_opts(),
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "noplaylist": True,
    }

    try:
        with YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception as e:
        return jsonify({"error": friendly_extract_error(str(e), platform)}), 400

    formats = info.get("formats", []) or []
    # MP3/audio-only downloads are YouTube-only. For every other platform we
    # simply don't send back an mp3 size, and the frontend won't show the
    # MP3 row at all (see PLATFORM_META / renderPreview in script.js).
    mp3_size = estimate_audio_size(formats) if platform == "youtube" else None

    base_response = {
        "platform": platform,
        "label": PLATFORM_LABELS.get(platform, "Video"),
        "title": info.get("title") or "Video",
        "thumbnail": info.get("thumbnail"),
        "duration_label": format_duration_label(info.get("duration")),
        "views_label": format_view_count(info.get("view_count")),
        "relative_date": format_relative_date(info.get("upload_date")),
        "mp3_size_label": sizeof_fmt(mp3_size) if mp3_size else None,
        "mp3_available": platform == "youtube",
    }

    if platform not in MANUAL_QUALITY_PLATFORMS:
        best_size = estimate_video_size(formats)
        base_response.update({
            "auto": True,
            "best_size_label": sizeof_fmt(best_size) if best_size else None,
            "message": "The best available quality will be downloaded automatically for this platform.",
        })
        return jsonify(base_response)

    available_heights = set()
    for f in formats:
        h = f.get("height")
        vcodec = f.get("vcodec")
        if h and vcodec and vcodec != "none":
            available_heights.add(int(h))

    # Match presets to closest available height (so button always maps to something real)
    qualities_h = []
    for preset in QUALITY_PRESETS:
        if not available_heights:
            continue
        # exact match preferred, else closest available height <= preset, else closest overall
        if preset in available_heights:
            qualities_h.append(preset)
        else:
            candidates = [h for h in available_heights if h <= preset]
            if candidates:
                closest = max(candidates)
            else:
                closest = min(available_heights)
            if closest not in qualities_h:
                qualities_h.append(closest)

    qualities_h = sorted(set(qualities_h), reverse=True)

    qualities = []
    for idx, h in enumerate(qualities_h):
        size = estimate_video_size(formats, height=h)
        qualities.append({
            "height": h,
            "label": quality_label(h),
            "size_label": sizeof_fmt(size) if size else None,
            "best": idx == 0,
        })

    base_response.update({
        "auto": False,
        "qualities": qualities,
    })
    return jsonify(base_response)


class DownloadCancelled(Exception):
    """Raised from inside the progress hook to abort an in-progress yt-dlp download."""
    pass


def run_download_job(job_id, url, mode, quality, platform):
    """Runs in a background thread. Updates JOBS[job_id] live via yt-dlp's progress hook."""

    def progress_hook(d):
        with JOBS_LOCK:
            job = JOBS.get(job_id)
            if not job:
                return
            if job.get("cancel_requested"):
                raise DownloadCancelled("Cancelled by user")
            if d["status"] == "downloading":
                total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
                downloaded = d.get("downloaded_bytes", 0)
                if total:
                    percent = round((downloaded / total) * 100, 1)
                else:
                    # Instagram/TikTok/X/Facebook are often served as
                    # fragmented (HLS/DASH) streams with no known
                    # Content-Length, so total_bytes is never set and the
                    # ring would otherwise stay stuck at 0% the whole time.
                    # Fall back to fragment progress so the % UI still moves.
                    frag_idx = d.get("fragment_index")
                    frag_cnt = d.get("fragment_count")
                    if frag_idx and frag_cnt:
                        percent = round((frag_idx / frag_cnt) * 100, 1)
                    else:
                        percent = job.get("percent") or 0
                speed = d.get("speed")
                eta = d.get("eta")
                job.update({
                    "status": "downloading",
                    "percent": percent,
                    "speed": f"{sizeof_fmt(speed)}/s" if speed else "...",
                    "eta": f"{int(eta)}s" if eta is not None else "...",
                    "downloaded": sizeof_fmt(downloaded),
                    "total": sizeof_fmt(total) if total else "?",
                })
            elif d["status"] == "finished":
                # Raw download finished; ffmpeg merge/audio-extraction may still run.
                job.update({"status": "processing", "percent": 99, "speed": "-", "eta": "-"})

    job_dir = JOBS[job_id]["job_dir"]
    outtmpl = os.path.join(job_dir, "%(title).100s.%(ext)s")

    ydl_opts = {
        **base_ydl_opts(),
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "outtmpl": outtmpl,
        "restrictfilenames": True,
        "progress_hooks": [progress_hook],
    }

    if FFMPEG_DIR:
        ydl_opts["ffmpeg_location"] = FFMPEG_DIR

    if mode == "audio":
        ydl_opts.update({
            "format": "bestaudio/best",
            "postprocessors": [{
                "key": "FFmpegExtractAudio",
                "preferredcodec": "mp3",
                "preferredquality": "192",
            }],
        })
    else:
        if platform in MANUAL_QUALITY_PLATFORMS and quality:
            try:
                q = int(quality)
            except (TypeError, ValueError):
                q = None
            fmt = f"bestvideo[height<={q}]+bestaudio/best[height<={q}]" if q else "bestvideo+bestaudio/best"
            ydl_opts["format"] = fmt
            ydl_opts["merge_output_format"] = "mp4"
        else:
            # Instagram / TikTok / X / Facebook / other -> auto best available quality
            ydl_opts["format"] = "bestvideo+bestaudio/best"
            ydl_opts["merge_output_format"] = "mp4"

    try:
        with YoutubeDL(ydl_opts) as ydl:
            ydl.download([url])

        files = [f for f in os.listdir(job_dir) if os.path.isfile(os.path.join(job_dir, f))]
        if not files:
            raise RuntimeError("The file did not download. Please try again.")

        with JOBS_LOCK:
            JOBS[job_id].update({
                "status": "finished",
                "percent": 100,
                "filename": files[0],
            })
    except DownloadCancelled:
        cleanup_dir(job_dir)
        with JOBS_LOCK:
            JOBS[job_id].update({"status": "cancelled", "error": "Download cancelled."})
    except Exception as e:
        traceback.print_exc()
        cleanup_dir(job_dir)
        with JOBS_LOCK:
            JOBS[job_id].update({"status": "error", "error": friendly_extract_error(str(e), platform)})


@app.route("/api/start-download", methods=["POST"])
def api_start_download():
    """
    Kicks off a background download and returns a job_id immediately so the
    frontend can poll /api/progress/<job_id> for real-time updates.
    JSON body: url, mode ("video"/"audio"), quality (optional, youtube only)
    """
    data = request.get_json(silent=True) or {}
    url = (data.get("url") or "").strip()
    mode = (data.get("mode") or "video").strip()
    quality = data.get("quality")

    if not url:
        return jsonify({"error": "No link found."}), 400

    if YoutubeDL is None:
        return jsonify({"error": "yt-dlp is not installed."}), 500

    if not FFMPEG_AVAILABLE:
        return jsonify({
            "error": "FFmpeg is not installed on this system. FFmpeg is required for "
                     "high-quality video merging and MP3 conversion. See README.md for "
                     "install steps (Windows: winget install \"FFmpeg (Essentials Build)\", "
                     "Mac: brew install ffmpeg, Linux: sudo apt install ffmpeg)."
        }), 500

    platform = detect_platform(url)

    # MP3/audio-only downloads are restricted to YouTube. Enforced here too
    # (not just hidden in the UI) so the restriction can't be bypassed by
    # calling this endpoint directly.
    if mode == "audio" and platform != "youtube":
        return jsonify({
            "error": "MP3 download is only available for YouTube links."
        }), 400
    job_dir = make_job_dir()
    job_id = os.path.basename(job_dir)

    with JOBS_LOCK:
        JOBS[job_id] = {
            "status": "starting",
            "percent": 0,
            "speed": "...",
            "eta": "...",
            "downloaded": "0 B",
            "total": "?",
            "job_dir": job_dir,
            "filename": None,
            "error": None,
            "cancel_requested": False,
        }

    thread = threading.Thread(
        target=run_download_job,
        args=(job_id, url, mode, quality, platform),
        daemon=True,
    )
    thread.start()

    return jsonify({"job_id": job_id})


@app.route("/api/progress/<job_id>", methods=["GET"])
def api_progress(job_id):
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if not job:
            return jsonify({"error": "Job not found."}), 404
        # Don't leak internal filesystem path to the client.
        safe_job = {k: v for k, v in job.items() if k != "job_dir"}
    return jsonify(safe_job)


@app.route("/api/cancel/<job_id>", methods=["POST"])
def api_cancel(job_id):
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if not job:
            return jsonify({"error": "Job not found."}), 404
        job["cancel_requested"] = True
    return jsonify({"status": "cancelling"})


@app.route("/api/fetch-file/<job_id>", methods=["GET"])
def api_fetch_file(job_id):
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if not job:
            return jsonify({"error": "Job not found."}), 404
        if job["status"] != "finished":
            return jsonify({"error": "Download is not finished yet."}), 400
        job_dir = job["job_dir"]
        filename = job["filename"]

    result_path = os.path.join(job_dir, filename)
    if not os.path.isfile(result_path):
        return jsonify({"error": "File not found."}), 404

    @after_this_request
    def cleanup(response):
        cleanup_dir(job_dir)
        with JOBS_LOCK:
            JOBS.pop(job_id, None)
        return response

    return send_file(result_path, as_attachment=True, download_name=filename)


@app.route("/robots.txt")
def robots_txt():
    body = (
        "User-agent: *\n"
        "Allow: /\n"
        "Sitemap: " + request.url_root.rstrip("/") + "/sitemap.xml\n"
    )
    return app.response_class(body, mimetype="text/plain")


@app.route("/sitemap.xml")
def sitemap_xml():
    base = request.url_root.rstrip("/")
    today = datetime.utcnow().strftime("%Y-%m-%d")
    body = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        "  <url>\n"
        f"    <loc>{base}/</loc>\n"
        f"    <lastmod>{today}</lastmod>\n"
        "    <changefreq>weekly</changefreq>\n"
        "    <priority>1.0</priority>\n"
        "  </url>\n"
        "</urlset>\n"
    )
    return app.response_class(body, mimetype="application/xml")


@app.errorhandler(404)
def not_found(e):
    return jsonify({"error": "Route not found."}), 404


if __name__ == "__main__":
    # threaded=True is required so progress-polling requests aren't blocked
    # while a download is running in its background thread.
    #
    # DEBUG must stay off in production — set the DEBUG env var to "1"
    # locally if you want the reloader/debugger back.
    debug_mode = os.environ.get("DEBUG", "0") == "1"
    port = int(os.environ.get("PORT", 5000))
    app.run(debug=debug_mode, host="0.0.0.0", port=port, threaded=True)
