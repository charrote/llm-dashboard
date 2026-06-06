import express from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 9234;
let lmStudioUrl = process.env.LMSTUDIO_URL || 'http://localhost:1234';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));
app.use('/node_modules', express.static(path.join(__dirname, 'node_modules')));

const LOGS_DIR = path.join(__dirname, 'logs');
const CURRENT_LOG_FILE = path.join(LOGS_DIR, 'current.json');

const defaultStats = () => ({
  requests: [],
  byApiKey: {},
  byModel: {},
  hourlyStats: new Array(24).fill(0).map(() => ({ requests: 0, tokens: 0, errors: 0 })),
  totalTokens: { prompt: 0, completion: 0 },
  latency: { sum: 0, count: 0, min: Infinity, max: 0 },
  errors: 0
});

let stats = defaultStats();
let errorLogs = [];
let currentDate = getDateStr();

if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

function getDateStr(date = new Date()) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

function getLogFileName(dateStr) {
  return path.join(LOGS_DIR, `${dateStr}.json`);
}

function loadCurrentStats() {
  try {
    if (fs.existsSync(CURRENT_LOG_FILE)) {
      const data = JSON.parse(fs.readFileSync(CURRENT_LOG_FILE, 'utf8'));
      const fileDate = data.date;
      const today = getDateStr();
      if (fileDate === today) {
        stats = {
          ...defaultStats(),
          ...data,
          latency: data.latency || { sum: 0, count: 0, min: Infinity, max: 0 }
        };
        errorLogs = data.errorLogs || [];
        console.log(`已加载今日(${today})数据: ${stats.requests.length}条请求`);
      } else {
        const oldFile = getLogFileName(fileDate);
        fs.writeFileSync(oldFile, JSON.stringify(data, null, 2));
        console.log(`已保存昨日(${fileDate})数据到 ${path.basename(oldFile)}`);
        stats = defaultStats();
        errorLogs = [];
      }
    }
  } catch (error) {
    console.error('加载数据失败:', error.message);
    stats = defaultStats();
    errorLogs = [];
  }
}

function saveCurrentStats() {
  try {
    const today = getDateStr();
    if (today !== currentDate) {
      const oldFile = getLogFileName(currentDate);
      fs.writeFileSync(oldFile, JSON.stringify({ ...stats, date: currentDate, errorLogs }, null, 2));
      console.log(`已保存 ${currentDate} 数据到 ${path.basename(oldFile)}`);
      currentDate = today;
      stats = defaultStats();
      errorLogs = [];
    }
    fs.writeFileSync(CURRENT_LOG_FILE, JSON.stringify({ ...stats, date: today, errorLogs }, null, 2));
  } catch (error) {
    console.error('保存数据失败:', error.message);
  }
}

setInterval(saveCurrentStats, 60000);

loadCurrentStats();

function getHourIndex(date = new Date()) {
  const hour = date.getUTCHours() + 8;
  return hour >= 24 ? hour - 24 : hour;
}

function updateStats(data) {
  const requestDate = new Date(data.timestamp);
  const hour = getHourIndex(requestDate);
  
  stats.requests.push(data);
  if (stats.requests.length > 1000) stats.requests.shift();
  
  stats.hourlyStats[hour].requests++;
  stats.hourlyStats[hour].tokens += data.tokens.total;
  stats.totalTokens.prompt += data.tokens.prompt;
  stats.totalTokens.completion += data.tokens.completion;
  
  if (data.apiKey) {
    if (!stats.byApiKey[data.apiKey]) {
      stats.byApiKey[data.apiKey] = { requests: 0, tokens: 0, errors: 0, models: {} };
    }
    stats.byApiKey[data.apiKey].requests++;
    stats.byApiKey[data.apiKey].tokens += data.tokens.total;
    
    if (!stats.byApiKey[data.apiKey].models[data.model]) {
      stats.byApiKey[data.apiKey].models[data.model] = { requests: 0, tokens: 0 };
    }
    stats.byApiKey[data.apiKey].models[data.model].requests++;
    stats.byApiKey[data.apiKey].models[data.model].tokens += data.tokens.total;
  }
  
  if (!stats.byModel[data.model]) {
    stats.byModel[data.model] = { requests: 0, tokens: 0, errors: 0, apiKeys: {} };
  }
  stats.byModel[data.model].requests++;
  stats.byModel[data.model].tokens += data.tokens.total;
  
  if (data.apiKey) {
    if (!stats.byModel[data.model].apiKeys[data.apiKey]) {
      stats.byModel[data.model].apiKeys[data.apiKey] = 0;
    }
    stats.byModel[data.model].apiKeys[data.apiKey]++;
  }
  
  stats.latency.sum += data.latency;
  stats.latency.count++;
  stats.latency.min = Math.min(stats.latency.min, data.latency);
  stats.latency.max = Math.max(stats.latency.max, data.latency);
  
  if (data.error) {
    stats.errors++;
    stats.hourlyStats[hour].errors++;
    if (data.apiKey && stats.byApiKey[data.apiKey]) {
      stats.byApiKey[data.apiKey].errors++;
    }
    if (stats.byModel[data.model]) {
      stats.byModel[data.model].errors++;
    }
    
    errorLogs.push({
      id: data.requestId,
      timestamp: data.timestamp,
      requestId: data.requestId,
      method: data.method,
      path: data.path,
      apiKey: data.apiKeyFull || data.apiKey,
      model: data.model,
      errorType: 'API_ERROR',
      errorMessage: data.error,
      status: data.status,
      latency: data.latency,
      resolved: false
    });
  }
  
  saveCurrentStats();
}

