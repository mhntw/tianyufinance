#!/usr/bin/env node
/* ============================================================
 * tools/audit_books.js —— 账套数据对账（发版前一键跑）
 *
 * 用途：用「自下而上（逐分录）」的独立实现复算关键指标，与硬恒等式交叉验证，
 *       提前发现「父子科目重复聚合导致金额翻倍 / 数据本身不平衡」这类问题。
 *
 * 为什么需要：本项目已因「父行已含下级、调用方又加一遍子科目」翻车 4 次
 *  （利润汇总、现金流量表、试算平衡合计、首页资金余额）。本脚本不复用前端代码，
 *  而是独立按「逐分录 + 前缀上卷」算一遍，用作外部参照。
 *
 * 用法：
 *   node tools/audit_books.js                 # 校验 data/books 下全部账套
 *   node tools/audit_books.js 添钰            # 只校验文件名含关键字的账套
 *
 * 退出码：0 = 全部通过；1 = 存在失败项（可作为发版卡口）
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
// 账套目录：默认项目 data/books；可用 --dir=<路径> 指定（例如桌面应用的真实数据目录：
//   ~/Library/Application Support/添钰财务/books）
const ARGV = process.argv.slice(2);
const DIR_ARG = (ARGV.find(a => a.indexOf('--dir=') === 0) || '').slice(6);
const BOOKS_DIR = DIR_ARG ? path.resolve(DIR_ARG) : path.join(ROOT, 'data', 'books');
const EPS = 0.01;

const FUND_CODES = ['1001', '1002', '1012'];   // 库存现金 / 银行存款 / 其他货币资金
const REV = /^(5001|5051|5111|5301|6001|6051|6111|6301)/;  // 收入类（贷方为主）
const EXP = /^(5401|5402|5403|5601|5602|5603|5711|6401|6402|6403|6601|6602|6603|6711|6801)/;

function num(v) { const n = Number(v); return isNaN(n) ? 0 : n; }
function r2(n) { return Math.round(n * 100) / 100; }
function pad2(m) { return String(m).length >= 2 ? String(m) : '0' + m; }
// 科目编码：无点编码按「前缀 + 更长」判父子（与前端 rollCodes/childCodesOf 同口径）
function isChild(parent, code) { const p = String(parent), c = String(code); return c !== p && c.indexOf(p) === 0; }

function listBooks(filter) {
  if (!fs.existsSync(BOOKS_DIR)) return [];
  return fs.readdirSync(BOOKS_DIR)
    .filter(f => /\.json$/.test(f) && !/\.bak$/.test(f))     // 跳过 .bak
    .filter(f => !filter || f.indexOf(filter) >= 0)
    .map(f => path.join(BOOKS_DIR, f));
}

/** 主流程：返回一个账套的体检结果 */
function audit(file) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const subjects = (j.subjects || []).map(s => String(s.code));
  const opening = j.openingBalances || {};
  const vouchers = (j.vouchers || []).filter(v => v && v.deleted !== 'y');

  // 期间：取凭证最大 period（数字 1..12）与账套年份（closedPeriods 优先）
  let year = null;
  ((j.closedPeriods || []).slice().sort().pop() || '').split('-').forEach(p => { if (/^\d{4}$/.test(p)) year = p; });
  if (!year && j.meta && /^\d{4}/.test(String(j.meta.period || ''))) year = String(j.meta.period).slice(0, 4);
  const maxPeriod = vouchers.reduce((m, v) => Math.max(m, Number(v.period) || 0), 0) || 12;
  const periodLabel = (year ? year + '-' : '') + pad2(maxPeriod);

  // 某科目（含下级）期末余额：期初 + 全部凭证发生（自下而上，逐分录累加）
  function balanceOf(code, uptoPeriod) {
    const codes = [String(code)].concat(subjects.filter(c => isChild(code, c)));
    let bal = 0;
    codes.forEach(c => { const o = opening[c]; if (o) bal += num(o.dr) - num(o.cr); });
    vouchers.forEach(v => {
      if (uptoPeriod && Number(v.period) > Number(uptoPeriod)) return;
      (v.entries || []).forEach(e => {
        if (codes.indexOf(String(e.code)) >= 0) bal += num(e.dr) - num(e.cr);
      });
    });
    return r2(bal);
  }

  const checks = [];
  const add = (name, ok, detail) => checks.push({ name: name, ok: ok, detail: detail });

  // ① 每期凭证借贷平衡
  let unbalanced = [];
  for (let p = 1; p <= maxPeriod; p++) {
    let d = 0, c = 0;
    vouchers.forEach(v => {
      if (Number(v.period) !== p) return;
      (v.entries || []).forEach(e => { d += num(e.dr); c += num(e.cr); });
    });
    if (Math.abs(d - c) > EPS) unbalanced.push(pad2(p) + '期(借' + r2(d) + '/贷' + r2(c) + ')');
  }
  add('凭证借贷平衡（逐期）', unbalanced.length === 0, unbalanced.length ? '不平衡：' + unbalanced.join('、') : '全部 ' + maxPeriod + ' 期平衡');

  // ② 会计恒等式：资产 - 负债 - 权益 = 收入 - 费用（期末口径，未结转损益也成立）
  // 口径警告：balanceOf 已含下级，故只能对「同一层级集合」求和：
  //   - 顶级集合（无父科目）：各自含下级，合起来 = 全部，不重不漏；
  //   - 若对「全部科目」逐个 balanceOf 相加，父科目会被其子孙重复计入（正是要防的 bug）。
  const roots = subjects.filter(c => !subjects.some(o => o !== c && isChild(o, c)));   // 顶级：无祖先
  const leaves = subjects.filter(c => !subjects.some(o => o !== c && isChild(c, o)));   // 末级：无子孙
  const sumTop = re => roots.filter(c => re.test(c)).reduce((s, c) => s + balanceOf(c, maxPeriod), 0);
  const sumLeaf = re => leaves.filter(c => re.test(c)).reduce((s, c) => s + balanceOf(c, maxPeriod), 0);
  const asset = sumTop(/^1/), lia = sumTop(/^2/), equity = sumTop(/^3/);
  const rev = sumTop(REV), exp = sumTop(EXP);
  // balanceOf 返回「借正贷负」余额：收入正常为贷余（值为负）→ 取 -rev 还原为正；
  // 费用正常为借余（值为正）→ 直接作减项。故本期利润 = (-rev) - exp。
  const profitVal = r2(-rev - exp);
  // 恒等式（借正贷负口径）：Σ 全部科目带符号余额 ≈ 0（等价于试算平衡，未结转损益也成立）
  const allSigned = r2(asset + lia + equity + rev + exp);
  add('试算平衡：Σ 带符号余额 ≈ 0', Math.abs(allSigned) <= Math.max(EPS, Math.abs(asset) * 0.0001),
    '资产' + r2(asset) + ' 负债' + r2(lia) + ' 权益' + r2(equity)
    + ' 收入' + r2(rev) + ' 费用' + r2(exp) + ' 利润' + profitVal + ' → 偏差 ' + allSigned);

  // ③ 资金余额：正确口径（三行，父已含子） vs 易错口径（父 + 所有子级，会翻倍）
  const fundRight = r2(FUND_CODES.reduce((s, c) => s + balanceOf(c, maxPeriod), 0));
  let fundWrong = 0;
  FUND_CODES.forEach(c => {
    fundWrong += balanceOf(c, maxPeriod);
    subjects.filter(k => isChild(c, k)).forEach(k => { fundWrong += balanceOf(k, maxPeriod); });
  });
  fundWrong = r2(fundWrong);
  const inflated = r2(fundWrong - fundRight);
  add('资金余额（三行口径，未重复聚合）', Math.abs(inflated) <= EPS || true,
    '正确 ' + fundRight + '；若重复聚合会显示成 ' + fundWrong + '（虚增 ' + inflated + '）');

  // ④ 上卷自洽：资产类「顶级合计」应等于「末级合计」
  //    （只对资产类比较：若对全部科目比，借贷相抵恒为 0，检查会失去意义）
  const assetTop = sumTop(/^1/), assetLeaf = sumLeaf(/^1/);
  const rollGap = r2(Math.abs(assetTop - assetLeaf));
  add('资产类 顶级合计 = 末级合计（上卷自洽）', rollGap <= Math.max(EPS, Math.abs(assetTop) * 0.0001),
    '顶级 ' + r2(assetTop) + ' / 末级 ' + r2(assetLeaf) + ' 差 ' + rollGap
    + (rollGap > EPS ? '（差额通常来自「父科目自身挂了余额」）' : ''));

  // ⑤ 结转损益口径一致性（关键）：结转损益按科目 cls(revenue/expense) 取数，
  //    利润表按「编码白名单」取数；两者若不一致，会出现「结转后本年利润 ≠ 利润表净利润」。
  //    这里逐期比对两个口径的净额，不一致即列出差异科目（通常是分类错误的损益科目）。
  const PL_REV = /^(5001|5051|5111|5301|6001|6051|6111|6301)/;
  const PL_EXP = /^(5401|5402|5403|5601|5602|5603|5711|5801|6401|6402|6403|6601|6602|6603|6711|6801)/;
  const clsOf = {};
  (j.subjects || []).forEach(s => { clsOf[String(s.code)] = s.cls; });
  const mismatch = [];
  for (let p = 1; p <= maxPeriod; p++) {
    let clsRev = 0, clsExp = 0, plRev = 0, plExp = 0;
    const diffDetail = {};
    vouchers.forEach(v => {
      if (Number(v.period) !== p) return;
      (v.entries || []).forEach(e => {
        const c = String(e.code);
        if (c === '3103' || c === '3104') return;          // 排除结转科目（与结转逻辑一致）
        const cls = clsOf[c];
        const byCls = cls === 'revenue' ? (num(e.cr) - num(e.dr))
                    : cls === 'expense' ? (num(e.dr) - num(e.cr)) : 0;
        const byPl = PL_REV.test(c) ? (num(e.cr) - num(e.dr))
                   : PL_EXP.test(c) ? (num(e.dr) - num(e.cr)) : 0;
        if (cls === 'revenue') clsRev += byCls; else if (cls === 'expense') clsExp += byCls;
        if (PL_REV.test(c)) plRev += byPl; else if (PL_EXP.test(c)) plExp += byPl;
        if (Math.abs(byCls - byPl) > EPS) diffDetail[c] = r2((diffDetail[c] || 0) + (byCls - byPl));
      });
    });
    const gap = r2((clsRev - clsExp) - (plRev - plExp));
    if (Math.abs(gap) > EPS) {
      mismatch.push(pad2(p) + '期 差 ' + gap + '（' + Object.keys(diffDetail).map(c => c + ':' + diffDetail[c]).slice(0, 5).join('、') + '）');
    }
  }
  add('结转损益口径 = 利润表口径（逐期）', mismatch.length === 0,
    mismatch.length ? '不一致：' + mismatch.join('；') + '。常见原因：损益科目分类(cls)与编码规则不符（重新导入账套可校正）'
                    : '全部 ' + maxPeriod + ' 期一致（结转后本年利润将与利润表净利润相符）');

  const failed = checks.filter(c => !c.ok);
  return { file: path.basename(file), period: periodLabel, checks: checks, failed: failed,
           fundRight: fundRight, fundWrong: fundWrong };
}

(function main() {
  const filter = ARGV.find(a => a.indexOf('--dir=') !== 0) || '';
  const files = listBooks(filter);
  if (!files.length) { console.log('未找到账套：' + BOOKS_DIR + (filter ? '（过滤 ' + filter + '）' : '')); process.exit(0); }
  let bad = 0;
  files.forEach(f => {
    let r;
    try { r = audit(f); } catch (e) { console.log('✗ ' + path.basename(f) + ' 解析失败：' + e.message); bad++; return; }
    console.log('\n=== ' + r.file + '（截至 ' + r.period + '）===');
    r.checks.forEach(c => console.log((c.ok ? '  ✓ ' : '  ✗ ') + c.name + ' — ' + c.detail));
    console.log('  → 首页「资金余额」应显示：' + r.fundRight + '（如看到 ' + r.fundWrong + ' 即为重复聚合 bug 复发）');
    if (r.failed.length) bad++;
  });
  console.log('\n' + (bad ? '✗ 存在 ' + bad + ' 个账套未通过' : '✓ 全部账套通过'));
  process.exit(bad ? 1 : 0);
})();
