// 自 report/Extra.js 拆分（B 方案第 2 批试点）：费用明细表。只挪窝不改写。
import { $, S, money, fmt, goPage, currentPeriod, lastClosedPeriod, esc, num, showToast, nowTimeStr, round2,
  periodRangeOptions, monthsBetween, prevYearMonth, monthLabel, subjectLevel, subjectFilter, getSubjectNameByCode } from './_shared.js';
const edState = {
  page: 1,
  pageSize: 500,
  expanded: new Set()           // 手动展开/折叠的 code（与“展开所有级次”互不干扰）
};

export function renderExpenseDetail() {
  try {
    bindED();
    initEDFilters();
    refreshExpenseDetail();
  } catch (e) {
    console.error('[renderExpenseDetail ERROR]', e);
  }
}

function bindED() {
  // 报表选项复选框（年度合计/同环比/展开所有级次/明细科目显示全称/零值）最简实现：
  // index.html 五个 checkbox 直接用原生内联 onchange="__edOptChange()" 触发，
  // 这里只把模块内的刷新入口挂到 window。注册放在 __edBound 检查之前，
  // 保证每次进入页面都一定注册成功，从根本上规避事件委托/绑定时机失效问题。
  window.__edOptChange = function () {
    edState.page = 1;
    refreshExpenseDetail();
  };

  if (window.__edBound) return;
  window.__edBound = true;



  $('edPeriodStart') && $('edPeriodStart').addEventListener('change', () => {
    // 保证 start <= end
    const s = $('edPeriodStart').value;
    const e = $('edPeriodEnd').value;
    if (s > e) $('edPeriodEnd').value = s;
    edState.page = 1;
    refreshExpenseDetail();
  });
  $('edPeriodEnd') && $('edPeriodEnd').addEventListener('change', () => {
    const s = $('edPeriodStart').value;
    const e = $('edPeriodEnd').value;
    if (e < s) $('edPeriodStart').value = e;
    edState.page = 1;
    refreshExpenseDetail();
  });

  $('edPageSize') && $('edPageSize').addEventListener('change', e => {
    edState.pageSize = parseInt(e.target.value, 10) || 500;
    edState.page = 1;
    refreshExpenseDetail();
  });

  $('edPages') && $('edPages').addEventListener('click', e => {
    const li = e.target.closest('li');
    if (!li || li.classList.contains('disabled') || li.classList.contains('active')) return;
    const page = parseInt(li.dataset.page, 10);
    if (!isNaN(page)) {
      edState.page = page;
      refreshExpenseDetail();
    }
  });

  // 树形展开/折叠（事件委托）：操作/分析列已删除，仅名称列内 arrow 触发
  $('edBody') && $('edBody').addEventListener('click', e => {
    const arrow = e.target.closest('.ed-tree-arrow');
    if (arrow) {
      const code = arrow.dataset.c;
      if (edState.expanded.has(code)) edState.expanded.delete(code);
      else edState.expanded.add(code);
      // 取消“展开所有级次”的勾选，避免手动折叠后立即被强制展开
      const opt = $('edOptExpand');
      if (opt && opt.checked) opt.checked = false;
      refreshExpenseDetail();
    }
  });

  // btnEdPrint 已加 data-print，由全局委托统一走 kdPrint()。
  $('btnEdExport') && $('btnEdExport').addEventListener('click', exportED);
}

// 费用明细表可选科目范围：损益类（5/6 开头）
const ED_SUBJECT_RE = /^[56]/;

function edSubjectTree() {
  // 取所有损益类科目，按 code 前缀构造父子树
  const subs = subjectFilter(s => ED_SUBJECT_RE.test(s.code));
  const codes = subs.map(s => s.code);
  const map = {};
  subs.forEach(s => {
    map[s.code] = { code: s.code, name: s.name, level: subjectLevel(s.code), children: [], parent: null };
  });
  const roots = [];
  subs.forEach(s => {
    const node = map[s.code];
    let parent = null;
    for (let i = s.code.length - 1; i >= 4; i--) {
      const prefix = s.code.slice(0, i);
      if (map[prefix]) { parent = map[prefix]; break; }
    }
    node.parent = parent;
    if (parent) parent.children.push(node);
    else roots.push(node);
  });
  const sort = nodes => { nodes.sort((a, b) => a.code.localeCompare(b.code)); nodes.forEach(n => sort(n.children)); };
  sort(roots);
  return { roots, map };
}

