# 用量趋势图表优化设计

## 概述
在现有的"用量趋势"图表中增加日请求曲线、综合用量均线和请求数均线。

## 变更范围
- **只改前端**：`dashboard.html`
- **后端不变**：`/api/weekly-trend` 已返回 `requests`、`tokens` 字段

## 新增图表元素

| 元素 | 类型 | Y轴 | 颜色 | 样式 |
|------|------|-----|------|------|
| Requests（日请求数） | 折线图（无填充） | 右轴 `y1` | `rgba(249, 115, 22, 1)` 橙色 | 实线 |
| 综合用量 7日 SMA | 折线图（无填充） | 左轴 `y`（共用） | `rgba(168, 85, 247, 1)` 紫色 | 虚线 |
| 请求数 7日 SMA | 折线图（无填充） | 右轴 `y1`（共用） | `rgba(251, 146, 60, 1)` 浅橙 | 虚线 |

## 数据集顺序（共 5 个）
1. Prompt Tokens（保留，填充蓝色）
2. Completion Tokens（保留，填充绿色）
3. 综合用量 7日 SMA（新增，紫色虚线）
4. Requests（新增，橙色实线）
5. 请求数 7日 SMA（新增，浅橙虚线）

## 移动平均计算
- 函数 `sma(arr, window)`：对数组每个位置计算以该位置结尾的窗口平均值
- 前缀处理：前 `window-1` 个元素按实际长度平均（不跳过）
- 综合用量均线：对 `promptTokens + completionTokens`（即 API 返回的 `tokens`）做 SMA-7
- 请求数均线：对 `requests` 做 SMA-7

## 实现步骤
1. 在 `initCharts()` 中给 `weeklyTrendChart` 增加右轴 `y1` 配置
2. 在 `initCharts()` 中增加 3 个新 datasets（Requests, 综合均线, 请求均线），均线初始化为空
3. 实现 `sma()` 工具函数
4. 在 `updateUI()` 的用量趋势更新逻辑中计算均线并更新所有 5 个 datasets
5. 更新 `options.scales.y1` 的 ticks 格式化

## 样式规格
- `y1` 轴：位置 `right`，grid 不显示（避免重叠），ticks 颜色同 `y`
- 均线：`borderDash: [5, 5]`，`pointRadius: 0`，`borderWidth: 2`
- Requests 实线：`pointRadius: 2`，`borderWidth: 2`，`fill: false`
