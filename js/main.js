// ESM 入口：把各页面模块的渲染函数挂载到全局 globalThis.__renderXxx。
// app.js 持有路由字典 PAGE_REFRESHERS，统一经 renderVia(name) 转发到这些全局引用；
// 链路：goPage → PAGE_REFRESHERS → renderVia(name) → __renderXxx。单一桥接点，无双重逻辑。
import { renderTrialBalance } from './pages/ledger/TrialBalance.js?v=2026082933';
import { refreshBs, refreshPl, refreshCf, refreshTx } from './pages/report/Report.js?v=2026082730';
import {
  refreshGl, refreshDl, refreshMl, refreshQg, refreshQd, refreshAx, refreshAb, refreshAc
} from './pages/ledger/Ledger.js?v=2026083108';
import { refreshSubjects } from './pages/subject/Subject.js?v=2026083124';
import { renderProjectProfit } from './pages/report/ProjectProfit.js?v=2026082730';
import { renderExpenseDetail } from './pages/report/ExpenseDetail.js?v=2026083114';
import { renderOriginal } from './pages/report/Original.js?v=2026090203';
import { renderReportCenter } from './pages/report/ReportCenter.js?v=2026083111';
import {
  refreshAssets, refreshDas, refreshDad, refreshAssetCategory, refreshAssetChangeLog, refreshAssetDeprVoucher,
  refreshAssetDeprHost
} from './pages/asset/Asset.js?v=2026083118';
import {
  refreshVoucherWord, refreshAuxSetting, refreshCashflowInit, refreshCashflowProject,
  refreshBackup, refreshLogs, refreshBookManage, refreshSysEvents,
  refreshParam, refreshSystemSettings
} from './pages/settings/Settings.js?v=2026090504';
import {
  refreshSalary, refreshSalaryStats, refreshDeptStaff, refreshSalaryTpl
} from './pages/salary/Salary.js?v=2026083118';
import './pages/settle/Settle.js?v=2026090506';
import './pages/settings/Opening.js?v=2026083115';
import { refreshVoucher, refreshSum, refreshQuery, refreshRecycleBin } from './pages/voucher/Voucher.js?v=2026090209';
import { refreshHome, resizeAllCharts, setupHome } from './pages/home/Home.js?v=2026090801';
import { refreshTools } from './pages/settings/Tools.js?v=2026090801';
import { refreshCloudSync } from './pages/settings/CloudSync.js?v=2026090801';
import { initPeriodRangePicker, updatePeriodRangeTrigger } from './components/PeriodRangePicker.js?v=2026082730';

// —— 通用起止期间选择器（总账/明细账/项目利润表/费用明细表等） ——
initPeriodRangePicker();
// 触发器文本同步入口：原 Extra.js 以 require 调组件（浏览器 ESM 无 require），改由入口统一注册
globalThis.__EXTRA_UPDATE_PERIOD_TRIGGER__ = updatePeriodRangeTrigger;

// —— 探针页：试算平衡表 ——
globalThis.__renderTrialBalance = renderTrialBalance;

// —— 报表域：资产负债表 / 利润表 / 现金流量表 / 应交税费明细表 ——
globalThis.__renderBs = refreshBs;
globalThis.__renderPl = refreshPl;
globalThis.__renderCf = refreshCf;
globalThis.__renderTx = refreshTx;

// —— 账簿域：总账 / 明细账 / 多栏账 / 数量总账 / 数量明细账 / 辅助核算明细 / 辅助核算余额 / 辅助核算组合 ——
globalThis.__renderGl = refreshGl;
globalThis.__renderDl = refreshDl;
globalThis.__renderMl = refreshMl;
globalThis.__renderQg = refreshQg;
globalThis.__renderQd = refreshQd;
globalThis.__renderAx = refreshAx;
globalThis.__renderAb = refreshAb;
globalThis.__renderAc = refreshAc;
globalThis.__renderSubjects = refreshSubjects;

// —— report 尾巴域：原始凭证 / 项目利润 / 费用明细 / 报表中心 ——
globalThis.__renderOriginal = renderOriginal;
globalThis.__renderProjectProfit = renderProjectProfit;
globalThis.__renderExpenseDetail = renderExpenseDetail;
globalThis.__renderReportCenter = renderReportCenter;

// —— 固定资产域：资产清单 / 折旧清单 / 折旧明细 / 资产类别 / 资产变动 / 折旧凭证 ——
globalThis.__renderAssets = refreshAssets;
globalThis.__renderDas = refreshDas;
globalThis.__renderDad = refreshDad;
globalThis.__renderAssetCategory = refreshAssetCategory;
globalThis.__renderAssetChangeLog = refreshAssetChangeLog;
globalThis.__renderAssetDeprVoucher = refreshAssetDeprVoucher;
// 折旧宿主（page-asset-depr）：页内 Tab 收敛，进入/刷新宿主调用
globalThis.__renderAssetDeprHost = refreshAssetDeprHost;

