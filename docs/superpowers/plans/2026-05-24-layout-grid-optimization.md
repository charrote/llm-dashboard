# Layout Grid Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add configurable grid column count and per-card column width settings, persisted to server config.

**Architecture:** Two-file change: `proxy/server.js` (config API) + `dashboard.html` (UI). Server stores `layoutGrid` (number) and `cardWidths` (object). Frontend unifies all cards into a single CSS grid and adds per-card width controls.

**Tech Stack:** Express.js, vanilla JS, Tailwind CSS (CDN), Chart.js

---

### Task 1: Add layoutGrid and cardWidths to server config

**Files:**
- Modify: `proxy/server.js:18-28` (defaults)
- Modify: `proxy/server.js:991-1005` (GET /api/config)
- Modify: `proxy/server.js:1007-1031` (POST /api/config)

- [ ] **Step 1: Add defaults for new config fields**

Edit `proxy/server.js` after line 28 (after resourceMonitor defaults):

```js
config.layoutGrid = config.layoutGrid || 6;
config.cardWidths = config.cardWidths || {};
```

- [ ] **Step 2: Add fields to GET /api/config response**

Edit `proxy/server.js` GET handler to add `layoutGrid` and `cardWidths`:

```js
app.get('/api/config', (req, res) => {
  res.json({
    lmStudioContainer: config.lmStudio?.container || '',
    lmStudioPort: config.lmStudio?.port || 1234,
    lmStudioUrl: lmStudioUrl || '',
    enableAPIKey: config.enableAPIKey || false,
    enableLog: config.enableLog || false,
    lmAuthEnabled: config.lmAuthEnabled || false,
    lmAuthValue: config.lmAuthValue || '',
    simCostEnabled: config.simCostEnabled || false,
    simPromptCost: config.simPromptCost || 0,
    simCompletionCost: config.simCompletionCost || 0,
    trendDays: config.trendDays || 30,
    layoutGrid: config.layoutGrid || 6,
    cardWidths: config.cardWidths || {}
  });
});
```

- [ ] **Step 3: Add fields to POST /api/config**

Edit the destructuring and body in the POST handler:

```js
app.post('/api/config', (req, res) => {
  const { lmStudioContainer, lmStudioPort, lmStudioUrl: url, defaultAPIKey, enableAPIKey, enableLog, lmAuthEnabled, lmAuthValue, simCostEnabled, simPromptCost, simCompletionCost, trendDays, layoutGrid, cardWidths } = req.body;
  
  // ... existing code ...
  
  if (layoutGrid !== undefined) config.layoutGrid = parseInt(layoutGrid) || 6;
  if (cardWidths !== undefined) config.cardWidths = cardWidths;
  
  // existing condition check needs updating to include the new fields
```

- [ ] **Step 4: Update the conditional save check**

The current condition on line 1017 checks for specific fields. Extend it to include `layoutGrid` and `cardWidths`:

Change:
```js
  if (defaultAPIKey !== undefined || enableAPIKey !== undefined || enableLog !== undefined || lmAuthEnabled !== undefined || lmAuthValue !== undefined || simCostEnabled !== undefined || simPromptCost !== undefined || simCompletionCost !== undefined || trendDays !== undefined) {
```
To:
```js
  if (defaultAPIKey !== undefined || enableAPIKey !== undefined || enableLog !== undefined || lmAuthEnabled !== undefined || lmAuthValue !== undefined || simCostEnabled !== undefined || simPromptCost !== undefined || simCompletionCost !== undefined || trendDays !== undefined || layoutGrid !== undefined || cardWidths !== undefined) {
```

- [ ] **Step 5: Verify server still starts**

Run: `node proxy/server.js` (should start without errors, then Ctrl+C)

- [ ] **Step 6: Commit**

```bash
git add proxy/server.js
git commit -m "feat: add layoutGrid and cardWidths to server config API"
```

---

### Task 2: Add "布局栅格" input to config modal

**Files:**
- Modify: `dashboard.html`

- [ ] **Step 1: Add layoutGrid input to config modal HTML**

After the `trendDays` input (around line 112), add:

```html
          <div class="border-t border-gray-700 pt-4 mt-4">
            <label class="block text-sm text-gray-400 mb-2">布局栅格</label>
            <input type="number" id="layoutGrid" min="1" max="24" value="6"
                   class="w-full bg-gray-700 border border-gray-600 rounded-lg px-4 py-2 text-white focus:border-blue-500 focus:outline-none">
            <p class="text-xs text-gray-500 mt-1">主页卡片网格列数（1-24），默认 6</p>
          </div>
```

Place it right before the `<div class="flex gap-2">` containing "测试连接" and "保存" buttons.

