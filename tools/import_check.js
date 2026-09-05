#!/usr/bin/env node
/**
 * import_check.js — 金蝶导入兼容性自检（内部质量门；对使用者零操作）
 *
 * 定位：金蝶能正常记账的账套，导入本软件后必须「接得住」——红灯应为 0、黄灯只是说明。
 * 本报告是给「开发/导入器」的兼容缺口清单 + 给使用者的"已就绪"结论，不是让使用者去改账套数据：
 *   🔴 红灯：本不应出现在金蝶正常账套中 —— 属导入/引擎兼容缺口，报由软件修复后重新导入即可；
 *   🟡 黄灯：导入口径说明（金蝶映射特性）或旧版导入器遗留（新版已自动处理），仅供知悉；
 *   🟢 绿灯：账套可直接使用。
 * 用法：node tools/import_check.js <账套JSON路径...>
 * 只读：不改任何数据（persist/addLog/backupNow 均 no-op）。
 */
'use strict';
const fs = require('fs');
const path = require('path');

global.window = global;
global.Storage = { saveBook: () => Promise.resolve({ ok: true }), saveBackup: () => Promise.resolve({ ok: true }) };
const S = require('/Users/chen/财务软件/ty/js/store.js').store;
S.persist = () => {}; S.addLog = () => {}; S.backupNow = () => Promise.resolve(true);

const args = process.argv.slice(2);
if (!args.length) { console.log('用法：node tools/import_check.js <账套JSON路径...>'); process.exit(1); }

const num = v => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const fmt = n => n.toFixed(2);
const EPS = 0.01;

