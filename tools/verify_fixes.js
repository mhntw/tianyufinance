// 验证三项修复：addVoucher借贷平衡 / settleChecklist借贷平衡+幽灵科目拦截 / 正常流程不破坏
const fs=require('fs'),path=require('path');
const store={}; global.localStorage={getItem:k=>k in store?store[k]:null,setItem:(k,v)=>{store[k]=String(v);},removeItem:k=>{delete store[k];}};
global.window=global; global.navigator={sendBeacon:()=>true}; global.document={addEventListener(){}};
// 持久化垫片：store.persist 会调 window.Storage.saveBook，测试环境不落盘
global.Storage = { saveBook: () => Promise.resolve({ ok: true }), saveBackup: () => Promise.resolve({ ok: true }) };
global.fetch=()=>Promise.reject(new Error('off')); global.XMLHttpRequest=function(){this.open=()=>{};this.setRequestHeader=()=>{};this.send=()=>{};this.status=200;};
global.addEventListener=()=>{}; global.setTimeout=setTimeout; global.clearTimeout=clearTimeout;
require(path.join(__dirname,'..','js','store.js'));
const S=global.S; const num=x=>{x=Number(x);return isNaN(x)?0:x;}; const EPS=0.005;

const ok=[];
function check(name, cond, extra){ ok.push((cond?'PASS':'FAIL')+' '+name+(extra?' ['+extra+']':'')); if(!cond) global.__fail=true; }

// 用真实账套作为基底
const booksDir=path.join(__dirname,'..','data','books');
const file=fs.readdirSync(booksDir).filter(f=>f.endsWith('.json')&&!f.endsWith('.bak'))[0];
const base=JSON.parse(fs.readFileSync(path.join(booksDir,file),'utf8'));
S.state=base; S._glCache={}; S.normalizeState(); S.ensureCashFlowFields();
const month='2026-07';

// 1) 正常平衡凭证 -> addVoucher 成功
const r1=S.addVoucher({word:'记',no:'999',date:month+'-20',summary:'正常',entries:[{code:'1001',name:'现金',dr:100,cr:0},{code:'6001',name:'收入',dr:0,cr:100}]});
check('正常平衡凭证可入库', r1 && r1.ok!==false && r1.id, r1&&r1.id?'ok':'被拒:'+(r1&&r1.msg));
// 撤回刚才的测试凭证（从 vouchers 移除，不影响后续）
S.state.vouchers=S.state.vouchers.filter(v=>!(v.word==='记'&&v.no==='999')); S._glCache={};

// 2) 借贷不平凭证 -> addVoucher 拒绝
const r2=S.addVoucher({word:'记',no:'998',date:month+'-20',summary:'不平',entries:[{code:'1001',name:'现金',dr:100,cr:0},{code:'6001',name:'收入',dr:0,cr:50}]});
check('借贷不平凭证被 addVoucher 拒绝', r2 && r2.ok===false, r2&&r2.msg);

// 3) 幽灵科目凭证 -> 先入库(模拟绕过UI的脏数据)，再结账清单应 fail
const r3=S.addVoucher({word:'记',no:'997',date:month+'-20',summary:'幽灵',entries:[{code:'1001',name:'现金',dr:100,cr:0},{code:'ZZZ999',name:'未知科目',dr:0,cr:100}]});
check('幽灵科目凭证仍可被 addVoucher 入库(底层不拦科目表,由结账清单拦)', r3 && r3.id, r3&&r3.msg);
const chk=S.settleChecklist(month);
const ghostChk=chk.filter(c=>c.key==='ghost')[0];
const vbalChk=chk.filter(c=>c.key==='vbal')[0];
check('幽灵科目检查项存在且标 fail', ghostChk && ghostChk.status==='fail', ghostChk&&(ghostChk.status+' '+ghostChk.tip));
check('借贷平衡检查项存在', vbalChk && vbalChk.status==='ok', vbalChk&&vbalChk.status);
// 结账应因 ghost fail 被拦截
const closeRes=S.closePeriod(month);
check('含幽灵科目的月份结账被拦截', closeRes.ok===false && closeRes.fails && closeRes.fails.some(f=>f.key==='ghost'), closeRes&&(closeRes.msg||'ok'));

// 4) 移除幽灵凭证后，结账清单 ghost 应 ok
S.state.vouchers=S.state.vouchers.filter(v=>!(v.word==='记'&&v.no==='997')); S._glCache={};
const chk2=S.settleChecklist(month);
const ghostChk2=chk2.filter(c=>c.key==='ghost')[0];
check('清除幽灵凭证后 ghost 检查 ok', ghostChk2 && ghostChk2.status==='ok', ghostChk2&&ghostChk2.status);

// 5) 正常账套(无脏数据) settleChecklist 不应有 vbal/ghost fail
const chk3=S.settleChecklist(month);
check('正常账套无 vbal/ghost fail', !chk3.some(c=>(c.key==='vbal'||c.key==='ghost')&&c.status==='fail'), chk3.filter(c=>c.status==='fail').map(c=>c.key).join(','));

console.log(ok.join('\n'));
console.log(global.__fail?'\n>>> 存在 FAIL':'\n>>> 全部 PASS');
