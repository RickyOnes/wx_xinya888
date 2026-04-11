#!/usr/bin/env node

const http = require('http');
const { spawn } = require('child_process');
const { URL } = require('url');
const fs = require('fs').promises;
const path = require('path');
const cron = require('node-cron');
const Busboy = require('busboy');
const { createClient } = require('@supabase/supabase-js');

const PORT = process.env.TRIGGER_PORT || 3001;
const API_KEY = process.env.API_KEY || '';
const SCRIPTS_DIR = '/app/scripts';
const USER_DATA_SCRIPTS_DIR = '/app/puppeteer_user_data';
const LOG_FILE = path.join(USER_DATA_SCRIPTS_DIR, 'logs.txt');
const MAX_HISTORY = 20;
const MAX_LOG_DAYS = 30;
const SSE_HEARTBEAT_INTERVAL = 25000;
const SSE_RETRY_INTERVAL = 5000;

// Supabase 配置（从环境变量读取）
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
let supabase = null;
if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  console.log('Supabase 客户端已初始化');
} else {
  console.warn('警告：未设置 SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY，认证功能将不可用！');
}

// 会话配置
const COOKIE_MAX_AGE = 15 * 24 * 60 * 60; // 15 天（秒）

// 辅助函数：解析 Cookie
function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach(cookie => {
    const [name, value] = cookie.trim().split('=');
    if (name && value) cookies[name] = decodeURIComponent(value);
  });
  return cookies;
}

// 辅助函数：设置 Cookie（httpOnly, secure 可选）
function setCookie(res, name, value, maxAge = COOKIE_MAX_AGE) {
  let cookie = `${name}=${encodeURIComponent(value)}; HttpOnly; Path=/; Max-Age=${maxAge}`;
  // 如果使用 HTTPS（ClawCloud 默认是 https），添加 Secure 标志
  if (process.env.NODE_ENV === 'production' || process.env.USE_SECURE_COOKIE === 'true') {
    cookie += '; Secure';
  }
  res.setHeader('Set-Cookie', cookie);
}

// 清除 Cookie
function clearCookie(res, name) {
  res.setHeader('Set-Cookie', `${name}=; HttpOnly; Path=/; Max-Age=0`);
}

// 验证 Token（从 Cookie 中读取 access_token）
async function authenticateFromCookie(req, res) {
  if (!supabase) return false;
  const cookies = parseCookies(req.headers.cookie);
  const accessToken = cookies['crawler_token'];
  if (!accessToken) return false;
  try {
    const { data: { user }, error } = await supabase.auth.getUser(accessToken);
    if (error || !user) return false;
    // 可选：将用户信息挂载到 req.user
    req.user = user;
    return true;
  } catch (err) {
    console.error('Token 验证失败:', err.message);
    return false;
  }
}

// ---------- 脚本显示名称映射 ----------
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
let history = [];
let sseClients = [];