function buildEDSubjectPop() {
  const pop = $('edSubjectPop');
  const trigger = $('edSubjectTrigger');
  const tagsBox = $('edSubjectTags');
  const placeholder = $('edSubjectPlaceholder');
  if (!pop || !trigger) return;

  const { roots } = edSubjectTree();
  const expanded = new Set(); // 已展开节点 code

  const render = () => {
    const walk = nodes => nodes.map(n => {
      const hasChildren = n.children && n.children.length;
      const isExpanded = expanded.has(n.code) || !hasChildren;
      const toggleCls = hasChildren ? (isExpanded ? 'expanded' : '') : 'empty';
      const childrenHtml = hasChildren && isExpanded ? `<div class="ed-subj-children">${walk(n.children)}</div>` : '';
      return `<div class="ed-subj-node" data-code="${n.code}">
        <div class="ed-subj-row">
          <span class="ed-subj-toggle ${toggleCls}"></span>
          <input type="checkbox" value="${n.code}" id="ed-subj-${n.code}" data-subj="1">
          <label for="ed-subj-${n.code}">${n.code} ${esc(n.name)}</label>
        </div>
        ${childrenHtml}
      </div>`;
    }).join('');
    const allCbs = () => Array.from(pop.querySelectorAll('input[type=checkbox][data-subj]'));
    const allChecked = () => allCbs().every(i => i.checked);
    pop.innerHTML = '<div class="ed-subj-tree">' + walk(roots) + '</div>' +
      '<div class="ed-subj-foot">' +
      '<label><input type="checkbox" id="edSubjSelectAll" data-act="all"> 全选</label>' +
      '<span class="ed-subj-count" id="edSubjCount">已选 <strong>0</strong> 项</span>' +
      '</div>';
    // 全选 checkbox 默认按当前状态同步（render 可能由展开/折叠触发，此时无 checked 变化）
    const allBox = $('edSubjSelectAll');
    if (allBox) allBox.checked = allChecked();
  };

  const descendants = node => {
    const res = [node];
    (node.children || []).forEach(c => res.push(...descendants(c)));
    return res;
  };

  const getTree = () => edSubjectTree();

  const sync = () => {
    const checked = Array.from(pop.querySelectorAll('input[type=checkbox]:checked')).map(i => i.value);
    const { map } = getTree();
    // 重新计算父子勾选状态：子级全选则父级自动勾选；勾选父级则子级自动勾选
    Object.values(map).forEach(n => n._checked = false);
    checked.forEach(code => { if (map[code]) map[code]._checked = true; });
    // 自下而上：子级全选则父级勾选
    const up = nodes => {
      nodes.forEach(n => {
        if (n.children.length) { up(n.children); if (n.children.every(c => c._checked)) n._checked = true; }
      });
    };
    up(roots);
    // 自上而下：父级勾选则子级全勾选
    const down = nodes => {
      nodes.forEach(n => {
        if (n._checked && n.children.length) n.children.forEach(c => c._checked = true);
        down(n.children);
      });
    };
    down(roots);
    // 同步 checkbox DOM
    Object.values(map).forEach(n => {
      const cb = pop.querySelector(`input[value="${n.code}"]`);
      if (cb) cb.checked = n._checked;
    });
    renderTags();
  };

  const renderTags = () => {
    const { map } = getTree();
    const checked = Array.from(pop.querySelectorAll('input[type=checkbox][data-subj]:checked')).map(i => i.value)
      .filter(code => map[code]);
    // 仅显示顶层勾选（若父级已勾选，不显示子级）
    const top = checked.filter(code => {
      const p = map[code].parent;
      return !p || !checked.includes(p.code);
    });
    if (tagsBox) {
      // 规格：触发框高度固定，只显示最上面选择的一个科目（其余折叠），由右侧「共 N 项」告知总数
      if (!top.length) {
        tagsBox.innerHTML = `<span class="ed-subj-placeholder" id="edSubjectPlaceholder">全部损益科目</span>`;
      } else {
        const n = map[top[0]];
        const more = top.length > 1 ? `<span class="ed-subj-more">+${top.length - 1}</span>` : '';
        tagsBox.innerHTML =
          `<span class="ed-subj-tag" data-code="${n.code}">${esc(n.code)} ${esc(n.name)}<span class="ed-subj-tag-close" data-code="${n.code}">×</span></span>${more}`;
      }
    }
    const cnt = $('edSubjectCount');
    if (cnt) cnt.textContent = String(checked.length);
    const footCnt = $('edSubjCount');
    if (footCnt) footCnt.innerHTML = `已选 <strong>${checked.length}</strong> 项`;
    const allBox = $('edSubjSelectAll');
    if (allBox) {
      const allCbs = Array.from(pop.querySelectorAll('input[type=checkbox][data-subj]'));
      allBox.checked = allCbs.length > 0 && allCbs.every(i => i.checked);
    }
    // 触发报表刷新（避免每次点 checkbox 都刷新，只在关闭浮层或删除 tag 时刷新）
  };

  const removeTag = code => {
    const cb = pop.querySelector(`input[value="${code}"]`);
    if (cb) { cb.checked = false; sync(); }
  };

  const toggleExpand = code => {
    if (expanded.has(code)) expanded.delete(code);
    else expanded.add(code);
    render(); sync();
  };

  render();
  // 费用明细表默认预填费用类一级科目（5601/5602/5603），打开即按费用口径出表
  const _edMap = edSubjectTree().map;
  ['5601', '5602', '5603'].forEach(code => {
    if (_edMap[code]) {
      const cb = pop.querySelector(`input[value="${code}"]`);
      if (cb) cb.checked = true;
    }
  });
  sync();

  // 事件委托：展开箭头、checkbox、底部全选、tag 删除
  pop.addEventListener('click', e => {
    const toggle = e.target.closest('.ed-subj-toggle');
    if (toggle) { toggleExpand(toggle.closest('.ed-subj-node').dataset.code); return; }
    const allBox = e.target.closest('#edSubjSelectAll');
    if (allBox) {
      pop.querySelectorAll('input[type=checkbox][data-subj]').forEach(i => i.checked = allBox.checked);
      sync();
      return;
    }
    const cb = e.target.closest('input[type="checkbox"][data-subj]');
    if (cb) { sync(); return; }
  });

  // tag 删除
  if (tagsBox) {
    tagsBox.addEventListener('click', e => {
      const close = e.target.closest('.ed-subj-tag-close');
      if (close) { e.stopPropagation(); removeTag(close.dataset.code); refreshExpenseDetail(); }
    });
  }

  // 触发框开合
  trigger.addEventListener('click', e => {
    if (e.target.closest('.ed-subj-tag-close')) return;
    pop.hidden = !pop.hidden;
  });
  // 点击页面其它处关闭（关闭时刷新报表）
  const closeHandler = e => {
    if (pop.hidden) return;
    const wrap = $('edSubjectWrap');
    if (!wrap.contains(e.target)) { pop.hidden = true; refreshExpenseDetail(); }
  };
  document.addEventListener('click', closeHandler);
}

