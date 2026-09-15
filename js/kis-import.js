/*
 *   账套 (.ais) 纯前端导入
 *   的 .ais 本质是 Jet/Access (MDB) 数据库，无需软件、无需解密，
 * 也无需 Python / mdbtools。本模块在浏览器内用 mdb-reader 直接解析 .ais，
 * 将科目/凭证/余额转换为本软件 ledger 结构（与 import_kis.py 逻辑等价）。
 * 依赖：js/mdb-reader.js（已挂载 window.MDBReader）
 * 使用：window.KisImport.parse(arrayBufferOrFile) -> Promise<{ledger, stats}>
 */
(function (global) {
  'use strict';

  // 导入科目类别权威表：项目内建准则（standards.js）的一级科目编码 → cls。
  // 必须在标准模板上求 cls，而不是纯靠编码前缀/方向启发式——历史 bug 曾把
  // 4001 生产成本 → equity、2401 递延收益 → asset、5301 营业外收入 → expense
  // 分错，导致利润表「页面行合计 ≠ 数据层 netProfit」（I10 恒等式 FAIL，差额恰为
  // 这些科目当月发生额）。凡命中本表一级编码的科目（含其 4-2-2 下级子科目），
  // 一律采用模板权威类别，杜绝启发式误判；模板未覆盖的自定义编码才走启发式。
  function standardClsOf(code) {
    var c = (code || '').trim();
    var std = global.STANDARDS;
    if (!std) return null;
    // 同时合并两套准则模板：旧准则 5xxx 与小企业 2013 的 6xxx 编码并存，均可命中
    var list = [];
    if (std.old && std.old.subjects) list = list.concat(std.old.subjects);
    if (std.small2013 && std.small2013.subjects) list = list.concat(std.small2013.subjects);
    var best = null;
    list.forEach(function (s) {
      if (!s || !s.code) return;
      if (c === s.code || (c.length > s.code.length && c.indexOf(s.code) === 0)) {
        if (!best || s.code.length > best.code.length) best = s;
      }
    });
    return best ? best.cls : null;
  }

  // 模板分录方向兜底：按科目权威类别（资产/成本/费用→借，负债/权益/收入→贷）。
  // 仅用于金蝶老模式模板（GLVchTemplate1 无方向字段、金额又为空）的方向预置，
  // 与金蝶套用行为一致；少数反向业务（如提现的银行存款）需套用后微调。
  function tplSideOfCode(code) {
    var cls = standardClsOf(code);
    if (cls === 'liability' || cls === 'equity' || cls === 'revenue') return 'cr';
    return 'dr';
  }

  // 科目表 GLAcct.FGroup 的权威分类（账套实测规律）：
  // 101/102 资产（流动/非流动）、201/202 负债（流动/长期）、301 权益、
  // 400/401 成本、501/502 收入、503~507 费用。
  // 用途：写入科目 grpCls，仅作「展示分类」（科目页分类 Tab / 科目类别列），
  // 保证与界面一致；取数口径仍用 cls（结转损益、报表等按 cls 白名单/规则取数）。
  function tyGroupCls(group) {
    var g = parseInt(group, 10);
    if (!g) return null;
    if (g >= 101 && g <= 102) return 'asset';
    if (g >= 201 && g <= 202) return 'liability';
    if (g === 301) return 'equity';
    if (g === 400 || g === 401) return 'cost';
    if (g >= 501 && g <= 502) return 'revenue';
    if (g >= 503 && g <= 507) return 'expense';
    return null;
  }

  function classify(code, dc) {
    var c = (code || '').trim();
    // 权威优先：命中标准准则一级科目（含子科目）直接采用模板类别
    var tpl = standardClsOf(c);
    if (tpl) return tpl;
    // 成本类（生产成本/制造费用/研发支出/工程施工等）：归 cost，
    // 不能落进 expense——否则结转损益会把生产成本余额结转到本年利润（错误）
    if (/^(4001|4002|4101|4301|4401|4403)/.test(c)) return 'cost';
    var asset = ["1001","1002","1012","1101","1121","1122","1123","1131","1132","1221","1231","1321","1601","1602","1604","1701","1801","1901","100","101","102","110","112","113","122","123","132","160","170","180","190"];
    var liab  = ["2001","2201","2202","2203","2211","2221","2231","2241","2401","2501","2701","2801","200","220","221","222","223","224","240","250","270","280"];
    // 权益类。含「以前年度损益调整」/自定义变体（6901 企业会计制度、6000 自定义），
    // 该科目属权益调整（不进当期损益、不是资产），若落入 asset 兜底会在资产负债表资产侧污染（H2 教训同源）。
    var eq     = ["3001","3002","3101","3103","3104","4103","4104","6000","6901","300","310","410"];
    var exp    = ["4001","4002","4101","5001","5051","5111","5201","5301","5401","5402","5403","5601","5602","5603","5701","5711","5801","400","500","505","511","520","530","540","560","570","580"];
    function starts(arr){ for (var i=0;i<arr.length;i++){ if (c.indexOf(arr[i])===0) return true; } return false; }
    if (starts(asset)) return 'asset';
    if (starts(liab))  return 'liability';
    if (starts(eq))    return 'equity';
    if (starts(exp)) {
      // 损益类：优先用 FDC 方向判断（C=贷方=收入类，D=借方=费用类）。
      // 修复 H2：5301 营业外收入 FDC=C 应归 revenue，原硬编码归 expense 导致利润表漏取。
      if (dc === 'C') return 'revenue';
      if (dc === 'D') return 'expense';
      // 无 dc 回退（外部调用兼容）：保留原编码前缀逻辑
      if (c.indexOf("5001")===0 || c.indexOf("5051")===0 || c.indexOf("5111")===0 || c.indexOf("5301")===0 || c.indexOf("500")===0 || c.indexOf("505")===0 || c.indexOf("511")===0 || c.indexOf("530")===0) return 'revenue';
      return 'expense';
    }
    return 'asset';
  }

  function parseDate(s) {
    if (!s) return '';
    function pad(n){ return (n<10?'0':'')+n; }
    // 1) JS Date 对象：mdb-reader 对 DateTime 列（如 FDate）返回 Date。
    // 其内部是 UTC 纪元毫秒，须用 UTC 取值，避免负时区环境下日期回退一天。
    if (s instanceof Date || (s && typeof s.getTime === 'function')) {
      if (isNaN(s.getTime())) return '';
      return s.getUTCFullYear() + '-' + pad(s.getUTCMonth() + 1) + '-' + pad(s.getUTCDate());
    }
    var str = String(s).trim();
    if (!str) return '';
    // 2) 纯数字：OLE/Excel 日期序列号（自 1899-12-30 起的天数）
    if (/^\d+(\.\d+)?$/.test(str)) {
      var n = parseFloat(str);
      if (n > 1) {
        var d = new Date(Math.round((n - 25569) * 86400000));
        if (!isNaN(d.getTime()) && d.getUTCFullYear() > 1900) {
          return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
        }
      }
    }
    // 3) 字符串：YYYY[-/.]M[-/.]D（四位数年份优先，避免二位数歧义）
    var m = str.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (m) return m[1] + '-' + pad(+m[2]) + '-' + pad(+m[3]);
    // 4) 字符串：M/D/YY 或 M/D/YYYY（旧文本格式）
    m = str.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (m) {
      var yy = parseInt(m[3],10);
      var yyyy = yy < 100 ? (yy < 70 ? 2000 + yy : 1900 + yy) : yy;
      return yyyy + '-' + pad(parseInt(m[1],10)) + '-' + pad(parseInt(m[2],10));
    }
    // 5) 中文日期：YYYY年M月D日
    m = str.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
    if (m) return m[1] + '-' + pad(+m[2]) + '-' + pad(+m[3]);
    return '';
  }

  function getRows(reader, table) {
    var names = reader.getTableNames();
    if (names.indexOf(table) === -1) return [];
    var tbl = reader.getTable(table);
    return tbl.getData() || [];
  }

  // 兼容 buffer polyfill 以 {Buffer,...} 命名空间形式暴露的情况，取真正的构造器
  function getBufferCtor() {
    var B = global.Buffer;
    if (!B) return null;
    if (typeof B.alloc === 'function') return B;        // 已是构造器
    if (B.Buffer && typeof B.Buffer.alloc === 'function') return B.Buffer; // 命名空间形态
    return null;
  }

  // 统一把输入转为 mdb-reader 可用的 Buffer（浏览器用 buffer polyfill 的全局 Buffer）
  function toBuffer(input) {
    var B = getBufferCtor();
    if (B && B.isBuffer && B.isBuffer(input)) return input;
    if (B && B.from) {
      if (input instanceof ArrayBuffer) return B.from(input);
      if (input instanceof Uint8Array) return B.from(input);
      if (input && input.buffer instanceof ArrayBuffer) return B.from(input.buffer, input.byteOffset, input.byteLength);
    }
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    return input;
  }

  function convert(buffer, fileName) {
    var M = global.MDBReader;
    var MDBReader = (M && (M.default || M.MDBReader)) || M;
    if (typeof MDBReader !== 'function') throw new Error('解析库未加载 (MDBReader)');
    var reader = new MDBReader(toBuffer(buffer));

    // 1. 科目
    var acctRows = getRows(reader, 'GLAcct');
    var subjects = [];
    var acctName = {};
    var seenCode = {};
    var dupCodes = [];
    acctRows.forEach(function (r) {
      var code = (r.FAcctID || '').toString().trim();
      var name = (r.FAcctName || '').toString().trim();
      if (!code) return;
      if (seenCode[code]) { if (dupCodes.indexOf(code)===-1) dupCodes.push(code); return; }
      seenCode[code] = true;
      acctName[code] = name;
      var dc = (r.FDC || 'D').toString().trim().toUpperCase();
      var normal = dc === 'D' ? 'dr' : 'cr';
      subjects.push({
        code: code,
        name: name,
        cls: classify(code, dc),
        // grpCls： FGroup 归类（仅展示用，科目页分类 Tab 与科目类别列取它），
        // 与界面保持一致；grp 保留原始编码便于追溯。
        grpCls: tyGroupCls(r.FGroup) || null,
        grp: parseInt(r.FGroup, 10) || null,
        normal: normal,
        level: parseInt(r.FLevel || 1, 10) || 1
      });
    });

    // 2. 凭证：GLVch 每条分录按 期间/字/号 聚合，跳过已删除(FDeleted==1)
    var vchRows = getRows(reader, 'GLVch');
    var vchMap = {};
    var vchOrder = [];
    vchRows.forEach(function (r) {
      if (parseInt(r.FDeleted || 0, 10) === 1) return;
      var d = parseDate(r.FDate);
      var rawPeriod = parseInt(r.FPeriod || 0, 10) || 0;
      // 兼容两种期间格式： 标准 1~12；老版/专业版 6 位期间号 YYYYMM（如 202201）
      var period = rawPeriod > 999 ? rawPeriod % 100 : rawPeriod;
      // 聚合 key 含日期+年份+原始期间：跨年账套中「同期间号+同字号+同号」的凭证不能合并；
      // 加入日期后，源数据中同期间同字号重复出现的异常行也不会被误合并。
      var key = d + ' ' + rawPeriod + ' ' + (r.FGroup || '记') + ' ' + (parseInt(r.FNum || 0, 10));
      var v = vchMap[key];
      if (!v) {
        v = {
          word: r.FGroup || '记',
          no: parseInt(r.FNum || 0, 10),
          period: period,
          date: d,
          attach: parseInt(r.FAttachment || 0, 10),
          preparer: (r.FPreparer || '').toString(),
          checker: (r.FChecker || '').toString(),
          poster: (r.FPoster || '').toString(),
          posted: (r.FPosted === true || r.FPosted === 1 || r.FPosted === 'true'),
          checked: (r.FChecked === true || r.FChecked === 1 || r.FChecked === 'true'),
          entries: []
        };
        vchMap[key] = v;
        vchOrder.push(v);
      }
      var code = (r.FAcctID || '').toString().trim();
      v.entries.push({
        code: code,
        name: acctName[code] || code,
        summary: (r.FExp || '').toString().trim(),
        dr: Math.round((parseFloat(r.FDebit || 0) || 0) * 100) / 100,
        cr: Math.round((parseFloat(r.FCredit || 0) || 0) * 100) / 100
      });
    });
    // 排序口径与金蝶界面显示一致：先按【期间年月】分组（date 的 YYYY-MM），
    // 同期间内按 FDate（凭证日期）升序、同日期按原始 FNum 升序。
    // 重排原因：金蝶 KIS 修改/加录凭证后会重写 FNum 但界面显示用"期内位置序号"，
    // 直接读 FNum 会导致修改过的凭证号错位（如金蝶显示记-2，FNum 却变成了 37）。
    // 解决：排序后按期内从 1 重新编号，与金蝶界面显示完全一致。
    vchOrder.sort(function (a, b) {
      var aYm = (a.date || '').slice(0, 7);
      var bYm = (b.date || '').slice(0, 7);
      if (aYm !== bYm) return aYm < bYm ? -1 : 1;
      var dc = (a.date || '').localeCompare(b.date || '');
      if (dc !== 0) return dc;
      return (+a.no || 0) - (+b.no || 0);
    });
    // 按期内重新编号：word+期间 分组，每组从 1 开始递增
    var noCounters = {};
    vchOrder.forEach(function (v) {
      var ym = (v.date || '').slice(0, 7);
      var key = (v.word || '记') + '|' + ym;
      noCounters[key] = (noCounters[key] || 0) + 1;
      v.no = noCounters[key];
    });
    var vouchers = vchOrder;

    // 3. 期初余额：见下方（需先确定账套真实启用期，跨年账套才能正确取"开业期初"行）

    var base = (fileName || '账套').replace(/\.[^.]+$/, '');
    var startYear = new Date().getFullYear();
    var startPeriod = 0;

    // ① 优先：读金蝶 GLSetup 表拿 FStartYear + FStartPeriod — 账套真实启用期的唯一权威来源
    // 历史 bug：未读 GLSetup，靠凭证最早日期猜 startYear，跨年账套的 GLBal 里会混入上年结转空壳行，
    // minPeriodKey 被抢成上年1月，openingBalances 误取上年结转余额当"开业期初"，
    // 导致 store 的 openingOf(code, 当期) = 开业期初 + 之前凭证累计 → 多算了一整年
    try {
      var setupRows = getRows(reader, 'GLSetup');
      if (setupRows && setupRows.length) {
        var s = setupRows[0];  // GLSetup 通常只有一行
        var sy = parseInt(s.FStartYear || s.FYear || s.FStartYear ? s.FStartYear : 0, 10) || 0;
        var sp = parseInt(s.FStartPeriod || s.FPeriod || s.FStartMonth || 0, 10) || 0;
        if (!sy) {
          // 回退：GLSetup 里可能用 FStartDate 存启用日期（YYYY-MM-DD 或 Date 对象）
          var sd = s.FStartDate || s.FBeginDate || s.FBeginBalDate;
          if (sd) {
            if (sd instanceof Date) { sy = sd.getUTCFullYear(); sp = sd.getUTCMonth() + 1; }
            else {
              var sm = String(sd).match(/(\d{4})[-/年](\d{1,2})/);
              if (sm) { sy = parseInt(sm[1],10); sp = parseInt(sm[2],10); }
            }
          }
        }
        if (sy >= 1900 && sy <= 2200 && (sp >= 1 && sp <= 12)) {
          startYear = sy;
          startPeriod = sp;
        }
      }
    } catch (e) { /* 老账套可能没 GLSetup 表，忽略 */ }

    // ② 回退：从凭证最早日期推 startYear（仅当 GLSetup 无效时）
    if (!startPeriod) {
      if (vouchers.length) {
        for (var i = 0; i < vouchers.length; i++) {
          var y = parseInt((vouchers[i].date || '').slice(0, 4), 10);
          if (y && y >= 1900 && y <= 2200) { startYear = y; break; }
        }
      } else {
        var m = base.match(/(\d{4})\s*年/);
        if (m) startYear = parseInt(m[1], 10);
      }
    }
    var pad = function(n){ return (n<10?'0':'')+n; };

    // ③ 从 GLBal 取真实的 minPeriodKey：
    //   - 如果 startPeriod 已确定（来自 GLSetup），直接算 key，只匹配这个精确期间的行
    //   - 如果 GLSetup 无效，回退遍历取最小 FPeriod（兼容极端老账套）
    var balRows = getRows(reader, 'GLBal');
    function periodOf(r) { var p = parseInt(r.FPeriod || 0, 10) || 0; return p > 999 ? p % 100 : p; }
    function periodKeyOf(r) {
      var p = parseInt(r.FPeriod || 0, 10) || 0;
      return p > 999 ? p : startYear * 100 + p;
    }
    var minPeriodKey = 0;
    if (startPeriod) {
      // 精确模式：只取启用期 FPeriod 行的 FBal 作为开业期初
      minPeriodKey = startYear * 100 + startPeriod;
      // 但必须确认 GLBal 里真的有这个期间的行，否则还是遍历取最小
      var hasThisPeriod = balRows.some(function (r) { return periodKeyOf(r) === minPeriodKey; });
      if (!hasThisPeriod) minPeriodKey = 0;
    }
    if (!minPeriodKey) {
      // 回退：遍历 GLBal 取最小期间
      balRows.forEach(function (r) {
        var k = periodKeyOf(r);
        if (k && (!minPeriodKey || k < minPeriodKey)) minPeriodKey = k;
      });
    }
    var minPeriod = minPeriodKey ? minPeriodKey % 100 : 0;
    // 币种回退：优先综合币 '*' 行（标准版 GLBal 汇总行 FCyID='*'）；
    // 若账套完全没有综合币行（外币/多币种账套），回退到出现次数最多的币种行，
    // 避免期初余额整体丢失。FObjID 统一取 '*'（不含核算项目明细行）。
    var cyMap = {}, cyPick = null;
    balRows.forEach(function (r) {
      if (periodKeyOf(r) !== minPeriodKey) return;
      var cy = (r.FCyID || '').toString().trim();
      var obj = (r.FObjID || '').toString().trim();
      if (!cy || !obj) return;
      cyMap[cy] = (cyMap[cy] || 0) + 1;
      if (cy === '*' && obj === '*') cyPick = { cy: '*', obj: '*' };
    });
    if (!cyPick) {
      var best = '', bestN = 0;
      for (var ck in cyMap) { if (cyMap[ck] > bestN) { bestN = cyMap[ck]; best = ck; } }
      cyPick = { cy: best, obj: '*' };
    }
    var allCodes = {};
    balRows.forEach(function (r) {
      if (periodKeyOf(r) !== minPeriodKey) return;
      if ((r.FCyID || '').toString().trim() !== cyPick.cy || (r.FObjID || '').toString().trim() !== cyPick.obj) return;
      var code = (r.FAcctID || '').toString().trim();
      if (!code || code === '*') return;
      allCodes[code] = true;
    });
    var hasChild = {};
    var codes = Object.keys(allCodes);
    codes.forEach(function (c) {
      codes.forEach(function (d) {
        if (d !== c && d.indexOf(c) === 0) { hasChild[c] = true; }
      });
    });
    var opening = {};
    balRows.forEach(function (r) {
      if (periodKeyOf(r) !== minPeriodKey) return;
      if ((r.FCyID || '').toString().trim() !== cyPick.cy || (r.FObjID || '').toString().trim() !== cyPick.obj) return;
      var code = (r.FAcctID || '').toString().trim();
      if (!code || code === '*' || hasChild[code]) return;
      // 只保留第一条匹配：标准版账套 GLBal 期间为 1~12 且不含年份，
      // 同月跨年行只取最早出现的，避免被后续年份覆盖
      if (opening[code]) return;
      var beg = Math.round((parseFloat(r.FBegBal || 0) || 0) * 100) / 100;
      if (beg === 0) return;
      var normal = beg >= 0 ? 'dr' : 'cr';
      opening[code] = {
        dr: normal === 'dr' ? Math.abs(beg) : 0,
        cr: normal === 'cr' ? Math.abs(beg) : 0
      };
    });
    if (!minPeriod) minPeriod = 1;
    // startMonth：优先用 GLSetup 的真实启用期；回退到 minPeriod（遍历 GLBal 取最小）
    var effectiveStartPeriod = startPeriod || minPeriod;
    var startMonth = startYear + '-' + pad(effectiveStartPeriod);

    // 推导结账进度（closedPeriods）：标准规范下，凭证最大期间之前的各月均已结账，
    // 当前期间 = 最后凭证年份的最大期间（"当期未结账期"）。
    // 跨年账套必须按年份分别推导：2022 年凭证到 12 月 → 2022-01~11 结账；
    // 2023 年凭证到 3 月 → 2023-01~02 结账；currentPeriod = 2023-03。
    var yearMax = {};
    vouchers.forEach(function (v) {
      var y = (v.date || '').slice(0, 4);
      if (!y) return;
      if (!yearMax[y] || v.period > yearMax[y]) yearMax[y] = v.period;
    });
    var closedPeriods = [];
    Object.keys(yearMax).sort().forEach(function (y) {
      for (var cp = 1; cp < yearMax[y]; cp++) closedPeriods.push(y + '-' + pad(cp));
    });
    var lastYear = Object.keys(yearMax).sort().pop() || (startYear + '');
    var maxPeriod = yearMax[lastYear] || 0;
    var currentPeriod = maxPeriod >= 1 ? lastYear + '-' + pad(maxPeriod) : startMonth;

    // 借贷平衡校验：逐张凭证核对借=贷，源数据异常时统计并在导入结果中提示用户
    var unbalancedVouchers = 0;
    vchOrder.forEach(function (v) {
      var dr = 0, cr = 0;
      v.entries.forEach(function (e) { dr += e.dr; cr += e.cr; });
      if (Math.abs(dr - cr) > 0.01) unbalancedVouchers++;
    });

    // 上游空值保护：base 解析不出名字时 fallback 到文件名（去掉后缀），再兜底到「新账套」
    var companyName = (base || '').trim();
    if (!companyName) {
      var fn = (fileName || '').replace(/\.(ais|json)$/i, '').trim();
      companyName = fn || '新账套';
    }

    // ===== 常用凭证模板（用户自定义） =====
    // s*.?ais：GLVchTemplateEx=模板头（FID/FName/FVchGroup），GLVchTemplateExInfo=分录（FGroupID→FID,
    // FExp 摘要 / FAcctID 科目 / FDR 借贷方向）。金额不存 → 结构模板，与软件「模板只存结构」口径一致。
    // GLVchTemplate*（多准则系统预置模板）不导入，避免与本账套准则/科目冲突。
    var vchTemplates = [];
    try {
      var tplHeads = getRows(reader, 'GLVchTemplateEx');
      var tplLines = getRows(reader, 'GLVchTemplateExInfo');
      if (tplHeads.length || tplLines.length) {
        var subjName = {};
        subjects.forEach(function (s) { subjName[s.code] = s.name || ''; });
        var linesBy = {};
        tplLines.forEach(function (r) {
          var gid = r.FGroupID;
          if (gid == null) return;
          if (!linesBy[gid]) linesBy[gid] = [];
          linesBy[gid].push({
            summary: r.FExp || '',
            code: String(r.FAcctID || ''),
            name: subjName[String(r.FAcctID || '')] || '',
            side: String(r.FDR || '') === '贷' ? 'cr' : 'dr'
          });
        });
        tplHeads.forEach(function (r) {
          var name = String(r.FName || '').trim();
          if (!name || r.FID == null) return;
          var entries = (linesBy[r.FID] || []).filter(function (e) {
            return e.code && subjName[e.code] !== undefined;
          });
          if (!entries.length) return;
          vchTemplates.push({
            id: 'K' + r.FID,
            name: name,
            word: (r.FVchGroup || '记') || '记',
            entries: entries
          });
        });
      }
      // ===== 老模式常用凭证模板（金蝶 KIS：GLVchTemplate + GLVchTemplate1，仅结构、金额留空）=====
      // GLVchTemplate1 无 FDR 方向字段，方向由 FDebit/FCredit 体现；结构模板两者皆 0，
      // 金蝶本身未存方向，套用时按科目性质预置（与金蝶一致，少数反向业务如提现需微调）。
      // 仅解析主表 GLVchTemplate / GLVchTemplate1（不带 _2011/_NewKJ 等准则变体后缀，避免重复）。
      var tplH2 = getRows(reader, 'GLVchTemplate');
      var tplL2 = getRows(reader, 'GLVchTemplate1');
      if (tplH2.length || tplL2.length) {
        var by2 = {};
        tplL2.forEach(function (r) {
          var gid = r.FGroupID; if (gid == null) return;
          (by2[gid] = by2[gid] || []).push({
            summary: r.FExp || '',
            code: String(r.FAcctID || ''),
            name: subjName[String(r.FAcctID || '')] || '',
            side: (parseFloat(r.FDebit) > 0) ? 'dr' : ((parseFloat(r.FCredit) > 0) ? 'cr' : tplSideOfCode(r.FAcctID))
          });
        });
        tplH2.forEach(function (r) {
          var name = String(r.FName || '').trim();
          if (!name || r.FID == null) return;
          var entries = (by2[r.FID] || []).filter(function (e) { return e.code && subjName[e.code] !== undefined; });
          if (!entries.length) return;
          vchTemplates.push({ id: 'K' + r.FID, name: name, word: (r.FVchGroup || '记') || '记', entries: entries });
        });
      }
    } catch (e) {
      if (typeof console !== 'undefined') console.warn('[AIS] 常用凭证模板读取失败', e);
    }

    // ===== 期末处理模板（金蝶自动转账 GLServiceType + GLServiceTypeEntry）=====
    // 金蝶 KIS 不内置固定的"结转损益/折旧/增值税/附加税/所得税"模板——这些由 KIS 后端硬编码；
    // GLServiceType 里存的是用户自设的摊销、计提、利润分配等通用分录模板，跟我们 Settle 里的
    // 自定义模板（ruleType='balance'）模型完全对齐。
    // 导入策略：只导入 id 不在系统模板名单里的（系统模板硬编码更准），变成 custom=true 模板。
    var settleTemplates = [];
    try {
      var sysIds = ['dep', 'cost', 'vat', 'surTax', 'incTax', 'profit']; // 我们的 6 个系统模板
      var svcHdrs = getRows(reader, 'GLServiceType');
      var svcLines = getRows(reader, 'GLServiceTypeEntry');
      if (svcHdrs.length) {
        var subjNameMap = {};
        subjects.forEach(function (s) { subjNameMap[s.code] = s.name || ''; });
        // 分录按 FID 分组
        var linesByFid = {};
        svcLines.forEach(function (r) {
          var fid = r.FID; if (fid == null) return;
          (linesByFid[fid] = linesByFid[fid] || []).push(r);
        });
        // FDC 金蝶方向 1=借方(D) 0=贷方(C)，FProportion 金额比例（金蝶按此比例分配源科目余额）
        var fidToSysId = { 4: 'vat', 6: 'incTax', 3: 'surTax', 7: 'yearEnd' }; // 可映射到我们系统模板的跳过
        svcHdrs.forEach(function (h) {
          var fid = h.FID;
          // 跳过能映射到我们系统模板的（硬编码更准）
          if (fidToSysId[fid]) return;
          var periods = String(h.FPeriod || '').trim(); // e.g. "1,2,3,...,12" 或 "12"
          var name = (h.FName || '').toString().trim();
          if (h.FName2) name = name + '（' + h.FName2 + '）'; // 计提税金（城建税）/利润分配（法定盈余）
          var lines = linesByFid[fid] || [];
          if (!lines.length) return;
          var templateEntries = lines.map(function (l) {
            var code = String(l.FAcctID || '').trim();
            var dc = String(l.FDC || '0') === '1' ? 'D' : 'C';
            return {
              summary: (l.FExp || '').toString().trim() || name,
              code: code,
              name: subjNameMap[code] || '',
              dc: dc,
              amount: 0, // 金额留空，ruleType='balance' 模式下运行时按源科目余额计算
              amountRatio: Number(l.FProportion || 0) || 0
            };
          }).filter(function (e) {
            // 过滤掉科目号不存在于 subjects 的分录（金蝶老模板可能用旧准则编码，账套已转准则就不匹配）
            return e.code && subjNameMap[e.code] !== undefined;
          });
          // 过滤后必须借贷两边都有（否则凭证永远不平）
          var hasD = templateEntries.some(function(e){ return e.dc === 'D'; });
          var hasC = templateEntries.some(function(e){ return e.dc === 'C'; });
          if (!templateEntries.length || !hasD || !hasC) return;
          var tmpl = {
            id: 'ais_svc_' + fid,
            name: name,
            enabled: false,  // 默认禁用，用户启用后才有卡片
            custom: true,
            summary: name,
            word: '记',
            template: templateEntries,
            hasEntries: templateEntries.length > 0,
            ruleType: 'balance',        // 金蝶按 FProportion 从源科目取余额分配
            months: periods,             // 生效期："1,2,...,12" 或 "12"
            aisFID: fid                  // 源表行号，便于追溯
          };
          settleTemplates.push(tmpl);
        });
      }
    } catch (e) {
      if (typeof console !== 'undefined') console.warn('[AIS] 期末处理模板读取失败', e);
    }

    // 自动识别会计准则：看 subjects 里制造费用编码
    // 两套准则损益类都是 5xxx，唯一差异 = 制造费用：
    //   小企业准则 2013 → 4101
    //   企业会计制度   → 4105
    var detectedStandard = 'small2013'; // 默认小企业准则（金蝶 KIS 默认，绅蓝之星/添钰来客都是）
    var has4101 = subjects.some(function(s){ return s.code === '4101'; });
    var has4105 = subjects.some(function(s){ return s.code === '4105'; });
    if (has4105 && !has4101) detectedStandard = 'old';

    // 凭证字：扫描所有凭证实际使用过的字，全部预设并启用；默认"记"
    var _vwUsed = {};
    vouchers.forEach(function(v){ if (v.word) _vwUsed[v.word] = true; });
    var voucherWords = ['记','收','付','转'].filter(function(w){ return _vwUsed[w]; });
    // 如果 AIS 只用到"记"，但金蝶默认 4 个字都该预置，全部加上（用到的 enabled）
    if (!voucherWords.length) voucherWords = ['记']; // 兜底
    var defaultVw = voucherWords[0] || '记';
    // 4 个金蝶默认凭证字，全部预置，实际用到的启用
    var allWords = {};
    ['记','收','付','转'].forEach(function(w){ allWords[w] = true; });
    Object.keys(_vwUsed).forEach(function(w){ allWords[w] = true; });
    voucherWords = Object.keys(allWords).map(function(w){
      return { name: w, title: w + '账凭证', enabled: _vwUsed[w] ? true : false };
    });

    var ledger = {
      standard: detectedStandard,
      company: { name: companyName, startMonth: startMonth,  currency: 'RMB' },
      param: { fxRate: 1, voucherWord: defaultVw },
      voucherWords: voucherWords,
      subjects: subjects,
      openingBalances: opening,
      vouchers: vouchers,
      closedPeriods: closedPeriods,
      vchTemplates: vchTemplates,   // 用户自定义常用凭证模板（仅结构，金额留空）
      settleTemplates: settleTemplates,  // 期末处理模板（金蝶自动转账 GLServiceType 自设模板）
      fixedAssets: [],
      salary: [],
      meta: {
        source: fileName || '',
        importedAt: new Date().toISOString().slice(0,19),
        period: minPeriod
      }
    };

    var stats = {
      subjects: subjects.length,
      acctRows: acctRows.length,
      vouchers: vouchers.length,
      vchRows: vchRows.length,
      opening: Object.keys(opening).length,
      balRows: balRows.length,
      unbalancedVouchers: unbalancedVouchers,
      period: minPeriod,
      company: base,
      closedPeriods: closedPeriods,
      currentPeriod: currentPeriod,
      currencyFallback: (cyPick && cyPick.cy !== '*') ? cyPick.cy : '',
      dupSubjects: dupCodes.length ? dupCodes.slice().sort() : []
    };

    // === 只读探针（诊断用）：把 .ais 关键字段分布落盘，便于核对导入结果；失败不影响导入 ===
    try {
      var probe = {
        fileName: fileName || '',
        GLVch_FPosted_dist: (function(){
          var t = getRows(reader,'GLVch'); var d = {};
          t.forEach(function(r){ var k = String(r.FPosted); d[k] = (d[k]||0)+1; }); return d;
        })(),
        GLVch_FChecked_dist: (function(){
          var t = getRows(reader,'GLVch'); var d = {};
          t.forEach(function(r){ var k = String(r.FChecked); d[k] = (d[k]||0)+1; }); return d;
        })(),
        GLVch_FPeriod_dist: (function(){
          var t = getRows(reader,'GLVch'); var d = {};
          t.forEach(function(r){ var k = String(r.FPeriod); d[k] = (d[k]||0)+1; }); return d;
        })(),
        GLVch_FPreparer_sample: (function(){
          var t = getRows(reader,'GLVch'); var s = {};
          t.forEach(function(r){ var k = String(r.FPreparer||''); if(k && !s[k]){ s[k]=true; } });
          return Object.keys(s).slice(0,20);
          })(),
        GLBal_FCyID_dist: (function(){
          var t = getRows(reader,'GLBal'); var d = {};
          t.forEach(function(r){ var k = String((r.FCyID||'').toString().trim()||'(空)') + '|' + String((r.FObjID||'').toString().trim()||'(空)'); d[k] = (d[k]||0)+1; }); return d;
        })(),
        GLBal_FPeriod_dist: (function(){
          var t = getRows(reader,'GLBal'); var d = {};
          t.forEach(function(r){ var k = String(r.FPeriod); d[k] = (d[k]||0)+1; }); return d;
        })(),
        unbalancedVouchers: unbalancedVouchers,
        derived_closedPeriods: closedPeriods,
        derived_currentPeriod: currentPeriod,
        startMonth: startMonth
      };
      // 探测结果挂全局供手动查看（桌面版无服务端，仅本地诊断）
      global.__AIS_PROBE__ = probe;
      if (typeof console !== 'undefined') console.log('[AIS_PROBE]', JSON.stringify(probe).slice(0, 2000));
    } catch (e) {
      if (typeof console !== 'undefined') console.warn('[AIS_PROBE] failed', e);
    }

    return { ledger: ledger, stats: stats };
  }

  function parse(input) {
    return new Promise(function (resolve, reject) {
      try {
        var name = '';
        if (input && input.name) name = input.name;
        if (input && typeof input.arrayBuffer === 'function') {
          // 浏览器 File / Blob
          input.arrayBuffer().then(function (buf) { resolve(convert(buf, name)); }).catch(reject);
          return;
        }
        if (input instanceof ArrayBuffer ||
            (typeof Uint8Array !== 'undefined' && input instanceof Uint8Array) ||
            (global.Buffer && global.Buffer.isBuffer && global.Buffer.isBuffer(input)) ||
            (input && input.buffer instanceof ArrayBuffer)) {
          resolve(convert(input, name));
          return;
        }
        if (input && input.byteLength != null && input.slice) {
          // 跨 realm 的 ArrayBuffer / TypedArray 兜底
          resolve(convert(input, name));
          return;
        }
        reject(new Error('不支持的输入类型'));
      } catch (e) { reject(e); }
    });
  }

  global.KisImport = { parse: parse, convert: convert, classify: classify, parseMulti: parseMulti };

  /* ============================================================
   * 多年账套合并导入（按年导出 .ais，本接口合并同店多年为连续账套）
   *
   * 设计：
   *   - 按文件名年份排序，以最早年为"基础年"完整导入
   *   - 后续年只取凭证 + 科目（去重合并），丢弃期初余额（保留基础年的"开业期初"）
   *   - 凭证号按「字 + 期间」从 1 编号（默认，与字号口径一致：
   *     每期从 1 重新计，跨年/跨月允许同号，号码不会随账期无限滚大）
   *   - 跨年一致性校验：基础年+后续年凭证累积推导期末 vs 下一年.ais 实际期初
   *
   * 使用：
   *   KisImport.parseMulti(
   *     [file2024, file2025, file2026],
   *     { baseName: '绅蓝之星', voucherNoStrategy: 'monthly' }
   *   ) -> Promise<{ ledger, stats, warnings }>
   *
   * voucherNoStrategy:
   *   'monthly'（默认）按月（字+期间）从 1 编号：记字第1号每月重置，同
   *   'renumber' 跨年连续重排：记-1..N（全局连续，号会逐年滚大，一般不再使用）
   *   'prefix'   年份前缀：no 不变，但 voucher.id 改为 年-字-号
   *   'keep'      原样保留（跨年重复，不推荐）
   * ============================================================ */
  function parseMulti(files, options) {
    options = options || {};
    if (!Array.isArray(files) || files.length === 0)
      return Promise.reject(new Error('未传入文件'));
    if (files.length === 1) {
      // 单文件走原 parse 路径
      return parse(files[0]).then(function (r) {
        return { ledger: r.ledger, stats: r.stats, warnings: [] };
      });
    }

    // 1. 按文件名年份排序（升序）
    function yearOf(f) {
      var n = (f && f.name) || '';
      var m = n.match(/(\d{4})\s*年/);
      return m ? parseInt(m[1], 10) : 0;
    }
    var sorted = files.slice().sort(function (a, b) {
      return yearOf(a) - yearOf(b);
    });

    // 2. 逐个解析（用 convert 直接处理 Buffer）
    return Promise.all(sorted.map(function (f) {
      return parse(f).then(function (r) {
        return { file: f, ledger: r.ledger, stats: r.stats, year: yearOf(f) };
      });
    })).then(function (results) {
      // 3. 基础年（最早）的 ledger 作为合并基底
      var base = results[0];
      var merged = JSON.parse(JSON.stringify(base.ledger));  // 深拷贝避免污染
      var baseYear = base.year || parseInt((base.ledger.company.startMonth || '').slice(0, 4), 10);

      // 4. 合并后续年的凭证 + 科目 + 已结账期间
      var subjectsMap = {};
      merged.subjects.forEach(function (s) { subjectsMap[s.code] = s; });

      var allVouchers = merged.vouchers.slice();
      var yearBoundaries = [];   // 跨年校验结果
      // 工具：从期初 + 凭证推导「截至该年末」的余额（按科目）
      // 关键：必须是**累计到 year 为止的全部年份**凭证，而不是只要 year 当年。
      // 历史 bug：这里曾写成只取当年（vy !== year 就跳过），导致推导 2025 期末时漏掉
      // 2024 年全年发生额——绅蓝之星 1001 因此把真实的 788.00 算成 -829.00，
      // 与 2026 期初对不上，误报出 46 个科目差异。账套数据本身并不受影响。
      function deriveYearEnd(opening, vouchers, year) {
        var bal = {};
        var yEnd = Number(year) || 0;
        // 期初
        Object.keys(opening || {}).forEach(function (code) {
          var e = opening[code];
          bal[code] = (bal[code] || 0) + (e.dr || 0) - (e.cr || 0);
        });
        // 凭证借贷影响：累计 year 及之前各年
        vouchers.forEach(function (v) {
          var vy = parseInt((v.date || '').slice(0, 4), 10);
          if (!vy || vy > yEnd) return;
          (v.entries || []).forEach(function (e) {
            bal[e.code] = (bal[e.code] || 0) + (e.dr || 0) - (e.cr || 0);
          });
        });
        return bal;
      }

      // 4.0 先计算基础年期末，作为跨年校验的初始 prevYearEndBalances
      // 这样首次循环（results[1]）即可对比 基础年期末 vs 第二年期初
      var prevYearEndBalances = deriveYearEnd(merged.openingBalances, allVouchers, baseYear);

      results.slice(1).forEach(function (r) {
        var y = r.year;
        if (!y) y = parseInt((r.ledger.company.startMonth || '').slice(0, 4), 10);

        // 4a. 跨年校验：上一年期末 vs 本年期初
        if (prevYearEndBalances && r.ledger.openingBalances) {
          var actualOpening = r.ledger.openingBalances;
          var diffs = [];
          var compared = 0; // 参与核对（上年期末与本年期初均有）的科目数
          Object.keys(prevYearEndBalances).forEach(function (code) {
            if (actualOpening[code]) {
              compared++;
              var prev = prevYearEndBalances[code];
              var cur = (actualOpening[code].dr || 0) - (actualOpening[code].cr || 0);
              var d = Math.round((prev - cur) * 100) / 100;
              if (Math.abs(d) > 0.01) {
                diffs.push({ code: code, prevEnd: prev, curOpen: cur, diff: d });
              }
            }
          });
          yearBoundaries.push({
            fromYear: y - 1, toYear: y,
            checked: diffs.length,     // 有差异的科目数
            total: compared,           // 参与核对科目数（文案用，避免「0 个科目全部一致」歧义）
            maxDiff: diffs.length ? diffs.reduce(function (m, x) { return Math.abs(x.diff) > Math.abs(m) ? x.diff : m; }, 0) : 0,
            samples: diffs.slice(0, 10),  // 摘要：前 10 个供 toast 预览
            allDiffs: diffs  // 完整：所有差异科目供 modal 详情查看
          });
        }

        // 4b. 推导本年期末，供下一年校验
        prevYearEndBalances = deriveYearEnd(merged.openingBalances, allVouchers.concat(r.ledger.vouchers), y);

        // 4c. 合并凭证（暂保留原 no，最后统一重排）
        r.ledger.vouchers.forEach(function (v) { allVouchers.push(v); });

        // 4d. 合并科目（按 code 去重，后续年新科目加入）
        r.ledger.subjects.forEach(function (s) {
          if (!subjectsMap[s.code]) {
            subjectsMap[s.code] = s;
            merged.subjects.push(s);
          }
        });

        // 4e. 合并 closedPeriods
        (r.ledger.closedPeriods || []).forEach(function (p) {
          if (merged.closedPeriods.indexOf(p) < 0) merged.closedPeriods.push(p);
        });
      });
      merged.closedPeriods.sort();

      // 5. 凭证号重排策略
      var strategy = options.voucherNoStrategy || 'monthly';
      var warnings = [];

      // 全局按 date+原序排序
      allVouchers.sort(function (a, b) {
        var c = (a.date || '') < (b.date || '') ? -1 : ((a.date || '') > (b.date || '') ? 1 : 0);
        if (c) return c;
        return (a.period || 0) - (b.period || 0) || (a.no || 0) - (b.no || 0);
      });

      if (strategy === 'monthly') {
        // 按月（字+期间）从 1 编号：与字号口径一致，每期从 1 重新计，
        // 跨年/跨月允许同号，id 含日期保持唯一；号码不会随账期无限滚大。
        var monthCounter = {};
        allVouchers.forEach(function (v) {
          var w = v.word || '记';
          var ym = (v.date || '').slice(0, 7);
          if (!/^\d{4}-\d{2}$/.test(ym)) {
            var y = (v.date || '').slice(0, 4);
            var p = Math.max(1, parseInt(v.period, 10) || 1);
            ym = y + '-' + (p < 10 ? '0' : '') + p;
          }
          var key = w + '|' + ym;
          monthCounter[key] = (monthCounter[key] || 0) + 1;
          v.no = monthCounter[key];
          v.id = w + '-' + v.no + '-' + (v.date || '');  // id 含日期保证唯一
        });
      } else if (strategy === 'renumber') {
        // 跨年连续重排：按凭证字分组，每组从 1 开始连续编号
        var noCounter = {};
        allVouchers.forEach(function (v) {
          var w = v.word || '记';
          noCounter[w] = (noCounter[w] || 0) + 1;
          v.no = noCounter[w];
          v.id = w + '-' + v.no + '-' + (v.date || '');  // id 含日期保证唯一
        });
      } else if (strategy === 'prefix') {
        // 年份前缀：no 不变，id 加年份
        allVouchers.forEach(function (v) {
          var y = (v.date || '').slice(0, 4);
          v.id = y + '-' + (v.word || '记') + '-' + v.no;
        });
      }
      // 'keep' 不处理

      merged.vouchers = allVouchers;

      // 6. 推导合并后的 closedPeriods（重排 closedPeriods 也基于凭证最大期间）
      var yearMax = {};
      allVouchers.forEach(function (v) {
        var y = (v.date || '').slice(0, 4);
        if (!y) return;
        if (!yearMax[y] || v.period > yearMax[y]) yearMax[y] = v.period;
      });
      var pad = function (n) { return (n < 10 ? '0' : '') + n; };
      var closedPeriods = [];
      Object.keys(yearMax).sort().forEach(function (y) {
        for (var cp = 1; cp < yearMax[y]; cp++) closedPeriods.push(y + '-' + pad(cp));
      });
      merged.closedPeriods = closedPeriods;

      // 7. 元数据合并
      merged.meta = merged.meta || {};
      merged.meta.source = (options.baseName || base.ledger.company.name) + '（多年合并）';
      merged.meta.years = results.map(function (r) { return r.year; }).filter(Boolean);
      merged.meta.importedAt = new Date().toISOString().slice(0, 19);
      merged.meta.mergedFrom = results.map(function (r) { return r.file.name; });
      // 跨年校验报告完整存档（供 UI 事后查看，不丢失明细）
      merged.meta.yearBoundaries = yearBoundaries;

      // 8. 公司名：用 baseName 或去掉年份的文件名
      var compName = options.baseName;
      if (!compName) {
        // 从基础文件名提取店名（去掉 _YYYY年_ 格式.ais）
        compName = (base.file.name || '').replace(/[_\s]*\d{4}\s*年.*$/, '').trim() || base.ledger.company.name;
      }
      merged.company.name = compName;
      // startMonth 用基础年的（开业期初月份）
      // currentPeriod 用最新年的最大凭证期间
      var lastYear = Object.keys(yearMax).sort().pop();
      merged.company.currentPeriod = lastYear ? lastYear + '-' + pad(yearMax[lastYear]) : merged.company.startMonth;

      // 9. 校验告警
      yearBoundaries.forEach(function (b) {
        if (b.checked > 0) {
          warnings.push('跨年差异 [' + b.fromYear + '→' + b.toYear + ']：' + b.checked + ' 个科目期初与上年期末不一致，最大差异 ' + Math.abs(b.maxDiff).toFixed(2) + '（金蝶年结未达账/折旧未生成/手动调整等常见原因）');
        }
      });

      var stats = {
        years: results.map(function (r) { return r.year; }).filter(Boolean),
        subjects: merged.subjects.length,
        vouchers: merged.vouchers.length,
        opening: Object.keys(merged.openingBalances).length,
        closedPeriods: merged.closedPeriods,
        yearBoundaries: yearBoundaries,
        perYear: results.map(function (r) {
          return { year: r.year, vouchers: r.ledger.vouchers.length, subjects: r.ledger.subjects.length };
        })
      };

      return { ledger: merged, stats: stats, warnings: warnings };
    });
  }

})(typeof window !== 'undefined' ? window : this);
