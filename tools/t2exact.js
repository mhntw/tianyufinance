// 用 single-code 精确匹配重算 T2（每个凭证分录 e.code 只匹配同名科目行），与 A 对比
const fs=require('fs'),path=require('path');
const store={}; global.localStorage={getItem:k=>k in store?store[k]:null,setItem:(k,v)=>{store[k]=String(v);},removeItem:k=>{delete store[k];}};
global.window=global; global.navigator={sendBeacon:()=>true}; global.document={addEventListener(){}};
global.fetch=()=>Promise.reject(new Error('off')); global.XMLHttpRequest=function(){this.open=()=>{};this.setRequestHeader=()=>{};this.send=()=>{};this.status=200;};
global.addEventListener=()=>{}; global.setTimeout=setTimeout; global.clearTimeout=clearTimeout;
require(path.join(__dirname,'..','js','store.js'));
const S=global.S; const num=x=>{x=Number(x);return isNaN(x)?0:x;}; const EPS=0.005;
const booksDir=path.join(__dirname,'..','data','books');
for(const file of fs.readdirSync(booksDir).filter(f=>f.endsWith('.json')&&!f.endsWith('.bak'))){
  const st=JSON.parse(fs.readFileSync(path.join(booksDir,file),'utf8'));
  S.state=st; S._glCache={}; S.normalizeState(); S.ensureCashFlowFields();
  const name=file.replace(/_\d{4}.*$/,'');
  const months=[...new Set((st.vouchers||[]).map(v=>(v.date||'').slice(0,7).length===7?(v.date||'').slice(0,7):null).filter(Boolean))].sort();
  const subjectByCode={}; S.subjects().forEach(s=>subjectByCode[s.code]=s);
  console.log('\n==== '+name);
  months.forEach(m=>{
    const gl=S.generalLedger(m);
    // single-code 精确：每个科目行 periodDr+periodCr 即为该 code 真实发生额；A 也按 code 精确累加
    let T2=0; gl.forEach(r=>{ T2+=num(r.periodDr)+num(r.periodCr); });
    // 但父科目上卷了子目 -> 重复。改：只算"其 code 在凭证里实际出现"或"末级"？
    // 直接按凭证 single-code 算 A，并算"父科目不重复"的 T2
    let Adr=0,Acr=0;
    const usedCodes=new Set();
    (st.vouchers||[]).forEach(v=>{ if((v.date||'').slice(0,7)!==m)return; v.entries.forEach(e=>{ Adr+=num(e.dr); Acr+=num(e.cr); }); });
    const A=Adr+Acr;
    // 找到"多出的"：g行里 periodDr+periodCr 之和 - A = 重复上卷量
    let dup = T2 - A;
    console.log('  '+m+' generalLedger求和T2='+T2.toFixed(2)+' A(凭证)='+A.toFixed(2)+' 重复上卷量='+dup.toFixed(2)+' ('+(Math.abs(dup)<1?'末级OK':dup>0?'父+子重复':'异常')+')');
  });
}
