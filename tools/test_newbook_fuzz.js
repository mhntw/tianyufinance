#!/usr/bin/env node
/* ============================================================
 * tools/test_newbook_fuzz.js —— 「新建账套 + 代入随机数据」的不变量随机测试（fuzz）
 *
 * 【为什么要有它】
 *   既有测试基本是「固定输入 → 固定期望」（sim_vouchers 手写场景、e2e 走一遍主流程）。
 *   而「新建账套」是唯一没有外部数据可参照的入口：科目表、凭证、结账/反结账的
 *   组合空间极大，固定用例覆盖不到边界组合 —— 跨月同号、软删后占号、结账期写入、
 *   负数（红字）分录、0.01 小数、显式撞号、逐期结账与反结账的交替 …… 这些才是
 *   真实使用中最容易踩坏数据的地方。
 *   本脚本用**可复现的伪随机序列**（固定种子）反复施加这些操作，每一步之后校验
 *   会计不变量；一旦被破坏，打印种子与复现命令，可直接原样重跑定位。
 *
 * 【安全】Storage 全部替换为内存实现，全程零 fs 调用 —— 从原理上不可能触碰真实账套
 *   （与 test_import_e2e.js / test_book_manage_e2e.js 同一约定，不靠路径校验去兜）。
 *
 * 【为什么默认固定种子】随机测试若每次都换种子，CI 会 flaky（今天绿明天红），
 *   让人对红色脱敏。固定种子 = 可复现的确定性回归；--seed 供主动探索新路径。
 *
 * 用法：
 *   node tools/test_newbook_fuzz.js                 # 默认种子 20260929 / 200 步
 *   node tools/test_newbook_fuzz.js --seed 7        # 换种子探索
 *   node tools/test_newbook_fuzz.js --steps 800     # 加步数（更深）
 * ============================================================ */
'use strict';
const path = require('path');

/* ---------- 浏览器环境 mock（store.js 依赖） ---------- */
const mem = {};
global.localStorage = {
  getItem: k => (k in mem ? mem[k] : null),
  setItem: (k, v) => { mem[k] = String(v); },
  removeItem: k => { delete mem[k]; }
};
global.document = {
  getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  createElement: () => ({ style: {}, appendChild() {}, setAttribute() {}, classList: { add() {}, remove() {} } }),
  addEventListener() {}
};
global.window = global;
global.__TAURI__ = {}; global.isTauri = false;
try { global.navigator = { userAgent: 'node' }; } catch (e) { /* Node 21+ 内置只读 navigator */ }

require(path.resolve(__dirname, '../js/storage.js'));
require(path.resolve(__dirname, '../js/store.js'));
const S = global.S, Storage = global.Storage;

/* ---------- 内存 Storage（零 fs） ---------- */
const books = {};
let metaStore = { last_book: null, disabled: {} };
Storage.init = () => { global.__refreshAll = () => {}; return Promise.resolve({ ok: true }); };
Storage.saveBook = (id, json) => { books[id] = json; return Promise.resolve({ ok: true }); };
Storage.loadBook = (id) => Promise.resolve(books[id] || null);
Storage.deleteBook = (id) => { delete books[id]; return Promise.resolve({ ok: true }); };
Storage.listBooks = () => Promise.resolve(Object.keys(books));
Storage.readMeta = () => Promise.resolve(JSON.parse(JSON.stringify(metaStore)));
Storage.writeMeta = (m) => { metaStore = (typeof m === 'string') ? JSON.parse(m) : m; return Promise.resolve({ ok: true }); };
Storage.getDataDir = () => Promise.resolve('<内存模式>');
Storage.saveBackup = () => Promise.resolve({ ok: true });
Storage.listBackups = () => Promise.resolve([]);
Storage.loadBackup = () => Promise.resolve(null);

/* ---------- 参数 ---------- */
const argv = process.argv.slice(2);
function argVal(name, def) { const i = argv.indexOf(name); return (i >= 0 && argv[i + 1] != null) ? argv[i + 1] : def; }
const SEED = Number(argVal('--seed', 20260929)) >>> 0;
const STEPS = Math.max(10, Number(argVal('--steps', 200)) | 0);
const REPRO = 'node tools/test_newbook_fuzz.js --seed ' + SEED + ' --steps ' + STEPS;

/* ---------- 可复现伪随机（mulberry32） ---------- */
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
let rnd = mulberry32(SEED);
const rndInt = n => Math.floor(rnd() * n);

