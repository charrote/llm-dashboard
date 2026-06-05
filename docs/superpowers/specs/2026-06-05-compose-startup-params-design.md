# 性能测试面板：启动参数（docker-compose.yml 编辑器）

**日期**：2026-06-05
**状态**：已批准
**类型**：功能改进

## 背景与动机

`lmstudio-dashboard` 的「性能测试」面板目前已支持「模型调整」（编辑 `models.ini`）和「重载模型」（`docker restart`）两个运维按钮，但缺少对**容器启动参数**（`docker-compose.yml`）的在线编辑能力：

- 调优 llama.cpp 参数（如 `--top_p`、`--repeat-penalty`、`--sleep-idle-seconds`）时，需要在宿主机手动编辑 `docker-compose.yml`、再 `docker compose up -d --build`
- 当前 `proxy/server.js:1748` 已硬编码了 `docker-compose.yml` 所在目录 `/home/uantek/dev/llama.cpp.server-mtp`，但 UI 上没暴露——一旦用户移动或重命名项目目录，编辑器会直接失灵
- 调优时需要在终端、vim、仪表盘之间来回切，流程割裂

**目标**：在「性能测试」面板中暴露一个「启动参数」按钮，**自动定位**到启动推理引擎容器的 `docker-compose.yml`，提供在线编辑 + YAML 语法校验，保存后**复用现有「重载模型」按钮**完成应用。

## 目标与非目标

### 目标
- 性能测试面板新增「启动参数」按钮，点击打开 `docker-compose.yml` 编辑模态
- 路径解析优先级：自动探测（`docker inspect` compose 标签）→ 配置回退（`composeProjectDir`）→ 禁用按钮
- 自动探测成功时，把探测到的路径回填到 `composeProjectDir`（仅在用户未设置时），让配置自愈
- 编辑模态显示文件路径、源（自动 / 手动）、容器名；保存时做 YAML 语法校验
- 设置面板新增「Compose 项目目录」字段，作为探测失败的兜底配置

### 非目标
- 不做 docker-compose 字段 schema 校验（仅 YAML 语法）
- 不支持 `docker-compose.override.yml` 等附加文件（只编辑主文件）
- 不在 v1 集成「应用 compose」操作（用户改完点现有「重载模型」即可）
- 不做并发写锁（单用户操作；最后写赢）
- 不重构 `models.ini` 编辑器或「重载模型」按钮

## 路径解析策略

### 优先级链

1. **`docker inspect` 读取 compose 标签**（自动，源标记 `auto`）
2. **`config.composeProjectDir` 用户配置**（手动，源标记 `config`）
3. **都没有** → `getComposeConfig()` 返回 `null`，UI 禁用按钮

### 标签读取

```bash
docker inspect <container> --format '{{json .Config.Labels}}'
```

关键标签：

| 标签 | 用途 |
|------|------|
| `com.docker.compose.project.config_files` | 冒号分隔的 compose 文件列表（相对路径） |
| `com.docker.compose.project.working_dir` | compose 工作目录（绝对路径） |
| `com.docker.compose.project` | 项目名（用于显示） |

主文件路径 = `working_dir + '/' + config_files.split(':')[0]`，本设计固定编辑 `docker-compose.yml`（`config_files` 第一个文件即为主文件，多数情况就是它）。

### 自动回填（Lazy）

`getComposeConfig()` 自身**始终不写盘**。回填发生在 `GET /api/compose-config` 处理路径上：

```js
app.get('/api/compose-config', async (req, res) => {
  const compose = await getComposeConfig();
  if (compose && compose.source === 'auto' && config.composeProjectDir !== compose.projectDir) {
    config.composeProjectDir = compose.projectDir;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    console.log(`[AUTO-FILL] composeProjectDir=${compose.projectDir}`);
  }
  // ... 原有响应逻辑
});
```

- **不写盘条件**：`config.composeProjectDir === compose.projectDir`（值已匹配，可能是用户主动填的，也可能是上次回填的）
- **首次探测成功 + 字段为空** → 回填
- **用户已设置其他值** → 保留用户值（用户配置优先）
- **不依赖服务启动时机**：用户首次打开模态触发回填，符合「用到再写」原则

