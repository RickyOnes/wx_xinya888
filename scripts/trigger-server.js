#!/usr/bin/env node

const http = require('http');
const { spawn } = require('child_process');
const { URL } = require('url');
const fs = require('fs').promises;
const path = require('path');

const PORT = process.env.TRIGGER_PORT || 3001;
const API_KEY = process.env.API_KEY || '';
const SCRIPTS_DIR = '/app/scripts'; // 脚本目录

let isRunning = false;
let lastRunTime = null;
let lastRunResult = null;
let currentScript = null;

async function getAvailableScripts() {
  try {
    const files = await fs.readdir(SCRIPTS_DIR);
    return files.filter(file => 
      file.endsWith('.js') && 
      file !== 'trigger-server.js' &&
      file !== 'proxy.js'
    );
  } catch (err) {
    console.error('读取脚本目录失败:', err);
    return [];
  }
}

function executeScript(scriptName) {
  return new Promise((resolve) => {
    if (isRunning) {
      resolve({ success: false, message: '爬虫正在运行中，请稍后再试', script: scriptName });
      return;
    }

    isRunning = true;
    currentScript = scriptName;
    console.log("==========================================");
    console.log(`[${new Date().toISOString()}] 开始执行脚本: ${scriptName}`);
    const startTime = Math.floor(Date.now() / 1000);

    const scriptPath = path.join(SCRIPTS_DIR, scriptName); // 绝对路径

    const child = spawn('node', [scriptPath], {
      stdio: 'pipe',
      env: process.env,
      cwd: '/app'
    });

    let output = '';
    let errorOutput = '';

    child.stdout.on('data', (data) => {
      const str = data.toString();
      output += str;
      console.log(`[${scriptName} 输出] ${str.trim()}`);
    });

    child.stderr.on('data', (data) => {
      const str = data.toString();
      errorOutput += str;
      console.error(`[${scriptName} 错误] ${str.trim()}`);
    });

    child.on('close', (code) => {
      isRunning = false;
      currentScript = null;
      lastRunTime = new Date();
      const endTime = Math.floor(Date.now() / 1000);
      const duration = endTime - startTime;

      const result = {
        success: code === 0,
        exitCode: code,
        script: scriptName,
        timestamp: lastRunTime.toISOString(),
        duration: duration,
        output: output.slice(-5000),
        error: errorOutput.slice(-5000)
      };

      lastRunResult = result;
      console.log(`[${lastRunTime.toISOString()}] 脚本 ${scriptName} 执行完成，退出码: ${code}`);
      console.log(`总运行时长: ${duration} 秒`);
      console.log("==========================================");
      resolve(result);
    });

    child.on('error', (err) => {
      isRunning = false;
      currentScript = null;
      lastRunTime = new Date();
      const endTime = Math.floor(Date.now() / 1000);
      const duration = endTime - startTime;
      const result = {
        success: false,
        exitCode: -1,
        script: scriptName,
        timestamp: lastRunTime.toISOString(),
        duration: duration,
        output: output.slice(-5000),
        error: err.message
      };
      lastRunResult = result;
      console.error(`[${lastRunTime.toISOString()}] 脚本 ${scriptName} 执行错误: ${err.message}`);
      console.log("==========================================");
      resolve(result);
    });
  });
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const path = parsedUrl.pathname;
  const method = req.method;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (API_KEY && (path.startsWith('/run/') || path === '/trigger' && method === 'POST')) {
    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${API_KEY}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '未授权访问' }));
      return;
    }
  }

  if (path === '/health' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      service: 'crawler-trigger',
      port: PORT,
      crawler_running: isRunning,
      current_script: currentScript,
      last_run: lastRunTime ? lastRunTime.toISOString() : null
    }));
    return;
  }

  if (path === '/status' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      crawler_running: isRunning,
      current_script: currentScript,
      last_run_time: lastRunTime ? lastRunTime.toISOString() : null,
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

  if (path.startsWith('/run/') && method === 'POST') {
    const scriptName = path.substring(5);
    if (!scriptName || !scriptName.endsWith('.js')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '无效的脚本名' }));
      return;
    }

    const availableScripts = await getAvailableScripts();
    if (!availableScripts.includes(scriptName)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '脚本不存在' }));
      return;
    }

    const result = await executeScript(scriptName);
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

  if (path === '/trigger' && method === 'POST') {
    const result = await executeScript('update-pdd-cron.js');
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

  if (path === '/trigger' && method === 'GET') {
    const availableScripts = await getAvailableScripts();
    const buttonsHtml = availableScripts.map(script => 
      `<button class="script-btn" data-script="${script}" ${isRunning ? 'disabled' : ''}>运行 ${script}</button>`
    ).join('\n          ');

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            * { box-sizing: border-box; margin: 0; padding: 0; }
            body {
              font-family: 'Segoe UI', Roboto, system-ui, sans-serif;
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              min-height: 100vh;
              display: flex;
              align-items: center;
              justify-content: center;
              padding: 20px;
            }
            .card {
              background: rgba(255,255,255,0.95);
              backdrop-filter: blur(10px);
              border-radius: 20px;
              padding: 30px 40px;
              box-shadow: 0 20px 40px rgba(0,0,0,0.3);
              width: 100%;
              max-width: 700px;
            }
            h1 {
              font-size: 2rem;
              color: #333;
              margin-bottom: 10px;
              border-left: 6px solid #667eea;
              padding-left: 20px;
            }
            .status-bar {
              background: #f0f4f8;
              border-radius: 40px;
              padding: 15px 25px;
              margin: 20px 0;
              display: flex;
              align-items: center;
              gap: 15px;
              flex-wrap: wrap;
            }
            .status-indicator {
              display: inline-block;
              width: 16px;
              height: 16px;
              border-radius: 50%;
              background: ${isRunning ? '#fbbf24' : '#10b981'};
              box-shadow: 0 0 0 3px ${isRunning ? '#fef3c7' : '#d1fae5'};
              animation: ${isRunning ? 'pulse 1.5s infinite' : 'none'};
            }
            @keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.5; } }
            .status-text {
              font-size: 1.1rem;
              font-weight: 500;
              color: #1e293b;
            }
            .last-run {
              margin-left: auto;
              color: #64748b;
              font-size: 0.95rem;
            }
            .button-grid {
              display: grid;
              grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
              gap: 15px;
              margin: 30px 0 20px;
            }
            .script-btn {
              background: white;
              border: 2px solid #e2e8f0;
              border-radius: 60px;
              padding: 14px 20px;
              font-size: 1rem;
              font-weight: 600;
              color: #1e293b;
              cursor: pointer;
              transition: all 0.2s;
              box-shadow: 0 4px 6px -2px rgba(0,0,0,0.05);
            }
            .script-btn:hover:not(:disabled) {
              border-color: #667eea;
              background: #f5f3ff;
              transform: translateY(-2px);
              box-shadow: 0 10px 15px -3px rgba(102,126,234,0.3);
            }
            .script-btn:disabled {
              opacity: 0.5;
              cursor: not-allowed;
              background: #e2e8f0;
            }
            .modal {
              display: none;
              position: fixed;
              top: 0; left: 0; width: 100%; height: 100%;
              background: rgba(0,0,0,0.5);
              align-items: center;
              justify-content: center;
              z-index: 1000;
            }
            .modal.active { display: flex; }
            .modal-content {
              background: white;
              border-radius: 20px;
              max-width: 600px;
              width: 90%;
              max-height: 80vh;
              overflow-y: auto;
              padding: 30px;
              box-shadow: 0 25px 50px -12px black;
              position: relative;
            }
            .modal-close {
              position: absolute;
              top: 20px; right: 20px;
              background: none;
              border: none;
              font-size: 1.8rem;
              cursor: pointer;
              color: #94a3b8;
            }
            .modal-close:hover { color: #475569; }
            .modal-title {
              font-size: 1.5rem;
              margin-bottom: 20px;
              color: #1e293b;
              border-bottom: 2px solid #e2e8f0;
              padding-bottom: 10px;
            }
            .result-pre {
              background: #1e293b;
              color: #e2e8f0;
              padding: 15px;
              border-radius: 12px;
              overflow-x: auto;
              font-family: 'JetBrains Mono', monospace;
              font-size: 0.9rem;
            }
            .loading {
              display: inline-block;
              width: 20px;
              height: 20px;
              border: 3px solid #e2e8f0;
              border-top-color: #667eea;
              border-radius: 50%;
              animation: spin 1s linear infinite;
              margin-right: 8px;
            }
            @keyframes spin { to { transform: rotate(360deg); } }
            .footer-links {
              text-align: center;
              margin-top: 20px;
              color: #94a3b8;
            }
            .api-link {
              color: #667eea;
              cursor: pointer;
              text-decoration: underline;
              margin: 0 8px;
            }
            .api-link:hover { opacity: 0.8; }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>🐞 爬虫控制台</h1>

            <div class="status-bar">
              <span class="status-indicator"></span>
              <span class="status-text" id="globalStatus">${isRunning ? '运行中' : '空闲'}</span>
              <span class="last-run" id="lastRunInfo">
                上次: ${lastRunTime ? new Date(lastRunTime).toLocaleString() : '无'} 
                ${lastRunResult ? `(脚本: ${lastRunResult.script})` : ''}
              </span>
            </div>

            <div class="button-grid" id="buttonGrid">
              ${buttonsHtml}
            </div>

            <div class="footer-links">
              <span class="api-link" data-url="/status">📊 查看状态</span> | 
              <span class="api-link" data-url="/health">💓 健康检查</span>
            </div>
          </div>

          <div class="modal" id="resultModal">
            <div class="modal-content">
              <button class="modal-close" id="modalClose">&times;</button>
              <div class="modal-title" id="modalTitle">执行结果</div>
              <pre class="result-pre" id="modalResult">等待返回…</pre>
            </div>
          </div>

          <script>
            const modal = document.getElementById('resultModal');
            const modalTitle = document.getElementById('modalTitle');
            const modalResult = document.getElementById('modalResult');
            const globalStatus = document.getElementById('globalStatus');
            const lastRunInfo = document.getElementById('lastRunInfo');
            const buttonGrid = document.getElementById('buttonGrid');
            let isRunning = ${isRunning};

            function updateUI() {
              fetch('/status')
                .then(r => r.json())
                .then(data => {
                  isRunning = data.crawler_running;
                  globalStatus.innerText = isRunning ? '运行中' : '空闲';
                  const last = data.last_run_result;
                  if (last) {
                    lastRunInfo.innerText = \`上次: \${new Date(last.timestamp).toLocaleString()} (脚本: \${last.script})\`;
                  }
                  document.querySelectorAll('.script-btn').forEach(btn => {
                    btn.disabled = isRunning;
                  });
                })
                .catch(() => {});
            }

            function showModal(title, content) {
              modalTitle.innerText = title;
              modalResult.innerText = content;
              modal.classList.add('active');
            }

            async function runScript(scriptName, btn) {
              if (isRunning) {
                showModal('无法执行', '已有脚本正在运行，请稍后重试。');
                return;
              }

              const originalText = btn.innerText;
              btn.innerText = '⏳ 执行中…';
              btn.disabled = true;

              try {
                const response = await fetch('/run/' + scriptName, { method: 'POST' });
                const data = await response.json();
                showModal(\`执行结果 - \${scriptName}\`, JSON.stringify(data, null, 2));
                updateUI();
              } catch (err) {
                showModal('请求失败', err.message);
              } finally {
                btn.innerText = originalText;
                btn.disabled = isRunning;
              }
            }

            document.querySelectorAll('.script-btn').forEach(btn => {
              btn.addEventListener('click', (e) => {
                const script = e.target.dataset.script;
                runScript(script, e.target);
              });
            });

            document.querySelectorAll('.api-link').forEach(span => {
              span.addEventListener('click', async (e) => {
                const url = e.target.dataset.url;
                try {
                  const response = await fetch(url);
                  const data = await response.json();
                  showModal(\`API: \${url}\`, JSON.stringify(data, null, 2));
                } catch (err) {
                  showModal('请求失败', err.message);
                }
              });
            });

            document.getElementById('modalClose').addEventListener('click', () => {
              modal.classList.remove('active');
            });
            modal.addEventListener('click', (e) => {
              if (e.target === modal) modal.classList.remove('active');
            });

            setInterval(updateUI, 5000);
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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`触发服务器运行在 http://0.0.0.0:${PORT}`);
  console.log(`可用端点:`);
  console.log(`  GET  /health      - 健康检查`);
  console.log(`  GET  /status      - 爬虫状态`);
  console.log(`  GET  /trigger     - 多脚本触发界面`);
  console.log(`  POST /trigger     - 触发默认脚本 (update-pdd-cron.js)`);
  console.log(`  POST /run/脚本名   - 触发指定脚本`);
  if (API_KEY) {
    console.log(`⚠️  API Key 验证已启用，请使用 Authorization: Bearer ${API_KEY} 头`);
  }
});

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