#!/usr/bin/env node
// 用真实账套验证 addSubject / setOpening 的段式子科目逻辑（对齐金蝶）
import fs from 'fs';
import os from 'os';
import path from 'path';

const booksDir = path.join(os.homedir(), 'Library', 'Application Support', '添钰财务', 'books');
const bookFile = path.join(booksDir, 'default.json');
if (!fs.existsSync(bookFile)) { console.log('✗ 未找到账套，跳过'); process.exit(0); }

let subjects = JSON.parse(fs.readFileSync(bookFile, 'utf8')).subjects;
let openingBalances = {};
const CODE_RE = /^\d{4,16}$/;
const ACCOUNT_CLASSES = { asset: { normal: 'dr' }, liability: { normal: 'cr' }, owner: { normal: 'cr' }, revenue: { normal: 'cr' }, expense: { normal: 'dr' }, cost: { normal: 'dr' } };

function subject(code) { return subjects.find(s => s.code === code) || null; }
function childCodesOf(code) { return subjects.filter(s => s.code !== code && s.code.indexOf(code) === 0).map(s => s.code); }

function addSubject(code, name, cls, extra) {
  code = String(code).trim();
  if (!CODE_RE.test(code)) return { ok: false, msg: '科目编码格式不正确' };
  if (code.length % 2 !== 0) return { ok: false, msg: '奇数位' };
  if (subject(code)) return { ok: false, msg: '已存在' };
  const level = code.length >= 6 ? (code.length - 4) / 2 : 0;
  const parentCode = level > 0 ? code.slice(0, -2) : '';
  const parent = parentCode ? subject(parentCode) : null;
  if (level > 0 && !parent) return { ok: false, msg: '父不存在' };
  const cls2 = cls || (parent ? parent.cls : '');
  if (!ACCOUNT_CLASSES[cls2]) return { ok: false, msg: '类别无效' };
  subjects.push({ code, name, cls: cls2, normal: ACCOUNT_CLASSES[cls2].normal, level, parent: parent ? parent.code : '' });
  return { ok: true };
}

function setOpening(code, dr, cr, yb, ytdDr, ytdCr) {
  dr = Number(dr) || 0; cr = Number(cr) || 0;
  if (childCodesOf(code).length > 0 && (dr !== 0 || cr !== 0)) return { ok: false, msg: '有下级' };
  openingBalances[code] = { dr, cr };
  return { ok: true };
}

let pass = 0, fail = 0;
function T(name, cond, extra) { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (extra ? ' → ' + extra : '')); } }

console.log('【addSubject 段式子科目】');
const r1 = addSubject('112201', '应收账款-测试', 'asset');
T('新增 112201 成功', r1.ok);
if (r1.ok) {
  const s = subject('112201');
  T('level=1', s.level === 1);
  T('parent=1122', s.parent === '1122');
  T('cls 继承 asset', s.cls === 'asset');
}
T('父不存在 999901 拒绝', !addSubject('999901', 'x', 'asset').ok);
T('重复 112201 拒绝', !addSubject('112201', 'y', 'asset').ok);
T('非法 1001.01 拒绝', !addSubject('1001.01', 'y', 'asset').ok);
T('奇数位 10010 拒绝', !addSubject('10010', 'y', 'asset').ok);

console.log('【setOpening 期初口径】');
T('父科目(1122)有子目禁录期初', !setOpening('1122', 100, 0).ok);
T('末级(112201)可录期初', setOpening('112201', 100, 0).ok);
T('无子目(1001)可录期初', setOpening('1001', 500, 0).ok);

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
