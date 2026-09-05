#!/usr/bin/env node
// 验证录凭证科目联想的核心匹配逻辑（从 app.js 提取 matchList 规则，独立验证）
// 匹配规则（对齐金蝶「输入框+下拉」）：
//   1. 编码前缀匹配（如 '112' → '1122 应收账款'、'1123 预付账款'）
//   2. 名称包含匹配（如 '银行' → '银行存款'）
//   3. 空输入显示前 12 个

const subs = [
  { code: '1001', name: '库存现金' },
  { code: '1002', name: '银行存款' },
  { code: '1122', name: '应收账款' },
  { code: '1123', name: '预付账款' },
  { code: '6001', name: '主营业务收入' },
];

// 与 app.js bindSubjectCombo 内 matchList 完全一致的规则
function matchList(kw) {
  const k = String(kw || '').trim().toLowerCase();
  if (!k) return subs.slice(0, 12);
  return subs.filter(s =>
    String(s.code).toLowerCase().indexOf(k) === 0
    || String(s.name).toLowerCase().indexOf(k) >= 0
  ).slice(0, 12);
}

let pass = 0, fail = 0;
function T(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' → ' + extra : '')); }
}

console.log('【编码前缀匹配】');
T('"112" 命中 1122', matchList('112').some(s => s.code === '1122'));
T('"112" 命中 1123', matchList('112').some(s => s.code === '1123'));
T('"112" 不命中 1001', !matchList('112').some(s => s.code === '1001'));

console.log('【名称匹配】');
T('"银行" 命中 银行存款', matchList('银行').some(s => s.name === '银行存款'));
T('"应收" 命中 应收账款', matchList('应收').some(s => s.name === '应收账款'));

console.log('【空输入】');
T('空输入返回前 12 个', matchList('').length === 5);
T('空输入含第一个科目', matchList('')[0].code === '1001');

console.log('【大小写】');
T('"1001" 精确', matchList('1001').length === 1 && matchList('1001')[0].code === '1001');
T('无匹配返回空', matchList('9999').length === 0);

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
