# Inference-Container-Driven Downstream Views Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `inferenceContainer` the single source of truth that drives the real-time log, target-model dropdown, and `composeProjectDir` field, with real-time prefill in Settings before save.

**Architecture:** Server-side adds a `GET /api/models-ini` endpoint (host path primary, container `docker exec` fallback), extends `GET /api/compose-config` to accept `?container=` for pre-save preview, and makes `POST /api/config` auto-derive `composeProjectDir` when `inferenceContainer` changes and the field is omitted. Frontend adds a `change` handler on the `inferenceContainer` dropdown that previews the auto-derived value before save, and switches the target-model dropdown to use the new endpoint. Reusable `parseModelsIni()` helper is extracted. No test framework (manual `curl` integration tests, consistent with the codebase).

**Tech Stack:** Express.js (Node, ES modules), vanilla JS, Tailwind CSS (CDN), `child_process.execAsync` (existing), no new dependencies.

**Reference Spec:** `docs/superpowers/specs/2026-06-05-inference-container-sot-design.md`

**Previous related work:** `docs/superpowers/specs/2026-06-05-compose-startup-params-design.md` and its plan; the `启动参数` feature is already shipped on master.

**Commit hygiene (CRITICAL — learned from data loss in previous workstream):**
- **NEVER use `git reset --hard`** — destroys uncommitted work.
- **NEVER use `git stash drop` / `git stash clear`** without explicit user instruction.
- For each task, the working tree must be clean before starting (commit or stash any drift first).
- If something goes wrong mid-task, **stop and ask the user** — do not try to "fix" the worktree with `reset`/`checkout`.
- For multi-file changes within a task, commit them together in the final step; intermediate state should not be left dirty.

---

## File Map

| File | Responsibility |
|------|----------------|
| `proxy/server.js` | Add `parseModelsIni()`, `getModelsIni()`, `probeComposeDirOnly()`, new `GET /api/models-ini` endpoint, `?container=` on `GET /api/compose-config`, auto-derive on `POST /api/config` |
| `dashboard.html` | Add `inferenceContainer` change handler in Settings; add `composeProjectDir` input handler; switch target-model dropdown to `/api/models-ini`; add CSS for "已自动探测" badge |
| `README.md` | Document the new endpoint and linkage behavior |

No new files. No new dependencies. No test files (manual curl + browser verification).

---

### Task 1: Add `parseModelsIni()` utility

**Files:**
- Modify: `proxy/server.js` (after `getComposeConfig()`, around line 95)

- [ ] **Step 1: Add the function**

Find the end of `getComposeConfig()` (currently the closing `}` on the line after `return { ... source }`). The function ends right before `function loadApiKeys() {` (line 97). Insert the following block between them:

```js
function parseModelsIni(text) {
  const models = [];
  let current = null;
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      if (current) models.push(current);
      current = {
        id: sectionMatch[1] === '*' ? 'default' : sectionMatch[1],
        alias: null,
        ctxSize: null,
        model: null,
        extra: {}
      };
      continue;
    }
    if (!current) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim();
    const num = Number(value);
    const finalValue = (value !== '' && Number.isFinite(num) && /^-?\d+(\.\d+)?$/.test(value)) ? num : value;
    if (key === 'alias') current.alias = finalValue;
    else if (key === 'ctx-size') current.ctxSize = finalValue;
    else if (key === 'model') current.model = finalValue;
    else current.extra[key] = finalValue;
  }
  if (current) models.push(current);
  return models;
}
```

- [ ] **Step 2: Verify syntax**

Run:
```bash
cd /home/uantek/dev/Applications/lmstudio-dashboard && node -c proxy/server.js && echo SYNTAX_OK
```

Expected: `SYNTAX_OK`

- [ ] **Step 3: Commit**

```bash
cd /home/uantek/dev/Applications/lmstudio-dashboard
git add proxy/server.js
git commit -m "feat(api): add parseModelsIni() utility for models.ini INI parsing"
```

---

### Task 2: Add `getModelsIni()` data source selector

**Files:**
- Modify: `proxy/server.js` (after `parseModelsIni`, same block as Task 1)

- [ ] **Step 1: Add the function**

Add immediately after `parseModelsIni()`:

