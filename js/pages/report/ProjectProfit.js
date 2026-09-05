// 自 report/Extra.js 拆分（B 方案第 2 批试点）：项目利润表。只挪窝不改写。
import { $, S, money, fmt, goPage, currentPeriod, lastClosedPeriod, esc, num, showToast, nowTimeStr, round2,
  periodRangeOptions, monthsBetween, prevYearMonth, monthLabel, subjectLevel, subjectFilter, getSubjectNameByCode } from './_shared.js';
// ---------- 项目利润表（行=利润表行项目、列=项目；筛选栏=起止期间+核算维度/项目+无发生额不显示，无"报表类型/期间类型"） ----------
const PP_ROWS = [
  { no: 1, name: '一、营业收入', codes: ['5001', '5051'], dir: 'cr' },
  { no: 2, name: '减：营业成本', codes: ['5401', '5402'], dir: 'dr' },
  { no: 3, name: '税金及附加', codes: ['5403'], dir: 'dr' },
  { no: 4, name: '销售费用', codes: ['5601'], dir: 'dr' },
  { no: 5, name: '管理费用', codes: ['5602'], dir: 'dr' },
  { no: 6, name: '研发费用', codes: ['5604'], dir: 'dr' },
  { no: 7, name: '财务费用', codes: ['5603'], dir: 'dr' },
  { no: 8, name: '其中：利息费用', codes: [], dir: 'dr', nameMatch: ['利息费用', '利息支出'] },
  { no: 9, name: '利息收入', codes: [], dir: 'cr', nameMatch: ['利息收入'] },
  { no: 10, name: '加：其他收益', codes: ['6117'], dir: 'cr' },
  { no: 11, name: '投资收益（损失以"-"号填列）', codes: ['5111'], dir: 'cr' },
  { no: 12, name: '以摊余成本计量的金融资产终止确认收益（损失以"-"号填列）', codes: [], dir: 'cr' },
  { no: 13, name: '其中：对联营企业和合营企业的投资收益', codes: [], dir: 'cr' },
  { no: 14, name: '净敞口套期收益（损失以"-"号填列）', codes: [], dir: 'cr' },
  { no: 15, name: '公允价值变动收益（损失以"-"号填列）', codes: ['6101'], dir: 'cr' },
  { no: 16, name: '信用减值损失（损失以"-"号填列）', codes: ['6702'], dir: 'dr' },
  { no: 17, name: '资产减值损失（损失以"-"号填列）', codes: ['6701'], dir: 'dr' },
  { no: 18, name: '资产处置收益（损失以"-"号填列）', codes: ['5302'], dir: 'cr' },
  { no: 19, name: '二、营业利润（亏损以"-"号填列）', calc: 'op' },
  { no: 20, name: '加：营业外收入', codes: ['5301'], dir: 'cr' },
  { no: 21, name: '减：营业外支出', codes: ['5711'], dir: 'dr' },
  { no: 22, name: '三、利润总额（亏损总额以"-"号填列）', calc: 'tp' },
  { no: 23, name: '减：所得税费用', codes: ['5801'], dir: 'dr' },
  { no: 24, name: '四、净利润（净亏损以"-"号填列）', calc: 'np' },
  { no: 25, name: '（一）持续经营净利润（净亏损以"-"号填列）', calc: 'con' },
  { no: 26, name: '（二）终止经营净利润（净亏损以"-"号填列）', calc: 'term' },
  { no: 27, name: '五、其他综合收益的税后净额', codes: [], dir: 'cr' },
  { no: 28, name: '（一）不能重分类进损益的其他综合收益', codes: [], dir: 'cr' },
  { no: 29, name: '1. 重新计量设定受益计划变动额', codes: [], dir: 'cr' },
  { no: 30, name: '2. 权益法下不能转损益的其他综合收益', codes: [], dir: 'cr' },
  { no: 31, name: '3. 其他权益工具投资公允价值变动', codes: [], dir: 'cr' },
  { no: 32, name: '4. 企业自身信用风险公允价值变动', codes: [], dir: 'cr' },
  { no: 33, name: '5. 其他', codes: [], dir: 'cr' },
  { no: 34, name: '（二）将重分类进损益的其他综合收益', codes: [], dir: 'cr' },
  { no: 35, name: '1. 权益法下可转损益的其他综合收益', codes: [], dir: 'cr' },
  { no: 36, name: '2. 其他债权投资公允价值变动', codes: [], dir: 'cr' },
  { no: 37, name: '3. 金融资产重分类计入其他综合收益的金额', codes: [], dir: 'cr' },
  { no: 38, name: '4. 其他债权投资信用减值准备', codes: [], dir: 'cr' },
  { no: 39, name: '5. 现金流量套期储备', codes: [], dir: 'cr' },
  { no: 40, name: '6. 外币财务报表折算差额', codes: [], dir: 'cr' },
  { no: 41, name: '7. 其他', codes: [], dir: 'cr' },
  { no: 42, name: '六、综合收益总额', calc: 'ci' },
  { no: 43, name: '七、每股收益', codes: [], dir: 'cr' },
  { no: 44, name: '（一）基本每股收益', codes: [], dir: 'cr' },
  { no: 45, name: '（二）稀释每股收益', codes: [], dir: 'cr' }
];

