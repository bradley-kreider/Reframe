const SKIP_TAGS = new Set([
  "SCRIPT", "STYLE", "TEXTAREA", "INPUT", "CODE", "NOSCRIPT", "PRE",
]);
const MAX_MATCHES_PER_SCAN = 50;
const MAX_CONCURRENT_REPLACEMENTS = 3;
const DEBOUNCE_MS = 500;
const ADAPTIVE_RESCAN_BASE_MS = 700;
const ADAPTIVE_RESCAN_MAX_MS = 5000;
const ADAPTIVE_RESCAN_MAX_ATTEMPTS = 6;
const IMAGE_RETRY_INTERVAL_MS = 1000;
const IMAGE_RETRY_MAX_ATTEMPTS = 20;
const DESCRIPTION_CONTAINER_SELECTORS = "[data-editable='description'], .container__description, .container_list-images-with-description__description";
const CARD_CONTAINER_SELECTORS = "li[data-uri], article, [data-component-name='card'], li[class*='container__item'], [class*='card']";

let blacklist = [];
let whitelist = [];
let blacklistRegex = null;
let scanning = false;
let queuedScanRequested = false;
let newsApiKey = null;
let replacementEnabled = true;
let restrictToMajorNews = false;
let adaptiveRescanTimer = null;
let adaptiveRescanAttempt = 0;
let pendingImageRetryTimer = null;
const pendingImageReplacements = new Set();

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
let majorNewsDomains = [...DEFAULT_MAJOR_NEWS_DOMAINS];

function normalizeDomainList(domains) {
  if (!Array.isArray(domains)) return [];

  const seen = new Set();
  const normalized = [];

  for (const domain of domains) {
    const clean = String(domain || "")
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/.*/, "")
      .replace(/^www\./, "");

    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    normalized.push(clean);
  }

  return normalized;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildRegex(items) {
  if (!items.length) return null;
  const pattern = items.map((item) => escapeRegex(item.value)).join("|");
  return new RegExp("(" + pattern + ")", "gi");
}

function isExtensionContextInvalidatedError(err) {
  const message = typeof err === "string" ? err : err?.message;
  return typeof message === "string" && message.includes("Extension context invalidated");
}

async function loadPreferences() {
  try {
    const [prefsResponse, storageResult] = await Promise.all([
      chrome.runtime.sendMessage({ action: "getPreferences" }),
      chrome.storage.local.get(["newsApiKey", "restrictToMajorNews", "majorNewsDomains", "replacementEnabled"]),
    ]);
    blacklist = prefsResponse.blacklist || [];
    whitelist = prefsResponse.whitelist || [];
    blacklistRegex = buildRegex(blacklist);
    newsApiKey = storageResult.newsApiKey || null;
    replacementEnabled = storageResult.replacementEnabled !== false;
    restrictToMajorNews = Boolean(storageResult.restrictToMajorNews);

    const storedDomains = normalizeDomainList(storageResult.majorNewsDomains);
    majorNewsDomains = storedDomains.length
      ? storedDomains
      : [...DEFAULT_MAJOR_NEWS_DOMAINS];
  } catch (err) {
    if (isExtensionContextInvalidatedError(err)) return;
    console.warn("[Reframe] Failed to load preferences:", err);
  }
}

function isMajorNewsWebsite(hostname) {
  const normalized = (hostname || "").toLowerCase();
  return majorNewsDomains.some((domain) =>
    normalized === domain || normalized.endsWith("." + domain)
  );
}

function getTextNodes() {
  const nodes = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.textContent.trim()) return NodeFilter.FILTER_REJECT;
      if (SKIP_TAGS.has(node.parentElement?.tagName)) return NodeFilter.FILTER_REJECT;
      if (node.parentElement?.closest("[data-reframe-replaced]")) return NodeFilter.FILTER_REJECT;
      if (node.parentElement?.closest("[data-reframe-container-replaced='true']")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let node;
  while ((node = walker.nextNode())) nodes.push(node);
  return nodes;
}

function getReplacementContainer(node) {
  if (!node || node.nodeType !== Node.ELEMENT_NODE) return null;
  return node.closest(CARD_CONTAINER_SELECTORS);
}

function getContainerKey(container) {
  if (!container) return null;
  return (
    container.getAttribute("data-open-link") ||
    container.querySelector("a[href]")?.getAttribute("href") ||
    container.getAttribute("data-uri") ||
    null
  );
}

function isDescriptionNode(node) {
  if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
  return Boolean(node.closest(DESCRIPTION_CONTAINER_SELECTORS));
}

