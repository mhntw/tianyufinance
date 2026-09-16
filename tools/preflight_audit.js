// 投产前全面审计（只读，不修改任何账套）
//   A. 账套数据完整性：凭证借贷平衡 / 科目存在 / 金额合法 / 期初平衡 / 凭证号
//   B. 报表准确性：按月校验 科目余额表借贷平衡、资产负债表恒等式、现金流量恒等式、利润表勾稽
// 用法：node tools/preflight_audit.js
'use strict';

const fs = require('fs');
const path = require('path');

const mem = {};
global.localStorage = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; } };
global.document = { getElementById: () => null, addEventListener() {} };
global.window = global;
if (!global.navigator) global.navigator = { sendBeacon: () => true };
else if (!global.navigator.sendBeacon) { try { global.navigator.sendBeacon = () => true; } catch (e) {} }
global.__TAURI__ = {};
global.isTauri = false;
require(path.resolve(__dirname, '../js/storage.js'));
require(path.resolve(__dirname, '../js/store.js'));
const S = global.S;

const DIRS = [
  path.resolve(process.env.HOME, 'Library/Application Support/添钰财务/books'),
  path.resolve(__dirname, '../data/books')
];
const EPS = 0.005;
const BIG = 1; // 报表恒等式容差（分位取整误差）
function num(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }
const near = (a, b, e) => Math.abs(num(a) - num(b)) < (e === undefined ? EPS : e);

let G_FAIL = 0, G_WARN = 0;
function ck(cond, msg, detail) {
  if (cond) return true;
  G_FAIL++;
  console.log('    ✗ ' + msg + (detail ? '  → ' + detail : ''));
  return false;
}
function warn(cond, msg, detail) {
  if (cond) return true;
  G_WARN++;
  console.log('    ! ' + msg + (detail ? '  → ' + detail : ''));
  return false;
}

function collectBooks() {
  const out = [];
  DIRS.forEach((d) => {
    if (!fs.existsSync(d)) return;
    fs.readdirSync(d).filter((f) => f.endsWith('.json')).forEach((f) => {
      out.push(path.join(d, f));
    });
  });
  return out;
}

function loadBook(file) {
  const raw = fs.readFileSync(file, 'utf8');
  S.state = JSON.parse(raw);
  S.bookId = path.basename(file, '.json');
  if (S.state.schemaVersion == null) S.state.schemaVersion = 5;
  S.normalizeState();
  S.ensureVoucherIds();
  if (S.ensureBankAccounts) S.ensureBankAccounts();
  if (S.ensureCashFlowFields) S.ensureCashFlowFields();
  S._glCache = {};
  return S.state;
}

function allMonths(st) {
  const mm = {};
  (st.vouchers || []).forEach((v) => {
    const m = (v.date || '').slice(0, 7);
    if (/^\d{4}-\d{2}$/.test(m)) mm[m] = 1;
  });
  return Object.keys(mm).sort();
}

function leafCodes(st) {
  const codes = (st.subjects || []).map((s) => String(s.code));
  return codes.filter((c) => !codes.some((o) => o !== c && o.indexOf(c) === 0));
}

/* ---------- A. 凭证级数据完整性 ---------- */
function auditVouchers(st) {
  const res = { total: 0, badBalance: [], missingSubj: [], badAmount: [], badDate: [], emptyEntries: [], noId: [] };
  const subjSet = {};
  (st.subjects || []).forEach((s) => { subjSet[String(s.code)] = s; });
  (st.vouchers || []).forEach((v, i) => {
    if (v.deleted === 'y') return;
    res.total++;
    const entries = v.entries || [];
    let dr = 0, cr = 0;
    if (!entries.length) { res.emptyEntries.push({ i, word: v.word, no: v.no }); return; }
    entries.forEach((e) => {
      dr += num(e.dr); cr += num(e.cr);
      if (!subjSet[String(e.code)]) res.missingSubj.push({ i, code: e.code, word: v.word, no: v.no });
      if (e.dr !== undefined && e.dr !== '' && isNaN(parseFloat(e.dr))) res.badAmount.push({ i, f: 'dr', v: e.dr });
      if (e.cr !== undefined && e.cr !== '' && isNaN(parseFloat(e.cr))) res.badAmount.push({ i, f: 'cr', v: e.cr });
    });
    if (!near(dr, cr, 0.01)) res.badBalance.push({ i, word: v.word, no: v.no, date: v.date, dr, cr, diff: +(dr - cr).toFixed(2) });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v.date || '')) res.badDate.push({ i, word: v.word, no: v.no, date: v.date });
    if (!v.id) res.noId.push({ i, word: v.word, no: v.no });
  });
  return res;
}