export function renderProjectProfit() {
  bindPP();
  fillPPFilters();
  refreshPP();
}

function bindPP() {
  if (window.__ppBound) return;
  window.__ppBound = true;
  // 刷新时同时重填项目下拉（如刚在「设置-辅助核算」新增了档案），再重算表格
  $('btnPpQuery') && $('btnPpQuery').addEventListener('click', () => { fillPPProjects(); refreshPP(); });
  // btnPpPrint 已加 data-print，由全局委托统一走 kdPrint()。
  $('btnPpExport') && $('btnPpExport').addEventListener('click', exportPP);
  $('ppAuxType') && $('ppAuxType').addEventListener('change', () => { fillPPProjects(); refreshPP(); });
  $('ppFrom') && $('ppFrom').addEventListener('change', refreshPP);
  $('ppTo') && $('ppTo').addEventListener('change', refreshPP);
  $('ppNoZero') && $('ppNoZero').addEventListener('change', refreshPP);
  bindPPProjectPop();
}

// 项目多选浮层（与费用明细表「科目」选择框同款交互：触发框+标签+勾选浮层；项目档案为扁平列表，无树级）
function bindPPProjectPop() {
  const wrap = $('ppProjectWrap'), trigger = $('ppProjectTrigger'), pop = $('ppProjectPop');
  if (!wrap || !trigger || !pop) return;
  trigger.addEventListener('click', e => {
    if (e.target.closest('.ed-subj-tag-close')) return;
    pop.hidden = !pop.hidden;
  });
  // 弹层内：全选 / 勾选（委托，pop 内容每次重建但监听挂在 pop 容器上，仅绑定一次）
  pop.addEventListener('click', e => {
    const allBox = e.target.closest('#ppSelectAll');
    if (allBox) {
      pop.querySelectorAll('input[type=checkbox][data-pp]').forEach(i => i.checked = allBox.checked);
      syncPPTags(); return;
    }
    if (e.target.closest('input[type=checkbox][data-pp]')) { syncPPTags(); return; }
  });
  // 点击页面其它处关闭浮层并刷新报表（勾选不立即刷新，关闭才出数）
  document.addEventListener('click', e => {
    if (pop.hidden) return;
    if (!wrap.contains(e.target)) { pop.hidden = true; refreshPP(); }
  });
  // 删除标签
  const tagsBox = $('ppProjectTags');
  if (tagsBox) {
    tagsBox.addEventListener('click', e => {
      const close = e.target.closest('.ed-subj-tag-close');
      if (!close) return;
      e.stopPropagation();
      const cb = pop.querySelector(`input[type=checkbox][data-pp][value="${close.dataset.id}"]`);
      if (cb) {
        cb.checked = false;
        // 允许删空：全部不选时触发器显示「全部项目」，refreshPP 按该维度全部项目各一列出表
        syncPPTags();
      }
      refreshPP();
    });
  }
}

function fillPPFilters() {
  const from = $('ppFrom'), to = $('ppTo');
  if (from && to) {
    const opts = periodRangeOptions();
    from.innerHTML = opts;
    to.innerHTML = opts;
    const lp = lastClosedPeriod();
    from.value = lp;
    to.value = lp;
  }
  // 同步起止期间选择器触发器文本
  if (window.__EXTRA_UPDATE_PERIOD_TRIGGER__) {
    window.__EXTRA_UPDATE_PERIOD_TRIGGER__('ppFrom', 'ppTo');
  }
  const auxSel = $('ppAuxType');
  if (auxSel) {
    const types = (S.AUX_TYPES || S.auxTypes ? (S.AUX_TYPES || S.auxTypes()) : []);
    const list = Array.isArray(types) ? types : [];
    // 默认部门。但部门无档案而其他类型有档案时，自动切到第一个有档案的类型，
    // 避免"在设置里新增了核算项目档案、回来却仍看不到"（档案按账套+类型隔离）
    const hasItems = k => (S.auxItems ? S.auxItems(k).length : 0);
    let defKey = 'dept';
    if (!hasItems('dept') && list.length) {
      const first = list.find(t => hasItems(t.key));
      if (first) defKey = first.key;
    }
    auxSel.innerHTML = list.map(t => `<option value="${t.key}" ${t.key === defKey ? 'selected' : ''}>${t.name || t.label}</option>`).join('');
  }
  fillPPProjects();
}