- [ ] **Step 2: Load layoutGrid in loadConfig()**

In `loadConfig()` function, after the trendDays line:

```js
        document.getElementById('layoutGrid').value = data.layoutGrid || 6;
```

- [ ] **Step 3: Save layoutGrid in saveConfig()**

In `saveConfig()`, before the fetch body:

```js
      const layoutGrid = document.getElementById('layoutGrid').value;
```

And add to the POST body:

```js
            layoutGrid: parseInt(layoutGrid) || 6,
```

- [ ] **Step 4: Update appConfig in loadConfigWithoutModal()**

Add `layoutGrid` to the appConfig in `loadConfigWithoutModal()`:

```js
        appConfig = {
          simCostEnabled: data.simCostEnabled || false,
          simPromptCost: data.simPromptCost || 0,
          simCompletionCost: data.simCompletionCost || 0,
          trendDays: data.trendDays || 30,
          layoutGrid: data.layoutGrid || 6,
          cardWidths: data.cardWidths || {}
        };
```

- [ ] **Step 5: Commit**

```bash
git add dashboard.html
git commit -m "feat: add layoutGrid setting to config modal"
```

---

### Task 3: Unify cards into single grid with dynamic column spans

**Files:**
- Modify: `dashboard.html`

- [ ] **Step 1: Define card IDs and default widths in JS**

Add after the `appConfig` declaration (around line 513):

```js
    const CARD_DEFAULTS = {
      'today-requests': 2,
      'resource-monitor': 2,
      'container-logs': 3,
      'trend-chart': 1,
      'hourly-chart': 1,
      'apikey-table': 1,
      'model-table': 1,
      'model-performance': 1,
      'cost-trend': 1,
      'logs-section': 1
    };
```

- [ ] **Step 2: Wrap all card sections in a single grid container**

Replace the existing separate grid containers with one unified grid:

Change the top stats grid div:
```html
    <!-- Stats Cards -->
    <div class="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4 mb-6">
```
To:
```html
    <!-- Cards Grid -->
    <div id="cardsGrid" class="grid gap-4 mb-6">
```

Change the charts row from:
```html
    <!-- Charts Row -->
    <div class="grid grid-cols-1 xl:grid-cols-2 gap-6 mb-10">
```
To:
```html
    <!-- (remove the wrapper div, keep just the chart cards inside cardsGrid) -->
```

Change the tables row from:
```html
    <!-- Tables Row -->
    <div class="grid grid-cols-1 xl:grid-cols-3 gap-6 mb-10">
```
To the same treatment.

And remove the standalone `div` wrappers for cost-trend and logs-section, making them direct children of `#cardsGrid`.

- [ ] **Step 3: Add `data-card-id` attributes to each card**

Example for the today-requests card:
```html
      <div data-card-id="today-requests" class="bg-gray-800 rounded-xl p-5">
```
Remove existing `col-span-2`, `col-span-1 xl:col-span-3` classes from all cards.

- [ ] **Step 4: Add a helper function to apply grid layout**

```js
    function applyGridLayout() {
      const grid = document.getElementById('cardsGrid');
      const cols = appConfig.layoutGrid || 6;
      grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
      
      document.querySelectorAll('[data-card-id]').forEach(el => {
        const id = el.dataset.cardId;
        const span = (appConfig.cardWidths && appConfig.cardWidths[id]) || CARD_DEFAULTS[id] || 1;
        el.style.gridColumn = `span ${Math.min(span, cols)}`;
      });
    }
```

- [ ] **Step 5: Call applyGridLayout after data loads**

Call `applyGridLayout()` at the end of `loadConfigWithoutModal()` after setting appConfig, and at the end of `saveConfig()` after closing the modal.

- [ ] **Step 6: Commit**

```bash
git add dashboard.html
git commit -m "feat: unify card grid with dynamic column spans"
```

---

### Task 4: Add per-card width selector button

**Files:**
- Modify: `dashboard.html`

- [ ] **Step 1: Add a popover HTML element for card width setting**

Add after the config modal, somewhere before the closing `</div>` of `#app`:

```html
    <!-- Card Width Popover -->
    <div id="cardWidthPopover" class="fixed z-50 hidden">
      <div class="bg-gray-800 rounded-xl p-4 shadow-xl border border-gray-700 w-48">
        <div class="text-sm text-gray-400 mb-2">栅格宽度</div>
        <div class="flex items-center gap-2">
          <input type="number" id="cardWidthInput" min="1" max="6" value="1"
                 class="w-20 bg-gray-700 border border-gray-600 rounded-lg px-3 py-1.5 text-white text-sm focus:border-blue-500 focus:outline-none">
          <span class="text-gray-400 text-sm">/ <span id="cardWidthMax">6</span></span>
        </div>
        <div class="flex gap-2 mt-3">
          <button onclick="saveCardWidth()" class="flex-1 bg-blue-600 hover:bg-blue-700 px-3 py-1.5 rounded-lg text-sm transition">确定</button>
          <button onclick="closeCardWidthPopover()" class="flex-1 bg-gray-600 hover:bg-gray-500 px-3 py-1.5 rounded-lg text-sm transition">取消</button>
        </div>
      </div>
    </div>
```

