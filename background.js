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
const MAX_BATCH_ITEMS = 8;
const MAX_TEXT_LENGTH = 600;
const TRANSLATION_CACHE_KEY = "ytlt-background-cache";
const pendingRequests = new Map();
let cacheLoaded = false;
let activeRequests = 0;
const requestQueue = [];

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  await chrome.storage.sync.set({ ...DEFAULT_SETTINGS, ...current });
  await loadPersistentCache();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "translate") {
    return false;
  }

  handleTranslateMessage(message)
    .then((translatedText) => sendResponse({ ok: true, translatedText }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));

  return true;
});

async function handleTranslateMessage(message) {
  if (Array.isArray(message.items)) {
    const items = message.items.slice(0, MAX_BATCH_ITEMS);
    const translatedItems = await Promise.all(
      items.map((item) => translateText(item.text, message.sourceLanguage, message.targetLanguage))
    );
    return translatedItems;
  }

  return translateText(message.text, message.sourceLanguage, message.targetLanguage);
}

async function translateText(text, sourceLanguage, targetLanguage) {
  await loadPersistentCache();

  const normalizedText = normalizeText(text);
  if (!normalizedText) {
    return "";
  }

  const source = sourceLanguage || "auto";
  const target = targetLanguage || "zh-CN";
  const cacheKey = `${source}:${target}:${normalizedText.slice(0, MAX_TEXT_LENGTH)}`;

  if (translationCache.has(cacheKey)) {
    return translationCache.get(cacheKey);
  }

  if (pendingRequests.has(cacheKey)) {
    return pendingRequests.get(cacheKey);
  }

  const request = enqueueTranslation(() => requestGoogleTranslation(normalizedText, source, target, cacheKey))
    .finally(() => {
      pendingRequests.delete(cacheKey);
    });

  pendingRequests.set(cacheKey, request);
  return request;
}

async function requestGoogleTranslation(text, source, target, cacheKey) {
  const url = new URL("https://translate.googleapis.com/translate_a/single");
  url.searchParams.set("client", "gtx");
  url.searchParams.set("sl", source);
  url.searchParams.set("tl", target);
  url.searchParams.set("dt", "t");
  url.searchParams.set("q", text.slice(0, MAX_TEXT_LENGTH));

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`Google Translate request failed: ${response.status}`);
  }

  const payload = await response.json();
  const translatedText = parseGoogleTranslateResponse(payload);
  setCache(cacheKey, translatedText);
  return translatedText;
}

function enqueueTranslation(task) {
  return new Promise((resolve, reject) => {
    requestQueue.push({ task, resolve, reject });
    drainQueue();
  });
}

function drainQueue() {
  while (activeRequests < 2 && requestQueue.length > 0) {
    const next = requestQueue.shift();
    activeRequests += 1;

    next.task()
      .then(next.resolve)
      .catch(next.reject)
      .finally(() => {
        activeRequests -= 1;
        drainQueue();
      });
  }
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
  savePersistentCache();
}

async function loadPersistentCache() {
  if (cacheLoaded) {
    return;
  }

  cacheLoaded = true;
  const stored = await chrome.storage.local.get(TRANSLATION_CACHE_KEY);
  const entries = stored[TRANSLATION_CACHE_KEY];
  if (!Array.isArray(entries)) {
    return;
  }

  for (const [key, value] of entries.slice(-MAX_CACHE_ITEMS)) {
    translationCache.set(key, value);
  }
}

function savePersistentCache() {
  chrome.storage.local.set({
    [TRANSLATION_CACHE_KEY]: [...translationCache.entries()].slice(-MAX_CACHE_ITEMS)
  });
}
