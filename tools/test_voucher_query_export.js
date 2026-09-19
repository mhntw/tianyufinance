/* 查凭证导出（exportQuery / queryVouchers）测试
 * 运行：node tools/test_voucher_query_export.js
 *
 * 覆盖：
 *  1. 跨期查询：起止不同月份时逐月汇总
 *  2. 科目过滤：只保留含该科目的凭证
 *  3. 字号排序：升序 / 降序
 *  4. 导出：按分录展开，凭证级字段只在首行；借贷金额取数值型而非格式化串
 *  5. 无数据 / 未选期间时不导出并给出提示
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
async function step(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + '\n    ' + e.message); }
}

const VOUCHER_PATH = path.join(__dirname, '..', 'js', 'pages', 'voucher', 'Voucher.js');
const src = fs.readFileSync(VOUCHER_PATH, 'utf8');

/* matchSubjectCode 不在 Voucher.js 里 —— 它由第 19 行的 ESM import 从 SubjectPicker.js 引入，
 * 因此「按名字在 src 中正则提取」永远找不到它（import 进来的标识符不在源码文本中定义）。
 * 这里单独从组件文件里提取，与 monthList 的处理同理：让被测代码走真实实现而非简化版。 */
const PICKER_PATH = path.join(__dirname, '..', 'js', 'components', 'SubjectPicker.js');
const pickerSrc = fs.readFileSync(PICKER_PATH, 'utf8');
function extractFrom(source, name) {
  const re = new RegExp('function ' + name + '\\s*\\([^)]*\\)\\s*\\{');
  const m = source.match(re);
  if (!m) throw new Error('未找到函数 ' + name);
  let i = source.indexOf('{', m.index), depth = 0, end = -1;
  for (let j = i; j < source.length; j++) {
    if (source[j] === '{') depth++;
    else if (source[j] === '}') { depth--; if (depth === 0) { end = j; break; } }
  }
  return source.slice(m.index, end + 1);
}

// 从源码中提取目标函数（按大括号配对）
function extract(name) {
  const re = new RegExp('function ' + name + '\\s*\\([^)]*\\)\\s*\\{');
  const m = src.match(re);
  if (!m) throw new Error('未找到函数 ' + name);
  let i = src.indexOf('{', m.index), depth = 0, end = -1;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) { end = j; break; } }
  }
  return src.slice(m.index, end + 1);
}

// 构造最小运行环境：mock store / DOM / XLSX，捕获导出结果
function makeEnv(periodVouchers) {
  const captured = { sheets: null, fname: null, toasts: [] };
  const els = {
    qPeriodStart: { value: '2026-01' },
    qPeriodEnd: { value: '2026-02' },
    qCode: { value: '' }
  };
  const sandbox = {
    console,
    Array, Object, JSON, String, Number, parseInt, parseFloat, isNaN,
    Set,   // qSubjectCodes 内部用 new Set()，沙箱必须显式提供（vm 不自动继承宿主全局）
    XLSX: {
      utils: {
        book_new() { return { __wb: true }; },
        book_append_sheet(wb, ws, name) { captured.sheets = { wb, ws, name }; },
        aoa_to_sheet(rows) { return { __rows: rows }; }
      }
    },
    __safeExportExcel(wb, fname) { captured.fname = fname; return Promise.resolve('/p'); },
    showToast(msg, type) { captured.toasts.push({ msg, type }); },
    $: (id) => els[id] || null,
    U: {
      num: (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; },
      /* monthList：与 store.js 的同名函数**逐行同源**（展开月份区间，含 01~12 校验）。
         此前只 mock 了 U.num，queryVouchers 内部调 U.monthList 时报「is not a function」。
         直接复制实现而非简化，是为了让被测代码走真实口径 —— 若 store 的 monthList 变了，
         这里也应同步（两处都在注释里标注了出处）。 */
      monthList: (start, end) => {
        const out = [];
        const s = String(start == null ? '' : start), e = String(end == null ? '' : end);
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(s) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(e)) return out;
        let y = +s.slice(0, 4), m = +s.slice(5, 7);
        const ey = +e.slice(0, 4), em = +e.slice(5, 7);
        while (y < ey || (y === ey && m <= em)) {
          out.push(y + '-' + String(m).padStart(2, '0'));
          m++; if (m > 12) { m = 1; y++; }
        }
        return out;
      }
    },
    S: {
      periodVouchers: (m) => (periodVouchers[m] || []).slice(),
      subjects: () => (els.__subjects || [])   // qSubjectCodes 用；用例未设时为空
    },
    qSortDir: 0
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    // qSubjectCodes 与 queryVouchers/exportQuery 同处 Voucher.js 顶层，被它们调用；
    // 只提取后两者时，调用 qSubjectCodes 会解析到沙箱全局而报「is not defined」。
    extract('qSubjectCodes') + '\n' +
    extractFrom(pickerSrc, 'matchSubjectCode') + '\n' +   // 来自 SubjectPicker.js（ESM import）
    extract('queryVouchers') + '\n' + extract('exportQuery') + '\n' +
    'globalThis.queryVouchers = queryVouchers; globalThis.exportQuery = exportQuery;',
    sandbox
  );
  return { sandbox, captured, els };
}

