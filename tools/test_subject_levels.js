#!/usr/bin/env node
// 验证子科目全链路（段式编码）：新增子科目、层级判断、多栏账直属、level 推导
import fs from 'fs';

const CODE_RE = /^\d{4,16}$/;
// 段式层级：一级4位，每下级+2位；父 = 去掉末级2位
const levelOf = code => code.length >= 6 ? (code.length - 4) / 2 : 0;
const parentOf = code => code.length >= 6 ? code.slice(0, -2) : '';

const childOf = (all, code) => all.filter(s => s.code !== code && s.code.indexOf(code) === 0 && s.code.length > code.length);
// 多栏账直属：去掉末级2位后等于父
const directChildOf = (all, code) => childOf(all, code).filter(s => {
  if (s.code.length > code.length + 2) return s.code.slice(0, -2) === code;
  return true;
});

let pass = 0, fail = 0;
function T(name, cond, extra) { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (extra ? ' → ' + extra : '')); } }

// 段式科目表模拟
const subs = [
  { code: '1122', name: '应收账款', level: 0 },
  { code: '112201', name: '应收账款-客户A', level: 1 },
  { code: '11220101', name: '客户A-货款', level: 2 },
  { code: '112202', name: '应收账款-客户B', level: 1 },
  { code: '1001', name: '库存现金', level: 0 },
  { code: '100101', name: '库存现金-人民币', level: 1 },
];

console.log('【段式编码正则】');
T('一级 1001 通过', CODE_RE.test('1001'));
T('二级 100101 通过', CODE_RE.test('100101'));
T('三级 11220101 通过', CODE_RE.test('11220101'));
T('非法 1001.01（有点）拒绝', !CODE_RE.test('1001.01'));
T('非法 abc 拒绝', !CODE_RE.test('abc'));
T('奇数位 1001a 拒绝', !CODE_RE.test('1001a'));

console.log('【level / parent 推导】');
T('1001 → level0', levelOf('1001') === 0);
T('100101 → level1', levelOf('100101') === 1);
T('11220101 → level2', levelOf('11220101') === 2);
T('100101 → 父1001', parentOf('100101') === '1001');
T('11220101 → 父112201', parentOf('11220101') === '112201');
T('一级无父', parentOf('1001') === '');

console.log('【childCodesOf 全部下级】');
T('1001 含 100101', childOf(subs, '1001').some(s => s.code === '100101'));
T('1001 不含 1122', !childOf(subs, '1001').some(s => s.code === '1122'));
T('1122 全部下级 = 3', childOf(subs, '1122').length === 3);

console.log('【多栏账直属子科目】');
const d = directChildOf(subs, '1122');
T('1122 直属 = 2（112201/112202）', d.length === 2);
T('直属不含孙级 11220101', !d.some(s => s.code === '11220101'));
const d2 = directChildOf(subs, '112201');
T('112201 直属 = 1（11220101）', d2.length === 1 && d2[0].code === '11220101');

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
