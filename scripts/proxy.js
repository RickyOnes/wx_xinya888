#!/usr/bin/env node
const http = require('http');
const https = require('https');
const httpProxy = require('http-proxy');
const net = require('net');
const { URL } = require('url');

const PROXY_PORT = process.env.PROXY_PORT || 3000;
const API_TARGET = process.env.API_TARGET || 'http://localhost:3001';
const VNC_TARGET = process.env.VNC_TARGET || 'http://localhost:6080';

// 强制认证参数（建议在 ClawCloud 环境变量中设置）
const PROXY_USER = process.env.PROXY_USER || '';
const PROXY_PASS = process.env.PROXY_PASS || '';
// 允许的目标主机白名单（逗号分隔），默认为 Google 相关域名
const PROXY_ALLOW_HOSTS = (process.env.PROXY_ALLOW_HOSTS || 'accounts.google.com,oauth2.googleapis.com,www.googleapis.com,googleusercontent.com,www.gstatic.com,fonts.googleapis.com')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

const proxy = httpProxy.createProxyServer({ ws: true, xfwd: true });

proxy.on('error', (err, req, res) => {
  try {
    console.error('[Proxy error]', err.message);
    if (res && res.writeHead) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Bad Gateway');
    }
  } catch (e) { /* ignore */ }
});

// 忽略这些高频 API 路径的日志
const silentApiPaths = ['/history', '/health', '/events'];
// 忽略这些 VNC 路径的日志
const silentVncPaths = ['/favicon.ico'];

function isIpv4Private(ip) {
  if (!ip) return false;
  if (!net.isIP(ip)) return false;
  // only handle IPv4 private ranges here
  if (net.isIP(ip) === 4) {
    return ip.startsWith('10.') || ip.startsWith('192.168.') || /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip) || ip === '127.0.0.1';
  }
  return false;
}

function isHostAllowed(hostname) {
  if (!hostname) return false;
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0') return false;
  if (net.isIP(host)) {
    if (isIpv4Private(host)) return false;
  }
  for (const allowed of PROXY_ALLOW_HOSTS) {
    if (host === allowed || host.endsWith('.' + allowed)) return true;
  }
  return false;
}

function checkProxyAuth(req) {
  if (!PROXY_USER || !PROXY_PASS) return true; // 未配置则允许
  const header = req.headers['proxy-authorization'] || req.headers['authorization'];
  if (!header) return false;
  const parts = header.split(' ');
  if (parts.length < 2) return false;
  if (parts[0].toLowerCase() !== 'basic') return false;
  let creds = '';
  try { creds = Buffer.from(parts[1], 'base64').toString(); } catch (e) { return false; }
  return creds === `${PROXY_USER}:${PROXY_PASS}`;
}

function removeProxyHeaders(headers) {
  if (!headers) return;
  delete headers['proxy-authorization'];
  delete headers['proxy-authenticate'];
  delete headers['proxy-connection'];
}

