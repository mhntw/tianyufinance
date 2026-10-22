#!/usr/bin/env node
'use strict';
/* ============================================================
 * tools/verify_import_contract.js —— 转换器 ↔ 主软件 的**契约测试**
 *
 * 【为什么需要】2026-10-22 把金蝶 .ais 导入链路从主软件拆到 ais-tool/ 独立转换器。
 *   拆开后两侧靠一个 **json 文件**传递数据，而这个文件有一条极隐蔽的规则：
 *
 *     主软件 store.importExternalBook 的金额单位判据是
 *         if (book.schemaVersion !== SCHEMA_VERSION) migrateAmountsToV6(book);
 *     它靠「**没有** schemaVersion」来判定"这是元单位、需要 ×10000 迁移"。
 *
 *   于是：
 *     · 转换器**绝不能**在产出的 json 里补 schemaVersion —— 补了迁移就被跳过，
 *       整本账金额少乘 10000 倍，而每个数看起来都自洽（store.js 该处注释称之为
 *       "最难查的一类数据事故"）。
 *     · 主软件将来若升 schemaVersion，迁移必须写成链式（v5→v6→v7…逐级跑完再标版本），
 *       否则"无版本号的老转换器产物"会被直接标成新版本、跳过中间迁移。
 *
 *   这两条现在都只靠注释维持。本脚本把它们变成**会咬人的断言**：
 *     ① 静态：kis-import.js / convert.js 里不得出现 schemaVersion（红线一）
 *     ② 静态：主软件（index.html + js/**）不得引用 kis-import / mdb-reader / buffer（拆分不退流）
 *     ③ 运行时：真实 .ais → 转换 → 导入主软件 → 金额必须恰为原来的 ×10000（红线二）
 *     ④ 运行时：转换产物必须能被主软件完整接纳（补版本号、补 id、补 cashFlowItems）
 *
 * 【什么时候会红】升级主软件账套结构 / 改金额单位 / 改 importExternalBook 的版本判据时，
 *   它会立刻告诉你"老转换器产物不再兼容"—— 那正是需要重新评估搭配问题的时刻。
 *
 * 用法：node tools/verify_import_contract.js   （无 .ais 样本时打印跳过并 exit 0）
 * ============================================================ */
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, 'ais-tool', 'js');
let bad = 0;
const ck = (c, m, d) => { if (c) console.log('  ✓ ' + m); else { console.log('  ✗ ' + m + (d ? '  → ' + d : '')); bad++; } };

/* ---------- 浏览器环境桩（store.js 需要） ---------- */
const mem = {};
global.localStorage = {
  getItem: k => (k in mem ? mem[k] : null),
  setItem: (k, v) => { mem[k] = String(v); },
  removeItem: k => { delete mem[k]; }
};
global.document = { getElementById: () => null };
global.window = global;
global.__TAURI__ = {};
global.isTauri = false;
require(path.join(ROOT, 'js', 'storage.js'));
require(path.join(ROOT, 'js', 'store.js'));
const S = global.S;

console.log('\n=== 契约一：静态红线（schemaVersion / 拆分不退流）===');
['kis-import.js', 'convert.js'].forEach(function (f) {
  const p = path.join(TOOL, '..', f === 'convert.js' ? f : path.join('js', f));
  if (!fs.existsSync(p)) { ck(false, f + ' 应存在（拆分后它必须还在）'); return; }
  const src = fs.readFileSync(p, 'utf8');
  /* 剥注释：本文件的注释里就会出现 schemaVersion 这个词（正在解释这条规则），
     不剥就会被自己的说明文字命中 —— check_single_source 上踩过一次同样的坑。 */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ').replace(/\/\/.*$/gm, ' ');
  ck(code.indexOf('schemaVersion') < 0,
    f + ' 的**代码**里不得出现 schemaVersion（转换器产物必须"无版本号"，否则金额少乘 10000 倍）',
    '命中位置附近：' + (code.slice(Math.max(0, code.indexOf('schemaVersion') - 40), code.indexOf('schemaVersion') + 40) || '').replace(/\s+/g, ' '));
});
/* 拆分不退流：主软件不得再**引用**那三个文件（防止"用户抱怨导不了 .ais"把它们加回来）
   ⚠ 必须先剥注释：store.js / Settings.js 的注释里都在解释这次拆分，必然提到那三个文件名；
     不剥就会被自己的说明文字命中（check_single_source 上踩过一次同样的坑）。 */
(function () {
  const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ').replace(/\/\/.*$/gm, ' ');
  const bad = [];
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (!/node_modules|\.git/.test(p)) walk(p); return; }
    if (!/\.(js|mjs|html)$/.test(e.name)) return;
    const rel = path.relative(ROOT, p).split(path.sep).join('/');
    if (rel.indexOf('ais-tool/') === 0 || rel.indexOf('tools/') === 0) return;   // 转换器与测试不算主软件
    const code = strip(fs.readFileSync(p, 'utf8'));
    /* script 标签引用 + require/import 才算"真的在用"；注释里的文件名已被剥掉 */
    if (/<script[^>]+src="[^"]*(kis-import|mdb-reader|buffer\.js)/.test(code)
      || /require\([^)]*(kis-import|mdb-reader|buffer\.js)/.test(code)
      || /from\s+['"][^'"]*(kis-import|mdb-reader|buffer\.js)/.test(code)
      || /\bKisImport\b/.test(code)) bad.push(rel);
  });
  walk(path.join(ROOT, 'js'));
  const html = strip(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'));
  if (/<script[^>]+src="[^"]*(kis-import|mdb-reader|buffer\.js)/.test(html)) bad.push('index.html');
  ck(bad.length === 0, '主软件（index.html + js/**）不得引用 kis-import / mdb-reader / buffer / KisImport',
    '命中：' + bad.join(', '));
})();

