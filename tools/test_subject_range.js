#!/usr/bin/env node
// 验证科目范围解析器与凭证查询的端到端正确性（对齐金蝶「科目范围输入框」方案）
// 依赖真实账套：需先把账套复制到 ~/Library/Application Support/心中有数/books/default.json

import fs from 'fs';
import os from 'os';
import path from 'path';

const booksDir = path.join(os.homedir(), 'Library', 'Application Support', '心中有数', 'books');
const bookFile = path.join(booksDir, 'default.json');
if (!fs.existsSync(bookFile)) { console.log('✗ 未找到账套，跳过'); process.exit(0); }
const d = JSON.parse(fs.readFileSync(bookFile, 'utf8'));
const subs = (d.subjects || []).map(s => ({ code: String(s.code), name: s.name }));
const vouchers = d.vouchers || [];

// —— 从 SubjectRangePicker.js 提取纯函数 parseSubjectRange / matchSubjectCode ——
const src = fs.readFileSync(path.join('js', 'components', 'SubjectRangePicker.js'), 'utf8');
const fnParse = src.match(/function parseSubjectRange[\s\S]*?\n}\n/)[0];
const fnMatch = src.match(/function matchSubjectCode[\s\S]*?\n}\n/)[0];
const SEP_RE = /[,，、\s]+/;
const parseSubjectRange = eval('(function(){ ' + fnParse + ' return parseSubjectRange; })()');
const matchSubjectCode = eval('(function(){ return ' + fnMatch + ' })()');

let pass = 0, fail = 0;
function T(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

// —— 解析器单元用例 ——
console.log('【解析器】');
T('空表达式 = 全部(null)', parseSubjectRange('', subs).codes === null);
T('单码 1001 命中', parseSubjectRange('1001', subs).codes.has('1001'));
T('多码 1001,1012', (() => { const c = parseSubjectRange('1001,1012', subs).codes; return c && c.has('1001') && c.has('1012'); })());
T('中文逗号', (() => { const c = parseSubjectRange('1001，1012', subs).codes; return c && c.has('1001') && c.has('1012'); })());
T('空格分隔', (() => { const c = parseSubjectRange('1001 1012', subs).codes; return c && c.has('1001') && c.has('1012'); })());
T('范围 1121-1123', (() => { const c = parseSubjectRange('1121-1123', subs).codes; return c && c.has('1121') && c.has('1122') && c.has('1123'); })());
T('不存在单码报错', parseSubjectRange('9999', subs).ok === false);
T('起止颠倒报错', parseSubjectRange('1123-1121', subs).ok === false);

// —— 查询语义：凭证只要含任一分录命中即返回 ——
function queryVouchers(code) {
  if (!code) return vouchers;
  return vouchers.filter(v => (v.entries || []).some(e => matchSubjectCode(code, e.code)));
}
console.log('【凭证查询】');
T('全部(空) = 全部凭证', queryVouchers(null).length === vouchers.length);
const all = queryVouchers(null);
const hasSubj = c => all.some(v => (v.entries || []).some(e => e.code === c));
if (subs.length) {
  const c0 = subs[0].code;
  const one = queryVouchers(parseSubjectRange(c0, subs).codes);
  T('单科目过滤 = 含该科目凭证', hasSubj(c0) ? one.length > 0 : one.length === 0);
}
// 范围过滤：凭证至少命中范围内某科目
const anyRange = subs.filter(s => ['1121','1122','1123'].includes(s.code));
if (anyRange.length && hasSubj('1122')) {
  const r = queryVouchers(parseSubjectRange('1121-1123', subs).codes);
  T('范围过滤命中', r.length > 0);
}

// matchSubjectCode 空集合 = 全命中
T('matchSubjectCode(null) = true', matchSubjectCode(null, '1122') === true);

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