function edSelectedSubjectCodes() {
  const pop = $('edSubjectPop');
  if (!pop) return [];
  return Array.from(pop.querySelectorAll('input[type=checkbox]:checked')).map(i => i.value);
}

function initEDFilters() {
  const startSel = $('edPeriodStart');
  const endSel = $('edPeriodEnd');
  if (startSel && endSel) {
    const opts = periodRangeOptions();
    startSel.innerHTML = opts;
    endSel.innerHTML = opts;
    // 默认期间 = 本期（最近一个已结账期间，如已结账到 7 月即取 7 月；尚未结账则回退最近有凭证的期间）
    const cp = lastClosedPeriod();
    startSel.value = cp;
    endSel.value = cp;
  }
  // 同步起止期间选择器触发器文本
  if (window.__EXTRA_UPDATE_PERIOD_TRIGGER__) {
    window.__EXTRA_UPDATE_PERIOD_TRIGGER__('edPeriodStart', 'edPeriodEnd');
  }

  // 默认勾选：年度合计 + 展开所有级次（与 HTML 中 checked 双保险，防止重渲染丢失）
  if ($('edOptYearTotal')) $('edOptYearTotal').checked = true;
  if ($('edOptExpand')) $('edOptExpand').checked = true;

  // 科目多选（科目 下拉勾选）：构建复选项浮层
  buildEDSubjectPop();
}

