#!/usr/bin/env node
/* ============================================================
 * 版本号单一入口 —— 读 / 校验 / 一次改到位
 * ============================================================
 * 【为什么需要它】本仓库的版本号**散在 4 个文件**里，历史上因此漂过：
 *   - `7a674ce` 把 tauri.conf.json / Cargo.toml 从 1.1.6 降到 0.5.0（换新品牌线），
 *     但 `tauri/package.json` 一直停在 **1.1.2**；
 *   - `发布新版.command` 原来只 `sed` 了 tauri.conf.json —— 这正是「版本号统一」要消灭的那类不一致。
 * 四处各自的真实消费方：
 *   · tauri/src-tauri/tauri.conf.json  → tauri-action 读它定**安装包名 + Release**（权威源）
 *   · tauri/src-tauri/Cargo.toml       → Rust `CARGO_PKG_VERSION` → `app_version` 命令
 *                                        → 界面「软件版本」+ js/update.js 的**本地版本**
 *   · tauri/src-tauri/Cargo.lock       → cargo；`name = "ty"` 那个包块必须与 Cargo.toml 一致
 *   · tauri/package.json               → 只是 npm 壳，全库无人读；但留着旧号会误导人，故一并同步
 * （`dist` 里的 `?v=` 不是版本号，是 build-dist.mjs 注入的**内容指纹**，不参与本脚本。）
 *
 * 【用法】
 *   node tools/version.js                打印四处版本 + 一致性
 *   node tools/version.js --check         不一致 / 非法 / tag 已存在 → 非零退出（发版卡口用）
 *   node tools/version.js --set 0.5.2     一次把四处都改成 0.5.2
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const F = {
  conf: path.join(ROOT, 'tauri', 'src-tauri', 'tauri.conf.json'),
  cargo: path.join(ROOT, 'tauri', 'src-tauri', 'Cargo.toml'),
  lock: path.join(ROOT, 'tauri', 'src-tauri', 'Cargo.lock'),
  pkg: path.join(ROOT, 'tauri', 'package.json')
};
const SEMVER = /^\d+\.\d+\.\d+$/;

const read = p => fs.readFileSync(p, 'utf8');
// 只替换【顶层那一个】版本字段，避免把依赖版本一起改掉：
//   tauri.conf.json 全文只有 1 处 "version"（顶层）；
//   Cargo.toml 取第一个行首 version（即 [package] 的）；
//   package.json 取第一处 "version"；
//   Cargo.lock 必须定位到 name = "ty" 的包块（依赖里也有大量 version 行）。
function setInConf(s, v) {
  const m = s.match(/"version"\s*:\s*"[^"]*"/);
  if (!m) throw new Error('tauri.conf.json 里找不到 version 字段');
  return s.replace(m[0], '"version": "' + v + '"');
}
function setInCargo(s, v) {
  const m = s.match(/^version\s*=\s*"[^"]*"/m);
  if (!m) throw new Error('Cargo.toml 里找不到 [package] version');
  return s.replace(m[0], 'version = "' + v + '"');
}
function setInLock(s, v) {
  const re = /(\[\[package\]\]\nname = "ty"\nversion = ")[^"]+(")/;
  if (!re.test(s)) throw new Error('Cargo.lock 里找不到 name = "ty" 的包块');
  return s.replace(re, '$1' + v + '$2');
}
function setInPkg(s, v) {
  const m = s.match(/"version"\s*:\s*"[^"]*"/);
  if (!m) throw new Error('package.json 里找不到 version 字段');
  return s.replace(m[0], '"version": "' + v + '"');
}
// 读：只取「顶层/本包」那个值
function getConf(s) { const m = s.match(/"version"\s*:\s*"([^"]*)"/); return m ? m[1] : null; }
function getCargo(s) { const m = s.match(/^version\s*=\s*"([^"]*)"/m); return m ? m[1] : null; }
function getLock(s) { const m = s.match(/\[\[package\]\]\nname = "ty"\nversion = "([^"]*)"/); return m ? m[1] : null; }
function getPkg(s) { const m = s.match(/"version"\s*:\s*"([^"]*)"/); return m ? m[1] : null; }

function readAll() {
  return {
    'tauri.conf.json ': getConf(read(F.conf)),
    'Cargo.toml      ': getCargo(read(F.cargo)),
    'Cargo.lock (ty) ': getLock(read(F.lock)),
    'package.json    ': getPkg(read(F.pkg))
  };
}
// 当前仓库已有的 tag 列表（无 git / 无 tag 时返回空数组，不炸）
function tags() {
  try {
    return execFileSync('git', ['tag', '--list', 'v*'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n').map(s => s.trim()).filter(Boolean);
  } catch (e) { return []; }
}

function print() {
  const all = readAll();
  const vals = Object.keys(all).map(k => all[k]);
  console.log('版本号出处：');
  Object.keys(all).forEach(k => console.log('  ' + k + ' ' + (all[k] || '(缺失!)') + (SEMVER.test(all[k] || '') ? '' : '  ⚠️ 非 x.y.z')));
  const uniq = [...new Set(vals)];
  console.log('一致性：' + (uniq.length === 1 ? '✓ 四处一致（' + uniq[0] + '）' : '✗ 不一致 → ' + JSON.stringify(all)));
  return { all: all, uniq: uniq, v: uniq.length === 1 ? uniq[0] : null };
}

function main() {
  const argv = process.argv.slice(2);
  const setIdx = argv.indexOf('--set');
  const wantSet = setIdx >= 0 ? String(argv[setIdx + 1] || '').replace(/^v/, '') : null;

  if (wantSet) {
    if (!SEMVER.test(wantSet)) { console.error('✗ 版本号格式不对（应为三段数字，如 0.5.2）：' + wantSet); process.exit(1); }
    fs.writeFileSync(F.conf, setInConf(read(F.conf), wantSet));
    fs.writeFileSync(F.cargo, setInCargo(read(F.cargo), wantSet));
    fs.writeFileSync(F.lock, setInLock(read(F.lock), wantSet));
    fs.writeFileSync(F.pkg, setInPkg(read(F.pkg), wantSet));
    console.log('已把四处版本号设为 ' + wantSet + '：');
    const r = print();
    process.exit(r.uniq.length === 1 ? 0 : 1);
  }

  const r = print();

  if (argv.indexOf('--check') < 0) {
    const t = tags();
    if (t.length) console.log('仓库现有 v* tag：' + t.length + ' 个 → ' + t.join(', '));
    process.exit(0);
  }

  let bad = 0;
  if (r.uniq.length !== 1) { console.error('✗ 四处版本号不一致 —— 发版前必须统一（node tools/version.js --set <版本>）'); bad++; }
  if (r.v && !SEMVER.test(r.v)) { console.error('✗ 版本号非法：' + r.v); bad++; }
  if (r.v) {
    const t = tags();
    if (t.indexOf('v' + r.v) >= 0) { console.error('✗ tag v' + r.v + ' 已存在 —— 重复打 tag 会让工作流去更新既有 Release，请先升版本号'); bad++; }
    // 提示性检查（不失败）：仓库里存在**比当前版本更高**的 tag，多半是历史品牌线
    const higher = t.filter(x => {
      const a = x.slice(1).split('.').map(Number), b = r.v.split('.').map(Number);
      for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0); }
      return false;
    });
    if (higher.length) console.log('ℹ️ 仓库里存在比当前更高的 tag（历史品牌线，正常）：' + higher.slice(0, 3).join(', ') + (higher.length > 3 ? ' …' : ''));
  }
  console.log(bad ? '\n✗ 版本号自检未通过（' + bad + ' 项）' : '\n✓ 版本号自检通过（四处一致：' + r.v + '）');
  process.exit(bad ? 1 : 0);
}
main();
