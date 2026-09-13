/* ==========================================================
   VidLink frontend
   ========================================================== */

/* ---------- element refs ---------- */
const urlInput = document.getElementById("urlInput");
const checkBtn = document.getElementById("checkBtn");
const statusMsg = document.getElementById("statusMsg");

const previewCard = document.getElementById("previewCard");
const previewPlatIcon = document.getElementById("previewPlatIcon");
const previewPlatLabel = document.getElementById("previewPlatLabel");
const previewThumb = document.getElementById("previewThumb");
const thumbFallback = document.getElementById("thumbFallback");
const thumbDuration = document.getElementById("thumbDuration");
const previewTitle = document.getElementById("previewTitle");
const previewSub = document.getElementById("previewSub");
const detectSteps = document.getElementById("detectSteps");

const optionsCard = document.getElementById("optionsCard");
const qualityButtons = document.getElementById("qualityButtons");
const primaryDownloadBtn = document.getElementById("primaryDownloadBtn");

const loadingOverlay = document.getElementById("loadingOverlay");
const loadingText = document.getElementById("loadingText");
const loadingSub = document.getElementById("loadingSub");
const progressPercent = document.getElementById("progressPercent");
const ringFill = document.getElementById("ringFill");
const progressSpeed = document.getElementById("progressSpeed");
const progressEta = document.getElementById("progressEta");
const progressQualityLabel = document.getElementById("progressQualityLabel");
const cancelBtn = document.getElementById("cancelBtn");

const doneOverlay = document.getElementById("doneOverlay");
const doneThumb = document.getElementById("doneThumb");
const doneThumbFallback = document.getElementById("doneThumbFallback");
const doneFilename = document.getElementById("doneFilename");
const doneFileMeta = document.getElementById("doneFileMeta");
const doneCloseBtn = document.getElementById("doneCloseBtn");
const downloadAnotherBtn = document.getElementById("downloadAnotherBtn");

// (progress bar fill now uses simple width%, no circumference math needed)

const PLATFORM_META = {
  youtube: { label: "YouTube", icon: "\u25B6", cls: "yt" },
  instagram: { label: "Instagram", icon: "\u25CE", cls: "ig" },
  tiktok: { label: "TikTok", icon: "\u266B", cls: "tt" },
  twitter: { label: "X (Twitter)", icon: "\uD835\uDD4F", cls: "xx" },
  facebook: { label: "Facebook", icon: "f", cls: "fb" },
  other: { label: "Video", icon: "\uD83D\uDD17", cls: "other" },
};

const EXAMPLE_URLS = {
  youtube: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  tiktok: "https://www.tiktok.com/@user/video/1234567890",
  instagram: "https://www.instagram.com/reel/xxxxxxxxxxx/",
  facebook: "https://www.facebook.com/watch/?v=1234567890",
  twitter: "https://x.com/user/status/1234567890",
};

let currentUrl = "";
let currentData = null;
let selectedQuality = null;
let pollTimer = null;
let currentJobId = null;
let pendingMode = "video";
let pendingQuality = null;

/* ---------- settings (localStorage) ---------- */
const SETTINGS_KEY = "vidlink_settings";
function loadSettings() {
  try {
    return Object.assign(
      { theme: "light" },
      JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}")
    );
  } catch (e) {
    return { theme: "light" };
  }
}
function saveSettings(s) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}
let settings = loadSettings();


/* ==========================================================
   Theme
   ========================================================== */
const themeToggle = document.getElementById("themeToggle");
const themeIcon = document.getElementById("themeIcon");

const MOON_SVG = '<svg class="icon" viewBox="0 0 24 24"><path d="M21 12.6A9 9 0 1 1 11.4 3a7 7 0 0 0 9.6 9.6Z"/></svg>';
const SUN_SVG = '<svg class="icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  themeIcon.innerHTML = theme === "dark" ? MOON_SVG : SUN_SVG;
  settings.theme = theme;
  saveSettings(settings);
}
applyTheme(settings.theme);

themeToggle.addEventListener("click", () => {
  applyTheme(settings.theme === "dark" ? "light" : "dark");
});


/* ==========================================================
   Platform quick-select chips
   ========================================================== */
document.querySelectorAll(".platform-chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    document.querySelectorAll(".platform-chip").forEach((c) => c.classList.remove("active"));
    chip.classList.add("active");
    const plat = chip.dataset.platform;
    if (!urlInput.value.trim() && EXAMPLE_URLS[plat]) {
      urlInput.placeholder = "e.g. " + EXAMPLE_URLS[plat];
    }
    urlInput.focus();
  });
});

