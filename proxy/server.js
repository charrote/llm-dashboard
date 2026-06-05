import express from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { TrimCompressor } from 'slimcontext';
import { exec } from 'child_process';
import { promisify } from 'util';
import yaml from 'js-yaml';

const execAsync = promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG_FILE = path.join(__dirname, 'config.json');
const APIKEYS_FILE = path.join(__dirname, 'apikeys.json');
let config = fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) : {};

config.simCostEnabled = config.simCostEnabled || false;
config.simPromptCost = config.simPromptCost || 0;
config.simCompletionCost = config.simCompletionCost || 0;
config.simCacheHitCost = config.simCacheHitCost || 0;
config.trendDays = config.trendDays || 30;
config.resourceMonitor = config.resourceMonitor || {
  enabled: true,
  dockerContainer: 'llamacppserver_llama-server_1',
  maxConcurrent: 4
};
config.layoutGrid = config.layoutGrid || 6;
config.cardWidths = config.cardWidths || {};
config.cardOrder = config.cardOrder || [];

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
  const raw = config.inferenceContainer || 'llamacppserver_llama-server_1';
  const container = raw.replace(/[^a-zA-Z0-9_.-]/g, '');
  const port = parseInt(config.inferencePort) || 1234;
  return {
    container,
    port,
    url: `http://${container}:${port}`
  };
}

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
  if (/[;&|$`<>(){}\\]/.test(projectDir)) return null;

  return {
    container,
    projectDir,
    composeFile: path.join(projectDir, 'docker-compose.yml'),
    source
  };
}

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

// Migrate legacy config fields to inferenceContainer/inferencePort.
// Priority: new fields > lmStudio.container/port > lmStudioUrl parse > LMSTUDIO_URL env > resourceMonitor.dockerContainer > defaults
if (
  typeof config.inferenceContainer !== 'string' || !config.inferenceContainer ||
  !Number.isFinite(parseInt(config.inferencePort))
) {
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

  if (!migratedContainer && process.env.LMSTUDIO_URL) {
    const m = process.env.LMSTUDIO_URL.match(/^https?:\/\/([^:/]+):(\d+)/);
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
  hourlyStatsBase: (getCurrentBeijingHour() + 1) % 24,
  totalTokens: { prompt: 0, completion: 0, cached: 0 },
  latency: { sum: 0, count: 0, min: Infinity, max: 0 },
  errors: 0
});

let stats = defaultStats();
let errorLogs = [];
let currentDate = getDateStr();
let isBenchmarking = false;

if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

function getDateStr(date = new Date()) {
  const bj = new Date(date.getTime() + 8 * 3600 * 1000);
  const yyyy = bj.getUTCFullYear();
  const mm = String(bj.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(bj.getUTCDate()).padStart(2, '0');
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
        const hasBase = data.hourlyStatsBase !== undefined && data.hourlyStatsBase !== null;
        stats = migrateStatsData({
          ...defaultStats(),
          ...data,
          totalTokens: { ...defaultStats().totalTokens, ...(data.totalTokens || {}) },
          hourlyStatsBase: hasBase ? data.hourlyStatsBase : undefined,
          latency: data.latency || { sum: 0, count: 0, min: Infinity, max: 0 }
        });
        if (!hasBase) {
          const currentHour = getCurrentBeijingHour();
          const newBase = (currentHour + 1) % 24;
          const newArray = new Array(24).fill(0).map(() => ({ requests: 0, tokens: 0, errors: 0 }));
          for (let i = 0; i < 24; i++) {
            if (stats.hourlyStats[i] && (stats.hourlyStats[i].requests > 0 || stats.hourlyStats[i].tokens > 0 || stats.hourlyStats[i].errors > 0)) {
              const newIndex = (i - newBase + 24) % 24;
              newArray[newIndex] = { ...stats.hourlyStats[i] };
            }
          }
          stats.hourlyStats = newArray;
          stats.hourlyStatsBase = newBase;
        }
        errorLogs = data.errorLogs || [];
      } else {
        const oldFile = getLogFileName(fileDate);
        fs.writeFileSync(oldFile, JSON.stringify(data, null, 2));
        const oldHourlyStats = data.hourlyStats;
        const oldBase = data.hourlyStatsBase;
        stats = defaultStats();
        if (oldHourlyStats && oldHourlyStats.length === 24 && oldBase !== undefined) {
          const currentHour = getCurrentBeijingHour();
          const expectedBase = (currentHour + 1) % 24;
          const newArray = new Array(24).fill(0).map(() => ({ requests: 0, tokens: 0, errors: 0 }));
          for (let i = 0; i < 24; i++) {
            const oldHour = (oldBase + i) % 24;
            const newIndex = (oldHour - expectedBase + 24) % 24;
            newArray[newIndex] = { ...oldHourlyStats[i] };
          }
          stats.hourlyStats = newArray;
          stats.hourlyStatsBase = expectedBase;
        }
        errorLogs = [];
      }
    }
  } catch (error) {
    console.error('加载数据失败:', error.message);
    stats = defaultStats();
    errorLogs = [];
  }
  supplementHourlyStatsFromArchives();
}

function supplementHourlyStatsFromArchives() {
  try {
    const files = fs.readdirSync(LOGS_DIR)
      .filter(f => /^\d{8}\.json$/.test(f))
      .sort()
      .reverse();
    for (const file of files) {
      if (file === 'current.json') continue;
      const filePath = path.join(LOGS_DIR, file);
      const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const archiveHourly = content.hourlyStats;
      const archiveBase = content.hourlyStatsBase;
      if (!archiveHourly || archiveHourly.length !== 24 || archiveBase === undefined) continue;
      const currentBase = stats.hourlyStatsBase;
      let filled = 0;
      for (let i = 0; i < 24; i++) {
        const slot = stats.hourlyStats[i];
        if (!slot.requests && !slot.tokens && !slot.errors) {
          const hour = (currentBase + i) % 24;
          const archiveSlot = archiveHourly[(hour - archiveBase + 24) % 24];
          if (archiveSlot && (archiveSlot.requests || archiveSlot.tokens || archiveSlot.errors)) {
            slot.requests = archiveSlot.requests || 0;
            slot.tokens = archiveSlot.tokens || 0;
            slot.errors = archiveSlot.errors || 0;
            filled++;
          }
        }
      }
      if (filled > 0) {
        console.log(`从归档 ${file} 补充了 ${filled} 个小时数据`);
        break;
      }
    }
  } catch (error) {
    console.error('补充小时数据失败:', error.message);
  }
}

function saveCurrentStats() {
  try {
    const today = getDateStr();
    if (today !== currentDate) {
      const oldFile = getLogFileName(currentDate);
      fs.writeFileSync(oldFile, JSON.stringify({ ...stats, date: currentDate, errorLogs }, null, 2));
      currentDate = today;
      const keptHourly = stats.hourlyStats;
      const keptBase = stats.hourlyStatsBase;
      stats = defaultStats();
      stats.hourlyStats = keptHourly;
      stats.hourlyStatsBase = keptBase;
      errorLogs = [];
    }
    fs.writeFileSync(CURRENT_LOG_FILE, JSON.stringify({ ...stats, date: today, errorLogs }, null, 2));
  } catch (error) {
    console.error('保存数据失败:', error.message);
  }
}

setInterval(() => {
  rotateHourlyStats();
  saveCurrentStats();
}, 60000);

loadCurrentStats();

function getCurrentBeijingHour(date = new Date()) {
  const hour = date.getUTCHours() + 8;
  return hour >= 24 ? hour - 24 : hour;
}

function rotateHourlyStats() {
  const currentHour = getCurrentBeijingHour();
  const expectedBase = (currentHour + 1) % 24;
  let base = stats.hourlyStatsBase;
  let diff = (expectedBase - base + 24) % 24;

  if (diff > 12) {
    const newArray = new Array(24).fill(0).map(() => ({ requests: 0, tokens: 0, errors: 0 }));
    for (let i = 0; i < 24; i++) {
      const oldHour = (base + i) % 24;
      const newIndex = (oldHour - expectedBase + 24) % 24;
      newArray[newIndex] = { ...stats.hourlyStats[i] };
    }
    stats.hourlyStats = newArray;
  } else {
    for (let i = 0; i < diff; i++) {
      stats.hourlyStats.shift();
      stats.hourlyStats.push({ requests: 0, tokens: 0, errors: 0 });
    }
  }
  stats.hourlyStatsBase = expectedBase;
}

function updateStats(data) {
  rotateHourlyStats();

  const requestDate = new Date(data.timestamp);
  const hour = getCurrentBeijingHour(requestDate);
  const slotIndex = (hour - stats.hourlyStatsBase + 24) % 24;
  
  stats.requests.push(data);
  if (stats.requests.length > 1000) stats.requests.shift();
  stats.totalRequestCount++;
  
  stats.hourlyStats[slotIndex].requests++;
  stats.hourlyStats[slotIndex].tokens += data.tokens.total;
  stats.totalTokens.prompt += data.tokens.prompt;
  stats.totalTokens.completion += data.tokens.completion;
  stats.totalTokens.cached += data.tokens.cached || 0;
  
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
    stats.hourlyStats[slotIndex].errors++;
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

function finalizeRequest(requestId, completionTokens, latency, status, error, ttft = null, forwardTime = 0, llmTime = 0, cachedTokens = 0, promptTokens = null) {
  const pending = pendingRequests.get(requestId);
  if (!pending) return;
  
  if (promptTokens !== null && promptTokens > 0) {
    pending.tokens.prompt = promptTokens;
  }
  
  const tpot = (ttft && completionTokens > 0 && latency > ttft) ? Math.round((latency - ttft) / completionTokens) : (completionTokens > 0 ? Math.round(latency / completionTokens) : null);
  
  pending.tokens.completion = completionTokens;
  pending.tokens.cached = cachedTokens;
  pending.tokens.total = pending.tokens.prompt + completionTokens;
  pending.latency = latency;
  pending.status = status;
  pending.error = error;
  pending.ttft = ttft;
  pending.tpot = tpot;
  pending.requestTime = forwardTime;
  pending.llmTime = llmTime;
  
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
  
  const prompt = resData.usage?.prompt_tokens || estimatedPrompt || 0;
  const cached = resData.usage?.prompt_tokens_details?.cached_tokens || 0;
  
  return { prompt, completion, total: prompt + completion, cached };
}

const requestStartTimes = new Map();
const requestFirstTokenTimes = new Map();
const requestForwardTimes = new Map();
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
  
  if (isBenchmarking && req.headers['x-internal'] !== 'benchmark') {
    return res.status(503).json({ error: '模型服务准备中，请稍后再试' });
  }
  
  const promptTokens = Math.ceil(Buffer.byteLength(JSON.stringify(req.body?.messages || [])) / 4);
  
  pendingRequests.set(requestId, {
    requestId,
    timestamp: new Date(startTime).toISOString(),
    apiKey: clientApiKey.substring(0, 16) + '...',
    apiKeyFull: clientApiKey,
    userId: (apiKeys.find(k => k.apiKey === clientApiKey) || {}).userId || null,
    model,
    method: req.method,
    path: req.path,
    status: 200,
    tokens: { prompt: promptTokens, completion: 0, total: promptTokens },
    latency: 0,
    error: null,
    ttft: null,
    tpot: null,
    requestTime: 0,
    llmTime: 0
  });
  
  requestStartTimes.set(requestId, startTime);
  requestForwardTimes.set(requestId, Date.now());
  
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
  
  let forwardTime = 0;
  let llmStart = Date.now();
  
  try {
    const forwardStart = requestForwardTimes.get(requestId) || Date.now();
    const response = await fetch(targetUrl, {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        ...(authHeader && { 'Authorization': `Bearer ${authHeader}` })
      },
      ...(!isGetOrHead && { body: JSON.stringify(req.body) })
    });
    requestForwardTimes.delete(requestId);
    const forwardEnd = Date.now();
    forwardTime = forwardEnd - forwardStart;
    llmStart = forwardEnd;

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
              const llmTime = endTime - llmStart;

              let cachedTokens = 0;
              let streamPromptTokens = 0;
              const lines = streamContent.split('\n');
              for (let i = lines.length - 1; i >= 0; i--) {
                const line = lines[i].trim();
                if (line.startsWith('data: ') && !line.includes('[DONE]')) {
                  try {
                    const data = JSON.parse(line.slice(6));
                    if (data.usage?.prompt_tokens) {
                      streamPromptTokens = data.usage.prompt_tokens;
                    }
                    if (data.usage?.prompt_tokens_details?.cached_tokens) {
                      cachedTokens = data.usage.prompt_tokens_details.cached_tokens;
                    }
                    if (data.usage) break;
                  } catch (_) {}
                }
              }

              finalizeRequest(requestId, completionTokens, Math.max(0, endTime - startTime), response.status, null, ttft, forwardTime, llmTime, cachedTokens, streamPromptTokens);
              
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
          try {
            res.end();
          } catch (_) {}
          const endTime = Date.now();
          const startTime = requestStartTimes.get(requestId) || endTime;
          requestStartTimes.delete(requestId);
          requestFirstTokenTimes.delete(requestId);
          finalizeRequest(requestId, 0, Math.max(0, endTime - startTime), 500, error.message, null, forwardTime, 0);
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
    const fwdEnd = Date.now();
    forwardTime = fwdEnd - forwardStart;
    llmStart = fwdEnd;
    
    if (config.enableLog) {
      console.log(`[PROXY] Response:`, JSON.stringify(data));
    }
    
    const tokens = extractTokenUsage(data, req.body, promptTokens);
    const llmTime = Date.now() - llmStart;
    finalizeRequest(requestId, tokens.completion, latency, response.status, null, null, forwardTime, llmTime, tokens.cached, tokens.prompt);
    
    res.status(response.status).json(data);
    
  } catch (error) {
    const endTime = Date.now();
    const startTime = requestStartTimes.get(requestId) || endTime;
    requestStartTimes.delete(requestId);
    requestForwardTimes.delete(requestId);
    const latency = Math.max(0, endTime - startTime);
    const timestamp = new Date(startTime).toISOString();

    if (config.enableLog) {
      console.log(`[PROXY] ${req.method} ${req.path} -> ERROR: ${error.message} (${latency}ms)`);
      console.log(`[PROXY] Request:`, JSON.stringify(req.body));
    }
    
    finalizeRequest(requestId, 0, latency, 500, error.message, null, forwardTime, 0);
    
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
    serverTime: Date.now(),
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
  
  const daysCount = config.trendDays || 30;
  for (let i = daysCount - 1; i >= 0; i--) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    const dateStr = getDateStr(date);
    const logFile = getLogFileName(dateStr);
    
    let dayData = { date: dateStr, requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, tokens: 0, cost: 0 };
    
    if (dateStr === getDateStr(today)) {
      dayData.requests = stats.totalRequestCount || stats.requests.length;
      dayData.promptTokens = stats.totalTokens.prompt;
      dayData.completionTokens = stats.totalTokens.completion;
      dayData.cachedTokens = stats.totalTokens.cached || 0;
      dayData.tokens = stats.totalTokens.prompt + stats.totalTokens.completion;
    } else if (fs.existsSync(logFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(logFile, 'utf8'));
        dayData.requests = data.totalRequestCount || data.requests?.length || 0;
        dayData.promptTokens = data.totalTokens?.prompt || 0;
        dayData.completionTokens = data.totalTokens?.completion || 0;
        dayData.cachedTokens = data.totalTokens?.cached || 0;
        dayData.tokens = (data.totalTokens?.prompt || 0) + (data.totalTokens?.completion || 0);
      } catch (e) {
        console.error(`读取${dateStr}失败:`, e.message);
      }
    }
    
    if (config.simCostEnabled && (config.simPromptCost > 0 || config.simCompletionCost > 0 || config.simCacheHitCost > 0)) {
      const hitRate = dayData.promptTokens > 0 ? Math.min(dayData.cachedTokens / dayData.promptTokens, 1) : 0;
      const uncachedPromptCost = (dayData.promptTokens / 1000000) * config.simPromptCost * (1 - hitRate);
      const cachedPromptCost = (dayData.promptTokens / 1000000) * (config.simCacheHitCost || 0) * hitRate;
      const completionCost = (dayData.completionTokens / 1000000) * config.simCompletionCost;
      dayData.cost = uncachedPromptCost + cachedPromptCost + completionCost;
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
        const cachedTokens = stats.totalTokens?.cached || 0;
        let cost = 0;
        if (config.simCostEnabled && (config.simPromptCost > 0 || config.simCompletionCost > 0 || config.simCacheHitCost > 0)) {
          const hitRate = promptTokens > 0 ? Math.min(cachedTokens / promptTokens, 1) : 0;
          const uncachedPromptCost = (promptTokens / 1000000) * config.simPromptCost * (1 - hitRate);
          const cachedPromptCost = (promptTokens / 1000000) * (config.simCacheHitCost || 0) * hitRate;
          const completionCost = (completionTokens / 1000000) * config.simCompletionCost;
          cost = uncachedPromptCost + cachedPromptCost + completionCost;
        }
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

app.post('/api/config', async (req, res) => {
  const {
    inferenceContainer, inferencePort, lmStudioUrl: url,
    defaultAPIKey, enableAPIKey, enableLog,
    lmAuthEnabled, lmAuthValue,
    simCostEnabled, simPromptCost, simCompletionCost, simCacheHitCost,
    trendDays, layoutGrid, cardWidths, cardOrder,
    composeProjectDir
  } = req.body;

  let inferenceChanged = false;

  if (typeof inferenceContainer === 'string' && inferenceContainer.trim()) {
    const trimmed = inferenceContainer.trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(trimmed)) {
      return res.status(400).json({ error: 'inferenceContainer 必须匹配 ^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$' });
    }
    if (trimmed !== config.inferenceContainer) {
      config.inferenceContainer = trimmed;
      inferenceChanged = true;
    }
  }
  if (inferencePort !== undefined && inferencePort !== null && inferencePort !== '') {
    const port = parseInt(inferencePort);
    if (Number.isFinite(port) && port >= 1 && port <= 65535) {
      if (port !== config.inferencePort) {
        config.inferencePort = port;
        inferenceChanged = true;
      }
    } else {
      return res.status(400).json({ error: 'inferencePort 必须是 1-65535 的整数' });
    }
  }
  if (composeProjectDir !== undefined) {
    if (typeof composeProjectDir !== 'string') {
      return res.status(400).json({ error: 'composeProjectDir 必须是字符串' });
    }
    const trimmed = composeProjectDir.trim();
    if (trimmed) {
      if (/[;&|$`<>(){}\\]/.test(trimmed)) {
        return res.status(400).json({ error: 'composeProjectDir 含有非法字符' });
      }
      config.composeProjectDir = trimmed;
    } else {
      delete config.composeProjectDir;
    }
  }

  // Backward compat: legacy client sends only lmStudioUrl
  const hasNewFields = (typeof inferenceContainer === 'string' && inferenceContainer.trim()) ||
                       (inferencePort !== undefined && inferencePort !== null && inferencePort !== '');
  if (!hasNewFields && url) {
    const m = url.match(/^https?:\/\/([^:/]+):(\d+)/);
    if (m) {
      if (config.inferenceContainer !== m[1]) {
        config.inferenceContainer = m[1];
        inferenceChanged = true;
      }
      const parsedPort = parseInt(m[2]);
      if (Number.isFinite(parsedPort) && parsedPort >= 1 && parsedPort <= 65535 && config.inferencePort !== parsedPort) {
        config.inferencePort = parsedPort;
        inferenceChanged = true;
      }
    }
  }

  if (inferenceChanged) {
    const inf = getInferenceConfig();
    lmStudioUrl = inf.url;
    // Auto-derive composeProjectDir when the user changed the container but did
    // not include composeProjectDir in this request. The "": clear and "/path":
    // honor cases are handled by the explicit parse block above; this branch
    // only fires for the undefined (omitted) case.
    if (composeProjectDir === undefined) {
      const probed = await probeComposeFor(inf.container);
      if (probed) {
        config.composeProjectDir = probed.projectDir;
        console.log(`[AUTO-DERIVE] composeProjectDir=${probed.projectDir} (from ${inf.container})`);
      }
    }
  }

  if (
    inferenceContainer !== undefined || inferencePort !== undefined ||
    defaultAPIKey !== undefined || enableAPIKey !== undefined || enableLog !== undefined ||
    lmAuthEnabled !== undefined || lmAuthValue !== undefined ||
    simCostEnabled !== undefined || simPromptCost !== undefined || simCompletionCost !== undefined || simCacheHitCost !== undefined ||
    trendDays !== undefined || layoutGrid !== undefined || cardWidths !== undefined || cardOrder !== undefined ||
    composeProjectDir !== undefined
  ) {
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
  const { container, port, url } = req.body;
  let testUrl;
  if (typeof container === 'string' && container.trim() && port !== undefined && port !== null && port !== '') {
    const safeName = container.trim().replace(/[^a-zA-Z0-9_.-]/g, '');
    const safePort = parseInt(port);
    if (!Number.isFinite(safePort) || safePort < 1 || safePort > 65535) {
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

app.get('/api/models', async (req, res) => {
  try {
    const response = await fetch(`${getInferenceConfig().url}/v1/models`);
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
  stats.hourlyStatsBase = (getCurrentBeijingHour() + 1) % 24;
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

let _prevCpuStat = null;

function calcCpuPct(line) {
  const parts = line.trim().split(/\s+/);
  const idle = parseInt(parts[4]) || 0;
  const total = parts.slice(1).reduce((s, v) => s + (parseInt(v) || 0), 0);
  return { idle, total };
}

async function getCpuInfo() {
  const out = { cores: 0, threads: 0, load: 0 };
  try {
    const { stdout: cpuinfo } = await execAsync("grep -c ^processor /proc/cpuinfo");
    out.threads = parseInt(cpuinfo.trim()) || 0;
  } catch {}
  try {
    const { stdout: coreinfo } = await execAsync("grep 'cpu cores' /proc/cpuinfo | head -1 | awk '{print $4}'");
    out.cores = parseInt(coreinfo.trim()) || out.threads;
  } catch {}
  try {
    const { stdout: stat } = await execAsync("head -1 /proc/stat");
    const cur = calcCpuPct(stat);
    if (_prevCpuStat) {
      const idleDelta = cur.idle - _prevCpuStat.idle;
      const totalDelta = cur.total - _prevCpuStat.total;
      out.load = totalDelta > 0 ? Math.round((1 - idleDelta / totalDelta) * 100) : 0;
    }
    _prevCpuStat = cur;
  } catch {}
  return out;
}

async function getGpuDetails(container, modelFallback) {
  const info = { model: modelFallback || '', load: 0, temp: 0, power: 0 };
  try {
    const { stdout: gpuUse } = await execAsync(`docker exec ${container} sh -c 'cat /sys/class/drm/card0/device/gpu_busy_percent 2>/dev/null || echo 0'`);
    info.load = parseInt(gpuUse.trim()) || 0;
  } catch {}

  try {
    const { stdout: tmp } = await execAsync(`docker exec ${container} sh -c 'cat /sys/class/drm/card0/device/hwmon/hwmon*/temp1_input 2>/dev/null || echo 0'`);
    const t = parseInt(tmp.trim());
    if (t > 0) info.temp = Math.round(t / 1000);
  } catch {}

  try {
    const { stdout: pwr } = await execAsync(`docker exec ${container} sh -c 'cat /sys/class/drm/card0/device/hwmon/hwmon*/power1_average 2>/dev/null || echo 0'`);
    const p = parseInt(pwr.trim());
    if (p > 0) info.power = Math.round(p / 1000000);
  } catch {}

  try {
    const { stdout: name } = await execAsync(`docker exec ${container} sh -c 'rocm-smi --showproductname 2>/dev/null' | grep 'Product Name' | head -1 | sed 's/.*: *//'`);
    const n = name.trim();
    if (n) info.model = n;
  } catch {}

  return info;
}

async function getMemInfo() {
  const out = { totalGB: 0, usedGB: 0, percent: 0 };
  try {
    const { stdout: mem } = await execAsync("awk '/MemTotal/{t=$2} /MemAvailable/{a=$2} END{printf \"%.0f %.0f\", t, a}' /proc/meminfo");
    const [totalKb, availKb] = mem.trim().split(/\s+/).map(Number);
    if (totalKb > 0) {
      out.totalGB = +(totalKb / 1024 / 1024).toFixed(1);
      const usedKb = totalKb - availKb;
      out.usedGB = +(usedKb / 1024 / 1024).toFixed(1);
      out.percent = Math.round((usedKb / totalKb) * 100);
    }
  } catch {}
  return out;
}

app.get('/api/resource-monitor', async (req, res) => {
  const resourceConfig = config.resourceMonitor || {};
  if (!resourceConfig.enabled) {
    return res.json({ enabled: false });
  }

  const dockerContainer = getInferenceConfig().container;
  const maxConcurrent = resourceConfig.maxConcurrent || 4;
  
  let result = {
    enabled: true,
    concurrent: 0,
    maxConcurrent: maxConcurrent,
    gpuUsage: 0,
    vramUsed: 0,
    vramTotal: 0,
    cpu: null,
    gpu: null,
    memory: null,
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
    result.gpuUsage = parseInt(gpuUse.trim()) || 0;
  } catch (e) {
    console.error('GPU usage error:', e.message);
  }

  try {
    const { stdout: vramUsedInfo } = await execAsync(`docker exec ${dockerContainer} sh -c 'cat /sys/class/drm/card0/device/mem_info_gtt_used 2>/dev/null || cat /sys/class/drm/card0/device/mem_info_vram_used 2>/dev/null || echo 0'`);
    const vramUsed = parseInt(vramUsedInfo.trim()) || 0;
    if (vramUsed > 0) {
      result.vramUsed = Math.round(vramUsed / 1024 / 1024);
    }

    const { stdout: vramTotalInfo } = await execAsync(`docker exec ${dockerContainer} sh -c 'cat /sys/class/drm/card0/device/mem_info_gtt_total 2>/dev/null || cat /sys/class/drm/card0/device/mem_info_vram_total 2>/dev/null || echo 0'`);
    const vramTotal = parseInt(vramTotalInfo.trim()) || 0;
    if (vramTotal > 0) {
      result.vramTotal = Math.round(vramTotal / 1024 / 1024);
    }
  } catch (e) {
    console.error('VRAM usage error:', e.message);
  }

  const [cpu, gpu, memory] = await Promise.all([
    getCpuInfo(),
    getGpuDetails(dockerContainer, resourceConfig.gpuModel),
    getMemInfo()
  ]);
  result.cpu = cpu;
  result.gpu = gpu;
  result.memory = memory;

  res.json(result);
});

let recentEfficiency = { ttft: 0, tpot: 0, tps: 0, requestTime: 0, llmTime: 0 };

app.get('/api/efficiency', (req, res) => {
  const recentRequests = stats.requests.slice(-20).filter(r => r.ttft || r.tpot);
  if (recentRequests.length > 0) {
    const validRequests = recentRequests.filter(r => (r.ttft || r.tpot) && r.tokens?.completion > 0);
    if (validRequests.length > 0) {
      const totalTtft = validRequests.reduce((sum, r) => sum + (r.ttft || 0), 0);
      const totalTpot = validRequests.reduce((sum, r) => sum + (r.tpot || 0), 0);
      const totalTokens = validRequests.reduce((sum, r) => sum + r.tokens.completion, 0);
      const totalLatency = validRequests.reduce((sum, r) => sum + r.latency, 0);
      const totalRequestTime = validRequests.reduce((sum, r) => sum + (r.requestTime || 0), 0);
      const totalLlmTime = validRequests.reduce((sum, r) => sum + (r.llmTime || 0), 0);
      
      recentEfficiency = {
        ttft: Math.round(totalTtft / validRequests.length),
        tpot: Math.round(totalTpot / validRequests.length),
        tps: totalLatency > 0 ? Math.round(totalTokens / (totalLatency / 1000)) : 0,
        requestTime: Math.round(totalRequestTime / validRequests.length),
        llmTime: Math.round(totalLlmTime / validRequests.length)
      };
    }
  }
  res.json(recentEfficiency);
});

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

const BENCHMARK_PARAGRAPH = '深度学习模型在大规模语言理解任务中表现出了卓越的性能。这些模型通过海量文本数据的预训练，能够捕捉到丰富的语义信息和语法结构。在自然语言处理领域，transformer架构的引入彻底改变了模型的设计范式，使得模型能够更好地处理长距离依赖关系。上下文理解能力是大语言模型最核心的能力之一，它决定了模型在复杂任务上的表现。模型通过自注意力机制可以同时关注输入序列中的所有位置，从而建立全局依赖关系。这种机制使得模型在处理长文本时能够保持对前后文的一致性理解。随着模型规模的不断扩大，大语言模型展现出了许多令人惊叹的涌现能力，包括少样本学习、逻辑推理和代码生成等。';

function generateBenchmarkPrompt(targetTokens) {
  let result = '';
  let estimatedTokens = 0;
  while (estimatedTokens < targetTokens) {
    result += BENCHMARK_PARAGRAPH;
    estimatedTokens = Math.ceil(Buffer.byteLength(result, 'utf-8') / 4);
  }
  return result;
}

const PROXY_INTERNAL = `http://127.0.0.1:${PORT}`;

async function runBenchmarkIteration(model, targetTokens, iteration, prompt) {
  const url = `${PROXY_INTERNAL}/v1/chat/completions`;
  const startTime = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 600000);
    const response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'x-internal': 'benchmark' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: '你是AI助手，请用简洁的语言回答问题。回答不超过50个字。' },
          { role: 'user', content: `${prompt}\n请用一句话总结以上内容的核心观点。` }
        ],
        temperature: 0.7,
        max_tokens: 100,
        stream: false
      })
    });
    clearTimeout(timeout);
    const latency = Date.now() - startTime;
    const data = await response.json();
    const usage = data.usage || {};
    const promptTokens = usage.prompt_tokens || 0;
    const completionTokens = usage.completion_tokens || 0;
    const totalTokens = usage.total_tokens || 0;
    const totalSpeed = totalTokens > 0 && latency > 0 ? Math.round(totalTokens / (latency / 1000)) : 0;
    const genTps = completionTokens > 0 && latency > 0 ? parseFloat((completionTokens / (latency / 1000)).toFixed(1)) : 0;
    const tpot = completionTokens > 0 ? Math.round(latency / completionTokens) : 0;
    console.log(`[BENCHMARK] ${model} ${targetTokens} iter ${iteration}: ${latency}ms`);
    return { iteration, latency, promptTokens, completionTokens, totalTokens, totalSpeed, genTps, tpot, error: null };
  } catch (err) {
    console.log(`[BENCHMARK] ${model} ${targetTokens} iter ${iteration} error: ${err.message}`);
    return { iteration, error: err.message };
  }
}

