#!/usr/bin/env node
/* ============================================================
 * check-period-contract.js —— 期间控件契约自检（发版前卡口）
 *
 * 背景：期间控件的「UI 交互」是全局共用的，但「默认期间是什么 / 值怎么填」
 *       一度由 16 个页面各自决定，其中 8 个是逐字拷贝 —— 典型的「改一处漏五处」。
 *       已收敛为：默认值由 index.html 的 data-default 声明、由组件单点解析、
 *       页面统一走 periodRangeValue(prefix)。本脚本把这套契约固化成机器检查，
 *       防止日后有人图省事又在各页面手写初始化。
 *
 * 检查项：
 *   1) 每个 data-period 占位符都必须声明 data-default（且取值合法）
 *   2) 每个 data-on-change 回调都必须在 js/main.js 注册为全局函数
 *   3) js/pages/ 下不得直接给期间输入赋值（默认值与填充只允许走单点实现）
 *   4) 期间控件两端（Start/End）必须用同一个表达式赋值 —— 「只产出一个报告期」的核心契约
 *   5) 不得重新引入 data-single 双模开关（要跨期请加「粒度」，不要把起止端点加回来）
 *
 * 退出码：0 = 通过；1 = 存在违规（发布应中止）
 * ============================================================ */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const INDEX_HTML = path.join(ROOT, 'index.html');
const MAIN_JS = path.join(ROOT, 'js', 'main.js');
const PAGES_DIR = path.join(ROOT, 'js', 'pages');
const JS_DIR = path.join(ROOT, 'js');
const PICKER_JS = path.join(ROOT, 'js', 'components', 'PeriodRangePicker.js');
// 允许给期间输入赋值的单点实现（其余位置一律禁止）
const ALLOWED_ASSIGN = new Set([
  path.join(ROOT, 'js', 'app.js'),                        // periodRangeValue 单点实现
  path.join(ROOT, 'js', 'components', 'PeriodRangePicker.js'), // 组件自身（openPop/applySelection）
  __filename,
]);

const VALID_DEFAULTS = new Set(['currentPeriod', 'lastClosedPeriod']);
const errors = [];
const warns = [];

function read(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (e) { return ''; }
}

/* ---------- 收集 index.html 里的期间占位符 ---------- */
const html = read(INDEX_HTML);
if (!html) {
  console.error('[check-period-contract] 读取 index.html 失败');
  process.exit(1);
}

const hosts = [];
for (const m of html.matchAll(/<div\s+([^>]*\bdata-period="[^"]*"[^>]*)>/g)) {
  const attrs = m[1];
  const id = (attrs.match(/data-period="([^"]*)"/) || [])[1];
  const def = (attrs.match(/data-default="([^"]*)"/) || [])[1];
  const onChange = (attrs.match(/data-on-change="([^"]*)"/) || [])[1];
  if (id) hosts.push({ id, def, onChange });
}

if (!hosts.length) {
  errors.push('index.html 中未找到任何 data-period 占位符（期间控件可能被整体移除或改写）');
}

/* ---------- 规则 1：必须声明合法的 data-default ---------- */
for (const h of hosts) {
  if (!h.def) {
    errors.push(`[默认值未声明] data-period="${h.id}" 缺少 data-default（应声明 currentPeriod 或 lastClosedPeriod）`);
  } else if (!VALID_DEFAULTS.has(h.def)) {
    errors.push(`[默认值非法] data-period="${h.id}" 的 data-default="${h.def}" 不在允许范围内（currentPeriod / lastClosedPeriod）`);
  }
}

/* ---------- 规则 2：data-on-change 必须已注册为全局函数 ---------- */
const mainSrc = read(MAIN_JS);
for (const h of hosts) {
  if (!h.onChange) {
    errors.push(`[回调缺失] data-period="${h.id}" 未声明 data-on-change`);
    continue;
  }
  const re = new RegExp('globalThis\\.' + h.onChange.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*=');
  if (!re.test(mainSrc)) {
    errors.push(`[回调未注册] data-on-change="${h.onChange}"（${h.id}）在 js/main.js 中未挂到 globalThis，选完期间不会刷新`);
  }
}

/* ---------- 规则 3：页面不得直接给期间输入赋值 ---------- */
// 识别「期间输入」：xxPeriodStart / xxPeriodEnd，或约定的临时变量名。
// 注意用 \b 词边界：否则 codeInput 会被误判（其中含子串 eInp = c-o-d-eInp-u-t）。
const PERIOD_INPUT_RE = /\b[\w$]*Period(?:Start|End)\b|\bsInp\b|\beInp\b|\bstartSel\b|\bendSel\b/;

// 向上找最近的函数名，用于识别「跳转设置期间」这类正常用途
function enclosingFunctionName(lines, idx) {
  for (let i = idx; i >= 0; i--) {
    const line = lines[i];
    const m = line.match(/function\s+([A-Za-z_$][\w$]*)/)
           || line.match(/(?:globalThis|window)\.([A-Za-z_$][\w$]*)\s*=\s*(?:function|[\w$])/)
           || line.match(/\b([A-Za-z_$][\w$]*)\s*=\s*function/);
    if (m) return m[1];
  }
  return '';
}

function scanDir(dir) {
  let files = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) files = files.concat(scanDir(p));
    else if (name.endsWith('.js')) files.push(p);
  }
  return files;
}