document.getElementById("supportedBtn").addEventListener("click", () => {
  setStatus("Supported: YouTube, TikTok, Instagram, Facebook, X (Twitter).", "info");
});

/* ==========================================================
   Status helper
   ========================================================== */
function setStatus(msg, type) {
  statusMsg.textContent = msg || "";
  statusMsg.className = "status" + (type ? " " + type : "");
}

/* ==========================================================
   Check link -> preview
   ========================================================== */
checkBtn.addEventListener("click", checkLink);
urlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") checkLink();
});

function resetPreview() {
  previewThumb.classList.add("hidden");
  thumbFallback.classList.remove("hidden");
  thumbDuration.classList.add("hidden");
  previewTitle.textContent = "Paste a link above to preview your video here";
  previewSub.classList.add("hidden");
  previewSub.textContent = "";
  optionsCard.classList.add("hidden");
  detectSteps.classList.add("hidden");
  previewPlatIcon.className = "p-icon yt";
  previewPlatIcon.textContent = "\u25B6";
  previewPlatLabel.textContent = "YouTube";
}

function stepDetect(step) {
  return new Promise((resolve) => {
    detectSteps.classList.remove("hidden");
    const els = detectSteps.querySelectorAll(".detect-step");
    els.forEach((el) => el.classList.remove("active", "done"));
    let i = 0;
    const order = ["fetch", "qualities", "prep"];
    const interval = setInterval(() => {
      if (i > 0) els[i - 1].classList.add("done");
      if (i < order.length) {
        els[i].classList.add("active");
        i++;
      } else {
        clearInterval(interval);
        resolve();
      }
    }, 220);
  });
}