function updateCardDescription(container, descriptionText, replacementNode) {
  if (!container || !descriptionText) return;

  const descriptionElement = container.querySelector(DESCRIPTION_CONTAINER_SELECTORS);
  if (!descriptionElement) return;

  // Avoid overwriting the node we just replaced.
  if (replacementNode && (descriptionElement === replacementNode || descriptionElement.contains(replacementNode))) {
    return;
  }

  const nextText = String(descriptionText).trim();
  if (!nextText) return;

  descriptionElement.textContent = nextText;
  descriptionElement.setAttribute("data-reframe-replaced", "true");
}

function findMatches(textNodes) {
  if (!blacklistRegex) return [];
  const matches = [];
  const containerMatchIndexByKey = new Map();

  for (const node of textNodes) {
    if (matches.length >= MAX_MATCHES_PER_SCAN) break;
    blacklistRegex.lastIndex = 0;
    if (blacklistRegex.test(node.textContent)) {
      blacklistRegex.lastIndex = 0;
      const matchedItems = [];
      let m;
      while ((m = blacklistRegex.exec(node.textContent))) {
        const matchedValue = m[0].toLowerCase();
        // Find which blacklist item this matched
        const blacklistItem = blacklist.find(item =>
          item.value.toLowerCase() === matchedValue
        );
        if (blacklistItem) {
          matchedItems.push({
            value: matchedValue,
            type: blacklistItem.type
          });
        }
      }
      if (matchedItems.length > 0) {
        const element = node.parentElement;
        const container = getReplacementContainer(element);
        const containerKey = getContainerKey(container);
        const description = isDescriptionNode(element);

        if (container?.getAttribute("data-reframe-container-replaced") === "true") {
          continue;
        }

        if (containerKey) {
          if (containerMatchIndexByKey.has(containerKey)) {
            const existingIndex = containerMatchIndexByKey.get(containerKey);
            const existing = matches[existingIndex];
            // Prefer replacing headline/title text over description text in the same card.
            if (existing?.isDescription && !description) {
              matches[existingIndex] = {
                node,
                text: node.textContent,
                matchedTerms: matchedItems,
                container,
                containerKey,
                isDescription: description,
              };
            }
            continue;
          }

          containerMatchIndexByKey.set(containerKey, matches.length);
        }

        matches.push({
          node,
          text: node.textContent,
          matchedTerms: matchedItems,
          container,
          containerKey,
          isDescription: description,
        });
      }
    }
  }
  return matches;
}

function resetAdaptiveRescan() {
  adaptiveRescanAttempt = 0;
  if (adaptiveRescanTimer) {
    clearTimeout(adaptiveRescanTimer);
    adaptiveRescanTimer = null;
  }
}

function scheduleAdaptiveRescan(reason) {
  if (adaptiveRescanTimer || adaptiveRescanAttempt >= ADAPTIVE_RESCAN_MAX_ATTEMPTS) {
    return;
  }

  const delay = Math.min(
    ADAPTIVE_RESCAN_BASE_MS * Math.pow(2, adaptiveRescanAttempt),
    ADAPTIVE_RESCAN_MAX_MS
  );

  console.log("[Reframe] Scheduling adaptive rescan:", { reason, delay, attempt: adaptiveRescanAttempt + 1 });

  adaptiveRescanTimer = setTimeout(() => {
    adaptiveRescanTimer = null;
    adaptiveRescanAttempt += 1;
    scanPage();
  }, delay);
}

async function replaceMatchesConcurrently(matches) {
  if (!matches.length) return;

  let index = 0;
  const workerCount = Math.min(MAX_CONCURRENT_REPLACEMENTS, matches.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (index < matches.length) {
      const current = matches[index++];
      await replaceMatch(current);
    }
  });

  await Promise.all(workers);
}

function schedulePendingImageRetry() {
  if (pendingImageRetryTimer || !pendingImageReplacements.size) return;
  pendingImageRetryTimer = setTimeout(() => {
    pendingImageRetryTimer = null;
    processPendingImageReplacements();
  }, IMAGE_RETRY_INTERVAL_MS);
}

function queuePairedImageReplacement(contextNode, imageUrl, articleUrl) {
  if (!contextNode || !imageUrl) return;

  pendingImageReplacements.add({
    contextNode,
    imageUrl,
    articleUrl: articleUrl || null,
    attemptsRemaining: IMAGE_RETRY_MAX_ATTEMPTS,
  });
  schedulePendingImageRetry();
}

function processPendingImageReplacements() {
  if (!pendingImageReplacements.size) return;

  const nextPending = new Set();
  for (const task of pendingImageReplacements) {
    if (!task.contextNode?.isConnected) continue;

    const didReplace = replacePairedImage(task.contextNode, task.imageUrl, task.articleUrl);
    if (!didReplace && task.attemptsRemaining > 1) {
      task.attemptsRemaining -= 1;
      nextPending.add(task);
    }
  }

  pendingImageReplacements.clear();
  nextPending.forEach((task) => pendingImageReplacements.add(task));
  if (pendingImageReplacements.size) {
    schedulePendingImageRetry();
  }
}

