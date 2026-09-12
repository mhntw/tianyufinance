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
//   同时负责【资源版本号自动注入】（见下），因此发布版永不会因"忘了 bump"而陈旧。
//
// 你平时只改 rj/ 源目录（index.html、css/、js/），dist/ 无需手动维护。
// ============================================================
//
// ── 资源版本号自动注入（根治手工 bump）──────────────────────────
// 问题背景：此前 index.html 与各级 ESM import 里的 `?v=` 全靠人工维护，且引用链有三层
//   （index.html → main.js → 各页面 → components/），改了被引用文件必须把所有引用者的
//   版本号一起改。漏改任一环，webview 就命中磁盘缓存的旧文件，而且【故障是静默的】——
//   改动看起来"没生效"，不报任何错。
//
// 现在的规则：
//   · 源文件的 `?v=` 一律是占位符（`?v=dev`），不代表任何含义，**不需要也不会再手工 bump**；
//   · 每次打包时由本脚本把所有 `?v=` 统一改写为本次构建的【内容指纹】。
//
// 指纹算法：dist/ 内全部待发布文件按相对路径排序后，逐个把「路径 + 原始字节」喂进 sha1，
//   取前 12 位。要点：
//     · 内容不变 → 指纹不变：同一份源重复构建产物一致，可复现、可校验；
//     · 任一文件变 → 全量 URL 变化（含 main.js 等中间层，因为它们的 import 文本也随之改写）。
//   为什么用「单一全局指纹」而不是逐文件哈希：
//     dist/ 是本地磁盘资源，没有重复"下载"成本；单一指纹免去了「被引用者先算、引用者后算」
//     的拓扑排序，也就彻底不存在"改了子模块忘改引用者"的漏洞。
// ============================================================

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

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

/** 列出 dir 下全部文件，按「相对路径（统一用 /）」排序 —— 保证指纹稳定可复现 */
function listFilesSorted(dir) {
  const out = [];
  (function walk(d) {
    for (const name of fs.readdirSync(d)) {
      if (shouldExclude(name)) continue;
      const p = path.join(d, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else out.push(p);
    }
  })(dir);
  return out
    .map(p => path.relative(dir, p).split(path.sep).join('/'))
    .sort();
}

/** 内容指纹：路径 + 原始字节（Buffer，不做编码转换，二进制文件也安全） */
function computeFingerprint() {
  const h = crypto.createHash('sha1');
  for (const rel of listFilesSorted(DIST_DIR)) {
    h.update(rel);
    h.update(Buffer.from([0]));                        // 分隔符，避免「路径与内容的拼接歧义」
    h.update(fs.readFileSync(path.join(DIST_DIR, rel)));
  }
  return h.digest('hex').slice(0, 12);
}

// 只改写「资源引用」形态的 ?v=：值以 " ' 空白 ) 之一结束（覆盖 href/src 属性与 import 说明符，
// 也覆盖 CSS 里 url(...?v=x) 的写法）。已核实 js/ 内 ?v= 只出现在 import 语句中，无误伤。
const V_ANY = /(\?v=)[^"'\s)]+/g;
const STAMPABLE = /\.(html|js|css)$/;

/** 把 dist 内所有资源引用的 ?v= 统一改写为指纹；返回被改写的文件数 */
function stampAssetVersions(version) {
  let n = 0;
  for (const rel of listFilesSorted(DIST_DIR)) {
    if (!STAMPABLE.test(rel)) continue;
    const p = path.join(DIST_DIR, rel);
    const src = fs.readFileSync(p, 'utf8');
    const out = src.replace(V_ANY, `$1${version}`);
    if (out !== src) { fs.writeFileSync(p, out); n++; }
  }
  return n;
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

  // 2. 资源版本号注入：先按「拷贝后的原始内容」算指纹，再统一改写所有 ?v=
  //    （顺序不可颠倒：指纹取自未改写内容，故同一份源无论构建多少次都得到同一指纹）
  const fingerprint = computeFingerprint();
  const stamped = stampAssetVersions(fingerprint);

  console.log(`[build-dist] 完成：${total} 个文件已同步到 ${DIST_DIR}`);
  console.log(`[build-dist] 资源版本号已注入为 ${fingerprint}（改写 ${stamped} 个文件，无需手工 bump）`);
}

main();

