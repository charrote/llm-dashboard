# Cost Trend Configurable Days Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the cost trend chart's data period configurable via the settings modal instead of hardcoded 30 days.

**Architecture:** Add `trendDays` field to `config.json`, expose it via `/api/config` GET/POST, use it server-side in `/api/weekly-trend` to control data points, and dynamically size frontend chart arrays based on response data length.

**Tech Stack:** Express.js, Chart.js, vanilla JS, JSON config file

---

### Task 1: Add `trendDays` to config.json and server defaults

**Files:**
- Modify: `proxy/config.json:15`
- Modify: `proxy/server.js:20-27`

- [ ] **Add trendDays to config.json**

Edit `proxy/config.json`, add `"trendDays": 30` after the `simCompletionCost` line:

```json
  "simPromptCost": 0.2,
  "simCompletionCost": 2,
  "trendDays": 30,
  "resourceMonitor": {
```

- [ ] **Add trendDays default in server.js**

Edit `proxy/server.js`, add after line 22 (`config.simCompletionCost = config.simCompletionCost || 0;`):

```javascript
config.trendDays = config.trendDays || 30;
```

---

### Task 2: Update `/api/weekly-trend` to use configurable days

**Files:**
- Modify: `proxy/server.js:781-820`

- [ ] **Change hardcoded 29 to config-driven loop**

Edit `proxy/server.js` line 785. Replace:

```javascript
  for (let i = 29; i >= 0; i--) {
```

With:

```javascript
  const daysCount = config.trendDays || 30;
  for (let i = daysCount - 1; i >= 0; i--) {
```

---

### Task 3: Expose `trendDays` in `/api/config` GET/POST

**Files:**
- Modify: `proxy/server.js:989-1001` (GET)
- Modify: `proxy/server.js:1004-1027` (POST)

- [ ] **Add trendDays to GET response**

Edit `proxy/server.js` lines 998-1001 in GET `/api/config`. Replace:

```javascript
    simCostEnabled: config.simCostEnabled || false,
    simPromptCost: config.simPromptCost || 0,
    simCompletionCost: config.simCompletionCost || 0
  });
```

With:

```javascript
    simCostEnabled: config.simCostEnabled || false,
    simPromptCost: config.simPromptCost || 0,
    simCompletionCost: config.simCompletionCost || 0,
    trendDays: config.trendDays || 30
  });
```

- [ ] **Add trendDays to POST handler**

Edit `proxy/server.js` line 1005 in POST `/api/config`. Replace:

```javascript
  const { lmStudioContainer, lmStudioPort, lmStudioUrl: url, defaultAPIKey, enableAPIKey, enableLog, lmAuthEnabled, lmAuthValue, simCostEnabled, simPromptCost, simCompletionCost } = req.body;
```

With:

```javascript
  const { lmStudioContainer, lmStudioPort, lmStudioUrl: url, defaultAPIKey, enableAPIKey, enableLog, lmAuthEnabled, lmAuthValue, simCostEnabled, simPromptCost, simCompletionCost, trendDays } = req.body;
```

Edit `proxy/server.js` line 1014. Replace:

```javascript
  if (defaultAPIKey !== undefined || enableAPIKey !== undefined || enableLog !== undefined || lmAuthEnabled !== undefined || lmAuthValue !== undefined || simCostEnabled !== undefined || simPromptCost !== undefined || simCompletionCost !== undefined) {
```

With:

```javascript
  if (defaultAPIKey !== undefined || enableAPIKey !== undefined || enableLog !== undefined || lmAuthEnabled !== undefined || lmAuthValue !== undefined || simCostEnabled !== undefined || simPromptCost !== undefined || simCompletionCost !== undefined || trendDays !== undefined) {
```

Edit `proxy/server.js` after line 1022. Add before the `fs.writeFileSync` line:

```javascript
    if (trendDays !== undefined) config.trendDays = parseInt(trendDays) || 30;
```

---

### Task 4: Add `trendDays` to frontend config handling

**Files:**
- Modify: `dashboard.html:508` (default appConfig)
- Modify: `dashboard.html:1158-1162` (loadConfig appConfig assignment)
- Modify: `dashboard.html:1180-1184` (loadConfigWithoutModal)
- Modify: `dashboard.html:1313-1317` (saveConfig local appConfig)

- [ ] **Add trendDays to default appConfig**

Edit `dashboard.html` line 508. Replace:

```javascript
    let appConfig = { simCostEnabled: false, simPromptCost: 0, simCompletionCost: 0 };
```

With:

```javascript
    let appConfig = { simCostEnabled: false, simPromptCost: 0, simCompletionCost: 0, trendDays: 30 };
```

- [ ] **Add trendDays to loadConfig() appConfig**

Edit `dashboard.html` lines 1158-1162. Replace:

```javascript
        appConfig = {
          simCostEnabled: data.simCostEnabled || false,
          simPromptCost: data.simPromptCost || 0,
          simCompletionCost: data.simCompletionCost || 0
        };
```

With:

