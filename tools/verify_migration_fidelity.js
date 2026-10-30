#!/usr/bin/env node
'use strict';
/* ============================================================
 * tools/verify_migration_fidelity.js —— 金额定点化（v5 → v6）迁移保真审计
 *
 * 【为什么有这个脚本】2026-09-30 起，账套金额从「元」浮点改成**定点整数**
 *   （1 元 = 10000 个最小单位，见 js/store.js 的 migrateAmountsToV6 / AMT_SCALE）。
 *   迁移是**对真实账套做乘法并写盘**的一次性动作 —— 一旦漏乘某个字段或乘两次，
 *   金额会整体错 10000 倍 / 1 亿倍，而"每个数都自洽"（借贷仍平、试算仍平、报表仍平），
 *   所有恒等式断言全部照常通过。所以必须有一个**直接盯磁盘数值**的审计。
 *
 * 【判据：逐叶子比对「迁移后的账套」与「它迁移前的 v5 备份」】
 *   · 数字叶子：要么 v6 === round(v5 × 10000)（迁移了），要么 v6 === v5（不该迁的没动）
 *   · 其余叶子（字符串/布尔/null）：必须完全相同
 *   · 数组长度、对象键集合：必须相同
 *   **任何第三种情况 = 异常**（会打印路径与两个值）
 *
 *   ⚠ 判据刻意**不依赖** migrateAmountsToV6 的字段白名单 —— 那正是要审的对象。
 *     另有一组"金额字段名 + 路径上下文"的启发式（isMoneyPath）：若某个金额字段
 *     **没被乘 10000**（漏迁），它单独列出。assetCats[].salvage（残值率%）不算金额。
 *
 * 【怎么找"迁移前"的基线】books/ 里挑 v6 的账套；backups/ 里挑**同名、v5、
 *   且科目数与凭证数都相同**的最近一份 —— 不满足就不对照（绝不拿不同期的备份硬比，
 *   那只会产生假警报）。没有基线 = 未对照（不是通过）。
 *
 * 【用法】
 *   node tools/verify_migration_fidelity.js                       # 审计所有 v6 账套
 *   node tools/verify_migration_fidelity.js <账套.json> <基线.json>  # 审计指定两份
 *   退出码：0 = 全部一致（或无账套可审）；1 = 发现异常
 * ============================================================ */

const fs = require('fs');
const os = require('os');
const path = require('path');

function homeDir() {
  const h = os.homedir();
  if (process.platform === 'darwin') return path.join(h, 'Library', 'Application Support', '添钰财务');
  if (process.platform === 'win32') return path.join(h, 'AppData', 'Roaming', '添钰财务');
  return path.join(h, '.local', 'share', '添钰财务');
}
const BOOKS_DIR = path.join(homeDir(), 'books');
const BACKUPS_DIR = path.join(homeDir(), 'backups');
const V6 = 6, AMT_SCALE = 10000;

/* 金额字段名（配合**路径上下文**判断 —— assetCats[].salvage 是残值率，不是金额） */
const MONEY_LEAF = ['dr', 'cr', 'yb', 'ytdDr', 'ytdCr', 'amt', 'ytd', 'maxDiff',
  'prevEnd', 'curOpen', 'diff', 'should', 'real', 'yearDepr',
  'original', 'accumDeprBegin', 'accumDepr', 'salvage', 'impairment', 'netValueBegin', 'netValueEnd'];
function isMoneyPath(p) {
  const parts = p.split('.');
  const last = parts[parts.length - 1].replace(/\[\d+\]$/, '');
  if (last === 'salvage' && /assetCats/.test(p)) return false;         // 残值率（%）
  if (/^fixedAssets\[\d+\]/.test(p)) return MONEY_LEAF.indexOf(last) >= 0;
  if (/^vouchers\[\d+\]\.entries\[\d+\]/.test(p)) return last === 'dr' || last === 'cr';
  if (/^vouchers\[\d+\]\.deprReverted\[\d+\]/.test(p)) return last === 'amt';
  if (/^openingBalances\./.test(p)) return ['dr', 'cr', 'yb', 'ytdDr', 'ytdCr'].indexOf(last) >= 0;
  if (/^payrolls\[\d+\]/.test(p)) return last === 'should' || last === 'real';
  if (/^cashFlowOpening\./.test(p)) return last === 'ytd';
  if (/yearBoundaries/.test(p)) return ['maxDiff', 'prevEnd', 'curOpen', 'diff'].indexOf(last) >= 0;
  return false;
}