function refreshExpenseDetail() {
  const dataMax = currentPeriod(); // 数据实际最后月份（最近有凭证的期间）
  // 查询上限 = 本月（当下自然月，与账套进度无关）：仅截断未来月份；
  // 账套未做到本月时该月显示空表属正常，不再被拉回账套数据最后月份
  const now = new Date();
  const cap = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  const startRaw = $('edPeriodStart') ? $('edPeriodStart').value : dataMax;
  let endRaw = $('edPeriodEnd') ? $('edPeriodEnd').value : dataMax;
  if (endRaw > cap) endRaw = cap;
  const start = startRaw < cap ? startRaw : cap;
  const end = endRaw;
  const months = monthsBetween(start, end);
  const showZero = $('edOptZero') && $('edOptZero').checked;
  const showFullName = $('edOptFullName') && $('edOptFullName').checked;
  const showRatio = $('edOptRatio') && $('edOptRatio').checked;
  const expandAll = $('edOptExpand') && $('edOptExpand').checked;
  const showYearTotal = !($('edOptYearTotal')) || $('edOptYearTotal').checked;

  // 费用明细表可选科目范围：损益类（5/6 开头），含收入/成本/费用等
  let subs = subjectFilter(s => ED_SUBJECT_RE.test(s.code));

  // 按科目 code 去重：金蝶科目 code 本应唯一，但部分源账套（.ais）存在脏数据（如 5603 财务费用重复两条），
  // 若不去重，费用明细表会渲染重复行、且合计把同一科目算多次（合计虚高）。此处按 code 唯一化，
  // 不影响科目展示页（subject 页如实呈现重复），仅纠正「按 code 聚合」类报表的计算。
  const _seenCode = {};
  subs = subs.filter(s => { if (_seenCode[s.code]) return false; _seenCode[s.code] = true; return true; });

  // 科目多选过滤（科目 下拉勾选；不选=全部）
  let selCodes = edSelectedSubjectCodes();
  if (selCodes.length) {
    subs = subs.filter(s => selCodes.some(c => s.code === c || s.code.startsWith(c) || s.name.includes(c)));
  }

  // 计算每个科目在每个月的发生额
  // 费用明细表口径：费用类科目（正常余额在借方）的「发生额」= 借方发生额（periodDr），
  // 不能用 net(periodDr-periodCr)——月末结转损益会把费用贷方清零，net 会恒为 0。
  const glByMonth = {};
  months.forEach(m => {
    const gl = S.generalLedger(m) || [];
    glByMonth[m] = {};
    gl.forEach(r => { glByMonth[m][r.code] = r.normal === 'dr' ? (r.periodDr || 0) : (r.periodCr || 0); });
  });

  // 去年同期（用于「较同期」），与本期口径一致：去年同月逐月对应
  const yStart = prevYearMonth(start), yEnd = prevYearMonth(end);
  const yearMonths = monthsBetween(yStart, yEnd);
  const yearGlByMonth = {};
  yearMonths.forEach(m => {
    const gl = S.generalLedger(m) || [];
    yearGlByMonth[m] = {};
    gl.forEach(r => { yearGlByMonth[m][r.code] = r.normal === 'dr' ? (r.periodDr || 0) : (r.periodCr || 0); });
  });
  const yearTotalsByCode = {};
  yearMonths.forEach(m => {
    Object.keys(yearGlByMonth[m]).forEach(c => { yearTotalsByCode[c] = round2((yearTotalsByCode[c] || 0) + yearGlByMonth[m][c]); });
  });

  // 构建树：父子关系按 code 前缀最短匹配
  const allCodes = subs.map(s => s.code).sort();
  const parentMap = {};
  allCodes.forEach(code => {
    let parent = null;
    for (let i = code.length - 1; i >= 4; i--) {
      const prefix = code.slice(0, i);
      if (allCodes.includes(prefix)) { parent = prefix; break; }
    }
    parentMap[code] = parent;
  });

  const nodeMap = {};
  subs.forEach(s => {
    nodeMap[s.code] = {
      code: s.code,
      name: s.name,
      level: subjectLevel(s.code),
      children: [],
      amounts: months.map(m => glByMonth[m][s.code] || 0),
      hasAmount: false
    };
  });

  const roots = [];
  subs.forEach(s => {
    const node = nodeMap[s.code];
    const p = parentMap[s.code];
    if (p && nodeMap[p]) nodeMap[p].children.push(node);
    else roots.push(node);
  });

  // 对子节点排序
  const sortTree = nodes => {
    nodes.sort((a, b) => a.code.localeCompare(b.code));
    nodes.forEach(n => sortTree(n.children));
  };
  sortTree(roots);

  // 若某级科目在 GL 中没有汇总行，用子级汇总补齐；并标记是否有非零发生
  const fillAmounts = node => {
    node.children.forEach(fillAmounts);
    if (!node.amounts.some(v => v !== 0) && node.children.length) {
      node.amounts = months.map((_, i) => round2(node.children.reduce((sum, c) => sum + c.amounts[i], 0)));
    }
    node.total = round2(node.amounts.reduce((a, b) => a + b, 0));
    node.hasAmount = node.total !== 0 || node.children.some(c => c.hasAmount);
  };
  roots.forEach(fillAmounts);

  // 显示科目级次下拉已删除（2026-08-16 简化）：始终显示至最末级，
  // 显示深度由「展开所有级次」勾选 + 手动展开箭头控制
  let displayRoots = roots;

  // 零值过滤：展示发生额为0的科目 未勾选时，隐藏 total 为 0 且没有子级显示的叶子；父级保留
  if (!showZero) {
    const filterZero = nodes => {
      return nodes.filter(n => {
        const children = filterZero(n.children);
        n.children = children;
        return n.total !== 0 || children.length > 0;
      });
    };
    displayRoots = filterZero(displayRoots);
  }

  // 计算各列合计（只含当前显示行，且只加“非由子级汇总出的父级”避免重复）
  // 合计行 = 所有一级科目行相加，与展开状态无关
  const totals = { months: months.map(() => 0), yearTotal: 0 };
  const sumToTotals = (nodes, isRoot = true) => {
    nodes.forEach(n => {
      if (isRoot) {
        n.amounts.forEach((v, i) => { totals.months[i] = round2(totals.months[i] + v); });
        totals.yearTotal = round2(totals.yearTotal + n.total);
      }
      sumToTotals(n.children, false);
    });
  };
  sumToTotals(displayRoots, true);

  renderEDGrid(months, displayRoots, totals, { showYearTotal, showRatio, showFullName, expandAll, yearTotalsByCode, start, end });
  renderEDPagination(displayRoots.length);
}

