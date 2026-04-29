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
let observer = null;

init();

async function init() {
  settings = {
    ...DEFAULT_SETTINGS,
    ...(await chrome.storage.sync.get(DEFAULT_SETTINGS))
  };

  ensureOverlay();
  applySettings();
  startCaptionObserver();
  pollForCaptionChanges();

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") {
      return;
    }

    for (const [key, change] of Object.entries(changes)) {
      settings[key] = change.newValue;
    }

    applySettings();
    requestCaptionTranslation(getCurrentCaptionText());
  });
}

function startCaptionObserver() {
  if (observer) {
    observer.disconnect();
  }

  observer = new MutationObserver(() => {
    requestCaptionTranslation(getCurrentCaptionText());
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true
  });
}

function pollForCaptionChanges() {
  window.setInterval(() => {
    const currentVideoId = new URLSearchParams(location.search).get("v") || location.pathname;
    if (currentVideoId !== lastVideoId) {
      lastVideoId = currentVideoId;
      lastCaptionText = "";
      lastTranslatedText = "";
      renderOverlay("", "");
      ensureOverlay();
    }

    requestCaptionTranslation(getCurrentCaptionText());
  }, 700);
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

  try {
    const response = await chrome.runtime.sendMessage({
      type: "translate",
      text: captionText,
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
