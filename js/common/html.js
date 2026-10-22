/* ============================================================================
 * html`` —— 自动转义的标签模板（2026-10-22 试点）
 *
 * 【为什么有它】全项目的 innerHTML 都是"字符串拼接 + 记得 esc"，安全性全靠人记：
 * 一个漏写就是注入面（本轮 77 处 REVIEW 里就挖到 4 个真实漏洞）。改成标签模板后，
 * **插值默认转义**，要插入可信片段必须显式写 raw() —— 把"默认不安全"翻成"默认安全"。
 *
 * 【用法】
 *     import { html, raw } from '../../common/html.js?v=dev';
 *     el.innerHTML = html`<td>${row.name}</td>`;            // name 自动转义
 *     el.innerHTML = html`<div>${raw(childHtml)}</div>`;    // childHtml 已是 html`` 产物或已转义
 *
 * 【返回值】返回 RawHtml 对象（不是裸字符串）：这样 `${html`…`}` 嵌套时不会被二次转义；
 * 赋值给 innerHTML / 参与字符串拼接时经 toString() 还原，行为与字符串一致。
 *
 * 【不要做的事】
 *   · 不要对 html`` 的产物再调用 esc() —— 会双重转义成 &amp;lt;
 *   · 不要把未经验证的字符串用 raw() 包起来 —— 那等于手工关闭防护，必须在上游确认已转义
 *   · esc / escAttr 仍可继续用（老代码不强制迁移）；同一段模板里混用会双重转义，迁移时整段换掉
 * ========================================================================== */
'use strict';

import { esc } from './helpers.js?v=dev';

/* 可信片段标记：把"已经安全"的 HTML 显式包一层，避免默认转义把它吃掉。 */
class RawHtml {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}

function raw(s) { return new RawHtml(s == null ? '' : String(s)); }

/* 单个插值的归一化：null / undefined / false 输出空串；数组逐项处理；RawHtml 原样放行。 */
function htmlVal(v) {
  if (v == null || v === false) return '';
  if (v instanceof RawHtml) return v.s;
  if (Array.isArray(v)) return v.map(htmlVal).join('');
  return esc(String(v));
}

function html(strings) {
  let out = strings[0];
  for (let i = 1; i < arguments.length; i++) {
    out += htmlVal(arguments[i]) + strings[i];
  }
  return new RawHtml(out);
}

export { html, raw, RawHtml };
