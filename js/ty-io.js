/* 固定资产卡片 数据互通模块
 * 通过 xlsx 实现固定资产卡片的导入与导出：
 *   - 导出：把卡片数组写成 31 列 xlsx（兼容外部导出的卡片表头）
 *   - 导入：解析 xlsx 回卡片数组（按 31 列表头对齐；也兼容仅含关键列的精简表）
 * 依赖 SheetJS（js/xlsx.full.min.js）全局 XLSX。
 *
 * 本软件科目编码采用标准方案（1001/1002/1122/2202/1405/6401/6001/5601/2211/2001…），
 * 导入时科目代码可直接沿用，无需映射。
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
  // 固定资产导入专用金额清洗：处理会计括号负数 (1,000) → -1000，再剥掉千分位/货币符号
  function cleanNum(v) {
    if (v === undefined || v === null || v === '') return 0;
    if (typeof v === 'number') return v;
    var s = String(v).trim();
    if (/^\(.*\)$/.test(s)) s = '-' + s.replace(/[()]/g, '');
    return num(s.replace(/[^\d.\-]/g, ''));
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
  // 导入：解析 xlsx 回卡片数组
  // 采用「表头别名映射」——既兼容本软件导出的 31 列表头，
  // 也兼容外部账套固定资产清单常见叫法（资产编码/资产名称/原值…）。
  /* 使用期限的两套口径（外部账套混用，必须分清）：
   *   年限组：使用年限 / 折旧年限 / 预计使用年限 … → 数值就是「年」
   *   期数组：预计使用期数 / 预计使用期限 / 使用期数 … → 数值是「月」，要 ÷12
   * 【踩坑记录】旧实现只看单元格里有没有"年"字：`(v && r.indexOf('年') < 0) ? v / 12 : v`。
   * 于是「使用年限 = 5」（纯数字）被当成 5 期 → 0.42 年，月折旧由 1,000 变 12,000（放大 12 倍）。
   * 现在改为【按命中的列名分组】判定，并加合理性兜底（见 lifeToYears）。
   * 注：「使用期限」本身歧义（两种账套都在用），故归入年限组后由兜底纠正。 */
  var LIFE_YEAR_ALIASES = ['使用年限', '折旧年限', '预计使用年限', '预计使用年数', '使用年数', '使用期限', 'life', 'usefulyears', 'usefullife'];
  var LIFE_MONTH_ALIASES = ['预计使用期数', '预计使用期限', '使用期数', '折旧期数', '预计折旧期数'];
  var FA_ALIASES = {
    code:           ['编码', '资产编码', '卡片编号', '卡片编码', '代码', '编号', '资产代码', 'cardno', 'code'],
    name:           ['名称', '资产名称', '固定资产名称', 'cardname', 'name'],
    category:       ['类别', '资产类别', '固定资产类别', 'category'],
    dept:           ['部门', '使用部门', 'dept', 'department'],
    acqDate:        ['入账日期', '开始使用日期', '投入使用日期', '使用日期', '购置日期', 'acqdate', 'usedate'],
    entryPeriod:    ['录入期间', '入账期间', '会计期间', 'entryperiod'],
    original:       ['原值', '资产原值', '固定资产原值', 'original', 'cost'],
    accumDeprBegin: ['期初累计折旧', '累计折旧期初', 'accumdeprbegin'],
    // 顺序即优先级：「期末累计折旧」必须排在「累计折旧」之前 —— 两列并存时前者才是期末值
    accumDepr:      ['期末累计折旧', '累计折旧', '已提折旧', 'accumdepr'],
    life:           LIFE_YEAR_ALIASES.concat(LIFE_MONTH_ALIASES),
    // 金蝶卡片列表导出带「月折旧额」：只作导入体检的交叉校验值，不落库（卡片月折旧由 assetMonthlyDepr 统一算）
    monthDeprRef:   ['月折旧额', '月折旧', 'monthlydepr'],
    salvage:        ['残值', '净残值', '预计净残值', 'salvage'],
    salvageRate:    ['残值率', '净残值率', '预计残值率%', '残值率%', 'salvageRate', 'salvagerate'],
    impairment:     ['减值准备', 'impairment'],
    netValueBegin:  ['期初净值', '净值期初', 'netvaluebegin'],
    netValueEnd:    ['期末净值', '净值期末', 'netvalueend'],
    method:         ['折旧方法', '折旧方式', 'method', 'deprmethod'],
    status:         ['状态', '使用状况', '使用状态', 'status'],
    qty:            ['数量', 'qty'],
    spec:           ['规格型号', '规格', '型号', 'spec', 'model'],
    location:       ['存放地点', '存放位置', '地点', 'location'],
    user:           ['使用人', '保管人', '责任人', 'user', 'keeper'],
    cleanPeriod:    ['清理期间', 'cleanperiod'],
    addVoucher:     ['新增资产凭证', '增加凭证', 'addvoucher'],
    cleanVoucher:   ['清理凭证', 'cleanvoucher'],
    impairVoucher:  ['减值准备凭证', 'impairvoucher'],
    otherVoucher:   ['其他变动凭证', 'othervoucher'],
    memo:           ['备注', '摘要', '说明', 'memo', 'remark'],
    periodUsed:     ['已折旧期间数', '已折旧期间', 'periodused'],
    yearDepr:       ['本年已折旧', 'yeardepr'],
    // 科目字段：对齐「卡片新增」表单的 7 个科目选择，外部账套模板导出里直接带这些列
    faAcctId:       ['固定资产科目', 'faacctid'],
    accDeprAcct:    ['累计折旧科目', 'accdeptacct'],
    deprFeeAcct:    ['折旧费用科目', 'deprfeeacct'],
    cleanAcct:      ['资产清理科目', 'cleanacct'],
    purchaseAcct:   ['资产购入对方科目', 'purchaseacct'],
    taxAcct:        ['税金科目', 'taxacct'],
    impairAcct:     ['减值准备对方科目', 'impairacct']
  };
  function faNorm(s) { return (s == null ? '' : String(s)).trim().toLowerCase().replace(/[\s_\-()（）]/g, ''); }
  var FA_ALIAS_NORM = {};
  Object.keys(FA_ALIASES).forEach(function (f) { FA_ALIAS_NORM[f] = FA_ALIASES[f].map(faNorm); });
  // 根据表头行（数组）建立「字段 -> 列序号」映射；先精确匹配，再子串兜底
  // 命中的列名是否属于「期数(月)」组
  function lifeIsMonthAlias(alias) {
    var a = faNorm(alias || '');
    if (!a) return false;
    for (var i = 0; i < LIFE_MONTH_ALIASES.length; i++) { if (faNorm(LIFE_MONTH_ALIASES[i]) === a) return true; }
    return false;
  }
  /* 使用期限 → 年（唯一实现）。三步：
   *   ① 单元格自带"年"字（如 "5年"）→ 按年；
   *   ② 否则按【命中的列名分组】：年限组原样、期数组 ÷12；
   *   ③ 合理性兜底：结果 >50 年 或 <0.5 年 时换另一种口径，换后合理就采用
   *      —— 这一步专门兼容「使用期限 = 60」这类歧义列名（归在年限组，但 60 年不合理 → 按 60 期 = 5 年）。 */
  function lifeToYears(rawVal, alias) {
    var txt = String(rawVal == null ? '' : rawVal);
    var v = cleanNum(txt);
    if (!v) return 0;
    var monthBase = (txt.indexOf('年') < 0) && lifeIsMonthAlias(alias);
    var y = monthBase ? v / 12 : v;
    if (y > 50 || y < 0.5) {
      var alt = monthBase ? v : v / 12;
      if (alt >= 0.5 && alt <= 50) y = alt;
    }
    return Math.round(y * 10000) / 10000;   // 保留 4 位：期数 14 → 1.1667 年 → ×12 仍精确回到 14
  }
  function buildAssetColMap(headerArr) {
    var fieldToCol = {}, colTaken = {}, fieldAlias = {};
    /* 精确匹配：**字段序在外、列序在内**，同一字段的多个同义列由【别名顺序】定优先级。
     * 【为什么不能按列序先到先得】实测：文件同时含「累计折旧」和「期末累计折旧」两列时，
     * 按列序命中的那一列赢、另一列被静默忽略 ——
     *   表头 期初,累计折旧,期末 → 期末取到「累计折旧」列（可能不是期末值）；
     *   表头 期初,期末,累计折旧 → 期末取到「期末累计折旧」列 ✓
     * 同一份数据、仅列序不同就取到不同的值，属静默取错。改为别名顺序定优先级后，
     * 「期末累计折旧」恒优先于「累计折旧」（见 FA_ALIASES.accumDepr 的顺序）。 */
    Object.keys(FA_ALIAS_NORM).forEach(function (f) {
      if (fieldToCol[f] !== undefined) return;
      FA_ALIAS_NORM[f].forEach(function (alias) {
        if (fieldToCol[f] !== undefined || !alias) return;
        for (var ci = 0; ci < (headerArr || []).length; ci++) {
          if (colTaken[ci]) continue;
          if (faNorm(headerArr[ci]) === alias) { fieldToCol[f] = ci; colTaken[ci] = true; fieldAlias[f] = headerArr[ci]; return; }
        }
      });
    });
    (headerArr || []).forEach(function (cell, ci) {
      if (colTaken[ci]) return;
      var nh = faNorm(cell);
      if (nh.length < 2) return;
      if (nh.indexOf('科目') >= 0) return; // 会计科目列(如累计折旧科目)只含编码,不能充作金额字段
      Object.keys(FA_ALIAS_NORM).forEach(function (f) {
        if (fieldToCol[f] !== undefined) return;
        FA_ALIAS_NORM[f].forEach(function (a) {
          if (a.length >= 2 && nh.indexOf(a) >= 0) { fieldToCol[f] = ci; colTaken[ci] = true; fieldAlias[f] = cell; }
        });
      });
    });
    return { col: fieldToCol, alias: fieldAlias };
  }
  // 扫描工作表，找真正的表头行：含可识别字段关键字最多的那一行。
  // 外部账套导出常在表头前放标题行/副标题行（如「卡片」「云会计演示账套」），
  // 不能直接把首行当表头，否则后续列全部取不到。
  function findAssetHeaderRow(aoa) {
    var bestIdx = 0, bestScore = 2;
    for (var idx = 0; idx < aoa.length && idx <= 20; idx++) {
      var score = 0;
      (aoa[idx] || []).forEach(function (cell) {
        var nh = faNorm(cell);
        if (!nh) return;
        Object.keys(FA_ALIAS_NORM).forEach(function (f) {
          if (FA_ALIAS_NORM[f].indexOf(nh) >= 0) score++;
        });
      });
      if (score > bestScore) { bestScore = score; bestIdx = idx; }
    }
    return bestIdx;
  }
  function parseAssetWorkbook(wb) {
    var name = (wb.SheetNames || [])[0];
    if (!name) return [];
    var aoa = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '', raw: false });
    if (!aoa.length) return [];
    var headerIdx = findAssetHeaderRow(aoa);
    var colMap = buildAssetColMap(aoa[headerIdx]);
    var fieldToCol = colMap.col, fieldAlias = colMap.alias;
    var get = function (field, row) {
      var ci = fieldToCol[field];
      return ci !== undefined ? (row[ci] == null ? '' : row[ci]) : '';
    };
    var out = [];
    for (var i = headerIdx + 1; i < aoa.length; i++) {
      var arr = aoa[i];
      if (!arr || !arr.length) continue;
      var hasVal = arr.some(function (c) { return c !== '' && c != null; });
      if (!hasVal) continue;
      var fa = {
        code: get('code', arr),
        name: get('name', arr),
        category: get('category', arr),
        dept: get('dept', arr),
        acqDate: get('acqDate', arr),
        entryPeriod: get('entryPeriod', arr),
        original: cleanNum(get('original', arr)),
        accumDeprBegin: cleanNum(get('accumDeprBegin', arr)),
        accumDepr: cleanNum(get('accumDepr', arr)),
        // 使用期限折算为"年"：按命中的列名分组（年限组/期数组）+ 合理性兜底，见 lifeToYears
        life: lifeToYears(get('life', arr), fieldAlias.life),
        // 残值：优先取文件「残值」列；若文件只给残值率%没给残值(外部账套常见)，按「原值×残值率%」补算，与卡片新增表单同逻辑，否则折旧基数会算错
        salvage: (function () {
          var s = cleanNum(get('salvage', arr));
          if (s > 0) return s;
          var r = cleanNum(get('salvageRate', arr));
          var o = cleanNum(get('original', arr));
          return (o > 0 && r > 0) ? o * r / 100 : s;
        })(),
        salvageRate: get('salvageRate', arr),
        impairment: cleanNum(get('impairment', arr)),
        netValueBegin: cleanNum(get('netValueBegin', arr)),
        netValueEnd: cleanNum(get('netValueEnd', arr)),
        method: get('method', arr) || '平均年限法',
        status: get('status', arr) || '正常',
        qty: cleanNum(get('qty', arr)),
        spec: get('spec', arr),
        location: get('location', arr),
        user: get('user', arr),
        cleanPeriod: get('cleanPeriod', arr),
        addVoucher: get('addVoucher', arr),
        cleanVoucher: get('cleanVoucher', arr),
        impairVoucher: get('impairVoucher', arr),
        otherVoucher: get('otherVoucher', arr),
        memo: get('memo', arr),
        periodUsed: cleanNum(get('periodUsed', arr)),
        yearDepr: cleanNum(get('yearDepr', arr)),
        // 金蝶卡片列表导出的「月折旧额」：仅作导入体检的交叉校验值，落库前由导入方删除
        monthDeprRef: cleanNum(get('monthDeprRef', arr)),
        faAcctId: get('faAcctId', arr),
        accDeprAcct: get('accDeprAcct', arr),
        deprFeeAcct: get('deprFeeAcct', arr),
        cleanAcct: get('cleanAcct', arr),
        purchaseAcct: get('purchaseAcct', arr),
        taxAcct: get('taxAcct', arr),
        impairAcct: get('impairAcct', arr)
      };
      if (fa.name) out.push(fa);
    }
    return out;
  }

  global.TyIo = {
    buildAssetWorkbook: buildAssetWorkbook,
    parseAssetWorkbook: parseAssetWorkbook
  };
})(window);
