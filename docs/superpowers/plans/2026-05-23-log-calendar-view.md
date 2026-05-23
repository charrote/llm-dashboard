# Log Calendar View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the daily-card list in the "历史日志" modal with a monthly calendar view with month navigation, monthly summary, and auto-height.

**Architecture:** Single file change to `dashboard.html`. Modal HTML gets new nav/summary elements; JS gets `renderCalendar()`, month navigation handlers, and monthly summary calculation. Detail view (`loadLogDetail`) stays unchanged.

**Tech Stack:** Vanilla JS, Tailwind CSS (already in use)

**Files:**
- Modify: `/home/uantek/dev/Applications/lmstudio-dashboard/dashboard.html`

---

### Task 1: Update modal HTML — month nav, summary row, calendar container

**Files:**
- Modify: `dashboard.html:212-230`

- [ ] **Step 1: Read current modal HTML**

Read lines 212-230 of dashboard.html to see exact current structure.

- [ ] **Step 2: Replace modal body HTML**

Current:
```html
<div id="logsModal" class="fixed inset-0 bg-black/50 hidden items-center justify-center z-50">
  <div class="bg-gray-800 rounded-xl p-6 w-[90vw] max-w-4xl max-h-[85vh] flex flex-col">
    <div class="flex items-center justify-between mb-4">
      <h2 class="text-xl font-bold">历史日志</h2>
      <button onclick="closeLogs()" class="text-gray-400 hover:text-white text-2xl">&times;</button>
    </div>
    <div id="logsList" class="grid grid-cols-7 gap-2 mb-4 max-h-[200px] overflow-y-auto scrollbar-thin">
      <div class="text-gray-500 text-center py-4 col-span-7">加载中...</div>
    </div>
    <div id="logDetail" class="flex-1 overflow-hidden hidden">
      <div class="flex items-center justify-between mb-2">
        <h3 id="logDetailTitle" class="text-lg font-semibold"></h3>
        <button onclick="closeLogDetail()" class="text-sm text-gray-400 hover:text-white">返回列表</button>
      </div>
      <div id="logStats" class="grid grid-cols-4 gap-4 mb-4 p-4 bg-gray-700/50 rounded-lg"></div>
      <div id="logRequests" class="font-mono text-xs space-y-1 max-h-[300px] overflow-y-auto scrollbar-thin"></div>
    </div>
  </div>
</div>
```

Replace with:
```html
<div id="logsModal" class="fixed inset-0 bg-black/50 hidden items-center justify-center z-50">
  <div class="bg-gray-800 rounded-xl p-6 w-[90vw] max-w-4xl max-h-[85vh] flex flex-col">
    <div class="flex items-center justify-between mb-4">
      <h2 class="text-xl font-bold">历史日志</h2>
      <button onclick="closeLogs()" class="text-gray-400 hover:text-white text-2xl">&times;</button>
    </div>
    <!-- Month Navigation -->
    <div id="logCalendarNav" class="flex items-center justify-between mb-2">
      <div class="flex items-center gap-2">
        <button onclick="changeMonth(-1)" class="px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded text-sm transition">&larr;</button>
        <span id="currentMonthLabel" class="text-lg font-semibold min-w-[130px] text-center"></span>
        <button onclick="changeMonth(1)" class="px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded text-sm transition">&rarr;</button>
      </div>
      <select id="monthSelector" class="bg-gray-700 text-sm rounded px-2 py-1 border border-gray-600" onchange="jumpToMonth(this.value)"></select>
    </div>
    <!-- Monthly Summary -->
    <div id="monthlySummary" class="grid grid-cols-4 gap-4 mb-3 p-3 bg-gray-700/30 rounded-lg text-sm">
      <div><span class="text-gray-400">累计请求</span><span id="monthRequests" class="ml-2 text-white font-bold">0</span></div>
      <div><span class="text-gray-400">累计Tokens</span><span id="monthTokens" class="ml-2 text-blue-400 font-bold">0</span></div>
      <div><span class="text-gray-400">累计费用</span><span id="monthCost" class="ml-2 text-green-400 font-bold">¥0.00</span></div>
      <div><span class="text-gray-400">错误率</span><span id="monthErrorRate" class="ml-2 text-red-400 font-bold">0%</span></div>
    </div>
    <!-- Weekday Header -->
    <div id="weekdayHeader" class="grid grid-cols-7 gap-1 mb-1 text-xs text-gray-500 text-center"></div>
    <!-- Calendar Grid -->
    <div id="logsCalendar" class="grid grid-cols-7 gap-1 flex-1"></div>
    <!-- Detail View (unchanged) -->
    <div id="logDetail" class="flex-1 overflow-hidden hidden">
      <div class="flex items-center justify-between mb-2">
        <h3 id="logDetailTitle" class="text-lg font-semibold"></h3>
        <button onclick="closeLogDetail()" class="text-sm text-gray-400 hover:text-white">返回列表</button>
      </div>
      <div id="logStats" class="grid grid-cols-4 gap-4 mb-4 p-4 bg-gray-700/50 rounded-lg"></div>
      <div id="logRequests" class="font-mono text-xs space-y-1 max-h-[300px] overflow-y-auto scrollbar-thin"></div>
    </div>
  </div>
</div>
```