const server = http.createServer((req, res) => {
  const rawUrl = req.url || '/';

  // 检测是否为绝对 URL（客户端作为 HTTP 代理发出的请求）
  let isAbsolute = false;
  try {
    // new URL 会抛出异常如果不是绝对 URL
    new URL(rawUrl);
    isAbsolute = true;
  } catch (e) {
    isAbsolute = false;
  }

  if (isAbsolute) {
    // forward-proxy 模式（支持 HTTP，HTTPS 通过 CONNECT）
    if (!checkProxyAuth(req)) {
      res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="Proxy"' });
      res.end('Proxy Authentication Required');
      return;
    }
    let target;
    try { target = new URL(rawUrl); } catch (e) { res.writeHead(400); res.end('Bad Request'); return; }
    if (!isHostAllowed(target.hostname)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }
    removeProxyHeaders(req.headers);
    // 构建请求并转发
    const lib = target.protocol === 'https:' ? https : http;
    const opts = {
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search,
      method: req.method,
      headers: Object.assign({}, req.headers, { host: target.host })
    };
    const proxied = lib.request(opts, (proxiedRes) => {
      res.writeHead(proxiedRes.statusCode, proxiedRes.headers);
      proxiedRes.pipe(res, { end: true });
    });
    proxied.on('error', (err) => {
      console.error('[Proxy forward error]', err.message);
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Bad Gateway');
    });
    req.pipe(proxied, { end: true });
    return;
  }

  // 非代理模式：保持原有基于路径的反向代理行为
  const pathname = rawUrl.split('?')[0];
  if (pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`
      <!DOCTYPE html>
      <html>
        <head><title>服务导航</title></head>
        <body style="font-family: sans-serif; text-align: center; padding-top: 50px;">
          <h1>服务导航</h1>
          <p><a href="/vnc.html">🖥️ 访问 VNC 桌面</a></p>
          <p><a href="/trigger">🤖 访问爬虫控制台</a></p>
          <p style="margin-top:20px;color:#666;font-size:0.9rem;">代理: ${PROXY_USER ? '已启用认证' : '未启用认证'}</p>
        </body>
      </html>
    `);
    return;
  }

  const apiPaths = [
    '/trigger', '/status', '/health', '/history', '/logs', '/stop', '/upload', '/events',
    '/login', '/logout', '/check-auth'
  ];
  if (apiPaths.includes(pathname) || pathname.startsWith('/run/') || pathname.startsWith('/script/')) {
    if (!silentApiPaths.includes(pathname)) console.log(`[Proxy] API request: ${pathname}`);
    removeProxyHeaders(req.headers);
    proxy.web(req, res, { target: API_TARGET });
    return;
  }

  if (!silentVncPaths.includes(pathname)) console.log(`[Proxy] VNC request: ${pathname}`);
  removeProxyHeaders(req.headers);
  proxy.web(req, res, { target: VNC_TARGET });
});

// 处理 CONNECT（HTTPS 隧道）
server.on('connect', (req, clientSocket, head) => {
  if (!checkProxyAuth(req)) {
    clientSocket.write('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="Proxy"\r\n\r\n');
    clientSocket.end();
    return;
  }
  // req.url 是 host:port
  const hostPort = req.url || '';
  const idx = hostPort.lastIndexOf(':');
  let host = hostPort;
  let port = 443;
  if (idx !== -1) {
    host = hostPort.slice(0, idx);
    const p = parseInt(hostPort.slice(idx + 1), 10);
    if (!Number.isNaN(p)) port = p;
  }
  if (!isHostAllowed(host)) {
    clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    clientSocket.end();
    return;
  }
  const serverSocket = net.connect(port, host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) serverSocket.write(head);
    serverSocket.pipe(clientSocket);
    clientSocket.pipe(serverSocket);
  });
  serverSocket.on('error', (err) => {
    console.error(`[Proxy CONNECT error] ${host}:${port} -> ${err.message}`);
    try { clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch(e){}
  });
  clientSocket.on('error', () => serverSocket.end());
});

// WebSocket 升级（用于 noVNC）
server.on('upgrade', (req, socket, head) => {
  const pathname = req.url.split('?')[0];
  console.log(`[Proxy] WebSocket upgrade: ${pathname}`);
  removeProxyHeaders(req.headers);
  proxy.ws(req, socket, head, { target: VNC_TARGET });
});

server.listen(PROXY_PORT, '0.0.0.0', () => {
  console.log(`反向代理运行在端口 ${PROXY_PORT}`);
  console.log(`  API 后端: ${API_TARGET}`);
  console.log(`  VNC 后端: ${VNC_TARGET}`);
  if (PROXY_USER && PROXY_PASS) console.log(`  正向代理已启用，认证用户: ${PROXY_USER}`);
  else console.log(`  正向代理已启用，未配置认证（请尽快设置 PROXY_USER/PROXY_PASS）`);
});

process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));