/* 资产类别编码→名称映射（供放行⑦用）：v5 基线存编码、v6 文件存名称，
   当且仅当能在 v6.assetCats 中找到 code=编码 且 name=名称 的条目，才算"格式升级等价"。 */
function catCodeToName(book, code) {
  const cats = (book && Array.isArray(book.assetCats)) ? book.assetCats : [];
  for (const c of cats) if (String(c.code) === String(code)) return c.name;
  return undefined;
}

function compare(newBook, oldBook) {
  const res = { leaves: 0, scaled: 0, zero: 0, unchanged: 0, missed: [], bad: [] };
  function walk(a, b, p) {
    const ta = a === null ? 'null' : Array.isArray(a) ? 'array' : typeof a;
    const tb = b === null ? 'null' : Array.isArray(b) ? 'array' : typeof b;
    if (ta !== tb) { res.bad.push(p + ' 类型不同：' + ta + ' vs ' + tb); return; }
    if (ta === 'array') {
      if (a.length !== b.length) {
        // 放行④（2026-10-21）：结账模板定义改为随账套存储（原在 localStorage['settle_templates_v1']），
        //   迁移会把旧键里的定义并进 v6 账套，故 v5 基线该数组为 0 条属**预期新增**，不是迁移破坏。
        //   只在「基线为空」时放行；两边都有内容时仍严格比长度。
        if (p === 'settleTemplates' && b.length === 0) return;
        // 放行⑥：depts 是用户可增删的基础资料，迁移脚本不触碰它；任何差异均来自
        //   用户运行期编辑（增删部门），非迁移破坏，不属金额保真审计范围。
        if (p === 'depts') return;
        res.bad.push(p + ' 长度不同：' + a.length + ' vs ' + b.length); return;
      }
      for (let i = 0; i < a.length; i++) walk(a[i], b[i], p + '[' + i + ']');
      return;
    }
    if (ta === 'object') {
      // 放行③（2026-10-21）：`_` 前缀一律视为内部标记位（如 _settleTplMigrated = 结账模板已迁移），
      //   不参与键集合与逐字比较 —— 它是运行期状态，不是账套业务字段。
      //   【为什么是"先剔除再比"而不是"键集合不同就 return"】后者会跳过整棵子树的深度比较，
      //   等于把该对象的迁移保真检查整段废掉（同层真正的业务键差异会被一并放过）。
      const ka = Object.keys(a).filter(k => k.charAt(0) !== '_').sort();
      const kb = Object.keys(b).filter(k => k.charAt(0) !== '_').sort();
      if (ka.join(',') !== kb.join(',')) {
        // 放行①：运行期懒初始化给老账套加的空 cashFlowOpening 键（store.getCashFlowOpening
        //   原先会就地塞 {} 并写盘）。这是迁移后用户操作的副作用，非迁移破坏了结构；
        //   真实账套若录过现金流量期初，v5 基线也会有该键且金额已 ×10000，不会走到这里。
        var onlyCfEmpty = ka.length === kb.length + 1 && ka.indexOf('cashFlowOpening') >= 0
          && kb.indexOf('cashFlowOpening') < 0 && JSON.stringify(a.cashFlowOpening || {}) === '{}';
        if (onlyCfEmpty) return;
        // 放行②：整个 param 子树是用户运行期可改参数（bookHideZero / thousand …），
        //   对照「迁移前的 v5 备份」必然包含用户后续操作，属对照法假阳性，非迁移破坏。
        if (p === 'param') return;
        /* 放行⑤（2026-10-22）：凭证的 kind（期末业务类型）由 store.normalizeState 里的
         *   ensureVoucherKinds() 按**科目结构**回填，属**预期新增**字段，不是迁移破坏 ——
         *   与放行④（结账模板随账套存储）同类：都是"加载/迁移时补出来的元数据"。
         *   实测背景：修好「未分配利润为明细科目」的年结识别后，绅蓝之星有 2 张导入的年结凭证
         *   （2024-12 记-150、2025-12 记-67）被补上 kind=carryYE，本脚本因此报「多[kind]」。
         *   【为什么不干脆全放行】仍要求 ① 只多 kind 这一个键（防止同层其它字段被悄悄增删）；
         *   ② kind 取值必须在已知枚举内（防止回填逻辑坏掉、写入错值也被放过）。 */
        var onlyKind = ka.length === kb.length + 1
          && /^vouchers\[\d+\]$/.test(p)
          && ka.filter(function (k) { return kb.indexOf(k) < 0; }).join(',') === 'kind'
          && ['carryPL', 'carryYE', 'depr', 'carryCost', 'payrollAcc', 'payrollPay', 'profitDist']
            .indexOf(a.kind) >= 0;
        if (onlyKind) return;
        res.bad.push(p + ' 键集合不同：多[' + ka.filter(k => kb.indexOf(k) < 0) + '] 少[' + kb.filter(k => ka.indexOf(k) < 0) + ']');
        return;
      }
      ka.forEach(k => walk(a[k], b[k], p ? p + '.' + k : k));
      return;
    }
    res.leaves++;
    if (p === 'schemaVersion') return;                       // 版本号本来就该变
    if (ta === 'number') {
      if (!isFinite(a) || !isFinite(b)) { res.bad.push(p + ' 非有限数 ' + a + ' vs ' + b); return; }
      const scaled = Math.round(Math.abs(b) * AMT_SCALE) * (b < 0 ? -1 : 1);
      if (a === scaled) { if (a === 0) res.zero++; else res.scaled++; return; }
      if (a === b) {
        if (isMoneyPath(p)) res.missed.push(p + '  v5=' + b + ' → v6=' + a + '（金额字段却没有 ×10000）');
        res.unchanged++;
        return;
      }
      if (isMoneyPath(p)) res.bad.push(p + ' 既非 ×10000 也非不变：v5=' + b + ' → v6=' + a + '（期望 ' + scaled + '）');
      else res.bad.push(p + ' 非金额字段被改动：v5=' + b + ' → v6=' + a + '（迁移不该碰它）');
      return;
    }
    if (a !== b) {
      if (p.indexOf('param.') === 0) return;   // 用户运行期参数（放行②）：非迁移破坏
      // 放行⑦：fixedAssets[].category 编码→名称是 migrateAssetCategoryToName 的有意格式升级
      //   （资产类别维度下线，卡片存名称而非档案编码，由 normalizeState 触发一次）。
      //   仅当 v5 编码能在 v6.assetCats 映射到 v6 名称才放行，仍拦"真·编码错配"。
      if (/^fixedAssets\[\d+\]\.category$/.test(p) && catCodeToName(newBook, b) === a) return;
      res.bad.push(p + ' 值不同：' + JSON.stringify(a) + ' vs ' + JSON.stringify(b));
    }
  }
  walk(newBook, oldBook, '');
  return res;
}

