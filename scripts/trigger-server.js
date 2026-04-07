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
const MAX_HISTORY = 30;          // 内存中保留最近30条记录
const MAX_LOG_DAYS = 30;          // 日志文件保留30天

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
let currentChild = null;          // 当前运行的子进程
let currentTimeout = null;        // 超时定时器
let taskQueue = [];               // 队列元素：{ scriptName, resolve, reject }
let lastRunResult = null;
let lastRunTime = null;

// 性能统计
let stats = {
  totalExecutions: 0,
  successCount: 0,
  failCount: 0,
  totalDurationSeconds: 0,
  lastExecution: null
};

// 历史记录（内存）
let history = [];                 // 每个元素: { timestamp, script, duration, success, exitCode }

// SSE 客户端列表
let sseClients = [];

// ---------- 辅助函数 ----------
function beijingTime(date = new Date()) {
  return date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

function sendSSE(data) {
  const message = `data: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(client => client.write(message));
}

function broadcastLog(level, message) {
  sendSSE({ level, message, timestamp: beijingTime() });
}

// 记录到持久化日志文件（简化格式，仅追加，不清理）
async function appendHistoryLog(entry) {
  const line = `${entry.timestamp} | ${entry.script} | 耗时:${entry.duration}s | ${entry.success ? '成功' : '失败'} | 退出码:${entry.exitCode}\n`;
  try {
    await fs.appendFile(LOG_FILE, line, 'utf8');
  } catch (err) {
    console.error('写入历史日志失败:', err.message);
  }
}

// 清理超过 MAX_LOG_DAYS 天的旧日志（每天执行一次）
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

// 添加到内存历史
function addToHistory(script, duration, success, exitCode) {
  const record = {
    timestamp: beijingTime(),
    script,
    duration,
    success,
    exitCode
  };
  history.unshift(record);
  if (history.length > MAX_HISTORY) history.pop();
  // 更新统计
  stats.totalExecutions++;
  if (success) stats.successCount++;
  else stats.failCount++;
  stats.totalDurationSeconds += duration;
  stats.lastExecution = record.timestamp;
}

// 执行脚本的核心函数（实际运行）
function runScriptTask(scriptName, resolve, reject) {
  if (currentChild) {
    reject(new Error('已有脚本在运行，但队列机制应防止此情况'));
    return;
  }

  isRunning = true;
  currentScript = scriptName;
  const startTime = Date.now();
  console.log("==========================================");
  console.log(`[${beijingTime()}] 开始执行脚本: ${scriptName}`);
  broadcastLog('info', `开始执行脚本: ${scriptName}`);

  // 获取脚本路径
  getScriptPath(scriptName).then(scriptPath => {
    if (!scriptPath) throw new Error(`脚本 ${scriptName} 不存在`);

    const child = spawn('node', [scriptPath], {
      stdio: 'pipe',
      env: process.env,
      cwd: '/app'
    });
    currentChild = child;

    // 超时控制（30分钟）
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
        timestamp: beijingTime(endTime),
        duration,
        output: output.slice(-5000),
        error: errorOutput.slice(-5000)
      };
      lastRunResult = result;
      console.log(`[${beijingTime(endTime)}] 脚本 ${scriptName} 执行完成，退出码: ${code}`);
      console.log(`总运行时长: ${duration} 秒`);
      broadcastLog('info', `脚本 ${scriptName} 执行完成，退出码: ${code}，耗时 ${duration} 秒`);
      console.log("==========================================");

      // 记录历史和持久化
      addToHistory(scriptName, duration, success, code);
      appendHistoryLog({
        timestamp: beijingTime(endTime),
        script: scriptName,
        duration,
        success,
        exitCode: code
      });

      resolve(result);
      // 执行下一个任务
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
        timestamp: beijingTime(),
        duration,
        output: output.slice(-5000),
        error: err.message
      };
      lastRunResult = result;
      console.error(`[${beijingTime()}] 脚本 ${scriptName} 执行错误: ${err.message}`);
      broadcastLog('error', `脚本 ${scriptName} 执行错误: ${err.message}`);
      addToHistory(scriptName, duration, false, -1);
      appendHistoryLog({
        timestamp: beijingTime(),
        script: scriptName,
        duration,
        success: false,
        exitCode: -1
      });
      resolve(result);
      runNext();
    });
  }).catch(err => {
    // 获取路径失败
    const duration = 0;
    const result = {
      success: false,
      exitCode: -1,
      script: scriptName,
      timestamp: beijingTime(),
      duration,
      output: '',
      error: err.message
    };
    lastRunResult = result;
    console.error(`[${beijingTime()}] 脚本 ${scriptName} 定位失败: ${err.message}`);
    broadcastLog('error', `脚本 ${scriptName} 定位失败: ${err.message}`);
    addToHistory(scriptName, duration, false, -1);
    appendHistoryLog({
      timestamp: beijingTime(),
      script: scriptName,
      duration,
      success: false,
      exitCode: -1
    });
    isRunning = false;
    currentScript = null;
    resolve(result);
    runNext();
  });
}

// 队列调度
function queueScript(scriptName) {
  return new Promise((resolve, reject) => {
    taskQueue.push({ scriptName, resolve, reject });
    if (!isRunning) runNext();
  });
}

function runNext() {
  if (taskQueue.length === 0) return;
  if (isRunning) return;
  const { scriptName, resolve, reject } = taskQueue.shift();
  runScriptTask(scriptName, resolve, reject);
}

// 终止当前脚本
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
  return { success: true, message: '已发送终止信号' };
}

// 获取脚本列表（合并两个目录）
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

// 初始化：加载历史记录（从日志文件恢复内存 history 和 stats）
async function loadHistoryFromFile() {
  try {
    const content = await fs.readFile(LOG_FILE, 'utf8');
    const lines = content.split(/\r?\n/).filter(l => l.trim());
    // 解析每一行：格式 "2025-04-07 12:34:56 | script.js | 耗时:10s | 成功 | 退出码:0"
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
    history = records.reverse(); // 最新的在前
    // 重新计算 stats
    stats = { totalExecutions: 0, successCount: 0, failCount: 0, totalDurationSeconds: 0, lastExecution: null };
    for (const r of history) {
      stats.totalExecutions++;
      if (r.success) stats.successCount++;
      else stats.failCount++;
      stats.totalDurationSeconds += r.duration;
      if (!stats.lastExecution) stats.lastExecution = r.timestamp;
    }
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

  // API Key 验证（只对需要保护的路由）
  const protectedPaths = ['/run/', '/trigger', '/stop', '/upload', '/script/'];
  if (API_KEY && protectedPaths.some(p => pathname === p || pathname.startsWith(p))) {
    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${API_KEY}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '未授权访问' }));
      return;
    }
  }

  // ---------- 健康检查 ----------
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

  // ---------- 状态查询 ----------
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

  // ---------- 历史记录 ----------
  if (pathname === '/history' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(history));
    return;
  }

  // ---------- Prometheus 指标 ----------
  if (pathname === '/metrics' && method === 'GET') {
    const avgDuration = stats.totalExecutions ? (stats.totalDurationSeconds / stats.totalExecutions).toFixed(2) : 0;
    const successRate = stats.totalExecutions ? ((stats.successCount / stats.totalExecutions) * 100).toFixed(2) : 0;
    const metrics = [
      `# HELP crawler_total_executions Total number of script executions`,
      `# TYPE crawler_total_executions counter`,
      `crawler_total_executions ${stats.totalExecutions}`,
      `# HELP crawler_success_count Number of successful executions`,
      `# TYPE crawler_success_count counter`,
      `crawler_success_count ${stats.successCount}`,
      `# HELP crawler_fail_count Number of failed executions`,
      `# TYPE crawler_fail_count counter`,
      `crawler_fail_count ${stats.failCount}`,
      `# HELP crawler_avg_duration_seconds Average execution duration in seconds`,
      `# TYPE crawler_avg_duration_seconds gauge`,
      `crawler_avg_duration_seconds ${avgDuration}`,
      `# HELP crawler_success_rate_percent Success rate percentage`,
      `# TYPE crawler_success_rate_percent gauge`,
      `crawler_success_rate_percent ${successRate}`,
      `# HELP crawler_queue_length Current number of queued scripts`,
      `# TYPE crawler_queue_length gauge`,
      `crawler_queue_length ${taskQueue.length}`
    ];
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
    res.end(metrics.join('\n'));
    return;
  }

  // ---------- 触发脚本（加入队列）----------
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

  // ---------- 默认触发（update-pdd-cron.js）----------
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

  // ---------- 终止脚本 ----------
  if (pathname === '/stop' && method === 'POST') {
    const result = await stopCurrentScript();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // ---------- 上传脚本 ----------
  if (pathname === '/upload' && method === 'POST') {
    const busboy = Busboy({ headers: req.headers });
    let savedFile = null;
    busboy.on('file', (fieldname, file, filename, encoding, mimetype) => {
      if (!filename.endsWith('.js')) {
        file.resume();
        savedFile = { error: '只允许上传 .js 文件' };
        return;
      }
      const savePath = path.join(USER_DATA_SCRIPTS_DIR, path.basename(filename));
      const writeStream = require('fs').createWriteStream(savePath);
      file.pipe(writeStream);
      savedFile = { success: true, filename, path: savePath };
    });
    busboy.on('finish', () => {
      if (savedFile && savedFile.error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: savedFile.error }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: '上传成功', file: savedFile.filename }));
      }
    });
    req.pipe(busboy);
    return;
  }

  // ---------- 删除脚本 ----------
  if (pathname.startsWith('/script/') && method === 'DELETE') {
    const filename = pathname.substring(9); // 去掉 '/script/'
    if (!filename || !filename.endsWith('.js')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '无效的文件名' }));
      return;
    }
    // 防止路径遍历
    const safeName = path.basename(filename);
    const targetPath = path.join(USER_DATA_SCRIPTS_DIR, safeName);
    try {
      await fs.access(targetPath);
      await fs.unlink(targetPath);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: `脚本 ${safeName} 已删除` }));
    } catch (err) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '文件不存在或无法删除' }));
    }
    return;
  }

  // ---------- SSE 实时日志 ----------
  if (pathname === '/logs' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    sseClients.push(res);
    req.on('close', () => {
      sseClients = sseClients.filter(client => client !== res);
    });
    return;
  }

  // ---------- Web 界面（增强版）----------
  if (pathname === '/trigger' && method === 'GET') {
    const availableScripts = await getAvailableScripts();
    const buttonsHtml = availableScripts.map(script => {
      const displayName = getDisplayName(script);
      return `
        <div class="script-item">
          <button class="script-btn" data-script="${script}" ${isRunning ? 'disabled' : ''}>${displayName}</button>
          <button class="delete-btn" data-script="${script}" title="删除脚本">🗑️</button>
        </div>
      `;
    }).join('\n');
    const lastRunTimeStr = lastRunTime ? beijingTime(lastRunTime) : '无';
    const lastRunScript = lastRunResult ? `(脚本: ${lastRunResult.script})` : '';
    const queueLen = taskQueue.length;

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
              gap: 20px;
              flex-wrap: wrap;
            }
            .card {
              background: rgba(255,255,255,0.95);
              backdrop-filter: blur(10px);
              border-radius: 20px;
              padding: 20px 25px;
              box-shadow: 0 20px 40px rgba(0,0,0,0.3);
              flex: 1;
              min-width: 300px;
            }
            .full-width {
              width: 100%;
            }
            h1 { font-size: 1.8rem; color: #333; margin-bottom: 10px; border-left: 6px solid #667eea; padding-left: 20px; }
            h2 { font-size: 1.3rem; margin: 15px 0 10px; color: #2d3748; border-bottom: 2px solid #e2e8f0; }
            .status-bar {
              background: #f0f4f8;
              border-radius: 40px;
              padding: 12px 20px;
              margin-bottom: 20px;
              display: flex;
              align-items: center;
              gap: 15px;
              flex-wrap: wrap;
            }
            .status-indicator {
              display: inline-block;
              width: 14px;
              height: 14px;
              border-radius: 50%;
              background: ${isRunning ? '#fbbf24' : '#10b981'};
              animation: ${isRunning ? 'pulse 1.5s infinite' : 'none'};
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
            .script-btn:hover:not(:disabled) {
              border-color: #667eea;
              background: #f5f3ff;
              transform: translateY(-1px);
            }
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
            input[type="file"] { margin: 8px 0; }
            .metrics {
              font-size: 0.9rem;
              background: #f1f5f9;
              border-radius: 12px;
              padding: 12px;
              margin-top: 15px;
            }
            .footer-links { text-align: center; margin-top: 20px; color: #94a3b8; }
            .api-link { color: #667eea; cursor: pointer; text-decoration: underline; margin: 0 8px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="card full-width">
              <h1>🐞 爬虫控制台</h1>
              <div class="status-bar">
                <span class="status-indicator"></span>
                <span id="globalStatus">${isRunning ? '运行中' : '空闲'}</span>
                <span>队列: <span id="queueLen">${queueLen}</span></span>
                <span>当前脚本: <span id="currentScript">${currentScript || '无'}</span></span>
                <span>上次: ${lastRunTimeStr} ${lastRunScript}</span>
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

              <div class="metrics">
                <strong>📊 统计指标</strong><br>
                总执行次数: <span id="totalExec">${stats.totalExecutions}</span> |
                成功: <span id="successCount">${stats.successCount}</span> |
                失败: <span id="failCount">${stats.failCount}</span> |
                平均耗时: <span id="avgDuration">${stats.totalExecutions ? (stats.totalDurationSeconds/stats.totalExecutions).toFixed(1) : 0}</span> 秒
              </div>

              <div class="footer-links">
                <span class="api-link" data-url="/status">📊 状态</span> |
                <span class="api-link" data-url="/history">📜 历史记录</span> |
                <span class="api-link" data-url="/metrics">📈 Metrics</span>
              </div>
            </div>
          </div>

          <script>
            const logBox = document.getElementById('logBox');
            const globalStatusSpan = document.getElementById('globalStatus');
            const queueLenSpan = document.getElementById('queueLen');
            const currentScriptSpan = document.getElementById('currentScript');
            const stopBtn = document.getElementById('stopBtn');
            const uploadFile = document.getElementById('uploadFile');
            const uploadBtn = document.getElementById('uploadBtn');
            const uploadMsg = document.getElementById('uploadMsg');

            // SSE 连接
            const evtSource = new EventSource('/logs');
            evtSource.onmessage = function(e) {
              const data = JSON.parse(e.data);
              const color = data.level === 'error' ? '#f87171' : (data.level === 'stderr' ? '#fbbf24' : '#a0aec0');
              const line = \`<span style="color:\${color}">[\${data.timestamp}] \${data.message}</span><br>\`;
              logBox.innerHTML += line;
              logBox.scrollTop = logBox.scrollHeight;
            };

            function updateUI() {
              fetch('/status').then(r => r.json()).then(data => {
                globalStatusSpan.innerText = data.crawler_running ? '运行中' : '空闲';
                queueLenSpan.innerText = data.queue_length;
                currentScriptSpan.innerText = data.current_script || '无';
                document.querySelectorAll('.script-btn').forEach(btn => {
                  btn.disabled = data.crawler_running;
                });
              }).catch(()=>{});
              fetch('/metrics').then(r => r.text()).then(text => {
                const lines = text.split('\\n');
                let total=0, success=0, fail=0, avg=0;
                for(let l of lines) {
                  if(l.startsWith('crawler_total_executions')) total = parseInt(l.split(' ')[1]);
                  if(l.startsWith('crawler_success_count')) success = parseInt(l.split(' ')[1]);
                  if(l.startsWith('crawler_fail_count')) fail = parseInt(l.split(' ')[1]);
                  if(l.startsWith('crawler_avg_duration_seconds')) avg = parseFloat(l.split(' ')[1]);
                }
                document.getElementById('totalExec').innerText = total;
                document.getElementById('successCount').innerText = success;
                document.getElementById('failCount').innerText = fail;
                document.getElementById('avgDuration').innerText = avg.toFixed(1);
              }).catch(()=>{});
            }

            async function runScript(scriptName, btn) {
              if (!btn.disabled) {
                const originalText = btn.innerText;
                btn.innerText = '⏳ 排队中…';
                btn.disabled = true;
                try {
                  const res = await fetch('/run/' + scriptName, { method: 'POST' });
                  const data = await res.json();
                  alert(\`脚本 \${scriptName} 执行完成\\n退出码: \${data.result.exitCode}\\n耗时: \${data.result.duration}秒\`);
                } catch(err) { alert('请求失败: '+err.message); }
                finally { btn.innerText = originalText; updateUI(); }
              }
            }

            async function deleteScript(scriptName) {
              if(!confirm(\`确定删除脚本 \${scriptName} 吗？\`)) return;
              try {
                const res = await fetch('/script/' + scriptName, { method: 'DELETE' });
                const data = await res.json();
                alert(data.message || data.error);
                location.reload();
              } catch(err) { alert('删除失败: '+err.message); }
            }

            stopBtn.onclick = async () => {
              const res = await fetch('/stop', { method: 'POST' });
              const data = await res.json();
              alert(data.message);
              updateUI();
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
            document.querySelectorAll('.api-link').forEach(span => {
              span.addEventListener('click', async (e) => {
                const url = e.target.dataset.url;
                const res = await fetch(url);
                const data = await res.text();
                alert(data);
              });
            });

            setInterval(updateUI, 3000);
            updateUI();
          </script>
        </body>
      </html>
    `);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: '端点未找到' }));
});

