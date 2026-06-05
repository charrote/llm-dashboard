# 单点真相：推理引擎容器驱动下游视图

- **日期**：2026-06-05
- **作者**：lmstudio-dashboard 维护者
- **状态**：设计稿，待评审
- **相关**：[2026-06-05-compose-startup-params-design.md](2026-06-05-compose-startup-params-design.md)（已实现的"启动参数"功能，本文是其下游延伸）

## 背景

设置面板允许用户选择「推理引擎容器」（`inferenceContainer`）。当前该字段是若干下游视图的**唯一容器来源**，但相关 UI 状态（compose 目录、模型列表、目标模型下拉）并未与之强联动：

| 下游 | 现状 | 问题 |
|---|---|---|
| 实时日志 | 跟随 `getInferenceConfig().container` | ✅ 已联动，无需改 |
| 启动参数（compose 文件） | 懒反推 | ✅ 已联动（上一版设计） |
| 目标模型下拉 | 走 `/api/models`（代理 LM Studio `/v1/models`） | ❌ 读的是**容器内**运行时 API，依赖容器运行；与启动参数 / compose 路径不同源 |
| 设置面板 `composeProjectDir` 字段 | 独立可编辑字段，auto-detect 仅作 fallback | ❌ 用户感知不到"反推"的存在，重复劳动 |

## 目标

**`inferenceContainer` 成为单点真相（Single Source of Truth, SSoT）**。其余字段全部从它反推，用户可手动覆盖作为 escape hatch。

## 设计

### 1. 反推关系图

```
            ┌─────────────────────┐
            │  inferenceContainer │  ← 用户在设置面板下拉
            │  (用户选择 + 落盘)  │
            └──────────┬──────────┘
                       │
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
  composeProjectDir  models.ini   容器日志
  (docker inspect    (宿主路径    (docker logs
   Labels 反推)       /container   --tail 10)
        │             fallback)
        │
        ▼
  docker-compose.yml
  (启动参数编辑器)
```

四者都从 `inferenceContainer` 出发：

| 字段 | 反推方式 | 存储 | 用户可覆盖 |
|---|---|---|---|
| `composeProjectDir` | `docker inspect` Labels | 落 `config.json` | ✅（兜底，auto-detect 失败时手动） |
| `models.ini` 路径 | `<composeProjectDir>/models.ini` | 不存 | ❌（只读） |
| 容器日志 | `docker logs --tail 10 <container>` | 不存 | ❌ |
| 启动参数 | `path.join(composeProjectDir, 'docker-compose.yml')` | 不存 | ❌（编辑的是文件） |

### 2. 服务端

#### 2.1 新端点 `GET /api/models-ini`

```http
GET /api/models-ini
```

**响应 200：**

```json
{
  "projectDir": "/home/uantek/dev/llama.cpp.server",
  "composeFile": "/home/uantek/dev/llama.cpp.server/docker-compose.yml",
  "source": "host",
  "models": [
    {
      "id": "UANTEKDEV0",
      "alias": "Qwen3.6-35B-A3B-UA",
      "ctxSize": 262144,
      "model": "/models/HauhauCS/Qwen3.6-35B-A3B-Uncensored-HauhauCS-Aggressive/Qwen3.6-35B-A3B-UA"
    },
    {
      "id": "default",
      "alias": null,
      "ctxSize": 4096,
      "model": null
    }
  ]
}
```

**响应 404（`source: "missing"`）：**

```json
{
  "source": "missing",
  "reason": "未找到 models.ini（宿主路径 /home/uantek/dev/llama.cpp.server/models.ini 不存在；容器 llamacppserver-llama-server-1 未运行或无 /app/models.ini）",
  "models": []
}
```

**数据源策略（按优先级）：**

1. **宿主路径**：`<projectDir>/models.ini`（`projectDir` 由 `getComposeConfig()` 解析）
   - 存在 → `source: "host"`
2. **容器路径**：`docker exec <container> cat /app/models.ini`
   - 存在 → `source: "container"`
3. 都没有 → `source: "missing"` + 友好 `reason`

#### 2.2 解析函数 `parseModelsIni(text)`

抽成顶层函数（与 `getComposeConfig()` 同级），供新端点和未来其他端点复用。

**输入：** INI 格式文本

**输出：**

```js
[
  { id: "default", alias: "Qwen3.6-35B-A3B-UA", ctxSize: 262144, model: "...", /* 其他键 */ },
  { id: "UANTEKDEV0", alias: "...", ctxSize: 131072, model: "..." }
]
```

