#!/usr/bin/env node
/* ============================================================================
 * 导出 / 分页**单点**的回归（2026-10-04 新增）
 *
 * 【为什么要单独测这两个单点】
 *   本轮把 12 处导出样板合并成 `TyIo.buildSheetWorkbook`、6 处分页算术合并成 `U.totalPages`。
 *   合并本身若被测到，页面侧**不会报错** —— 只是导出的表悄悄丢了列宽/合并，或分页出现"第 0 页"。
 *   属于"只测成功路径就看不见"的那类，故给单点本身立判据：
 *     ① sheet 名 / rows / cols / merges 必须**原样**进入工作簿（总账靠 merges 才能跨行合并科目名）；
 *     ② json 形态必须走 json_to_sheet（js/pages/settings/_shared.js 的 exportTable 用它）；
 *     ③ 未给 cols/merges 时不得写空字段（与原来的页面写法等价，避免给 SheetJS 塞空数组）；
 *     ④ U.totalPages 与旧内联写法**逐值等价**，且 0 条数据仍返回 1 页（守卫不能丢）。
 *
 * 【装载方式】两个单点都很"干净"，故**按源码提取函数**来测（与 test_typrint.js 同一套路）：
 *   store.js 的 IIFE 需要 document/localStorage 等一大套环境，整文件 eval 反而脆弱。
 * ========================================================================== */
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function ck(ok, name, detail) {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '　→ ' + detail : '')); }
}

/* ---------- 环境：mock XLSX（真机里 TyIo 只在调用时用它） ---------- */
global.window = global;
global.XLSX = {
  utils: {
    book_new: function () { return { SheetNames: [], Sheets: [], __wb: true }; },
    aoa_to_sheet: function (rows) { return { __rows: rows }; },
    json_to_sheet: function (rows) { return { __json: rows }; },
    book_append_sheet: function (wb, ws, name) { wb.__last = { ws: ws, name: name }; }
  }
};

/* ---------- 装载 ty-io.js（全局脚本，与真机 index.html 一致） ---------- */
console.log('导出 / 分页单点测试：');
(0, eval)(fs.readFileSync(path.join(ROOT, 'js', 'ty-io.js'), 'utf8'));
const T = global.TyIo;
ck(!!T && typeof T.buildSheetWorkbook === 'function',
  'TyIo.buildSheetWorkbook 已暴露（页面导出靠它造工作簿）');

const wb = T.buildSheetWorkbook({
  sheet: '总账', rows: [[1, 2]],
  cols: [{ wch: 12 }, { wch: 22 }],
  merges: [{ s: { r: 0, c: 0 }, e: { r: 2, c: 0 } }]
});
ck(!!wb && !!wb.__last && wb.__last.name === '总账', 'sheet 名原样进入工作簿',
  wb && wb.__last ? String(wb.__last.name) : '(无)');
ck(!!wb.__last && wb.__last.ws.__rows[0][0] === 1, 'rows 经 aoa_to_sheet（二维数组原样）');
ck(!!wb.__last && Array.isArray(wb.__last.ws['!cols']) && wb.__last.ws['!cols'][1].wch === 22,
  '列宽 !cols 原样写入');
ck(!!wb.__last && Array.isArray(wb.__last.ws['!merges']) && wb.__last.ws['!merges'].length === 1
  && wb.__last.ws['!merges'][0].e.r === 2,
  '合并 !merges 原样写入（总账的科目名跨行合并靠它）');

const wbJson = T.buildSheetWorkbook({ sheet: '导出', json: [{ a: 1 }, { a: 2 }] });
ck(!!wbJson.__last && wbJson.__last.ws.__json && wbJson.__last.ws.__json.length === 2,
  'json 形态走 json_to_sheet（_shared.exportTable 用它）');

const wbPlain = T.buildSheetWorkbook({ sheet: 'y', rows: [['a']] });
ck(!!wbPlain.__last && !wbPlain.__last.ws['!cols'] && !wbPlain.__last.ws['!merges'],
  '未给 cols/merges 时不写空字段（与原先页面写法等价）');

/* ---------- 分页单点：按源码提取（store.js 整体 eval 需 document/localStorage，过重） ---------- */
const storeSrc = fs.readFileSync(path.join(ROOT, 'js', 'store.js'), 'utf8');
const m = /function\s+totalPages\s*\([^)]*\)\s*\{/.exec(storeSrc);
ck(!!m, 'store.js 里能找到 totalPages（口径单点的持有者）');
if (m) {
  let depth = 0, end = -1;
  for (let j = storeSrc.indexOf('{', m.index); j < storeSrc.length; j++) {
    if (storeSrc[j] === '{') depth++;
    else if (storeSrc[j] === '}') { depth--; if (!depth) { end = j; break; } }
  }
  const fn = (0, eval)('(' + storeSrc.slice(m.index, end + 1) + ')');
  const oldImpl = function (total, size) { return Math.max(1, Math.ceil(total / size)); };
  const cases = [[0, 50], [1, 50], [50, 50], [51, 50], [100, 50], [1234, 100], [7, 10], [0, 1]];
  let same = true, detail = '';
  cases.forEach(function (c) {
    const a = fn(c[0], c[1]), b = oldImpl(c[0], c[1]);
    if (a !== b) { same = false; detail += '(' + c[0] + ',' + c[1] + ') 得 ' + a + '，旧写法 ' + b + '；'; }
  });
  ck(same, 'totalPages 与旧内联写法逐值等价（' + cases.length + ' 组样本）', detail);
  ck(fn(0, 50) === 1, '0 条数据 → 1 页（守卫不能丢：否则会渲染"第 0 页 / 共 0 页"）');
  ck(fn(51, 50) === 2, '51 条 / 每页 50 → 2 页');
}

console.log('\n结果：' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
