# 设置面板：推理引擎容器选择器

**日期**：2026-06-02
**状态**：已批准
**类型**：功能改进 / 配置模型重构

## 背景与动机

`lmstudio-dashboard` 是一个 LM Studio 请求代理与监控仪表盘。开发服务器同时跑多个构建后端（vLLM、llama.cpp、TGI、SGLang、Ollama 等不同推理引擎构建产物），容器经常变化。

当前问题：
- 设置面板的"模型地址"是文本输入，需要手动填 `http://<容器名>:<端口>`，容器名变化时必须手动改
- `proxy/server.js` 中 `model-config` 与 `reload-model` 端点硬编码了 `LLM_CONTAINER = 'llamacppserver-mtp-llama-server-1'`
- `config.json` 的 `resourceMonitor.dockerContainer` 与"模型地址"是两个独立的容器配置，重复且容易不同步
- 资源监控、容器日志、模型调整、重载模型四块都依赖容器名，但分散在多处

**目标**：用单一"推理引擎容器 + 端口"配置驱动所有下游功能。

## 目标与非目标

### 目标
- 设置面板提供推理引擎容器下拉选择 + 端口输入
- 自动按关键字过滤出推理引擎相关容器
- 推理引擎容器的选择统一驱动：
  - 请求转发的目标 URL
  - 资源监控（GPU/CPU/内存）
  - "实时请求"卡片的容器日志
  - "模型调整"的 `models.ini` 读写容器
  - "重载模型"的 `docker restart` 目标

### 非目标
- 不实现端口自动探测（用户手动填）
- 不支持非 Docker 部署的回退（统一假设推理引擎在 Docker 容器中）
- 不重构仪表盘其他无关功能
- **不影响**：`lmAuth` 授权值、APIKey 鉴权、用量统计、提示词优化等均保持原样，仅切换容器名称 / URL 派生路径

## 容器识别策略

**关键字匹配（容器名 + 镜像名，大小写不敏感）**：

| 引擎 | 关键字示例 |
|------|-----------|
| llama.cpp | `llama`, `llama-server`, `llamacpp` |
| vLLM | `vllm` |
| TGI | `tgi`, `text-generation-inference` |
| SGLang | `sglang` |
| Ollama | `ollama` |
| 通用 | `inference`, `llm-server` |

后端硬编码关键字数组：
```js
const INFERENCE_KEYWORDS = [
  'llama', 'llamacpp', 'llama-server', 'llama.cpp',
  'vllm', 'tgi', 'text-generation-inference',
  'sglang', 'ollama', 'inference', 'llm-server'
];
```

匹配规则：`containerName.toLowerCase()` 或 `imageName.toLowerCase()` 中任一包含任一关键字 → 视为推理引擎。

## 设计

### 1. 配置模型

**`config.json` 字段变化**：

| 字段 | 变化 | 说明 |
|------|------|------|
| `inferenceContainer` | **新增** | 推理引擎容器名（如 `llamacppserver-mtp-llama-server-1`） |
| `inferencePort` | **新增** | 推理引擎 HTTP 端口（默认 `1234`） |
| `lmStudioUrl` | 派生 | `http://${inferenceContainer}:${inferencePort}`，不再单独保存 |
| `lmStudio.container` | 派生 | = `inferenceContainer`（旧字段保留兼容） |
| `lmStudio.port` | 派生 | = `inferencePort`（旧字段保留兼容） |
| `resourceMonitor.dockerContainer` | 派生 | = `inferenceContainer`（旧字段保留兼容） |

**`inferenceContainer` / `inferencePort` 是唯一持久化的源**。其他字段在服务启动时派生，POST `/api/config` 时同步更新。

> **端口默认值 1234 是 LM Studio 的约定**。其他引擎（vLLM 8000、Ollama 11434、TGI 8080 等）需要用户在端口输入框中自行填入正确值。这是非目标中"不实现端口自动探测"的权衡。

### 2. 启动配置迁移

服务启动时（`proxy/server.js` 顶部）按以下优先级回填 `inferenceContainer`/`inferencePort`：

1. `config.inferenceContainer` + `config.inferencePort`（新字段已存在）
2. `config.lmStudio.container` + `config.lmStudio.port`（旧字段，向后兼容）
3. `config.lmStudioUrl` 解析 `http://NAME:PORT`（更旧字段）
4. `config.resourceMonitor.dockerContainer` + 默认端口 `1234`
5. 默认值 `llamacppserver_llama-server_1` + `1234`

启动时派生 `lmStudioUrl`、`lmStudio`、`resourceMonitor.dockerContainer` 后**不写盘**（避免污染），但读取代码统一走派生函数。

### 3. 后端 API 变化

#### `GET /api/containers`（增强）

