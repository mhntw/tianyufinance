/* 共享基座（自 Settings.js 抽出）：桥接常量 + 通用 Excel 导出；只挚窝零改写 */
const H = globalThis.__TY_HELPERS__ || {};
const EX = globalThis.__TY_EXPORT__ || {};
const $ = H.$;
const money = H.money;
const esc = H.esc;
const showToast = H.showToast;
const fmtDate = H.fmtDate || function (d) { try { return new Date(d).toISOString().slice(0, 10); } catch (e) { return ''; } };
const currentPeriod = H.currentPeriod;
const S = H.S || (EX && EX.store);
const U = H.U || (EX && EX.util);
const num = H.num || (U && U.num) || function (v) { var n = parseFloat(v); return isNaN(n) ? 0 : n; };
// 全局常量（store.js 挂在 global 上的 ACCOUNT_CLASSES / AUX_TYPES 等）
const ACCOUNT_CLASSES = globalThis.ACCOUNT_CLASSES || (EX && EX.ACCOUNT_CLASSES);
const AUX_TYPES = globalThis.AUX_TYPES || (EX && EX.AUX_TYPES);

  // 通用：对象数组导出 Excel（「导出」）
  // 统一走安全包装 __safeExportExcel：Tauri 下写入 exports 目录（避免浏览器下载静默失效），
  // 浏览器回退原生下载；任何异常都会显式提示，杜绝「无反应」。
  function exportTable(rows, name) {
    if (!rows || !rows.length) return showToast('无数据可导出', 'error');
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), name || '导出');
    __safeExportExcel(wb, (name || '导出') + '_' + currentPeriod());
  }

export { $, money, esc, showToast, fmtDate, currentPeriod, S, U, num,
  ACCOUNT_CLASSES, AUX_TYPES, exportTable };
