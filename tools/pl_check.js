// 利润表内部勾稽 + 模拟结转损益后资产负债表仍平衡 + runSelfTest 实际输出
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
  console.log('\n==== '+name);
  months.forEach(m=>{
    const pl=S.profitStatement(m);
    // 利润表：营业收入-营业成本-税金及附加-期间费用 ≈ 利润总额
    const revenue=num(pl.mainRevenue)+num(pl.otherRevenue);
    const cost=num(pl.mainCost)+num(pl.mainTax)+num(pl.sellExp)+num(pl.adminExp)+num(pl.finExp);
    const totalProfit=num(pl.totalProfit);
    const check=(revenue-cost);
    // runSelfTest 实际
    let diag=[]; try{ diag=S.runSelfTest(m)||[]; }catch(e){ diag=['[runSelfTest异常]'+e.message]; }
    const bs=S.balanceSheet(m);
    const bsDiff=num(bs.assets)-num(bs.liabilities)-num(bs.equity);
    console.log('  '+m+' 利润表勾稽(营收-成本费用='+check.toFixed(2)+' 利润总额='+totalProfit.toFixed(2)+' 差='+(check-totalProfit).toFixed(2)+(Math.abs(check-totalProfit)<EPS?' OK':' <<差')+') | BS差='+bsDiff.toFixed(2)+(Math.abs(bsDiff)<EPS?' OK':' <<不平')+' | 自检='+(diag.length?diag.join(';'):'无'));
  });
  // 模拟结转损益（在副本上，不污染原数据）
  try{
    const st2=JSON.parse(JSON.stringify(st));
    S.state=st2; S._glCache={}; S.normalizeState(); S.ensureCashFlowFields();
    const lastM=months[months.length-1];
    const r=S.carryForwardProfit(lastM);
    if(r.ok){
      S._glCache={};
      const bs=S.balanceSheet(lastM);
      const bsDiff=num(bs.assets)-num(bs.liabilities)-num(bs.equity);
      console.log('  [模拟结转'+lastM+'] 收入='+r.totalRev.toFixed(2)+' 费用='+r.totalExp.toFixed(2)+' 净利='+r.net.toFixed(2)+' | 结转后BS差='+bsDiff.toFixed(2)+(Math.abs(bsDiff)<EPS?' OK':' <<不平'));
    } else {
      console.log('  [模拟结转'+lastM+'] 未生成: '+r.msg);
    }
  }catch(e){ console.log('  [模拟结转异常] '+e.message); }
  S.state=st;
}
