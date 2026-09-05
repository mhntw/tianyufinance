// 静态检查：确认业务页面里不再有「裸」原生 confirm(/prompt(/alert( 调用。
// 允许的例外：
//   1) js/dialog-bridge.js 内的实现与其 fallback；
//   2) 形如 window.confirm / window.prompt / window.alert 的显式调用（仅 bridge fallback 使用）；
//   3) 字符串或注释中的出现；mdb-reader.js 为第三方库内部（其 message() 非弹窗）。
// 运行：node tools/check_no_native_dialog.js

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'js');
const allowFiles = new Set(['dialog-bridge.js', 'mdb-reader.js']);

function walk(dir) {
  let out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walk(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = walk(root);
let problems = 0;
for (const f of files) {
  if (allowFiles.has(path.basename(f))) continue;
  const src = fs.readFileSync(f, 'utf8').split('\n');
  src.forEach((line, i) => {
    // 跳过注释行
    const code = line.replace(/\/\/.*$/, '');
    // 裸 confirm( / prompt( / alert(，但排除 window.confirm / window.prompt / window.alert
    // 以及 bridge 内定义（allowFiles 已整体豁免 dialog-bridge.js）
    if (/\b(confirm|prompt|alert)\s*\(/.test(code) && !/window\.(confirm|prompt|alert)/.test(code)) {
      problems++;
      console.error('  ✗ 裸调用: ' + path.relative(root, f) + ':' + (i + 1) + '  ' + line.trim());
    }
  });
}

if (problems) {
  console.error('\n发现 ' + problems + ' 处裸原生 confirm/prompt 调用，需改为 H.confirmAsync / H.promptAsync');
  process.exit(1);
}
console.log('✓ 所有业务页面已无裸原生 confirm/prompt 调用（统一走异步 dialog 桥接）');