Note: `#logsList` is replaced by `#logsCalendar` + `#weekdayHeader` + `#logCalendarNav` + `#monthlySummary`.

- [ ] **Step 3: Verify HTML**

Read the modified section to confirm the HTML structure is correct.

---

### Task 2: Implement calendar rendering JS

**Files:**
- Modify: `dashboard.html` (after line 1516, or replace existing `loadLogsList`)

- [ ] **Step 1: Read current JS functions to understand what to change**

Read the current `openLogs()`, `loadLogsList()`, `loadLogDetail()` functions.

- [ ] **Step 2: Replace `openLogs()` and `loadLogsList()` with calendar logic**

Current `openLogs()`:
```js
async function openLogs() {
  document.getElementById('logsModal').classList.remove('hidden');
  document.getElementById('logsModal').classList.add('flex');
  document.getElementById('logDetail').classList.add('hidden');
  document.getElementById('logsList').classList.remove('hidden');
  await loadLogsList();
}
```

Replace with:
```js
let calendarLogs = [];
let calendarYear, calendarMonth;
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

async function openLogs() {
  document.getElementById('logsModal').classList.remove('hidden');
  document.getElementById('logsModal').classList.add('flex');
  document.getElementById('logDetail').classList.add('hidden');
  document.getElementById('logsCalendar').classList.remove('hidden');
  document.getElementById('logCalendarNav').classList.remove('hidden');
  document.getElementById('monthlySummary').classList.remove('hidden');
  document.getElementById('weekdayHeader').classList.remove('hidden');
  const now = new Date();
  calendarYear = now.getFullYear();
  calendarMonth = now.getMonth(); // 0-indexed
  await loadCalendarData();
}

async function loadCalendarData() {
  try {
    const response = await fetch(`${API_BASE}/logs`);
    calendarLogs = await response.json();
  } catch (e) {
    calendarLogs = [];
  }
  renderCalendar(calendarYear, calendarMonth);
}

function renderCalendar(year, month) {
  const calendarEl = document.getElementById('logsCalendar');
  const navLabel = document.getElementById('currentMonthLabel');
  const selector = document.getElementById('monthSelector');

  navLabel.textContent = `${year}年${month + 1}月`;

  // Update dropdown
  const currentVal = `${year}-${String(month + 1).padStart(2, '0')}`;
  if (selector.value !== currentVal) {
    selector.value = currentVal;
  }

  // Render weekday header
  const weekdayEl = document.getElementById('weekdayHeader');
  weekdayEl.innerHTML = WEEKDAYS.map(d => `<div class="py-1">${d}</div>`).join('');

  // Filter logs for this month
  const prefix = `${year}${String(month + 1).padStart(2, '0')}`;
  const monthLogs = calendarLogs.filter(log => log.date.startsWith(prefix));

  // Compute monthly summary
  updateMonthlySummary(monthLogs);

  // Build calendar grid
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = new Date();
  const todayStr = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;

  const cells = [];

  // Empty cells before first day
  for (let i = 0; i < firstDay; i++) {
    cells.push('<div class="aspect-square"></div>');
  }

  // Day cells
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${prefix}${String(d).padStart(2, '0')}`;
    const log = monthLogs.find(l => l.date === dateStr);
    const isToday = dateStr === todayStr;

    if (log) {
      const totalTokens = typeof log.totalTokens === 'object' && log.totalTokens !== null
        ? (log.totalTokens.prompt || 0) + (log.totalTokens.completion || 0)
        : (log.totalTokens || 0);
      const costText = log.cost > 0 ? `¥${log.cost.toFixed(2)}` : '';
      const errorText = log.errors > 0 ? `${log.errors}err` : '';
      cells.push(`
        <button onclick="loadLogDetail('${log.date}')"
          class="bg-gray-700/50 hover:bg-gray-600 rounded p-1 text-xs text-left transition flex flex-col ${isToday ? 'ring-2 ring-blue-500' : ''}">
          <span class="text-gray-400 font-medium">${d}</span>
          <span class="text-white font-bold text-sm">${formatNumber(log.requests)}</span>
          <span class="text-gray-500 truncate">${formatNumber(totalTokens)}</span>
          ${costText ? `<span class="text-green-400 truncate">${costText}</span>` : ''}
          ${errorText ? `<span class="text-red-400 truncate">${errorText}</span>` : ''}
        </button>
      `);
    } else {
      cells.push(`
        <div class="bg-gray-800/30 rounded p-1 text-xs text-gray-600 flex flex-col ${isToday ? 'ring-1 ring-gray-600' : ''}">
          <span class="font-medium">${d}</span>
          <span class="mt-1">无数据</span>
        </div>
      `);
    }
  }

  calendarEl.innerHTML = cells.join('');
}
```

- [ ] **Step 3: Add `changeMonth()`, `jumpToMonth()`, `initMonthSelector()`, `updateMonthlySummary()` functions**

```js
function changeMonth(delta) {
  calendarMonth += delta;
  if (calendarMonth > 11) {
    calendarMonth = 0;
    calendarYear++;
  } else if (calendarMonth < 0) {
    calendarMonth = 11;
    calendarYear--;
  }
  renderCalendar(calendarYear, calendarMonth);
}