function fillPPProjects() {
  const pop = $('ppProjectPop'), tagsBox = $('ppProjectTags');
  if (!pop || !tagsBox) return;
  const auxType = $('ppAuxType') ? $('ppAuxType').value : 'dept';
  const items = S.auxItems ? S.auxItems(auxType) : [];
  const typeName = S.auxTypeName ? S.auxTypeName(auxType) : '核算项目';
  if (!items.length) {
    pop.innerHTML = `<div class="ed-subj-tree"><div class="ed-subj-empty">暂无${typeName}档案，请先在「设置-辅助核算」维护</div></div>`;
    const ph = $('ppProjectPlaceholder');
    if (ph) ph.textContent = `（暂无${typeName}档案）`;
    const cnt = $('ppProjectCount');
    if (cnt) cnt.textContent = '0';
    return;
  }
  pop.innerHTML = `<div class="ed-subj-tree">${items.map(it =>
    `<div class="ed-subj-node"><div class="ed-subj-row">
      <span class="ed-subj-toggle empty"></span>
      <input type="checkbox" value="${it.id}" data-pp="1">
      <label>${esc(it.name)}</label>
    </div></div>`).join('')}</div>
    <div class="ed-subj-foot">
      <label><input type="checkbox" id="ppSelectAll" data-act="all"> 全选</label>
      <span class="ed-subj-count" id="ppSubjCount">已选 <strong>0</strong> 项</span>
    </div>`;
  // 默认勾选首个项目，（默认取首个项目出表）
  const first = pop.querySelector('input[type=checkbox][data-pp]');
  if (first) first.checked = true;
  syncPPTags();
}

// 同步项目选择框的标签/计数/全选状态（供浮层勾选与标签删除共用）
function syncPPTags() {
  const pop = $('ppProjectPop'), tagsBox = $('ppProjectTags');
  if (!pop) return;
  const auxType = $('ppAuxType') ? $('ppAuxType').value : 'dept';
  const items = S.auxItems ? S.auxItems(auxType) : [];
  const byId = {};
  items.forEach(it => { byId[it.id] = it.name; });
  const checked = Array.from(pop.querySelectorAll('input[type=checkbox][data-pp]:checked')).map(i => i.value);
  if (tagsBox) {
    if (!checked.length) {
      tagsBox.innerHTML = `<span class="ed-subj-placeholder">全部项目</span>`;
    } else {
      const first = byId[checked[0]] || checked[0];
      const more = checked.length > 1 ? `<span class="ed-subj-more">+${checked.length - 1}</span>` : '';
      tagsBox.innerHTML = `<span class="ed-subj-tag" data-id="${checked[0]}">${esc(first)}<span class="ed-subj-tag-close" data-id="${checked[0]}">×</span></span>${more}`;
    }
  }
  const cnt = $('ppProjectCount');
  if (cnt) cnt.textContent = String(checked.length);
  const footCnt = $('ppSubjCount');
  if (footCnt) footCnt.innerHTML = `已选 <strong>${checked.length}</strong> 项`;
  const allBox = $('ppSelectAll');
  if (allBox) {
    const all = Array.from(pop.querySelectorAll('input[type=checkbox][data-pp]'));
    allBox.checked = all.length > 0 && all.every(i => i.checked);
  }
}

// 当前勾选的项目列表（供 refreshPP 取数）
function ppSelectedProjects(auxType) {
  const pop = $('ppProjectPop');
  if (!pop) return [];
  const items = S.auxItems ? S.auxItems(auxType) : [];
  const byId = {};
  items.forEach(it => { byId[it.id] = it.name; });
  return Array.from(pop.querySelectorAll('input[type=checkbox][data-pp]:checked'))
    .map(i => ({ id: i.value, name: byId[i.value] || i.value }));
}