/* ---------- 小工具 ---------- */
const num = v => { const n = Number(v); return isNaN(n) ? 0 : n; };
const round2 = n => Math.round(num(n) * 100) / 100;
const EPS = 0.005;
const pad2 = n => String(n).padStart(2, '0');
const vmonth = v => String((v && v.date) || '').slice(0, 7);           // 与 store.voucherMonth 同口径（date 优先）
const sumDr = es => (es || []).reduce((s, e) => s + num(e.dr), 0);
const sumCr = es => (es || []).reduce((s, e) => s + num(e.cr), 0);
function shiftMonth(m, d) {
  let [y, mm] = String(m).split('-').map(Number);
  const t = y * 12 + (mm - 1) + d;
  return Math.floor(t / 12) + '-' + pad2(t % 12 + 1);
}

/* ---------- 断言 ---------- */
let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return true; }
  fail++;
  const line = name + (detail ? '  ' + detail : '');
  failures.push(line);
  console.error('  ✗ ' + line);
  return false;
}

/* ============================================================
 * 建账：新建一个**空账套**，启用期间设为过去 8 个月，
 * 使随机凭证可以铺满 [启用月, 当前月] 这一整段期间。
 * ============================================================ */
const now = new Date();
const curMonth = now.getFullYear() + '-' + pad2(now.getMonth() + 1);
const startMonth = shiftMonth(curMonth, -8);
const RANGE = [];
for (let m = startMonth; m <= curMonth; m = shiftMonth(m, 1)) RANGE.push(m);

const BOOK_NAME = '随机测试账套';
const bookId = S.newBook(BOOK_NAME, 'small2013', startMonth);
S._glCache = {};

console.log('═══════════════════════════════════════════════════════════');
console.log(' 新建账套随机测试（fuzz）');
console.log('═══════════════════════════════════════════════════════════');
console.log('  账套      ' + BOOK_NAME + '（' + bookId + '）');
console.log('  启用期间  ' + startMonth + '    当前月 ' + curMonth + '    可用期间 ' + RANGE.length + ' 个');
console.log('  种子      ' + SEED + '    步数 ' + STEPS);
console.log('  复现      ' + REPRO);

// 开箱可用性（新建账套必须自带科目表，否则随机测试无从下手）
check('新建账套自带科目表', (S.state.subjects || []).length > 10, '科目数=' + (S.state.subjects || []).length);
check('新建账套启用期间已设为 ' + startMonth, S.state.company.startMonth === startMonth, S.state.company.startMonth);

/* ============================================================
 * 科目池
 *   只用「被资产负债表规则覆盖的末级权益/资产负债科目」作为随机记账对象 ——
 *   这样「资产 = 负债 + 所有者权益」是**必须恒成立**的硬不变量；
 *   若某科目其实没被报表规则覆盖，恒等式就会破，恰是我们要抓的真缺陷。
 *   另单独备一份损益类科目池，用于低频制造「需结转损益」的场景。
 * ============================================================ */
function bsMappedCodes() {
  const set = new Set();
  const rules = (S.state.reportRules && S.state.reportRules.balanceSheet) || {};
  Object.keys(rules).forEach(k => {
    const g = rules[k]; if (!g || !g.items) return;
    g.items.forEach(it => {
      (it.codes || []).forEach(c => set.add(String(c)));
      (it.minus || []).forEach(c => set.add(String(c)));
    });
  });
  return set;
}
const mapped = bsMappedCodes();
const isLeaf = s => !(S.state.subjects || []).some(o => o !== s && String(o.code).indexOf(String(s.code)) === 0);
const coveredByBS = s => { let hit = false; mapped.forEach(m => { if (String(s.code).indexOf(m) === 0) hit = true; }); return hit; };
const allSubj = S.state.subjects || [];
let POOL = allSubj.filter(s => ['asset', 'liability', 'equity'].indexOf(s.cls) >= 0
  && s.code !== '3103' && s.code !== '3104' && isLeaf(s) && coveredByBS(s));
if (POOL.length < 4) POOL = allSubj.filter(s => ['asset', 'liability'].indexOf(s.cls) >= 0 && isLeaf(s)); // 报表规则缺失时兜底
const POOL_PL = allSubj.filter(s => ['revenue', 'expense'].indexOf(s.cls) >= 0 && isLeaf(s));
const LEAF_CODES = new Set(allSubj.filter(isLeaf).map(s => s.code));   // 试算平衡求和用（见 I4 注释）
console.log('  科目池    ' + POOL.length + ' 个（资产负债表科目）/ ' + POOL_PL.length + ' 个（损益科目）');
check('随机科目池足够（>=4）', POOL.length >= 4, 'pool=' + POOL.length);