**响应**：
```json
{
  "containers": [
    { "name": "llamacppserver-mtp-llama-server-1", "image": "ghcr.io/ggerganov/llama.cpp:server", "matched": true },
    { "name": "dashboard", "image": "lmstudio-dashboard:latest", "matched": false }
  ],
  "keywords": ["llama", "llamacpp", "llama-server", "vllm", "tgi", "sglang", "ollama", "inference", "llm-server"]
}
```

**实现**：
- `docker ps --format "{{.Names}}\t{{.Image}}"` 一次取名字 + 镜像
- 按 `INFERENCE_KEYWORDS` 过滤 `matched` 字段
- 前端只展示 `matched === true` 的容器，但展示全部列表给 UI 标记候选
- `docker` 命令不可用时返回 `503` + 明确错误

#### `GET /api/config`（调整字段）

```json
{
  "inferenceContainer": "llamacppserver-mtp-llama-server-1",
  "inferencePort": 1234,
  "lmStudioUrl": "http://llamacppserver-mtp-llama-server-1:1234",
  "enableAPIKey": true,
  ...
}
```

不再返回 `resourceMonitor.dockerContainer`、`lmStudio.container`、`lmStudio.port`（派生值，前端不需要）。

#### `POST /api/config`（接收新字段）

```json
{
  "inferenceContainer": "...",
  "inferencePort": 1234,
  ...
}
```

- 校验：`inferenceContainer` 非空（去除两端空白）、`inferencePort` 整数 1-65535
- 持久化到 `config.inferenceContainer` / `config.inferencePort`
- 同步更新内存变量 `lmStudioUrl`（其他派生字段读取时计算）
- **API 向后兼容**：若客户端仍传 `lmStudioUrl`（旧字段）而未传新字段，解析 `http://NAME:PORT` 回写到新字段后写盘。这是为了**外部 API 消费者**的兼容性，前端 UI 已完全切换到新字段。

#### `GET /api/container-logs`（派生来源）

- 不再读 `resourceMonitor.dockerContainer`
- 改为读 `config.inferenceContainer`（或经派生函数）

#### `GET /api/model-config` / `POST /api/model-config`（派生来源）

- 删除 `const LLM_CONTAINER = 'llamacppserver-mtp-llama-server-1'` 硬编码
- 改为读 `config.inferenceContainer`（或经派生函数）

#### `POST /api/reload-model`（派生来源）

- 删除硬编码 `docker restart llamacppserver-mtp-llama-server-1` 兜底
- 改为 `docker restart ${safeName(config.inferenceContainer)}`
- 删除 `docker compose restart`（不可靠，与具体容器名耦合），统一走 `docker restart`

#### `POST /api/test`（适配新字段）

- 接受 `{ container, port }` 替代 `{ url }`
- 后端派生 `url = http://${container}:${port}` 探测 `/v1/models`
- 保留对 `url` 字段的兼容（旧客户端）

### 4. 前端 UI 变化

#### 设置面板「模型设置」模态（dashboard.html）

**位置**：当前"模型地址"输入框（行 151-156）替换。

**新结构**：
```html
<div>
  <label>推理引擎容器</label>
  <div class="flex gap-2">
    <select id="inferenceContainer" class="flex-1 ...">
      <option>llamacppserver-mtp-llama-server-1</option>
    </select>
    <button onclick="refreshContainers()" class="...">↻ 刷新</button>
  </div>
  <label>端口</label>
  <input type="number" id="inferencePort" min="1" max="65535" value="1234" />
  <p class="text-xs text-gray-500">
    URL: <span id="inferenceUrlPreview" class="text-blue-400">http://...:1234</span>
    （自动派生）
  </p>
</div>
```

**交互**：
- 打开设置面板时调用 `loadConfig()` + `loadContainers()`，并行加载
- 容器下拉仅展示 `matched === true` 的容器
- 容器或端口变更时，URL 预览实时更新
- 容器下拉为空时显示选项 `未找到推理引擎容器，请确认 Docker 中有 llama.cpp / vllm / tgi 等容器运行` 并禁用保存
- "测试连接"按钮调用 `POST /api/test`，body 用 `{ container, port }`

**删除**：原 `<input type="text" id="lmStudioUrl" />` 与其提示文本

#### JS 函数变化

- `loadConfig()`: 读取 `inferenceContainer`/`inferencePort` 填入表单
- `loadContainers()`: 调 `GET /api/containers`，填充下拉
- `refreshContainers()`: 重新调 `loadContainers()`
- `saveConfig()`: 提交 `{ inferenceContainer, inferencePort, ... }`
- `testConnection()`: 改用 `{ container, port }` 提交

#### 实时容器日志卡（dashboard.html 行 627-636）

**无变化**：继续轮询 `/api/container-logs`，后端已自动使用新字段。

#### 性能测试：模型调整 / 重载模型（dashboard.html）

**无变化**：调用 `/api/model-config` 和 `/api/reload-model`，后端已自动使用新字段。

