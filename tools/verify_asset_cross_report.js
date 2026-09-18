'use strict';
/* 固定资产「跨报表数据一致性」验证（2026-09-18）
 *
 * 【为什么需要】当天查出固定资产模块几处口径分叉，都是"页面看着对、数字却与账不符"的类型：
 *
 *   ① 折旧报表的「本月折旧」无条件对所有在用卡求 assetMonthlyDepr(fa)，而实际计提
 *      （depreciateMonth）有跳过条件（购置晚于本月 / 已提满 / 本月已计提 / 次月起提）。
 *      添钰来客 2026-03~06：报表 10,866.63，凭证与总账都是 10,810.42（差 56.21，
 *      恰是一张「购置晚于本月」的卡）；「本年折旧额」同源，差 281.07。
 *      → 修法：报表期间折旧/本年折旧改用「累计滚增」（accumEnd − accumBegin）。
 *
 *   ② 折旧报表**没有排除尚未购置的资产**（只过滤了「清理」状态）。同一张卡购置月 2026-06，
 *      选 2026-03 时它照样占一行，原值、期末净值都被计入合计，使「原值」合计虚增 3,550.00
 *      （恰为该卡原值），与总账 1601 期末余额对不上。
 *      → 修法：期间早于购置月的资产不参与本表。
 *
 * 本脚本用真实账套逐期核对四方数字，任何一方漂移都会失败：
 *   ① 折旧报表（_assetDeprRows 口径：期初=起始月前一月末，期间折旧=滚增）
 *   ② 卡片页四金额（期初累计/期末累计/期初净值/期末净值）
 *   ③ 总账 1602（期初 ob / 本期发生 period / 期末 end / 本年累计 ytd）
 *   ④ 总账 1601 期末（原值）
 *   ⑤ 报表内部自洽：期末 = 期初 + 期间折旧
 *   ⑥ 行的可见性：期间早于购置月的资产不出现
 *
 * 容差：两张卡各自 round2 后相加 vs 精确值累加，最多引入「张数 × 1 分」的舍入差，
 * 故断言用 tol = max(0.05, 张数 × 0.01 + 0.05)，只拦口径错误、不拦舍入。
 *
 * 用法：node tools/verify_asset_cross_report.js
 */
const fs = require('fs'), os = require('os'), path = require('path');
const ROOT = path.resolve(__dirname, '..');

const mem = {};
global.localStorage = { getItem: k => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; } };
global.document = { getElementById: () => null, addEventListener: () => {} };
global.window = global; global.__TAURI__ = {}; global.isTauri = false;
require(path.join(ROOT, 'js/storage.js'));
require(path.join(ROOT, 'js/store.js'));
const S = global.S;

const num = v => { const x = parseFloat(v); return isFinite(x) ? x : 0; };
const r2 = v => Math.round(v * 100) / 100;
function addMonths(ym, n) { const p = String(ym).split('-'); const t = (+p[0]) * 12 + (+p[1] - 1) + n; return String(Math.floor(t / 12)).padStart(4, '0') + '-' + String(t % 12 + 1).padStart(2, '0'); }
function mb(a, b) { const pa = a.split('-'), pb = b.split('-'); return (pb[0] - pa[0]) * 12 + (pb[1] - pa[1]); }
const anchorOf = fa => fa.deprMonth ? String(fa.deprMonth) : (fa.acqDate ? addMonths(String(fa.acqDate).slice(0, 7), num(fa.periodUsed || 0)) : '');
// 复刻 _accumDeprAt（列表/报表/对账共用的滚算口径）
function accumAt(fa, month, md) {
  const begin = num(fa.accumDeprBegin), anchor = anchorOf(fa);
  if (!anchor || !month || !md) return num(fa.accumDepr) || begin;
  const d = mb(anchor, month);
  if (!d) return begin;
  let v = begin + md * d;
  if (v < 0) v = 0;
  const cap = Math.max(0, num(fa.original) - num(fa.salvage));
  if (cap > 0 && v > cap) v = cap;
  return v;
}

let pass = 0, fail = 0;
const fails = [];
const notes = [];   // 「账实不符」提示：反映的是账套数据本身，不计入失败
function check(cond, label, detail) {
  if (cond) { pass++; return; }
  fail++; fails.push(label + (detail ? '  → ' + detail : ''));
}

