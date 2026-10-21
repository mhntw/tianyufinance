/* ============================================================================
 * tools/check_amt_cells.js —— 金额位格算法守卫
 *
 * 为什么需要：位格的「负号借用左侧空位格」规则只能靠肉眼验收，历史上改过两次都回退。
 * 这里把 11 格结构、负号落位、溢出边界全部用断言锁死；任何改动跑一遍就会红。
 * 对应实现：js/pages/voucher/amt_cells.mjs（唯一实现，无 DOM 依赖）。
 * ========================================================================== */
const path = require('path');
const assert = require('assert');
const { pathToFileURL } = require('url');

const MOD = pathToFileURL(path.join(__dirname, '..', 'js', 'pages', 'voucher', 'amt_cells.mjs')).href;

let passed = 0;
let total = 0;
function check(label, fn) {
  total++;
  try {
    fn();
    passed++;
    console.log('  ✓ ' + label);
  } catch (e) {
    console.error('  ✗ ' + label + '\n    ' + e.message);
    process.exitCode = 1;
  }
}

(async function main() {
  const { computeAmtCells, AMT_UNITS, AMT_CELL_COUNT } = await import(MOD);

  const cellsOf = function (v, f2) { return computeAmtCells(v, f2).cells; };
  const text = function (arr) { return arr.map(function (c) { return c === '' ? '·' : c; }).join(''); };

  check('位格数恒为 11（单位串 ' + AMT_UNITS + '）', function () {
    assert.strictEqual(AMT_CELL_COUNT, 11);
    [0, 1, 1234.56, -0.5, -1234.56, -99999999.99, '', null, 123456789].forEach(function (v) {
      assert.strictEqual(cellsOf(v, true).length, 11, 'cells 长度错误: ' + v);
    });
  });

  check('空值 / 0 → 11 个空格，无溢出', function () {
    ['', null, 0].forEach(function (v) {
      const r = computeAmtCells(v, true);
      assert.strictEqual(r.overflow, false);
      assert.deepStrictEqual(r.cells, new Array(11).fill(''));
    });
  });

  check('正数 1234.56 → 末尾 6 格依次 1 2 3 4 5 6，不含负号', function () {
    const c = cellsOf(1234.56, true);
    assert.strictEqual(text(c), '·····123456');
    assert.ok(c.indexOf('-') === -1);
  });

  check('负数 -1234.56 → 负号紧贴最高位（万格），数字位与正数一致', function () {
    const c = cellsOf(-1234.56, true);
    assert.strictEqual(text(c), '····-123456');
    assert.strictEqual(c[4], '-');
    assert.strictEqual(c[5], '1');
  });

  check('小数 -0.50 → 负号落在十格，元角分为 0 5 0', function () {
    const c = cellsOf(-0.5, true);
    assert.strictEqual(text(c), '·······-050');
  });

  check('接近上限 -99999999.99 → 11 格占满且负号在首位', function () {
    const c = cellsOf(-99999999.99, true);
    assert.strictEqual(text(c), '-9999999999');
  });

  check('|v| 在千万级（±9999999.99）一律不溢出', function () {
    [9999999.99, -9999999.99, 1234567.89, -1234567.89].forEach(function (v) {
      assert.strictEqual(computeAmtCells(v, true).overflow, false, '不该溢出: ' + v);
    });
  });

  check('边界：-1 亿 无空位放负号 → 溢出走文本', function () {
    const r = computeAmtCells(-100000000, true);
    assert.strictEqual(r.overflow, true);
    assert.strictEqual(r.neg, true);
    assert.strictEqual(r.text, '100000000.00');
  });

  check('边界：正数 100 亿（整数位 10 格）→ 溢出走文本', function () {
    const r = computeAmtCells(10000000000, true);
    assert.strictEqual(r.overflow, true);
    assert.strictEqual(r.neg, false);
    assert.strictEqual(r.text, '10000000000.00');
  });

  check('不变式：负号最多一个，且右侧必须紧邻数字', function () {
    [1, 12, 123, 1234, 12345, 123456, 1234567, 12345678, 123456789, 0.5, 0.05].forEach(function (n) {
      const c = cellsOf(-n, true);
      if (computeAmtCells(-n, true).overflow) return;
      const hits = c.map(function (x, i) { return x === '-' ? i : -1; }).filter(function (i) { return i >= 0; });
      assert.strictEqual(hits.length, 1, '负号个数错误: ' + n);
      const at = hits[0];
      assert.ok(at + 1 < 11, '负号右侧没有格子: ' + n);
      assert.ok(c[at + 1] !== '' && c[at + 1] !== '-', '负号右侧不是数字: ' + n + ' → ' + text(c));
    });
  });

  check('正数永不出现负号', function () {
    [0.07, 1, 999.99, 123456789].forEach(function (v) {
      assert.ok(cellsOf(v, true).indexOf('-') === -1);
    });
  });

  check('表头单位串按字符落格（表头与数字格子同构）', function () {
    const c = cellsOf(AMT_UNITS, false);
    assert.strictEqual(c.join(''), AMT_UNITS);
  });

  check('force2=false 时正数保持输入原样（123 → 末三格 1 2 3）', function () {
    assert.strictEqual(text(cellsOf(123, false)), '········123');
  });

  check('force2=false 时负数仍按两位小数落格（-123 → -123.00 共 5 个数字）', function () {
    assert.strictEqual(text(cellsOf(-123, false)), '·····-12300');
  });

  const failed = total - passed;
  console.log('结果：' + passed + ' 项断言通过' + (failed ? '（失败 ' + failed + ' 项）' : '，全部通过'));
  if (failed) process.exitCode = 1;
})();
