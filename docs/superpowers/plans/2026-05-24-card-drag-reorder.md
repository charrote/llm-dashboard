# Card Drag-and-Drop Reorder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow long-press (mobile) / direct-drag (desktop) on dashboard card headers to reorder cards, with position persisted to server config.

**Architecture:** Two-file change: `proxy/server.js` (add `cardOrder` to config API) + `dashboard.html` (SortableJS integration, card header handle, persistence logic). SortableJS loaded from CDN — same pattern as existing Tailwind/Chart.js dependencies.

**Tech Stack:** Express.js, vanilla JS, Tailwind CSS (CDN), Chart.js (CDN), SortableJS (CDN)

---

### Task 1: Add cardOrder to server config

**Files:**
- Modify: `proxy/server.js:29-30` (defaults)
- Modify: `proxy/server.js:1005-1007` (GET /api/config)
- Modify: `proxy/server.js:1012` (POST destructure)
- Modify: `proxy/server.js:1021` (POST condition)
- Modify: `proxy/server.js:1031-1032` (POST body handling)

- [ ] **Step 1: Add cardOrder default**

Edit `proxy/server.js` after line 30 (`config.cardWidths = config.cardWidths || {};`):

```js
config.cardOrder = config.cardOrder || [];
```

- [ ] **Step 2: Add cardOrder to GET /api/config response**

Edit `proxy/server.js` GET handler to add `cardOrder` after `cardWidths`:

```js
     cardWidths: config.cardWidths || {},
     cardOrder: config.cardOrder || []
```

- [ ] **Step 3: Add cardOrder to POST destructure**

Update the destructuring on line 1012 — add `cardOrder`:

```js
  const { lmStudioContainer, lmStudioPort, lmStudioUrl: url, defaultAPIKey, enableAPIKey, enableLog, lmAuthEnabled, lmAuthValue, simCostEnabled, simPromptCost, simCompletionCost, trendDays, layoutGrid, cardWidths, cardOrder } = req.body;
```

- [ ] **Step 4: Add cardOrder to POST condition and handling**

Update the condition on line 1021 — add `cardOrder`:

Change:
```js
|| layoutGrid !== undefined || cardWidths !== undefined) {
```
To:
```js
|| layoutGrid !== undefined || cardWidths !== undefined || cardOrder !== undefined) {
```

After the existing `if (cardWidths !== undefined) config.cardWidths = cardWidths;` (line 1032), add:

```js
    if (cardOrder !== undefined) config.cardOrder = cardOrder;
```

- [ ] **Step 5: Verify server starts**

Run: `node proxy/server.js`
Expected: starts without errors, no crash. Ctrl+C to stop.

- [ ] **Step 6: Commit**

```bash
git add proxy/server.js
git commit -m "feat: add cardOrder to server config API"
```

---

### Task 2: Add SortableJS CDN and `.card-header` classes to dashboard.html

**Files:**
- Modify: `dashboard.html`

- [ ] **Step 1: Add SortableJS CDN script tag**

In `dashboard.html`, after line 8 (Chart.js script tag), add:

```html
  <script src="https://cdn.jsdelivr.net/npm/sortablejs@1.15.6/Sortable.min.js"></script>
```

- [ ] **Step 2: Add cursor-grab CSS**

In the existing `<style>` block (after line 15), add:

```css
    .card-header { cursor: grab; }
    .card-header:active { cursor: grabbing; }
```

Using classes instead of Tailwind utilities to avoid Tailwind CDN purge stripping.

- [ ] **Step 3: Add `.card-header` class to all 10 card header divs**

Each card currently has a header like:
```html
        <div class="flex items-center justify-between mb-4">
```

Change every one of these 10 occurrences to:
```html
        <div class="card-header flex items-center justify-between mb-4">
```

The 10 card headers to modify (lines 293, 326, 385, 396, 403, 411, 434, 456, 481, 493):

