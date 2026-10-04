'use strict';
/* 布局在「窗口缩放 / 界面放大」下的健壮性抽查（**手动工具，不纳入 run-all 默认回归**）
 *
 * 【为什么手动】它要真开一个无头浏览器渲染，比其余脚本慢一个数量级；
 *   日常回归应保持秒级，故命名不带 verify_ 前缀（也就不会被 run-all 自动收集）。
 *   改窗口尺寸相关 CSS、或发版前，手动跑一次：
 *       node tools/layout_probe.js                     默认 3 档（1280 / 1024 / 900）
 *       node tools/layout_probe.js --sizes=1280x800    指定档位
 *       node tools/layout_probe.js --budget=20000      调虚拟时间预算（默认 12000，越慢越稳）
 *
 * 【判据】A) 文档级横向溢出 = 0；B) "溢出最近裁切祖先且滚不到"的元素 = 0；C) 模态宽不超视口。
 *   为什么不是"元素自身 box 溢出"？—— 首页 .metric-grid 就是**故意**让 row 比自身宽 16px
 *   （注释写明：抵掉白框右内边距，末列再 padding-right:16px 抵消）。首版用后者，把它误报成缺陷 ✗。
 *   正确判据只能是"**内容是否溢出最近的可裁切祖先、且无法滚到**"（即用户真的看不到）。
 *
 * 【血泪教训 · 别重犯】首版用 execFileSync（同步）启动浏览器 —— 它**阻塞 Node 事件循环**，
 *   而本文件自带的静态 HTTP 服务跑在同一个事件循环里，于是**服务不响应 → 浏览器等页面等到超时**
 *   （表现为"每档卡 90 秒"，还留下 20+ 个孤儿浏览器进程把机器占住）。
 *   改用异步 spawn 后一切正常。凡是"自带服务 + 启动子进程"，子进程必须异步起。
 *
 * 【退出码】0 = 通过或无浏览器（跳过）；1 = 发现布局缺陷或浏览器执行失败。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
/* 抽查档位与安全最小尺寸来自单点 tools/layout_min.js —— 那里记录了 900x600 的实测依据，
   并由 tools/check_window_min.js 守住"窗口最小尺寸 / 安全边界 / 抽查档位"三者一致。 */
const { SAFE_MIN, SIZES: DEFAULT_SIZES } = require('./layout_min.js');
const PAGES = ['home', 'voucher', 'detail-ledger', 'report-balance', 'settle'];

/* ---------- 找无头浏览器（**必须优先 headless-shell**） ---------- */
/* 实测教训：Playwright 缓存里同时有 headless-shell 与**完整 Chromium.app**，
   选到后者用 --headless 跑会挂住不退出。 */
function findBrowser() {
  const shell = [], others = [];
  if (process.env.CHROME_BIN) others.push(process.env.CHROME_BIN);
  [path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright'),
    path.join(os.homedir(), '.cache', 'ms-playwright')].forEach(function (root) {
    let dirs = [];
    try { dirs = fs.readdirSync(root); } catch (e) { return; }
    dirs.filter(function (d) { return /^chromium_headless_shell-/.test(d); }).sort().reverse().forEach(function (d) {
      ['chrome-headless-shell-mac-arm64/chrome-headless-shell', 'chrome-headless-shell-mac-x64/chrome-headless-shell',
        'chrome-headless-shell-linux64/chrome-headless-shell'].forEach(function (sub) { shell.push(path.join(root, d, sub)); });
    });
    dirs.filter(function (d) { return /^chromium-/.test(d); }).sort().reverse().forEach(function (d) {
      ['chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-linux/chrome'].forEach(function (sub) { others.push(path.join(root, d, sub)); });
    });
  });
  others.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  for (const c of shell.concat(others)) { try { if (fs.statSync(c).isFile()) return c; } catch (e) {} }
  return null;
}

/* ---------- 异步启动（不阻塞事件循环 → 自带服务才能响应） ---------- */
function spawnAsync(bin, args, timeoutMs) {
  return new Promise(function (resolve) {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '', done = false;
    const timer = setTimeout(function () {
      if (done) return; done = true;
      try { child.kill('SIGKILL'); } catch (e) {}
      resolve({ out: out, timedOut: true });
    }, timeoutMs);
    child.stdout.on('data', function (d) { out += d; });
    child.on('error', function (e) { if (done) return; done = true; clearTimeout(timer); resolve({ out: '', error: e.message }); });
    child.on('close', function () { if (done) return; done = true; clearTimeout(timer); resolve({ out: out }); });
  });
}