```js
async function getModelsIni() {
  const compose = await getComposeConfig();
  const container = getInferenceConfig().container;

  if (compose) {
    const hostPath = path.join(compose.projectDir, 'models.ini');
    try {
      const text = fs.readFileSync(hostPath, 'utf-8');
      return {
        source: 'host',
        projectDir: compose.projectDir,
        composeFile: compose.composeFile,
        models: parseModelsIni(text)
      };
    } catch (_) { /* fall through to container */ }
  }

  try {
    const safeName = container.replace(/[^a-zA-Z0-9_.-]/g, '');
    const { stdout } = await execAsync(`docker exec ${safeName} cat /app/models.ini`);
    return {
      source: 'container',
      projectDir: compose ? compose.projectDir : null,
      composeFile: compose ? compose.composeFile : null,
      models: parseModelsIni(stdout)
    };
  } catch (_) { /* fall through to missing */ }

  const reasonParts = [];
  if (!compose) reasonParts.push('未配置 composeProjectDir 且自动探测不可用');
  else reasonParts.push(`宿主路径 ${path.join(compose.projectDir, 'models.ini')} 不存在`);
  reasonParts.push(`容器 ${container} 未运行或无 /app/models.ini`);
  return {
    source: 'missing',
    reason: reasonParts.join('；'),
    models: []
  };
}
```

- [ ] **Step 2: Verify syntax**

```bash
cd /home/uantek/dev/Applications/lmstudio-dashboard && node -c proxy/server.js && echo SYNTAX_OK
```

Expected: `SYNTAX_OK`

- [ ] **Step 3: Commit**

```bash
cd /home/uantek/dev/Applications/lmstudio-dashboard
git add proxy/server.js
git commit -m "feat(api): add getModelsIni() data source selector"
```

---

### Task 3: Add `GET /api/models-ini` endpoint

**Files:**
- Modify: `proxy/server.js` (after the `GET /api/compose-config` block, around line 1845)

- [ ] **Step 1: Find the right insertion point**

After the `GET /api/compose-config` handler closes (the line that contains `res.json({` for compose-config response, followed by `});` and a blank line), and before the `POST /api/compose-config` handler, insert the new endpoint.

Read `proxy/server.js` starting at line 1822 (`app.get('/api/compose-config', ...)`) to find the closing `});` of that handler. Insert the new endpoint immediately after.

- [ ] **Step 2: Add the endpoint**

```js
app.get('/api/models-ini', async (req, res) => {
  try {
    const result = await getModelsIni();
    if (result.source === 'missing') {
      return res.status(200).json(result);
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ source: 'missing', reason: e.message, models: [] });
  }
});
```

- [ ] **Step 3: Smoke test**

Start a fresh server on port 9241 (avoid 9234 which may be occupied):
```bash
cd /home/uantek/dev/Applications/lmstudio-dashboard && PORT=9241 node proxy/server.js > /tmp/svr.log 2>&1 & echo $! > /tmp/svr.pid
sleep 1.5
curl -s http://localhost:9241/api/models-ini | python3 -c 'import json,sys; d=json.load(sys.stdin); print("source="+d.get("source","?"), "models="+str(len(d.get("models",[]))))'
kill $(cat /tmp/svr.pid) 2>/dev/null; rm -f /tmp/svr.pid
```

Expected output: `source=host models=N` (where N is the section count, e.g., 4) — or `source=container models=N` if host path is missing, or `source=missing models=0` if both fail.

If `source=missing` with reason text: investigate; the proxy should at least find the compose dir via `docker inspect` or the saved `config.composeProjectDir`.

- [ ] **Step 4: Commit**

```bash
cd /home/uantek/dev/Applications/lmstudio-dashboard
git add proxy/server.js
git commit -m "feat(api): add GET /api/models-ini endpoint"
```

---

### Task 4: Enhance `GET /api/compose-config` with `?container=` support

**Files:**
- Modify: `proxy/server.js` (the existing `GET /api/compose-config` handler, around line 1822)

- [ ] **Step 1: Read the current handler**

