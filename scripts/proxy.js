#!/usr/bin/env node
const http = require('http');
const httpProxy = require('http-proxy');
const { URL } = require('url');

const PROXY_PORT = process.env.PROXY_PORT || 3000;      // 公网入口
const API_TARGET = process.env.API_TARGET || 'http://localhost:3001';
const VNC_TARGET = process.env.VNC_TARGET || 'http://localhost:6080';

// 创建代理实例
const proxy = httpProxy.createProxyServer({
  ws: true,  // 支持 WebSocket
  xfwd: true // 传递原始 IP
});

// 错误处理
proxy.on('error', (err, req, res) => {
  console.error('[Proxy error]', err);
  if (res.writeHead) {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Bad Gateway');
  }
});

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const path = parsedUrl.pathname;

  // 判断是否为 API 请求
  if (path.startsWith('/trigger') || path.startsWith('/status') || path.startsWith('/health')) {
    console.log(`[Proxy] API request: ${path}`);
    proxy.web(req, res, { target: API_TARGET });
  } else {
    // 其余请求（包括 /vnc.html, /websockify 等）转发给 noVNC
    console.log(`[Proxy] VNC request: ${path}`);
    proxy.web(req, res, { target: VNC_TARGET });
  }
});

// 处理 WebSocket 升级
server.on('upgrade', (req, socket, head) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const path = parsedUrl.pathname;
  console.log(`[Proxy] WebSocket upgrade: ${path}`);
  // WebSocket 都转发给 noVNC（因为 noVNC 负责 WebSocket <-> VNC）
  proxy.ws(req, socket, head, { target: VNC_TARGET });
});

server.listen(PROXY_PORT, '0.0.0.0', () => {
  console.log(`反向代理运行在端口 ${PROXY_PORT}`);
  console.log(`  API 后端: ${API_TARGET}`);
  console.log(`  VNC 后端: ${VNC_TARGET}`);
});

// 优雅退出
process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));