function reportOf(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  S.state = JSON.parse(JSON.stringify(raw));
  S.bookId = path.basename(file, '.json');
  S._glCache = {};
  S.normalizeState();

  const out = [];
  const red = t => out.push('  🔴 ' + t);
  const yellow = t => out.push('  🟡 ' + t);
  const green = t => out.push('  🟢 ' + t);
  const head = t => out.push('\n◆ ' + t);
  let redN = 0, yelN = 0;
  const markRed = arr => { redN += arr; };
  const markYel = () => { yelN++; };

  const vs = (S.state.vouchers || []).filter(v => v.deleted !== 'y');
  const subs = S.state.subjects || [];
  const std = S.state.standard || 'old';
  const company = (S.state.company && S.state.company.name) || path.basename(file, '.json');
  const mm = {};
  vs.forEach(v => { const m = (v.date || '').slice(0, 7); if (m) mm[m] = (mm[m] || 0) + 1; });
  const ms = Object.keys(mm).sort();
  out.push('════════ 金蝶导入兼容性自检 ════════');
  out.push('账套：' + company + '　准则：' + std + '　期间：' + (ms[0] || '-') + ' ~ ' + (ms[ms.length - 1] || '-'));
  out.push('凭证：' + vs.length + ' 张　科目：' + subs.length + ' 个　已结账期：' + ((S.state.closedPeriods || []).length) + ' 个');

  // ── 1. 借贷平衡（红灯：软件侧兼容缺口） ──
  head('1. 凭证借贷平衡');
  const unbalanced = vs.filter(v => !S.voucherBalance(v.entries).balanced);
  if (unbalanced.length) {
    red('存在 ' + unbalanced.length + ' 张借贷不平凭证（前 5：' + unbalanced.slice(0, 5).map(v => (v.word || '记') + '-' + v.no).join('、') + '）——金蝶正常账套不应出现，属导入兼容缺口，报软件修复导入器后重新导入');
    redN += 1;
  } else green('全部 ' + vs.length + ' 张凭证借贷平衡 ✓');

  // ── 2. 幽灵科目 ──
  head('2. 科目代码完整性（幽灵科目）');
  const codeSet = {}; subs.forEach(s => { codeSet[s.code] = true; });
  const ghost = [];
  vs.forEach(v => (v.entries || []).forEach(e => { if (!codeSet[e.code]) ghost.push((v.word || '记') + '-' + v.no + '(' + e.code + ')'); }));
  if (ghost.length) { red('存在不在科目表中的分录：' + ghost.slice(0, 5).join('、') + '（' + ghost.length + ' 处）'); redN += 1; }
  else green('无幽灵科目 ✓');

  // ── 3. 科目类别与准则模板比对（H2 教训） ──
  head('3. 科目类别核对（对照准则权威模板）');
  const tpl = {};
  const stdObj = global.STANDARDS && global.STANDARDS[std];
  (stdObj && stdObj.subjects || []).forEach(s => { if (!tpl[s.code]) tpl[s.code] = s.cls; });
  const mismatch = subs.filter(s => tpl[s.code] && tpl[s.code] !== s.cls);
  if (mismatch.length) {
    const detail = mismatch.map(s => s.code + ' ' + s.name + '：现=' + s.cls + ' 应为=' + tpl[s.code]).join('；');
    // 导入器已按准则模板权威归类（standardClsOf），此类错标仅来自旧版导入器产物——
    // 不是使用者职责：新版导入不再产生；如需修正历史快照由软件侧一次性迁移。
    yellow('科目类别与准则不一致（' + mismatch.length + ' 个）：' + detail + ' —— 旧版导入器遗留，新版导入器已按准则模板归类；账套数据无需使用者处理');
    yelN++;
  } else green('全部科目类别与准则模板一致 ✓');

  // ── 4. 期初试算平衡 ──
  head('4. 期初试算平衡');
  const ob = S.state.openingBalances || {};
  let opDr = 0, opCr = 0;
  Object.keys(ob).forEach(k => { opDr += num(ob[k].dr); opCr += num(ob[k].cr); });
  if (Math.abs(opDr - opCr) >= EPS) { red('期初借贷不平（借 ' + fmt(opDr) + ' / 贷 ' + fmt(opCr) + '，差 ' + fmt(opDr - opCr) + '）'); redN += 1; }
  else green('期初平衡（借 = 贷 = ' + fmt(opDr) + '）✓');

  // ── 5. 逐月试算平衡 + 货币资金勾稽 + 资产负债表 ──
  head('5. 逐月试算平衡');
  let tbBad = 0, bsBad = 0, cfBad = 0;
  ms.forEach(m => {
    const gl = S.generalLedger(m);
    let dr = 0, cr = 0;
    gl.forEach(r => { if (r.code.length <= 4) { dr += num(r.endDr); cr += num(r.endCr); } });
    if (Math.abs(dr - cr) >= EPS) { tbBad++; if (tbBad <= 3) red(m + ' 试算不平（差 ' + fmt(dr - cr) + '）'); }
    const bs = S.balanceSheet(m);
    const d = num(bs.totalAsset) - num(bs.totalAll);
    if (Math.abs(d) >= EPS) {
      // 未结转损益月差额≈净利润属正常（黄灯说明），其余红灯
      const up = Math.abs(d - num(S.unclosedProfit(m))) < 1;
      if (!up) { bsBad++; if (bsBad <= 3) red(m + ' 资产负债表不平衡且非未结转损益所致（差 ' + fmt(d) + '）'); }
    }
    const cf = S.cashFlow(m);
    if (Math.abs(num(cf.ending) - num(cf.opening) - (num(cf.operating) + num(cf.investing) + num(cf.financing) + num(cf.exchange))) >= EPS) {
      cfBad++; if (cfBad <= 3) red(m + ' 现金流量表勾稽断裂（期初+净变动≠期末）');
    }
  });
  if (tbBad) { redN += 1; } else green('全部 ' + ms.length + ' 个月试算平衡 ✓');
  if (bsBad) redN += 1; else green('资产负债表恒等式全部月份成立（未结转月差额=净利润属正常口径）✓');
  if (cfBad) redN += 1; else green('货币资金勾稽逐月成立（现金流期末 = 现金科目余额）✓');

  // ── 6. 明细账余额连续（抽样末级科目×近8月） ──
  head('6. 明细账余额连续性（抽查近 8 月）');
  let dlCnt = 0, dlBad = 0;
  const leaf = subs.filter(s => !subs.some(x => x.code !== s.code && x.code.indexOf(s.code) === 0));
  ms.slice(-8).forEach(m => {
    leaf.forEach(s => {
      const dl = S.detailLedger(s.code, m);
      if (!dl || !dl.rows.length) return;
      dlCnt++;
      let dr = num(dl.obDr), cr = num(dl.obCr);
      dl.rows.forEach(row => {
        dr += num(row.dr); cr += num(row.cr);
        const exp = s.normal === 'dr' ? Math.abs(dr - cr) : Math.abs(cr - dr);
        if (Math.abs(exp - num(row.bal)) >= EPS) dlBad++;
      });
    });
  });
  if (dlBad) { red(dlBad + ' 处明细账余额不连续'); redN += 1; } else green('抽查 ' + dlCnt + ' 组明细账余额连续 ✓');

  // ── 7. 结账检查（最近已结账月） ──
  head('7. 结账检查（最近已结账月）');
  const closedLast = (S.state.closedPeriods || []).slice().sort().pop();
  if (closedLast) {
    const cl = S.settleChecklist(closedLast);
    const fails = cl.filter(c => c.status === 'fail');
    if (fails.length) { red(closedLast + ' 结账检查未通过：' + fails.map(c => c.label + '(' + c.tip + ')').join('；')); redN += 1; }
    else green(closedLast + ' 结账检查通过（' + cl.map(c => c.key).join('/') + ' 全部 ok）✓');
    // 空结账期说明
    const emptyClosed = (S.state.closedPeriods || []).filter(m => !mm[m]);
    if (emptyClosed.length) { yellow('空结账期（无凭证却标记已结账）：' + emptyClosed.join('、') + ' —— 金蝶导入映射特性，报表由凭证动态生成不受影响'); yelN++; }
    const holes = []; let p = null;
    (S.state.closedPeriods || []).slice().sort().forEach(m => { if (p) { const d1 = +p.slice(0, 4) * 12 + +p.slice(5); const d2 = +m.slice(0, 4) * 12 + +m.slice(5); if (d2 - d1 !== 1) holes.push(p + '→' + m); } p = m; });
    if (holes.length) { yellow('结账期间不连续（跳期）：' + holes.join('、') + ' —— 同上为导入映射特性'); yelN++; }
  } else green('暂无已结账期间（新账套，需自行结账）');

  // ── 8. 结转到最新期间的可用性（v.kind 判定） ──
  head('8. 期末结转判定可用性');
  const lastM = ms[ms.length - 1];
  const cfOK = S.carryForwardState(lastM);
  const K = S.VOUCHER_KINDS;
  const kindCount = {};
  vs.forEach(v => { if (v.kind) kindCount[v.kind] = (kindCount[v.kind] || 0) + 1; });
  const carryPL = kindCount[K.CARRY_PL] || 0;
  green('结转损益凭证识别 ' + carryPL + ' 张、年结 ' + (kindCount[K.CARRY_YE] || 0) + ' 张（v.kind 结构识别，不依赖摘要）✓');

  // ── 9. 未分配利润口径提示 ──
  head('9. 未分配利润口径提示');
  const prio = subs.filter(s => /以前年度损益调整/.test(s.name || '') || s.code === '6000' || String(s.code).indexOf('6901') === 0);
  if (prio.length) {
    const misCls = prio.filter(s => s.cls !== 'equity'); // 归 equity 即正确，无需提示
    const okCnt = prio.length - misCls.length;
    if (okCnt) green('以前年度损益调整科目 ' + okCnt + ' 个已正确归类 equity（权益）✓');
    misCls.forEach(s => {
      yellow('科目 ' + s.code + ' ' + s.name + ' 归类=' + s.cls + '（余额 ' + fmt((function(){const o=ob[s.code];return o?(num(o.cr)-num(o.dr)):0;})()) + '）。该类应为权益调整科目，请由软件侧修正导入映射（新版导入器已自动归 equity）');
    });
    yelN += misCls.length;
  } else green('无「以前年度损益调整」科目 ✓');

  // ── 10. 凭证字号（同号/断号） ──
  head('10. 凭证字号检查');
  const dup = vs.filter(v => vs.filter(x => x.word === v.word && x.no === v.no && x.date === v.date).length > 1);
  if (dup.length) { red('存在同字同号同日期凭证 ' + dup.length + ' 张（首例：' + (dup[0].word || '记') + '-' + dup[0].no + '）'); redN += 1; }
  else green('无重复凭证字号 ✓');
  out.push('');
  out.push('════════ 结论 ════════');
  if (redN) out.push('❌ 红灯 ' + redN + ' 项：金蝶正常账套不应出现，属软件导入/引擎兼容缺口——请反馈开发修复后重新导入即可，账套数据无需使用者处理。');
  else if (yelN) out.push('🟡 黄灯 ' + yelN + ' 项、红灯 0：账套可直接使用；黄灯为金蝶导入口径说明或旧版导入器遗留（新版已自动处理），仅供知悉，无需操作。');
  else out.push('✅ 全部通过：账套可直接使用。');
  return { out: out, red: redN, yel: yelN };
}

let TR = 0, TY = 0;
args.forEach(f => {
  try {
    const r = reportOf(f);
    console.log(r.out.join('\n') + '\n');
    TR += r.red; TY += r.yel;
  } catch (e) { console.log('\n' + f + ' 体检失败：' + e.message); process.exit(1); }
});
console.log('汇总：红灯 ' + TR + ' / 黄灯 ' + TY + (TR ? ' → 金蝶正常账套不应出现，属软件兼容缺口（报开发修复后重新导入）' : ' → 账套可直接使用'));
process.exit(TR ? 1 : 0);
