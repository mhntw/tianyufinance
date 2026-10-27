#!/usr/bin/env node
/* 结账模板持久化验证：模板定义必须以**账套**为唯一权威（2026-10-21 定稿）
 *
 * 背景（两起真实报障）：
 *   · "结账模板不稳定，已经设置好了的会自动消失"（老机器从 v0.6.0 之前升级上来）
 *   · 根因：定义只写 localStorage['settle_templates_v1']，账套里只留 {id,enabled}。
 *     该键是全局单键：加载时按账套过滤、保存时把过滤后的子集整体覆盖回去 → 双账套互相抹掉；
 *     且 localStorage 按 WebView 来源隔离（2026-09-13 起标识符 com.chen.xzys → com.chen.ty），
 *     换版本/换电脑/清缓存即整体消失。
 *
 * 本脚本用**真实函数**（从 Settle.js 抽取，不是复刻）+ mock 的 localStorage/S 验证：
 *   ① 双账套互不覆盖    ② 清空 localStorage 仍不丢    ③ 迁移幂等
 *   ④ 删除不复活        ⑤ 空壳记录不渲染成死卡片      ⑥ 账套已有定义不被旧值覆盖
 *   ⑦ 迁移只并当前账套  ⑧ 静态卡口：两个写入方都不再写旧键
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SETTLE = path.join(ROOT, 'js/pages/settle/Settle.js');
const STORE = path.join(ROOT, 'js/store.js');
const settleSrc = fs.readFileSync(SETTLE, 'utf8');
const storeSrc = fs.readFileSync(STORE, 'utf8');

let pass = 0, fail = 0, skip = 0;
function check(ok, label, extra) {
  if (ok) { pass++; }
  else { fail++; console.log('  ✗ ' + label + (extra ? '  —— ' + extra : '')); }
}
function skipCase(label) { skip++; console.log('  - 跳过：' + label); }

/* ---------- 抽取真实函数（花括号配对，避免正则截断） ---------- */
function fnText(name) {
  const start = settleSrc.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('Settle.js 中找不到函数：' + name);
  let i = settleSrc.indexOf('{', start), depth = 0;
  for (; i < settleSrc.length; i++) {
    if (settleSrc[i] === '{') depth++;
    else if (settleSrc[i] === '}') { depth--; if (depth === 0) return settleSrc.slice(start, i + 1); }
  }
  throw new Error('函数花括号不平衡：' + name);
}
function varText(name) {
  const m = settleSrc.match(new RegExp('^var ' + name + ' = [^;]+;', 'm'));
  if (!m) throw new Error('Settle.js 中找不到变量：' + name);
  return m[0];
}

const FN_NAMES = ['defaultSettleTemplates', 'isSystemSettleTmpl', 'snapshotSettleTemplate', 'stateSettleTemplates',
  'syncTplEnabledFromStore', 'migrateLegacySettleTemplates', 'loadSettleTemplates',
  'writeSettleTemplatesToState', 'persistSettleTemplates', 'syncTplEnabledToStore'];

const code = [
  varText('SETTLE_TMPL_KEY'),
  FN_NAMES.map(fnText).join('\n'),
  'var settleTmplList = [];',
  'function setList(l) { settleTmplList = l; }',
  'function getList() { return settleTmplList; }',
  'function pushTpl(t) { settleTmplList.push(t); }',
  'function reload() { settleTmplList = loadSettleTemplates(); return settleTmplList; }',
  'return { reload: reload, persist: persistSettleTemplates, migrate: migrateLegacySettleTemplates,',
  '         cur: getList, setList: setList, pushTpl: pushTpl, load: loadSettleTemplates };'
].join('\n');

function makeEnv(bookId, state) {
  const mem = {};
  const ls = {
    getItem: k => (k in mem ? mem[k] : null),
    setItem: (k, v) => { mem[k] = String(v); },
    removeItem: k => { delete mem[k]; }
  };
  const S = {
    bookId: bookId,
    state: state || {},
    _persists: 0,
    persist: function () { S._persists++; },
    /* 与 store.setBookFields 同口径：写多个顶层字段 → 落盘（本测试只计次数）。
       Settle.js 的写入已收口到这个受控入口（架构边界 B2），mock 必须跟上。 */
    setBookFields: function (obj) {
      if (!S.state || !obj) return false;
      Object.keys(obj).forEach(function (k) { S.state[k] = obj[k]; });
      S._persists++;
      return true;
    },
    /* 与 store.js:3221-3239 同口径（cost 默认关、dep/profit 默认开、其它 id 默认关） */
    settleTplEnabled: function (id) {
      const tpls = S.state.settleTemplates;
      if (Array.isArray(tpls)) {
        for (const t of tpls) { if (t && t.id === id) return t.enabled !== false; }
      }
      if (id === 'cost') return false;
      return ['dep', 'cost', 'profit'].indexOf(id) >= 0;
    }
  };
  S.state = state || {};
  const api = new Function('S', 'localStorage', code)(S, ls);
  return { S, mem, api };
}
const names = list => (list || []).map(t => t.id).join(',');
const has = (list, id) => (list || []).some(t => t && t.id === id);
const find = (list, id) => (list || []).filter(t => t && t.id === id)[0];
const tplDef = (code, amount) => [{ summary: 's', code: code, dr: amount, cr: 0 }];

