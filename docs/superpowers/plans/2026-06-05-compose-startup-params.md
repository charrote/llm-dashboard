# Compose Startup Params Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "启动参数" button to the 性能测试 panel that opens an editor for the `docker-compose.yml` of the running inference engine container. The path is auto-detected via `docker inspect` compose labels, with a user-overridable `composeProjectDir` fallback in Settings.

**Architecture:** Mirror the existing `model-config` flow. `proxy/server.js` adds a `getComposeConfig()` derivation function, two new endpoints (`GET/POST /api/compose-config`), and accepts a new `composeProjectDir` field on `POST /api/config`. `dashboard.html` adds an indigo "启动参数" button, a compose-config modal, a settings field, and helper JS functions. `js-yaml@^4.1.0` is the only new dependency. No test framework (manual `curl` integration tests, consistent with the codebase).

**Tech Stack:** Express.js (Node, ES modules), vanilla JS, Tailwind CSS (CDN), `js-yaml@^4.1.0`, `child_process.execAsync` (existing).

**Reference Spec:** `docs/superpowers/specs/2026-06-05-compose-startup-params-design.md`

---

## File Map

| File | Responsibility |
|------|----------------|
| `proxy/package.json` | Add `js-yaml@^4.1.0` dependency |
| `proxy/server.js` | Add `getComposeConfig()` derivation; add `GET/POST /api/compose-config`; extend `POST /api/config` to accept `composeProjectDir` |
| `dashboard.html` | Add indigo "启动参数" button; add `composeConfigModal`; add Settings panel `composeProjectDir` field; add JS functions (`loadComposeConfigStatus`, `openComposeConfig`, `closeComposeConfig`, `loadComposeConfigContent`, `saveComposeConfig`); update `loadConfig`/`saveConfig` |
| `README.md` | Add one-line note to "性能测试" section |
| `proxy/config.json` | Auto-populated on first `GET /api/compose-config`; not hand-edited |

---

### Task 1: Add `js-yaml` dependency

**Files:**
- Modify: `proxy/package.json`

- [ ] **Step 1: Add `js-yaml` to dependencies**

Replace the `"dependencies"` block in `proxy/package.json` (lines 9-16) with:

```json
"dependencies": {
  "@langchain/core": "^0.3.80",
  "chart.js": "^4.4.1",
  "cors": "^2.8.5",
  "express": "^4.18.2",
  "js-yaml": "^4.1.0",
  "slimcontext": "^2.1.3",
  "uuid": "^9.0.0"
}
```

- [ ] **Step 2: Install the dependency**

Run:
```bash
cd /home/uantek/dev/Applications/lmstudio-dashboard && npm install --prefix proxy
```

Expected: adds `js-yaml` to `proxy/node_modules`, updates `proxy/package-lock.json`. No errors.

- [ ] **Step 3: Verify server still starts**

Run:
```bash
cd /home/uantek/dev/Applications/lmstudio-dashboard && timeout 3 node proxy/server.js 2>&1 | head -10
```

Expected: `LM Studio Proxy running on http://0.0.0.0:9234` (timeout-killed).

- [ ] **Step 4: Commit**

```bash
cd /home/uantek/dev/Applications/lmstudio-dashboard
git add proxy/package.json proxy/package-lock.json
git commit -m "feat(deps): add js-yaml for compose config validation"
```

---

### Task 2: Add `getComposeConfig()` derivation function

**Files:**
- Modify: `proxy/server.js` (top of file, after `getInferenceConfig`)

- [ ] **Step 1: Require `js-yaml` and `path`**

Check the top of `proxy/server.js` for existing `require`/`import` lines. The file uses ES modules (`"type": "module"` in `package.json`). Find the existing `import` lines (e.g., `import express from 'express';`) and add after them:

```js
import path from 'path';
import yaml from 'js-yaml';
```

If `path` is already imported, only add the `yaml` line.

- [ ] **Step 2: Add `getComposeConfig()` after `getInferenceConfig()`**

Find the end of `getInferenceConfig()` (line 55 in the current file) and add after it:

