#!/usr/bin/env node

const http = require('http');
const { spawn } = require('child_process');
const { URL } = require('url');
const fs = require('fs').promises;
const path = require('path');
const cron = require('node-cron');
const Busboy = require('busboy');

const PORT = process.env.TRIGGER_PORT || 3001;
const API_KEY = process.env.API_KEY || '';
const SCRIPTS_DIR = '/app/scripts';
const USER_DATA_SCRIPTS_DIR = '/app/puppeteer_user_data';
const LOG_FILE = path.join(USER_DATA_SCRIPTS_DIR, 'logs.txt');
const MAX_HISTORY = 30;
const MAX_LOG_DAYS = 30;

// 脚本显示名称映射
const SCRIPT_DISPLAY_NAMES = {
  'quick-plan-update.js': '【快速更新密钥】',
  'update-pdd.js': '【旧版更新密钥】',
  'update-pdd-new.js': '【新版更新密钥】',
  'update-pdd-cron.js': '【ClawCloud专用更新】',
  'update-clawcloud-token.js': '【刷新ClawCloud口令】',
  'quick-update-bill.js': '【更新账单密钥】'
};

function getDisplayName(scriptFileName) {
  return SCRIPT_DISPLAY_NAMES[scriptFileName] || scriptFileName.replace(/\.js$/, '');
}

// ---------- 全局状态 ----------
let isRunning = false;
let currentScript = null;
let currentChild = null;
let currentTimeout = null;
let taskQueue = [];
let lastRunResult = null;
let lastRunTime = null;

// 历史记录（内存），每条记录包含开始时间、脚本、耗时、成功状态、退出码
let history = [];

// SSE 客户端列表
let sseClients = [];

