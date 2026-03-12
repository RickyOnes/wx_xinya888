#!/usr/bin/env node

/**
 * 触发爬虫执行的 HTTP 服务器
 * 提供 /trigger 端点手动触发爬虫任务
 * 用于 Supabase Cron 定时调用
 *
 * Supabase Cron 配置示例（在 Supabase SQL 编辑器中执行）：
 * -- 启用 pg_cron 和 pg_net 扩展（如果尚未启用）
 * CREATE EXTENSION IF NOT EXISTS pg_cron;
 * CREATE EXTENSION IF NOT EXISTS pg_net;
 * 
    // -- 添加定时任务，每 30 分钟触发一次爬虫
    // SELECT cron.schedule(
    //   'trigger-crawler-every-30min',
    //   '* 30 * * * *',
    //   $$
    //   SELECT net.http_post(
    //     url := 'http://&lt;你的容器IP或域名&gt;/trigger',
    //     headers := '{"Authorization": "Bearer &lt;你的API_KEY&gt;"}'::jsonb, 未设置 API_KEY 时可省略
    //     timeout_milliseconds := 300000
    //   ) AS request_id;
    //   $$
    // );
    // 
    // 注意：需要将 &lt;你的容器IP或域名&gt; 替换为实际部署地址，&lt;你的API_KEY&gt; 替换为设置的 API_KEY 环境变量值。
    // 如果未设置 API_KEY 环境变量，则无需 Authorization 头。
 */

const http = require('http');
const { spawn } = require('child_process');
const { URL } = require('url');

const PORT = process.env.TRIGGER_PORT || 3001;  // 改为 3001
const API_KEY = process.env.API_KEY || '';
const CRAWLER_SCRIPT = 'scripts/update-pdd-new.js';

let isRunning = false;
let lastRunTime = null;
let lastRunResult = null;

function executeCrawler() {
  if (isRunning) {
    return Promise.resolve({ success: false, message: '爬虫正在运行中，请稍后再试' });
  }

  isRunning = true;
  console.log("==========================================");
  console.log(`CronJob 开始时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
  const startTime = Math.floor(Date.now() / 1000);
  console.log(`[${new Date().toISOString()}] 开始执行爬虫脚本: ${CRAWLER_SCRIPT}`);

  return new Promise((resolve) => {
    const child = spawn('node', [CRAWLER_SCRIPT], {
      stdio: 'pipe',
      env: { ...process.env, HEADLESS: 'true' },  // 强制无头模式
      cwd: '/app'      
    });

    let output = '';
    let errorOutput = '';

    child.stdout.on('data', (data) => {
      const str = data.toString();
      output += str;
      console.log(`[爬虫输出] ${str.trim()}`);
    });

    child.stderr.on('data', (data) => {
      const str = data.toString();
      errorOutput += str;
      console.error(`[爬虫错误] ${str.trim()}`);
    });

    child.on('close', (code) => {
      isRunning = false;
      lastRunTime = new Date();
      const endTime = Math.floor(Date.now() / 1000);
      const duration = endTime - startTime;
      
      const result = {
        success: code === 0,
        exitCode: code,
        timestamp: lastRunTime.toISOString(),
        duration: duration,
        output: output.slice(-5000), // 保留最后5000字符
        error: errorOutput.slice(-5000)
      };
      
      lastRunResult = result;
      console.log(`[${lastRunTime.toISOString()}] 爬虫执行完成，退出码: ${code}`);
      console.log(`CronJob 结束时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
      console.log(`总运行时长: ${duration} 秒`);
      console.log(`退出码: ${code}`);
      console.log("==========================================");
      resolve(result);
    });

    child.on('error', (err) => {
      isRunning = false;
      lastRunTime = new Date();
      const endTime = Math.floor(Date.now() / 1000);
      const duration = endTime - startTime;
      const result = {
        success: false,
        exitCode: -1,
        timestamp: lastRunTime.toISOString(),
        duration: duration,
        output: output.slice(-5000),
        error: err.message  // spawn 错误信息
      };
      lastRunResult = result;
      console.error(`[${lastRunTime.toISOString()}] 爬虫执行错误: ${err.message}`);
      console.log(`CronJob 结束时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
      console.log(`总运行时长: ${duration} 秒`);
      console.log("==========================================");
      resolve(result);
    });
  });
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const path = parsedUrl.pathname;
  const method = req.method;

  // 设置 CORS 头
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // 验证 API Key（如果设置了）
  if (API_KEY) {
    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${API_KEY}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '未授权访问' }));
      return;
    }
  }

  // 健康检查端点
  if (path === '/trigger' && method === 'GET') {
    // 在 Content-Type 中明确指定字符集为 utf-8
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); 
    res.end(`
      <html>
        <head><meta charset="UTF-8"></head> <!-- 同时 HTML 内部也指定，双重保险 -->
        <body>
          <h1>爬虫触发界面</h1>
          <p>状态: ${isRunning ? '运行中' : '空闲'}</p>
          <p>上次运行时间: ${lastRunTime ? lastRunTime.toLocaleString() : '从未运行'}</p>
          <form action="/trigger" method="POST">
            <button type="submit">触发爬虫执行</button>
          </form>
          <p><a href="/status">查看状态</a> | <a href="/health">健康检查</a></p>
        </body>
      </html>
    `);
    return;
  }

  // 状态端点
  if (path === '/status' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      crawler_running: isRunning,
      last_run_time: lastRunTime ? lastRunTime.toISOString() : null,
      last_run_result: lastRunResult ? {
        success: lastRunResult.success,
        exitCode: lastRunResult.exitCode,
        timestamp: lastRunResult.timestamp,
        duration: lastRunResult.duration
      } : null
    }));
    return;
  }

  // 触发爬虫端点
  if (path === '/trigger' && method === 'POST') {
    try {
      const result = await executeCrawler();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        message: '爬虫任务已触发',
        result: {
          success: result.success,
          exitCode: result.exitCode,
          timestamp: result.timestamp,
          duration: result.duration
        }
      }));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  // 手动触发端点（GET，用于测试）
  if (path === '/trigger' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
      <html>
        <head><title>触发爬虫</title></head>
        <body>
          <h1>爬虫触发界面</h1>
          <p>状态: ${isRunning ? '运行中' : '空闲'}</p>
          <p>上次运行时间: ${lastRunTime ? lastRunTime.toLocaleString() : '从未运行'}</p>
          <form action="/trigger" method="POST">
            <button type="submit">触发爬虫执行</button>
          </form>
          <p><a href="/status">查看状态</a> | <a href="/health">健康检查</a></p>
        </body>
      </html>
    `);
    return;
  }

  // 404 处理
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: '端点未找到' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`触发服务器运行在 http://0.0.0.0:${PORT}`);
  console.log(`可用端点:`);
  console.log(`  GET  /health    - 健康检查`);
  console.log(`  GET  /status    - 爬虫状态`);
  console.log(`  GET  /trigger   - 触发界面（测试用）`);
  console.log(`  POST /trigger   - 触发爬虫执行`);
  if (API_KEY) {
    console.log(`⚠️  API Key 验证已启用，请使用 Authorization: Bearer ${API_KEY} 头`);
  }
});

// 处理进程退出
process.on('SIGINT', () => {
  console.log('收到 SIGINT 信号，关闭服务器...');
  server.close(() => {
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  console.log('收到 SIGTERM 信号，关闭服务器...');
  server.close(() => {
    process.exit(0);
  });
});