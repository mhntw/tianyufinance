/* ============================================================
 * ais-tool/convert.js —— 金蝶 .ais → 本软件账套 .json 转换器
 *
 * 【这是什么】从主软件拆出来的独立转换工具（2026-10-22）。主软件只导入 .json，
 *   金蝶账套的解析（mdb-reader 二进制解析 + kis-import 转换，约 2.4 万行）
 *   整体搬到这里。本文件只是**页面胶水**：选文件 → 调 KisImport → 预览 → 下载。
 *
 * 【为什么脚本标签必须静态引全四个】kis-import.js 的 ensureMdbReader() 里写死了
 *   `loadScript('js/buffer.js')` 这样的**相对路径**，本页在子目录下解析不到。
 *   而 mdbReady() 为 true 时它直接 resolve、根本不走 loadScript —— 所以 index.html
 *   必须**按顺序静态引入** buffer.js → mdb-reader.js → standards.js → kis-import.js。
 *   ⚠ 这四行 <script> 不是可选的，删掉任何一行本页都会报「解析模块未加载」。
 *
 * 【最重要的红线：输出的 json 里绝对不能出现 schemaVersion】
 *   主软件 store.importExternalBook 的金额单位判据是：
 *       if (book.schemaVersion !== SCHEMA_VERSION) migrateAmountsToV6(book);
 *   它靠「**没有** schemaVersion」来判定"这是元单位、需要 ×10000 迁移"。
 *   KisImport 产出的 ledger 金额是**元**（保留 4 位精度），且有意不打版本号。
 *   一旦这里"好心"补一个 schemaVersion: 6，迁移就被跳过 → 金额少乘 10000 倍 ——
 *   整本账数字错一万倍，而且每个数看起来都自洽（store.js 该处注释原话：
 *   "最难查的一类数据事故"）。
 *   故本文件只做 JSON.stringify(res.ledger)，**一个字段都不加、一个都不改**。
 *   卡口：tools/verify_import_contract.js 会静态扫描本文件与 kis-import.js。
 * ============================================================ */