async function checkLink() {
  const url = urlInput.value.trim();
  if (!url) {
    setStatus("Please paste a link first.", "error");
    return;
  }

  currentUrl = url;
  currentData = null;
  selectedQuality = null;
  resetPreview();
  setStatus("Checking link...", "info");
  checkBtn.disabled = true;

  const detectPromise = stepDetect();

  try {
    const res = await fetch("/api/formats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    await detectPromise;
    detectSteps.classList.add("hidden");

    if (!res.ok) {
      setStatus(data.error || "Something went wrong.", "error");
      return;
    }

    setStatus("", "");
    currentData = data;
    renderPreview(data);
  } catch (err) {
    await detectPromise;
    detectSteps.classList.add("hidden");
    setStatus("Could not connect to the server.", "error");
  } finally {
    checkBtn.disabled = false;
  }
}

function renderPreview(data) {
  const meta = PLATFORM_META[data.platform] || PLATFORM_META.other;
  previewPlatIcon.className = "p-icon " + meta.cls;
  previewPlatIcon.textContent = meta.icon;
  previewPlatLabel.textContent = data.label || meta.label;

  if (data.thumbnail) {
    previewThumb.src = data.thumbnail;
    previewThumb.classList.remove("hidden");
    thumbFallback.classList.add("hidden");
  } else {
    previewThumb.classList.add("hidden");
    thumbFallback.classList.remove("hidden");
  }

  if (data.duration_label) {
    thumbDuration.textContent = data.duration_label;
    thumbDuration.classList.remove("hidden");
  }

  previewTitle.textContent = data.title || "Video";

  const subParts = [data.views_label, data.relative_date].filter(Boolean);
  if (subParts.length) {
    previewSub.textContent = subParts.join(" \u2022 ");
    previewSub.classList.remove("hidden");
  }

  optionsCard.classList.remove("hidden");
  qualityButtons.innerHTML = "";

  if (data.auto) {
    selectedQuality = null;
    const row = buildQualityRow({
      label: "Best available quality",
      sizeLabel: data.best_size_label,
      best: true,
      value: null,
    });
    row.classList.add("selected");
    qualityButtons.appendChild(row);
  } else if (data.qualities && data.qualities.length) {
    data.qualities.forEach((q, idx) => {
      const row = buildQualityRow({
        label: `MP4 \u2014 ${q.label}`,
        sizeLabel: q.size_label,
        best: q.best,
        value: q.height,
      });
      if (idx === 0) {
        row.classList.add("selected");
        selectedQuality = q.height;
      }
      qualityButtons.appendChild(row);
    });
  } else {
    const row = buildQualityRow({ label: "Best available quality", sizeLabel: null, best: true, value: null });
    row.classList.add("selected");
    qualityButtons.appendChild(row);
  }

  // MP3 row — YouTube only. Other platforms (Instagram/TikTok/X/Facebook)
  // don't get an audio-only option at all.
  if (data.platform === "youtube") {
    const mp3Row = buildQualityRow({
      label: '<svg class="icon" viewBox="0 0 24 24"><path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/></svg> MP3 (Audio Only)',
      sizeLabel: data.mp3_size_label,
      best: false,
      value: "mp3",
    });
    qualityButtons.appendChild(mp3Row);
  }

  primaryDownloadBtn.onclick = () => {
    const mode = selectedQuality === "mp3" ? "audio" : "video";
    downloadFile(mode, mode === "audio" ? null : selectedQuality);
  };
}

function buildQualityRow({ label, sizeLabel, best, value }) {
  const row = document.createElement("div");
  row.className = "quality-row";
  row.innerHTML = `
    <span class="radio"></span>
    <span class="q-label">${label}${best ? '<span class="best-tag">BEST</span>' : ""}</span>
    <span class="q-size">${sizeLabel || ""}</span>
  `;
  row.addEventListener("click", () => {
    qualityButtons.querySelectorAll(".quality-row").forEach((r) => r.classList.remove("selected"));
    row.classList.add("selected");
    selectedQuality = value;
  });
  return row;
}

/* ==========================================================
   Download flow (start job -> poll -> fetch file)
   ========================================================== */
function updateRing(percent) {
  const clamped = Math.min(100, Math.max(0, percent));
  ringFill.style.width = clamped + "%";
}

function showLoading(qualityLabel) {
  progressPercent.textContent = "0";
  updateRing(0);
  progressSpeed.textContent = "...";
  progressEta.textContent = "...";
  progressQualityLabel.textContent = qualityLabel || "\u2014";
  loadingText.textContent = "Downloading video\u2026";
  loadingSub.textContent = currentData ? (currentData.title || "") : "";
  loadingOverlay.classList.remove("hidden");
}

function hideLoading() {
  loadingOverlay.classList.add("hidden");
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function downloadFile(mode, quality) {
  if (!currentUrl) return;
  pendingMode = mode;
  pendingQuality = quality;

  const qLabel = mode === "audio" ? "MP3 Audio" : (quality ? quality + "p" : "Best Quality");
  showLoading(qLabel);

  try {
    const startRes = await fetch("/api/start-download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: currentUrl, mode, quality }),
    });
    const startData = await startRes.json();

    if (!startRes.ok) {
      setStatus(startData.error || "Could not start the download.", "error");
      hideLoading();
      return;
    }

    currentJobId = startData.job_id;
    pollTimer = setInterval(() => pollProgress(currentJobId), 650);
  } catch (err) {
    setStatus("Something went wrong starting the download.", "error");
    hideLoading();
  }
}

async function pollProgress(jobId) {
  try {
    const res = await fetch(`/api/progress/${jobId}`);
    const data = await res.json();

    if (!res.ok) {
      clearInterval(pollTimer);
      pollTimer = null;
      setStatus(data.error || "Could not check progress.", "error");
      hideLoading();
      return;
    }

    if (data.status === "downloading" || data.status === "starting") {
      loadingText.textContent = "Downloading video\u2026";
      const pct = data.percent ?? 0;
      progressPercent.textContent = Math.round(pct);
      updateRing(pct);
      progressSpeed.textContent = data.speed || "...";
      progressEta.textContent = data.eta || "...";
    } else if (data.status === "processing") {
      loadingText.textContent = "Processing (merging/converting)\u2026";
      progressPercent.textContent = "99";
      updateRing(99);
      progressSpeed.textContent = "\u2014";
      progressEta.textContent = "\u2014";
    } else if (data.status === "finished") {
      clearInterval(pollTimer);
      pollTimer = null;
      progressPercent.textContent = "100";
      updateRing(100);
      loadingText.textContent = "Ready! Saving file\u2026";
      await fetchFinishedFile(jobId);
    } else if (data.status === "cancelled") {
      clearInterval(pollTimer);
      pollTimer = null;
      hideLoading();
      setStatus("Download cancelled.", "info");
    } else if (data.status === "error") {
      clearInterval(pollTimer);
      pollTimer = null;
      setStatus(data.error || "Download failed.", "error");
      hideLoading();
    }
  } catch (err) {
    clearInterval(pollTimer);
    pollTimer = null;
    setStatus("Something went wrong while checking progress.", "error");
    hideLoading();
  }
}

cancelBtn.addEventListener("click", async () => {
  if (currentJobId) {
    try {
      await fetch(`/api/cancel/${currentJobId}`, { method: "POST" });
    } catch (e) {
      /* ignore */
    }
  }
});

async function fetchFinishedFile(jobId) {
  try {
    const res = await fetch(`/api/fetch-file/${jobId}`);

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setStatus(data.error || "Could not download the file.", "error");
      hideLoading();
      return;
    }

    const blob = await res.blob();
    let filename = "download";
    const disposition = res.headers.get("Content-Disposition");
    if (disposition) {
      const match = disposition.match(/filename="?([^"]+)"?/);
      if (match) filename = match[1];
    }

    const blobUrl = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(blobUrl);

    const sizeLabel = pendingMode === "audio"
      ? (currentData && currentData.mp3_size_label)
      : (currentData && (currentData.best_size_label ||
          (currentData.qualities || []).find((q) => q.height === selectedQuality)?.size_label));

    hideLoading();
    showDone(filename, sizeLabel);
  } catch (err) {
    setStatus("Something went wrong saving the file.", "error");
    hideLoading();
  }
}