/* ---------- B. 报表恒等式（按月） ---------- */
function auditReports(st, months) {
  const out = { bs: [], cf: [], gl: [], pl: [], unclosed: [] };
  const leaf = leafCodes(st);
  const leafSet = {};
  leaf.forEach((c) => { leafSet[c] = 1; });

  months.forEach((m) => {
    // 1) 科目余额表：末级科目借贷合计必须相等
    const gl = S.generalLedger(m);
    let obD = 0, obC = 0, pdD = 0, pdC = 0, edD = 0, edC = 0;
    gl.forEach((r) => {
      if (!leafSet[String(r.code)]) return;
      obD += num(r.obDr); obC += num(r.obCr);
      pdD += num(r.periodDr); pdC += num(r.periodCr);
      edD += num(r.endDr); edC += num(r.endCr);
    });
    if (!near(obD, obC, BIG) || !near(pdD, pdC, BIG) || !near(edD, edC, BIG)) {
      out.gl.push({ m, obDiff: +(obD - obC).toFixed(2), pdDiff: +(pdD - pdC).toFixed(2), edDiff: +(edD - edC).toFixed(2) });
    }

    // 2) 资产负债表恒等式：资产 = 负债 + 所有者权益 + 未结转损益净额
    //    （损益未结转时净损益仍挂在损益科目上，尚未进入 3103，需并入验证；
    //      若连此式都不平，说明账套数据/取数规则确实有问题）
    let bs = null;
    try { bs = S.balanceSheet(m); } catch (e) { out.bs.push({ m, err: e.message }); }
    if (bs) {
      let net = 0;
      gl.forEach((r) => {
        if (!leafSet[String(r.code)]) return;
        if (r.cls === 'revenue') net += num(r.endCr) - num(r.endDr);
        else if (r.cls === 'expense') net -= num(r.endDr) - num(r.endCr);
      });
      // 严格恒等式：未结转损益已并入「未分配利润」，故任何期间都应恒等成立
      const raw = num(bs.totalAsset) - num(bs.totalAll);
      if (Math.abs(raw) >= BIG) out.unclosed.push({ m, raw: +raw.toFixed(2), plNet: +net.toFixed(2) });
      if (!near(raw, 0, BIG)) out.bs.push({ m, asset: +bs.totalAsset.toFixed(2), lia: +bs.totalLiability.toFixed(2), eq: +bs.totalEquity.toFixed(2), plNet: +net.toFixed(2), diff: +raw.toFixed(2) });
    }

    // 3) 现金流量表恒等式：三项净额 + 汇率 = 期末现金 - 期初现金
    let cf = null;
    try { cf = S.cashFlow(m); } catch (e) { out.cf.push({ m, err: e.message }); }
    if (cf) {
      const net = num(cf.operating) + num(cf.investing) + num(cf.financing) + num(cf.exchange);
      const move = num(cf.ending) - num(cf.opening);
      if (!near(net, move, BIG)) out.cf.push({ m, net: +net.toFixed(2), move: +move.toFixed(2), diff: +(net - move).toFixed(2) });
    }

    // 4) 利润表：按页面规则口径（reportRules.incomeStatement）复算，必须与逐分录总额一致，
    //    且损益类科目必须被规则完整覆盖（漏覆盖 = 利润表少计收入/费用）
    let pl = null;
    try { pl = S.profitStatement(m); } catch (e) { out.pl.push({ m, err: e.message }); }
    if (pl) {
      const rules = (st.reportRules && st.reportRules.incomeStatement)
        || (global.STANDARDS && global.STANDARDS.small2013 && global.STANDARDS.small2013.reportRules.incomeStatement) || [];
      const byCode = {};
      (pl.items || []).forEach((it) => { byCode[it.code] = it; });
      const amt = (c) => { const it = byCode[c]; return it ? num(it.cur) : 0; };
      const allCodes = [];
      rules.forEach((r) => { (r.codes || []).forEach((c) => { if (allCodes.indexOf(c) < 0) allCodes.push(c); }); });
      // 规则取数覆盖的科目集合（含上卷子目）
      const covered = {};
      allCodes.forEach((c) => { S.rollCodes(c).forEach((x) => { covered[x] = 1; }); });
      // 损益类科目中本期有发生额但未被规则覆盖的
      const uncovered = [];
      (pl.items || []).forEach((it) => {
        if (num(it.cur) === 0) return;
        if (!covered[it.code]) uncovered.push({ code: it.code, name: it.name, cur: +num(it.cur).toFixed(2) });
      });
      // 规则覆盖的全部收入类/费用类科目（含营业外收入、投资收益等，与 totalRevenue 同口径）
      const clsSum = (want) => allCodes.filter((c) => {
        const sj = S.subject(c);
        return sj && sj.cls === want;
      }).reduce((s, c) => s + amt(c), 0);
      const ruleRev = clsSum('revenue');
      const ruleExp = clsSum('expense');
      const dRev = ruleRev - num(pl.totalRevenue);
      const dExp = ruleExp - num(pl.totalExpense);
      if (!near(dRev, 0, BIG) || !near(dExp, 0, BIG) || uncovered.length) {
        out.pl.push({ m, ruleRev: +ruleRev.toFixed(2), totalRev: +num(pl.totalRevenue).toFixed(2), ruleExp: +ruleExp.toFixed(2), totalExp: +num(pl.totalExpense).toFixed(2), uncovered: uncovered.slice(0, 6) });
      }
    }
  });
  return out;
}