(function () {
  'use strict';

  /* ---------- 与主软件同源的两个小函数（镜像，勿单方面改） ----------
   * 为什么内联而不 import：本页要能**双击直接打开**（file:// 协议），
   * ES module 的 import 在 file:// 下被 CORS 挡死，只能靠经典 <script>。
   * 这两个函数在 js/common/import-classify.js 是权威版；那里若改，这里要同步。 */
  function safeIdOf(name) {
    var s = String(name == null ? '' : name).replace(/[\\/:*?"<>|]/g, '_').trim();
    return Array.from(s).slice(0, 60).join('');
  }
  function importErrText(e) {
    var d = String((e && e.message) || e || '').trim() || '未知错误';
    if (/Wrong page type|assertPageType|Expected \d+ but received|Invalid page|not a valid/i.test(d)) {
      return '这不是有效的金蝶账套文件（.ais），或文件已损坏；请确认导出的是金蝶「账套文件(.ais)」'
        + '（报表、凭证列表、Excel 都不是账套文件）。技术详情：' + d;
    }
    if (/MDBReader|解析库/.test(d)) return '解析模块未加载，请刷新页面后重试';
    return d;
  }

  var $ = function (id) { return document.getElementById(id); };
  var lastLedger = null;   // 最近一次成功转换的 ledger（仅供下载，不做任何加工）

  function say(msg, kind) {
    var box = $('status');
    if (!box) return;
    box.textContent = msg;
    box.className = 'status ' + (kind || 'info');
  }

  /* ---------- 预览：把 stats 里已有的事实摆给用户看 ----------
   * 【为什么值得做】这些信息（借贷不平几张、科目重复几个、期初币种回退、跨年差异）
   *   以前是**导入主软件之后**才看到的。放到这里，用户在下载前就能判断"这次转换可不可信"，
   *   而不是导入后才发现问题、再回头怀疑是导入器错了。 */
  function renderPreview(res, bookName) {
    var book = res && res.ledger;
    var stats = (res && res.stats) || {};
    var rows = [];

    rows.push(['账套名称', bookName]);
    rows.push(['科目', (book.subjects || []).length + ' 个']);
    rows.push(['凭证', (book.vouchers || []).length + ' 张']);
    if (stats.vchRows != null && stats.vchRows > 0) {
      rows.push(['分录源行数', stats.vchRows + ' 行 → ' + (book.vouchers || []).length + ' 张凭证']);
    }
    if (stats.company) rows.push(['金蝶账套名', stats.company]);

    var warns = [];
    if (stats.unbalancedVouchers) {
      warns.push('借贷不平凭证 ' + stats.unbalancedVouchers + ' 张 —— 请核对源账套（这些凭证在原金蝶里就不平）');
    }
    if (stats.currencyFallback) {
      warns.push('期初余额按币种 ' + stats.currencyFallback + ' 导入（账套无综合币汇总行）');
    }
    if (stats.dupSubjects && stats.dupSubjects.length) {
      warns.push('已去重 ' + stats.dupSubjects.length + ' 个重复科目编码（金蝶 GLAcct 的正常现象）');
    }
    // 多年合并：跨年一致性校验 + 每年凭证数
    if (stats.yearBoundaries && stats.yearBoundaries.length) {
      stats.yearBoundaries.forEach(function (b) {
        if (b.checked > 0) {
          warns.push(b.fromYear + '→' + b.toYear + '：' + b.checked + ' 个科目期初与上年期末不一致，最大差异 '
            + Math.abs(b.maxDiff).toFixed(2) + ' 元');
        } else {
          rows.push([b.fromYear + '→' + b.toYear + ' 年结校验', '通过']);
        }
      });
    }
    if (stats.perYear && stats.perYear.length) {
      rows.push(['每年凭证数', stats.perYear.map(function (y) { return y.year + '年(' + y.vouchers + '张)'; }).join(' ')]);
    }
    (res && res.warnings || []).forEach(function (w) { warns.push(String(w)); });

    var html = '<table class="pv">';
    rows.forEach(function (r) {
      html += '<tr><th>' + esc(r[0]) + '</th><td>' + esc(r[1]) + '</td></tr>';
    });
    html += '</table>';
    if (warns.length) {
      html += '<div class="warnbox"><b>需要你留意（不影响转换，但建议核对）：</b><ul>'
        + warns.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul></div>';
    }
    $('preview').innerHTML = html;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------- 主流程 ---------- */
  function run() {
    var input = $('aisFile');
    var files = input && input.files ? Array.from(input.files) : [];
    if (!files.length) { say('请先选择 .ais 文件', 'error'); return; }
    if (!window.KisImport || typeof window.KisImport.parse !== 'function') {
      say('解析模块未加载，请刷新页面后重试', 'error'); return;
    }

    var nameInput = $('bookName');
    var bookName = (nameInput && nameInput.value || '').trim();
    if (!bookName) {
      // 默认名：第一个文件名去掉 _YYYY年_ 后缀（与主软件原 handleMultiYearImport 同规则）
      bookName = (files[0].name || '账套').replace(/[_\s]*\d{4}\s*年.*$/, '').trim() || '金蝶账套';
    }

    $('btnConvert').disabled = true;
    $('btnDownload').disabled = true;
    lastLedger = null;
    say('正在解析（大文件可能需数十秒）…', 'info');

    var p = files.length >= 2
      ? window.KisImport.parseMulti(files, { baseName: bookName })
      : window.KisImport.parse(files[0]);

    p.then(function (res) {
      var book = res && res.ledger;
      if (!book || !Array.isArray(book.subjects) || !book.subjects.length) {
        say('转换中止：账套科目为空或文件有问题', 'error'); return;
      }
      if (!Array.isArray(book.vouchers)) {
        say('转换中止：凭证数据异常', 'error'); return;
      }
      /* ⚠ 只原样保存 ledger，**不得**补 schemaVersion / 不得改任何金额（见文件头红线说明）。 */
      lastLedger = book;
      renderPreview(res, bookName);
      say('转换完成：' + book.subjects.length + ' 科目 / ' + book.vouchers.length + ' 凭证。'
        + '请检查下面的信息，确认后点「下载账套 .json」', 'ok');
      $('btnDownload').disabled = false;
    }).catch(function (e) {
      say('转换失败：' + importErrText(e), 'error');
    }).then(function () {
      $('btnConvert').disabled = false;
    });
  }

  function download() {
    if (!lastLedger) { say('请先完成一次转换', 'error'); return; }
    var name = (($('bookName') || {}).value || '').trim() || '金蝶账套';
    var fname = safeIdOf(name) + '_' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '.json';
    var blob = new Blob([JSON.stringify(lastLedger)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fname;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    say('已下载 ' + fname + ' —— 到主软件「设置 → 账套管理 → 导入账套」选这个文件即可', 'ok');
  }

  document.addEventListener('DOMContentLoaded', function () {
    var bc = $('btnConvert');
    if (bc) bc.addEventListener('click', run);
    var bd = $('btnDownload');
    if (bd) bd.addEventListener('click', download);
    // 选好文件后自动带出默认账套名（取第一个文件名，去掉年份后缀）
    var inp = $('aisFile');
    if (inp) inp.addEventListener('change', function () {
      var f = inp.files && inp.files[0];
      if (f && $('bookName') && !$('bookName').value) {
        $('bookName').value = (f.name || '').replace(/[_\s]*\d{4}\s*年.*$/, '').trim() || '金蝶账套';
      }
    });
  });
})();