// —— 设置域：辅助核算 / 现金流量初始 / 现金流量项目 / 备份 / 操作日志 / 系统参数 / 系统设置 ——
globalThis.__renderAuxSetting = refreshAuxSetting;
globalThis.__renderCashflowInit = refreshCashflowInit;
globalThis.__renderCashflowProject = refreshCashflowProject;
globalThis.__renderBackup = refreshBackup;
globalThis.__renderLogs = refreshLogs;
globalThis.__renderSysEvents = refreshSysEvents;
globalThis.__renderParam = refreshParam;
globalThis.__renderSystemSettings = refreshSystemSettings;

// —— 工资域：工资表 / 工资统计 / 部门职员 / 工资凭证模板（新手导航已移除） ——
globalThis.__renderSalary = refreshSalary;
globalThis.__renderSalaryStats = refreshSalaryStats;
globalThis.__renderDeptStaff = refreshDeptStaff;
globalThis.__renderSalaryTpl = refreshSalaryTpl;

// —— 凭证域：录入 / 汇总 / 查询 ——
globalThis.__renderVoucher = refreshVoucher;
globalThis.__renderSum = refreshSum;
globalThis.__renderQuery = refreshQuery;

// —— 首页工作台域：仪表盘 / 指标卡片 / ECharts 图表 ——
globalThis.__renderHome = refreshHome;
globalThis.resizeAllCharts = resizeAllCharts;
// 首页初始化事件绑定（仅在 DOM ready 后调用一次）
setupHome();

// —— 基础功能页域：账套管理 / 数据恢复 / 导入导出 ——
globalThis.__renderTools = refreshTools;

// —— 云同步（WebDAV，手动触发）：随系统设置页一并渲染 ——
globalThis.__renderCloudSync = refreshCloudSync;

// 启动后若当前页正好是已迁移页，立即渲染一次（兼容刷新后直达/缓存页恢复）。
document.addEventListener('DOMContentLoaded', function () {
  var activeSec = document.querySelector('.page.active');
  var activePage = activeSec ? activeSec.id.replace('page-', '') : 'home';
  var h = (location.hash || '').replace(/^#/, '');
  var keys = globalThis.__PAGE_REFRESHERS__ ? Object.keys(globalThis.__PAGE_REFRESHERS__) : [];
  var extraPages = ['original', 'project-profit', 'expense-detail', 'report-center'];
  var directable = !!h && (keys.indexOf(h) >= 0 || extraPages.indexOf(h) >= 0);

  // 兜底 1：hash 直达已迁移页。app.js（传统脚本）早于 ESM 执行，初始化期委托桩
  // 可能因模块未挂载而静默跳过；此处 main.js 已就绪，补一次真实渲染。
  if (directable) {
    var renderName = h.split('-').map(function (seg) { return seg.charAt(0).toUpperCase() + seg.slice(1); }).join('');
    if (h !== activePage) {
      if (globalThis.goPage) { try { globalThis.goPage(h, true); } catch (e) { console.error('[hash直达兜底失败]', h, e); } }
      return; // goPage 会渲染当前页，不再走兜底 2
    }
    if (extraPages.indexOf(h) >= 0) {
      var fn = globalThis['__render' + renderName];
      if (fn) { try { fn(); } catch (e) { console.error('[hash直达兜底失败]', h, e); } }
    } else if (globalThis.__PAGE_REFRESHERS__ && globalThis.__PAGE_REFRESHERS__[h]) {
      try { globalThis.__PAGE_REFRESHERS__[h](); } catch (e) { console.error('[hash直达兜底失败]', h, e); }
    }
    return; // 已处理，不再走兜底 2
  }

  // 兜底 2：非 hash 直达，但当前已激活页是已迁移页（标签缓存/刷新后菜单页等场景
  // 初始化期委托桩跳过），强制补刷新一次，避免页面空白或残留旧 0 数据。
  if (activePage !== 'home' && globalThis.__PAGE_REFRESHERS__ && globalThis.__PAGE_REFRESHERS__[activePage]) {
    try { globalThis.__PAGE_REFRESHERS__[activePage](); } catch (e) { console.error('[当前页兜底失败]', activePage, e); }
  } else if (activePage === 'home' && globalThis.__renderHome) {
    try { globalThis.__renderHome(); } catch (e) { console.error('[当前页兜底失败]', 'home', e); }
  }
});