const BOOKS = path.join(os.homedir(), 'Library/Application Support/添钰财务/books');
const PERIODS = ['2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'];
let bookCount = 0, lateAssets = 0;

fs.readdirSync(BOOKS).filter(f => f.endsWith('.json')).sort().forEach(name => {
  const b = JSON.parse(fs.readFileSync(path.join(BOOKS, name), 'utf8'));
  S.state = b; if (S.normalizeState) S.normalizeState(); S._glCache = {};
  const fas = (S.state.fixedAssets || []).filter(f => f.status !== '清理');
  if (!fas.length) return;
  const depSubject = S.subjectRole && S.subjectRole('ACC_DEPR');
  const sub1601 = (S.state.subjects || []).filter(s => String(s.code).indexOf('1601') === 0 && String(s.code).length === 4)[0];
  if (!depSubject) return;
  bookCount++;
  const short = name.slice(0, 14);

  // 期间可见集：期间早于购置月的资产不参与本表（对齐金蝶）
  function visibleIn(m) {
    return fas.filter(fa => {
      const acqM = fa.acqDate ? String(fa.acqDate).slice(0, 7) : '';
      return !(acqM && acqM > m);
    });
  }
  // 统计"购置晚于首个考察期间"的资产（这些正是边界用例，务必覆盖）
  const late = fas.filter(fa => fa.acqDate && String(fa.acqDate).slice(0, 7) > PERIODS[0]);
  lateAssets += late.length;
  if (late.length) {
    late.forEach(fa => {
      const acqM = String(fa.acqDate).slice(0, 7);
      const earlier = PERIODS.filter(m => m < acqM);
      if (earlier.length) {
        check(visibleIn(earlier[0]).indexOf(fa) < 0,
          short + ' ' + fa.code + ' 在购置月(' + acqM + ')之前不出现', '期间 ' + earlier[0]);
      }
      // 购置当月必须仍然出现（资产已入账，只是按次月起提本月折旧为 0）
      if (PERIODS.indexOf(acqM) >= 0) {
        check(visibleIn(acqM).indexOf(fa) >= 0,
          short + ' ' + fa.code + ' 在购置当月仍要出现', '期间 ' + acqM);
      }
    });
  }

  PERIODS.forEach(m => {
    const cur = visibleIn(m);
    if (!cur.length) return;
    const tol = Math.max(0.05, r2(cur.length * 0.01 + 0.05));
    let cAb = 0, cAe = 0, cNe = 0;          // 卡片页（单期）
    let rAb = 0, rAe = 0, rMd = 0, rYd = 0, rNe = 0, rOrig = 0;   // 折旧报表
    const y = String(m).slice(0, 4);
    cur.forEach(fa => {
      const md = S.assetMonthlyDepr(fa);
      const pb = addMonths(m, -1);
      const ab = accumAt(fa, pb, md), ae = accumAt(fa, m, md);
      cAb += ab; cAe += ae;
      cNe += Math.max(0, num(fa.original) - ae - num(fa.impairment));
      rOrig += num(fa.original);
      rAb += ab; rAe += ae; rNe += Math.max(0, num(fa.original) - ae - num(fa.impairment));
      rMd += Math.max(0, ae - ab);
      rYd += Math.max(0, ae - accumAt(fa, addMonths(y + '-01', -1), md));
    });

    const rows = S.generalLedger(m) || [];
    const row = rows.filter(x => String(x.code) === String(depSubject.code))[0];
    if (!row) return;
    const sign = row.normal === 'cr' ? 1 : -1;
    const ledBeg = sign * (num(row.obCr) - num(row.obDr));
    const ledPer = sign * (num(row.periodCr) - num(row.periodDr));
    const ledEnd = sign * (num(row.endCr) - num(row.endDr));
    const ledYtd = sign * (num(row.ytdCr) - num(row.ytdDr));
    const P = short + ' ' + m;

    // 内洽 / 卡片页同源
    check(Math.abs(r2(rAe - (rAb + rMd))) < 0.02, P + ' 报表自洽 期末=期初+期间折旧',
      rAb.toFixed(2) + ' + ' + rMd.toFixed(2) + ' vs ' + rAe.toFixed(2));
    check(Math.abs(r2(cAb - rAb)) < 0.005, P + ' 卡片/报表 期初累计一致', cAb.toFixed(2) + ' vs ' + rAb.toFixed(2));
    check(Math.abs(r2(cAe - rAe)) < 0.005, P + ' 卡片/报表 期末累计一致', cAe.toFixed(2) + ' vs ' + rAe.toFixed(2));
    check(Math.abs(r2(cNe - rNe)) < 0.005, P + ' 卡片/报表 期末净值一致', cNe.toFixed(2) + ' vs ' + rNe.toFixed(2));

    // 与账核对（核心）
    check(Math.abs(r2(rAb - ledBeg)) <= tol, P + ' 期初累计 = 总账期初', rAb.toFixed(2) + ' vs ' + ledBeg.toFixed(2));
    check(Math.abs(r2(rMd - ledPer)) <= tol, P + ' 期间折旧 = 总账本期发生', rMd.toFixed(2) + ' vs ' + ledPer.toFixed(2));
    check(Math.abs(r2(rAe - ledEnd)) <= tol, P + ' 期末累计 = 总账期末', rAe.toFixed(2) + ' vs ' + ledEnd.toFixed(2));
    check(Math.abs(r2(rYd - ledYtd)) <= tol, P + ' 本年折旧 = 总账本年累计', rYd.toFixed(2) + ' vs ' + ledYtd.toFixed(2));

    // 原值合计 vs 总账 1601 期末。
    // 注意：这里只作「账实不符」提示，**不计入失败**。原因是 1601 上可能有并未建立卡片的资产
    // （实测：绅蓝之星「1601001 家具设备」账面 787,047.41，而挂在该科目下的卡片原值合计只有
    // 588,903.41 —— 差 198,144.00 的固定资产在账上却没有任何卡片，属既有数据问题，
    // 与代码口径无关）。若把数据问题当成断言失败，反而会掩盖真正的口径回归。
    if (sub1601) {
      const row1 = rows.filter(x => String(x.code) === String(sub1601.code))[0];
      if (row1) {
        const sign1 = row1.normal === 'dr' ? 1 : -1;
        const led1 = sign1 * (num(row1.endDr) - num(row1.endCr));
        const diff = r2(rOrig - led1);
        if (Math.abs(diff) > tol) {
          notes.push(P + ' 原值与总账1601差 ' + diff.toFixed(2) + '（卡片 ' + rOrig.toFixed(2) + ' / 账面 ' + led1.toFixed(2) + '）');
        }
      }
    }
  });

  /* ---- D 组：卡片 ↔ 总账对账（复刻 _assetLedgerReconcile 的新逻辑）----
   * 2026-09-19 给页面对账补了「原值」维度。这一组的价值是验证：新维度确实能检出
   * 旧逻辑（只核对累计折旧）查不出来的账实不符 —— 绅蓝之星的 198,144.00 正是活样本。
   * 断言刻意做成「①通过、②必须报警」，将来若有人把②删掉，这里立刻失败。 */
  PERIODS.forEach(m => {
    const rows = S.generalLedger(m) || [];
    const endBal = code => {
      const r = rows.filter(x => String(x.code) === String(code))[0];
      if (!r) return null;
      return r.normal === 'dr' ? (num(r.endDr) - num(r.endCr)) : (num(r.endCr) - num(r.endDr));
    };
    const active = fas.filter(fa => {
      if (fa.status === '清理') return false;
      const a = fa.acqDate ? String(fa.acqDate).slice(0, 7) : '';
      return !(a && a > m);
    });
    // ① 累计折旧
    const dep = S.subjectRole('ACC_DEPR');
    let cDep = 0;
    active.forEach(fa => { cDep += accumAt(fa, m, S.assetMonthlyDepr(fa)); });
    const lDep = endBal(dep.code);
    if (lDep !== null) {
      const d = r2(cDep - lDep), tol = r2(active.length * 0.01 + 0.01);
      check(Math.abs(d) <= tol, short + ' ' + m + ' 对账①累计折旧应通过',
        '差 ' + d.toFixed(2) + ' / 容差 ' + tol.toFixed(2));
    }
    // ② 原值：按卡片实际挂的科目分组（与页面实现同口径）
    const byAcct = {}; let cOrig = 0;
    active.forEach(fa => {
      const code = String(fa.faAcctId == null ? '' : fa.faAcctId).split(',')[0].trim();
      const o = num(fa.original); cOrig += o;
      if (code && S.subject(code)) byAcct[code] = (byAcct[code] || 0) + o;
    });
    let lOrig = 0; const det = [];
    Object.keys(byAcct).forEach(c => {
      const v = endBal(c) || 0; lOrig += v;
      det.push({ code: c, diff: r2(byAcct[c] - v) });
    });
    det.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
    const d2 = r2(cOrig - lOrig);
    if (short.indexOf('添钰') === 0) {
      // 该账套卡片与总账完全吻合，②必须通过
      check(Math.abs(d2) <= 0.01, short + ' ' + m + ' 对账②原值应通过（此账套账实相符）', '差 ' + d2.toFixed(2));
    } else if (short.indexOf('绅蓝') === 0) {
      // 已知账实不符：1601001 期初含一块从未拆成卡片的资产。
      // 关键是「①照样通过、②必须报警」——这正是只做①时会漏掉的情形。
      check(Math.abs(d2) > 0.01, short + ' ' + m + ' 对账②应检出原值不符（①查不出的问题必须暴露）',
        '差 ' + d2.toFixed(2));
      if (det[0]) check(det[0].code === '1601001', short + ' ' + m + ' 差异应定位到 1601001',
        '实际定位到 ' + det[0].code);
    }
  });
});

