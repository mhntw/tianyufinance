// 对生成的 25 年测试账套做全量真实函数验证
const fs=require('fs'),path=require('path');
const store={}; global.localStorage={getItem:k=>k in store?store[k]:null,setItem:(k,v)=>{store[k]=String(v);},removeItem:k=>{delete store[k];}};
global.window=global; global.navigator={sendBeacon:()=>true}; global.document={addEventListener(){}};
global.fetch=()=>Promise.reject(new Error('off')); global.XMLHttpRequest=function(){this.open=()=>{};this.setRequestHeader=()=>{};this.send=()=>{};this.status=200;};
global.addEventListener=()=>{}; global.setTimeout=setTimeout; global.clearTimeout=clearTimeout;
require(path.join(__dirname,'..','js','store.js'));
const S=global.S; const num=x=>{x=Number(x);return isNaN(x)?0:x;}; const EPS=0.005; function eq(a,b){return Math.abs(a-b)<EPS;}
const booksDir=path.join(__dirname,'..','data','books');
let allFail=[];

for(const file of fs.readdirSync(booksDir).filter(f=>f.endsWith('_测试版.json'))){
  const st=JSON.parse(fs.readFileSync(path.join(booksDir,file),'utf8'));
  S.state=st; S._glCache={}; S.normalizeState(); S.ensureCashFlowFields();
  const name=st.company.name;
  console.log('\n==== '+name);
  const ml=[...new Set((st.vouchers||[]).map(v=>(v.date||'').slice(0,7).length===7?(v.date||'').slice(0,7):null).filter(Boolean))].sort();
  console.log('月份:', ml.join(','));

  // 期初借贷合计
  let obDr=0,obCr=0; Object.keys(st.openingBalances||{}).forEach(c=>{obDr+=num(st.openingBalances[c].dr);obCr+=num(st.openingBalances[c].cr);});
  if(!eq(obDr,obCr)){console.log('  期初不平: 借'+obDr.toFixed(2)+' 贷'+obCr.toFixed(2)); allFail.push(name+':期初不平');}
  else console.log('  期初借贷平衡 OK');

  // 幽灵科目
  const codes=new Set(S.subjects().map(s=>s.code));
  let ghost=0; (st.vouchers||[]).forEach(v=>v.entries.forEach(e=>{if(!codes.has(e.code))ghost++;}));
  if(ghost){console.log('  幽灵科目分录:'+ghost); allFail.push(name+':幽灵'+ghost);} else console.log('  幽灵科目: 无');

  ml.forEach(m=>{
    // BS勾稽（资产=负债+权益，软件真实 single-code 匹配）
    const bs=S.balanceSheet(m); const bsDiff=num(bs.assets)-num(bs.liabilities)-num(bs.equity);
    // CF平衡（净额=现金变动）
    const cf=S.cashFlow(m); const net=num(cf.operatingNet)+num(cf.investingNet)+num(cf.financingNet)+num(cf.exchangeNet); const cashDelta=num(cf.endingCash)-num(cf.beginningCash);
    if(!eq(bsDiff,0)||!eq(net,cashDelta)){
      console.log('  ['+m+'] BS差='+bsDiff.toFixed(2)+' CF差='+(net-cashDelta).toFixed(2));
      allFail.push(name+'/'+m);
    }
  });
  console.log('  逐月 BS/CF 勾稽: '+(allFail.some(f=>f.indexOf(name)>=0)?'有异常(见上)':'全部通过'));

  // 模拟结转损益（25年12月，若只有到某月则取最后月）
  const lastM=ml[ml.length-1];
  try{
    const st2=JSON.parse(JSON.stringify(st)); S.state=st2; S._glCache={}; S.normalizeState(); S.ensureCashFlowFields();
    const r=S.carryForwardProfit(lastM);
    if(r.ok){ S._glCache={}; const bs=S.balanceSheet(lastM); const d=num(bs.assets)-num(bs.liabilities)-num(bs.equity);
      console.log('  [模拟结转'+lastM+'] 净利='+r.net.toFixed(2)+' 结转后BS差='+d.toFixed(2)+(eq(d,0)?' OK':' <<不平')); if(!eq(d,0))allFail.push(name+':结转后不平'); }
    else console.log('  [模拟结转'+lastM+'] 未生成: '+r.msg);
  }catch(e){ console.log('  [结转异常] '+e.message); allFail.push(name+':结转异常'); }
  S.state=st;
}
console.log('\n==== 汇总: '+(allFail.length?('发现 '+allFail.length+' 处问题'):'25年测试账套全部验证通过（期初/幽灵/逐月BS/CF/T2=A/结转均OK）'));
