importScripts("db.js");

const XAI_BASE = "https://api.x.ai/v1";
const XAI_MODEL = "grok-4-1-fast-non-reasoning";

// const NEWSAPI_BASE = "https://newsapi.org/v2/everything";
// custom API
const NEWSAPI_BASE = "http://localhost:4000/v2/everything";

const NEWSAPI_FETCH_TIMEOUT_MS = 5000;
const ARTICLE_FETCH_ATTEMPTS = 1;
const ARTICLE_PAGE_VARIETY = 3;
// set false to use xAI
const USE_NEWSAPI_TITLE_ONLY = true;

// Cache keyed by topic, lives for the duration of the service worker session
const newsApiCache = {};
const usedArticleUrls = new Set();
let replacementCount = 0;
let lengthAdjustSecondPassEnabled = null;
let whitelistRotationCursor = 0;

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "about", "your", "their",
  "will", "have", "has", "had", "are", "was", "were", "been", "being", "you", "they",
  "them", "his", "her", "its", "our", "not", "but", "can", "all", "any", "who", "how",
  "when", "what", "where", "why", "after", "before", "over", "under", "than", "then",
]);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("[Reframe] Background received message:", message.action);
  if (message.action === "checkGrokStatus") {
    checkGrok().then(sendResponse);
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
    usedArticleUrls.clear();
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

async function checkGrok() {
  const xaiApiKey = await resolveXaiApiKey();
  if (!xaiApiKey) return { connected: false };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(XAI_BASE + "/models", {
      headers: {
        Authorization: "Bearer " + xaiApiKey,
      },
      signal: controller.signal,
    });
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
    console.error("[Reframe] NewsAPI failure: API key missing, cannot fetch replacement article.");
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
    console.error("[Reframe] NewsAPI failure: no article returned for replacement.", {
      matchedTerms: safeMatchedTerms,
      whitelist: safeWhitelist,
    });
    return {
      success: false,
      error: "No replacement article available; skipping replacement.",
    };
  }

  if (USE_NEWSAPI_TITLE_ONLY) {
    replacementCount++;
    return {
      success: true,
      replacement: (articleResult.title || "").trim(),
      articleUrl: articleResult?.url || null,
      articleImageUrl: articleResult?.imageUrl || null,
      articleDescription: articleResult?.description || articleResult?.title || null,
    };
  }

  // Build prompt with article information for context
  const prompt = buildPrompt(originalText, safeMatchedTerms, safeWhitelist, articleResult);

  // Then fetch LLM replacement based on the article
  const xaiResult = await fetchXaiNonReasoning(prompt);

  if (!xaiResult.success) return xaiResult;

  const groundedReplacement = ensureGroundedReplacement(
    xaiResult.replacement,
    articleResult,
    originalText
  );

  const normalizedReplacement = await enforceSimilarLength(originalText, groundedReplacement);

  replacementCount++;
  return {
    success: true,
    replacement: normalizedReplacement,
    articleUrl: articleResult?.url || null,
    articleImageUrl: articleResult?.imageUrl || null,
    articleDescription: articleResult?.description || articleResult?.title || null,
  };
}

function wordCount(text) {
  const words = (text || "").trim().split(/\s+/).filter(Boolean);
  return words.length;
}

function tokenizeSignificant(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 3 && !STOPWORDS.has(token));
}

