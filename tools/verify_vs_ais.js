#!/usr/bin/env node
'use strict';
/* ============================================================
 * 金蝶原账套 ↔ ty 当前账套：逐科目、逐期、逐字段金额对比
 *
 * 【为什么要做这个】此前所有对账都是「ty 内部各口径之间」（利润表 ↔ 结转 ↔ 总账），
 *   看不见「导入转换」环节引入的偏差。本脚本直接拿金蝶 .ais 的 GLBal
 *   （金蝶自己的权威科目余额）与 ty 的 generalLedger 逐科目逐期比，容差 0.01 元。
 *
 * 【软删除如何解释】ty 侧的所有「活动凭证」入口都排除软删除凭证，金蝶侧没有这个概念，
 *   故两者的差异应当【恰好等于】软删除凭证的影响。脚本自动算出该影响并归类：
 *     · 差异 ≡ 软删除影响            → 可解释（维护者主动删除，非缺陷）
 *     · 有差异但不等于软删除影响     → 需人工核查（怀疑导入/计算缺陷）
 *
 * 【对比字段（金蝶 GLBal ↔ ty generalLedger）】
 *   期初余额 FBegBal   ↔ obDr - obCr      （借方为正 signed，两边同口径）
 *   本期借方 FDebit    ↔ periodDr
 *   本期贷方 FCredit   ↔ periodCr
 *   期末余额 FEndBal   ↔ endDr - endCr
 *   本年借方 FYtdDebit ↔ ytdDr
 *   本年贷方 FYtdCredit↔ ytdCr
 *
 * 用法：node tools/verify_vs_ais.js [.ais路径] [账套JSON路径]
 * ============================================================ */
const fs = require('fs'), os = require('os'), path = require('path');

