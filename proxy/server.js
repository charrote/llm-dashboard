import express from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { TrimCompressor } from 'slimcontext';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG_FILE = path.join(__dirname, 'config.json');
const APIKEYS_FILE = path.join(__dirname, 'apikeys.json');
let config = fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) : {};

config.simCostEnabled = config.simCostEnabled || false;
config.simPromptCost = config.simPromptCost || 0;
config.simCompletionCost = config.simCompletionCost || 0;
config.resourceMonitor = config.resourceMonitor || {
  enabled: true,
  dockerContainer: 'llamacppserver_llama-server_1',
  maxConcurrent: 4
};

function loadApiKeys() {
  try {
    if (fs.existsSync(APIKEYS_FILE)) {
      return JSON.parse(fs.readFileSync(APIKEYS_FILE, 'utf-8'));
    }
  } catch (error) {
    console.error('加载 API Keys 失败:', error.message);
  }
  return [];
}

function saveApiKeys(apiKeys) {
  try {
    fs.writeFileSync(APIKEYS_FILE, JSON.stringify(apiKeys, null, 2));
  } catch (error) {
    console.error('保存 API Keys 失败:', error.message);
  }
}

let apiKeys = loadApiKeys();

const STRATEGY_CONFIG = {
  preserve: { thresholdPercent: 0.7, minRecentMessages: 3 },
  compress: { thresholdPercent: 0.5, minRecentMessages: 1 },
  balance: { thresholdPercent: 0.6, minRecentMessages: 2 }
};

function countMessageTokens(messages) {
  return Math.ceil(Buffer.byteLength(JSON.stringify(messages)) / 4);
}

function saveOptimizationLog(requestId, before, after, strategy, beforeTokens, afterTokens) {
  const optLogDir = path.join(LOGS_DIR, 'optimization');
  if (!fs.existsSync(optLogDir)) {
    fs.mkdirSync(optLogDir, { recursive: true });
  }
  
  const logFile = path.join(optLogDir, `${getDateStr()}.json`);
  let logs = [];
  
  if (fs.existsSync(logFile)) {
    try {
      logs = JSON.parse(fs.readFileSync(logFile, 'utf-8'));
    } catch (e) {
      logs = [];
    }
  }
  
  logs.push({
    timestamp: new Date().toISOString(),
    requestId,
    strategy,
    before: { tokens: beforeTokens, messageCount: before.length },
    after: { tokens: afterTokens, messageCount: after.length },
    saved: beforeTokens - afterTokens
  });
  
  try {
    fs.writeFileSync(logFile, JSON.stringify(logs, null, 2));
  } catch (e) {
    console.error('保存优化日志失败:', e.message);
  }
  
  cleanupOldOptimizationLogs();
}

function cleanupOldOptimizationLogs() {
  const retentionDays = config.promptOptimization?.logRetentionDays || 30;
  const optLogDir = path.join(LOGS_DIR, 'optimization');
  
  if (!fs.existsSync(optLogDir)) return;
  
  const files = fs.readdirSync(optLogDir);
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
  
  files.forEach(file => {
    if (file.startsWith('optimization-') && file.endsWith('.json')) {
      const dateStr = file.replace('optimization-', '').replace('.json', '');
      const fileDate = new Date(dateStr.slice(0, 4) + '-' + dateStr.slice(4, 6) + '-' + dateStr.slice(6, 8));
      if (fileDate < cutoffDate) {
        fs.unlinkSync(path.join(optLogDir, file));
      }
    }
  });
}

const app = express();
const PORT = process.env.PORT || 9234;
let lmStudioUrl = config.lmStudioUrl || process.env.LMSTUDIO_URL || 'http://host.docker.internal:1234';

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname)));
app.use('/node_modules', express.static(path.join(__dirname, 'node_modules')));

const LOGS_DIR = path.join(__dirname, 'logs');
const CURRENT_LOG_FILE = path.join(LOGS_DIR, 'current.json');