function beijingTime(date = new Date()) {
  return date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

function sendSSE(event, data) {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients = sseClients.filter(client => {
    try {
      client.write(message);
      return true;
    } catch (err) {
      console.error('SSE 推送失败，移除失效连接:', err.message);
      return false;
    }
  });
}

setInterval(() => {
  if (sseClients.length > 0) {
    sendSSE('heartbeat', { timestamp: beijingTime() });
  }
}, SSE_HEARTBEAT_INTERVAL);

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
      timestamp: lastRunResult.timestamp
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

function addToHistory(script, startTimeStr, duration, success, exitCode) {
  const record = {
    timestamp: startTimeStr,
    script,
    duration,
    success,
    exitCode
  };
  history.unshift(record);
  if (history.length > MAX_HISTORY) history.pop();
  appendHistoryLog(record);
}

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
  } catch (err) { }
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
  try { await fs.access(mainPath); return mainPath; } catch { }
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

  // ==================== 认证相关路由（无需登录） ====================
  // 登录页面
  if (pathname === '/login' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>爬虫控制台 - 登录</title>
          <style>
            body {
              font-family: 'Segoe UI', Roboto, system-ui, sans-serif;
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              min-height: 100vh;
              display: flex;
              align-items: center;
              justify-content: center;
              margin: 0;
              padding: 20px;
            }
            .login-card {
              background: rgba(255,255,255,0.95);
              border-radius: 20px;
              padding: 40px;
              width: 100%;
              max-width: 400px;
              box-shadow: 0 20px 40px rgba(0,0,0,0.3);
            }
            h1 { text-align: center; color: #333; margin-bottom: 30px; }
            input {
              width: 100%;
              padding: 12px;
              margin: 8px 0 20px;
              border: 1px solid #ddd;
              border-radius: 8px;
              font-size: 16px;
            }
            button {
              width: 100%;
              padding: 12px;
              background: #667eea;
              color: white;
              border: none;
              border-radius: 8px;
              font-size: 16px;
              cursor: pointer;
            }
            button:hover { background: #5a67d8; }
            .error { color: #e53e3e; margin-top: 10px; text-align: center; }
            .info { text-align: center; margin-top: 20px; color: #718096; }
          </style>
        </head>
        <body>
          <div class="login-card">
            <h1>🐞 爬虫控制台登录</h1>
            <form id="loginForm">
              <input type="email" id="email" placeholder="邮箱" required>
              <input type="password" id="password" placeholder="密码" required>
              <button type="submit">登录</button>
              <div id="errorMsg" class="error"></div>
            </form>
            <div class="info">使用 Supabase 账号登录</div>
          </div>
          <script>
            document.getElementById('loginForm').addEventListener('submit', async (e) => {
              e.preventDefault();
              const email = document.getElementById('email').value;
              const password = document.getElementById('password').value;
              const errorDiv = document.getElementById('errorMsg');
              try {
                const response = await fetch('/login', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ email, password })
                });
                const data = await response.json();
                if (response.ok) {
                  window.location.href = '/trigger';
                } else {
                  errorDiv.textContent = data.error || '登录失败';
                }
              } catch (err) {
                errorDiv.textContent = '网络错误，请稍后重试';
              }
            });
          </script>
        </body>
      </html>
    `);
    return;
  }

  // 登录 API（POST）
  if (pathname === '/login' && method === 'POST') {
    if (!supabase) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '认证服务未配置' }));
      return;
    }
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { email, password } = JSON.parse(body);
        if (!email || !password) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '邮箱和密码不能为空' }));
          return;
        }
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error.message }));
          return;
        }
        // 设置 httpOnly Cookie
        setCookie(res, 'crawler_token', data.session.access_token, COOKIE_MAX_AGE);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '无效的请求' }));
      }
    });
    return;
  }

  // 登出
  if (pathname === '/logout' && method === 'POST') {
    clearCookie(res, 'crawler_token');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  // 检查登录状态（前端可用）
  if (pathname === '/check-auth' && method === 'GET') {
    const isAuth = await authenticateFromCookie(req, res);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ authenticated: isAuth }));
    return;
  }

  // ==================== 需要认证的路由 ====================
  const protectedPaths = ['/trigger', '/run/', '/stop', '/upload', '/script/', '/status', '/history', '/events', '/health', '/metrics'];
  const isProtected = protectedPaths.some(p => pathname === p || pathname.startsWith(p));

  if (isProtected) {
    // 优先检查 API_KEY（如果设置且请求提供了正确的 Bearer Token）
    let authByApiKey = false;
    if (API_KEY) {
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader === `Bearer ${API_KEY}`) {
        authByApiKey = true;
      }
    }

    if (authByApiKey) {
      // API_KEY 验证通过，允许访问，跳过 Supabase 认证
      // 继续处理后续业务逻辑
    } else if (supabase) {
      // 没有 API_KEY 或验证失败，尝试 Supabase Cookie 认证
      const isAuth = await authenticateFromCookie(req, res);
      if (!isAuth) {
        if (pathname === '/trigger' && method === 'GET') {
          res.writeHead(302, { 'Location': '/login' });
          res.end();
          return;
        } else {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '未授权，请先登录或提供有效的 API_KEY' }));
          return;
        }
      }
    } else if (!supabase && !API_KEY) {
      // 如果两者都未配置，允许所有访问（降级模式）
      console.warn('认证未配置，允许所有访问');
    } else {
      // 有 Supabase 但未配置 API_KEY，且认证失败
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '未授权，请先登录' }));
      return;
    }
  }

  // ==================== 原有业务逻辑（无需修改） ====================
  // 健康检查
  if (pathname === '/health' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'crawler-trigger', port: PORT, crawler_running: isRunning, current_script: currentScript, last_run: lastRunTime ? beijingTime(lastRunTime) : null }));
    return;
  }

  // 状态查询
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

  // 触发脚本
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

  // 上传脚本
  if (pathname === '/upload' && method === 'POST') {
    const busboy = Busboy({
      headers: req.headers,
      limits: { fileSize: 10 * 1024 * 1024 },
      defCharset: 'utf-8'
    });
    let savedFile = null;
    let errorMsg = null;

    busboy.on('file', (fieldname, file, filenameOrInfo) => {
      let rawFilename = '';
      if (filenameOrInfo && typeof filenameOrInfo === 'object') {
        rawFilename = filenameOrInfo.filename || '';
      } else if (typeof filenameOrInfo === 'string') {
        rawFilename = filenameOrInfo;
      } else if (filenameOrInfo) {
        rawFilename = filenameOrInfo.toString();
      }
      let safeFilename = rawFilename;
      try {
        if (/^[\x00-\xFF]*$/.test(rawFilename) && rawFilename !== '') {
          safeFilename = Buffer.from(rawFilename, 'latin1').toString('utf8');
        }
      } catch(e) {}
      safeFilename = safeFilename.trim();

      if (!safeFilename || !safeFilename.endsWith('.js')) {
        file.resume();
        errorMsg = `只允许上传 .js 文件，收到: "${safeFilename || '空'}"`;
        return;
      }
      const baseName = path.basename(safeFilename);
      const savePath = path.join(USER_DATA_SCRIPTS_DIR, baseName);
      const writeStream = require('fs').createWriteStream(savePath);
      file.pipe(writeStream);
      savedFile = { success: true, filename: baseName, path: savePath };
      writeStream.on('error', (err) => {
        console.error('写入文件失败:', err);
        errorMsg = '文件写入失败: ' + err.message;
        savedFile = null;
      });
    });

    busboy.on('error', (err) => {
      console.error('Busboy 解析错误:', err);
      errorMsg = '上传解析失败: ' + err.message;
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

  // 删除脚本（使用原始 URL 避免自动解码问题）
  if (req.url.startsWith('/script/') && method === 'DELETE') {
    let rawPath = req.url;
    const queryIndex = rawPath.indexOf('?');
    if (queryIndex !== -1) rawPath = rawPath.substring(0, queryIndex);
    let encodedFilename = rawPath.substring('/script/'.length);
    if (!encodedFilename) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '无效的文件名' }));
      return;
    }
    let filename = '';
    try {
      filename = decodeURIComponent(encodedFilename);
    } catch (e) {
      filename = encodedFilename;
    }
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
    console.log(`[删除] 原始URL: ${req.url}, 编码后: ${encodedFilename}, 解码后: ${filename}, 最终路径: ${targetPath}`);
    try {
      await fs.access(targetPath);
      await fs.unlink(targetPath);
      console.log(`[${beijingTime()}] 已删除脚本: ${safeName}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: `脚本 ${safeName} 已删除` }));
    } catch (err) {
      if (err.code === 'ENOENT') {
        let dirList = [];
        try {
          dirList = await fs.readdir(USER_DATA_SCRIPTS_DIR);
        } catch(e) {}
        console.error(`文件不存在: ${targetPath}, 目录内容: ${dirList.join(', ')}`);
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
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no'
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    res.write(`retry: ${SSE_RETRY_INTERVAL}\n\n`);
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

  // Web 控制台界面（已通过认证中间件保护，这里直接返回 HTML）
  if (pathname === '/trigger' && method === 'GET') {
    const availableScripts = await getAvailableScripts();
    const buttonsHtml = availableScripts.map(script => {
      const displayName = getDisplayName(script);
      return `
        <div class="script-item">
          <button class="script-btn" data-script="${script.replace(/"/g, '&quot;')}">${displayName}</button>
          <button class="delete-btn" data-script="${script.replace(/"/g, '&quot;')}" title="删除脚本">🗑️</button>
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
            .log-section {
              display: none;
            }
            .log-section.visible {
              display: block;
            }
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
            .toast {
              position: fixed;
              top: 20px;
              left: 50%;
              transform: translateX(-50%);
              background: #333;
              color: #fff;
              padding: 12px 24px;
              border-radius: 8px;
              z-index: 10000;
              font-size: 14px;
              box-shadow: 0 4px 12px rgba(0,0,0,0.15);
              animation: fadeInOut 3s ease forwards;
              pointer-events: none;
            }
            .toast.success { background: #28a745; }
            .toast.error { background: #dc3545; }
            .toast.info { background: #17a2b8; }
            @keyframes fadeInOut {
              0% { opacity: 0; transform: translateX(-50%) translateY(-20px); }
              10% { opacity: 1; transform: translateX(-50%) translateY(0); }
              90% { opacity: 1; }
              100% { opacity: 0; transform: translateX(-50%) translateY(-20px); }
            }
            .logout-btn {
              position: absolute;
              top: 20px;
              right: 30px;
              background: #e53e3e;
              color: white;
              border: none;
              border-radius: 30px;
              padding: 8px 16px;
              cursor: pointer;
            }
            .logout-btn:hover { background: #c53030; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="card">
              <div style="position: relative;">
                <h1>🐞 爬虫控制台</h1>
                <button id="logoutBtn" class="logout-btn">登出</button>
              </div>

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

              <div class="log-section" id="logSection">
                <h2>📡 实时执行日志</h2>
                <div class="log-box" id="logBox"></div>
              </div>

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
            </div>
          </div>

          <script>
            const logBox = document.getElementById('logBox');
            const logSection = document.getElementById('logSection');
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
            const logoutBtn = document.getElementById('logoutBtn');

            function showToast(msg, type = 'info') {
              const toast = document.createElement('div');
              toast.className = 'toast ' + type;
              toast.textContent = msg;
              document.body.appendChild(toast);
              setTimeout(() => toast.remove(), 3000);
            }

            let reconnectTimer = null;
            let hideLogTimer = null;
            let evtSource = null;
            let heartbeatCheckTimer = null;
            let lastSSEActivityAt = 0;
            let serviceHealthy = true;
            let sseStatus = 'connecting';
            let reconnectAttempts = 0;
            const SSE_BASE_RECONNECT_DELAY = 5000;
            const SSE_MAX_RECONNECT_DELAY = 30000;
            const HEALTH_CHECK_TIMEOUT = 5000;

            function setLogSectionVisible(visible) {
              if (visible) {
                if (hideLogTimer) {
                  clearTimeout(hideLogTimer);
                  hideLogTimer = null;
                }
                logSection.classList.add('visible');
                return;
              }
              if (hideLogTimer) clearTimeout(hideLogTimer);
              hideLogTimer = setTimeout(() => {
                logSection.classList.remove('visible');
                hideLogTimer = null;
              }, 10000);
            }

            function renderHealthStatus() {
              if (sseStatus === 'reconnecting') {
                healthStatusSpan.innerText = '连接断开，重连中...';
                return;
              }
              if (sseStatus === 'connecting') {
                healthStatusSpan.innerText = '连接中...';
                return;
              }
              healthStatusSpan.innerText = serviceHealthy ? '正常' : '异常';
            }

            function setSSEStatus(status) {
              sseStatus = status;
              renderHealthStatus();
            }

            function clearReconnectTimer() {
              if (!reconnectTimer) return;
              clearTimeout(reconnectTimer);
              reconnectTimer = null;
            }

            function markSSEAlive() {
              lastSSEActivityAt = Date.now();
              reconnectAttempts = 0;
              clearReconnectTimer();
              setSSEStatus('connected');
            }

            function closeSSE() {
              if (evtSource) {
                evtSource.close();
                evtSource = null;
              }
            }

            function scheduleReconnect(delayOverride) {
              clearReconnectTimer();
              const delay = typeof delayOverride === 'number'
                ? delayOverride
                : Math.min(SSE_BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempts), SSE_MAX_RECONNECT_DELAY);
              reconnectTimer = setTimeout(() => {
                reconnectTimer = null;
                connectSSE();
              }, delay);
              if (typeof delayOverride !== 'number') {
                reconnectAttempts += 1;
              }
              return delay;
            }

            function reconnectSSE(delayOverride) {
              setSSEStatus('reconnecting');
              closeSSE();
              if (delayOverride === 0) {
                connectSSE();
                return 0;
              }
              return scheduleReconnect(delayOverride);
            }

            function ensureHeartbeatWatch() {
              if (heartbeatCheckTimer) return;
              heartbeatCheckTimer = setInterval(() => {
                if (!evtSource || Date.now() - lastSSEActivityAt <= 45000) return;
                console.warn('SSE 长时间无活动，准备重连');
                reconnectSSE(0);
              }, 15000);
            }

            async function fetchJSONWithTimeout(url, timeout) {
              const controller = new AbortController();
              const timeoutId = setTimeout(() => controller.abort(), timeout);
              try {
                const res = await fetch(url, {
                  cache: 'no-store',
                  signal: controller.signal
                });
                if (!res.ok) {
                  throw new Error('HTTP ' + res.status);
                }
                return await res.json();
              } finally {
                clearTimeout(timeoutId);
              }
            }

            async function updateHealthStatus() {
              try {
                const data = await fetchJSONWithTimeout('/health', HEALTH_CHECK_TIMEOUT);
                serviceHealthy = data.status === 'ok';
              } catch (e) {
                serviceHealthy = false;
              }
              renderHealthStatus();
            }

            function connectSSE() {
              if (evtSource && evtSource.readyState !== EventSource.CLOSED) return;
              clearReconnectTimer();
              setSSEStatus('connecting');
              closeSSE();
              evtSource = new EventSource('/events');
              ensureHeartbeatWatch();

              evtSource.onopen = function() {
                markSSEAlive();
              };

              evtSource.addEventListener('heartbeat', function() {
                markSSEAlive();
              });

              evtSource.addEventListener('log', function(e) {
                markSSEAlive();
                try {
                  const data = JSON.parse(e.data);
                  const color = data.level === 'error' ? '#f87171' : (data.level === 'stderr' ? '#fbbf24' : '#a0aec0');
                  const line = \`<span style="color:\${color}">[\${data.timestamp}] \${data.message}</span><br>\`;
                  logBox.innerHTML += line;
                  logBox.scrollTop = logBox.scrollHeight;
                } catch(err) { console.error('解析日志错误', err); }
              });

              evtSource.addEventListener('state', function(e) {
                markSSEAlive();
                try {
                  const state = JSON.parse(e.data);
                  const isRunning = state.isRunning;
                  globalStatusSpan.innerText = isRunning ? '运行中' : '空闲';
                  if (isRunning) {
                    statusIndicator.className = 'status-indicator running';
                  } else {
                    statusIndicator.className = 'status-indicator';
                  }
                  setLogSectionVisible(isRunning);
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
                const delay = reconnectSSE();
                console.error('SSE连接错误，' + Math.round(delay / 1000) + '秒后重连', err);
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
                const encoded = encodeURIComponent(scriptName);
                const res = await fetch('/run/' + encoded, { method: 'POST' });
                const data = await res.json();
                if (data.result) {
                  showToast(\`脚本 \${scriptName} 执行完成，退出码: \${data.result.exitCode}，耗时 \${data.result.duration} 秒\`, data.result.success ? 'success' : 'error');
                } else {
                  showToast(data.message || '执行完成', 'info');
                }
              } catch(err) {
                showToast('请求失败: ' + err.message, 'error');
              } finally {
                btn.innerText = originalText;
              }
            }

            async function deleteScript(scriptName) {
              if(!confirm('确定删除该脚本吗？')) return;
              try {
                const encoded = encodeURIComponent(scriptName);
                const res = await fetch('/script/' + encoded, { method: 'DELETE' });
                const data = await res.json();
                if (data.message) {
                  showToast(data.message, 'success');
                  setTimeout(() => location.reload(), 1000);
                } else {
                  showToast(data.error || '删除失败', 'error');
                }
              } catch(err) {
                showToast('删除失败: ' + err.message, 'error');
              }
            }

            stopBtn.onclick = async () => {
              const res = await fetch('/stop', { method: 'POST' });
              const data = await res.json();
              showToast(data.message, data.success ? 'success' : 'error');
            };

            uploadBtn.onclick = async () => {
              const file = uploadFile.files[0];
              if(!file) { showToast('请选择文件', 'error'); return; }
              const formData = new FormData();
              formData.append('script', file);
              try {
                const res = await fetch('/upload', { method: 'POST', body: formData });
                const data = await res.json();
                if (data.message) {
                  showToast(data.message, 'success');
                  setTimeout(() => location.reload(), 1000);
                } else {
                  showToast(data.error || '上传失败', 'error');
                }
              } catch(err) {
                showToast('上传请求失败: ' + err.message, 'error');
              }
            };

            logoutBtn.onclick = async () => {
              const res = await fetch('/logout', { method: 'POST' });
              const data = await res.json();
              if (data.success) {
                window.location.href = '/login';
              } else {
                showToast('登出失败', 'error');
              }
            };

            document.querySelectorAll('.script-btn').forEach(btn => {
              btn.addEventListener('click', (e) => {
                const script = e.target.getAttribute('data-script');
                runScript(script, e.target);
              });
            });
            document.querySelectorAll('.delete-btn').forEach(btn => {
              btn.addEventListener('click', (e) => {
                const script = e.target.getAttribute('data-script');
                deleteScript(script);
              });
            });

            document.addEventListener('visibilitychange', () => {
              if (document.visibilityState === 'visible') {
                connectSSE();
                updateHealthStatus();
              }
            });
            window.addEventListener('focus', () => {
              connectSSE();
              updateHealthStatus();
            });
            window.addEventListener('online', () => {
              connectSSE();
              updateHealthStatus();
            });
            window.addEventListener('beforeunload', () => {
              if (reconnectTimer) clearTimeout(reconnectTimer);
              if (heartbeatCheckTimer) clearInterval(heartbeatCheckTimer);
              closeSSE();
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

cron.schedule('8 0 */3 * *', () => { //每3天北京时间8：08运行
  console.log(`[${beijingTime()}] 定时任务触发，执行 update-clawcloud-token.js`);
  queueScript('update-clawcloud-token.js').catch(err => console.error('定时任务执行失败:', err));
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
  if (!supabase) console.warn('⚠️ Supabase 未配置，认证功能已禁用！请设置环境变量 SUPABASE_URL 和 SUPABASE_SERVICE_ROLE_KEY');
});

process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));