/* ---------- 解析参数 ---------- */
// 【血泪教训】本机可能存在同一账套的多份 .ais 副本（如 Desktop 与 Downloads），
//   其中较旧的那份可能缺少最新月份的结转凭证，拿它对比会凭空造出「余额差异」的假象。
//   故默认在候选位置中自动选取 **mtime 最新** 的那份。
//
// 【血泪教训 2.0（2026-09-22）—— 本脚本曾长期空转】
//   两端曾各挑各的：.ais 按 mtime 取【最新】，ty 账套按【文件名排序取第一个】。
//   而 books 目录里排序第一的恰好是名为「测试」的空账套（B1790064565274.json：0 张凭证、
//   69 个科目），于是本脚本【每次都在拿金蝶数据比一个空账套】—— 稳定产出 700+ 项「差异」，
//   全是假警报；喊久了被当成「已知老问题」，这张覆盖最广的网就此报废。
//   更隐蔽的是：原有的「期间配对校验」也拦不住。金蝶期间号是按【ty 账套的启用月】映射的
//   （拿被测对象解释待测数据），两边「首期」必然相等 → 校验形同虚设。
//   现改为：公司名配对 + 同公司取最新 + 自动避开空账套 + 期间基准取 .ais 自身年度；
//   配对不上一律明确报「配错账套」，绝不输出无意义的差异。
function booksDirPath() {
  const h = os.homedir();
  if (process.platform === 'darwin') return path.join(h, 'Library', 'Application Support', '添钰财务', 'books');
  if (process.platform === 'win32') return path.join(h, 'AppData', 'Roaming', '添钰财务', 'books');
  return path.join(h, '.local', 'share', '添钰财务', 'books');
}
// 「…/添钰来客_2026年_金蝶KIS格式.ais」→ { name:'添钰来客', year:2026 }
function aisLabel(file) {
  const base = path.basename(file).replace(/\.ais$/i, '');
  const m = base.match(/^(.*?)[_\-](\d{4})\s*年/);
  if (m) return { name: m[1].trim(), year: +m[2] };
  const m2 = base.match(/(\d{4})\s*年/);
  return { name: base.replace(/[_\-].*$/, '').trim(), year: m2 ? +m2[1] : null };
}
function listAisCands() {
  const out = [];
  ['/Users/chen/Desktop', '/Users/chen/Downloads/金蝶账套 ais', '/Users/chen/Downloads'].forEach(function (d) {
    try {
      if (!fs.existsSync(d)) return;
      fs.readdirSync(d).forEach(function (f) {
        if (!/\.ais$/i.test(f)) return;
        const p = path.join(d, f);
        try { out.push({ p: p, file: f, label: aisLabel(f), mtime: fs.statSync(p).mtimeMs }); } catch (e) { }
      });
    } catch (e) { }
  });
  out.sort(function (a, b) { return b.mtime - a.mtime; });
  return out;
}
function listBooks() {
  const dir = booksDirPath();
  const out = [];
  try {
    fs.readdirSync(dir).filter(function (x) { return x.endsWith('.json') && x.indexOf('.bak') < 0; })
      .forEach(function (f) {
        const p = path.join(dir, f);
        let o = {}, st = null;
        try { o = JSON.parse(fs.readFileSync(p, 'utf8')); st = fs.statSync(p); } catch (e) { return; }
        const c = o.company || {};
        out.push({
          p: p, file: f, name: String(c.name || ''), start: String(c.startMonth || ''),
          vouchers: (o.vouchers || []).length, subjects: (o.subjects || []).length,
          mtime: st ? st.mtimeMs : 0
        });
      });
  } catch (e) { }
  return out;
}
// 硬条件：账套可用（有凭证、有科目）。空账套永远只会制造假差异，一律排除。
function bookUsable(b) { return b.vouchers > 0 && b.subjects > 10; }
function nameMatch(b, label) {
  if (!b.name || !label || !label.name) return false;
  return b.name.indexOf(label.name) >= 0 || label.name.indexOf(b.name) >= 0;
}
function pickBookFor(label, explicit) {
  const books = listBooks();
  if (!books.length) return { error: '跳过：找不到 ty 账套 JSON（' + booksDirPath() + '）' };
  if (explicit) {
    const one = books.filter(function (b) { return path.resolve(b.p) === path.resolve(explicit); })[0];
    if (!one) return { error: '跳过：指定的账套不存在 → ' + explicit };
    if (!bookUsable(one)) {
      return {
        error: '❌ 指定的账套不能用于对比：' + one.file
          + '\n   名称「' + one.name + '」 启用月 ' + one.start
          + ' 凭证 ' + one.vouchers + ' 张 科目 ' + one.subjects + ' 个'
          + '\n   这是空账套/测试账套，逐月比对只会产出假差异（700+ 项全是噪声）。请改指真实账套。'
      };
    }
    if (label && label.name && !nameMatch(one, label)) {
      console.log('⚠ 注意：账套名「' + one.name + '」与 .ais 公司「' + label.name + '」不同，仍按你显式指定的继续。');
    }
    return { book: one };
  }
  let pool = books.filter(function (b) { return nameMatch(b, label); });
  if (!pool.length) pool = books.slice();
  const usable = pool.filter(bookUsable);
  if (!usable.length) {
    return {
      error: '❌ 找不到可用于对比的账套（候选里没有含凭证的账套）：\n'
        + books.map(function (b) { return '     · ' + b.file + '（' + b.name + '，凭证 ' + b.vouchers + ' 张）'; }).join('\n')
    };
  }
  pool = usable;
  pool.sort(function (a, b) { return b.mtime - a.mtime; });
  return { book: pool[0] };
}
// 未显式传参时：以「能和某个可用账套按公司名配上对的最新 .ais」为准
function autoPick() {
  const aises = listAisCands();
  if (!aises.length) return { error: '跳过：找不到 .ais' };
  const books = listBooks().filter(bookUsable);
  if (!books.length) return { error: '跳过：找不到可用账套（' + booksDirPath() + '）' };
  for (let i = 0; i < aises.length; i++) {
    const hit = books.filter(function (b) { return nameMatch(b, aises[i].label); });
    if (hit.length) {
      hit.sort(function (a, b) { return b.mtime - a.mtime; });
      return { ais: aises[i], book: hit[0] };
    }
  }
  return {
    error: '跳过：.ais 与账套配不上对（按公司名匹配失败）\n'
      + '     ais  ：' + aises.slice(0, 5).map(function (a) { return a.file; }).join('｜') + '\n'
      + '     账套 ：' + books.map(function (b) { return b.file + '(' + b.name + ')'; }).join('｜')
  };
}

// 已知账套名 → 找同公司的最新 .ais（匹配不到则退回最新那份）
function pickAisFor(bookName) {
  const aises = listAisCands();
  if (!aises.length) return null;
  const hit = aises.filter(function (a) {
    return a.label.name && bookName && (bookName.indexOf(a.label.name) >= 0 || a.label.name.indexOf(bookName) >= 0);
  });
  return hit.length ? hit[0] : aises[0];
}

