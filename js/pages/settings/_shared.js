/* 共享基座（自 Settings.js 抽出）：桥接常量 + 通用 Excel 导出。
   引导块已收口到 ../../common/helpers.js（见其头部说明）；本文件只保留**设置族专属**的
   ACCOUNT_CLASSES 与 exportTable，并把常用名字继续对外转发（页面只需改 import 路径）。 */
import { H, EX, $, S, U, money, esc, num, showToast, currentPeriod, fmtDate } from '../../common/helpers.js?v=dev';

// 全局常量（store.js 挂在 global 上的 ACCOUNT_CLASSES 等）
const ACCOUNT_CLASSES = globalThis.ACCOUNT_CLASSES || (EX && EX.ACCOUNT_CLASSES);

// 通用：对象数组导出 Excel（「导出」）
// 统一走安全包装 __safeExportExcel：Tauri 下写入 exports 目录（避免浏览器下载静默失效），
// 浏览器回退原生下载；任何异常都会显式提示，杜绝「无反应」。
function exportTable(rows, name) {
  if (!rows || !rows.length) return showToast('无数据可导出', 'error');
  // 走单点（json 形态：对象数组 → 表头自动生成），见 js/ty-io.js 的 buildSheetWorkbook
  __safeExportExcel(TyIo.buildSheetWorkbook({ sheet: name || '导出', json: rows }), (name || '导出') + '_' + currentPeriod());
}

export { H, EX, $, money, esc, showToast, fmtDate, currentPeriod, S, U, num,
  ACCOUNT_CLASSES, exportTable };