```js
async function getComposeConfig() {
  const container = getInferenceConfig().container;
  let projectDir = null;
  let source = null;

  // 1) docker inspect compose 标签
  try {
    const safeName = container.replace(/[^a-zA-Z0-9_.-]/g, '');
    const { stdout } = await execAsync(`docker inspect ${safeName} --format '{{json .Config.Labels}}'`);
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

- [ ] **Step 3: Verify server still starts**

Run:
```bash
cd /home/uantek/dev/Applications/lmstudio-dashboard && timeout 3 node proxy/server.js 2>&1 | head -10
```

Expected: `LM Studio Proxy running on http://0.0.0.0:9234` (timeout-killed). No import errors.

- [ ] **Step 4: Commit**

```bash
cd /home/uantek/dev/Applications/lmstudio-dashboard
git add proxy/server.js
git commit -m "feat(server): add getComposeConfig() derivation with auto-detect + fallback"
```

---

### Task 3: Add `GET /api/compose-config` endpoint with lazy auto-fill

**Files:**
- Modify: `proxy/server.js` (after `/api/reload-model`, before `app.listen`)

- [ ] **Step 1: Add the GET endpoint**

Find `app.listen(PORT, '0.0.0.0', () => {` near line 1766 and add the new endpoint just before it:

```js
app.get('/api/compose-config', async (req, res) => {
  const compose = await getComposeConfig();
  if (!compose) {
    return res.status(404).json({ available: false, reason: '未找到 compose 标签或 composeProjectDir 配置' });
  }
  // Lazy auto-fill: if auto-detect succeeded and config field is empty/mismatched, persist it
  if (compose.source === 'auto' && config.composeProjectDir !== compose.projectDir) {
    config.composeProjectDir = compose.projectDir;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    console.log(`[AUTO-FILL] composeProjectDir=${compose.projectDir}`);
  }
  try {
    const content = fs.readFileSync(compose.composeFile, 'utf-8');
    res.json({
      available: true,
      container: compose.container,
      projectDir: compose.projectDir,
      composeFile: compose.composeFile,
      source: compose.source,
      content
    });
  } catch (err) {
    res.status(500).json({ available: false, reason: `读取文件失败: ${err.message}` });
  }
});
```

Verify that `CONFIG_FILE` is defined in the file. If not, search for `fs.writeFileSync` near the top — that line typically uses `CONFIG_FILE`. If the variable is named differently (e.g., `CONFIG_PATH`), use that name instead.

- [ ] **Step 2: Manual integration test**

Start the server in the background:
```bash
cd /home/uantek/dev/Applications/lmstudio-dashboard && node proxy/server.js > /tmp/server.log 2>&1 &
echo $! > /tmp/server.pid
sleep 2
```

Test (replace container name with the one in this dev env if different; default is `llamacppserver-mtp-llama-server-1`):
```bash
curl -s http://localhost:9234/api/compose-config | head -c 500
echo
echo "---"
cat proxy/config.json | grep composeProjectDir || echo "(no composeProjectDir yet)"
```

Expected: JSON with `available: true`, `source: "auto"`, `composeFile` pointing to the llama.cpp.server-mtp path, and `content` containing the YAML. The `config.json` should now have a `composeProjectDir` line (auto-filled on first call).

Stop the server:
```bash
kill $(cat /tmp/server.pid) 2>/dev/null; rm -f /tmp/server.pid
```

- [ ] **Step 3: Commit**

```bash
cd /home/uantek/dev/Applications/lmstudio-dashboard
git add proxy/server.js proxy/config.json
git commit -m "feat(api): GET /api/compose-config with lazy auto-fill"
```

---

### Task 4: Add `POST /api/compose-config` endpoint

**Files:**
- Modify: `proxy/server.js` (right after the GET endpoint added in Task 3)

- [ ] **Step 1: Add the POST endpoint**

Add immediately after the `app.get('/api/compose-config', ...)` handler:

