/* ============================================================================
 * js/pages/voucher/amt_cells.mjs —— 金额位格算法（纯函数，无 DOM 依赖）
 *
 * 【为什么单独成文件】位格的规则（负号借用左侧空位格、整数位占满时退回文本）
 *   是这套 UI 里唯一「算错了肉眼也未必看得出」的部分，历史上改过两次都靠人眼验收、两次回退。
 *   抽成纯函数后由 tools/check_amt_cells.js 用断言锁死（node 直接跑，不需要浏览器）。
 *
 * 【调用方】只有 js/pages/voucher/Voucher.js 的 amtInnerHtml()；DOM 拼装仍留在那边。
 *   app.js 只画表头单位行（amtUnitsHtml），不走这里。
 * ========================================================================== */

// 11 格：10^8（亿）→ 10^-2（分）。顺序即显示顺序，也是格线等分的依据。
export const AMT_UNITS = '亿千百十万千百十元角分';
export const AMT_CELL_COUNT = AMT_UNITS.length;

function emptyCells() {
  return new Array(AMT_CELL_COUNT).fill('');
}

/**
 * 金额 → 11 个位格字符（右对齐，负号占其右侧数字左边的第一个空位格）。
 *
 * @param {string|number} value 金额（元）。''、null、0 视为空位格
 * @param {boolean} force2 是否强制两位小数（合计行/借贷平衡用；普通位格保持用户输入原样）
 * @returns {{neg:boolean, cells:string[], overflow:boolean, text:string}}
 *   cells   长度恒为 AMT_CELL_COUNT，空位为 ''，负号为 '-'
 *   overflow=true  该金额放不进 11 格：整数位超 9 格（|v| ≥ 10 亿），或 |v| ≥ 1 亿的负数
 *                  左侧没有空位格放符号 —— 调用方改走纯文本分支（text 为不带符号的数值文本）
 */
export function computeAmtCells(value, force2) {
  var raw = (value === '' || value == null || value === 0) ? '' : value.toString();
  var t = raw;
  if (force2 && t && parseFloat(t)) t = parseFloat(t).toFixed(2);

  var negNum = parseFloat(raw);
  var neg = !isNaN(negNum) && negNum < 0;
  // 负数一律按绝对值的两位小数进位格：'-' 只占一格，数字口径与正数完全一致
  if (neg) t = Math.abs(negNum).toFixed(2);
  else t = t.replace('-', '');

  var bigTxt = parseFloat(t) ? parseFloat(t).toFixed(2) : t;
  // 整数位超过 9 格（含小数点后共 >12 字符）→ 位格装不下
  if (t.length > 12) return { neg: neg, cells: emptyCells(), overflow: true, text: bigTxt };

  // 与旧实现逐字等价：左侧补足 12 个占位符，取末 11 位（数字右对齐）
  var cells = (Array(12).join('_') + t.replace('.', '')).slice(-AMT_CELL_COUNT).split('');

  if (neg) {
    var firstDigit = -1;
    for (var q = 0; q < AMT_CELL_COUNT; q++) { if (cells[q] !== '_') { firstDigit = q; break; } }
    // firstDigit === 0：11 格被数字占满，负号无处可放
    if (firstDigit <= 0) {
      return { neg: neg, cells: emptyCells(), overflow: true, text: Math.abs(negNum).toFixed(2) };
    }
    cells[firstDigit - 1] = '-';
  }

  return {
    neg: neg,
    cells: cells.map(function (c) { return c === '_' ? '' : c; }),
    overflow: false,
    text: ''
  };
}
