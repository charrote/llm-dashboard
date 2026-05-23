# Log Calendar View Design

## Goal
Replace the current daily-card list in the existing "历史日志" modal with a monthly calendar view, keeping the same detail view on day click.

## Layout
```
┌──────────────────────────────────────────────┐
│ 历史日志                          [×]        │  ← existing modal header
├──────────────────────────────────────────────┤
│ ◄  2026年5月  ▼                  [× close]   │  ← month nav (arrows + dropdown)
├──────────────────────────────────────────────┤
│ 累计请求: 1,375 │ 累计Tokens: 85M            │  ← monthly summary row
│ 累计费用: ¥37.26 │ 错误率: 1.9%               │
├──────────────────────────────────────────────┤
│  日   一   二   三   四   五   六             │  ← weekday header
│        1    2    3    4    5    6             │
│  7    8    9   10   11   12   13              │  ← calendar grid
│  ...                                         │
│  25   26   27   28   29   30   31             │
└──────────────────────────────────────────────┘
```

## Details

### Month Navigation
- Left/right arrows (`◄` / `►`) change month by 1
- Month/year dropdown for jumping to any month
- Default: current month on open

### Monthly Summary Row
- 累计请求 — total requests for the month
- 累计Tokens — total prompt+completion tokens
- 累计费用 — total simulated cost, format `¥XX.XX`
- 错误率 — error rate as percentage

All computed from the daily log data for the displayed month.

### Calendar Grid
- 7 columns (Sun–Mon Chinese: 日一二三四五六)
- Grid layout fills available height (`flex-1`)
- Each day cell:
  - Date number in top-left or top-center
  - Day with data: shows requests count, tokens, cost, errors (same info as current card)
  - Day without data: centered "无数据" text
- Today's date highlighted (e.g., brighter border or background)
- Click day with data → open existing `loadLogDetail(date)` detail view
- Click day without data → no action

### Panel Height
- Calendar grid uses `flex-1` to fill remaining vertical space
- Modal body (`#logsList` container) grows naturally
- No fixed `max-h` on calendar grid; `.scrollbar-thin` removed if not needed

## Data Flow
- On modal open or month change:
  1. Fetch all `/api/logs` (already returns all dates)
  2. Client-side filter by year-month (`YYYYMM` prefix match)
  3. Compute monthly summary from filtered items
  4. Generate calendar grid: 6 weeks × 7 days, fill day cells with data
- Click day → existing `loadLogDetail(date)` unchanged

## Files Changed
- `dashboard.html` only:
  - Replace `#logsList` inner HTML rendering with calendar layout
  - Modify `loadLogsList()` → `loadLogCalendar(year, month)` or similar
  - Add month nav event handlers
  - Add monthly summary calculation
  - Keep `loadLogDetail()`, `closeLogDetail()`, `closeLogs()` unchanged

## What Stays the Same
- Modal open/close (`openLogs()`, `closeLogs()`)
- Detail view (`loadLogDetail()`, `closeLogDetail()`)
- All API endpoints (`/api/logs`, `/api/logs/:date`)
- Live log panel on main page unchanged

## Edge Cases
- Future months with no data: all cells show "无数据", summary shows all zeros
- Current month in progress: partial data reflects today
- Month with 31 days vs 30 vs 28/29: handled by JS Date
- Error fetching logs: show error message in calendar area