### 5. 数据流

```
┌────────────────┐    POST /api/config
│ 设置面板         │ ───────────────────────► ┌──────────────────┐
│ 容器: A         │                          │   config.json    │
│ 端口: 1234      │                          │ inferenceContainer│
└────────────────┘                          │ inferencePort     │
                                            └──────────────────┘
                                                     │
        ┌────────────────────────────────────────────┼────────────────────────────┐
        ▼                       ▼                    ▼                            ▼
  lmStudioUrl =          resourceMonitor.      /api/container-logs         /api/model-config
  http://A:1234          dockerContainer = A    (实时请求卡片)              /api/reload-model
  (所有请求转发)          (GPU/CPU/内存)                                     (性能测试)
```

### 6. 错误处理

| 场景 | 行为 |
|------|------|
| Docker 不可用 | `/api/containers` 返回 503；UI 提示「Docker 不可用」；保存按钮禁用 |
| 容器列表为空（无匹配） | 下拉显示提示选项；保存按钮禁用 |
| 选择容器后但服务不可达 | "测试连接"返回明确错误，不阻塞保存 |
| 配置文件无新字段 | 启动时按回填优先级恢复，写入新字段后其他派生字段不再持久化 |
| 容器名含特殊字符 | `safeName` 清洗 `[^a-zA-Z0-9_.-]`（与现有 `/api/container-logs` 一致） |
| 端口超出范围 | `POST /api/config` 返回 400 |

### 7. 测试

#### 后端单元测试（手动 / 可选 mocha）
- 容器过滤：关键字匹配（名 vs 镜像、大小写、空格）
- 配置迁移：从 `lmStudioUrl` 解析容器名/端口
- 配置迁移：从 `lmStudio.container/port` 回填
- `safeName` 清洗特殊字符
- 端口边界值（1、65535、超出）

#### 前端手动验证
- 设置面板打开：容器下拉 + 端口正确填充
- 切换容器：URL 预览实时变化
- 修改端口：URL 预览实时变化
- 点击"刷新"：重新拉取容器列表
- 容器列表为空：禁用保存，显示提示
- "测试连接"：成功/失败提示
- 保存后：仪表盘 / 实时请求 / 性能测试 都跟随新容器
- 重启服务：配置持久化正确

#### 集成验证
- 修改容器 → 实时请求日志的 `docker logs` 目标立即变化
- 修改容器 → 模型调整时 `docker exec` 目标正确
- 修改容器 → 重载模型时 `docker restart` 目标正确
- 修改容器 → 资源监控 GPU 读取目标正确

## 兼容性

- 配置字段向后兼容：旧 `config.json` 启动时自动迁移到 `inferenceContainer`/`inferencePort`
- 旧客户端 / API 调用：保留 `lmStudioUrl` 派生 + `POST /api/test` 接受 `url` 字段
- 旧字段 `lmStudio` / `resourceMonitor.dockerContainer` 在 POST 时不再保存（避免冗余）

## 风险与权衡

| 风险 | 缓解 |
|------|------|
| 用户容器名不含关键字时被过滤掉 | 关键字列表可后续扩展；提供 `↻ 刷新` 重新探测；提供详细错误提示 |
| `docker compose restart` 行为变化 | 显式 `docker restart ${container}` 更可预测，且与 UI 选择一致 |
| 旧 `lmStudioUrl` 配置覆盖端口解析 | 解析时仅在没有 `inferencePort` 时使用，旧的端口号不变 |
| 容器运行但服务未启动 | "测试连接"按钮提供显式反馈；不在保存时强校验（避免开发期反复重启） |

## 实施步骤概要

1. `proxy/server.js`：新增 `INFERENCE_KEYWORDS` 常量、`getInferenceConfig()` 派生函数、启动迁移逻辑
2. `proxy/server.js`：调整 `GET/POST /api/config`、`GET /api/containers`、`GET /api/container-logs`、`GET/POST /api/model-config`、`POST /api/reload-model`、`POST /api/test`
3. `dashboard.html`：替换"模型地址"输入框为容器下拉 + 端口输入
4. `dashboard.html`：更新 `loadConfig`、`saveConfig`、`testConnection` 适配新字段
5. `dashboard.html`：新增 `loadContainers`、`refreshContainers`、URL 预览实时更新
6. `README.md`：更新"配置"章节，说明新模型
7. 验证：手动 + 集成测试

## 文件变更清单

| 文件 | 类型 | 说明 |
|------|------|------|
| `proxy/server.js` | 修改 | 派生函数、API 端点、启动迁移、删除硬编码 |
| `dashboard.html` | 修改 | 设置面板 UI、JS 函数 |
| `README.md` | 修改 | 文档更新 |
| `proxy/config.json` | 自动迁移 | 启动时回填新字段 |
