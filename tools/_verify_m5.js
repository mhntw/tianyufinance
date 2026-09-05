#!/usr/bin/env node
/* _verify_m5.js — 验证「已使用科目禁改类别」防呆（M5）
 * 用例：未用科目可改类别；有凭证/期初科目禁改类别但可改名；真实账套抽查。
 * 只读（内存副本，persist no-op）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
global.window = global;
global.Storage = { saveBook: () => Promise.resolve({ ok: true }), saveBackup: () => Promise.resolve({ ok: true }) };
const S = require('/Users/chen/财务软件/ty/js/store.js').store;
S.persist = () => {}; S.addLog = () => {}; S.backupNow = () => Promise.resolve(true);

let bad = 0;
const ck = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) bad++; };

// —— 合成账套用例 ——
S.state = {}; S.normalizeState();
S.state.subjects = [
  { code: '1001', name: '库存现金', cls: 'asset', normal: 'dr' },
  { code: '2202', name: '应付账款', cls: 'liability', normal: 'cr' },
  { code: '6002', name: '营业成本(测试未用)', cls: 'expense', normal: 'dr' }
];
S.state.openingBalances = { '2202': { dr: 0, cr: 500, yb: 0, ytdDr: 0, ytdCr: 0 } }; // 2202 有期初
S.state.vouchers = [{
  id: 'v1', word: '记', no: 1, date: '2026-01-05', status: 'audited', deleted: 'n', summary: 'x',
  entries: [{ code: '1001', name: '库存现金', summary: '', dr: 100, cr: 0 }]
}]; // 1001 有凭证
S._glCache = {};

let r;
r = S.updateSubject('6002', '营业成本(测试未用)', 'revenue');            // 未用：应可改
ck(r.ok && S.subject('6002').cls === 'revenue', '未用科目可改类别 ' + (r.msg || ''));
r = S.updateSubject('1001', '库存现金', 'liability');                     // 有凭证：应拒
ck(!r.ok && /不允许修改科目类别/.test(r.msg || ''), '有凭证科目禁改类别（' + (r.msg || '') + '）');
ck(S.subject('1001').cls === 'asset', '被拒后类别未变');
r = S.updateSubject('2202', '应付账款', 'asset');                         // 有期初：应拒
ck(!r.ok, '有期初科目禁改类别（' + (r.msg || '') + '）');
r = S.updateSubject('1001', '库存现金-改名', 'asset');                    // 类别不变改名：应允许
ck(r.ok && S.subject('1001').name === '库存现金-改名', '已用科目仍可改名');

// —— 真实账套抽查：改动类别均被拦、改名不拦 ——
const dir = '/Users/chen/Library/Application Support/心中有数/books';
fs.readdirSync(dir).filter(f => /\.json$/.test(f)).forEach(f => {
  const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  if (((data.vouchers || []).length) < 10) return;
  S.state = JSON.parse(JSON.stringify(data)); S.bookId = f; S._glCache = {};
  S.normalizeState();
  const used = S.state.subjects.find(s => S._subjectUsed(s.code));
  const unused = S.state.subjects.find(s => !S._subjectUsed(s.code) && s.enabled !== false);
  console.log('\n== ' + f + ' ==');
  if (used) {
    const other = (used.cls === 'asset') ? 'liability' : 'asset';
    const ru = S.updateSubject(used.code, used.name, other);
    ck(!ru.ok && /不允许修改科目类别/.test(ru.msg || ''), used.code + ' ' + used.name + '（在用）改类别被拒');
    ck(S.subject(used.code).cls === used.cls, '类别保持不变');
    const rn = S.updateSubject(used.code, used.name + '·', used.cls);
    ck(rn.ok, '在用科目可改名');
  }
  if (unused) {
    const other = (unused.cls === 'asset') ? 'expense' : 'asset';
    const rk = S.updateSubject(unused.code, unused.name, other);
    ck(rk.ok, unused.code + ' ' + unused.name + '（未用）可改类别');
  } else {
    console.log('  (无未使用科目，跳过改类别用例)');
  }
});
console.log('\n' + (bad === 0 ? '✅ M5 防呆验证全部通过' : '❌ ' + bad + ' 处不符'));
process.exit(bad === 0 ? 0 : 1);
