// 页面模块（B 方案解耦，由 tools/migrate_domain.py 生成骨架）
// 依赖全部从全局桥接对象取，逻辑与 app.js 原实现逐字一致（只挪窝不改写）。
// 设计：globalThis.__TY_HELPERS__（app.js 注册）、globalThis.__TY_EXPORT__（store.js 注册）。
// 模块不 import store.js（避免 IIFE 双执行），统一从全局取已加载单例。

const H = globalThis.__TY_HELPERS__ || {};
// 起止期间取值统一走 app.js 单点实现（含默认值兜底）。
const periodRangeValue = H.periodRangeValue;
const EX = globalThis.__TY_EXPORT__ || {};
const $ = H.$;
const money = H.money;
const esc = H.esc;
import { bindSubjectPicker } from '../../components/SubjectPicker.js?v=dev';
const showToast = H.showToast;
const currentPeriod = H.currentPeriod;
const syncAll = H.syncAll;
const S = H.S || (EX && EX.store);
const U = H.U || (EX && EX.util);
const num = H.num || (U && U.num) || function (v) { var n = parseFloat(v); return isNaN(n) ? 0 : n; };
// 全局常量（store.js 挂在 global 上的 ACCOUNT_CLASSES 等）
const ACCOUNT_CLASSES = globalThis.ACCOUNT_CLASSES || (EX && EX.ACCOUNT_CLASSES);

  /* ============================================================
   * 固定资产
   * ============================================================ */
  /* 固定资产卡片（ykj-page1：过滤条 / 工具条 / 左树(类别+部门)+右表） */
  var _assetPage = 1, _assetPageSize = 500, _assetFiltered = [];
  var _assetCatSel = '';        // 左树选中的类别 code（''=全部）—— 类别字段存的是**编码**
  // 左树/筛选选中的部门**名称**（''=全部）。⚠️ 部门存的是名称、不是编码：
  // 卡片表单的「使用部门」是自由文本输入，store 里 addFixedAsset 也无「部门编码」契约，
  // 全库消费方（本树 / fDept 筛选 / 折旧汇总表按部门汇总）都按名称比。
  // 原先这里传/比的是 d.code → 卡片里写的「客房」永远匹配不上下拉的「002」，按部门筛选恒为 0 张。
  var _assetDeptSel = '';
  function _catName(code) {
    var c = assetCats().filter(function (x) { return x.code === code; })[0];
    return c ? c.name : (code || '');
  }
  // 左侧栏： table-left-box(资产类别树) + bottom-box(部门树)，各含「全部」根节点
  function _buildAssetTree(ulId, selCode, onPick) {
    var ul = $(ulId); if (!ul) return;
    ul.innerHTML = '';
    ul.appendChild(_assetTreeRoot('全部', selCode === '', onPick));
  }
  function _assetTreeRoot(name, selected, onPick) {
    var li = document.createElement('li');
    li.className = 'orig-tree-parent' + (selected ? ' selected' : '');
    // 本树是平铺的（「全部」+ 末级），无展开/折叠，故不再输出三角占位。
    // 原 <span class="tree-arrow"></span> 是空标签：画三角的 CSS 选择器为
    // .orig-tree .tree-parent .tree-arrow，而本树 li 的类名是 orig-tree-parent
    // （不是 tree-parent）→ 选择器从不匹配，既无字符也无 CSS 三角，纯废弃标记。
    li.innerHTML = esc(name);
    li.addEventListener('click', function () { onPick(''); });
    return li;
  }
  function _assetTreeLeaf(name, selected, onPick, code) {
    var li = document.createElement('li');
    li.className = 'orig-tree-child' + (selected ? ' selected' : '');
    li.innerHTML = esc(name);
    li.addEventListener('click', function () { onPick(code); });
    return li;
  }
  function renderAssetTree() {
    _buildAssetTree('assetCatTree', _assetCatSel, function (code) { _assetCatSel = code; _assetPage = 1; renderAssetTree(); renderAssets(); });
    assetCats().forEach(function (c) {
      $('assetCatTree').appendChild(_assetTreeLeaf(c.name, c.code === _assetCatSel, function (code) { _assetCatSel = code; _assetPage = 1; renderAssetTree(); renderAssets(); }, c.code));
    });
    _buildAssetTree('assetDeptTree', _assetDeptSel, function (name) { _assetDeptSel = name; _assetPage = 1; renderAssetTree(); renderAssets(); });
    // 部门树按**名称**选中/回传（与卡片 fa.dept 同口径），不要传 d.code
    S.depts().forEach(function (d) {
      $('assetDeptTree').appendChild(_assetTreeLeaf(d.name, d.name === _assetDeptSel, function (name) { _assetDeptSel = name; _assetPage = 1; renderAssetTree(); renderAssets(); }, d.name));
    });
  }
  /* 固定资产页的「期间」单点来源：全站统一的期间选择器组件（index.html 里 data-period="asset"，
   * 与总账/报表等页同一个 PeriodRangePicker）。组件就绪前或账套未加载时退回 currentPeriod()。
   * 2026-09-18 统一：此前是裸的 <input type="month" id="aPeriod">，且口径割裂 ——
   *   发凭证的动作（计提折旧、清理）读 $('aPeriod').value，
   *   而表格显示的「期末累计折旧」固定读 currentPeriod()，于是改期间时表格数字不变、看起来像失效。
   * 现在两者都走 _assetPeriod()，页面自洽：改期间，表格数字与计提期间一起变。 */
  function _assetPeriod() { return periodRangeValue('assetPeriod') || currentPeriod(); }
  function refreshAssets() {
    // 期间选择器的默认值由组件按 data-default="currentPeriod" 自行回填，此处无需再处理。
    // 类别 / 部门下拉已随「过滤」面板一并移除；这两个维度的筛选改由左侧树承担（点击即筛）。
    renderAssetTree();
    renderAssets();
  }
  /* 卡片筛选：只剩两个来源 —— 左侧树（类别 / 部门，点击即筛）与顶部「显示已清理资产」。
     2026-09-18 按用户要求移除了「过滤」折叠面板及其 11 项组合条件（编码、名称、日期区间、
     折旧方法、凭证与否…）：本软件卡片量级小，那些条件几乎用不到，却带来"点了没反应"一类
     的问题与无谓的维护负担。筛选逻辑本身保留 —— 左侧树仍要通过它生效。 */
  function _assetFilterList() {
    var cat = _assetCatSel;
    var dept = _assetDeptSel;
    var sw = $('fShowCleanedTop');
    var showCleaned = !!(sw && sw.checked);
    /* 期间过滤（2026-09-18 补：改期间时卡片清单也跟着变）：
     * 期间早于购置月 → 资产尚未入账，不显示。
     * 原先这里只过滤「清理」状态，于是 2026-06 才购置的卡在选 2026-03 时照样占一行，
     * 且其原值、期末净值都被计入卡片页合计 —— 实测使「原值」合计虚增 3,550.00（恰为该卡
     * 原值），与总账 1601 期末余额对不上。折旧表已在 _assetDeprRows 侧同步了该规则。
     * 判据用 acqM > period（而非 >=）：当月购置的卡仍要出现，资产已入账，只是尚未开始计提。 */
    var period = _assetPeriod();
    return S.state.fixedAssets.filter(function (fa) {
      if (cat && fa.category !== cat) return false;
      if (dept && fa.dept !== dept) return false;
      if (!showCleaned && fa.status === '清理') return false;
      var acqM = fa.acqDate ? String(fa.acqDate).slice(0, 7) : '';
      if (acqM && acqM > period) return false;
      return true;
    });
  }
  // 「新增资产凭证」单元格：有关联凭证时渲染成可点链接（点击打开该凭证，走 app.js 的全局
  // .link-voucher 委托）。跳转必须用**凭证 id**（含月份、唯一）—— 因为凭证号按「月」编，
  // word-no 跨月会重号（实测该账套里有 3 个「记-48」、3 个「记-28」），只存 word-no 点不准。
  // 只有显示值（如 Excel 导入自带的「新增资产凭证」列）而没有 id 时，退化为纯文本。
  function _addVoucherCell(fa) {
    if (!fa.addVoucher) return '';
    var text = esc(fa.addVoucher);
    if (!fa.addVoucherId) return text;
    return '<a href="#" class="link-voucher" data-id="' + esc(fa.addVoucherId) + '">' + text + '</a>';
  }
  /* ============ 累计折旧的期间滚动【唯一实现】 ============
   * 卡片上的「期初累计折旧」不是"永远等于期末"，它只是【截至某个锚点月末】的余额：
   *   - 本应用计提过的卡：锚点 = 最近一次计提月（deprMonth）
   *   - 外部导入的卡：锚点 = 购置月 + 已折旧期间数
   *     （导入模板只给出「期初累计折旧 + 本年已折旧」，没有期末列；实测本账套
   *      18/18 张卡片的锚点都落在 2026-07，与总账 1602 在 2026-07 的期末 316,209.32 完全吻合）
   * 任一期间末的累计折旧 = 期初累计折旧 + 月折旧 × (锚点月末 → 该期间末月 的月数)
   *   例：316,209.32 + 14,015.73 × 1 = 330,225.05 = 2026-08 期末（逐月一字不差）
   * ⚠️ 所以「期末累计折旧」必须按期间滚算；直接读卡片存的 accumDepr 会永远停在期初。 */
  function _addMonths(ym, n) {
    if (!ym) return '';
    var y = parseInt(String(ym).slice(0, 4), 10), m = parseInt(String(ym).slice(5, 7), 10);
    if (!y || !m) return '';
    var t = y * 12 + (m - 1) + n;
    return String(Math.floor(t / 12)).padStart(4, '0') + '-' + String(t % 12 + 1).padStart(2, '0');
  }
  function _deprAnchorMonth(fa) {
    if (fa.deprMonth) return String(fa.deprMonth);
    var acq = String(fa.acqDate || '').slice(0, 7);
    return acq ? _addMonths(acq, num(fa.periodUsed || 0)) : '';
  }
  // 至 month 月末的累计折旧。month 为空时退回卡片存值（保持旧行为，不炸页面）。
  function _accumDeprAt(fa, month, md) {
    var begin = num(fa.accumDeprBegin);
    var anchor = _deprAnchorMonth(fa);
    if (!anchor || !month || !md) return num(fa.accumDepr) || begin;
    var d = U.monthsBetween(anchor, month);          // 负数 = 往锚点之前回滚（查历史期间）
    if (!d) return begin;
    var v = begin + md * d;
    if (v < 0) v = 0;
    var cap = Math.max(0, num(fa.original) - num(fa.salvage));   // 不超提：上限 = 原值 - 残值
    if (cap > 0 && v > cap) v = cap;
    return v;
  }

  // 资产卡片 27 列共用 td 拼接（卡片页 + 折旧凭证页复用）
  function _assetRowCells(fa) {
    var md = S.assetMonthlyDepr(fa);
    /* 四个金额全部按「期间选择器的期间」滚算：
     *   期初累计 = 上一期间月末的累计；期末累计 = 本期间月末的累计；
     *   期初/期末净值 = 原值 − 对应累计 − 减值准备。
     * 2026-09-18 修正：此前「期初累计折旧」直接显示卡片存的 fa.accumDeprBegin。
     * 那是**内部锚点值**（卡片录入时的基准月末余额），不是"上一期间末"，语义与报表的
     * "期初"不符 —— 表现为切期间时该列不动，前后不一致。现改为同样参与滚算。
     * ⚠️ 卡片表单里的「期初累计折旧」输入框仍是锚点值（录入基准），两者口径不同属正常。 */
    var pEnd = _assetPeriod();
    var pBegin = _addMonths(pEnd, -1);                       // 期初 = 上一期间月末
    var accumBegin = _accumDeprAt(fa, pBegin, md);
    var accumEnd = _accumDeprAt(fa, pEnd, md);
    var netBegin = Math.max(0, num(fa.original) - accumBegin - num(fa.impairment));
    var netEnd = Math.max(0, num(fa.original) - accumEnd - num(fa.impairment));
    return (
      '<td class="mono">' + (fa.code || '') + '</td>' +
      '<td>' + (fa.name || '') + '</td>' +
      '<td>' + _catName(fa.category) + '</td>' +
      '<td>' + (fa.dept || '') + '</td>' +
      '<td>' + (fa.acqDate || '') + '</td>' +
      '<td class="ta-r mono">' + money(fa.original) + '</td>' +
      '<td class="ta-r mono">' + money(accumBegin) + '</td>' +
      '<td class="ta-r mono">' + money(accumEnd) + '</td>' +
      '<td class="ta-r mono">' + money(md) + '</td>' +
      '<td>' + (fa.life ? fa.life + '年' : '') + '</td>' +
      '<td>' + (fa.periodUsed || '') + '</td>' +
      '<td class="ta-r mono">' + money(fa.salvage) + '</td>' +
      '<td class="ta-r mono">' + num(fa.salvageRate).toFixed(2) + '</td>' +
      '<td class="ta-r mono">' + money(fa.impairment) + '</td>' +
      '<td class="ta-r mono">' + money(netBegin) + '</td>' +
      '<td class="ta-r mono">' + money(netEnd) + '</td>' +
      '<td>' + (fa.method || '') + '</td>' +
      '<td>' + (fa.status || '正常') + '</td>' +
      '<td class="ta-r">' + (fa.qty || '') + '</td>' +
      '<td>' + (fa.spec || '') + '</td>' +
      '<td>' + (fa.location || '') + '</td>' +
      '<td>' + (fa.user || '') + '</td>' +
      '<td>' + (fa.cleanPeriod || '') + '</td>' +
      '<td class="mono">' + _addVoucherCell(fa) + '</td>' +
      '<td class="mono">' + (fa.cleanVoucher || '') + '</td>' +
      '<td class="mono">' + (fa.impairVoucher || '') + '</td>' +
      '<td class="mono">' + (fa.otherVoucher || '') + '</td>' +
      '<td>' + (fa.memo || '') + '</td>'
    );
  }
  function renderAssets() {
    _assetFiltered = _assetFilterList();
    var tb = $('assetBody'); tb.innerHTML = '';
    var total = _assetFiltered.length;
    var pages = Math.max(1, Math.ceil(total / _assetPageSize));
    if (_assetPage > pages) _assetPage = pages;
    var start = (_assetPage - 1) * _assetPageSize;
    var slice = _assetFiltered.slice(start, start + _assetPageSize);
    slice.forEach(function (fa) {
      var tr = document.createElement('tr');
      // 操作列：图标简化为蓝色可点击文字（样式见 css 的 .asset-ops）；
      // 动作之间不靠源码空格分隔（换行/折叠时会忽宽忽窄），由 CSS margin 统一间距。
      // 2026-09-18 修复：此前「删除」「清理 / 取消清理」的**渲染**被误删（点击处理一直都在），
      // 行内只剩「编辑」—— 其中「取消清理」在其它任何入口都不存在，清理过的卡片无从撤销。
      // 现按卡片状态二选一恢复；「复制」仍保持移除（那是有意精简，非误删）。
      tr.innerHTML =
        '<td class="col-check"><input type="checkbox" class="aChk" data-id="' + fa.id + '"></td>' +
        '<td class="asset-ops"><a class="link-edit" data-asset-edit="' + fa.id + '">编辑</a>' +
        (fa.status === '清理'
          ? '<a class="link-unclean" data-unclean="' + fa.id + '">取消清理</a>'
          : '<a class="link-clean" data-clean="' + fa.id + '">清理</a>') + '</td>' +
        _assetRowCells(fa);
      tb.appendChild(tr);
    });
    // 合计行
    var foot = $('assetFoot'); foot.innerHTML = '';
    if (total > 0) {
      var sOrig = 0, sB = 0, sE = 0, sM = 0, sS = 0, sI = 0, sNB = 0, sNE = 0;
      // 与卡片行同源：四个金额都按「期初 = 上月末 / 期末 = 本月末」滚算
      var cp = _assetPeriod();
      var cb = _addMonths(cp, -1);
      _assetFiltered.forEach(function (fa) {
        var md = S.assetMonthlyDepr(fa);
        var ae = _accumDeprAt(fa, cp, md);   // 期末累计
        var ab = _accumDeprAt(fa, cb, md);   // 期初累计
        sOrig += num(fa.original); sB += ab; sE += ae;
        sM += md; sS += num(fa.salvage); sI += num(fa.impairment);
        sNB += Math.max(0, num(fa.original) - ab - num(fa.impairment));
        sNE += Math.max(0, num(fa.original) - ae - num(fa.impairment));
      });
      var trf = document.createElement('tr');
      trf.innerHTML = '<td></td><td>合计</td><td colspan="6"></td>' +
        '<td class="ta-r mono">' + money(sOrig) + '</td>' +
        '<td class="ta-r mono">' + money(sB) + '</td>' +
        '<td class="ta-r mono">' + money(sE) + '</td>' +
        '<td class="ta-r mono">' + money(sM) + '</td>' +
        '<td></td><td></td>' +
        '<td class="ta-r mono">' + money(sS) + '</td>' +
        '<td></td>' +
        '<td class="ta-r mono">' + money(sI) + '</td>' +
        '<td class="ta-r mono">' + money(sNB) + '</td>' +
        '<td class="ta-r mono">' + money(sNE) + '</td>' +
        '<td colspan="12"></td>';
      foot.appendChild(trf);
    }
    $('assetCount').textContent = '共 ' + total + ' 条';
    $('aPageNo').textContent = _assetPage;
    var pages = Math.max(1, Math.ceil(total / _assetPageSize));
    $('aPrev').parentNode.classList.toggle('disabled', _assetPage <= 1);
    $('aNext').parentNode.classList.toggle('disabled', _assetPage >= pages);
    renderAssetReconcile();   // 卡片 ↔ 总账对账状态（一致则隐藏）
    updateAssetDeprTip();    // 折旧生成状态提示（取代原独立折旧凭证页的顶部提示）
  }
  // 工具条
  $('btnNewAsset').addEventListener('click', function () { _openAssetModal(null); });
  $('btnAssetHistory').addEventListener('click', showAllFaHistory);
  // 左树（类别/部门）点击筛选已在 renderAssetTree 内绑定
  // 顶部「显示已清理资产」：原先还要与折叠面板里的同名勾选框互相同步，面板已移除，只留其一
  $('fShowCleanedTop').addEventListener('change', function () { _assetPage = 1; renderAssets(); });
  $('btnAssetExport').addEventListener('click', function () {
    if (!_assetFiltered.length) return showToast('当前无可导出的卡片', 'error');
    var wb = TyIo.buildAssetWorkbook(_assetFiltered);
    __safeExportExcel(wb, '固定资产卡片_' + _assetPeriod())
      .then(function (path) { window.__fileSaveBridge.toastExported(path); })
      .catch(function (e) { showToast('导出失败：' + (e && e.message || e), 'error'); });
  });
  /* ---------- 导入体检 + 查重报告（2026-09-17） ----------
   * 为什么需要：导入的失败模式是"静默"的 —— 缺列不报错，只是期末累计折旧悄悄算不出来。
   * 检查项（每一项都是实测踩过的坑）：
   *   ① 缺开始使用日期 → 期末累计折旧的锚点算不出来，页面只能退回卡片存值（会停在期初）
   *   ② 缺预计使用期限 → 月折旧为 0，期末永远等于期初
   *   ③ 期初/期末累计折旧都为 0 → 卡片没有折旧起点
   *   ④ 文件带出的「月折旧额」与本软件算法(剩余净值/剩余寿命)不符 → 卡片可能改过折旧方法/年限
   *   ⑤ 期初、期末都给时，(期末-期初) 不是月折旧额的整数倍 → 两个口径不一致
   * 只提示、不阻断：源头数据的问题需要用户自己判断。 */
  function _assetImportCheck(list) {
    var out = [];
    (list || []).forEach(function (fa) {
      var msg = [];
      var begin = num(fa.accumDeprBegin), end = num(fa.accumDepr);
      var md = S.assetMonthlyDepr(fa);
      var ref = num(fa.monthDeprRef);                      // 导入文件的「月折旧额」（给了才有）
      if (!fa.acqDate) msg.push('缺开始使用日期');
      if (!num(fa.life)) msg.push('缺预计使用期限');
      if (!begin && !end) msg.push('期初/期末累计折旧均为 0');
      if (ref > 0 && md > 0 && Math.abs(ref - md) > 0.01) {
        msg.push('月折旧与导入数据不符（本软件 ' + md.toFixed(2) + ' / 导入 ' + ref.toFixed(2) + '）');
      }
      // 文件给的期末（归一前的原值）与期初的差额，应当是月折旧的整数倍
      var fileEnd = num(fa.accumDeprRef) || end;
      var unit = ref > 0 ? ref : md;      // 校验单位：优先导入文件的「月折旧额」，其次本软件算出的月折旧
      var diff = fileEnd - begin;
      if (unit > 0 && begin > 0 && fileEnd > 0 && Math.abs(diff / unit - Math.round(diff / unit)) > 0.01) {
        msg.push('期初/期末差额 ' + diff.toFixed(2) + ' 不是月折旧 ' + unit.toFixed(2) + ' 的整数倍');
      }
      if (msg.length) out.push({ code: fa.code || '', name: fa.name || '', msg: msg.join('；') });
    });
    return out;
  }
  // 提示条渲染（表格上方）：有提示才显示；无提示但跳过了重复时也给一句回执
  function renderAssetImportCheck(warns, addedCount, dupCount) {
    var el = $('assetImportCheck');
    if (!el) return;
    var close = ' <a href="#" class="gl-filter-clear" id="assetImportCheckClose">关闭</a>';
    if (warns && warns.length) {
      el.className = 'open-check warn';
      el.hidden = false;
      el.innerHTML = '导入体检：' + warns.length + ' 张卡片有需核对项（不影响导入）—— ' +
        warns.slice(0, 6).map(function (w) { return esc(w.code + ' ' + w.name + '：' + w.msg); }).join('；') +
        (warns.length > 6 ? '；…等共 ' + warns.length + ' 张' : '') + close;
      // 明细同时写操作日志，便于事后回查（提示条只显示前 6 条）
      if (S.addLog) {
        S.addLog('固定资产导入体检', warns.map(function (w) { return w.code + ' ' + w.name + '：' + w.msg; }).join(' | '), '固定资产');
      }
      return;
    }
    if (dupCount) {
      el.className = 'open-check ok';
      el.hidden = false;
      el.innerHTML = '导入完成：新增 ' + addedCount + ' 张，按编码跳过重复 ' + dupCount + ' 张。' + close;
      return;
    }
    el.hidden = true;
    el.innerHTML = '';
  }
  /* ---------- 卡片 ↔ 总账对账 ----------
   * 卡片与总账是同一事实的两份记录，以下两条都必须相等：
   *   ① 累计折旧：卡片「期末累计折旧」合计  vs 「累计折旧」科目的总账期末余额
   *   ② 原值    ：卡片「原值」合计        vs  卡片所挂各固定资产科目的总账期末余额合计
   *
   * 【为什么必须补②】只做①时，「账上有资产却没有建卡片」这种错查不出来：这类资产的累计折旧是 0，
   * 卡片侧与总账侧同时少一块、互不影响，①照样通过。实测（绅蓝之星 2026-08）：科目
   * 1601001「家具设备」账面 787,047.41 而卡片只有 588,903.41，差 198,144.00（其中 204,184.00
   * 是期初余额里从未拆成卡片的部分，−6,040.00 是一台已处置却仍标「正常」的空调），
   * 累计折旧核对完全通过 —— 补了②才暴露出来。
   *
   * 核对口径（与列表、折旧表的可见集严格一致）：
   *   · 已「清理」的卡片不计入 —— 清理凭证已把该资产从账上转出，卡片侧保留历史值属正常差异；
   *   · 期间早于购置月的卡片不计入 —— 该资产尚未入账。
   * 容差：①按卡片张数放大（两边舍入方式不同：卡片一次性舍入，总账按每张卡 round2 后相加）；
   *       ②两侧都是精确录入值，固定 0.01。 */
  function _assetLedgerReconcile(month) {
    if (!month) return null;
    var rows = S.generalLedger(month) || [];
    function endBalOf(code) {
      var r = rows.filter(function (x) { return String(x.code) === String(code); })[0];
      if (!r) return null;
      return r.normal === 'dr' ? (num(r.endDr) - num(r.endCr)) : (num(r.endCr) - num(r.endDr));
    }
    // 参与核对的卡片（同页面可见口径）
    var active = (S.state.fixedAssets || []).filter(function (fa) {
      if (fa.status === '清理') return false;
      var acqM = fa.acqDate ? String(fa.acqDate).slice(0, 7) : '';
      return !(acqM && acqM > month);
    });

    // ① 累计折旧
    var depr = null;
    var depSubj = S.subjectRole && S.subjectRole('ACC_DEPR');
    if (depSubj) {
      var cardTotal = 0;
      active.forEach(function (fa) { cardTotal += _accumDeprAt(fa, month, S.assetMonthlyDepr(fa)); });
      var ledgerEnd = endBalOf(depSubj.code);
      if (ledgerEnd !== null) {
        var d1 = Math.round((cardTotal - ledgerEnd) * 100) / 100;
        var tol = Math.round((active.length * 0.01 + 0.01) * 100) / 100;
        depr = { subject: depSubj, cardTotal: cardTotal, ledgerTotal: ledgerEnd, diff: d1,
          tolerance: tol, ok: Math.abs(d1) <= tol };
      }
    }

    // ② 原值：按卡片**实际挂的**固定资产科目分组核对。
    //    不用「猜」固定资产科目 —— 1601 常有明细科目（1601001/1601002…），卡片可能挂在任一层，
    //    直接取卡片上的 faAcctId 才准，也才能把差异定位到具体科目。
    var byAcct = {}, orphan = { count: 0, amount: 0 }, cardOrig = 0;
    active.forEach(function (fa) {
      // 兼容脏数据：实测科目码会被拼成 "5401006,5401006"
      var code = String(fa.faAcctId == null ? '' : fa.faAcctId).split(',')[0].trim();
      var orig = num(fa.original);
      cardOrig += orig;
      if (code && S.subject(code)) byAcct[code] = (byAcct[code] || 0) + orig;
      else { orphan.count++; orphan.amount += orig; }   // 未设科目 / 科目已不存在 → 无处核对
    });
    var ledgerOrig = 0, detail = [];
    Object.keys(byAcct).forEach(function (c) {
      var led = endBalOf(c) || 0;
      ledgerOrig += led;
      detail.push({ code: c, name: (S.subject(c) || {}).name || '', card: byAcct[c],
        ledger: led, diff: Math.round((byAcct[c] - led) * 100) / 100 });
    });
    detail.sort(function (a, b) { return Math.abs(b.diff) - Math.abs(a.diff); });
    var d2 = Math.round((cardOrig - ledgerOrig) * 100) / 100;
    var orig = { cardTotal: cardOrig, ledgerTotal: ledgerOrig, diff: d2, tolerance: 0.01,
      ok: Math.abs(d2) <= 0.01, detail: detail, orphan: orphan };

    return { month: month, depr: depr, orig: orig, ok: (!depr || depr.ok) && orig.ok };
  }
  // 每次渲染资产列表时刷新（一致则隐藏，不打扰）
  function renderAssetReconcile() {
    var el = $('assetReconcileCheck');
    if (!el) return;
    var rc = _assetLedgerReconcile(_assetPeriod());
    if (!rc || rc.ok) { el.hidden = true; el.innerHTML = ''; return; }
    var parts = [];
    // ② 原值（先讲这条 —— 它指向"有资产没建卡片"这类结构性缺失，比折旧的偶发差异更要紧）
    if (rc.orig && !rc.orig.ok) {
      var worst = (rc.orig.detail || [])[0];
      parts.push('<b>原值与总账不符</b>：卡片原值合计 <b>' + money(rc.orig.cardTotal) + '</b>，' +
        '账上（' + esc(rc.month) + ' 期末）合计 <b>' + money(rc.orig.ledgerTotal) + '</b>，' +
        '差额 <b>' + money(rc.orig.diff) + '</b>' +
        '（负数为「账上有这笔资产、但没有对应的卡片」，正数为「有卡片而账上没有」）。' +
        (worst ? '差异最大的科目：<b>' + esc(worst.code + ' ' + worst.name) + '</b>（卡片 ' +
          money(worst.card) + ' / 账上 ' + money(worst.ledger) + '）。' : ''));
      if (rc.orig.orphan && rc.orig.orphan.count) {
        parts.push('另有 ' + rc.orig.orphan.count + ' 张卡片未指定固定资产科目（原值合计 ' +
          money(rc.orig.orphan.amount) + '），无法参与核对，请先在卡片上补选科目。');
      }
    }
    // ① 累计折旧
    if (rc.depr && !rc.depr.ok) {
      parts.push('<b>期末累计折旧与总账不符</b>：卡片合计 <b>' + money(rc.depr.cardTotal) + '</b>，' +
        '科目「' + esc(rc.depr.subject.code + ' ' + rc.depr.subject.name) + '」' + esc(rc.month) +
        ' 期末 <b>' + money(rc.depr.ledgerTotal) + '</b>，差额 <b>' + money(rc.depr.diff) +
        '</b>（容差 ' + money(rc.depr.tolerance) + '，已按卡片张数计入逐张舍入的累计误差）。');
    }
    if (!parts.length) { el.hidden = true; el.innerHTML = ''; return; }
    parts.push('常见原因：有资产未建卡片、期初余额未拆成明细资产、资产已处置但卡片未标「清理」、卡片被手工改过或计提未落账。');
    el.className = 'open-check warn';
    el.hidden = false;
    el.innerHTML = parts.join('<br>');
  }
  // 关闭按钮（一次性委托，避免每次导入重复绑定）
  if (!globalThis.__assetImportCheckBound) {
    globalThis.__assetImportCheckBound = true;
    document.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('#assetImportCheckClose');
      if (!a) return;
      e.preventDefault();
      var el = $('assetImportCheck');
      if (el) { el.hidden = true; el.innerHTML = ''; }
    });
  }
  $('btnAssetImport').addEventListener('click', function () {
    var inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.xlsx,.xls';
    inp.onchange = function () {
      var f = inp.files[0]; if (!f) return;
      var reader = new FileReader();
      reader.onload = function (e) {
        try {
          var wb = XLSX.read(e.target.result, { type: 'array' });
          var list = TyIo.parseAssetWorkbook(wb);
          if (!list.length) return showToast('未解析到有效卡片（需含编码/名称/原值）', 'error');
          // 【按编码查重】编码已存在的默认跳过 —— 否则同一个文件点两次就会卡片翻倍
          // （addFixedAsset 不做唯一性检查：卡片、折旧表都会翻倍；总账不受影响但账实不符）。
          var existCode = {};
          (S.state.fixedAssets || []).forEach(function (x) { var c = String(x.code || '').trim(); if (c) existCode[c] = true; });
          var listAdd = [], listDup = [];
          list.forEach(function (fa) {
            var c = String(fa.code || '').trim();
            if (c && existCode[c]) { listDup.push(fa); return; }
            if (c) existCode[c] = true;      // 文件内部同编码也只入一条
            listAdd.push(fa);
          });
          // 【期初/期末口径归一】卡片的不变式是「期初累计折旧 = 期末累计折旧 = 累计至『已折旧期间』月末」
          // （应用自身计提就是"月末滚转"，见 store.depreciateMonth）。
          // 而导入文件给出的「期末累计折旧」是【查询期间末】的值，与「已折旧期间数」相差一个月 ——
          // 直接落库会让 assetMonthlyDepr 的"剩余净值 ÷ 剩余寿命"整体错一个月
          // （实测月折旧会从 6,517.50 变成 6,341.35）。故：期末一律回到期初，
          // 文件给的期末只留作体检校验值（accumDeprRef），落库前删除。
          listAdd.forEach(function (fa) {
            var b = num(fa.accumDeprBegin), e = num(fa.accumDepr);
            if (b > 0 && e > 0 && Math.abs(e - b) > 0.01) { fa.accumDeprRef = e; fa.accumDepr = b; }
          });
          // 【导入体检】不阻断导入，把"会静默出错"的项报出来（提示条 + 操作日志）
          var warns = _assetImportCheck(listAdd);
          listAdd.forEach(function (fa) { delete fa.monthDeprRef; delete fa.accumDeprRef; S.addFixedAsset(fa); });
          // 导入后清空左树筛选并回到首页，确保新卡片可见；含非「正常」状态则自动开启「显示已清理资产」
          _assetCatSel = ''; _assetDeptSel = ''; _assetPage = 1;
          var hasNonNormal = listAdd.some(function (fa) { return (fa.status || '正常') !== '正常'; });
          var swTop = $('fShowCleanedTop'); if (swTop) swTop.checked = hasNonNormal;
          renderAssetTree(); renderAssets(); syncAll();
          renderAssetImportCheck(warns, listAdd.length, listDup.length);
          var msg = listAdd.length
            ? ('已导入 ' + listAdd.length + ' 张卡片')
            : ('未新增（' + listDup.length + ' 张编码均已存在，已跳过）');
          if (listAdd.length && listDup.length) msg += '，跳过同编码重复 ' + listDup.length + ' 张';
          if (warns.length) msg += '；' + warns.length + ' 张有需核对项（见表格上方）';
          showToast(msg + (hasNonNormal ? '（含非「正常」状态，已开启显示）' : ''), warns.length ? 'warn' : 'success');
        } catch (err) { showToast('导入失败：' + err.message, 'error'); }
      };
      reader.readAsArrayBuffer(f);
    };
    inp.click();
  });
  $('btnAssetBatch').addEventListener('click', function (e) {
    e.stopPropagation();
    var m = $('assetBatchMenu'); if (m) m.hidden = !m.hidden;
  });
  $('assetBatchMenu').addEventListener('click', async function (e) {
    var a = e.target.closest('a');
    if (!a) return;
    // 先收起菜单再分发：菜单里现在还有「导入/导出/打印」这类**没有 data-batch** 的项，
    // 它们由各自既有通道处理（导入/导出 = 本文件按 id 绑定；打印 = app.js 的 [data-print] 全局委托）。
    // 原先按 a[data-batch] 选择器取元素并在取不到时直接 return，会导致点这三项菜单不收起 —— 故改为
    // 先关闭、再判断有无 data-batch，无则交还给它们的处理器。
    $('assetBatchMenu').hidden = true;
    var act = a.getAttribute('data-batch');
    if (!act) return;
    var checked = [].slice.call(document.querySelectorAll('.aChk:checked')).map(function (c) { return c.getAttribute('data-id'); });
    // 「关联凭证」：把**账上已有**的购入凭证挂到卡片上，填「新增资产凭证」列。
    // ⚠️ 只关联、不生成凭证 —— 迁移账套里购入凭证本就在（实测 10 张卡片 10/10 命中），
    // 再「生成」一张就是固定资产重复入账。幂等：已关联的卡片跳过，可反复点。
    // 不要求先勾选（勾了就只关联勾选的、没勾就关联全部未关联的）→ 排在通用守卫之前
    if (act === 'link') {
      var lr = S.linkAssetAcquisitions(checked);
      renderAssets(); syncAll();
      var lmsg = lr.linked.length ? ('已关联 ' + lr.linked.length + ' 张卡片的凭证') : '没有可新关联的卡片';
      if (lr.unmatched.length) lmsg += '；另有 ' + lr.unmatched.length + ' 张未匹配到凭证';
      showToast(lmsg, lr.unmatched.length ? 'warn' : 'success');
      if (lr.unmatched.length) console.warn('[关联凭证] 未匹配明细：', lr.unmatched);
      return;
    }
    if (!checked.length) return showToast('请先勾选要操作的卡片', 'error');
    if (act === 'cleanvch') {
      // 生成清理凭证（原「生成凭证」按钮勾了已清理卡片时走的那条路径，现归到批量操作里）。
      // 只挑「已清理且未生成清理凭证」的卡片，genCleanVoucher 自身对已生成过的会跳过（幂等）。
      // 与「计提折旧」一致：写凭证的动作不加二次确认。
      var month = _assetPeriod();
      var cleanIds = checked.filter(function (id) {
        var fa = S.state.fixedAssets.filter(function (x) { return x.id === id; })[0];
        return fa && fa.status === '清理' && !fa.cleanVoucher;
      });
      if (!cleanIds.length) return showToast('勾选的卡片里没有「已清理且未生成清理凭证」的资产', 'warn');
      var rc = S.genCleanVoucher(cleanIds, month);
      if (!rc.ok) return showToast(rc.msg, 'error');
      showToast('已生成清理凭证 ' + rc.voucher.word + '-' + rc.voucher.no);
      renderAssets(); syncAll();
    } else if (act === 'unlink') {
      // 错配回退：只解除「卡片 ↔ 购入凭证」的关联，**不动凭证本身**（凭证是账，不能因解关联而消失）
      if (!(await H.confirmAsync('已勾选 ' + checked.length + ' 张卡片，确认解除「新增资产凭证」的关联？\n只解除关联，不会删除或修改任何凭证。（此操作与删除折旧/清理凭证无关）', { title: '解除购入凭证关联' }))) return;
      var ur = S.unlinkAssetAcquisitions(checked);
      renderAssets(); syncAll();
      showToast(ur.n ? ('已解除 ' + ur.n + ' 张卡片的关联') : '所勾选的卡片本来就没有关联凭证');
    } else if (act === 'clean') {
      // 与行内清理同一口径：批量标记 + 一张汇总清理凭证（genCleanVoucher 支持多卡合并成一张）；
      // 生成失败则整体回滚标记，避免留下「已清理但无凭证」的悬空状态。
      var m2 = _assetPeriod();
      if (!(await H.confirmAsync('已勾选 ' + checked.length + ' 张卡片，确认批量清理并生成清理凭证（清理期间 ' + m2 + '）？\n\n' +
        '将生成一张汇总凭证：借 固定资产清理/累计折旧，贷 固定资产。\n' +
        '注意：该凭证只转出账面价值，处置收入、清理费用与净损益结转需另行手工处理。\n\n' +
        '清理后这些卡片会移入「显示已清理资产」视图并停止计提折旧；如需撤销，删除该凭证即可自动恢复。', { title: '批量清理' }))) return;
      // 只记下「本次新标记」的卡片：失败回滚时只还原这些。
      // 不能拿 checked 整体回滚 —— 勾选里可能混有「原本就已清理且有凭证」的卡片，
      // 而 cancelCleanFixedAsset 现在会连同凭证一起撤销，那就误删了人家既有的清理凭证。
      var newlyMarked = checked.filter(function (id) {
        var f = S.state.fixedAssets.filter(function (x) { return x.id === id; })[0];
        return f && f.status !== '清理';
      });
      newlyMarked.forEach(function (id) { S.cleanFixedAsset(id, m2); });
      var gv2 = S.genCleanVoucher(checked, m2);
      if (!gv2.ok) {
        newlyMarked.forEach(function (id) { S.cancelCleanFixedAsset(id); });
        renderAssets(); syncAll();
        return showToast('批量清理未完成：' + gv2.msg, 'error');
      }
      renderAssets(); syncAll();
      showToast('已清理 ' + gv2.count + ' 张，生成凭证 ' + ((gv2.voucher.word || '记') + '-' + gv2.voucher.no) +
        '，金额 ' + money(gv2.total) + '（卡片已归入「显示已清理资产」）');
    } else {
      if (!(await H.confirmAsync('已勾选 ' + checked.length + ' 张卡片，确认批量删除？\n\n' +
        '已有折旧或清理记录的卡片无法删除（会提示改用「清理」处理）。', { title: '批量删除' }))) return;
      var delOk = 0, delFail = 0;
      checked.forEach(function (id) { var r = S.removeFixedAsset(id); if (r.ok) delOk++; else delFail++; });
      renderAssets(); syncAll();
      showToast('已删除 ' + delOk + ' 张' + (delFail ? '，' + delFail + ' 张因已折旧/清理未删' : ''));
    }
  });
  document.addEventListener('click', function (e) {
    var m = $('assetBatchMenu');
    if (m && !m.hidden && !e.target.closest('#btnAssetBatch') && !e.target.closest('#assetBatchMenu')) m.hidden = true;
  });
  // 「计提折旧」：按左侧期间对【全部】应计提资产计提本月折旧并生成折旧凭证。
  // 为什么不吃勾选：准则要求对所有应计提折旧的固定资产按月计提，不能挑着提（漏提即账实不符），
  //   故本操作与勾选无关。但页面上「批量清理/批量删除/关联购入凭证」都遵循「勾了就只处理勾选的」，
  //   用户极易形成同样预期 —— 因此仅在【有勾选】时弹确认明确告知范围，不勾选则直接执行（日常不打扰）。
  $('btnAssetGenVoucher').addEventListener('click', async function () {
    var month = _assetPeriod();
    var checked = Array.prototype.slice.call(document.querySelectorAll('.aChk:checked'));
    if (checked.length) {
      var total = (S.state.fixedAssets || []).length;
      if (!(await H.confirmAsync(
        '「计提折旧」按期间对全部应计提折旧的资产进行，与勾选无关（勾选不参与筛选）。\n\n' +
        '本账套共 ' + total + ' 张卡片，系统会自动跳过已清理、已提满、本月已计提的资产。\n\n' +
        '是否继续计提 ' + month + ' 的折旧？', { title: '计提折旧范围' }))) return;
    }
    var r = S.depreciateMonth(month);
    if (!r.ok) return showToast(r.msg, 'error');
    showToast('已计提 ' + month + ' 折旧，生成凭证 ' + ((r.voucher.word || '记') + '-' + r.voucher.no) + '，金额 ' + money(r.total) + '（' + r.count + ' 项资产）');
    renderAssets(); syncAll();
  });
  $('aPrev').addEventListener('click', function () { if (_assetPage > 1) { _assetPage--; renderAssets(); } });
  $('aNext').addEventListener('click', function () {
    var pages = Math.max(1, Math.ceil(_assetFiltered.length / _assetPageSize));
    if (_assetPage < pages) { _assetPage++; renderAssets(); }
  });
  $('aPageSize').addEventListener('change', function () { _assetPageSize = num($('aPageSize').value); _assetPage = 1; renderAssets(); });
  $('aCheckAll').addEventListener('change', function (e) { document.querySelectorAll('.aChk').forEach(function (c) { c.checked = e.target.checked; }); });
  // 资产类别页表头全选：此前同样是「有元素、无绑定」。
  $('catCheckAll').addEventListener('change', function (e) {
    document.querySelectorAll('.catChk').forEach(function (c) { c.checked = e.target.checked; });
  });
  $('assetBody').addEventListener('click', async function (e) {
    if (e.target.classList.contains('link-edit')) {
      _openAssetModal(e.target.getAttribute('data-asset-edit'));
    } else if (e.target.classList.contains('link-clean')) {
      // 清理一步式：标记清理 + 立即生成清理凭证。
      // 必须「先标记再生成」—— genCleanVoucher 只处理 status=清理 的卡片；
      // 生成失败则把标记回滚，避免留下「卡片显示已清理、账上资产还在」的账实不符。
      // 边界：本凭证只做「账面价值转入固定资产清理」这一步，处置收入/清理费用/净损益结转
      // 属会计判断，软件不代做（确认弹窗已明示）。
      var cid = e.target.getAttribute('data-clean');
      var cf = S.state.fixedAssets.filter(function (x) { return x.id === cid; })[0];
      if (!cf) return;
      var cm = _assetPeriod();
      if (!(await H.confirmAsync('确认清理「' + cf.name + '」？\n清理期间：' + cm +
        '\n\n将同时生成清理凭证：借 固定资产清理/累计折旧，贷 固定资产。' +
        '\n注意：该凭证只转出账面价值，处置收入、清理费用与净损益结转需另行手工处理。' +
        '\n\n清理后该卡片会移入「显示已清理资产」视图（列表上方勾选可查看），不再计提折旧；' +
        '如需撤销，删除该清理凭证即可，卡片会自动恢复为正常。', { title: '清理资产' }))) return;
      S.cleanFixedAsset(cid, cm);
      var gv = S.genCleanVoucher([cid], cm);
      if (!gv.ok) {
        S.cancelCleanFixedAsset(cid); // 生成失败 → 回滚标记，不留「已清理但无凭证」的悬空状态
        renderAssets(); syncAll();
        return showToast('清理未完成：' + gv.msg, 'error');
      }
      var gvNo = (gv.voucher.word || '记') + '-' + gv.voucher.no;
      renderAssets(); syncAll();
      showToast('已清理并生成凭证 ' + gvNo + '：' + cf.name + '（卡片已归入「显示已清理资产」，删除该凭证可撤销）');
    } else if (e.target.classList.contains('link-unclean')) {
      // 取消清理 = 撤销整个处置动作：若该卡片已生成清理凭证，会连同凭证一起删除（账务回退）。
      // 这是会动账的操作，故先在弹窗里说清"要删哪张凭证"再执行（凭证为软删，可在回收站还原）。
      var unId = e.target.getAttribute('data-unclean');
      var unFa = S.state.fixedAssets.filter(function (x) { return x.id === unId; })[0];
      if (unFa && unFa.cleanVoucher) {
        if (!(await H.confirmAsync('确认取消「' + unFa.name + '」的清理？\n\n' +
          '将同时删除清理凭证 ' + unFa.cleanVoucher + '（账务一并回退）。', { title: '取消清理' }))) return;
      }
      var r = S.cancelCleanFixedAsset(unId);
      if (!r.ok) return showToast(r.msg, 'error');
      renderAssets(); syncAll();
      showToast(r.removedVoucher ? ('已取消清理，清理凭证 ' + r.removedVoucher + ' 已删除') : '已取消清理');
    }
  });
  // （行内「复制」功能已于 2026-09-18 移除：固定资产业务中逐张复制卡片意义不大，
  //   且行内操作越少越不易误点。新增卡片请用顶部「新增」。）
  // 固定资产表单的 7 个科目选择：统一用唯一科目选择组件 bindSubjectPicker（输入框+联想）。
  // 每个下拉带各自的前缀过滤（如固定资产只列 16 开头）。首次绑定一次（dataset 守卫），
  // 之后 _openAssetModal 只回填 value，避免每次打开重复挂监听。
  var _acctCombos = {
    aFaAcct: /^16/, aAccDeprAcct: /^1602/, aDeprFeeAcct: /^5[0-9]/, aCleanAcct: /^1606/,
    aPurchaseAcct: /^1[0-9]/, aImpairAcct: /^1[0-9]/
  };
  function _bindAcctCombos() {
    Object.keys(_acctCombos).forEach(function (id) {
      var inp = $(id); if (!inp || inp.dataset.comboBound) return;
      inp.dataset.comboBound = '1';
      bindSubjectPicker(inp, {
        filter: function (s) { return _acctCombos[id].test(s.code); },
        onPick: function (code) { inp.value = code; } // 选中即写回（与旧 SubjectCombo 行为一致）
      });
    });
  }
  // fa 对象字段名（faAcctId/accDeprAcct/...）与 input id（aFaAcct/...）不同，需显式映射
  var _acctFieldMap = {
    aFaAcct: 'faAcctId', aAccDeprAcct: 'accDeprAcct', aDeprFeeAcct: 'deprFeeAcct',
    aCleanAcct: 'cleanAcct', aPurchaseAcct: 'purchaseAcct', aImpairAcct: 'impairAcct'
  };
  function _setAcctCombos(fa) {
    Object.keys(_acctFieldMap).forEach(function (id) {
      var inp = $(id); if (inp) inp.value = (fa && fa[_acctFieldMap[id]]) || '';
    });
  }
  var _editingDeprMonth = '';   // 编辑卡片时卡片自带的锚点月（有则优先于推导）
  // 推导锚点月 =「开始使用月 + 已折旧期间」，与 _accumDeprAt 里外部导入卡的口径一致
  function _anchorMonth() {
    var acq = $('aAcq') ? $('aAcq').value : '';
    var ym = acq ? String(acq).slice(0, 7) : '';
    if (!/^\d{4}-\d{2}$/.test(ym)) return '';
    return _addMonths(ym, U.num($('aPeriodUsed').value));
  }
  /* 辅助提示：把字段的隐含口径直接写出来。这几个字段原先没有任何说明 ——
   * 而「期初累计折旧」恰恰最需要说明：它必须是【锚点月末】的余额，时点填错就会与总账差整期折旧
   * （卡片显示累计 vs 总账 1602，差额正好是一期月折旧额）。 */
  function _updateHints() {
    var o = U.num($('aOriginal').value), sr = U.num($('aSalvageRate').value), m = U.num($('aLife').value);
    var hS = $('aSalvageHint');
    if (hS) hS.textContent = o > 0 ? ('预计残值 ' + money(o * sr / 100)) : '';
    var hA = $('aAccumHint');
    if (hA) {
      var anchor = _editingDeprMonth || _anchorMonth();
      hA.textContent = anchor ? ('截至 ' + anchor + ' 月末' + (_editingDeprMonth ? '（最近计提月）' : '')) : '';
    }
    var hM = $('aMonthDeprHint');
    if (hM) hM.textContent = (o > 0 && m > 0) ? '按原值、残值率、期数算出' : '';
  }
  // 月折旧额联动：录入原值/残值率/期数后自动计算（form_perDepreciation）
  function _calcMonthDepr() {
    var o = U.num($('aOriginal').value), r = U.num($('aSalvageRate').value), m = U.num($('aLife').value);
    if (!o || !m) { $('aMonthDepr').value = ''; _updateHints(); return; }
    $('aMonthDepr').value = ((o * (1 - r / 100)) / m).toFixed(2);
    _updateHints();
  }
  function _openAssetModal(id) {
    // 填充类别下拉（仅一次）
    var ac = $('aCategory');
    if (ac && ac.options.length <= 1) {
      var fa = id ? S.state.fixedAssets.filter(function (x) { return x.id === id; })[0] : null;
      // 新增时只列启用类别；编辑时额外补回该卡片当前类别（即使已停用，避免历史回填丢失）
      assetCats().forEach(function (c) {
        if (c.enabled === false && !(fa && fa.category === c.code)) return;
        var o = document.createElement('option'); o.value = c.code; o.textContent = c.name + (c.enabled === false ? '（停用）' : ''); ac.appendChild(o);
      });
    }
    // 科目选择统一为联想输入（bindSubjectPicker 组件，带前缀过滤）
    _bindAcctCombos();
    var fa = id ? S.state.fixedAssets.filter(function (x) { return x.id === id; })[0] : null;
    // 填充部门下拉（仅一次）。部门存**名称**（与卡片 fa.dept 同口径），故 option 的 value 就是名称。
    // 与类别下拉同款：新增时只列启用部门；编辑时补回该卡片当前部门（含已停用）。
    var ad = $('aDept');
    if (ad && ad.options.length <= 1) {
      var hasCurDept = false;
      S.depts().forEach(function (d) {
        if (d.enabled === false && !(fa && fa.dept === d.name)) return;
        if (fa && fa.dept === d.name) hasCurDept = true;
        var o = document.createElement('option');
        o.value = d.name; o.textContent = d.name + (d.enabled === false ? '（停用）' : '');
        ad.appendChild(o);
      });
      // 兜底：卡片上的部门不在档案里（老数据 / 手工改过）→ 也列出来。
      // 否则 <select> 会回落到「请选择」，一保存就把部门清空了。
      if (fa && fa.dept && !hasCurDept) {
        var oc = document.createElement('option'); oc.value = fa.dept; oc.textContent = fa.dept; ad.appendChild(oc);
      }
    }
    $('aCode').value = fa ? (fa.code || '') : '';
    $('aName').value = fa ? (fa.name || '') : '';
    _setAcctCombos(fa); // 回填 7 个科目（input 的 .value）
    $('aDept').value = fa ? (fa.dept || '') : '';
    $('aAcq').value = fa ? (fa.acqDate || '') : '';
    $('aOriginal').value = fa ? fa.original : '';
    $('aMethod').value = fa ? (fa.method || '平均年限法') : '平均年限法';
    $('aSalvageRate').value = fa ? fa.salvageRate : '';
    $('aLife').value = fa ? (fa.life * 12) : 60;    // 存储为年，表单显示月
    $('aPeriodUsed').value = fa ? (fa.periodUsed || 0) : 0;
    $('aAccumDeprBegin').value = fa ? num(fa.accumDeprBegin) : 0;
    $('aYearDepr').value = fa ? (fa.yearDepr || 0) : 0;
    $('aQty').value = fa ? (fa.qty || 1) : 1;
    $('aCategory').value = fa ? (fa.category || '') : '';
    $('aSpec').value = fa ? (fa.spec || '') : '';
    $('aLocation').value = fa ? (fa.location || '') : '';
    $('aUser').value = fa ? (fa.user || '') : '';
    $('aImpairment').value = fa ? fa.impairment : 0;
    $('aMemo').value = fa ? (fa.memo || '') : '';
    // 「状态」「清理期间」已不在表单里：新增一律「正常」，转清理走卡片行的
    // 「清理」动作（会同时生成凭证）；编辑时 _collectAsset 也不再采集这两个字段，
    // 所以卡片上的原值不会被覆盖。
    // 新增时「资产清理科目」默认带出 1606（固定资产清理），省一次手选。
    if (!fa) {
      var cl = $('aCleanAcct');
      if (cl && !cl.value) {
        var cs = (S.state.subjects || []).filter(function (x) { return String(x.code) === '1606'; })[0];
        if (cs) cl.value = String(cs.code);
      }
    }
    // 编辑已计提过的卡片：锚点用卡片自带 deprMonth（最近计提月），优先于"购置月+已折旧期间"推导
    _editingDeprMonth = (fa && fa.deprMonth) ? String(fa.deprMonth) : '';
    _calcMonthDepr();   // 内部连带刷新辅助提示
    // 已提过折旧 → 禁用身份 + 折旧 + 会计科目字段（改了会破坏折旧轨迹）
    // 新增时 / 未提过时 → 全部可改
    var hasDepr = fa && (num(fa.periodUsed) > 0 || num(fa.accumDeprBegin) > 0 || fa.deprMonth);
    var lockedIds = ['aCode', 'aName', 'aFaAcct', 'aAccDeprAcct', 'aDeprFeeAcct',
      'aAcq', 'aOriginal', 'aMethod', 'aSalvageRate', 'aLife', 'aPeriodUsed',
      'aAccumDeprBegin', 'aYearDepr', 'aQty', 'aImpairment'];
    lockedIds.forEach(function (eid) {
      var el = $(eid); if (!el) return;
      el.disabled = !!hasDepr;
      if (hasDepr) el.title = '已计提折旧的卡片，此字段不可修改（如需修改请先反结账、删除该期间折旧凭证）';
      else el.removeAttribute('title');
    });
    $('assetModal').setAttribute('data-asset-id', id || '');
    $('assetModal').classList.add('show');
  }
  // 收集表单为卡片对象
  function _collectAsset() {
    return {
      code: $('aCode').value, name: $('aName').value, faAcctId: $('aFaAcct').value, dept: $('aDept').value,
      acqDate: $('aAcq').value, original: U.num($('aOriginal').value), accDeprAcct: $('aAccDeprAcct').value,
      method: $('aMethod').value, deprFeeAcct: $('aDeprFeeAcct').value, cleanAcct: $('aCleanAcct').value,
      purchaseAcct: $('aPurchaseAcct').value, impairAcct: $('aImpairAcct').value, salvageRate: $('aSalvageRate').value,
      life: U.num($('aLife').value) / 12, periodUsed: U.num($('aPeriodUsed').value),
      accumDeprBegin: U.num($('aAccumDeprBegin').value), yearDepr: U.num($('aYearDepr').value),
      qty: U.num($('aQty').value), category: $('aCategory').value, spec: $('aSpec').value,
      location: $('aLocation').value, user: $('aUser').value,
      impairment: U.num($('aImpairment').value), memo: $('aMemo').value,
      // 刻意不采集 status / cleanPeriod：表单已移除这两个字段。
      // 编辑时不覆盖卡片原值；新增时由 addFixedAsset 补默认（'正常' / ''）。
      salvage: U.num($('aOriginal').value) * U.num($('aSalvageRate').value) / 100
    };
  }
  $('btnCloseAsset').addEventListener('click', function () { $('assetModal').classList.remove('show'); });
  $('btnCloseAssetHistory').addEventListener('click', function () { $('assetHistoryModal').classList.remove('show'); });
  $('btnCloseAssetHistory2').addEventListener('click', function () { $('assetHistoryModal').classList.remove('show'); });
  // aAcq / aPeriodUsed 也挂上：这两个字段决定锚点月，变动时需即时刷新期初累计折旧的时点提示
  ['aOriginal', 'aSalvageRate', 'aLife', 'aAcq', 'aPeriodUsed'].forEach(function (id) {
    var el = $(id); if (el) el.addEventListener('input', _calcMonthDepr);
  });
  function _saveAsset() {
    // 取值校验必须用**原始字符串**，不能校验 _collectAsset 的产物：那里已用 U.num() 转成数字，
    // 空输入一律变成 0，于是 `=== ''` / `=== undefined` 永远为假 —— 原先三项"必填"因此形同虚设，
    // 「期初累计折旧」留空会被静默按 0 保存（对已提过折旧的老资产等于把累计清零）。
    var rawRate = $('aSalvageRate').value, rawLife = $('aLife').value;
    var rawPeriod = $('aPeriodUsed').value, rawBegin = $('aAccumDeprBegin').value;
    var fa = _collectAsset();
    // 必填校验
    if (!fa.code) return showToast('请填写资产编码', 'error');
    if (!fa.name) return showToast('请填写资产名称', 'error');
    if (!fa.faAcctId) return showToast('请选择固定资产科目', 'error');
    if (!fa.dept) return showToast('请选择使用部门', 'error');
    if (!fa.acqDate) return showToast('请选择开始使用日期', 'error');
    if (!fa.category) return showToast('请选择资产类别', 'error');   // 资产类别为必填
    if (!fa.original) return showToast('请填写原值', 'error');
    if (!fa.accDeprAcct) return showToast('请选择累计折旧科目', 'error');
    if (!fa.method) return showToast('请选择折旧方法', 'error');
    if (!fa.deprFeeAcct) return showToast('请选择折旧费用科目', 'error');
    if (!fa.cleanAcct) return showToast('请选择资产清理科目', 'error');
    if (!fa.purchaseAcct) return showToast('请选择资产购入对方科目', 'error');
    if (rawRate === '') return showToast('请填写残值率%', 'error');
    if (rawLife === '' || U.num(rawLife) <= 0) return showToast('请填写预计使用期数(月)', 'error');
    if (rawPeriod === '' || U.num(rawPeriod) < 0) return showToast('已折旧期间不能为空或负数', 'error');
    if (rawBegin === '' || U.num(rawBegin) < 0) return showToast('期初累计折旧不能为空或负数', 'error');
    // 范围校验（原先完全没有）：超限会写出"锚点落在未来 / 期数倒挂"的卡片，滚算结果不可用
    if (U.num(rawPeriod) > U.num(rawLife)) {
      return showToast('已折旧期间（' + U.num(rawPeriod) + '）不能大于预计使用期数（' + U.num(rawLife) + '）', 'error');
    }
    if (U.num(rawRate) < 0 || U.num(rawRate) > 100) return showToast('残值率应在 0 ~ 100 之间', 'error');
    if (fa.original < 0) return showToast('原值不能为负数', 'error');
    // 编码查重：同编码两张卡会让筛选、折旧汇总出现重复项（addFixedAsset 自身不做唯一性检查）
    var editId = $('assetModal').getAttribute('data-asset-id');
    var dup = S.state.fixedAssets.filter(function (x) {
      return String(x.code) === String(fa.code) && x.id !== editId;
    })[0];
    if (dup) return showToast('资产编码「' + fa.code + '」已被「' + (dup.name || '') + '」占用', 'error');
    if (editId) { S.updateFixedAsset(editId, fa); showToast('卡片已更新'); }
    else { S.addFixedAsset(fa); showToast('卡片已保存'); }
    /* 卡片清单按期间过滤购置日期后，新卡若开始使用日期晚于当前期间会立刻"看不见" ——
     * 容易被当成没保存成功，故合并成一条提示告知去向（比自动切换期间更简单，也不夺静态决策权）。 */
    var acqM = String(fa.acqDate || '').slice(0, 7);
    var curPeriod = _assetPeriod();
    if (acqM && acqM > curPeriod) {
      showToast('卡片已' + (editId ? '更新' : '保存') + '；其开始使用日期为 ' + acqM +
        '，在当前期间（' + curPeriod + '）的清单中不显示 —— 请切换到 ' + acqM + ' 或之后查看');
    }
    $('assetModal').classList.remove('show');
    renderAssets(); syncAll();
  }
  $('btnSaveAsset').addEventListener('click', _saveAsset);

  function refreshDas() {
    // 默认期间由 index.html 的 data-default 声明，periodRangeValue 单点兜底并同步触发器文本
    var month = periodRangeValue('dasPeriod');
    renderDas(month);
    // 汇总表 8 列（1 分组列 + 7 金额列），表名行的 colspan 必须跟着改，否则表头跨列错位。
    if (globalThis.setRptHead) globalThis.setRptHead('dasTitleRow', '折旧汇总表', 8, month);
  }
  function dasMonth() { var e = $('dasPeriodEnd'); return e ? e.value : currentPeriod(); }
  // 期间起始月：期初累计折旧按「起始月之前一月末」滚算（见 _accumDeprAt），取不到就退化为结束月
  function dasStartMonth() { var e = $('dasPeriodStart'); return (e && e.value) ? e.value : dasMonth(); }
  // 期间变更由期间控件的 data-on-change 直接回调（组件不再派发 change 事件），此处无需再绑监听。
  // btnDasPrint 已加 data-print，由全局委托统一走 tyPrint()。
  $('btnDasExport').addEventListener('click', function () {
    var month = dasMonth();
    var groups = _deprGroups(month, false, $('dasShowCleaned').checked, dasStartMonth());
    if (!groups.length) return showToast('当前期间无可导出数据', 'error');
    var headers = ['类别'].concat(DEPR_AMT_COLS.map(function (c) { return c.h; }));
    var data = groups.map(function (g) {
      return [g.key].concat(DEPR_AMT_COLS.map(function (c) { return deprSum(g.rows, c.k).toFixed(2); }));
    });
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([headers].concat(data)), '折旧汇总表');
    __safeExportExcel(wb, '折旧汇总表_' + month);
  });
  function _assetDeprRows(month, opts) {
    opts = opts || {};
    var y = month ? month.slice(0, 4) : currentPeriod().slice(0, 4);
    // 期初列 = 期间「起始月之前一个月末」的余额（期末 = 期初 + 期间内各月折旧）
    var prevOfStart = _addMonths(opts.startMonth || month, -1);
    var rows = S.state.fixedAssets.filter(function (fa) {
      if (!opts.showCleaned && fa.status === '清理') return false;
      /* 期间早于购置月 → 该资产尚未入账，本表不应出现（2026-09-18 补）。
       * 选前几个期间时看不到后期才购置的资产。
       * 实测（添钰来客）：「010 沙发折叠床」购置月 2026-06，但本表此前只过滤了「清理」状态，
       * 于是选 2026-03 时它照样占一行 —— 更糟的是它的原值、期末净值都被计入合计，
       * 使「原值」合计虚增 3,550.00（恰为该卡原值），与总账 1601 期末余额对不上。
       * 注意判据是 acqMonth > month 才排除：当月购置的卡**仍要显示**（资产已入账，
       * 只是按「次月起提」本月折旧为 0），不能连带排除掉。 */
      var acqM = fa.acqDate ? String(fa.acqDate).slice(0, 7) : '';
      if (acqM && acqM > month) return false;
      return true;
    }).map(function (fa) {
      var md = S.assetMonthlyDepr(fa);
      // 期初/期末累计折旧都按锚点月末滚算（唯一实现 _accumDeprAt），不再读卡片存值
      var accumBegin = _accumDeprAt(fa, prevOfStart, md);
      var accumEnd = _accumDeprAt(fa, month, md);
      /* 期间折旧 = 累计的滚增，**不**用 assetMonthlyDepr 直接求和（2026-09-18 修正）。
       * 原实现：yearDepr = md × 月份数；monthDepr 也在调用方按 md 求和 —— 都没有考虑
       * 「购置晚于本月 / 已提满 / 本月已计提 / 次月起提」这些情形，与计提凭证口径分叉。
       * 实测（添钰来客 2026-03~06）：报表本月折旧 10,866.63，而凭证与总账都是 10,810.42，
       * 差 56.21 恰是一张「购置晚于本月」的卡（010 沙发折叠床）；本年折旧额同理差 281.07。
       * 改用滚增后与总账 1602 只差逐张舍入的 0.01~0.03，彻底同源。
       * 注意不要改用 assetDeprDue()：它含 "deprMonth === month → 0" 的**计提幂等保护**，
       * 对已计提的历史期间会算出 0，而凭证里是有金额的。报表要的是账面滚增。 */
      var monthDepr = Math.max(0, accumEnd - accumBegin);
      var yearDepr = Math.max(0, accumEnd - _accumDeprAt(fa, _addMonths(y + '-01', -1), md));   // 年初前一个月末至今
      var netEnd = Math.max(0, num(fa.original) - accumEnd - num(fa.impairment));
      return {
        fa: fa,
        monthDepr: monthDepr,
        yearDepr: yearDepr,
        accumBegin: accumBegin,
        accumEnd: accumEnd,
        netEnd: netEnd,
        orig: num(fa.original),
        impair: num(fa.impairment),
        cat: fa.category || '', catName: _catName(fa.category), dept: fa.dept || '', code: fa.code || '', name: fa.name || ''
      };
    });
    return rows;
  }
  /* ---------- 折旧两表的共用列定义与聚合（汇总表 / 明细表 / 两处导出都从这里取） ----------
   * 汇总表一行一个类别/部门、只出合计；明细表逐资产、组末小计，二者分工清晰。
   * 两表共用同一组金额列，避免列顺序或口径在两处各写一遍后漂移。 */
  var DEPR_AMT_COLS = [
    { h: '原值', k: 'orig' },
    { h: '期初累计折旧', k: 'ab' },
    { h: '本月折旧', k: 'md' },
    { h: '本年折旧额', k: 'yd' },
    { h: '期末累计折旧', k: 'ae' },
    { h: '期末减值准备', k: 'im' },
    { h: '期末净值', k: 'ne' }
  ];
  // 列键 → _assetDeprRows 返回对象上的真实字段名（唯一映射点）。
  // 注意字段名不同名：ab→accumBegin、md→monthDepr、ae→accumEnd、im→impair、ne→netEnd。
  var DEPR_FIELD = { orig: 'orig', ab: 'accumBegin', md: 'monthDepr', yd: 'yearDepr', ae: 'accumEnd', im: 'impair', ne: 'netEnd' };
  function deprVal(row, key) { return num(row[DEPR_FIELD[key]]); }
  function deprSum(rows, key) {
    return rows.reduce(function (s, r) { return s + deprVal(r, key); }, 0);
  }
  // 按类别（或部门）分组并保持插入顺序 → [{ key, rows }]。
  function _deprGroups(month, byDept, showCleaned, startMonth) {
    var groups = {}, order = [];
    _assetDeprRows(month, { showCleaned: showCleaned, startMonth: startMonth }).forEach(function (r) {
      var k = byDept ? (r.dept || '未指定部门') : (r.catName || '未分类');
      if (!groups[k]) { groups[k] = []; order.push(k); }
      groups[k].push(r);
    });
    return order.map(function (k) { return { key: k, rows: groups[k] }; });
  }
  function renderDas(month) {
    var showCleaned = $('dasShowCleaned').checked;
    if ($('dasMonthTh')) $('dasMonthTh').textContent = (month || currentPeriod()) + '折旧';
    var groups = _deprGroups(month, false, showCleaned, dasStartMonth());
    var tb = $('dasBody'); tb.innerHTML = '';
    var all = [];
    groups.forEach(function (g) {
      var tr = document.createElement('tr');
      tr.innerHTML = '<td>' + esc(g.key) + '</td>' + DEPR_AMT_COLS.map(function (c) {
        return '<td class="ta-r mono">' + money(deprSum(g.rows, c.k)) + '</td>';
      }).join('');
      tb.appendChild(tr);
      all = all.concat(g.rows);
    });
    var foot = $('dasFoot'); foot.innerHTML = '';
    var trf = document.createElement('tr');
    trf.innerHTML = '<td>合计</td>' + DEPR_AMT_COLS.map(function (c) {
      return '<td class="ta-r mono">' + money(deprSum(all, c.k)) + '</td>';
    }).join('');
    foot.appendChild(trf);
  }
  function refreshDad() {
    // 默认期间由 index.html 的 data-default 声明，periodRangeValue 单点兜底并同步触发器文本
    var month = periodRangeValue('dadPeriod');
    renderDad(month);
    if (globalThis.setRptHead) globalThis.setRptHead('dadTitleRow', '折旧明细表', 11, month);
  }
  function dadMonth() { var e = $('dadPeriodEnd'); return e ? e.value : currentPeriod(); }
  function dadStartMonth() { var e = $('dadPeriodStart'); return (e && e.value) ? e.value : dadMonth(); }
  // 期间变更由期间控件的 data-on-change 直接回调（组件不再派发 change 事件），此处无需再绑监听。
  // btnDadPrint 已加 data-print，由全局委托统一走 tyPrint()。
  $('btnDadExport').addEventListener('click', function () {
    var month = dadMonth();
    var rows = _assetDeprRows(month, { showCleaned: $('dadShowCleaned').checked, startMonth: dadStartMonth() });
    if (!rows.length) return showToast('当前期间无可导出数据', 'error');
    var headers = ['类别', '编码', '名称', '部门'].concat(DEPR_AMT_COLS.map(function (c) { return c.h; }));
    var data = rows.map(function (r) {
      return [r.catName, r.code, r.name, r.dept].concat(DEPR_AMT_COLS.map(function (c) { return deprVal(r, c.k).toFixed(2); }));
    });
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([headers].concat(data)), '折旧明细表');
    __safeExportExcel(wb, '折旧明细表_' + month);
  });
  function renderDad(month) {
    var showCleaned = $('dadShowCleaned').checked;
    if ($('dadMonthTh')) $('dadMonthTh').textContent = (month || currentPeriod()) + '折旧';
    // 明细表口径：按类别分组 → 组内逐资产明细行 + 组末「小计」→ 表末「合计」。
    // 与「折旧汇总表」的分工由此确立：汇总表一行一类别、只出合计，明细表到每一张资产卡片。
    var groups = _deprGroups(month, false, showCleaned, dadStartMonth());
    var tb = $('dadBody'); tb.innerHTML = '';
    var all = [];
    groups.forEach(function (g) {
      g.rows.forEach(function (r) {
        var tr = document.createElement('tr');
        // 逐资产明细行：4 个文本列 + 共用金额列。
        // （原实现这 4 列未转义，资产名称/部门里出现 < & " 会破坏单元格结构，现与汇总表一致走 esc）
        tr.innerHTML = '<td>' + esc(r.catName) + '</td>'
          + '<td class="mono">' + esc(r.code) + '</td>'
          + '<td>' + esc(r.name) + '</td>'
          + '<td>' + esc(r.dept) + '</td>'
          + DEPR_AMT_COLS.map(function (c) {
            return '<td class="ta-r mono">' + money(deprVal(r, c.k)) + '</td>';
          }).join('');
        tb.appendChild(tr);
      });
      all = all.concat(g.rows);
      // 组末小计。金额一律走 deprSum(g.rows, k)：原实现用 Object.keys(tot) 直接取 r[key]，
      // 而 r 上的字段名是 monthDepr/accumBegin/accumEnd/impair/netEnd，
      // 7 个键里 6 个取不到值（0 + undefined = NaN），合计行只有「原值」列是对的。
      var lab = document.createElement('tr');
      lab.className = 'subtotal-row';
      lab.innerHTML = '<td></td><td></td><td>' + esc(g.key) + ' 小计</td><td></td>'
        + DEPR_AMT_COLS.map(function (c) {
          return '<td class="ta-r mono">' + money(deprSum(g.rows, c.k)) + '</td>';
        }).join('');
      tb.appendChild(lab);
    });
    var foot = $('dadFoot'); foot.innerHTML = '';
    var trf = document.createElement('tr');
    trf.innerHTML = '<td colspan="4">合计</td>'
      + DEPR_AMT_COLS.map(function (c) {
        return '<td class="ta-r mono">' + money(deprSum(all, c.k)) + '</td>';
      }).join('');
    foot.appendChild(trf);
  }

  /* 资产类别：默认档案（6 类）与「编码 ↔ 名称」归一的唯一事实源在 store —— 前端只引用。
     原先这份预置写在本函数里（懒创建），而「category 存编码」的契约在 store —— 两处分离导致
     导入把类别**名称**写进了 category（筛选筛不到、编辑会丢类别）。现已收敛到 store。 */
  function assetCats() { return S.assetCats(); }
  function renderAssetCategory() {
    var tb = $('catBody'); tb.innerHTML = '';
    assetCats().forEach(function (c, i) {
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td class="col-check"><input type="checkbox" class="catChk" data-i="' + i + '"></td>' +
        '<td><a class="link-edit" data-cat="' + i + '">编辑</a> <a class="link-toggle" data-catdel="' + i + '">' + (c.enabled === false ? '启用' : '停用') + '</a></td>' +
        '<td class="mono">' + c.code + '</td>' +
        '<td>' + c.name + (c.enabled === false ? ' <span class="tag-disabled">停用</span>' : '') + '</td>' +
        '<td>' + c.method + '</td>' +
        '<td class="ta-r">' + c.life + ' 年</td>' +
        '<td class="ta-r">' + c.salvage + '%</td>' +
        '<td class="mono">' + c.asset + '</td>' +
        '<td class="mono">' + c.depr + '</td>' +
        '<td>' + c.memo + '</td>';
      tb.appendChild(tr);
    });
  }
  function refreshAssetCategory() { renderAssetCategory(); }
  $('btnResetCat').addEventListener('click', async function () {
    if (!(await H.confirmAsync('恢复默认资产类别将覆盖当前已自定义的类别与折旧参数，确认继续？', { title: '恢复默认类别' }))) return;
    S.state.assetCats = null; renderAssetCategory(); showToast('已恢复默认类别');
  });
  $('btnNewCat').addEventListener('click', function () { _openCatModal(-1); });
  $('btnDelCat').addEventListener('click', async function () {
    var checked = [].slice.call(document.querySelectorAll('.catChk:checked')).map(function (c) { return num(c.getAttribute('data-i')); });
    if (!checked.length) return showToast('请先勾选要停用的类别', 'error');
    if (!(await H.confirmAsync('确认停用选中的 ' + checked.length + ' 个资产类别？\n停用后新增资产不能再选该类，历史资产类别保留。', { title: '停用资产类别' }))) return;
    var list = assetCats();
    checked.forEach(function (i) { if (list[i]) list[i].enabled = false; });
    S.state.assetCats = list; renderAssetCategory(); showToast('已停用'); syncAll();
  });
  $('catBody').addEventListener('click', async function (e) {
    if (e.target.classList.contains('link-toggle')) {
      var i = num(e.target.getAttribute('data-catdel'));
      var cat = assetCats()[i];
      var disabling = !(cat && cat.enabled === false);
      if (disabling) {
        if (!(await H.confirmAsync('确认停用资产类别「' + (cat ? cat.name : '') + '」？', { title: '停用资产类别' }))) return;
      }
      cat.enabled = disabling ? false : true;
      renderAssetCategory(); showToast(disabling ? '已停用' : '已启用'); syncAll();
    } else if (e.target.classList.contains('link-edit')) {
      _openCatModal(num(e.target.getAttribute('data-cat')));
    }
  });
  function _openCatModal(idx) {
    var c = idx >= 0 ? assetCats()[idx] : null;
    $('catModal').setAttribute('data-idx', idx);
    $('catCode').value = c ? c.code : '';
    $('catName').value = c ? c.name : '';
    $('catMethod').value = c ? c.method : '平均年限法';
    $('catLife').value = c ? c.life : 5;
    $('catSalvage').value = c ? c.salvage : 5;
    $('catAsset').value = c ? c.asset : '1601';
    $('catDepr').value = c ? c.depr : '1602';
    $('catMemo').value = c ? c.memo : '';
    $('catModal').classList.add('show');
  }
  $('btnCloseCat').addEventListener('click', function () { $('catModal').classList.remove('show'); });
  $('btnSaveCat').addEventListener('click', function () {
    var idx = num($('catModal').getAttribute('data-idx'));
    var c = {
      code: $('catCode').value, name: $('catName').value, method: $('catMethod').value,
      life: U.num($('catLife').value), salvage: U.num($('catSalvage').value),
      asset: $('catAsset').value, depr: $('catDepr').value, memo: $('catMemo').value,
      enabled: (idx >= 0 ? (assetCats()[idx] && assetCats()[idx].enabled !== false) : true)
    };
    if (!c.code || !c.name) return showToast('请填写类别编码与名称', 'error');
    var list = assetCats();
    if (idx >= 0) list[idx] = c; else list.push(c);
    S.state.assetCats = list;
    $('catModal').classList.remove('show');
    renderAssetCategory(); syncAll(); showToast('类别已保存');
  });

  /* 折旧生成状态提示：合并自原独立「折旧凭证」页的顶部提示。
   * 只保留核心价值 —— 提前告知用户本期是否已计提折旧，避免重复点击。
   * 其余功能（表格、导出、批量删卡片、参数设置）全部并入卡片页或删除。
   * 参数设置面板为死功能（store.depreciateMonth 不读 S.state.deprVchSetting），直接移除。 */
  function _deprVchOf(month) {
    if (!S.periodVouchersOfKind) return [];
    return S.periodVouchersOfKind(month, S.VOUCHER_KINDS.DEPR);
  }
  function updateAssetDeprTip() {
    var tip = $('assetDeprTip');
    if (!tip) return;
    var month = _assetPeriod();
    var dup = _deprVchOf(month);
    if (dup.length) {
      var nos = dup.map(function (v) { return (v.word || '记') + '-' + v.no; }).join('、');
      tip.className = 'k-tip warn';
      tip.textContent = month + ' 期已生成折旧凭证（' + nos + '），重复计提会被系统拒绝。';
      tip.hidden = false;
    } else {
      // 未生成时也显示引导 —— 新用户可能不知道「计提折旧」按钮是生成折旧凭证的入口
      tip.className = 'k-tip info';
      tip.textContent = month + ' 期尚未计提折旧，点击上方「计提折旧」按钮可一次性生成本期折旧凭证。';
      tip.hidden = false;
    }
  }

  /* 全账套变动历史：遍历所有卡片的 fa.history，按时间倒序合并成一条时间线 */
  function showAllFaHistory() {
    var all = [];
    S.state.fixedAssets.forEach(function (fa) {
      (fa.history || []).forEach(function (h) {
        all.push({ fa: fa, h: h });
      });
    });
    // 按时间倒序（history.unshift 已经是倒序，但多张卡合并后要重新排）
    all.sort(function (a, b) { return (b.h.time || '').localeCompare(a.h.time || ''); });
    var body = $('assetHistoryBody');
    var title = $('assetHistoryTitle');
    if (!body) return;
    title.textContent = '全部固定资产变动记录（' + all.length + ' 条）';
    if (!all.length) {
      body.innerHTML = '<div class="empty-hint">暂无变动记录<br><br>卡片的新增、编辑、清理操作都会自动记录在这里</div>';
    } else {
      var labels = S._assetHistoryLabels();
      var html = '';
      all.forEach(function (entry) {
        var fa = entry.fa, h = entry.h;
        html += '<div class="history-item">';
        html += '<div class="history-head">';
        html += '<span class="history-op">' + h.op + '</span>';
        html += '<span class="history-fa">' + (fa.name || '') + '</span>';
        if (fa.code) html += '<span class="history-code mono">' + fa.code + '</span>';
        html += '<span class="history-time">' + h.time + '</span>';
        html += '</div>';
        var keys = Object.keys(h.fields || {});
        if (!keys.length) {
          html += '<div class="history-detail">—</div>';
        } else {
          html += '<table class="history-table">';
          keys.forEach(function (k) {
            var label = labels[k] || k;
            var val = h.fields[k];
            if (Array.isArray(val)) {
              html += '<tr><td class="h-label">' + label + '</td>';
              html += '<td class="h-before">' + val[0] + '</td>';
              html += '<td class="h-arrow">→</td>';
              html += '<td class="h-after">' + val[1] + '</td></tr>';
            } else {
              html += '<tr><td class="h-label">' + label + '</td><td colspan="3">' + val + '</td></tr>';
            }
          });
          html += '</table>';
        }
        html += '</div>';
      });
      body.innerHTML = html;
    }
    $('assetHistoryModal').classList.add('show');
  }

  /* 固定资产卡片页工具条「资产类别」弹窗入口 */
  (function () {
    var opener = $('btnAssetCatMgr');
    if (opener) opener.addEventListener('click', function () {
      renderAssetCategory();
      var m = $('assetCatListModal');
      if (m) m.classList.add('show');
    });
    var closer = $('btnCloseAssetCatList');
    if (closer) closer.addEventListener('click', function () {
      var m = $('assetCatListModal');
      if (m) m.classList.remove('show');
    });
  })();
  /* 卡片页工具条「部门」弹窗入口：**复用工资页那个「部门职员」弹窗**（部门基础资料全库只有一份，
     资产卡片要用部门却得跑去工资页改，路径太绕）。渲染走 main.js 已挂的 __renderDeptStaff；
     关闭按钮、行内「编辑 / 启用停用」的绑定都在 Salary.js，此处只负责打开，不重复绑。 */
  (function () {
    var opener = $('btnAssetDeptMgr');
    if (!opener) return;
    opener.addEventListener('click', function () {
      if (globalThis.__renderDeptStaff) globalThis.__renderDeptStaff();
      var m = $('deptStaffModal');
      if (m) m.classList.add('show');
    });
  })();

export {
  refreshAssets, refreshDas, refreshDad, refreshAssetCategory
};

