#!/usr/bin/env node
'use strict';
/* ============================================================
 * tools/verify_asset_source.js —— 固定资产卡片「对源」验证（金蝶导出 xlsx ↔ 账套卡片）
 *
 * 【为什么有这个脚本】卡片**不来自 .ais**（KIS 账套不含固定资产，导入后 fixedAssets 为空），
 *   而是从金蝶导出的「固定资产卡片」xlsx 导入的。此前这条"对源"路径**零自动化覆盖**：
 *   · verify_asset_io.js     —— 只覆盖"导出/导入的单位往返"（自己造卡片、自己读回）；
 *   · verify_asset_cross_report.js —— 只覆盖"卡片 ↔ 总账"（内部一致性）。
 *   也就是说：卡片与**金蝶原始导出**是否一致，一直没人比过。本脚本补这一路。
 *
 * 【比什么】（来源与账套按编码配对）
 *   ① 确定性字段必须逐值相同：名称 / 部门 / 开始使用日期 / 原值 / 使用年限 / 残值率 / 残值 /
 *      折旧方法 / 状态 / 数量 / 规格 / 存放地点 / 使用人 / 备注 / **六个科目映射**
 *      · 类别：来源是**名称**、账套存**编码** → 用该账套自己的类别档案映射后再比（否则必假报）；
 *      · 金额：来源是「元」、账套是内部定点整数 → 经 util.yuan 换回元后比（±0.005 元）。
 *   ② 累计折旧（单独判据）：来源的「累计折旧额」↔ 账套的 accumDeprBegin，
 *      **差额必须恰为 1 期月折旧**（月折旧 =（原值 − 残值）/（年限 × 12））。
 *
 * 【为什么是"恰 1 期"而不是"相等"】账套的「期初累计折旧」锚定在**账套锚点月末**，
 *   比金蝶导出时点晚一个月 —— 这是既有设计（见 js/pages/asset/Asset.js 的字段说明：
 *   "它必须是【锚点月末】的余额，时点填错就会与总账差整期折旧"）。
 *   而账套的值才是与**金蝶 GLBal** 一致的那个（总账已由 verify_vs_ais.js 验证 0 差异，
 *   卡片↔总账由 verify_asset_cross_report.js 验证）—— 故"恰 1 期"才是正确形态，
 *   改成"要求相等"等于把正确的数据判成错的。
 *   ⚠ 别退回"差额 ≤ 某容差"：那会放过"多/少两个月"这类真错。
 *
 * 【已知的账套独有卡（白名单，不是漏网）】APP_ONLY_CODES 里的卡**不在**金蝶导出中 ——
 *   它们是在**应用里新增**的卡片（来源不可考，故不参与对源比对）。0091 之类新卡同理：
 *   若某天确实从金蝶新增了卡，请把编码从白名单移除，让它回到比对面。
 *
 * 【用法】
 *   node tools/verify_asset_source.js                      # 自动找 ~/Downloads/金蝶账套 ais 与账套目录
 *   TY_ASSET_SRC_DIR=<目录>  TY_ASSET_BOOK_DIR=<目录>      # 覆盖来源目录 / 账套目录（便于自测）
 *   node tools/verify_asset_source.js <来源xlsx目录> <账套目录>
 *   退出码：0 = 全部一致（或无来源可对）；1 = 存在差异
 *
 * 【来源位置 —— 已确认并固定记忆，别再满机找】
 *   目录：`~/Downloads/金蝶账套 ais/`（**不在仓库里**，故 git 里查不到）
 *     · 账套原文件：`添钰来客_2025年/2026年_金蝶KIS格式.ais`、`绅蓝之星_2024/2025/2026年_金蝶KIS格式.ais`
 *     · 固定资产卡片：两张金蝶导出 xlsx —— **卡片只在这两张 xlsx 里，`.ais` 不含固定资产**
 *       （KIS 账套本身没有固定资产表，导入后 `fixedAssets` 为空；卡片是从 xlsx 单独导进来的）
 *   ⚠ **文件名会变**：2026-10-01 实测从「…_卡片.xlsx」被改名为「… 固定资产卡片.xlsx」。
 *     故本脚本按「**目录固定 + 文件名含账套名**」匹配，**不写死文件名**；
 *     若一份都没匹配上，会把该目录里现有的 xlsx **全部列出来**（避免再次"找不到"）。
 * ============================================================ */