function sumVouchers(book) {
  let dr = 0, cr = 0;
  (book.vouchers || []).forEach(v => (v.entries || []).forEach(e => { dr += Number(e.dr) || 0; cr += Number(e.cr) || 0; }));
  return { dr, cr };
}

function report(name, newBook, oldBook) {
  const r = compare(newBook, oldBook);
  const bad = r.bad.length + r.missed.length;
  const sa = sumVouchers(newBook), sb = sumVouchers(oldBook);
  console.log('  账套：' + name);
  console.log('    叶子 ' + r.leaves + '｜金额 ×10000 一致 ' + r.scaled + '｜双方为 0 ' + r.zero +
    '｜非金额不变 ' + r.unchanged + '｜**漏迁** ' + r.missed.length + '｜异常 ' + r.bad.length);
  console.log('    借贷合计 v5 dr=' + sb.dr.toFixed(4) + ' cr=' + sb.cr.toFixed(4) +
    ' → v6 dr=' + sa.dr + ' cr=' + sa.cr + '（÷10000 = ' + (sa.dr / AMT_SCALE).toFixed(4) + ' / ' + (sa.cr / AMT_SCALE).toFixed(4) + '）');
  r.missed.slice(0, 10).forEach(x => console.log('    ✗ ' + x));
  r.bad.slice(0, 10).forEach(x => console.log('    ✗ ' + x));
  return bad === 0;
}