// 按「列」预聚合一次分录索引（项目利润表性能优化）：
// 每列（=一个核算项目）只遍历一遍期间内全部分录，按科目 code 精确累计 + 保留分录供名称匹配，
// 之后 45 行取数都从索引查，避免原来「行×列×期间×分录」的重复全量遍历导致切换卡顿。
function ppIndexFor(months, auxType, auxId) {
  const filterAux = !!auxType && auxId !== '__ALL__';
  const map = {};      // code -> {dr, cr}
  const nameList = []; // 供 nameMatch（利息费用/利息收入等名称关键词行）逐分录匹配
  months.forEach(m => {
    (S.periodVouchers(m) || []).forEach(v => {
      (v.entries || []).forEach(e => {
        // 退化模式：未选核算维度（auxType 为空）或账套无该辅助核算（auxId='__ALL__'）时，不过滤 aux，按全账套合计
        if (filterAux && (!e.aux || e.aux.type !== auxType || e.aux.id !== auxId)) return;
        const dr = Number(e.dr || 0);
        const cr = Number(e.cr || 0);
        const a = map[e.code] || (map[e.code] = { dr: 0, cr: 0 });
        a.dr += dr;
        a.cr += cr;
        nameList.push(e);
      });
    });
  });
  return { map, nameList };
}

// 从列索引取单个利润表行的金额（codes 前缀上卷查 map，nameMatch 名称关键词遍历 nameList）
function ppCellFromIndex(idx, codes, dir, nameMatch) {
  const hasCodes = codes && codes.length;
  const hasName = nameMatch && nameMatch.length;
  // 空 codes 且无名称匹配：该行不参与取数（防止把所有分录误累加，如利息收入几百万的 bug）
  if (!hasCodes && !hasName) return 0;
  let sum = 0;
  if (hasCodes) {
    const map = idx.map;
    for (const code in map) {
      if (codes.some(c => code === c || code.startsWith(c))) {
        sum += dir === 'dr' ? map[code].dr : map[code].cr;
      }
    }
  } else if (hasName) {
    idx.nameList.forEach(e => {
      const nm = e.name || (S.subjectName && S.subjectName(e.code)) || '';
      if (!nameMatch.some(k => nm.indexOf(k) >= 0)) return;
      sum += dir === 'dr' ? Number(e.dr || 0) : Number(e.cr || 0);
    });
  }
  return round2(sum);
}

function ppNameClass(name) {
  if (!name) return '';
  if (/^[一二三四五六七八九十、]/.test(name)) return 'pp-row-bold';
  if (/^（/.test(name)) return 'pp-indent-1';
  if (/^\d+\./.test(name)) return 'pp-indent-2';
  if (/^(其中|减|加)：/.test(name)) return 'pp-indent-1';
  return '';
}