The current handler at line 1822:
```js
app.get('/api/compose-config', async (req, res) => {
  const compose = await getComposeConfig();
  if (!compose) {
    return res.status(404).json({ available: false, reason: '未找到 compose 标签或 composeProjectDir 配置' });
  }
  // Lazy auto-fill: only when auto-detect succeeded and the config field is empty.
  // User-set values are preserved — they can clear the field to trigger re-detection.
  if (compose.source === 'auto' && !config.composeProjectDir) {
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
  } catch (e) {
    res.status(500).json({ available: false, reason: '读取文件失败: ' + e.message });
  }
});
```

- [ ] **Step 2: Add `?container=` override**

Replace the entire handler with this version. The change: when `?container=X` is provided, build a fresh config view using that container (skipping `config.composeProjectDir` fallback), and **skip the lazy auto-fill** (auto-fill is for the saved container only):

```js
app.get('/api/compose-config', async (req, res) => {
  const overrideContainer = typeof req.query.container === 'string' ? req.query.container.trim() : '';
  let compose;
  if (overrideContainer) {
    compose = await probeComposeFor(overrideContainer);
    if (!compose) {
      return res.status(200).json({
        available: false,
        reason: `容器 ${overrideContainer} 反推失败：无 compose Labels 或 working_dir`
      });
    }
  } else {
    compose = await getComposeConfig();
    if (!compose) {
      return res.status(404).json({ available: false, reason: '未找到 compose 标签或 composeProjectDir 配置' });
    }
    // Lazy auto-fill: only when auto-detect succeeded and the config field is empty.
    // User-set values are preserved — they can clear the field to trigger re-detection.
    if (compose.source === 'auto' && !config.composeProjectDir) {
      config.composeProjectDir = compose.projectDir;
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
      console.log(`[AUTO-FILL] composeProjectDir=${compose.projectDir}`);
    }
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
  } catch (e) {
    res.status(500).json({ available: false, reason: '读取文件失败: ' + e.message });
  }
});
```

- [ ] **Step 3: Add the `probeComposeFor()` helper**

Add immediately after `getComposeConfig()` (or before — anywhere among the helper functions is fine). Place it directly after the closing `}` of `getComposeConfig()`:

```js
async function probeComposeFor(container) {
  const safeName = container.replace(/[^a-zA-Z0-9_.-]/g, '');
  try {
    const { stdout } = await execAsync(`docker inspect ${safeName} --format '{{json .Config.Labels}}'`);
    if (!stdout.trim()) return null;
    const labels = JSON.parse(stdout);
    const workingDir = labels['com.docker.compose.project.working_dir'];
    if (workingDir && !/[;&|$`<>(){}\\]/.test(workingDir)) {
      return {
        container,
        projectDir: workingDir,
        composeFile: path.join(workingDir, 'docker-compose.yml'),
        source: 'auto'
      };
    }
  } catch (_) { /* ignore */ }
  return null;
}
```

- [ ] **Step 4: Verify syntax**

```bash
cd /home/uantek/dev/Applications/lmstudio-dashboard && node -c proxy/server.js && echo SYNTAX_OK
```

Expected: `SYNTAX_OK`

- [ ] **Step 5: Smoke test the new query param**

```bash
cd /home/uantek/dev/Applications/lmstudio-dashboard && PORT=9242 node proxy/server.js > /tmp/svr.log 2>&1 & echo $! > /tmp/svr.pid
sleep 1.5
# Test 1: no query param — should use saved config
echo "=== default ==="
curl -s http://localhost:9242/api/compose-config | python3 -c 'import json,sys; d=json.load(sys.stdin); print("available="+str(d.get("available")), "source="+str(d.get("source")))'
# Test 2: with explicit container — should probe that container
echo "=== ?container=llamacppserver-llama-server-1 ==="
curl -s "http://localhost:9242/api/compose-config?container=llamacppserver-llama-server-1" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("available="+str(d.get("available")), "source="+str(d.get("source")), "projectDir="+str(d.get("projectDir")))'
# Test 3: nonexistent container
echo "=== ?container=nonexistent-xyz ==="
curl -s "http://localhost:9242/api/compose-config?container=nonexistent-xyz" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("available="+str(d.get("available")), "reason="+str(d.get("reason","")))'
kill $(cat /tmp/svr.pid) 2>/dev/null; rm -f /tmp/svr.pid
```

Expected: 3 lines, each describing its test case. Test 1 and 2 should show `available=True`; Test 3 should show `available=False` with a reason.

- [ ] **Step 6: Commit**

```bash
cd /home/uantek/dev/Applications/lmstudio-dashboard
git add proxy/server.js
git commit -m "feat(api): add ?container= override on GET /api/compose-config"
```

---

### Task 5: Auto-derive `composeProjectDir` in `POST /api/config`

**Files:**
- Modify: `proxy/server.js` (the `POST /api/config` handler, around lines 1166-1262)

- [ ] **Step 1: Read the current `inferenceChanged` block**

Read `proxy/server.js` from line 1176 to 1235. The relevant section is the `if (inferenceChanged) { ... }` block (lines 1232-1235 currently), which updates `lmStudioUrl`.

- [ ] **Step 2: Add auto-derive logic**

Replace the existing `if (inferenceChanged) { ... }` block (lines 1232-1235) with:

```js
  if (inferenceChanged) {
    const inf = getInferenceConfig();
    lmStudioUrl = inf.url;
    // Auto-derive composeProjectDir when the user changed container but did not
    // explicitly set composeProjectDir in this request. Empty string ("") and
    // undefined both leave the field alone unless a value is provided.
    if (composeProjectDir === undefined) {
      const probed = await probeComposeFor(inf.container);
      if (probed) {
        config.composeProjectDir = probed.projectDir;
        console.log(`[AUTO-DERIVE] composeProjectDir=${probed.projectDir} (from ${inf.container})`);
      }
    }
  }