/* ---------- 注入页面的探针 ---------- */
const PROBE = `
(function () {
  var PAGES = ${JSON.stringify(PAGES)};
  function sel(el) {
    if (!el || el.nodeType !== 1) return '?';
    var s = el.tagName.toLowerCase();
    if (el.id) return s + '#' + el.id;
    var c = (el.getAttribute('class') || '').trim().split(/\\s+/).slice(0, 2).join('.');
    return c ? s + '.' + c : s;
  }
  function visible(el) {
    var cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  }
  function scrollableX(el) {
    var cs = getComputedStyle(el);
    return (cs.overflowX === 'auto' || cs.overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 1;
  }
  function clipBoxOf(el) {
    for (var p = el.parentElement; p; p = p.parentElement) {
      var ox = getComputedStyle(p).overflowX;
      if (ox === 'visible') continue;
      return { el: p, scrollable: scrollableX(p) };
    }
    return null;
  }
  function audit() {
    var vw = window.innerWidth;
    var out = { size: vw + 'x' + window.innerHeight,
      docOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      unreachable: [] };
    var all = document.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (!visible(el)) continue;
      var cs = getComputedStyle(el);
      var r = el.getBoundingClientRect();
      if (r.width < 1 || cs.position === 'fixed') continue;
      /* 整体在视口外 → 跳过：侧滑菜单等是**故意**定位到屏幕外待滑入的（右缘 <0 / 左缘 >视口），
         它们不是"被裁掉看不到的内容"。首版没这条，于是每次都在顶栏误报一批 ✗ */
      if (r.right < 0 || r.left > vw) continue;
      if (cs.textOverflow === 'ellipsis' || el.hasAttribute('title')) continue;
      var cb = clipBoxOf(el);
      if (!cb || cb.scrollable) continue;
      var cr = cb.el.getBoundingClientRect();
      if (r.right > cr.right + 1 || r.left < cr.left - 1) {
        out.unreachable.push(sel(el) + ' 右缘 ' + Math.round(r.right) + ' 超出裁切祖先 ' +
          sel(cb.el) + '（右缘 ' + Math.round(cr.right) + '，视口 ' + vw + '）');
      }
    }
    out.unreachable = out.unreachable.filter(function (v, i, a) { return a.indexOf(v) === i; }).slice(0, 6);
    return out;
  }
  function modalProbe(done) {
    var H = globalThis.__TY_HELPERS__ || {};
    if (typeof H.confirmAsync !== 'function') { done({ skipped: true }); return; }
    var p = null;
    try { p = H.confirmAsync('布局抽查：模态是否超出视口？', { title: '布局抽查' }); } catch (e) { done({ error: e.message }); return; }
    setTimeout(function () {
      var boxes = document.querySelectorAll('.modal-box'), vis = null, res = { vw: window.innerWidth };
      for (var i = 0; i < boxes.length; i++) { if (boxes[i].getBoundingClientRect().width > 0) { vis = boxes[i]; break; } }
      if (!vis) res.error = '未找到可见 .modal-box（共 ' + boxes.length + ' 个）';
      else {
        var r = vis.getBoundingClientRect(), cs = getComputedStyle(vis);
        res.w = Math.round(r.width); res.maxW = cs.maxWidth;
        res.cut = r.right > window.innerWidth + 1 || r.left < -1;
      }
      try {
        var ov = document.querySelector('.modal');
        if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
      } catch (e2) {}
      if (p && p.then) p.then(function () {}, function () {});
      done(res);
    }, 400);
  }
  function run() {
    var chunks = [];
    PAGES.forEach(function (pg) {
      try { globalThis.goPage(pg); } catch (e) {}
      try { chunks.push(pg + '##' + JSON.stringify(audit())); }
      catch (e) { chunks.push(pg + '##{"error":"' + e.message + '"}'); }
    });
    modalProbe(function (modal) {
      document.documentElement.setAttribute('data-probe',
        window.innerWidth + 'x' + window.innerHeight + '||' + chunks.join('##PAGE##') + '##PAGE##__modal__##' + JSON.stringify(modal));
    });
  }
  if (document.readyState === 'complete') setTimeout(run, 1200);
  else window.addEventListener('load', function () { setTimeout(run, 1200); });
})();
`;

function serve(dir) {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
  const srv = http.createServer(function (req, res) {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    const p = path.join(dir, rel);
    if (!p.startsWith(dir) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.statusCode = 404; res.end('404'); return; }
    res.setHeader('Content-Type', types[path.extname(p)] || 'application/octet-stream');
    res.end(fs.readFileSync(p));
  });
  return new Promise(function (resolve) { srv.listen(0, '127.0.0.1', function () { resolve({ srv: srv, port: srv.address().port }); }); });
}