## 设计

### 1. 配置模型

`config.json` 字段变化：

| 字段 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `composeProjectDir` | string | 否 | `''` | 备用宿主机目录绝对路径，指向 `docker-compose.yml` 所在目录。自动探测失败时使用 |

`composeProjectDir` 填充时机（lazy，详见「自动回填」一节）：

1. `config.composeProjectDir`（已存在 → 保留）
2. **首次 `GET /api/compose-config` 调用时**：自动探测成功且字段为空 → 回填
3. 用户在设置面板手动编辑 → 优先于自动探测结果（值不同则不覆盖）

### 2. 后端 API

#### `GET /api/compose-config`

- 行为：调用 `getComposeConfig()` 解析路径；解析失败返回 404
- 成功响应：
  ```json
  {
    "available": true,
    "container": "llamacppserver-mtp-llama-server-1",
    "projectDir": "/home/uantek/dev/llama.cpp.server-mtp",
    "composeFile": "/home/uantek/dev/llama.cpp.server-mtp/docker-compose.yml",
    "source": "auto",
    "content": "version: '3.8'\n..."
  }
  ```
- 不可用响应：
  ```json
  HTTP 404
  { "available": false, "reason": "未找到 compose 标签或 composeProjectDir 配置" }
  ```
- 文件不存在或读失败 → HTTP 500 + `{available:false, reason:"读取文件失败: <err>"}`

#### `POST /api/compose-config`

