importScripts("db.js");

const OLLAMA_BASE = "http://localhost:11434";
const OLLAMA_MODEL = "llama3.2";
const NEWSAPI_BASE = "https://newsapi.org/v2/everything";

// Cache keyed by topic, lives for the duration of the service worker session
const newsApiCache = {};
let replacementCount = 0;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("[Reframe] Background received message:", message.action);
  if (message.action === "checkOllamaStatus") {
    checkOllama().then(sendResponse);
    return true; // async
  }

  if (message.action === "getReplacements") {
    console.log("[Reframe] Processing getReplacements request");
    (async () => {
      try {
        const result = await getReplacements(
          message.text,
          message.matchedTerms,
          message.whitelist,
          message.newsApiKey
        );
        sendResponse(result);
      } catch (err) {
        console.error("[Reframe] getReplacements error:", err);
        sendResponse({
          success: false,
          error: err?.message || "Unexpected replacement error",
        });
      }
    })();
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

  if (message.action === "clearArticleCache") {
    console.log("[Reframe] Clearing article cache");
    Object.keys(newsApiCache).forEach(key => delete newsApiCache[key]);
    sendResponse({ success: true });
  }

  if (message.action === "getReplacementCount") {
    sendResponse({ count: replacementCount });
  }

  if (message.action === "resetReplacementCount") {
    replacementCount = 0;
    sendResponse({ count: replacementCount });
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

async function getReplacements(originalText, matchedTerms, whitelist, newsApiKey) {
  const safeMatchedTerms = Array.isArray(matchedTerms) ? matchedTerms : [];
  const safeWhitelist = Array.isArray(whitelist) ? whitelist : [];
  const resolvedNewsApiKey = await resolveNewsApiKey(newsApiKey);

  if (!resolvedNewsApiKey) {
    return {
      success: false,
      error: "NewsAPI key is missing. Set it in the popup to enable article-based replacements.",
    };
  }

  const articleResult = resolvedNewsApiKey
    ? await getBestReplacementArticle(safeWhitelist, safeMatchedTerms, resolvedNewsApiKey)
    : null;

  // Strict mode: only replace when we have a reference article.
  if (!articleResult || !articleResult.title) {
    return {
      success: false,
      error: "No replacement article available; skipping replacement.",
    };
  }

  // Build prompt with article information for context
  const prompt = buildPrompt(originalText, safeMatchedTerms, safeWhitelist, articleResult);

  // Then fetch LLM replacement based on the article
  const ollamaResult = await fetchOllama(prompt);

  if (!ollamaResult.success) return ollamaResult;

  const normalizedReplacement = await enforceSimilarLength(originalText, ollamaResult.replacement);

  replacementCount++;
  return {
    success: true,
    replacement: normalizedReplacement,
    articleUrl: articleResult?.url || null,
    articleImageUrl: articleResult?.imageUrl || null,
  };
}

function wordCount(text) {
  const words = (text || "").trim().split(/\s+/).filter(Boolean);
  return words.length;
}

async function enforceSimilarLength(originalText, replacementText) {
  const originalWords = wordCount(originalText);
  const replacementWords = wordCount(replacementText);

  if (!originalWords || !replacementWords) return replacementText;

  // Keep output in a tight range around the original length.
  const minWords = Math.max(1, Math.floor(originalWords * 0.85));
  const maxWords = Math.ceil(originalWords * 1.15);

  if (replacementWords >= minWords && replacementWords <= maxWords) {
    return replacementText;
  }

  const adjustPrompt =
    "Rewrite the replacement text to match the original length more closely.\\n" +
    "Return ONLY rewritten text.\\n\\n" +
    "ORIGINAL WORD COUNT: " + originalWords + "\\n" +
    "TARGET RANGE: " + minWords + "-" + maxWords + " words\\n" +
    "ORIGINAL TEXT: \"" + originalText + "\"\\n" +
    "CURRENT REPLACEMENT: \"" + replacementText + "\"\\n\\n" +
    "Keep meaning aligned with the current replacement, preserve tone and sentence structure, and stay within target range.";

  const adjusted = await fetchOllama(adjustPrompt);
  if (!adjusted.success) return replacementText;

  const adjustedWords = wordCount(adjusted.replacement);
  if (adjustedWords >= minWords && adjustedWords <= maxWords) {
    return adjusted.replacement;
  }

  // If second pass still misses range, keep the first replacement to avoid over-processing.
  return replacementText;
}

async function fetchOllama(prompt) {
  console.log("[Reframe] Starting Ollama request with prompt length:", prompt.length);
  const requestBody = {
    model: OLLAMA_MODEL,
    prompt,
    stream: false,
    options: {
      temperature: 0.3,
      num_predict: 256,
    },
  };
  console.log("[Reframe] Request body:", JSON.stringify(requestBody, null, 2));
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);
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

    if (!res.ok) {
      const errorText = await res.text();
      console.error("[Reframe] Ollama error response:", res.status, errorText);
      return { success: false, error: "Ollama returned " + res.status + ": " + errorText };
    }

    const data = await res.json();
    return { success: true, replacement: data.response.trim() };
  } catch (err) {
    console.error("[Reframe] Fetch error:", err);
    return { success: false, error: err.message };
  }
}

