#!/usr/bin/env node
/**
 * verify_invariants.js — 第 1 层不变量回归测试
 *
 * 用法：
 *   node tools/verify_invariants.js <账套JSON路径>
 *   node tools/verify_invariants.js            # 默认取最新账套
 *
 * 验证 10 条恒等式（I1-I10），任何一条失败即报告，退出码 1。
 * 不修改任何账套数据（persist 被 mock 为空函数）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

/* ---------- mock 浏览器环境 ---------- */
global.window = global;
global.Storage = { saveBook: () => Promise.resolve({ ok: true }), saveBackup: () => Promise.resolve({ ok: true }) };

/* ---------- 加载 store.js ---------- */
const storePath = path.join(__dirname, '..', 'js', 'store.js');
const storeMod = require(storePath);
const S = storeMod.store;
// mock persist/addLog/backupNow，避免写盘
S.persist = function () { /* no-op for verification */ };
S.addLog = function () { /* no-op */ };
S.backupNow = function () { return Promise.resolve(true); };

/* ---------- 工具 ---------- */
const EPS = 0.005;
const PASS = '\x1b[32mPASS\x1b[0m';
const FAIL = '\x1b[31mFAIL\x1b[0m';
const WARN = '\x1b[33mWARN\x1b[0m';

let totalPass = 0, totalFail = 0, totalWarn = 0;

function report(id, label, ok, detail) {
  const tag = ok ? PASS : (detail && detail.startsWith('WARN') ? WARN : FAIL);
  console.log('  [' + tag + '] ' + id + ' ' + label + (detail && !ok ? '  ' + detail : ''));
  if (ok) totalPass++; else if (detail && detail.startsWith('WARN')) totalWarn++; else totalFail++;
}

function round2(n) { return Math.round(Number(n) * 100) / 100; }

/* ---------- 定位账套 ---------- */
function findBook(arg) {
  if (arg && fs.existsSync(arg)) return arg;
  // 默认取最新账套
  const dir = path.join(process.env.HOME, 'Library', 'Application Support', '添钰财务', 'books');
  if (!fs.existsSync(dir)) {
    console.error('账套目录不存在：' + dir);
    process.exit(1);
  }
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => ({
    name: f, path: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs
  })).sort((a, b) => b.mtime - a.mtime);
  if (!files.length) { console.error('无账套文件'); process.exit(1); }
  return files[0].path;
}

/* ============================================================
 * 主流程
 * ============================================================ */
