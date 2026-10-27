#!/usr/bin/env node
'use strict';
/* ============================================================
 * tools/verify_book_integrity.js —— 账套 .json **结构完整性**校验（只读）
 *
 * 【为什么需要】账套文件是本软件的唯一真相源。历史上的丢失都不是"写错数字"，
 *   而是"字段没了"且**没有任何报错**：JSON.stringify 静默丢弃 undefined 键、
 *   顶层类型被写坏（该是数组却是 null/对象）导致页面崩或整块数据消失。
 *   写入侧的防护见 js/store.js 的 _bookSaveProblems / _fillMissingBookDefaults（写前体检）
 *   与 _markBookWriteBlocked（损坏文件暂停写盘）；本脚本是**外部独立校验**，
 *   不复用前端代码，用于发版前/排障时确认磁盘上的账套确实完整。
 *
 * 【判据分级】只有"会让数据错/让页面崩"的才判失败，避免对正常老账套误报：
 *   失败：JSON 无法解析；subjects/vouchers 不是数组；凭证缺 entries；凭证借贷不平；
 *         v6 账套里出现非整数金额（定点格式被破坏 → 显示错 10000 倍）；期初余额行结构坏。
 *   提示：缺非核心顶层字段（加载时由 emptyState 补默认，无信息损失）；
 *         非 v6 版本（加载时会自动迁移）；固定资产卡片缺 id（可能影响折旧定位）。
 *
 * 用法：
 *   node tools/verify_book_integrity.js               # 校验真实数据目录下的全部账套
 *   node tools/verify_book_integrity.js --dir=<目录>  # 指定账套目录
 *   node tools/verify_book_integrity.js <文件.json>    # 只校验单个文件（如刚导出的账套）
 *
 * 退出码：0 = 全部通过 / 无账套可查（跳过）；1 = 存在失败项
 * ============================================================ */

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');

/* 账套目录解析：与 verify_books_audit.js 同口径（真实应用数据目录优先于项目内 data/books） */
function detectAppDataBooks() {
  const home = os.homedir();
  const cands = [];
  if (process.platform === 'darwin') {
    cands.push(path.join(home, 'Library', 'Application Support', '添钰财务', 'books'));
  } else if (process.platform === 'win32') {
    const appdata = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    cands.push(path.join(appdata, '添钰财务', 'books'));
  } else {
    const xdg = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
    cands.push(path.join(xdg, '添钰财务', 'books'));
  }
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (e) {} }
  return null;
}

const ARGV = process.argv.slice(2);
const FILE_ARG = ARGV.find(a => !a.startsWith('--') && /\.json$/i.test(a));
const DIR_ARG = (ARGV.find(a => a.indexOf('--dir=') === 0) || '').slice(6);
const BOOKS_DIR = DIR_ARG ? path.resolve(DIR_ARG)
  : (detectAppDataBooks() || path.join(ROOT, 'data', 'books'));

/* 账套 schema（版本 + 顶层键集合）取自 js/store.js 的**单一来源**导出（exported.bookSchema）。
   刻意不用正则从源码抓键名：缩进/结构一变就会静默失效，校验随之变成"假绿"。
   取不到就判失败（不打印"跳过"），因为这属于工具与数据层不同步，必须暴露。 */
function loadBookSchema() {
  try {
    if (typeof global.window === 'undefined') global.window = global;
    global.__TAURI__ = global.__TAURI__ || {};
    if (!global.localStorage) {
      const mem = {};
      global.localStorage = {
        getItem: k => (k in mem ? mem[k] : null),
        setItem: (k, v) => { mem[k] = String(v); },
        removeItem: k => { delete mem[k]; },
      };
    }
    if (!global.document) global.document = { getElementById: () => null, querySelectorAll: () => [] };
    const mod = require(path.join(ROOT, 'js', 'store.js'));
    const bs = mod && mod.bookSchema;
    return (bs && Array.isArray(bs.keys) && bs.keys.length && bs.version) ? bs : null;
  } catch (e) {
    return null;
  }
}

const SCHEMA = loadBookSchema();
if (!SCHEMA) {
  console.log('✗ 无法从 js/store.js 取得 bookSchema（导出缺失或加载失败）—— 校验工具与数据层不同步');
  process.exit(1);
}
const V6 = SCHEMA.version;

/* 缺了会直接影响"账能不能用"的核心集合（其余缺失可由 emptyState 补默认，无信息损失） */
const CORE_FIELDS = ['subjects', 'vouchers'];
/* 固定资产卡片的金额字段（v6 内部为整数，单位 0.0001 元） */
const FA_AMT = ['original', 'accumDeprBegin', 'accumDepr', 'salvage', 'impairment',
  'netValueBegin', 'netValueEnd', 'yearDepr'];

const isInt = v => typeof v === 'number' && isFinite(v) && Math.floor(v) === v;

