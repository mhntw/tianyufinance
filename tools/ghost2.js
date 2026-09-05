// 精确排查：绅蓝之星中，凭证分录 e.code 是否都能被"末级科目精确匹配"或"父科目 rollCodes 覆盖"？
// 若某 e.code 不在 subjects 表里任何 code（含父级），即幽灵科目。
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
  const codes=new Set(S.subjects().map(s=>s.code));
  const months=(st.vouchers||[]).map(v=>(v.date||'').slice(0,7)).filter(x=>x.length===7);
  // 收集所有出现过的 code 及其金额（按月份）
  const byCode={};
  (st.vouchers||[]).forEach(v=>{const m=(v.date||'').slice(0,7); v.entries.forEach(e=>{ (byCode[e.code]=byCode[e.code]||{}); byCode[e.code][m]=(byCode[e.code][m]||0)+(num(e.dr)+num(e.cr)); });});
  // 幽灵：code 不在 subjects 中
  const ghosts=Object.keys(byCode).filter(c=>!codes.has(c));
  console.log('\n==== '+name+' 唯一代码数='+Object.keys(byCode).length+' 科目数='+codes.size+' 幽灵code数='+ghosts.length);
  if(ghosts.length){
    ghosts.forEach(c=>{
      const per=Object.keys(byCode[c]).map(m=>m+':'+byCode[c][m].toFixed(2)).join(' ');
      console.log('   幽灵 code='+c+' 出现月份金额: '+per);
    });
  } else {
    console.log('   无幽灵科目（所有 e.code 均存在于科目表）');
  }
}
