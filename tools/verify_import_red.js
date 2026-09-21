#!/usr/bin/env node
'use strict';
/* ============================================================
 * 金蝶导入「红字（负数）」保留验证
 *
 * 【为什么需要这条】
 *   ty 曾把金蝶红字「借 -1,724.85」改写成「贷 +1,724.85」（负借=贷方、负贷=借方）。
 *   该改写是**信息破坏性**的：改写后它与真实的反方向业务长得完全一样，无法区分。
 *   后果是「本期发生额」按借贷双方合计列示，而金蝶与准则主流口径是净额（红字抵减），
 *   逐列对不上。现已改为**原样保留负数**，本脚本锁死该行为，防止以后被改回去。
 *
 * 【关键陷阱：mdb-reader 会消耗传入的 Buffer】
 *   实测：同一 Buffer 连续构造两个 MDBReader，第二次读到的数据里负数会全部变成正数
 *   （22 条 → 0 条）。故【每次读取都必须 fs.readFileSync 新建 Buffer】，绝不能复用。
 *   早期排查曾因此误判为「改动没生效」，白白绕了大弯 —— 记在这里，别再踩。
 *
 * 【验证项】
 *   1. 导入后的负数分录行数 == 金蝶 GLVch 原始负数行数（原样保留，不多不少）
 *   2. 每张凭证借贷平衡（不平凭证数 == 0）
 *   3. 全账套借方合计 == 贷方合计
 *   4. meta.redStyle === 'native'（科目余额表据此决定是否显示口径说明）
 *
 * 用法：node tools/verify_import_red.js [.ais路径]
 *   缺省时自动在常见位置寻找 .ais；找不到则跳过（保证无账套的 CI 环境同样通过）。
 * ============================================================ */
const fs = require('fs'), path = require('path'), os = require('os');

/* ---------- 定位 .ais ---------- */
const DEFAULT_AIS = [
  path.join(os.homedir(), 'Downloads/金蝶账套 ais/添钰来客_2026年_金蝶KIS格式.ais'),
  path.join(os.homedir(), 'Downloads/金蝶账套 ais/添钰来客_2025年_金蝶KIS格式.ais'),
  path.join(os.homedir(), 'Downloads/金蝶账套 ais/绅蓝之星_2026年_金蝶KIS格式.ais')
];
const AIS = process.argv[2] || DEFAULT_AIS.filter(fs.existsSync)[0];

if (!AIS || !fs.existsSync(AIS)) {
  console.log('（跳过：未找到金蝶 .ais 源文件，本环境不验证导入红字）');
  process.exit(0);
}

/* ---------- 加载依赖（与 contrast_pl_ais.js 同口径） ---------- */
global.window = global;
try { global.Buffer = require('buffer').Buffer; } catch (e) { }
(0, eval)(fs.readFileSync(path.join(__dirname, '..', 'js', 'mdb-reader.js'), 'utf8'));
global.MDBReader = global.MDBReader.default || global.MDBReader;
try {
  (0, eval)(fs.readFileSync(path.join(__dirname, '..', 'js', 'standards.js'), 'utf8'));
} catch (e) { /* 标准表可选 */ }
(0, eval)(fs.readFileSync(path.join(__dirname, '..', 'js', 'kis-import.js'), 'utf8'));

const R = function (n) { return Math.round((Number(n) || 0) * 100) / 100; };
let pass = 0, fail = 0;
function ck(ok, label, extra) {
  if (ok) { pass++; console.log('    ✓ ' + label); }
  else { fail++; console.log('    ✗ ' + label + (extra ? '  ' + extra : '')); }
}

console.log('=== 导入红字保留验证：' + path.basename(AIS) + ' ===');

/* ---------- ① 金蝶原始侧（独立 Buffer） ---------- */
/** 每次都要新建 Buffer —— 见文件头「关键陷阱」 */
function readNegRows() {
  const buf = fs.readFileSync(AIS);
  const rows = new global.MDBReader(buf).getTable('GLVch').getData() || [];
  return rows.filter(function (r) {
    if (r.FDeleted === true) return false;
    return (Number(r.FDebit) || 0) < 0 || (Number(r.FCredit) || 0) < 0;
  });
}
const negRows = readNegRows();

console.log('  金蝶原始 GLVch：负数分录 ' + negRows.length + ' 行');
if (negRows.length) {
  negRows.slice(0, 3).forEach(function (r) {
    console.log('      样例 ' + String(r.FAcctID).trim() +
      '  借=' + r.FDebit + '  贷=' + r.FCredit);
  });
}

/* ---------- ② 导入侧（全新 Buffer） ---------- */
const impBuf = fs.readFileSync(AIS);
const res = global.KisImport.convert(impBuf, path.basename(AIS));
const led = (res && res.ledger) || res;

let tyNeg = 0, badVch = 0, sumDr = 0, sumCr = 0;
(led.vouchers || []).forEach(function (v) {
  let d = 0, c = 0;
  (v.entries || []).forEach(function (e) {
    if ((Number(e.dr) || 0) < 0 || (Number(e.cr) || 0) < 0) tyNeg++;
    d += Number(e.dr) || 0;
    c += Number(e.cr) || 0;
  });
  if (Math.abs(d - c) > 0.01) badVch++;
  sumDr += d; sumCr += c;
});

console.log('  导入后：凭证 ' + (led.vouchers || []).length + ' 张，负数分录 ' + tyNeg + ' 行');
console.log('');

ck(tyNeg === negRows.length,
  '红字原样保留（金蝶 ' + negRows.length + ' 条 → ty ' + tyNeg + ' 条）',
  '若 ty 为 0，说明又退化成了「反方向正数」');
ck(badVch === 0, '每张凭证借贷平衡（不平 ' + badVch + ' 张）');
ck(Math.abs(R(sumDr) - R(sumCr)) < 0.01,
  '全账套借/贷合计相等（' + R(sumDr) + ' / ' + R(sumCr) + '）');
ck((led.meta || {}).redStyle === 'native',
  'meta.redStyle = native（科目余额表据此判断口径）',
  '实际=' + JSON.stringify((led.meta || {}).redStyle));

console.log('');
console.log('  小计：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