/* ---------------- 入口 ---------------- */
const argBook = process.argv[2] || null, argBase = process.argv[3] || null;

if (argBook && argBase) {
  const a = JSON.parse(fs.readFileSync(argBook, 'utf8'));
  const b = JSON.parse(fs.readFileSync(argBase, 'utf8'));
  const ok = report(path.basename(argBook) + '（人工指定基线）', a, b);
  console.log('');
  console.log(ok ? '✓ 迁移保真：每个金额都恰为 ×10000，其余字段逐字未变' : '✗ 发现异常，见上');
  process.exit(ok ? 0 : 1);
}

/* 默认：为每个 v6 账套自动找"同期 v5 基线"（科目数 + 凭证数都相同） */
const books = [];
try {
  fs.readdirSync(BOOKS_DIR).filter(f => f.endsWith('.json')).forEach(f => {
    try {
      const o = JSON.parse(fs.readFileSync(path.join(BOOKS_DIR, f), 'utf8'));
      if (o.schemaVersion === V6) books.push({ f: f, o: o });
    } catch (e) { }
  });
} catch (e) { }

let auditCount = 0, failCount = 0, noBase = 0;
books.forEach(bk => {
  let base = null;
  try {
    const cands = fs.readdirSync(BACKUPS_DIR)
      .filter(f => f.indexOf(bk.f.replace(/\.json$/, '')) === 0 && f.endsWith('.json'))
      .map(f => ({ f: f, t: fs.statSync(path.join(BACKUPS_DIR, f)).mtimeMs }))
      .sort((x, y) => y.t - x.t);                                  // 新的优先
    for (const c of cands) {
      let o;
      try { o = JSON.parse(fs.readFileSync(path.join(BACKUPS_DIR, c.f), 'utf8')); } catch (e) { continue; }
      if (o.schemaVersion === V6) continue;                        // 要的是迁移**前**的
      // 必须同期：科目数与凭证数都一致，否则不是"同一个账套的前一刻"
      if ((o.subjects || []).length !== (bk.o.subjects || []).length) continue;
      if ((o.vouchers || []).length !== (bk.o.vouchers || []).length) continue;
      base = { f: c.f, o: o }; break;
    }
  } catch (e) { }
  if (!base) { noBase++; console.log('  · ' + bk.f + '：找不到同期的 v5 基线（未对照）'); return; }
  auditCount++;
  if (!report(bk.f + '  ↔  ' + base.f, bk.o, base.o)) failCount++;
});

console.log('');
if (!auditCount && !noBase && !books.length) {
  console.log('跳过：' + BOOKS_DIR + ' 下没有 v6（已迁移）账套可审计');
  process.exit(0);
}
if (!auditCount) {
  console.log('跳过：没有找到可对照的「v6 账套 + 同期 v5 基线」组合（' + noBase + ' 本缺基线）');
  process.exit(0);
}
/* 结论行必须带明确的 ✓/✗ 与「结果：」—— run-all 会拒绝"只靠退出码的通过"
   （2026-09-30 实测：本脚本首版就因此被它标为「无断言痕迹」）。 */
console.log(failCount
  ? '结果：迁移保真 ✗ —— 对照 ' + auditCount + ' 本，异常 ' + failCount + ' 本'
    + (noBase ? '，另 ' + noBase + ' 本缺基线未对照' : '')
  : '结果：迁移保真 ✓ —— 对照 ' + auditCount + ' 本，每个金额都恰为 ×10000、其余字段逐字未变'
    + (noBase ? '（另 ' + noBase + ' 本缺同期基线，未对照）' : ''));
process.exit(failCount ? 1 : 0);
