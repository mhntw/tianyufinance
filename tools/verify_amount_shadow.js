#!/usr/bin/env node
/**
 * verify_amount_shadow.js — 金额定点化「影子对照」
 *
 * 用法：
 *   node tools/verify_amount_shadow.js [账套JSON路径]
 *   SHADOW_BASE=<commit> node tools/verify_amount_shadow.js     # 换旧实现基线（默认 7e7ae66）
 *   SHADOW_DETAIL=<n> node tools/verify_amount_shadow.js        # 明细账抽查科目数（默认 40）
 *
 * 【做什么】把**同一个账套**分别喂给两套 store 实现：
 *   · 旧实现 = 定点化之前的 store.js（从 git 基线 `git show <commit>:js/store.js` 取出，
 *     在内存里编译执行，不落盘、不改仓库）；
 *   · 新实现 = 当前 js/store.js。
 * 然后逐函数、逐字段对照：`新值 === Math.round(旧值 × 10000)`。
 *
 * 【为什么必须是「整数精确相等」】定点化的目的就是保住 0.0001 元这一位精度。
 *   若对照退化成 `round2(新) === round2(旧)`（即「逐分相等」），恰恰会把本次要保住的
 *   0.0001 精度差异全部掩盖 —— 那等于用一个刚刚被消灭的容差来验收这次的改动。
 *   故旧值必须**先 ×10000 再取整**，与新区间对齐后严格比较。
 *
 * 【两域数据从哪来】旧实现工作在「元」浮点域，新实现工作在「0.0001 元整数」域：
 *   · 磁盘账套仍是 v5（未迁移）→ 直接用磁盘原始文本作旧域数据（最真实）；
 *   · 磁盘账套已是 v6 → 取「迁移前快照」（backups/<id>_pre_restore_*.json，由迁移流程强制写）
 *     作为旧域数据。快照是迁移前的原样文本，正是旧实现该吃的输入。
 *   两种来源都不修改用户数据。
 *
 * 【除不尽的值：单独认账，不混入严格相等】整数域里每一处求和都是精确的，而旧实现是
 *   逐笔浮点累加 —— 当原始数据本身带**超过 4 位小数**的残余（典型的：4 位值被除摊成循环小数，
 *   如 2051.6644444444446）时，两边的舍入归属会差 1 个最小单位（0.0001 元）。
 *   这类差异按设计就不该逐位相等，若一律报失败会淹没真实问题；若一律放行又会掩盖真实问题。
 *   故按**叶子自身的残余**判定（见 compareAt 注释），且单列计数与样例 —— 只有旧值确实带
 *   超 4 位残余时才允许 ±1 个最小单位，旧值本身就是精确 4 位则必须严格相等。
 *
 * 【命中数卡口】**必须有字段真正走了「×10000」这一支**（hitScale > 0）。否则说明两域其实是
 *   同一个域（例如旧实现取到了新代码、或数据被提前迁移），对照根本没生效却会「全绿」——
 *   这正是本项目历史上反复出现的「假绿」形态，故设硬卡口。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.SHADOW_BASE || '7e7ae66';   // 阶段 0 基线 = 定点化之前的最后一次提交
const DETAIL_N = Number(process.env.SHADOW_DETAIL || 40);

const PASS = '\x1b[32mPASS\x1b[0m';
const FAIL = '\x1b[31mFAIL\x1b[0m';

/* ---------- 浏览器环境桩（两套实现同用） ---------- */
global.window = global;
global.Storage = {
  saveBook: () => Promise.resolve({ ok: true }),
  saveBackup: () => Promise.resolve({ ok: true }),
  saveRestoreSnapshot: () => Promise.resolve({ ok: true, ts: 0 }),
  readMeta: () => Promise.resolve({ last_book: null, disabled: {} }),
  writeMeta: () => Promise.resolve({ ok: true })
};

/* standards.js 挂在 window.STANDARDS 上；两套 store 都读它。
   （旧实现源码里那句 `require('./standards.js')` 在临时目录必然失败、且被 try 吞掉 —— 
    所以必须在这里先把准则装好，否则旧实现会拿不到报表规则。） */
