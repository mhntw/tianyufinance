#!/usr/bin/env node
/* ============================================================================
 * 测试壳共用的「引导块注入器」（2026-10-04）
 *
 * 【为什么需要它】页面引导块已收口到 js/common/helpers.js，页面里只剩一行
 *     import { H, $, S, U, … } from '../../common/helpers.js?v=dev';
 * 而本项目的测试壳装载页面源码时会用各自的 stripEsm 把 import 改写成：
 *     var H = (globalThis.__XP_IMPORTS__ || {})['H'];   // 见各壳的 stripEsm
 * —— 也就是说：**壳负责喂 __XP_IMPORTS__**。收口后 4 个壳立刻报
 *     TypeError: Cannot read properties of undefined (reading 'periodRangeValue')
 * 原因就是 `H` 没在 __XP_IMPORTS__ 里（`H.periodRangeValue` 因而抛错）。
 *
 * 【本模块做什么】把 helpers.js 的导出**求值一次**，合并进 __XP_IMPORTS__。
 * 各壳只需在装载页面源码前调用一次（幂等，重复调用无害）。
 *
 * ⚠ 文件名不带下划线前缀：tools/_*.js 被 .gitignore 忽略，而本文件是要入库的公共件；
 *   同时它不匹配 run-all 的收集规则（test_/verify_/check_/sim_），不会被当测试跑。
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const NAMES = ['H', 'EX', '$', 'S', 'U', 'money', 'esc', 'escHtml', 'escAttr', 'num',
  'showToast', 'currentPeriod', 'fmtDate', 'round2', 'yuan'];

/**
 * @param {object} globalObj 目标全局对象（测试壳里通常传 `global` 或 `globalThis`）
 * @param {string} rootDir   仓库根目录（用于定位 js/common/helpers.js）
 * @returns {object} 本次注入的名字表（便于调试）
 */
function installBootImports(globalObj, rootDir) {
  const g = globalObj || globalThis;
  const root = rootDir || path.join(__dirname, '..');
  const src = fs.readFileSync(path.join(root, 'js', 'common', 'helpers.js'), 'utf8')
    // helpers.js 只有 export（没有 import）：去掉后即为可直接求值的普通脚本
    .replace(/^\s*export\s*\{[\s\S]*?\};?[ \t]*$/gm, '');
  /* 在函数作用域里求值，再把名字整表返回 —— 避免往真实全局塞一堆 const（那会污染壳）。 */
  const boot = (0, eval)('(function () {\n' + src + '\nreturn { ' +
    NAMES.map(function (n) { return n + ': ' + n; }).join(', ') + ' };\n})')();
  g.__XP_IMPORTS__ = Object.assign(g.__XP_IMPORTS__ || {}, boot);
  return boot;
}

module.exports = { installBootImports: installBootImports, NAMES: NAMES };
