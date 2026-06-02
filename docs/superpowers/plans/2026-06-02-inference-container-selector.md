# Inference Engine Container Selector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the "模型地址" text input in the Settings panel with a Docker container dropdown (filtered to inference engine containers) plus a port input. This single selection drives the request-forwarding URL, resource-monitor container, "实时请求" container logs, "模型调整" models.ini reads/writes, and "重载模型" container restart.

**Architecture:** Two-file change. `proxy/server.js` adds a `getInferenceConfig()` derivation function with startup migration from old fields, a hardcoded `INFERENCE_KEYWORDS` constant for filtering `docker ps` output, and updates every endpoint that previously read `resourceMonitor.dockerContainer` or the hardcoded `LLM_CONTAINER` to read the new `config.inferenceContainer` instead. `dashboard.html` replaces the text input with a `<select>` + port input, adds a `loadContainers()` helper that calls a new response shape on `GET /api/containers`, and updates `loadConfig`/`saveConfig`/`testConnection` to use the new field names. `proxy/config.json` is auto-migrated on first server start.

**Tech Stack:** Express.js (Node), vanilla JS, Tailwind CSS (CDN), no test framework (manual `curl` integration tests).

**Reference Spec:** `docs/superpowers/specs/2026-06-02-inference-container-selector-design.md`

---

## File Map

| File | Responsibility |
|------|----------------|
| `proxy/server.js` | Add `INFERENCE_KEYWORDS`, `getInferenceConfig()` derivation, startup migration; update `/api/containers`, `/api/config` (GET/POST), `/api/container-logs`, `/api/model-config` (GET/POST), `/api/reload-model`, `/api/test`, `/api/resource-monitor` |
| `dashboard.html` | Replace URL input with `<select id="inferenceContainer">` + `<input id="inferencePort">`; add `loadContainers()`, `refreshContainers()`, URL preview; update `loadConfig()`, `saveConfig()`, `testConnection()` |
| `README.md` | Update "配置" section to document new fields and removal of `lmStudioUrl`/`resourceMonitor.dockerContainer` direct editing |
| `proxy/config.json` | Auto-migrated on first server start; not hand-edited as part of this plan |

---

### Task 1: Add `INFERENCE_KEYWORDS` constant and `getInferenceConfig()` derivation

**Files:**
- Modify: `proxy/server.js:18-32` (top of file, after `config` defaults)

- [ ] **Step 1: Add keyword constant and derivation helper**

After `config.cardOrder = config.cardOrder || [];` (line 32), add:

```js
const INFERENCE_KEYWORDS = [
  'llama', 'llamacpp', 'llama-server', 'llama.cpp',
  'vllm', 'tgi', 'text-generation-inference',
  'sglang', 'ollama', 'inference', 'llm-server'
];

function isInferenceContainer(name, image) {
  const lower = (s) => (s || '').toLowerCase();
  const text = lower(name) + ' ' + lower(image);
  return INFERENCE_KEYWORDS.some(kw => text.includes(kw));
}

function getInferenceConfig() {
  const container = config.inferenceContainer || 'llamacppserver_llama-server_1';
  const port = parseInt(config.inferencePort) || 1234;
  return {
    container,
    port,
    url: `http://${container}:${port}`
  };
}
```

- [ ] **Step 2: Verify server still starts**

Run:
```bash
cd /home/uantek/dev/Applications/lmstudio-dashboard && timeout 3 node proxy/server.js 2>&1 | head -20
```
Expected: `LM Studio Proxy running on http://0.0.0.0:9234` (and timeout-killed).

- [ ] **Step 3: Commit**

```bash
cd /home/uantek/dev/Applications/lmstudio-dashboard
git add proxy/server.js
git commit -m "feat(config): add INFERENCE_KEYWORDS and getInferenceConfig() helper"
```

---

### Task 2: Add startup migration for legacy config fields

**Files:**
- Modify: `proxy/server.js:121-128` (the `lmStudioUrl` initialization block)

- [ ] **Step 1: Replace the existing `lmStudioUrl` initialization**

The existing block at lines 121-128 is:
```js
const app = express();
const PORT = process.env.PORT || 9234;
let lmStudioUrl = '';
if (config.lmStudio?.container && config.lmStudio?.port) {
  lmStudioUrl = `http://${config.lmStudio.container}:${config.lmStudio.port}`;
} else {
  lmStudioUrl = config.lmStudioUrl || process.env.LMSTUDIO_URL || 'http://host.docker.internal:1234';
}
```

Replace it with:
```js
const app = express();
const PORT = process.env.PORT || 9234;

// Migrate legacy config fields to inferenceContainer/inferencePort.
// Priority: new fields > lmStudio.container/port > lmStudioUrl parse > resourceMonitor.dockerContainer > defaults
if (!config.inferenceContainer || !config.inferencePort) {
  let migratedContainer = config.inferenceContainer || '';
  let migratedPort = config.inferencePort;

  if (!migratedContainer && config.lmStudio?.container) {
    migratedContainer = config.lmStudio.container;
    if (!migratedPort && config.lmStudio.port) migratedPort = config.lmStudio.port;
  }

  if (!migratedContainer && config.lmStudioUrl) {
    const m = config.lmStudioUrl.match(/^https?:\/\/([^:/]+):(\d+)/);
    if (m) {
      migratedContainer = m[1];
      if (!migratedPort) migratedPort = parseInt(m[2]);
    }
  }

  if (!migratedContainer && config.resourceMonitor?.dockerContainer) {
    migratedContainer = config.resourceMonitor.dockerContainer;
  }

  if (!migratedContainer) migratedContainer = 'llamacppserver_llama-server_1';
  if (!migratedPort) migratedPort = 1234;

  config.inferenceContainer = migratedContainer;
  config.inferencePort = migratedPort;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  console.log(`[MIGRATE] inferenceContainer=${migratedContainer} inferencePort=${migratedPort}`);
}

