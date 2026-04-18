let currentStore = "blacklist";
let currentFilter = "all";

const DEFAULT_MAJOR_NEWS_DOMAINS = [
  "news.google.com",
  "reuters.com",
  "apnews.com",
  "bbc.com",
  "bbc.co.uk",
  "cnn.com",
  "foxnews.com",
  "nytimes.com",
  "washingtonpost.com",
  "wsj.com",
  "nbcnews.com",
  "abcnews.go.com",
  "cbsnews.com",
  "usatoday.com",
  "bloomberg.com",
  "theguardian.com",
  "npr.org",
  "forbes.com",
  "msn.com",
  "yahoo.com",
];

const prefList = document.getElementById("pref-list");
const addForm = document.getElementById("add-form");
const prefType = document.getElementById("pref-type");
const prefValue = document.getElementById("pref-value");
const clearAllBtn = document.getElementById("clear-all-btn");
const statusEl = document.getElementById("custom-api-status");
const statusText = document.getElementById("status-text");
const replacementCountEl = document.getElementById("replacement-count");
const replacementEnabledToggle = document.getElementById("replacement-enabled-toggle");

function setPopupDimState() {
  document.body.classList.toggle("popup-dimmed", !replacementEnabledToggle.checked);
}

replacementEnabledToggle.addEventListener("change", async () => {
  await chrome.storage.local.set({ replacementEnabled: replacementEnabledToggle.checked });
  setPopupDimState();
  notifyPreferencesUpdated();
});

// --- Tab switching ---
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelector(".tab.active").classList.remove("active");
    tab.classList.add("active");
    currentStore = tab.dataset.store;
    renderList();
  });
});

// --- Filter switching ---
document.querySelectorAll(".filter").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelector(".filter.active").classList.remove("active");
    btn.classList.add("active");
    currentFilter = btn.dataset.type;
    renderList();
  });
});

// --- Add preference ---
addForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const value = prefValue.value.trim();
  if (!value) return;
  try {
    await addPreference(currentStore, prefType.value, value);
    prefValue.value = "";
    renderList();
    notifyPreferencesUpdated();
  } catch (err) {
    if (err.name === "ConstraintError") {
      alert("This value already exists in the " + currentStore + ".");
    } else {
      console.error("Failed to add preference:", err);
    }
  }
});

// --- Clear all ---
clearAllBtn.addEventListener("click", async () => {
  if (!confirm("Clear all " + currentStore + " entries?")) return;
  await clearAllPreferences(currentStore);
  renderList();
  notifyPreferencesUpdated();
});

// --- Render preference list ---
async function renderList() {
  let items;
  if (currentFilter === "all") {
    items = await getAllPreferences(currentStore);
  } else {
    items = await getPreferencesByType(currentStore, currentFilter);
  }
  items.sort((a, b) => b.createdAt - a.createdAt);

  prefList.innerHTML = "";
  for (const item of items) {
    const li = document.createElement("li");
    li.className = "pref-item";
    li.innerHTML =
      '<span class="type-badge">' + escapeHtml(item.type) + "</span>" +
      '<span class="value">' + escapeHtml(item.value) + "</span>" +
      '<button class="edit-btn" title="Edit">&#9998;</button>' +
      '<button class="delete-btn" title="Delete">&times;</button>';

    li.querySelector(".delete-btn").addEventListener("click", async () => {
      await removePreference(currentStore, item.id);
      renderList();
      notifyPreferencesUpdated();
    });

    li.querySelector(".edit-btn").addEventListener("click", () => {
      startInlineEdit(li, item);
    });

    prefList.appendChild(li);
  }
}

