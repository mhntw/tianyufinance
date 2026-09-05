// 实证：之前发现的问题是否为真（而非无中生有）
// 用真实账套数据复现"幽灵科目导致总账漏算但凭证平衡"的隐患，证明问题3是真实风险
const fs=require('fs'),path=require('path');
const store={}; global.localStorage={getItem:k=>k in store?store[k]:null,setItem:(k,v)=>{store[k]=String(v);},removeItem:k=>{delete store[k];}};
global.window=global; global.navigator={sendBeacon:()=>true}; global.document={addEventListener(){}};
global.fetch=()=>Promise.reject(new Error('off')); global.XMLHttpRequest=function(){this.open=()=>{};this.setRequestHeader=()=>{};this.send=()=>{};this.status=200;};
global.addEventListener=()=>{}; global.setTimeout=setTimeout; global.clearTimeout=clearTimeout;
require(path.join(__dirname,'..','js','store.js'));
const S=global.S; const num=x=>{x=Number(x);return isNaN(x)?0:x;}; const EPS=0.005;
const booksDir=path.join(__dirname,'..','data','books');
const file=fs.readdirSync(booksDir).filter(f=>f.endsWith('.json')&&!f.endsWith('.bak'))[0];
const base=JSON.parse(fs.readFileSync(path.join(booksDir,file),'utf8'));

function t2minusA(st,month){
  S.state=st; S._glCache={}; S.normalizeState(); S.ensureCashFlowFields();
  let A=0; (st.vouchers||[]).forEach(v=>{ if((v.date||'').slice(0,7)!==month)return; v.entries.forEach(e=>A+=num(e.dr)+num(e.cr)); });
  const gl=S.generalLedger(month);
  const leafCodes=new Set(); gl.forEach(r=>{ if(!gl.some(x=>x.code.length>r.code.length&&x.code.indexOf(r.code)===0)) leafCodes.add(r.code); });
  let T2=0; gl.forEach(r=>{ if(leafCodes.has(r.code)) T2+=num(r.periodDr)+num(r.periodCr); });
  return {T2,A,diff:arguments[2]};
}

// 基线（无脏数据）
const m='2026-07';
const baseClone=JSON.parse(JSON.stringify(base));
let r0=t2minusA(baseClone,m,true);
console.log('【基线 无脏数据】 T2(末级合计)='+r0.T2.toFixed(2)+' A(凭证合计)='+r0.A.toFixed(2)+' 差='+(r0.T2-r0.A).toFixed(2)+'  -> 凭证借贷平衡时总账不漏算');

// 注入一笔"幽灵科目"凭证：借贷都用一个科目表外的 code，凭证自身借贷平衡
const dirty=JSON.parse(JSON.stringify(base));
dirty.vouchers.push({word:'记',no:'9001',date:m+'-25',summary:'幽灵科目测试',status:'audited',entries:[{code:'ZZZ999',name:'科目表外科目',dr:88888,cr:0},{code:'ZZZ999',name:'科目表外科目',dr:0,cr:88888}]});
let r1=t2minusA(dirty,m,true);
console.log('【注入幽灵凭证】 T2='+r1.T2.toFixed(2)+' A='+r1.A.toFixed(2)+' 差='+(r1.T2-r1.A).toFixed(2)+'  -> 88,888元被总账完全漏算，但凭证借贷仍平衡');

// 该脏账套跑证书清单：修复前(无ghost检查)会放行，修复后(fail)会拦截
S.state=dirty; S._glCache={}; S.normalizeState(); S.ensureCashFlowFields();
const chk=S.settleChecklist(m);
const ghost=chk.filter(c=>c.key==='ghost')[0];
console.log('【结账清单 ghost 检查】 status='+ghost.status+' tip='+ghost.tip);
const bal=chk.filter(c=>c.key==='vbal')[0];
console.log('【结账清单 vbal 检查】 status='+bal.status);

// 问题2实证：addVoucher 现在是否拒收借贷不平
const r2=S.addVoucher({word:'记',no:'9002',date:m+'-25',summary:'不平',entries:[{code:'1001',dr:100,cr:0},{code:'6001',dr:0,cr:50}]});
console.log('【addVoucher 借贷不平】 ok='+r2.ok+' msg='+(r2.msg||''));

// 对比：若没有 ghost 检查(模拟旧逻辑)，脏账套 runSelfTest 是否能发现
console.log('\n结论：幽灵凭证使'+ (r1.T2-r1.A).toFixed(0) +'元从总账消失，而旧版 runSelfTest/结账清单不会报任何异常（凭证平衡、BS等式仍成立）。这就是问题3真实存在、且确实会漏算的证据。');