function sendSSE(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

app.get('/api/benchmark', async (req, res) => {
  const rawCtx = req.query.contextSizes || '8000';
  const contextSizes = rawCtx.split(',').map(Number).filter(n => n > 0);
  const iterations = parseInt(req.query.iterations) || 2;
  const model = req.query.model || '';

  if (contextSizes.length === 0 || !model) {
    return res.status(400).json({ error: 'contextSizes and model required' });
  }

  let aborted = false;
  req.on('close', () => {
    aborted = true;
    isBenchmarking = false;
  });

  const allResults = {};
  const benchStart = Date.now();

  isBenchmarking = true;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  sendSSE(res, { type: 'start', model, iterations, contextSizes });

  for (const ctxSize of contextSizes) {
    if (aborted) break;
    const ctxStartTime = Date.now();
    const prompt = generateBenchmarkPrompt(ctxSize);
    sendSSE(res, { type: 'progress', ctxSize, message: `开始测试 ${ctxSize/1000}K...` });

    const iterResults = [];
    for (let i = 1; i <= iterations; i++) {
      if (aborted) break;
      const startTime = Date.now();
      const result = await runBenchmarkIteration(model, ctxSize, i, prompt);
      result.ctxSize = ctxSize;
      iterResults.push(result);
      sendSSE(res, { type: 'iteration', ctxSize, iteration: i, result });
    }

    if (aborted) break;

    const valid = iterResults.filter(r => !r.error);
    const summary = valid.length > 0 ? {
      coldStart: valid[0] ? { latency: valid[0].latency, totalSpeed: valid[0].totalSpeed, genTps: valid[0].genTps, tpot: valid[0].tpot } : null,
      warmLatency: valid.length > 1 ? Math.round(valid.slice(1).reduce((s, r) => s + r.latency, 0) / (valid.length - 1)) : null,
      warmGenTps: valid.length > 1 ? parseFloat((valid.slice(1).reduce((s, r) => s + r.genTps, 0) / (valid.length - 1)).toFixed(1)) : null,
      warmTpot: valid.length > 1 ? Math.round(valid.slice(1).reduce((s, r) => s + r.tpot, 0) / (valid.length - 1)) : null,
      avgLatency: Math.round(valid.reduce((s, r) => s + r.latency, 0) / valid.length),
      avgGenTps: parseFloat((valid.reduce((s, r) => s + r.genTps, 0) / valid.length).toFixed(1)),
      avgTpot: Math.round(valid.reduce((s, r) => s + r.tpot, 0) / valid.length),
      avgTotalSpeed: Math.round(valid.reduce((s, r) => s + r.totalSpeed, 0) / valid.length)
    } : null;

    const ctxDuration = Date.now() - ctxStartTime;
    allResults[ctxSize] = { results: iterResults, summary };
    sendSSE(res, { type: 'ctxDone', ctxSize, summary, ctxDuration });
  }

  const totalTime = Date.now() - benchStart;
  isBenchmarking = false;

  if (aborted) {
    console.log(`[BENCHMARK] Aborted after ${totalTime}ms`);
    return res.end();
  }

  sendSSE(res, { type: 'complete', totalTime, allResults, contextSizes, model, iterations });
  console.log(`[BENCHMARK] Complete: ${totalTime}ms`);
  res.end();
});

app.post('/api/benchmark/cancel', (req, res) => {
  isBenchmarking = false;
  res.json({ success: true, message: 'Benchmark cancelled' });
});

app.get('/api/model-config', async (req, res) => {
  const { model } = req.query;
  if (!model) return res.status(400).json({ error: 'model required' });
  try {
    const { stdout } = await execAsync(`docker exec ${getInferenceConfig().container} cat /app/models.ini`);
    const lines = stdout.split('\n');
    const sectionStart = lines.findIndex(l => l.trim() === `[${model}]`);
    if (sectionStart === -1) return res.status(404).json({ error: 'model section not found' });
    let sectionEnd = lines.length;
    for (let i = sectionStart + 1; i < lines.length; i++) {
      if (lines[i].trim().startsWith('[') && lines[i].trim().endsWith(']')) {
        sectionEnd = i;
        break;
      }
    }
    const sectionLines = lines.slice(sectionStart, sectionEnd);
    res.json({ model, content: sectionLines.join('\n') });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/model-config', async (req, res) => {
  const { model, content } = req.body;
  if (!model || !content) return res.status(400).json({ error: 'model and content required' });
  try {
    const { stdout } = await execAsync(`docker exec ${getInferenceConfig().container} cat /app/models.ini`);
    const lines = stdout.split('\n');
    const sectionStart = lines.findIndex(l => l.trim() === `[${model}]`);
    if (sectionStart === -1) return res.status(404).json({ error: 'model section not found' });
    let sectionEnd = lines.length;
    for (let i = sectionStart + 1; i < lines.length; i++) {
      if (lines[i].trim().startsWith('[') && lines[i].trim().endsWith(']')) {
        sectionEnd = i;
        break;
      }
    }
    const newLines = [...lines.slice(0, sectionStart), ...content.split('\n'), ...lines.slice(sectionEnd)];
    const newContent = newLines.join('\n');
    const b64 = Buffer.from(newContent, 'utf-8').toString('base64');
    await execAsync(`docker run --rm -i -v /home/uantek/dev/llama.cpp.server-mtp:/target busybox sh -c 'echo ${b64} | base64 -d > /target/models.ini'`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
    // User-set values are preserved — they can clear the field to re-trigger detection.
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
  } catch (err) {
    res.status(500).json({ available: false, reason: `读取文件失败: ${err.message}` });
  }
});

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
  if (/[;&|$`<>(){}\\]/.test(compose.projectDir)) {
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`LM Studio Proxy running on http://0.0.0.0:${PORT}`);
  console.log(`Forwarding requests to ${lmStudioUrl}`);
  console.log(`\nUsage: Change your API base URL to http://localhost:${PORT}/v1`);
});
