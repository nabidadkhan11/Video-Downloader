# All-in-One Video Downloader (Flask)

A web app to download videos/reels from YouTube, Instagram, TikTok, X (Twitter), and Facebook.

## Features
- **YouTube**: Paste a link and available qualities (144p/240p/360p/480p/720p/1080p) are shown — pick whichever you want.
- **Instagram / TikTok / X (Twitter) / Facebook**: Paste a link and the best available (high quality) video downloads automatically — no need to pick a quality.
- **MP3**: Download audio-only MP3 from any of the supported platforms.
- **Real-time Progress**: A live progress bar shows percentage, speed (KB/s or MB/s), and ETA while the download runs. This works via a background thread + polling.

## Requirements

1. **Python 3.9+**
2. **FFmpeg** — required for merging high-quality video streams and for MP3 conversion.
   - Windows: `winget install "FFmpeg (Essentials Build)"` (run in an Administrator terminal), or download from https://www.gyan.dev/ffmpeg/builds/ and add the `bin` folder to your PATH.
   - Mac: `brew install ffmpeg`
   - Linux: `sudo apt install ffmpeg`

   > Without FFmpeg, high quality (720p/1080p) YouTube downloads and MP3 conversion won't work. The app will show a clear warning if FFmpeg isn't found, and also auto-detects common winget/choco/scoop install locations on Windows as a fallback.

   After installing, verify with:
   ```
   ffmpeg -version
   ```
   If you just installed it, open a **new** terminal window before running the app (PATH changes only apply to new terminal sessions).

## Installation

```bash
cd video_downloader
python -m venv venv
source venv/bin/activate      # Windows: venv\Scripts\activate
pip install -r requirements.txt
```

## Run

```bash
python app.py
```

Then open your browser at: `http://127.0.0.1:5000`

## Project Structure

```
video_downloader/
├── app.py                  # Flask backend + yt-dlp logic
├── requirements.txt
├── templates/
│   └── index.html          # Main UI
├── static/
│   ├── css/style.css
│   └── js/script.js
└── downloads/               # Temporary download folder (auto-cleared)
```

## How Deployment Works (if you host this online)

- FFmpeg only needs to be installed on the **server** where the app runs — not on each visitor's device.
- Users just open the site in their browser; the server downloads/processes the video and streams it back as a normal browser download.
- Good hosting options: Render, Railway, or your own VPS (DigitalOcean, Hetzner, etc.). Serverless platforms like Vercel/Netlify won't work since they don't support FFmpeg or long-running background jobs.
- If you deploy with multiple worker processes, note that the in-memory job/progress tracking (`JOBS` dict) is per-process — for a single server instance this works fine, but scaling across multiple instances would need a shared store (e.g. Redis).
- **See [DEPLOYMENT.md](DEPLOYMENT.md)** for a full step-by-step hosting guide (Render/Railway/VPS + Dockerfile/Procfile already included) and an SEO checklist.

## Notes
- Downloads are created in a temporary `downloads/` folder and deleted automatically right after being sent to the user.
- Only download videos you own or have permission to use — respect each platform's terms of service.
- If a link fails (private, age-restricted, geo-blocked, or removed), a clear error message will be shown.
