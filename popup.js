const DEFAULT_SETTINGS = {
  enabled: true,
  sourceLanguage: "auto",
  targetLanguage: "zh-CN",
  showOriginal: true,
  position: "bottom",
  fontSize: 18
};

const controls = {
  enabled: document.querySelector("#enabled"),
  sourceLanguage: document.querySelector("#sourceLanguage"),
  targetLanguage: document.querySelector("#targetLanguage"),
  showOriginal: document.querySelector("#showOriginal"),
  position: document.querySelector("#position"),
  fontSize: document.querySelector("#fontSize")
};

init();

async function init() {
  const settings = {
    ...DEFAULT_SETTINGS,
    ...(await chrome.storage.sync.get(DEFAULT_SETTINGS))
  };

  for (const [key, control] of Object.entries(controls)) {
    if (control.type === "checkbox") {
      control.checked = Boolean(settings[key]);
    } else {
      control.value = settings[key];
    }

    control.addEventListener("input", () => saveSetting(key, control));
    control.addEventListener("change", () => saveSetting(key, control));
  }

  document.querySelector("#rescan").addEventListener("click", rescanActiveTab);
}

async function saveSetting(key, control) {
  const value = control.type === "checkbox" ? control.checked : control.value;
  await chrome.storage.sync.set({
    [key]: key === "fontSize" ? Number(value) : value
  });
}

async function rescanActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    return;
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { type: "rescan" });
  } catch (error) {
    console.warn("[YouTube Translator]", error);
  }
}