**规则：**
- `[*]` section 视为 `id: "default"`
- `[SectionName]` 视为 `id: "SectionName"`
- 每个 section 抽成扁平 `{ key: value }`，同名键取最后一次出现的值
- 键名统一为 lowercase（与现有 `models.ini` 习惯一致）
- 值类型：尝试 `Number()` 转换，转换失败保留原字符串
- 注释行（`;` / `#` 开头）跳过
- 关键字段提取（`alias`, `ctx-size`, `model`）作为顶层结构化字段；其余字段保留在 `extra` 对象里

**与现有 `/api/model-config` 的关系：**
- 现有端点（line 1764）只读**单 section** 返回原文；保留不动
- 未来可优化：内部改为调 `parseModelsIni` 抽 section，但本次不重构

#### 2.3 增强 `GET /api/compose-config`

支持 `?container=<name>` 查询参数，**仅用于探测**，**不修改**默认容器配置。

```http
GET /api/compose-config?container=llamacppserver-llama-server-1
```

**逻辑：**
- 若传 `container` 参数：用此值作为探测目标，**跳过** `config.composeProjectDir` 兜底（只走 `docker inspect` 反推）
- 若未传：保持现有行为（默认用 `getInferenceConfig().container` + config 兜底）
- 响应字段不变（`available`, `source`, `projectDir`, `composeFile`, `container`, `reason?`）
- **不**触发自动回填（自动回填是 `POST /api/config` 的事；探测只读）

**为什么不允许 `?container=` 走 config 兜底：** 探测的目的是让前端在用户**还没保存**时预览反推结果，config 兜底会让"手动指定的 `composeProjectDir`"错误地覆盖用户的新选择。

#### 2.4 增强 `POST /api/config`

**新增行为：** 当 `inferenceContainer` 变更且请求未显式传 `composeProjectDir` 时，服务端自动反推并写入 config。

**逻辑：**

```js
// 现有 OR-chain
configChanged = (
  inferenceContainer !== undefined ||
  inferencePort !== undefined ||
  composeProjectDir !== undefined ||  // 旧
  /* ... */
);

if (inferenceContainer !== undefined && inferenceContainer !== config.inferenceContainer) {
  config.inferenceContainer = inferenceContainer;
  inferenceChanged = true;
}

// 新增：自动反推
if (inferenceChanged && composeProjectDir === undefined) {
  // 用新容器名探测
  const probed = await probeComposeDirOnly(inferenceContainer);
  if (probed) {
    config.composeProjectDir = probed;
    // 不修改 inferenceChanged，不重复写
  }
}
```

**边界：**
- `composeProjectDir: ""`（清空）走原逻辑 `delete config.composeProjectDir`（line 1209-1210）
- `composeProjectDir: "/path"`（显式传值）走原逻辑 `config.composeProjectDir = trimmed`（line 1208），**不**覆盖
- `composeProjectDir` 字段缺失（不传）走新逻辑：反推 → 写入
- 探测失败（auto-detect 失败 + config 兜底也不存在）→ 静默跳过，config 保持原样

**新增辅助函数 `probeComposeDirOnly(container)`：**