require(path.join(ROOT, 'js', 'standards.js'));

/* ---------- 载入两套实现 ---------- */
function loadOldStore() {
  let src;
  try {
    src = execFileSync('git', ['show', BASE + ':js/store.js'],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    console.log('跳过：取不到基线 ' + BASE + ' 的 js/store.js（git 对象缺失？）');
    console.log('本脚本需要 git 基线作为「旧实现」对照物，取不到时跳过而非误报失败。');
    process.exit(0);
  }
  // 在内存里编译：写进 os.tmpdir() 的虚拟路径，不落盘、不污染仓库
  const fake = path.join(os.tmpdir(), 'ty_shadow_old_store.js');
  const m = new Module(fake, null);
  m.filename = fake;
  m.paths = Module._nodeModulePaths(ROOT);
  m._compile(src, fake);
  return m.exports.store;
}

const S_old = loadOldStore();
const S_new = require(path.join(ROOT, 'js', 'store.js')).store;

[S_old, S_new].forEach(S => {
  S.persist = function () {};
  S.addLog = function () {};
  S.backupNow = function () { return Promise.resolve(true); };
});

/* ---------- 定位账套与「旧域数据」 ---------- */
function appRoot() {
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', '添钰财务');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), '添钰财务');
  return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), '添钰财务');
}
function findBook(arg) {
  if (arg && fs.existsSync(arg)) return arg;
  const dir = path.join(appRoot(), 'books');
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => ({
      name: f, path: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs
    })).sort((a, b) => b.mtime - a.mtime)
    : [];
  if (!files.length) {
    console.log('跳过：未找到账套（' + dir + '）');
    console.log('本脚本需要真实账套作为样本，无账套环境（如 CI）自动跳过，返回 0，不计为失败。');
    process.exit(0);
  }
  return files[0].path;
}

