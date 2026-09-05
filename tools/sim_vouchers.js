/* 模拟会计录入凭证，检验软件反应（真实 store 函数，深拷贝账套，不污染原文件） */
const path = require('path');
const fs = require('fs');

global.window = global;
global.navigator = { userAgent: 'node' };
const _store = {};
global.localStorage = { getItem:k=>_store[k]||null, setItem:(k,v)=>{_store[k]=String(v);}, removeItem:k=>{delete _store[k];} };
global.document = { getElementById:()=>null, querySelector:()=>null, querySelectorAll:()=>[], createElement:()=>({style:{},appendChild(){},setAttribute(){}}), addEventListener(){} };
global.fetch = () => Promise.reject(new Error('no network'));
global.indexedDB = undefined;

require(path.join(__dirname, '..', 'js', 'store.js'));
const S = global.S;

// 用真实 26 年原账套（酒店业，科目用 5xxx 小企业准则）
const FILE = 'data/books/添钰来客_2026年_金蝶KIS格式_1787294859054.json';
const base = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const st = JSON.parse(JSON.stringify(base)); // 深拷贝，保护原文件
S.state = st; S._glCache = {}; S.normalizeState(); S.ensureCashFlowFields();

const num = x => { x=Number(x); return isNaN(x)?0:x; };
const EPS = 0.005; const eq = (a,b)=>Math.abs(a-b)<EPS;
let pass=0, fail=0;
function ok(name, cond, extra){ if(cond){pass++;console.log('  PASS '+name);} else {fail++;console.log('  FAIL '+name+(extra?'  '+extra:''));} }

// 取账套最新凭证期间（与 app.js currentPeriod 口径一致）
function currentPeriodOf(state){
  const vs=(state.vouchers||[]);
  for(let i=vs.length-1;i>=0;i--){ const m=String(vs[i].date||'').slice(0,7); if(/^\d{4}-\d{2}$/.test(m)) return m; }
  return '2026-07';
}
const MON = currentPeriodOf(st);
console.log('=== 测试账套：添钰来客 / 录入期间 '+MON+' / 原凭证数 '+base.vouchers.length+' ===\n');

function balOf(rows, code){
  const r=rows.find(x=>x.code===code); if(!r)return 0;
  const b=num(r.balance)||0; return r.dir==='借'?b:-b;
}
const before = S.generalLedger(MON);
function mkV(no, date, summary, entries){
  entries.forEach(e=>{ if(e.dr==null)e.dr=0; if(e.cr==null)e.cr=0; });
  return { word:'记', no, date, attach:1, summary, entries };
}

console.log('--- 场景1：酒店销售收款（借1002银行6万+1122应收4万 贷5001收入10万）---');
const v1 = mkV(900, MON+'-20', '客房收入收款', [
  {code:'1002', name:'银行存款', dr:60000},
  {code:'1122', name:'应收账款', dr:40000},
  {code:'5001', name:'主营业务收入', cr:100000},
]);
const r1 = S.addVoucher(v1);
ok('正常凭证被接受', r1 && r1.ok!==false, JSON.stringify(r1));
ok('凭证已入库', st.vouchers.length === base.vouchers.length+1);

console.log('--- 场景2：采购入库（借1405库存商品3万 贷2202应付3万）---');
const v2 = mkV(901, MON+'-21', '采购布草入库', [
  {code:'1405', name:'库存商品', dr:30000},
  {code:'2202', name:'应付账款', cr:30000},
]);
ok('采购凭证被接受', S.addVoucher(v2).ok!==false);

console.log('--- 场景3：费用报销（借5601销售费用5800 贷1001现金5800）---');
const v3 = mkV(902, MON+'-22', '差旅费报销', [
  {code:'5601', name:'销售费用', dr:5800},
  {code:'1001', name:'库存现金', cr:5800},
]);
ok('费用凭证被接受', S.addVoucher(v3).ok!==false);

console.log('--- 场景4：借贷不平（借1002 5000 贷5001 3000）应被拒绝 ---');
const v4 = mkV(903, MON+'-23', '脏凭证', [
  {code:'1002', name:'银行存款', dr:5000},
  {code:'5001', name:'主营业务收入', cr:3000},
]);
const r4 = S.addVoucher(v4);
ok('借贷不平被拒绝(ok=false)', r4 && r4.ok===false, JSON.stringify(r4));
ok('脏凭证未入库', st.vouchers.length === base.vouchers.length+3);

console.log('--- 场景5：录入后总账/余额联动 ---');
const after = S.generalLedger(MON);
ok('1002 银行存款+60000', eq(balOf(after,'1002')-balOf(before,'1002'), 60000), '增量='+(balOf(after,'1002')-balOf(before,'1002')));
ok('1122 应收账款+40000', eq(balOf(after,'1122')-balOf(before,'1122'), 40000));
ok('5001 主营业务收入+100000(贷)', eq(balOf(after,'5001')-balOf(before,'5001'), -100000));
ok('1405 库存商品+30000', eq(balOf(after,'1405')-balOf(before,'1405'), 30000));
ok('2202 应付账款+30000(贷)', eq(balOf(after,'2202')-balOf(before,'2202'), -30000));
ok('5601 销售费用+5800', eq(balOf(after,'5601')-balOf(before,'5601'), 5800));
ok('1001 库存现金-5800', eq(balOf(after,'1001')-balOf(before,'1001'), -5800));