```js
async function probeComposeDirOnly(container) {
  // 只走 docker inspect，不读 config
  const safeName = container.replace(/[^a-zA-Z0-9_.-]/g, '');
  try {
    const { stdout } = await execAsync(
      `docker inspect ${safeName} --format '{{json .Config.Labels}}'`
    );
    if (!stdout.trim()) return null;
    const labels = JSON.parse(stdout);
    const workingDir = labels['com.docker.compose.project.working_dir'];
    if (workingDir && !/[;&|$`<>(){}\\]/.test(workingDir)) {
      return workingDir;
    }
  } catch (_) { /* ignore */ }
  return null;
}
```

复用 `getComposeConfig()` 的反推逻辑会更 DRY，但本函数只关心 working_dir，不读 config、不校验 composeFile 存在、不返回结构化对象——简单场景，独立函数更清晰。

### 3. 前端

#### 3.1 设置面板：`inferenceContainer` 实时预填

**触发时机：** 下拉 `change` 事件，**不**等到保存。

**流程：**

```js
inferenceContainerSelect.addEventListener('change', async () => {
  const container = inferenceContainerSelect.value;
  if (!container) {
    composeProjectDirInput.value = '';
    composeProjectDirStatus.textContent = '请先选择推理引擎容器';
    composeProjectDirStatus.className = 'text-gray-500';
    return;
  }

  composeProjectDirStatus.textContent = '正在反推 compose 目录...';
  composeProjectDirStatus.className = 'text-gray-400';

  try {
    const r = await fetch(`${API_BASE}/compose-config?container=${encodeURIComponent(container)}`);
    const j = await r.json();
    if (j.available) {
      composeProjectDirInput.value = j.projectDir;
      composeProjectDirInput.dataset.source = 'auto';
      composeProjectDirStatus.textContent = '✓ 已自动探测（可手动覆盖）';
      composeProjectDirStatus.className = 'text-blue-400';
    } else {
      composeProjectDirInput.value = '';
      composeProjectDirInput.dataset.source = 'none';
      composeProjectDirStatus.textContent = `✗ 未自动探测${j.reason ? '：' + j.reason : ''}`;
      composeProjectDirStatus.className = 'text-yellow-400';
    }
  } catch (e) {
    composeProjectDirStatus.textContent = '✗ 探测失败：' + e.message;
    composeProjectDirStatus.className = 'text-red-400';
  }
});
```

**用户编辑后状态变化：**

```js
composeProjectDirInput.addEventListener('input', () => {
  // 用户手动改了就标记为 manual
  composeProjectDirInput.dataset.source = 'manual';
  composeProjectDirStatus.textContent = '已手动修改（保存时覆盖自动值）';
  composeProjectDirStatus.className = 'text-yellow-400';
});
```

**保存时行为不变：** 前端照旧把 `composeProjectDir` 字段值（用户当前看到的）POST 给后端。若用户**没碰过**该字段、**没保存过**设置：值是下拉 change 触发的预填；保存时 POST 一个非空字符串 → 后端尊重用户值（line 1208），不触发新逻辑。这是符合预期的——前端预填的字符串视为"用户显式接受"。

**初始化逻辑：**

页面打开 / 拉取 `/api/config` 填充设置面板时，若 `inferenceContainer` 已设值但 `composeProjectDir` 为空，**不主动触发**反推（避免多余的 docker inspect）。状态显示："未设置，留空则由启动参数面板自动探测"。

#### 3.2 目标模型下拉：切换到 `GET /api/models-ini`

**现有 `loadModels()`（dashboard.html:2942）：**

```js
const resp = await fetch(`${API_BASE}/models`);  // 走 /v1/models
```

**改为：**

```js
const resp = await fetch(`${API_BASE}/models-ini`);
const j = await resp.json();
if (j.source === 'missing') {
  throw new Error(j.reason || '未找到 models.ini');
}
const models = j.models;
```

**下拉选项渲染：**

```html
<option value="<id>"><id> — <alias> (ctx: <ctxSize>)</option>
```

- `id` 即 section 名（用户配置名）
- `alias` 优先显示；无 alias 时显示 id 自身
- `ctxSize` 用人类可读格式（`262144` → `256K`，内联：`ctxSize >= 1024 ? Math.round(ctxSize/1024) + 'K' : String(ctxSize)`）

**失败处理：**

```js
} catch (err) {
  modelQueryContent.classList.add('hidden');
  modelQueryError.classList.remove('hidden');
  modelQueryError.textContent = '加载模型列表失败：' + err.message + '（请确认设置面板已选择推理引擎容器）';
  // 禁用「开始压测」按钮（与现有"未选目标模型"提示合并）
}
```

#### 3.3 实时请求卡片：不动

当前 `/api/container-logs` 用 `getInferenceConfig().container`，保存设置后 500ms 轮询自动跟随。无需改动。

### 4. 数据流时序

**用户首次选择容器（典型 happy path）：**

```
1. 用户打开设置面板
2. GET /api/config → inferenceContainer="X", composeProjectDir=""  (前端渲染)
3. 用户改下拉到 "Y"
4. 前端: change 事件
5. 前端: GET /api/compose-config?container=Y
6. 后端: docker inspect Y → 找到 working_dir="/path/Z"
7. 前端: composeProjectDirInput.value = "/path/Z"，状态 "✓ 已自动探测"
8. 用户点保存
9. 前端: POST /api/config {inferenceContainer: "Y", composeProjectDir: "/path/Z", ...}
10. 后端: 尊重显式 composeProjectDir → config 写入
11. 前端: 关闭模态，下次轮询 /api/container-logs → Y 的日志
```

**用户切换容器（迁移到新容器）：**

```
1-7. 同上，预填新 compose dir
8. 用户点保存
9. 前端: POST /api/config {inferenceContainer: "Y", composeProjectDir: "/path/Z", ...}
10. 后端: 写 config
11. 后端: 通知前端 200 OK
12. 实时日志: 下次轮询 500ms 内跟随 Y
13. 目标模型: 用户重开性能测试面板时刷新 → 显示 Y 的 models.ini
```

**反推失败场景：**

```
1. 用户选 "Y"，Y 是个裸 docker run 容器（无 compose Labels）
2. 前端: GET /api/compose-config?container=Y
3. 后端: docker inspect 失败/无 Labels → available: false
4. 前端: composeProjectDirInput 清空，状态 "✗ 未自动探测"
5. 用户手动填 /path/Z
6. 保存
7. 后端: 尊重用户填的 /path/Z
```

### 5. 错误处理

| 场景 | 行为 |
|---|---|
| `GET /api/models-ini` 全部失败 | 返回 200 + `source: "missing"`，前端降级显示原因 |
| `GET /api/compose-config?container=X` 容器不存在 | 200 + `available: false, reason: "容器不存在"` |
| 探测时 docker 守护进程无响应 | 200 + `available: false, reason: "docker 不可用"` |
| 前端预填请求失败 | 状态条 "✗ 探测失败：..."，composeProjectDir 不预填，用户需手动填 |
| `POST /api/config` 反推抛错 | 静默吞掉（不影响 config 主流程；只 log console） |
| `inferenceContainer` 格式非法（防注入） | 现有正则 `^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$` 仍生效（server.js:1181） |

### 6. 复用与重构

- **`getComposeConfig()` (server.js:58)**：本次只读不重构
- **`probeComposeDirOnly(container)`**：新加的薄函数，与 `getComposeConfig()` 内部反推逻辑相同但**不读 config、不返回 composeFile**。代码重复 ~15 行，可接受
- **`parseModelsIni(text)`**：新加的工具函数，**未来**可重构 `/api/model-config` 也用它，但本次不重构
- **现有 `/api/model-config` (server.js:1764)**：本次**不改**。它写 `models.ini` 用的是硬编码路径 `/home/uantek/dev/llama.cpp.server-mtp`，不是本文档范畴（见 §7）

### 7. 不在本次范围

1. **`/api/model-config` 写入硬编码路径**：当前写 `models.ini` 用 `docker run -v /home/uantek/dev/llama.cpp.server-mtp:/target`（server.js:1804），应改为读 `config.composeProjectDir`。这是另一项债务，本次不碰
2. **`models.ini` UI 编辑器**（"模型调整"按钮）切到宿主路径写入：与 §7.1 绑定，等下次清理
3. **`/api/config` 配置迁移**：旧 `lmStudio.container/port` → `inferenceContainer/inferencePort` 迁移逻辑（server.js:187-227）已存在，本次不动
4. **多容器支持**：未来若需"dashboard 监控 A 容器、启动参数编辑 B 容器"等工作流，应重构 `inferenceContainer` 为 `monitoredContainer` + `composeContainer` 双字段。本次维持单字段
5. **`getComposeConfig()` 内部 config 兜底**：本次保留"用户显式设的 `composeProjectDir` 作为 fallback"。下一轮可考虑完全去掉兜底（纯 SSoT），但会破坏"auto-detect 失败的容器"工作流，先观望

### 8. 测试

无项目测试套件（手工 curl 验证）。本设计需在集成测试阶段覆盖：

**curl 端：**

1. `GET /api/models-ini` 返回合法 JSON；`source` 正确（host/host-with-fallback/container/missing）
2. 切换容器后 `GET /api/compose-config?container=X` 返回正确 working_dir
3. `POST /api/config` 不传 `composeProjectDir` 时，反推生效（读 config.json 验证）
4. `POST /api/config` 传空 `composeProjectDir: ""` 时，**不**反推，字段被删除
5. `POST /api/config` 传显式 `composeProjectDir: "/x"` 时，**不**反推，字段被设置
6. `parseModelsIni` 对真实 `models.ini` 解析正确（id, alias, ctx-size, model 字段）

**浏览器端（人工）：**

1. 设置面板下拉 change → composeProjectDir 实时预填 + 角标
2. 目标模型下拉显示新列表 + ctx size
3. 实时请求日志跟随新容器（保存后 ≤ 500ms 出现新容器日志）
4. 用户手动改 composeProjectDir → 角标变 "已手动修改"
5. 反推失败 → composeProjectDir 清空 + 提示，手动填写仍可用

### 9. 实施计划

11 个任务，分阶段提交：

| # | 范围 | 文件 |
|---|---|---|
| 1 | 抽 `parseModelsIni(text)` | proxy/server.js |
| 2 | 实现 `getModelsIni()` 数据源选择 | proxy/server.js |
| 3 | 新增 `GET /api/models-ini` | proxy/server.js |
| 4 | 增强 `GET /api/compose-config` 支持 `?container=` | proxy/server.js |
| 5 | 抽 `probeComposeDirOnly(container)` 工具 | proxy/server.js |
| 6 | 增强 `POST /api/config` 自动反推逻辑 | proxy/server.js |
| 7 | 设置面板 `inferenceContainer` change 处理器 | dashboard.html |
| 8 | 设置面板 composeProjectDir input 处理器 | dashboard.html |
| 9 | 目标模型下拉切换到 `/api/models-ini` | dashboard.html |
| 10 | 文档：更新 README + 此 spec 关联 | README.md |
| 11 | 集成测试（curl + 浏览器验证） | — |

每任务独立提交，便于 review 和回滚。
