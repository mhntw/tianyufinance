'use strict';
/* 可交互元素的「绑定空缺」检查（2026-09-18）
 *
 * 背景：本会话接连发现同一族问题 —— **HTML 里有元素，但 JS 从不引用它**：
 *   · bindOriginal 从未被调用 →「原始凭证」整页交互失效（过滤、筛选、查询全无反应）
 *   · 折旧凭证页 / 资产类别页的表头全选框无绑定
 *   · 资产变动记录页的 3 个显示选项（按部门汇总/显示已清理/显示变动信息）无绑定
 *   · 原始凭证页的「条/页」下拉与分页按钮无绑定
 *   · 两个 Modal 版弹窗整块废弃却留在 HTML 里（其内按钮自然永不生效）
 * 共性：控件长得完全正常，点了毫无反应，不报错、不影响渲染，因此极难发现。
 *
 * 检查逻辑：扫描 index.html 中 button / a / input / select 上定义的 id，
 *   若该 id 在全项目 JS 源码里一次都没出现，且该元素也没有 data-* 或内联 onclick，
 *   则列为「疑似空壳」。
 *
 * ⚠️ 已知误报来源：被动态拼接的 id（如 'page-' + name、'btn' + x）。这类 id 在源码里
 *    不会以完整字符串出现，会被误判。判断时请结合该元素所属页面是否由 JS 动态渲染。
 *
 * 用法：node tools/check_dead_elements.js   （退出码 1 表示存在疑似空壳）
 */
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');

function walk(dir, out) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  ents.forEach(function (e) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!/^(node_modules|\.git|dist|tauri|target)$/.test(e.name)) walk(p, out);
    } else if (/\.js$/.test(e.name) && !/\.min\.js$|xlsx\.full\.min|mdb-reader/.test(e.name)) {
      out.push(p);
    }
  });
  return out;
}

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const jsSrc = walk(path.join(ROOT, 'js'), []).map(function (f) { return fs.readFileSync(f, 'utf8'); }).join('\n');

function lineOf(idx) { return html.slice(0, idx).split('\n').length; }

// ---- 1) 可交互元素：有 id，但 JS 从未引用，也无 data-* / 内联处理器 ----
const reInt = /<(button|a|input|select)\b([^>]*\sid="([A-Za-z0-9_-]+)"[^>]*)>/g;
const sus = [];
let m;
while ((m = reInt.exec(html))) {
  const tag = m[1], attrs = m[2], id = m[3];
  if (jsSrc.indexOf(id) >= 0) continue;          // JS 里出现过即视为有引用
  if (/\bdata-|\bonclick=/.test(attrs)) continue; // 有 data-* 或内联处理器 → 另有机制
  sus.push({ tag: tag, id: id, line: lineOf(m.index) });
}

// ---- 2) 无 id、无 class、无 data-*、无 onclick 的 button/a（连被委托命中的机会都没有）----
const reShell = /<(button|a)\b([^>]*)>/g;
const shells = [];
while ((m = reShell.exec(html))) {
  const tag = m[1], attrs = m[2];
  if (/\bid=/.test(attrs)) continue;
  if (/\bonclick=|\bdata-|\bhref="#/.test(attrs)) continue;
  shells.push({ tag: tag, line: lineOf(m.index), cls: (attrs.match(/class="([^"]*)"/) || [])[1] || '(无 class)' });
}

console.log('可交互元素绑定空缺检查');
console.log('  index.html 中 button/a/input/select 定义 id 若干，JS 单文件数 ' + walk(path.join(ROOT, 'js'), []).length);

let fail = 0;
if (sus.length) {
  fail = 1;
  console.log('\n★ 以下 ' + sus.length + ' 个可交互元素有 id，但 JS 从未引用（页面上点了多半没反应）：');
  sus.forEach(function (s) {
    console.log('    ' + s.id.padEnd(24) + '<' + (s.tag + '>').padEnd(8) + ' index.html:' + s.line);
  });
  console.log('  处置：① 补上事件绑定；② 若确已废弃，删掉元素（连同相关 CSS/JS）。');
} else {
  console.log('\n✓ 未发现"有 id 却无绑定"的可交互元素');
}

if (shells.length) {
  console.log('\n· 另有 ' + shells.length + ' 个无 id/无 class/无 data-* 的 button|a（多为 JS 动态渲染的静态占位，会被覆盖）：');
  shells.slice(0, 8).forEach(function (s) {
    console.log('    index.html:' + String(s.line).padEnd(7) + '<' + s.tag + '> class="' + s.cls + '"');
  });
  if (shells.length > 8) console.log('    ...（其余 ' + (shells.length - 8) + ' 个略）');
}

process.exit(fail);