- 请求体：`{ "content": "新 YAML 内容" }`
- 处理流程：
  1. `getComposeConfig()` 解析路径；失败 → 404
  2. `yaml.load(content)` 校验语法；失败 → 400 + 解析 detail
  3. 路径安全二次校验（`/[;&|$`<>(){}]/`）；失败 → 400
  4. base64 编码 + `docker run --rm -i -v "${projectDir}":/target busybox sh -c 'echo ${b64} | base64 -d > /target/docker-compose.yml'`
  5. 成功 → `{success: true}`
- 错误响应：
  ```json
  HTTP 400
  { "error": "YAML 语法错误", "detail": "duplicated mapping key at line 12, column 5" }
  ```

**新增依赖**：
- `js-yaml@^4.1.0`（加入 `proxy/package.json`）

### 3. `getComposeConfig()` 派生函数

```js
async function getComposeConfig() {
  const container = getInferenceConfig().container;
  let projectDir = null;
  let source = null;

  // 1) docker inspect compose 标签
  try {
    const { stdout } = await execAsync(`docker inspect ${container} --format '{{json .Config.Labels}}'`);
    if (stdout.trim()) {
      const labels = JSON.parse(stdout);
      const configFiles = labels['com.docker.compose.project.config_files'];
      const workingDir  = labels['com.docker.compose.project.working_dir'];
      if (workingDir && configFiles) {
        projectDir = workingDir;
        source = 'auto';
      }
    }
  } catch (_) { /* 忽略，回退到 config */ }

  // 2) 回退到 config.composeProjectDir
  if (!projectDir && config.composeProjectDir) {
    projectDir = config.composeProjectDir;
    source = 'config';
  }

  if (!projectDir) return null;

  // 3) 安全校验
  if (/[;&|$`<>(){}]/.test(projectDir)) return null;

  return {
    container,
    projectDir,
    composeFile: path.join(projectDir, 'docker-compose.yml'),
    source
  };
}
```

> 函数是 `async`（`docker inspect` 异步）；GET / POST 处理器用 `await getComposeConfig()`。

> 注：实现中 `execAsync` 已用 `util.promisify`，无需新增；`fs.readFileSync` / `fs.writeFileSync` 同样已有。

### 4. 前端 UI

#### 4.1 性能测试面板新增按钮（`dashboard.html:434` 后）

```html
<button id="composeConfigBtn" onclick="openComposeConfig()" disabled
        class="bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-700 disabled:text-gray-500 disabled:cursor-not-allowed px-4 py-2 rounded-lg text-sm transition h-fit"
        title="启动参数">
  启动参数
</button>
```

- 颜色：`indigo-600`（与现有 pink/yellow/red/blue/green 不重叠）
- 默认 `disabled`；`openBenchmark()` 末尾调用 `loadComposeConfigStatus()` 探测
- 启用后 `title` 展示「自动探测：/path/...」或「配置路径：/path/...」

#### 4.2 「启动参数」编辑模态（新增在 `modelConfigModal` 后）

- 标题：`🐳 启动参数 - <container>`
- 信息行：文件路径（蓝色等宽）+ 源徽章（绿色「自动探测」/ 蓝色「手动配置」）
- 黄色警告：`⚠️ 修改需重启容器（点击"重载模型"按钮）才能生效。`
- Textarea：等宽字体，min-height 400px
- 错误行：保存失败时显示红色错误块
- 按钮：取消 / 保存

#### 4.3 设置面板「Compose 项目目录」字段（`dashboard.html:163` 后）

```html
<label class="block text-sm text-gray-400 mb-2 mt-3">Compose 项目目录</label>
<input type="text" id="composeProjectDir" placeholder="/path/to/docker-compose-dir"
       class="w-full bg-gray-700 border border-gray-600 rounded-lg px-4 py-2 text-white focus:border-blue-500 focus:outline-none font-mono text-sm">
<p class="text-xs text-gray-500 mt-1">
  备用路径：自动探测失败时使用。留空则「启动参数」按钮禁用。
  <span id="composeProjectDirStatus" class="text-gray-600"></span>
</p>
```

`loadConfig` / `saveConfig` 中追加读写 `composeProjectDir` 字段；保存成功后探测一次，更新 `#composeProjectDirStatus` 文案（`✓ 当前配置可用` / `✗ 路径无效`）。

### 5. 数据流

```
┌─────────────────┐  GET /api/compose-config    ┌──────────────────┐
│  性能测试面板    │ ───────────────────────────► │ getComposeConfig │
│  启动参数按钮    │ ◄─────────────────────────── │  ├ docker inspect│
│  (探测 + 启用)   │   {available, path, content} │  ├ config 回退   │
└─────────────────┘                              │  └ 安全校验      │
        │                                        └──────────────────┘
        │ click
        ▼
┌─────────────────┐  GET /api/compose-config    ┌──────────────────┐
│  编辑模态        │ ───────────────────────────► │ 读 fs 文件        │
│  (textarea)     │ ◄─────────────────────────── │ (composeFile)    │
└─────────────────┘                              └──────────────────┘
        │ 编辑后保存
        ▼
┌─────────────────┐  POST /api/compose-config   ┌──────────────────┐
│  模态            │ ───────────────────────────► │ yaml.load 校验   │
│  saveComposeConfig│                              │ base64 + docker  │
│                 │ ◄─────────────────────────── │   run busybox    │
└─────────────────┘   {success}                   └──────────────────┘
        │
        │ 用户点现有"重载模型"按钮
        ▼
   docker restart <container>
```

### 6. 错误处理

| 场景 | 行为 |
|------|------|
| 容器非 compose 启动，无 compose 标签 | `getComposeConfig()` 返回 `null`；按钮 disabled |
| 容器已 `docker stop` | `docker inspect` 仍可读 Labels；编辑可保存（写盘不依赖容器运行） |
| `composeProjectDir` 配置路径不存在 | `fs.readFileSync` ENOENT → GET 500，按钮 disabled |
| `composeProjectDir` 含 shell 元字符 | `getComposeConfig()` 返回 `null`，按钮 disabled |
| 写盘时 busybox 镜像未拉取 | `docker run` 抛错 → POST 500；模态显示错误 |
| 用户保存的 YAML 有语法错误 | `yaml.load` 抛错 → POST 400；模态错误块显示 |
| 容器切换后旧路径不再适用 | `getComposeConfig()` 重新探测；探测成功自动回填新路径 |
| `docker inspect` 命令失败 | `getComposeConfig()` 内部 try/catch 兜底 → 按钮 disabled |
| 多文件 compose | 取 `config_files` 第一个文件（主文件），不编辑 `override` |

### 7. 测试

#### 后端手动验证
- 容器为 compose 启动：探测成功，回填 `composeProjectDir`，按钮启用
- 容器为 `docker run` 启动：无标签，按钮 disabled
- 设置面板填入 `/tmp/empty-dir`：探测失败回退到该路径，`fs.readFileSync` 抛 ENOENT，GET 500
- POST 故意写非法 YAML：js-yaml 抛错，HTTP 400 + detail
- POST 含 `${;}` 字符的路径：双重检查，HTTP 400
- 正常保存：写盘后 `cat` 容器外对应文件验证内容一致

#### 前端手动验证
- 打开性能测试面板：按钮 1s 内 enabled，title 显示「自动探测：/path/...」
- 点击按钮：模态打开，路径、源徽章、textarea 内容全部正确
- 修改一段注释保存：弹窗「保存成功」，关闭模态
- 改坏 YAML 保存：模态内错误红框显示，textarea 保留
- 设置面板改 `composeProjectDir` → 保存 → 重开性能测试 → 徽章变蓝「手动配置」
- 切换推理引擎容器 → 重开 → 路径跟随新容器重新探测

#### 集成验证
- 改 compose 的 `command:` → 保存 → 手动点「重载模型」→ 容器拉起新命令
- 删除 `docker-compose.yml` 重建（模拟外部工具覆盖）→ 仪表盘仍能打开编辑器、内容为新文件

## 兼容性

- 配置字段向后兼容：旧 `config.json` 无 `composeProjectDir`，首次启动自动回填
- 现有 `models.ini` 编辑器、「重载模型」按钮、`/api/model-config`、`/api/reload-model` 不受影响
- 现有 `docker-compose.yml`（含 `version: '3.8'` 等字段）兼容 YAML 1.2 语法（js-yaml 4.x 默认 CORE_SCHEMA）

## 风险与权衡

| 风险 | 缓解 |
|------|------|
| 容器用 `docker run` 直接启动（非 compose） | 按钮 disabled + 引导用户填 `composeProjectDir` |
| `docker inspect` 输出含特殊字符 | `JSON.parse` 包裹；外层 try/catch 兜底 |
| 路径含空格、Unicode | `getComposeConfig` 元字符白名单过滤；`docker run` 命令双引号包裹 + 内部 `"` 转义 |
| 用户改坏 YAML 导致容器起不来 | 不在 v1 自动应用，提示需「重载模型」生效；用户可在终端 `docker compose config` 验证 |
| 多 compose 文件项目 | v1 只编辑主文件；后续如需编辑 override 再扩展 |
| 并发写 | 单用户操作假设；最后写赢；不在 v1 引入锁 |

## 实施步骤概要

1. `proxy/package.json`：加 `js-yaml@^4.1.0`，`npm install`
2. `proxy/server.js`：
   - 新增 `async getComposeConfig()` 函数（含安全校验）
   - `GET /api/compose-config` 内实现 lazy 自动回填
   - 新增 `GET /api/compose-config`、`POST /api/compose-config`
   - `POST /api/config` 接收 `composeProjectDir` 字段
3. `dashboard.html`：
   - 性能测试面板新增「启动参数」按钮
   - 新增 composeConfigModal 模态
   - `loadComposeConfigStatus` / `openComposeConfig` / `loadComposeConfigContent` / `saveComposeConfig` / `closeComposeConfig` 函数
   - 设置面板加 `composeProjectDir` 字段 + 状态提示
   - `loadConfig` / `saveConfig` 适配
4. README.md：「性能测试」小节加一行说明
5. 验证：手动 + 集成测试

## 文件变更清单

| 文件 | 类型 | 说明 |
|------|------|------|
| `proxy/server.js` | 修改 | `getComposeConfig`、自动回填、API 端点、`/api/config` 接收新字段 |
| `proxy/package.json` | 修改 | 加 `js-yaml` 依赖 |
| `dashboard.html` | 修改 | 性能测试面板按钮、composeConfigModal、设置面板字段、JS 函数 |
| `README.md` | 修改 | 「性能测试」小节补充「启动参数」一行说明 |
| `proxy/config.json` | 自动迁移 | 启动时回填 `composeProjectDir` |