function trimToWordCount(text, targetWords) {
  const words = (text || "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "";
  if (!targetWords || words.length <= targetWords) return words.join(" ");
  return words.slice(0, targetWords).join(" ");
}

function buildDescriptionFallback(article, originalText) {
  const description = (article?.description || "").trim();
  const title = (article?.title || "").trim();
  const baseline = description || title;
  if (!baseline) return "";

  const targetWords = Math.max(8, Math.ceil(wordCount(originalText) * 1.05));
  return trimToWordCount(baseline, targetWords);
}

function ensureGroundedReplacement(candidate, article, originalText) {
  const replacement = (candidate || "").trim();
  if (!replacement) {
    return buildDescriptionFallback(article, originalText);
  }

  const referenceText = [article?.title || "", article?.description || ""].join(" ").trim();
  const referenceTokens = new Set(tokenizeSignificant(referenceText));
  const replacementTokens = tokenizeSignificant(replacement);

  if (!referenceTokens.size || !replacementTokens.length) {
    return buildDescriptionFallback(article, originalText);
  }

  let overlap = 0;
  for (const token of replacementTokens) {
    if (referenceTokens.has(token)) overlap += 1;
  }

  const overlapRatio = overlap / Math.max(1, replacementTokens.length);
  const grounded = overlap >= 2 || overlapRatio >= 0.2;

  if (!grounded) {
    console.warn("[Reframe] Replacement not grounded in article description/title; using fallback summary.", {
      replacement,
      articleTitle: article?.title || null,
      articleDescription: article?.description || null,
    });
    return buildDescriptionFallback(article, originalText);
  }

  return replacement;
}

async function enforceSimilarLength(originalText, replacementText) {
  const originalWords = wordCount(originalText);
  const replacementWords = wordCount(replacementText);

  if (!originalWords || !replacementWords) return replacementText;

  // Keep output in a tight range around the original length.
  const minWords = Math.max(1, Math.floor(originalWords * 0.7));
  const maxWords = Math.ceil(originalWords * 1.35);

  if (replacementWords >= minWords && replacementWords <= maxWords) {
    return replacementText;
  }

  if (!(await isLengthAdjustSecondPassEnabled())) {
    return replacementText;
  }

  const adjustPrompt =
    "Rewrite the replacement text so it reads naturally while staying close to the original length.\\n" +
    "Return ONLY rewritten text.\\n\\n" +
    "ORIGINAL WORD COUNT: " + originalWords + "\\n" +
    "TARGET RANGE: " + minWords + "-" + maxWords + " words\\n" +
    "ORIGINAL TEXT: \"" + originalText + "\"\\n" +
    "CURRENT REPLACEMENT: \"" + replacementText + "\"\\n\\n" +
    "Keep meaning aligned with the current replacement, keep a natural flow, and stay within target range.";

  const adjusted = await fetchXaiNonReasoning(adjustPrompt);
  if (!adjusted.success) return replacementText;

  const adjustedWords = wordCount(adjusted.replacement);
  if (adjustedWords >= minWords && adjustedWords <= maxWords) {
    return adjusted.replacement;
  }

  // If second pass still misses range, keep the first replacement to avoid over-processing.
  return replacementText;
}

async function isLengthAdjustSecondPassEnabled() {
  if (lengthAdjustSecondPassEnabled !== null) {
    return lengthAdjustSecondPassEnabled;
  }

  try {
    const result = await chrome.storage.local.get("lengthAdjustSecondPassEnabled");
    lengthAdjustSecondPassEnabled = Boolean(result.lengthAdjustSecondPassEnabled);
  } catch {
    lengthAdjustSecondPassEnabled = false;
  }

  return lengthAdjustSecondPassEnabled;
}

async function fetchXaiNonReasoning(prompt) {
  const xaiApiKey = await resolveXaiApiKey();
  if (!xaiApiKey) {
    console.error("[Reframe] xAI failure: API key missing, cannot request completion.");
    return {
      success: false,
      error: "xAI API key is missing. Add it in the popup to enable replacements.",
    };
  }

  console.log("[Reframe] Starting xAI request with prompt length:", prompt.length);
  const requestBody = {
    model: XAI_MODEL,
    messages: [
      {
        role: "system",
        content: "You produce factual rewrites grounded only in provided article title/description. Never invent details. Return plain text only.",
      },
      {
        role: "user",
        content: prompt,
      },
    ],
    temperature: 0.1,
    max_tokens: 320,
  };
  console.log("[Reframe] Request body:", JSON.stringify(requestBody, null, 2));
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);
    const res = await fetch(XAI_BASE + "/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + xaiApiKey,
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const errorText = await res.text();
      console.error("[Reframe] xAI error response:", res.status, errorText);
      return { success: false, error: "xAI returned " + res.status + ": " + errorText };
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    const text = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n")
        : "";

    const cleaned = (text || "").trim();
    if (!cleaned) {
      console.error("[Reframe] xAI failure: empty completion payload.", {
        hasChoices: Array.isArray(data?.choices),
        firstChoice: data?.choices?.[0] || null,
      });
      return { success: false, error: "xAI returned an empty completion." };
    }

    return { success: true, replacement: cleaned };
  } catch (err) {
    console.error("[Reframe] Fetch error:", err);
    return { success: false, error: err.message };
  }
}