```

This is a single, targeted change. The `inferenceChanged` block becomes async — the handler is already declared as `app.post('/api/config', (req, res) => {` but uses `await` via inner helpers; we need to make the handler `async` to allow `await probeComposeFor(...)`. Change line 1166 from:

```js
app.post('/api/config', (req, res) => {
```

to:

```js
app.post('/api/config', async (req, res) => {
```

- [ ] **Step 3: Verify syntax**

```bash
cd /home/uantek/dev/Applications/lmstudio-dashboard && node -c proxy/server.js && echo SYNTAX_OK
```

Expected: `SYNTAX_OK`

- [ ] **Step 4: Smoke test the three branches**

```bash
cd /home/uantek/dev/Applications/lmstudio-dashboard && PORT=9243 node proxy/server.js > /tmp/svr.log 2>&1 & echo $! > /tmp/svr.pid
sleep 1.5
cp proxy/config.json /tmp/cfg.bak
# Branch 1: change container, no composeProjectDir → auto-derive
echo "=== Branch 1: change container, no composeProjectDir ==="
curl -s -X POST -H 'Content-Type: application/json' -d '{"inferenceContainer":"llamacppserver-llama-server-1"}' http://localhost:9243/api/config
echo
grep composeProjectDir proxy/config.json
# Branch 2: change container, explicit composeProjectDir → respect
echo "=== Branch 2: change container, explicit composeProjectDir ==="
curl -s -X POST -H 'Content-Type: application/json' -d '{"inferenceContainer":"llamacppserver-llama-server-1","composeProjectDir":"/explicit/path"}' http://localhost:9243/api/config
echo
grep composeProjectDir proxy/config.json
# Branch 3: change container, empty composeProjectDir → clear
echo "=== Branch 3: change container, empty composeProjectDir ==="
curl -s -X POST -H 'Content-Type: application/json' -d '{"inferenceContainer":"llamacppserver-llama-server-1","composeProjectDir":""}' http://localhost:9243/api/config
echo
grep composeProjectDir proxy/config.json || echo "(cleared)"
# Restore
cp /tmp/cfg.bak proxy/config.json
rm /tmp/cfg.bak
kill $(cat /tmp/svr.pid) 2>/dev/null; rm -f /tmp/svr.pid
```

Expected:
- Branch 1: `composeProjectDir` is set to the auto-detected path
- Branch 2: `composeProjectDir` is `/explicit/path` (user value wins)
- Branch 3: `composeProjectDir` is cleared (empty string triggers delete)

- [ ] **Step 5: Commit**

```bash
cd /home/uantek/dev/Applications/lmstudio-dashboard
git add proxy/server.js
git commit -m "feat(api): auto-derive composeProjectDir when inferenceContainer changes"
```

---

### Task 6: Add `inferenceContainer` change handler in Settings

**Files:**
- Modify: `dashboard.html` (Settings panel container dropdown + script)

- [ ] **Step 1: Find the change listener**

In `dashboard.html`, find the existing `addEventListener('change', updateInferenceUrlPreview)` near line 1847. That listener is on `inferenceContainer`. We need to extend it (or replace it) to also call our new probe function.

- [ ] **Step 2: Replace the existing change listener**

Read the current code around line 1847 to see the exact block. The existing listener is:
```js
document.getElementById('inferenceContainer').addEventListener('change', updateInferenceUrlPreview);
```

Replace it with:
```js
document.getElementById('inferenceContainer').addEventListener('change', () => {
  updateInferenceUrlPreview();
  prefillComposeProjectDir();
});
```

- [ ] **Step 3: Add the `prefillComposeProjectDir` function**

Add the function right before `saveConfig()` (currently around line 1887). Insert this block:

```js
    async function prefillComposeProjectDir() {
      const container = document.getElementById('inferenceContainer').value;
      const input = document.getElementById('composeProjectDir');
      const status = document.getElementById('composeProjectDirStatus');
      if (!container) {
        input.value = '';
        input.dataset.source = 'none';
        status.textContent = '请先选择推理引擎容器';
        status.className = 'text-gray-500';
        return;
      }
      status.textContent = '正在反推 compose 目录...';
      status.className = 'text-gray-400';
      try {
        const r = await fetch(`${API_BASE}/compose-config?container=${encodeURIComponent(container)}`);
        const j = await r.json();
        if (j.available) {
          input.value = j.projectDir;
          input.dataset.source = 'auto';
          status.textContent = '✓ 已自动探测（可手动覆盖）';
          status.className = 'text-blue-400';
        } else {
          input.value = '';
          input.dataset.source = 'none';
          status.textContent = '✗ 未自动探测：' + (j.reason || '未知原因');
          status.className = 'text-yellow-400';
        }
      } catch (e) {
        status.textContent = '✗ 探测失败：' + e.message;
        status.className = 'text-red-400';
      }
    }
```

- [ ] **Step 4: Verify HTML still loads**

```bash
cd /home/uantek/dev/Applications/lmstudio-dashboard && PORT=9244 node proxy/server.js > /tmp/svr.log 2>&1 & echo $! > /tmp/svr.pid
sleep 1.5
curl -s http://localhost:9244/ | grep -c 'prefillComposeProjectDir'
kill $(cat /tmp/svr.pid) 2>/dev/null; rm -f /tmp/svr.pid
```

Expected: `1` (function name found in served HTML).

- [ ] **Step 5: Commit**

```bash
cd /home/uantek/dev/Applications/lmstudio-dashboard
git add dashboard.html
git commit -m "feat(ui): prefill composeProjectDir on inferenceContainer change"
```

---

### Task 7: Add `composeProjectDir` input manual-edit handler

**Files:**
- Modify: `dashboard.html` (script section)

- [ ] **Step 1: Add the input listener**

Add this block immediately after the `prefillComposeProjectDir` function from Task 6 (right before `saveConfig`):

```js
    document.getElementById('composeProjectDir').addEventListener('input', () => {
      const input = document.getElementById('composeProjectDir');
      const status = document.getElementById('composeProjectDirStatus');
      if (input.dataset.source === 'auto') {
        input.dataset.source = 'manual';
        status.textContent = '已手动修改（保存时覆盖自动值）';
        status.className = 'text-yellow-400';
      }
    });
```

- [ ] **Step 2: Verify HTML still loads**

```bash
cd /home/uantek/dev/Applications/lmstudio-dashboard && PORT=9245 node proxy/server.js > /tmp/svr.log 2>&1 & echo $! > /tmp/svr.pid
sleep 1.5
curl -s http://localhost:9245/ | grep -c "addEventListener('input'"
kill $(cat /tmp/svr.pid) 2>/dev/null; rm -f /tmp/svr.pid
```

Expected: `1` (the new listener is present).

- [ ] **Step 3: Commit**

```bash
cd /home/uantek/dev/Applications/lmstudio-dashboard
git add dashboard.html
git commit -m "feat(ui): mark composeProjectDir as manual when user edits"
```

---

### Task 8: Switch target-model dropdown to `GET /api/models-ini`

**Files:**
- Modify: `dashboard.html` (the `loadModels()` function around line 2942)

- [ ] **Step 1: Replace the fetch URL**

Read `dashboard.html` around line 2942. The current `loadModels()` is:

```js
    async function loadModels() {
      try {
        const resp = await fetch(`${API_BASE}/models`);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const json = await resp.json();
        const models = json.data || [];
        const tbody = document.getElementById('modelQueryList');
        if (models.length === 0) {
          tbody.innerHTML = '<tr><td colspan="4" class="text-center py-4 text-gray-500">暂无模型</td></tr>';
        } else {
          tbody.innerHTML = models.map(m => {
            const alias = (m.aliases || []).filter(a => a !== m.id).join(', ') || '-';
            const ctx = parseCtxSize(m.status && m.status.args);
            const type = getModelType(m);
            return '<tr class="border-b border-gray-700/50 hover:bg-gray-700/30">'
              + '<td class="py-2 px-3 text-white">' + escapeHtml(m.id) + '</td>'
              + '<td class="py-2 px-3 text-gray-300">' + escapeHtml(alias) + '</td>'
              + '<td class="py-2 px-3"><span class="px-2 py-0.5 rounded text-xs bg-gray-700 text-gray-300">' + escapeHtml(type) + '</td>'
              + '<td class="py-2 px-3 text-right text-blue-400">' + ctx + '</td>'
              + '</tr>';
          }).join('');
        }
        document.getElementById('modelQueryLoading').classList.add('hidden');
        document.getElementById('modelQueryContent').classList.remove('hidden');
      } catch (err) {
        document.getElementById('modelQueryLoading').classList.add('hidden');
        document.getElementById('modelQueryError').classList.remove('hidden');
        document.getElementById('modelQueryError').textContent = '加载失败: ' + err.message;
      }
    }
```

Replace it with the new version. The new version calls `/api/models-ini`, formats `ctxSize` inline, and shows a clearer error message:

```js
    function formatCtxSize(n) {
      if (n == null) return '-';
      if (n >= 1024) return Math.round(n / 1024) + 'K';
      return String(n);
    }

    function getModelTypeIni(model) {
      const id = (model.id || '').toLowerCase();
      const alias = (model.alias || '').toLowerCase();
      const combined = id + ' ' + alias;
      if (/embed|rerank/.test(combined)) return '嵌入';
      if (/summarize|summary/.test(combined)) return '摘要';
      return '文本生成';
    }

    async function loadModels() {
      try {
        const resp = await fetch(`${API_BASE}/models-ini`);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const json = await resp.json();
        if (json.source === 'missing') {
          throw new Error(json.reason || '未找到 models.ini');
        }
        const models = json.models || [];
        const tbody = document.getElementById('modelQueryList');
        if (models.length === 0) {
          tbody.innerHTML = '<tr><td colspan="4" class="text-center py-4 text-gray-500">暂无模型</td></tr>';
        } else {
          tbody.innerHTML = models.map(m => {
            const alias = m.alias || '-';
            const ctx = formatCtxSize(m.ctxSize);
            const type = getModelTypeIni(m);
            return '<tr class="border-b border-gray-700/50 hover:bg-gray-700/30">'
              + '<td class="py-2 px-3 text-white">' + escapeHtml(m.id) + '</td>'
              + '<td class="py-2 px-3 text-gray-300">' + escapeHtml(alias) + '</td>'
              + '<td class="py-2 px-3"><span class="px-2 py-0.5 rounded text-xs bg-gray-700 text-gray-300">' + escapeHtml(type) + '</span></td>'
              + '<td class="py-2 px-3 text-right text-blue-400">' + ctx + '</td>'
              + '</tr>';
          }).join('');
        }
        document.getElementById('modelQueryLoading').classList.add('hidden');
        document.getElementById('modelQueryContent').classList.remove('hidden');
      } catch (err) {
        document.getElementById('modelQueryLoading').classList.add('hidden');
        document.getElementById('modelQueryError').classList.remove('hidden');
        document.getElementById('modelQueryError').textContent = '加载失败：' + err.message + '（请确认设置面板已选择推理引擎容器）';
      }
    }
```

- [ ] **Step 2: Verify HTML still loads**

```bash
cd /home/uantek/dev/Applications/lmstudio-dashboard && PORT=9246 node proxy/server.js > /tmp/svr.log 2>&1 & echo $! > /tmp/svr.pid
sleep 1.5
curl -s http://localhost:9246/ | grep -c 'formatCtxSize'
kill $(cat /tmp/svr.pid) 2>/dev/null; rm -f /tmp/svr.pid
```

Expected: `1`.

- [ ] **Step 3: Commit**

```bash
cd /home/uantek/dev/Applications/lmstudio-dashboard
git add dashboard.html
git commit -m "feat(ui): load target-model list from host-side models.ini"
```

---

### Task 9: Update README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add the new endpoint row**

Find the API table in `README.md` and the row for `GET/POST` `/api/compose-config` (added by the previous spec). Immediately after that row, add:

```markdown
| GET | `/api/models-ini` | 列出 docker-compose 项目目录下的 models.ini 中配置的模型 |
```

- [ ] **Step 2: Update the Settings feature description**

Find the "设置 (Settings)" section in `README.md`. Add or update a bullet describing the linkage:

```markdown
- **推理引擎容器联动**: 切换容器后实时反推 compose 目录、跟随容器日志、刷新目标模型列表（无需重启 dashboard）
```

If there's no existing "设置" section header, add a new section before the API table.

- [ ] **Step 3: Commit**

```bash
cd /home/uantek/dev/Applications/lmstudio-dashboard
git add README.md
git commit -m "docs: document /api/models-ini and container-driven linkage"
```

---

### Task 10: End-to-end integration test

**Files:**
- Read-only verification of the running system. No file changes.

- [ ] **Step 1: Start a clean server**

```bash
cd /home/uantek/dev/Applications/lmstudio-dashboard && PORT=9247 node proxy/server.js > /tmp/svr.log 2>&1 & echo $! > /tmp/svr.pid
sleep 1.5
```

If 9247 is taken, try 9248, 9249, etc.

- [ ] **Step 2: Test `GET /api/models-ini` (3 branches)**

```bash
echo "=== host (preferred) ==="
curl -s http://localhost:9247/api/models-ini | python3 -c 'import json,sys; d=json.load(sys.stdin); print("source="+d["source"], "models="+str(len(d["models"])), "first="+str(d["models"][0]["id"] if d["models"] else None))'

echo "=== empty container selection (should still work via saved config) ==="
# Skip — the endpoint always uses the saved container
echo "(skipped — endpoint always uses saved container)"

echo "=== missing (force by removing composeProjectDir) ==="
cp proxy/config.json /tmp/cfg.bak
# Set inferenceContainer to one that doesn't exist for compose
curl -s -X POST -H 'Content-Type: application/json' -d '{"inferenceContainer":"definitely-not-a-real-container-xyz","composeProjectDir":""}' http://localhost:9247/api/config > /dev/null
curl -s http://localhost:9247/api/models-ini | python3 -c 'import json,sys; d=json.load(sys.stdin); print("source="+d["source"], "reason="+(d.get("reason","")[:80]))'
cp /tmp/cfg.bak proxy/config.json
rm /tmp/cfg.bak
```

Expected: host path shows `source=host models=N` (N≥1). Missing branch shows `source=missing` with a non-empty reason.

- [ ] **Step 3: Test `?container=` on compose-config**

```bash
echo "=== ?container= with valid ==="
curl -s "http://localhost:9247/api/compose-config?container=llamacppserver-llama-server-1" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("available="+str(d["available"]), "source="+str(d.get("source")))'

echo "=== ?container= with invalid ==="
curl -s "http://localhost:9247/api/compose-config?container=invalid-xyz" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("available="+str(d["available"]), "reason="+d.get("reason",""))'
```

Expected: valid → `available=True source=auto` (or `config` if saved). invalid → `available=False reason=<...>`.

- [ ] **Step 4: Test `POST /api/config` auto-derive (3 branches)**

```bash
cp proxy/config.json /tmp/cfg.bak
echo "=== Branch 1: change container, no composeProjectDir ==="
curl -s -X POST -H 'Content-Type: application/json' -d '{"inferenceContainer":"llamacppserver-llama-server-1"}' http://localhost:9247/api/config > /dev/null
grep composeProjectDir proxy/config.json
echo "=== Branch 2: change container, explicit value ==="
curl -s -X POST -H 'Content-Type: application/json' -d '{"inferenceContainer":"llamacppserver-llama-server-1","composeProjectDir":"/explicit"}' http://localhost:9247/api/config > /dev/null
grep composeProjectDir proxy/config.json
echo "=== Branch 3: change container, empty string ==="
curl -s -X POST -H 'Content-Type: application/json' -d '{"inferenceContainer":"llamacppserver-llama-server-1","composeProjectDir":""}' http://localhost:9247/api/config > /dev/null
grep composeProjectDir proxy/config.json || echo "(cleared)"
cp /tmp/cfg.bak proxy/config.json
rm /tmp/cfg.bak
```

Expected:
- Branch 1: auto-detected path set
- Branch 2: `/explicit`
- Branch 3: `(cleared)`

- [ ] **Step 5: Verify dashboard.html has all the new functions**

```bash
curl -s http://localhost:9247/ > /tmp/served.html
for fn in prefillComposeProjectDir formatCtxSize getModelTypeIni; do
  echo -n "$fn: "
  grep -c "function $fn\| $fn =" /tmp/served.html
done
grep -c "addEventListener('input'" /tmp/served.html
```

Expected: 1 for each function name, 1 for the input listener.

- [ ] **Step 6: Stop server and verify commit log**

```bash
kill $(cat /tmp/svr.pid) 2>/dev/null; rm -f /tmp/svr.pid
cd /home/uantek/dev/Applications/lmstudio-dashboard
git log --oneline e394e45..HEAD
git status
```

Expected: 9 implementation commits (Tasks 1-9) on top of the spec. Working tree clean except possibly `proxy/logs/current.json` (runtime artifact).

- [ ] **Step 7: Final report to user**

Report:
- All 6 test steps passed
- The user should restart their dev server on port 9234 to pick up the new code
- The user should manually verify the browser UI: open Settings, change the inference container dropdown, watch the composeProjectDir field prefill, save, and confirm the target-model dropdown shows the new list
- The current HEAD includes the spec doc + 9 implementation commits; branch is N+9 commits ahead of `origin/master`

---

## Self-Review Checklist

Run after writing the plan; fix issues inline.

- [x] **Spec coverage:** Each section in the spec maps to a task:
  - §1 (反推关系图) → conceptual, no code
  - §2.1 (GET /api/models-ini) → Tasks 2 + 3
  - §2.2 (parseModelsIni) → Task 1
  - §2.3 (?container= on compose-config) → Task 4
  - §2.4 (POST /api/config auto-derive) → Task 5
  - §3.1 (Settings change handler) → Tasks 6 + 7
  - §3.2 (target-model dropdown) → Task 8
  - §3.3 (live log) → "no change" (noted in spec §3.3)
  - §7 (out of scope) → not in plan (intentional)
  - §8 (testing) → Task 10
  - §9 (plan) → this document

- [x] **Placeholder scan:** No "TBD", "TODO", "implement later", "fill in details", or "add appropriate error handling" without specifics. Every code step has the actual code.

- [x] **Type/signature consistency:**
  - `parseModelsIni(text)` defined in Task 1, used in Task 2 → consistent
  - `getModelsIni()` defined in Task 2, returns `{source, projectDir?, composeFile?, models, reason?}` → used in Task 3 endpoint → consistent
  - `probeComposeFor(container)` defined in Task 4, used in Tasks 4 and 5 → consistent
  - `prefillComposeProjectDir()` defined in Task 6, called from change listener → consistent
  - `formatCtxSize(n)` and `getModelTypeIni(model)` defined in Task 8, both used in `loadModels` → consistent
  - Function names in `dashboard.html` match the implementation tasks