/* ============================================================
 * 随机凭证生成
 * ============================================================ */
function randAmt() {
  const p = rnd();
  if (p < 0.05) return 0.01;                      // 最小金额（浮点边界）
  if (p < 0.10) return 999999.99;                 // 大额
  if (p < 0.22) return Math.round(rnd() * 5000 * 100) / 100;  // 任意两位小数
  return Math.round(rnd() * 9000 + 100);          // 整元
}
// 把 totalC（单位：分）随机切成 n 份，每份 >= 1 分
function splitCents(totalC, n) {
  if (totalC < n) totalC = n;
  const cuts = new Set();
  while (cuts.size < n - 1) cuts.add(1 + rndInt(totalC - 1));
  const arr = [...cuts].sort((a, b) => a - b);
  const parts = []; let prev = 0;
  arr.forEach(c => { parts.push(c - prev); prev = c; });
  parts.push(totalC - prev);
  return parts;
}
function pickSubj(pool) { return pool[rndInt(pool.length)]; }
const WORDS = ['记', '收', '付', '转'];

// 生成一张**借贷平衡**的凭证；opts.word/no 可强制指定（用于撞号用例）
function makeVoucher(month, opts) {
  opts = opts || {};
  const nD = 1 + rndInt(2), nC = 1 + rndInt(2);
  const totalC = Math.max(Math.round(randAmt() * 100), nD + nC);
  const drParts = splitCents(totalC, nD).map(c => c / 100);
  const crParts = splitCents(totalC, nC).map(c => c / 100);
  let entries = [];
  drParts.forEach(a => { const s = pickSubj(POOL); entries.push({ code: s.code, name: s.name, dr: a, cr: 0 }); });
  crParts.forEach(a => { const s = pickSubj(POOL); entries.push({ code: s.code, name: s.name, dr: 0, cr: a }); });
  // 12% 掺入损益科目：制造「本期需结转损益」，让结账路径真正被走到
  if (POOL_PL.length && rnd() < 0.12) {
    const drIdx = entries.findIndex(e => num(e.dr) !== 0);
    const crIdx = entries.findIndex(e => num(e.cr) !== 0);
    if (drIdx >= 0 && rnd() < 0.5) { const s = POOL_PL.filter(x => x.cls === 'expense')[rndInt(Math.max(1, POOL_PL.filter(x => x.cls === 'expense').length))] || pickSubj(POOL_PL); entries[drIdx].code = s.code; entries[drIdx].name = s.name; }
    if (crIdx >= 0 && rnd() < 0.7) { const rs = POOL_PL.filter(x => x.cls === 'revenue'); const s = rs.length ? rs[rndInt(rs.length)] : pickSubj(POOL_PL); entries[crIdx].code = s.code; entries[crIdx].name = s.name; }
  }
  // 15% 追加一组「负数分录（红字冲减）」：借 -X / 贷 -X 同额成对，余额不受影响
  if (rnd() < 0.15) {
    const x = round2(1 + rnd() * 999);
    const a = pickSubj(POOL), b = pickSubj(POOL);
    entries.push({ code: a.code, name: a.name, dr: -x, cr: 0 });
    entries.push({ code: b.code, name: b.name, dr: 0, cr: -x });
  }
  return {
    word: opts.word || (rnd() < 0.72 ? (S.state.param.voucherWord || '记') : WORDS[rndInt(4)]),
    no: (opts.no != null ? opts.no : undefined),
    date: month + '-' + pad2(1 + rndInt(28)),
    attach: 0,
    summary: '随机凭证',
    entries: entries
  };
}