function extractTokenUsage(resData) {
  let prompt = 0, completion = 0;
  
  if (resData.usage) {
    prompt = resData.usage.prompt_tokens || 0;
    completion = resData.usage.completion_tokens || 0;
  }
  
  if (resData.choices?.[0]?.usage) {
    prompt = resData.choices[0].usage.prompt_tokens || prompt;
    completion = resData.choices[0].usage.completion_tokens || completion;
  }
  
  return { prompt, completion, total: prompt + completion };
}

async function proxyRequest(req, res) {
  const startTime = Date.now();
  const requestId = uuidv4();
  const apiKey = req.headers['authorization']?.replace('Bearer ', '') || 'anonymous';
  const model = req.body?.model || 'unknown';
  const isStream = req.body?.stream === true;
  
  const targetPath = req.path.replace(/^\/v1/, '');
  const targetUrl = `${lmStudioUrl}/v1${targetPath}`;
  
  try {
    const response = await fetch(targetUrl, {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        ...(req.headers['authorization'] && { 'Authorization': req.headers['authorization'] })
      },
      body: JSON.stringify(req.body)
    });
    
    if (isStream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      
      async function pump() {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              res.end();
              break;
            }
            res.write(decoder.decode(value, { stream: true }));
          }
        } catch (error) {
          res.status(500).json({ error: error.message });
        }
      }
      
      pump();
      
      updateStats({
        requestId,
        timestamp: new Date().toISOString(),
        apiKey: apiKey.substring(0, 16) + '...',
        apiKeyFull: apiKey,
        model,
        method: req.method,
        path: req.path,
        status: response.status,
        tokens: { prompt: 0, completion: 0, total: 0 },
        latency: Date.now() - startTime,
        error: null
      });
      
      return;
    }
    
    const latency = Date.now() - startTime;
    const data = await response.json();
    
    const tokens = extractTokenUsage(data);
    
    updateStats({
      requestId,
      timestamp: new Date().toISOString(),
      apiKey: apiKey.substring(0, 16) + '...',
      apiKeyFull: apiKey,
      model,
      method: req.method,
      path: req.path,
      status: response.status,
      tokens,
      latency,
      error: null
    });
    
    res.status(response.status).json(data);
    
  } catch (error) {
    const latency = Date.now() - startTime;
    const timestamp = new Date().toISOString();
    
    updateStats({
      requestId,
      timestamp,
      apiKey: apiKey.substring(0, 16) + '...',
      apiKeyFull: apiKey,
      model,
      method: req.method,
      path: req.path,
      status: 500,
      tokens: { prompt: 0, completion: 0, total: 0 },
      latency,
      error: error.message
    });
    
    errorLogs.push({
      id: uuidv4(),
      timestamp,
      requestId,
      method: req.method,
      path: req.path,
      apiKey: apiKey,
      model,
      errorType: 'NETWORK_ERROR',
      errorMessage: error.message,
      latency,
      lmStudioUrl: targetUrl,
      resolved: false
    });
    
    res.status(500).json({ error: error.message });
  }
}

app.get(['/', '/dashboard', '/dashboard.html'], (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'dashboard.html'));
});

app.use((req, res, next) => {
  if (req.path.startsWith('/api/') || req.path === '/stats' || req.path === '/reset') {
    return next();
  }
  if (req.path.includes('.') && !req.path.startsWith('/v1')) {
    return next();
  }
  proxyRequest(req, res);
});

app.get('/api/stats', (req, res) => {
  res.json({
    ...stats,
    latency: stats.latency.count > 0 ? {
      avg: Math.round(stats.latency.sum / stats.latency.count),
      sum: stats.latency.sum,
      count: stats.latency.count,
      min: stats.latency.min === Infinity ? 0 : stats.latency.min,
      max: stats.latency.max
    } : { avg: 0, sum: 0, count: 0, min: 0, max: 0 }
  });
});