function refreshPP() {
  const auxType = $('ppAuxType') ? $('ppAuxType').value : 'dept';
  let projects = ppSelectedProjects(auxType);
  if (!projects.length && S.auxItems) {              // 空选择（用户删光标签）= 全部项目各一列
    const all = S.auxItems(auxType) || [];
    if (all.length) projects = all.map(it => ({ id: it.id, name: it.name }));
  }
  // 退化模式：未选核算维度（auxType 为空）或账套无该辅助核算时，退化为单列「全账套合计」
  const hasAux = !!(auxType && (S.auxItems ? S.auxItems(auxType).length : 0));
  if (!hasAux) projects = [{ id: '__ALL__', name: '全账套合计' }];
  // 列结构：行=利润表行项目；列=所选项目（每项目一列）+ 合计；期间=所选起止范围逐月取数
  const start = $('ppFrom') ? $('ppFrom').value : currentPeriod();
  const end = $('ppTo') ? $('ppTo').value : currentPeriod();
  const noZero = $('ppNoZero') && $('ppNoZero').checked;

  const columns = projects.map(p => ({ key: p.id, name: p.name }));

  // 每列预聚合一次分录索引，全部 45 行共享，避免重复全量遍历
  const months = monthsBetween(start, end);
  const colIdx = columns.map(col => ppIndexFor(months, auxType, col.key));

  const rows = PP_ROWS.map(r => {
    const cells = {};
    let total = 0;
    if (r.codes && !r.calc) {
      columns.forEach((col, i) => {
        const v = ppCellFromIndex(colIdx[i], r.codes, r.dir, r.nameMatch);
        cells[col.key] = v;
        total += v;
      });
    }
    return { ...r, cells, total: round2(total) };
  });

  rows.forEach(r => {
    if (!r.calc) return;
    let total = 0;
    columns.forEach(col => {
      const c = col.key;
      let v = 0;
      if (r.calc === 'op') {
        // 营业利润 = 营业收入 - 营业成本 - 税金及附加 - 销售/管理/研发/财务费用
        // + 其他收益 + 投资收益 + 净敞口 + 公允价值变动 + 信用减值 + 资产减值 + 资产处置收益
        v = (rows[0].cells[c] || 0) + (rows[9].cells[c] || 0) + (rows[10].cells[c] || 0)
          + (rows[11].cells[c] || 0) + (rows[12].cells[c] || 0) + (rows[13].cells[c] || 0)
          + (rows[14].cells[c] || 0) + (rows[15].cells[c] || 0) + (rows[16].cells[c] || 0)
          + (rows[17].cells[c] || 0)
          - (rows[1].cells[c] || 0) - (rows[2].cells[c] || 0)
          - (rows[3].cells[c] || 0) - (rows[4].cells[c] || 0) - (rows[5].cells[c] || 0)
          - (rows[6].cells[c] || 0);
        // 注：其中：利息费用(r7)/利息收入(r8)为财务费用(r6)子项，已并入 r6，不再单独加减
      } else if (r.calc === 'tp') {
        v = (rows[18].cells[c] || 0) + (rows[19].cells[c] || 0) - (rows[20].cells[c] || 0);
      } else if (r.calc === 'np') {
        v = (rows[21].cells[c] || 0) - (rows[22].cells[c] || 0);
      } else if (r.calc === 'con') {
        v = (rows[23].cells[c] || 0);            // 持续经营净利润 = 净利润
      } else if (r.calc === 'term') {
        v = 0;                                   // 终止经营净利润（一般账套为 0）
      } else if (r.calc === 'ci') {
        v = (rows[23].cells[c] || 0) + (rows[26].cells[c] || 0);
      }
      v = round2(v);
      r.cells[c] = v;
      total += v;
    });
    r.total = round2(total);
  });

  const displayRows = noZero
    ? rows.filter(r => Math.abs(r.total) > 0.005 || Object.values(r.cells).some(v => Math.abs(v) > 0.005))
    : rows;

  const thead = $('ppHead');
  if (thead) {
    const colN = 2 + columns.length + 1;
    const periodText = `${monthLabel(start)} 至 ${monthLabel(end)}`;
    thead.innerHTML =
      '<tr class="grid-title" id="ppTitleRow"></tr>' +
      '<tr>' +
      '<th class="col-name pp-name-col">项目</th>' +
      '<th class="col-no">行次</th>' +
      columns.map(c => `<th class="col-amt" title="${c.name}">${c.name}</th>`).join('') +
      '<th class="col-amt">合计</th>' +
      '</tr>';
    if (globalThis.setRptHead) globalThis.setRptHead('ppTitleRow', '项目利润表', colN, null, periodText);
  }

  const tbody = $('ppBody');
  if (tbody) {
    tbody.innerHTML = displayRows.map(r => {
      if (!r.name) return '<tr><td colspan="100" class="pp-empty-row"></td></tr>';
      const cls = ppNameClass(r.name);
      const cellsHtml = columns.map(c => `<td class="col-amt">${money(r.cells[c.key] || 0)}</td>`).join('');
      return `<tr class="${r.no === '' ? 'pp-dots' : ''}">` +
        `<td class="col-name pp-name-col ${cls}">${esc(String(r.name || ''))}</td>` +
        `<td class="col-no">${String(r.no)}</td>` +
        cellsHtml +
        `<td class="col-amt">${money(r.total || 0)}</td>` +
        '</tr>';
    }).join('') || '<tr><td colspan="3" class="text-center">无数据</td></tr>';
  }

  const foot = $('ppFoot');
  if (foot) foot.textContent = `1 - ${displayRows.length} 共 ${displayRows.length} 条`;
}

function exportPP() {
  const headEl = $('ppHead');
  const bodyEl = $('ppBody');
  if (!bodyEl) return showToast('表格尚未渲染', 'warn');
  const rows = [];
  const tdsHead = (headEl || {}).querySelectorAll('th');
  const headers = Array.from(tdsHead).map(th => th.textContent);
  bodyEl.querySelectorAll('tr').forEach(tr => {
    const td = tr.querySelectorAll('td');
    if (td.length < 3) return;
    rows.push(Array.from(td).map(d => d.textContent));
  });
  if (!rows.length) return showToast('无数据可导出', 'warn');
  const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  const fname = `项目利润表_${currentPeriod()}.csv`;
  __safeExportCsv('\ufeff' + csv, fname);
}

// ---------- 费用明细表（期间范围 + 树形多栏表） ----------