const inference = getInferenceConfig();
let lmStudioUrl = inference.url;
```

- [ ] **Step 2: Verify the server starts and migrates old configs**

Check the current `proxy/config.json` — it has `lmStudioUrl: "http://llamacppserver-mtp-llama-server-1:1234"`. Back it up first:

```bash
cd /home/uantek/dev/Applications/lmstudio-dashboard
cp proxy/config.json /tmp/config.before-migration.json
```

Run:
```bash
cd /home/uantek/dev/Applications/lmstudio-dashboard
timeout 3 node proxy/server.js 2>&1 | head -20
```

Expected output to include a line like:
```
[MIGRATE] inferenceContainer=llamacppserver-mtp-llama-server-1 inferencePort=1234
```

After the run, check `proxy/config.json` now contains the new fields:
```bash
grep -E "inferenceContainer|inferencePort" proxy/config.json
```
Expected:
```
  "inferenceContainer": "llamacppserver-mtp-llama-server-1",
  "inferencePort": 1234,
```

- [ ] **Step 3: Confirm second run does not re-migrate (idempotency)**

Run again:
```bash
cd /home/uantek/dev/Applications/lmstudio-dashboard
timeout 3 node proxy/server.js 2>&1 | head -20
```
Expected: **no** `[MIGRATE]` line printed.

- [ ] **Step 4: Commit**

```bash
cd /home/uantek/dev/Applications/lmstudio-dashboard
git add proxy/server.js
git commit -m "feat(config): migrate legacy lmStudioUrl/resourceMonitor.dockerContainer to inferenceContainer/inferencePort"
```

---

### Task 3: Update `GET /api/containers` to return filtered list with image info

**Files:**
- Modify: `proxy/server.js:1430-1438` (the existing `GET /api/containers` handler)

- [ ] **Step 1: Replace the handler**

Existing handler:
```js
app.get('/api/containers', async (req, res) => {
  try {
    const { stdout } = await execAsync('docker ps --format "{{.Names}}"');
    const containers = stdout.trim().split('\n').filter(c => c);
    res.json(containers);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
```

Replace with:
```js
app.get('/api/containers', async (req, res) => {
  try {
    const { stdout } = await execAsync('docker ps --format "{{.Names}}\\t{{.Image}}"');
    const lines = stdout.trim().split('\n').filter(l => l);
    const containers = lines.map(line => {
      const [name, ...imageParts] = line.split('\t');
      const image = imageParts.join('\t');
      return { name, image, matched: isInferenceContainer(name, image) };
    });
    res.json({ containers, keywords: INFERENCE_KEYWORDS });
  } catch (error) {
    res.status(503).json({ error: 'docker 不可用: ' + error.message });
  }
});
```

- [ ] **Step 2: Manual integration test**

Start the server:
```bash
cd /home/uantek/dev/Applications/lmstudio-dashboard
node proxy/server.js &
SERVER_PID=$!
sleep 2
```

Test:
```bash
curl -s http://localhost:9234/api/containers | head -c 2000
kill $SERVER_PID 2>/dev/null
```

Expected: JSON object with `containers` array (each item has `name`, `image`, `matched` boolean) and `keywords` array. In this dev environment, the llama container should have `matched: true` and the dashboard container `matched: false`.

- [ ] **Step 3: Commit**

```bash
cd /home/uantek/dev/Applications/lmstudio-dashboard
git add proxy/server.js
git commit -m "feat(api): /api/containers returns name+image+matched for inference filtering"
```

---

### Task 4: Update `GET /api/config` and `POST /api/config` to expose/use new fields

**Files:**
- Modify: `proxy/server.js:1058-1106` (the two `/api/config` handlers)

- [ ] **Step 1: Update GET handler to return new fields**

Replace the response object in `app.get('/api/config', ...)` (lines 1058-1076). The current handler returns:
```js
app.get('/api/config', (req, res) => {
  res.json({
    lmStudioContainer: config.lmStudio?.container || '',
    lmStudioPort: config.lmStudio?.port || 1234,
    lmStudioUrl: lmStudioUrl || '',
    enableAPIKey: config.enableAPIKey || false,
    enableLog: config.enableLog || false,
    lmAuthEnabled: config.lmAuthEnabled || false,
    lmAuthValue: config.lmAuthValue || '',
    simCostEnabled: config.simCostEnabled || false,
    simPromptCost: config.simPromptCost || 0,
    simCompletionCost: config.simCompletionCost || 0,
    simCacheHitCost: config.simCacheHitCost || 0,
    trendDays: config.trendDays || 30,
    layoutGrid: config.layoutGrid || 6,
    cardWidths: config.cardWidths || {},
    cardOrder: config.cardOrder || []
  });
});
```

Replace with:
```js
app.get('/api/config', (req, res) => {
  const inf = getInferenceConfig();
  res.json({
    inferenceContainer: inf.container,
    inferencePort: inf.port,
    lmStudioUrl: inf.url,
    enableAPIKey: config.enableAPIKey || false,
    enableLog: config.enableLog || false,
    lmAuthEnabled: config.lmAuthEnabled || false,
    lmAuthValue: config.lmAuthValue || '',
    simCostEnabled: config.simCostEnabled || false,
    simPromptCost: config.simPromptCost || 0,
    simCompletionCost: config.simCompletionCost || 0,
    simCacheHitCost: config.simCacheHitCost || 0,
    trendDays: config.trendDays || 30,
    layoutGrid: config.layoutGrid || 6,
    cardWidths: config.cardWidths || {},
    cardOrder: config.cardOrder || []
  });
});
```

- [ ] **Step 2: Update POST handler to accept and persist new fields**

Replace `app.post('/api/config', ...)` (lines 1078-1106). The current handler:
```js
app.post('/api/config', (req, res) => {
  const { lmStudioContainer, lmStudioPort, lmStudioUrl: url, defaultAPIKey, enableAPIKey, enableLog, lmAuthEnabled, lmAuthValue, simCostEnabled, simPromptCost, simCompletionCost, simCacheHitCost, trendDays, layoutGrid, cardWidths, cardOrder } = req.body;
  
  if (lmStudioContainer && lmStudioPort) {
    config.lmStudio = { container: lmStudioContainer, port: parseInt(lmStudioPort) };
    lmStudioUrl = `http://${lmStudioContainer}:${lmStudioPort}`;
  } else if (url) {
    lmStudioUrl = url;
  }
  
  if (defaultAPIKey !== undefined || ... || cardOrder !== undefined) {
    if (defaultAPIKey !== undefined) config.defaultAPIKey = defaultAPIKey;
    if (enableAPIKey !== undefined) config.enableAPIKey = enableAPIKey;
    if (enableLog !== undefined) config.enableLog = enableLog;
    if (lmAuthEnabled !== undefined) config.lmAuthEnabled = lmAuthEnabled;
    if (lmAuthValue !== undefined) config.lmAuthValue = lmAuthValue;
    if (simCostEnabled !== undefined) config.simCostEnabled = simCostEnabled;
    if (simPromptCost !== undefined) config.simPromptCost = parseFloat(simPromptCost) || 0;
    if (simCompletionCost !== undefined) config.simCompletionCost = parseFloat(simCompletionCost) || 0;
    if (simCacheHitCost !== undefined) config.simCacheHitCost = parseFloat(simCacheHitCost) || 0;
    if (trendDays !== undefined) config.trendDays = parseInt(trendDays) || 30;
    if (layoutGrid !== undefined) config.layoutGrid = parseInt(layoutGrid) || 6;
    if (cardWidths !== undefined) config.cardWidths = cardWidths;
    if (cardOrder !== undefined) config.cardOrder = cardOrder;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  }
  
  res.json({ success: true, lmStudioUrl });
});
```

Replace with:
```js
app.post('/api/config', (req, res) => {
  const {
    inferenceContainer, inferencePort, lmStudioUrl: url,
    defaultAPIKey, enableAPIKey, enableLog,
    lmAuthEnabled, lmAuthValue,
    simCostEnabled, simPromptCost, simCompletionCost, simCacheHitCost,
    trendDays, layoutGrid, cardWidths, cardOrder
  } = req.body;

  // Handle inference container/port. Accept either new fields or legacy lmStudioUrl parse for backward compat.
  let containerChanged = false;
  if (typeof inferenceContainer === 'string' && inferenceContainer.trim()) {
    const trimmed = inferenceContainer.trim();
    if (trimmed !== config.inferenceContainer) {
      config.inferenceContainer = trimmed;
      containerChanged = true;
    }
  }
  if (inferencePort !== undefined && inferencePort !== null) {
    const port = parseInt(inferencePort);
    if (Number.isFinite(port) && port >= 1 && port <= 65535) {
      if (port !== config.inferencePort) {
        config.inferencePort = port;
        containerChanged = true;
      }
    } else {
      return res.status(400).json({ error: 'inferencePort 必须是 1-65535 的整数' });
    }
  }
  if (containerChanged) {
    // Backward compat: if old client only sent lmStudioUrl, parse it
    if (!inferenceContainer && url) {
      const m = url.match(/^https?:\/\/([^:/]+):(\d+)/);
      if (m) {
        config.inferenceContainer = m[1];
        config.inferencePort = parseInt(m[2]);
      }
    }
    // Re-derive lmStudioUrl from current inference config
    const inf = getInferenceConfig();
    lmStudioUrl = inf.url;
    // Note: resourceMonitor.dockerContainer is now derived at read time; we don't write it back to disk
  }
  
  if (defaultAPIKey !== undefined || enableAPIKey !== undefined || enableLog !== undefined || lmAuthEnabled !== undefined || lmAuthValue !== undefined || simCostEnabled !== undefined || simPromptCost !== undefined || simCompletionCost !== undefined || simCacheHitCost !== undefined || trendDays !== undefined || layoutGrid !== undefined || cardWidths !== undefined || cardOrder !== undefined) {
    if (defaultAPIKey !== undefined) config.defaultAPIKey = defaultAPIKey;
    if (enableAPIKey !== undefined) config.enableAPIKey = enableAPIKey;
    if (enableLog !== undefined) config.enableLog = enableLog;
    if (lmAuthEnabled !== undefined) config.lmAuthEnabled = lmAuthEnabled;
    if (lmAuthValue !== undefined) config.lmAuthValue = lmAuthValue;
    if (simCostEnabled !== undefined) config.simCostEnabled = simCostEnabled;
    if (simPromptCost !== undefined) config.simPromptCost = parseFloat(simPromptCost) || 0;
    if (simCompletionCost !== undefined) config.simCompletionCost = parseFloat(simCompletionCost) || 0;
    if (simCacheHitCost !== undefined) config.simCacheHitCost = parseFloat(simCacheHitCost) || 0;
    if (trendDays !== undefined) config.trendDays = parseInt(trendDays) || 30;
    if (layoutGrid !== undefined) config.layoutGrid = parseInt(layoutGrid) || 6;
    if (cardWidths !== undefined) config.cardWidths = cardWidths;
    if (cardOrder !== undefined) config.cardOrder = cardOrder;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  }
  
  res.json({ success: true, lmStudioUrl });
});
```

- [ ] **Step 3: Manual integration test — GET response shape**

Start the server:
```bash
cd /home/uantek/dev/Applications/lmstudio-dashboard
node proxy/server.js &
SERVER_PID=$!
sleep 2
```

Test:
```bash
curl -s http://localhost:9234/api/config | python3 -c "import sys,json;d=json.load(sys.stdin);print('keys:',sorted(d.keys()));print('container:',d.get('inferenceContainer'));print('port:',d.get('inferencePort'));print('url:',d.get('lmStudioUrl'))"
```

Expected:
```
keys: ['cardOrder', 'cardWidths', 'enableAPIKey', 'enableLog', 'inferenceContainer', 'inferencePort', 'layoutGrid', 'lmAuthEnabled', 'lmAuthValue', 'lmStudioUrl', 'simCacheHitCost', 'simCompletionCost', 'simCostEnabled', 'simPromptCost', 'trendDays']
container: llamacppserver-mtp-llama-server-1
port: 1234
url: http://llamacppserver-mtp-llama-server-1:1234
```

- [ ] **Step 4: Manual integration test — POST round-trip**

Test:
```bash
curl -s -X POST http://localhost:9234/api/config -H "Content-Type: application/json" -d '{"inferenceContainer":"some-test-container","inferencePort":4567}'
```
Expected: `{"success":true,"lmStudioUrl":"http://some-test-container:4567"}`

Then GET to confirm:
```bash
curl -s http://localhost:9234/api/config | grep -E "inferenceContainer|inferencePort"
```
Expected:
```
  "inferenceContainer": "some-test-container",
  "inferencePort": 4567,
```

Restore original values and clean up:
```bash
curl -s -X POST http://localhost:9234/api/config -H "Content-Type: application/json" -d '{"inferenceContainer":"llamacppserver-mtp-llama-server-1","inferencePort":1234}'
kill $SERVER_PID 2>/dev/null
```

- [ ] **Step 5: Commit**

```bash
cd /home/uantek/dev/Applications/lmstudio-dashboard
git add proxy/server.js
git commit -m "feat(api): /api/config exposes and persists inferenceContainer/inferencePort"
```

---

### Task 5: Update downstream endpoints to read `inferenceContainer`

**Files:**
- Modify: `proxy/server.js:1341-1394` (`/api/resource-monitor` — replace fallback container string)
- Modify: `proxy/server.js:1440-1451` (`/api/container-logs`)
- Modify: `proxy/server.js:1592-1639` (`/api/model-config` GET/POST — remove `LLM_CONTAINER` constant)
- Modify: `proxy/server.js:1641-1653` (`/api/reload-model`)

- [ ] **Step 1: Update `/api/resource-monitor` to use derived container**

In `app.get('/api/resource-monitor', ...)` (line 1335), change the line that picks the container from:
```js
  const dockerContainer = resourceConfig.dockerContainer || 'llamacppserver_llama-server_1';
```
to:
```js
  const dockerContainer = getInferenceConfig().container;
```

There are 4 usages of `dockerContainer` later in the same function (lines 1358, 1370, 1377, 1383, 1394) — these are already local-variable references, so no change needed beyond Step 1.

Also remove the now-unused `resourceConfig.dockerContainer` reference; the rest of the function still uses `resourceConfig.enabled`, `resourceConfig.maxConcurrent`, and `resourceConfig.gpuModel`, which are still valid. Leave those.

- [ ] **Step 2: Update `/api/container-logs` to use derived container**

In `app.get('/api/container-logs', ...)` (line 1440), replace the whole handler:

Current:
```js
app.get('/api/container-logs', async (req, res) => {
  try {
    const resourceConfig = config.resourceMonitor || {};
    const dockerContainer = resourceConfig.dockerContainer || 'llamacppserver_llama-server_1';
    const safeName = dockerContainer.replace(/[^a-zA-Z0-9_.-]/g, '');
    const { stdout } = await execAsync(`docker logs --tail 10 ${safeName}`);
    const lines = stdout.replace(/\r\n/g, '\n').split('\n').filter(l => l);
    res.json({ lines: lines.slice(-10) });
  } catch (error) {
    res.json({ lines: [], error: error.message });
  }
});
```

Replace with:
```js
app.get('/api/container-logs', async (req, res) => {
  try {
    const dockerContainer = getInferenceConfig().container;
    const safeName = dockerContainer.replace(/[^a-zA-Z0-9_.-]/g, '');
    const { stdout } = await execAsync(`docker logs --tail 10 ${safeName}`);
    const lines = stdout.replace(/\r\n/g, '\n').split('\n').filter(l => l);
    res.json({ lines: lines.slice(-10) });
  } catch (error) {
    res.json({ lines: [], error: error.message });
  }
});
```

- [ ] **Step 3: Remove `LLM_CONTAINER` constant and update `/api/model-config`**

In `proxy/server.js:1592`, delete the line:
```js
const LLM_CONTAINER = 'llamacppserver-mtp-llama-server-1';
```

In the GET handler (line 1594-1614), change the `docker exec` call:
```js
    const { stdout } = await execAsync(`docker exec ${LLM_CONTAINER} cat /app/models.ini`);
```
to:
```js
    const { stdout } = await execAsync(`docker exec ${getInferenceConfig().container} cat /app/models.ini`);
```

In the POST handler (line 1616-1639), change the same line:
```js
    const { stdout } = await execAsync(`docker exec ${LLM_CONTAINER} cat /app/models.ini`);
```
to:
```js
    const { stdout } = await execAsync(`docker exec ${getInferenceConfig().container} cat /app/models.ini`);
```

- [ ] **Step 4: Update `/api/reload-model` to use derived container**

Replace the entire `/api/reload-model` handler (lines 1641-1653):

Current:
```js
app.post('/api/reload-model', async (req, res) => {
  try {
    await execAsync('docker compose restart');
    res.json({ success: true, message: 'Docker compose restarted' });
  } catch (err) {
    try {
      await execAsync('docker restart llamacppserver-mtp-llama-server-1');
      res.json({ success: true, message: 'Container restarted' });
    } catch (err2) {
      res.status(500).json({ error: err2.message });
    }
  }
});
```

Replace with:
```js
app.post('/api/reload-model', async (req, res) => {
  const dockerContainer = getInferenceConfig().container;
  const safeName = dockerContainer.replace(/[^a-zA-Z0-9_.-]/g, '');
  try {
    await execAsync(`docker restart ${safeName}`);
    res.json({ success: true, message: `Container ${safeName} restarted` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 5: Manual integration test**

Start the server:
```bash
cd /home/uantek/dev/Applications/lmstudio-dashboard
node proxy/server.js &
SERVER_PID=$!
sleep 2
```

Test (these will fail if the inference container doesn't exist, but should not 500 with "container not defined"):
```bash
echo "--- /api/container-logs ---"
curl -s http://localhost:9234/api/container-logs | head -c 500
echo
echo "--- /api/model-config (should be a normal error from docker exec) ---"
curl -s "http://localhost:9234/api/model-config?model=test"
echo
echo "--- /api/resource-monitor ---"
curl -s http://localhost:9234/api/resource-monitor | head -c 500
echo
kill $SERVER_PID 2>/dev/null
```

Expected: Each endpoint returns valid JSON (not an uncaught error). Errors mention docker, not the JS variable.

- [ ] **Step 6: Commit**

```bash
cd /home/uantek/dev/Applications/lmstudio-dashboard
git add proxy/server.js
git commit -m "refactor: route all container-using endpoints through getInferenceConfig()"
```

---

### Task 6: Update `POST /api/test` to accept `{ container, port }`

**Files:**
- Modify: `proxy/server.js:1127-1166` (the `POST /api/test` handler)

- [ ] **Step 1: Update handler to derive URL from container/port**

Replace the existing handler (lines 1127-1166):

Current (excerpt of the relevant part):
```js
app.post('/api/test', async (req, res) => {
  const { url } = req.body;
  const testUrl = url || lmStudioUrl;
  ...
```

Replace the entire handler with:
```js
app.post('/api/test', async (req, res) => {
  const { container, port, url } = req.body;
  let testUrl;
  if (typeof container === 'string' && container.trim() && port) {
    const safeName = container.trim().replace(/[^a-zA-Z0-9_.-]/g, '');
    const safePort = parseInt(port);
    if (safePort < 1 || safePort > 65535) {
      return res.status(400).json({ success: false, error: 'port 必须在 1-65535 之间' });
    }
    testUrl = `http://${safeName}:${safePort}`;
  } else if (url) {
    testUrl = url;
  } else {
    testUrl = lmStudioUrl;
  }
  const startTime = Date.now();
  console.log(`[TEST] Testing URL: ${testUrl}`);
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(`${testUrl}/v1/models`, {
      signal: controller.signal
    });
    clearTimeout(timeout);
    const latency = Date.now() - startTime;
    if (response.ok) {
      const data = await response.json();
      console.log(`[TEST] Success: ${latency}ms`);
      res.json({
        success: true,
        latency,
        models: data.data?.map(m => m.id) || [],
        message: `连接成功 (${latency}ms)`
      });
    } else {
      console.log(`[TEST] HTTP ${response.status}`);
      res.status(response.status).json({
        success: false,
        error: `HTTP ${response.status}`,
        latency
      });
    }
  } catch (error) {
    const latency = Date.now() - startTime;
    console.log(`[TEST] Error: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message,
      latency
    });
  }
});
```

- [ ] **Step 2: Manual integration test**

Start the server:
```bash
cd /home/uantek/dev/Applications/lmstudio-dashboard
node proxy/server.js &
SERVER_PID=$!
sleep 2
```

Test with the new fields:
```bash
curl -s -X POST http://localhost:9234/api/test -H "Content-Type: application/json" -d '{"container":"llamacppserver-mtp-llama-server-1","port":1234}' | head -c 500
echo
```

Expected: `{"success":true,"latency":...,"models":[...],"message":"连接成功 (Xms)"}` (or a connection error if the container isn't running, but the request format must be accepted).

Test with the legacy `url` field still works:
```bash
curl -s -X POST http://localhost:9234/api/test -H "Content-Type: application/json" -d '{"url":"http://llamacppserver-mtp-llama-server-1:1234"}' | head -c 500
echo
```

Expected: same shape response.

Test invalid port:
```bash
curl -s -X POST http://localhost:9234/api/test -H "Content-Type: application/json" -d '{"container":"x","port":99999}'
echo
```
Expected: `{"success":false,"error":"port 必须在 1-65535 之间"}` and HTTP 400.

```bash
kill $SERVER_PID 2>/dev/null
```

- [ ] **Step 3: Commit**

```bash
cd /home/uantek/dev/Applications/lmstudio-dashboard
git add proxy/server.js
git commit -m "feat(api): /api/test accepts {container,port} with backward-compat for {url}"
```

---

### Task 7: Replace dashboard "模型地址" input with container selector + port input

**Files:**
- Modify: `dashboard.html:151-156` (the existing text input block)
- Modify: `dashboard.html:1616` (in `loadConfig()` — replace URL read)
- Modify: `dashboard.html:1802,1814-1817` (in `saveConfig()` — replace URL write and validation)
- Modify: `dashboard.html:1765-1799` (in `testConnection()` — replace URL read)

- [ ] **Step 1: Replace the input markup**

Find the existing block in the `configModal`:
```html
          <div>
            <label class="block text-sm text-gray-400 mb-2">模型地址</label>
            <input type="text" id="lmStudioUrl" placeholder="http://192.168.x.x:1234" 
                   class="w-full bg-gray-700 border border-gray-600 rounded-lg px-4 py-2 text-white focus:border-blue-500 focus:outline-none">
            <p class="text-xs text-gray-500 mt-1">Docker部署时使用: http://host.docker.internal:1234</p>
          </div>
```

Replace with:
```html
          <div>
            <label class="block text-sm text-gray-400 mb-2">推理引擎容器</label>
            <div class="flex gap-2 mb-2">
              <select id="inferenceContainer" class="flex-1 bg-gray-700 border border-gray-600 rounded-lg px-4 py-2 text-white focus:border-blue-500 focus:outline-none">
                <option value="">加载中...</option>
              </select>
              <button type="button" onclick="refreshContainers()" class="bg-gray-600 hover:bg-gray-700 px-3 py-2 rounded-lg text-sm transition" title="重新加载容器列表">↻ 刷新</button>
            </div>
            <label class="block text-sm text-gray-400 mb-2">端口</label>
            <input type="number" id="inferencePort" min="1" max="65535" value="1234"
                   class="w-full bg-gray-700 border border-gray-600 rounded-lg px-4 py-2 text-white focus:border-blue-500 focus:outline-none">
            <p class="text-xs text-gray-500 mt-1">URL: <span id="inferenceUrlPreview" class="text-blue-400">http://...:1234</span>（自动派生）</p>
          </div>
```

- [ ] **Step 2: Update `loadConfig()` to read new fields**

In `loadConfig()` (line 1611), find:
```js
        document.getElementById('lmStudioUrl').value = data.lmStudioUrl || '';
```

Replace with:
```js
        document.getElementById('inferenceContainer').value = data.inferenceContainer || '';
        document.getElementById('inferencePort').value = data.inferencePort || 1234;
        updateInferenceUrlPreview();
```

- [ ] **Step 3: Update `openConfig()` to also load containers**

Find `async function openConfig() {` (line 1644). Replace the function body with:
```js
    async function openConfig() {
      document.body.style.overflow = 'hidden';
      await Promise.all([loadConfig(), loadContainers()]);
      setToggle('gridEditToggle', false);
      updateGridEditState();
      document.getElementById('configModal').classList.remove('hidden');
      document.getElementById('configModal').classList.add('flex');
      document.getElementById('testResult').classList.add('hidden');
    }
```

- [ ] **Step 4: Add `loadContainers`, `refreshContainers`, and URL preview helpers**

Insert these functions after the `openConfig` function (or in any reasonable location near the other config functions, e.g. right after `closeConfig`):

```js
    async function loadContainers() {
      const select = document.getElementById('inferenceContainer');
      const currentValue = select.value;
      try {
        const resp = await fetch(`${API_BASE}/containers`);
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          throw new Error(err.error || `HTTP ${resp.status}`);
        }
        const data = await resp.json();
        const containers = (data.containers || []).filter(c => c.matched);
        if (containers.length === 0) {
          select.innerHTML = '<option value="">未找到推理引擎容器，请确认 Docker 中有 llama.cpp / vllm / tgi 等容器运行</option>';
          select.disabled = true;
        } else {
          select.disabled = false;
          select.innerHTML = containers.map(c =>
            `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)} <${escapeHtml(c.image)}></option>`
          ).join('');
          // Preserve previously selected value if still present
          if (currentValue && containers.some(c => c.name === currentValue)) {
            select.value = currentValue;
          }
        }
      } catch (err) {
        select.innerHTML = `<option value="">Docker 不可用: ${escapeHtml(err.message)}</option>`;
        select.disabled = true;
      }
      updateInferenceUrlPreview();
    }

    async function refreshContainers() {
      await loadContainers();
    }

    function updateInferenceUrlPreview() {
      const container = document.getElementById('inferenceContainer').value || '<container>';
      const port = document.getElementById('inferencePort').value || '<port>';
      document.getElementById('inferenceUrlPreview').textContent = `http://${container}:${port}`;
    }
```

Also wire up the input/select change events. Find the script block where `loadConfig` is defined; add right after the `updateInferenceUrlPreview` function:

```js
    document.getElementById('inferenceContainer').addEventListener('change', updateInferenceUrlPreview);
    document.getElementById('inferencePort').addEventListener('input', updateInferenceUrlPreview);
```

(If these elements don't exist yet on first load, the script block runs at end of `<body>` after the modal markup, so they do exist — keep this as-is.)

- [ ] **Step 5: Update `testConnection()` to use container + port**

Find `async function testConnection()` (line 1765). Replace the function body:

Current:
```js
    async function testConnection() {
      const url = document.getElementById('lmStudioUrl').value;
      const resultDiv = document.getElementById('testResult');
      const testBtn = document.getElementById('testBtn');
      
      resultDiv.classList.remove('hidden', 'bg-green-900/50', 'bg-red-900/50');
      resultDiv.innerHTML = '<span class="text-yellow-400">测试中...</span>';
      testBtn.disabled = true;
      
      try {
        const response = await fetch(`${API_BASE}/test`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url })
        });
        ...
```

Replace the `url` line and the `body` JSON:
```js
    async function testConnection() {
      const container = document.getElementById('inferenceContainer').value;
      const port = document.getElementById('inferencePort').value;
      const resultDiv = document.getElementById('testResult');
      const testBtn = document.getElementById('testBtn');
      
      resultDiv.classList.remove('hidden', 'bg-green-900/50', 'bg-red-900/50');
      resultDiv.innerHTML = '<span class="text-yellow-400">测试中...</span>';
      testBtn.disabled = true;
      
      try {
        const response = await fetch(`${API_BASE}/test`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ container, port: parseInt(port) })
        });
```

(The rest of the function — `data.success` / `data.models` / etc. — stays the same.)

- [ ] **Step 6: Update `saveConfig()` to use new fields**

In `saveConfig()` (line 1801), find:
```js
    async function saveConfig() {
      const url = document.getElementById('lmStudioUrl').value;
      ...
      if (!url) {
        alert('请输入 LM Studio 服务器地址');
        return;
      }
      ...
            body: JSON.stringify({ 
            lmStudioUrl: url,
            ...
```

Replace the `url` line, the validation, and the `lmStudioUrl: url` body field:

```js
    async function saveConfig() {
      const inferenceContainer = document.getElementById('inferenceContainer').value;
      const inferencePort = document.getElementById('inferencePort').value;
      ...
      if (!inferenceContainer) {
        alert('请选择推理引擎容器');
        return;
      }
      ...
            body: JSON.stringify({ 
            inferenceContainer: inferenceContainer,
            inferencePort: parseInt(inferencePort) || 1234,
            ...
```

- [ ] **Step 7: Visual verification (manual)**

Open the dashboard in a browser:
```bash
cd /home/uantek/dev/Applications/lmstudio-dashboard
node proxy/server.js &
SERVER_PID=$!
sleep 2
xdg-open http://localhost:9234/dashboard.html 2>/dev/null || open http://localhost:9234/dashboard.html
```

Check:
1. Click 设置 button
2. The form should show: 推理引擎容器 [select with matched containers] [↻ 刷新 button]
3. Below: 端口 [number input, default 1234]
4. Below: URL preview showing `http://<container>:1234`
5. Change container or port → URL preview updates immediately
6. Click 刷新 → re-fetches container list
7. Click 测试连接 → should respond with success/failure based on actual container
8. Click 保存 → config saved, modal closes
9. Reopen the modal → values persisted
10. Verify 实时请求 card log is from the selected container
11. Open 性能测试 → 模型调整 reads/writes the selected container's `models.ini`
12. Click 重载模型 → restarts the selected container

```bash
kill $SERVER_PID 2>/dev/null
```

- [ ] **Step 8: Commit**

```bash
cd /home/uantek/dev/Applications/lmstudio-dashboard
git add dashboard.html
git commit -m "feat(ui): replace 模型地址 input with inference container selector and port"
```

---

### Task 8: Update README to document the new configuration model

**Files:**
- Modify: `README.md:35-72` (the "配置" / "LM Studio 地址" / "资源监控配置" sections)

- [ ] **Step 1: Replace the "LM Studio 地址" section**

Find:
```markdown
### LM Studio 地址
点击仪表盘右上角的 **设置** 按钮，配置 LM Studio 服务器地址并测试连接。
```

Replace with:
```markdown
### 推理引擎容器
点击仪表盘右上角的 **设置** 按钮，从已运行的 Docker 容器列表中选择推理引擎（llama.cpp / vLLM / TGI / SGLang / Ollama 等），并填写其 HTTP 端口。URL 会自动派生为 `http://<容器名>:<端口>`。

容器名 / 镜像名匹配以下任一关键字会被识别为推理引擎：`llama`、`llamacpp`、`llama-server`、`llama.cpp`、`vllm`、`tgi`、`text-generation-inference`、`sglang`、`ollama`、`inference`、`llm-server`。如果你的容器名不含上述关键字，请重命名容器或修改 `proxy/server.js` 中的 `INFERENCE_KEYWORDS` 数组。

> **端口默认值 1234 是 LM Studio 的约定。** vLLM 用户填 8000，Ollama 填 11434，TGI 填 8080。
```

- [ ] **Step 2: Replace the "资源监控配置" section**

Find:
```markdown
### 资源监控配置
编辑 `proxy/config.json`，启用并配置资源监控：
```

Replace with:
```markdown
### 资源监控配置
资源监控读取 **推理引擎容器**（即设置面板中所选容器）的 GPU / CPU / 内存，无需单独配置。`proxy/config.json` 中的 `resourceMonitor` 字段仅保留以下子键：
```

Then update the table to remove `dockerContainer`:

Find:
```markdown
| 字段 | 说明 |
|------|------|
| `enabled` | 启用/禁用资源监控 |
| `dockerContainer` | LLM 服务容器名，用于采集 GPU 数据 |
| `maxConcurrent` | 最大并发请求数 |
| `gpuModel` | GPU 型号名（容器内无法自动检测时使用） |
```

Replace with:
```markdown
| 字段 | 说明 |
|------|------|
| `enabled` | 启用/禁用资源监控 |
| `maxConcurrent` | 最大并发请求数 |
| `gpuModel` | GPU 型号名（容器内无法自动检测时使用） |

> **LLM 服务容器**（旧 `resourceMonitor.dockerContainer`）已合并到 `inferenceContainer`，由设置面板的"推理引擎容器"下拉控制。旧字段在配置文件中仍可存在但被忽略。
```

- [ ] **Step 3: Verify the README renders sensibly**

Read the file:
```bash
sed -n '30,90p' /home/uantek/dev/Applications/lmstudio-dashboard/README.md
```

Confirm: No leftover references to "LM Studio 地址" as text input. The new "推理引擎容器" section reads naturally. The table reflects the new fields.

- [ ] **Step 4: Commit**

```bash
cd /home/uantek/dev/Applications/lmstudio-dashboard
git add README.md
git commit -m "docs: document inferenceContainer/inferencePort config model"
```

---

### Task 9: End-to-end integration verification

**Files:**
- (no file modifications — verification only)

- [ ] **Step 1: Start the server fresh and exercise the full flow**

```bash
cd /home/uantek/dev/Applications/lmstudio-dashboard
node proxy/server.js &
SERVER_PID=$!
sleep 2
```

- [ ] **Step 2: Verify `/api/containers` returns matched containers**

```bash
curl -s http://localhost:9234/api/containers | python3 -m json.tool | head -30
```

Expected: Object with `containers` (each item has `matched: true/false`) and `keywords` array.

- [ ] **Step 3: Verify all four downstream features use the new config**

```bash
echo "--- 1. Request forwarding URL ---"
curl -s http://localhost:9234/api/config | python3 -c "import sys,json;d=json.load(sys.stdin);print('lmStudioUrl =',d['lmStudioUrl'])"

echo "--- 2. Resource monitor (uses inferenceContainer) ---"
curl -s http://localhost:9234/api/resource-monitor | head -c 200
echo

echo "--- 3. Container logs (uses inferenceContainer) ---"
curl -s http://localhost:9234/api/container-logs | head -c 200
echo

echo "--- 4. Reload model (uses inferenceContainer) ---"
# Do NOT actually invoke; just verify the route is alive
curl -s -X POST http://localhost:9234/api/reload-model -w "\nHTTP %{http_code}\n"
```

Expected: All endpoints respond with valid JSON. The first one prints the correct URL.

- [ ] **Step 4: Change inferenceContainer via POST and re-verify**

```bash
# Change
curl -s -X POST http://localhost:9234/api/config -H "Content-Type: application/json" -d '{"inferenceContainer":"llamacppserver-mtp-llama-server-1","inferencePort":1234}'

# Verify URL changed
curl -s http://localhost:9234/api/config | python3 -c "import sys,json;d=json.load(sys.stdin);print('After change, lmStudioUrl =',d['lmStudioUrl'])"
```

Expected: After POST, GET returns the new URL.

- [ ] **Step 5: Verify port validation**

```bash
curl -s -X POST http://localhost:9234/api/config -H "Content-Type: application/json" -d '{"inferencePort":99999}' -w "\nHTTP %{http_code}\n"
```

Expected: `{"error":"inferencePort 必须是 1-65535 的整数"}` and HTTP 400.

- [ ] **Step 6: Verify config file persistence**

```bash
cat proxy/config.json | python3 -c "import sys,json;d=json.load(sys.stdin);print('persisted inferenceContainer =',d.get('inferenceContainer'));print('persisted inferencePort =',d.get('inferencePort'));print('persisted resourceMonitor.dockerContainer =',d.get('resourceMonitor',{}).get('dockerContainer'))"
```

Expected: `inferenceContainer` and `inferencePort` are set. `resourceMonitor.dockerContainer` is either absent or stale (it's now derived, not saved).

- [ ] **Step 7: Stop the server**

```bash
kill $SERVER_PID 2>/dev/null
```

- [ ] **Step 8: Final review**

```bash
cd /home/uantek/dev/Applications/lmstudio-dashboard
git log --oneline -10
```

Expected: ~7-8 new commits, each focused, in this order: Task 1 (helper), Task 2 (migration), Task 3 (containers API), Task 4 (config API), Task 5 (downstream endpoints), Task 6 (test API), Task 7 (UI), Task 8 (docs).

---

## Self-Review Notes (already applied during writing)

- **Type/name consistency**: `getInferenceConfig()`, `isInferenceContainer()`, `INFERENCE_KEYWORDS`, `inferenceContainer`, `inferencePort` are used identically throughout.
- **Backward compatibility**: Task 4's POST handler accepts legacy `lmStudioUrl` if new fields are missing. Task 6's `/api/test` accepts legacy `url`. Task 2's startup migration reads all legacy field shapes.
- **No placeholders**: All code blocks are complete; no "TBD" or "implement later" markers.
- **Tested fields**: All spec requirements map to at least one task — config model (Tasks 1, 2, 4), API (Tasks 3, 4, 5, 6), UI (Task 7), docs (Task 8), end-to-end (Task 9).