/* ---------- 不变量 ---------- */
function dupKeys() {
  const seen = {}, dup = [];
  (S.state.vouchers || []).forEach(v => {
    const k = (v.word || '记') + '#' + v.no + '@' + vmonth(v);
    if (seen[k]) dup.push(k); else seen[k] = 1;
  });
  return dup;
}
function checkInvariants() {
  const vs = S.state.vouchers || [];
  // I1 每张凭证（含已软删）借贷必须平衡
  const bad = vs.filter(v => Math.abs(sumDr(v.entries) - sumCr(v.entries)) >= EPS);
  check('I1 所有凭证借贷平衡', bad.length === 0, bad.slice(0, 3).map(v => v.word + '-' + v.no).join(','));
  // I2 同月同凭证字下字号唯一（软删凭证仍占号 → 必须一并计入）
  const dup = dupKeys();
  check('I2 同月同字号唯一（含软删）', dup.length === 0, dup.slice(0, 3).join(','));
  // I3 任何凭证的期间都落在 [启用月, 当前月]（不允许账套外期间）
  const out = vs.filter(v => { const m = vmonth(v); return !(m >= startMonth && m <= curMonth); });
  check('I3 凭证期间在[启用月,当前月]内', out.length === 0, out.slice(0, 3).map(v => v.word + '-' + v.no + '@' + vmonth(v)).join(','));
  // I4 试算平衡：**末级科目**本年累计借方合计 = 贷方合计。
  // 【为什么用 ytd 而不是 end】损益类科目在 generalLedger 里期初恒为 0（按年结转清零的口径），
  // 其期末余额只含本期发生额；因此拿 endDr/endCr 跨类别求和并不构成试算平衡。ytd 口径
  // 覆盖当年 1 月~本月全部发生额，末级行求和恒等于全部凭证借贷合计，才是真不变量。
  // 【为什么必须限定末级】generalLedger 每行已按 rollCodes 上卷（父行 = 自身 + 全部下级），
  // 若把父子行一起求和，下级金额会被重复计入，和恒不为零 —— 那是取数口径，不是账不平。
  const gl = (S.generalLedger(curMonth) || []).filter(r => LEAF_CODES.has(r.code));
  const d = gl.reduce((s, r) => s + num(r.ytdDr), 0), c = gl.reduce((s, r) => s + num(r.ytdCr), 0);
  check('I4 总账试算平衡（本年累计借合计=贷合计）', Math.abs(d - c) < 0.01, '差=' + round2(d - c));
  // I5 资产负债表恒等式
  const bs = S.balanceSheet(curMonth);
  const diff = round2(num(bs.totalAsset) - num(bs.totalLiability) - num(bs.totalEquity));
  check('I5 资产 = 负债 + 所有者权益', Math.abs(diff) < 0.01,
    '差=' + diff + '  A=' + num(bs.totalAsset) + '  L+E=' + round2(num(bs.totalLiability) + num(bs.totalEquity)));
}

/* ============================================================
 * 随机操作
 * ============================================================ */
const skipClose = new Set();     // 因真缺陷无法结账的月份（避免每步重复刷同一失败）
const stats = { add: 0, gate: 0, del: 0, restore: 0, close: 0, reopen: 0, carry: 0 };

function activeIn(month) { return (S.state.vouchers || []).filter(v => v.deleted !== 'y' && vmonth(v) === month); }
function isSorted(a) { for (let i = 1; i < a.length; i++) if (a[i - 1] > a[i]) return false; return true; }

function opAdd() {
  const mode = rnd();
  // ① 早于启用月 → 必须被拒
  if (mode < 0.06) {
    const m = shiftMonth(startMonth, -(1 + rndInt(3)));
    const r = S.addVoucher(makeVoucher(m));
    stats.gate++;
    return check('闸门：早于启用月的凭证被拒', r && r.ok === false && /早于账套启用期间/.test(r.msg || ''), JSON.stringify(r));
  }
  // ② 未来月 → 必须被拒
  if (mode < 0.12) {
    const m = shiftMonth(curMonth, 1 + rndInt(3));
    const r = S.addVoucher(makeVoucher(m));
    stats.gate++;
    return check('闸门：未来月的凭证被拒', r && r.ok === false && /晚于当前月份/.test(r.msg || ''), JSON.stringify(r));
  }
  // ③ 已结账月 → 必须被拒
  const closed = (S.state.closedPeriods || []).slice();
  if (mode < 0.20 && closed.length) {
    const m = closed[rndInt(closed.length)];
    const r = S.addVoucher(makeVoucher(m));
    stats.gate++;
    return check('闸门：已结账月新增被拒', r && r.ok === false && /已结账/.test(r.msg || ''), JSON.stringify(r));
  }
  // ④ 借贷不平 → 必须被拒（且不得入库）
  if (mode < 0.28) {
    const openM = openMonths();
    if (!openM.length) return;
    const v = makeVoucher(openM[rndInt(openM.length)]);
    v.entries.push({ code: POOL[0].code, name: POOL[0].name, dr: 1, cr: 0 });   // 故意只加借方
    const before = (S.state.vouchers || []).length;
    const r = S.addVoucher(v);
    stats.gate++;
    check('闸门：借贷不平被拒', r && r.ok === false && /不平/.test(r.msg || ''), JSON.stringify(r));
    return check('闸门：被拒的脏凭证未入库', (S.state.vouchers || []).length === before);
  }
  // ⑤ 显式指定已存在的字号 → 撞号必须被拒（含软删凭证的号）
  if (mode < 0.34) {
    const closedNow = S.state.closedPeriods || [];
    const all = (S.state.vouchers || []).filter(v => closedNow.indexOf(vmonth(v)) < 0);  // 只用未结账月，确保拒绝原因确实是撞号
    if (!all.length) return;
    const v0 = all[rndInt(all.length)];
    const r = S.addVoucher(makeVoucher(vmonth(v0), { word: v0.word || '记', no: v0.no }));
    stats.gate++;
    return check('闸门：同月同字号撞号被拒', r && r.ok === false && /已存在字号/.test(r.msg || ''), JSON.stringify(r));
  }
  // ⑥ 正常新增到未结账月
  const openM = openMonths();
  if (!openM.length) return;
  const v = makeVoucher(openM[rndInt(openM.length)]);
  const r = S.addVoucher(v);
  stats.add++;
  return check('正常凭证被接受并入库', !!(r && r.id), JSON.stringify(r));
}

