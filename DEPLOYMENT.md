# Deployment & SEO Guide

## What kind of host does this need?

This app is a real Flask backend (not a static site): it runs `yt-dlp` +
`ffmpeg`, keeps background download jobs in memory, and streams files back
to the browser. That rules out static hosts.

| Won't work | Why |
|---|---|
| Netlify, Vercel, GitHub Pages | Static-only / serverless functions with a short execution limit — can't run ffmpeg or long background jobs |
| Most "free static site" hosts | Same reason |

| Will work | Notes |
|---|---|
| **Render.com** ⭐ recommended | Easiest. Free/low tier, Docker support, works with the `Dockerfile` in this repo out of the box |
| **Railway.app** | Also easy, similar to Render, Docker or Procfile both work |
| **Fly.io** | Docker-first, good if you want the app closer to your users globally |
| **A VPS** (DigitalOcean, Hetzner, Linode) | Most control, cheapest at scale, more setup work |
| PythonAnywhere | Possible but fiddly — ffmpeg and outbound-request limits on the free tier often get in the way |

## Option A — Render (recommended, ~10 minutes)

1. Push this folder to a GitHub repo.
2. Go to [render.com](https://render.com) → **New +** → **Web Service** → connect your repo.
3. Render will detect the `Dockerfile` automatically — leave "Environment" as **Docker**.
4. Instance type: the free tier works for testing; pick a paid tier for real traffic (video downloads are CPU/bandwidth-heavy).
5. Click **Create Web Service**. Render builds the image (installs ffmpeg + Python deps) and gives you a URL like `https://vidlink.onrender.com`.
6. Done — that URL is your live site.

No Dockerfile support on your plan? Render also reads the `Procfile`
(`web: gunicorn app:app ...`) directly if you pick the **Python**
environment instead — just add ffmpeg via Render's "native environment"
build command: `apt-get update && apt-get install -y ffmpeg`.

## Option B — Railway

1. [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**.
2. Railway auto-detects the `Dockerfile`. If it doesn't, add a build command that installs ffmpeg, or switch the service to Docker mode manually.
3. Set the `PORT` variable if Railway doesn't inject one automatically (it usually does).
4. Deploy — you get a `*.up.railway.app` URL.

## Option C — Your own VPS (DigitalOcean/Hetzner/etc.)

```bash
sudo apt update && sudo apt install -y python3-venv ffmpeg nginx
git clone <your-repo-url> vidlink && cd vidlink
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
gunicorn app:app --workers 1 --threads 8 --timeout 180 --bind 127.0.0.1:5000
```

Then put Nginx in front as a reverse proxy (for HTTPS via Certbot) pointing
to `127.0.0.1:5000`, and run gunicorn under `systemd` or `pm2` so it
restarts on crash/reboot.

## Important settings already wired up for you

- `app.py` no longer hardcodes `debug=True` — it reads `DEBUG` and `PORT`
  env vars, defaulting to debug **off**, which is what you want in
  production.
- `Procfile` / `Dockerfile` both run **1 worker**. The app tracks download
  progress in an in-memory dict (`JOBS`), which only works correctly with
  a single process. If you need to scale to multiple instances, move
  `JOBS` to Redis first.
- Gunicorn's timeout is raised to 180s because video extraction/downloads
  can take longer than the 30s default.

## A note on legality

Downloading video from third-party platforms can conflict with their
terms of service, and redistributing copyrighted content without
permission can create legal exposure for you as the operator. If you
host this publicly, make clear (e.g. in the About page) that it's meant
for content you own or have permission to download, and keep in mind
some hosts may take down services that generate large volumes of
copyright complaints.

---

# SEO Checklist

The following is already done in this codebase:

- ✅ Unique `<title>` and `<meta name="description">` in `templates/index.html`
- ✅ Open Graph + Twitter Card meta tags (edit the copy to match your brand once you pick a name)
- ✅ `WebApplication` and `FAQPage` JSON-LD structured data (the FAQ one can earn rich-result snippets in Google search)
- ✅ Semantic heading structure (one `<h1>`, `<h2>` per section, `<h3>`/`<h4>` for sub-points)
- ✅ `/robots.txt` and `/sitemap.xml` routes (served by Flask, see `app.py`)
- ✅ Mobile-responsive layout (Google ranks mobile-friendliness directly)
- ✅ Fast, dependency-light frontend (no heavy JS frameworks)

## What you should still do after deploying

1. **Set your real domain.** Buy a domain (Namecheap, Porkbun, Google Domains successor, etc.) and point it at your host — a custom domain ranks and looks far more trustworthy than a `*.onrender.com` URL.
2. **Google Search Console.** Add your live domain, verify ownership, and submit `https://yourdomain.com/sitemap.xml`.
3. **Bing Webmaster Tools.** Same idea, smaller but free extra traffic.
4. **Replace placeholder content.** The About page currently has placeholder name/bio/social links — search engines and users both penalize obviously-fake "Your Name" placeholder text, so fill in your real details.
5. **Backlinks.** List the tool on directories like Product Hunt, AlternativeTo, or relevant subreddits/forums (where allowed) — backlinks matter more than on-page tweaks for a new site.
6. **Page speed.** Once live, run it through [PageSpeed Insights](https://pagespeed.web.dev/) and fix anything it flags (usually server response time on your chosen host).
7. **Multi-page SEO (optional, bigger win later).** Right now About/History are JS tabs on one URL, so Google only indexes one page. If SEO becomes a priority, turn `/about` and `/history` into real Flask routes with their own `<title>`/meta tags — that gives you more indexable pages and more chances to rank for different search terms.
