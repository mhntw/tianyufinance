#!/usr/bin/env node
// ============================================================
// build-dist.mjs —— 打包前把最新运行时前端同步到干净的 dist/ 打包源（跨平台版）
//
// 兼容：Windows / macOS / Linux（Tauri 的 beforeBuildCommand 在 Windows 上用
//   cmd 执行，原生无 `sh`，所以这里用 Node.js 实现，摆脱 POSIX shell 依赖）。
//
// 目的：
//   Tauri 的 frontendDist 必须指向一个"只含 web 资源"的目录（否则会把
//   src-tauri/target、node_modules 等当成前端资源而拒绝打包）。
//   本脚本在每次 `tauri build` 前，把 rj/ 里的运行时文件同步进 dist/，
//   排除开发/备份/IDE 残留 / .DS_Store 等，保证打包永远是最新的纯净源。
//
// 你平时只改 rj/ 源目录（index.html、css/、js/），dist/ 无需手动维护。
// ============================================================

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TAURI_DIR = path.resolve(__dirname, '..');       // tauri/
const RJ_ROOT = path.resolve(TAURI_DIR, '..');          // 前端源根（rj/）
const DIST_DIR = path.join(TAURI_DIR, 'dist');

// 打包时应排除的目录名 / 文件名（IDE 残留、系统垃圾、备份等）
const EXCLUDE_NAMES = new Set([
  '.DS_Store',
  '.codebuddy',
  '.workbuddy',
  '.git',
  '__pycache__',
  'node_modules',
]);

// 要同步的根级条目（相对 RJ_ROOT）。后端库已在底下被确认是可移植的。
const ENTRY_POINTS = ['index.html', 'css', 'js'];

function shouldExclude(name) {
  return EXCLUDE_NAMES.has(name);
}

/** 递归拷贝 src -> dest，跳过需要排除的条目；返回拷贝文件数 */
function copyRecursive(src, dest) {
  let count = 0;
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      if (shouldExclude(name)) continue;
      count += copyRecursive(path.join(src, name), path.join(dest, name));
    }
    return count;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return count + 1;
}

function main() {
  // 1. 重建干净的 dist（删除旧内容，避免残留文件进包）
  fs.rmSync(DIST_DIR, { recursive: true, force: true });
  fs.mkdirSync(DIST_DIR, { recursive: true });

  let total = 0;
  for (const rel of ENTRY_POINTS) {
    const src = path.join(RJ_ROOT, rel);
    if (!fs.existsSync(src)) {
      console.warn(`[build-dist] 跳过缺失源: ${rel}`);
      continue;
    }
    total += copyRecursive(src, path.join(DIST_DIR, rel));
  }

  console.log(`[build-dist] 完成：${total} 个文件已同步到 ${DIST_DIR}`);
}

main();
