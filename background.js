importScripts("db.js");

const OLLAMA_BASE = "http://localhost:11434";
const OLLAMA_MODEL = "llama3.2";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "checkOllamaStatus") {
    checkOllama().then(sendResponse);
    return true; // async
  }

  if (message.action === "getReplacements") {
    getReplacements(message.text, message.matchedTerms, message.whitelist)
      .then(sendResponse);
    return true;
  }

  if (message.action === "getPreferences") {
    Promise.all([
      getAllPreferences("blacklist"),
      getAllPreferences("whitelist"),
    ]).then(([blacklist, whitelist]) => {
      sendResponse({ blacklist, whitelist });
    }).catch((err) => {
      sendResponse({ blacklist: [], whitelist: [], error: err.message });
    });
    return true;
  }

  if (message.action === "preferencesUpdated") {
    // Relay rescan to the active tab's content script
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, { action: "rescanPage" }).catch(() => {});
      }
    });
  }
});

async function checkOllama() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(OLLAMA_BASE + "/", { signal: controller.signal });
    clearTimeout(timeout);
    return { connected: res.ok };
  } catch {
    return { connected: false };
  }
}

async function getReplacements(originalText, matchedTerms, whitelist) {
  const prompt = buildPrompt(originalText, matchedTerms, whitelist);
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    const res = await fetch(OLLAMA_BASE + "/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt,
        stream: false,
        options: {
          temperature: 0.3,
          num_predict: 256,
        },
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) return { success: false, error: "Ollama returned " + res.status };

    const data = await res.json();
    return { success: true, replacement: data.response.trim() };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function buildPrompt(originalText, matchedTerms, whitelist) {
  const keywords = whitelist.filter((w) => w.type === "keyword").map((w) => w.value);
  const topics = whitelist.filter((w) => w.type === "topic").map((w) => w.value);
  const sources = whitelist.filter((w) => w.type === "source").map((w) => w.value);

  return (
    "You are a content replacement assistant. The user has blacklisted certain content and wants it replaced with content related to their whitelist preferences.\n\n" +
    "BLACKLISTED TERMS FOUND: " + matchedTerms.join(", ") + "\n" +
    'ORIGINAL TEXT: "' + originalText + '"\n' +
    "USER'S WHITELISTED PREFERENCES:\n" +
    "- Keywords: " + (keywords.length ? keywords.join(", ") : "(none)") + "\n" +
    "- Topics: " + (topics.length ? topics.join(", ") : "(none)") + "\n" +
    "- Sources: " + (sources.length ? sources.join(", ") : "(none)") + "\n\n" +
    "Rewrite the original text, replacing references to blacklisted terms with content related to the user's whitelisted preferences. Keep the same sentence structure and tone. Similar length to the original. Only output the rewritten text."
  );
}
