# Layout Grid Optimization Design

## Overview
Allow users to configure the number of grid columns on the dashboard and set individual card widths, with persistence to server config.

## Backend Changes

### Config Schema (`proxy/config.json`)
- Add `layoutGrid`: number, default `6`, defines the uniform grid column count
- Add `cardWidths`: `{ [cardId: string]: number }`, stores per-card column span (1 ~ layoutGrid)

### API Changes (`/api/config`)
- **GET**: return `layoutGrid` and `cardWidths` fields
- **POST**: accept and save `layoutGrid` and `cardWidths` fields

## Frontend Changes

### Config Modal
- Add a "布局栅格" number input, default `6`, min `1`

### Grid Layout
- Unify all card sections (stats, charts, tables, cost trend, logs) into a single CSS grid
- Grid uses `style="grid-template-columns: repeat(N, 1fr)"` with N = layoutGrid value
- Each card uses `style="grid-column: span X"` where X is the card's configured width (default `1` or a sensible per-card default)

### Card Width Selector
- Each card in the grid gets a grid-icon button (⊞) in the top-right corner (next to card title)
- Click opens a small popover with a number input (min 1, max = layoutGrid)
- Changing the value updates the card width in real-time and saves to server via POST `/api/config`

### Card ID Mapping
Each card needs a stable identifier for `cardWidths`:
| Card | ID | Default Width |
|---|---|---|
| 当日请求 | `today-requests` | 2 |
| 资源监控 | `resource-monitor` | 2 |
| 实时请求 | `container-logs` | 3 |
| 用量趋势 | `trend-chart` | 1 |
| 24小时请求分布 | `hourly-chart` | 1 |
| KEY用量 | `apikey-table` | 1 |
| 模型用量 | `model-table` | 1 |
| 模型性能 | `model-performance` | 1 |
| 成本趋势 | `cost-trend` | 1 |
| 日志 | `logs-section` | 1 |

## Implementation Order
1. Add `layoutGrid` and `cardWidths` to server config endpoint
2. Update frontend config modal with "布局栅格" input
3. Unify grid container and convert cards to ID-based dynamic spans
4. Add per-card width selector button/popover
5. Wire up save-to-server on width change
