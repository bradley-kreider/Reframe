let currentStore = "blacklist";
let currentFilter = "all";

const prefList = document.getElementById("pref-list");
const addForm = document.getElementById("add-form");
const prefType = document.getElementById("pref-type");
const prefValue = document.getElementById("pref-value");
const clearAllBtn = document.getElementById("clear-all-btn");
const statusEl = document.getElementById("ollama-status");
const statusText = document.getElementById("status-text");

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

// --- Ollama status ---
async function checkOllamaStatus() {
  statusEl.className = "status checking";
  statusText.textContent = "Checking...";
  try {
    const response = await chrome.runtime.sendMessage({ action: "checkOllamaStatus" });
    if (response && response.connected) {
      statusEl.className = "status connected";
      statusText.textContent = "Ollama Connected";
    } else {
      statusEl.className = "status disconnected";
      statusText.textContent = "Ollama Disconnected";
    }
  } catch {
    statusEl.className = "status disconnected";
    statusText.textContent = "Ollama Disconnected";
  }
}

function notifyPreferencesUpdated() {
  chrome.runtime.sendMessage({ action: "preferencesUpdated" }).catch(() => {});
}

// --- Init ---
renderList();
checkOllamaStatus();
