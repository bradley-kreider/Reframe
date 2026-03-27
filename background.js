importScripts("db.js");

// const NEWSAPI_BASE = "https://newsapi.org/v2/everything";
// custom API
// const NEWSAPI_BASE = "http://localhost:4000/v2/everything";
const NEWSAPI_BASE = "https://newsfeed-hhtk.onrender.com/v2/everything"; // CUSTOM LIVE API BOIIII I TELL YOU WHAT

const NEWSAPI_FETCH_TIMEOUT_MS = 5000;
const ARTICLE_FETCH_ATTEMPTS = 3;
const ARTICLE_PAGE_VARIETY = 3;

// Cache keyed by topic, lives for the duration of the service worker session
const newsApiCache = {};
const usedArticleUrls = new Set();
let replacementCount = 0;
let whitelistRotationCursor = 0;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("[Reframe] Background received message:", message.action);
  if (message.action === "checkCustomApiStatus") {
    checkCustomApiHeartbeat().then(sendResponse);
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

async function checkCustomApiHeartbeat() {
  const endpoints = [
    NEWSAPI_BASE + "/health",
    NEWSAPI_BASE + "/heartbeat",
    NEWSAPI_BASE,
  ];
  try {
    for (const endpoint of endpoints) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      try {
        const res = await fetch(endpoint, {
          method: "GET",
          cache: "no-store",
          signal: controller.signal,
        });
        if (res.ok) {
          clearTimeout(timeout);
          return { connected: true, endpoint };
        }
      } catch {
        // Try next endpoint.
      } finally {
        clearTimeout(timeout);
      }
    }
    return { connected: false };
  } catch {
    return { connected: false };
  }
}

async function getReplacements(originalText, matchedTerms, whitelist, newsApiKey) {
  const safeMatchedTerms = Array.isArray(matchedTerms) ? matchedTerms : [];
  const safeWhitelist = Array.isArray(whitelist) ? whitelist : [];
  const resolvedNewsApiKey = await resolveNewsApiKey(newsApiKey);

  const articleResult = await getBestReplacementArticle(
    safeWhitelist,
    safeMatchedTerms,
    resolvedNewsApiKey
  );

  // Strict mode: only replace when we have a reference article.
  if (!articleResult || !articleResult.title) {
    console.error("[Reframe] newsFeed failure: no article returned for replacement.", {
      matchedTerms: safeMatchedTerms,
      whitelist: safeWhitelist,
    });
    return {
      success: false,
      error: "No replacement article available; skipping replacement.",
    };
  }

  replacementCount++;
  return {
    success: true,
    replacement: (articleResult.title || "").trim(),
    articleUrl: articleResult?.url || null,
    articleImageUrl: articleResult?.imageUrl || null,
    articleDescription: articleResult?.description || articleResult?.title || null,
  };
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

  // When all safe candidates were already used, allow safe reuse so replacements
  // keep flowing instead of stalling partway through long pages.
  const reusablePick = pickReusableArticleFromPool(pool, blacklistTerms);
  if (reusablePick) {
    console.log("[Reframe] Reusing safe cached article for topic:", topic);
    return reusablePick;
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

    const reusableFreshPick = pickReusableArticleFromPool(pool, blacklistTerms);
    if (reusableFreshPick) {
      return reusableFreshPick;
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
      page: String(page)
    });

    // Optional key: only send when present.
    if (apiKey) {
      params.set("apiKey", apiKey);
    }

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
      console.warn("[Reframe] newsFeed returned", res.status, "for topic", topic, errorText);
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
    const errorMessage =
      typeof err === "string"
        ? err
        : err?.message || err?.name || JSON.stringify(err);
    console.error("[Reframe] newsFeed request failed for topic/page:", {
      topic,
      page,
      errorName: err?.name || null,
      errorMessage,
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

function pickReusableArticleFromPool(pool, blacklistTerms = []) {
  if (!pool?.articles?.length) return null;

  for (let i = pool.cursor; i < pool.articles.length; i++) {
    const article = pool.articles[i];
    if (!article?.url) continue;
    if (articleContainsBlacklistedTerm(article, blacklistTerms)) continue;
    pool.cursor = i + 1;
    return article;
  }

  for (let i = 0; i < pool.cursor; i++) {
    const article = pool.articles[i];
    if (!article?.url) continue;
    if (articleContainsBlacklistedTerm(article, blacklistTerms)) continue;
    pool.cursor = i + 1;
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

  const failureDetails = {
    searchTerms,
    blacklistMatchedTerms,
    whitelistCount: whitelistTerms.length,
    blacklistCount: blacklistMatchedTerms.length,
    usedArticleCount: usedArticleUrls.size,
  };
  console.error(
    "[Reframe] newsFeed failure: no safe article found for whitelist intent. " +
      JSON.stringify(failureDetails)
  );

  return null;
}

function rotateTerms(terms, offset) {
  if (!terms.length) return terms;
  const start = ((offset % terms.length) + terms.length) % terms.length;
  return [...terms.slice(start), ...terms.slice(0, start)];
}