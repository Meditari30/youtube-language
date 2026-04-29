const DEFAULT_SETTINGS = {
  enabled: true,
  sourceLanguage: "auto",
  targetLanguage: "zh-CN",
  showOriginal: true,
  position: "bottom",
  fontSize: 18
};

const RENDER_INTERVAL_MS = 200;
const TRACK_RETRY_MS = 350;
const TRACK_RETRY_LIMIT = 10;
const PREFETCH_AHEAD = 8;
const STORAGE_FLUSH_MS = 900;
const MAX_VIDEO_CACHE_ITEMS = 700;
const DOM_FALLBACK_DELAY_MS = 1600;
const NO_CAPTION_HINT_DELAY_MS = 6000;
const ORIGINAL_DISPLAY_LIMIT = 120;
const TRANSLATED_DISPLAY_LIMIT = 120;

let settings = { ...DEFAULT_SETTINGS };
let overlay;
let video;
let renderTimer = null;
let storageFlushTimer = null;
let videoId = "";
let trackKey = "";
let cacheKey = "";
let loadSerial = 0;
let activeCueIndex = -1;
let cues = [];
let translatedCues = [];
let translations = new Map();
let pendingTranslations = new Map();
let dirtyTranslations = false;
let prefetchTimer = null;
let domFallbackText = "";
let domFallbackTranslatedText = "";
let domFallbackTimer = null;
let captionLoadStartedAt = 0;
let captionTrackFailed = false;
let autoCaptionAttempted = false;
let captionTrackCache = new Map();

init();

async function init() {
  settings = {
    ...DEFAULT_SETTINGS,
    ...(await chrome.storage.sync.get(DEFAULT_SETTINGS))
  };

  ensureOverlay();
  applySettings();
  startRenderLoop();

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") {
      return;
    }

    for (const [key, change] of Object.entries(changes)) {
      settings[key] = change.newValue;
    }

    applySettings();
    resetVideoState();
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "rescan") {
      return false;
    }

    resetVideoState();
    tick();
    sendResponse({ ok: true });
    return false;
  });
}

function startRenderLoop() {
  window.clearInterval(renderTimer);
  renderTimer = window.setInterval(tick, RENDER_INTERVAL_MS);
  tick();
}

function tick() {
  if (!settings.enabled || !isWatchPage()) {
    renderOverlay("", "");
    return;
  }

  const currentVideoId = getVideoId();
  if (!currentVideoId) {
    renderOverlay("", "");
    return;
  }

  if (currentVideoId !== videoId || didLanguageChange()) {
    loadVideoCaptions(currentVideoId);
    return;
  }

  video = document.querySelector("video.html5-main-video, video") || video;
  if (!video || cues.length === 0) {
    tryEnableYouTubeCaptions();
    if (videoId && shouldUseDomFallback()) {
      renderDomFallbackCaption();
    } else if (videoId && shouldShowNoCaptionHint()) {
      renderOverlay("", "Waiting for YouTube captions...");
    }
    return;
  }

  renderCurrentCue(video.currentTime);
}

async function loadVideoCaptions(nextVideoId) {
  const serial = ++loadSerial;
  videoId = nextVideoId;
  captionLoadStartedAt = Date.now();
  trackKey = `${settings.sourceLanguage}:${settings.targetLanguage}`;
  activeCueIndex = -1;
  cues = [];
  translatedCues = [];
  translations = new Map();
  pendingTranslations.clear();
  domFallbackText = "";
  domFallbackTranslatedText = "";
  captionTrackFailed = false;
  autoCaptionAttempted = false;
  window.clearTimeout(domFallbackTimer);
  renderOverlay("", "");

  try {
    const track = await waitForCaptionTrack(nextVideoId, serial);
    if (!track || serial !== loadSerial) {
      if (serial === loadSerial) {
        captionTrackFailed = true;
        tryEnableYouTubeCaptions();
      }
      return;
    }

    const nextCacheKey = buildCacheKey(nextVideoId, track, settings.targetLanguage);
    const cached = await chrome.storage.local.get(nextCacheKey);
    if (serial !== loadSerial) {
      return;
    }

    cacheKey = nextCacheKey;
    translations = new Map(Object.entries(cached[nextCacheKey] || {}));
    const [sourceCues, officialCues] = await Promise.all([
      fetchTrackCues(track),
      fetchOfficialTranslatedCues(track, settings.targetLanguage)
    ]);
    cues = sourceCues;
    translatedCues = officialCues;

    if (serial !== loadSerial) {
      return;
    }

    activeCueIndex = -1;
    video = document.querySelector("video.html5-main-video, video") || video;
    if (video && translatedCues.length === 0) {
      const index = Math.max(findCueIndex(video.currentTime), 0);
      requestTranslationBatch(index, true);
    }
  } catch (error) {
    if (serial === loadSerial) {
      cues = [];
      captionTrackFailed = true;
      renderOverlay("", "");
    }

    console.warn("[YouTube Translator]", error);
  }
}

