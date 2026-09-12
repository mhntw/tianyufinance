'use strict';
/* 统一科目选择组件回归：加载真实 SubjectPicker.js，验证 打开/关闭/重开/输入联想 + onPick(科目) + limit + matchSubjectCode */
const fs = require('fs');
const path = require('path');

class El {
  constructor(tag) { this.tagName = tag; this.children = []; this.style = {}; this._cls = new Set(); this._h = {}; this._attrs = {}; this.parentNode = null; this.value = ''; this.innerHTML = ''; this.textContent = ''; }
  get classList() { const s = this; return { add: c => s._cls.add(c), remove: c => s._cls.delete(c), contains: c => s._cls.has(c) }; }
  get className() { return Array.from(this._cls).join(' '); }
  set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
  setAttribute(k, v) { this._attrs[k] = v; }
  getAttribute(k) { return this._attrs[k]; }
  appendChild(c) { this.children.push(c); c.parentNode = this; return c; }
  remove() { if (this.parentNode) { this.parentNode.children = this.parentNode.children.filter(x => x !== this); this.parentNode = null; } }
  addEventListener(t, fn) { (this._h[t] = this._h[t] || []).push(fn); }
  removeEventListener() {}
  dispatch(t, e) { (this._h[t] || []).forEach(fn => fn(Object.assign({ type: t, preventDefault() {}, stopPropagation() {} }, e || {}))); }
  querySelectorAll() { return []; }
  contains(n) { return n === this; }
  closest(sel) { if (sel === '.subj-range-btn' && this._cls.has('subj-range-btn')) return this; return null; }
  getBoundingClientRect() { return { left: 0, top: 0, right: 200, bottom: 30, width: 200, height: 30 }; }
  focus() { global.document.activeElement = this; this.dispatch('focus'); }
}
const body = new El('body');
const docHandlers = [];
global.document = { body, activeElement: null, createElement: t => new El(t), getElementById: () => null, addEventListener: (t, fn) => docHandlers.push([t, fn]) };
global.window = { innerHeight: 800, scrollX: 0, scrollY: 0, addEventListener: () => {} };
global.$ = () => null;
global.__TY_HELPERS__ = { esc: s => String(s == null ? '' : s) };
const fireDocument = (t, target) => docHandlers.filter(h => h[0] === t).forEach(h => h[1]({ type: t, target, preventDefault() {}, stopPropagation() {} }));
const popOf = () => body.children.filter(c => c._cls && c._cls.has('subj-range-pop'))[0] || null;
const popCount = () => body.children.filter(c => c._cls && c._cls.has('subj-range-pop')).length;

let src = fs.readFileSync(path.join(__dirname, '..', 'js', 'components', 'SubjectPicker.js'), 'utf8');
src = src.replace(/^import[^\n]*\n/m, '').replace(/export\s+/g, '');
const { bindSubjectPicker, matchSubjectCode } = new Function('subjectFullName', src + '\n;return { bindSubjectPicker, matchSubjectCode };')((code, name) => code + ' ' + name);

const subs = [{ code: '1001', name: '库存现金' }, { code: '1002', name: '银行存款' }, { code: '6601', name: '管理费用' }];
let bad = 0;
const ck = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) bad++; };

const input = new El('input');
bindSubjectPicker(input, { getSubjects: () => subs.slice(), onPick: () => {} });
input.focus(); ck(popCount() === 1, '聚焦 → 弹出');
fireDocument('mousedown', input); ck(popCount() === 1, '点输入框本身不误关');
fireDocument('mousedown', new El('div')); ck(popCount() === 0, '点外部 → 关闭');
input.focus(); fireDocument('mousedown', new El('div')); input.focus();
ck(popCount() === 1, '外部关闭后再次点击 → 能重开（回归）');
fireDocument('mousedown', new El('div')); input.value = '1002'; input.dispatch('input', {});
ck(popCount() === 1, '关闭态输入编码 → 重开并显示（回归）');

// onPick 回传 (code, 科目对象)
const picks = [];
const in2 = new El('input');
bindSubjectPicker(in2, { getSubjects: () => subs.slice(), onPick: (code, s) => picks.push([code, s]) });
in2.focus(); in2.dispatch('keydown', { key: 'Enter' });
ck(picks.length === 1 && picks[0][0] === '1001' && picks[0][1] && picks[0][1].name === '库存现金', 'onPick 回传 (code, 科目对象)');

// limit 生效
const in3 = new El('input');
bindSubjectPicker(in3, { getSubjects: () => subs.slice(), limit: 2 });
in3.focus();
const list = popOf().children[0];
ck((list.innerHTML.match(/subj-range-row/g) || []).length === 2, 'limit=2 时 3 个科目只渲染 2 行');

// matchSubjectCode（查凭证科目过滤用）
ck(matchSubjectCode(null, '1001') === true, 'matchSubjectCode(null) = 全部命中');
ck(matchSubjectCode(new Set(['1001']), '1001') === true && matchSubjectCode(new Set(['1001']), '1002') === false, 'matchSubjectCode(集合) 精确命中');

console.log('\n' + (bad === 0 ? '全部通过：统一科目选择组件 稳定 + 能力完整' : bad + ' 项未通过'));
process.exitCode = bad === 0 ? 0 : 1;