function openMonths() {
  const closed = S.state.closedPeriods || [];
  return RANGE.filter(m => closed.indexOf(m) < 0);
}

function opDel() {
  const closed = S.state.closedPeriods || [];
  const cands = (S.state.vouchers || []).filter(v => v.deleted !== 'y' && closed.indexOf(vmonth(v)) < 0);
  if (!cands.length) return;
  const v = cands[rndInt(cands.length)];
  const m = vmonth(v), word = v.word || '记', no = v.no;
  const r = S.removeVoucher(v.id, 'fuzz 删除');
  if (!check('未结账期凭证可删除', r && r.ok === true, JSON.stringify(r))) return;
  stats.del++;
  check('删除为软删（凭证仍在账套中）', (S.state.vouchers || []).some(x => x.id === v.id && x.deleted === 'y'));
  // 已删凭证仍占号：同月同字号不得被复用（审计线索）
  const rr = S.addVoucher(makeVoucher(m, { word: word, no: no }));
  check('已删凭证仍占号（同月同字号不可复用）', rr && rr.ok === false, JSON.stringify(rr));
}

function opRestore() {
  const closed = S.state.closedPeriods || [];
  const cands = (S.state.vouchers || []).filter(v => v.deleted === 'y' && closed.indexOf(vmonth(v)) < 0);
  if (!cands.length) return;
  const v = cands[rndInt(cands.length)];
  const r = S.restoreVoucher(v.id);
  if (!check('未结账期已删凭证可还原', r && r.ok === true, JSON.stringify(r))) return;
  stats.restore++;
  check('还原后不再带 deleted 标记', v.deleted !== 'y');
}

/* 结账一个期间（含「被结转损益拦截」时的恢复逻辑）；返回 { r, dbg }。
 * 恢复路径完全按应用自身的提示走：
 *   · 未结转 → 结转损益；
 *   · 已结转但检查仍要结转（结转后又发生损益，或损益凭证被删产生"孤立结转"）
 *     → 先删除过时的结转凭证，再结转 / 或直接结账。
 *   若这样都救不回来，才是真正的死锁（属产品缺陷，必须报出来）。 */
