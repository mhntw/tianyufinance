// 页面模块（B 方案解耦，由 tools/migrate_domain.py 生成骨架）
// 依赖全部从全局桥接对象取，逻辑与 app.js 原实现逐字一致（只挪窝不改写）。
// 设计：globalThis.__TY_HELPERS__（app.js 注册）、globalThis.__TY_EXPORT__（store.js 注册）。
// 模块不 import store.js（避免 IIFE 双执行），统一从全局取已加载单例。

import { $, money, esc, showToast, fmtDate, currentPeriod, S, U, num,
  ACCOUNT_CLASSES, exportTable } from './_shared.js';
const H = globalThis.__TY_HELPERS__ || {};

// refreshAll 是 app.js IIFE 的局部刷新函数，经桥接层暴露；本模块必须先绑定才能调用
// （否则裸调用抛 ReferenceError，导致「导入成功但读取账套失败」）
const refreshAll = (globalThis.__TY_HELPERS__ || {}).refreshAll;

  /* ============================================================
   * 设置：凭证字 / 现金流量科目
   * ============================================================ */
  function refreshVoucherWord() {
    var tb = $('vwBody'); tb.innerHTML = '';
    (S.state.voucherWords || []).forEach(function (w, i) {
      var tr = document.createElement('tr');
      var protect = (w.name === '记');
      tr.innerHTML =
        '<td>' + w.name + (protect ? ' <span class="ok-tag">默认</span>' : '') + '</td>' +
        '<td>' + w.title + '</td>' +
        '<td class="col-op">' + (protect
          ? '<a class="link-del disabled" data-i="' + i + '">—</a>'
          : '<a class="link-toggle" data-i="' + i + '">' + (w.enabled === false ? '启用' : '停用') + '</a>') + '</td>';
      tb.appendChild(tr);
    });
    tb.querySelectorAll('.link-toggle').forEach(function (a) {
      a.addEventListener('click', async function () {
        var i = +this.getAttribute('data-i');
        var row = S.state.voucherWords[i];
        if (row && row.name === '记') { showToast('“记”为默认凭证字，不可停用'); return; }
        var disabling = !(row && row.enabled === false);
        if (disabling) {
          if (!(await H.confirmAsync('确定停用凭证字「' + (row ? row.title || row.name : '') + '」？\n停用后新增凭证不能再选该凭证字，历史凭证保留。', { title: '停用凭证字' }))) return;
        }
        row.enabled = disabling ? false : true;
        S.persist(); renderVoucherWordBody();
      });
    });
  }
  function renderVoucherWordBody() { refreshVoucherWord(); }
  $('btnAddWord').addEventListener('click', async function () {
    var name = await H.promptAsync('凭证字（如 记 / 转 / 收）：', '', { title: '新增凭证字' });
    if (!name) return;
    var title = (await H.promptAsync('打印标题（如 记账凭证）：', name + '账凭证', { title: '打印标题' })) || name;
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
        : '<td class="num"><input class="cf-ytd input-sm" data-id="' + it.id + '" value="' + (o.ytd || 0) + '"></td>';
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
    // 审计修复：原实现读 S.subject(c).obDr——科目档案对象不存余额字段，恒为 0，
    // 导致「试算平衡」永远拿 0 与录入合计比较，形同虚设。
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
    if (Math.abs(total - cashOb) > 0.01) {
      showToast('试算不平衡：现金流量初始余额各项目之和(' + total.toFixed(2) + ') 与现金科目期初余额(' + cashOb.toFixed(2) + ') 不符', 'error');
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
      return { 项目: it.name, 行次: it.rowNum || '', 期初余额: o.ytd || 0 };
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
        '<td>' + (s.normal === 'dr' ? '借' : '贷') + '</td>' +
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
  // 输入 _voucherAuditSummary 的产物 {id,word,no,date,summary,status,maker,entries:[{code,name,dr,cr}]}
  function _auditFmt(v) {
    if (!v) return '(无)';
    var lines = [];
    lines.push('凭证 ' + (v.word || '') + '-' + (v.no != null ? v.no : '') + ' · ' + (v.date || '') + ' · ' + (v.summary || ''));
    if (v.maker) lines.push('制单：' + v.maker + ' · 状态：' + (v.status || 'draft'));
    (v.entries || []).forEach(function (e) {
      var amt = e.dr ? '借 ' + num(e.dr).toFixed(2) : (e.cr ? '贷 ' + num(e.cr).toFixed(2) : '0.00');
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
      (S.getLogs() || []).forEach(function (l) { users[l.user || '会计'] = 1; });
      var optUser = Object.keys(users).sort();
      $('logUser').innerHTML = '<option value="">全部</option>' + optUser.map(function (u) {
        return '<option value="' + u + '">' + u + '</option>';
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
        tr.innerHTML = '<td class="mono">' + (l.time || '') + '</td><td>' + (l.user || '') + '</td><td>' +
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
    var SYS_ACTIONS = { '新建账套': 1, '删除账套': 1, '导入账套': 1, '恢复备份': 1, '切换会计准则': 1, '还原账套': 1, '清空回收站': 1, '彻底删除账套': 1 };
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
  // 导入：复用 aisFile input（原 import-ais 的文件选择器，现移到 book-manage 页面内）
  // 支持两种文件：
  // 1) .json —— 本软件账套备份，直接前端 JSON.parse 恢复（原逻辑）
  // 2) .ais ——   账套，浏览器内用 mdb-reader 直接解析（零依赖，无需服务端）
  var bmFile = $('aisFile');
  if (bmFile) {
    bmFile.addEventListener('change', function () {
      if (!bmFile.files || !bmFile.files.length) return;
      var f = bmFile.files[0];
      var lower = (f.name || '').toLowerCase();
      if (lower.endsWith('.ais')) { handleImportAis(f); bmFile.value = ''; return; }
      // .json 备份恢复（原逻辑）
      var reader = new FileReader();
      showToast('正在读取备份文件…');
      reader.onload = async function () {
        try {
          var data = JSON.parse(reader.result);
          if (!data || !data.company) { showToast('文件不是有效的账套备份', 'error'); bmFile.value = ''; return; }
          // 导入是整体覆盖当前账本，先留快照以便撤回（复用 Tools.js 的同一套保护）
          var guard = globalThis.__guardBeforeRestore;
          if (guard) {
            const goon = await guard('未能创建「覆盖前存档」，继续导入将无法撤回。是否仍要继续？');
            if (!goon) { bmFile.value = ''; return; }
          }
          var r = S.restoreFromData(data);
          if (!r.ok) { showToast(r.msg || '导入失败', 'error'); bmFile.value = ''; return; }
          var cnt = (data.subjects ? data.subjects.length : 0), vcnt = (data.vouchers ? data.vouchers.length : 0);
          // .json 备份恢复同样记入操作日志，保证操作日志能看到"导入账套"操作
          S.addLog('导入账套', '导入账套（JSON备份恢复）' + '（' + cnt + ' 科目 / ' + vcnt + ' 凭证）', '账套');
          showToast('导入成功：' + cnt + ' 科目 / ' + vcnt + ' 凭证');
          refreshBookManage(); refreshAll();
        } catch (e) { showToast('导入出错：文件不是有效的账套备份(JSON)', 'error'); }
        bmFile.value = '';
      };
      reader.onerror = function () { showToast('读取文件失败', 'error'); bmFile.value = ''; };
      reader.readAsText(f);
    });
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
            var bid = bookName.trim() + '_合并_' + new Date().toISOString().slice(0,10).replace(/-/g,'') + '_' + Date.now();
            loadServerBookIntoLocal(bid, book);
            if (S && S.persist) S.persist();
            var cnt = book.subjects.length, vcnt = book.vouchers.length;
            var years = (stats && stats.years || []).join('、');
            var tip = '多年合并导入成功：' + bookName + '（' + years + '），' + cnt + ' 科目 / ' + vcnt + ' 凭证';
            var warns = (res && res.warnings) || [];
            // 跨年校验结果
            if (stats && stats.yearBoundaries) {
              stats.yearBoundaries.forEach(function (b) {
                if (b.checked > 0) {
                  warns.push(b.fromYear + '→' + b.toYear + '：' + b.checked + ' 个科目期初与上年期末不一致，最大差异 ¥' + Math.abs(b.maxDiff).toFixed(2));
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
            showToast(tip, warns.length ? 'warn' : 'success', 8000);
            refreshBookManage();
            if (window.__refreshAll) window.__refreshAll();
            // 合并完成时渲染跨年校验报告到页内卡片
            if (stats && stats.yearBoundaries && stats.yearBoundaries.length) {
              _showYearBoundaryCard(stats.yearBoundaries);
            }
          })
          .catch(function (e) {
            showToast('合并导入失败：' + (e && e.message || e), 'error');
          });
      });
  }

  // 跨年校验报告渲染：渲染到页内卡片的 table（不依赖 modal）
  function _renderYearBoundaryToCard(yearBoundaries, tbEl) {
    tbEl = tbEl || $('yearBoundaryTableInPage');
    if (!tbEl) return;
    if (!yearBoundaries || !yearBoundaries.length) {
      tbEl.innerHTML = '<thead><tr><th>校验结果</th></tr></thead><tbody><tr><td class="empty-hint" style="padding:24px;text-align:center;color:#34a853">✓ 无跨年差异，所有年度期初与上年期末完全一致</td></tr></tbody>';
      return;
    }
    var html = '<thead><tr><th style="width:16%">年份</th><th style="width:22%">科目编码</th><th style="width:18%">上年期末</th><th style="width:18%">本年期初</th><th style="width:14%">差异</th><th style="width:12%">差异率</th></tr></thead><tbody>';
    yearBoundaries.forEach(function (b) {
      var diffs = b.allDiffs || b.samples || [];
      if (!diffs.length) {
        // 文案修正：b.checked 是「有差异科目数」（一致时=0），不能用它冒充核对总数；
        // 用 b.total（参与核对科目数，新导入器已写入），旧存档无 total 时只报「一致」不带数量。
        html += '<tr class="ok-row"><td>' + b.fromYear + '→' + b.toYear + '</td><td colspan="5" style="color:#34a853">校验通过：' +
          (b.total ? (b.total + ' 个科目期初与上年期末一致') : '期初与上年期末核对一致') + '（0 差异）✓</td></tr>';
        return;
      }
      diffs.forEach(function (d, i) {
        var diffRate = d.prevEnd !== 0 ? (Math.abs(d.diff / d.prevEnd) * 100).toFixed(1) + '%' : '—';
        html += '<tr' + (i === 0 ? ' class="grp-row"' : '') + '>';
        if (i === 0) {
          html += '<td rowspan="' + diffs.length + '" class="grp-label" style="vertical-align:top">' + b.fromYear + '→' + b.toYear + '<br><span class="muted">(' + b.checked + ' 科目差异)</span></td>';
        }
        html += '<td class="mono">' + esc(d.code) + (d.name ? ' ' + esc(d.name) : '') + '</td>';
        html += '<td class="mono ta-r">' + num(d.prevEnd).toFixed(2) + '</td>';
        html += '<td class="mono ta-r">' + num(d.curOpen).toFixed(2) + '</td>';
        html += '<td class="mono ta-r ' + (Math.abs(d.diff) > 1 ? 'ty-red' : '') + '">' + (d.diff > 0 ? '+' : '') + num(d.diff).toFixed(2) + '</td>';
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

  // 绑定多年合并导入按钮
  var btnMultiYearImport = document.getElementById('btnMultiYearImport');
  if (btnMultiYearImport) {
    btnMultiYearImport.addEventListener('click', function () {
      var input = document.getElementById('multiAisFile');
      if (!input) return;
      input.value = '';
      input.click();
    });
  }
  // 绑定"查看校验报告"按钮：从当前账套 meta.yearBoundaries 读取并展示
  var btnViewYearBoundary = document.getElementById('btnViewYearBoundary');
  if (btnViewYearBoundary) {
    btnViewYearBoundary.addEventListener('click', function () {
      var meta = S && S.state && S.state.meta;
      if (!meta || !meta.yearBoundaries || !meta.yearBoundaries.length) {
        showToast('当前账套不是多年合并导入的账套，无校验报告', 'warn');
        return;
      }
      _showYearBoundaryCard(meta.yearBoundaries);
    });
  }
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
      try { r = S.financialHealthCheck({ largeVoucher: 50000, keySubject: 100000 }); }
      catch (e) { showToast('风险检测失败：' + (e && e.message || e), 'error', 6000); return; }
      _renderHealthCheckToCard(r, sm, tb);
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
        + '<span class="hs-medium">中危：<b>' + r.summary.medium + '</b></span>';
    }
    if (!tbEl) return;
    if (!r.checks || !r.checks.length) {
      tbEl.innerHTML = '<thead><tr><th>检测结果</th></tr></thead><tbody><tr><td class="empty-hint" style="padding:24px;text-align:center;color:#34a853">✓ 未发现风险点，账套数据健康</td></tr></tbody>';
      return;
    }
    var html = '<thead><tr><th style="width:18%">检测项</th><th style="width:8%">等级</th><th style="width:30%">明细</th><th style="width:34%">说明</th><th style="width:10%">操作</th></tr></thead><tbody>';
    r.checks.forEach(function (c) {
      var sev = c.severity === 'high' ? '<span class="tag tag-stop">高危</span>'
        : (c.severity === 'medium' ? '<span class="tag tag-warn">中危</span>' : '<span class="tag">低危</span>');
      var items = c.items || [];
      items.forEach(function (it, i) {
        html += '<tr' + (i === 0 ? ' class="grp-row"' : '') + '>';
        if (i === 0) {
          html += '<td rowspan="' + items.length + '" class="grp-label" style="vertical-align:top">' + esc(c.title) + '<br><span class="muted">(' + items.length + ' 项)</span></td>';
          html += '<td rowspan="' + items.length + '" style="vertical-align:top">' + sev + '</td>';
        }
        var detail = '';
        var jump = '';
        if (c.type === 'direction_anomaly') {
          detail = '<b>' + esc(it.code) + ' ' + esc(it.name) + '</b><br>余额 ¥' + num(it.balance).toFixed(2) + '（' + esc(it.dir) + '）';
          jump = '<a class="link-jump" data-jump="ledger" data-code="' + esc(it.code) + '">查科目账</a>';
        } else if (c.type === 'key_subject_large') {
          detail = '<b>' + esc(it.name) + '</b><br>余额 ¥' + num(it.balance).toFixed(2);
          var firstCode = (it.codes || '').split('/')[0];
          jump = '<a class="link-jump" data-jump="ledger" data-code="' + esc(firstCode) + '">查科目账</a>';
        } else if (c.type === 'large_voucher') {
          detail = '<b>' + esc(it.date) + ' ' + esc(it.word || '记') + '-' + esc(it.no) + '</b><br>¥' + num(it.amount).toFixed(2) + ' ' + esc(it.summary || '');
          jump = '<a class="link-jump" data-jump="voucher" data-vid="' + esc(it.id) + '">查凭证</a>';
        } else if (c.type === 'unclosed_pl') {
          detail = '<b>' + esc(it.code) + ' ' + esc(it.name) + '</b><br>余额 ¥' + num(it.balance).toFixed(2) + '（' + esc(it.dir) + '）';
          jump = '<a class="link-jump" data-jump="ledger" data-code="' + esc(it.code) + '">查科目账</a>';
        } else if (c.type === 'bs_unbalanced') {
          detail = '资产 ¥' + num(it.totalAsset).toFixed(2) + ' / 负债权益 ¥' + num(it.totalAll).toFixed(2) + '<br>差额 ¥' + num(Math.abs(it.diff)).toFixed(2);
          jump = '<a class="link-jump" data-jump="report">看资产负债表</a>';
        } else if (c.type === 'year_jump') {
          detail = '<b>' + it.fromYear + '→' + it.toYear + ' 科目 ' + esc(it.code) + '</b><br>上年期末 ¥' + num(it.prevEnd).toFixed(2) + ' → 本年期初 ¥' + num(it.curOpen).toFixed(2);
          jump = '<a class="link-jump" data-jump="ledger" data-code="' + esc(it.code) + '">查科目账</a>';
        } else {
          detail = esc(JSON.stringify(it).slice(0, 100));
        }
        html += '<td>' + detail + '</td>';
        html += '<td class="issue-text">' + esc(it.issue || '') + '</td>';
        html += '<td class="ta-c">' + jump + '</td>';
        html += '</tr>';
      });
    });
    html += '</tbody>';
    tbEl.innerHTML = html;
  }
  // 穿透链接：全局事件委托，只处理风险检测卡片内的 .link-jump
  document.addEventListener('click', function (e) {
    var a = e.target.closest('.link-jump');
    if (!a) return;
    if (!a.closest('#healthCheckCard')) return;
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
  var multiAisFile = document.getElementById('multiAisFile');
  if (multiAisFile) {
    multiAisFile.addEventListener('change', function () {
      if (this.files && this.files.length) handleMultiYearImport(this.files);
    });
  }

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
        // 账套 id：文件名去后缀 + 时间戳，避免覆盖同目录同名导入
        var base = (file.name || 'kis').replace(/\.[^.]+$/, '');
        var bid = base + '_' + Date.now();
        loadServerBookIntoLocal(bid, book);
        // 立即持久化到本地
        if (S && S.persist) S.persist();
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
        showToast(tip);
        refreshBookManage();
        if (window.__refreshAll) window.__refreshAll();
      })
      .catch(function (e) {
        showToast('导入失败：' + (e && e.message || e), 'error');
      });
  }

  // 将导入的账套注入并立即落真实文件（桌面版账套真相源为 <应用数据目录>/添钰财务/books/）。
  // 不再写 kis_books localStorage 缓存（账套以磁盘为准），仅记录当前账套指针到 meta。
  function loadServerBookIntoLocal(id, book) {
    S.bookId = id; S.state = book;
    if (S.state.schemaVersion == null) S.state.schemaVersion = S.SCHEMA_VERSION; // 导入账套补版本号，避免每次加载误判版本冲突
    // 补全账套字段并自动判定会计准则（导入不含 standard 字段，按科目 5xxx/6xxx 自动判定，
    // 避免一律默认为旧准则把 6xxx 小企业准则账套标错）；normalizeState 内部含 detectStandardBySubjects 判定。
    if (typeof S.normalizeState === 'function') { try { S.normalizeState(); } catch (e) { console.warn('normalizeState 失败：' + e); } }
    S.ensureCashFlowMap();
    // 立即落真实文件（<应用数据目录>/添钰财务/books/<id>.json），不依赖防抖，防止刷新后丢失
    if (typeof window.Storage !== 'undefined') {
      window.Storage.saveBook(id, JSON.stringify(S.state)).catch(function (e) {
        showToast('导入账套落盘失败：' + (e && e.message || e), 'error');
      });
    }
    // 记录「当前账套指针」到磁盘 meta，保证重开默认进入该导入账套
    try { if (typeof S.setCurrentBookMeta === 'function') S.setCurrentBookMeta(id); } catch (e) {}
    S.addLog('导入账套', '导入账套 ' + id + '（' + (book.subjects ? book.subjects.length : 0) + ' 科目 / ' + (book.vouchers ? book.vouchers.length : 0) + ' 凭证）', '账套');
    if (typeof S.refreshBookIndex === 'function') S.refreshBookIndex();
  }
  $('btnBmImport').addEventListener('click', function () { if (bmFile) bmFile.click(); });

// —— 系统设置聚合页（系统参数 + 凭证模板 + 操作日志 三 Tab 合一）——
function refreshParam() {
  var p = S.state.param;
  var c = S.state.company || {};
  // 基本信息只读展示：公司名称（改名走「账套管理」）、启用期间（点「修改」弹窗调整）
  var nmEl = $('sysNameVal'); if (nmEl) nmEl.textContent = c.name || '';
  var stEl = $('sysStartVal'); if (stEl) stEl.textContent = c.startMonth || '';
  // 会计制度：只读展示当前准则（由 state.standard 驱动）；变更走受操作密码保护的弹窗
  var curStdKey = S.state.standard || 'old';
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
  var vc = p.voucherChecks || {};
  $('pChkDeficit').checked = !!vc.deficitCheck;
  $('pBookHideZero').checked = !!p.bookHideZero;
  $('pBookExpand').checked = !!p.bookExpandAll;
  $('pChkSettle').checked = !!p.checkBeforeSettle;
  // 事件绑定（一次性）
  if (!globalThis.__paramBound) {
    $('btnSaveParam').addEventListener('click', function () {
      var p = S.state.param;
      // 仅保存凭证/账簿/结账行为选项；公司名称/启用期间/会计制度均不在此保存
      p.voucherChecks = {
        deficitCheck: $('pChkDeficit').checked
      };
      p.bookHideZero = $('pBookHideZero').checked;
      p.bookExpandAll = $('pBookExpand').checked;
      p.checkBeforeSettle = $('pChkSettle').checked;
      S.persist();
      showToast('参数已保存');
    });
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
        var ok = await H.confirmAsync('账套已有凭证 / 期初 / 结账数据。\n\n修改启用期间只影响期间下拉的起点与「启用期间」显示，\n不影响任何凭证与报表数据。\n\n确认将启用期间由「' + (old || '') + '」改为「' + v + '」？', { title: '修改启用期间' });
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
    // 会计制度变更（高危不可逆）：入口收敛为「变更准则…」按钮 → 选择目标准则 → 操作密码 → 二次确认
    var bStdOpen = $('btnChangeStandard');
    if (bStdOpen) bStdOpen.addEventListener('click', function () {
      var curKey = S.state.standard || 'old';
      // 打开弹窗时默认选中「与当前不同」的准则，避免误触
      var radios = document.querySelectorAll('input[name="stdNew"]');
      Array.prototype.forEach.call(radios, function (r) { r.checked = (r.value !== curKey); });
      if (H.openModal) H.openModal('stdChangeModal');
    });
    var bStdDo = $('btnDoChangeStd');
    if (bStdDo) bStdDo.addEventListener('click', async function () {
      var STDSW = (typeof globalThis !== 'undefined' && globalThis.STANDARDS) || {};
      var curKey = S.state.standard || 'old';
      var sel = document.querySelector('input[name="stdNew"]:checked');
      var toKey = sel ? sel.value : '';
      if (!toKey || toKey === curKey) return showToast('请选择与当前不同的会计准则', 'warn');
      // 不可逆高危操作：先验证操作密码（可逆免密 / 不可逆必密）
      if (!(await H.askOpPassword('切换会计准则'))) return;
      var curLabel = (STDSW[curKey] && STDSW[curKey].label) || curKey;
      var toLabel = (STDSW[toKey] && STDSW[toKey].label) || toKey;
      var ok = await H.confirmAsync(
        '当前准则：「' + curLabel + '」\n' +
        '目标准则：「' + toLabel + '」\n\n' +
        '切换将迁移损益类科目编码（5xxx↔6xxx）于科目表 / 期初余额 / 凭证分录 / 现金流映射，\n' +
        '并重灌报表取数规则，不可逆。建议先在「账套管理」做备份。\n\n' +
        '确定要切换吗？',
        { title: '切换会计准则' }
      );
      if (!ok) return;
      var r = S.setStandard(toKey);
      if (r && r.ok) {
        var ch = r.changed || {};
        if (H.closeModal) H.closeModal('stdChangeModal');
        showToast(r.msg + '（改科目 ' + (ch.subjects || 0) +
                 '、凭证 ' + (ch.vouchers || 0) +
                 '、期初 ' + (ch.opening || 0) + '）');
        refreshAll();
      } else {
        showToast((r && r.msg) || '切换失败', 'error');
      }
    });
    var bStdCancel = $('btnCancelStdChange');
    if (bStdCancel) bStdCancel.addEventListener('click', function () { if (H.closeModal) H.closeModal('stdChangeModal'); });
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

