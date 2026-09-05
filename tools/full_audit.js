// 全面审查诊断脚本（驱动真实 js/store.js 做交叉验证，不写库）
// 审计改造：原版本自行复刻算法（openingOf 只读 openingBalances、现金判定仅三父码），
// 与 store 真实口径不一致，产生大量假阳性（CF/BS「不平」）。
// 现改为 require 真实 store，对每账套每期间断言四表硬勾稽：
//   TB 试算平衡(仅末级) / BS 资产=负债+权益 / PL 收入-费用=净利 / CF 三项净额+汇率=期末-期初
const fs = require('fs');
const path = require('path');

global.window = global;
global.document = {};
global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} };
global.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
const S = require(path.join(__dirname, '..', 'js', 'store.js')).store;

const booksDir = path.join(__dirname, '..', 'data', 'books');
const EPS = 0.02;
const num = x => { if (x === undefined || x === null || x === '') return 0; if (typeof x === 'number') return x; const n = parseFloat(String(x).replace(/,/g, '')); return isNaN(n) ? 0 : n; };

function loadBooks() {
  return fs.readdirSync(booksDir)
    .filter(f => f.endsWith('.json') && !f.endsWith('.bak'))
    .map(f => ({ name: f, st: JSON.parse(fs.readFileSync(path.join(booksDir, f), 'utf8')) }));
}

let problems = 0;
loadBooks().forEach(({ name, st }) => {
  S.state = JSON.parse(JSON.stringify(st));
  S.bookId = (st.company && st.company.name) || name;
  S._glCache = {};
  S.ensureCashFlowFields();
  console.log('\n===== ' + S.bookId + ' =====');

  const months = S.allMonths();
  const allCodes = S.subjects().map(s => s.code);
  const isLeaf = code => !allCodes.some(c => c !== code && c.indexOf(code) === 0);

  let prevEnd = null;
  months.forEach(m => {
    const gl = S.generalLedger(m);
    let obD = 0, obC = 0, eD = 0, eC = 0;
    gl.forEach(r => {
      if (!isLeaf(r.code)) return;
      obD += num(r.obDr); obC += num(r.obCr);
      eD += num(r.endDr); eC += num(r.endCr);
    });
    if (Math.abs(obD - obC) > EPS || Math.abs(eD - eC) > EPS) {
      console.log(' - [TB不平] ' + m + ' 期初借' + obD.toFixed(2) + '/贷' + obC.toFixed(2) + '(差' + (obD - obC).toFixed(2) + ') 期末借' + eD.toFixed(2) + '/贷' + eC.toFixed(2) + '(差' + (eD - eC).toFixed(2) + ')');
      problems++;
    }
    let asset = 0, liab = 0, equity = 0;
    gl.forEach(r => {
      if (!isLeaf(r.code)) return;
      const dr = num(r.endDr), cr = num(r.endCr);
      // 审计口径：带符号余额（而非正常方向绝对值）。负债科目出现借方余额（如股东往来对冲）
      // 时自动成为负负债，保持 资产=负债+权益 的恒等可检验；损益类未结转数并入权益。
      if (r.cls === 'asset') asset += dr - cr;
      else if (r.cls === 'liability') liab += cr - dr;
      else if (r.cls === 'equity') equity += cr - dr;
      else if (r.cls === 'revenue') equity += cr - dr;   // 未结转收入：贷方余额增加权益
      else if (r.cls === 'expense') equity += cr - dr;   // 未结转费用：借方余额减少权益
    });
    const bsDiff = Math.abs(asset - (liab + equity));
    if (bsDiff > EPS) {
      console.log(' - [BS不平] ' + m + ' 资产=' + asset.toFixed(2) + ' 负债=' + liab.toFixed(2) + ' 权益=' + equity.toFixed(2) + ' 差=' + (asset - liab - equity).toFixed(2));
      problems++;
    }
    const cf = S.cashFlow(m);
    const netInc = num(cf.operating) + num(cf.investing) + num(cf.financing) + num(cf.exchange);
    const cfDiff = Math.abs((num(cf.opening) + netInc) - num(cf.ending));
    if (cfDiff > EPS) {
      console.log(' - [CF不平] ' + m + ' 净额=' + netInc.toFixed(2) + ' 现金变动=' + (num(cf.ending) - num(cf.opening)).toFixed(2) + ' 差=' + ((num(cf.opening) + netInc) - num(cf.ending)).toFixed(2));
      problems++;
    }
    if (prevEnd !== null && Math.abs(prevEnd - num(cf.opening)) > EPS) {
      console.log(' - [CF衔接] ' + m + ' 期初=' + num(cf.opening).toFixed(2) + ' != 上月期末=' + prevEnd.toFixed(2));
      problems++;
    }
    prevEnd = num(cf.ending);
  });

  const lastM = months[months.length - 1];
  if (lastM) {
    const pl = S.profitStatement(lastM);
    const diff = Math.abs((num(pl.totalRevenue) - num(pl.totalExpense)) - num(pl.netProfit));
    if (diff > EPS) { console.log(' - [PL不平] ' + lastM + ' 收入=' + num(pl.totalRevenue).toFixed(2) + ' 费用=' + num(pl.totalExpense).toFixed(2) + ' 净利=' + num(pl.netProfit).toFixed(2)); problems++; }
    console.log('摘要 ' + lastM + ': 收入=' + num(pl.totalRevenue).toFixed(2) + ' 费用=' + num(pl.totalExpense).toFixed(2) + ' 净利=' + num(pl.netProfit).toFixed(2)
      + ' | 现金 open=' + num(S.cashFlow(lastM).opening).toFixed(2) + ' end=' + num(S.cashFlow(lastM).ending).toFixed(2));
  }
});

console.log(problems ? '\n===== 发现问题: ' + problems + ' =====' : '\n===== 四表勾稽全部通过 =====');
process.exit(problems ? 1 : 0);