function attemptClose(m) {
  let r = S.closePeriod(m);
  if (r && r.ok === false && r.warnOnly) r = S.closePeriod(m, { force: true });   // 仅提醒项 → 强制结账（与 UI 一致）
  let dbg = '';
  const blockedByCarry = () => r && r.ok === false && (r.fails || []).some(f => f.key === 'carry');
  if (blockedByCarry()) {
    let c = S.carryForwardProfit(m);
    // 用 state 判定比正则可靠：'stale' = 结转凭证与当前损益不一致（孤立结转），
    // 按应用提示"先删除旧结转凭证再重新生成"；'ok' 理论上不会被 carry 拦截，兜底一并处理。
    if (c && c.ok === false && (c.state === 'stale' || c.state === 'ok')) {
      const olds = (c.vouchers || []).filter(v => v.deleted !== 'y');
      olds.forEach(v => S.removeVoucher(v.id, 'fuzz 重做结转'));
      dbg += ' | 清除过时结转凭证 ' + olds.length + ' 张';
      c = S.carryForwardProfit(m);
    }
    dbg += ' | 结转返回：' + JSON.stringify({ ok: c && c.ok, state: c && c.state, msg: c && c.msg });
    const clAfter = (S.settleChecklist(m) || []).filter(x => x.key === 'carry')[0];
    check('结转/清除过时结转后，结转检查通过（状态可恢复，非死锁）', clAfter && clAfter.status === 'ok',
      '月=' + m + ' 检查=' + JSON.stringify(clAfter) + dbg);
    if (clAfter && clAfter.status === 'ok') {
      r = S.closePeriod(m);
      if (r && r.ok === false && r.warnOnly) r = S.closePeriod(m, { force: true });
      dbg += ' | 复结：' + JSON.stringify({ ok: r && r.ok, msg: r && r.msg });
    }
  }
  return { r: r, dbg: dbg };
}

function opClose() {
  const closed = S.state.closedPeriods || [];
  const m = RANGE.filter(x => closed.indexOf(x) < 0 && !skipClose.has(x))[0];
  if (!m) return;
  const res = attemptClose(m), r = res.r, carryDbg = res.dbg;
  if (r && r.ok === true) {
    stats.close++;
    check('结账后该期标记为已结账', S.isPeriodClosed(m));
    check('closedPeriods 保持有序', isSorted(S.state.closedPeriods || []));
    const rr = S.addVoucher(makeVoucher(m));
    check('结账后不可新增该期凭证', rr && rr.ok === false && /已结账/.test(rr.msg || ''), JSON.stringify(rr));
    const act = activeIn(m);
    if (act.length) {
      const rrr = S.removeVoucher(act[0].id, 'fuzz 破坏性试探');
      check('结账后不可删除该期凭证', rrr && rrr.ok === false && /已结账/.test(rrr.msg || ''), JSON.stringify(rrr));
    }
    return;
  }
  const msg = (r && r.msg) || '';
  if (/上一期间|该月已结账/.test(msg)) { check('结账前置条件（逐期/未重复）拦截正确', true); return; }
  skipClose.add(m);
  check('结账失败仅因「上期未结账 / 已结账」', false,
    '月=' + m + ' msg=' + msg + ' fails=' + JSON.stringify(((r && r.fails) || []).map(f => f.key + ':' + f.tip)) + carryDbg);
}

function opReopen() {
  const closed = (S.state.closedPeriods || []).slice().sort();
  if (!closed.length) return;
  const m = closed[closed.length - 1];
  const r = S.reopenPeriod(m, 'fuzz 反结账');
  if (!check('仅最近一期可反结账（本步即最近一期）', r && r.ok === true, JSON.stringify(r))) return;
  stats.reopen++;
  check('反结账后该期不再是已结账', !S.isPeriodClosed(m));
  const rr = S.addVoucher(makeVoucher(m));
  check('反结账后该期可再新增凭证', !!(rr && rr.id), JSON.stringify(rr));
}

function opCarry() {
  const closed = S.state.closedPeriods || [];
  const m = RANGE.filter(x => closed.indexOf(x) < 0 && !skipClose.has(x))[0];
  if (!m) return;
  const before = S.carryForwardStatus(m);          // 调用前的四态（唯一判定点，不必自己拼口径）
  const r = S.carryForwardProfit(m);
  if (before.exists) {
    // 已有结转凭证：本期已结平 → 幂等拒绝（state='ok'）；净额不为零（孤立结转）→ 过时须重做（state='stale'）
    check('已结转的期间再次结转被拒（幂等 / 过时须重做）',
      r && r.ok === false && (r.state === 'ok' || r.state === 'stale'), JSON.stringify(r));
  } else {
    check('未结转期间结转成功（或确无损益）', r && (r.ok === true || r.state === 'zero'), JSON.stringify(r));
    if (r && r.ok) stats.carry++;
  }
}

/* ============================================================
 * 主循环
 * ============================================================ */