console.log('\n=== 契约二：真实 .ais → 转换 → 导入 → 金额必须恰为 ×10000 ===');
/* 找样本：与 verify_vs_ais.js 同一批目录（保持口径一致，避免两边各挑各的） */
const DIRS = ['/Users/chen/Desktop', '/Users/chen/Downloads/金蝶账套 ais', '/Users/chen/Downloads'];
let aisPath = null;
for (const d of DIRS) {
  try {
    if (!fs.existsSync(d)) continue;
    const hit = fs.readdirSync(d).filter(f => /\.ais$/i.test(f))
      .map(f => ({ p: path.join(d, f), m: fs.statSync(path.join(d, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)[0];
    if (hit) { aisPath = hit.p; break; }
  } catch (e) { /* 目录不存在就换下一个 */ }
}
if (!aisPath) {
  console.log('  · 跳过：本机没有金蝶 .ais 样本（CI 环境无样本，这条不算未校验通过）');
} else {
  console.log('  · 样本：' + path.basename(aisPath));
  /* 加载解析链：顺序必须是 mdb-reader → kis-import（kis-import 依赖全局 MDBReader） */
  (0, eval)(fs.readFileSync(path.join(TOOL, 'mdb-reader.js'), 'utf8'));
  (0, eval)(fs.readFileSync(path.join(TOOL, 'kis-import.js'), 'utf8'));
  const KI = global.KisImport;
  ck(KI && typeof KI.parse === 'function', '能从 ais-tool/js/kis-import.js 取到 KisImport.parse');

  const buf = fs.readFileSync(aisPath);
  KI.parse(buf).then(function (res) {
    const book = res.ledger, stats = res.stats || {};
    ck(book && Array.isArray(book.subjects) && book.subjects.length > 0,
      '转换产物有科目（' + (book.subjects || []).length + ' 个）');
    ck(Array.isArray(book.vouchers) && book.vouchers.length > 0,
      '转换产物有凭证（' + (book.vouchers || []).length + ' 张）');

    /* 红线一（运行时侧）：产物**不得**带版本号 */
    ck(book.schemaVersion === undefined,
      '转换产物不得带 schemaVersion（带了 → 主软件跳过 ×10000 迁移 → 金额错一万倍）',
      '实测 schemaVersion=' + JSON.stringify(book.schemaVersion));
    ck(!('schemaVersion' in book), '转换产物的顶层键里不得出现 schemaVersion');

    /* 取一个**有金额的**分录作为基准，导入后校验它恰为原来的 ×10000 */
    let probe = null;
    for (const v of (book.vouchers || [])) {
      for (const e of (v.entries || [])) {
        if (e && (Number(e.dr) > 0 || Number(e.cr) > 0)) { probe = e; break; }
      }
      if (probe) break;
    }
    ck(!!probe, '能找到带金额的分录作为校验基准');
    const before = probe ? Math.max(Number(probe.dr) || 0, Number(probe.cr) || 0) : 0;

    /* 导入主软件：这一步会跑 normalizeState / ensureVoucherIds / ensureCashFlowFields */
    S.state = {}; S.bookId = '';
    S.normalizeState();
    const bid = 'CONTRACT_' + Date.now();
    return S.importExternalBook(bid, book).then(function (saved) {
      ck(saved === true, '转换产物能被主软件 importExternalBook 接纳（返回 true = 已写盘）');
      ck(S.state.schemaVersion === S.SCHEMA_VERSION,
        '导入后账套被补上当前 schemaVersion（' + S.state.schemaVersion + '）—— 老产物不会卡在旧版本');
      const vs = S.state.vouchers || [];
      ck(vs.length === (book.vouchers || []).length, '凭证数一致（' + vs.length + '）');
      ck(vs.every(v => !!v.id), '每张凭证都被补上稳定 id（点凭证定位不会失效）');
      ck(Array.isArray(S.state.cashFlowItems) && S.state.cashFlowItems.length > 0,
        'cashFlowItems 已兜底（否则现金流量页面 forEach 崩溃、页面空白）');

      if (probe) {
        /* 在导入后的账套里找同一条分录（按科目 + 金额特征匹配），断言它 = 原值 ×10000 */
        const after = vs.reduce(function (found, v) {
          if (found) return found;
          return (v.entries || []).reduce(function (f, e) {
            if (f) return f;
            return (String(e.code) === String(probe.code)
              && (Number(e.dr) === before * 10000 || Number(e.cr) === before * 10000)) ? e : null;
          }, null);
        }, null);
        ck(!!after, '导入后能找到基准分录，且金额恰为转换产物 ×10000',
          after ? ('科目 ' + after.code + ' dr=' + after.dr + ' cr=' + after.cr + '，期望 ' + before * 10000)
            : ('未找到 科目=' + probe.code + ' 金额=' + before * 10000));
      }
      console.log('\n' + (bad === 0 ? '✓ 契约测试全部通过：转换器产物与主软件导入端完全兼容'
        : '✗ 契约测试有 ' + bad + ' 处不符'));
      process.exit(bad ? 1 : 0);
    });
  }).catch(function (e) {
    console.error('  ✗ 解析/导入链异常：' + (e && e.message || e));
    process.exit(1);
  });
}
