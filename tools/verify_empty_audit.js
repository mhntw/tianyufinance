// 空账套 / 无凭证 / 无期初 鲁棒性压测：用真实 store 函数跑边界场景，看是否抛异常或产生 NaN
const fs=require('fs'),path=require('path');
const store={}; global.localStorage={getItem:k=>k in store?store[k]:null,setItem:(k,v)=>{store[k]=String(v);},removeItem:k=>{delete store[k];}};
global.window=global; global.navigator={sendBeacon:()=>true}; global.document={addEventListener(){}};
global.fetch=()=>Promise.reject(new Error('off')); global.XMLHttpRequest=function(){this.open=()=>{};this.setRequestHeader=()=>{};this.send=()=>{};this.status=200;};
global.addEventListener=()=>{}; global.setTimeout=setTimeout; global.clearTimeout=clearTimeout;
require(path.join(__dirname,'..','js','store.js'));
const S=global.S; const num=x=>{x=Number(x);return isNaN(x)?0:x;}; const EPS=0.005;

function mkEmpty(){
  // 极简空账套：仅默认科目，无期初、无凭证
  const st={ subjects:[], openingBalances:{}, vouchers:[], closedPeriods:[], company:{name:'空账套',startMonth:'2026-01'}, param:{}, fixedAssets:[], salary:[], currentPeriod:'' };
  // 注入默认科目
  return st;
}
function hasNaN(obj,path){
  if(typeof obj==='number') return isNaN(obj)?[path]:[];
  if(obj&&typeof obj==='object'){let r=[];for(const k in obj){r=r.concat(hasNaN(obj[k],path+'.'+k));}return r.slice(0,5);}
  return [];
}

let problems=[];
// 场景1：完全空（含空 subjects，模拟全新账套未初始化）
const s1={subjects:[],openingBalances:{},vouchers:[],closedPeriods:[],company:{name:'x',startMonth:'2026-01'},param:{}};
[S.state=s1,S._glCache={},S.normalizeState(),S.ensureCashFlowFields()];
['2026-01','2026-02'].forEach(m=>{
  try{
    const bs=S.balanceSheet(m); const pl=S.profitStatement(m); const gl=S.generalLedger(m); const cf=S.cashFlow(m);
    const nan=hasNaN(bs,'bs').concat(hasNaN(pl,'pl')).concat(hasNaN(cf,'cf'));
    if(nan.length) problems.push('空账套 '+m+' 出现NaN字段: '+nan.join(','));
  }catch(e){ problems.push('空账套 '+m+' 抛异常: '+e.message); }
});
console.log('场景1 完全空账套(无科目无凭证):', problems.length?problems.join(' | '):'无异常/无NaN');

// 场景2：有默认科目，无期初无凭证
problems=[];
const s2=JSON.parse(JSON.stringify(require(path.join(__dirname,'..','js','store.js'))&&{})); // 不用
// 直接用 normalizeState 会注入 default subjects
[S.state={subjects:[],openingBalances:{},vouchers:[],closedPeriods:[],company:{name:'x',startMonth:'2026-01'},param:{}},S._glCache={},S.normalizeState(),S.ensureCashFlowFields()];
try{
  const bs=S.balanceSheet('2026-01');
  const bsDiff=num(bs.assets)-num(bs.liabilities)-num(bs.equity);
  console.log('场景2 默认科目无凭证: BS差='+bsDiff.toFixed(2)+' 资产='+num(bs.assets).toFixed(2)+' 负债='+num(bs.liabilities).toFixed(2)+' 权益='+num(bs.equity).toFixed(2)+(bsDiff>EPS?' <<不平':' OK'));
}catch(e){ console.log('场景2 异常: '+e.message); }

// 场景3：单笔凭证但借贷不平（脏数据防护）—— addVoucher 是否拦截
[S.state={subjects:[{code:'1001',name:'现金',cls:'asset',normal:'dr'},{code:'6001',name:'收入',cls:'revenue',normal:'cr'}],openingBalances:{},vouchers:[],closedPeriods:[],company:{name:'x',startMonth:'2026-01'},param:{}},S._glCache={},S.normalizeState(),S.ensureCashFlowFields()];
try{
  const r=S.addVoucher({word:'记',no:'1',date:'2026-01-15',summary:'测试',entries:[{code:'1001',name:'现金',dr:100,cr:0},{code:'6001',name:'收入',dr:0,cr:50}]});
  console.log('场景3 借贷不平凭证: addVoucher 返回 ok='+(r&&r.ok)+(r&&r.msg?(' ('+r.msg+')'):''));
}catch(e){ console.log('场景3 异常: '+e.message); }