```js
app.post('/api/compose-config', async (req, res) => {
  const { content } = req.body;
  if (typeof content !== 'string') return res.status(400).json({ error: 'content required' });

  const compose = await getComposeConfig();
  if (!compose) {
    return res.status(404).json({ available: false, reason: 'compose 配置不可用' });
  }

  // 1. YAML 语法校验
  try {
    yaml.load(content);
  } catch (e) {
    return res.status(400).json({ error: 'YAML 语法错误', detail: e.message });
  }

  // 2. 路径安全（防御性二次检查）
  if (/[;&|$`<>(){}]/.test(compose.projectDir)) {
    return res.status(400).json({ error: 'projectDir 含有非法字符' });
  }

  // 3. 写入（双引号包裹 projectDir，逃逸内嵌 "）
  try {
    const safeDir = '"' + compose.projectDir.replace(/"/g, '\\"') + '"';
    const b64 = Buffer.from(content, 'utf-8').toString('base64');
    await execAsync(`docker run --rm -i -v ${safeDir}:/target busybox sh -c 'echo ${b64} | base64 -d > /target/docker-compose.yml'`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 2: Manual integration test**

Start the server:
```bash
cd /home/uantek/dev/Applications/lmstudio-dashboard && node proxy/server.js > /tmp/server.log 2>&1 &
echo $! > /tmp/server.pid
sleep 2
```

Backup the original file (out of caution; the editor in real use replaces it, not appends):
```bash
cp /home/uantek/dev/llama.cpp.server-mtp/docker-compose.yml /tmp/docker-compose.bak
```

Test valid save (round-trip):
```bash
ORIGINAL=$(curl -s http://localhost:9234/api/compose-config | grep -o '"content":"[^"]*"' | head -c 200)
curl -s -X POST -H 'Content-Type: application/json' \
  -d "{\"content\":$(curl -s http://localhost:9234/api/compose-config | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)[\"content\"]))')}" \
  http://localhost:9234/api/compose-config
echo
diff /home/uantek/dev/llama.cpp.server-mtp/docker-compose.yml /tmp/docker-compose.bak && echo "ROUND-TRIP OK"
```

Test invalid YAML:
```bash
curl -s -w "\nHTTP %{http_code}\n" -X POST -H 'Content-Type: application/json' \
  -d '{"content":"services:\n  bad: [unclosed"}' \
  http://localhost:9234/api/compose-config
```

Expected:
- Round-trip: `{"success":true}` and `ROUND-TRIP OK`
- Invalid YAML: `{"error":"YAML 语法错误","detail":"..."}` and `HTTP 400`

Stop the server:
```bash
kill $(cat /tmp/server.pid) 2>/dev/null; rm -f /tmp/server.pid
rm -f /tmp/docker-compose.bak
```

- [ ] **Step 3: Commit**

```bash
cd /home/uantek/dev/Applications/lmstudio-dashboard
git add proxy/server.js
git commit -m "feat(api): POST /api/compose-config with YAML validation + safe write"
```

---

### Task 5: Extend `POST /api/config` to accept `composeProjectDir`

**Files:**
- Modify: `proxy/server.js` (in the `app.post('/api/config', ...)` handler, around line 1106-1180)

- [ ] **Step 1: Read the existing POST handler**

Find the `app.post('/api/config', ...)` block. It contains a series of `if (...)` blocks that validate and persist individual config fields (e.g., `inferenceContainer`, `inferencePort`).

- [ ] **Step 2: Add `composeProjectDir` handling**

Add a new block after the `inferencePort` handling (search for the line `config.inferencePort = port;` and add after the closing brace of that block):

```js
  if (composeProjectDir !== undefined) {
    if (typeof composeProjectDir !== 'string') {
      return res.status(400).json({ error: 'composeProjectDir 必须是字符串' });
    }
    const trimmed = composeProjectDir.trim();
    if (trimmed) {
      if (/[;&|$`<>(){}]/.test(trimmed)) {
        return res.status(400).json({ error: 'composeProjectDir 含有非法字符' });
      }
      config.composeProjectDir = trimmed;
    } else {
      delete config.composeProjectDir;
    }
  }