function startInlineEdit(li, item) {
  const valueSpan = li.querySelector(".value");
  const input = document.createElement("input");
  input.type = "text";
  input.className = "value-edit";
  input.value = item.value;
  valueSpan.replaceWith(input);
  input.focus();
  input.select();

  const save = async () => {
    const newVal = input.value.trim();
    if (newVal && newVal !== item.value) {
      try {
        await updatePreference(currentStore, item.id, newVal);
        notifyPreferencesUpdated();
      } catch (err) {
        if (err.name === "ConstraintError") {
          alert("This value already exists.");
        }
      }
    }
    renderList();
  };

  input.addEventListener("blur", save);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") save();
    if (e.key === "Escape") renderList();
  });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// --- Custom API heartbeat ---
async function checkCustomApiStatus() {
  statusEl.className = "status checking";
  statusText.textContent = "Checking...";
  try {
    const response = await chrome.runtime.sendMessage({ action: "checkCustomApiStatus" });
    if (response && response.connected) {
      statusEl.className = "status connected";
      statusText.textContent = "API Connected";
    } else {
      statusEl.className = "status disconnected";
      statusText.textContent = "API Disconnected";
    }
  } catch {
    statusEl.className = "status disconnected";
    statusText.textContent = "API Disconnected";
  }
}

function notifyPreferencesUpdated() {
  chrome.runtime.sendMessage({ action: "preferencesUpdated" }).catch(() => {});
}

const majorNewsOnlyToggle = document.getElementById("major-news-only-toggle");
const majorNewsDomainsSection = document.getElementById("major-news-domains-section");
const majorNewsDomainValue = document.getElementById("major-news-domain-value");
const addMajorNewsDomainBtn = document.getElementById("add-major-news-domain-btn");
const majorNewsDomainsList = document.getElementById("major-news-domains-list");
let majorNewsDomains = [...DEFAULT_MAJOR_NEWS_DOMAINS];

function setMajorNewsDomainsVisibility() {
  if (majorNewsOnlyToggle.checked) {
    majorNewsDomainsSection.classList.remove("hidden");
  } else {
    majorNewsDomainsSection.classList.add("hidden");
  }
}

function normalizeSingleDomain(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*/, "")
    .replace(/^www\./, "");
}

function normalizeDomainList(domains) {
  const seen = new Set();
  return (domains || [])
    .map((domain) => normalizeSingleDomain(domain))
    .filter(Boolean)
    .filter((domain) => {
      if (seen.has(domain)) return false;
      seen.add(domain);
      return true;
    });
}

async function saveMajorNewsDomains(domains) {
  const normalized = normalizeDomainList(domains);
  majorNewsDomains = normalized.length ? normalized : [...DEFAULT_MAJOR_NEWS_DOMAINS];
  await chrome.storage.local.set({ majorNewsDomains: majorNewsDomains });
  renderMajorNewsDomains();
  notifyPreferencesUpdated();
}

function renderMajorNewsDomains() {
  majorNewsDomainsList.innerHTML = "";

  for (const domain of majorNewsDomains) {
    const li = document.createElement("li");
    li.className = "domain-item";
    li.innerHTML =
      '<span class="domain-value">' + escapeHtml(domain) + "</span>" +
      '<button class="edit-btn" title="Edit">&#9998;</button>' +
      '<button class="delete-btn" title="Delete">&times;</button>';

    li.querySelector(".edit-btn").addEventListener("click", () => {
      startInlineDomainEdit(li, domain);
    });

    li.querySelector(".delete-btn").addEventListener("click", async () => {
      const next = majorNewsDomains.filter((d) => d !== domain);
      await saveMajorNewsDomains(next);
    });

    majorNewsDomainsList.appendChild(li);
  }
}

function startInlineDomainEdit(li, originalDomain) {
  const valueSpan = li.querySelector(".domain-value");
  const input = document.createElement("input");
  input.type = "text";
  input.className = "domain-value-edit";
  input.value = originalDomain;
  valueSpan.replaceWith(input);
  input.focus();
  input.select();

  const save = async () => {
    const nextValue = normalizeSingleDomain(input.value);
    if (!nextValue || nextValue === originalDomain) {
      renderMajorNewsDomains();
      return;
    }

    const next = majorNewsDomains.map((d) => (d === originalDomain ? nextValue : d));
    await saveMajorNewsDomains(next);
  };

  input.addEventListener("blur", save);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") save();
    if (e.key === "Escape") renderMajorNewsDomains();
  });
}