1. `today-requests` (line 293): `<div class="flex items-center justify-between mb-4">`
2. `resource-monitor` (line 326): `<div class="flex items-center justify-between mb-4">`
3. `container-logs` (line 385): `<div class="flex items-center justify-between mb-4">`
4. `trend-chart` (line 396): `<div class="flex items-center justify-between mb-4">`
5. `hourly-chart` (line 403): `<div class="flex items-center justify-between mb-4">`
6. `apikey-table` (line 411): `<div class="flex items-center justify-between mb-4">`
7. `model-table` (line 434): `<div class="flex items-center justify-between mb-4">`
8. `model-performance` (line 456): `<div class="flex items-center justify-between mb-4">`
9. `cost-trend` (line 481): `<div class="flex items-center justify-between mb-4">`
10. `logs-section` (line 493): `<div class="flex items-center justify-between mb-4">`

Each gets the class `card-header` added: `class="card-header flex items-center justify-between mb-4"`.

- [ ] **Step 4: Commit**

```bash
git add dashboard.html
git commit -m "feat: add SortableJS CDN and card-header handle classes"
```

---

### Task 3: Implement Sortable initialization and save logic

**Files:**
- Modify: `dashboard.html`

- [ ] **Step 1: Add cardOrder to appConfig default**

In `dashboard.html` line 546, update the `appConfig` declaration:

Change:
```js
    let appConfig = { simCostEnabled: false, simPromptCost: 0, simCompletionCost: 0, trendDays: 30, layoutGrid: 6, cardWidths: {} };
```
To:
```js
    let appConfig = { simCostEnabled: false, simPromptCost: 0, simCompletionCost: 0, trendDays: 30, layoutGrid: 6, cardWidths: {}, cardOrder: [] };
```

- [ ] **Step 2: Add DOM reorder logic to loadConfigWithoutModal**

In `loadConfigWithoutModal()`, after the `applyGridLayout();` call (line 1316), add reorder logic before `applyGridLayout()` — it needs to run BEFORE `applyGridLayout()` so the grid is laid out in the correct order:

```js
        if (data.cardOrder && data.cardOrder.length) {
          const grid = document.getElementById('cardsGrid');
          data.cardOrder.forEach(id => {
            const el = grid.querySelector(`[data-card-id="${id}"]`);
            if (el) grid.appendChild(el);
          });
        }
        appConfig.cardOrder = data.cardOrder || [];
```

So the full `loadConfigWithoutModal` becomes:

```js
    async function loadConfigWithoutModal() {
      try {
        const response = await fetch(`${API_BASE}/config`);
        const data = await response.json();
        appConfig = {
          simCostEnabled: data.simCostEnabled || false,
          simPromptCost: data.simPromptCost || 0,
          simCompletionCost: data.simCompletionCost || 0,
          trendDays: data.trendDays || 30,
          layoutGrid: data.layoutGrid || 6,
          cardWidths: data.cardWidths || {},
          cardOrder: data.cardOrder || []
        };
        if (data.cardOrder && data.cardOrder.length) {
          const grid = document.getElementById('cardsGrid');
          data.cardOrder.forEach(id => {
            const el = grid.querySelector(`[data-card-id="${id}"]`);
            if (el) grid.appendChild(el);
          });
        }
        applyGridLayout();
      } catch (error) {
        console.error('Load config error:', error);
      }
    }
```

- [ ] **Step 3: Add cardOrder to loadConfig (for consistency)**

In `loadConfig()`, before `closeConfig()` or at any point after `appConfig` is set, add:

After line 1289 (`cardWidths: data.cardWidths || {}`), add:
```js
          cardOrder: data.cardOrder || []
```

So the full appConfig block in `loadConfig` becomes:
```js
        appConfig = {
          simCostEnabled: data.simCostEnabled || false,
          simPromptCost: data.simPromptCost || 0,
          simCompletionCost: data.simCompletionCost || 0,
          trendDays: data.trendDays || 30,
          layoutGrid: data.layoutGrid || 6,
          cardWidths: data.cardWidths || {},
          cardOrder: data.cardOrder || []
        };
```

