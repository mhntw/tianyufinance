/* 固定资产卡片 数据互通模块
 * 通过 xlsx 实现固定资产卡片的导入与导出：
 *   - 导出：把卡片数组写成 31 列 xlsx（兼容外部导出的卡片表头）
 *   - 导入：解析 xlsx 回卡片数组（按 31 列表头对齐；也兼容仅含关键列的精简表）
 * 依赖 SheetJS（js/xlsx.full.min.js）全局 XLSX。
 *
 * 说明：本软件科目编码已对齐参考实现（1001/1002/1122/2202/1405/6401/6001/5601/2211/2001…），
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

  function fmt(n) { return n ? Number(n).toFixed(2) : ''; }

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

  global.TyIo = {
    buildAssetWorkbook: buildAssetWorkbook,
    parseAssetWorkbook: parseAssetWorkbook
  };
})(window);
