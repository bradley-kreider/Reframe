const SKIP_TAGS = new Set([
  "SCRIPT", "STYLE", "TEXTAREA", "INPUT", "CODE", "NOSCRIPT", "PRE",
]);
const MAX_MATCHES_PER_SCAN = 50;
const DEBOUNCE_MS = 500;

let blacklist = [];
let whitelist = [];
let blacklistRegex = null;
let scanning = false;

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
    const response = await chrome.runtime.sendMessage({ action: "getPreferences" });
    blacklist = response.blacklist || [];
    whitelist = response.whitelist || [];
    blacklistRegex = buildRegex(blacklist);
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
    });

    if (!response || !response.success) {
      console.warn("[Reframe] Replacement failed:", response?.error);
      return;
    }

    // Make sure the node is still in the DOM
    if (!match.node.parentElement) return;

    const span = document.createElement("span");
    span.textContent = response.replacement;
    span.setAttribute("data-reframe-replaced", "true");
    span.style.backgroundColor = "rgba(74, 144, 217, 0.08)";
    span.style.borderRadius = "2px";
    span.title = "Reframed content (original contained: " + match.matchedTerms.join(", ") + ")";
    match.node.parentElement.replaceChild(span, match.node);
  } catch (err) {
    console.warn("[Reframe] Error replacing text:", err);
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
