# Reframe MVP — Testing Instructions

## Prerequisites

1. **Google Chrome** (or Chromium-based browser)
2. **Ollama** installed and running locally
   - Install: https://ollama.com/download
   - Pull the model: `ollama pull llama3.2`
   - Start the server: `ollama serve` (runs on `http://localhost:11434`)

---

## Step 1: Load the Extension

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked**
4. Select the `C:\dev\Reframe` folder
5. The Reframe icon (blue "R") should appear in your toolbar — pin it for easy access

---

## Step 2: Verify Ollama Connection

1. Make sure `ollama serve` is running in a terminal
2. Click the Reframe toolbar icon to open the popup
3. The top-right should show a green dot with **"Ollama Connected"**
4. If it shows red / "Disconnected", check that Ollama is running and listening on port 11434

---

## Step 3: Add Preferences

### Add blacklist entries (content you want replaced)
1. In the popup, make sure the **Blacklist** tab is selected
2. From the dropdown, pick a type:
   - **Keyword** — a specific word or phrase (e.g., "war", "inflation")
   - **Topic** — a broader subject (e.g., "politics", "crime")
   - **Source** — a content source (e.g., "CNN", "Fox News")
3. Type a value in the text field and click **Add**
4. Repeat to add several entries

### Add whitelist entries (content you want to see instead)
1. Switch to the **Whitelist** tab
2. Add entries the same way (e.g., keyword "gardening", topic "cooking", source "Nature Magazine")

### Suggested test set
| List      | Type    | Value        |
|-----------|---------|--------------|
| Blacklist | Keyword | war          |
| Blacklist | Keyword | conflict     |
| Blacklist | Topic   | politics     |
| Whitelist | Keyword | gardening    |
| Whitelist | Keyword | flowers      |
| Whitelist | Topic   | cooking      |

---

## Step 4: Test Content Replacement

1. Open a news site that likely contains your blacklisted terms (e.g., CNN, BBC, Reuters)
2. Open the browser DevTools console (`F12` → Console tab)
3. You should see log messages:
   - `[Reframe] Scanning page...`
   - `[Reframe] Found X matches`
   - `[Reframe] Scan complete`
4. Replaced text will have a **subtle blue highlight** and a tooltip showing which blacklisted terms were found
5. Hover over highlighted text to see the tooltip

**Note:** Each replacement requires a round-trip to Ollama, so replacements appear one at a time. The page remains fully interactive while this happens.

---

## Step 5: Test Preference Management

### Edit a preference
1. Open the popup and click the **pencil icon** next to any entry
2. Modify the value and press **Enter** (or click away to save)
3. The updated value should persist — close and reopen the popup to confirm

### Delete a preference
1. Click the **× button** next to any entry
2. It should be removed immediately

### Filter by type
1. Click the **Keywords**, **Topics**, or **Sources** filter buttons above the list
2. The list should filter to show only that type
3. Click **All** to show everything again

### Clear all
1. Click **Clear All** at the bottom
2. Confirm the dialog — all entries in the current tab (Blacklist or Whitelist) will be deleted

---

## Step 6: Test Live Updates

1. Have a news page open with replacements already applied
2. Open the popup and add a new blacklist entry for a word visible on the page
3. The content script should re-scan and replace the newly blacklisted content
4. Check the console for `[Reframe] Scanning page...` logs

---

## Step 7: Test SPA / Dynamic Content

1. Go to a single-page app like Twitter/X or Reddit
2. Scroll down to load new content
3. The MutationObserver should detect new DOM nodes and scan them (with a 500ms debounce)
4. Check the console for repeated scan logs as new content loads

---

## Step 8: Test Graceful Degradation

1. Stop Ollama (`Ctrl+C` in the terminal running `ollama serve`)
2. Open the popup — status should show **red / "Ollama Disconnected"**
3. Visit a page with blacklisted content — console should show match detection but warn about failed replacements
4. Original text remains unchanged (no broken content)
5. Restart Ollama (`ollama serve`) and reload the page — replacements should work again

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Extension doesn't appear | Make sure Developer mode is on and you selected the correct folder |
| "Ollama Disconnected" | Run `ollama serve` and verify `http://localhost:11434` responds in a browser |
| No matches found | Check that your blacklist terms actually appear on the page (case-insensitive) |
| Replacements timeout | Ollama may be slow on first run (loading model). Try again after the model is warm |
| No replacements despite matches | Make sure you have **whitelist** entries too — both lists are required |
| Console errors about IndexedDB | Try removing and re-loading the extension |