const defaultStats = () => ({
  requests: [],
  totalRequestCount: 0,
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

function migrateStatsData(stats) {
  if (!stats.byModel) return stats;
  for (const model in stats.byModel) {
    const modelData = stats.byModel[model];
    if (modelData.apiKeys) {
      for (const key in modelData.apiKeys) {
        const val = modelData.apiKeys[key];
        if (typeof val === 'number') {
          modelData.apiKeys[key] = { requests: val, tokens: 0 };
        }
      }
    }
  }
  return stats;
}

function loadCurrentStats() {
  try {
    if (fs.existsSync(CURRENT_LOG_FILE)) {
      const data = JSON.parse(fs.readFileSync(CURRENT_LOG_FILE, 'utf8'));
      const fileDate = data.date;
      const today = getDateStr();
      if (fileDate === today) {
        stats = migrateStatsData({
          ...defaultStats(),
          ...data,
          latency: data.latency || { sum: 0, count: 0, min: Infinity, max: 0 }
        });
        errorLogs = data.errorLogs || [];
      } else {
        const oldFile = getLogFileName(fileDate);
        fs.writeFileSync(oldFile, JSON.stringify(data, null, 2));
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
  stats.totalRequestCount++;
  
  stats.hourlyStats[hour].requests++;
  stats.hourlyStats[hour].tokens += data.tokens.total;
  stats.totalTokens.prompt += data.tokens.prompt;
  stats.totalTokens.completion += data.tokens.completion;
  
  if (data.apiKey) {
    if (!stats.byApiKey[data.apiKey]) {
      stats.byApiKey[data.apiKey] = { requests: 0, promptTokens: 0, completionTokens: 0, tokens: 0, errors: 0, models: {} };
    }
    stats.byApiKey[data.apiKey].requests++;
    stats.byApiKey[data.apiKey].promptTokens += data.tokens.prompt;
    stats.byApiKey[data.apiKey].completionTokens += data.tokens.completion;
    stats.byApiKey[data.apiKey].tokens += data.tokens.total;
    
    if (!stats.byApiKey[data.apiKey].models[data.model]) {
      stats.byApiKey[data.apiKey].models[data.model] = { requests: 0, promptTokens: 0, completionTokens: 0, tokens: 0 };
    }
    stats.byApiKey[data.apiKey].models[data.model].requests++;
    stats.byApiKey[data.apiKey].models[data.model].promptTokens += data.tokens.prompt;
    stats.byApiKey[data.apiKey].models[data.model].completionTokens += data.tokens.completion;
    stats.byApiKey[data.apiKey].models[data.model].tokens += data.tokens.total;
  }
  
  if (!stats.byModel[data.model]) {
    stats.byModel[data.model] = { requests: 0, promptTokens: 0, completionTokens: 0, tokens: 0, errors: 0, apiKeys: {}, latency: { sum: 0, count: 0 }, contextLength: { sum: 0, count: 0 }, ttft: { sum: 0, count: 0 }, tpot: { sum: 0, count: 0 }, tps: { sum: 0, count: 0 } };
  }
  stats.byModel[data.model].requests++;
  stats.byModel[data.model].promptTokens += data.tokens.prompt;
  stats.byModel[data.model].completionTokens += data.tokens.completion;
  stats.byModel[data.model].tokens += data.tokens.total;
  
  if (data.latency > 0) {
    if (!stats.byModel[data.model].latency) {
      stats.byModel[data.model].latency = { sum: 0, count: 0 };
    }
    stats.byModel[data.model].latency.sum += data.latency;
    stats.byModel[data.model].latency.count++;
  }
  
  if (data.ttft && data.ttft > 0) {
    if (!stats.byModel[data.model].ttft) {
      stats.byModel[data.model].ttft = { sum: 0, count: 0 };
    }
    stats.byModel[data.model].ttft.sum += data.ttft;
    stats.byModel[data.model].ttft.count++;
  }
  
  if (data.latency > 0 && data.tokens.completion > 0) {
    const tpms = data.latency / data.tokens.completion;
    const tps = data.tokens.completion / (data.latency / 1000);
    
    if (!stats.byModel[data.model].tpot) {
      stats.byModel[data.model].tpot = { sum: 0, count: 0 };
    }
    stats.byModel[data.model].tpot.sum += tpms;
    stats.byModel[data.model].tpot.count++;
    
    if (!stats.byModel[data.model].tps) {
      stats.byModel[data.model].tps = { sum: 0, count: 0 };
    }
    stats.byModel[data.model].tps.sum += tps;
    stats.byModel[data.model].tps.count++;
  }
  
  if (data.tokens.prompt > 0) {
    if (!stats.byModel[data.model].contextLength) {
      stats.byModel[data.model].contextLength = { sum: 0, count: 0 };
    }
    stats.byModel[data.model].contextLength.sum += data.tokens.prompt;
    stats.byModel[data.model].contextLength.count++;
  }
  
  if (data.apiKey) {
    if (!stats.byModel[data.model].apiKeys[data.apiKey]) {
      stats.byModel[data.model].apiKeys[data.apiKey] = { requests: 0, tokens: 0 };
    }
    stats.byModel[data.model].apiKeys[data.apiKey].requests++;
    stats.byModel[data.model].apiKeys[data.apiKey].tokens += data.tokens.total;
  }
  
  if (data.latency > 0) {
    stats.latency.sum += data.latency;
    stats.latency.count++;
    stats.latency.min = Math.min(stats.latency.min, data.latency);
    stats.latency.max = Math.max(stats.latency.max, data.latency);
  }
  
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
      userId: (apiKeys.find(k => k.apiKey === (data.apiKeyFull || data.apiKey)) || {}).userId || null,
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

function finalizeRequest(requestId, completionTokens, latency, status, error, ttft = null) {
  const pending = pendingRequests.get(requestId);
  if (!pending) return;
  
  pending.tokens.completion = completionTokens;
  pending.tokens.total = pending.tokens.prompt + completionTokens;
  pending.latency = latency;
  pending.status = status;
  pending.error = error;
  pending.ttft = ttft;
  
  updateStats(pending);
  pendingRequests.delete(requestId);
}

function extractTokenUsage(resData, reqBody = null, estimatedPrompt = 0) {
  let completion = 0;
  
  if (resData.usage) {
    completion = resData.usage.completion_tokens || 0;
  }
  
  if (resData.choices?.[0]?.usage) {
    completion = resData.choices[0].usage.completion_tokens || completion;
  }
  
  if (completion === 0) {
    if (resData.choices?.[0]?.message?.content) {
      const content = resData.choices[0].message.content;
      completion = Math.ceil(Buffer.byteLength(content) / 4);
    }
  }
  
  const prompt = estimatedPrompt || (resData.usage?.prompt_tokens || 0);
  
  return { prompt, completion, total: prompt + completion };
}

const requestStartTimes = new Map();
const requestFirstTokenTimes = new Map();
const pendingRequests = new Map();

async function proxyRequest(req, res) {
  const startTime = Date.now();
  const requestId = uuidv4();
  const clientApiKey = req.headers['authorization']?.replace('Bearer ', '') || 'anonymous';
  const model = req.body?.model || 'unknown';
  const isStream = req.body?.stream === true;
  
  const validApiKeys = apiKeys.filter(k => k.enabled).map(k => k.apiKey);
  if (config.enableAPIKey && clientApiKey !== 'anonymous' && !validApiKeys.includes(clientApiKey)) {
    const timestamp = new Date(startTime).toISOString();
    const keyInfo = apiKeys.find(k => k.apiKey === clientApiKey);
    const errorLog = {
      id: uuidv4(),
      timestamp,
      requestId,
      method: req.method,
      path: req.path,
      apiKey: clientApiKey,
      userId: keyInfo?.userId || null,
      model,
      errorType: 'INVALID_API_KEY',
      errorMessage: 'API Key不在允许列表中',
      latency: 0,
      resolved: false
    };
    errorLogs.push(errorLog);
    saveCurrentStats();
    return res.status(401).json({ error: 'Invalid API Key', message: 'API Key不在允许列表中' });
  }
  
  const promptTokens = Math.ceil(Buffer.byteLength(JSON.stringify(req.body?.messages || [])) / 4);
  
  pendingRequests.set(requestId, {
    requestId,
    timestamp: new Date(startTime).toISOString(),
    apiKey: clientApiKey.substring(0, 16) + '...',
    apiKeyFull: clientApiKey,
    model,
    method: req.method,
    path: req.path,
    status: 200,
    tokens: { prompt: promptTokens, completion: 0, total: promptTokens },
    latency: 0,
    error: null
  });
  
  requestStartTimes.set(requestId, startTime);
  
  const targetPath = req.path.replace(/^\/v1/, '');
  const targetUrl = `${lmStudioUrl}/v1${targetPath}`;
  
  if (config.promptOptimization?.enabled && req.body?.messages) {
    const validMessages = req.body.messages.filter(m => m && m.content && m.role);
    const currentTokens = countMessageTokens(validMessages);
    if (currentTokens >= config.promptOptimization.threshold && validMessages.length > 0) {
      const { threshold, strategy } = config.promptOptimization;
      const strategyParams = STRATEGY_CONFIG[strategy] || STRATEGY_CONFIG.preserve;
      
      const compressor = new TrimCompressor({
        maxModelTokens: threshold,
        thresholdPercent: strategyParams.thresholdPercent,
        minRecentMessages: strategyParams.minRecentMessages
      });
      
      const originalMessages = JSON.parse(JSON.stringify(validMessages));
      req.body.messages = await compressor.compress(validMessages);
      
      const optimizedTokens = countMessageTokens(req.body.messages);
      saveOptimizationLog(requestId, originalMessages, req.body.messages, strategy, currentTokens, optimizedTokens);
    }
  }
  
  const useApiKey = config.enableAPIKey === true;
  let apiKey = useApiKey && config.defaultAPIKey ? config.defaultAPIKey : null;
  
  if (config.lmAuthEnabled && config.lmAuthValue) {
    apiKey = config.lmAuthValue;
  }
  
  const authHeader = req.headers['authorization']?.replace('Bearer ', '') || apiKey;
  const isGetOrHead = req.method === 'GET' || req.method === 'HEAD';
  
  try {
    const response = await fetch(targetUrl, {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        ...(authHeader && { 'Authorization': `Bearer ${authHeader}` })
      },
      ...(!isGetOrHead && { body: JSON.stringify(req.body) })
    });

    if (config.enableLog) {
      const endTime = Date.now();
      const startTime = requestStartTimes.get(requestId) || endTime;
      console.log(`[PROXY] ${req.method} ${req.path} -> ${response.status} (${endTime - startTime}ms)`);
      console.log(`[PROXY] Request:`, JSON.stringify(req.body));
    }
    
    let streamContent = '';
    
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
              
              const endTime = Date.now();
              const startTime = requestStartTimes.get(requestId) || endTime;
              const firstTokenTime = requestFirstTokenTimes.get(requestId) || endTime;
              requestStartTimes.delete(requestId);
              requestFirstTokenTimes.delete(requestId);
              
              if (config.enableLog) {
                console.log(`[PROXY] Stream Response:`, streamContent);
              }
              
              const completionTokens = Math.ceil(Buffer.byteLength(streamContent) / 4);
              const ttft = firstTokenTime - startTime;
              finalizeRequest(requestId, completionTokens, Math.max(0, endTime - startTime), response.status, null, ttft);
              
              break;
            }
            const decoded = decoder.decode(value, { stream: true });
            streamContent += decoded;
            
            if (!requestFirstTokenTimes.has(requestId) && decoded.length > 0) {
              requestFirstTokenTimes.set(requestId, Date.now());
            }
            
            res.write(decoded);
          }
        } catch (error) {
          res.status(500).json({ error: error.message });
        }
      }
      
      pump();
      
      return;
    }
    
    const endTime = Date.now();
    const startTime = requestStartTimes.get(requestId) || endTime;
    const latency = Math.max(0, endTime - startTime);
    requestStartTimes.delete(requestId);
    
    const data = await response.json();
    
    if (config.enableLog) {
      console.log(`[PROXY] Response:`, JSON.stringify(data));
    }
    
    const tokens = extractTokenUsage(data, req.body, promptTokens);
    
    finalizeRequest(requestId, tokens.completion, latency, response.status, null);
    
    res.status(response.status).json(data);
    
  } catch (error) {
    const endTime = Date.now();
    const startTime = requestStartTimes.get(requestId) || endTime;
    requestStartTimes.delete(requestId);
    const latency = Math.max(0, endTime - startTime);
    const timestamp = new Date(startTime).toISOString();

    if (config.enableLog) {
      console.log(`[PROXY] ${req.method} ${req.path} -> ERROR: ${error.message} (${latency}ms)`);
      console.log(`[PROXY] Request:`, JSON.stringify(req.body));
    }
    
    finalizeRequest(requestId, 0, latency, 500, error.message);
    
    errorLogs.push({
      id: uuidv4(),
      timestamp,
      requestId,
      method: req.method,
      path: req.path,
      apiKey: clientApiKey,
      userId: (apiKeys.find(k => k.apiKey === clientApiKey) || {}).userId || null,
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

app.get('/apikey-search', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'apikey-search.html'));
});

app.get('/roocode-guide', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'roocode-guide.html'));
});

