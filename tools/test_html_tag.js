/* ============================================================================
 * tools/test_html_tag.js —— html`` 自动转义模板的行为守卫
 *
 * 为什么需要：html`` 的承诺是"插值默认转义"，一旦实现写错（比如漏了 RawHtml 判断、
 * 或让数组直接 join），就会变成"看起来安全、其实不转义"的假防护 —— 比不用它更危险。
 * 这里把转义 / raw 放行 / 嵌套不双重转义 / 空值 / 数组 五条口径锁死。
 * 对应实现：js/common/html.js
 * ========================================================================== */
const path = require('path');
const assert = require('assert');
const { pathToFileURL } = require('url');

const MOD = pathToFileURL(path.join(__dirname, '..', 'js', 'common', 'html.js')).href;

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
  const { html, raw, RawHtml } = await import(MOD);

  check('普通插值自动转义 & < > " \'', function () {
    const out = String(html`<b>${'<img src=x onerror="1">\'&'}</b>`);
    assert.strictEqual(out.indexOf('<img'), -1, '原始尖括号被放行: ' + out);
    assert.ok(out.indexOf('&lt;img') >= 0, '未转义成 &lt;: ' + out);
    assert.ok(out.indexOf('&quot;') >= 0 && out.indexOf('&#39;') >= 0 && out.indexOf('&amp;') >= 0, out);
  });

  check('属性上下文同样安全（引号被转义）', function () {
    const out = String(html`<a title="${'x" onmouseover="1'}"></a>`);
    assert.strictEqual(out.indexOf('onmouseover="1'), -1, '属性闭合逃逸: ' + out);
    assert.ok(out.indexOf('&quot;') >= 0, out);
  });

  check('raw() 片段原样放行（用于已转义/常量 HTML）', function () {
    const out = String(html`<div>${raw('<i class="x">ok</i>')}</div>`);
    assert.strictEqual(out, '<div><i class="x">ok</i></div>');
  });

  check('嵌套 html`` 不会被二次转义', function () {
    const inner = html`<span>${'<x>'}</span>`;
    const out = String(html`<div>${inner}</div>`);
    assert.strictEqual(out, '<div><span>&lt;x&gt;</span></div>');
  });

  check('null / undefined / false 输出空串，不输出 "null"', function () {
    assert.strictEqual(String(html`[${null}${undefined}${false}]`), '[]');
  });

  check('数组逐项转义后拼接（不直接 join）', function () {
    const out = String(html`<ul>${['<a>', '<b>']}</ul>`);
    assert.strictEqual(out, '<ul>&lt;a&gt;&lt;b&gt;</ul>');
  });

  check('数字与普通文本保持原样', function () {
    assert.strictEqual(String(html`<td>${1234.56}</td>`), '<td>1234.56</td>');
    assert.strictEqual(String(html`<td>${'借方'}</td>`), '<td>借方</td>');
  });

  check('返回值可参与字符串拼接（toString 与字符串一致）', function () {
    const out = '<tr>' + html`<td>${'<x>'}</td>` + '</tr>';
    assert.strictEqual(out, '<tr><td>&lt;x&gt;</td></tr>');
    assert.ok(html`` instanceof RawHtml, 'html`` 应返回 RawHtml');
  });

  console.log('\n' + passed + ' / ' + total + ' 通过');
  if (passed !== total) process.exitCode = 1;
})();
