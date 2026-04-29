const DEFAULT_SETTINGS = {
  enabled: true,
  sourceLanguage: "auto",
  targetLanguage: "zh-CN",
  showOriginal: true,
  position: "bottom",
  fontSize: 18
};

let settings = { ...DEFAULT_SETTINGS };
let overlay;
let lastCaptionText = "";
let lastTranslatedText = "";
let lastVideoId = "";
let translateTimer = null;
let requestSerial = 0;
let pollTimer = null;
let lastRequestTime = 0;

const MIN_TRANSLATE_INTERVAL = 1200;
const MAX_CAPTION_LENGTH = 500;

init();

async function init() {
  settings = {
    ...DEFAULT_SETTINGS,
    ...(await chrome.storage.sync.get(DEFAULT_SETTINGS))
  };

  ensureOverlay();
  applySettings();
  pollForCaptionChanges();

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") {
      return;
    }

    for (const [key, change] of Object.entries(changes)) {
      settings[key] = change.newValue;
    }

    applySettings();
    if (isWatchPage()) {
      requestCaptionTranslation(getCurrentCaptionText());
    }
  });
}

function pollForCaptionChanges() {
  window.clearInterval(pollTimer);
  pollTimer = window.setInterval(() => {
    if (!isWatchPage()) {
      lastCaptionText = "";
      lastTranslatedText = "";
      renderOverlay("", "");
      return;
    }

    const currentVideoId = new URLSearchParams(location.search).get("v") || location.pathname;
    if (currentVideoId !== lastVideoId) {
      lastVideoId = currentVideoId;
      lastCaptionText = "";
      lastTranslatedText = "";
      renderOverlay("", "");
      ensureOverlay();
    }

    requestCaptionTranslation(getCurrentCaptionText());
  }, 1000);
}

function getCurrentCaptionText() {
  const captionSegments = [
    ...document.querySelectorAll(".ytp-caption-segment")
  ];

  const text = captionSegments
    .map((segment) => segment.textContent || "")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  return text;
}

function requestCaptionTranslation(captionText) {
  const normalizedCaption = normalizeText(captionText);

  if (!settings.enabled || !normalizedCaption) {
    lastCaptionText = normalizedCaption;
    lastTranslatedText = "";
    renderOverlay(normalizedCaption, "");
    return;
  }

  if (normalizedCaption === lastCaptionText) {
    renderOverlay(normalizedCaption, lastTranslatedText);
    return;
  }

  lastCaptionText = normalizedCaption;
  lastTranslatedText = "";
  renderOverlay(normalizedCaption, "");

  window.clearTimeout(translateTimer);
  translateTimer = window.setTimeout(() => {
    translateCurrentCaption(normalizedCaption);
  }, 160);
}

async function translateCurrentCaption(captionText) {
  const serial = ++requestSerial;
  const elapsed = Date.now() - lastRequestTime;

  if (elapsed < MIN_TRANSLATE_INTERVAL) {
    window.clearTimeout(translateTimer);
    translateTimer = window.setTimeout(() => {
      translateCurrentCaption(captionText);
    }, MIN_TRANSLATE_INTERVAL - elapsed);
    return;
  }

  lastRequestTime = Date.now();

  try {
    const response = await chrome.runtime.sendMessage({
      type: "translate",
      text: captionText.slice(0, MAX_CAPTION_LENGTH),
      sourceLanguage: settings.sourceLanguage,
      targetLanguage: settings.targetLanguage
    });

    if (serial !== requestSerial || captionText !== lastCaptionText) {
      return;
    }

    if (!response?.ok) {
      throw new Error(response?.error || "Translation failed");
    }

    lastTranslatedText = normalizeText(response.translatedText);
    renderOverlay(captionText, lastTranslatedText);
  } catch (error) {
    lastTranslatedText = "";
    renderOverlay(captionText, "Translation unavailable");
    console.warn("[YouTube Translator]", error);
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
  const hasTranslatedText = Boolean(normalizeText(translatedText));
  const shouldShow = settings.enabled && (hasTranslatedText || settings.showOriginal);

  overlay.classList.toggle("ytlt-hidden", !shouldShow);
  overlay.classList.toggle("ytlt-top", settings.position === "top");
  overlay.classList.toggle("ytlt-bottom", settings.position !== "top");
  originalNode.hidden = !settings.showOriginal || !originalText;
  originalNode.textContent = originalText || "";
  translatedNode.textContent = translatedText || "";
}

function applySettings() {
  ensureOverlay();
  overlay.style.setProperty("--ytlt-font-size", `${settings.fontSize || 18}px`);
  overlay.classList.toggle("ytlt-hidden", !settings.enabled);
  overlay.classList.toggle("ytlt-top", settings.position === "top");
  overlay.classList.toggle("ytlt-bottom", settings.position !== "top");
}

function normalizeText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function isWatchPage() {
  return location.hostname.includes("youtube.com") && location.pathname === "/watch";
}