```

Also, near the top of the handler (where other fields are destructured from `req.body`), add:

```js
  const { composeProjectDir } = req.body;
```

Adjust placement as needed — match the existing destructuring style (some handlers use `const { ... } = req.body;` at the top, some inline).

- [ ] **Step 3: Manual integration test**

Start the server:
```bash
cd /home/uantek/dev/Applications/lmstudio-dashboard && node proxy/server.js > /tmp/server.log 2>&1 &
echo $! > /tmp/server.pid
sleep 2
```

Test save:
```bash
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"composeProjectDir":"/tmp/test-compose-dir"}' \
  http://localhost:9234/api/config
echo
cat proxy/config.json | grep composeProjectDir
```

Expected: response `{"success":true,...}` and `config.json` contains `"composeProjectDir": "/tmp/test-compose-dir"`.

Test invalid (special char):
```bash
curl -s -w "\nHTTP %{http_code}\n" -X POST -H 'Content-Type: application/json' \
  -d '{"composeProjectDir":"/tmp/foo;rm -rf /"}' \
  http://localhost:9234/api/config
```

Expected: `HTTP 400` and error message.

Test empty (clear):
```bash
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"composeProjectDir":""}' \
  http://localhost:9234/api/config
echo
cat proxy/config.json | grep composeProjectDir || echo "(cleared)"
```

Expected: success; `composeProjectDir` removed from `config.json`.

Reset to original state:
```bash
curl -s -X POST -H 'Content-Type: application/json' -d '{}' http://localhost:9234/api/config > /dev/null
# restore by deleting the field if it was set during Task 3 auto-fill
sed -i '/"composeProjectDir"/d' proxy/config.json
```

Stop the server:
```bash
kill $(cat /tmp/server.pid) 2>/dev/null; rm -f /tmp/server.pid
```

- [ ] **Step 4: Commit**

```bash
cd /home/uantek/dev/Applications/lmstudio-dashboard
git add proxy/server.js
git commit -m "feat(api): POST /api/config accepts composeProjectDir with safety check"
```

---

### Task 6: Add `composeProjectDir` field to Settings panel

**Files:**
- Modify: `dashboard.html:163` (after the URL preview line in the 模型设置 modal)

- [ ] **Step 1: Add the field HTML**

Find this block in `dashboard.html` (around line 162):
```html
            <p class="text-xs text-gray-500 mt-1">URL: <span id="inferenceUrlPreview" class="text-blue-400">http://...:1234</span>（自动派生）</p>
          </div>
```

Insert the new field between that `</p>` and `</div>`:

```html
            <label class="block text-sm text-gray-400 mb-2 mt-3">Compose 项目目录</label>
            <input type="text" id="composeProjectDir" placeholder="/path/to/docker-compose-dir"
                   class="w-full bg-gray-700 border border-gray-600 rounded-lg px-4 py-2 text-white focus:border-blue-500 focus:outline-none font-mono text-sm">
            <p class="text-xs text-gray-500 mt-1">
              备用路径：自动探测失败时使用。留空则「启动参数」按钮禁用。
              <span id="composeProjectDirStatus" class="text-gray-600"></span>
            </p>
```

- [ ] **Step 2: Update `loadConfig()` to populate the field**

Find the `loadConfig()` function (around line 1615-1625) and add this line near where `inferenceContainer`/`inferencePort` are populated:

```js
      document.getElementById('composeProjectDir').value = data.composeProjectDir || '';
```

- [ ] **Step 3: Update `saveConfig()` to include the field**

Find the `saveConfig()` function body. Locate where the `body` object is constructed (e.g., `const body = { ... }` or `const inferenceContainer = ...`). Add:

```js
      const composeProjectDir = document.getElementById('composeProjectDir').value.trim();