const _a1 = process.argv[2] || null, _a2 = process.argv[3] || null;
let AIS = null, BOOK = null, AIS_LABEL = null;
if (_a1 || _a2) {
  const aPath = (_a1 && /\.ais$/i.test(_a1)) ? _a1 : ((_a2 && /\.ais$/i.test(_a2)) ? _a2 : null);
  const bPath = (_a1 && !/\.ais$/i.test(_a1)) ? _a1 : ((_a2 && !/\.ais$/i.test(_a2)) ? _a2 : null);
  if (aPath) {
    if (!fs.existsSync(aPath)) { console.log('跳过：找不到 .ais → ' + aPath); process.exit(0); }
    AIS = aPath; AIS_LABEL = aisLabel(aPath);
  }
  if (bPath) {
    const r = pickBookFor(AIS_LABEL, bPath);
    if (r.error) { console.log(r.error); process.exit(1); }
    BOOK = r.book.p;
  }
}
// 补全缺失的一侧：给了谁就用谁去配另一边，两边都没给才全自动。
// （曾漏掉「只给 .ais」这一支，结果用户指定绅蓝之星的 .ais 却拿添钰来客账套去比 —— 又造出 1216 项假差异。）
if (!AIS || !BOOK) {
  if (AIS && !BOOK) {
    const r = pickBookFor(AIS_LABEL, null);
    if (r.error) { console.log(r.error); process.exit(0); }
    BOOK = r.book.p;
  } else if (!AIS && BOOK) {
    const one = listBooks().filter(function (b) { return path.resolve(b.p) === path.resolve(BOOK); })[0];
    const a = pickAisFor(one ? one.name : '');
    if (!a) { console.log('跳过：找不到 .ais'); process.exit(0); }
    AIS = a.p; AIS_LABEL = a.label;
  } else {
    const p = autoPick();
    if (p.error) { console.log(p.error); process.exit(0); }
    AIS = p.ais.p; AIS_LABEL = p.ais.label; BOOK = p.book.p;
  }
}
if (!fs.existsSync(AIS)) { console.log('跳过：找不到 .ais → ' + AIS); process.exit(0); }
if (!BOOK || !fs.existsSync(BOOK)) { console.log('跳过：找不到 ty 账套 JSON'); process.exit(0); }

/* ---------- 0.5 本次参与比对的 .ais 清单（多年账套必须按年度分别取） ---------- */
// 【血泪教训 3.0（2026-09-22）—— 只取一份 = 早年的账整段没比过】
//   本机的事实：金蝶 KIS 的 .ais 是**按年度分文件**的（添钰来客 2025/2026，绅蓝之星 2024/2025/2026），
//   而 ty 账套是「多年合并导入」（添钰来客 2025-03 起 18 个月，绅蓝之星 2024-04 起 29 个月）。
//   脚本原先只取 mtime 最新的一份（= 当年），于是「2025 及更早」**完全没参与比对**，
//   而且只提示了"较新期间未比对"一侧 —— 静默漏掉 10 个月 / 21 个月却报绿灯，
//   又是一次"范围悄悄缩小"。故：同公司有几份年度 .ais 就全部纳入，
//   各自期间号按**各自文件名的年度**换算后合并进同一张月表（kis）。
// 只有「参数里真的是一个 .ais 路径」才算显式指定单份 —— 传账套路径不算。
// （曾写成 `!!(_a1 || _a2)`：只给账套时也被判成"显式指定单份"，于是年度 .ais 全被排除，
//   恰好复现了它本该修掉的那个毛病。判据要看"给的是什么"，不是"有没有给"。）
const _explicitAis = !!((_a1 && /\.ais$/i.test(_a1)) || (_a2 && /\.ais$/i.test(_a2)));
const _sameCo = listAisCands().filter(function (a) {
  return a.label && a.label.year && AIS_LABEL && AIS_LABEL.name &&
    (a.label.name.indexOf(AIS_LABEL.name) >= 0 || AIS_LABEL.name.indexOf(a.label.name) >= 0);
});
let AIS_LIST = _explicitAis ? [{ p: AIS, label: AIS_LABEL, mtime: 0 }] : _sameCo;
if (!AIS_LIST.length) AIS_LIST = [{ p: AIS, label: AIS_LABEL, mtime: 0 }];
// 同一年度只留一份（重复副本取 mtime 最新：旧副本可能缺最新月份的结转凭证）
AIS_LIST = (function () {
  const byYear = {};
  AIS_LIST.forEach(function (a) { const y = a.label.year || 0; if (!byYear[y] || a.mtime > byYear[y].mtime) byYear[y] = a; });
  return Object.keys(byYear).map(function (y) { return byYear[y]; })
    .sort(function (a, b) { return (a.label.year || 0) - (b.label.year || 0); });
})();