app.get('/opencode-guide', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'opencode-guide.html'));
});

app.get('/openclaw-guide', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'openclaw-guide.html'));
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
  const sortedRequests = [...stats.requests]
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, 30);
  res.json({
    ...stats,
    requests: sortedRequests,
    latency: stats.latency.count > 0 ? {
      avg: Math.round(stats.latency.sum / stats.latency.count),
      sum: stats.latency.sum,
      count: stats.latency.count,
      min: stats.latency.min === Infinity ? 0 : stats.latency.min,
      max: stats.latency.max
    } : { avg: 0, sum: 0, count: 0, min: 0, max: 0 }
  });
});

app.get('/api/weekly-trend', (req, res) => {
  const days = [];
  const today = new Date();
  
  for (let i = 29; i >= 0; i--) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    const dateStr = getDateStr(date);
    const logFile = getLogFileName(dateStr);
    
    let dayData = { date: dateStr, requests: 0, promptTokens: 0, completionTokens: 0, tokens: 0, cost: 0 };
    
    if (dateStr === getDateStr(today)) {
      dayData.requests = stats.totalRequestCount || stats.requests.length;
      dayData.promptTokens = stats.totalTokens.prompt;
      dayData.completionTokens = stats.totalTokens.completion;
      dayData.tokens = stats.totalTokens.prompt + stats.totalTokens.completion;
    } else if (fs.existsSync(logFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(logFile, 'utf8'));
        dayData.requests = data.totalRequestCount || data.requests?.length || 0;
        dayData.promptTokens = data.totalTokens?.prompt || 0;
        dayData.completionTokens = data.totalTokens?.completion || 0;
        dayData.tokens = (data.totalTokens?.prompt || 0) + (data.totalTokens?.completion || 0);
      } catch (e) {
        console.error(`读取${dateStr}失败:`, e.message);
      }
    }
    
    if (config.simCostEnabled && (config.simPromptCost > 0 || config.simCompletionCost > 0)) {
      dayData.cost = ((dayData.promptTokens / 1000000) * config.simPromptCost) + ((dayData.completionTokens / 1000000) * config.simCompletionCost);
    }
    
    const mmdd = dateStr.slice(4);
    dayData.label = `${mmdd.slice(0,2)}/${mmdd.slice(2)}`;
    days.push(dayData);
  }
  
  res.json(days);
});

