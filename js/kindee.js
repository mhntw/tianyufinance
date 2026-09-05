/* 云会计 数据互通模块
 * 双向打通：
 *   - 导入：读取精斗云导出的 xlsx（凭证 / 科目余额），写入本软件
 *   - 导出：生成精斗云可导入的 xlsx 模板（凭证导入模板 / 科目余额表）
 * 依赖 SheetJS（js/xlsx.full.min.js）全局 XLSX。
 *
 * 说明：本软件科目编码已对齐金蝶（1001/1002/1122/2202/1405/6401/6001/5601/2211/2001…），
 * 所以导入时科目代码可直接沿用，无需映射。
 */
(function (global) {
  'use strict';

  function num(v) {
    if (v === undefined || v === null || v === '') return 0;
    if (typeof v === 'number') return v;
    var s = String(v).replace(/,/g, '').replace(/[¥￥\s]/g, '');
    var n = parseFloat(s);
    return isNaN(n) ? 0 : n;
  }

  function readSheet(wb, name) {
    var ws = wb.Sheets[name];
    if (!ws) return null;
    return XLSX.utils.sheet_to_json(ws, { defval: '', raw: false });
  }

  function sheetNames(wb) {
    return wb.SheetNames || [];
  }

  // 判断一个表头行是否为「凭证表」
  function isVoucherSheet(rows) {
    if (!rows || !rows.length) return false;
    var keys = Object.keys(rows[0]);
    var hit = 0;
    ['凭证字', '凭证号', '日期', '摘要', '科目代码', '科目编码', '借方金额', '贷方金额'].forEach(function (k) {
      if (keys.indexOf(k) >= 0) hit++;
    });
    return hit >= 5;
  }

  // 判断是否为「科目余额表」
  function isBalanceSheet(rows) {
    if (!rows || !rows.length) return false;
    var keys = Object.keys(rows[0]);
    var hit = 0;
    ['科目代码', '科目名称', '期初借方', '期初贷方', '期末借方', '期末贷方'].forEach(function (k) {
      if (keys.indexOf(k) >= 0) hit++;
    });
    return hit >= 4;
  }

  /* ============== 导入 ============== */

  // 从 ArrayBuffer/二进制 解析，返回 { vouchers:[], balances:[] }
  function parseWorkbook(wb) {
    var out = { vouchers: [], balances: [] };
    sheetNames(wb).forEach(function (name) {
      var rows = readSheet(wb, name);
      if (!rows || !rows.length) return;
      if (isVoucherSheet(rows)) {
        out.vouchers = out.vouchers.concat(parseVouchers(rows));
      } else if (isBalanceSheet(rows)) {
        out.balances = out.balances.concat(parseBalances(rows));
      }
    });
    return out;
  }

  function parseVouchers(rows) {
    // 按 (凭证字 + 凭证号 + 日期) 分组，多行合成一张凭证
    var groups = {};
    var order = [];
    rows.forEach(function (r) {
      var word = (r['凭证字'] || '记') + '';
      var no = (r['凭证号'] || '').toString().trim();
      var date = (r['日期'] || '').toString().trim();
      if (!no && !date) return;
      var key = word + '|' + no + '|' + date;
      if (!groups[key]) {
        groups[key] = {
          word: word,
          no: no,
          date: normalizeDate(date),
          entries: []
        };
        order.push(key);
      }
      var code = (r['科目代码'] || r['科目编码'] || '').toString().trim();
      if (!code) return;
      var dr = num(r['借方金额']);
      var cr = num(r['贷方金额']);
      var entry = {
        code: code,
        name: (r['科目名称'] || '').toString().trim(),
        summary: (r['摘要'] || '').toString().trim(),
        dr: dr,
        cr: cr
      };
      // 核算项目（银行存款辅助等）：仅记录文本，导入后映射到银行档案
      var aux1 = (r['核算项目1名称'] || r['核算项目1代码'] || '').toString().trim();
      if (aux1) entry.aux = aux1;
      if (entry.summary || dr || cr) groups[key].entries.push(entry);
    });
    // 兜底：过滤掉没有任何有效分录的凭证——表头列名不匹配时宁可不导入，也不产生空凭证污染账套
    return order.map(function (k) { return groups[k]; }).filter(function (v) { return v.entries.length; });
  }

  function parseBalances(rows) {
    var out = [];
    rows.forEach(function (r) {
      var code = (r['科目代码'] || '').toString().trim();
      if (!code) return;
      var obDr = num(r['期初借方']);
      var obCr = num(r['期初贷方']);
      var cbDr = num(r['期末借方']);
      var cbCr = num(r['期末贷方']);
      out.push({
        code: code,
        name: (r['科目名称'] || '').toString().trim(),
        obDr: obDr,
        obCr: obCr,
        cbDr: cbDr,
        cbCr: cbCr
      });
    });
    return out;
  }

  function normalizeDate(s) {
    if (!s) return new Date().toISOString().slice(0, 10);
    // 支持 2024/1/1、2024-01-01、2024年1月1日、Excel 序列号
    if (/^\d{4}\/\d{1,2}\/\d{1,2}$/.test(s)) return s.replace(/\//g, '-');
    if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(s)) return s;
    var m = s.match(/^(\d{4})年(\d{1,2})月(\d{1,2})/);
    if (m) return m[1] + '-' + pad(m[2]) + '-' + pad(m[3]);
    var n = parseInt(s, 10);
    if (!isNaN(n) && n > 20000) {
      // Excel 日期序列号
      var d = new Date((n - 25569) * 86400 * 1000);
      return d.toISOString().slice(0, 10);
    }
    return s;
  }

  function pad(n) { return ('0' + n).slice(-2); }

  /* ============== 导出 ============== */

  // 生成精斗云「凭证导入模板」xlsx
  function buildVoucherWorkbook(vouchers) {
    var headers = ['凭证字', '凭证号', '日期', '附单据数', '摘要', '科目代码', '科目名称',
      '币种', '汇率', '借方金额', '贷方金额', '核算项目1类型', '核算项目1代码', '核算项目1名称',
      '数量', '单价', '制单人', '审核人', '过账人', '机制凭证'];
    var rows = [headers];
    var no = 1;
    vouchers.forEach(function (v) {
      (v.entries || []).forEach(function (e, i) {
        rows.push([
          v.word || '记',
          v.no || no,
          v.date,
          '',
          e.summary || '',
          e.code,
          e.name || '',
          '人民币',
          1,
          e.dr ? e.dr.toFixed(2) : '',
          e.cr ? e.cr.toFixed(2) : '',
          e.auxType || '',
          e.auxCode || '',
          e.aux || '',
          '',
          '',
          '本软件',
          '',
          '',
          ''
        ]);
      });
      no++;
    });
    var ws = XLSX.utils.aoa_to_sheet(rows);
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '凭证');
    return wb;
  }

  // 生成「科目余额表」xlsx（可作精斗云期初）
  function buildBalanceWorkbook(balances) {
    var headers = ['科目代码', '科目名称', '期初借方', '期初贷方', '本期借方', '本期贷方', '期末借方', '期末贷方'];
    var rows = [headers];
    balances.forEach(function (b) {
      rows.push([
        b.code, b.name || '',
        fmt(b.obDr), fmt(b.obCr),
        fmt(b.periodDr || 0), fmt(b.periodCr || 0),
        fmt(b.cbDr || b.obDr), fmt(b.cbCr || b.obCr)
      ]);
    });
    var ws = XLSX.utils.aoa_to_sheet(rows);
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '科目余额');
    return wb;
  }

  function fmt(n) { return n ? Number(n).toFixed(2) : ''; }

  function downloadWorkbook(wb, filename) {
    if (window.__fileSaveBridge) {
      var base = String(filename || '导出').replace(/\.xlsx$/i, '');
      __safeExportExcel(wb, base)
        .then(function (path) { window.__fileSaveBridge.toastExported(path); })
        .catch(function (e) { console.error('导出失败', e); });
    } else {
      XLSX.writeFile(wb, filename);
    }
  }

  /* ============== 固定资产卡片 导出/导入 ============== */
  // 卡片表 31 列表头（顺序严格对照资产_卡片.html struct L2245-2472）
  var ASSET_HEADERS = ['操作', '编码', '名称', '类别', '部门', '开始使用日期', '录入期间', '原值',
    '期初累计折旧', '期末累计折旧', '月折旧', '预计使用期限', '已折旧期间', '残值', '残值率%',
    '减值准备', '期初净值', '期末净值', '折旧方法', '状态', '数量', '规格型号', '存放地点',
    '使用人', '清理期间', '新增资产凭证', '清理凭证', '减值准备凭证', '其他变动凭证', '备注'];
  // 与 fixedAssets 字段的映射（跳过操作列，按列名取数）
  function _assetField(fa, key) {
    switch (key) {
      case '编码': return fa.code || '';
      case '名称': return fa.name || '';
      case '类别': return fa.category || '';
      case '部门': return fa.dept || '';
      case '开始使用日期': return fa.acqDate || '';
      case '录入期间': return fa.entryPeriod || '';
      case '原值': return fmt(fa.original);
      case '期初累计折旧': return fmt(fa.accumDeprBegin);
      case '期末累计折旧': return fmt(fa.accumDepr);
      case '月折旧': return fmt(fa.assetMonthlyDepr ? fa.assetMonthlyDepr : '');
      case '预计使用期限': return fa.life ? (fa.life + '年') : '';
      case '已折旧期间': return fa.periodUsed || '';
      case '残值': return fmt(fa.salvage);
      case '残值率%': return (fa.salvageRate != null ? Number(fa.salvageRate).toFixed(2) : '');
      case '减值准备': return fmt(fa.impairment);
      case '期初净值': return fmt(fa.netValueBegin);
      case '期末净值': return fmt(fa.netValueEnd);
      case '折旧方法': return fa.method || '';
      case '状态': return fa.status || '正常';
      case '数量': return (fa.qty != null ? fa.qty : '');
      case '规格型号': return fa.spec || '';
      case '存放地点': return fa.location || '';
      case '使用人': return fa.user || '';
      case '清理期间': return fa.cleanPeriod || '';
      case '新增资产凭证': return fa.addVoucher || '';
      case '清理凭证': return fa.cleanVoucher || '';
      case '减值准备凭证': return fa.impairVoucher || '';
      case '其他变动凭证': return fa.otherVoucher || '';
      case '备注': return fa.memo || '';
      default: return '';
    }
  }
  // 导出：把卡片数组写成 31 列 xlsx
  function buildAssetWorkbook(fixedAssets) {
    var rows = [ASSET_HEADERS];
    (fixedAssets || []).forEach(function (fa) {
      var r = [''];  // 操作列留空
      ASSET_HEADERS.slice(1).forEach(function (k) { r.push(_assetField(fa, k)); });
      rows.push(r);
    });
    var ws = XLSX.utils.aoa_to_sheet(rows);
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '固定资产卡片');
    return wb;
  }
  // 导入：解析 xlsx 回卡片数组（按 31 列表头对齐；也兼容仅含关键列的精简表）
  function parseAssetWorkbook(wb) {
    var name = (wb.SheetNames || [])[0];
    if (!name) return [];
    var rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: '', raw: false });
    if (!rows.length) return [];
    var keys = Object.keys(rows[0]);
    // 取表头中能识别的字段（编码/名称/类别/部门/原值…）
    return rows.map(function (row) {
      var get = function (cands) {
        for (var i = 0; i < cands.length; i++) { if (row[cands[i]] !== undefined && row[cands[i]] !== '') return row[cands[i]]; }
        return '';
      };
      return {
        code: get(['编码', 'code', '资产编码']),
        name: get(['名称', 'name', '资产名称']),
        category: get(['类别', 'category', '资产类别']),
        dept: get(['部门', 'dept']),
        acqDate: get(['开始使用日期', 'acqDate', '使用日期']),
        entryPeriod: get(['录入期间', 'entryPeriod']),
        original: num(get(['原值', 'original'])),
        accumDeprBegin: num(get(['期初累计折旧', 'accumDeprBegin'])),
        accumDepr: num(get(['期末累计折旧', 'accumDepr'])),
        life: num(get(['预计使用期限', 'life']).toString().replace(/[^\d.]/g, '')),
        salvage: num(get(['残值', 'salvage'])),
        salvageRate: get(['残值率%', '残值率', 'salvageRate']),
        impairment: num(get(['减值准备', 'impairment'])),
        netValueBegin: num(get(['期初净值', 'netValueBegin'])),
        netValueEnd: num(get(['期末净值', 'netValueEnd'])),
        method: get(['折旧方法', 'method']) || '平均年限法',
        status: get(['状态', 'status']) || '正常',
        qty: num(get(['数量', 'qty'])),
        spec: get(['规格型号', 'spec']),
        location: get(['存放地点', 'location']),
        user: get(['使用人', 'user']),
        cleanPeriod: get(['清理期间', 'cleanPeriod']),
        addVoucher: get(['新增资产凭证', 'addVoucher']),
        cleanVoucher: get(['清理凭证', 'cleanVoucher']),
        impairVoucher: get(['减值准备凭证', 'impairVoucher']),
        otherVoucher: get(['其他变动凭证', 'otherVoucher']),
        memo: get(['备注', 'memo'])
      };
    }).filter(function (fa) { return fa.name && fa.original; });
  }

  global.KinDee = {
    parseWorkbook: parseWorkbook,
    buildVoucherWorkbook: buildVoucherWorkbook,
    buildBalanceWorkbook: buildBalanceWorkbook,
    buildAssetWorkbook: buildAssetWorkbook,
    parseAssetWorkbook: parseAssetWorkbook,
    downloadWorkbook: downloadWorkbook,
    // 暴露内部解析函数便于测试
    _parseVouchers: parseVouchers,
    _parseBalances: parseBalances,
    _isVoucherSheet: isVoucherSheet,
    _isBalanceSheet: isBalanceSheet
  };
})(window);