/* ========== ① 账套为权威：双账套互不覆盖 ========== */
console.log('① 双账套互不覆盖');
{
  const A = makeEnv('A', { settleTemplates: [] });
  A.api.reload();
  A.api.pushTpl({ id: 'c1', name: '摊销A', custom: true, enabled: true, template: tplDef('1801', 100), word: '记' });
  A.api.persist();
  const aRec = find(A.S.state.settleTemplates, 'c1');
  check(!!aRec, 'A 保存后：定义应写进账套 state.settleTemplates');
  check(!!(aRec && aRec.template && aRec.template.length), 'A 保存后：账套里应有完整分录定义（不是只有 {id,enabled}）',
    JSON.stringify(aRec));
  check(A.mem.settle_templates_v1 === undefined, 'A 保存后：不应再写 localStorage 旧键（账套是唯一权威）',
    '实际写入了 ' + (A.mem.settle_templates_v1 || '').slice(0, 40));

  // 切到账套 B：独立 state，只点一次启用（旧实现在这里会把 A 的定义抹掉）
  A.S.bookId = 'B'; A.S.state = { settleTemplates: [] };
  A.api.reload();
  check(!has(A.api.cur(), 'c1'), 'B 账套不应看到 A 的自定义模板（账套隔离）');
  find(A.api.cur(), 'cost').enabled = true;
  A.api.persist();
  check(has(A.S.state.settleTemplates, 'cost'), 'B 保存后：B 的账套里应有 cost 记录');
  check(find(A.S.state.settleTemplates, 'cost').enabled === true, 'B 保存后：cost 启用状态应落进 B 账套');

  // 切回 A
  A.S.bookId = 'A';
  A.S.state = JSON.parse(JSON.stringify({  // 模拟从磁盘重新载入 A
    settleTemplates: [Object.assign({}, aRec)]
  }));
  A.api.reload();
  check(has(A.api.cur(), 'c1'), '切回 A：c1 必须还在（旧实现在 B 保存时会把它的定义抹掉）', names(A.api.cur()));
  check(!!(find(A.api.cur(), 'c1') || {}).template, '切回 A：c1 的分录定义必须还在');
}

/* ========== ② 清空 localStorage（清缓存/换安装标识/换电脑）后仍不丢 ========== */
console.log('② 清空 localStorage 后仍不丢');
{
  const A = makeEnv('A', { settleTemplates: [{ id: 'c1', custom: true, enabled: true, name: 'x', template: tplDef('1801', 1) }] });
  A.mem.settle_templates_v1 = '[]';        // 旧键即使为空/丢失
  A.api.reload();
  check(has(A.api.cur(), 'c1'), '旧键为空时：模板应完全来自账套', names(A.api.cur()));
}

