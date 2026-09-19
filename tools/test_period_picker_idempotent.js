'use strict';
/* 期间选择器「初始化幂等」测试
 *
 * 【为什么需要】initPeriodRangePicker() 会在 document 上注册点击监听。
 * 若被调用两次，监听重复注册，表现为「点一下浮层打开、立刻又被另一个监听关掉」——
 * 不报错，极难定位。2026-09-19 给组件加了幂等守卫，本测试守住它不被改回。
 *
 * 【测法】加载真实的 PeriodRangePicker.js（剥掉 ESM 语法），mock 最小 DOM，
 * 连续调用两次，断言 document 上的 click 监听数量只等于「一次初始化」的量。
 */
const fs = require('fs');
const path = require('path');

/* ---------- 最小 DOM ---------- */
const docHandlers = [];
function makeEl(tag) {
  const el = {
    tagName: tag, children: [], style: {}, dataset: {}, value: '',
    innerHTML: '', textContent: '', hidden: false, _cls: new Set(), _h: {},
    parentNode: null,
    classList: {
      add(c) { el._cls.add(c); }, remove(c) { el._cls.delete(c); },
      contains(c) { return el._cls.has(c); }
    },
    setAttribute() {}, getAttribute() { return null; },
    appendChild(c) { el.children.push(c); c.parentNode = el; return c; },
    remove() {}, addEventListener(t, fn) { (el._h[t] = el._h[t] || []).push(fn); },
    removeEventListener() {}, querySelector() { return null; },
    querySelectorAll() { return []; }, contains() { return false; },
    closest() { return null; }, focus() {}, removeAttribute() {},
    getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  };
  return el;
}
global.document = {
  body: makeEl('body'),
  documentElement: makeEl('html'),
  createElement: makeEl,
  getElementById: () => null,
  // 不返回任何 [data-period] 宿主：本测试只关心监听注册数，不关心控件展开
  querySelectorAll: () => [],
  addEventListener: (t, fn) => { docHandlers.push([t, fn]); },
  removeEventListener: () => {},
  activeElement: null
};
global.window = { innerHeight: 800, scrollX: 0, scrollY: 0, addEventListener: () => {} };
global.$ = () => null;

/* ---------- 加载真实组件（剥离 ESM 语法）---------- */
let src = fs.readFileSync(path.join(__dirname, '..', 'js', 'components', 'PeriodRangePicker.js'), 'utf8');
src = src.replace(/^import[^\n]*\n/gm, '').replace(/export\s+/g, '');
const mod = new Function(src + '\n;return { initPeriodRangePicker };')();
const { initPeriodRangePicker } = mod;

let bad = 0;
const ck = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) bad++; };

console.log('期间选择器「初始化幂等」测试：');

initPeriodRangePicker();
const n1 = docHandlers.length;
initPeriodRangePicker();
initPeriodRangePicker();
const n3 = docHandlers.length;

// 前置条件：必须真的注册了监听，否则下面的断言会因为「什么都没发生」而假通过
ck(n1 > 0, '首次初始化确实注册了 document 监听（' + n1 + ' 个）——否则断言会假通过');
ck(n3 === n1, '重复初始化（共 3 次）后监听数量不变：' + n1 + ' → ' + n3);

console.log('\n' + (bad === 0 ? '全部通过：期间选择器初始化幂等' : bad + ' 项未通过'));
process.exitCode = bad === 0 ? 0 : 1;