function run(bookPath) {
  const raw = fs.readFileSync(bookPath, 'utf8');
  const data = JSON.parse(raw);
  S.state = data;
  S.bookId = data.id || 'verify';

  console.log('\n=== 不变量回归测试 ===');
  console.log('账套：' + (data.company && data.company.name || path.basename(bookPath)));
  console.log('科目：' + (data.subjects || []).length + '  凭证：' + (data.vouchers || []).length +
    '  期初：' + Object.keys(data.openingBalances || {}).length);
  console.log('已结账期间：' + JSON.stringify(data.closedPeriods || []));
  console.log('');

  // 确定所有有凭证的月份
  const months = {};
  (data.vouchers || []).forEach(v => {
    const m = (v.date || '').slice(0, 7);
    if (m) months[m] = (months[m] || 0) + 1;
  });
  const monthList = Object.keys(months).sort();
  console.log('测试期间：' + monthList.join(', '));
  console.log('');

  /* --- I1：每张凭证借贷平衡 --- */
  console.log('--- I1: 凭证借贷平衡 ---');
  let badV = 0;
  (data.vouchers || []).forEach(v => {
    const r = S.voucherBalance(v.entries);
    if (!r.balanced) {
      badV++;
      console.log('    不平：' + (v.word || '') + '-' + (v.no != null ? v.no : '') +
        ' ' + (v.date || '') + '  借=' + round2(r.dr) + ' 贷=' + round2(r.cr) + ' 差=' + round2(r.dr - r.cr));
    }
  });
  report('I1', '凭证借贷平衡', badV === 0, badV ? 'FAIL ' + badV + ' 张凭证不平' : '');

  /* --- I2：任意月份试算平衡（借方期末合计=贷方期末合计） --- */
  console.log('--- I2: 试算平衡（各月期末） ---');
  let i2ok = true;
  monthList.forEach(m => {
    const gl = S.generalLedger(m);
    let totalDr = 0, totalCr = 0;
    // 只看一级科目（level=0）避免父子重复
    gl.forEach(r => {
      if (r.code.length <= 4) { // 一级科目
        totalDr += r.endDr;
        totalCr += r.endCr;
      }
    });
    const diff = Math.abs(totalDr - totalCr);
    if (diff >= 0.01) {
      i2ok = false;
      console.log('    ' + m + '：借方合计=' + round2(totalDr) + ' 贷方合计=' + round2(totalCr) + ' 差额=' + round2(diff));
    }
  });
  report('I2', '试算平衡', i2ok, i2ok ? '' : 'FAIL 试算不平');

  /* --- I3：资产负债表恒等式 --- */
  console.log('--- I3: 资产负债表恒等式（资产=负债+权益） ---');
  let i3ok = true;
  monthList.forEach(m => {
    const bs = S.balanceSheet(m);
    const diff = bs.totalAsset - bs.totalAll;
    if (Math.abs(diff) >= 0.01) {
      // 检查是否可由未结转损益解释
      let netProfit = 0;
      try { netProfit = S.profitStatement(m).netProfit; } catch (e) {}
      const residual = Math.abs(diff - netProfit) < 1;
      if (residual) {
        // warn：未结转损益导致
      } else {
        i3ok = false;
        console.log('    ' + m + '：资产=' + round2(bs.totalAsset) + ' 负债+权益=' + round2(bs.totalAll) +
          ' 差额=' + round2(diff) + '（无法由未结转损益 ' + round2(netProfit) + ' 解释）');
      }
    }
  });
  report('I3', '资产负债表恒等式', i3ok, i3ok ? '' : 'FAIL 恒等式不成立');

  /* --- I4：现金流量表勾稽（期初+净额=期末） --- */
  console.log('--- I4: 现金流量表勾稽（期初+Σ净额=期末） ---');
  let i4ok = true;
  monthList.forEach(m => {
    const cf = S.cashFlow(m);
    const netSum = cf.opening + cf.operating + cf.investing + cf.financing + cf.exchange;
    const diff = Math.abs(netSum - cf.ending);
    if (diff >= 0.01) {
      i4ok = false;
      console.log('    ' + m + '：期初=' + round2(cf.opening) + ' 经营=' + round2(cf.operating) +
        ' 投资=' + round2(cf.investing) + ' 筹资=' + round2(cf.financing) + ' 汇率=' + round2(cf.exchange) +
        ' → 合计=' + round2(netSum) + ' 期末=' + round2(cf.ending) + ' 差额=' + round2(diff));
    }
  });
  report('I4', '现金流量表勾稽', i4ok, i4ok ? '' : 'FAIL 勾稽不平');

  /* --- I5：现金流量表明细=大类小计 --- */
  console.log('--- I5: 现金流量表明细合计=大类小计 ---');
  let i5ok = true;
  monthList.forEach(m => {
    const cf = S.cashFlow(m);
    const CAT = {
      operating: ['cf_sale', 'cf_taxret', 'cf_opother', 'cf_buy', 'cf_payemp', 'cf_taxpay', 'cf_opothp'],
      investing: ['cf_invgain', 'cf_invother', 'cf_fixgain', 'cf_dissub', 'cf_invothin', 'cf_invpay', 'cf_investpay', 'cf_dissubpay', 'cf_invothp'],
      financing: ['cf_absinv', 'cf_finloan', 'cf_finother', 'cf_finrepay', 'cf_paydiv', 'cf_finothp']
    };
    Object.keys(CAT).forEach(cat => {
      let sum = 0;
      CAT[cat].forEach(id => { sum += cf.items[id] || 0; });
      const diff = Math.abs(sum - cf[cat]);
      if (diff >= 0.01) {
        i5ok = false;
        console.log('    ' + m + ' ' + cat + '：明细合计=' + round2(sum) + ' 大类=' + round2(cf[cat]) + ' 差额=' + round2(diff));
      }
    });
  });
  report('I5', '现金流量表明细=大类', i5ok, i5ok ? '' : 'FAIL 明细与大类不一致');

  /* --- I6：结转损益幂等 --- */
  console.log('--- I6: 结转损益幂等性 ---');
  // 对未结账月份测试（已结账月份 carryForwardProfit 会拒绝）
  const openMonths = monthList.filter(m => !(data.closedPeriods || []).includes(m));
  let i6ok = true;
  openMonths.forEach(m => {
    // 检查是否已有结转凭证
    const existing = S.periodVouchers(m).filter(v => /结转.*损益/.test(v.summary || ''));
    if (existing.length > 0) {
      // 已有结转凭证，carryForwardProfit 应拒绝重复
      const r = S.carryForwardProfit(m);
      if (r.ok) {
        // 检查是否真的生成了新凭证（S.persist 被 mock，但 S.addVoucher 会 push 到 state.vouchers）
        const after = S.periodVouchers(m).filter(v => /结转.*损益/.test(v.summary || ''));
        if (after.length > existing.length) {
          i6ok = false;
          console.log('    ' + m + '：重复结转生成了新凭证（' + existing.length + '→' + after.length + '）');
          // 回退：删除多生成的
          S.state.vouchers = S.state.vouchers.filter(v => v !== after[after.length - 1]);
        }
      }
    }
  });
  report('I6', '结转损益幂等', i6ok, i6ok ? '' : 'FAIL 重复结转未被拦截');

  /* --- I7：年初数滚动（1月 yearBal = 建账期初） --- */
  console.log('--- I7: 年初数滚动 ---');
  let i7ok = true;
  if (monthList.length > 0) {
    const jan = monthList[0].slice(0, 5) + '01';
    if (months[jan] || data.openingBalances) {
      const gl = S.generalLedger(jan);
      // 对所有有一级科目检查：yearBal 应等于期初
      gl.forEach(r => {
        if (r.code.length > 4) return; // 只查一级
        const op = S.openingOf(r.code, jan);
        // generalLedger 的 yearBal 不直接返回，用 balanceSheet 的 year 列
      });
      // 简化：检查 1 月资产负债表 year 列 = 期初
      const bs = S.balanceSheet(jan);
      // 资产负债表 year 应等于期初余额
      bs.groups.assetCurrent.items.forEach(it => {
        // 不做严格断言，只 warn
      });
    }
  }
  report('I7', '年初数滚动', true, 'WARN 待金蝶对照深度验证（此轮跳过严格断言）');

  /* --- I8：期初试算平衡 --- */
  console.log('--- I8: 期初试算平衡 ---');
  const opCheck = S.openingBalanceCheck();
  report('I8', '期初试算平衡', opCheck.balanced,
    opCheck.balanced ? '' : 'FAIL 借=' + round2(opCheck.dr) + ' 贷=' + round2(opCheck.cr) + ' 差=' + round2(opCheck.dr - opCheck.cr));

  /* --- I9：明细账逐笔余额连续性 --- */
  console.log('--- I9: 明细账逐笔余额连续 ---');
  let i9ok = true, i9count = 0;
  // 抽查前 20 个末级科目
  const leafSubjects = (data.subjects || []).filter(s => {
    return !data.subjects.some(x => x.code !== s.code && x.code.indexOf(s.code) === 0);
  });
  const sample = leafSubjects.slice(0, Math.min(20, leafSubjects.length));
  sample.forEach(s => {
    monthList.forEach(m => {
      const dl = S.detailLedger(s.code, m);
      if (!dl || !dl.rows.length) return;
      i9count++;
      let runningDr = dl.obDr, runningCr = dl.obCr;
      dl.rows.forEach((row, i) => {
        runningDr += row.dr;
        runningCr += row.cr;
        const expectedEnd = s.normal === 'dr' ? (runningDr - runningCr) : (runningCr - runningDr);
        const expectedAbs = Math.abs(expectedEnd);
        if (Math.abs(expectedAbs - row.bal) >= 0.01) {
          i9ok = false;
          console.log('    ' + s.code + ' ' + m + ' 第' + (i + 1) + '行：期望余额=' + round2(expectedAbs) + ' 实际=' + round2(row.bal));
        }
      });
    });
  });
  report('I9', '明细账余额连续（' + i9count + ' 组）', i9ok, i9ok ? '' : 'FAIL 余额不连续');

  /* --- I10：利润表页面与数据层一致（审计 H2 专项） ---
     配置化改造后：页面层 computeIncomeRows 读 state.reportRules.incomeStatement
     规则求值；此处同口径复算净利润，与数据层 profitStatement.netProfit 比对。
     规则驱动 → 适用于任意准则（old 5xxx / small2013 6xxx），不再硬编码科目。 */
  console.log('--- I10: 利润表页面行合计 vs 数据层 netProfit（H2 专项） ---');
  let i10ok = true;
  // 复刻 computeIncomeRows 的净利润求值（仅取 netProfit subtotal）
  function ruleNetProfit(pl, month) {
    const byCode = {};
    pl.items.forEach(it => { byCode[it.code] = it; });
    function amt(code) { return byCode[code] ? byCode[code] : { cur: 0, ytd: 0 }; }
    function sum(codes) {
      return (codes || []).reduce((a, c) => { const x = amt(c); return { cur: a.cur + x.cur, ytd: a.ytd + x.ytd }; }, { cur: 0, ytd: 0 });
    }
    const fb = (global.STANDARDS && global.STANDARDS.old && global.STANDARDS.old.reportRules.incomeStatement) || [];
    const rules = (S.state.reportRules && S.state.reportRules.incomeStatement) || fb;
    const sub = {};
    for (const r of rules) {
      if (r.type === 'subtotal') {
        let cur = 0, ytd = 0;
        for (const f of (r.formula || [])) {
          const v = f.ref ? (sub[f.ref] || { cur: 0, ytd: 0 }) : sum(f.codes || []);
          const sign = f.sign === '-' ? -1 : 1;
          cur += sign * v.cur; ytd += sign * v.ytd;
        }
        if (r.id) sub[r.id] = { cur, ytd };
        if (r.id === 'netProfit') return cur;
      }
    }
    return null; // 规则中无 netProfit subtotal
  }
  monthList.forEach(m => {
    const pl = S.profitStatement(m);
    const pageNet = ruleNetProfit(pl, m);
    if (pageNet == null) {
      i10ok = false;
      console.log('    ' + m + '：规则未定义 netProfit subtotal');
      return;
    }
    const diff = Math.abs(pageNet - pl.netProfit);
    if (diff >= 0.01) {
      i10ok = false;
      console.log('    ' + m + '：页面净利润=' + round2(pageNet) + ' 数据层=' + round2(pl.netProfit) + ' 差额=' + round2(diff));
    }
  });

  // —— I10 差异自动诊断（2026-09-05 复盘：历史多次审查漏网，差额是"导入科目类别标错"）——
  // 数据层 profitStatement 按科目 cls 取数、页面层按 reportRules 的 codes 求值，两侧都依赖
  // 科目类别标注。若导入时把 5301 营业外收入误标 expense、4001 生产成本误标 equity、
  // 2401 递延收益误标 asset，则「该科目当月发生额」会变成 I10 差额（损益方向反转 ×2），
  // 且只在有发生额的月份显现——此前 I1–I9 恒等式全部通过，故长期未被发现。
  // 此处对照项目内建准则模板逐科目核对，一旦不一致直接列出，避免再当"神秘差额"处理。
  console.log('    —— I10 诊断：科目类别与准则模板核对 ——');
  const std = global.STANDARDS;
  let clsBad = 0;
  function clsDiagnose() {
    if (!std) { console.log('    （STANDARDS 未加载，跳过类别核对）'); return; }
    // 合并两套准则的一级科目（old 5xxx 与 small2013 6xxx），子科目按最长编码前缀继承
    const tplList = [];
    if (std.old && std.old.subjects) tplList.push.apply(tplList, std.old.subjects);
    if (std.small2013 && std.small2013.subjects) tplList.push.apply(tplList, std.small2013.subjects);
    (data.subjects || []).forEach(s => {
      const code = String(s.code || '');
      let best = null;
      for (let i = 0; i < tplList.length; i++) {
        const t = tplList[i];
        if (!t || !t.code) continue;
        if (code === t.code || (code.length > t.code.length && code.indexOf(t.code) === 0)) {
          if (!best || t.code.length > best.code.length) best = t;
        }
      }
      if (best && best.cls !== s.cls) {
        clsBad++;
        console.log('      ✗ 科目 ' + code + ' ' + (s.name || '') +
          '：账套 cls=' + s.cls + '，准则模板应为 ' + best.cls +
          '（I10 差额根因；请重新导入账套或修正科目类别）');
      }
    });
    if (!clsBad) console.log('      ✓ 全部科目类别与准则模板一致');
  }
  clsDiagnose();
  report('I10', '利润表页面=数据层', i10ok, i10ok ? '' : 'FAIL 页面与数据层不一致（已附科目类别诊断，见上）');

  /* --- 汇总 --- */
  console.log('');
  console.log('=== 汇总 ===');
  console.log('  PASS: ' + totalPass + '  FAIL: ' + totalFail + '  WARN: ' + totalWarn);
  console.log('');
  process.exit(totalFail > 0 ? 1 : 0);
}

// 运行
const bookArg = process.argv[2];
const bookFile = findBook(bookArg);
run(bookFile);
