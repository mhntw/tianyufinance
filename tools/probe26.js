// 探查 26 年真实账套结构，为生成 25 年数据提供依据
const fs=require('fs'),path=require('path');
const store={}; global.localStorage={getItem:k=>k in store?store[k]:null,setItem:(k,v)=>{store[k]=String(v);},removeItem:k=>{delete store[k];}};
global.window=global; global.navigator={sendBeacon:()=>true}; global.document={addEventListener(){}};
global.fetch=()=>Promise.reject(new Error('off')); global.XMLHttpRequest=function(){this.open=()=>{};this.setRequestHeader=()=>{};this.send=()=>{};this.status=200;};
global.addEventListener=()=>{}; global.setTimeout=setTimeout; global.clearTimeout=clearTimeout;
require(path.join(__dirname,'..','js','store.js'));
const S=global.S; const num=x=>{x=Number(x);return isNaN(x)?0:x;};
const booksDir=path.join(__dirname,'..','data','books');

for(const file of fs.readdirSync(booksDir).filter(f=>f.endsWith('.json')&&!f.endsWith('.bak'))){
  const st=JSON.parse(fs.readFileSync(path.join(booksDir,file),'utf8'));
  S.state=st; S._glCache={}; S.normalizeState(); S.ensureCashFlowFields();
  const name=file.replace(/_\d{4}.*$/,'');
  // 凭证月份分布
  const byMonth={}; (st.vouchers||[]).forEach(v=>{const m=(v.date||'').slice(0,7); if(m)byMonth[m]=(byMonth[m]||0)+1;});
  // 结账进度
  const closed=st.closedPeriods||[];
  const cur=st.currentPeriod||'';
  // 期初 vs 凭证 资金类科目 2026-01 余额（看期初规模）
  const glJan=S.generalLedger('2026-01');
  const cashJan=glJan.filter(r=>['1001','1002','1012'].indexOf(r.code)>=0).map(r=>r.code+':借'+r.obDr.toFixed(0)+'/贷'+r.obCr.toFixed(0));
  // 26年各损益科目全年净发生额（取2026-12 一般取不到，取2026-07累计近似）
  // 已结转损益的月份？检查有无"结转损益"凭证
  const carry=S.periodVouchers('2026-07').some(v=>/结转.*损益/.test(v.summary||''));
  console.log('\n==== '+name);
  console.log('  科目数='+S.subjects().length+' 凭证数='+(st.vouchers||[]).length);
  console.log('  凭证月份分布:', Object.keys(byMonth).sort().map(m=>m+':'+byMonth[m]).join(' '));
  console.log('  closedPeriods=['+closed.join(',')+'] currentPeriod='+cur);
  console.log('  期初资金类(1001/1002/1012) 2026-01:', cashJan.join(' '));
  console.log('  2026-07 是否有结转损益凭证:', carry);
  // 利润表 2026-07 全年累计(1-7月) 收入/费用/净利
  const pl=S.profitStatement('2026-07');
  console.log('  2026-01~07 利润: 收入='+pl.totalRevenue.toFixed(0)+' 费用='+pl.totalExpense.toFixed(0)+' 净利='+pl.netProfit.toFixed(0));
  // 未分配利润 3104 期初(2026-01)
  const undist=S.generalLedger('2026-01').filter(r=>r.code==='3104')[0];
  console.log('  利润分配(3104) 2026-01期初: 借'+(undist?undist.obDr.toFixed(0):'0')+'/贷'+(undist?undist.obCr.toFixed(0):'0'));
}
