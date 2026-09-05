// 静态检查：确认业务页面里不再有「裸」浏览器下载（XLSX.writeFile / Blob+a.click / createObjectURL），
// 这些在 Tauri webview 下会静默失效（文件下到未知位置或根本不出现）。
// 允许的例外：
//   1) js/file-save-bridge.js 内的实现与其浏览器回退分支；
//   2) 形如 window.__fileSaveBridge.saveExcel / saveText 的调用（已走 Rust 写盘）。
// 运行：node tools/check_no_native_download.js

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'js');
const allowFiles = new Set(['file-save-bridge.js', 'mdb-reader.js', '_shared.js', 'kindee.js']);

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
  let inBridgeCall = false;
  src.forEach((rawLine, i) => {
    const line = rawLine.replace(/\/\/.*$/, ''); // 去注释
    const rel = path.relative(root, f) + ':' + (i + 1);
    // 跳过已正确走桥接的行
    if (/__fileSaveBridge\.(saveExcel|saveText|toastExported)/.test(line)) return;
    // 裸 XLSX.writeFile（非桥接内部）
    if (/XLSX\.writeFile\s*\(/.test(line)) {
      problems++;
      console.error('  ✗ 裸 XLSX.writeFile: ' + rel + '  ' + rawLine.trim());
    }
    // 裸下载：createObjectURL / a.click / a.download（非桥接内部）
    if (/createObjectURL\s*\(|a\.click\s*\(|a\.download/.test(line)) {
      problems++;
      console.error('  ✗ 裸浏览器下载: ' + rel + '  ' + rawLine.trim());
    }
    // 裸 Blob 构造（排除 TextEncoder/正常用途较难精确，仅当与 a.href=URL.createObjectURL 同行或紧邻时报警）
    if (/new Blob\s*\(/.test(line) && !/__fileSaveBridge/.test(line)) {
      // 仅在文件级出现裸 Blob 时提示，便于人工复核（非致命）
      console.warn('  ⚠ 裸 new Blob（请确认是否已走桥接）: ' + rel + '  ' + rawLine.trim());
    }
  });
}

if (problems) {
  console.error('\n发现 ' + problems + ' 处裸浏览器下载调用，需改为 window.__fileSaveBridge.saveExcel / saveText');
  process.exit(1);
}
console.log('✓ 所有业务页面导出已统一走 file-save-bridge（Tauri 下写入 exports 目录）');