function v(id, word, no, date, entries) {
  return { id, word, no, date, status: 'draft', attach: 1, entries };
}

(async function () {
  console.log('查凭证导出测试：');

  const pv = {
    '2026-01': [v('a', '记', 2, '2026-01-05', [{ code: '1001', name: '库存现金', summary: '提现', dr: 100, cr: 0 }])],
    '2026-02': [v('b', '记', 1, '2026-02-08', [
      { code: '1002', name: '银行存款', summary: '收款', dr: 0, cr: 200 },
      { code: '6001', name: '主营业务收入', summary: '收款', dr: 200, cr: 0 }
    ])],
    '2026-03': [v('c', '记', 1, '2026-03-08', [{ code: '1001', name: '库存现金', summary: '提现', dr: 50, cr: 0 }])]
  };

  // vm 沙箱内产生的数组原型与外层不同，deepStrictEqual 会因 realm 差异失败，
  // 这里先转成宿主 realm 的普通数组再断言。
  const plain = (arr) => Array.from(arr);

  await step('跨期查询汇总两个期间的凭证', function () {
    const { sandbox } = makeEnv(pv);
    const r = sandbox.queryVouchers('2026-01', '2026-02', '');
    assert.strictEqual(r.length, 2);
    assert.deepStrictEqual(plain(r.map(x => x.id)), ['a', 'b']);
  });

  await step('同一期间只取一次，不重复', function () {
    const { sandbox } = makeEnv(pv);
    const r = sandbox.queryVouchers('2026-01', '2026-01', '');
    assert.strictEqual(r.length, 1);
  });

  /* ---- 区间相关的边界（2026-09-19 查凭证开放起止期间后补）---- */
  await step('区间起止相同时与单期等价', function () {
    const { sandbox } = makeEnv(pv);
    const single = sandbox.queryVouchers('2026-02', '2026-02', '');
    const range = sandbox.queryVouchers('2026-01', '2026-02', '');
    assert.deepStrictEqual(plain(single.map(x => x.id)), ['b'], '单期只取 2 月');
    assert.deepStrictEqual(plain(range.map(x => x.id)), ['a', 'b'], '区间含 1、2 月');
  });

  await step('起期晚于止期时返回空（不抛错，也不返回全部）', function () {
    const { sandbox } = makeEnv(pv);
    const r = sandbox.queryVouchers('2026-03', '2026-01', '');
    assert.strictEqual(r.length, 0, '反序区间应返回空数组，而非静默返回全部数据');
  });

  await step('跨年区间可正确展开（账簿类无「本年累计」列，跨年无口径冲突）', function () {
    const 跨年 = {
      '2025-11': [v('x1', '记', 1, '2025-11-05', [{ code: '1001', name: '库存现金', dr: 10, cr: 0 }])],
      '2026-01': [v('x2', '记', 1, '2026-01-05', [{ code: '1001', name: '库存现金', dr: 20, cr: 0 }])],
    };
    const { sandbox } = makeEnv(跨年);
    const r = sandbox.queryVouchers('2025-11', '2026-01', '');
    assert.strictEqual(r.length, 2, '应同时命中 2025-11 与 2026-01');
    assert.deepStrictEqual(plain(r.map(x => x.id)), ['x1', 'x2'], '按月顺序展开');
  });

  await step('科目过滤只保留含该科目的凭证', function () {
    const { sandbox } = makeEnv(pv);
    /* 第三个参数是**科目码集合（Set）**，不是字符串 —— queryVouchers 内部直接交给
       matchSubjectCode(codes, code)，后者调用 codes.has()。页面里两处真实调用
       （Voucher.js:1225 / 1262）传的都是 qSubjectCodes().codes（Set 或 null）。
       早先测试传字符串 '6001'，于是报「codes.has is not a function」。 */
    const r = sandbox.queryVouchers('2026-01', '2026-02', new Set(['6001']));
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].id, 'b');
  });

  await step('字号升序/降序生效', function () {
    const e1 = makeEnv(pv); e1.sandbox.qSortDir = 1;
    assert.deepStrictEqual(plain(e1.sandbox.queryVouchers('2026-01', '2026-02', '').map(x => x.no)), [1, 2], '升序应为 1,2');
    const e2 = makeEnv(pv); e2.sandbox.qSortDir = 2;
    assert.deepStrictEqual(plain(e2.sandbox.queryVouchers('2026-01', '2026-02', '').map(x => x.no)), [2, 1], '降序应为 2,1');
  });

  await step('导出按分录展开，凭证级字段只在首行', function () {
    const { sandbox, captured } = makeEnv(pv);
    sandbox.exportQuery();
    assert.ok(captured.sheets, '应生成 sheet');
    const rows = captured.sheets.ws.__rows;
    assert.strictEqual(rows[0][0], '日期');
    // 凭证 a 一条分录；凭证 b 两条分录 → 共 1 + 3 = 3 数据行
    assert.strictEqual(rows.length, 4, '表头 1 + 数据 3');
    assert.strictEqual(rows[1][0], '2026-01-05');
    assert.strictEqual(rows[1][1], '记-2');
    // 凭证 b 的第二个分录行：日期/字号应为空（不在首行重复）
    assert.strictEqual(rows[3][0], '', '非首行日期应留空');
    assert.strictEqual(rows[3][1], '', '非首行字号应留空');
    assert.strictEqual(rows[3][3], '6001 主营业务收入');
  });

  await step('导出金额为数值型，非格式化字符串', function () {
    const { sandbox, captured } = makeEnv(pv);
    sandbox.exportQuery();
    const rows = captured.sheets.ws.__rows;
    assert.strictEqual(rows[1][4], 100, '借方应为数值 100');
    assert.strictEqual(rows[2][5], 200, '贷方应为数值 200');
    assert.strictEqual(rows[2][4], '', '零值应留空而非 0');
  });

  await step('文件名带期间区间', function () {
    const { sandbox, captured } = makeEnv(pv);
    sandbox.exportQuery();
    assert.strictEqual(captured.fname, '凭证列表_2026-01至2026-02');
    // 单期间文件名不带「至」
    const e = makeEnv(pv);
    e.els.qPeriodStart.value = '2026-03'; e.els.qPeriodEnd.value = '2026-03';
    e.sandbox.exportQuery();
    assert.strictEqual(e.captured.fname, '凭证列表_2026-03');
  });

  await step('无数据时不导出并提示', function () {
    const { sandbox, captured } = makeEnv({});
    sandbox.exportQuery();
    assert.strictEqual(captured.sheets, null, '不应生成 sheet');
    assert.ok(captured.toasts.some(t => /没有可导出/.test(t.msg)));
  });

  await step('未选期间时不导出并提示', function () {
    const { sandbox, captured } = makeEnv(pv);
    sandbox.$ = () => ({ value: '' });
    sandbox.exportQuery();
    assert.strictEqual(captured.sheets, null);
    assert.ok(captured.toasts.some(t => /请先选择查询期间/.test(t.msg)));
  });

  /* ---- 静态契约：哪些页面允许「区间期间」（2026-09-19 讨论后固化）----
   *
   * 取舍标准：**只有「看流水」的账簿类可以给区间**。判据是该页有没有「本年累计」列——
   * 有这一列的（报表、总账），一旦允许跨自然年的区间，「本年累计」就失去法定口径
   * （准则要求按自然年归集），属实质隐患，故一律保持单期。
   *
   * 这条契约的作用：防止将来有人"顺手"给某个报表也加上 data-range。数值类断言
   * 未必能立刻发现，但口径已经错了。 */
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const periodTag = key => {
    const m = html.match(new RegExp('<div[^>]*data-period="' + key + '"[^>]*>'));
    return m ? m[0] : '';
  };
  await step('契约：明细账(dl)与查凭证(q)启用区间模式', function () {
    ['dl', 'q'].forEach(k => {
      const tag = periodTag(k);
      assert.ok(tag, '找不到 data-period="' + k + '" 的控件');
      assert.ok(/data-range="true"/.test(tag), k + ' 应带 data-range="true"');
    });
  });
  await step('契约：报表类与总账保持单期（含「本年累计」列，跨年区间会使该列口径失效）', function () {
    ['bs', 'pl', 'cf', 'tx', 'gl'].forEach(k => {
      const tag = periodTag(k);
      if (!tag) return;   // 该控件不存在则跳过（不误报）
      assert.ok(!/data-range="true"/.test(tag),
        k + ' 不应带 data-range —— 该页含「本年累计」列，跨年区间会让它失去法定口径');
    });
  });

  console.log('\n结果：' + passed + ' 通过, ' + failed + ' 失败');
  process.exit(failed ? 1 : 0);
})();