function formatUserName(apiKey, apiKeysList) {
  let keyInfo = apiKeysList.find(k => k.apiKey === apiKey);
  if (!keyInfo && apiKey.endsWith('...')) {
    const prefix = apiKey.replace('...', '');
    keyInfo = apiKeysList.find(k => k.apiKey.startsWith(prefix));
  }
  if (keyInfo && keyInfo.phone) {
    const phone = keyInfo.phone.replace(/\D/g, '');
    if (phone.length >= 4) {
      return '***' + phone.slice(-4);
    }
    return '***' + phone;
  }
  if (keyInfo && keyInfo.userName) {
    return keyInfo.userName;
  }
  return apiKey;
}

app.get('/api/user-stats', (req, res) => {
  const userStats = {};
  
  for (const [apiKey, data] of Object.entries(stats.byApiKey)) {
    const userName = formatUserName(apiKey, apiKeys);
    if (!userStats[userName]) {
      userStats[userName] = { requests: 0, promptTokens: 0, completionTokens: 0, tokens: 0 };
    }
    userStats[userName].requests += data.requests;
    userStats[userName].promptTokens += data.promptTokens || 0;
    userStats[userName].completionTokens += data.completionTokens || 0;
    userStats[userName].tokens += data.tokens;
  }
  
  const sortedUsers = Object.entries(userStats)
    .sort((a, b) => b[1].tokens - a[1].tokens)
    .map(([userName, data]) => ({ userName, ...data }));
  
  const totalTokens = sortedUsers.reduce((sum, u) => sum + u.tokens, 0);
  const userPie = sortedUsers.map(u => ({
    userName: u.userName,
    promptTokens: u.promptTokens,
    completionTokens: u.completionTokens,
    tokens: u.tokens,
    percentage: totalTokens > 0 ? Math.round(u.tokens / totalTokens * 100) : 0
  }));
  
  res.json({ ranking: sortedUsers, pie: userPie });
});