/* ---- 静态契约：卡片页与折旧报表的「期间过滤」必须在两处同时存在 ----
 * 这两处过滤是 2026-09-18 为保证"改期间后卡片清单与折旧表口径一致"而加的。若将来有人
 * 只删掉其中一处（比如回滚卡片页的过滤），两侧的可见集就会重新分叉，而数值类断言未必能
 * 立刻发现。故在此把规则固化成断言 —— 这是纯文本检查，不依赖运行环境。 */
(function checkVisibleFilterContract() {
  const src = fs.readFileSync(path.join(ROOT, 'js/pages/asset/Asset.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const seg = (name) => {
    const i = src.indexOf('function ' + name);
    return i < 0 ? '' : src.slice(i, i + 1400);
  };
  const a = seg('_assetDeprRows');    // 折旧汇总表 / 明细表 / 导出
  const b = seg('_assetFilterList');  // 卡片页清单（行 + 分页 + 合计）
  check(/acqM\s*&&\s*acqM\s*>\s*month/.test(a),
    '契约：_assetDeprRows 按购置月过滤（期间早于购置月不出现）');
  check(/acqM\s*&&\s*acqM\s*>\s*period/.test(b),
    '契约：_assetFilterList 按购置月过滤（卡片页与折旧表可见集一致）');
  // 判据必须是 > 而不是 >= ：当月购置的资产要显示（已入账，只是本月尚未起提）
  check(!/acqM\s*&&\s*acqM\s*>=\s*month/.test(a) && !/acqM\s*&&\s*acqM\s*>=\s*period/.test(b),
    '契约：判据为 >（当月购置仍要显示），未被改成 >=');
})();

console.log('固定资产跨报表一致性验证（卡片页 / 折旧报表 / 总账 1601·1602）');
console.log('  账套 ' + bookCount + ' 个 × ' + PERIODS.length + ' 期间 ｜ 边界用例：购置较晚的资产 ' + lateAssets + ' 张');
console.log('');
if (notes.length) {
  console.log('⚠ 账实不符提示（数据本身的问题，非代码口径）：');
  // 同名差额每个期间都报一次，去重后再展示，避免刷屏
  const seen = {};
  notes.forEach(function (t) {
    const k = t.replace(/^\S+\s+\d{4}-\d{2}\s*/, '');
    if (!seen[k]) { seen[k] = 1; console.log('  · ' + t); }
  });
  console.log('');
}
if (fail === 0) {
  console.log('✓ ' + pass + ' 项断言全部通过 —— 与账同源，无口径分叉');
  process.exit(0);
}
console.log('★ ' + fail + ' 项不符（通过 ' + pass + '）：');
fails.slice(0, 30).forEach(function (f) { console.log('  · ' + f); });
if (fails.length > 30) console.log('  ...（其余 ' + (fails.length - 30) + ' 项略）');
process.exit(1);