const R = function (n) { return Math.round((Number(n) || 0) * 100) / 100; };
const num = function (v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const EPS = 0.01;

/* ---------- 1. 读金蝶 GLBal ---------- */
global.window = global;
try { global.Buffer = require('buffer').Buffer; } catch (e) { }
(0, eval)(fs.readFileSync(path.join(__dirname, '..', 'js', 'mdb-reader.js'), 'utf8'));
const MDBReader = global.MDBReader.default;

const RAW_BOOK = fs.readFileSync(BOOK, 'utf8');
const BOOK_OBJ = JSON.parse(RAW_BOOK);
const START = ((BOOK_OBJ.company || {}).startMonth) || '2026-01';

// 期间号(1~12) → 'YYYY-MM'。基准取 **该份 .ais 自身的年度**（文件名 _YYYY年_）：
//   KIS「YYYY年」账套的第 1 期即该年 1 月。**年度必须逐份传入**（多年度合并时不能共用一个基准）。
// 【旧实现的错】基准曾用 ty 账套的启用月 —— 等于拿被测对象去解释待测数据，
//   导致「期间配对校验」两侧的首期必然相等而形同虚设（假警报的直接成因之一）。
const AIS_YEAR = (AIS_LABEL && AIS_LABEL.year) || (+String(START).slice(0, 4) || 2026);
function mapPeriod(p, year) {
  const total = ((year || AIS_YEAR) * 12) + (p - 1);
  const y = Math.floor(total / 12), m = (total % 12) + 1;
  return y + '-' + ('0' + m).slice(-2);
}

console.log('金蝶原账套：' + AIS_LIST.map(function (a) { return path.basename(a.p); }).join(' ＋ ')
  + '   （' + AIS_LIST.length + ' 份年度，期间号各按自身年度换算）');
console.log('ty 账套　　：' + path.basename(BOOK) + '   （启用月 ' + START + '）');
if (_explicitAis && _sameCo.length > 1) {
  const others = _sameCo.filter(function (a) { return a.label.year !== (AIS_LABEL && AIS_LABEL.year); });
  if (others.length) {
    console.log('ℹ 你显式指定了单份 .ais，故这些年度【未参与比对】：'
      + others.map(function (a) { return a.label.year + '年(' + path.basename(a.p) + ')'; }).join('、'));
    console.log('  要全期间对照，请不带参数直接运行：node tools/verify_vs_ais.js');
  }
}
console.log('');

// kis[month][code] = { beg, debit, credit, ytdD, ytdC, end }  ← 各年度 .ais 合并到同一张月表
const kis = {};
let balRowsTotal = 0, dupCells = 0;
AIS_LIST.forEach(function (a) {
  const year = a.label.year || AIS_YEAR;
  const reader = new MDBReader(fs.readFileSync(a.p));
  if (reader.getTableNames().indexOf('GLBal') < 0) {
    console.log('跳过（该 .ais 无 GLBal 表）：' + path.basename(a.p));
    return;
  }
  const rows = reader.getTable('GLBal').getData() || [];
  balRowsTotal += rows.length;
  rows.forEach(function (r) {
    if (String(r.FCyID || '').trim() !== '*' || String(r.FObjID || '').trim() !== '*') return;
    const code = String(r.FAcctID || '').trim();
    if (!code || code === '*') return;
    const rp = parseInt(r.FPeriod || 0, 10) || 0;
    if (!rp) return;
    // rp 已是 YYYYMM 形态时以它为准；否则按**本份文件自己的年度**换算
    const m = rp > 999 ? (String(rp).slice(0, 4) + '-' + String(rp).slice(4, 6)) : mapPeriod(rp, year);
    if (!/^\d{4}-\d{2}$/.test(m)) return;
    kis[m] = kis[m] || {};
    // 两份 .ais 出现「同一月同一科目」= 年度范围重叠，后读覆盖前值 —— 必须报出来而不是默默吃掉
    if (kis[m][code]) dupCells++;
    kis[m][code] = {
      beg: R(num(r.FBegBal)), debit: R(num(r.FDebit)), credit: R(num(r.FCredit)),
      ytdD: R(num(r.FYtdDebit)), ytdC: R(num(r.FYtdCredit)), end: R(num(r.FEndBal))
    };
  });
});
if (dupCells) {
  console.log('⚠ 多份 .ais 之间存在重复的「月份×科目」数据 ' + dupCells + ' 处（已按后读覆盖）——'
    + '请核查年度范围是否重叠，否则该处比对结果不可信。');
}
console.log('金蝶 GLBal：' + balRowsTotal + ' 行，覆盖期间 ' + Object.keys(kis).sort().join(', '));

/* ---------- 2. 读 ty 侧（用 store 计算总账） ---------- */
global.localStorage = { getItem: function () { return null; }, setItem: function () { }, removeItem: function () { } };
global.document = { getElementById: function () { return null; }, addEventListener: function () { }, querySelector: function () { return null; }, querySelectorAll: function () { return []; } };
global.__TAURI__ = {}; if (typeof global.isTauri === 'undefined') global.isTauri = false;
try { global.navigator = { userAgent: 'node' }; } catch (e) { }
global.fetch = function () { return Promise.reject(new Error('no net')); };
require(path.join(__dirname, '..', 'js', 'store.js'));
const S = global.S;
S.persist = function () { }; S.save = function () { return Promise.resolve(); };
S.addLog = function () { }; S.backupNow = function () { return Promise.resolve(true); };
if (global.Storage) { global.Storage.saveBook = function () { return Promise.resolve({ ok: true }); }; }
S.state = JSON.parse(RAW_BOOK); S.bookId = '__VSAIS__'; S._glCache = {};
if (S.normalizeState) S.normalizeState();

/* ---------- 3. 软删除凭证的影响（金蝶含、ty 不含）---------- */
// delImpact[month][code] = { dr, cr }  ← 软删除凭证的发生额
const delImpact = {};
(S.state.vouchers || []).forEach(function (v) {
  if (v.deleted !== 'y') return;
  const m = String(v.date || '').slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(m)) return;
  delImpact[m] = delImpact[m] || {};
  (v.entries || []).forEach(function (e) {
    const c = String(e.code);
    delImpact[m][c] = delImpact[m][c] || { dr: 0, cr: 0 };
    delImpact[m][c].dr += num(e.dr); delImpact[m][c].cr += num(e.cr);
  });
});
let delTotalAmt = 0;
Object.keys(delImpact).forEach(function (m) {
  Object.keys(delImpact[m]).forEach(function (c) { delTotalAmt += delImpact[m][c].dr + delImpact[m][c].cr; });
});