function showDone(filename, sizeLabel) {
  if (currentData && currentData.thumbnail) {
    doneThumb.src = currentData.thumbnail;
    doneThumb.classList.remove("hidden");
    doneThumbFallback.classList.add("hidden");
  } else {
    doneThumb.classList.add("hidden");
    doneThumbFallback.classList.remove("hidden");
  }
  doneFilename.textContent = filename;
  doneFileMeta.textContent = sizeLabel || "Saved to Downloads";
  doneOverlay.classList.remove("hidden");
  recordHistoryEntry(filename, sizeLabel);
}

doneCloseBtn.addEventListener("click", () => {
  doneOverlay.classList.add("hidden");
  setStatus("\u2713 Download complete", "info");
});
downloadAnotherBtn.addEventListener("click", () => {
  doneOverlay.classList.add("hidden");
  urlInput.value = "";
  resetPreview();
  setStatus("", "");
  urlInput.focus();
});

/* ==========================================================
   Utils
   ========================================================== */
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : str;
  return div.innerHTML;
}

/* ==========================================================
   Tab navigation (Home / History / About)
   ========================================================== */
function setActiveTab(tab) {
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.add("hidden"));
  const panel = document.getElementById("tab-" + tab);
  if (panel) panel.classList.remove("hidden");

  document.querySelectorAll("[data-tab]").forEach((el) => {
    el.classList.toggle("active", el.dataset.tab === tab);
  });

  if (tab === "history") renderHistory();
  closeDrawer();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

document.querySelectorAll("[data-tab]").forEach((el) => {
  el.addEventListener("click", () => setActiveTab(el.dataset.tab));
});

document.getElementById("ctaBtn").addEventListener("click", () => {
  setActiveTab("home");
  setTimeout(() => urlInput.focus(), 300);
});

/* ==========================================================
   Mobile drawer
   ========================================================== */
const hamburgerBtn = document.getElementById("hamburgerBtn");
const mobileDrawer = document.getElementById("mobileDrawer");
const drawerBackdrop = document.getElementById("drawerBackdrop");
const drawerCloseBtn = document.getElementById("drawerCloseBtn");

function openDrawer() {
  mobileDrawer.classList.add("open");
  drawerBackdrop.classList.remove("hidden");
}
function closeDrawer() {
  mobileDrawer.classList.remove("open");
  drawerBackdrop.classList.add("hidden");
}
hamburgerBtn.addEventListener("click", openDrawer);
drawerCloseBtn.addEventListener("click", closeDrawer);
drawerBackdrop.addEventListener("click", closeDrawer);

/* ==========================================================
   Footer year
   ========================================================== */
const yearNow = new Date().getFullYear();
const footerYearEl = document.getElementById("footerYear");
const drawerYearEl = document.getElementById("drawerYear");
if (footerYearEl) footerYearEl.textContent = yearNow;
if (drawerYearEl) drawerYearEl.textContent = yearNow;

/* ==========================================================
   Download history (saved locally on this device only)
   ========================================================== */
const HISTORY_KEY = "vidlink_history";
const HISTORY_LIMIT = 50;
const historyList = document.getElementById("historyList");
const clearHistoryBtn = document.getElementById("clearHistoryBtn");

function loadHistoryEntries() {
  try {
    const arr = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

function saveHistoryEntries(arr) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(arr.slice(0, HISTORY_LIMIT)));
  } catch (e) {
    /* storage full or unavailable — ignore silently */
  }
}