console.log('\n── 随机操作 ──────────────────────────────────────────────');
for (let step = 1; step <= STEPS; step++) {
  const p = rnd();
  if (p < 0.50) opAdd();
  else if (p < 0.64) opDel();
  else if (p < 0.69) opRestore();
  else if (p < 0.86) opClose();
  else if (p < 0.94) opReopen();
  else opCarry();
  checkInvariants();
  if (step % 50 === 0) console.log('  · 第 ' + step + ' 步：凭证 ' + (S.state.vouchers || []).length
    + ' 张 / 已结账 ' + (S.state.closedPeriods || []).length + ' 期 / 失败 ' + fail);
  if (fail > 20) { console.error('  失败过多，提前中止（详情见上）。'); break; }
}

/* ============================================================
 * 收尾：确定性场景（随机步之外的必要闭环）
 * ============================================================ */
console.log('\n── 收尾校验 ──────────────────────────────────────────────');
const vsAll = S.state.vouchers || [];
console.log('  账套最终态：凭证 ' + vsAll.length + ' 张（软删 ' + vsAll.filter(v => v.deleted === 'y').length
  + '）/ 已结账 ' + JSON.stringify(S.state.closedPeriods || []));
console.log('  操作统计：新增成功 ' + stats.add + ' / 闸门用例 ' + stats.gate + ' / 删除 ' + stats.del
  + ' / 还原 ' + stats.restore + ' / 结账 ' + stats.close + ' / 反结账 ' + stats.reopen + ' / 结转 ' + stats.carry);
check('随机过程确实产生了凭证（测试非空转）', stats.add > 0, '新增成功=' + stats.add);
check('随机过程确实覆盖了结账（测试非空转）', stats.close + stats.reopen > 0, '结账=' + stats.close + ' 反结账=' + stats.reopen);

/* 确定性闭环：结转损益 → 结账。
 * 随机步里「结转」可能整轮都没被抽到（且是否抽到随种子而变），故这里固定走一遍，
 * 保证「新账套 + 损益数据 → 结转 → 结账」这条主链路每轮都被真实执行。
 * 结账须逐期进行，故先把 lastM 之前的期间按序结清。 */
const lastM = RANGE[RANGE.length - 1];
RANGE.slice(0, -1).forEach(m => { if (!S.isPeriodClosed(m)) attemptClose(m); });
if (!S.isPeriodClosed(lastM)) {
  // 清掉该月已有结转凭证，制造「确实需要结转」的状态
  (S.state.vouchers || []).filter(v => v.deleted !== 'y' && vmonth(v) === lastM
    && v.kind === S.VOUCHER_KINDS.CARRY_PL).forEach(v => S.removeVoucher(v.id, 'fuzz 收尾重做'));
  const expS = allSubj.filter(s => s.cls === 'expense' && isLeaf(s))[0];
  const av = S.addVoucher({
    word: '记', date: lastM + '-15', summary: '确定性结转用例',
    entries: [{ code: expS.code, name: expS.name, dr: 1000, cr: 0 },
              { code: POOL[0].code, name: POOL[0].name, dr: 0, cr: 1000 }]
  });
  check('收尾：录入一笔损益凭证', !!(av && av.id), JSON.stringify(av));
  const cl = (S.settleChecklist(lastM) || []).filter(c => c.key === 'carry')[0];
  check('收尾：结账检查识别出「未结转损益」', cl && cl.status === 'fail', JSON.stringify(cl));
  const c = S.carryForwardProfit(lastM);
  check('收尾：结转损益成功', c && c.ok === true, JSON.stringify(c));
  const cl2 = (S.settleChecklist(lastM) || []).filter(c => c.key === 'carry')[0];
  check('收尾：结转后结账检查通过', cl2 && cl2.status === 'ok', JSON.stringify(cl2));
  const rc = attemptClose(lastM).r;
  check('收尾：结转后可正常结账', rc && rc.ok === true, JSON.stringify(rc));
}

// 已结账期间：逐期做一次「不可改」的确定性探查
const closedNow = (S.state.closedPeriods || []).slice().sort();
closedNow.forEach(m => {
  const r = S.addVoucher(makeVoucher(m));
  check('结账期间 ' + m + ' 不可新增', r && r.ok === false && /已结账/.test(r.msg || ''), JSON.stringify(r));
  activeIn(m).forEach(v => {
    const rr = S.removeVoucher(v.id, 'fuzz 探查');
    check('结账期间 ' + m + ' 不可删除已有凭证', rr && rr.ok === false, JSON.stringify(rr));
  });
});