app.get('/api/requests', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const offset = parseInt(req.query.offset) || 0;
  const sorted = [...stats.requests].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  res.json(sorted.slice(offset, offset + limit));
});

app.get('/api/errors', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const unresolved = req.query.unresolved === 'true';
  let logs = errorLogs;
  
  if (unresolved) {
    logs = logs.filter(log => !log.resolved);
  }
  
  res.json(logs.slice(-limit).reverse());
});

app.patch('/api/errors/:id', (req, res) => {
  const { id } = req.params;
  const { resolved } = req.body;
  
  const log = errorLogs.find(log => log.id === id);
  if (!log) {
    return res.status(404).json({ error: 'Error log not found' });
  }
  
  log.resolved = resolved;
  saveErrorLogs();
  res.json(log);
});

app.delete('/api/errors', (req, res) => {
  errorLogs = [];
  saveCurrentStats();
  res.json({ success: true, message: 'All error logs cleared' });
});

app.delete('/api/errors/resolved', (req, res) => {
  errorLogs = errorLogs.filter(log => !log.resolved);
  saveCurrentStats();
  res.json({ success: true, message: 'Resolved error logs cleared' });
});

app.get('/api/logs', (req, res) => {
  try {
    const files = fs.readdirSync(LOGS_DIR)
      .filter(f => f.endsWith('.json') && f !== 'current.json')
      .map(f => {
        const dateStr = f.replace('.json', '');
        const filePath = path.join(LOGS_DIR, f);
        const stats = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return {
          date: dateStr,
          displayDate: `${dateStr.slice(0,4)}-${dateStr.slice(4,6)}-${dateStr.slice(6,8)}`,
          requests: stats.requests?.length || 0,
          errors: stats.errors || 0,
          totalTokens: stats.totalTokens?.prompt + stats.totalTokens?.completion || 0
        };
      })
      .sort((a, b) => b.date.localeCompare(a.date));
    res.json(files);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/logs/:date', (req, res) => {
  const { date } = req.params;
  const filePath = path.join(LOGS_DIR, `${date}.json`);
  
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Log file not found' });
  }
  
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    res.json({
      date,
      displayDate: `${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}`,
      requests: data.requests || [],
      byApiKey: data.byApiKey || {},
      byModel: data.byModel || {},
      hourlyStats: data.hourlyStats || [],
      totalTokens: data.totalTokens || { prompt: 0, completion: 0 },
      latency: data.latency || { sum: 0, count: 0 },
      errors: data.errors || 0,
      errorLogs: data.errorLogs || []
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/config', (req, res) => {
  res.json({ lmStudioUrl });
});

app.post('/api/config', (req, res) => {
  const { lmStudioUrl: url } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'lmStudioUrl is required' });
  }
  lmStudioUrl = url;
  console.log(`LM Studio URL updated to: ${lmStudioUrl}`);
  res.json({ success: true, lmStudioUrl });
});

app.post('/api/test', async (req, res) => {
  const { url } = req.body;
  const testUrl = url || lmStudioUrl;
  const startTime = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(`${testUrl}/v1/models`, {
      signal: controller.signal
    });
    clearTimeout(timeout);
    const latency = Date.now() - startTime;
    if (response.ok) {
      const data = await response.json();
      res.json({ 
        success: true, 
        latency,
        models: data.data?.map(m => m.id) || [],
        message: `连接成功 (${latency}ms)`
      });
    } else {
      res.status(response.status).json({ 
        success: false, 
        error: `HTTP ${response.status}`,
        latency
      });
    }
  } catch (error) {
    const latency = Date.now() - startTime;
    res.status(500).json({ 
      success: false, 
      error: error.message,
      latency
    });
  }
});

app.get('/api/models', async (req, res) => {
  try {
    const response = await fetch(`${lmStudioUrl}/v1/models`);
    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/reset', (req, res) => {
  stats.requests = [];
  stats.byApiKey = {};
  stats.byModel = {};
  stats.hourlyStats = new Array(24).fill(0).map(() => ({ requests: 0, tokens: 0, errors: 0 }));
  stats.totalTokens = { prompt: 0, completion: 0 };
  stats.latency = { sum: 0, count: 0, min: Infinity, max: 0 };
  stats.errors = 0;
  errorLogs = [];
  saveCurrentStats();
  res.json({ success: true });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`LM Studio Proxy running on http://0.0.0.0:${PORT}`);
  console.log(`Forwarding requests to ${lmStudioUrl}`);
  console.log(`\nUsage: Change your API base URL to http://localhost:${PORT}/v1`);
});