async function waitForCaptionTrack(nextVideoId, serial) {
  for (let attempt = 0; attempt < TRACK_RETRY_LIMIT; attempt += 1) {
    const track = chooseCaptionTrack(await getCaptionTracks(nextVideoId));
    if (track || serial !== loadSerial) {
      return track;
    }

    await sleep(TRACK_RETRY_MS);
  }

  return null;
}

async function getCaptionTracks(nextVideoId) {
  const cachedTracks = captionTrackCache.get(nextVideoId);
  if (cachedTracks) {
    return cachedTracks;
  }

  const tracks = [];
  const responses = await getPlayerResponses(nextVideoId);

  for (const response of responses) {
    const captionTracks = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (Array.isArray(captionTracks)) {
      tracks.push(...captionTracks);
    }
  }

  const seen = new Set();
  const uniqueTracks = tracks.filter((track) => {
    const key = `${track.baseUrl}:${track.languageCode}:${track.kind || ""}`;
    if (!track.baseUrl || seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });

  captionTrackCache.set(nextVideoId, uniqueTracks);
  return uniqueTracks;
}

async function getPlayerResponses(nextVideoId) {
  const responses = [];

  const inlineResponse = parsePlayerResponse(document.documentElement.innerHTML);
  if (inlineResponse) {
    responses.push(inlineResponse);
  }

  if (responses.length === 0 && nextVideoId) {
    const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(nextVideoId)}`;
    const response = await fetch(watchUrl, { credentials: "include" });
    if (response.ok) {
      const html = await response.text();
      const fetchedResponse = parsePlayerResponse(html);
      if (fetchedResponse) {
        responses.push(fetchedResponse);
      }
    }
  }

  return responses;
}

function parsePlayerResponse(source) {
  const marker = "ytInitialPlayerResponse";
  const markerIndex = source.indexOf(marker);
  if (markerIndex === -1) {
    return null;
  }

  const braceStart = source.indexOf("{", markerIndex);
  if (braceStart === -1) {
    return null;
  }

  const jsonText = extractJsonObject(source, braceStart);
  if (!jsonText) {
    return null;
  }

  try {
    return JSON.parse(jsonText);
  } catch (error) {
    console.warn("[YouTube Translator] Could not parse player response", error);
    return null;
  }
}

function extractJsonObject(source, startIndex) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < source.length; index += 1) {
    const char = source[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }

      continue;
    }

    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(startIndex, index + 1);
      }
    }
  }

  return "";
}

function chooseCaptionTrack(tracks) {
  if (!tracks.length) {
    return null;
  }

  const sourceLanguage = normalizeLanguage(settings.sourceLanguage);
  if (sourceLanguage !== "auto") {
    const exact = tracks.find((track) => normalizeLanguage(track.languageCode) === sourceLanguage);
    if (exact) {
      return exact;
    }

    const related = tracks.find((track) => normalizeLanguage(track.languageCode).startsWith(sourceLanguage));
    if (related) {
      return related;
    }
  }

  const manualTracks = tracks.filter((track) => track.kind !== "asr");
  return manualTracks[0] || tracks[0];
}

async function fetchOfficialTranslatedCues(track, targetLanguage) {
  if (!targetLanguage || normalizeLanguage(targetLanguage) === normalizeLanguage(track.languageCode)) {
    return [];
  }

  try {
    const url = new URL(track.baseUrl);
    url.searchParams.set("fmt", "json3");
    url.searchParams.set("tlang", targetLanguage);

    const response = await fetch(url.toString(), { credentials: "include" });
    if (!response.ok) {
      return [];
    }

    const payload = await response.json();
    return parseJson3Cues(payload);
  } catch (error) {
    console.warn("[YouTube Translator] Official translated captions unavailable", error);
    return [];
  }
}

async function fetchTrackCues(track) {
  const url = new URL(track.baseUrl);
  url.searchParams.set("fmt", "json3");

  const response = await fetch(url.toString(), { credentials: "include" });
  if (!response.ok) {
    throw new Error(`Caption track request failed: ${response.status}`);
  }

  const payload = await response.json();
  return parseJson3Cues(payload);
}

function parseJson3Cues(payload) {
  const parsed = [];
  const events = Array.isArray(payload?.events) ? payload.events : [];

  for (const event of events) {
    const text = (event.segs || [])
      .map((segment) => segment.utf8 || "")
      .join("")
      .replace(/\s+/g, " ")
      .trim();

    if (!text || typeof event.tStartMs !== "number") {
      continue;
    }

    const start = event.tStartMs / 1000;
    const duration = Math.max((event.dDurationMs || 1800) / 1000, 0.4);
    parsed.push({
      id: `${event.tStartMs}:${text}`,
      start,
      end: start + duration,
      text
    });
  }

  return parsed;
}

function renderCurrentCue(currentTime) {
  const index = findCueIndex(currentTime);
  if (index === -1) {
    activeCueIndex = -1;
    if (shouldUseDomFallback()) {
      renderDomFallbackCaption();
    } else {
      renderOverlay("", "");
    }
    return;
  }

  activeCueIndex = index;
  const cue = cues[index];
  const translatedText = getTranslatedCueText(index, cue);

  const hasOfficialTranslation = translatedCues.length > 0;
  if (!translatedText && !hasOfficialTranslation) {
    requestTranslationBatch(index, true);
  }

  if (!hasOfficialTranslation) {
    prefetchTranslations(index);
  }

  if (translatedText) {
    renderOverlay(cue.text, translatedText);
  } else {
    renderOverlay("", "");
  }
}

function getTranslatedCueText(index, cue) {
  const officialCue = translatedCues[index];
  if (officialCue?.text && Math.abs(officialCue.start - cue.start) < 0.8) {
    return officialCue.text;
  }

  const timeMatchedCue = findTranslatedCueByTime(cue.start);
  if (timeMatchedCue?.text) {
    return timeMatchedCue.text;
  }

  return translations.get(cue.id) || "";
}

function findTranslatedCueByTime(startTime) {
  if (translatedCues.length === 0) {
    return null;
  }

  let low = 0;
  let high = translatedCues.length - 1;
  let closestCue = null;
  let closestDistance = Infinity;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const cue = translatedCues[mid];
    const distance = Math.abs(cue.start - startTime);

    if (distance < closestDistance) {
      closestDistance = distance;
      closestCue = cue;
    }

    if (cue.start < startTime) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return closestDistance < 1.2 ? closestCue : null;
}

function findCueIndex(currentTime) {
  if (activeCueIndex >= 0) {
    const activeCue = cues[activeCueIndex];
    if (activeCue && currentTime >= activeCue.start && currentTime <= activeCue.end) {
      return activeCueIndex;
    }
  }

  let low = 0;
  let high = cues.length - 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const cue = cues[mid];

    if (currentTime < cue.start) {
      high = mid - 1;
    } else if (currentTime > cue.end) {
      low = mid + 1;
    } else {
      return mid;
    }
  }

  return -1;
}

function prefetchTranslations(index) {
  window.clearTimeout(prefetchTimer);
  prefetchTimer = window.setTimeout(() => {
    requestTranslationBatch(index, false);
  }, 120);
}

async function requestTranslationBatch(index, includeCurrent) {
  const batch = [];
  const startOffset = includeCurrent ? 0 : 1;

  for (let offset = startOffset; offset <= PREFETCH_AHEAD; offset += 1) {
    const cue = cues[index + offset];
    if (cue && !translations.has(cue.id) && !pendingTranslations.has(cue.id)) {
      batch.push(cue);
    }
  }

  if (batch.length === 0) {
    return;
  }

  for (const cue of batch) {
    pendingTranslations.set(cue.id, true);
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: "translate",
      items: batch.map((cue) => ({ text: cue.text })),
      sourceLanguage: settings.sourceLanguage,
      targetLanguage: settings.targetLanguage
    });

    if (!response?.ok || !Array.isArray(response.translatedText)) {
      throw new Error(response?.error || "Batch translation failed");
    }

    for (let indexInBatch = 0; indexInBatch < batch.length; indexInBatch += 1) {
      const translatedText = normalizeText(response.translatedText[indexInBatch]);
      if (translatedText) {
        const cue = batch[indexInBatch];
        translations.set(cue.id, translatedText);
        dirtyTranslations = true;
        if (activeCueIndex >= 0 && cues[activeCueIndex]?.id === cue.id) {
          renderOverlay(cue.text, translatedText);
        }
      }
    }

    scheduleStorageFlush();
  } catch (error) {
    console.warn("[YouTube Translator]", error);
  } finally {
    for (const cue of batch) {
      pendingTranslations.delete(cue.id);
    }
  }
}

async function requestCueTranslation(cue) {
  if (!cue?.text || translations.has(cue.id) || pendingTranslations.has(cue.id)) {
    return;
  }

  const promise = chrome.runtime
    .sendMessage({
      type: "translate",
      text: cue.text,
      sourceLanguage: settings.sourceLanguage,
      targetLanguage: settings.targetLanguage
    })
    .then((response) => {
      if (!response?.ok) {
        throw new Error(response?.error || "Translation failed");
      }

      const translatedText = normalizeText(response.translatedText);
      if (translatedText) {
        translations.set(cue.id, translatedText);
        dirtyTranslations = true;
        scheduleStorageFlush();
        if (activeCueIndex >= 0 && cues[activeCueIndex]?.id === cue.id) {
          renderOverlay(cue.text, translatedText);
        }
      }
    })
    .catch((error) => {
      console.warn("[YouTube Translator]", error);
    })
    .finally(() => {
      pendingTranslations.delete(cue.id);
    });

  pendingTranslations.set(cue.id, promise);
}

function shouldUseDomFallback() {
  return captionLoadStartedAt > 0 && (captionTrackFailed || Date.now() - captionLoadStartedAt > DOM_FALLBACK_DELAY_MS);
}

function shouldShowNoCaptionHint() {
  return captionLoadStartedAt > 0 && Date.now() - captionLoadStartedAt > NO_CAPTION_HINT_DELAY_MS;
}

function renderDomFallbackCaption() {
  const captionText = getCurrentDomCaptionText();

  if (!captionText) {
    renderOverlay("", shouldShowNoCaptionHint() ? "No YouTube captions detected. Turn on CC if this video has subtitles." : "");
    return;
  }

  if (captionText !== domFallbackText) {
    domFallbackText = captionText;
    domFallbackTranslatedText = "";
    requestDomFallbackTranslation(captionText);
  }

  if (domFallbackTranslatedText) {
    renderOverlay(captionText, domFallbackTranslatedText);
  } else {
    renderOverlay("", "");
  }
}

function tryEnableYouTubeCaptions() {
  if (autoCaptionAttempted) {
    return;
  }

  const captionsButton = document.querySelector(".ytp-subtitles-button");
  if (!captionsButton || captionsButton.getAttribute("aria-pressed") === "true") {
    autoCaptionAttempted = true;
    return;
  }

  autoCaptionAttempted = true;
  captionsButton.click();
}

function getCurrentDomCaptionText() {
  return [...document.querySelectorAll(".ytp-caption-segment")]
    .map((segment) => segment.textContent || "")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function requestDomFallbackTranslation(text) {
  window.clearTimeout(domFallbackTimer);
  domFallbackTimer = window.setTimeout(async () => {
    try {
      const response = await chrome.runtime.sendMessage({
        type: "translate",
        text,
        sourceLanguage: settings.sourceLanguage,
        targetLanguage: settings.targetLanguage
      });

      if (text !== domFallbackText || !response?.ok) {
        return;
      }

      domFallbackTranslatedText = normalizeText(response.translatedText);
      renderOverlay(text, domFallbackTranslatedText);
    } catch (error) {
      console.warn("[YouTube Translator]", error);
    }
  }, 250);
}

function scheduleStorageFlush() {
  window.clearTimeout(storageFlushTimer);
  storageFlushTimer = window.setTimeout(() => {
    if (!dirtyTranslations || !cacheKey) {
      return;
    }

    dirtyTranslations = false;
    trimTranslationCache();
    chrome.storage.local.set({
      [cacheKey]: Object.fromEntries(translations)
    });
  }, STORAGE_FLUSH_MS);
}

function trimTranslationCache() {
  while (translations.size > MAX_VIDEO_CACHE_ITEMS) {
    const firstKey = translations.keys().next().value;
    translations.delete(firstKey);
  }
}

function ensureOverlay() {
  if (overlay && document.documentElement.contains(overlay)) {
    return overlay;
  }

  overlay = document.createElement("div");
  overlay.id = "yt-language-translator-overlay";
  overlay.setAttribute("aria-live", "polite");
  overlay.innerHTML = `
    <div class="ytlt-original"></div>
    <div class="ytlt-translated"></div>
  `;

  document.documentElement.appendChild(overlay);
  return overlay;
}

function renderOverlay(originalText, translatedText) {
  ensureOverlay();

  const originalNode = overlay.querySelector(".ytlt-original");
  const translatedNode = overlay.querySelector(".ytlt-translated");
  const displayOriginalText = formatDisplayLine(originalText, ORIGINAL_DISPLAY_LIMIT);
  const displayTranslatedText = formatDisplayLine(translatedText, TRANSLATED_DISPLAY_LIMIT);
  const hasOriginalText = Boolean(displayOriginalText);
  const hasTranslatedText = Boolean(displayTranslatedText);
  const shouldShow = settings.enabled && (hasTranslatedText || (settings.showOriginal && hasOriginalText));

  overlay.classList.toggle("ytlt-hidden", !shouldShow);
  overlay.classList.toggle("ytlt-top", settings.position === "top");
  overlay.classList.toggle("ytlt-bottom", settings.position !== "top");
  originalNode.hidden = !settings.showOriginal || !hasOriginalText;
  originalNode.textContent = displayOriginalText;
  translatedNode.textContent = displayTranslatedText;
}

function applySettings() {
  ensureOverlay();
  overlay.style.setProperty("--ytlt-font-size", `${settings.fontSize || 18}px`);
  overlay.classList.toggle("ytlt-hidden", !settings.enabled);
  overlay.classList.toggle("ytlt-top", settings.position === "top");
  overlay.classList.toggle("ytlt-bottom", settings.position !== "top");
}

function resetVideoState() {
  videoId = "";
  trackKey = "";
  cacheKey = "";
  activeCueIndex = -1;
  cues = [];
  translatedCues = [];
  translations = new Map();
  pendingTranslations.clear();
  captionLoadStartedAt = 0;
  captionTrackFailed = false;
  autoCaptionAttempted = false;
  window.clearTimeout(prefetchTimer);
  domFallbackText = "";
  domFallbackTranslatedText = "";
  window.clearTimeout(domFallbackTimer);
  renderOverlay("", "");
}

function didLanguageChange() {
  return trackKey !== `${settings.sourceLanguage}:${settings.targetLanguage}`;
}

function buildCacheKey(nextVideoId, track, targetLanguage) {
  return `ytlt:${nextVideoId}:${track.languageCode || "auto"}:${track.kind || "manual"}:${targetLanguage}`;
}

function getVideoId() {
  return new URLSearchParams(location.search).get("v") || "";
}

function isWatchPage() {
  return location.hostname.includes("youtube.com") && location.pathname === "/watch";
}

function normalizeText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function formatDisplayLine(text, limit) {
  const normalized = normalizeText(text);
  if (normalized.length <= limit) {
    return normalized;
  }

  return `${normalized.slice(0, limit - 1).trim()}...`;
}

function normalizeLanguage(language) {
  return String(language || "auto").toLowerCase();
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