async function resolveXaiApiKey() {
  try {
    const result = await chrome.storage.local.get("xaiApiKey");
    return typeof result.xaiApiKey === "string" ? result.xaiApiKey.trim() : "";
  } catch {
    return "";
  }
}

async function fetchArticle(topic, apiKey, options = {}) {
  const {
    blacklistTerms = [],
    whitelistTopics = [],
    whitelistKeywords = [],
    whitelistSources = []
  } = options;

  const cacheKey = (topic || "").trim().toLowerCase();
  if (!cacheKey) return null;

  if (!newsApiCache[cacheKey]) {
    newsApiCache[cacheKey] = { articles: [], cursor: 0 };
  }

  const pool = newsApiCache[cacheKey];
  const cachedPick = pickUnusedArticleFromPool(pool, blacklistTerms);
  if (cachedPick) {
    console.log("[Reframe] Using cached fresh article for topic:", topic);
    return cachedPick;
  }

  console.log("[Reframe] Fetching new article batch for topic:", topic);

  // Keep retries tight so one replacement does not stall for many round trips.
  for (let attempt = 0; attempt < ARTICLE_FETCH_ATTEMPTS; attempt++) {
    const page = 1 + Math.floor(Math.random() * ARTICLE_PAGE_VARIETY);
    const freshBatch = await fetchArticleBatch(topic, apiKey, page, {
      blacklistTerms,
      whitelistTopics,
      whitelistKeywords,
      whitelistSources
    });
    if (!freshBatch.length) continue;

    mergeArticleBatch(pool, freshBatch);
    const freshPick = pickUnusedArticleFromPool(pool, blacklistTerms);
    if (freshPick) {
      return freshPick;
    }
  }

  return null;
}

async function fetchArticleBatch(topic, apiKey, page, options = {}) {
  const {
    blacklistTerms = [],
    whitelistTopics = [],
    whitelistKeywords = [],
    whitelistSources = []
  } = options;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), NEWSAPI_FETCH_TIMEOUT_MS);

  try {
    const params = new URLSearchParams({
      q: topic,
      language: "en",
      sortBy: "publishedAt",
      pageSize: "20",
      page: String(page),
      apiKey
    });

    if (blacklistTerms.length) {
      params.set("blacklistTerms", blacklistTerms.join(","));
    }
    if (whitelistTopics.length) {
      params.set("whitelistTopics", whitelistTopics.join(","));
    }
    if (whitelistKeywords.length) {
      params.set("whitelistKeywords", whitelistKeywords.join(","));
    }
    if (whitelistSources.length) {
      params.set("whitelistSources", whitelistSources.join(","));
    }

    const url = NEWSAPI_BASE + "?" + params.toString();

    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      const errorText = await res.text();
      console.warn("[Reframe] NewsAPI returned", res.status, "for topic", topic, errorText);
      return [];
    }

    const data = await res.json();
    const articles = (data.articles || [])
      .filter((a) => a && a.title && a.url)
      .map((article) => ({
        url: article.url || null,
        imageUrl: article.urlToImage || null,
        title: article.title || null,
        description: article.description || null,
      }))
      .filter((article) => !articleContainsBlacklistedTerm(article, blacklistTerms));

    return articles;
  } catch (err) {
    console.error("[Reframe] NewsAPI request failed for topic/page:", {
      topic,
      page,
      error: err?.message || String(err),
    });
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

function mergeArticleBatch(pool, articles) {
  const seenUrls = new Set(pool.articles.map((a) => a.url));
  for (const article of articles) {
    if (!article?.url || seenUrls.has(article.url)) continue;
    seenUrls.add(article.url);
    pool.articles.push(article);
  }
}

function pickUnusedArticleFromPool(pool, blacklistTerms = []) {
  if (!pool?.articles?.length) return null;

  for (let i = pool.cursor; i < pool.articles.length; i++) {
    const article = pool.articles[i];
    if (!article?.url || usedArticleUrls.has(article.url)) continue;
    if (articleContainsBlacklistedTerm(article, blacklistTerms)) continue;
    pool.cursor = i + 1;
    usedArticleUrls.add(article.url);
    return article;
  }

  for (let i = 0; i < pool.cursor; i++) {
    const article = pool.articles[i];
    if (!article?.url || usedArticleUrls.has(article.url)) continue;
    if (articleContainsBlacklistedTerm(article, blacklistTerms)) continue;
    pool.cursor = i + 1;
    usedArticleUrls.add(article.url);
    return article;
  }

  return null;
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
    "You are a content replacement assistant. Rewrite content as a concise factual summary of the REFERENCE ARTICLE DESCRIPTION.\n" +
    "Do not invent events, quotes, statistics, or background details.\n" +
    "If the description is short, stay short and precise.\n\n" +
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
    "\nWrite text that is strictly about the reference article title/description only. " +
    "Keep it factual and summary-like. " +
    "Do not add external narrative or promotion. " +
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
    unique.push(term.toLowerCase());
  }

  return unique;
}