/* ========== ③④ 迁移：账套优先、只补缺、幂等；删除不复活 ========== */
console.log('③ 旧版迁移');
{
  const legacy = [
    { id: 'dep', name: '计提折旧', enabled: false, summary: '旧摘要', template: [] },
    { id: 'c9', name: '旧自定义', custom: true, enabled: true, bookId: 'L', template: tplDef('1801', 9) },
    { id: 'cx', name: '别的账套', custom: true, enabled: true, bookId: 'OTHER', template: tplDef('1801', 8) },
    { id: 'fx', name: '期末调汇', custom: true, enabled: true, template: tplDef('1001', 1) }
  ];
  const E = makeEnv('L', { settleTemplates: [{ id: 'c9', enabled: true }] });   // 老账套里只有空壳
  E.mem.settle_templates_v1 = JSON.stringify(legacy);
  E.api.migrate();
  const st = E.S.state.settleTemplates;
  check(E.S.state._settleTplMigrated === true, '迁移后应打 _settleTplMigrated 标记（此后不再读旧键）');
  check(has(st, 'c9') && !!(find(st, 'c9').template || []).length, '空壳 c9 必须被旧定义替换（不能因同名跳过）',
    JSON.stringify(find(st, 'c9')));
  check(st.filter(t => t.id === 'c9').length === 1, 'c9 不应产生重复记录', '条数 ' + st.filter(t => t.id === 'c9').length);
  check(!has(st, 'cx'), '归属其它账套(bookId=OTHER)的模板不得并入当前账套');
  check(!has(st, 'fx'), '已下线的 fx 模板不得迁移进来');
  check(find(st, 'dep').enabled === false, '系统模板：enabled 应保留账套值（这里是账套没有记录 → 补缺用旧值 false）');

  const before = JSON.stringify(E.S.state.settleTemplates), pBefore = E.S._persists;
  E.api.migrate();
  check(JSON.stringify(E.S.state.settleTemplates) === before, '迁移必须幂等：第二次不得改动任何模板记录');
  check(E.S._persists === pBefore, '迁移幂等：第二次不应再落盘');

  // 删除后刷新：不得被旧键复活
  E.api.setList(E.api.reload().filter(t => t.id !== 'c9'));
  E.api.persist();
  check(!has(E.S.state.settleTemplates, 'c9'), '删除 c9 后：账套里不应再有该记录');
  E.api.reload();
  check(!has(E.api.cur(), 'c9'), '删除后再次刷新：不得从旧 localStorage 复活');
}

/* ========== ⑤ 空壳不渲染成死卡片 ========== */
console.log('⑤ 空壳记录不渲染');
{
  const E = makeEnv('X', { settleTemplates: [{ id: 'ghost', custom: true, enabled: true }] });
  E.api.reload();
  check(!has(E.api.cur(), 'ghost'), '账套里只有 {id,enabled} 而没有分录定义的自定义模板不应进列表');
  check(has(E.api.cur(), 'dep') && has(E.api.cur(), 'profit'), '系统模板仍应正常在列表里');
}

/* ========== ⑥ 账套已有定义不被旧值覆盖 ========== */
console.log('⑥ 账套优先');
{
  const E = makeEnv('L', { settleTemplates: [{ id: 'c1', custom: true, enabled: true, name: '新名', template: tplDef('1801', 5) }] });
  E.mem.settle_templates_v1 = JSON.stringify([{ id: 'c1', custom: true, enabled: false, name: '旧名', template: tplDef('1001', 5) }]);
  E.api.migrate();
  const r = find(E.S.state.settleTemplates, 'c1');
  check(r.name === '新名' && r.template[0].code === '1801', '账套里已有完整定义时，旧 localStorage 值不得覆盖它',
    JSON.stringify(r));
}

/* ========== ⑦ 未知业务字段必须整体保留（白名单漏字段的回归） ========== */
console.log('⑦ 字段完整性');
{
  const E = makeEnv('A', { settleTemplates: [] });
  E.api.reload();
  const cost = find(E.api.cur(), 'cost');
  Object.assign(cost, {
    costRevSubj: '5001', costInvSubj: '1405', costProdSubj: '4001',
    costRate: '75', costAmount: '123.45', costSummary: '结转销售成本', voucherDate: 'period'
  });
  E.api.persist();
  const r = find(E.S.state.settleTemplates, 'cost') || {};
  check(r.costRevSubj === '5001' && r.costInvSubj === '1405' && r.costProdSubj === '4001'
    && r.costRate === '75' && r.costAmount === '123.45' && r.costSummary === '结转销售成本'
    && r.voucherDate === 'period',
    '模板设置里可编辑的业务字段必须整体存进账套（曾用字段白名单漏掉这五个，保存即丢）', JSON.stringify(r));
}

/* ========== ⑧ 静态卡口 ========== */
console.log('⑧ 静态卡口');
check(!/localStorage\.setItem\(\s*SETTLE_TMPL_KEY/.test(settleSrc),
  'Settle.js 不得再写 localStorage 旧键（只读迁移源）');
check(!/settle_templates_v1/.test(storeSrc),
  'store.js 不得再出现 settle_templates_v1（第二个写入方会让账套重新分裂成两套真值）');
check(!/localStorage\.setItem\(\s*STL_KEY/.test(storeSrc), 'store.js 不得再写 STL_KEY');

/* ---------- 汇总 ---------- */
if (fail) {
  console.log('\n✗ 结账模板持久化验证失败：' + fail + ' 项（通过 ' + pass + (skip ? '，跳过 ' + skip : '') + '）');
  process.exit(1);
}
console.log('\n✓ 结账模板持久化验证通过：' + pass + ' 项' + (skip ? '，跳过 ' + skip : ''));
process.exit(0);