app.get('/api/model-latency', (req, res) => {
  const modelLatency = Object.entries(stats.byModel)
    .map(([modelName, data]) => ({
      modelName,
      requests: data.requests,
      avgLatency: data.latency && data.latency.count > 0 ? Math.round(data.latency.sum / data.latency.count) : 0,
      avgContextLength: data.contextLength && data.contextLength.count > 0 ? Math.round(data.contextLength.sum / data.contextLength.count) : 0
    }))
    .sort((a, b) => b.requests - a.requests);
  
  res.json(modelLatency);
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
      .filter(f => f.endsWith('.json'))
      .map(f => {
        let dateStr = f.replace('.json', '');
        const isCurrent = dateStr === 'current';
        if (isCurrent) {
          dateStr = getDateStr();
        }
        const filePath = path.join(LOGS_DIR, f);
        const stats = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const promptTokens = stats.totalTokens?.prompt || 0;
        const completionTokens = stats.totalTokens?.completion || 0;
        const cost = config.simCostEnabled && (config.simPromptCost > 0 || config.simCompletionCost > 0)
          ? ((promptTokens / 1000000) * config.simPromptCost) + ((completionTokens / 1000000) * config.simCompletionCost)
          : 0;
        return {
          date: dateStr,
          displayDate: isCurrent ? `${dateStr.slice(0,4)}-${dateStr.slice(4,6)}-${dateStr.slice(6,8)} (今日)` : `${dateStr.slice(0,4)}-${dateStr.slice(4,6)}-${dateStr.slice(6,8)}`,
          requests: stats.totalRequestCount || stats.requests?.length || 0,
          errors: stats.errors || 0,
          totalTokens: promptTokens + completionTokens,
          cost: cost
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
  res.json({
    lmStudioUrl: lmStudioUrl || '',
    enableAPIKey: config.enableAPIKey || false,
    enableLog: config.enableLog || false,
    lmAuthEnabled: config.lmAuthEnabled || false,
    lmAuthValue: config.lmAuthValue || '',
    simCostEnabled: config.simCostEnabled || false,
    simPromptCost: config.simPromptCost || 0,
    simCompletionCost: config.simCompletionCost || 0
  });
});

app.post('/api/config', (req, res) => {
  const { lmStudioUrl: url, defaultAPIKey, enableAPIKey, enableLog, lmAuthEnabled, lmAuthValue, simCostEnabled, simPromptCost, simCompletionCost } = req.body;
  
  if (url) {
    lmStudioUrl = url;
  }
  
  if (defaultAPIKey !== undefined || enableAPIKey !== undefined || enableLog !== undefined || lmAuthEnabled !== undefined || lmAuthValue !== undefined || simCostEnabled !== undefined || simPromptCost !== undefined || simCompletionCost !== undefined) {
    if (defaultAPIKey !== undefined) config.defaultAPIKey = defaultAPIKey;
    if (enableAPIKey !== undefined) config.enableAPIKey = enableAPIKey;
    if (enableLog !== undefined) config.enableLog = enableLog;
    if (lmAuthEnabled !== undefined) config.lmAuthEnabled = lmAuthEnabled;
    if (lmAuthValue !== undefined) config.lmAuthValue = lmAuthValue;
    if (simCostEnabled !== undefined) config.simCostEnabled = simCostEnabled;
    if (simPromptCost !== undefined) config.simPromptCost = parseFloat(simPromptCost) || 0;
    if (simCompletionCost !== undefined) config.simCompletionCost = parseFloat(simCompletionCost) || 0;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  }
  
  res.json({ success: true, lmStudioUrl });
});

app.get('/api/prompt-config', (req, res) => {
  const opt = config.promptOptimization || { enabled: false, threshold: 4096, strategy: 'preserve', logRetentionDays: 30 };
  res.json(opt);
});

app.post('/api/prompt-config', (req, res) => {
  const { enabled, threshold, strategy, logRetentionDays } = req.body;
  
  config.promptOptimization = {
    enabled: Boolean(enabled),
    threshold: Math.max(4096, Number(threshold) || 4096),
    strategy: ['preserve', 'compress', 'balance'].includes(strategy) ? strategy : 'preserve',
    logRetentionDays: Math.max(1, Number(logRetentionDays) || 30)
  };
  
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  res.json({ success: true });
});

app.post('/api/test', async (req, res) => {
  const { url } = req.body;
  const testUrl = url || lmStudioUrl;
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
  stats.totalRequestCount = 0;
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

app.get('/api/apikeys', (req, res) => {
  res.json(apiKeys);
});

function generateApiKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = 'ux-';
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

app.post('/api/apikeys', (req, res) => {
  const { userName, userId, phone } = req.body;
  
  if (!userName) {
    return res.status(400).json({ error: '用户名不能为空' });
  }
  
  const newApiKey = {
    id: uuidv4(),
    apiKey: generateApiKey(),
    userName: userName,
    userId: userId || '',
    phone: phone || '',
    enabled: true,
    createdAt: new Date().toISOString(),
    lastUsedAt: null
  };
  
  apiKeys.push(newApiKey);
  saveApiKeys(apiKeys);
  res.json(newApiKey);
});

app.put('/api/apikeys/:id', (req, res) => {
  const { id } = req.params;
  const { userName, userId, phone, enabled } = req.body;
  
  const index = apiKeys.findIndex(k => k.id === id);
  if (index === -1) {
    return res.status(404).json({ error: 'API Key 不存在' });
  }
  
  if (userName !== undefined) apiKeys[index].userName = userName;
  if (userId !== undefined) apiKeys[index].userId = userId;
  if (phone !== undefined) apiKeys[index].phone = phone;
  if (enabled !== undefined) apiKeys[index].enabled = enabled;
  
  saveApiKeys(apiKeys);
  res.json(apiKeys[index]);
});

app.delete('/api/apikeys/:id', (req, res) => {
  const { id } = req.params;
  
  const index = apiKeys.findIndex(k => k.id === id);
  if (index === -1) {
    return res.status(404).json({ error: 'API Key 不存在' });
  }
  
  apiKeys.splice(index, 1);
  saveApiKeys(apiKeys);
  res.json({ success: true });
});

app.get('/api/resource-monitor', async (req, res) => {
  const resourceConfig = config.resourceMonitor || {};
  if (!resourceConfig.enabled) {
    return res.json({ enabled: false });
  }

  const dockerContainer = resourceConfig.dockerContainer || 'llamacppserver_llama-server_1';
  const maxConcurrent = resourceConfig.maxConcurrent || 4;
  
  let result = {
    enabled: true,
    concurrent: 0,
    maxConcurrent: maxConcurrent,
    gpuUsage: 0,
    vramUsed: 0,
    vramTotal: 0,
    timestamp: new Date().toISOString()
  };

  try {
    const { stdout: dockerLogs } = await execAsync(`docker logs --tail 30 ${dockerContainer} 2>&1`);
    if (dockerLogs.includes('all slots are idle')) {
      result.concurrent = 0;
    } else if (dockerLogs.includes('slot') || dockerLogs.includes('processing')) {
      const slotMatches = dockerLogs.match(/slot.*busy/gi);
      result.concurrent = slotMatches ? Math.min(slotMatches.length, maxConcurrent) : 1;
    }
  } catch (e) {
    console.error('Docker logs error:', e.message);
  }

  try {
    const { stdout: gpuUse } = await execAsync(`docker exec ${dockerContainer} sh -c 'cat /sys/class/drm/card0/device/gpu_busy_percent 2>/dev/null || echo 0'`);
    const gpuVal = parseInt(gpuUse.trim()) || 0;
    if (gpuVal > 0) {
      result.gpuUsage = gpuVal;
    } else {
      const { stdout: gpuUse2 } = await execAsync(`docker exec ${dockerContainer} sh -c 'cat /sys/class/drm/card0/device/gpu_busy_percent 2>/dev/null || echo 0'`);
      result.gpuUsage = parseInt(gpuUse2.trim()) || 0;
    }
  } catch (e) {
    console.error('GPU usage error:', e.message);
  }

  try {
    const { stdout: vramInfo } = await execAsync(`docker exec ${dockerContainer} sh -c 'cat /sys/class/drm/card0/device/mem_info_vram_used 2>/dev/null || cat /sys/class/drm/card0/device/mem_info_gtt_used 2>/dev/null || echo 0'`);
    const vramUsed = parseInt(vramInfo.trim()) || 0;
    if (vramUsed > 0) {
      result.vramUsed = Math.round(vramUsed / 1024 / 1024);
    }
  } catch (e) {
    console.error('VRAM usage error:', e.message);
  }

  res.json(result);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`LM Studio Proxy running on http://0.0.0.0:${PORT}`);
  console.log(`Forwarding requests to ${lmStudioUrl}`);
  console.log(`\nUsage: Change your API base URL to http://localhost:${PORT}/v1`);
});
