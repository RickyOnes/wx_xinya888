#!/usr/bin/env node
const http = require('http');
const net = require('net');
const httpProxy = require('http-proxy');

const PROXY_PORT = process.env.PROXY_PORT || 3000;
const API_TARGET = process.env.API_TARGET || 'http://localhost:3001';
const VNC_TARGET = process.env.VNC_TARGET || 'http://localhost:6080';
const VNC_HOST = process.env.VNC_HOST || 'localhost';
const VNC_PORT = parseInt(process.env.VNC_PORT || '5900', 10);

const proxy = httpProxy.createProxyServer({ ws: true, xfwd: true });

proxy.on('error', (err, req, res) => {
  console.error('[Proxy error]', err.message);
  if (res.writeHead) {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Bad Gateway');
  }
});

const silentApiPaths = ['/history', '/health', '/events'];
const silentVncPaths = ['/favicon.ico'];

const server = http.createServer((req, res) => {
  const url = req.url || '/';
  const pathname = url.split('?')[0];

  if (pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`
      <!DOCTYPE html>
      <html>
        <head><title>服务导航</title></head>
        <body style="font-family: sans-serif; text-align: center; padding: 30px 20px;">
          <h1>服务导航</h1>
          <p><a href="/vnc.html">🖥️ 访问 VNC 桌面（noVNC）</a></p>
          <p><a href="/trigger">🤖 访问爬虫控制台</a></p>
          <hr>
          <div style="max-width:680px;margin:30px auto;text-align:left;background:#f8fafc;padding:20px 25px;border-radius:12px;border:1px solid #cbd5e1;font-size:0.95rem;">
            <p style="margin-top:0;font-weight:bold;">💡 若 noVNC 缓慢，可尝试使用原生 VNC 客户端（需要平台支持 HTTP CONNECT）</p>
            <p style="color:#b91c1c;font-size:0.9rem;">⚠️ 注意：直接访问 https://你的域名 即可，<b>请勿在浏览器地址栏添加端口号（如 :3000）</b>，否则无法连接。</p>
            <ol style="padding-left:1.2em;line-height:1.8;">
              <li><b>确认平台支持 HTTP CONNECT 方法</b><br>
                大多数反向代理（Nginx、Traefik）默认允许，但 Serverless/CloudRun 平台通常不支持。<br>
                若连接失败请使用 noVNC，或优化 noVNC 速度（降低分辨率、色深）。
              </li>
              <li><b>配置 VNC 客户端</b>（以 TigerVNC Viewer 为例）：
                <ul style="list-style-type:disc;padding-left:1.2em;">
                  <li>打开连接设置 → “代理”选项卡</li>
                  <li>代理类型：<code>HTTP</code></li>
                  <li>代理主机：<code>你的平台域名</code></li>
                  <li>代理端口：<code>443</code>（平台已默认使用 HTTPS 端口，勿填其他端口）</li>
                  <li>VNC 服务器地址：<code>localhost</code></li>
                  <li>端口：<code>5900</code></li>
                </ul>
              </li>
              <li><b>输入密码</b>：容器环境变量 <code>VNC_PASSWORD</code> 设置的值</li>
              <li>点击连接；若超时或失败，说明平台网关不支持 CONNECT 隧道，请改用 noVNC。</li>
            </ol>
            <p style="margin-bottom:0;font-size:0.9rem;">🔧 提升 noVNC 流畅度：可降低桌面色彩与分辨率，或通过 <code>proxy.js</code> 启用压缩传输。</p>
          </div>
        </body>
      </html>
    `);
    return;
  }


  const apiPaths = [
    '/trigger', '/status', '/health', '/history', '/history/detail',
    '/login', '/logout', '/check-auth', '/upload', '/events'
  ];
  if (apiPaths.includes(pathname) || pathname.startsWith('/run/') || pathname.startsWith('/script/') || pathname.startsWith('/file/')) {

    if (!silentApiPaths.includes(pathname)) {
      console.log(`[Proxy] API request: ${pathname}`);
    }
    proxy.web(req, res, { target: API_TARGET });
    return;
  }

  // 其他请求转发给 noVNC（Web 界面及 WebSocket）
  if (!silentVncPaths.includes(pathname)) {
    console.log(`[Proxy] VNC request: ${pathname}`);
  }
  proxy.web(req, res, { target: VNC_TARGET });
});

// 处理 WebSocket（noVNC 使用）
server.on('upgrade', (req, socket, head) => {
  const pathname = req.url.split('?')[0];
  console.log(`[Proxy] WebSocket upgrade: ${pathname}`);
  proxy.ws(req, socket, head, { target: VNC_TARGET });
});

// 处理 HTTP CONNECT（供原生 VNC 客户端使用）
server.on('connect', (req, clientSocket, head) => {
  const [host, portStr] = req.url.split(':');
  const port = parseInt(portStr || '5900', 10);

  // 安全限制：仅允许连接到内部的 VNC 服务
  if (
    (host !== 'localhost' && host !== '127.0.0.1' && host !== '0.0.0.0') ||
    port !== VNC_PORT
  ) {
    console.warn(`[Proxy] 拒绝 CONNECT 到 ${host}:${port}`);
    clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    clientSocket.destroy();
    return;
  }

  console.log(`[Proxy] CONNECT 隧道: VNC ${host}:${port}`);
  const targetSocket = net.connect(VNC_PORT, VNC_HOST, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    targetSocket.write(head);
    targetSocket.pipe(clientSocket);
    clientSocket.pipe(targetSocket);
  });

  targetSocket.on('error', (err) => {
    console.error(`[Proxy] VNC 连接失败: ${err.message}`);
    clientSocket.end();
  });
  clientSocket.on('error', (err) => {
    console.error(`[Proxy] 客户端连接错误: ${err.message}`);
    targetSocket.end();
  });
  clientSocket.on('close', () => targetSocket.end());
  targetSocket.on('close', () => clientSocket.end());
});

server.listen(PROXY_PORT, '0.0.0.0', () => {
  console.log(`反向代理运行在端口 ${PROXY_PORT}`);
  console.log(`  API 后端: ${API_TARGET}`);
  console.log(`  VNC 后端: ${VNC_TARGET}`);
  console.log(`  VNC 直连隧道已启用（${VNC_HOST}:${VNC_PORT}）`);
});

process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));