/* ---------- 4. 逐期逐科目对比 ---------- */
const months = Object.keys(kis).sort();

/* ---------- 配对校验：只比对两者的「共同期间」 ---------- */
// 【为什么需要】本机常有多份 .ais（2024 / 2025 / 2026 各一份）与多个账套（单年 / 多年合并）。
//   两者期间范围未必对得上 —— 典型误配：拿「2026 单年 .ais」比「2025+2026 合并账套」，
//   逐月硬比会凭空产出上千项差异（实测 7885 项），全是误报。
//   ⚠ 但也不能「范围不一致就整体跳过」：那会让「多年合并账套 + 单年 .ais」这种常见组合
//     彻底失去检查（旧实现正是如此，等于把唯一能跨年对照的网当废纸）。
//   现改为：取两者期间范围的【交集】逐月比对，交集为空才跳过。
//   期初余额在交集首期两侧同义（都表示该期期初），故取交集是安全的。
const bookStart = (S.state.company && S.state.company.startMonth) || '';
// 账套实际有凭证的最晚月份（.ais 侧用 GLBal 的期间，账套侧没有等价表，用凭证推）
let bookLast = '';
(S.state.vouchers || []).forEach(function (v) {
  if (v.deleted === 'y') return;
  const vm = String(v.date || '').slice(0, 7);
  if (/^\d{4}-\d{2}$/.test(vm) && vm > bookLast) bookLast = vm;
});
const aisFirst = months[0] || '', aisLast = months[months.length - 1] || '';
const from = (bookStart && bookStart > aisFirst) ? bookStart : aisFirst;
const to = (bookLast && aisLast) ? (bookLast < aisLast ? bookLast : aisLast) : (aisLast || bookLast);
const cmpMonths = months.filter(function (m) { return (!from || m >= from) && (!to || m <= to); });
if (!cmpMonths.length) {
  console.log('跳过：.ais 与 ty 账套的期间范围没有交集，逐月比对无意义。');
  console.log('      .ais 期间 ' + aisFirst + ' ~ ' + aisLast
    + '   vs   账套 ' + (bookStart || '?') + ' ~ ' + (bookLast || '?'));
  console.log('      如需比对，请显式指定两者：node tools/verify_vs_ais.js <.ais> <账套.json>');
  process.exit(0);
}
console.log('本次比对区间：' + from + ' ~ ' + to + '（共 ' + cmpMonths.length + ' 期，全字段严格比对）');
// 【缺口必须自己交代清楚】"只比对了一部分"绝不能被读成"全部一致"。
//   旧实现只提示「较新期间」一侧，于是「多年合并账套 + 单年 .ais」时更早的整段被静默跳过
//   —— 实测添钰来客 18 期里 10 期、绅蓝之星 29 期里 21 期从未与金蝶比过，却一直报绿。
const bookMonths = (function () {
  const s = {};
  (S.state.vouchers || []).forEach(function (v) {
    if (v.deleted === 'y') return;
    const vm = String(v.date || '').slice(0, 7);
    if (/^\d{4}-\d{2}$/.test(vm)) s[vm] = 1;
  });
  return Object.keys(s).sort();
})();
const gapEarly = bookMonths.filter(function (m) { return from && m < from; });
const gapLate = bookMonths.filter(function (m) { return to && m > to; });
if (gapEarly.length) {
  console.log('⚠ 账套更早的 ' + gapEarly.length + ' 期【未参与比对】：' + gapEarly[0] + ' ~ ' + gapEarly[gapEarly.length - 1]
    + '（金蝶侧最早只到 ' + (aisFirst || '?') + '）。若本机有这些年度单独的 .ais，'
    + '不带参数直接运行会自动全部纳入比对。');
}
if (gapLate.length) {
  console.log('ℹ 账套较新的 ' + gapLate.length + ' 期【未参与比对】：' + gapLate[0] + ' ~ ' + gapLate[gapLate.length - 1]
    + '（金蝶侧最新只到 ' + (aisLast || '?') + '；账套可能尚未导入该月）。');
}
console.log('账套期间覆盖：共 ' + bookMonths.length + ' 期，本次比对 ' + cmpMonths.length + ' 期'
  + (bookMonths.length > cmpMonths.length ? '，未覆盖 ' + (bookMonths.length - cmpMonths.length) + ' 期' : '（全覆盖 ✓）'));