- [ ] **Step 2: Add grid icon button to each card**

Add a grid icon button to each card's title area. For example, in the today-requests card:

Change:
```html
        <h3 class="text-lg font-semibold mb-4">📊 当日请求</h3>
```
To:
```html
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-lg font-semibold">📊 当日请求</h3>
          <button onclick="openCardWidthPopover('today-requests', event)" class="text-gray-500 hover:text-white transition text-sm px-1" title="设置栅格宽度">⊞</button>
        </div>
```

Repeat for all 10 cards.

- [ ] **Step 3: Add JS functions for popover**

```js
    let activeCardId = null;

    function openCardWidthPopover(cardId, event) {
      activeCardId = cardId;
      const cols = appConfig.layoutGrid || 6;
      const current = (appConfig.cardWidths && appConfig.cardWidths[cardId]) || CARD_DEFAULTS[cardId] || 1;
      
      const input = document.getElementById('cardWidthInput');
      input.value = current;
      input.max = cols;
      document.getElementById('cardWidthMax').textContent = cols;
      
      const popover = document.getElementById('cardWidthPopover');
      const rect = event.currentTarget.getBoundingClientRect();
      popover.style.top = (rect.bottom + 8) + 'px';
      popover.style.left = Math.max(8, rect.left - 140) + 'px';
      popover.classList.remove('hidden');
    }

    function closeCardWidthPopover() {
      document.getElementById('cardWidthPopover').classList.add('hidden');
      activeCardId = null;
    }

    async function saveCardWidth() {
      if (!activeCardId) return;
      const cols = appConfig.layoutGrid || 6;
      const val = parseInt(document.getElementById('cardWidthInput').value) || 1;
      const span = Math.max(1, Math.min(val, cols));
      
      appConfig.cardWidths = appConfig.cardWidths || {};
      appConfig.cardWidths[activeCardId] = span;
      
      // Save to server
      try {
        await fetch(`${API_BASE}/config`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cardWidths: appConfig.cardWidths })
        });
      } catch (e) {
        console.error('Save card width error:', e);
      }
      
      applyGridLayout();
      closeCardWidthPopover();
    }
    
    // Close popover on outside click
    document.addEventListener('click', function(e) {
      const popover = document.getElementById('cardWidthPopover');
      if (!popover.classList.contains('hidden') && !popover.contains(e.target) && !e.target.closest('[data-card-id]')?.querySelector('button')) {
        // Check if click is on the button that opened it
        const target = e.target;
        if (!target.closest('button[onclick*="openCardWidthPopover"]')) {
          closeCardWidthPopover();
        }
      }
    });
```

Better approach for outside click - use a simpler handler:

```js
    document.addEventListener('click', function(e) {
      const popover = document.getElementById('cardWidthPopover');
      if (popover.classList.contains('hidden')) return;
      if (!popover.contains(e.target) && !e.target.closest('[onclick*="openCardWidthPopover"]')) {
        closeCardWidthPopover();
      }
    });
```

- [ ] **Step 4: Connect saveConfig to also persist cardWidths**

In `saveConfig()`, add `cardWidths` to the body:

```js
            cardWidths: appConfig.cardWidths || {},
```

- [ ] **Step 5: Commit**

```bash
git add dashboard.html
git commit -m "feat: add per-card grid width selector with persistence"
```

---

### Task 5: Wire up applyGridLayout on page load and poll

**Files:**
- Modify: `dashboard.html`

- [ ] **Step 1: Call applyGridLayout on init**

At the bottom of the script, after `loadConfigWithoutModal()`, add:

```js
    applyGridLayout();
```

- [ ] **Step 2: Verify the full flow**

The page should:
1. Load config from server (including layoutGrid and cardWidths)
2. Call `applyGridLayout()` to set up the grid
3. Each card shows in its configured column span
4. Clicking ⊞ on any card opens the popover
5. Changing the width and clicking "确定" updates the layout and saves to server
6. Changing the overall "布局栅格" in settings and saving updates all cards

- [ ] **Step 3: Commit**

```bash
git add dashboard.html
git commit -m "feat: wire up grid layout on page load"
```