const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

/* ---------- 运行环境（与其他 store 测试同款） ---------- */
const mem = {};
global.localStorage = { getItem: k => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; } };
global.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() { } };
global.window = global; global.__TAURI__ = {}; global.isTauri = false;
require(path.join(ROOT, 'js', 'storage.js'));
require(path.join(ROOT, 'js', 'store.js'));
const U = global.util;                                   // 定点换算单点：yuan / AMT_SCALE
global.XLSX = require(path.join(ROOT, 'js', 'xlsx.full.min.js'));
require(path.join(ROOT, 'js', 'ty-io.js'));
const TyIo = global.TyIo;

if (!U || typeof U.yuan !== 'function' || U.AMT_SCALE !== 10000) {
  console.log('✗ 前置失败：util 定点底座不可用（yuan / AMT_SCALE=10000）');
  process.exit(1);
}

function appRoot() {
  const h = os.homedir();
  if (process.platform === 'darwin') return path.join(h, 'Library', 'Application Support', '添钰财务');
  if (process.platform === 'win32') return path.join(h, 'AppData', 'Roaming', '添钰财务');
  return path.join(h, '.local', 'share', '添钰财务');
}
const SRC_DIR = process.argv[2] || process.env.TY_ASSET_SRC_DIR || path.join(os.homedir(), 'Downloads', '金蝶账套 ais');
const BOOK_DIR = process.argv[3] || process.env.TY_ASSET_BOOK_DIR || path.join(appRoot(), 'books');

/* 账套里"应用内新增"的卡：来源不可考，不参与对源比对（见头注释） */
const APP_ONLY_CODES = ['0019'];

const yuan = n => U.yuan(n);
const norm = s => String(s == null ? '' : s).trim();
const money = n => (Math.round(Number(n || 0) * 100) / 100).toFixed(2);
const eqNum = (a, b, tol) => Math.abs(Number(a) - Number(b)) <= (tol == null ? 0.005 : tol);

let fail = 0, pass = 0, noted = 0;
function ck(cond, label, detail) {
  if (cond) { pass++; return; }
  fail++; console.log('  ✗ ' + label + (detail ? '  → ' + detail : ''));
}

/* ---------- 来源与账套 ---------- */
let xlsx = [];
try { xlsx = fs.readdirSync(SRC_DIR).filter(f => f.toLowerCase().endsWith('.xlsx')); } catch (e) { xlsx = []; }
let books = [];
try { books = fs.readdirSync(BOOK_DIR).filter(f => f.endsWith('.json') && f.indexOf('.bak') < 0); } catch (e) { books = []; }

if (!xlsx.length) {
  console.log('跳过：' + SRC_DIR + ' 下没有金蝶导出的卡片 xlsx（无来源可比）');
  console.log('  → 金蝶原始数据（含那两张固定资产卡片 xlsx）应放在 ~/Downloads/金蝶账套 ais/，');
  console.log('    见本文件头注释「来源位置」；若已挪走，用 TY_ASSET_SRC_DIR=<目录> 或第一个参数指定。');
  process.exit(0);
}
if (!books.length) {
  console.log('跳过：' + BOOK_DIR + ' 下没有账套文件');
  process.exit(0);
}

console.log('卡片对源验证（金蝶导出 xlsx ↔ 账套卡片）');
console.log('来源目录：' + SRC_DIR);
console.log('账套目录：' + BOOK_DIR);