function jumpToMonth(val) {
  const parts = val.split('-');
  calendarYear = parseInt(parts[0]);
  calendarMonth = parseInt(parts[1]) - 1;
  renderCalendar(calendarYear, calendarMonth);
}

function initMonthSelector() {
  const selector = document.getElementById('monthSelector');
  const currentYear = new Date().getFullYear();
  const options = [];
  for (let y = currentYear - 1; y <= currentYear + 1; y++) {
    for (let m = 1; m <= 12; m++) {
      const val = `${y}-${String(m).padStart(2, '0')}`;
      const label = `${y}年${m}月`;
      options.push(`<option value="${val}">${label}</option>`);
    }
  }
  selector.innerHTML = options.join('');
}

function updateMonthlySummary(monthLogs) {
  if (monthLogs.length === 0) {
    document.getElementById('monthRequests').textContent = '0';
    document.getElementById('monthTokens').textContent = '0';
    document.getElementById('monthCost').textContent = '¥0.00';
    document.getElementById('monthErrorRate').textContent = '0%';
    return;
  }
  const totalRequests = monthLogs.reduce((s, l) => s + (l.requests || 0), 0);
  const totalTokens = monthLogs.reduce((s, l) => {
    const t = l.totalTokens;
    if (typeof t === 'object' && t !== null) return s + (t.prompt || 0) + (t.completion || 0);
    return s + (t || 0);
  }, 0);
  const totalCost = monthLogs.reduce((s, l) => s + (l.cost || 0), 0);
  const totalErrors = monthLogs.reduce((s, l) => s + (l.errors || 0), 0);
  const errorRate = totalRequests > 0 ? ((totalErrors / totalRequests) * 100).toFixed(1) : '0';

  document.getElementById('monthRequests').textContent = formatNumber(totalRequests);
  document.getElementById('monthTokens').textContent = formatNumber(totalTokens);
  document.getElementById('monthCost').textContent = `¥${totalCost.toFixed(2)}`;
  document.getElementById('monthErrorRate').textContent = `${errorRate}%`;
}
```

- [ ] **Step 4: Update `loadLogDetail()` to hide calendar elements instead of `logsList`**

In `loadLogDetail()`, change line 1470 from:
```js
const listDiv = document.getElementById('logsList');
```
to:
```js
const listDiv = null; // no longer used
```

Change lines 1506-1507 from:
```js
listDiv.classList.add('hidden');
detailDiv.classList.remove('hidden');
```
to:
```js
document.getElementById('logCalendarNav').classList.add('hidden');
document.getElementById('monthlySummary').classList.add('hidden');
document.getElementById('weekdayHeader').classList.add('hidden');
document.getElementById('logsCalendar').classList.add('hidden');
detailDiv.classList.remove('hidden');
```

- [ ] **Step 5: Update `closeLogDetail()` to show calendar instead of logsList**

```js
function closeLogDetail() {
  document.getElementById('logDetail').classList.add('hidden');
  document.getElementById('logCalendarNav').classList.remove('hidden');
  document.getElementById('monthlySummary').classList.remove('hidden');
  document.getElementById('weekdayHeader').classList.remove('hidden');
  document.getElementById('logsCalendar').classList.remove('hidden');
}
```

- [ ] **Step 5: Call `initMonthSelector()` inside `openLogs()` before `loadCalendarData()`**

Add `initMonthSelector();` inside `openLogs()`.

---

### Task 3: Clean up old code and verify

**Files:**
- Modify: `dashboard.html`

- [ ] **Step 1: Remove old `loadLogsList()` function**

Delete the entire `loadLogsList()` function body (lines ~1443-1466). It's replaced by `loadCalendarData()` + `renderCalendar()`.

- [ ] **Step 2: Verify no dangling references**

Search for references to `logsList` (the old element id) in the HTML and JS. Replace any with `logsCalendar` as needed.

- [ ] **Step 3: Test the modal**

Open the dashboard in browser, click "查看日志", verify:
- Calendar shows current month
- Weekday headers correct (日一二三四五六)
- Days with data show requests/tokens/cost/errors
- Days without data show "无数据"
- Monthly summary shows correct totals
- Month nav arrows work
- Month dropdown works
- Click day with data → detail view opens
- "返回列表" → back to calendar
- Today highlighted
- Modal height auto-adjusts

- [ ] **Step 4: Rebuild Docker container**

```bash
docker compose down && docker compose up -d
```