/** 取「迁移前快照」原文（v5），供旧实现使用；找不到返回 null */
function findPreMigrationSnapshot(bookId) {
  const dir = path.join(appRoot(), 'backups');
  if (!fs.existsSync(dir)) return null;
  const cands = fs.readdirSync(dir)
    .filter(f => f.endsWith('.json') && f.indexOf(bookId) === 0)
    .map(f => ({ f: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const c of cands) {
    try {
      const o = JSON.parse(fs.readFileSync(path.join(dir, c.f), 'utf8'));
      if (o && o.schemaVersion !== 6) return { obj: o, file: c.f };
    } catch (e) { /* 坏备份跳过 */ }
  }
  return null;
}

/* ---------- 对照器 ---------- */
/* 非金额的数值字段：这些字段在两套实现里必须**逐位相同**，不参与 ×10000 期望。
   （数量、层次、行次、凭证号都不是金额；一旦有新增的非金额数值字段混进来，
     会被判成「金额差异」而报红 —— 这是刻意选的失败方向：宁可多报一眼，不可漏报。） */
const NON_AMOUNT_KEYS = {
  no: 1, qtyDr: 1, qtyCr: 1, level: 1, rowNum: 1, sortOrder: 1, count: 1, n: 1, idx: 1, index: 1,
  grp: 1   // 科目档案上的分组号（如 102 / 400 / 504），非金额；detailLedger 会原样带出科目对象
};

/* 余额方向字段（'借'/'贷'/''）。它们由金额**推导**而来，而旧实现的浮点噪声会把
   「余额本应为 0」算成 5.68e-14 → 方向显示「借/贷」；定点化后余额精确为 0 → 方向留空。
   这是本次改造要拿到的收益（详见 store.js generalLedger 的「零余额无方向」注释），
   不该记成差异。放行条件是**单向**的：只允许 借/贷 → 空，且对应的 balance/ytdBalance
   字段本身已在金额对照里严格核过（新值为 0 且与旧值×10000 一致），故不存在掩盖真错的空间。 */
const DIR_KEYS = { dir: 1, ytdDir: 1 };

const stat = {
  cmp: 0,          // 比较过的金额叶子数（严格相等）
  exact: 0,        // 严格相等：新值 === Math.round(旧值×10000)
  residual: [],    // 除不尽残差：±1 个最小单位（0.0001 元），单列认账
  zeroNoise: 0,    // 旧浮点噪声导致的「零余额方向」差异（定点化收益，非缺陷）
  nonAmt: 0,       // 非金额数值叶子（逐位相同）
  diffs: []        // 真差异
};

function compareAt(path_, key, oldV, newV) {
  // null / undefined
  if (oldV === null || oldV === undefined || newV === null || newV === undefined) {
    if (oldV !== newV) stat.diffs.push({ path: path_, old: oldV, new: newV, why: '空值不一致' });
    return;
  }
  if (Array.isArray(oldV) || Array.isArray(newV)) {
    if (!Array.isArray(oldV) || !Array.isArray(newV)) {
      stat.diffs.push({ path: path_, old: oldV, new: newV, why: '数组类型不一致' }); return;
    }
    if (oldV.length !== newV.length) {
      stat.diffs.push({ path: path_, old: '长度' + oldV.length, new: '长度' + newV.length, why: '长度不一致' });
      return;
    }
    for (let i = 0; i < oldV.length; i++) compareAt(path_ + '[' + i + ']', key, oldV[i], newV[i]);
    return;
  }
  if (typeof oldV === 'object' || typeof newV === 'object') {
    if (typeof oldV !== 'object' || typeof newV !== 'object') {
      stat.diffs.push({ path: path_, old: oldV, new: newV, why: '对象类型不一致' }); return;
    }
    const keys = Object.keys(oldV);
    Object.keys(newV).forEach(k => { if (keys.indexOf(k) < 0) keys.push(k); });
    keys.forEach(k => compareAt(path_ + '.' + k, k, oldV[k], newV[k]));
    return;
  }
  if (typeof oldV === 'number' && typeof newV === 'number') {
    if (NON_AMOUNT_KEYS[key]) {
      stat.nonAmt++;
      if (oldV !== newV) stat.diffs.push({ path: path_, old: oldV, new: newV, why: '非金额字段不一致' });
      return;
    }
    if (!Number.isSafeInteger(newV)) {
      stat.diffs.push({ path: path_, old: oldV, new: newV, why: '新值不是安全整数（定点域契约被破坏）' });
      return;
    }
    stat.cmp++;
    const scaled = oldV * 10000;                 // 旧域（元）→ 目标域（0.0001 元）
    const nearest = Math.round(scaled);
    if (newV === nearest) { stat.exact++; return; }
    /* 除不尽判定：`residue` = 旧值本身超出 4 位定点的残余。
       只有旧值确实带残余时才允许 ±1 个最小单位 —— 那是「两边舍入归属不同」，
       是设计内的差异；旧值本身是精确 4 位（residue≈0）却对不上，就是真错，必须报红。 */
    const residue = Math.abs(scaled - nearest);
    if (Math.abs(newV - nearest) <= 1 && residue > 1e-6) {
      stat.residual.push({ path: path_, old: oldV, new: newV, expect: nearest });
      return;
    }
    stat.diffs.push({ path: path_, old: oldV, new: newV, expect: nearest, why: '金额不一致（期望旧值×10000）' });
    return;
  }
  if (oldV !== newV) {
    if (DIR_KEYS[key] && newV === '' && (oldV === '借' || oldV === '贷')) { stat.zeroNoise++; return; }
    stat.diffs.push({ path: path_, old: oldV, new: newV, why: '值不一致' });
  }
}

let sections = 0;
function section(title) {
  sections++;
  console.log('\n--- ' + title + ' ---');
}
let sectionDiffs = 0;
function finishSection(before) {
  const d = stat.diffs.length - before;
  if (d) { sectionDiffs += d; console.log('    ✗ 本组差异 ' + d + ' 处'); }
  else console.log('    ✓ 一致');
}

function run(bookPath) {
  const rawText = fs.readFileSync(bookPath, 'utf8');
  const raw = JSON.parse(rawText);
  const bookId = raw.id || path.basename(bookPath, '.json');

  console.log('\n=== 金额定点化 影子对照 ===');
  console.log('新实现：js/store.js（SCHEMA_VERSION=' + S_new.SCHEMA_VERSION + '）');
  console.log('旧实现：git ' + BASE + ':js/store.js');
  console.log('账套：' + ((raw.company && raw.company.name) || bookId) + '（' + path.basename(bookPath) + '）');

  /* --- 旧域数据（旧实现吃「元」浮点） --- */
  let oldData;
  if (raw.schemaVersion !== 6) {
    oldData = raw;
    console.log('旧域数据：磁盘原文（schemaVersion=' + raw.schemaVersion + '，未迁移）');
  } else {
    const snap = findPreMigrationSnapshot(bookId);
    if (!snap) {
      console.log('跳过：磁盘账套已是 v6，且找不到 v5 的迁移前快照（backups/<id>_pre_restore_*.json）。');
      console.log('影子对照需要「迁移前的原始数据」作为旧实现的输入；快照缺失时跳过而非误报失败。');
      process.exit(0);
    }
    oldData = snap.obj;
    console.log('旧域数据：迁移前快照 backups/' + snap.file + '（schemaVersion=' + oldData.schemaVersion + '）');
  }

  /* --- 新域数据：迁移到 v6 --- */
  const newData = JSON.parse(JSON.stringify(oldData));
  S_new.migrateAmountsToV6(newData);

  S_old.state = oldData; S_old.bookId = bookId;
  S_new.state = newData; S_new.bookId = bookId;

  const months = {};
  (oldData.vouchers || []).forEach(v => {
    const m = (v.date || '').slice(0, 7); if (m) months[m] = 1;
  });
  (oldData.closedPeriods || []).forEach(m => { if (m) months[m] = 1; });
  const monthList = Object.keys(months).sort();
  const subjects = (oldData.subjects || []).map(s => s.code);
  console.log('样本：' + monthList.length + ' 个月 × ' + subjects.length + ' 科目，凭证 ' +
    (oldData.vouchers || []).length + ' 张');

  /* --- 1) 总账（含每个科目的期初 openingOf、本期、期末、本年累计） --- */
  section('总账 generalLedger（' + monthList.length + ' 期 × ' + subjects.length + ' 科目）');
  let before = stat.diffs.length;
  monthList.forEach(m => {
    compareAt('generalLedger(' + m + ')', 'gl', S_old.generalLedger(m), S_new.generalLedger(m));
  });
  finishSection(before);

  /* --- 2) 科目余额表（trialBalance = generalLedger 的别名，仍然实调，防两处分叉） --- */
  section('科目余额表 trialBalance');
  before = stat.diffs.length;
  monthList.forEach(m => {
    compareAt('trialBalance(' + m + ')', 'tb', S_old.trialBalance(m), S_new.trialBalance(m));
  });
  finishSection(before);

  /* --- 3) 期末余额 / 本期发生额（全科目 × 全期间） --- */
  section('科目期末余额 / 本期发生额（' + monthList.length + ' × ' + subjects.length + '）');
  before = stat.diffs.length;
  monthList.forEach(m => {
    subjects.forEach(c => {
      compareAt('subjectEndBalance(' + c + ',' + m + ')', 'seb', S_old.subjectEndBalance(c, m), S_new.subjectEndBalance(c, m));
      compareAt('subjectPeriodAmount(' + c + ',' + m + ')', 'spa', S_old.subjectPeriodAmount(c, m), S_new.subjectPeriodAmount(c, m));
    });
  });
  finishSection(before);

  /* --- 4) 明细账（抽查末级科目 × 全期间；逐笔 dr/cr/bal 与期初/本期/累计） --- */
  const leaf = (oldData.subjects || []).filter(s =>
    !(oldData.subjects || []).some(x => x.code !== s.code && x.code.indexOf(s.code) === 0));
  const sample = leaf.slice(0, Math.min(DETAIL_N, leaf.length)).map(s => s.code);
  section('明细账 detailLedger（' + sample.length + ' 科目 × ' + monthList.length + ' 期）');
  before = stat.diffs.length;
  monthList.forEach(m => {
    sample.forEach(c => {
      compareAt('detailLedger(' + c + ',' + m + ')', 'dl', S_old.detailLedger(c, m), S_new.detailLedger(c, m));
    });
  });
  finishSection(before);

  /* --- 5) 报表三张 --- */
  section('资产负债表 balanceSheet');
  before = stat.diffs.length;
  monthList.forEach(m => compareAt('balanceSheet(' + m + ')', 'bs', S_old.balanceSheet(m), S_new.balanceSheet(m)));
  finishSection(before);

  section('利润表 profitStatement');
  before = stat.diffs.length;
  monthList.forEach(m => compareAt('profitStatement(' + m + ')', 'ps', S_old.profitStatement(m), S_new.profitStatement(m)));
  finishSection(before);

  section('现金流量表 cashFlow');
  before = stat.diffs.length;
  monthList.forEach(m => compareAt('cashFlow(' + m + ')', 'cf', S_old.cashFlow(m), S_new.cashFlow(m)));
  finishSection(before);

  /* --- 汇总 --- */
  console.log('\n=== 汇总 ===');
  console.log('  金额字段对照 ' + stat.cmp + ' 个：严格相等 ' + stat.exact +
    '，除不尽残差 ' + stat.residual.length + '，不一致 ' + stat.diffs.length);
  console.log('  非金额数值字段 ' + stat.nonAmt + ' 个（要求逐位相同，不参与 ×10000）');
  console.log('  零余额方向差异 ' + stat.zeroNoise + ' 处（旧浮点噪声使"余额 0"带上方向，定点化后归零 —— 收益）');

  if (stat.residual.length) {
    console.log('\n  除不尽残差（±1 个最小单位，即 0.0001 元；旧值本身带超 4 位残余，舍入归属不同）');
    console.log('  共 ' + stat.residual.length + ' 处，样例（最多 5 条）：');
    stat.residual.slice(0, 5).forEach(r => {
      console.log('    · ' + r.path + '  旧=' + r.old + ' ×10000=' + r.expect + ' 新=' + r.new);
    });
  }

  if (stat.diffs.length) {
    // 按字段名聚集：差异往往成族出现（同一字段 × 不同期间/科目），先给分布再给样例
    const byField = {};
    stat.diffs.forEach(d => {
      const f = String(d.path).split('.').pop().replace(/\[\d+\]$/, '');
      byField[f] = (byField[f] || 0) + 1;
    });
    console.log('\n  不一致（失败）：共 ' + stat.diffs.length + ' 处，按字段聚集：');
    Object.keys(byField).sort((a, b) => byField[b] - byField[a]).forEach(f => {
      console.log('    ' + String(byField[f]).padStart(6) + ' 处  ' + f);
    });
    console.log('  样例（最多 10 条）：');
    stat.diffs.slice(0, 10).forEach(d => {
      console.log('    ✗ ' + d.path + '  ' + d.why + '  旧=' + d.old + ' 新=' + d.new +
        (d.expect !== undefined ? ' 期望=' + d.expect : ''));
    });
  }

  /* --- 命中数卡口：必须真的有字段走了 ×10000，否则对照等于没生效 --- */
  let ok = stat.diffs.length === 0;
  if (stat.cmp === 0 || stat.exact === 0) {
    ok = false;
    console.log('\n  ' + FAIL + ' 命中数卡口：没有任何金额字段走「旧值×10000」这一支 —— ' +
      '说明对照未生效（两域可能是同一个域），本次结果不成立。');
  }

  console.log('\n结果：' + (ok ? PASS : FAIL) + '  ' + (ok
    ? '新旧两套实现在 ' + sections + ' 组、' + stat.cmp + ' 个金额字段上逐 0.0001 元一致'
    : '存在差异，见上'));
  console.log('');
  process.exit(ok ? 0 : 1);
}

const bookArg = process.argv[2];
run(findBook(bookArg));