```

And add `composeProjectDir,` to the body object that gets sent in the POST.

- [ ] **Step 4: Add status-feedback function**

Find the end of `saveConfig()` (just before its closing brace) and add:

```js
      // Probe the new value to update status hint
      try {
        const probe = await fetch(`${API_BASE}/compose-config`);
        const probeData = await probe.json();
        const status = document.getElementById('composeProjectDirStatus');
        if (probeData.available) {
          status.textContent = `✓ 当前配置可用 (${probeData.source === 'auto' ? '自动探测' : '手动配置'})`;
          status.className = 'text-green-400';
        } else {
          status.textContent = '✗ 路径无效，自动探测亦不可用';
          status.className = 'text-red-400';
        }
      } catch (_) { /* ignore */ }
```

If `saveConfig` is not already `async`, add `async` to its declaration.

- [ ] **Step 5: Verify in browser**

Start the server:
```bash
cd /home/uantek/dev/Applications/lmstudio-dashboard && node proxy/server.js > /tmp/server.log 2>&1 &
echo $! > /tmp/server.pid
sleep 2
```

Open `http://localhost:9234` in a browser. Click 设置 → 模型设置. Confirm:
- "Compose 项目目录" field is visible below the URL preview
- Field is empty by default
- Save a path (e.g., `/tmp/foo`); status updates to "✓ 当前配置可用 (自动探测)" or "✗ 路径无效" depending on state
- Reload the page; the saved value persists

Stop the server:
```bash
kill $(cat /tmp/server.pid) 2>/dev/null; rm -f /tmp/server.pid
```

- [ ] **Step 6: Commit**

```bash
cd /home/uantek/dev/Applications/lmstudio-dashboard
git add dashboard.html
git commit -m "feat(ui): add composeProjectDir field to Settings panel"
```

---

### Task 7: Add "启动参数" button to 性能测试 panel + status probe

**Files:**
- Modify: `dashboard.html:434-439` (button row in 性能测试 modal)

- [ ] **Step 1: Add the button**

Find this block:
```html
          <button onclick="openModelTuning()" class="bg-yellow-600 hover:bg-yellow-700 px-4 py-2 rounded-lg text-sm transition h-fit">
            模型调整
          </button>
          <button onclick="reloadModel()" class="bg-red-600 hover:bg-red-700 px-4 py-2 rounded-lg text-sm transition h-fit">
            重载模型
          </button>
```

Insert a new button between them:

```html
          <button onclick="openModelTuning()" class="bg-yellow-600 hover:bg-yellow-700 px-4 py-2 rounded-lg text-sm transition h-fit">
            模型调整
          </button>
          <button id="composeConfigBtn" onclick="openComposeConfig()" disabled
                  class="bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-700 disabled:text-gray-500 disabled:cursor-not-allowed px-4 py-2 rounded-lg text-sm transition h-fit"
                  title="启动参数">
            启动参数
          </button>
          <button onclick="reloadModel()" class="bg-red-600 hover:bg-red-700 px-4 py-2 rounded-lg text-sm transition h-fit">
            重载模型
          </button>
```

- [ ] **Step 2: Add `loadComposeConfigStatus()` function**

Find the end of `openBenchmark()` (around line 2438) and add a call:

```js
      loadComposeConfigStatus();
```

Then add the function definition anywhere convenient near the other benchmark JS (e.g., after `openBenchmark`):

```js
    async function loadComposeConfigStatus() {
      const btn = document.getElementById('composeConfigBtn');
      try {
        const resp = await fetch(`${API_BASE}/compose-config`);
        const data = await resp.json();
        if (data.available) {
          btn.disabled = false;
          btn.title = data.source === 'auto'
            ? `启动参数（自动探测：${data.composeFile}）`
            : `启动参数（配置路径：${data.composeFile}）`;
        } else {
          btn.disabled = true;
          btn.title = data.reason || 'compose 配置不可用';
        }
      } catch (err) {
        btn.disabled = true;
        btn.title = '加载失败: ' + err.message;
      }
    }
```

- [ ] **Step 3: Verify in browser**

Start the server:
```bash
cd /home/uantek/dev/Applications/lmstudio-dashboard && node proxy/server.js > /tmp/server.log 2>&1 &
echo $! > /tmp/server.pid
sleep 2
```