async function fetchArticle(topic, apiKey) {
  if (newsApiCache[topic]) {
    console.log("[Reframe] Using cached article for topic:", topic);
    return newsApiCache[topic];
  }

  console.log("[Reframe] Fetching new article for topic:", topic);
  try {
    const url = NEWSAPI_BASE + "?q=" + encodeURIComponent(topic) + "&language=en&sortBy=relevancy&pageSize=5&apiKey=" + apiKey;
    const res = await fetch(url);
    if (!res.ok) {
      const errorText = await res.text();
      console.warn("[Reframe] NewsAPI returned", res.status, "for topic", topic, errorText);
      return null;
    }

    const data = await res.json();
    const article = (data.articles || []).find((a) => a?.title) || null;
    if (!article) return null;

    const result = {
      url: article.url || null,
      imageUrl: article.urlToImage || null,
      title: article.title || null,
      description: article.description || null,
    };
    newsApiCache[topic] = result;
    console.log("[Reframe] Cached new article for topic:", topic);
    return result;
  } catch {
    return null;
  }
}

async function resolveNewsApiKey(providedKey) {
  const trimmed = typeof providedKey === "string" ? providedKey.trim() : "";
  if (trimmed) return trimmed;

  try {
    const result = await chrome.storage.local.get("newsApiKey");
    return typeof result.newsApiKey === "string" ? result.newsApiKey.trim() : "";
  } catch {
    return "";
  }
}

function buildPrompt(originalText, matchedTerms, whitelist, article) {
  const keywords = whitelist.filter((w) => w.type === "keyword").map((w) => w.value);
  const topics = whitelist.filter((w) => w.type === "topic").map((w) => w.value);
  const sources = whitelist.filter((w) => w.type === "source").map((w) => w.value);

  // Format matched terms with their types
  const formattedMatchedTerms = (matchedTerms || []).map((term) =>
    typeof term === "string" ? term : `${term.value} (${term.type})`
  ).join(", ");

  const originalWordTotal = wordCount(originalText);
  const targetMin = Math.max(1, Math.floor(originalWordTotal * 0.85));
  const targetMax = Math.ceil(originalWordTotal * 1.15);

  let prompt = (
    "You are a content replacement assistant. Rewrite content to be ONLY about the provided reference article.\n\n" +
    "BLACKLISTED TERMS FOUND: " + formattedMatchedTerms + "\n" +
    'ORIGINAL TEXT: "' + originalText + '"\n' +
    "USER'S WHITELISTED PREFERENCES:\n" +
    "- Keywords: " + (keywords.length ? keywords.join(", ") : "(none)") + "\n" +
    "- Topics: " + (topics.length ? topics.join(", ") : "(none)") + "\n" +
    "- Sources: " + (sources.length ? sources.join(", ") : "(none)") + "\n"
  );

  // Include article information if available
  if (article && article.title) {
    prompt += (
      "\nREFERENCE ARTICLE:\n" +
      "- Title: " + article.title + "\n" +
      (article.description ? "- Description: " + article.description + "\n" : "") +
      (article.url ? "- URL: " + article.url + "\n" : "")
    );
  }

  prompt += (
    "\nWrite new text that is strictly about the reference article only. " +
    "Do not mention unrelated topics, and do not invent details not supported by the reference article title/description. " +
    "Keep the same sentence structure and tone. " +
    "Target " + originalWordTotal + " words (acceptable range: " + targetMin + "-" + targetMax + "). " +
    "Only output the rewritten text."
  );

  return prompt;
}

function buildReplacementSearchTerms(whitelist) {
  if (!Array.isArray(whitelist) || !whitelist.length) return [];

  const topics = whitelist.filter((w) => w.type === "topic").map((w) => w.value.trim());
  const keywords = whitelist.filter((w) => w.type === "keyword").map((w) => w.value.trim());
  const sources = whitelist.filter((w) => w.type === "source").map((w) => w.value.trim());

  const ordered = [...topics, ...keywords, ...sources].filter(Boolean);
  const seen = new Set();
  const unique = [];

  for (const term of ordered) {
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(term);
  }

  return unique;
}

function buildMatchedTermSearchTerms(matchedTerms) {
  if (!Array.isArray(matchedTerms) || !matchedTerms.length) return [];

  const rawTerms = matchedTerms
    .map((term) => typeof term === "string" ? term : term?.value)
    .filter(Boolean)
    .map((term) => term.trim())
    .filter(Boolean);

  const seen = new Set();
  const unique = [];
  for (const term of rawTerms) {
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(term);
  }

  return unique;
}

async function getBestReplacementArticle(whitelist, matchedTerms, apiKey) {
  const whitelistTerms = buildReplacementSearchTerms(whitelist);
  const blacklistMatchedTerms = buildMatchedTermSearchTerms(matchedTerms);
  const allTerms = [...whitelistTerms, ...blacklistMatchedTerms];

  const seen = new Set();
  const searchTerms = allTerms.filter((term) => {
    const key = term.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  for (const term of searchTerms) {
    const article = await fetchArticle(term, apiKey);
    if (article && article.title) {
      return article;
    }
  }

  if (whitelistTerms.length) {
    const combined = whitelistTerms.slice(0, 3).join(" OR ");
    const fallbackArticle = await fetchArticle(combined, apiKey);
    if (fallbackArticle && fallbackArticle.title) {
      return fallbackArticle;
    }
  }

  return null;
}