console.log('软删除凭证影响：' + (delTotalAmt ? (R(delTotalAmt) + '（元·借贷合计，期间 ' + Object.keys(delImpact).join(',') + '）') : '无'));

// 【旧版导入账套 → 发生额列不参与比对】
// 旧版导入把金蝶红字「借 -1,724.85」改写成「贷 +1,724.85」（见 js/kis-import.js 历史实现），
// 于是「本期/本年累计发生额」按**借贷双方合计**列示，而金蝶 GLBal 是**净额**（红字抵减借方），
// 两者必然不等 —— 实测各月差 -1,724.85 / -162 / -14.27，恰为各笔红冲金额，与此前利润表
// 口径问题同源。该改写是**信息破坏性**的，已无法从账套内还原（红冲与真实反方向业务无法区分），
// 故旧账套的发生额列本就不该与金蝶一致 —— 这是「已知且不可逆」的，不是缺陷。
// 因此：旧账套只严格比对【余额列】（beg/end，不受影响）；发生额列跳过并明确提示。
// 用新版重新导入（meta.redStyle === 'native'）后，本判断自动失效，恢复全字段严格比对。
const BOOK_META = (BOOK_OBJ && BOOK_OBJ.meta) || {};
const LEGACY_RED_STYLE = !!BOOK_META.importedAt && BOOK_META.redStyle !== 'native';
if (LEGACY_RED_STYLE) {
  console.log('⚠ 本账套为旧版方式导入（红字被转写成反方向）→ 发生额列口径与金蝶不同，'
    + '本次只严格比对余额列；重新导入后自动恢复全字段比对。');
}
console.log('');