- [ ] **Step 4: Add saveCardOrder function and initialize Sortable**

Before `initCharts();` (line 2030), add the Sortable initialization and save function:

```js
    let sortableInstance = null;

    function initSortable() {
      if (sortableInstance) sortableInstance.destroy();
      sortableInstance = new Sortable(document.getElementById('cardsGrid'), {
        animation: 200,
        delay: 300,
        delayOnTouchOnly: true,
        handle: '.card-header',
        onEnd: saveCardOrder
      });
    }

    async function saveCardOrder() {
      const order = Array.from(document.querySelectorAll('[data-card-id]'))
        .map(el => el.dataset.cardId);
      appConfig.cardOrder = order;
      try {
        await fetch(`${API_BASE}/config`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cardOrder: order })
        });
      } catch (e) {
        console.error('Save card order error:', e);
      }
    }
```

- [ ] **Step 5: Wire up initSortable call**

After line 2031 (`loadConfigWithoutModal();`), add:
```js
    initSortable();
```

The bottom of the script block should now look like:
```js
    initCharts();
    loadConfigWithoutModal();
    initSortable();
    poll();
    setInterval(poll, 2000);
    setInterval(() => fetchContainerLogs().then(updateContainerLogs), 500);
```

- [ ] **Step 6: Commit**

```bash
git add dashboard.html
git commit -m "feat: implement card drag-reorder with SortableJS and persistence"
```

---

### Task 4: Verify full flow

- [ ] **Step 1: Start the server**

Run: `node proxy/server.js`

Expected: server starts on port 3000 (or configured port)

- [ ] **Step 2: Open the dashboard**

Open `http://localhost:3000` in a browser.

Verify:
- Dashboard loads with all cards displayed
- Cards are in the default HTML order initially
- Hovering over any card header shows grab cursor
- Dragging a card by its header reorders it
- Release triggers position save (check server console for no errors)

- [ ] **Step 3: Verify persistence**

- Drag a card to a new position
- Reload the page
- Verify the card stays in the dragged position

- [ ] **Step 4: Verify mobile long-press**

- Open Chrome DevTools → Toggle Device Toolbar (Ctrl+Shift+M)
- Select a mobile device preset
- Long-press (hold ~300ms) on a card header
- Verify drag starts only after the delay, not on immediate touch

- [ ] **Step 5: Verify card width popover still works**

- Click the ⊞ button on any card
- Verify card width popover opens and works correctly
- The ⊞ button is inside `.card-header` but SortableJS's `handle` selector with `.card-header` should conflict — verify it doesn't block the popover button

Actually, Step 5 is critical: the ⊞ button is inside the `.card-header` div. SortableJS with `handle: '.card-header'` means dragging anywhere on `.card-header` initiates a drag. This will conflict with the ⊞ button click. We need to exclude the ⊞ button from the handle.

**Fix for Step 2 in the plan — we need to add a `filter` option or use a nested handle approach:**

In the Sortable initialization, add:
```js
        filter: '.card-header button',
        preventOnFilter: false,
```

This excludes the ⊞ button from triggering drag while still allowing clicks on it.

So the Sortable options become:
```js
      sortableInstance = new Sortable(document.getElementById('cardsGrid'), {
        animation: 200,
        delay: 300,
        delayOnTouchOnly: true,
        handle: '.card-header',
        filter: '.card-header button',
        preventOnFilter: false,
        onEnd: saveCardOrder
      });
```

- [ ] **Step 6: Re-verify card width popover**

After the fix:
- Click the ⊞ button — popover should open (drag not triggered)
- Drag by the header text area — drag should start
- No interference between the two actions

- [ ] **Step 7: Commit the fix**

```bash
git add dashboard.html
git commit -m "fix: exclude ⊞ button from sortable handle to allow popover clicks"
```