```javascript
        appConfig = {
          simCostEnabled: data.simCostEnabled || false,
          simPromptCost: data.simPromptCost || 0,
          simCompletionCost: data.simCompletionCost || 0,
          trendDays: data.trendDays || 30
        };
```

- [ ] **Add trendDays to loadConfigWithoutModal()**

Edit `dashboard.html` lines 1180-1184. Replace:

```javascript
        appConfig = {
          simCostEnabled: data.simCostEnabled || false,
          simPromptCost: data.simPromptCost || 0,
          simCompletionCost: data.simCompletionCost || 0
        };
```

With:

```javascript
        appConfig = {
          simCostEnabled: data.simCostEnabled || false,
          simPromptCost: data.simPromptCost || 0,
          simCompletionCost: data.simCompletionCost || 0,
          trendDays: data.trendDays || 30
        };
```

- [ ] **Add trendDays to saveConfig() local appConfig update**

Edit `dashboard.html` lines 1313-1317. Replace:

```javascript
          appConfig = {
            simCostEnabled: simCostEnabled,
            simPromptCost: parseFloat(simPromptCost) || 0,
            simCompletionCost: parseFloat(simCompletionCost) || 0
          };
```

With:

```javascript
          appConfig = {
            simCostEnabled: simCostEnabled,
            simPromptCost: parseFloat(simPromptCost) || 0,
            simCompletionCost: parseFloat(simCompletionCost) || 0,
            trendDays: parseInt(document.getElementById('trendDays').value) || 30
          };
```

---

### Task 5: Add trendDays input to settings modal

**Files:**
- Modify: `dashboard.html:96-108`

- [ ] **Add trendDays number input to settings modal**

Edit `dashboard.html`, after the cost input grid div (line 107 closed by `</div>` at line 108), add the trend days input. The current structure is:

```html
            </div>
          </div>
```

Insert between the `</div>` (end of cost grid) and the next `</div>` (end of cost toggle section):

```html
            <div class="mt-4">
              <label class="block text-sm text-gray-400 mb-2">成本趋势天数</label>
              <input type="number" id="trendDays" min="1" max="365" value="30"
                     class="w-full bg-gray-700 border border-gray-600 rounded-lg px-4 py-2 text-white focus:border-blue-500 focus:outline-none">
            </div>
          </div>
```

- [ ] **Add trendDays input to saveConfig POST body**

Edit `dashboard.html` lines 1287-1289 in `saveConfig()`. Replace:

```javascript
      const simCostEnabled = isToggleOn('simCostToggle');
      const simPromptCost = document.getElementById('simPromptCost').value;
      const simCompletionCost = document.getElementById('simCompletionCost').value;
```

With:

```javascript
      const simCostEnabled = isToggleOn('simCostToggle');
      const simPromptCost = document.getElementById('simPromptCost').value;
      const simCompletionCost = document.getElementById('simCompletionCost').value;
      const trendDays = document.getElementById('trendDays').value;
```

Edit `dashboard.html` lines 1306-1308 in the POST body. Replace:

```javascript
            simCostEnabled: simCostEnabled,
            simPromptCost: simPromptCost,
            simCompletionCost: simCompletionCost
```

With:

```javascript
            simCostEnabled: simCostEnabled,
            simPromptCost: simPromptCost,
            simCompletionCost: simCompletionCost,
            trendDays: trendDays
```

- [ ] **Add trendDays to loadConfig() input value**

Edit `dashboard.html` after line 1156 (`document.getElementById('simCompletionCost').value = data.simCompletionCost !== undefined ? data.simCompletionCost : '';`), add:

```javascript
        document.getElementById('trendDays').value = data.trendDays !== undefined ? data.trendDays : 30;
```

---

### Task 6: Replace hardcoded Array(30) with dynamic length

**Files:**
- Modify: `dashboard.html:824` and `dashboard.html:828`

- [ ] **Use weeklyData.length instead of 30**

Edit `dashboard.html` line 824. Replace:

```javascript
          costTrendChart.data.datasets[1].data = Array(30).fill(avg);
```

With:

```javascript
          costTrendChart.data.datasets[1].data = Array(weeklyData.length).fill(avg);
```

Edit `dashboard.html` line 828. Replace:

```javascript
            data: Array(30).fill(avg),
```

With:

```javascript
            data: Array(weeklyData.length).fill(avg),
```

---

### Task 7: Verify changes work

- [ ] **Restart server and test**

Run: `node proxy/server.js`

Expected: Server starts on port 3456 (or whatever the configured port is).

- [ ] **Test default behavior**

Open the dashboard in a browser. Open the settings modal, verify "成本趋势天数" input shows 30. Close settings, verify cost trend chart renders with 30 data points.

- [ ] **Test configurable days**

Open settings, change "成本趋势天数" to 90, click save. Reopen settings, verify the value persists as 90. Close settings, verify cost trend chart now renders with 90 data points (scroll to see all labels).

- [ ] **Test edge cases**

Set "成本趋势天数" to 1, verify chart renders with 1 data point. Set to 365, verify chart renders with 365 data points.
