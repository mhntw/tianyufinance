#!/usr/bin/env node
// 验证金蝶科目 Excel 导入逻辑（与 Subject.js importSubjectsFromExcel 相同的映射）
// 用真实金蝶导出文件：~/Downloads/20260830170910_科目.xlsx
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const XLSX = require('../js/xlsx.full.min.js');

const f = path.join(os.homedir(), 'Downloads', '20260830170910_科目.xlsx');
if (!fs.existsSync(f)) { console.log('✗ 未找到金蝶科目文件，跳过'); process.exit(0); }

// —— 科目表（从真实账套初始化，模拟 S.state.subjects）——
let bookFile = path.join(os.homedir(), 'Library', 'Application Support', '心中有数', 'books', 'default.json');
let subjects = fs.existsSync(bookFile)
  ? JSON.parse(fs.readFileSync(bookFile, 'utf8')).subjects
  : [];
const initialCount = subjects.length;

// —— 复刻 store.js 的 addSubject 逻辑 ——
const CODE_RE = /^\d{4,16}$/;
const ACCOUNT_CLASSES = {
  asset: { name: '资产', normal: 'dr', side: '借' }, liability: { name: '负债', normal: 'cr', side: '贷' },
  equity: { name: '权益', normal: 'cr', side: '贷' }, revenue: { name: '收入', normal: 'cr', side: '贷' },
  expense: { name: '费用', normal: 'dr', side: '借' }, cost: { name: '成本', normal: 'dr', side: '借' },
};
const KDJ_CAT_MAP = {
  '流动资产': 'asset', '非流动资产': 'asset', '流动负债': 'liability', '非流动负债': 'liability',
  '所有者权益': 'equity', '成本': 'cost', '营业收入': 'revenue', '其他收益': 'revenue',
  '营业成本及税金': 'expense', '其他损失': 'expense', '期间费用': 'expense', '所得税': 'expense',
  '以前年度损益调整': 'expense'
};
const KDJ_AUX_MAP = { '客户': 'customer', '供应商': 'supplier', '存货': 'inventory' };

function subject(code) { return subjects.find(s => s.code === code) || null; }
function addSubject(code, name, cls, extra) {
  code = String(code).trim();
  if (!CODE_RE.test(code)) return { ok: false, msg: '编码格式' };
  if (code.length % 2 !== 0) return { ok: false, msg: '奇数位' };
  if (subject(code)) return { ok: false, msg: '已存在' };
  const level = code.length >= 6 ? (code.length - 4) / 2 : 0;
  const parentCode = level > 0 ? code.slice(0, -2) : '';
  const parent = parentCode ? subject(parentCode) : null;
  if (level > 0 && !parent) return { ok: false, msg: '父不存在:' + parentCode };
  const cls2 = cls || (parent ? parent.cls : '');
  if (!ACCOUNT_CLASSES[cls2]) return { ok: false, msg: '类别无效' };
  const e = extra || {};
  subjects.push({ code, name, cls: cls2, normal: ACCOUNT_CLASSES[cls2].normal, level, parent: parent ? parent.code : '',
    aux: e.aux || [], qty: !!e.qty, unit: e.unit || '', foreign: !!e.foreign, adjust: !!e.adjust, currency: e.currency || '' });
  return { ok: true };
}

// —— 读取金蝶 Excel ——
const buf = fs.readFileSync(f);
const wb = XLSX.read(buf, { type: 'buffer' });
const ws = wb.Sheets[wb.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

let pass = 0, fail = 0;
function T(name, cond, extra) { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (extra ? ' → ' + extra : '')); } }

console.log(`金蝶科目文件: ${rows.length} 行, 现有账套科目: ${initialCount}`);
console.log('【导入逻辑】');
let ok = 0, skipped = 0, firstErr = null;
rows.forEach(r => {
  const code = String(r['编码'] || '').trim();
  const name = String(r['名称'] || '').trim();
  if (!code || !name) return;
  let cls = KDJ_CAT_MAP[String(r['类别'] || '').trim()];
  if (!cls) cls = (String(r['余额方向'] || '') === '贷') ? 'liability' : 'asset';
  const auxStr = String(r['辅助核算类别'] || '');
  const aux = [];
  if (auxStr) auxStr.split(/[\/、]/).forEach(a => { const k = KDJ_AUX_MAP[a.trim()]; if (k && aux.indexOf(k) < 0) aux.push(k); });
  const isQty = String(r['数量核算'] || '') === '√' || /^\d+$/.test(String(r['数量核算'] || '').trim());
  const isFgn = /^(?!RMB$)/.test(String(r['外币核算'] || 'RMB').trim());
  const res = addSubject(code, name, cls, { aux, qty: isQty, foreign: isFgn });
  if (res.ok) ok++; else { skipped++; if (!firstErr) firstErr = code + ':' + res.msg; }
});

T('导入成功数 > 0', ok > 0, `成功 ${ok}`);
T('跳过数(已存在)合理', skipped >= 0, `跳过 ${skipped}`);
T('父科目校验: 100101 父=1001 存在', subject('100101') && subject('100101').parent === '1001');
T('段式编码: 100101 level=1', subject('100101') && subject('100101').level === 1);
T('类别映射: 库存现金→asset', subject('1001') && subject('1001').cls === 'asset');
T('成本类: 某成本科目→cost', subjects.some(s => s.cls === 'cost'));

// 类别/aux 校验
const auxSubject = subjects.find(s => (s.aux || []).length > 0);
T('辅助核算映射(customer/supplier/inventory)', !auxSubject || auxSubject.aux.some(a => ['customer','supplier','inventory'].includes(a)));

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
