const SKIP_TAGS = new Set([
  "SCRIPT", "STYLE", "TEXTAREA", "INPUT", "CODE", "NOSCRIPT", "PRE",
]);
const MAX_MATCHES_PER_SCAN = 50;
const DEBOUNCE_MS = 500;

let blacklist = [];
let whitelist = [];
let blacklistRegex = null;
let scanning = false;
let newsApiKey = null;

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
      const terms = new Set();
      let m;
      while ((m = blacklistRegex.exec(node.textContent))) {
        terms.add(m[0].toLowerCase());
      }
      matches.push({ node, text: node.textContent, matchedTerms: [...terms] });
    }
  }
  return matches;
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
      console.warn("[Reframe] Replacement failed:", response?.error);
      return;
    }

    // Make sure the node is still in the DOM
    if (!match.node.parentElement) return;

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
    replacement.style.backgroundColor = "rgba(74, 144, 217, 0.08)";
    replacement.style.borderRadius = "2px";
    replacement.title = "Reframed content (original contained: " + match.matchedTerms.join(", ") + ")";
    match.node.parentElement.replaceChild(replacement, match.node);

    if (response.articleImageUrl) {
      replaceHeroImage(response.articleImageUrl);
    }
  } catch (err) {
    console.warn("[Reframe] Error replacing text:", err);
  }
}

function replaceHeroImage(imageUrl) {
  // Try og:image meta tag first
  const ogImage = document.querySelector('meta[property="og:image"]');
  if (ogImage) {
    ogImage.setAttribute("content", imageUrl);
  }

  // Find the hero image element: largest <img> in the top portion of the page
  const allImages = Array.from(document.querySelectorAll("img[src]")).filter((img) => {
    // Skip tiny icons and tracking pixels
    return img.naturalWidth > 100 || img.width > 100 || img.offsetWidth > 100;
  });

  if (!allImages.length) return;

  // Prefer images in header/article/figure elements, otherwise pick the largest visible one
  const heroCandidate =
    document.querySelector("header img[src], article img[src], figure img[src], .hero img[src], [class*='header'] img[src], [class*='hero'] img[src]") ||
    allImages.reduce((best, img) => {
      const bArea = (best.offsetWidth || best.width || 0) * (best.offsetHeight || best.height || 0);
      const iArea = (img.offsetWidth || img.width || 0) * (img.offsetHeight || img.height || 0);
      return iArea > bArea ? img : best;
    });

  if (heroCandidate) {
    heroCandidate.src = imageUrl;
    heroCandidate.srcset = "";
  }
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
});

// --- Message listener for rescan ---
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === "rescanPage") {
    scanPage();
  }
});

// --- Init ---
scanPage().then(() => {
  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
});
