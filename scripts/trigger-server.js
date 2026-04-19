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
const HISTORY_FILE = path.join(USER_DATA_SCRIPTS_DIR, 'history.json');
const MAX_HISTORY = 20;
const MAX_LOG_DAYS = 30;
const SSE_HEARTBEAT_INTERVAL = 25000;
const SSE_RETRY_INTERVAL = 5000;
const STOP_FORCE_KILL_DELAY = 15000;

// Supabase 配置（从环境变量读取）
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const AUTH_ACCESS_COOKIE = 'crawler_token';
const AUTH_REFRESH_COOKIE = 'crawler_refresh_token';

function createSupabaseAuthClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  });
}

let supabase = null;
if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
  supabase = createSupabaseAuthClient();
  console.log('Supabase 客户端已初始化');
} else {
  console.warn('警告：未设置 SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY，认证功能将不可用！');
}

// 会话配置
const COOKIE_MAX_AGE = 15 * 24 * 60 * 60; // 15 天（秒）
const AUTH_CACHE_TTL_MS = 60 * 1000; // 认证用户缓存 TTL（60秒）
const AUTH_REFRESH_LEEWAY_MS = 60 * 1000; // access token 提前 60 秒视为即将过期
const AUTH_INVALID_TOKEN_TTL_MS = 60 * 1000; // 无效 access token 短期缓存，避免重复远程校验

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

function buildCookie(name, value, maxAge = COOKIE_MAX_AGE) {
  let cookie = `${name}=${encodeURIComponent(value)}; HttpOnly; Path=/; Max-Age=${maxAge}; SameSite=Lax`;
  if (process.env.NODE_ENV === 'production' || process.env.USE_SECURE_COOKIE === 'true') {
    cookie += '; Secure';
  }
  return cookie;
}

function appendSetCookie(res, cookie) {
  const existing = res.getHeader('Set-Cookie');
  if (!existing) {
    res.setHeader('Set-Cookie', [cookie]);
    return;
  }
  const cookieList = Array.isArray(existing) ? existing : [existing];
  res.setHeader('Set-Cookie', [...cookieList, cookie]);
}

// 辅助函数：设置 Cookie（httpOnly, secure 可选）
function setCookie(res, name, value, maxAge = COOKIE_MAX_AGE) {
  appendSetCookie(res, buildCookie(name, value, maxAge));
}

// 清除 Cookie
function clearCookie(res, name) {
  appendSetCookie(res, buildCookie(name, '', 0));
}

function setAuthCookies(res, session) {
  if (!session?.access_token || !session?.refresh_token) return;
  setCookie(res, AUTH_ACCESS_COOKIE, session.access_token, COOKIE_MAX_AGE);
  setCookie(res, AUTH_REFRESH_COOKIE, session.refresh_token, COOKIE_MAX_AGE);
}

function clearAuthCookies(res) {
  clearCookie(res, AUTH_ACCESS_COOKIE);
  clearCookie(res, AUTH_REFRESH_COOKIE);
}

const authUserCache = new Map();
const authInvalidTokenCache = new Map();
const authRefreshPromises = new Map();

function getCachedAuthUser(accessToken) {
  if (!accessToken) return null;
  const cached = authUserCache.get(accessToken);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    authUserCache.delete(accessToken);
    return null;
  }
  return cached.user;
}

function setCachedAuthUser(accessToken, user) {
  if (!accessToken || !user) return;
  authUserCache.set(accessToken, {
    user,
    expiresAt: Date.now() + AUTH_CACHE_TTL_MS
  });
}

function clearCachedAuthUser(accessToken) {
  if (!accessToken) return;
  authUserCache.delete(accessToken);
}

function decodeBase64Url(value) {
  if (!value) return '';
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

function parseJwtPayload(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    return JSON.parse(decodeBase64Url(parts[1]));
  } catch {
    return null;
  }
}

function isTokenExpiredOrNearExpiry(token, leewayMs = AUTH_REFRESH_LEEWAY_MS) {
  const payload = parseJwtPayload(token);
  if (!payload?.exp) return false;
  const expiresAt = Number(payload.exp) * 1000;
  if (!Number.isFinite(expiresAt)) return false;
  return expiresAt <= (Date.now() + leewayMs);
}

function getInvalidAccessTokenReason(accessToken) {
  if (!accessToken) return null;
  const cached = authInvalidTokenCache.get(accessToken);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    authInvalidTokenCache.delete(accessToken);
    return null;
  }
  return cached.reason;
}

function markInvalidAccessToken(accessToken, reason = 'access token 无效') {
  if (!accessToken) return;
  authInvalidTokenCache.set(accessToken, {
    reason,
    expiresAt: Date.now() + AUTH_INVALID_TOKEN_TTL_MS
  });
}

function clearInvalidAccessToken(accessToken) {
  if (!accessToken) return;
  authInvalidTokenCache.delete(accessToken);
}

async function refreshAuthSession(accessToken, refreshToken) {
  if (!refreshToken) return { session: null, user: null, error: new Error('缺少 refresh token') };

  const refreshKey = `${refreshToken}::${accessToken || ''}`;
  const pendingRefresh = authRefreshPromises.get(refreshKey);
  if (pendingRefresh) return pendingRefresh;

  const refreshPromise = (async () => {
    const authClient = createSupabaseAuthClient();
    if (!authClient) return { session: null, user: null, error: new Error('认证服务未配置') };
    const { data, error } = await authClient.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken
    });
    return {
      session: data?.session || null,
      user: data?.user || data?.session?.user || null,
      error
    };
  })();

  authRefreshPromises.set(refreshKey, refreshPromise);
  try {
    return await refreshPromise;
  } finally {
    authRefreshPromises.delete(refreshKey);
  }
}

