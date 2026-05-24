# Card Drag-and-Drop Reorder Design

## Overview
Allow users to long-press on any dashboard card header to trigger drag mode, then drag the card to a new position in the grid. The card order is persisted to the server so it survives page reloads.

## Backend Changes

### Config Schema (`proxy/config.json`)
- Add `cardOrder`: `string[]` — ordered list of `data-card-id` values, e.g. `["today-requests", "cost-trend", "logs-section", ...]`

### API Changes (`/api/config`)
- **GET**: return `cardOrder` field
- **POST**: accept and save `cardOrder` field
- On first load or if `cardOrder` is absent/empty, the frontend defaults to the DOM's current element order

## Frontend Changes

### CDN Dependency
Add SortableJS to `<head>` (consistent with existing CDN pattern for Tailwind + Chart.js):
```html
<script src="https://cdn.jsdelivr.net/npm/sortablejs@1.15.6/Sortable.min.js"></script>
```

### Card Header Handle
Each card's header `<div>` gets class `card-header` with cursor styling. The existing structure already has `flex items-center justify-between` in each card header — only need to add the class:
```html
<div class="card-header flex items-center justify-between mb-4 cursor-grab active:cursor-grabbing">
```

This is a targeted change: the 10 card headers are equivalent already, just need the class + cursor styles added.

### Sortable Initialization
After `loadConfigWithoutModal()` completes (and after cards are reordered if `cardOrder` exists), initialize Sortable:

```js
let sortable = new Sortable(document.getElementById('cardsGrid'), {
  animation: 200,
  delay: 300,
  delayOnTouchOnly: true,
  handle: '.card-header',
  onEnd: saveCardOrder
});
```

- `animation: 200` — smooth 200ms transition
- `delay: 300` + `delayOnTouchOnly: true` — mobile long-press 300ms to initiate drag; desktop drags work immediately
- `handle: '.card-header'` — only the header area triggers drag

The Sortable instance is stored in a variable so it can be destroyed and re-created if needed (e.g., if grid is re-laid-out).

### Position Persistence

**On drag end:**
```js
async function saveCardOrder() {
  const order = Array.from(document.querySelectorAll('[data-card-id]'))
    .map(el => el.dataset.cardId);
  appConfig.cardOrder = order;
  await fetch(`${API_BASE}/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cardOrder: order })
  });
}
```

**On page load** (in `loadConfigWithoutModal()`):
```js
if (data.cardOrder && data.cardOrder.length) {
  const grid = document.getElementById('cardsGrid');
  data.cardOrder.forEach(id => {
    const el = grid.querySelector(`[data-card-id="${id}"]`);
    if (el) grid.appendChild(el);
  });
}
```

`appendChild` on an already-mounted element automatically moves it, so this reorders DOM nodes to match the saved order without any remove/re-add.

### Load Flow
1. Page loads → `loadConfigWithoutModal()` fetches config
2. If `cardOrder` exists, reorder DOM to match
3. `applyGridLayout()` runs (existing)
4. Sortable initialized on `#cardsGrid`

### Visual Feedback
- `.cursor-grab` on `.card-header` shows grab cursor on hover
- `.active:cursor-grabbing` shows grabbing cursor while dragging
- SortableJS provides a semi-transparent clone while dragging
- The dragged element gets `opacity: 0` at original position (SortableJS default)

## No Other Changes
- No new UI elements (the header itself is the handle)
- No config modal changes
- No new API endpoints (reuses existing `/api/config`)

## Implementation Order
1. Add `cardOrder` to server config schema and API (GET + POST)
2. Add SortableJS CDN script to `dashboard.html`
3. Add `.card-header` class + cursor styles to all 10 card headers
4. Initialize Sortable after page load
5. Implement `saveCardOrder()` callback on sort end
6. Implement DOM reorder on page load from saved `cardOrder`
7. Test full flow: drag → save → reload → position restored