function articleContainsBlacklistedTerm(article, blacklistTerms) {
  if (!blacklistTerms?.length) return false;
  const haystack = `${article?.title || ""} ${article?.description || ""}`.toLowerCase();
  return blacklistTerms.some((term) => term && haystack.includes(term.toLowerCase()));
}

function splitWhitelistByType(whitelist) {
  const safeWhitelist = Array.isArray(whitelist) ? whitelist : [];
  return {
    whitelistTopics: safeWhitelist.filter((w) => w.type === "topic").map((w) => String(w.value || "").trim()).filter(Boolean),
    whitelistKeywords: safeWhitelist.filter((w) => w.type === "keyword").map((w) => String(w.value || "").trim()).filter(Boolean),
    whitelistSources: safeWhitelist.filter((w) => w.type === "source").map((w) => String(w.value || "").trim()).filter(Boolean),
  };
}

async function fetchSafeFallbackArticle(apiKey, blacklistTerms) {
  const fallbackTerms = ["breaking news", "world news", "current events"];
  for (const term of fallbackTerms) {
    const article = await fetchArticle(term, apiKey, { blacklistTerms });
    if (article && article.title) {
      return article;
    }
  }
  return null;
}

async function getBestReplacementArticle(whitelist, matchedTerms, apiKey) {
  const whitelistTerms = buildReplacementSearchTerms(whitelist);
  const blacklistMatchedTerms = buildMatchedTermSearchTerms(matchedTerms);
  const { whitelistTopics, whitelistKeywords, whitelistSources } = splitWhitelistByType(whitelist);

  const rotatedWhitelistTerms = whitelistTerms.length
    ? rotateTerms(whitelistTerms, whitelistRotationCursor)
    : [];

  if (whitelistTerms.length) {
    whitelistRotationCursor = (whitelistRotationCursor + 1) % whitelistTerms.length;
  }

  // Only search by whitelist intent; never search by blacklist terms.
  const searchTerms = rotatedWhitelistTerms;

  for (const term of searchTerms) {
    const article = await fetchArticle(term, apiKey, {
      blacklistTerms: blacklistMatchedTerms,
      whitelistTopics,
      whitelistKeywords,
      whitelistSources
    });
    if (article && article.title) {
      return article;
    }
  }

  if (whitelistTerms.length) {
    const combined = whitelistTerms.slice(0, 3).join(" OR ");
    const fallbackArticle = await fetchArticle(combined, apiKey, {
      blacklistTerms: blacklistMatchedTerms,
      whitelistTopics,
      whitelistKeywords,
      whitelistSources
    });
    if (fallbackArticle && fallbackArticle.title) {
      return fallbackArticle;
    }
  }

  // Final fallback: allow generic article only if it does not contain blacklisted terms.
  const safeRandomFallback = await fetchSafeFallbackArticle(apiKey, blacklistMatchedTerms);
  if (safeRandomFallback && safeRandomFallback.title) {
    return safeRandomFallback;
  }

  console.error("[Reframe] NewsAPI failure: no safe article found for whitelist intent.", {
    searchTerms,
    blacklistMatchedTerms,
  });

  return null;
}

function rotateTerms(terms, offset) {
  if (!terms.length) return terms;
  const start = ((offset % terms.length) + terms.length) % terms.length;
  return [...terms.slice(start), ...terms.slice(0, start)];
}