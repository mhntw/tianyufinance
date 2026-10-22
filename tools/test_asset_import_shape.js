#!/usr/bin/env node
'use strict';
/* ============================================================
 * tools/test_asset_import_shape.js —— 固定资产卡片 xlsx 导入的「畸形输入」守卫
 *
 * 【为什么要有】导入的失败模式是静默的：解析器不抛错，但会把不可能的期限/单元格错误值
 *   悄悄变成卡片字段（月折旧 0、残值 2020 …）。这里锁三件事：
 *     ① 畸形工作簿（空表 / 只有标题 / 错误单元格 #DIV/0! / 缺 !ref）不得抛错；
 *     ② 期限负值必须归 0 —— 否则 life=-0.4167 既躲过 assetMonthlyDepr 的 life<=0 判定，
 *        也躲过「导入体检」的 !num(fa.life)（负数 truthy），卡片月折旧静默为 0；
 *     ③ 期限的正常口径不能被修坏：14 期 → 1.1667 年、5年 → 5、歧义列 60 → 5（60 期）。
 *
 * 【不依赖真实账套】纯合成工作簿，用与运行时同一个 SheetJS 文件。
 * 用法：node tools/test_asset_import_shape.js
 * ============================================================ */
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
function ck(cond, label, detail) {
  if (cond) { pass++; return; }
  fail++; console.log('  ✗ ' + label + (detail !== undefined ? '  → ' + detail : ''));
}

const mem = {};
global.localStorage = { getItem: k => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; } };
global.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() { } };
global.window = global; global.__TAURI__ = {}; global.isTauri = false;
require(path.join(ROOT, 'js', 'storage.js'));
require(path.join(ROOT, 'js', 'store.js'));
global.XLSX = require(path.join(ROOT, 'js', 'xlsx.full.min.js'));
require(path.join(ROOT, 'js', 'ty-io.js'));
const XLSX = global.XLSX, TyIo = global.TyIo;

function wbOf(rows, sheetName) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), sheetName || 'S');
  return wb;
}
function parse(wb) {
  try { return { ok: true, list: TyIo.parseAssetWorkbook(wb) }; }
  catch (e) { return { ok: false, err: e && e.message }; }
}

/* ---------- ① 畸形输入不得抛错 ---------- */
console.log('== 畸形工作簿：解析器必须稳住 ==');
const emptyWb = XLSX.utils.book_new();
ck(parse(emptyWb).ok, '空工作簿（无工作表）不抛错');
ck(parse(emptyWb).list && parse(emptyWb).list.length === 0, '空工作簿返回空数组');

const titleOnly = wbOf([['固定资产卡片台账'], ['编制单位：某某公司']], '卡片');
ck(parse(titleOnly).ok, '只有标题行不抛错');
ck(parse(titleOnly).list.length === 0, '只有标题行不产生卡片（不能把标题当数据）');

const headerOnly = wbOf([['操作', '编码', '名称', '类别', '原值', '预计使用期限', '残值']]);
ck(parse(headerOnly).ok, '只有表头不抛错');
ck(parse(headerOnly).list.length === 0, '只有表头不产生卡片');

const noRef = wbOf([['操作', '编码', '名称', '原值']]);
delete noRef.Sheets.S['!ref'];
ck(parse(noRef).ok, '工作表缺 !ref 不抛错');

const errCell = wbOf([['操作', '编码', '名称', '原值']], 'S');
errCell.Sheets.S['A2'] = { t: 'e', v: 7, w: '#DIV/0!' };
errCell.Sheets.S['B2'] = { t: 's', v: 'A001' };
errCell.Sheets.S['C2'] = { t: 's', v: '电脑' };
errCell.Sheets.S['D2'] = { t: 'e', v: 7, w: '#N/A' };
ck(parse(errCell).ok, '错误单元格 (#DIV/0! / #N/A) 不抛错');

/* ---------- ② 期限负值必须归 0 ---------- */
console.log('\n== 期限口径 ==');
const L = TyIo.parseAssetWorkbook(wbOf([['操作', '编码', '名称', '原值', '预计使用期限'], ['', 'A1', '甲', 1000, '-5']]))[0];
ck(L && L.life === 0, '期限 -5 → 归 0（不得留 -0.4167，否则体检与月折旧都漏判）', L && L.life);

const M = TyIo.parseAssetWorkbook(wbOf([['操作', '编码', '名称', '原值', '预计使用期限'], ['', 'A2', '乙', 1000, '0']]))[0];
ck(M && M.life === 0, '期限 0 → 0（缺期限由体检提示）', M && M.life);

/* ---------- ③ 正常口径不能被修坏 ---------- */
const P = TyIo.parseAssetWorkbook(wbOf([['操作', '编码', '名称', '原值', '预计使用期数'], ['', 'A3', '丙', 1000, '14']]))[0];
ck(P && Math.abs(P.life - 14 / 12) < 0.0001, '「预计使用期数 14」→ 1.1667 年（期数组 ÷12）', P && P.life);

const Y = TyIo.parseAssetWorkbook(wbOf([['操作', '编码', '名称', '原值', '预计使用期限'], ['', 'A4', '丁', 1000, '5年']]))[0];
ck(Y && Y.life === 5, '「5年」→ 5 年（单元格带"年"字优先按年）', Y && Y.life);

const A = TyIo.parseAssetWorkbook(wbOf([['操作', '编码', '名称', '原值', '预计使用期限'], ['', 'A5', '戊', 1000, '60']]))[0];
ck(A && A.life === 5, '歧义列「使用期限 60」→ 5 年（60 年不合理则按 60 期兜底）', A && A.life);

/* 无名称的行不是卡片（标题/合计行不得被当成资产） */
const N = TyIo.parseAssetWorkbook(wbOf([['操作', '编码', '名称', '原值'], ['', 'A6', '', 1000], ['', 'A7', '己', 2000]]));
ck(N.length === 1 && N[0].name === '己', '无名称行被跳过，只保留真卡片', JSON.stringify(N.map(x => x.name)));

console.log('\n' + pass + ' / ' + (pass + fail) + ' 通过');
if (fail) process.exitCode = 1;