/* ============ 主流程 ============ */
const files = collectBooks();
console.log('发现账套 ' + files.length + ' 个\n');

files.forEach((file) => {
  const name = path.basename(file);
  let st;
  try { st = loadBook(file); } catch (e) { console.log('==== ' + name + ' 加载失败: ' + e.message + '\n'); G_FAIL++; return; }

  const months = allMonths(st);
  console.log('==== ' + name);
  console.log('   公司=' + ((st.company || {}).name || '-') + ' 准则=' + (st.standard || '-') +
    ' 凭证=' + (st.vouchers || []).length + ' 科目=' + (st.subjects || []).length +
    ' 期初科目=' + Object.keys(st.openingBalances || {}).length +
    ' 已结账=' + JSON.stringify(st.closedPeriods || []) +
    ' 期间=' + months.length + '个' + (months.length ? '(' + months[0] + '~' + months[months.length - 1] + ')' : ''));

  // A. 凭证完整性
  const v = auditVouchers(st);
  console.log('  [A] 凭证完整性：有效 ' + v.total + ' 张');
  ck(v.badBalance.length === 0, 'A1 凭证借贷必须平衡', v.badBalance.length + ' 张不平衡 ' + JSON.stringify(v.badBalance.slice(0, 5)));
  ck(v.missingSubj.length === 0, 'A2 分录科目必须存在于科目表', v.missingSubj.length + ' 条悬空 ' + JSON.stringify(v.missingSubj.slice(0, 5)));
  ck(v.badAmount.length === 0, 'A3 金额必须是数字', JSON.stringify(v.badAmount.slice(0, 5)));
  ck(v.badDate.length === 0, 'A4 凭证日期格式合法', JSON.stringify(v.badDate.slice(0, 5)));
  ck(v.emptyEntries.length === 0, 'A5 无空分录凭证', JSON.stringify(v.emptyEntries.slice(0, 5)));
  ck(v.noId.length === 0, 'A6 凭证必须有稳定 id', JSON.stringify(v.noId.slice(0, 5)));

  // A7 期初余额借贷平衡
  const obc = S.openingBalanceCheck();
  ck(obc.balanced, 'A7 建账期初借贷平衡', '借 ' + obc.dr.toFixed(2) + ' / 贷 ' + obc.cr.toFixed(2));

  // A8 凭证号重复（同月同字同号）
  const dup = {};
  const dupList = [];
  (st.vouchers || []).forEach((x) => {
    if (x.deleted === 'y') return;
    const k = (x.date || '').slice(0, 7) + '|' + x.word + '|' + x.no;
    if (dup[k]) dupList.push(k); else dup[k] = 1;
  });
  warn(dupList.length === 0, 'A8 同月同字凭证号不重复', dupList.length + ' 组重复 ' + JSON.stringify(dupList.slice(0, 8)));

  // B. 报表恒等式
  if (!months.length) { console.log('  [B] 无凭证期间，跳过报表校验\n'); return; }
  const r = auditReports(st, months);
  console.log('  [B] 报表恒等式（' + months.length + ' 个期间）');
  ck(r.gl.length === 0, 'B1 科目余额表 借贷合计相等（期初/本期/期末）', JSON.stringify(r.gl.slice(0, 6)));
  ck(r.bs.length === 0, 'B2 资产 = 负债 + 所有者权益', JSON.stringify(r.bs.slice(0, 6)));
  ck(r.cf.length === 0, 'B3 现金流量三项净额 = 现金净变动', JSON.stringify(r.cf.slice(0, 6)));
  ck(r.pl.length === 0, 'B4 利润表规则取数 = 逐分录总额 且 损益科目全覆盖', JSON.stringify(r.pl.slice(0, 6)));
  if (r.unclosed.length) {
    console.log('    · 恒等式不成立期间：' + r.unclosed.map((x) => x.m + '(差' + x.raw.toFixed(2) + ')').join(' '));
  }

  // C. 板块台账 ↔ 总账 提示性对账（只提示、不计失败；若资产未全部经卡片管理，差异属正常）
  const faList = (st.fixedAssets || []).filter((f) => f && f.original && f.status !== '清理');
  if (faList.length && months.length) {
    const mLast = months[months.length - 1];
    const leafSet = {};
    leafCodes(st).forEach((c) => { leafSet[c] = 1; });
    let a1601 = 0;
    S.generalLedger(mLast).forEach((row) => {
      if (leafSet[String(row.code)] && String(row.code).indexOf('1601') === 0) {
        a1601 += num(row.endDr) - num(row.endCr);
      }
    });
    const cardSum = faList.reduce((s, f) => s + num(f.original), 0);
    warn(Math.abs(a1601 - cardSum) <= 1,
      'C1 固定资产卡片原值合计 = 科目 1601 期末余额',
      faList.length + ' 张卡片原值 ' + cardSum.toFixed(2) + ' vs 科目1601 期末 ' + a1601.toFixed(2) +
      '，差异 ' + (cardSum - a1601).toFixed(2) + ' 元（若存在手工/外部管理的固定资产请忽略）');
  }

  // D. 业务科目角色可解析性（防准则硬编码回归）：自动凭证所需角色能否在当前准则解析到科目。
  //    仅输出提示（不破坏「0 失败 0 警告」门禁）：旧账套可能天然缺 1603/1606 等科目，
  //    如需使用固定资产清理/减值请先在科目页添加。
  if (typeof S.subjectRole === 'function') {
    const roleLabels = {
      DEPR_FEE: '折旧费用(管理费用)', PAYROLL_FEE: '工资费用(管理费用)', ACC_DEPR: '累计折旧',
      FA_ASSET: '固定资产', FA_CLEAN: '固定资产清理', FA_IMPAIR: '固定资产减值准备',
      PAYROLL_PAYABLE: '应付职工薪酬', BANK: '银行存款',
      PROFIT_YEAR: '本年利润', PROFIT_RESIDUAL: '利润分配', COST_PROD: '生产成本', COST_INV: '库存商品'
    };
    const missing = Object.keys(roleLabels).filter((role) => !S.subjectRole(role));
    if (missing.length) {
      console.log('    · [D] ' + ((st.company || {}).name || name) + ' 科目角色缺失：' +
        missing.map((r) => r + '(' + roleLabels[r] + ')').join('、') + '（不使用对应模块可忽略）');
    }
  }
  console.log('');
});

console.log('========== 汇总：失败 ' + G_FAIL + ' 项，警告 ' + G_WARN + ' 项 ==========');
process.exit(G_FAIL ? 1 : 0);
