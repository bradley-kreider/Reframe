const SKIP_TAGS = new Set([
  "SCRIPT", "STYLE", "TEXTAREA", "INPUT", "CODE", "NOSCRIPT", "PRE",
]);
const MAX_MATCHES_PER_SCAN = 50;
const DEBOUNCE_MS = 500;
const IMAGE_RETRY_INTERVAL_MS = 1000;
const IMAGE_RETRY_MAX_ATTEMPTS = 20;

let blacklist = [];
let whitelist = [];
let blacklistRegex = null;
let scanning = false;
let newsApiKey = null;
let pendingImageRetryTimer = null;
const pendingImageReplacements = new Set();

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildRegex(items) {
  if (!items.length) return null;
  const pattern = items.map((item) => escapeRegex(item.value)).join("|");
  return new RegExp("(" + pattern + ")", "gi");
}

async function loadPreferences() {
  try {
    const [prefsResponse, storageResult] = await Promise.all([
      chrome.runtime.sendMessage({ action: "getPreferences" }),
      chrome.storage.local.get("newsApiKey"),
    ]);
    blacklist = prefsResponse.blacklist || [];
    whitelist = prefsResponse.whitelist || [];
    blacklistRegex = buildRegex(blacklist);
    newsApiKey = storageResult.newsApiKey || null;
  } catch (err) {
    console.warn("[Reframe] Failed to load preferences:", err);
  }
}

function getTextNodes() {
  const nodes = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.textContent.trim()) return NodeFilter.FILTER_REJECT;
      if (SKIP_TAGS.has(node.parentElement?.tagName)) return NodeFilter.FILTER_REJECT;
      if (node.parentElement?.closest("[data-reframe-replaced]")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let node;
  while ((node = walker.nextNode())) nodes.push(node);
  return nodes;
}

function findMatches(textNodes) {
  if (!blacklistRegex) return [];
  const matches = [];
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
        matches.push({ node, text: node.textContent, matchedTerms: matchedItems });
      }
    }
  }
  return matches;
}

function schedulePendingImageRetry() {
  if (pendingImageRetryTimer || !pendingImageReplacements.size) return;
  pendingImageRetryTimer = setTimeout(() => {
    pendingImageRetryTimer = null;
    processPendingImageReplacements();
  }, IMAGE_RETRY_INTERVAL_MS);
}

function queuePairedImageReplacement(contextNode, imageUrl) {
  if (!contextNode || !imageUrl) return;

  pendingImageReplacements.add({
    contextNode,
    imageUrl,
    attemptsRemaining: IMAGE_RETRY_MAX_ATTEMPTS,
  });
  schedulePendingImageRetry();
}

function processPendingImageReplacements() {
  if (!pendingImageReplacements.size) return;

  const nextPending = new Set();
  for (const task of pendingImageReplacements) {
    if (!task.contextNode?.isConnected) continue;

    const didReplace = replacePairedImage(task.contextNode, task.imageUrl);
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

    let replacement;
    if (response.articleUrl) {
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
    const parent = contextElement;
    const computedStyle = window.getComputedStyle(parent);
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
    
    // Add subtle styling for visibility
    replacement.style.backgroundColor = "rgba(74, 144, 217, 0.08)";
    replacement.style.borderRadius = "2px";
    replacement.title = "Reframed content (original contained: " + match.matchedTerms.map(t => t.value).join(", ") + ")";
    
    contextElement.replaceChild(replacement, match.node);

    if (response.articleImageUrl) {
      const didReplaceImage = replacePairedImage(replacement, response.articleImageUrl);
      if (!didReplaceImage) {
        queuePairedImageReplacement(replacement, response.articleImageUrl);
      }
    }
  } catch (err) {
    console.warn("[Reframe] Error replacing text:", err);
  }
}

function replacePairedImage(contextNode, imageUrl) {
  // Some pages block non-https mixed content images.
  if (!imageUrl || !/^https?:\/\//i.test(imageUrl)) {
    return false;
  }

  const normalizedImageUrl = imageUrl.replace(/^http:\/\//i, "https://");

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

    // Skip tiny icons and hidden tracking pixels.
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

  const imageWrapper = pairedImage.closest("[data-url]");
  if (imageWrapper) {
    imageWrapper.setAttribute("data-url", normalizedImageUrl);
  }

  return true;
}

async function scanPage() {
  if (scanning) return;
  scanning = true;

  await loadPreferences();
  if (!blacklistRegex || !whitelist.length) {
    scanning = false;
    return;
  }

  console.log("[Reframe] Scanning page...");
  const textNodes = getTextNodes();
  const matches = findMatches(textNodes);
  console.log("[Reframe] Found", matches.length, "matches");

  // Process replacements sequentially to avoid overwhelming Ollama
  for (const match of matches) {
    await replaceMatch(match);
  }

  scanning = false;
  console.log("[Reframe] Scan complete");
}

// --- MutationObserver (debounced) ---
let debounceTimer = null;

const observer = new MutationObserver(() => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    scanPage();
  }, DEBOUNCE_MS);

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
  });
});
