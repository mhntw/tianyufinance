// 幽灵科目诊断脚本
// 复刻 store.js 中 generalLedger 的"按科目上卷"逻辑，
// 检测凭证分录中 e.code 不在科目表的分录（幽灵科目），
// 并核对 T2（总账发生额合计）与 A（凭证分录合计）是否相等。
const fs = require('fs');
const path = require('path');

const booksDir = path.join(__dirname, '..', 'data', 'books');

function num(x) { x = Number(x); return isNaN(x) ? 0 : x; }
const EPS = 0.005;

function loadBooks() {
  return fs.readdirSync(booksDir)
    .filter(f => f.endsWith('.json') && !f.endsWith('.bak'))
    .map(f => ({ name: f, data: JSON.parse(fs.readFileSync(path.join(booksDir, f), 'utf8')) }));
}

function subjects(state) { return state.subjects || []; }
function subject(state, code) {
  return subjects(state).filter(s => s.code === code)[0] || null;
}

// 复刻 store.generalLedger 的 month 取数：返回 T2（总账发生额合计）
function totalLedgerAmount(state, month) {
  let total = 0; // T2: 上卷到所有科目的借贷发生额合计
  subjects(state).forEach(function (s) {
    const codes = [s.code];
    s.subs && s.subs.forEach(function (x) { codes.push(x.code); });
    // 期初与凭证（本应用当月，这里为全局核算用 periodVouchers 思路，但 generalLedger 实际取 month 期）
    (state.vouchers || []).forEach(function (v) {
      // 简化：仅统计 month 期凭证（与 generalLedger(month) 对齐）
      const m = (v.date || '').slice(0, 7);
      if (month && m !== month) return;
      v.entries.forEach(function (e) {
        if (codes.indexOf(e.code) >= 0) {
          total += num(e.dr) + num(e.cr);
        }
      });
    });
  });
  return total;
}

// A: 所有凭证分录（不区分是否在科目表）
function totalVoucherAmount(state, month) {
  let total = 0;
  (state.vouchers || []).forEach(function (v) {
    const m = (v.date || '').slice(0, 7);
    if (month && m !== month) return;
    v.entries.forEach(function (e) {
      total += num(e.dr) + num(e.cr);
    });
  });
  return total;
}

// 找出幽灵科目分录
function findGhostEntries(state, month) {
  const ghosts = [];
  (state.vouchers || []).forEach(function (v) {
    const m = (v.date || '').slice(0, 7);
    if (month && m !== month) return;
    v.entries.forEach(function (e) {
      if (!subject(state, e.code)) {
        ghosts.push({ v: v.word + '-' + v.no, date: v.date, code: e.code, name: e.name || '', dr: num(e.dr), cr: num(e.cr) });
      }
    });
  });
  return ghosts;
}

const books = loadBooks();
let anyGhost = false;

books.forEach(function (b) {
  const st = b.data;
  console.log('\n========================================');
  console.log('账套:', b.name);
  console.log('科目数:', subjects(st).length, ' 凭证数:', (st.vouchers || []).length);

  // 收集所有出现过的月份
  const months = {};
  (st.vouchers || []).forEach(v => { months[(v.date || '').slice(0, 7)] = true; });
  const monthList = Object.keys(months).filter(m => m.length === 7);

  // 全局（不分月）
  const T2 = totalLedgerAmount(st, null);
  const A = totalVoucherAmount(st, null);
  const diff = A - T2;
  console.log('--- 全局 ---');
  console.log('T2(总账发生额合计):', T2.toFixed(2));
  console.log('A (凭证分录合计) :', A.toFixed(2));
  console.log('A - T2           :', diff.toFixed(2), Math.abs(diff) >= EPS ? '<<< 不相等！' : '(相等)');

  const ghosts = findGhostEntries(st, null);
  if (ghosts.length) {
    anyGhost = true;
    console.log('幽灵科目分录数:', ghosts.length, '<<< 存在问题');
    ghosts.slice(0, 30).forEach(g => {
      console.log('   ', g.v, g.date, 'code=' + g.code, 'name=' + g.name, 'dr=' + g.dr, 'cr=' + g.cr);
    });
  } else {
    console.log('幽灵科目分录数: 0');
  }

  // 逐月（与报表层 S.generalLedger(month) 对齐）
  console.log('--- 逐月 ---');
  monthList.forEach(function (m) {
    const t2 = totalLedgerAmount(st, m);
    const a = totalVoucherAmount(st, m);
    const d = a - t2;
    const gh = findGhostEntries(st, m);
    const flag = (Math.abs(d) >= EPS || gh.length) ? '<<< 异常' : '';
    if (flag) {
      anyGhost = true;
      console.log('  ', m, 'T2=' + t2.toFixed(2), 'A=' + a.toFixed(2), '差=' + d.toFixed(2), '幽灵=' + gh.length, flag);
    }
  });
});

console.log('\n========================================');
console.log(anyGhost ? '结论：存在幽灵科目 / T2≠A 异常' : '结论：未发现幽灵科目，T2 与 A 一致');
