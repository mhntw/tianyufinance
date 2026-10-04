/* ============================================================================
 * 页面公共引导块（**唯一实现**，2026-10-04 收口，用户确认）
 *
 * 【为什么有它】此前 17 个页面/组件各自在文件顶部抄一遍同一段引导：
 *     const H = globalThis.__TY_HELPERS__ || {};
 *     const S = H.S || (EX && EX.store);  …（每个文件写法还不一样）
 * 实测差异（这就是收敛时必须先审的原因）：
 *   · `$`   4 种写法（H.$ / document.getElementById / globalThis.$ || … / H.$ || 返回 null）
 *   · `S`   4 种（H.S / || window.S / || (EX && EX.store) / || window.store）
 *   · `U`   4 种（H.U / || window.util / || (EX && EX.util) / || {}）
 *   · `esc` 4 种，**其中 3 种的兜底根本不转义**（`s => String(s == null ? '' : s)`）✗
 *   · `num` 2 种且**语义不同**：parseFloat 链（'1,234' → 1）vs Number(v)||0（'1,234' → 0）
 *   · money / round2 / currentPeriod / showToast 兜底链长短不一
 *
 * 【本文件的取舍】取**最防御的并集** —— 真机里 `H.*` 由 app.js 注册、永远存在
 * （tools/check_helper_deps.js 在守"所有 H.xxx 引用均已注册"），故这些兜底是**休眠态**；
 * 但休眠代码也不该各写一份、更不该"兜底成不转义"：
 *   · esc 兜底取**真转义**（修掉那 3 处 no-op 兜底）；
 *   · num 兜底取 parseFloat 链（与 store.num 口径一致）；
 *   · $ 兜底取 document.getElementById，S/U 取最长的回退链（EX → window → 空对象）。
 *
 * 【用法】页面只写一行：
 *     import { H, S, U, $, esc, money, num, showToast, currentPeriod, round2, yuan } from '../../common/helpers.js?v=dev';
 * 需要 family 专属名字（goPage / monthList / periodRangeValue / subjectLevel …）时，
 * 仍从各自的 pages/xxx/_shared.js 取 —— 那些文件现在改为从本模块转发。
 *
 * ⚠ 别再把引导块抄回页面：卡口 check_single_source 的 inline-helper-bootstrap 会红。
 * ========================================================================== */
'use strict';

const H = globalThis.__TY_HELPERS__ || {};
const EX = globalThis.__TY_EXPORT__ || {};

const $ = H.$ || function (id) { return document.getElementById(id); };
const S = H.S || (EX && EX.store) || (typeof window !== 'undefined' && (window.S || window.store)) || null;
const U = H.U || (EX && EX.util) || (typeof window !== 'undefined' && window.util) || {};

/* 金额显示（内部定点整数 → 2 位）：真机走 store.money；兜底按"元"处理，与旧 report/_shared.js 一致。 */
const money = H.money || function (v) { return v == null ? '0.00' : Number(v).toFixed(2); };

/* HTML 转义：兜底必须**真转义**（旧写法有 3 处兜底是 `String(...)` 空操作）。 */
const esc = H.esc || function (s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
};
const escHtml = esc;   // Ledger / TrialBalance / Voucher 用的别名
const escAttr = esc;   // Voucher 用于属性上下文（esc 已含引号，等价）

const num = H.num || (U && U.num) || function (v) { var n = parseFloat(v); return isNaN(n) ? 0 : n; };
const showToast = H.showToast || function (msg) { console.log('[toast]', msg); };
const currentPeriod = H.currentPeriod || function () {
  return (typeof window !== 'undefined' && window.store && window.store.currentPeriod) || '2026-01';
};
/* 本地日期（口径与 store.fmtDate 一致）：入参是 'YYYY-MM-DD' 时原样返回，避开 UTC 解析偏移。 */
const fmtDate = H.fmtDate || function (d) {
  try {
    if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
    const x = new Date(d);
    if (isNaN(x.getTime())) return '';
    return x.getFullYear() + '-' + ('0' + (x.getMonth() + 1)).slice(-2) + '-' + ('0' + x.getDate()).slice(-2);
  } catch (e) { return ''; }
};
const round2 = H.round2 || (U && U.round2)
  || (typeof window !== 'undefined' && window.util && window.util.round2);
/* ⚠ 这里**不允许**再写一份 `Math.round(n*100)/100` 兜底 —— 那会被口径卡口 inline-round2 判红，
   而且正是它要防的"第二份归零实现"（漏 `-0` 归一 → 显示 "-0.00"）。
   与收口前的实际行为一致：store 未注册时 `round2` 为 undefined，调用即报错（而不是悄悄用一份错的）。 */
/* 内部定点整数 → 元：一律走单点 U.yuan（比例只有 store.js 一处定义）。 */
const yuan = function (a) { return U.yuan(a); };

export { H, EX, $, S, U, money, esc, escHtml, escAttr, num, showToast, currentPeriod, fmtDate, round2, yuan };
