/* 表格容器健康检查（只读扫描，不修改任何文件）
 * 运行：node tools/scan_table_containers.js
 *
 * 检查每个 .grid 表格：
 *   ① 溢出时由谁滚动（往上找第一个能滚动的祖先）
 *   ② 该滚动容器是否有确定高度 —— 决定表头 position:sticky 能否生效
 *   ③ 该滚动容器是否有兄弟元素会被表格撑走（如右侧侧栏）
 *
 * 背景知识（本脚本的判定依据）：
 *   - CSS 规范：overflow-x 为 auto/scroll/hidden 而 overflow-y 为 visible 时，
 *     visible 会被**计算成 auto**。所以 `.grid-wrap{overflow-x:auto;overflow-y:visible}`
 *     实际是双向滚动容器，只是没有高度 → 纵向滚动范围为 0 → sticky 不生效。
 *   - position:sticky 的粘性参考是「最近的滚动祖先」。该祖先必须真的能滚动，
 *     否则 sticky 元素只是随文档流一起滚走（表现为表头被顶出去/不吸顶）。
 *   - 获得确定高度的方式：height / max-height / flex:1 + min-height:0（父级需为 flex）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(ROOT, 'css/style.css'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/* ---------- 1. 解析 CSS ---------- */
function parseCss(src) {
  const rules = [];
  let buf = '', sel = '', depth = 0, inC = null, inS = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (inC) { if (c === '*' && n === '/') { inC = null; i++; } continue; }
    if (inS) { if (c === inS && src[i - 1] !== '\\') inS = null; continue; }
    if (c === '/' && n === '*') { inC = 1; i++; continue; }
    if (c === '/' && n === '/') { inC = 'l'; continue; }
    if (c === '"' || c === "'") { inS = c; continue; }
    if (c === '{') { if (depth === 0) { sel = buf.trim(); buf = ''; } depth++; continue; }
    if (c === '}') { depth--; if (depth === 0) { rules.push({ sel, body: buf }); buf = ''; } continue; }
    buf += c;
  }
  return rules;
}
const rules = parseCss(css);

// 取某选择器的声明（简单精确匹配，够用）
function declsFor(sel) {
  const out = {};
  for (const r of rules) {
    if (r.sel.split(',').map(s => s.trim()).includes(sel)) {
      for (const d of r.body.split(';')) {
        const i = d.indexOf(':');
        if (i > 0) out[d.slice(0, i).trim()] = d.slice(i + 1).trim();
      }
    }
  }
  return out;
}

const getOverflow = (d) => ({
  x: d['overflow-x'] || d['overflow'] || 'visible',
  y: d['overflow-y'] || d['overflow'] || 'visible'
});
// 按 CSS 规范修正：一个非 visible、另一个 visible 时，visible 计算为 auto
function effectiveOverflow(d) {
  let { x, y } = getOverflow(d);
  const isVis = v => v === 'visible';
  if (!isVis(x) && isVis(y)) y = 'auto';
  if (isVis(x) && !isVis(y)) x = 'auto';
  return { x, y };
}
const scrollable = o => ['auto', 'scroll'].includes(o.x) || ['auto', 'scroll'].includes(o.y);
// 真正的高度约束。注意 max-height:none 是「无限制」，不算高度约束（曾误判导致漏报）
const isNone = v => !v || v === 'none' || v === 'auto' || v === '0';
const hasHeight = d =>
  (!isNone(d.height)) ||
  (!isNone(d['max-height'])) ||
  (!!d.flex && !isNone(d['min-height']));   // flex:1 + min-height:0 → 由父级分配确定高度

/* ---------- 2. 解析 HTML，建祖先链 ---------- */
// 提取所有标签（开/闭/自闭合），记录行号
const tags = [];
const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;
let m;
while ((m = tagRe.exec(html))) {
  const [full, slash, name, attrs] = m;
  tags.push({
    name: name.toLowerCase(),
    close: slash === '/',
    self: /\/\s*$/.test(attrs),
    cls: (attrs.match(/class="([^"]*)"/) || [])[1] || '',
    id: (attrs.match(/id="([^"]*)"/) || [])[1] || '',
    line: html.slice(0, m.index).split('\n').length,
    idx: m.index
  });
}