function renderEDGrid(months, roots, totals, opts) {
  const head = $('edGridHead');
  const body = $('edBody');
  const foot = $('edFoot');
  if (!head || !body || !foot) return;

  const colCount = 2 + months.length + (opts.showYearTotal ? 1 : 0) + (opts.showRatio ? 2 : 0);

  // 表头：标题行收口到全局 setRptHead；列头行挂 edColHead（操作列已去掉，展开箭头在名称列内）
  const periodText = `${monthLabel(opts.start)} 至 ${monthLabel(opts.end)}`;
  head.innerHTML = '<tr class="grid-title" id="edTitleRow"></tr><tr id="edColHead"></tr>';
  let colHtml = '<th class="col-code">编码</th><th class="col-name">名称</th>';
  months.forEach(m => { colHtml += `<th class="col-amt">${monthLabel(m)}</th>`; });
  if (opts.showYearTotal) colHtml += `<th class="col-amt">${months[0] ? months[0].split('-')[0] : ''}年合计</th>`;
  if (opts.showRatio) {
    colHtml += '<th class="col-amt">较上期</th><th class="col-amt">较同期</th>';
  }
  const colHead = $('edColHead');
  if (colHead) colHead.innerHTML = colHtml;
  if (globalThis.setRptHead) globalThis.setRptHead('edTitleRow', '费用明细表', colCount, null, periodText);

  // 表体（树形）
  const rows = [];
  const pushRows = (nodes, depth = 0) => {
    nodes.forEach(n => {
      const expanded = opts.expandAll || edState.expanded.has(n.code);
      const hasChildren = n.children && n.children.length;
      const arrow = hasChildren
        ? `<span class="ed-tree-arrow ${expanded ? 'expanded' : ''}" data-c="${n.code}"></span>`
        : '<span class="ed-tree-spacer"></span>';
      const name = opts.showFullName && depth > 0
        ? getSubjectNameByCode(parentOfCodeInTree(roots, n.code)) + ' / ' + n.name
        : n.name;
      const indent = depth * 18;
      const amountCells = n.amounts.map(v => `<td class="col-amt">${money(v)}</td>`).join('');
      const yearCell = opts.showYearTotal ? `<td class="col-amt">${money(n.total)}</td>` : '';
      let ratioCells = '';
      if (opts.showRatio) {
        // 较上期 = 本期范围末月 vs 上月（环比）；较同期 = 本期范围合计 vs 去年同期合计（同比）
        const last = n.amounts[n.amounts.length - 1] || 0;
        const prev = n.amounts.length > 1 ? n.amounts[n.amounts.length - 2] : 0;
        const ySum = (opts.yearTotalsByCode && opts.yearTotalsByCode[n.code]) || 0;
        const mom = prev === 0 ? '-' : pct(last - prev, prev);
        const yoy = ySum === 0 ? '-' : pct(n.total - ySum, ySum);
        ratioCells = `<td class="col-amt">${mom}</td><td class="col-amt">${yoy}</td>`;
      }
      rows.push(`<tr class="ed-tree-row" data-level="${n.level}">
        <td class="col-code">${n.code}</td>
        <td class="col-name"><span class="ed-tree-indent" style="width:${12 + indent}px"></span>${arrow}<span class="ed-tree-text">${name}</span></td>
        ${amountCells}${yearCell}${ratioCells}
      </tr>`);
      if (expanded && hasChildren) pushRows(n.children, depth + 1);
    });
  };
  pushRows(roots);
  body.innerHTML = rows.join('') || `<tr><td colspan="${colCount}" class="text-center">无数据</td></tr>`;

  // 表尾合计（同步去掉「操作」列）
  let footHtml = '<tr class="ed-foot-row"><td class="col-code"></td><td class="col-name">合计</td>' +
    totals.months.map(v => `<td class="col-amt">${money(v)}</td>`).join('');
  if (opts.showYearTotal) footHtml += `<td class="col-amt">${money(totals.yearTotal)}</td>`;
  if (opts.showRatio) footHtml += '<td class="col-amt"></td><td class="col-amt"></td>';
  footHtml += '</tr>';
  foot.innerHTML = footHtml;
}

