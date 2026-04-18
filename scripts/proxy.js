#!/usr/bin/env node
const http = require('http');
const httpProxy = require('http-proxy');

const PROXY_PORT = process.env.PROXY_PORT || 3000;
const API_TARGET = process.env.API_TARGET || 'http://localhost:3001';
const VNC_TARGET = process.env.VNC_TARGET || 'http://localhost:6080';

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
        <body style="font-family: sans-serif; text-align: center; padding-top: 50px;">
          <h1>服务导航</h1>
          <p><a href="/vnc.html">🖥️ 访问 VNC 桌面</a></p>
          <p><a href="/trigger">🤖 访问爬虫控制台</a></p>
        </body>
      </html>
    `);
    return;
  }



  const apiPaths = [

    '/trigger', '/status', '/health', '/history', '/history/detail', '/logs', '/stop', '/upload', '/events',
    '/login', '/logout', '/check-auth'
  ];
  if (apiPaths.includes(pathname) || pathname.startsWith('/run/') || pathname.startsWith('/script/')) {
    if (!silentApiPaths.includes(pathname)) {
      console.log(`[Proxy] API request: ${pathname}`);
    }
    proxy.web(req, res, { target: API_TARGET });
    return;
  }

  if (!silentVncPaths.includes(pathname)) {
    console.log(`[Proxy] VNC request: ${pathname}`);
  }
  proxy.web(req, res, { target: VNC_TARGET });
});

server.on('upgrade', (req, socket, head) => {
  const pathname = req.url.split('?')[0];
  console.log(`[Proxy] WebSocket upgrade: ${pathname}`);
  proxy.ws(req, socket, head, { target: VNC_TARGET });
});

server.listen(PROXY_PORT, '0.0.0.0', () => {
  console.log(`反向代理运行在端口 ${PROXY_PORT}`);
  console.log(`  API 后端: ${API_TARGET}`);
  console.log(`  VNC 后端: ${VNC_TARGET}`);
});

process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));