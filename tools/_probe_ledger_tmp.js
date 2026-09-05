// 一次性诊断：用真实账套 json 验证账簿各表取数（跑完即删）
'use strict';
const path = require('path');
const fs = require('fs');
const mem = {};
global.localStorage = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; } };
global.document = { getElementById: () => null };
global.window = global;
global.__TAURI__ = {};
global.isTauri = false;
require(path.resolve(__dirname, '../js/storage.js'));
require(path.resolve(__dirname, '../js/store.js'));
const S = global.S;

const bookPath = process.argv[2];
const month = process.argv[3] || '2026-06';
const data = JSON.parse(fs.readFileSync(bookPath, 'utf-8'));

// 复用 restoreFromData 补全 state（会调 persist，需临时禁用写盘干扰）
S.persist = function () {};
S.bookId = 'probe';
const r = S.restoreFromData(data);
console.log('restore ok:', !!r.ok);

const subs = S.subjects();
console.log('科目数:', subs.length);

// 1) 总账
try {
  const gl = S.generalLedger(month);
  console.log('总账(' + month + ') 行数:', gl.length, gl[0] ? '样例:' + gl[0].code + ' ' + gl[0].name : '');
} catch (e) { console.log('总账 异常:', e.message); }

// 2) 明细账（随机取科目）
try {
  const code = subs[5] && subs[5].code;
  const dl = S.detailLedger(code, month);
  console.log('明细账(' + code + ',' + month + ') rows:', dl && dl.rows ? dl.rows.length : 0, dl && dl.rows.length ? '首行:' + dl.rows[0].summary : '');
} catch (e) { console.log('明细账 异常:', e.message); }

// 3) 试算平衡
try {
  const tb = S.trialBalance(month);
  console.log('试算平衡(' + month + ') rows:', tb && tb.length ? tb.length : (tb ? '(obj)' : 'null'), tb && tb.length ? tb[0] : '');
} catch (e) { console.log('试算平衡 异常:', e.message); }

// 4) 数量核算科目（qg/qd 前提）
console.log('数量核算科目数:', subs.filter(function (s) { return s.qty; }).length);

// 5) 核算项目（ax/ab/ac 前提）
const auxT = S.auxTypes();
console.log('AUX_TYPES 个数:', auxT.length, auxT.map(function (t) { return t.key; }).join(','));
console.log('科目是否有 aux 绑定:', subs.filter(function (s) { return s.aux || s.auxType; }).length);