Open `http://localhost:9234`, click 性能测试. Confirm:
- "启动参数" button is visible, indigo, between "模型调整" and "重载模型"
- Button is enabled (not greyed out)
- Hover the button: tooltip shows the docker-compose.yml absolute path

Stop the server:
```bash
kill $(cat /tmp/server.pid) 2>/dev/null; rm -f /tmp/server.pid
```

- [ ] **Step 4: Commit**

```bash
cd /home/uantek/dev/Applications/lmstudio-dashboard
git add dashboard.html
git commit -m "feat(ui): add 启动参数 button with availability probe"
```

---

### Task 8: Add compose config modal + open/close/load/save functions

**Files:**
- Modify: `dashboard.html:503` (after `modelConfigModal`)

- [ ] **Step 1: Add the modal HTML**

Find the end of the `modelConfigModal` div (just before `<!-- Cards Grid -->`) and add:

```html
    <!-- Compose Config Modal -->
    <div id="composeConfigModal" class="fixed inset-0 bg-black/50 hidden items-center justify-center z-50">
      <div class="bg-gray-800 rounded-xl p-6 w-full max-w-4xl mx-4 max-h-[85vh] flex flex-col">
        <div class="flex items-center justify-between mb-4">
          <h2 class="text-xl font-bold">🐳 启动参数 - <span id="composeConfigContainer" class="text-green-400"></span></h2>
          <button onclick="closeComposeConfig()" class="text-gray-400 hover:text-white text-2xl">&times;</button>
        </div>
        <div id="composeConfigLoading" class="text-center py-8 text-gray-400">加载中...</div>
        <div id="composeConfigEditor" class="hidden flex-1 flex flex-col min-h-0">
          <div class="text-xs text-gray-500 mb-2 flex items-center gap-2 flex-wrap">
            <span>文件: <code id="composeConfigPath" class="text-blue-400"></code></span>
            <span id="composeConfigSource" class="px-1.5 py-0.5 rounded text-[10px]"></span>
          </div>
          <div class="text-xs text-yellow-500 mb-2">⚠️ 修改需重启容器（点击"重载模型"按钮）才能生效。</div>
          <textarea id="composeConfigText" class="flex-1 bg-gray-900 border border-gray-700 rounded-lg p-3 text-xs font-mono text-green-300 resize-none scrollbar-thin min-h-[400px]"></textarea>
          <div id="composeConfigError" class="hidden mt-2 p-2 bg-red-900/30 border border-red-700 rounded text-xs text-red-300"></div>
          <div class="flex justify-end gap-3 mt-4">
            <button onclick="closeComposeConfig()" class="bg-gray-600 hover:bg-gray-700 px-4 py-2 rounded-lg text-sm transition">取消</button>
            <button id="composeConfigSaveBtn" onclick="saveComposeConfig()" class="bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded-lg text-sm transition">保存</button>
          </div>
        </div>
        <div id="composeConfigLoadError" class="hidden text-center py-8 text-red-400"></div>
      </div>
    </div>
```

- [ ] **Step 2: Add modal JS functions**

Add these functions after `loadComposeConfigStatus` (from Task 7):