function recordHistoryEntry(filename, sizeLabel) {
  const platform = (currentData && currentData.platform) || "other";
  const meta = PLATFORM_META[platform] || PLATFORM_META.other;
  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    url: currentUrl,
    title: (currentData && currentData.title) || "Video",
    thumbnail: (currentData && currentData.thumbnail) || "",
    platform: platform,
    platformLabel: (currentData && currentData.label) || meta.label,
    mode: pendingMode,
    quality: pendingQuality,
    sizeLabel: sizeLabel || "",
    filename: filename,
    timestamp: Date.now(),
  };
  const arr = loadHistoryEntries();
  arr.unshift(entry);
  saveHistoryEntries(arr);
}

function formatHistoryDate(ts) {
  const diffMs = Date.now() - ts;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return mins + "m ago";
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + "h ago";
  const days = Math.floor(hrs / 24);
  if (days < 7) return days + "d ago";
  return new Date(ts).toLocaleDateString();
}

function renderHistory() {
  if (!historyList) return;
  const arr = loadHistoryEntries();
  historyList.innerHTML = "";

  if (!arr.length) {
    historyList.innerHTML = `
      <div class="empty-state">
        <div class="es-icon"><svg class="icon" viewBox="0 0 24 24" style="width:32px;height:32px;"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg></div>
        <p>No downloads yet. Anything you download will show up here.</p>
      </div>`;
    return;
  }

  arr.forEach((item) => {
    const meta = PLATFORM_META[item.platform] || PLATFORM_META.other;
    const row = document.createElement("div");
    row.className = "hist-item";

    const thumbHtml = item.thumbnail
      ? `<img src="${item.thumbnail}" alt="" class="hist-thumb">`
      : `<div class="hist-thumb-fallback"><svg class="icon" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/></svg></div>`;

    const qualityLabel = item.mode === "audio" ? "MP3 Audio" : (item.quality ? item.quality + "p" : "Best Quality");
    const metaParts = [item.platformLabel || meta.label, qualityLabel, item.sizeLabel, formatHistoryDate(item.timestamp)].filter(Boolean);

    row.innerHTML = `
      ${thumbHtml}
      <div class="hist-info">
        <div class="hist-title">${escapeHtml(item.title)}</div>
        <div class="hist-meta">${escapeHtml(metaParts.join(" \u2022 "))}</div>
      </div>
      <div class="hist-actions">
        <button class="hist-btn redownload" title="Redownload">
          <svg class="icon" viewBox="0 0 24 24"><path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M4 21h16"/></svg>
        </button>
        <button class="hist-btn remove" title="Remove from history">
          <svg class="icon" viewBox="0 0 24 24"><line x1="5" y1="5" x2="19" y2="19"/><line x1="19" y1="5" x2="5" y2="19"/></svg>
        </button>
      </div>
    `;

    row.querySelector(".redownload").addEventListener("click", () => redownloadHistoryItem(item));
    row.querySelector(".remove").addEventListener("click", () => {
      saveHistoryEntries(loadHistoryEntries().filter((i) => i.id !== item.id));
      renderHistory();
    });

    historyList.appendChild(row);
  });
}

function redownloadHistoryItem(item) {
  currentUrl = item.url;
  currentData = {
    title: item.title,
    thumbnail: item.thumbnail,
    platform: item.platform,
    label: item.platformLabel,
    best_size_label: item.mode !== "audio" ? item.sizeLabel : null,
    mp3_size_label: item.mode === "audio" ? item.sizeLabel : null,
  };
  selectedQuality = item.mode === "audio" ? "mp3" : item.quality;

  setActiveTab("home");
  resetPreview();

  const meta = PLATFORM_META[item.platform] || PLATFORM_META.other;
  previewPlatIcon.className = "p-icon " + meta.cls;
  previewPlatIcon.textContent = meta.icon;
  previewPlatLabel.textContent = item.platformLabel || meta.label;
  if (item.thumbnail) {
    previewThumb.src = item.thumbnail;
    previewThumb.classList.remove("hidden");
    thumbFallback.classList.add("hidden");
  }
  previewTitle.textContent = item.title || "Video";
  optionsCard.classList.add("hidden");

  setStatus('Redownloading "' + (item.title || "video") + '"\u2026', "info");
  downloadFile(item.mode, item.mode === "audio" ? null : item.quality);
}

if (clearHistoryBtn) {
  clearHistoryBtn.addEventListener("click", () => {
    if (!loadHistoryEntries().length) return;
    if (confirm("Clear your entire download history on this device?")) {
      localStorage.removeItem(HISTORY_KEY);
      renderHistory();
    }
  });
}

/* init */
resetPreview();