async function replaceMatch(match) {
  try {
    if (match.container?.getAttribute("data-reframe-container-replaced") === "true") {
      return;
    }

    const response = await chrome.runtime.sendMessage({
      action: "getReplacements",
      text: match.text,
      matchedTerms: match.matchedTerms,
      whitelist,
      newsApiKey,
    });

    if (!response || !response.success) {
      const errorMsg = response?.error || "Unknown replacement failure";
      const isExpectedSkip =
        errorMsg.includes("No replacement article available") ||
        errorMsg.includes("did not pass validation");

      if (!isExpectedSkip) {
        console.warn("[Reframe] Replacement failed:", errorMsg);
      }
      return;
    }

    // Make sure the node is still in the DOM
    if (!match.node.parentElement) return;
    const contextElement = match.node.parentElement;
    const existingAnchor = contextElement.closest("a[href]");

    let replacement;
    const insideExistingAnchor = Boolean(existingAnchor);
    if (response.articleUrl && !insideExistingAnchor) {
      replacement = document.createElement("a");
      replacement.href = response.articleUrl;
      replacement.target = "_blank";
      replacement.rel = "noopener noreferrer";
    } else {
      replacement = document.createElement("span");
    }
    replacement.textContent = response.replacement;
    replacement.setAttribute("data-reframe-replaced", "true");
    
    // Copy computed styles from parent to match seamlessly
    const computedStyle = window.getComputedStyle(contextElement);
    const stylesToCopy = [
      "color",
      "fontSize",
      "fontFamily",
      "fontWeight",
      "fontStyle",
      "lineHeight",
      "letterSpacing",
      "textTransform",
      "textDecoration",
      "fontVariant"
    ];
    
    stylesToCopy.forEach(style => {
      replacement.style[style] = computedStyle[style];
    });
    
    replacement.title = "Reframed content (original contained: " + match.matchedTerms.map(t => t.value).join(", ") + ")";

    if (response.articleUrl && insideExistingAnchor && existingAnchor) {
      existingAnchor.href = response.articleUrl;
      existingAnchor.target = "_blank";
      existingAnchor.rel = "noopener noreferrer";
    }
    
    contextElement.replaceChild(replacement, match.node);

    if (match.container) {
      if (response.articleDescription) {
        updateCardDescription(match.container, response.articleDescription, replacement);
      }

      match.container.setAttribute("data-reframe-container-replaced", "true");
      if (match.containerKey) {
        match.container.setAttribute("data-reframe-container-key", match.containerKey);
      }
    }

    if (response.articleImageUrl) {
      const didReplaceImage = replacePairedImage(replacement, response.articleImageUrl, response.articleUrl);
      if (!didReplaceImage) {
        queuePairedImageReplacement(replacement, response.articleImageUrl, response.articleUrl);
      }
    }
  } catch (err) {
    console.warn("[Reframe] Error replacing text:", err);
  }
}