```js
    function openComposeConfig() {
      document.getElementById('composeConfigModal').classList.remove('hidden');
      document.getElementById('composeConfigModal').classList.add('flex');
      document.getElementById('composeConfigLoading').classList.remove('hidden');
      document.getElementById('composeConfigEditor').classList.add('hidden');
      document.getElementById('composeConfigLoadError').classList.add('hidden');
      document.getElementById('composeConfigError').classList.add('hidden');
      document.body.style.overflow = 'hidden';
      loadComposeConfigContent();
    }

    function closeComposeConfig() {
      document.body.style.overflow = '';
      document.getElementById('composeConfigModal').classList.add('hidden');
      document.getElementById('composeConfigModal').classList.remove('flex');
    }

    async function loadComposeConfigContent() {
      try {
        const resp = await fetch(`${API_BASE}/compose-config`);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const data = await resp.json();
        if (!data.available) throw new Error(data.reason || '不可用');
        document.getElementById('composeConfigContainer').textContent = data.container;
        document.getElementById('composeConfigPath').textContent = data.composeFile;
        const srcBadge = document.getElementById('composeConfigSource');
        if (data.source === 'auto') {
          srcBadge.textContent = '自动探测';
          srcBadge.className = 'px-1.5 py-0.5 rounded text-[10px] bg-green-900/40 text-green-300';
        } else {
          srcBadge.textContent = '手动配置';
          srcBadge.className = 'px-1.5 py-0.5 rounded text-[10px] bg-blue-900/40 text-blue-300';
        }
        document.getElementById('composeConfigText').value = data.content;
        document.getElementById('composeConfigLoading').classList.add('hidden');
        document.getElementById('composeConfigEditor').classList.remove('hidden');
      } catch (err) {
        document.getElementById('composeConfigLoading').classList.add('hidden');
        document.getElementById('composeConfigLoadError').classList.remove('hidden');
        document.getElementById('composeConfigLoadError').textContent = '加载失败: ' + err.message;
      }
    }

    async function saveComposeConfig() {
      const content = document.getElementById('composeConfigText').value;
      const btn = document.getElementById('composeConfigSaveBtn');
      const errBox = document.getElementById('composeConfigError');
      errBox.classList.add('hidden');
      btn.disabled = true;
      btn.textContent = '保存中...';
      try {
        const resp = await fetch(`${API_BASE}/compose-config`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content })
        });
        const data = await resp.json();
        if (!resp.ok) {
          errBox.classList.remove('hidden');
          errBox.textContent = (data.error || '保存失败') + (data.detail ? ` — ${data.detail}` : '');
          return;
        }
        alert('保存成功！需要重载模型才能生效。');
        closeComposeConfig();
      } catch (err) {
        errBox.classList.remove('hidden');
        errBox.textContent = '保存失败: ' + err.message;
      } finally {
        btn.disabled = false;
        btn.textContent = '保存';
      }
    }
```

- [ ] **Step 3: Verify in browser**

Start the server:
```bash
cd /home/uantek/dev/Applications/lmstudio-dashboard && node proxy/server.js > /tmp/server.log 2>&1 &
echo $! > /tmp/server.pid
sleep 2
```

Open `http://localhost:9234` → 性能测试 → 启动参数. Confirm:
- Modal opens, loading state briefly visible
- Header: `🐳 启动参数 - llamacppserver-mtp-llama-server-1`
- File path: full absolute path to docker-compose.yml
- Source badge: green "自动探测" (or blue "手动配置" if user set one)
- Textarea populated with the YAML content
- Cancel closes the modal

Test invalid YAML save:
- Append a stray `:` to a line in the textarea
- Click 保存
- Confirm red error block appears at the bottom with the YAML error detail
- Confirm textarea content is preserved

Test valid save:
- Click 取消
- Reopen, click 保存 without modifying
- Confirm "保存成功" alert, modal closes
- `cat /home/uantek/dev/llama.cpp.server-mtp/docker-compose.yml` should be unchanged (round-trip)

Stop the server:
```bash
kill $(cat /tmp/server.pid) 2>/dev/null; rm -f /tmp/server.pid
```

- [ ] **Step 4: Commit**

```bash
cd /home/uantek/dev/Applications/lmstudio-dashboard
git add dashboard.html
git commit -m "feat(ui): add compose config modal with YAML validation feedback"
```

---

### Task 9: Update README.md

**Files:**
- Modify: `README.md` (the "性能测试 (Benchmark)" section, around line 105)

- [ ] **Step 1: Add a bullet for the new feature**

Find this block in `README.md`:
```markdown
- **模型调整**: 读写模型配置文件（models.ini），需重启模型生效
- **一键重载模型**: `docker restart` 重启 LLM 容器
- **测试中自动屏蔽外部请求**: 返回 503 "模型服务准备中"
```

Add a new bullet between "模型调整" and "一键重载模型":