const pageFiles = fs.existsSync(PAGES_DIR) ? scanDir(PAGES_DIR) : [];
for (const file of pageFiles) {
  if (ALLOWED_ASSIGN.has(file)) continue;
  const src = read(file);
  const lines = src.split(/\r?\n/);
  lines.forEach((line, i) => {
    // 只看给「期间输入」赋值的行
    if (!PERIOD_INPUT_RE.test(line)) return;
    if (!/\.value\s*=/.test(line)) return;
    if (/==|===|!==|!=/.test(line)) return;             // 比较而非赋值
    // 跳转时设置目标页期间属正常用途（如 __glJumpTo / __plJumpToRow），不算违规
    if (/jump/i.test(enclosingFunctionName(lines, i))) return;
    if (/\|\|/.test(line)) {
      warns.push(`[建议收敛] ${path.relative(ROOT, file)}:${i + 1} 仍在内联兜底默认值：${line.trim()}`);
      return;
    }
    errors.push(`[禁止直接赋值] ${path.relative(ROOT, file)}:${i + 1} 不应给期间输入赋值（默认值请走 data-default + periodRangeValue）：${line.trim()}`);
  });
}

/* ---------- 规则 4：两端 hidden input 必须恒等（单期契约的核心） ---------- */
// 「控件只产出一个报告期」的机器可校验形式：凡是给期间输入赋值的地方，Start 与 End 两侧
// 必须用「同一个表达式」赋值（把被赋值的变量名归一成 <SELF> 后逐一比对）。
// 若有人只改一端、或给两端写不同的值，就等于把范围语义悄悄加回来了 —— 那正是
// 「总账页选了期间没反应」的成因：动的那一端不参与取数，表格自然毫无变化。
// 已按此规则查出并修掉两处真实违规：__glJumpTo(首页「本年」传 from~to) 与 __plJumpToRow。
const PERIOD_INPUT_WRITE = /\b([\w$]+)\.value\s*=\s*([^;]+)/g;
const ALIAS_START = new Set(['sInp', 'startInput', 'startSel']);
const ALIAS_END = new Set(['eInp', 'endInput', 'endSel']);

function periodSide(v) {
  if (/PeriodStart$/.test(v) || ALIAS_START.has(v)) return 'start';
  if (/PeriodEnd$/.test(v) || ALIAS_END.has(v)) return 'end';
  return null;
}

const writes = { start: [], end: [] };
for (const file of (fs.existsSync(JS_DIR) ? scanDir(JS_DIR) : [])) {
  if (file === __filename) continue;
  read(file).split(/\r?\n/).forEach((line, i) => {
    for (const m of line.matchAll(PERIOD_INPUT_WRITE)) {
      const side = periodSide(m[1]);
      if (!side) continue;
      const self = new RegExp('\\b' + m[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'g');
      writes[side].push({ where: `${path.relative(ROOT, file)}:${i + 1}`, norm: m[2].replace(self, '<SELF>').trim() });
    }
  });
}

if (!writes.start.length || !writes.end.length) {
  errors.push('[两端写入缺失] 未在 js/ 下找到期间的 Start/End 赋值 —— 控件可能已被改写，请人工确认');
} else {
  const sSet = [...new Set(writes.start.map(w => w.norm))].sort();
  const eSet = [...new Set(writes.end.map(w => w.norm))].sort();
  if (sSet.join(' ¦ ') !== eSet.join(' ¦ ')) {
    const locate = (list, arr) => list.map(x => `"${x}"（${arr.filter(w => w.norm === x).map(w => w.where).join('、')}）`).join('；');
    const onlyS = sSet.filter(x => !eSet.includes(x));
    const onlyE = eSet.filter(x => !sSet.includes(x));
    errors.push('[两端不等值] Start 与 End 用了不同的赋值表达式 —— 等于把范围语义加回来了（契约要求两端恒等）'
      + (onlyS.length ? `\n        仅 Start 侧：${locate(onlyS, writes.start)}` : '')
      + (onlyE.length ? `\n        仅 End   侧：${locate(onlyE, writes.end)}` : ''));
  }
}

/* ---------- 规则 5：不得重新引入「范围 / 单期」双模开关 ---------- */
// data-single 是旧范围设计的开关，清理时已连同组件透传一并删除（全库零消费方）。
// 它若再次出现，通常意味着有人想给控件加回范围模式 —— 那会推翻单期契约。
// 正确做法是加「粒度」（月/季/年）由粒度派生区间，理由见 CHANGELOG 2026-09-13。
for (const [file, src] of [[INDEX_HTML, html], [PICKER_JS, read(PICKER_JS)]]) {
  if (/data-single/.test(src)) {
    errors.push(`[双模开关回归] ${path.relative(ROOT, file)} 中出现 data-single —— 该开关已废弃。`
      + '要支持跨期请加「粒度」（月/季/年）并派生区间，不要把起止端点加回来。');
  }
}

/* ---------- 输出 ---------- */
console.log('============================================');
console.log('  期间控件契约自检');
console.log('============================================');
console.log(`  期间控件数量：${hosts.length}`);
const byKind = {};
hosts.forEach(h => { byKind[h.def || '(未声明)'] = (byKind[h.def || '(未声明)'] || 0) + 1; });
Object.keys(byKind).sort().forEach(k => console.log(`    ${k}: ${byKind[k]}`));
console.log('');

if (warns.length) {
  console.log(`  提示 ${warns.length} 条：`);
  warns.forEach(w => console.log('    · ' + w));
  console.log('');
}

if (errors.length) {
  console.log(`  ✗ 发现 ${errors.length} 项违规：`);
  errors.forEach(e => console.log('    - ' + e));
  console.log('');
  console.log('  期间控件契约未通过，请修复后再发布。');
  process.exit(1);
}

console.log('  ✓ 全部通过：默认值均已声明、回调均已注册、页面无直接赋值、两端恒等、无双模开关');
process.exit(0);
