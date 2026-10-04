'use strict';
/* 窗口最小尺寸卡口（秒级、纯静态、纳入 run-all 默认回归）
 *
 * 【守什么】"窗口不能被拖到布局会坏的那一段"这件事，靠三处保持一致：
 *   ① tauri/src-tauri/tauri.conf.json 的 app.windows[0].minWidth / minHeight
 *      （真正拦住用户拖拽的地方 —— 2026-10-04 之前**它根本不存在**，所以能一路拖到布局塌陷）
 *   ② tools/layout_min.js 的 SAFE_MIN（实测出来的安全边界，单一真值来源）
 *   ③ tools/layout_probe.js 的抽查档位（不得低于 SAFE_MIN，否则测的是"真机上到不了的尺寸"）
 *   任一处被改小/被改没，本脚本立刻报错 —— 免得下次又"静默退化"回能拖坏的状态。
 *
 * 【为什么不是浏览器测试】真机边界靠 layout_probe.js（手动跑，需浏览器）；本脚本只做
 *   静态一致性守护，保证"实测结论"不会被后来的改动悄悄推翻，且零成本进默认回归。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const errors = [];

/* ① 单点常量 */
let safeMin = null, sizes = null;
try {
  const m = require('./layout_min.js');
  safeMin = m.SAFE_MIN; sizes = m.SIZES;
} catch (e) {
  errors.push('无法加载 tools/layout_min.js（单一真值来源丢失）：' + e.message);
}

/* ② Tauri 窗口最小尺寸 */
const confRel = 'tauri/src-tauri/tauri.conf.json';
try {
  const conf = JSON.parse(fs.readFileSync(path.join(ROOT, confRel), 'utf8'));
  const win = ((conf.app || {}).windows || [])[0] || {};
  if (safeMin) {
    if (!(win.minWidth >= safeMin.w)) {
      errors.push(`[窗口最小尺寸] ${confRel} 的 minWidth=${win.minWidth === undefined ? '(缺失)' : win.minWidth}` +
        ` < 实测安全宽度 ${safeMin.w} —— 用户可把窗口拖到布局塌陷的区间（顶栏期间文本被推出窗口左缘）。`);
    }
    if (!(win.minHeight >= safeMin.h)) {
      errors.push(`[窗口最小尺寸] ${confRel} 的 minHeight=${win.minHeight === undefined ? '(缺失)' : win.minHeight}` +
        ` < 实测安全高度 ${safeMin.h}。`);
    }
  }
} catch (e) {
  errors.push(`无法读取/解析 ${confRel}：` + e.message);
}

/* ③ 抽查档位不得低于安全边界（否则"通过"是假通过） */
if (safeMin && Array.isArray(sizes)) {
  sizes.forEach(function (s) {
    if (!(s[0] >= safeMin.w && s[1] >= safeMin.h)) {
      errors.push(`[抽查档位] ${s.join('x')} 低于安全最小尺寸 ${safeMin.w}x${safeMin.h}` +
        ` —— 真机无法达到该尺寸，测它没有意义（改 tools/layout_min.js 的 SIZES）。`);
    }
  });
  if (!sizes.length) errors.push('[抽查档位] tools/layout_min.js 的 SIZES 为空。');
} else if (Array.isArray(sizes)) {
  errors.push('layout_min.js 缺少 SIZES。');
}

/* ④ 探针脚本必须真的用这份单点（防止有人复制一份常量后在别处跑偏） */
try {
  const probe = fs.readFileSync(path.join(ROOT, 'tools', 'layout_probe.js'), 'utf8');
  if (probe.indexOf("require('./layout_min.js')") < 0) {
    errors.push('[单点未复用] tools/layout_probe.js 未从 tools/layout_min.js 取档位 —— 常量必须只有一处。');
  }
} catch (e) {
  errors.push('无法读取 tools/layout_probe.js：' + e.message);
}

/* ⑤ 界面缩放的「安全上限」常量必须与实测边界一致
 * 这是**跨语言常量**（浏览器模块不能 require tools/ 下的文件），无法共享同一个定义，
 * 只能靠卡口比对 —— 与 tauri.conf.json 那处同一性质。 */
try {
  const uiScale = fs.readFileSync(path.join(ROOT, 'js', 'common', 'ui-scale.js'), 'utf8');
  const m = /LAYOUT_MIN_W\s*=\s*(\d+)/.exec(uiScale);
  if (!m) errors.push('[界面缩放] js/common/ui-scale.js 里找不到 LAYOUT_MIN_W —— 放大上限失去依据。');
  else if (safeMin && Number(m[1]) !== safeMin.w) {
    errors.push(`[界面缩放] ui-scale.js 的 LAYOUT_MIN_W=${m[1]} 与实测安全宽度 ${safeMin.w} 不一致 —— ` +
      '放大后的有效布局宽度会低于安全边界（放大即把用户带进布局塌陷区间）。');
  }
  const rng = /const MIN = ([\d.]+), MAX = ([\d.]+), STEP = ([\d.]+)/.exec(uiScale);
  if (!rng) errors.push('[界面缩放] ui-scale.js 里找不到 MIN / MAX / STEP 定义。');
  else {
    if (!(Number(rng[1]) > 0 && Number(rng[1]) < 1)) errors.push(`[界面缩放] MIN=${rng[1]} 应在 (0,1) —— 下限是"缩小"。`);
    if (!(Number(rng[2]) > 1)) errors.push(`[界面缩放] MAX=${rng[2]} 应 >1 —— 否则"放大"这个功能不存在。`);
    if (!(Number(rng[3]) > 0 && Number(rng[3]) < 1)) errors.push(`[界面缩放] STEP=${rng[3]} 应在 (0,1)，否则步进会跳过中间档。`);
  }
} catch (e) {
  errors.push('无法读取 js/common/ui-scale.js：' + e.message);
}

console.log('============================================');
console.log('窗口最小尺寸卡口（安全边界 ' + (safeMin ? safeMin.w + 'x' + safeMin.h : '?') + '）');
if (errors.length) {
  console.log('✗ ' + errors.length + ' 项：');
  errors.forEach(function (e) { console.log('  · ' + e); });
  console.log('============================================');
  process.exit(1);
}
console.log('✓ Tauri minWidth/minHeight 与实测安全边界一致，抽查档位不低于该边界，单点未被复制');
console.log('============================================');
process.exit(0);
