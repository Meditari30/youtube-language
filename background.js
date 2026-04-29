const DEFAULT_SETTINGS = {
  enabled: true,
  sourceLanguage: "auto",
  targetLanguage: "zh-CN",
  showOriginal: true,
  position: "bottom",
  fontSize: 18
};

const translationCache = new Map();
const MAX_CACHE_ITEMS = 400;

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  await chrome.storage.sync.set({ ...DEFAULT_SETTINGS, ...current });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "translate") {
    return false;
  }

  translateText(message.text, message.sourceLanguage, message.targetLanguage)
    .then((translatedText) => sendResponse({ ok: true, translatedText }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));

  return true;
});

async function translateText(text, sourceLanguage, targetLanguage) {
  const normalizedText = normalizeText(text);
  if (!normalizedText) {
    return "";
  }

  const source = sourceLanguage || "auto";
  const target = targetLanguage || "zh-CN";
  const cacheKey = `${source}:${target}:${normalizedText}`;

  if (translationCache.has(cacheKey)) {
    return translationCache.get(cacheKey);
  }

  const url = new URL("https://translate.googleapis.com/translate_a/single");
  url.searchParams.set("client", "gtx");
  url.searchParams.set("sl", source);
  url.searchParams.set("tl", target);
  url.searchParams.set("dt", "t");
  url.searchParams.set("q", normalizedText);

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`Google Translate request failed: ${response.status}`);
  }

  const payload = await response.json();
  const translatedText = parseGoogleTranslateResponse(payload);
  setCache(cacheKey, translatedText);
  return translatedText;
}

function parseGoogleTranslateResponse(payload) {
  if (!Array.isArray(payload?.[0])) {
    throw new Error("Unexpected Google Translate response");
  }

  return payload[0]
    .map((part) => part?.[0])
    .filter(Boolean)
    .join("")
    .trim();
}

function normalizeText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function setCache(key, value) {
  if (translationCache.size >= MAX_CACHE_ITEMS) {
    const oldestKey = translationCache.keys().next().value;
    translationCache.delete(oldestKey);
  }

  translationCache.set(key, value);
}
