// 用软件真实的 store.js 函数做权威验证（而非自制复刻）
// 注入最小浏览器垫片 -> require store -> 逐账套喂入真实 state -> 调用 generalLedger/balanceSheet/cashFlow/profitStatement/runSelfTest
const fs = require('fs');
const path = require('path');

// ---- 浏览器垫片 ----
const store = {};
global.localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; },
};
global.window = global;
global.navigator = { sendBeacon: () => true };
global.document = { addEventListener(){}, };
global.fetch = () => Promise.reject(new Error('offline')); // 不联网
global.XMLHttpRequest = function(){ this.open=()=>{}; this.setRequestHeader=()=>{}; this.send=()=>{}; this.status=200; };
global.addEventListener = () => {};
global.setTimeout = setTimeout;
global.clearTimeout = clearTimeout;

require(path.join(__dirname, '..', 'js', 'store.js'));
const S = global.S;

const booksDir = path.join(__dirname, '..', 'data', 'books');
const EPS = 0.005;
function eq(a,b){ return Math.abs(a-b) < EPS; }
function num(x){ x=Number(x); return isNaN(x)?0:x; }

function monthsOf(st){
  const m={}; (st.vouchers||[]).forEach(v=>{const x=(v.date||'').slice(0,7); if(x.length===7)m[x]=true;});
  return Object.keys(m).sort();
}

let allProblems = [];
for (const file of fs.readdirSync(booksDir).filter(f=>f.endsWith('.json')&&!f.endsWith('.bak'))) {
  const st = JSON.parse(fs.readFileSync(path.join(booksDir, file), 'utf8'));
  S.state = st;
  S._glCache = {}; // 切换账套清空记忆化缓存，避免串账
  S.normalizeState();
  S.ensureCashFlowFields();
  const name = file.replace(/_\d{4}.*$/,'');
  console.log('\n================================================================');
  console.log('账套:', name, '('+file+')', '科目', (S.subjects&&S.subjects().length), '凭证', (st.vouchers||[]).length);

  const ml = monthsOf(st);
  console.log('月份:', ml.join(','));

  ml.forEach(m=>{
    const probs = [];

    // T2 vs A：用真实 generalLedger 上卷 vs 凭证原始合计
    const gl = S.generalLedger(m);
    const allCodes = new Set(gl.map(r=>r.code));
    let T2 = 0;
    gl.forEach(r=>{
      // 仅对末级科目（非任何科目的前缀父级）求和，避免父子重复上卷导致虚高
      const isParent = gl.some(x=>x.code.length>r.code.length && x.code.indexOf(r.code)===0);
      if(isParent) return;
      T2 += num(r.periodDr) + num(r.periodCr);
    });
    let A = 0;
    (st.vouchers||[]).forEach(v=>{ if((v.date||'').slice(0,7)===m) v.entries.forEach(e=>{ A += num(e.dr)+num(e.cr); }); });
    if(!eq(T2, A)) probs.push(`T2(${T2.toFixed(2)}) != A(${A.toFixed(2)}) 差=${(T2-A).toFixed(2)}`);

    // 资产负债表真实函数
    const bs = S.balanceSheet(m);
    const diff = num(bs.assets) - num(bs.liabilities) - num(bs.equity);
    if(!eq(diff,0)) probs.push(`BS不平: 资产=${bs.assets.toFixed(2)} 负债=${bs.liabilities.toFixed(2)} 权益=${bs.equity.toFixed(2)} 差=${diff.toFixed(2)}`);

    // 现金流量表：净额(经营+投资+筹资+汇率) 应 = 现金期末-期初
    const cf = S.cashFlow(m);
    const net = num(cf.operatingNet) + num(cf.investingNet) + num(cf.financingNet) + num(cf.exchangeNet);
    const cashDelta = num(cf.endingCash) - num(cf.beginningCash);
    if(!eq(net, cashDelta)) probs.push(`CF不平衡: 净额=${net.toFixed(2)} 现金变动=${cashDelta.toFixed(2)} 差=${(net-cashDelta).toFixed(2)}`);

    // 利润表：收入-费用 应 = 净利润(=未分配利润本年增加，粗略用 carriedProfit)
    const pl = S.profitStatement(m);
    // 校验利润表内部：营业利润等勾稽（简化：收入合计-成本税费合计 与 利润总额符号合理即可，不强制）

    // 结账检查（自带）
    const st0 = S.state;
    let diag;
    try { diag = S.runSelfTest ? S.runSelfTest(m) : null; } catch(e){ diag = { error: e.message }; }

    if(probs.length || (diag && diag.length)){
      console.log('  ['+m+'] ' + (probs.join('; ') || ''));
      if(diag && diag.length) diag.forEach(d=>console.log('     自检: '+d));
      allProblems.push(name+'/'+m+': '+(probs.join('; ')||'')+(diag&&diag.length?(' 自检:'+diag.join('|')):''));
    }
  });

  // 凭证借贷平衡（真实函数 periodVouchers 已过滤，这里直接算）
  let unbal=0;
  (st.vouchers||[]).forEach(v=>{let d=0,c=0;v.entries.forEach(e=>{d+=num(e.dr);c+=num(e.cr);}); if(!eq(d,c))unbal++;});
  if(unbal) { console.log('  凭证借贷不平:', unbal); allProblems.push(name+': 凭证不平 '+unbal+'张'); }
  else console.log('  凭证借贷平衡: 全部通过');

  // 期初借贷合计
  let obDr=0,obCr=0; Object.keys(st.openingBalances||{}).forEach(c=>{const o=st.openingBalances[c]; obDr+=num(o.dr); obCr+=num(o.cr);});
  if(!eq(obDr,obCr)){ console.log('  期初借贷不平衡: 借='+obDr.toFixed(2)+' 贷='+obCr.toFixed(2)); allProblems.push(name+': 期初不平衡'); }
  else console.log('  期初借贷平衡: OK');
}

console.log('\n================================================================');
console.log(allProblems.length ? ('发现 '+allProblems.length+' 项问题：') : '全部账套：T2=A、BS勾稽、CF平衡、凭证平衡、期初平衡 均通过');
allProblems.forEach(p=>console.log(' - '+p));
