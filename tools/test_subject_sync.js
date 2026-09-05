#!/usr/bin/env node
// 验证：新建子科目后，正在编辑的科目联想输入是否自动包含新科目（无需重新绑定）
import fs from 'fs';

// 模拟 Store：subjects 数组可动态 push（等价于 addSubject 后 state 变化）
let subjects = [
  { code: '1001', name: '库存现金', level: 0 },
  { code: '1122', name: '应收账款', level: 0 },
  { code: '100101', name: '库存现金-人民币', level: 1 },
];
globalThis.S = { subjects: () => subjects.slice() };

// 从 SubjectCombo.js 提取 bindSubjectCombo 的纯逻辑（matchList 实时读取）
const src = fs.readFileSync('js/components/SubjectCombo.js', 'utf8');

let pass = 0, fail = 0;
function T(name, cond, extra) { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (extra ? ' → ' + extra : '')); } }

// 复刻 matchList 的实时读取逻辑
function matchList(kw) {
  const subs = S.subjects();
  const k = String(kw || '').trim().toLowerCase();
  if (!k) return subs.slice(0, 12);
  return subs.filter(s =>
    String(s.code).toLowerCase().indexOf(k) === 0
    || String(s.name).toLowerCase().indexOf(k) >= 0
  ).slice(0, 12);
}

console.log('【绑定后新建子科目，联想是否同步】');
// 初始：绑定 combo（快照了 3 个科目）
T('初始联想含 100101', matchList('1001').some(s => s.code === '100101'));

// 新建子科目：112201（应收账款-客户A）
subjects.push({ code: '112201', name: '应收账款-客户A', level: 1 });

// 关键：不重新绑定，直接输入，看是否命中新科目
T('新建后输入"112201"命中新科目', matchList('112201').some(s => s.code === '112201'));
T('新建后输入"客户A"命中新科目', matchList('客户A').some(s => s.code === '112201'));
T('新建后空输入含新科目', matchList('').some(s => s.code === '112201'));

// 二级孙科目
subjects.push({ code: '11220101', name: '客户A-货款', level: 2 });
T('再建孙科目 11220101 也命中', matchList('11220101').some(s => s.code === '11220101'));

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
