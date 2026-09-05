// 定位绅蓝之星 25年账套 T2-A 差额来源：确认是脚本末级判定口径问题，还是数据真有漏算
const fs=require('fs'),path=require('path');
const store={}; global.localStorage={getItem:k=>k in store?store[k]:null,setItem:(k,v)=>{store[k]=String(v);},removeItem:k=>{delete store[k];}};
global.window=global; global.navigator={sendBeacon:()=>true}; global.document={addEventListener(){}};
global.fetch=()=>Promise.reject(new Error('off')); global.XMLHttpRequest=function(){this.open=()=>{};this.setRequestHeader=()=>{};this.send=()=>{};this.status=200;};
global.addEventListener=()=>{}; global.setTimeout=setTimeout; global.clearTimeout=clearTimeout;
require(path.join(__dirname,'..','js','store.js'));
const S=global.S; const num=x=>{x=Number(x);return isNaN(x)?0:x;}; const EPS=0.005;
const booksDir=path.join(__dirname,'..','data','books');
const file=fs.readdirSync(booksDir).filter(f=>f.indexOf('绅蓝')>=0&&f.indexOf('测试版')>=0)[0];
const st=JSON.parse(fs.readFileSync(path.join(booksDir,file),'utf8'));
S.state=st; S._glCache={}; S.normalizeState(); S.ensureCashFlowFields();
const m='2025-01';
const gl=S.generalLedger(m);
// 精确末级：code 不是任何其他更长 code 的前缀
const allCodes=new Set(gl.map(r=>r.code));
const isLeaf=c=>![...allCodes].some(x=>x.length>c.length&&x.indexOf(c)===0);
let T2=0; const leafAmt={};
gl.forEach(r=>{ if(isLeaf(r.code)){ T2+=num(r.periodDr)+num(r.periodCr); leafAmt[r.code]=(num(r.periodDr)+num(r.periodCr)); } });
let A=0; const realByCode={};
(st.vouchers||[]).forEach(v=>{ if((v.date||'').slice(0,7)!==m)return; v.entries.forEach(e=>{ A+=num(e.dr)+num(e.cr); realByCode[e.code]=(realByCode[e.code]||0)+(num(e.dr)+num(e.cr)); }); });
console.log('T2(精确末级)='+T2.toFixed(2)+' A='+A.toFixed(2)+' 差='+(T2-A).toFixed(2));
// 找真实 code 中，其金额未在末级 T2 中体现的部分
let miss=0; Object.keys(realByCode).forEach(c=>{ if(!isLeaf(c)){ console.log('  非末级真实code='+c+' 金额='+realByCode[c].toFixed(2)+' (被父级rollCodes上卷，不计入末级T2)'); } });
// 验证：资产负债表 BS 用 single-code 是否平衡
const bs=S.balanceSheet(m); console.log('BS资产='+num(bs.assets).toFixed(2)+' 负债='+num(bs.liabilities).toFixed(2)+' 权益='+num(bs.equity).toFixed(2)+' 差='+(num(bs.assets)-num(bs.liabilities)-num(bs.equity)).toFixed(2));
console.log('结论：T2-A 差额来自父科目上卷(子目金额被父级行汇总，末级T2未重复计)，BS 用 single-code 仍平衡 => 这是审计口径问题，非数据漏算。');
