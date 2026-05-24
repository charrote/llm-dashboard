# Cost Trend Configurable Days Design

## Goal
Make the cost trend chart's data period (currently hardcoded 30 days) configurable via the settings modal.

## Changes

### config.json
Add `trendDays: 30` (default).

### proxy/server.js
- `/api/weekly-trend`: read `config.trendDays` (default 30) for loop bound instead of hardcoded `29`
- `/api/config` GET: include `trendDays` in response
- `/api/config` POST: read and save `trendDays`

### dashboard.html
- `appConfig` defaults: add `trendDays: 30`
- Settings modal: add a number input "成本趋势天数" with min=1, placed in the cost section
- `updateUI()`: replace `Array(30).fill(avg)` with `Array(weeklyData.length).fill(avg)` (derive from actual data)
- Config save handler: include `trendDays`

## Data Flow
```
Settings input → POST /api/config (trendDays=N) → config.json updated
                                                        ↓
fetchWeeklyTrend() → GET /api/weekly-trend  →  loop N days → return N data points
                                                        ↓
updateUI() → render chart with N labels, N costs, N-length avg line
```

## Files Modified
| File | What |
|---|---|
| `proxy/config.json` | Add `trendDays` field |
| `proxy/server.js` | Server reads config for loop count |
| `dashboard.html` | Settings UI + dynamic chart sizing |
