// 定位 T2 > A 的根因：逐科目对比 generalLedger 上卷金额 vs 凭证中真实匹配该 code 的金额
const fs = require('fs');
const path = require('path');
const store={}; global.localStorage={getItem:k=>k in store?store[k]:null,setItem:(k,v)=>{store[k]=String(v);},removeItem:k=>{delete store[k];}};
global.window=global; global.navigator={sendBeacon:()=>true}; global.document={addEventListener(){}};
global.fetch=()=>Promise.reject(new Error('off')); global.XMLHttpRequest=function(){this.open=()=>{};this.setRequestHeader=()=>{};this.send=()=>{};this.status=200;};
global.addEventListener=()=>{}; global.setTimeout=setTimeout; global.clearTimeout=clearTimeout;
require(path.join(__dirname,'..','js','store.js'));
const S=global.S;
const EPS=0.005; const num=x=>{x=Number(x);return isNaN(x)?0:x;};
const booksDir=path.join(__dirname,'..','data','books');

const file = process.argv[2] || fs.readdirSync(booksDir).filter(f=>f.endsWith('.json')&&!f.endsWith('.bak'))[0];
const st = JSON.parse(fs.readFileSync(path.join(booksDir,file),'utf8'));
S.state=st; S._glCache={}; S.normalizeState(); S.ensureCashFlowFields();
const m = process.argv[3] || (st.vouchers||[]).map(v=>(v.date||'').slice(0,7)).filter(x=>x.length===7).sort()[0];
console.log('账套:', file, '月份:', m);

const gl = S.generalLedger(m);
// 凭证中真实匹配某 code（精确相等）的金额
const realByCode={};
(st.vouchers||[]).forEach(v=>{ if((v.date||'').slice(0,7)!==m)return; v.entries.forEach(e=>{ const c=e.code; realByCode[c]=realByCode[c]||0; realByCode[c]+=num(e.dr)+num(e.cr); }); });

// rollCodes 对每科目产生的匹配集合
const rollCodes = S.rollCodes;
const rows=[];
gl.forEach(r=>{
  const codes = rollCodes.call(S, r.code);
  // 上卷金额
  const rolled = num(r.periodDr)+num(r.periodCr);
  // 这些 codes 在凭证真实匹配的金额合计
  let real=0; codes.forEach(c=>{ real += (realByCode[c]||0); });
  const diff = rolled-real;
  if(Math.abs(diff)>=EPS){
    rows.push({code:r.code, name:r.name, codes:codes.join(','), rolled:rolled.toFixed(2), real:real.toFixed(2), diff:diff.toFixed(2), nCodes:codes.length});
  }
});
console.log('逐科目上卷≠真实匹配 的差额（取前30）:');
rows.slice(0,30).forEach(x=>console.log('  ', x.code, x.name, '| roll('+x.nCodes+'码)='+x.rolled, 'real='+x.real, '差='+x.diff, '['+x.codes+']'));

// 统计：是否有 code 同时被多个 rollCodes 命中（重复累加）
const hitCount={};
gl.forEach(r=>{ const codes=rollCodes.call(S,r.code); codes.forEach(c=>{ hitCount[c]=(hitCount[c]||0)+1; }); });
const dup = Object.keys(hitCount).filter(c=>hitCount[c]>1);
console.log('\n被多个科目 rollCodes 命中的 code 数:', dup.length);
dup.slice(0,20).forEach(c=>console.log('   code='+c+' 命中'+hitCount[c]+'次, 真实金额='+(realByCode[c]||0).toFixed(2)));