```markdown
- **模型调整**: 读写模型配置文件（models.ini），需重启模型生效
- **启动参数**: 在线编辑 `docker-compose.yml`，自动定位到启动推理引擎容器的 compose 文件（也可在「设置」中手动指定 `composeProjectDir`）；保存后点击"重载模型"使新参数生效
- **一键重载模型**: `docker restart` 重启 LLM 容器
- **测试中自动屏蔽外部请求**: 返回 503 "模型服务准备中"
```

- [ ] **Step 2: Add the new API endpoint to the table**

Find the API table row for `/api/reload-model` and add a new row just before it:

```markdown
| GET/POST | `/api/compose-config` | 读写 docker-compose.yml |
| POST | `/api/reload-model` | 重启 LLM 容器重载模型 |
```

- [ ] **Step 3: Commit**

```bash
cd /home/uantek/dev/Applications/lmstudio-dashboard
git add README.md
git commit -m "docs: document compose-config endpoint and 启动参数 UI"
```

---

### Task 10: End-to-end manual integration test

**Files:** None (manual verification)

- [ ] **Step 1: Start the server fresh**

```bash
cd /home/uantek/dev/Applications/lmstudio-dashboard && node proxy/server.js > /tmp/server.log 2>&1 &
echo $! > /tmp/server.pid
sleep 2
```

- [ ] **Step 2: Verify auto-detect path**

```bash
curl -s http://localhost:9234/api/compose-config | python3 -c 'import json,sys; d=json.load(sys.stdin); print(f"available={d[\"available\"]} source={d[\"source\"]} file={d[\"composeFile\"]}")'
```

Expected: `available=True source=auto file=/home/uantek/dev/llama.cpp.server-mtp/docker-compose.yml` (or your local path).

- [ ] **Step 3: Verify config auto-fill**

```bash
grep composeProjectDir proxy/config.json
```

Expected: a line like `"composeProjectDir": "/home/uantek/dev/llama.cpp.server-mtp",`.

- [ ] **Step 4: Verify button enablement in browser**

Open `http://localhost:9234` → 性能测试. Confirm the "启动参数" button is enabled and indigo.

- [ ] **Step 5: Open editor, make a no-op save round-trip**

Open 启动参数 modal. Without changing content, click 保存. Confirm "保存成功" alert, modal closes.

Verify file unchanged:
```bash
md5sum /home/uantek/dev/llama.cpp.server-mtp/docker-compose.yml
```

- [ ] **Step 6: Test YAML error feedback**

Open modal, change `--port 1234` to `--port 1234 :bad:` (intentional syntax error), click 保存. Confirm red error block shows YAML parse error, modal stays open, content preserved. Click 取消 to close.

- [ ] **Step 7: Test invalid path config**

In 设置 panel, set `composeProjectDir` to `/nonexistent/path`. Save. Confirm status hint shows "✗ 路径无效". Reopen 性能测试 panel — "启动参数" button should be disabled.

- [ ] **Step 8: Restore working state**

In 设置, clear `composeProjectDir` (empty string) and save. Confirm status hint becomes "✓ 当前配置可用 (自动探测)". Reopen 性能测试 — button re-enabled.

- [ ] **Step 9: Stop server and final commit (if any test revealed issues)**

```bash
kill $(cat /tmp/server.pid) 2>/dev/null; rm -f /tmp/server.pid
```

If any fixes were needed during testing, commit them with `git commit -am "fix: <description>"`. Otherwise, no commit needed for this task.

---

## Self-Review Notes (already applied)

1. **Spec coverage** — all 7 spec sections map to tasks:
   - §1 配置模型 → Task 5
   - §2 后端 API (GET/POST) → Tasks 3, 4
   - §3 `getComposeConfig()` → Task 2
   - §4 前端 UI → Tasks 6, 7, 8
   - §5 数据流 → Task 10 (integration)
   - §6 错误处理 → covered by each task's error path + Task 10
   - §7 测试 → Task 10

2. **Placeholder scan** — no TBD/TODO markers; every code block is complete; every curl command has expected output.

3. **Type consistency** — `getComposeConfig()` is `async` everywhere; `composeProjectDir` is referenced consistently in `config` object, form input, and API body.
