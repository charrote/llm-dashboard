# LM Studio 监控仪表盘

LM Studio 请求代理与实时监控仪表盘。支持请求转发、API Key 管理、用量统计、GPU/CPU/内存资源监控。

## 快速开始

### Docker 部署（推荐）

```bash
# 构建并启动
docker compose up -d

# 访问 http://localhost:9234
```

构建时会自动安装 `docker-cli`，用于从容器内采集 GPU 数据。

### Windows 一键启动
双击运行 `启动仪表盘.bat`，自动启动代理服务并打开仪表盘。

### 手动启动

```bash
# 安装依赖
cd proxy && npm install

# 启动代理服务
npm start

# 访问 http://localhost:9234
```

## 配置

### LM Studio 地址
点击仪表盘右上角的 **设置** 按钮，配置 LM Studio 服务器地址并测试连接。

### API 客户端配置
将 AI 应用的 API Base URL 指向代理服务：

```
http://localhost:9234/v1
```

支持所有 OpenAI API 兼容客户端（Chatbox、NextChat、Open WebUI 等）。

### 资源监控配置
编辑 `proxy/config.json`，启用并配置资源监控：

```json
{
  "resourceMonitor": {
    "enabled": true,
    "dockerContainer": "llamacppserver-mtp-llama-server-1",
    "maxConcurrent": 4,
    "gpuModel": "Radeon 8060S (ROCm)"
  }
}
```

| 字段 | 说明 |
|------|------|
| `enabled` | 启用/禁用资源监控 |
| `dockerContainer` | LLM 服务容器名，用于采集 GPU 数据 |
| `maxConcurrent` | 最大并发请求数 |
| `gpuModel` | GPU 型号名（容器内无法自动检测时使用） |

> GPU 温度/功耗/负载通过 `docker exec` 读取容器内 sysfs，需要将宿主机 Docker socket 挂载到容器中（docker-compose.yml 已配置）。

## 仪表盘功能

### 统计卡片

| 卡片 | 说明 |
|------|------|
| 📊 **当日请求** | 总请求数、错误请求、Prompt/Completion Token 数量及模拟费用、平均延迟 |
| 📡 **实时请求** | 容器实时日志（500ms 轮询） |
| 🖥 **资源监控** | CPU 核数/负载、GPU 型号/负载/温度/功耗、系统内存用量 |

### 图表
- **用量趋势**: 30 天请求量/Avg Token 趋势图
- **24 小时分布**: 按小时统计请求分布
- **Token 使用比例**: Prompt / Completion Token 环形图

### 数据表格
- **API Key 统计**: 按 Key 分组的请求数、Token 消耗、错误次数
- **模型统计**: 各模型使用情况排行
- **模型性能**: TTFT、TPOT、TPS 等性能指标

### 实时日志
- **请求日志**: 滚动显示最近 100 条请求详情（状态码、模型、Token、延迟）
- **错误日志**: 集中显示异常请求，支持批量清除

## 文件结构

```
lmstudio-dashboard/
├── Dockerfile                  # Docker 镜像配置（含 docker-cli）
├── docker-compose.yml          # Docker Compose 配置
├── dashboard.html              # 前端仪表盘（单页应用）
├── apikey-search.html          # API Key 搜索页面
├── 启动仪表盘.bat              # Windows 一键启动脚本
├── proxy/
│   ├── server.js               # 代理服务器（Node.js/Express）
│   ├── config.json             # 服务器配置
│   ├── apikeys.json            # API 密钥存储
│   └── package.json            # 依赖
├── data/
│   ├── logs/                   # 历史请求日志（按日归档）
│   └── apikeys.json            # API 密钥数据
└── README.md
```

## API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/stats` | 实时统计数据 |
| GET | `/api/resource-monitor` | CPU/GPU/内存资源监控数据 |
| GET | `/api/weekly-trend` | 30 天趋势数据 |
| GET | `/api/requests` | 分页请求日志 |
| GET | `/api/errors` | 错误日志 |
| GET/POST | `/api/config` | 读写配置 |
| GET/POST/DELETE | `/api/apikeys` | API Key 管理 |
| GET | `/api/logs` | 历史日志日期列表 |
| GET | `/api/logs/:date` | 指定日期日志详情 |
| GET | `/api/containers` | Docker 容器列表 |
| GET | `/api/container-logs` | 容器实时日志（末 10 行） |
| POST | `/api/prompt-optimize` | 提示词压缩优化 |

## 工作原理

```
┌──────────────┐      ┌──────────────┐      ┌──────────────┐
│  AI 客户端    │ ──── │  代理服务     │ ──── │  LM Studio   │
│ (Chatbox 等)  │      │ :9234        │      │ :1234        │
└──────────────┘      └──────────────┘      └──────────────┘
                            │
                            ▼
                     ┌──────────────┐
                     │  仪表盘       │
                     │ 每 2 秒轮询   │
                     └──────────────┘
```

1. AI 客户端请求发送到代理服务 (`localhost:9234`)
2. 代理服务记录请求数据（Token 数、延迟、模型等）并转发给 LM Studio
3. 前端仪表盘每 2 秒轮询 `/api/stats` 和 `/api/resource-monitor` 实时更新；容器日志每 500ms 独立轮询

## 注意事项

1. **LM Studio 需先启动**，确保监听 1234 端口
2. **Docker 部署**: 自动使用 `llamacppserver-mtp-llama-server-1` 容器名连接
3. **数据在内存中**: 重启服务会清空统计数据和日志（历史日志可选持久化）
4. **需要网络**: 仪表盘使用 Tailwind CDN 和 Chart.js CDN
5. **GPU 监控**: 需要容器能访问 Docker socket（已配置），llama 容器需有 ROCm/AMD GPU 驱动
6. **日志文件含 API Key**: `data/logs/` 已在 `.gitignore` 中排除，请勿提交到 git

## 故障排除

| 问题 | 解决 |
|------|------|
| Docker 部署失败 | `docker compose logs -f` 查看日志 |
| 端口冲突 | 修改 docker-compose.yml 中的 `published` 端口 |
| 仪表盘显示"等待请求" | 检查 API 客户端 Base URL 是否正确 |
| 资源监控无 GPU 数据 | 确认 Docker socket 已挂载，llama 容器 GPU 驱动正常 |
| 数据不更新 | 硬刷新浏览器 (Ctrl+Shift+R)，检查控制台错误 |