function pct(diff, base) {
  if (!base) return '-';
  const v = round2((diff / base) * 100);
  return (v > 0 ? '+' : '') + v + '%';
}

function parentOfCodeInTree(roots, code) {
  for (const r of roots) {
    if (code === r.code) return null;
    const found = findParent(r, code);
    if (found) return found;
  }
  return null;
}
function findParent(node, code) {
  for (const c of node.children || []) {
    if (c.code === code) return node.code;
    const p = findParent(c, code);
    if (p) return p;
  }
  return null;
}

function renderEDPagination(totalRoots) {
  const totalEl = $('edTotal');
  const pagesEl = $('edPages');
  if (!totalEl || !pagesEl) return;
  totalEl.textContent = `共 ${totalRoots} 条`;

  const totalPages = Math.max(1, Math.ceil(totalRoots / edState.pageSize));
  if (edState.page > totalPages) edState.page = totalPages;

  let html = '';
  html += `<li class="${edState.page === 1 ? 'disabled' : ''}" data-page="${edState.page - 1}" title="上一页"><button><i class="kdicon kdicon-arrow-left"></i></button></li>`;
  for (let i = 1; i <= totalPages; i++) {
    html += `<li class="${i === edState.page ? 'active' : ''}" data-page="${i}" title="${i}"><button>${i}</button></li>`;
  }
  html += `<li class="${edState.page === totalPages ? 'disabled' : ''}" data-page="${edState.page + 1}" title="下一页"><button><i class="kdicon kdicon-arrow-right"></i></button></li>`;
  pagesEl.innerHTML = html;
}

function exportED() {
  const head = $('edGridHead');
  const body = $('edBody');
  const foot = $('edFoot');
  if (!head || !body) return;
  // CSV 单元格转义：含逗号/引号/换行时用双引号包裹，内部引号翻倍（RFC 4180）。
  // 数值清洗：表格内数字经 money() 格式化带千分位逗号（如 200,848.45），若原样写入 CSV
  // 会被 Excel 按分隔符拆成多列、或按区域设置误判为文本，故导出时去掉千分位逗号还原纯数值。
  const numRe = /^-?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/;
  const csvCell = raw => {
    let t = (raw == null ? '' : String(raw)).trim();
    if (numRe.test(t)) t = t.replace(/,/g, '');
    if (/[",\n\r]/.test(t)) t = '"' + t.replace(/"/g, '""') + '"';
    return t;
  };
  const headers = Array.from(head.querySelectorAll('th')).map(th => csvCell(th.textContent));
  const rows = [];
  const collect = tr => { rows.push(Array.from(tr.querySelectorAll('td')).map(td => csvCell(td.textContent))); };
  body.querySelectorAll('tr').forEach(collect);
  if (foot) foot.querySelectorAll('tr').forEach(collect);
  const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  const fname = `费用明细表_${currentPeriod()}.csv`;
  __safeExportCsv('\ufeff' + csv, fname);
}

/* ============================================================
 * 原始凭证（电子档案 / 发票单据管理）
 * ============================================================ */
// 原始凭证/报表中心共用的期间范围下拉（DOM 填充版，区别于费用明细表的 periodRangeOptions 字符串版）
