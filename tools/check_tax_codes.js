#!/usr/bin/env node
'use strict';
/* ============================================================
 * tools/check_tax_codes.js —— 税金明细表「税种 ↔ 回退编码」静态卡口
 *
 * 【为什么需要】
 *   store.js 的税金明细表原来是两个**并行数组**：`taxNames[ti]`（税种）与
 *   `order[ti]`（标准回退编码），靠下标硬对齐。结果「资源税」的回退码被写成
 *   222105 —— 那是「待认证进项税额」，一个**增值税**明细。名称匹配失败的账套里，
 *   「资源税」行会显示待认证进项税额的发生额。
 *   实测 11/12 项正确、仅 1 项错；两本真实账套都因名称含「资源税」直接命中，
 *   回退路径从未走过，所以错误潜伏了一年多。
 *
 *   2026-10-22 已把两个数组合并成一个（编码与税种同处一行，见 store.js 注释），
 *   本卡口负责保证它以后不能再错：
 *     ① 每项必须带完整 { key, label, code }（漏 code 会当场抓到）；
 *     ② 编码唯一、非空、6 位数字；
 *     ③ 编码不得落进增值税区间 222101–222110 —— 税种回退码只可能是 222111 起的其他税种
 *        （这条不变量正是能自动抓住 222105 的那一条）。
 *
 * 用法：node tools/check_tax_codes.js
 * ============================================================ */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'js', 'store.js'), 'utf8');

// 只取 taxNames 那一块，避免扫到文件别处的 { key: … }
const blockM = /var taxNames = \[([\s\S]*?)\n {6}\];/.exec(src);
if (!blockM) {
  console.error('✗ js/store.js 里找不到 taxNames 定义块（是否改名？本卡口需同步更新）');
  process.exit(1);
}
const block = blockM[1];

const items = [];
const re = /\{\s*key:\s*'([^']+)'\s*,\s*label:\s*'([^']+)'\s*,\s*code:\s*'([^']+)'\s*\}/g;
let m;
while ((m = re.exec(block))) items.push({ key: m[1], label: m[2], code: m[3] });
const braceCount = (block.match(/\{\s*key:/g) || []).length;

let bad = 0;
const fail = (msg) => { console.error('  ✗ ' + msg); bad++; };

if (items.length !== braceCount) {
  fail('taxNames 共 ' + braceCount + ' 项，但只有 ' + items.length
    + ' 项带完整 { key, label, code } —— 有项漏了 code 字段？');
}
if (items.length < 10) fail('税种数量异常（' + items.length + '），疑似解析失败');

const seen = {};
items.forEach((it, i) => {
  const at = '第' + (i + 1) + '项「' + it.key + '」';
  if (!/^\d{6}$/.test(it.code)) { fail(at + ' 回退编码非法：' + JSON.stringify(it.code) + '（应为 6 位数字）'); return; }
  if (seen[it.code]) fail('回退编码重复：' + it.code + '（' + seen[it.code] + ' 与 ' + it.key + '）');
  seen[it.code] = it.key;
  /* 增值税区间 222101–222110 全部是增值税体系明细（应交/未交/预交增值税、待抵扣进项、
     待认证进项、待转销项、留抵、简易计税、转让金融商品、代扣代交）。
     其他税种从 222111（应交所得税）起排。回退码落进这个区间 = 编码错配。 */
  if (it.code >= '222101' && it.code <= '222110') {
    fail(at + ' 回退码 ' + it.code + ' 落在增值税区间 222101–222110 —— '
      + '税种回退码只可能是 222111 起的其他税种（资源税曾误写 222105）');
  }
});

if (bad) {
  console.error('\n✗ 税金明细表税种编码卡口未通过（' + bad + ' 项）');
  process.exit(1);
}
console.log('✓ 税金明细表税种编码卡口全部通过：' + items.length + ' 个税种，'
  + '编码唯一、均为 6 位、均在 222111+ 区间');
process.exit(0);