(async function main() {
  let sizes = DEFAULT_SIZES;
  const sizeArg = process.argv.find(function (a) { return a.indexOf('--sizes=') === 0; });
  if (sizeArg) sizes = sizeArg.slice(8).split(',').map(function (s) {
    const p = s.split(/[x,]/); return [parseInt(p[0], 10), parseInt(p[1], 10)];
  });
  const budgetArg = process.argv.find(function (a) { return a.indexOf('--budget=') === 0; });
  const budget = budgetArg ? parseInt(budgetArg.slice(9), 10) : 12000;

  console.log('============================================');
  console.log('布局缩放/放大抽查（' + sizes.map(function (s) { return s.join('x'); }).join(' / ') + '，虚拟时间预算 ' + budget + 'ms）');
  /* 低于窗口最小尺寸的档位在真机上到不了（会被 tauri 的 minWidth 拦住），测它是为了看"降级行为"，
     不是验收标准 —— 明确标注，免得把"坏"当成待修缺陷。 */
  const below = sizes.filter(function (s) { return s[0] < SAFE_MIN.w || s[1] < SAFE_MIN.h; });
  if (below.length) {
    console.log('  ⚠ 低于窗口最小尺寸 ' + SAFE_MIN.w + 'x' + SAFE_MIN.h + ' 的档位（真机不可达，仅看降级）：' +
      below.map(function (s) { return s.join('x'); }).join(' / '));
  }
  const browser = findBrowser();
  if (!browser) {
    console.log('· 未找到无头浏览器（Chromium 内核）→ 跳过。');
    console.log('  本机装了 Playwright（chrome-headless-shell）或系统 Chrome 时会真正执行。');
    console.log('============================================');
    process.exit(0);
  }
  console.log('  浏览器：' + browser);
  console.log('--------------------------------------------');

  const probeFile = path.join(ROOT, '_tmp_layout_probe.js');
  const htmlFile = path.join(ROOT, '_tmp_layout_probe.html');
  fs.writeFileSync(probeFile, PROBE, 'utf8');
  fs.writeFileSync(htmlFile,
    fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace('</body>', '<script src="_tmp_layout_probe.js"></script></body>'), 'utf8');

  const { srv, port } = await serve(ROOT);
  const failures = [];
  try {
    for (const [w, h] of sizes) {
      const r = await spawnAsync(browser, ['--headless', '--disable-gpu', '--no-sandbox',
        '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync',
        '--window-size=' + w + ',' + h, '--virtual-time-budget=' + budget, '--dump-dom',
        'http://127.0.0.1:' + port + '/_tmp_layout_probe.html'], 60000);
      if (r.timedOut || r.error) {
        console.log('  窗口 ' + (w + 'x' + h).padEnd(10) + '✗ 浏览器' + (r.timedOut ? '超时 60s' : '启动失败：' + r.error));
        failures.push('窗口 ' + w + 'x' + h + '：' + (r.timedOut ? '浏览器超时' : '启动失败 ' + r.error));
        continue;
      }
      const m = /data-probe="([^"]*)"/.exec(r.out);
      if (!m) { console.log('  窗口 ' + (w + 'x' + h).padEnd(10) + '✗ 未取到探针输出'); failures.push('窗口 ' + w + 'x' + h + '：未取到探针输出'); continue; }
      const txt = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
      const parts = txt.split('##PAGE##');
      const head = parts[0].split('||')[0];
      let bad = 0;
      parts.slice(1).forEach(function (chunk) {
        const i = chunk.indexOf('##');
        if (i < 0) return;
        const name = chunk.slice(0, i);
        let o; try { o = JSON.parse(chunk.slice(i + 2)); } catch (e) { return; }
        if (name === '__modal__') {
          if (o.cut) { failures.push('窗口 ' + head + '：【模态超视口】.modal-box 宽 ' + o.w + ' > 视口 ' + o.vw + '（max-width=' + o.maxW + '）'); bad++; }
          return;
        }
        if (o.docOverflowX > 1) { failures.push('窗口 ' + head + '：[' + name + '] 文档级横向溢出 ' + o.docOverflowX + 'px'); bad++; }
        (o.unreachable || []).forEach(function (u) { failures.push('窗口 ' + head + '：[' + name + '] ' + u); bad++; });
      });
      console.log('  窗口 ' + head.padEnd(10) + (bad ? '✗ ' + bad + ' 项' : '✓ 通过'));
    }
  } finally {
    srv.close();
    try { fs.unlinkSync(probeFile); } catch (e) {}
    try { fs.unlinkSync(htmlFile); } catch (e) {}
  }

  console.log('--------------------------------------------');
  if (failures.length) {
    console.log('✗ 发现 ' + failures.length + ' 项：');
    failures.slice(0, 16).forEach(function (f) { console.log('    ' + f); });
    console.log('============================================');
    process.exit(1);
  }
  console.log('✓ 各档尺寸下：无文档级横向溢出、无"溢出裁切祖先且滚不到"的内容、模态未超视口');
  console.log('============================================');
  process.exit(0);
})();
