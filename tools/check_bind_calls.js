'use strict';
/* 事件绑定函数调用检查（2026-09-18）
 *
 * 背景：js/pages/ 下每个页面模块都有形如 bindXxx() 的事件绑定函数，约定由同模块的
 * renderXxx() 负责调用（模块级只定义、不执行）。一旦忘记调用，就产生"孤儿函数"——
 * 该页**全部交互静默失效**，页面上只表现为"点了没反应"：不报错、不影响渲染、控制台
 * 也很干净（顶多是 null 相关的报错都碰不到），因此极难发现。
 *
 * 实测事故：「原始凭证」页的 bindOriginal() 从未被调用 —— 过滤开关点不开、收起无效、
 * 6 个筛选下拉与查询按钮全部无反应。用户反馈"过滤一直点击没反应"才被发现。
 *
 * 检查逻辑：扫描 js/ 下所有 function bindXxx() 定义，若该标识符在全项目中只出现 1 次
 * （即只有定义本身、没有任何调用），判定为孤儿函数。
 *
 * 用法：node tools/check_bind_calls.js   （退出码 1 表示存在孤儿函数）
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

const files = walk(path.join(ROOT, 'js'), []);
const srcs = files.map(function (f) { return { rel: path.relative(ROOT, f), src: fs.readFileSync(f, 'utf8') }; });
const all = srcs.map(function (x) { return x.src; }).join('\n');

const orphans = [];
srcs.forEach(function (x) {
  const re = /^function\s+(bind[A-Za-z0-9_]+)\s*\(/gm;
  let m;
  while ((m = re.exec(x.src))) {
    const name = m[1];
    // 全项目出现次数：>1 说明除了定义还有调用点
    const total = (all.match(new RegExp('\\b' + name + '\\b', 'g')) || []).length;
    if (total <= 1) orphans.push({ name: name, file: x.rel });
  }
});

console.log('事件绑定函数调用检查');
console.log('  扫描 ' + srcs.length + ' 个 js 文件');

if (!orphans.length) {
  console.log('\n✓ 所有 bindXxx 函数都有调用点，无孤儿函数');
  process.exit(0);
}
console.log('\n★ 以下 ' + orphans.length + ' 个绑定函数**只定义、从未被调用**（该页交互会静默失效）：');
orphans.forEach(function (o) { console.log('  · ' + o.name + '()  定义于 ' + o.file); });
console.log('\n修法：在对应模块的 renderXxx() 开头调用它（内部通常有 XxxBound 守卫，重复调用安全）。');
process.exit(1);
