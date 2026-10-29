// 部门档案卡片（2026-10-27 从 js/pages/salary/Salary.js 迁入「系统设置」）
//
// 为什么搬：部门是账套级**基础资料**（与科目、凭证字同级），资产卡片只是它目前唯一的使用方。
// 原先渲染与事件都住在工资页，资产页要靠 main.js 的全局钩子 __renderDeptStaff 去「借」——
// 工资模块一旦隐藏或移除，资产页的「部门」按钮立刻变哑。搬过来之后，删不删工资都与它无关。
// 形态也从 780px 弹窗改成页内卡片（与相邻的「凭证字」卡片同构）：低频基础配置不需要遮罩中断。
//
// 另外去掉原表格里的「职员投影」：那几行是从 S.state.payrolls 反推姓名的，本机两本真实账套
// payrolls 恒为 0，永远渲染不出内容，只会让部门表看起来"混着两种东西"。现在就是纯部门表。

import { H, $, S, showToast } from '../../common/helpers.js?v=dev';
import { html } from '../../common/html.js?v=dev';

/* 表格渲染（3 列：编码 / 名称 / 操作）。列的定宽在 css 的 #deptGrid 规则里。 */
function renderDeptBody() {
  var tb = $('deptBody');
  if (!tb) return;                       // 极端情况：卡片未装配（不该发生，但别抛）
  var list = S.depts();                  // 缺省自动种子，与资产卡片的部门下拉同源
  tb.innerHTML = '';
  list.forEach(function (d, i) {
    var tr = document.createElement('tr');
    // html`` 插值默认转义：部门名/编码都是用户可编辑字段，属性上下文同样安全
    // 已引用的部门不可删（硬删会造悬空引用）：链接置灰，点它给明确指引。未引用才可删。
    var used = (S.state.fixedAssets || []).filter(function (fa) { return String(fa.dept == null ? '' : fa.dept) === d.name; }).length;
    var delCls = used > 0 ? 'link-del disabled' : 'link-del';
    tr.innerHTML = html`<td class="mono col-code">${d.code}</td><td>${d.name}</td><td><a class="link-edit" data-edit-dept="${i}">编辑</a> <a class="link-toggle" data-i="${i}">${d.enabled === false ? '启用' : '停用'}</a> <a class="${delCls}" data-del-dept="${i}">删除</a></td>`;
    tb.appendChild(tr);
  });
  if (!list.length) tb.innerHTML = '<tr><td colspan="3" class="empty-hint">暂无部门</td></tr>';
}

/* 系统设置页刷新入口（由 Settings.js 的 refreshSystemSettings 调用）。 */
export function refreshDeptCard() {
  S.depts();
  renderDeptBody();
}

/* ===== 事件绑定（模块加载时绑一次，表格重渲染不受影响） ===== */
(function bindDeptCard() {
  var body = $('deptBody');
  if (body) {
    body.addEventListener('click', async function (e) {
      var t = e.target;

      // 启用 / 停用
      var toggle = t.closest && t.closest('a.link-toggle[data-i]');
      if (toggle) {
        var ti = +toggle.getAttribute('data-i');
        var td = S.depts()[ti];
        if (!td) return;
        var disabling = !(td.enabled === false);
        if (disabling && !(await H.confirmAsync('确认停用部门「' + td.name + '」？\n停用后新增资产卡片不能再选该部门，历史数据保留。', { title: '停用部门' }))) return;
        var r0 = S.setDeptEnabled(ti, !disabling);
        if (!r0.ok) return showToast(r0.msg, 'error');
        renderDeptBody();
        showToast(disabling ? '已停用' : '已启用');
        return;
      }

      // 删除（仅未引用部门可删；被引用时链接置灰，点它给明确指引）
      var delA = t.closest && t.closest('a[data-del-dept]');
      if (delA) {
        if (delA.classList.contains('disabled')) {
          showToast('该部门已被资产卡片使用，无法删除。请先到资产页将这些卡片的「使用部门」改为其它部门，或停用该部门。', 'error');
          return;
        }
        var di = +delA.getAttribute('data-del-dept');
        var dd = S.depts()[di];
        if (!dd) return;
        if (!(await H.confirmAsync('确认删除部门「' + dd.name + '」？删除后不可恢复。\n\n注意：已有资产卡片使用该部门的不可删除，请改用「停用」。', { title: '删除部门' }))) return;
        var r1 = S.removeDept(di);
        if (!r1.ok) return showToast(r1.msg, 'error');
        renderDeptBody();
        showToast('已删除部门「' + dd.name + '」');
        return;
      }

      // 编辑（改名 / 改编码）：两步 prompt，默认值预填当前值，任一步取消即整体放弃。
      // 落库与「回写所有引用该部门的资产卡片」都在 store.renameDept 里（两件事不能拆开做）。
      var editA = t.closest && t.closest('a[data-edit-dept]');
      if (!editA) return;
      e.preventDefault();
      var i = +editA.getAttribute('data-edit-dept');
      var d = S.depts()[i];
      if (!d) return;
      var name = await H.promptAsync('部门名称：', d.name, { title: '编辑部门' });
      if (name === null) return;
      var code = await H.promptAsync('部门编码：', d.code, { title: '编辑部门' });
      if (code === null) return;
      var r = S.renameDept(i, name, code);
      if (!r.ok) return showToast(r.msg, 'error');
      renderDeptBody();
      // 改名会顺手同步资产卡片的部门字段，必须说出来 —— 否则用户不知道改档案还动了数据
      showToast('已保存' + (r.renamed ? '，并同步了 ' + r.touched + ' 张资产卡片的部门' : ''), 'success');
    });
  }

  var addBtn = $('btnAddDept');
  if (addBtn) {
    addBtn.addEventListener('click', async function () {
      var name = await H.promptAsync('部门名称：', '', { title: '新增部门' });
      if (!name || !name.trim()) return;
      // 编码由 store.addDept 自动按现有最大值+1 生成（与资产卡片表单内联新增一致），无需用户手填。
      var r = S.addDept({ name: name.trim() });
      if (!r.ok) return showToast(r.msg, 'error');
      renderDeptBody();
      showToast('已新增部门「' + name.trim() + '」');
    });
  }
})();