const FIELDS = [
  ['beg', function (r) { return R(num(r.obDr) - num(r.obCr)); }, '期初余额'],
  ['debit', function (r) { return R(num(r.periodDr)); }, '本期借方'],
  ['credit', function (r) { return R(num(r.periodCr)); }, '本期贷方'],
  ['end', function (r) { return R(num(r.endDr) - num(r.endCr)); }, '期末余额'],
  ['ytdD', function (r) { return R(num(r.ytdDr)); }, '本年借方'],
  ['ytdC', function (r) { return R(num(r.ytdCr)); }, '本年贷方']
];

let totalChecked = 0, totalDiff = 0, totalExplained = 0, totalUnexplained = 0;
const unexplainedDetail = [];

cmpMonths.forEach(function (m) {
  const gl = S.generalLedger(m);
  const byCode = {};
  gl.forEach(function (r) { byCode[String(r.code)] = r; });
  const kisM = kis[m];

  const codeSeen = {};
  Object.keys(kisM).forEach(function (c) { codeSeen[c] = 1; });
  Object.keys(byCode).forEach(function (c) { codeSeen[c] = 1; });

  const issues = [];
  Object.keys(codeSeen).forEach(function (c) {
    const k = kisM[c] || { beg: 0, debit: 0, credit: 0, end: 0, ytdD: 0, ytdC: 0 };
    const t = byCode[c] || { obDr: 0, obCr: 0, periodDr: 0, periodCr: 0, endDr: 0, endCr: 0, ytdDr: 0, ytdCr: 0 };
    const del = (delImpact[m] || {})[c] || { dr: 0, cr: 0 };
    FIELDS.forEach(function (f) {
      // 旧版导入账套：跳过「发生额」四列（本期借/贷、本年借/贷），理由见 LEGACY_RED_STYLE 说明。
      // 余额两列 beg/end 不受红字口径影响，仍正常严格比对。
      if (LEGACY_RED_STYLE
        && (f[0] === 'debit' || f[0] === 'credit' || f[0] === 'ytdD' || f[0] === 'ytdC')) return;
      const kv = k[f[0]], tv = f[1](t), label = f[2];
      const d = R(kv - tv);
      if (Math.abs(d) < EPS) return;
      totalChecked++; totalDiff++;
      // 软删除影响是否恰好解释该差异？
      let expected = null;
      if (f[0] === 'debit') expected = R(del.dr);
      else if (f[0] === 'credit') expected = R(del.cr);
      else if (f[0] === 'end') expected = R(del.dr - del.cr);
      else if (f[0] === 'ytdD') expected = R(del.dr);
      else if (f[0] === 'ytdC') expected = R(del.cr);
      const explained = expected !== null && Math.abs(d - expected) < EPS;
      if (explained) totalExplained++;
      else {
        totalUnexplained++;
        issues.push('   ' + c + ' ' + label + '：金蝶 ' + kv + ' / ty ' + tv + ' 差 ' + d
          + (expected !== null ? '（软删除只能解释 ' + expected + '）' : ''));
      }
    });
  });
  if (issues.length) {
    console.log('✗ ' + m + ' 存在无法用软删除解释的差异（' + issues.length + ' 项）：');
    issues.slice(0, 14).forEach(function (x) { console.log(x); });
    unexplainedDetail.push(m);
    console.log('');
  }
});

console.log('─'.repeat(70));
console.log('对比期间数：' + cmpMonths.length + '/' + bookMonths.length + '　差异项：' + totalDiff
  + '　（其中软删除可解释：' + totalExplained + '）');
if (totalUnexplained === 0) {
  // 覆盖不全时必须说清楚 —— 否则"已比对部分一致"会被读成"整个账套都没问题"。
  if (bookMonths.length > cmpMonths.length) {
    console.log('✅ 已比对的 ' + cmpMonths.length + ' 期与金蝶金额完全一致 ✓');
    console.log('⚠ 但账套还有 ' + (bookMonths.length - cmpMonths.length) + ' 期【未参与比对】（见上方提示）——'
      + '不能据此认定"全账套无差异"。');
  } else {
    console.log('✅ 全部差异均可由「软删除凭证」解释 —— ty 与金蝶原账套金额一致（账套全期间） ✓');
  }
} else {
  console.log('❌ 有 ' + totalUnexplained + ' 项差异无法用软删除解释（期间：' + unexplainedDetail.join(',') + '）← 需人工核查');
}
process.exit(totalUnexplained === 0 ? 0 : 1);
