// 诊断：资产负债表不平衡 → 定位「有余额但未被任何报表项目规则覆盖」的科目
// 同时检查科目表编码隐患（前缀父子关系 vs 类别不一致）
'use strict';
const fs = require('fs');
const path = require('path');
const mem = {};
global.localStorage = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; } };
global.document = { getElementById: () => null, addEventListener() {} };
global.window = global;
global.__TAURI__ = {}; global.isTauri = false;
require(path.resolve(__dirname, '../js/storage.js'));
require(path.resolve(__dirname, '../js/store.js'));
const S = global.S;
function num(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }

const BOOK_DIR = path.resolve(process.env.HOME, 'Library/Application Support/心中有数/books');
const target = process.argv[2] || '添钰来客_合并_20260903_1788445713063.json';
const mm = process.argv[3] || '';
S.state = JSON.parse(fs.readFileSync(path.join(BOOK_DIR, target), 'utf8'));
S.bookId = target;
S.normalizeState(); S.ensureVoucherIds(); S.ensureCashFlowFields && S.ensureCashFlowFields();
S._glCache = {};

const st = S.state;
const subs = st.subjects || [];
const codes = subs.map((s) => String(s.code));
const byCode = {}; subs.forEach((s) => { byCode[String(s.code)] = s; });
function hasChild(c) { return codes.some((o) => o !== c && o.indexOf(c) === 0); }
const leaves = codes.filter((c) => !hasChild(c));

const rules = (st.reportRules && st.reportRules.balanceSheet)
  || (global.STANDARDS && global.STANDARDS.old.reportRules.balanceSheet);
const covered = {};
const ruleCodes = [];
['assetCurrent', 'assetNonCurrent', 'liaCurrent', 'liaNonCurrent', 'equity'].forEach((g) => {
  ((rules[g] || {}).items || []).forEach((it) => {
    (it.codes || []).concat(it.minus || []).forEach((c) => {
      ruleCodes.push(c);
      S.rollCodes(c).forEach((x) => { covered[x] = 1; });
    });
  });
});

const months = [];
(st.vouchers || []).forEach((v) => { const m = (v.date || '').slice(0, 7); if (m && months.indexOf(m) < 0) months.push(m); });
months.sort();
const m0 = mm || months[months.length - 1];

console.log('账套：' + target);
console.log('期间：' + m0 + ' | 规则科目码 ' + ruleCodes.length + ' 个 | 末级科目 ' + leaves.length + ' 个');

const gl = S.generalLedger(m0);
const glBy = {}; gl.forEach((r) => { glBy[String(r.code)] = r; });

console.log('\n【一、有期末余额但未被资产负债表规则覆盖的科目】（这些科目的钱"消失"了 → 报表不平）');
const miss = [];
leaves.forEach((c) => {
  const r = glBy[c];
  if (!r) return;
  const bal = (r.endDr - r.endCr);
  if (Math.abs(bal) < 0.005) return;
  if (covered[c]) return;
  miss.push({ c, name: r.name, cls: r.cls, bal: +bal.toFixed(2) });
});
if (!miss.length) console.log('    无（全部有余额科目均被覆盖）');
miss.sort((a, b) => Math.abs(b.bal) - Math.abs(a.bal));
miss.slice(0, 40).forEach((x) => console.log('    ' + x.c + ' ' + x.name + ' [' + x.cls + '] 余额=' + x.bal.toFixed(2)));
console.log('    合计影响：' + miss.reduce((s, x) => s + x.bal, 0).toFixed(2));

console.log('\n【二、科目编码隐患：前缀被当作父子但类别不一致】（上卷会串类）');
let bad = 0;
leaves.forEach((c) => {
  codes.forEach((o) => {
    if (o === c) return;
    if (c.indexOf(o) !== 0) return;
    const a = byCode[o], b = byCode[c];
    if (a.cls !== b.cls) {
      console.log('    ' + o + ' ' + a.name + '[' + a.cls + ']  ←被上卷←  ' + c + ' ' + b.name + '[' + b.cls + ']');
      bad++;
    }
  });
});
if (!bad) console.log('    无');

console.log('\n【三、按类别汇总校验（末级科目期末余额）】');
const sumByCls = {};
leaves.forEach((c) => {
  const r = glBy[c]; if (!r) return;
  const bal = r.endDr - r.endCr;
  sumByCls[r.cls] = (sumByCls[r.cls] || 0) + bal;
});
Object.keys(sumByCls).forEach((k) => console.log('    ' + k + ' = ' + sumByCls[k].toFixed(2)));
const bs = S.balanceSheet(m0);
console.log('\n【四、报表接口值】资产=' + bs.totalAsset.toFixed(2) + ' 负债=' + bs.totalLiability.toFixed(2) +
  ' 权益=' + bs.totalEquity.toFixed(2) + ' 负债+权益=' + bs.totalAll.toFixed(2) +
  ' 差额=' + (bs.totalAsset - bs.totalAll).toFixed(2));
// 按类别应有：资产 + 费用 = 负债 + 权益 + 收入
const asset = sumByCls.asset || 0, exp = sumByCls.expense || 0;
const lia = sumByCls.liability || 0, eq = sumByCls.equity || 0, rev = sumByCls.revenue || 0;
console.log('    类别恒等式 (资产+费用) - (负债+权益+收入) = ' + ((asset + exp) - (lia + eq + rev)).toFixed(2));
