#!/usr/bin/env node
'use strict';
/* ============================================================
 * tools/verify_import_vchno.js —— 导入后「凭证号 == 金蝶 FNum」
 *
 * 【为什么需要】凭证号是凭证的唯一业务标识：会计拿「记-29」找凭证、审计按号追溯纸质
 *   凭证本，全靠它。2026-09-22 发现 kis-import.js 曾按「期内日期顺序」把凭证号从 1 重排，
 *   理由是「金蝶修改/加录凭证后会重写 FNum，界面显示的是期内位置序号」—— 实测该理由不成立：
 *     · 5 个账套、52 个「期间×凭证字」分组，FNum 全部严格 1..N 连续（无断号无重号）；
 *       （若金蝶真会重写 FNum，必然留下跳号，一个都没有）
 *     · 金蝶界面显示的正是 FNum：截图中 2026-08-27 那张显示「记-2」，而 8 月共 63 张凭证，
 *       按「期内位置」绝不可能是第 2 张；ais 中「期间8 号2 = 08-27 = 1001 8月现金收入」吻合；
 *     · 误判很可能源于把 GLVch.FSerialNum（**分录**行号，递增且值很大）当成了凭证号。
 *   该重编号曾让添钰来客 2026 年 447 张中 442 张（98.9%）被改号，且原号被覆盖、不可逆。
 *
 * 【本脚本做什么】真的跑一遍导入器（js/kis-import.js），把导入结果与 .ais 的
 *   (凭证字, 日期, FNum) 逐张对照，确保**没有任何一张被改号**。
 *
 * 用法：node tools/verify_import_vchno.js [.ais 路径…]（缺省时扫描本机常见位置）
 * 退出码：0 = 一致；1 = 有改号（回归）；无 .ais 样本时跳过（exit 0，CI 友好）
 * ============================================================ */
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

/* ---------- 定位 .ais 样本 ---------- */
function listAis() {
  const dirs = [
    '/Users/chen/Desktop',
    '/Users/chen/Downloads/金蝶账套 ais',
    '/Users/chen/Downloads',
    path.join(os.homedir(), 'Documents')
  ];
  const out = [];
  dirs.forEach(function (d) {
    try {
      if (!fs.existsSync(d)) return;
      fs.readdirSync(d).forEach(function (f) {
        if (/\.ais$/i.test(f)) out.push(path.join(d, f));
      });
    } catch (e) { }
  });
  return out;
}
const args = process.argv.slice(2).filter(function (a) { return a.indexOf('--') !== 0; });
const files = args.length ? args : listAis();

/* ---------- 浏览器环境 mock（导入器依赖 MDBReader / STANDARDS / document） ---------- */
global.window = global;
try { global.Buffer = require('buffer').Buffer; } catch (e) { }
global.document = {
  getElementById: function () { return null; },
  createElement: function () { return { style: {}, appendChild: function () { } }; },
  addEventListener: function () { }
};
(0, eval)(fs.readFileSync(path.join(ROOT, 'js', 'mdb-reader.js'), 'utf8'));
(0, eval)(fs.readFileSync(path.join(ROOT, 'js', 'standards.js'), 'utf8'));
(0, eval)(fs.readFileSync(path.join(ROOT, 'js', 'kis-import.js'), 'utf8'));

const READER = global.MDBReader.default;
function dstr(v) {
  const dt = v instanceof Date ? v : new Date(v);
  return isNaN(dt.getTime()) ? ''
    : (dt.getFullYear() + '-' + ('0' + (dt.getMonth() + 1)).slice(-2) + '-' + ('0' + dt.getDate()).slice(-2));
}
// ais 侧：凭证字|日期|FNum → true（GLVch 是分录行表，需按 字+日期+号 去重成凭证）
function sourceKeys(aisPath) {
  const rows = new READER(fs.readFileSync(aisPath)).getTable('GLVch').getData() || [];
  const m = {};
  rows.forEach(function (v) {
    if (parseInt(v.FDeleted || 0, 10) === 1) return;
    const w = String(v.FGroup == null ? '' : v.FGroup).trim() || '记';
    m[w + '|' + dstr(v.FDate) + '|' + parseInt(v.FNum, 10)] = true;
  });
  return m;
}

let FAIL = 0, TOTAL = 0, CHECKED = 0, SKIPPED = 0;
const tasks = files.map(function (f) {
  const name = path.basename(f);
  let res = null;
  try {
    res = sourceKeys(f);
  } catch (e) {
    console.log('  - ' + name + '：跳过（无法解析 → ' + e.message + '）');
    SKIPPED++;
    return null;
  }
  const srcN = Object.keys(res).length;
  if (!srcN) { SKIPPED++; return null; }
  CHECKED++;
  return global.KisImport.parse(fs.readFileSync(f)).then(function (out) {
    const vs = (out.ledger && out.ledger.vouchers) || [];
    let miss = 0;
    const samples = [];
    vs.forEach(function (v) {
      const key = String(v.word || '记') + '|' + String(v.date || '').slice(0, 10) + '|' + v.no;
      if (!res[key]) {
        miss++;
        if (samples.length < 5) samples.push(String(v.word || '记') + '-' + v.no + ' ' + String(v.date || '').slice(0, 10));
      }
    });
    TOTAL += vs.length;
    if (vs.length !== srcN || miss) {
      FAIL++;
      console.log('  ✗ ' + name + '：来源 ' + srcN + ' 张 / 导入 ' + vs.length + ' 张；对不上 ' + miss + ' 张');
      samples.forEach(function (s) { console.log('        · 找不到对应源凭证：' + s); });
    } else {
      console.log('  ✓ ' + name + '：' + vs.length + ' / ' + vs.length + ' 张凭证号与 FNum 逐张一致');
    }
  }).catch(function (e) {
    FAIL++;
    console.log('  ✗ ' + name + '：导入抛错 → ' + e.message);
  });
}).filter(Boolean);

if (!files.length) {
  console.log('跳过：本机没有 .ais 样本');
  process.exit(0);
}

console.log('导入凭证号一致性检查（真跑导入器，对照 .ais 的 FNum）');
Promise.all(tasks).then(function () {
  console.log('─'.repeat(70));
  if (!CHECKED) { console.log('跳过：无可用 .ais 样本' + (SKIPPED ? '（解析失败 ' + SKIPPED + ' 个）' : '')); process.exit(0); }
  console.log('账套 ' + CHECKED + ' 个　凭证合计 ' + TOTAL + ' 张　不一致账套 ' + FAIL + ' 个');
  if (FAIL) {
    console.log('❌ 有账套的凭证号被改写 ← 凭证号必须原样沿用金蝶 FNum（见文件头说明）');
    process.exit(1);
  }
  console.log('✅ 全部账套：导入后凭证号与金蝶 FNum 逐张一致 ✓');
  process.exit(0);
});
