// 页面模块（B 方案解耦，由 tools/migrate_domain.py 生成骨架）
// 依赖全部从全局桥接对象取，逻辑与 app.js 原实现逐字一致（只挪窝不改写）。
// 设计：globalThis.__TY_HELPERS__（app.js 注册）、globalThis.__TY_EXPORT__（store.js 注册）。
// 模块不 import store.js（避免 IIFE 双执行），统一从全局取已加载单例。

import { $, money, esc, showToast, fmtDate, currentPeriod, S, U, num,
  ACCOUNT_CLASSES, exportTable } from './_shared.js';
// 导入账套的分流判据（纯函数，另见 js/common/import-classify.js 的说明）
import { importPlanOf, importErrText, safeIdOf } from '../../common/import-classify.js?v=dev';
const H = globalThis.__TY_HELPERS__ || {};

// refreshAll 是 app.js IIFE 的局部刷新函数，经桥接层暴露；本模块必须先绑定才能调用
// （否则裸调用抛 ReferenceError，导致「导入成功但读取账套失败」）
const refreshAll = (globalThis.__TY_HELPERS__ || {}).refreshAll;

  /* ============================================================
   * 设置：凭证字 / 现金流量科目
   * ============================================================ */
  function refreshVoucherWord() {
    var tb = $('vwBody'); tb.innerHTML = '';
    var curDef = (S.state.param && S.state.param.voucherWord) || '';
    // 预计算每个凭证字被引用次数（已删除凭证不计入）
    var refCount = {};
    (S.state.vouchers || []).forEach(function (v) {
      if (v.deleted === 'y') return;
      var w = v.word || '记';
      refCount[w] = (refCount[w] || 0) + 1;
    });
    (S.state.voucherWords || []).forEach(function (w, i) {
      var tr = document.createElement('tr');
      var isDef = (w.name === curDef);
      var refs = refCount[w.name] || 0;
      tr.innerHTML =
        '<td class="' + (isDef ? 'vw-default' : '') + '">' + w.name + (isDef ? ' <span class="ok-tag">默认</span>' : '') + '</td>' +
        '<td>' + w.title + '</td>' +
        '<td class="col-op">' +
          (isDef
            ? '<a class="link-del disabled">—</a>'
            : '<a class="link-make-def" data-i="' + i + '">设为默认</a>') +
          (isDef
            ? ''
            : '<a class="link-toggle" data-i="' + i + '">' + (w.enabled === false ? '启用' : '停用') + '</a>') +
          (isDef || refs > 0
            ? ''
            : '<a class="link-del link-vw-del" data-i="' + i + '">删除</a>') +
        '</td>';
      tb.appendChild(tr);
    });
    tb.querySelectorAll('.link-make-def').forEach(function (a) {
      a.addEventListener('click', function () {
        var i = +this.getAttribute('data-i');
        var row = S.state.voucherWords[i];
        if (!row || row.enabled === false) return showToast('默认凭证字必须启用', 'warn');
        S.state.param = S.state.param || {};
        S.state.param.voucherWord = row.name;
        S.persist(); refreshVoucherWord(); showToast('已将「' + row.name + '」设为默认凭证字');
      });
    });
    tb.querySelectorAll('.link-toggle').forEach(function (a) {
      a.addEventListener('click', async function () {
        var i = +this.getAttribute('data-i');
        var row = S.state.voucherWords[i];
        if (!row) return;
        if (row.name === curDef) { showToast('默认凭证字不可停用，请先将其他凭证字设为默认'); return; }
        var disabling = !(row.enabled === false);
        if (disabling) {
          if (!(await H.confirmAsync('确认停用凭证字「' + (row.title || row.name) + '」？\n停用后新增凭证不能再选该凭证字，历史凭证保留。', { title: '停用凭证字' }))) return;
        }
        row.enabled = disabling ? false : true;
        S.persist(); refreshVoucherWord();
      });
    });
    tb.querySelectorAll('.link-vw-del').forEach(function (a) {
      a.addEventListener('click', async function () {
        var i = +this.getAttribute('data-i');
        var row = S.state.voucherWords[i];
        if (!row) return;
        // 二次确认
        if (!(await H.confirmAsync('确认删除凭证字「' + row.name + '」？\n未被任何凭证使用，可安全删除。', { title: '删除凭证字' }))) return;
        S.state.voucherWords.splice(i, 1);
        // 删的是默认字 → 回退到第一个启用项
        if (row.name === curDef) {
          var firstEn = S.state.voucherWords.find(function (x) { return x.enabled !== false; });
          S.state.param.voucherWord = firstEn ? firstEn.name : (S.state.voucherWords[0] ? S.state.voucherWords[0].name : '记');
        }
        S.persist(); refreshVoucherWord(); showToast('已删除凭证字「' + row.name + '」');
      });
    });
  }
  $('btnAddWord').addEventListener('click', async function () {
    var name = await H.promptAsync('凭证字（如 记 / 转 / 收）：', '', { title: '新增凭证字' });
    if (!name) return;
    var title = (await H.promptAsync('打印标题（如 记账凭证）：', name + '账凭证', { title: '打印标题' })) || name;
    if (!S.state.voucherWords) S.state.voucherWords = [];
    S.state.voucherWords.push({ name: name.trim(), title: title.trim(), enabled: true });
    S.persist(); refreshVoucherWord(); showToast('已新增凭证字');
  });

  // 注：原币别管理（refreshCurrency/addCurrency）已随外币核算功能整体下线
  // 注：原辅助核算档案管理（refreshAuxSetting 等）已随 store.js 底层函数一并下线

  /* ============================================================
   * 设置：现金流量初始余额（对照：现金流量初始余额页）
   * 结构：工具条 刷新/保存/试算平衡/导出；AG Grid 4列=项目/行次/本年累计/占位
   * 仅「本年累计」(balance) 一列可录入；分类标题行加粗、不可录入；其余列为动态计算（不在此录入）。
   * ============================================================ */
  function refreshCashflowInit() {
    var tb = $('cfOpenBody'); tb.innerHTML = '';
    var opening = S.getCashFlowOpening();
    S.state.cashFlowItems.forEach(function (it) {
      var isTitle = !it.rowNum;            // 分类标题行（行次为空）
      var o = opening[it.id] || { ytd: 0 };
      var tr = document.createElement('tr');
      if (isTitle) tr.className = 'cf-title-row';
      var ytdCell = isTitle
        ? '<td class="num"></td>'
        : '<td class="num"><input class="cf-ytd input-sm" data-id="' + it.id + '" value="' + U.yuan(o.ytd || 0) + '"></td>';   // 回填「元」输入框：store 内部为定点整数
      tr.innerHTML =
        '<td>' + it.name + '</td>' +
        '<td class="mono center">' + (it.rowNum || '') + '</td>' +
        ytdCell +
        '<td></td>';
      tb.appendChild(tr);
    });
    tb.querySelectorAll('.cf-ytd').forEach(function (inp) {
      inp.addEventListener('change', function () {
        var id = this.getAttribute('data-id');
        S.setCashFlowOpening(id, this.value);
      });
    });
  }

  // 「试算平衡」：校验现金流量初始余额与现金科目期初余额勾稽——
  // 现金流量表各项目的期初数（即「现金流量初始余额」页录入值，带符号：流入正/流出负）之和，
  // 必须等于现金及现金等价物科目（1001/1002/1012）的期初余额（obDr-obCr）。
  // 这才是真实的期初勾稽（原口径把净增加额与累计混比，是错误勾稽）。
  function checkCashflowBalance() {
    var opening = S.getCashFlowOpening();
    // 现金科目期初余额：从 generalLedger 取启用月三行 obDr-obCr（父行已含子目上卷）。
    // 原实现读 S.subject(c).obDr——科目档案对象不存余额字段、恒为 0，使「试算平衡」拿 0 与录入合计比较、形同虚设；此处改从 generalLedger 取启用月三行。
    var startM = (S.state.company && S.state.company.startMonth) || (S.allMonths()[0] || '');
    var cashOb = 0;
    if (startM) {
      ['1001', '1002', '1012'].forEach(function (c) {
        var gr = S.generalLedger(startM).filter(function (g) { return g.code === c; })[0];
        if (gr) cashOb += num(gr.obDr) - num(gr.obCr);
      });
    }
    // 初始余额各明细项目（带符号：流入正、流出负）之和，应与现金科目期初一致
    var total = 0;
    S.state.cashFlowItems.forEach(function (it) {
      if (!it.rowNum) return; // 标题行不计入
      total += num((opening[it.id] || {}).ytd) || 0;
    });
    // 容差 1 分：total / cashOb 都是定点整数，原式 `> 0.01` 在整数域里 ≈0（塌成严格相等，亚元差异即报错）。
    if (Math.abs(total - cashOb) > U.AMT_SCALE / 100) {
      showToast('试算不平衡：现金流量初始余额各项目之和(' + U.yuan(total).toFixed(2) + ') 与现金科目期初余额(' + U.yuan(cashOb).toFixed(2) + ') 不符', 'error');
      return false;
    }
    showToast('试算平衡通过：现金流量初始余额与现金科目期初一致');
    return true;
  }

  // 工具条：刷新/保存/试算平衡/导出（对照：现金流量初始余额页工具条）
  $('btnCfOpenSave').addEventListener('click', function () {
    // 明细录入已 change 即存，保存按钮做一次全量落盘 + 提示
    S.persist();
    showToast('已保存现金流量初始余额');
  });
  $('btnCfOpenCheck').addEventListener('click', checkCashflowBalance);
  $('btnCfOpenExport').addEventListener('click', function () {
    var rows = S.state.cashFlowItems.map(function (it) {
      var o = S.getCashFlowOpening()[it.id] || { ytd: 0 };
      return { 项目: it.name, 行次: it.rowNum || '', 期初余额: U.yuan(o.ytd || 0) };   // 导出换回元
    });
    exportTable(rows, '现金流量初始余额');
  });

  /* ============================================================
   * 设置：科目现金流量项目
   * ============================================================ */
  function refreshCashflowProject() {
    var tb = $('cfMapBody'); tb.innerHTML = '';
    var map = S.getSubjectCashFlowMap();
    var subjects = S.subjects().slice().filter(function (s) { return s.parent ? true : (['1001','1002','1012'].indexOf(s.code) >= 0 || s.cls === 'asset' || s.cls === 'liability'); });
    // 仅现金及现金等价物科目与往来/资产负债科目参与映射（现金类默认映射「现金及现金等价物」）
    S.subjects().forEach(function (s) {
      var isCash = ['1001','1002','1012'].indexOf(s.code) >= 0;
      var m = map[s.code] || { credit: isCash ? 'cf_cash' : '', debit: '' };
      var opts = '<option value="">（未指定）</option>' + S.state.cashFlowItems.map(function (it) {
        return '<option value="' + it.id + '"' + (m.credit === it.id ? ' selected' : '') + '>' + it.name + '</option>';
      }).join('');
      var opts2 = '<option value="">（未指定）</option>' + S.state.cashFlowItems.map(function (it) {
        return '<option value="' + it.id + '"' + (m.debit === it.id ? ' selected' : '') + '>' + it.name + '</option>';
      }).join('');
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td class="mono">' + s.code + '</td>' +
        '<td>' + s.name + '</td>' +
        '<td>' + ((globalThis.__TY_CLS_NAME__ || {})[s.cls] || s.cls) + '</td>' +
        '<td>' + S.dirName(s.normal) + '</td>' +
        '<td><select class="cf-credit select-sm" data-code="' + s.code + '">' + opts + '</select></td>' +
        '<td><select class="cf-debit select-sm" data-code="' + s.code + '">' + opts2 + '</select></td>';
      tb.appendChild(tr);
    });
    tb.querySelectorAll('.cf-credit, .cf-debit').forEach(function (sel) {
      sel.addEventListener('change', function () {
        var code = this.getAttribute('data-code');
        var credit = tb.querySelector('.cf-credit[data-code="' + code + '"]').value;
        var debit = tb.querySelector('.cf-debit[data-code="' + code + '"]').value;
        S.setSubjectCashFlow(code, credit, debit);
        showToast('已保存映射');
      });
    });
  }

  /* ============================================================
   * 设置：备份与恢复
   * ============================================================ */
  function refreshBackup() {
    // 账套管理列表刷新（操作日志已独立成页，进入 operation-logs 页时单独刷新）
    if (globalThis.__renderTools) globalThis.__renderTools();
  }

  /* ============================================================
   * 设置：操作日志（「设置-操作日志」：过滤 + 分页 + 导出）
   * ============================================================ */
  // 结构化操作类型中文标签（addLog meta.action_type → 用户可读）
  var ACTION_TYPE_LABELS = {
    create: '新增',
    update: '修改',
    'delete': '删除',
    restore: '还原',
    purge: '清除',
    reopen: '反结账'
  };
  // 凭证审计摘要格式化（用于日志页「查看明细」展开区）
  function _auditFmt(v) {
    if (!v) return '(无)';
    var lines = [];
    lines.push('凭证 ' + (v.word || '') + '-' + (v.no != null ? v.no : '') + ' · ' + (v.date || '') + ' · ' + (v.summary || ''));
    // 兼容两套来源：ty 新录写 maker，金蝶导入写 preparer（否则导入凭证在此处无制单人）
    var mk = (S && S.voucherMaker) ? S.voucherMaker(v) : (v.maker || v.preparer || '');
    if (mk) lines.push('制单：' + mk);
    (v.entries || []).forEach(function (e) {
      var amt = e.dr ? '借 ' + U.yuan(num(e.dr)).toFixed(2) : (e.cr ? '贷 ' + U.yuan(num(e.cr)).toFixed(2) : '0.00');
      lines.push('  ' + (e.code || '') + ' ' + ((S.subjectName && S.subjectName(e.code)) || e.name || '') + ' ' + amt);
    });
    return lines.join('\n');
  }
  var logPageState = { page: 1, size: 50, filtered: [] };
  var logInitDone = false;

  function logFilter() {
    var user = ($('logUser').value || '').trim();
    var type = $('logType').value || '';
    var all = S.getLogs();
    return all.filter(function (l) {
      if (user && (l.user || '') !== user) return false;
      if (type && (l.module || '') !== type) return false;
      return true;
    });
  }

  function refreshLogs() {
    var tb = $('logBody'); tb.innerHTML = '';
    // 首次进入：操作人下拉从日志数据去重生成一次
    if (!logInitDone) {
      var users = {};
      (S.getLogs() || []).forEach(function (l) { users[l.user || '财务'] = 1; });
      var optUser = Object.keys(users).sort();
      $('logUser').innerHTML = '<option value="">全部</option>' + optUser.map(function (u) {
        return '<option value="' + esc(u) + '">' + esc(u) + '</option>';
      }).join('');
      logInitDone = true;
    }
    var filtered = logFilter();
    logPageState.filtered = filtered;
    var size = parseInt($('logPageSize').value, 10) || 50;
    logPageState.size = size;
    var total = filtered.length;
    var pages = Math.max(1, Math.ceil(total / size));
    if (logPageState.page > pages) logPageState.page = pages;
    var startIdx = (logPageState.page - 1) * size;
    var slice = filtered.slice(startIdx, startIdx + size);
    if (!slice.length) {
      tb.innerHTML = '<tr><td colspan="5" class="empty-hint">暂无操作记录</td></tr>';
    } else {
      slice.forEach(function (l, idx) {
        var tr = document.createElement('tr');
        // 反结账行加红标醒目（审计高危标识）
        if (l.action === '反结账') tr.className = 'log-row-reopen';
        var detailHtml = l.detail || '';
        // 反结账：追加 reason 红字显示
        if (l.action === '反结账' && l.reason) {
          detailHtml += '<div class="log-reason">原因：' + esc(l.reason) + '</div>';
        }
        // 凭证增删改：有 before/after 时加可展开的审计详情
        if (l.module === '凭证' && (l.before || l.after)) {
          var bid = 'logAudit_' + startIdx + '_' + idx;
          detailHtml += ' <a class="link-toggle log-audit-toggle" data-target="' + bid + '">查看明细</a>' +
            '<div id="' + bid + '" class="log-audit-detail" style="display:none">';
          if (l.before) detailHtml += '<div class="la-section"><span class="la-tag la-before">改前</span><pre class="la-pre">' + esc(_auditFmt(l.before)) + '</pre></div>';
          if (l.after) detailHtml += '<div class="la-section"><span class="la-tag la-after">改后</span><pre class="la-pre">' + esc(_auditFmt(l.after)) + '</pre></div>';
          detailHtml += '</div>';
        }
        // 结构化标签：有 action_type 时附加小标签（新增/修改/删除/还原/清除/反结账）
        var actTag = '';
        if (l.action_type && ACTION_TYPE_LABELS[l.action_type]) {
          var tagCls = 'act-tag-' + l.action_type;
          actTag = ' <span class="act-tag ' + tagCls + '">' + esc(ACTION_TYPE_LABELS[l.action_type]) + '</span>';
        }
        tr.innerHTML = '<td class="mono">' + esc(l.time || '') + '</td><td>' + esc(l.user || '') + '</td><td>' +
          (l.action || '') + actTag + '</td><td>' + (l.module || '设置') + '</td><td>' + detailHtml + '</td>';
        tb.appendChild(tr);
      });
      // 绑定凭证审计明细展开/收起
      tb.querySelectorAll('.log-audit-toggle').forEach(function (a) {
        a.addEventListener('click', function () {
          var t = document.getElementById(this.getAttribute('data-target'));
          if (!t) return;
          var open = t.style.display !== 'none';
          t.style.display = open ? 'none' : 'block';
          this.textContent = open ? '查看明细' : '收起明细';
        });
      });
    }
    $('logCount').textContent = '共 ' + total + ' 条';
    $('logPage').textContent = logPageState.page + ' / ' + pages;
    $('logPrev').disabled = logPageState.page <= 1;
    $('logNext').disabled = logPageState.page >= pages;
  }

  $('btnLogQuery').addEventListener('click', function () { logPageState.page = 1; refreshLogs(); });
  $('btnLogReset').addEventListener('click', function () {
    $('logUser').value = ''; $('logType').value = '';
    logPageState.page = 1; refreshLogs();
  });
  $('logPrev').addEventListener('click', function () { if (logPageState.page > 1) { logPageState.page--; refreshLogs(); } });
  $('logNext').addEventListener('click', function () {
    var pages = Math.max(1, Math.ceil(logPageState.filtered.length / logPageState.size));
    if (logPageState.page < pages) { logPageState.page++; refreshLogs(); }
  });
  $('logPageSize').addEventListener('change', function () { logPageState.page = 1; refreshLogs(); });

  /* ============================================================
   * 账套与系统事件（全局变更日志 changelog.json）
   * 与上方「操作日志」互补：操作日志=本账套内业务操作（随账套文件走，含审计明细）；
   * 本区=跨账套生命周期事件（删除/还原/清空账套等），删除的账套其业务日志已随文件进回收站，
   * 只能在这里看到"什么时候删的谁"。数据源 Storage.listChangeLog（Rust list_changelog）。
   * ============================================================ */
  function refreshSysEvents() {
    var tb = $('sysEventsBody');
    if (!tb) return; // HTML 未含新卡片（旧 dist），静默跳过不干扰
    tb.innerHTML = '<tr><td colspan="5" class="empty-hint">正在读取…</td></tr>';
    // 账套级动作集合：凡命中即展示（含历史无 module 字段的老条目兼容）
    var SYS_ACTIONS = { '新建账套': 1, '删除账套': 1, '导入账套': 1, '恢复备份': 1, '还原账套': 1, '清空回收站': 1 };
    function isSysEvent(l) {
      if (!l) return false;
      if (l.module === '账套') return true;          // 结构化 module 直接命中
      return !!SYS_ACTIONS[l.action];                 // 老条目无 module，按动作名兜底
    }
    var src = (typeof window.Storage !== 'undefined' && window.Storage.listChangeLog)
      ? window.Storage.listChangeLog() : Promise.resolve([]);
    src.then(function (list) {
      list = (list || []).filter(isSysEvent);
      // 按 ts 倒序（最新在前）
      list.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
      var cnt = $('sysEventsCount'); if (cnt) cnt.textContent = '共 ' + list.length + ' 条';
      tb.innerHTML = '';
      if (!list.length) {
        tb.innerHTML = '<tr><td colspan="5" class="empty-hint">暂无账套级事件（新建/删除/导入/还原账套等操作会出现在这里）</td></tr>';
        return;
      }
      list.slice(0, 200).forEach(function (l) {
        var tr = document.createElement('tr');
        var t = (l.time || '').replace('T', ' ').replace(/\.\d+Z$/, '').replace('Z', '');
        tr.innerHTML = '<td class="mono">' + esc(t || '') + '</td><td>' + esc(l.user || '—') + '</td>' +
          '<td>' + esc(l.action || '') + '</td><td>' + esc(l.module || '账套') + '</td>' +
          '<td>' + esc(l.detail || '') + '</td>';
        tb.appendChild(tr);
      });
    }).catch(function () {
      tb.innerHTML = '<tr><td colspan="5" class="empty-hint">读取系统事件失败（当前为浏览器调试模式或引擎未加载）</td></tr>';
    });
  }
  var btnSysEvents = $('btnSysEventsRefresh');
  if (btnSysEvents && !btnSysEvents._bound) { btnSysEvents._bound = true; btnSysEvents.addEventListener('click', refreshSysEvents); }

  /* ============================================================
   * 设置：账套管理（导入/导出）
   * ============================================================ */
  function refreshBookManage() {
    // 顶部"当前账套/启用期间"信息区已移除，仅保留账套列表刷新（refreshTools 经 globalThis.__renderTools 渲染）
    if (globalThis.__renderTools) globalThis.__renderTools();
  }
  /* ============================================================
   * 【2026-09-28 三合一 + 语义统一】导入账套（唯一入口，原「导入账套 / 多年合并导入 / 导入备份」）
   *
   * 三者原先各有一个按钮 + 隐藏 input + 一段处理逻辑。按**文件种类 + 数量**分流即可
   * （判据是纯函数 importPlanOf，可单独测试）：
   *     ① 1 个 .ais  → 解析后**新建**一个独立账套
   *     ② ≥2 个 .ais → 逐文件解析后**合并新建**一个连续多年账套
   *     ③ 1 个 .json → **作为新账套导入**
   *
   * 【核心不变量：本入口只做新增，绝不覆盖当前账套】
   *   用户看到"导入"二字时，心里想的是"加一本 / 打开别人给的账"，不会预期自己正在用的账被换掉 ——
   *   名字与行为不符是最坏的一类不一致，因为他不会去细读确认框（他"已经知道"这个按钮干什么了）。
   *   故 ③ 由原来的"覆盖当前账套"改为"作为新账套导入"。
   *   全应用只有一处能覆盖当前账本：「查看备份 → 恢复」（从应用内快照回滚）。
   *   （外部文件一度支持过"覆盖当前账本"，2026-09-28 按用户要求删除 —— 外部副本只做新增。）
   *   判不出的情况（混选 .ais/.json、多个 .json、其它类型）明确报错，**不做猜测**。
   * ============================================================ */
  var bmFile = $('bookImportFile');
  if (bmFile) {
    bmFile.addEventListener('change', function () {
      if (!bmFile.files || !bmFile.files.length) return;
      var plan = importPlanOf(bmFile.files);
      // 立刻清空 input：否则"再次选同一个文件"不会触发 change（原先各分支各清一次，容易漏）
      bmFile.value = '';
      if (plan.action === 'error') { showToast(plan.msg, 'error'); return; }
      if (plan.action === 'new-ais') { handleImportAis(plan.files[0]); return; }        // ①
      if (plan.action === 'new-json') { importJsonAsNewBook(plan.files[0]); return; }   // ③
      if (plan.action === 'merge-ais') { handleMultiYearImport(plan.files); return; }   // ②
      // 兜底：判据将来新增动作、而这里忘了接时**绝不**落到"按合并处理"（那会静默按错误方式导入）。
      // 宁可报一句看不懂的错，也不要悄悄做错事。
      showToast('导入入口未识别的分流动作：' + plan.action + '（请把这一条反馈给开发）', 'error');
    });
  }

  /* ③ .json 账套备份 → **作为新账套导入**（不是覆盖）。
     数据整理与落盘走 store 的同一条实现 S.importExternalBook（与 .ais 导入共用，
     保证两边口径一致，且这条路径能被 Node 里的行为测试真实跑到 —— 见 js/store.js 该函数注释）：
       · normalizeState     —— 补全旧备份缺的顶层/深层字段，并按科目自动判定准则
       · ensureVoucherIds   —— 凭证 id 缺失/不稳会导致"点凭证定位"失效
       · ensureCashFlowFields —— 现金流量字段兜底（旧备份可能没有）
     账套 id 用「名称 + 时间戳」（与 .ais 导入同一约定），避免与已有同名账套相互覆盖；
     名称必须先经 safeIdOf 净化（id 会被 Rust 当文件名用，见该函数说明）。 */
  function importJsonAsNewBook(f) {
    var reader = new FileReader();
    showToast('正在读取账套备份…');
    reader.onload = function () {
      try {
        var data = JSON.parse(reader.result);
        if (!data || (!data.company && !data.subjects)) { showToast('文件不是有效的账套备份', 'error'); return; }
        var base = String((data.company && data.company.name)
          || ((f && f.name) || '').replace(/\.[^.]+$/, '') || '导入账套').trim() || '导入账套';
        var bid = safeIdOf(base) + '_' + Date.now();
        // saved === false 表示**没写进磁盘**（保存失败告警横幅已同时给出），
        // 此时绝不能报"导入成功" —— 那与红色横幅自相矛盾，用户不知道信哪个。
        S.importExternalBook(bid, data).then(function (saved) {
          if (S && S.persist) S.persist();
          var cnt = (data.subjects ? data.subjects.length : 0), vcnt = (data.vouchers ? data.vouchers.length : 0);
          if (saved) showToast('已作为新账套「' + base + '」导入：' + cnt + ' 科目 / ' + vcnt + ' 凭证');
          refreshBookManage(); refreshAll();
        });
      } catch (e) { showToast('导入出错：文件不是有效的账套备份(JSON)', 'error'); }
    };
    reader.onerror = function () { showToast('读取文件失败', 'error'); };
    reader.readAsText(f);
  }

  //  多年账套合并导入：按年导出 .ais，本入口把同店多年 .ais 合并为一个连续多年账套。
  // 流程：选多个 .ais -> parseMulti 合并（基础年完整导入+后续年只取凭证，凭证号跨年连续重排）
  // -> 跨年一致性校验（上一年期末 vs 下一年期初） -> 本地载入
  function handleMultiYearImport(files) {
    if (!files || !files.length) return;
    if (files.length < 2) {
      showToast('请选择 2 个或以上的 .ais 文件（同店不同年份）', 'warn');
      return;
    }
    if (!window.KisImport || typeof window.KisImport.parseMulti !== 'function') {
      showToast('解析模块未加载，请刷新页面后重试', 'error');
      return;
    }
    // 用第一个文件名提取店名（去掉 _YYYY年_ 格式.ais）
    var firstName = files[0].name || '账套';
    var defaultName = firstName.replace(/[_\s]*\d{4}\s*年.*$/, '').trim() || '多年合并账套';
    H.promptAsync('请输入账套名称：', defaultName, { title: '多年合并导入（' + files.length + ' 个 .ais）' })
      .then(function (bookName) {
        if (!bookName) return;
        showToast('正在合并 ' + files.length + ' 个金蝶年度账套…（大文件可能需数十秒）');
        var t0 = Date.now();
        window.KisImport.parseMulti(Array.from(files), { baseName: bookName.trim() })
          .then(function (res) {
            var book = res && res.ledger;
            var stats = res && res.stats;
            if (!book || !Array.isArray(book.subjects) || !book.subjects.length) {
              showToast('导入中止：合并后账套科目为空或数据异常', 'error'); return;
            }
            if (!Array.isArray(book.vouchers)) {
              showToast('导入中止：合并后凭证数据异常', 'error'); return;
            }
            var bid = safeIdOf(bookName.trim()) + '_合并_' + new Date().toISOString().slice(0,10).replace(/-/g,'') + '_' + Date.now();
            var cnt = book.subjects.length, vcnt = book.vouchers.length;
            var years = (stats && stats.years || []).join('、');
            var tip = '多年合并导入成功：' + bookName + '（' + years + '），' + cnt + ' 科目 / ' + vcnt + ' 凭证';
            var warns = (res && res.warnings) || [];
            // 跨年校验结果
            if (stats && stats.yearBoundaries) {
              stats.yearBoundaries.forEach(function (b) {
                if (b.checked > 0) {
                  warns.push(b.fromYear + '→' + b.toYear + '：' + b.checked + ' 个科目期初与上年期末不一致，最大差异 ¥' + U.yuan(Math.abs(b.maxDiff)).toFixed(2));
                } else {
                  tip += '；' + b.fromYear + '→' + b.toYear + ' 年结校验通过';
                }
              });
            }
            // 每年统计
            if (stats && stats.perYear) {
              warns.push('每年凭证数：' + stats.perYear.map(function (y) {
                return y.year + '年(' + y.vouchers + '张)';
              }).join(' '));
            }
            if (warns.length) tip += '；' + warns.join('；');
            // saved === false 表示**没写进磁盘**（保存失败告警横幅已同时给出）——
            // 此时报"合并导入成功"会与红色横幅自相矛盾；校验报告卡片同理只在成功时弹。
            S.importExternalBook(bid, book).then(function (saved) {
              if (S && S.persist) S.persist();
              if (saved) {
                showToast(tip, warns.length ? 'warn' : 'success', 8000);
                // 合并完成时渲染跨年校验报告到页内卡片
                if (stats && stats.yearBoundaries && stats.yearBoundaries.length) {
                  _showYearBoundaryCard(stats.yearBoundaries);
                }
              }
              refreshBookManage();
              if (window.__refreshAll) window.__refreshAll();
            });
          })
          .catch(function (e) {
            showToast('合并导入失败：' + importErrText(e), 'error');   // 同一套文案单点（见 importErrText）
          });
      });
  }

  /* 跨年校验报告渲染（渲染到传入的 table，不依赖 modal）。
     【唯一实现】它被两处复用：独立的「跨年一致性校验报告」卡片（合并导入后自动弹）
     与「风险检测」卡片里的跨年分区 —— 不复制第二份，否则两处迟早走样。
     opts.keySubject：穿透链接的阈值（与风险检测同一口径，默认 ¥10 万）。
     差异 ≥ 该阈值的科目编码变成可点的 .link-jump → 穿透到科目账。 */
  function _renderYearBoundaryToCard(yearBoundaries, tbEl, opts) {
    tbEl = tbEl || $('yearBoundaryTableInPage');
    if (!tbEl) return;
    var jumpThreshold = (opts && opts.keySubject) || 100000;
    if (!yearBoundaries || !yearBoundaries.length) {
      tbEl.innerHTML = '<thead><tr><th>校验结果</th></tr></thead><tbody><tr><td class="empty-hint" style="color:var(--ty-green)">✓ 无跨年差异，所有年度期初与上年期末完全一致</td></tr></tbody>';
      return;
    }
    // 列宽走全站标准（原表头内联 width:16%/22%/18%… 已删除，改由内容自动 + 按比例补空白）
    var html = '<thead><tr><th>年份</th><th>科目编码</th><th class="ta-r">上年期末</th><th class="ta-r">本年期初</th><th class="ta-r">差异</th><th class="ta-r">差异率</th></tr></thead><tbody>';
    yearBoundaries.forEach(function (b) {
      var diffs = b.allDiffs || b.samples || [];
      if (!diffs.length) {
        // 文案修正：b.checked 是「有差异科目数」（一致时=0），不能用它冒充核对总数；
        // 用 b.total（参与核对科目数，新导入器已写入），旧存档无 total 时只报「一致」不带数量。
        html += '<tr class="ok-row"><td>' + b.fromYear + '→' + b.toYear + '</td><td colspan="5" style="color:var(--ty-green)">校验通过：' +
          (b.total ? (b.total + ' 个科目期初与上年期末一致') : '期初与上年期末核对一致') + '（0 差异）✓</td></tr>';
        return;
      }
      diffs.forEach(function (d, i) {
        var diffRate = d.prevEnd !== 0 ? (Math.abs(d.diff / d.prevEnd) * 100).toFixed(1) + '%' : '—';
        html += '<tr' + (i === 0 ? ' class="grp-row"' : '') + '>';
        if (i === 0) {
          html += '<td rowspan="' + diffs.length + '" class="grp-label">' + b.fromYear + '→' + b.toYear + '<br><span class="muted">(' + b.checked + ' 科目差异)</span></td>';
        }
        // 差异超阈值 → 科目编码可点，直接穿透到该科目账（与风险检测的 year_jump 同一阈值口径）
        var codeCell = (Math.abs(num(d.diff)) >= U.amt(jumpThreshold))
          ? '<a class="link-jump" data-jump="ledger" data-code="' + esc(d.code) + '"'
            + ' title="差异超 ¥' + jumpThreshold + '，点此查该科目账">' + esc(d.code) + '</a>'
          : esc(d.code);
        html += '<td class="mono">' + codeCell + (d.name ? ' ' + esc(d.name) : '') + '</td>';
        html += '<td class="mono ta-r">' + U.yuan(num(d.prevEnd)).toFixed(2) + '</td>';
        html += '<td class="mono ta-r">' + U.yuan(num(d.curOpen)).toFixed(2) + '</td>';
        html += '<td class="mono ta-r ' + (Math.abs(d.diff) > U.AMT_SCALE ? 'ty-red' : '') + '">' + (d.diff > 0 ? '+' : '') + U.yuan(num(d.diff)).toFixed(2) + '</td>';
        html += '<td class="mono ta-r">' + diffRate + '</td>';
        html += '</tr>';
      });
    });
    html += '</tbody>';
    tbEl.innerHTML = html;
  }
  // 显示跨年校验卡片到页内
  function _showYearBoundaryCard(yearBoundaries) {
    var card = document.getElementById('yearBoundaryCard');
    var tb = $('yearBoundaryTableInPage');
    if (!card || !tb) { showToast('校验报告面板未就绪', 'error'); return; }
    _renderYearBoundaryToCard(yearBoundaries, tb);
    card.style.display = '';
    setTimeout(function () { card.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 50);
  }
  // 关闭跨年校验卡片
  var btnYBClose = document.getElementById('btnYearBoundaryCloseCard');
  if (btnYBClose) {
    btnYBClose.addEventListener('click', function () {
      var card = document.getElementById('yearBoundaryCard');
      if (card) card.style.display = 'none';
    });
  }

  /* 【2026-09-28 三合一】原「多年合并导入」按钮及其 #multiAisFile 的绑定已删除 ——
     多选 .ais 的合并能力由统一的「导入账套」入口承担（判据 action==='merge' → handleMultiYearImport）。 */
  /* 【2026-09-28 合并进「风险检测」，原「查看校验报告」按钮已删除】理由三条：
     · 它只对**多年合并账套**有内容，其它账套点了只弹一句 toast —— 对绝大多数用户是死按钮；
     · 而目标用户的价值已在**合并导入成功那一刻**自动交付（handleMultiYearImport 会弹卡片）；
     · 跨年数据本来就在风险检测里被检（store.js 的检测 6 = year_jump，读同一份 meta.yearBoundaries）。
     现在跨年**完整表**作为「风险检测」卡片里的一个分区呈现（healthYearSec / healthYearTable），
     差异超风险阈值（默认 ¥10 万）的科目可直接点击穿透到科目账。
     导入后自动弹卡片的路径（_showYearBoundaryCard）保留不动 —— 那是它最有用的时刻。 */
  // 绑定"风险检测"按钮：扫描当前账套，结果直接渲染到账套卡片和操作日志之间的卡片中（不依赖 modal）
  var btnFinancialHealth = document.getElementById('btnFinancialHealth');
  if (btnFinancialHealth) {
    btnFinancialHealth.addEventListener('click', function () {
      if (!S || typeof S.financialHealthCheck !== 'function') {
        showToast('风险检测模块未加载', 'error'); return;
      }
      var card = document.getElementById('healthCheckCard');
      var tb = $('healthCheckTableInPage');
      var sm = $('healthCheckSummaryInPage');
      if (!card || !tb || !sm) {
        showToast('检测结果面板未就绪，刷新页面后重试', 'error'); return;
      }
      var t0 = Date.now();
      var r;
      /* 【2026-09-28】只传 keySubject，**不传 largeVoucher**：
         store 侧给 largeVoucher 的默认行为是「按本账套金额分布自适应取 TOP30」（注释写明
         "需要固定口径时才传 options.largeVoucher"），而此处原先一直传着固定 5 万 ——
         等于让那段自适应逻辑在生产里从不执行：大账套会先命中 355 笔再截断，
         清单既长又不代表该账套的"相对大额"。不传即走设计口径。 */
      try { r = S.financialHealthCheck({ keySubject: 100000 }); }
      catch (e) { showToast('风险检测失败：' + (e && e.message || e), 'error', 6000); return; }
      _renderHealthCheckToCard(r, sm, tb);
      /* 跨年校验分区（原「查看校验报告」的内容，2026-09-28 并入本卡片）。
         数据来自 meta.yearBoundaries，仅多年合并账套有；复用同一套表格渲染（不复制第二份）。
         ⚠ **无条件**设置显隐 —— 否则切换到普通账套后，上一本账套的跨年表会留在卡片里（错数）。 */
      var ysec = document.getElementById('healthYearSec');
      var ytb = $('healthYearTable');
      if (ysec && ytb) {
        var yb = (S.state && S.state.meta && S.state.meta.yearBoundaries) || null;
        if (yb && yb.length) {
          _renderYearBoundaryToCard(yb, ytb, { keySubject: 100000 });   // 阈值口径与本次检测一致
          ysec.style.display = '';
        } else {
          ytb.innerHTML = '';
          ysec.style.display = 'none';
        }
      }
      card.style.display = '';
      setTimeout(function () { card.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 50);
    });
  }
  // 关闭页内检测结果卡片
  var btnCloseCard = document.getElementById('btnHealthCheckCloseCard');
  if (btnCloseCard) {
    btnCloseCard.addEventListener('click', function () {
      var card = document.getElementById('healthCheckCard');
      if (card) card.style.display = 'none';
    });
  }
  // 渲染风险检测报告到页内卡片
  function _renderHealthCheckToCard(r, smEl, tbEl) {
    if (smEl) {
      var cls = r.summary.high ? 'health-summary-high' : (r.summary.medium ? 'health-summary-medium' : 'health-summary-ok');
      smEl.className = 'health-summary ' + cls;
      smEl.innerHTML = '<span class="hs-period">检测期间：' + esc(r.period) + '</span>'
        + '<span class="hs-total">风险点：<b>' + r.summary.total + '</b></span>'
        + '<span class="hs-high">高危：<b>' + r.summary.high + '</b></span>'
        + '<span class="hs-medium">中危：<b>' + r.summary.medium + '</b></span>'
        // 参考项只在存在时显示：否则"风险点 0"配着表格里一条参考信息会让人困惑
        + (r.summary.info ? '<span>参考：<b>' + r.summary.info + '</b></span>' : '');
    }
    if (!tbEl) return;
    if (!r.checks || !r.checks.length) {
      tbEl.innerHTML = '<thead><tr><th>检测结果</th></tr></thead><tbody><tr><td class="empty-hint" style="color:var(--ty-green)">✓ 未发现风险点，账套数据健康</td></tr></tbody>';
      return;
    }
    // 列宽走全站标准（原表头内联 width:18%/8%/30%/34%/10% 已删除）
    var html = '<thead><tr><th>检测项</th><th>等级</th><th>明细</th><th>说明</th><th>操作</th></tr></thead><tbody>';
    r.checks.forEach(function (c) {
      // 等级标签：info 显示「参考」—— 它不是风险，只是提示关注（必然命中的条目不该叫"风险"，
      // 否则用户会对真实告警脱敏；见 store.js 检测 3 的说明）
      var sev = c.severity === 'high' ? '<span class="tag tag-stop">高危</span>'
        : (c.severity === 'medium' ? '<span class="tag tag-warn">中危</span>'
          : (c.severity === 'info' ? '<span class="tag">参考</span>' : '<span class="tag">低危</span>'));
      var items = c.items || [];
      items.forEach(function (it, i) {
        html += '<tr' + (i === 0 ? ' class="grp-row"' : '') + '>';
        if (i === 0) {
          html += '<td rowspan="' + items.length + '" class="grp-label">' + esc(c.title) + '<br><span class="muted">(' + items.length + ' 项)</span></td>';
          html += '<td rowspan="' + items.length + '">' + sev + '</td>';
        }
        var detail = '';
        var jump = '';
        if (c.type === 'direction_anomaly') {
          detail = '<b>' + esc(it.code) + ' ' + esc(it.name) + '</b><br>余额 ¥' + U.yuan(num(it.balance)).toFixed(2) + '（' + esc(it.dir) + '）';
          jump = '<a class="link-jump" data-jump="ledger" data-code="' + esc(it.code) + '">查科目账</a>';
        } else if (c.type === 'key_subject_large') {
          detail = '<b>' + esc(it.name) + '</b><br>余额 ¥' + U.yuan(num(it.balance)).toFixed(2);
          var firstCode = (it.codes || '').split('/')[0];
          jump = '<a class="link-jump" data-jump="ledger" data-code="' + esc(firstCode) + '">查科目账</a>';
        } else if (c.type === 'large_voucher') {
          detail = '<b>' + esc(it.date) + ' ' + esc(it.word || '记') + '-' + esc(it.no) + '</b><br>¥' + U.yuan(num(it.amount)).toFixed(2) + ' ' + esc(it.summary || '');
          jump = '<a class="link-jump" data-jump="voucher" data-vid="' + esc(it.id) + '">查凭证</a>';
        } else if (c.type === 'unclosed_pl') {
          detail = '<b>' + esc(it.code) + ' ' + esc(it.name) + '</b><br>余额 ¥' + U.yuan(num(it.balance)).toFixed(2) + '（' + esc(it.dir) + '）';
          jump = '<a class="link-jump" data-jump="ledger" data-code="' + esc(it.code) + '">查科目账</a>';
        } else if (c.type === 'bs_unbalanced') {
          detail = '资产 ¥' + U.yuan(num(it.totalAsset)).toFixed(2) + ' / 负债权益 ¥' + U.yuan(num(it.totalAll)).toFixed(2) + '<br>差额 ¥' + U.yuan(num(Math.abs(it.diff))).toFixed(2);
          jump = '<a class="link-jump" data-jump="report">看资产负债表</a>';
        } else if (c.type === 'year_jump') {
          detail = '<b>' + it.fromYear + '→' + it.toYear + ' 科目 ' + esc(it.code) + '</b><br>上年期末 ¥' + U.yuan(num(it.prevEnd)).toFixed(2) + ' → 本年期初 ¥' + U.yuan(num(it.curOpen)).toFixed(2);
          jump = '<a class="link-jump" data-jump="ledger" data-code="' + esc(it.code) + '">查科目账</a>';
        } else {
          detail = esc(JSON.stringify(it).slice(0, 100));
        }
        html += '<td>' + detail + '</td>';
        html += '<td class="issue-text">' + esc(it.issue || '') + '</td>';
        html += '<td>' + jump + '</td>';
        html += '</tr>';
      });
    });
    html += '</tbody>';
    tbEl.innerHTML = html;
  }
  // 穿透链接：全局事件委托，处理风险检测卡片与跨年校验卡片内的 .link-jump
  document.addEventListener('click', function (e) {
    var a = e.target.closest('.link-jump');
    if (!a) return;
    // 跨年校验表在两处出现（风险检测卡片里的分区、独立的跨年报告卡片），两处都要能点
    if (!a.closest('#healthCheckCard') && !a.closest('#yearBoundaryCard')) return;
    var jump = a.getAttribute('data-jump');
    var code = a.getAttribute('data-code');
    var vid = a.getAttribute('data-vid');
    if (jump === 'ledger' && code) {
      if (typeof globalThis.gotoLedgerWithCode === 'function') globalThis.gotoLedgerWithCode(code);
      else if (typeof globalThis.goPage === 'function') globalThis.goPage('trial-balance');
    } else if (jump === 'voucher' && vid) {
      if (typeof globalThis.locateVoucherInQuery === 'function') globalThis.locateVoucherInQuery(vid);
      else if (typeof globalThis.goPage === 'function') globalThis.goPage('voucher-query');
    } else if (jump === 'report') {
      if (typeof globalThis.goPage === 'function') globalThis.goPage('report');
    }
  });
  /* 【2026-09-28 三合一】原 #multiAisFile 的 change 绑定已删除（合并进统一的导入入口）。 */

  //  账套 (.ais)：纯前端浏览器解析（零依赖，无需 Python / mdbtools / 服务器）。
  // 流程：浏览器内用 mdb-reader 直接读取 .ais -> KisImport 转换为账套结构 -> 本地载入。
  // 普通财务电脑无需安装任何环境，双击打开网页即可导入。
  function handleImportAis(file) {
    showToast('正在浏览器内解析金蝶账套…（大文件可能需数秒）');
    if (!window.KisImport || typeof window.KisImport.parse !== 'function') {
      showToast('解析模块未加载，请刷新页面后重试', 'error');
      return;
    }
    window.KisImport.parse(file)
      .then(function (res) {
        var book = res && res.ledger;
        var stats = res && res.stats;
        if (!book || !Array.isArray(book.subjects) || !book.subjects.length) {
          showToast('导入中止：账套科目为空或文件有问题，未导入', 'error'); return;
        }
        if (!Array.isArray(book.vouchers)) {
          showToast('导入中止：账套凭证数据异常，未导入', 'error'); return;
        }
        // 账套 id：文件名去后缀 + 时间戳，避免覆盖同目录同名导入（名称须净化，见 safeIdOf）
        var base = (file.name || 'kis').replace(/\.[^.]+$/, '');
        var bid = safeIdOf(base) + '_' + Date.now();
        var cnt = book.subjects.length, vcnt = book.vouchers.length;
        var tip = '金蝶账套导入成功：' + ((stats && stats.company) || base) + '，' + cnt + ' 科目 / ' + vcnt + ' 凭证';
        var warns = [];
        if (stats && stats.vchRows != null && stats.vchRows > 0) {
          warns.push('分录源 ' + stats.vchRows + ' 行 → ' + vcnt + ' 张凭证');
        }
        if (stats && stats.unbalancedVouchers) {
          warns.push('借贷不平凭证 ' + stats.unbalancedVouchers + ' 张，请核对源账套');
        }
        if (stats && stats.currencyFallback) {
          warns.push('期初余额按币种 ' + stats.currencyFallback + ' 导入（账套无综合币汇总行）');
        }
        if (stats && stats.dupSubjects && stats.dupSubjects.length) {
          warns.push('已去重 ' + stats.dupSubjects.length + ' 个重复科目');
        }
        if (warns.length) tip += '；' + warns.join('；');
        // saved === false 表示**没写进磁盘**（保存失败告警横幅已同时给出）——
        // 此时报"导入成功"会与红色横幅自相矛盾，用户不知道信哪个。
        S.importExternalBook(bid, book).then(function (saved) {
          if (S && S.persist) S.persist();
          if (saved) showToast(tip);
          refreshBookManage();
          if (window.__refreshAll) window.__refreshAll();
        });
      })
      .catch(function (e) {
        // 经 importErrText 翻成人话（原始英文栈对记账的人毫无意义，见其定义处注释）。
        // ⚠ 这条 catch 曾经是**死代码** —— parse 失败时外层 promise 永不结算，
        //   用户只看到全局兜底的「系统异常」；修复见 js/kis-import.js 的 parse 注释。
        showToast('导入失败：' + importErrText(e), 'error');
      });
  }

  // 三合一入口：一个按钮 → 一个文件选择器（#bookImportFile，可多选 .ais）
  $('btnBookImport').addEventListener('click', function () { if (bmFile) bmFile.click(); });

// —— 系统设置聚合页（系统参数 + 凭证模板 + 操作日志 三 Tab 合一）——
function refreshParam() {
  var p = S.state.param;
  var c = S.state.company || {};
  // 基本信息只读展示：公司名称（改名走「账套管理」）、启用期间（点「修改」弹窗调整）
  var nmEl = $('sysNameVal'); if (nmEl) nmEl.textContent = c.name || '';
  var stEl = $('sysStartVal'); if (stEl) stEl.textContent = c.startMonth || '';
  // 会计准则：只读展示（软件默认小企业准则，旧账套导入自动识别，不可手动切换）
  var curStdKey = S.state.standard || 'small2013';
  var curLabel = (globalThis.STANDARDS && globalThis.STANDARDS[curStdKey] && globalThis.STANDARDS[curStdKey].label) || curStdKey;
  var stdLab = $('sysStdLabel'); if (stdLab) stdLab.textContent = curLabel;
  // 软件版本号：在「关于」卡显示，从 Rust 编译时读，没拿到就显示 "--"
  var verEl = $('aboutVersion');
  if (verEl) {
    var upd = window.__TY_UPDATE__;
    if (upd && upd.getVersion) {
      upd.getVersion().then(function (v) {
        if (verEl) verEl.textContent = v ? 'v' + v : '--';
      });
    } else {
      verEl.textContent = '--';
    }
  }
  // 注：货币资金赤字检查现由【结账检查项】「货币资金赤字」承担（store.js 的 runSelfTest）。
  //     原凭证页「偏好设置」弹窗（含该开关）已于 2026-09-21 整体移除，此处不再有相关参数。
  // 默认密码 admin 提示：改过就不再提示
  var opHint = $('opPwHint');
  if (opHint) opHint.style.display = (S.state.op && S.state.op.opOverridden) ? 'none' : '';
  // 事件绑定（一次性）——参数改了自动存，不需要保存按钮
  if (!globalThis.__paramBound) {
    // 系统参数相关开关已迁移至各功能页面，此处不再有独立参数需绑定
    globalThis.__paramBound = true;
    // 启用期间：只读展示 + 受控「修改」弹窗。空账套直接改；已有凭证/期初/结账时保存前确认提示
    var bEditStart = $('btnEditStart');
    if (bEditStart) bEditStart.addEventListener('click', function () {
      var inp = $('epStart');
      if (inp) inp.value = (S.state.company && S.state.company.startMonth) || '';
      if (H.openModal) H.openModal('editPeriodModal');
    });
    var bSaveEditStart = $('btnSaveEditStart');
    if (bSaveEditStart) bSaveEditStart.addEventListener('click', async function () {
      var inp = $('epStart'); if (!inp) return;
      var v = (inp.value || '').trim();
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(v)) return showToast('请选择有效的月份', 'warn');
      var c = S.state.company || {};
      var old = c.startMonth || '';
      if (v === old) { if (H.closeModal) H.closeModal('editPeriodModal'); return; }
      // 有业务数据时：启用期间仅作「期间起点/标签」，凭证与报表均按实际日期计算，不受影响
      var hasData = (S.state.vouchers && S.state.vouchers.length) ||
                    (S.state.openingBalances && Object.keys(S.state.openingBalances).length) ||
                    (S.state.closedPeriods && S.state.closedPeriods.length);
      if (hasData) {
        var ok = await H.confirmAsync('账套已有凭证、期初、结账数据。\n\n修改启用期间只影响期间下拉的起点与「启用期间」显示，不影响任何凭证与报表数据。\n\n确认将启用期间由「' + (old || '') + '」改为「' + v + '」？', { title: '修改启用期间' });
        if (!ok) return;
      }
      c.startMonth = v;
      try { S.addLog('修改启用期间', '账套启用期间由「' + (old || '') + '」改为「' + v + '」', '账套'); } catch (e) {}
      if (H.closeModal) H.closeModal('editPeriodModal');
      refreshParam();
      refreshAll();
      // 落盘是异步的：以磁盘为准重建索引后刷新下方账套列表的「启用期间」列；系统事件稍候刷新
      setTimeout(function () {
        if (globalThis.__renderTools) {
          if (typeof S.refreshBookIndex === 'function') {
            S.refreshBookIndex().then(globalThis.__renderTools).catch(globalThis.__renderTools);
          } else globalThis.__renderTools();
        }
      }, 250);
      if (globalThis.__renderSysEvents) setTimeout(globalThis.__renderSysEvents, 400);
      showToast('启用期间已改为 ' + v, 'success');
    });
    var bCancelEditStart = $('btnCancelEditStart');
    if (bCancelEditStart) bCancelEditStart.addEventListener('click', function () { if (H.closeModal) H.closeModal('editPeriodModal'); });
    // 关于卡：检查更新 + GitHub 链接 + 邮箱复制
    var bChkUpd = $('aboutCheckUpdate');
    if (bChkUpd) bChkUpd.addEventListener('click', function () {
      var upd = window.__TY_UPDATE__;
      if (!upd || !upd.check) { showToast('更新模块未加载'); return; }
      upd.check();
    });
    var ghLink = $('aboutGitHub');
    if (ghLink && window.__TY_UPDATE__ && window.__TY_UPDATE__.REPO_RELEASE) {
      ghLink.href = window.__TY_UPDATE__.REPO_RELEASE;
    }
    var mailEl = $('aboutMail');
    if (mailEl) mailEl.addEventListener('click', function () {
      var txt = mailEl.textContent || '';
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(txt).then(function () { showToast('邮箱已复制'); });
        } else {
          // macOS 兼容兜底
          var ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta);
          ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
          showToast('邮箱已复制');
        }
      } catch (e) { showToast('复制失败，请手动选中'); }
    });
    // 操作密码修改：必须先验证「当前操作密码」（未自定义时为默认 admin），验证通过才允许改/恢复默认
    var bOpPw = $('btnSaveOpPw');
    if (bOpPw) bOpPw.addEventListener('click', function () {
      // 1) 验证当前生效密码（H.checkOpPassword 单点实现：默认 admin 或用户自定义值）
      var cur = ($('opPwCur') && $('opPwCur').value || '');
      if (!cur) { showToast('请输入当前操作密码', 'error'); return; }
      if (!(H.checkOpPassword ? H.checkOpPassword(cur) : cur === 'admin')) {
        showToast('当前操作密码不正确', 'error');
        if ($('opPwCur')) $('opPwCur').value = '';
        return;
      }
      // 2) 新密码：留空 = 恢复默认 admin
      var v = ($('opPwInput') && $('opPwInput').value || '').trim();
      if (v && v.length < 4) return showToast('新密码至少 4 位', 'error');
      var stg = S.settings || {};
      if (v) { stg.opPassword = v; stg.opOverridden = true; }
      else { stg.opPassword = ''; stg.opOverridden = false; }
      if (typeof S.saveSettings === 'function') S.saveSettings();
      else { try { localStorage.setItem('kis_settings', JSON.stringify(stg)); } catch (e) {} }
      if ($('opPwCur')) $('opPwCur').value = '';
      if ($('opPwInput')) $('opPwInput').value = '';
      refreshParam();
      // 存过密码后更新 hint 显隐
      var opHint = $('opPwHint');
      if (opHint) opHint.style.display = (stg.opOverridden) ? 'none' : '';
      showToast('操作密码已保存' + (v ? '' : '（已恢复默认密码）'), 'success');
    });
    globalThis.__paramBound = true;
  }
}

// 系统设置聚合页：系统参数 + 凭证字 + 卡片合一；凭证模板统一在「期末结账」页管理
function refreshSystemSettings() {
  if (globalThis.__renderParam) globalThis.__renderParam();
  else refreshParam();
  refreshVoucherWord();
  // 云同步卡（WebDAV）：与设置页一并刷新配置与上次同步信息
  if (globalThis.__renderCloudSync) globalThis.__renderCloudSync();
}

export {
  refreshVoucherWord, refreshCashflowInit, refreshCashflowProject,
  refreshBackup, refreshLogs, refreshBookManage,
  refreshSysEvents,
  refreshParam, refreshSystemSettings
};