let comparedBooks = 0;
books.forEach(function (bf) {
  const book = JSON.parse(fs.readFileSync(path.join(BOOK_DIR, bf), 'utf8'));
  const cards = book.fixedAssets || [];
  if (!cards.length) return;                                   // 无卡片的账套跳过（不算未对照）
  const bookName = norm(book.company && book.company.name);
  // 匹配规则：文件名含账套名；多个命中时优先带「卡片 / 固定资产」的（避免同目录里别的导出被选中）。
  const hits = xlsx.filter(f => bookName && f.indexOf(bookName) >= 0);
  const preferred = hits.filter(f => /卡片|固定资产/.test(f));
  const src = (preferred.length ? preferred : hits)[0];
  console.log('\n──── ' + bf.slice(0, 46) + '（卡片 ' + cards.length + ' 张）');
  if (hits.length > 1) {
    console.log('  · 该账套有 ' + hits.length + ' 个候选 xlsx，本次用：' + src +
      '（其余：' + hits.filter(f => f !== src).join('、') + '）');
  }
  if (!src) {
    console.log('  · 未找到该账套对应的卡片 xlsx（未对照）。' + SRC_DIR + ' 下现有 xlsx：');
    xlsx.forEach(f => console.log('      - ' + f));
    return;
  }
  comparedBooks++;

  const list = TyIo.parseAssetWorkbook(global.XLSX.read(fs.readFileSync(path.join(SRC_DIR, src)), { type: 'buffer' }));
  console.log('  来源：' + src + '（' + list.length + ' 张）');

  const catByCode = {};
  (book.assetCats || []).forEach(c => { catByCode[norm(c.code)] = norm(c.name); });
  const byCode = {}, srcByCode = {};
  cards.forEach(fa => { byCode[norm(fa.code)] = fa; });
  list.forEach(s => { srcByCode[norm(s.code)] = s; });

  // ① 只在一侧出现的卡
  const bookOnly = Object.keys(byCode).filter(c => !srcByCode[c]);
  const srcOnly = Object.keys(srcByCode).filter(c => !byCode[c]);
  const unexpectedBookOnly = bookOnly.filter(c => APP_ONLY_CODES.indexOf(c) < 0);
  const expectedBookOnly = bookOnly.filter(c => APP_ONLY_CODES.indexOf(c) >= 0);
  if (expectedBookOnly.length) console.log('  · 账套独有（白名单：应用内新增的卡）→ ' + expectedBookOnly.join(', '));
  ck(unexpectedBookOnly.length === 0,
    '不应出现"只在账套、却不在来源"的卡（除白名单外）', unexpectedBookOnly.join(', '));
  ck(srcOnly.length === 0, '来源里的卡都应在账套里（导入不得丢卡）', srcOnly.join(', '));

  // ② 逐卡比确定性字段
  let fieldBad = 0, deprBad = 0, deprOk = 0;
  Object.keys(srcByCode).forEach(function (code) {
    const s = srcByCode[code], b = byCode[code];
    if (!b) return;
    const diffs = [];
    if (norm(s.name) !== norm(b.name)) diffs.push('名称 "' + s.name + '" vs "' + b.name + '"');
    if (norm(s.dept) !== norm(b.dept)) diffs.push('部门 "' + s.dept + '" vs "' + b.dept + '"');
    if (norm(s.acqDate) !== norm(b.acqDate)) diffs.push('开始使用日期 "' + s.acqDate + '" vs "' + b.acqDate + '"');
    if (!eqNum(s.original, yuan(b.original))) diffs.push('原值 ' + s.original + ' vs ' + money(yuan(b.original)));
    if (!eqNum(s.life, b.life, 1e-9)) diffs.push('使用年限 ' + s.life + ' vs ' + b.life);
    if (!eqNum(s.salvageRate, b.salvageRate, 1e-9)) diffs.push('残值率 ' + s.salvageRate + ' vs ' + b.salvageRate);
    if (!eqNum(s.salvage, yuan(b.salvage))) diffs.push('残值 ' + s.salvage + ' vs ' + money(yuan(b.salvage)));
    if (norm(s.method) !== norm(b.method)) diffs.push('折旧方法 "' + s.method + '" vs "' + b.method + '"');
    if (norm(s.status) !== norm(b.status)) diffs.push('状态 "' + s.status + '" vs "' + b.status + '"');
    if (norm(s.qty) !== norm(b.qty)) diffs.push('数量 ' + s.qty + ' vs ' + b.qty);
    const mapped = catByCode[norm(b.category)];
    if (norm(s.category) && mapped && norm(s.category) !== mapped) diffs.push('类别 "' + s.category + '" vs 账套 ' + b.category + '(=' + mapped + ')');
    [['faAcctId', '固定资产科目'], ['accDeprAcct', '累计折旧科目'], ['deprFeeAcct', '折旧费用科目'],
      ['cleanAcct', '清理科目'], ['purchaseAcct', '购入对方科目'], ['impairAcct', '减值科目']].forEach(function (p) {
        const sv = norm(s[p[0]]), bv = norm(b[p[0]]);
        if (sv && sv !== bv) diffs.push(p[1] + ' "' + sv + '" vs "' + bv + '"');
      });
    [['spec', '规格型号'], ['location', '存放地点'], ['user', '使用人'], ['memo', '备注']].forEach(function (p) {
      const sv = norm(s[p[0]]), bv = norm(b[p[0]]);
      if (sv && sv !== bv) diffs.push(p[1] + ' "' + sv + '" vs "' + bv + '"');
    });
    if (diffs.length) { fieldBad++; console.log('  ✗ ' + code + ' ' + norm(b.name) + '：' + diffs.join('；')); }

    // ③ 累计折旧：差额必须恰为 1 期月折旧（锚点月末约定，见头注释）
    const monthly = (yuan(b.original) - yuan(b.salvage)) / (Number(b.life) * 12);
    const d = yuan(b.accumDeprBegin) - Number(s.accumDeprBegin);
    if (Math.abs(d) <= 0.005) { deprOk++; return; }             // 相同也算对（锚点正好对齐时）
    const k = monthly > 0 ? d / monthly : NaN;
    if (isFinite(k) && Math.abs(k - 1) < 0.01) { deprOk++; noted++; return; }
    deprBad++;
    console.log('  ✗ ' + code + ' ' + norm(b.name) + '：累计折旧 来源=' + money(s.accumDeprBegin) +
      ' 账套=' + money(yuan(b.accumDeprBegin)) + ' 差=' + money(d) +
      '（= ' + (isFinite(k) ? k.toFixed(3) : '?') + ' 期月折旧 ' + money(monthly) + '，应为 1.000 期）');
  });

  ck(fieldBad === 0, '确定性字段逐值一致（名称/部门/日期/原值/年限/残值率/残值/方法/状态/数量/类别/科目/文本）',
    fieldBad + ' 张有差异');
  ck(deprBad === 0, '累计折旧差额恰为 1 期月折旧（锚点月末约定）', deprBad + ' 张不符合');
  console.log('  ── 确定性字段一致 ' + (Object.keys(srcByCode).length - fieldBad) + '/' + Object.keys(srcByCode).length +
    ' 张；累计折旧符合约定 ' + deprOk + ' 张' + (noted ? '（其中 ' + noted + ' 张为 +1 期）' : ''));
});

console.log('');
if (!comparedBooks) {
  console.log('跳过：没有找到"账套 + 同名卡片 xlsx"的可对照组合');
  process.exit(0);
}
console.log(fail
  ? '结果：卡片对源 ✗ —— 对照 ' + comparedBooks + ' 本账套，' + fail + ' 项不符（通过 ' + pass + '）'
  : '结果：卡片对源 ✓ —— 对照 ' + comparedBooks + ' 本账套，' + pass + ' 项全部通过（' +
    '确定性字段逐值一致；累计折旧符合「锚点月末 +1 期」约定）');
process.exit(fail ? 1 : 0);