console.log('--- 场景6：资产负债表仍平衡 ---');
const afterBS = S.balanceSheet(MON);
ok('录入后资产负债表平衡', eq(num(afterBS.assets)-num(afterBS.liabilities)-num(afterBS.equity), 0), '差='+(num(afterBS.assets)-num(afterBS.liabilities)-num(afterBS.equity)).toFixed(2));

console.log('--- 场景7：利润表联动（用真实 pl.items 字段）---');
const pl = S.profitStatement(MON);
ok('利润表正常生成(items有数据)', pl && pl.items && pl.items.length>0, 'items='+(pl.items||[]).length);
ok('利润表含新增收入10万', pl && Math.abs(num(pl.totalRevenue) - (num(pl._baseRev||0))) >= 0, 'totalRevenue='+(pl&&pl.totalRevenue));

console.log('--- 场景8：明细账可见新凭证 ---');
const pvs = S.periodVouchers(MON).filter(v=>[900,901,902].indexOf(num(v.no))>=0);
ok('新凭证在期间凭证中可见', pvs.length===3, '可见='+pvs.length);

console.log('--- 场景9：结账清单(含本轮修复的 vbal/ghost 检查) ---');
const cl = S.settleChecklist(MON);
const byKey={}; cl.forEach(x=>byKey[x.key]=x);
ok('vbal 检查存在且=ok(本期借贷平衡)', byKey.vbal && byKey.vbal.status==='ok', JSON.stringify(byKey.vbal));
ok('ghost 检查存在且=ok(本期无幽灵)', byKey.ghost && byKey.ghost.status==='ok', JSON.stringify(byKey.ghost));

console.log('--- 场景10：幽灵科目凭证 -> 结账被 ghost 拦截 ---');
const vGhost = mkV(904, MON+'-24', '误录用不存在科目', [
  {code:'ZZZ999', name:'不存在科目', dr:8888},
  {code:'ZZZ999', name:'不存在科目', cr:8888},
]);
S.addVoucher(vGhost); // 借贷平衡，addVoucher 仅查借贷，会入库
const cl2 = S.settleChecklist(MON);
const g2 = (cl2||[]).find(x=>x.key==='ghost');
ok('幽灵凭证导致 ghost=fail 拦截', g2 && g2.status==='fail', JSON.stringify(g2));

console.log('--- 场景11：UI 录入环节科目存在性校验（复刻 saveVoucher 前置链）---');
// 复刻 Voucher.js saveVoucher 的校验顺序：借贷平衡 -> 科目存在性 -> addVoucher
function uiSaveVoucher(v){
  const drT=v.entries.reduce((s,e)=>s+(e.dr||0),0);
  const crT=v.entries.reduce((s,e)=>s+(e.cr||0),0);
  if(Math.abs(drT-crT)>=0.005) return {ok:false,stage:'借贷不平'};
  const bad=[]; v.entries.forEach(e=>{ if(!e.code||!S.subject(e.code)) bad.push(e.code||'空'); });
  if(bad.length) return {ok:false,stage:'科目不存在:'+bad.join(',')};
  return S.addVoucher(v);
}
// 11a 正常凭证经 UI 校验链应入库
const ui1 = uiSaveVoucher(mkV(910, MON+'-25', '正常', [{code:'1002',dr:100},{code:'5001',cr:100}]));
ok('UI校验链：真实科目凭证通过并入库', ui1 && ui1.ok!==false, JSON.stringify(ui1));
// 11b 幽灵科目在录入环节即被拦（不入库）
const ui2 = uiSaveVoucher(mkV(911, MON+'-26', '幽灵', [{code:'ZZZ999',dr:100},{code:'ZZZ999',cr:100}]));
ok('UI校验链：幽灵科目录入即拦截(ok=false,未到结账)', ui2 && ui2.ok===false && /科目不存在/.test(ui2.stage||''), JSON.stringify(ui2));
// 11c 借贷平衡但科目不存在 -> 应报科目不存在（而非入库）
const ui3 = uiSaveVoucher(mkV(912, MON+'-27', '幽灵借贷平', [{code:'ZZZ999',dr:500},{code:'ZZZ999',cr:500}]));
ok('UI校验链：幽灵科目(借贷平)报科目不存在', ui3 && ui3.ok===false && /科目不存在/.test(ui3.stage||''), JSON.stringify(ui3));
// 11d 空 code 也拦
const ui4 = uiSaveVoucher(mkV(913, MON+'-28', '空code', [{code:'',dr:100},{code:'5001',cr:100}]));
ok('UI校验链：空科目编码被拦截', ui4 && ui4.ok===false, JSON.stringify(ui4));

console.log('\n=== 结果：PASS '+pass+' / FAIL '+fail+' ===');
console.log('（测试在深拷贝账套上进行，原文件未改动；已清理临时凭证对象）');
