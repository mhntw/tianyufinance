// 页面模块（B 方案解耦，由 tools/migrate_domain.py 生成骨架）
// 依赖全部从全局桥接对象取，逻辑与 app.js 原实现逐字一致（只挪窝不改写）。
// 设计：globalThis.__TY_HELPERS__（app.js 注册）、globalThis.__TY_EXPORT__（store.js 注册）。
// 模块不 import store.js（避免 IIFE 双执行），统一从全局取已加载单例。

const H = globalThis.__TY_HELPERS__ || {};
const EX = globalThis.__TY_EXPORT__ || {};
const $ = H.$;
const money = H.money;
const esc = H.esc;
const showToast = H.showToast;
const currentPeriod = H.currentPeriod;
const syncAll = H.syncAll;
const S = H.S || (EX && EX.store);
const U = H.U || (EX && EX.util);
const num = H.num || (U && U.num) || function (v) { var n = parseFloat(v); return isNaN(n) ? 0 : n; };
// 全局常量（store.js 挂在 global 上的 ACCOUNT_CLASSES 等）
const ACCOUNT_CLASSES = globalThis.ACCOUNT_CLASSES || (EX && EX.ACCOUNT_CLASSES);
// 起止期间取值：统一走 app.js 的单点实现（H.periodRangeValue）。
// 复用统一期间取值实现，避免多份拷贝失同步。
// 口径：回填默认期间 + 同步触发器文本，返回结束期间。
const periodRangeValue = H.periodRangeValue;

  /* ============================================================
   * 工资
   * ============================================================ */
  function refreshSalary() {
    var month = periodRangeValue('salPeriod');
    renderSalary(month);
  }
  function renderSalary(month) {
    var tb = $('salBody'); tb.innerHTML = '';
    S.state.payrolls.filter(function (p) { return !month || p.month === month; }).forEach(function (p) {
      var tr = document.createElement('tr');
      tr.innerHTML = '<td>' + p.month + '</td><td>' + p.name + '</td><td>' + (p.category || '全部') + '</td><td class="ta-r mono">' + money(p.should) + '</td><td class="ta-r mono">' + money(p.real) + '</td><td><a class="link-del" data-id="' + p.id + '">删除</a></td>';
      tb.appendChild(tr);
    });
  }
  $('salBody').addEventListener('click', async function (e) {
    if (e.target.classList.contains('link-del')) {
      var pid = e.target.getAttribute('data-id');
      var r0 = S.removePayroll(pid);
      if (!r0.ok) return showToast(r0.msg, 'error');
      // 期间取自统一入口 periodRangeValue('salPeriod')：本页没有 salPeriodEnd 元素
      // （原写法 $('salPeriodEnd').value 恒为 null 解引用 → 删工资必抛「系统异常」）
      renderSalary(periodRangeValue('salPeriod')); showToast('已删除');
    }
  });
  $('btnNewSalary').addEventListener('click', function () {
    $('sMonth').value = currentPeriod();
    $('salaryModal').classList.add('show');
  });
  $('btnCloseSalary').addEventListener('click', function () { $('salaryModal').classList.remove('show'); });
  $('btnSaveSalary').addEventListener('click', function () {
    S.addPayroll({ month: $('sMonth').value, name: $('sName').value, category: $('sCat').value || '', should: U.num($('sShould').value), real: U.num($('sReal').value) });
    $('salaryModal').classList.remove('show');
    $('sName').value = ''; $('sShould').value = ''; $('sReal').value = ''; $('sCat').value = '';
    renderSalary(periodRangeValue('salPeriod')); showToast('工资已保存');
  });
  $('btnGenSalaryAccrual').addEventListener('click', function () {
    var month = periodRangeValue('salPeriod') || currentPeriod();
    var r = S.genPayrollVoucher(month, 'accrual');
    if (!r.ok) return showToast(r.msg, 'error');
    showToast('已生成计提工资凭证 ' + r.voucher.word + '-' + r.voucher.no);
    syncAll();
  });
  $('btnGenSalaryPay').addEventListener('click', function () {
    var month = periodRangeValue('salPeriod') || currentPeriod();
    var r = S.genPayrollVoucher(month, 'pay');
    if (!r.ok) return showToast(r.msg, 'error');
    showToast('已生成发放工资凭证 ' + r.voucher.word + '-' + r.voucher.no);
    syncAll();
  });

  /* ============================================================
   * 工资统计 / 部门职员（新手导航静态页已随外观简化移除）
   * ============================================================ */
  function refreshSalaryStats() {
    var month = periodRangeValue('sstPeriod');
    renderSalaryStats(month);
  }
  function renderSalaryStats(month) {
    var tb = $('sstBody'); tb.innerHTML = '';
    var rows = {};
    S.state.payrolls.forEach(function (p) {
      if (month && p.month !== month) return;
      var r = rows[p.month] || (rows[p.month] = { month: p.month, cat: '工资', n: 0, should: 0, real: 0 });
      r.n += 1; r.should += (+p.should || 0); r.real += (+p.real || 0);
    });
    var list = Object.keys(rows).sort().map(function (k) { return rows[k]; });
    if (!list.length) { tb.innerHTML = '<tr><td colspan="5" class="empty-hint">暂无工资数据</td></tr>'; return; }
    list.forEach(function (r) {
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td>' + r.month + '</td><td>' + r.cat + '</td><td>' + r.n + '</td>' +
        '<td class="ta-r mono">' + money(r.should) + '</td><td class="ta-r mono">' + money(r.real) + '</td>';
      tb.appendChild(tr);
    });
  }
  // 期间变更由期间控件的 data-on-change 直接回调（组件不派发 change 事件），此处无需再绑监听。

  // 默认部门种子已收敛到 store（此前这里另存了一份相同实现）；
  // 本页只经 S.depts() 取用（缺省自动种子，与资产页同源）。
  function refreshDeptStaff() {
    S.depts();
    renderDeptStaff();
  }
  function renderDeptStaff() {
    var tb = $('dsBody'); tb.innerHTML = '';
    var depts = S.depts();
    var staff = {};
    S.state.payrolls.forEach(function (p) { staff[p.name] = true; });
    depts.forEach(function (d, i) {
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td class="mono">' + d.code + '</td><td>' + d.name + '</td><td>' + d.type + '</td>' +
        '<td>' + (d.parent || '—') + '</td><td><a class="link-edit" data-edit-dept="' + i + '">编辑</a> <a class="link-toggle" data-i="' + i + '">' + (d.enabled === false ? '启用' : '停用') + '</a></td>';
      tb.appendChild(tr);
    });
    Object.keys(staff).forEach(function (nm, i) {
      var tr = document.createElement('tr');
      tr.innerHTML = '<td class="mono">E' + (i + 1) + '</td><td>' + nm + '</td><td>职员</td><td>—</td><td><a class="link-del disabled">—</a></td>';
      tb.appendChild(tr);
    });
    if (!depts.length && !Object.keys(staff).length) {
      tb.innerHTML = '<tr><td colspan="5" class="empty-hint">暂无部门职员</td></tr>';
    }
    tb.querySelectorAll('a.link-toggle[data-i]').forEach(function (a) {
      a.addEventListener('click', async function () {
        var i = +this.getAttribute('data-i');
        var d = S.state.depts[i];
        var disabling = !(d && d.enabled === false);
        if (disabling) {
          if (!(await H.confirmAsync('确定停用部门「' + (d ? d.name : '') + '」？\n停用后新增资产/工资等不能再选该部门，历史数据保留。', { title: '停用部门' }))) return;
        }
        d.enabled = disabling ? false : true;
        S.persist(); renderDeptStaff();
      });
    });
  }
  // 编辑部门（改名 / 改编码）。与「新增部门」同款两步 prompt：默认值预填当前值，
  // 想改哪个改哪个、其余直接回车即保持不变；任一步取消即整体放弃。
  // 落库与**回写所有引用该部门的资产卡片**都在 store.renameDept 里（两件事不能拆开做）。
  $('dsBody').addEventListener('click', async function (e) {
    var a = e.target.closest && e.target.closest('a[data-edit-dept]');
    if (!a) return;
    e.preventDefault();
    var i = +a.getAttribute('data-edit-dept');
    var d = S.depts()[i];
    if (!d) return;
    var name = await H.promptAsync('部门名称：', d.name, { title: '编辑部门' });
    if (name === null) return;                       // 取消
    var code = await H.promptAsync('部门编码：', d.code, { title: '编辑部门' });
    if (code === null) return;                       // 取消
    var r = S.renameDept(i, name, code);
    if (!r.ok) return showToast(r.msg, 'error');
    renderDeptStaff();
    // 改名时把「顺手同步了几张卡片」明确说出来 —— 否则用户不知道改档案还动了数据
    showToast('已保存' + (r.renamed ? '，并同步了 ' + r.touched + ' 张资产卡片的部门' : ''), 'success');
  });
  $('btnAddDept').addEventListener('click', async function () {
    var name = await H.promptAsync('部门名称：', '', { title: '新增部门' }); if (!name) return;
    var list = S.depts();
    var code = await H.promptAsync('部门编码：', String(list.length + 1).padStart(3, '0'), { title: '部门编码' }); if (!code) return;
    list.push({ code: code.trim(), name: name.trim(), type: '部门', parent: '', enabled: true });
    S.state.depts = list;
    S.persist(); renderDeptStaff(); showToast('已新增部门');
  });

  /* ============================================================
   * 工资凭证模板
   * 表格列：模板名称 / 凭证类型 / 工资类别 / 凭证字 / 启用 / 模板说明 / 操作
   * ============================================================ */
  function refreshSalaryTpl() {
    renderSalaryTplBody();
  }
  function renderSalaryTplBody() {
    var tb = $('salaryTplBody');
    if (!tb) return;
    var list = S.salaryVchTpls();
    var words = (S.state.voucherWords && S.state.voucherWords.length) ? S.state.voucherWords.filter(function (w) { return w.enabled !== false; }) : [{ name: '记' }];
    var wordOpts = words.map(function (w) {
      return '<option value="' + esc(w.name) + '">' + esc(w.name) + '</option>';
    }).join('');
    tb.innerHTML = '';
    list.forEach(function (t, i) {
      var tr = document.createElement('tr');
      tr.innerHTML =
        // 列宽走全站标准：单元格内输入框一律撑满所在列（宽度由表格自动分配）
        '<td><input class="inp" data-id="' + t.id + '" data-f="name" value="' + esc(t.name) + '"/></td>' +
        '<td><select class="inp" data-id="' + t.id + '" data-f="vchType">' +
          '<option value="计提工资"' + (t.vchType === '计提工资' ? ' selected' : '') + '>计提工资</option>' +
          '<option value="发放工资"' + (t.vchType === '发放工资' ? ' selected' : '') + '>发放工资</option>' +
        '</select></td>' +
        '<td><input class="inp" data-id="' + t.id + '" data-f="category" value="' + esc(t.category) + '"/></td>' +
        '<td><select class="inp" data-id="' + t.id + '" data-f="word">' +
          wordOpts.replace('value="' + esc(t.word) + '"', 'value="' + esc(t.word) + '" selected') +
        '</select></td>' +
        '<td><input type="checkbox" data-id="' + t.id + '" data-f="enabled"' + (t.enabled ? ' checked' : '') + '/></td>' +
        '<td><input class="inp" data-id="' + t.id + '" data-f="memo" value="' + esc(t.memo || '') + '"/></td>' +
        '<td><a class="link-del" data-id="' + t.id + '">删除</a></td>';
      tb.appendChild(tr);
    });
    if (!list.length) tb.innerHTML = '<tr><td colspan="7" class="empty-hint">暂无凭证模板</td></tr>';
    tb.querySelectorAll('input[data-id][data-f],select[data-id][data-f]').forEach(function (el) {
      var ev = el.tagName === 'SELECT' ? 'change' : 'input';
      el.addEventListener(ev, function () {
        var id = this.getAttribute('data-id'), f = this.getAttribute('data-f');
        var val = (f === 'enabled') ? this.checked : this.value;
        S.updateSalaryVchTpl(id, (function () { var o = {}; o[f] = val; return o; })());
      });
    });
    tb.querySelectorAll('a.link-del[data-id]').forEach(function (a) {
      a.addEventListener('click', async function () {
        if (!(await H.confirmAsync('确认删除该工资凭证模板？', { title: '删除模板' }))) return;
        S.removeSalaryVchTpl(this.getAttribute('data-id'));
        renderSalaryTplBody(); showToast('已删除');
      });
    });
  }
  $('btnAddSalaryTpl').addEventListener('click', async function () {
    var name = await H.promptAsync('模板名称：', '计提工资', { title: '新增模板' }); if (name === null) return;
    var type = await H.promptAsync('凭证类型（计提工资/发放工资）：', '计提工资', { title: '凭证类型' }); if (type === null) return;
    S.addSalaryVchTpl({ name: name.trim(), vchType: type.trim(), category: '全部', word: '记', enabled: 1, memo: '' });
    renderSalaryTplBody(); showToast('已新增模板');
  });
  $('btnResetSalaryTpl').addEventListener('click', async function () {
    if (!(await H.confirmAsync('将清空当前模板并恢复默认 13 条，确认？', { title: '恢复默认' }))) return;
    S.resetSalaryVchTpls(); renderSalaryTplBody(); showToast('已恢复默认');
  });

  /* ============================================================
   * 工资基础资料弹窗（外观简化收敛：部门职员 / 凭证模板 并入工资页）
   * ============================================================ */
  (function () {
    var openDept = $('btnOpenDeptStaff');
    if (openDept) openDept.addEventListener('click', function () {
      refreshDeptStaff();                 // 打开时重新渲染部门职员
      var m = $('deptStaffModal'); if (m) m.classList.add('show');
    });
    var closeDept = $('btnCloseDeptStaff');
    if (closeDept) closeDept.addEventListener('click', function () {
      var m = $('deptStaffModal'); if (m) m.classList.remove('show');
    });
    var openTpl = $('btnOpenSalaryTpl');
    if (openTpl) openTpl.addEventListener('click', function () {
      renderSalaryTplBody();              // 打开时重新渲染凭证模板
      var m = $('salaryTplModal'); if (m) m.classList.add('show');
    });
    var closeTpl = $('btnCloseSalaryTpl');
    if (closeTpl) closeTpl.addEventListener('click', function () {
      var m = $('salaryTplModal'); if (m) m.classList.remove('show');
    });
  })();

export {
  refreshSalary, refreshSalaryStats, refreshDeptStaff, refreshSalaryTpl
};