// ---------- 辅助函数 ----------
function beijingTime(date = new Date()) {
  return date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

function sendSSE(event, data) {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(client => client.write(message));
}

function broadcastLog(level, message) {
  sendSSE('log', { level, message, timestamp: beijingTime() });
}

function broadcastState() {
  const state = {
    isRunning,
    currentScript,
    queueLength: taskQueue.length,
    lastRun: lastRunTime ? beijingTime(lastRunTime) : null,
    lastRunResult: lastRunResult ? {
      script: lastRunResult.script,
      success: lastRunResult.success,
      duration: lastRunResult.duration,
      timestamp: lastRunResult.timestamp   // 这是开始时间
    } : null
  };
  sendSSE('state', state);
}

async function appendHistoryLog(entry) {
  const line = `${entry.timestamp} | ${entry.script} | 耗时:${entry.duration}s | ${entry.success ? '成功' : '失败'} | 退出码:${entry.exitCode}\n`;
  try {
    await fs.appendFile(LOG_FILE, line, 'utf8');
  } catch (err) {
    console.error('写入历史日志失败:', err.message);
  }
}

async function cleanOldLogs() {
  try {
    const content = await fs.readFile(LOG_FILE, 'utf8');
    const lines = content.split(/\r?\n/).filter(l => l.trim());
    const now = new Date();
    const cutoff = new Date(now.getTime() - MAX_LOG_DAYS * 24 * 60 * 60 * 1000);
    const kept = [];
    for (const line of lines) {
      const dateStr = line.split(' | ')[0];
      const logDate = new Date(dateStr);
      if (!isNaN(logDate) && logDate >= cutoff) kept.push(line);
    }
    await fs.writeFile(LOG_FILE, kept.join('\n') + (kept.length ? '\n' : ''), 'utf8');
    console.log(`[${beijingTime()}] 日志清理完成，保留 ${kept.length} 条记录`);
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('清理旧日志失败:', err.message);
  }
}

// 添加历史记录（使用开始时间、脚本名、耗时、成功标志、退出码）
function addToHistory(script, startTimeStr, duration, success, exitCode) {
  const record = {
    timestamp: startTimeStr,   // 脚本开始时间（北京时间字符串）
    script,
    duration,
    success,
    exitCode
  };
  history.unshift(record);
  if (history.length > MAX_HISTORY) history.pop();
  // 持久化
  appendHistoryLog(record);
}

// 执行脚本的核心函数（实际运行）
function runScriptTask(scriptName, resolve, reject) {
  if (currentChild) {
    reject(new Error('已有脚本在运行，但队列机制应防止此情况'));
    return;
  }

  isRunning = true;
  currentScript = scriptName;
  broadcastState();
  const startTime = Date.now();
  const startTimeStr = beijingTime(new Date(startTime));
  console.log("==========================================");
  console.log(`[${startTimeStr}] 开始执行脚本: ${scriptName}`);
  broadcastLog('info', `开始执行脚本: ${scriptName}`);

  getScriptPath(scriptName).then(scriptPath => {
    if (!scriptPath) throw new Error(`脚本 ${scriptName} 不存在`);

    const child = spawn('node', [scriptPath], {
      stdio: 'pipe',
      env: process.env,
      cwd: '/app'
    });
    currentChild = child;

    currentTimeout = setTimeout(() => {
      broadcastLog('error', `脚本 ${scriptName} 执行超时，强制终止`);
      child.kill('SIGTERM');
    }, 30 * 60 * 1000);

    let output = '';
    let errorOutput = '';

    child.stdout.on('data', (data) => {
      const str = data.toString();
      output += str;
      console.log(`[${scriptName} 输出] ${str.trim()}`);
      broadcastLog('stdout', str.trim());
    });

    child.stderr.on('data', (data) => {
      const str = data.toString();
      errorOutput += str;
      console.error(`[${scriptName} 错误] ${str.trim()}`);
      broadcastLog('stderr', str.trim());
    });

    child.on('close', (code) => {
      if (currentTimeout) clearTimeout(currentTimeout);
      currentChild = null;
      currentTimeout = null;
      isRunning = false;
      const endTime = new Date();
      const duration = Math.floor((Date.now() - startTime) / 1000);
      lastRunTime = endTime;
      const success = code === 0;
      const result = {
        success,
        exitCode: code,
        script: scriptName,
        timestamp: startTimeStr,
        duration,
        output: output.slice(-5000),
        error: errorOutput.slice(-5000)
      };
      lastRunResult = result;
      console.log(`[${beijingTime(endTime)}] 脚本 ${scriptName} 执行完成，退出码: ${code}`);
      console.log(`总运行时长: ${duration} 秒`);
      broadcastLog('info', `脚本 ${scriptName} 执行完成，退出码: ${code}，耗时 ${duration} 秒`);
      console.log("==========================================");

      addToHistory(scriptName, startTimeStr, duration, success, code);
      broadcastState();

      resolve(result);
      runNext();
    });

    child.on('error', (err) => {
      if (currentTimeout) clearTimeout(currentTimeout);
      currentChild = null;
      currentTimeout = null;
      isRunning = false;
      const duration = Math.floor((Date.now() - startTime) / 1000);
      const result = {
        success: false,
        exitCode: -1,
        script: scriptName,
        timestamp: startTimeStr,
        duration,
        output: output.slice(-5000),
        error: err.message
      };
      lastRunResult = result;
      console.error(`[${beijingTime()}] 脚本 ${scriptName} 执行错误: ${err.message}`);
      broadcastLog('error', `脚本 ${scriptName} 执行错误: ${err.message}`);
      addToHistory(scriptName, startTimeStr, duration, false, -1);
      broadcastState();
      resolve(result);
      runNext();
    });
  }).catch(err => {
    const duration = 0;
    const result = {
      success: false,
      exitCode: -1,
      script: scriptName,
      timestamp: startTimeStr,
      duration,
      output: '',
      error: err.message
    };
    lastRunResult = result;
    console.error(`[${beijingTime()}] 脚本 ${scriptName} 定位失败: ${err.message}`);
    broadcastLog('error', `脚本 ${scriptName} 定位失败: ${err.message}`);
    addToHistory(scriptName, startTimeStr, duration, false, -1);
    isRunning = false;
    currentScript = null;
    broadcastState();
    resolve(result);
    runNext();
  });
}

function queueScript(scriptName) {
  return new Promise((resolve, reject) => {
    taskQueue.push({ scriptName, resolve, reject });
    broadcastState();
    if (!isRunning) runNext();
  });
}

function runNext() {
  if (taskQueue.length === 0) return;
  if (isRunning) return;
  const { scriptName, resolve, reject } = taskQueue.shift();
  broadcastState();
  runScriptTask(scriptName, resolve, reject);
}

async function stopCurrentScript() {
  if (!currentChild) {
    return { success: false, message: '没有正在运行的脚本' };
  }
  currentChild.kill('SIGTERM');
  if (currentTimeout) clearTimeout(currentTimeout);
  currentChild = null;
  currentTimeout = null;
  isRunning = false;
  currentScript = null;
  broadcastState();
  return { success: true, message: '已发送终止信号' };
}

async function getAvailableScripts() {
  const scriptMap = new Map();
  try {
    const mainFiles = await fs.readdir(SCRIPTS_DIR);
    for (const file of mainFiles) {
      if (file.endsWith('.js') && file !== 'trigger-server.js' && file !== 'proxy.js') {
        if (!scriptMap.has(file)) scriptMap.set(file, SCRIPTS_DIR);
      }
    }
  } catch (err) { /* 忽略 */ }
  try {
    const userFiles = await fs.readdir(USER_DATA_SCRIPTS_DIR);
    for (const file of userFiles) {
      if (file.endsWith('.js')) {
        if (!scriptMap.has(file)) scriptMap.set(file, USER_DATA_SCRIPTS_DIR);
        else console.warn(`脚本名冲突: "${file}" 同时存在于两个目录，使用主目录的版本`);
      }
    }
  } catch (err) { if (err.code !== 'ENOENT') console.error(err); }
  return Array.from(scriptMap.keys());
}

async function getScriptPath(scriptName) {
  const mainPath = path.join(SCRIPTS_DIR, scriptName);
  try { await fs.access(mainPath); return mainPath; } catch { /* */ }
  const userPath = path.join(USER_DATA_SCRIPTS_DIR, scriptName);
  try { await fs.access(userPath); return userPath; } catch { return null; }
}

async function loadHistoryFromFile() {
  try {
    const content = await fs.readFile(LOG_FILE, 'utf8');
    const lines = content.split(/\r?\n/).filter(l => l.trim());
    const records = [];
    for (const line of lines.slice(-MAX_HISTORY)) {
      const match = line.match(/^(.+?) \| (.+?) \| 耗时:(\d+)s \| (成功|失败) \| 退出码:(-?\d+)/);
      if (match) {
        records.push({
          timestamp: match[1],
          script: match[2],
          duration: parseInt(match[3]),
          success: match[4] === '成功',
          exitCode: parseInt(match[5])
        });
      }
    }
    history = records.reverse();
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('加载历史日志失败:', err.message);
  }
}

// ---------- HTTP 服务器 ----------
const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;
  const method = req.method;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const protectedPaths = ['/run/', '/trigger', '/stop', '/upload', '/script/'];
  if (API_KEY && protectedPaths.some(p => pathname === p || pathname.startsWith(p))) {
    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${API_KEY}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '未授权访问' }));
      return;
    }
  }

  // 健康检查
  if (pathname === '/health' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      service: 'crawler-trigger',
      port: PORT,
      crawler_running: isRunning,
      current_script: currentScript,
      last_run: lastRunTime ? beijingTime(lastRunTime) : null
    }));
    return;
  }

  // 状态查询（兼容）
  if (pathname === '/status' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      crawler_running: isRunning,
      current_script: currentScript,
      queue_length: taskQueue.length,
      last_run_time: lastRunTime ? beijingTime(lastRunTime) : null,
      last_run_result: lastRunResult ? {
        success: lastRunResult.success,
        exitCode: lastRunResult.exitCode,
        script: lastRunResult.script,
        timestamp: lastRunResult.timestamp,
        duration: lastRunResult.duration
      } : null
    }));
    return;
  }

  // 历史记录
  if (pathname === '/history' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(history));
    return;
  }

  // 触发脚本（加入队列）
  if (pathname.startsWith('/run/') && method === 'POST') {
    const scriptName = pathname.substring(5);
    if (!scriptName || !scriptName.endsWith('.js')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '无效的脚本名' }));
      return;
    }
    const available = await getAvailableScripts();
    if (!available.includes(scriptName)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '脚本不存在' }));
      return;
    }
    const result = await queueScript(scriptName);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      message: `脚本 ${scriptName} 已触发`,
      result: {
        success: result.success,
        exitCode: result.exitCode,
        script: result.script,
        timestamp: result.timestamp,
        duration: result.duration
      }
    }));
    return;
  }

  // 默认触发
  if (pathname === '/trigger' && method === 'POST') {
    const result = await queueScript('update-pdd-cron.js');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      message: '爬虫任务已触发',
      result: {
        success: result.success,
        exitCode: result.exitCode,
        script: result.script,
        timestamp: result.timestamp,
        duration: result.duration
      }
    }));
    return;
  }

  // 终止脚本
  if (pathname === '/stop' && method === 'POST') {
    const result = await stopCurrentScript();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // ---------- 上传脚本（适配 busboy@1.6.0）----------
  if (pathname === '/upload' && method === 'POST') {
    const busboy = Busboy({ headers: req.headers, limits: { fileSize: 10 * 1024 * 1024 } });
    let savedFile = null;
    let errorMsg = null;

    busboy.on('file', (fieldname, file, filename, encoding, mimetype) => {
      // busboy@1.6.0 的回调参数顺序为 (fieldname, file, filename, encoding, mimetype)
      // filename 可能是字符串或 null，需要转换
      let safeFilename = '';
      if (filename && typeof filename === 'string') safeFilename = filename.trim();
      else if (filename) safeFilename = filename.toString().trim();

      if (!safeFilename || !safeFilename.endsWith('.js')) {
        file.resume();
        errorMsg = '只允许上传 .js 文件';
        return;
      }
      const baseName = path.basename(safeFilename);
      const savePath = path.join(USER_DATA_SCRIPTS_DIR, baseName);
      const writeStream = require('fs').createWriteStream(savePath);
      file.pipe(writeStream);
      savedFile = { success: true, filename: baseName, path: savePath };
      writeStream.on('error', (err) => {
        console.error('写入文件失败:', err);
        errorMsg = '文件写入失败';
        savedFile = null;
      });
    });

    busboy.on('error', (err) => {
      console.error('Busboy 解析错误:', err);
      errorMsg = '上传解析失败';
    });

    busboy.on('finish', () => {
      if (errorMsg) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: errorMsg }));
      } else if (savedFile) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: '上传成功', file: savedFile.filename }));
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '未收到有效文件' }));
      }
    });

    req.pipe(busboy);
    return;
  }

  // ---------- 删除脚本（安全增强）----------
  if (pathname.startsWith('/script/') && method === 'DELETE') {
    const filename = pathname.substring(9);
    if (!filename || !filename.endsWith('.js')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '无效的文件名，仅支持 .js 文件' }));
      return;
    }
    const safeName = path.basename(filename);
    if (!safeName || safeName.startsWith('.')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '非法的文件名' }));
      return;
    }
    const targetPath = path.join(USER_DATA_SCRIPTS_DIR, safeName);
    try {
      await fs.access(targetPath);
      await fs.unlink(targetPath);
      console.log(`[${beijingTime()}] 已删除脚本: ${safeName}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: `脚本 ${safeName} 已删除` }));
    } catch (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `文件 ${safeName} 不存在` }));
      } else {
        console.error(`删除失败: ${err.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '删除失败: ' + err.message }));
      }
    }
    return;
  }

  // SSE 实时日志和状态
  if (pathname === '/events' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    sseClients.push(res);
    sendSSE('state', {
      isRunning,
      currentScript,
      queueLength: taskQueue.length,
      lastRun: lastRunTime ? beijingTime(lastRunTime) : null,
      lastRunResult: lastRunResult ? {
        script: lastRunResult.script,
        success: lastRunResult.success,
        duration: lastRunResult.duration,
        timestamp: lastRunResult.timestamp
      } : null
    });
    req.on('close', () => {
      sseClients = sseClients.filter(client => client !== res);
    });
    return;
  }

  // Web 界面（完整版）
  if (pathname === '/trigger' && method === 'GET') {
    const availableScripts = await getAvailableScripts();
    const buttonsHtml = availableScripts.map(script => {
      const displayName = getDisplayName(script);
      return `
        <div class="script-item">
          <button class="script-btn" data-script="${script}">${displayName}</button>
          <button class="delete-btn" data-script="${script}" title="删除脚本">🗑️</button>
        </div>
      `;
    }).join('\n');

    let totalExecutions = history.length;
    let successCount = history.filter(h => h.success).length;
    let failCount = totalExecutions - successCount;
    let avgDuration = totalExecutions ? (history.reduce((sum, h) => sum + h.duration, 0) / totalExecutions).toFixed(1) : 0;

    const historyRows = history.map((h, idx) => `
      <tr>
        <td>${idx + 1}</td>
        <td>${h.timestamp}</td>
        <td>${h.script}</td>
        <td>${h.duration}秒</td>
        <td style="color: ${h.success ? 'green' : 'red'}">${h.success ? '成功' : '失败'}</td>
        <td>${h.exitCode}</td>
      </tr>
    `).join('');

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>爬虫控制台</title>
          <style>
            * { box-sizing: border-box; margin: 0; padding: 0; }
            body {
              font-family: 'Segoe UI', Roboto, system-ui, sans-serif;
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              min-height: 100vh;
              padding: 20px;
            }
            .container {
              max-width: 1400px;
              margin: 0 auto;
              display: flex;
              flex-direction: column;
              gap: 20px;
            }
            .card {
              background: rgba(255,255,255,0.95);
              backdrop-filter: blur(10px);
              border-radius: 20px;
              padding: 20px 25px;
              box-shadow: 0 20px 40px rgba(0,0,0,0.3);
            }
            h1 { font-size: 1.8rem; color: #333; margin-bottom: 10px; border-left: 6px solid #667eea; padding-left: 20px; }
            h2 { font-size: 1.3rem; margin: 15px 0 10px; color: #2d3748; border-bottom: 2px solid #e2e8f0; }
            .status-bar {
              background: #f0f4f8;
              border-radius: 40px;
              padding: 15px 25px;
              display: flex;
              flex-direction: column;
              gap: 12px;
            }
            .status-row {
              display: flex;
              align-items: center;
              gap: 25px;
              flex-wrap: wrap;
            }
            .status-item {
              display: flex;
              align-items: center;
              gap: 8px;
              font-size: 1rem;
            }
            .status-indicator {
              width: 12px;
              height: 12px;
              border-radius: 50%;
              background: #10b981;
            }
            .status-indicator.running {
              background: #fbbf24;
              animation: pulse 1.5s infinite;
            }
            @keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.5; } }
            .script-grid {
              display: grid;
              grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
              gap: 12px;
              margin: 15px 0;
            }
            .script-item {
              display: flex;
              gap: 8px;
              align-items: center;
            }
            .script-btn {
              flex: 1;
              background: white;
              border: 2px solid #e2e8f0;
              border-radius: 40px;
              padding: 10px 16px;
              font-size: 0.9rem;
              font-weight: 600;
              cursor: pointer;
              transition: all 0.2s;
            }
            .script-btn:hover { border-color: #667eea; background: #f5f3ff; transform: translateY(-1px); }
            .script-btn:disabled { opacity: 0.5; cursor: not-allowed; }
            .delete-btn {
              background: #fee2e2;
              border: none;
              border-radius: 30px;
              padding: 8px 12px;
              cursor: pointer;
              font-size: 1rem;
              transition: 0.2s;
            }
            .delete-btn:hover { background: #fecaca; }
            .log-box {
              background: #1e293b;
              color: #e2e8f0;
              border-radius: 12px;
              padding: 15px;
              height: 400px;
              overflow-y: auto;
              font-family: monospace;
              font-size: 0.85rem;
              white-space: pre-wrap;
              word-break: break-all;
            }
            .upload-area {
              margin-top: 20px;
              padding: 15px;
              background: #f8fafc;
              border-radius: 12px;
            }
            .btn-small {
              background: #667eea;
              color: white;
              border: none;
              border-radius: 30px;
              padding: 8px 16px;
              cursor: pointer;
              margin-top: 8px;
            }
            .btn-small:hover { background: #5a67d8; }
            .metrics {
              background: #f1f5f9;
              border-radius: 12px;
              padding: 12px;
              margin-top: 15px;
              display: flex;
              gap: 20px;
              flex-wrap: wrap;
            }
            .history-table {
              width: 100%;
              border-collapse: collapse;
              font-size: 0.85rem;
            }
            .history-table th, .history-table td {
              border: 1px solid #ddd;
              padding: 8px;
              text-align: left;
            }
            .history-table th {
              background: #f1f5f9;
              font-weight: 600;
            }
            .history-table tr:nth-child(even) { background: #f9f9f9; }
            .footer-links { text-align: center; margin-top: 20px; color: #94a3b8; }
            .api-link { color: #667eea; cursor: pointer; text-decoration: underline; margin: 0 8px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="card">
              <h1>🐞 爬虫控制台</h1>

              <div class="status-bar" id="statusBar">
                <div class="status-row">
                  <div class="status-item">
                    <span id="statusIndicator" class="status-indicator"></span>
                    <span id="globalStatus">空闲</span>
                  </div>
                  <div class="status-item">📋 队列: <span id="queueLen">0</span></div>
                  <div class="status-item">⚙️ 当前脚本: <span id="currentScript">无</span></div>
                  <div class="status-item">🕒 上次运行: <span id="lastRun">无</span></div>
                </div>
                <div class="status-row">
                  <div class="status-item">💚 健康状态: <span id="healthStatus">检查中...</span></div>
                </div>
              </div>

              <div style="display: flex; justify-content: space-between; align-items: center;">
                <h2>📜 可用脚本</h2>
                <button id="stopBtn" class="btn-small" style="background:#e53e3e;">⏹️ 终止当前脚本</button>
              </div>
              <div class="script-grid" id="buttonGrid">${buttonsHtml}</div>

              <div class="upload-area">
                <strong>📤 上传新脚本 (.js)</strong>
                <input type="file" id="uploadFile" accept=".js">
                <button id="uploadBtn" class="btn-small">上传</button>
                <span id="uploadMsg" style="margin-left: 10px;"></span>
              </div>

              <h2>📡 实时执行日志</h2>
              <div class="log-box" id="logBox"></div>

              <h2>📊 统计指标</h2>
              <div class="metrics">
                <span>总执行次数: <strong id="totalExec">${totalExecutions}</strong></span>
                <span>✅ 成功: <strong id="successCount">${successCount}</strong></span>
                <span>❌ 失败: <strong id="failCount">${failCount}</strong></span>
                <span>⏱️ 平均耗时: <strong id="avgDuration">${avgDuration}</strong> 秒</span>
              </div>

              <h2>📜 最近执行记录 (最多${MAX_HISTORY}条)</h2>
              <div style="overflow-x: auto; max-height: 400px; overflow-y: auto;">
                <table class="history-table" id="historyTable">
                  <thead>
                    <tr><th>序号</th><th>时间</th><th>脚本</th><th>耗时</th><th>状态</th><th>退出码</th></tr>
                  </thead>
                  <tbody id="historyBody">
                    ${historyRows}
                  </tbody>
                </table>
              </div>

              <div class="footer-links">
              </div>
            </div>
          </div>

          <script>
            const logBox = document.getElementById('logBox');
            const globalStatusSpan = document.getElementById('globalStatus');
            const queueLenSpan = document.getElementById('queueLen');
            const currentScriptSpan = document.getElementById('currentScript');
            const lastRunSpan = document.getElementById('lastRun');
            const statusIndicator = document.getElementById('statusIndicator');
            const healthStatusSpan = document.getElementById('healthStatus');
            const stopBtn = document.getElementById('stopBtn');
            const uploadFile = document.getElementById('uploadFile');
            const uploadBtn = document.getElementById('uploadBtn');
            const uploadMsg = document.getElementById('uploadMsg');

            let reconnectTimer = null;

            async function updateHealthStatus() {
              try {
                const res = await fetch('/health');
                const data = await res.json();
                healthStatusSpan.innerText = data.status === 'ok' ? '正常' : '异常';
              } catch (e) {
                healthStatusSpan.innerText = '无法连接';
              }
            }

            function connectSSE() {
              const evtSource = new EventSource('/events');
              evtSource.addEventListener('log', function(e) {
                try {
                  const data = JSON.parse(e.data);
                  const color = data.level === 'error' ? '#f87171' : (data.level === 'stderr' ? '#fbbf24' : '#a0aec0');
                  const line = \`<span style="color:\${color}">[\${data.timestamp}] \${data.message}</span><br>\`;
                  logBox.innerHTML += line;
                  logBox.scrollTop = logBox.scrollHeight;
                } catch(err) { console.error('解析日志错误', err); }
              });

              evtSource.addEventListener('state', function(e) {
                try {
                  const state = JSON.parse(e.data);
                  const isRunning = state.isRunning;
                  globalStatusSpan.innerText = isRunning ? '运行中' : '空闲';
                  if (isRunning) {
                    statusIndicator.className = 'status-indicator running';
                  } else {
                    statusIndicator.className = 'status-indicator';
                  }
                  queueLenSpan.innerText = state.queueLength;
                  currentScriptSpan.innerText = state.currentScript || '无';
                  lastRunSpan.innerText = state.lastRun || '无';
                  document.querySelectorAll('.script-btn').forEach(btn => {
                    btn.disabled = isRunning;
                  });
                  fetchHistoryAndUpdate();
                  fetchStatsAndUpdate();
                } catch(err) { console.error('解析状态错误', err); }
              });

              evtSource.onerror = function(err) {
                console.error('SSE连接错误，5秒后重连', err);
                evtSource.close();
                if (reconnectTimer) clearTimeout(reconnectTimer);
                reconnectTimer = setTimeout(() => connectSSE(), 5000);
                healthStatusSpan.innerText = '连接断开，重连中...';
              };
            }

            async function fetchHistoryAndUpdate() {
              try {
                const res = await fetch('/history');
                const history = await res.json();
                const tbody = document.getElementById('historyBody');
                if (history.length === 0) {
                  tbody.innerHTML = '<tr><td colspan="6">暂无记录</td></tr>';
                  return;
                }
                let html = '';
                history.forEach((h, idx) => {
                  html += \`
                    <tr>
                      <td>\${idx + 1}</td>
                      <td>\${h.timestamp}</td>
                      <td>\${h.script}</td>
                      <td>\${h.duration}秒</td>
                      <td style="color: \${h.success ? 'green' : 'red'}">\${h.success ? '成功' : '失败'}</td>
                      <td>\${h.exitCode}</td>
                    </tr>
                  \`;
                });
                tbody.innerHTML = html;
              } catch(e) { console.error('获取历史失败', e); }
            }

            async function fetchStatsAndUpdate() {
              try {
                const res = await fetch('/history');
                const history = await res.json();
                const total = history.length;
                const success = history.filter(h => h.success).length;
                const fail = total - success;
                const avg = total ? (history.reduce((sum, h) => sum + h.duration, 0) / total).toFixed(1) : 0;
                document.getElementById('totalExec').innerText = total;
                document.getElementById('successCount').innerText = success;
                document.getElementById('failCount').innerText = fail;
                document.getElementById('avgDuration').innerText = avg;
              } catch(e) {}
            }

            async function runScript(scriptName, btn) {
              if (btn.disabled) return;
              const originalText = btn.innerText;
              btn.innerText = '⏳ 排队中…';
              btn.disabled = true;
              try {
                const res = await fetch('/run/' + scriptName, { method: 'POST' });
                const data = await res.json();
                alert(\`脚本 \${scriptName} 执行完成\\n退出码: \${data.result.exitCode}\\n耗时: \${data.result.duration}秒\`);
              } catch(err) { alert('请求失败: '+err.message); }
              finally {
                btn.innerText = originalText;
              }
            }

            async function deleteScript(scriptName) {
              if(!confirm(\`确定删除脚本 \${scriptName} 吗？\`)) return;
              try {
                const res = await fetch('/script/' + scriptName, { method: 'DELETE' });
                const data = await res.json();
                alert(data.message || data.error);
                if (data.message) location.reload();
              } catch(err) { alert('删除失败: '+err.message); }
            }

            stopBtn.onclick = async () => {
              const res = await fetch('/stop', { method: 'POST' });
              const data = await res.json();
              alert(data.message);
            };

            uploadBtn.onclick = async () => {
              const file = uploadFile.files[0];
              if(!file) { uploadMsg.innerText = '请选择文件'; return; }
              const formData = new FormData();
              formData.append('script', file);
              const res = await fetch('/upload', { method: 'POST', body: formData });
              const data = await res.json();
              uploadMsg.innerText = data.message || data.error;
              if(data.message) setTimeout(()=>location.reload(), 1000);
            };

            document.querySelectorAll('.script-btn').forEach(btn => {
              btn.addEventListener('click', (e) => {
                const script = e.target.dataset.script;
                runScript(script, e.target);
              });
            });
            document.querySelectorAll('.delete-btn').forEach(btn => {
              btn.addEventListener('click', (e) => {
                const script = e.target.dataset.script;
                deleteScript(script);
              });
            });

            connectSSE();
            updateHealthStatus();
            setInterval(updateHealthStatus, 30000);
            fetchHistoryAndUpdate();
            fetchStatsAndUpdate();
          </script>
        </body>
      </html>
    `);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: '端点未找到' }));
});

// ---------- 定时任务 ----------
cron.schedule('15 6,9,10,11,12,13,14,15,16,17,18,21,22,23 * * *', () => {
  console.log(`[${beijingTime()}] 定时任务触发，执行 quick-plan-update.js`);
  queueScript('quick-plan-update.js').catch(err => console.error('定时任务执行失败:', err));
}, { timezone: "Asia/Shanghai" });

cron.schedule('0 6 * * *', () => {
  cleanOldLogs();
}, { timezone: "Asia/Shanghai" });

server.listen(PORT, '0.0.0.0', async () => {
  await loadHistoryFromFile();
  console.log(`触发服务器运行在 http://0.0.0.0:${PORT}`);
  console.log(`脚本目录: ${SCRIPTS_DIR} 和 ${USER_DATA_SCRIPTS_DIR}`);
  console.log(`日志文件: ${LOG_FILE}`);
  console.log(`可用端点: /health, /status, /trigger, /run/:script, /stop, /upload, /script/:filename, /events, /history`);
  if (API_KEY) console.log(`⚠️ API Key 验证已启用`);
});

process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));