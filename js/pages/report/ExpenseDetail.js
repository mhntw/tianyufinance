// 自 report/Extra.js 拆分（B 方案第 2 批试点）：费用明细表。只挪窝不改写。
import { $, S, money, absFmt, goPage, currentPeriod, esc, num, showToast, nowTimeStr, round2,
  monthList, prevYearMonth, monthLabel, subjectLevel, subjectFilter } from './_shared.js';
const edState = {
  page: 1,
  pageSize: 500,
  expanded: new Set()           // 手动展开/折叠的 code（与“展开所有级次”互不干扰）
};
// 缓存 refreshExpenseDetail 的全量计算结果，供「导出」复用：避免解析 DOM，格式统一为 xlsx。
let edExportData = null;
// 起止期间取值：统一走 app.js 的单点实现（含默认值兜底），页面不再各自决定默认期间
const periodRangeValue = (globalThis.__TY_HELPERS__ || {}).periodRangeValue;
// 账套作用域守卫（单点实现，见 app.js 的 bookScopeChanged）：换账套时复位本页状态
const bookScopeChanged = (globalThis.__TY_HELPERS__ || {}).bookScopeChanged || function () { return false; };

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



  // 期间变更由期间控件的 data-on-change 直接回调（组件不再派发 change 事件），此处无需再绑监听。
  // （原先这里还负责保证 start <= end，但单期控件起止恒等，该校正已无意义）

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

  // btnEdPrint 已加 data-print，由全局委托统一走 tyPrint()。
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

