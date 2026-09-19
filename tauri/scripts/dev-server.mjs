#!/usr/bin/env node
/* ============================================================
 * tauri/scripts/dev-server.mjs —— 开发用静态服务器（强制禁用缓存）
 *
 * 【为什么需要它】
 *   原先 beforeDevCommand 是 `python3 -m http.server 1420`。它不发 Cache-Control，
 *   而 index.html 里的资源都带 `?v=dev` —— 那是【占位符】，只在打包时被
 *   build-dist.mjs 替换成「内容指纹」（见其头部注释）。
 *   于是开发模式下 URL 永远不变 → WKWebView/WebView2 直接命中磁盘缓存 →
 *   改了 css/js 却看不到变化，**且故障是静默的**（不报错、控制台也干净）。
 *   项目里为此已浪费过排查时间（build-dist.mjs 头部的「根治手工 bump」一节就是记录此事）。
 *
 * 【本脚本做什么】
 *   对所有响应加 `Cache-Control: no-store`，并显式关闭条件请求缓存 ——
 *   开发时任何改动立即可见，不必再手动清 WebView 缓存或改 `?v=`。
 *
 * 【不影响打包】
 *   打包走的是 beforeBuildCommand → build-dist.mjs（注入内容指纹），与本脚本无关。
 *
 * 用法：node scripts/dev-server.mjs      （由 tauri dev 通过 beforeDevCommand 调用）
 * ============================================================ */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');   // 项目根（tauri/ 的上一级）
const PORT = 1420;
const HOST = '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(String(req.url || '/').split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';

  const file = path.normalize(path.join(ROOT, rel));

  // 防目录穿越：解析后的路径必须仍在 ROOT 之内
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found: ' + rel);
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      // ★ 核心：开发时一律不缓存 —— 改了就能看到，不必清 WebView 缓存
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0',
    });
    fs.createReadStream(file).pipe(res);
  });
});

server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.error('[dev-server] 端口 ' + PORT + ' 已被占用 —— 可能已有一个 dev 实例在跑，请先关掉它。');
  } else {
    console.error('[dev-server] 启动失败：' + (e && e.message || e));
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log('[dev-server] http://' + HOST + ':' + PORT + '  （已禁用缓存，改动即时生效）');
  console.log('[dev-server] 服务根目录：' + ROOT);
});