function checkOne(file) {
  const problems = [];   // 判失败
  const notices = [];    // 只提示

  let txt;
  try { txt = fs.readFileSync(file, 'utf8'); } catch (e) { return { problems: ['读取失败：' + (e && e.message || e)], notices }; }
  let d;
  try { d = JSON.parse(txt); } catch (e) { return { problems: ['JSON 解析失败（文件损坏）：' + (e && e.message || e)], notices }; }
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { problems: ['根节点不是对象'], notices };

  // 1) 顶层字段齐全（核心缺失判失败，其余只提示 —— 它们会被 emptyState 补默认）
  const missing = SCHEMA.keys.filter(k => !(k in d));
  const missingCore = missing.filter(k => CORE_FIELDS.includes(k));
  const missingRest = missing.filter(k => !CORE_FIELDS.includes(k));
  if (missingCore.length) problems.push('缺核心字段：' + missingCore.join(', '));
  if (missingRest.length) notices.push('缺字段（加载时补默认）：' + missingRest.join(', '));

  // 2) 类型：期望形状直接取自 store 的 schema 派生（与写前体检同一来源，避免规则漂移）
  (SCHEMA.arrayKeys || []).forEach(k => {
    if (d[k] !== undefined && !Array.isArray(d[k])) {
      problems.push(k + ' 应为数组，实际是 ' + (d[k] === null ? 'null' : typeof d[k]));
    }
  });
  (SCHEMA.objectKeys || []).forEach(k => {
    if (d[k] !== undefined && (d[k] === null || typeof d[k] !== 'object' || Array.isArray(d[k]))) problems.push(k + ' 应为对象');
  });

  // 3) 版本（当前版本号取自 store.js 的单一来源）
  const isV6 = d.schemaVersion === V6;
  if (d.schemaVersion === undefined) notices.push('无 schemaVersion（旧格式，加载时迁移到 v' + V6 + '）');
  else if (!isV6) notices.push('schemaVersion=' + d.schemaVersion + '（非当前 v' + V6 + '，加载时迁移）');

  // 4) 固定资产卡片
  if (Array.isArray(d.fixedAssets)) {
    let noId = 0, badAmt = 0;
    d.fixedAssets.forEach((fa, i) => {
      if (!fa || typeof fa !== 'object' || Array.isArray(fa)) { problems.push('fixedAssets[' + i + '] 不是对象'); return; }
      if (!fa.id) noId++;
      if (isV6) FA_AMT.forEach(k => { if (fa[k] !== undefined && !isInt(fa[k])) badAmt++; });
    });
    if (noId) notices.push('固定资产卡片缺 id：' + noId + ' 张（折旧/清理定位可能失效）');
    if (badAmt) problems.push('固定资产卡片金额不是整数：' + badAmt + ' 处（定点格式被破坏，显示会错 10000 倍）');
  }

  // 5) 凭证：entries 结构 + 借贷平衡（v6 整数精确比较；旧格式浮点按 1e-6 容差）
  if (Array.isArray(d.vouchers)) {
    let badEntries = 0, unbalanced = 0;
    const tol = isV6 ? 0 : 1e-6;
    d.vouchers.forEach((v, i) => {
      if (!v || typeof v !== 'object' || Array.isArray(v)) { problems.push('vouchers[' + i + '] 不是对象'); return; }
      if (!Array.isArray(v.entries)) { badEntries++; return; }
      let dr = 0, cr = 0;
      v.entries.forEach(e => { dr += Number((e && e.dr) || 0); cr += Number((e && e.cr) || 0); });
      if (Math.abs(dr - cr) > tol) unbalanced++;
    });
    if (badEntries) problems.push('凭证 entries 不是数组：' + badEntries + ' 张');
    if (unbalanced) problems.push('借贷不平衡的凭证：' + unbalanced + ' 张（数据已损坏或曾被外部改写）');
  }

  // 6) 期初余额
  const ob = d.openingBalances;
  if (ob && typeof ob === 'object' && !Array.isArray(ob)) {
    let bad = 0;
    Object.keys(ob).forEach(code => {
      const row = ob[code];
      if (!row || typeof row !== 'object' || Array.isArray(row)) { bad++; return; }
      if (isV6) ['dr', 'cr', 'yb', 'ytdDr', 'ytdCr'].forEach(k => {
        if (row[k] !== undefined && !isInt(row[k])) bad++;
      });
    });
    if (bad) problems.push('期初余额行结构/类型异常：' + bad + ' 处');
  }

  return { problems, notices };
}

/* ---------------- 主流程 ---------------- */
let files = [];
if (FILE_ARG) {
  files = [path.resolve(FILE_ARG)];
} else if (fs.existsSync(BOOKS_DIR)) {
  files = fs.readdirSync(BOOKS_DIR).filter(f => /\.json$/i.test(f)).map(f => path.join(BOOKS_DIR, f));
}

console.log('账套文件完整性校验');
console.log('  账套目录：' + (FILE_ARG ? path.dirname(files[0]) : BOOKS_DIR));

if (!files.length) {
  console.log('跳过：没有可校验的账套文件（' + BOOKS_DIR + ' 不存在或为空）');
  process.exit(0);
}

let fail = 0;
files.forEach(f => {
  const r = checkOne(f);
  const name = path.basename(f);
  if (r.problems.length) {
    fail++;
    console.log('  ✗ ' + name);
    r.problems.forEach(p => console.log('      · ' + p));
    r.notices.forEach(p => console.log('      提示：' + p));
  } else {
    console.log('  ✓ ' + name + (r.notices.length ? '   （提示：' + r.notices.join('；') + '）' : ''));
  }
});

console.log('');
if (fail) {
  console.log('✗ 账套完整性：' + fail + ' / ' + files.length + ' 本存在问题');
  process.exit(1);
}
console.log('✓ 账套完整性：' + files.length + ' 本全部结构正确、金额与凭证自洽');
process.exit(0);
