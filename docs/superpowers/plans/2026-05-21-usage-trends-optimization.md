# 用量趋势优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add daily request curve (with second Y-axis), combined tokens 7-day SMA, and request count 7-day SMA to the existing usage trends chart.

**Architecture:** All changes in `dashboard.html` — add SMA helper function, extend Chart.js config with `y1` axis + 3 new datasets, update `updateUI()` to compute SMAs.

**Tech Stack:** Chart.js v4.4.1, vanilla JS

---

### Task 1: Add SMA helper function and chart config (3 new datasets + y1 axis)

**Files:**
- Modify: `dashboard.html` — add `sma()` function near other helpers
- Modify: `dashboard.html:543-575` — extend chart init with 3 new datasets and `y1` scale

- [ ] **Step 1: Add `sma()` helper function**

Insert before `fetchWeeklyTrend()` (after line ~686):

```javascript
    function sma(arr, window) {
      return arr.map((_, i) => {
        const start = Math.max(0, i - window + 1);
        const slice = arr.slice(start, i + 1);
        return slice.reduce((a, b) => a + b, 0) / slice.length;
      });
    }
```

- [ ] **Step 2: Extend `weeklyTrendChart` datasets in initCharts()**

Replace the datasets array (lines 548-565) to add 3 new datasets:

```javascript
          datasets: [
            {
              label: 'Prompt Tokens',
              data: [],
              borderColor: 'rgba(59, 130, 246, 1)',
              backgroundColor: 'rgba(59, 130, 246, 0.1)',
              fill: true,
              tension: 0.3,
              yAxisID: 'y'
            },
            {
              label: 'Completion Tokens',
              data: [],
              borderColor: 'rgba(34, 197, 94, 1)',
              backgroundColor: 'rgba(34, 197, 94, 0.1)',
              fill: true,
              tension: 0.3,
              yAxisID: 'y'
            },
            {
              label: '综合用量 7日均',
              data: [],
              borderColor: 'rgba(168, 85, 247, 1)',
              backgroundColor: 'rgba(168, 85, 247, 0.05)',
              borderDash: [5, 5],
              borderWidth: 2,
              pointRadius: 0,
              fill: false,
              tension: 0.3,
              yAxisID: 'y'
            },
            {
              label: 'Requests',
              data: [],
              borderColor: 'rgba(249, 115, 22, 1)',
              backgroundColor: 'rgba(249, 115, 22, 0.1)',
              borderWidth: 2,
              pointRadius: 2,
              fill: false,
              tension: 0.3,
              yAxisID: 'y1'
            },
            {
              label: '请求数 7日均',
              data: [],
              borderColor: 'rgba(251, 146, 60, 1)',
              backgroundColor: 'rgba(251, 146, 60, 0.05)',
              borderDash: [5, 5],
              borderWidth: 2,
              pointRadius: 0,
              fill: false,
              tension: 0.3,
              yAxisID: 'y1'
            }
          ]
```

- [ ] **Step 3: Add `y1` (right axis) to the scales config**

Replace the `scales` block (lines 570-573) to add the second Y-axis:

```javascript
          scales: {
            y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.1)' }, ticks: { color: '#9ca3af', callback: v => formatNumber(v) } },
            y1: { beginAtZero: true, position: 'right', grid: { display: false }, ticks: { color: '#9ca3af', callback: v => formatNumber(v) } },
            x: { grid: { display: false }, ticks: { color: '#9ca3af' } }
          }
```

---

### Task 2: Update `updateUI()` to compute SMAs and populate all datasets

**Files:**
- Modify: `dashboard.html:758-765` — update weekly trend chart update block

- [ ] **Step 1: Replace the weekly trend chart update block**

Replace lines 758-765 with:

```javascript
      // Update weekly trend chart
      const weeklyData = await fetchWeeklyTrend();
      if (weeklyData.length > 0 && weeklyTrendChart) {
        const promptTokens = weeklyData.map(d => d.promptTokens);
        const completionTokens = weeklyData.map(d => d.completionTokens);
        const requests = weeklyData.map(d => d.requests);
        const combinedTokens = weeklyData.map(d => d.tokens);

        weeklyTrendChart.data.labels = weeklyData.map(d => d.label);
        weeklyTrendChart.data.datasets[0].data = promptTokens;
        weeklyTrendChart.data.datasets[1].data = completionTokens;
        weeklyTrendChart.data.datasets[2].data = sma(combinedTokens, 7);
        weeklyTrendChart.data.datasets[3].data = requests;
        weeklyTrendChart.data.datasets[4].data = sma(requests, 7);
        weeklyTrendChart.update('none');
      }
```

---

### Task 3: Verify the changes

- [ ] **Step 1: Check for syntax errors**

Run: `node -e "const fs=require('fs');const html=fs.readFileSync('dashboard.html','utf8');const js=html.match(/<script>([\s\S]*?)<\/script>/)[1];try{new Function(js.split('').filter(c=>c!=='
').join(''));console.log('JS syntax OK')}catch(e){console.log('Syntax error:',e.message)}"`

(Or just open in browser and check console.)

- [ ] **Step 2: Visual verification**
- Open `dashboard.html` in browser
- Confirm chart shows 5 datasets with legend
- Confirm right Y-axis appears with request counts
- Confirm dashed lines for SMAs
- Confirm data refreshes on polling