// 验证 Token（从 Cookie 中读取 access_token / refresh_token）
async function authenticateFromCookie(req, res) {
  if (!supabase) return false;
  const cookies = parseCookies(req.headers.cookie);
  const accessToken = cookies[AUTH_ACCESS_COOKIE];
  const refreshToken = cookies[AUTH_REFRESH_COOKIE];
  if (!accessToken && !refreshToken) return false;

  try {
    if (accessToken) {
      const cachedUser = getCachedAuthUser(accessToken);
      if (cachedUser) {
        req.user = cachedUser;
        return true;
      }

      const accessTokenExpired = isTokenExpiredOrNearExpiry(accessToken);
      const invalidReason = getInvalidAccessTokenReason(accessToken);

      if (!accessTokenExpired && !invalidReason) {
        const { data: { user }, error } = await supabase.auth.getUser(accessToken);
        if (!error && user) {
          clearInvalidAccessToken(accessToken);
          setCachedAuthUser(accessToken, user);
          req.user = user;
          return true;
        }

        const reason = error?.message || '未知错误';
        clearCachedAuthUser(accessToken);
        markInvalidAccessToken(accessToken, reason);
        if (!/token is expired/i.test(reason)) {
          console.warn('Access Token 验证失败，尝试自动刷新会话:', reason);
        }
      }
    }

    if (!accessToken || !refreshToken) {
      clearCachedAuthUser(accessToken);
      clearInvalidAccessToken(accessToken);
      clearAuthCookies(res);
      return false;
    }

    const { session, user, error } = await refreshAuthSession(accessToken, refreshToken);
    if (error || !session?.access_token || !session?.refresh_token || !user) {
      console.error('刷新 Supabase 会话失败:', error?.message || '未知错误');
      clearCachedAuthUser(accessToken);
      clearInvalidAccessToken(accessToken);
      clearAuthCookies(res);
      return false;
    }

    setAuthCookies(res, session);
    if (accessToken && accessToken !== session.access_token) {
      clearCachedAuthUser(accessToken);
      clearInvalidAccessToken(accessToken);
    }
    clearInvalidAccessToken(session.access_token);
    setCachedAuthUser(session.access_token, user);
    req.user = user;
    return true;
  } catch (err) {
    clearCachedAuthUser(accessToken);
    clearInvalidAccessToken(accessToken);
    console.error('Token 验证失败:', err.message);
    clearAuthCookies(res);
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
  'clean-browser-profiles.js': '【清理浏览器数据】',
  'quick-plan-update-new.js': '【并发快速更新密钥】',
  'quick-update-bill.js': '【更新账单密钥】'
};

function getDisplayName(scriptFileName) {
  return SCRIPT_DISPLAY_NAMES[scriptFileName] || scriptFileName.replace(/\.js$/, '');
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ---------- 全局状态 ----------
let isRunning = false;
let currentScript = null;
let currentChild = null;
let currentTimeout = null;
let currentStopReason = null;
let currentForceKillTimer = null;
let taskQueue = [];
let lastRunResult = null;
let lastRunTime = null;
let history = [];
let sseClients = [];
let isShuttingDown = false;

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

function clearForceKillTimer() {
  if (!currentForceKillTimer) return;
  clearTimeout(currentForceKillTimer);
  currentForceKillTimer = null;
}

function killChildProcess(child, signal) {
  if (!child) return false;

  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch (err) {
      if (err.code !== 'ESRCH') throw err;
    }
  }

  try {
    return child.kill(signal);
  } catch (err) {
    if (err.code === 'ESRCH') return false;
    throw err;
  }
}

function waitForChildExit(child, timeoutMs = STOP_FORCE_KILL_DELAY + 5000) {
  return new Promise(resolve => {
    if (!child || child.exitCode !== null || child.signalCode) {
      resolve();
      return;
    }

    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', done);
      child.removeListener('close', done);
      resolve();
    };

    const timer = setTimeout(done, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    child.on('exit', done);
    child.on('close', done);
  });
}

function hasSoftFailure(scriptName, output, errorOutput) {
  const combined = `${output}\n${errorOutput}`;

  if (scriptName === 'quick-plan-update.js') {
    return /所有浏览器启动尝试均失败|未获取到anti-content，跳过更新|脚本执行出错/.test(combined);
  }

  return false;
}

function extractFailureDetail(result) {
  const lines = `${result.error || ''}\n${result.output || ''}`
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  const priorityPatterns = [
    /❌/i,
    /错误|失败|异常|超时|终止|未获取到|未捕获到|不存在/i,
    /Error|Failed|Timeout|ENOENT|EACCES|SIGTERM|SIGKILL|already running|Could not find Chrome/i
  ];

  const matchedLines = lines.filter(line => priorityPatterns.some(pattern => pattern.test(line)));
  const selectedLines = (matchedLines.length > 0 ? matchedLines : lines).slice(-8);

  const summaryLines = [
    `脚本: ${result.script}`,
    `时间: ${result.timestamp}`,
    `退出码: ${result.exitCode}`
  ];

  if (result.stopReason === 'timeout') {
    summaryLines.push('原因: 脚本执行超时');
  } else if (result.stopReason === 'shutdown') {
    summaryLines.push('原因: 服务关闭导致脚本中断');
  } else if (result.stopReason) {
    summaryLines.push(`原因: ${result.stopReason}`);
  } else if (result.softFailure) {
    summaryLines.push('原因: 虽然进程退出码为 0，但日志中检测到关键失败内容');
  } else if (result.error) {
    summaryLines.push('原因: 运行时异常');
  }

  if (selectedLines.length === 0) {
    summaryLines.push('关键失败内容: 暂无可展示的失败详情');
    return summaryLines.join('\n');
  }

  return `${summaryLines.join('\n')}\n\n关键失败内容:\n${selectedLines.join('\n')}`.slice(0, 1800);
}

function createHistoryId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeHistoryRecord(record) {
  if (!record || typeof record !== 'object') return null;

  const duration = Number.parseInt(record.duration, 10);
  const exitCode = Number.parseInt(record.exitCode, 10);

  return {
    id: typeof record.id === 'string' && record.id ? record.id : createHistoryId(),
    timestamp: String(record.timestamp || ''),
    script: String(record.script || ''),
    duration: Number.isNaN(duration) ? 0 : duration,
    success: Boolean(record.success),
    exitCode: Number.isNaN(exitCode) ? -1 : exitCode,
    failureDetail: typeof record.failureDetail === 'string' ? record.failureDetail : ''
  };
}

function buildHistorySummary(record) {
  return {
    id: record.id,
    timestamp: record.timestamp,
    script: record.script,
    duration: record.duration,
    success: record.success,
    exitCode: record.exitCode
  };
}

function buildHistoryStatusHtml(record) {
  if (record.success) {
    return '<span style="color: green;">成功</span>';
  }

  const historyId = escapeHtml(record.id || '');
  return `<button type="button" class="history-status-btn failed" data-history-id="${historyId}">失败</button>`;
}

function getStatePayload() {
  return {
    isRunning,
    currentScript,
    shuttingDown: isShuttingDown,
    lastRun: lastRunTime ? beijingTime(lastRunTime) : null,
    lastRunResult: lastRunResult ? {
      script: lastRunResult.script,
      success: lastRunResult.success,
      duration: lastRunResult.duration,
      timestamp: lastRunResult.timestamp,
      exitCode: lastRunResult.exitCode
    } : null
  };
}

function broadcastState() {
  sendSSE('state', getStatePayload());
}

function requestChildStop(reason) {
  if (!currentChild) {
    return { success: false, message: '没有正在运行的脚本' };
  }
  if (currentStopReason) {
    return { success: false, message: '脚本正在终止中，请稍候' };
  }

  const child = currentChild;
  const scriptName = currentScript || '未知脚本';

  let signalSent = false;
  try {
    signalSent = killChildProcess(child, 'SIGTERM');
  } catch (err) {
    console.error(`终止脚本 ${scriptName} 失败: ${err.message}`);
    broadcastLog('error', `终止脚本 ${scriptName} 失败: ${err.message}`);
    return { success: false, message: `终止脚本失败: ${err.message}` };
  }

  if (!signalSent) {
    return { success: false, message: '终止信号发送失败，请稍后重试' };
  }

  currentStopReason = reason;
  if (currentTimeout) {
    clearTimeout(currentTimeout);
    currentTimeout = null;
  }
  clearForceKillTimer();
  currentForceKillTimer = setTimeout(() => {
    if (currentChild !== child) return;
    broadcastLog('error', `脚本 ${scriptName} 在 ${Math.round(STOP_FORCE_KILL_DELAY / 1000)} 秒内未退出，强制终止`);
    try {
      killChildProcess(child, 'SIGKILL');
    } catch (err) {
      console.error(`强制终止脚本 ${scriptName} 失败: ${err.message}`);
      broadcastLog('error', `强制终止脚本 ${scriptName} 失败: ${err.message}`);
    }
  }, STOP_FORCE_KILL_DELAY);

  if (reason === 'timeout') {
    broadcastLog('error', `脚本 ${scriptName} 执行超时，已发送终止信号，等待退出`);
  } else if (reason === 'shutdown') {
    broadcastLog('info', `服务正在关闭，已向脚本 ${scriptName} 发送终止信号，等待退出`);
  } else {
    broadcastLog('info', `已向脚本 ${scriptName} 发送终止信号，等待退出`);
  }
  broadcastState();

  return {
    success: true,
    message: reason === 'timeout'
      ? '脚本执行超时，正在终止'
      : reason === 'shutdown'
        ? '服务正在关闭，已发送终止信号，等待脚本退出'
        : '已发送终止信号，等待脚本退出'
  };
}

async function readHistoryRecordsFromDisk() {
  try {
    const content = await fs.readFile(HISTORY_FILE, 'utf8');
    if (!content.trim()) return [];

    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) {
      throw new Error('history.json 格式无效');
    }

    return parsed
      .map(normalizeHistoryRecord)
      .filter(Boolean)
      .slice(0, MAX_HISTORY);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    console.error('读取历史详情文件失败:', err.message);
    return null;
  }
}

