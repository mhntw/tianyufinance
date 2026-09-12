// ============================================================
// js/common/subject-name.js —— 科目「全路径名」唯一实现
//
// 形态：一级-二级-末级（形态），例：
// 100203 建行（陈总）        → 银行存款-建行（陈总）
// 160503 工器具              → 工程物资-工器具
// 1221xx 陈小龙              → 其他应收款-陈小龙
//
// 为什么需要：往来类末级科目常直接以人名/单位名命名，只显示末级名
// （「陈小龙」）看不出挂在哪个科目下，易误导。
//
// 规则：
// - 按编码真前缀逐级向上找父科目，拼到最前（顶级 → 末级）；
// - 末级名已包含某层父名时（如「银行存款-青岛银行」）跳过，不重复拼接。
//
// 使用方：录凭证科目栏（Voucher.js）、统一科目选择组件（components/SubjectPicker.js）。
// 改动这里即全站生效，页面不要各自再写一份拼接逻辑。
// ============================================================

export function subjectFullName(code, fallbackName) {
  var S = globalThis.S || (typeof window !== 'undefined' ? window.S : null);
  var c = String(code == null ? '' : code);
  if (!c) return '';
  var subs = (S && S.subjects) ? (S.subjects() || []) : [];
  var self = null;
  subs.some(function (x) { if (String(x.code) === c) { self = x; return true; } return false; });
  var name = (self && self.name) || fallbackName || '';
  if (!name) return '';
  var chain = [name];
  subs.filter(function (x) {
    var pc = String(x.code);
    return pc !== c && c.indexOf(pc) === 0;                                  // 编码真前缀 = 上级
  }).sort(function (a, b) {
    return String(a.code).length - String(b.code).length;                    // 顶级 → 下级
  }).forEach(function (a) {
    var an = a.name || '';
    if (!an) return;
    if (chain.some(function (p) { return p === an || p.indexOf(an) === 0; })) return; // 已含该层
    chain.unshift(an);
  });
  return chain.join('-');
}

// 同时挂到全局：app.js 等非模块脚本（顶部全局搜索等）也能直接用，
// 不必为了一个函数把老脚本改成 module。
globalThis.subjectFullName = subjectFullName;

export default subjectFullName;