// 科目弹层名称统一显示全路径名（与录凭证/科目下拉同口径）
const edFullName = n => (globalThis.subjectFullName ? globalThis.subjectFullName(n.code, n.name) : (n.name || ''));

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
      const childrenHtml = hasChildren && isExpanded ? `<div class="ed-subj-children indent-2">${walk(n.children)}</div>` : '';
      return `<div class="ed-subj-node" data-code="${n.code}">
        <div class="ed-subj-row">
          <span class="ed-subj-toggle ${toggleCls}"></span>
          <input type="checkbox" value="${n.code}" id="ed-subj-${n.code}" data-subj="1">
          <label for="ed-subj-${n.code}">${n.code} ${esc(edFullName(n))}</label>
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
  // 默认期间由 index.html 的 data-default 声明，periodRangeValue 单点兜底并同步触发器文本。
  // （此前这里手写「无条件赋值」把用户选的期间重置回默认期，表现为「选了期间但表格毫无变化」）
  periodRangeValue('edPeriod');

  // 默认勾选：年度合计；展开所有级次默认不勾选（与科目设置/余额表一致，只露一级）
  if ($('edOptYearTotal')) $('edOptYearTotal').checked = true;

  // 科目多选（科目 下拉勾选）：构建复选项浮层
  buildEDSubjectPop();
}

function refreshExpenseDetail() {
  // 换账套：手动展开的科目 code、分页、以及导出缓存全部属于上一本账套 —— 必须复位。
  // （展开集里是**旧账套的科目编码**，新账套多半没有这些 code；导出缓存残留会把旧账套的数导出。）
  if (bookScopeChanged('ed')) { edState.expanded.clear(); edState.page = 1; edExportData = null; }
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
  const months = monthList(start, end);
  const showZero = $('edOptZero') && $('edOptZero').checked;
  const showRatio = $('edOptRatio') && $('edOptRatio').checked;
  const expandAll = $('edOptExpand') && $('edOptExpand').checked;
  const showYearTotal = !($('edOptYearTotal')) || $('edOptYearTotal').checked;

  // 费用明细表可选科目范围：损益类（5/6 开头），含收入/成本/费用等
  let subs = subjectFilter(s => ED_SUBJECT_RE.test(s.code));

  // 按科目 code 去重：科目 code 本应唯一，但部分源账套（.ais）存在脏数据（如 5603 财务费用重复两条），
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
    // 按科目正常方向取发生额：走 store.normalSideAmount（唯一实现）
    gl.forEach(r => { glByMonth[m][r.code] = S.normalSideAmount(r); });
  });

  // 去年同期（用于「较同期」），与本期口径一致：去年同月逐月对应
  const yStart = prevYearMonth(start), yEnd = prevYearMonth(end);
  const yearMonths = monthList(yStart, yEnd);
  const yearGlByMonth = {};
  yearMonths.forEach(m => {
    const gl = S.generalLedger(m) || [];
    yearGlByMonth[m] = {};
    gl.forEach(r => { yearGlByMonth[m][r.code] = S.normalSideAmount(r); });
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

  renderEDGrid(months, displayRoots, totals, { showYearTotal, showRatio, expandAll, yearTotalsByCode, start, end });
  renderEDPagination(displayRoots.length);
  // 缓存全量结果供导出：直接基于已算数据构造 xlsx，金额写数值、不依赖页面渲染/DOM。
  edExportData = {
    months: months,
    displayRoots: displayRoots,
    totals: totals,
    opts: { showYearTotal: showYearTotal, showRatio: showRatio, yearTotalsByCode: yearTotalsByCode }
  };
}

function renderEDGrid(months, roots, totals, opts) {
  const head = $('edGridHead');
  const body = $('edBody');
  const foot = $('edFoot');
  if (!head || !body || !foot) return;

  const colCount = 2 + months.length + (opts.showYearTotal ? 1 : 0) + (opts.showRatio ? 2 : 0);

  // 表头：标题行收口到全局 setRptHead；列头行挂 edColHead
  // 列名按全站口径写全称「科目编码 / 科目名称」（原简写「编码 / 名称」）。
  // 展开三角放在【科目编码列】的代码前，与科目余额表一致（原在名称列内，与余额表不一致）。
  const periodText = `${monthLabel(opts.start)} 至 ${monthLabel(opts.end)}`;
  head.innerHTML = '<tr class="grid-title" id="edTitleRow"></tr><tr id="edColHead"></tr>';
  let colHtml = '<th class="col-code">科目编码</th><th class="col-name">科目名称</th>';
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
      // 箭头：用 store 公共函数统一生成文字 ▶▼（打印友好）
      const arrow = (globalThis.S && globalThis.S.subjectArrowHTML)
        ? globalThis.S.subjectArrowHTML(n.code, !!hasChildren, expanded, 'ed-tree-arrow')
        : (hasChildren
            ? `<span class="ed-tree-arrow ${expanded ? 'expanded' : ''}" data-c="${n.code}">${expanded ? '▼' : '▶'}</span>`
            : '<span class="ed-tree-spacer"></span>');
      const name = n.name;
      // 用节点自带的 level（store 已预计算），统一走 subjectIndentHTML
      const indent = (globalThis.S && globalThis.S.subjectIndentHTML)
        ? globalThis.S.subjectIndentHTML(n.level || 0)
        : `<span style="display:inline-block;width:${(n.level || 0) * 14}px"></span>`;
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
        <td class="col-code">${arrow}${n.code ? `<a href="#" class="link-gl-subject" data-code="${n.code}">${n.code}</a>` : ''}</td>
        <td class="col-name">${indent}<span class="ed-tree-text">${name}</span></td>
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


function renderEDPagination(totalRoots) {
  const totalEl = $('edTotal');
  const pagesEl = $('edPages');
  if (!totalEl || !pagesEl) return;
  totalEl.textContent = `共 ${totalRoots} 条`;

  const totalPages = Math.max(1, Math.ceil(totalRoots / edState.pageSize));
  if (edState.page > totalPages) edState.page = totalPages;

  let html = '';
  html += `<li class="${edState.page === 1 ? 'disabled' : ''}" data-page="${edState.page - 1}" title="上一页"><button><i class="tyicon tyicon-arrow-left"></i></button></li>`;
  for (let i = 1; i <= totalPages; i++) {
    html += `<li class="${i === edState.page ? 'active' : ''}" data-page="${i}" title="${i}"><button>${i}</button></li>`;
  }
  html += `<li class="${edState.page === totalPages ? 'disabled' : ''}" data-page="${edState.page + 1}" title="下一页"><button><i class="tyicon tyicon-arrow-right"></i></button></li>`;
  pagesEl.innerHTML = html;
}

// 导出（xlsx，与全账套报表统一）：直接基于 refreshExpenseDetail 缓存的全量数据构造，不解析 DOM。
// 金额列写数值（Excel 可再算，免去旧 CSV 的千分位/引号转义脆弱逻辑）；百分比列沿用界面 pct 文本。
// 费用明细表导出。
// 【同源约束，勿破】取数与汇总一律复用 renderExpenseDetail 缓存的 edExportData
//   （months / opts / totals / displayRoots），**不得在此自行重算**：
//   · 一旦这里另起一套取数，就会重演「屏幕与导出各写一份口径」的分叉 ——
//     账簿页与报表页都因此出过缺陷（见 tools/verify_cross_page.js 头部说明）。
//   · 与屏幕有意的差异只有三处，且都是**格式**而非数值：
//     树展开状态（导出给完整层级）、金额类型（屏幕文本 / 导出数字）、缩进方式（span / 空格）。
function exportED() {
  if (!edExportData) { showToast('请先打开费用明细表再导出', 'warn'); return; }
  var XLSX = globalThis.XLSX;
  if (!XLSX) { showToast('导出组件未加载', 'error'); return; }
  var safeExport = globalThis.__safeExportExcel;
  if (!safeExport) { showToast('导出功能不可用', 'error'); return; }
  var months = edExportData.months, opts = edExportData.opts, totals = edExportData.totals;
  var headers = ['编码', '名称'];
  months.forEach(function (m) { headers.push(monthLabel(m)); });
  if (opts.showYearTotal) headers.push((months[0] ? months[0].split('-')[0] : '') + '年合计');
  if (opts.showRatio) { headers.push('较上期'); headers.push('较同期'); }
  var rows = [headers];
  // 递归整棵树（不依赖界面展开状态，导出完整层级）
  var walk = function (nodes) {
    nodes.forEach(function (n) {
      var indent = (S && S.subjectIndentSpaces) ? S.subjectIndentSpaces(n.level || 0) : '';
      var cells = [n.code || '', indent + (n.name || '')];
      (n.amounts || []).forEach(function (v) { cells.push(num(v)); });
      if (opts.showYearTotal) cells.push(num(n.total));
      if (opts.showRatio) {
        var amts = n.amounts || [], last = amts[amts.length - 1] || 0, prev = amts.length > 1 ? amts[amts.length - 2] : 0;
        var ySum = (opts.yearTotalsByCode && opts.yearTotalsByCode[n.code]) || 0;
        cells.push(prev === 0 ? '' : pct(last - prev, prev));
        cells.push(ySum === 0 ? '' : pct(n.total - ySum, ySum));
      }
      rows.push(cells);
      if (n.children && n.children.length) walk(n.children);
    });
  };
  walk(edExportData.displayRoots);
  var foot = ['', '合计'];
  (totals.months || []).forEach(function (v) { foot.push(num(v)); });
  if (opts.showYearTotal) foot.push(num(totals.yearTotal));
  if (opts.showRatio) { foot.push(''); foot.push(''); }
  rows.push(foot);
  var wb = XLSX.utils.book_new();
  var ws = XLSX.utils.aoa_to_sheet(rows);
  var cols = [{ wch: 10 }, { wch: 22 }];
  for (var i = 0; i < months.length; i++) cols.push({ wch: 12 });
  if (opts.showYearTotal) cols.push({ wch: 12 });
  if (opts.showRatio) { cols.push({ wch: 10 }); cols.push({ wch: 10 }); }
  ws['!cols'] = cols;
  XLSX.utils.book_append_sheet(wb, ws, '费用明细表');
  safeExport(wb, '费用明细表_' + currentPeriod());
  showToast('已导出费用明细表', 'success');
}

/* ============================================================
 * 原始凭证（电子档案 / 发票单据管理）
 * ============================================================ */
// 原始凭证/报表中心共用的期间范围下拉（DOM 填充版，填入真实 <select> 元素）