majorNewsOnlyToggle.addEventListener("change", async () => {
  await chrome.storage.local.set({ restrictToMajorNews: majorNewsOnlyToggle.checked });
  setMajorNewsDomainsVisibility();
  notifyPreferencesUpdated();
});

addMajorNewsDomainBtn.addEventListener("click", async () => {
  const domain = normalizeSingleDomain(majorNewsDomainValue.value);
  if (!domain) return;

  const next = normalizeDomainList([...majorNewsDomains, domain]);
  await saveMajorNewsDomains(next);
  majorNewsDomainValue.value = "";
});

majorNewsDomainValue.addEventListener("keydown", async (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    addMajorNewsDomainBtn.click();
  }
});

async function loadSettings() {
  const result = await chrome.storage.local.get(["restrictToMajorNews", "majorNewsDomains", "replacementEnabled"]);
  majorNewsOnlyToggle.checked = Boolean(result.restrictToMajorNews);
  replacementEnabledToggle.checked = result.replacementEnabled !== false;
  setPopupDimState();
  setMajorNewsDomainsVisibility();

  const savedDomains = Array.isArray(result.majorNewsDomains) ? result.majorNewsDomains : [];
  majorNewsDomains = normalizeDomainList(savedDomains);
  if (!majorNewsDomains.length) {
    majorNewsDomains = [...DEFAULT_MAJOR_NEWS_DOMAINS];
  }
  renderMajorNewsDomains();
}

// --- Clear article cache (developer tool) ---
const clearCacheBtn = document.getElementById("clear-cache-btn");
clearCacheBtn.addEventListener("click", async () => {
  if (!confirm("Clear the article cache? This will force new NewsAPI queries on next replacements.")) return;
  chrome.runtime.sendMessage({ action: "clearArticleCache" }, (response) => {
    if (response && response.success) {
      clearCacheBtn.textContent = "Cache Cleared!";
      setTimeout(() => { clearCacheBtn.textContent = "Clear Article Cache"; }, 1500);
    }
  });
});

// --- API Key management (developer tool) ---
const apiKeyInput = document.getElementById("api-key-input");
const saveApiKeyBtn = document.getElementById("save-api-key-btn");

// Load existing API key on popup open
async function loadApiKey() {
  try {
    const result = await chrome.storage.local.get("newsApiKey");
    if (result.newsApiKey) {
      apiKeyInput.value = result.newsApiKey;
    }
  } catch (err) {
    console.error("Failed to load API key:", err);
  }
}

saveApiKeyBtn.addEventListener("click", async () => {
  const apiKey = apiKeyInput.value.trim();
  try {
    if (apiKey) {
      await chrome.storage.local.set({ newsApiKey: apiKey });
      saveApiKeyBtn.textContent = "Saved!";
      setTimeout(() => { saveApiKeyBtn.textContent = "Save API Key"; }, 1500);
    } else {
      // Clear the API key if input is empty
      await chrome.storage.local.remove("newsApiKey");
      saveApiKeyBtn.textContent = "Cleared!";
      setTimeout(() => { saveApiKeyBtn.textContent = "Save API Key"; }, 1500);
    }
    // Re-check API status after saving
    checkCustomApiStatus();
  } catch (err) {
    console.error("Failed to save API key:", err);
    saveApiKeyBtn.textContent = "Error!";
    setTimeout(() => { saveApiKeyBtn.textContent = "Save API Key"; }, 1500);
  }
});

// Allow Enter key to save API key
apiKeyInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    saveApiKeyBtn.click();
  }
});

// --- Init ---
renderList();
checkCustomApiStatus();
loadSettings();
loadApiKey();