function replacePairedImage(contextNode, imageUrl, articleUrl) {
  // Accept both http/https and data: URLs
  const isHttpImage = /^https?:\/\//i.test(imageUrl || "");
  const isDataImage = /^data:image\//i.test(imageUrl || "");
  if (!imageUrl || (!isHttpImage && !isDataImage)) {
    return false;
  }

  const normalizedImageUrl = isHttpImage
    ? imageUrl.replace(/^http:\/\//i, "https://")
    : imageUrl;

  const sourceElement = contextNode?.nodeType === Node.ELEMENT_NODE ? contextNode : contextNode?.parentElement;
  if (!sourceElement) return false;

  // Walk up to find a likely content block that also contains an image.
  const containerSelectors = "article, section, li, figure, main, [class*='card'], [class*='item'], [class*='story'], [class*='post']";
  let container = sourceElement.closest(containerSelectors);

  while (container && !container.querySelector("img")) {
    container = container.parentElement?.closest(containerSelectors) || null;
  }

  if (!container) {
    return false;
  }

  const sourceRect = sourceElement.getBoundingClientRect();

  const visibleCandidateImages = Array.from(container.querySelectorAll("img")).filter((img) => {
    const rect = img.getBoundingClientRect();
    const width = Math.max(img.naturalWidth || 0, img.width || 0, img.offsetWidth || 0, rect.width || 0);
    const height = Math.max(img.naturalHeight || 0, img.height || 0, img.offsetHeight || 0, rect.height || 0);
    const isVisible = rect.width > 0 && rect.height > 0;

    // Skip tiny icons and hidden tracking pixels. Hard coded
    return width > 120 && height > 80 && isVisible;
  });

  const fallbackCandidateImages = Array.from(container.querySelectorAll("picture img, .image__dam-img, img")).filter((img) => {
    const width = Math.max(img.naturalWidth || 0, img.width || 0, img.offsetWidth || 0);
    const height = Math.max(img.naturalHeight || 0, img.height || 0, img.offsetHeight || 0);
    return width > 40 || height > 40 || img.closest("picture") || img.closest("[data-url]");
  });

  const candidateImages = visibleCandidateImages.length ? visibleCandidateImages : fallbackCandidateImages;

  if (!candidateImages.length) return false;

  const pairedImage = candidateImages.reduce((best, img) => {
    const bRect = best.getBoundingClientRect();
    const iRect = img.getBoundingClientRect();

    const bArea = bRect.width * bRect.height;
    const iArea = iRect.width * iRect.height;

    const bCenterY = bRect.top + bRect.height / 2;
    const iCenterY = iRect.top + iRect.height / 2;
    const sourceCenterY = sourceRect.top + sourceRect.height / 2;

    const bDistance = Math.abs(bCenterY - sourceCenterY);
    const iDistance = Math.abs(iCenterY - sourceCenterY);

    // Prefer images closer to the replaced text, with area as a secondary signal.
    const bScore = bDistance * 5 - bArea / 1000;
    const iScore = iDistance * 5 - iArea / 1000;
    return iScore < bScore ? img : best;
  });

  const picture = pairedImage.closest("picture");
  if (picture) {
    picture.querySelectorAll("source").forEach((source) => {
      source.setAttribute("srcset", normalizedImageUrl);
      source.removeAttribute("sizes");
      source.removeAttribute("data-srcset");
    });
  }

  pairedImage.src = normalizedImageUrl;
  pairedImage.srcset = "";
  pairedImage.removeAttribute("sizes");
  pairedImage.removeAttribute("data-src");
  pairedImage.removeAttribute("data-srcset");
  pairedImage.setAttribute("data-src", normalizedImageUrl);
  pairedImage.setAttribute("data-srcset", normalizedImageUrl);
  pairedImage.setAttribute("loading", "eager");

  if (articleUrl) {
    const imageAnchor = pairedImage.closest("a[href]");
    if (imageAnchor) {
      imageAnchor.href = articleUrl;
      imageAnchor.target = "_blank";
      imageAnchor.rel = "noopener noreferrer";
    }

    pairedImage.setAttribute("data-zjs-href", articleUrl);
  }

  const imageWrapper = pairedImage.closest("[data-url]");
  if (imageWrapper) {
    imageWrapper.setAttribute("data-url", normalizedImageUrl);
  }

  return true;
}

async function scanPage() {
  if (scanning) {
    queuedScanRequested = true;
    return;
  }
  scanning = true;

  try {
    await loadPreferences();

    if (!replacementEnabled) {
      resetAdaptiveRescan();
      return;
    }

    if (restrictToMajorNews && !isMajorNewsWebsite(window.location.hostname)) {
      resetAdaptiveRescan();
      return;
    }

    if (!blacklistRegex || !whitelist.length) {
      scheduleAdaptiveRescan("preferences-not-ready");
      return;
    }

    console.log("[Reframe] Scanning page...");
    const textNodes = getTextNodes();
    const matches = findMatches(textNodes);
    console.log("[Reframe] Found", matches.length, "matches");

    // Small worker pool improves throughput while avoiding request floods.
    await replaceMatchesConcurrently(matches);

    if (matches.length === 0 && document.readyState !== "complete") {
      scheduleAdaptiveRescan("page-still-loading");
    } else if (matches.length === 0 && textNodes.length < 40) {
      scheduleAdaptiveRescan("low-text-density");
    } else {
      resetAdaptiveRescan();
    }

    console.log("[Reframe] Scan complete");
  } finally {
    scanning = false;
    if (queuedScanRequested) {
      queuedScanRequested = false;
      setTimeout(() => scanPage(), 0);
    }
  }
}

// --- MutationObserver (debounced) ---
let debounceTimer = null;

const observer = new MutationObserver((mutations) => {
  const dynamicDelay = Math.min(DEBOUNCE_MS + mutations.length * 25, 1500);
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    scanPage();
  }, dynamicDelay);

  if (pendingImageReplacements.size) {
    processPendingImageReplacements();
  }
});

// --- Message listener for rescan ---
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === "rescanPage") {
    scanPage();
  }
});

window.addEventListener("load", () => {
  processPendingImageReplacements();
});

window.addEventListener("scroll", () => {
  if (pendingImageReplacements.size) {
    processPendingImageReplacements();
  }
}, { passive: true });

// --- Init ---
scanPage().then(() => {
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  // Run a follow-up adaptive scan after observer attachment for late-hydrated pages.
  scheduleAdaptiveRescan("observer-attached");
});