// 全量重载一致性：把账套落盘内容读回、重算，报表必须与内存一致（防止「内存对、盘上错」）
const persisted = books[bookId] ? JSON.parse(books[bookId]) : null;
check('随机账套已落盘', !!persisted, bookId);
if (persisted) {
  check('落盘内容与内存凭证数一致', (persisted.vouchers || []).length === (S.state.vouchers || []).length,
    '盘上=' + (persisted.vouchers || []).length + ' 内存=' + (S.state.vouchers || []).length);
  check('落盘内容科目数正常', (persisted.subjects || []).length === (S.state.subjects || []).length);
}

checkInvariants();

/* ============================================================
 * 确定性回归：「孤立结转凭证」（随机步发现的缺陷，用固定场景锁住，防回归）
 *   顺序：录费用凭证 → 结转损益 → 删除那张原费用凭证。
 *   于是结转凭证成了"孤立结转"——它把 3103 结转了，但它要结转的损益却没了，
 *   本期损益净额反向不为零。修复前产品给出两句互相打架的提示：
 *     · 结账检查：「本期损益未结转，请先结转损益」
 *     · 点结转  ：「本期损益已结转，请勿重复；如需重做请先删除结转凭证（记-N）」
 *   用户按第一句去点结转必然失败。现两处统一走 carryForwardStatus() 四态判定：
 *   stale 态下双方都给同口径提示（点「重新结转」重新生成），且删掉旧结转凭证后
 *   本期已无损益 → 返回 state='zero'（UI 据此按成功提示，而不是报红）。
 *   本用例锁定四点：①stale 能被判定；②两处提示同口径；③删旧凭证后返回 zero；
 *   ④检查恢复 ok（有明确出口，非死锁）。
 * ============================================================ */
(function orphanCarryCase() {
  S.newBook('孤立结转取证账套', 'small2013', curMonth);
  S._glCache = {};
  const eS = (S.state.subjects || []).filter(s => s.cls === 'expense')[0];
  const aS = (S.state.subjects || []).filter(s => s.cls === 'asset')[0];
  const v0 = S.addVoucher({ word: '记', date: curMonth + '-10', summary: '孤立结转用例',
    entries: [{ code: eS.code, name: eS.name, dr: 2190, cr: 0 }, { code: aS.code, name: aS.name, dr: 0, cr: 2190 }] });
  const c0 = S.carryForwardProfit(curMonth);
  check('孤立结转用例：首次结转成功（state=done）', c0 && c0.ok === true && c0.state === 'done', JSON.stringify(c0));
  S.removeVoucher(v0.id, 'fuzz 孤立结转取证');
  const cItem = (S.settleChecklist(curMonth) || []).filter(x => x.key === 'carry')[0];
  check('孤立结转：结账检查能识别出「结转凭证已过时」并给出出口（状态可见，不静默）',
    cItem && cItem.status === 'fail' && /重新结转/.test(cItem.tip || ''), JSON.stringify(cItem));
  const c1 = S.carryForwardProfit(curMonth);
  check('孤立结转：判定为 stale，提示与结账检查同口径（不再出现"未结转/已结转"两句矛盾）',
    c1 && c1.ok === false && c1.state === 'stale' && /重新结转/.test(c1.msg || '')
      && !/已结转，请勿重复/.test(c1.msg || ''), JSON.stringify(c1));
  (S.state.vouchers || []).filter(v => v.deleted !== 'y' && v.kind === S.VOUCHER_KINDS.CARRY_PL)
    .forEach(v => S.removeVoucher(v.id, 'fuzz 孤立结转恢复'));
  const c2 = S.carryForwardProfit(curMonth);
  check('孤立结转：作废过时结转凭证后已无损益可结转（state=zero，UI 据此按成功提示而非报红）',
    c2 && c2.ok === false && c2.state === 'zero', JSON.stringify(c2));
  const cItem2 = (S.settleChecklist(curMonth) || []).filter(x => x.key === 'carry')[0];
  check('孤立结转：作废过时结转凭证后检查恢复 ok（有明确出口，非死锁）',
    cItem2 && cItem2.status === 'ok', JSON.stringify(cItem2));
  checkInvariants();
})();

console.log('\n' + (fail
  ? ('有 ' + fail + ' 项失败（种子 ' + SEED + '）\n复现：' + REPRO)
  : ('随机测试通过 ✅（' + pass + ' 项断言全部通过，种子 ' + SEED + '）')));
if (fail) {
  console.log('\n失败明细（前 20）：');
  failures.slice(0, 20).forEach((f, i) => console.log('  ' + (i + 1) + '. ' + f));
}
process.exit(fail ? 1 : 0);