// ---------- 初始化定时任务 ----------
// 1. 每小时执行 quick-plan-update.js（北京时间）
cron.schedule('15 6,9,10,11,12,13,14,15,16,17,18,21,22,23 * * *', () => {
  console.log(`[${beijingTime()}] 定时任务触发，执行 quick-plan-update.js`);
  queueScript('quick-plan-update.js').catch(err => console.error('定时任务执行失败:', err));
}, {
  timezone: "Asia/Shanghai"
});

// 2. 每天凌晨 6:00（北京时间）清理超过 30 天的旧日志
cron.schedule('0 6 * * *', () => {
  cleanOldLogs();
}, {
  timezone: "Asia/Shanghai"
});

// 启动服务器
server.listen(PORT, '0.0.0.0', async () => {
  await loadHistoryFromFile();
  console.log(`触发服务器运行在 http://0.0.0.0:${PORT}`);
  console.log(`脚本目录: ${SCRIPTS_DIR} 和 ${USER_DATA_SCRIPTS_DIR}`);
  console.log(`日志文件: ${LOG_FILE}`);
  console.log(`可用端点: /health, /status, /trigger, /run/:script, /stop, /upload, /script/:filename, /logs, /history, /metrics`);
  if (API_KEY) console.log(`⚠️ API Key 验证已启用`);
});

process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));