// 对每个 table.grid，回溯其开标签栈得到祖先链
const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'col', 'area', 'base', 'source']);
const stack = [];
const results = [];
for (const t of tags) {
  if (VOID.has(t.name) || t.self) continue;
  if (t.close) { for (let i = stack.length - 1; i >= 0; i--) { if (stack[i].name === t.name) { stack.length = i; break; } } continue; }
  stack.push(t);
  if (t.name === 'table' && /\bgrid\b/.test(t.cls)) {
    results.push({ table: t, chain: stack.slice(0, -1).reverse() });
  }
}

/* ---------- 3. 分析 ---------- */
console.log('表格容器健康检查\n' + '='.repeat(96));

const problems = [];
for (const { table, chain } of results) {
  const id = table.id || '(无id)';
  // 往上找第一个可滚动的祖先
  let sc = null;
  for (const a of chain) {
    const keys = [];
    if (a.id) keys.push('#' + a.id);
    const cs = a.cls.split(/\s+/).filter(Boolean);
    for (const c of cs) keys.push('.' + c);
    // 组合选择器：如 class="page active" 需匹配 CSS 里的 ".page.active"
    if (cs.length > 1) keys.push('.' + cs.join('.'));
    // 特例：HTML 里只写 class="page"，.active 由 JS 运行时添加，
    // CSS 规则写作 .page.active。这里补上该组合，否则会误报"无滚动祖先"。
    if (cs.includes('page')) keys.push('.page.active');
    for (const k of keys) {
      const d = declsFor(k);
      if (Object.keys(d).length && scrollable(effectiveOverflow(d))) { sc = { el: a, key: k, d }; break; }
    }
    if (sc) break;
  }
  if (!sc) {
    problems.push({ id, kind: '无滚动祖先', detail: '表格溢出会直接撑宽页面', line: table.line });
    continue;
  }
  const oe = effectiveOverflow(sc.d);
  const canScrollY = ['auto', 'scroll'].includes(oe.y);
  const height = hasHeight(sc.d);
  const flexOK = !!(sc.d.flex && (sc.d['min-height'] === '0' || sc.d['min-height'] === '0px'));
  const stickyOK = canScrollY && (height || flexOK);
  if (!stickyOK) {
    problems.push({
      id, kind: '表头sticky失效',
      detail: `滚动祖先 ${sc.key}：overflow-y=${oe.y}，${height ? '有高度' : (flexOK ? 'flex有高度' : '无高度约束')} → 纵向滚动范围为0`,
      line: table.line, key: sc.key
    });
  }
}

// 汇总
const byKind = {};
for (const p of problems) (byKind[p.kind] = byKind[p.kind] || []).push(p);
console.log(`共 ${results.length} 张 .grid 表格，发现 ${problems.length} 处风险\n`);
for (const [kind, list] of Object.entries(byKind)) {
  console.log(`【${kind}】 ${list.length} 处`);
  for (const p of list) console.log(`   L${String(p.line).padEnd(5)} #${p.id.padEnd(16)} ${p.detail}`);
  console.log('');
}

// 统计滚动祖先分布
const dist = {};
for (const { table, chain } of results) {
  for (const a of chain) {
    const keys = [];
    if (a.id) keys.push('#' + a.id);
    for (const c of a.cls.split(/\s+/).filter(Boolean)) keys.push('.' + c);
    for (const k of keys) {
      const d = declsFor(k);
      if (Object.keys(d).length && scrollable(effectiveOverflow(d))) { dist[k] = (dist[k] || 0) + 1; break; }
    }
  }
}
console.log('滚动祖先分布（谁在负责滚动）：');
Object.entries(dist).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`   ${k.padEnd(28)} ${v} 张表`));