async function writeHistoryRecordsToDisk(records) {
  try {
    const normalizedRecords = records
      .map(normalizeHistoryRecord)
      .filter(Boolean)
      .slice(0, MAX_HISTORY);
    await fs.writeFile(HISTORY_FILE, JSON.stringify(normalizedRecords, null, 2), 'utf8');
  } catch (err) {
    console.error('写入历史详情文件失败:', err.message);
  }
}

async function appendHistoryLog(entry) {
  const line = `${entry.timestamp} | ${entry.script} | 耗时:${entry.duration}s | ${entry.success ? '成功' : '失败'} | 退出码:${entry.exitCode}\n`;
  try {
    await fs.appendFile(LOG_FILE, line, 'utf8');
  } catch (err) {
    console.error('写入历史日志失败:', err.message);
  }

  await writeHistoryRecordsToDisk(history);
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

function addToHistory(script, startTimeStr, duration, success, exitCode, failureDetail = '') {
  const record = normalizeHistoryRecord({
    id: createHistoryId(),
    timestamp: startTimeStr,
    script,
    duration,
    success,
    exitCode,
    failureDetail
  });
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
  currentStopReason = null;
  clearForceKillTimer();
  broadcastState();
  const startTime = Date.now();
  const startTimeStr = beijingTime(new Date(startTime));
  console.log('\n==========================================');
  console.log(`[${startTimeStr}] 开始执行脚本: ${scriptName}`);
  broadcastLog('info', `开始执行脚本: ${scriptName}`);

  getScriptPath(scriptName).then(scriptPath => {
    if (!scriptPath) throw new Error(`脚本 ${scriptName} 不存在`);

    const child = spawn('node', [scriptPath], {
      stdio: 'pipe',
      env: process.env,
      cwd: '/app',
      detached: process.platform !== 'win32'
    });
    currentChild = child;

    currentTimeout = setTimeout(() => {
      requestChildStop('timeout');
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

    child.on('close', (code, signal) => {
      const stopReason = currentStopReason;
      if (currentTimeout) clearTimeout(currentTimeout);
      clearForceKillTimer();
      currentChild = null;
      currentTimeout = null;
      currentStopReason = null;
      isRunning = false;
      currentScript = null;
      const endTime = new Date();
      const duration = Math.floor((Date.now() - startTime) / 1000);
      const exitCode = code === null ? (signal || -1) : code;
      const softFailure = !stopReason && hasSoftFailure(scriptName, output, errorOutput);
      const success = !stopReason && code === 0 && !softFailure;
      lastRunTime = endTime;
      const result = {
        success,
        exitCode,
        signal: signal || null,
        stopReason,
        softFailure,
        script: scriptName,
        timestamp: startTimeStr,
        duration,
        output: output.slice(-5000),
        error: errorOutput.slice(-5000)
      };
      result.failureDetail = success ? '' : extractFailureDetail(result);
      lastRunResult = result;

      if (stopReason === 'manual') {
        console.warn(`[${beijingTime(endTime)}] 脚本 ${scriptName} 已手动终止，退出信号: ${signal || 'SIGTERM'}`);
        broadcastLog('info', `脚本 ${scriptName} 已手动终止，退出信号: ${signal || 'SIGTERM'}，耗时 ${duration} 秒`);
      } else if (stopReason === 'timeout') {
        console.error(`[${beijingTime(endTime)}] 脚本 ${scriptName} 因超时被终止，退出信号: ${signal || 'SIGTERM'}`);
        broadcastLog('error', `脚本 ${scriptName} 因超时被终止，退出信号: ${signal || 'SIGTERM'}，耗时 ${duration} 秒`);
      } else if (stopReason === 'shutdown') {
        console.warn(`[${beijingTime(endTime)}] 脚本 ${scriptName} 因服务关闭而终止，退出信号: ${signal || 'SIGTERM'}`);
        broadcastLog('info', `脚本 ${scriptName} 因服务关闭而终止，退出信号: ${signal || 'SIGTERM'}，耗时 ${duration} 秒`);
      } else if (softFailure) {
        console.error(`[${beijingTime(endTime)}] 脚本 ${scriptName} 执行完成，但检测到异常日志，判定为失败，退出码: ${exitCode}`);
        console.log(`总运行时长: ${duration} 秒`);
        broadcastLog('error', `脚本 ${scriptName} 执行完成，但检测到异常日志，判定为失败，退出码: ${exitCode}，耗时 ${duration} 秒`);
      } else {
        console.log(`[${beijingTime(endTime)}] 脚本 ${scriptName} 执行完成，退出码: ${exitCode}`);
        console.log(`总运行时长: ${duration} 秒`);
        broadcastLog('info', `脚本 ${scriptName} 执行完成，退出码: ${exitCode}，耗时 ${duration} 秒`);
      }
      console.log("==========================================");

      addToHistory(scriptName, startTimeStr, duration, success, exitCode, result.failureDetail);
      broadcastState();
      resolve(result);
      runNext();
    });

    child.on('error', (err) => {
      if (currentTimeout) clearTimeout(currentTimeout);
      clearForceKillTimer();
      currentChild = null;
      currentTimeout = null;
      currentStopReason = null;
      isRunning = false;
      currentScript = null;
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
      result.failureDetail = extractFailureDetail(result);
      lastRunResult = result;
      console.error(`[${beijingTime()}] 脚本 ${scriptName} 执行错误: ${err.message}`);
      broadcastLog('error', `脚本 ${scriptName} 执行错误: ${err.message}`);
      addToHistory(scriptName, startTimeStr, duration, false, -1, result.failureDetail);
      broadcastState();
      resolve(result);
      runNext();
    });
  }).catch(err => {
    clearForceKillTimer();
    currentStopReason = null;
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
    result.failureDetail = extractFailureDetail(result);
    lastRunResult = result;
    console.error(`[${beijingTime()}] 脚本 ${scriptName} 定位失败: ${err.message}`);
    broadcastLog('error', `脚本 ${scriptName} 定位失败: ${err.message}`);
    addToHistory(scriptName, startTimeStr, duration, false, -1, result.failureDetail);
    isRunning = false;
    currentScript = null;
    broadcastState();
    resolve(result);
    runNext();
  });
}

function queueScript(scriptName) {
  return new Promise((resolve, reject) => {
    if (isShuttingDown) {
      reject(new Error('trigger-server 正在关闭，暂不接受新的脚本任务'));
      return;
    }

    const queuedBefore = taskQueue.length;
    const queued = isRunning || queuedBefore > 0;
    const queuePosition = queued ? queuedBefore + 1 : 0;

    taskQueue.push({ scriptName, resolve: () => {}, reject: () => {} });
    broadcastState();
    if (!isRunning) runNext();

    resolve({
      accepted: true,
      script: scriptName,
      queued,
      queuePosition,
      startedAt: beijingTime()
    });
  });
}

function runNext() {
  if (isShuttingDown) return;
  if (taskQueue.length === 0) return;
  if (isRunning) return;
  const { scriptName, resolve, reject } = taskQueue.shift();
  broadcastState();
  runScriptTask(scriptName, resolve, reject);
}

function rejectQueuedTasks(message) {
  if (taskQueue.length === 0) return;
  const pendingTasks = taskQueue;
  taskQueue = [];
  for (const { reject } of pendingTasks) {
    reject(new Error(message));
  }
}

function closeSSEClients() {
  if (sseClients.length === 0) return;
  for (const client of sseClients) {
    try {
      client.end();
    } catch {}
  }
  sseClients = [];
}

async function shutdownServer(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  broadcastState();

  const exitTimer = setTimeout(() => {
    console.error(`[${beijingTime()}] ${signal} 关闭超时，强制退出进程`);
    process.exit(1);
  }, STOP_FORCE_KILL_DELAY + 10000);
  if (typeof exitTimer.unref === 'function') exitTimer.unref();

  console.warn(`[${beijingTime()}] 收到 ${signal}，开始优雅关闭 trigger-server`);
  broadcastLog('info', `收到 ${signal}，开始优雅关闭服务`);
  rejectQueuedTasks('trigger-server 正在关闭，已取消排队中的脚本任务');
  broadcastState();

  try {
    const child = currentChild;
    if (child) {
      if (!currentStopReason) {
        const stopResult = requestChildStop('shutdown');
        if (!stopResult.success) {
          console.warn(`[${beijingTime()}] 关闭时终止脚本失败: ${stopResult.message}`);
          broadcastLog('error', `关闭时终止脚本失败: ${stopResult.message}`);
        }
      } else {
        broadcastLog('info', `服务关闭中，等待脚本 ${currentScript || '未知脚本'} 退出`);
      }
      await waitForChildExit(child);
    }
  } catch (err) {
    console.error(`[${beijingTime()}] 优雅关闭脚本失败: ${err.message}`);
    broadcastLog('error', `优雅关闭脚本失败: ${err.message}`);
  }

  closeSSEClients();

  try {
    await new Promise(resolve => server.close(() => resolve()));
  } finally {
    clearTimeout(exitTimer);
  }

  process.exit(0);
}

async function getAvailableScriptEntries() {
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

  return Array.from(scriptMap.entries()).map(([name, directory]) => ({
    name,
    directory,
    deletable: directory === USER_DATA_SCRIPTS_DIR
  }));
}

async function getAvailableScripts() {
  const entries = await getAvailableScriptEntries();
  return entries.map(entry => entry.name);
}

async function getScriptPath(scriptName) {
  const mainPath = path.join(SCRIPTS_DIR, scriptName);
  try { await fs.access(mainPath); return mainPath; } catch { }
  const userPath = path.join(USER_DATA_SCRIPTS_DIR, scriptName);
  try { await fs.access(userPath); return userPath; } catch { return null; }
}

async function loadHistoryFromFile() {
  const diskHistory = await readHistoryRecordsFromDisk();
  if (diskHistory) {
    history = diskHistory;
    return;
  }

  try {
    const content = await fs.readFile(LOG_FILE, 'utf8');
    const lines = content.split(/\r?\n/).filter(l => l.trim());
    const records = [];
    for (const line of lines.slice(-MAX_HISTORY)) {
      const match = line.match(/^(.+?) \| (.+?) \| 耗时:(\d+)s \| (成功|失败) \| 退出码:(-?\d+)/);
      if (match) {
        records.push(normalizeHistoryRecord({
          timestamp: match[1],
          script: match[2],
          duration: Number.parseInt(match[3], 10),
          success: match[4] === '成功',
          exitCode: Number.parseInt(match[5], 10),
          failureDetail: ''
        }));
      }
    }
    history = records.filter(Boolean).reverse();
    await writeHistoryRecordsToDisk(history);
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
        const authClient = createSupabaseAuthClient();
        const { data, error } = await authClient.auth.signInWithPassword({ email, password });
        if (error) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error.message }));
          return;
        }
        if (!data.session?.access_token || !data.session?.refresh_token) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '登录成功，但未获取到完整会话' }));
          return;
        }
        setAuthCookies(res, data.session);
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
    clearAuthCookies(res);
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
  const protectedPaths = ['/trigger', '/run/', '/upload', '/script/', '/status', '/history', '/events', '/metrics'];
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
  if (pathname === '/history/detail' && method === 'GET') {
    const historyId = parsedUrl.searchParams.get('id');
    if (!historyId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '缺少历史记录ID' }));
      return;
    }

    const record = history.find(item => item.id === historyId);
    if (!record) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '未找到对应的失败记录' }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: record.id,
      failureDetail: record.failureDetail || ''
    }));
    return;
  }

  if (pathname === '/history' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(history.map(buildHistorySummary)));
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

    try {
      const result = await queueScript(scriptName);
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        message: result.queued
          ? `脚本 ${scriptName} 已加入队列，前方还有 ${result.queuePosition - 1} 个任务`
          : `脚本 ${scriptName} 已开始执行，请查看实时日志`,
        result
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: err.message || '启动脚本失败',
        current_script: currentScript || null
      }));
    }
    return;
  }

  // 默认触发
  if (pathname === '/trigger' && method === 'POST') {
    try {
      const result = await queueScript('update-pdd-cron.js');
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        message: result.queued
          ? `爬虫任务已加入队列，前方还有 ${result.queuePosition - 1} 个任务`
          : '爬虫任务已开始执行，请查看实时日志',
        result
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: err.message || '启动爬虫任务失败',
        current_script: currentScript || null
      }));
    }
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
    sendSSE('state', getStatePayload());
    req.on('close', () => {
      sseClients = sseClients.filter(client => client !== res);
    });
    return;
  }

  // Web 控制台界面（已通过认证中间件保护，这里直接返回 HTML）
  if (pathname === '/trigger' && method === 'GET') {
    const availableScripts = await getAvailableScriptEntries();
    const buttonsHtml = availableScripts.map(({ name, deletable }) => {
      const displayName = escapeHtml(getDisplayName(name));
      const safeScriptName = escapeHtml(name);
      return `
        <div class="script-item" title="${safeScriptName}">
          <button class="script-btn" data-script="${safeScriptName}" title="${safeScriptName}">${displayName}</button>
          ${deletable ? `<button class="delete-btn" data-script="${safeScriptName}" title="删除脚本 ${safeScriptName}">🗑️</button>` : ''}
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
        <td>${escapeHtml(h.timestamp)}</td>
        <td>${escapeHtml(h.script)}</td>
        <td>${h.duration}秒</td>
        <td>${buildHistoryStatusHtml(h)}</td>
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
            .desktop-section {
              margin-top: 20px;
            }
            .desktop-toolbar {
              display: flex;
              justify-content: space-between;
              align-items: center;
              gap: 12px;
              flex-wrap: wrap;
              margin-bottom: 10px;
            }
            .desktop-actions {
              display: flex;
              gap: 8px;
              flex-wrap: wrap;
            }
            .desktop-status {
              font-size: 0.9rem;
              color: #475569;
            }
            .desktop-frame-wrap {
              background: #0f172a;
              border-radius: 16px;
              overflow: hidden;
              border: 1px solid rgba(148, 163, 184, 0.3);
            }
            .desktop-placeholder {
              min-height: 220px;
              display: flex;
              align-items: center;
              justify-content: center;
              padding: 24px;
              color: #cbd5e1;
              background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
              text-align: center;
              line-height: 1.7;
            }
            .desktop-frame {
              width: 100%;
              height: min(72vh, 780px);
              border: 0;
              display: none;
              background: #0f172a;
            }
            .desktop-frame.visible {
              display: block;
            }
            .desktop-note {
              margin-top: 10px;
              color: #64748b;
              font-size: 0.85rem;
              line-height: 1.6;
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
            .history-status-btn {
              background: none;
              border: none;
              padding: 0;
              font: inherit;
              cursor: pointer;
              text-decoration: underline;
              text-underline-offset: 2px;
            }
            .history-status-btn.failed {
              color: #dc2626;
              font-weight: 600;
            }
            .modal-overlay {
              position: fixed;
              inset: 0;
              background: rgba(15, 23, 42, 0.55);
              display: none;
              align-items: center;
              justify-content: center;
              padding: 20px;
              z-index: 10001;
            }
            .modal-overlay.visible {
              display: flex;
            }
            .modal-card {
              width: min(720px, 100%);
              max-height: 80vh;
              overflow: hidden;
              background: #fff;
              border-radius: 16px;
              box-shadow: 0 20px 50px rgba(0,0,0,0.25);
              display: flex;
              flex-direction: column;
            }
            .modal-header {
              display: flex;
              justify-content: space-between;
              align-items: center;
              gap: 12px;
              padding: 18px 20px;
              border-bottom: 1px solid #e2e8f0;
            }
            .modal-close {
              border: none;
              background: #eef2ff;
              color: #4338ca;
              border-radius: 999px;
              width: 34px;
              height: 34px;
              cursor: pointer;
              font-size: 18px;
            }
            .modal-content {
              padding: 20px;
              overflow: auto;
            }
            .modal-pre {
              margin: 0;
              white-space: pre-wrap;
              word-break: break-word;
              font-family: Consolas, Monaco, monospace;
              font-size: 13px;
              line-height: 1.6;
              color: #1e293b;
            }
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
                  <div class="status-item">⚙️ 当前脚本: <span id="currentScript">无</span></div>
                  <div class="status-item">🕒 上次运行: <span id="lastRun">无</span></div>
                </div>
                <div class="status-row">
                  <div class="status-item">💚 健康状态: <span id="healthStatus">检查中...</span></div>
                </div>
              </div>

              <h2>📜 可用脚本</h2>
              <div class="script-grid" id="buttonGrid">${buttonsHtml}</div>

              <div class="upload-area">
                <strong>📤 上传新脚本 (.js)</strong>
                <input type="file" id="uploadFile" accept=".js">
                <button id="uploadBtn" class="btn-small">上传</button>
                <span id="uploadMsg" style="margin-left: 10px;"></span>
              </div>

              <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;">
                <h2 style="margin-bottom:0;">📡 实时执行日志</h2>
                <button id="toggleLogBtn" class="btn-small" type="button">👁️ 显示日志</button>
              </div>
              <div class="log-section" id="logSection">
                <div class="log-box" id="logBox"></div>
              </div>

              <div class="desktop-section">
                <div class="desktop-toolbar">
                  <h2 style="margin:0;">🖥️ 内嵌远程桌面</h2>
                  <div class="desktop-actions">
                    <span class="desktop-status">状态: <strong id="desktopStatus">未加载</strong></span>
                    <button id="loadDesktopBtn" class="btn-small" type="button">加载桌面</button>
                    <button id="refreshDesktopBtn" class="btn-small" type="button">刷新桌面</button>
                    <button id="openDesktopBtn" class="btn-small" type="button">新窗口打开</button>
                  </div>
                </div>
                <div class="desktop-frame-wrap">
                  <div id="desktopPlaceholder" class="desktop-placeholder">点击“加载桌面”后，会在当前控制台内嵌打开远程桌面，方便一边看日志一边操作。</div>
                  <iframe id="desktopFrame" class="desktop-frame" title="远程桌面" loading="lazy"></iframe>
                </div>
                <div class="desktop-note">该区域本质仍是 noVNC 的内嵌页面，主要提升操作便利性；与直接打开 <code>/vnc.html</code> 相比，传输链路基本相同，通常不会更快。</div>
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

          <div id="failureModal" class="modal-overlay">
            <div class="modal-card">
              <div class="modal-header">
                <h3>失败详情</h3>
                <button id="closeFailureModalBtn" class="modal-close" type="button">×</button>
              </div>
              <div class="modal-content">
                <pre id="failureModalContent" class="modal-pre"></pre>
              </div>
            </div>
          </div>

          <script>
            const logBox = document.getElementById('logBox');
            const logSection = document.getElementById('logSection');
            const globalStatusSpan = document.getElementById('globalStatus');
            const currentScriptSpan = document.getElementById('currentScript');
            const lastRunSpan = document.getElementById('lastRun');
            const statusIndicator = document.getElementById('statusIndicator');
            const healthStatusSpan = document.getElementById('healthStatus');
            const toggleLogBtn = document.getElementById('toggleLogBtn');
            const uploadFile = document.getElementById('uploadFile');
            const uploadBtn = document.getElementById('uploadBtn');
            const uploadMsg = document.getElementById('uploadMsg');
            const logoutBtn = document.getElementById('logoutBtn');
            const historyBody = document.getElementById('historyBody');
            const failureModal = document.getElementById('failureModal');
            const failureModalContent = document.getElementById('failureModalContent');
            const closeFailureModalBtn = document.getElementById('closeFailureModalBtn');
            const desktopFrame = document.getElementById('desktopFrame');
            const desktopPlaceholder = document.getElementById('desktopPlaceholder');
            const loadDesktopBtn = document.getElementById('loadDesktopBtn');
            const refreshDesktopBtn = document.getElementById('refreshDesktopBtn');
            const openDesktopBtn = document.getElementById('openDesktopBtn');
            const desktopStatus = document.getElementById('desktopStatus');
            const DESKTOP_FRAME_URL = '/vnc.html?autoconnect=true&resize=scale';

            function showToast(msg, type = 'info') {
              const toast = document.createElement('div');
              toast.className = 'toast ' + type;
              toast.textContent = msg;
              document.body.appendChild(toast);
              setTimeout(() => toast.remove(), 3000);
            }

            function escapeHtmlText(value) {
              return String(value ?? '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
            }

            function buildHistoryStatusCell(historyItem) {
              if (historyItem.success) {
                return '<span style="color: green;">成功</span>';
              }

              const historyId = encodeURIComponent(historyItem.id || '');
              return '<button type="button" class="history-status-btn failed" data-history-id="' + historyId + '">失败</button>';
            }

            function showFailureModal(detail) {
              failureModalContent.textContent = detail || '该失败记录暂无详细内容。';
              failureModal.classList.add('visible');
            }

            async function openFailureDetail(historyId) {
              showFailureModal('加载中...');
              try {
                const res = await fetch('/history/detail?id=' + encodeURIComponent(historyId), { cache: 'no-store' });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) {
                  throw new Error(data.error || '获取失败详情失败');
                }
                showFailureModal(data.failureDetail || '该失败记录暂无详细内容。');
              } catch (err) {
                showFailureModal('加载失败详情时出错: ' + err.message);
              }
            }

            function closeFailureModal() {
              failureModal.classList.remove('visible');
            }

            let reconnectTimer = null;
            let hideLogTimer = null;
            let evtSource = null;
            let heartbeatCheckTimer = null;
            let lastSSEActivityAt = 0;
            let serviceHealthy = true;
            let sseStatus = 'connecting';
            let reconnectAttempts = 0;
            let authRecoveryPromise = null;
            let loginRedirectTimer = null;
            let loginPromptShown = false;
            let latestIsRunning = false;
            let latestCompletedRunKey = '';
            let hasReceivedInitialState = false;
            let manualLogOverride = null;
            const SSE_BASE_RECONNECT_DELAY = 5000;
            const SSE_MAX_RECONNECT_DELAY = 30000;
            const HEALTH_CHECK_TIMEOUT = 5000;
            const AUTH_RECOVERY_DELAY = 1200;

            function updateLogToggleButton() {
              const visible = logSection.classList.contains('visible');
              toggleLogBtn.innerText = visible ? '🙈 隐藏日志' : '👁️ 显示日志';
            }

            function setLogSectionVisible(isRunning) {
              const wasRunning = latestIsRunning;
              latestIsRunning = isRunning;

              if (!isRunning && wasRunning && manualLogOverride === false) {
                manualLogOverride = null;
              }

              const shouldShowNow = manualLogOverride === true || (manualLogOverride !== false && isRunning);
              if (shouldShowNow) {
                if (hideLogTimer) {
                  clearTimeout(hideLogTimer);
                  hideLogTimer = null;
                }
                logSection.classList.add('visible');
                updateLogToggleButton();
                return;
              }

              if (hideLogTimer) {
                clearTimeout(hideLogTimer);
                hideLogTimer = null;
              }

              if (manualLogOverride === false) {
                logSection.classList.remove('visible');
                updateLogToggleButton();
                return;
              }

              hideLogTimer = setTimeout(() => {
                if (!latestIsRunning && manualLogOverride !== true) {
                  logSection.classList.remove('visible');
                  updateLogToggleButton();
                }
                hideLogTimer = null;
              }, 10000);
              updateLogToggleButton();
            }

            function renderHealthStatus() {
              if (authRecoveryPromise) {
                healthStatusSpan.innerText = '连接恢复中...';
                return;
              }
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

            function setDesktopStatus(status) {
              desktopStatus.innerText = status;
            }

            function buildDesktopFrameUrl() {
              return DESKTOP_FRAME_URL + '&t=' + Date.now();
            }

            function loadDesktopFrame(forceReload = false) {
              const hasLoaded = desktopFrame.dataset.loaded === 'true';
              if (hasLoaded && !forceReload) {
                setDesktopStatus('已加载');
                return;
              }

              desktopFrame.dataset.loaded = 'true';
              desktopPlaceholder.style.display = 'none';
              desktopFrame.classList.add('visible');
              setDesktopStatus(forceReload ? '重新连接中...' : '连接中...');
              desktopFrame.src = buildDesktopFrameUrl();
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

            function clearLoginRedirectTimer() {
              if (!loginRedirectTimer) return;
              clearTimeout(loginRedirectTimer);
              loginRedirectTimer = null;
            }

            function resetLoginPrompt() {
              loginPromptShown = false;
              clearLoginRedirectTimer();
            }

            function promptLogin(message = '登录状态已失效，请重新登录') {
              if (loginPromptShown) return;
              loginPromptShown = true;
              clearLoginRedirectTimer();
              showToast(message, 'error');
              loginRedirectTimer = setTimeout(() => {
                window.location.href = '/login';
              }, 1200);
            }

            function sleep(ms) {
              return new Promise(resolve => setTimeout(resolve, ms));
            }

            async function attemptSilentAuthRecovery(source) {
              if (authRecoveryPromise) return authRecoveryPromise;
              authRecoveryPromise = (async () => {
                try {
                  await sleep(AUTH_RECOVERY_DELAY);
                  const res = await fetch('/check-auth', { cache: 'no-store' });
                  const data = await res.json().catch(() => ({}));
                  if (res.ok && data.authenticated) {
                    resetLoginPrompt();
                    return true;
                  }
                  if (res.ok) {
                    promptLogin();
                  }
                  return false;
                } catch (err) {
                  console.warn('静默鉴权恢复检查失败', source, err);
                  return false;
                } finally {
                  authRecoveryPromise = null;
                  renderHealthStatus();
                }
              })();
              renderHealthStatus();
              return authRecoveryPromise;
            }

            function markSSEAlive() {
              lastSSEActivityAt = Date.now();
              reconnectAttempts = 0;
              serviceHealthy = true;
              clearReconnectTimer();
              resetLoginPrompt();
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
                  const err = new Error('HTTP ' + res.status);
                  err.status = res.status;
                  throw err;
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
                resetLoginPrompt();
              } catch (e) {
                if ((e.status === 401 || e.status === 403) && await attemptSilentAuthRecovery('health')) {
                  try {
                    const data = await fetchJSONWithTimeout('/health', HEALTH_CHECK_TIMEOUT);
                    serviceHealthy = data.status === 'ok';
                    resetLoginPrompt();
                  } catch (retryError) {
                    serviceHealthy = false;
                  }
                } else {
                  serviceHealthy = false;
                }
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
                  const isRunning = !!state.isRunning;
                  const shuttingDown = !!state.shuttingDown;
                  const completedRunKey = state.lastRunResult
                    ? \`\${state.lastRunResult.timestamp}|\${state.lastRunResult.script}|\${state.lastRunResult.duration}|\${state.lastRunResult.exitCode}|\${state.lastRunResult.success}\`
                    : '';
                  globalStatusSpan.innerText = shuttingDown ? '关闭中' : (isRunning ? '运行中' : '空闲');
                  if (isRunning) {
                    statusIndicator.className = 'status-indicator running';
                  } else {
                    statusIndicator.className = 'status-indicator';
                  }
                  setLogSectionVisible(isRunning);
                  currentScriptSpan.innerText = state.currentScript || '无';
                  lastRunSpan.innerText = state.lastRun || '无';
                  document.querySelectorAll('.script-btn').forEach(btn => {
                    btn.disabled = isRunning;
                  });
                  if (completedRunKey && completedRunKey !== latestCompletedRunKey) {
                    latestCompletedRunKey = completedRunKey;
                    refreshHistoryAndStats();
                    if (hasReceivedInitialState && !isRunning) {
                      showToast(\`脚本 \${state.lastRunResult.script} 执行完成，退出码: \${state.lastRunResult.exitCode}，耗时 \${state.lastRunResult.duration} 秒\`, state.lastRunResult.success ? 'success' : 'error');
                    }
                  }
                  hasReceivedInitialState = true;
                } catch(err) { console.error('解析状态错误', err); }
              });

              evtSource.onerror = function(err) {
                serviceHealthy = false;
                const delay = reconnectSSE();
                if (navigator.onLine) {
                  attemptSilentAuthRecovery('events').then(recovered => {
                    if (recovered) {
                      reconnectAttempts = 0;
                      reconnectSSE(0);
                    }
                  });
                }
                console.error('SSE连接错误，' + Math.round(delay / 1000) + '秒后重连', err);
              };
            }

            function renderHistoryAndStats(history) {
              if (!Array.isArray(history) || history.length === 0) {
                historyBody.innerHTML = '<tr><td colspan="6">暂无记录</td></tr>';
                document.getElementById('totalExec').innerText = 0;
                document.getElementById('successCount').innerText = 0;
                document.getElementById('failCount').innerText = 0;
                document.getElementById('avgDuration').innerText = 0;
                return;
              }

              let html = '';
              history.forEach((h, idx) => {
                html += \`
                  <tr>
                    <td>\${idx + 1}</td>
                    <td>\${escapeHtmlText(h.timestamp)}</td>
                    <td>\${escapeHtmlText(h.script)}</td>
                    <td>\${h.duration}秒</td>
                    <td>\${buildHistoryStatusCell(h)}</td>
                    <td>\${h.exitCode}</td>
                  </tr>
                \`;
              });
              historyBody.innerHTML = html;

              const total = history.length;
              const success = history.filter(h => h.success).length;
              const fail = total - success;
              const avg = total ? (history.reduce((sum, h) => sum + h.duration, 0) / total).toFixed(1) : 0;
              document.getElementById('totalExec').innerText = total;
              document.getElementById('successCount').innerText = success;
              document.getElementById('failCount').innerText = fail;
              document.getElementById('avgDuration').innerText = avg;
            }

            async function refreshHistoryAndStats() {
              try {
                const res = await fetch('/history', { cache: 'no-store' });
                const history = await res.json();
                renderHistoryAndStats(history);
              } catch(e) {
                console.error('获取历史失败', e);
              }
            }

            async function runScript(scriptName, btn) {
              if (btn.disabled) return;
              if (latestIsRunning) {
                showToast(\`脚本 \${currentScriptSpan.innerText || '任务'} 正在执行，请稍后再试\`, 'info');
                return;
              }
              const originalText = btn.innerText;
              btn.innerText = '⏳ 启动中…';
              btn.disabled = true;
              try {
                const encoded = encodeURIComponent(scriptName);
                const res = await fetch('/run/' + encoded, { method: 'POST' });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) {
                  throw new Error(data.error || '启动失败');
                }
                setLogSectionVisible(true);
                showToast(data.message || \`脚本 \${scriptName} 已开始执行，请查看实时日志\`, 'success');
              } catch(err) {
                showToast('请求失败: ' + err.message, 'error');
              } finally {
                btn.innerText = originalText;
                btn.disabled = latestIsRunning;
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

            toggleLogBtn.onclick = () => {
              const currentlyVisible = logSection.classList.contains('visible');
              if (currentlyVisible) {
                manualLogOverride = latestIsRunning ? false : null;
                if (hideLogTimer) {
                  clearTimeout(hideLogTimer);
                  hideLogTimer = null;
                }
                logSection.classList.remove('visible');
                updateLogToggleButton();
                return;
              }

              manualLogOverride = true;
              setLogSectionVisible(latestIsRunning);
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

            loadDesktopBtn.onclick = () => {
              loadDesktopFrame(false);
            };

            refreshDesktopBtn.onclick = () => {
              loadDesktopFrame(true);
            };

            openDesktopBtn.onclick = () => {
              window.open(DESKTOP_FRAME_URL, '_blank', 'noopener,noreferrer');
            };

            desktopFrame.addEventListener('load', () => {
              if (desktopFrame.dataset.loaded === 'true') {
                setDesktopStatus('已加载');
              }
            });

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

            historyBody.addEventListener('click', (e) => {
              const btn = e.target.closest('.history-status-btn.failed');
              if (!btn) return;
              const historyId = decodeURIComponent(btn.getAttribute('data-history-id') || '');
              if (!historyId) {
                showFailureModal('该失败记录暂无可用标识，无法读取详情。');
                return;
              }
              openFailureDetail(historyId);
            });

            closeFailureModalBtn.addEventListener('click', closeFailureModal);
            failureModal.addEventListener('click', (e) => {
              if (e.target === failureModal) closeFailureModal();
            });
            document.addEventListener('keydown', (e) => {
              if (e.key === 'Escape' && failureModal.classList.contains('visible')) {
                closeFailureModal();
              }
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
              if (desktopFrame.dataset.loaded === 'true') {
                desktopFrame.src = 'about:blank';
              }
            });

            updateLogToggleButton();
            connectSSE();
            updateHealthStatus();
            setInterval(() => {
              if (document.visibilityState === 'visible' && sseStatus !== 'connected') {
                updateHealthStatus();
              }
            }, 30000);
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

cron.schedule('8 6 * * *', () => { //每天北京时间6：08运行
  cleanOldLogs();
}, { timezone: "Asia/Shanghai" });

server.listen(PORT, '0.0.0.0', async () => {
  await loadHistoryFromFile();
  console.log(`触发服务器运行在 http://0.0.0.0:${PORT}`);
  console.log(`脚本目录: ${SCRIPTS_DIR} 和 ${USER_DATA_SCRIPTS_DIR}`);
  console.log(`日志文件: ${LOG_FILE}`);
  console.log(`历史详情文件: ${HISTORY_FILE}`);
  console.log(`可用端点: /health, /status, /trigger, /run/:script, /upload, /script/:filename, /events, /history, /history/detail`);
  if (API_KEY) console.log(`⚠️ API Key 验证已启用`);
  if (!supabase) console.warn('⚠️ Supabase 未配置，认证功能已禁用！请设置环境变量 SUPABASE_URL 和 SUPABASE_SERVICE_ROLE_KEY');
});

process.on('SIGINT', () => {
  shutdownServer('SIGINT').catch(err => {
    console.error(`[${beijingTime()}] SIGINT 关闭失败: ${err.message}`);
    process.exit(1);
  });
});

process.on('SIGTERM', () => {
  shutdownServer('SIGTERM').catch(err => {
    console.error(`[${beijingTime()}] SIGTERM 关闭失败: ${err.message}`);
    process.exit(1);
  });
});
