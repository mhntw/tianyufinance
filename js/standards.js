/* ============================================================
 * js/standards.js — 会计准则模板集（科目表 + 报表取数规则）
 *
 * 设计：
 *   - 每个准则自带「科目模板 + 报表规则模板」
 *   - 建账时按 key 选取，深拷贝写入账套 state（subjects / reportRules）
 *     拷入 state 后即为「该账套的规则快照」，可逐账套独立编辑，互不影响
 *   - 'old' 准则的 subjects + reportRules 与改造前硬编码逐字等价
 *     （DEFAULT_SUBJECTS + store.js:2306-2374 + Report.js:250-299），
 *     现有账套迁移后报表数值 0 变化
 *
 * 挂载：globalThis.STANDARDS
 * 依赖：无（纯数据 + 浅函数）
 * ============================================================ */
(function (global) {
  'use strict';

  /* ---------- 旧准则（企业会计制度）科目表 ----------
   * 与改造前 store.js DEFAULT_SUBJECTS 逐字一致；
   * 收入/费用用 5xxx 编码（5001 主营业务收入 / 5401 主营业务成本）。
   */
  var SUBJECTS_OLD = [
    { code: '1001', name: '库存现金',       cls: 'asset',     normal: 'dr' },
    { code: '1002', name: '银行存款',       cls: 'asset',     normal: 'dr' },
    { code: '1012', name: '其他货币资金',   cls: 'asset',     normal: 'dr' },
    { code: '1121', name: '应收票据',       cls: 'asset',     normal: 'dr' },
    { code: '1122', name: '应收账款',       cls: 'asset',     normal: 'dr' },
    { code: '1123', name: '预付账款',       cls: 'asset',     normal: 'dr' },
    { code: '1221', name: '其他应收款',     cls: 'asset',     normal: 'dr' },
    { code: '1231', name: '坏账准备',       cls: 'asset',     normal: 'cr' },
    { code: '1401', name: '材料采购',       cls: 'asset',     normal: 'dr' },
    { code: '1403', name: '原材料',         cls: 'asset',     normal: 'dr', qty: true, unit: '千克' },
    { code: '1405', name: '库存商品',       cls: 'asset',     normal: 'dr', qty: true, unit: '件' },
    { code: '1511', name: '长期股权投资',   cls: 'asset',     normal: 'dr' },
    { code: '1601', name: '固定资产',       cls: 'asset',     normal: 'dr' },
    { code: '1602', name: '累计折旧',       cls: 'asset',     normal: 'cr' },
    { code: '1603', name: '固定资产减值准备', cls: 'asset',   normal: 'cr' },
    { code: '1604', name: '在建工程',       cls: 'asset',     normal: 'dr' },
    { code: '1605', name: '工程物资',       cls: 'asset',     normal: 'dr' },
    { code: '1606', name: '固定资产清理',   cls: 'asset',     normal: 'dr' },
    { code: '1701', name: '无形资产',       cls: 'asset',     normal: 'dr' },
    { code: '1702', name: '累计摊销',       cls: 'asset',     normal: 'cr' },
    { code: '1801', name: '长期待摊费用',   cls: 'asset',     normal: 'dr' },
    { code: '1901', name: '待处理财产损溢', cls: 'asset',     normal: 'dr' },
    { code: '2001', name: '短期借款',       cls: 'liability', normal: 'cr' },
    { code: '2201', name: '应付票据',       cls: 'liability', normal: 'cr' },
    { code: '2202', name: '应付账款',       cls: 'liability', normal: 'cr' },
    { code: '2203', name: '预收账款',       cls: 'liability', normal: 'cr' },
    { code: '2211', name: '应付职工薪酬',   cls: 'liability', normal: 'cr' },
    { code: '2221', name: '应交税费',       cls: 'liability', normal: 'cr' },
    { code: '2231', name: '应付利息',       cls: 'liability', normal: 'cr' },
    { code: '2232', name: '应付利润',       cls: 'liability', normal: 'cr' },
    { code: '2241', name: '其他应付款',     cls: 'liability', normal: 'cr' },
    { code: '2401', name: '递延收益',       cls: 'liability', normal: 'cr' },
    { code: '3001', name: '实收资本(或股本)', cls: 'equity', normal: 'cr' },
    { code: '3002', name: '资本公积',       cls: 'equity', normal: 'cr' },
    { code: '3101', name: '盈余公积',       cls: 'equity', normal: 'cr' },
    { code: '3103', name: '本年利润',       cls: 'equity', normal: 'cr' },
    { code: '3104', name: '利润分配',       cls: 'equity', normal: 'cr' },
    { code: '4001', name: '生产成本',       cls: 'expense', normal: 'dr' },
    { code: '4002', name: '制造费用',       cls: 'expense', normal: 'dr' },
    { code: '5001', name: '主营业务收入',   cls: 'revenue', normal: 'cr' },
    { code: '5051', name: '其他业务收入',   cls: 'revenue', normal: 'cr' },
    { code: '5111', name: '投资收益',       cls: 'revenue', normal: 'cr' },
    { code: '5301', name: '营业外收入',     cls: 'revenue', normal: 'cr' },
    { code: '5401', name: '主营业务成本',   cls: 'expense', normal: 'dr' },
    { code: '5402', name: '其他业务成本',   cls: 'expense', normal: 'dr' },
    { code: '5403', name: '税金及附加',     cls: 'expense', normal: 'dr' },
    { code: '5601', name: '销售费用',       cls: 'expense', normal: 'dr' },
    { code: '5602', name: '管理费用',       cls: 'expense', normal: 'dr' },
    { code: '5603', name: '财务费用',       cls: 'expense', normal: 'dr' },
    { code: '5711', name: '营业外支出',     cls: 'expense', normal: 'dr' },
    { code: '5801', name: '所得税费用',     cls: 'expense', normal: 'dr' }
  ];

  /* ---------- 小企业会计准则（2013）科目表 ----------
   * 资产/负债/权益编码与旧准则一致（1xxx/2xxx/3xxx）；
   * 收入/费用改用 6xxx 编码（6001 主营业务收入 / 6401 主营业务成本）。
   */
  var SUBJECTS_SMALL2013 = [
    { code: '1001', name: '库存现金',       cls: 'asset',     normal: 'dr' },
    { code: '1002', name: '银行存款',       cls: 'asset',     normal: 'dr' },
    { code: '1012', name: '其他货币资金',   cls: 'asset',     normal: 'dr' },
    { code: '1121', name: '应收票据',       cls: 'asset',     normal: 'dr' },
    { code: '1122', name: '应收账款',       cls: 'asset',     normal: 'dr' },
    { code: '1123', name: '预付账款',       cls: 'asset',     normal: 'dr' },
    { code: '1221', name: '其他应收款',     cls: 'asset',     normal: 'dr' },
    { code: '1231', name: '坏账准备',       cls: 'asset',     normal: 'cr' },
    { code: '1401', name: '材料采购',       cls: 'asset',     normal: 'dr' },
    { code: '1403', name: '原材料',         cls: 'asset',     normal: 'dr', qty: true, unit: '千克' },
    { code: '1405', name: '库存商品',       cls: 'asset',     normal: 'dr', qty: true, unit: '件' },
    { code: '1511', name: '长期股权投资',   cls: 'asset',     normal: 'dr' },
    { code: '1601', name: '固定资产',       cls: 'asset',     normal: 'dr' },
    { code: '1602', name: '累计折旧',       cls: 'asset',     normal: 'cr' },
    { code: '1603', name: '固定资产减值准备', cls: 'asset',   normal: 'cr' },
    { code: '1604', name: '在建工程',       cls: 'asset',     normal: 'dr' },
    { code: '1605', name: '工程物资',       cls: 'asset',     normal: 'dr' },
    { code: '1606', name: '固定资产清理',   cls: 'asset',     normal: 'dr' },
    { code: '1701', name: '无形资产',       cls: 'asset',     normal: 'dr' },
    { code: '1702', name: '累计摊销',       cls: 'asset',     normal: 'cr' },
    { code: '1801', name: '长期待摊费用',   cls: 'asset',     normal: 'dr' },
    { code: '1901', name: '待处理财产损溢', cls: 'asset',     normal: 'dr' },
    { code: '2001', name: '短期借款',       cls: 'liability', normal: 'cr' },
    { code: '2201', name: '应付票据',       cls: 'liability', normal: 'cr' },
    { code: '2202', name: '应付账款',       cls: 'liability', normal: 'cr' },
    { code: '2203', name: '预收账款',       cls: 'liability', normal: 'cr' },
    { code: '2211', name: '应付职工薪酬',   cls: 'liability', normal: 'cr' },
    { code: '2221', name: '应交税费',       cls: 'liability', normal: 'cr' },
    { code: '2231', name: '应付利息',       cls: 'liability', normal: 'cr' },
    { code: '2232', name: '应付利润',       cls: 'liability', normal: 'cr' },
    { code: '2241', name: '其他应付款',     cls: 'liability', normal: 'cr' },
    { code: '2401', name: '递延收益',       cls: 'liability', normal: 'cr' },
    { code: '3001', name: '实收资本(或股本)', cls: 'equity', normal: 'cr' },
    { code: '3002', name: '资本公积',       cls: 'equity', normal: 'cr' },
    { code: '3101', name: '盈余公积',       cls: 'equity', normal: 'cr' },
    { code: '3103', name: '本年利润',       cls: 'equity', normal: 'cr' },
    { code: '3104', name: '利润分配',       cls: 'equity', normal: 'cr' },
    { code: '4001', name: '生产成本',       cls: 'expense', normal: 'dr' },
    { code: '4101', name: '制造费用',       cls: 'expense', normal: 'dr' },
    { code: '6001', name: '主营业务收入',   cls: 'revenue', normal: 'cr' },
    { code: '6051', name: '其他业务收入',   cls: 'revenue', normal: 'cr' },
    { code: '6111', name: '投资收益',       cls: 'revenue', normal: 'cr' },
    { code: '6301', name: '营业外收入',     cls: 'revenue', normal: 'cr' },
    { code: '6401', name: '主营业务成本',   cls: 'expense', normal: 'dr' },
    { code: '6402', name: '其他业务成本',   cls: 'expense', normal: 'dr' },
    { code: '6403', name: '税金及附加',     cls: 'expense', normal: 'dr' },
    { code: '6601', name: '销售费用',       cls: 'expense', normal: 'dr' },
    { code: '6602', name: '管理费用',       cls: 'expense', normal: 'dr' },
    { code: '6603', name: '财务费用',       cls: 'expense', normal: 'dr' },
    { code: '6711', name: '营业外支出',     cls: 'expense', normal: 'dr' },
    { code: '6801', name: '所得税费用',     cls: 'expense', normal: 'dr' }
  ];

  /* ---------- 资产负债表规则 ----------
   * 两准则的资产负债表项目编码一致（资产/负债/权益编码未变），
   * 故共用同一份 balanceSheet 规则。每个项目 {label, codes, minus}。
   * 与改造前 store.js:2306-2374 内联 groups 逐字等价。
   */
  var BALANCE_SHEET_RULES = {
    assetCurrent: {
      title: '流动资产：', subtotal: '流动资产合计',
      items: [
        { label: '货币资金', codes: ['1001', '1002', '1012'] },
        { label: '短期投资', codes: ['1101'] },
        { label: '应收票据', codes: ['1121'] },
        { label: '应收账款', codes: ['1122'] },
        { label: '预付款项', codes: ['1123'] },
        { label: '应收利息', codes: ['1132'] },
        { label: '应收股利', codes: ['1131'] },
        { label: '其他应收款', codes: ['1221'] },
        { label: '存货', codes: ['1401', '1402', '1403', '1404', '1405', '1407', '1408', '1411'] },
        { label: '其他流动资产', codes: [] }
      ]
    },
    assetNonCurrent: {
      title: '非流动资产：', subtotal: '非流动资产合计',
      items: [
        { label: '长期债券投资', codes: ['1501'] },
        { label: '长期股权投资', codes: ['1511'] },
        { label: '固定资产净值', codes: ['1601'], minus: ['1602'] },
        { label: '在建工程', codes: ['1604'] },
        { label: '工程物资', codes: ['1605'] },
        { label: '固定资产清理', codes: ['1606'] },
        { label: '生产性生物资产净值', codes: ['1621'], minus: ['1622'] },
        { label: '无形资产净值', codes: ['1701'], minus: ['1702'] },
        { label: '长期待摊费用', codes: ['1801'] },
        { label: '其他非流动资产', codes: ['1901'] }
      ]
    },
    liaCurrent: {
      title: '流动负债：', subtotal: '流动负债合计',
      items: [
        { label: '短期借款', codes: ['2001'] },
        { label: '应付票据', codes: ['2201'] },
        { label: '应付账款', codes: ['2202'] },
        { label: '预收账款', codes: ['2203'] },
        { label: '应付职工薪酬', codes: ['2211'] },
        { label: '应交税费', codes: ['2221'] },
        { label: '应付利息', codes: ['2231'] },
        { label: '应付利润', codes: ['2232'] },
        { label: '其他应付款', codes: ['2241'] },
        { label: '其他流动负债', codes: [] }
      ]
    },
    liaNonCurrent: {
      title: '非流动负债：', subtotal: '非流动负债合计',
      items: [
        { label: '长期借款', codes: ['2501'] },
        { label: '递延收益', codes: ['2401'] },
        { label: '长期应付款', codes: ['2701'] },
        { label: '其他非流动负债', codes: [] }
      ]
    },
    equity: {
      title: '所有者权益：', subtotal: '所有者权益合计',
      items: [
        { label: '实收资本', codes: ['3001'] },
        { label: '资本公积', codes: ['3002'] },
        { label: '盈余公积', codes: ['3101'] },
        // 标准：未分配利润 = 本年利润 + 利润分配（合并列示）
        { label: '未分配利润', codes: ['3103', '3104'] }
      ]
    }
  };

  /* ---------- 利润表规则 ----------
   * 行定义数组，渲染器按行序输出。每行：
   *   { label, codes }                          普通行：sum(codes)
   *   { type:'subtotal', id, label, formula }   小计行：formula 求值
   * formula 元素：{ codes?, ref?, sign:'+'|'-' }  codes=按编码取数，ref=引用前述 subtotal id
   *
   * 'old' 与改造前 Report.js:250-299 逐字等价；'small2013' 把 5xxx 换 6xxx。
   */
  function incomeStatementOld() {
    return [
      { label: '一、营业收入', codes: ['5001', '5051'] },
      { label: '减：营业成本', codes: ['5401', '5402'] },
      { label: '税金及附加', codes: ['5403'] },
      { label: '销售费用', codes: ['5601'] },
      { label: '管理费用', codes: ['5602'] },
      { label: '研发费用', codes: [] },
      { label: '财务费用', codes: ['5603'] },
      { label: '加：其他收益', codes: [] },
      { label: '投资收益（损失以“-”填列）', codes: ['5111'] },
      { label: '净敞口套期收益（损失以“-”填列）', codes: [] },
      { label: '公允价值变动收益（损失以“-”填列）', codes: [] },
      { label: '信用减值损失（损失以“-”填列）', codes: [] },
      { label: '资产减值损失（损失以“-”填列）', codes: [] },
      { label: '资产处置收益（损失以“-”填列）', codes: [] },
      { type: 'subtotal', id: 'opProfit', label: '二、营业利润（亏损以“-”填列）',
        formula: [
          { codes: ['5001', '5051'], sign: '+' },
          { codes: ['5401', '5402'], sign: '-' },
          { codes: ['5403'], sign: '-' },
          { codes: ['5601'], sign: '-' },
          { codes: ['5602'], sign: '-' },
          { codes: ['5603'], sign: '-' },
          { codes: ['5111'], sign: '+' }
        ] },
      { label: '加：营业外收入', codes: ['5301'] },
      { label: '减：营业外支出', codes: ['5711'] },
      { type: 'subtotal', id: 'totalProfit', label: '三、利润总额（亏损以“-”填列）',
        formula: [
          { ref: 'opProfit', sign: '+' },
          { codes: ['5301'], sign: '+' },
          { codes: ['5711'], sign: '-' }
        ] },
      { label: '减：所得税费用', codes: ['5801'] },
      { type: 'subtotal', id: 'netProfit', label: '四、净利润（亏损以“-”填列）',
        formula: [
          { ref: 'totalProfit', sign: '+' },
          { codes: ['5801'], sign: '-' }
        ] }
    ];
  }

  function incomeStatementSmall2013() {
    return [
      { label: '一、营业收入', codes: ['6001', '6051'] },
      { label: '减：营业成本', codes: ['6401', '6402'] },
      { label: '税金及附加', codes: ['6403'] },
      { label: '销售费用', codes: ['6601'] },
      { label: '管理费用', codes: ['6602'] },
      { label: '研发费用', codes: [] },
      { label: '财务费用', codes: ['6603'] },
      { label: '加：其他收益', codes: [] },
      { label: '投资收益（损失以“-”填列）', codes: ['6111'] },
      { label: '净敞口套期收益（损失以“-”填列）', codes: [] },
      { label: '公允价值变动收益（损失以“-”填列）', codes: [] },
      { label: '信用减值损失（损失以“-”填列）', codes: [] },
      { label: '资产减值损失（损失以“-”填列）', codes: [] },
      { label: '资产处置收益（损失以“-”填列）', codes: [] },
      { type: 'subtotal', id: 'opProfit', label: '二、营业利润（亏损以“-”填列）',
        formula: [
          { codes: ['6001', '6051'], sign: '+' },
          { codes: ['6401', '6402'], sign: '-' },
          { codes: ['6403'], sign: '-' },
          { codes: ['6601'], sign: '-' },
          { codes: ['6602'], sign: '-' },
          { codes: ['6603'], sign: '-' },
          { codes: ['6111'], sign: '+' }
        ] },
      { label: '加：营业外收入', codes: ['6301'] },
      { label: '减：营业外支出', codes: ['6711'] },
      { type: 'subtotal', id: 'totalProfit', label: '三、利润总额（亏损以“-”填列）',
        formula: [
          { ref: 'opProfit', sign: '+' },
          { codes: ['6301'], sign: '+' },
          { codes: ['6711'], sign: '-' }
        ] },
      { label: '减：所得税费用', codes: ['6801'] },
      { type: 'subtotal', id: 'netProfit', label: '四、净利润（亏损以“-”填列）',
        formula: [
          { ref: 'totalProfit', sign: '+' },
          { codes: ['6801'], sign: '-' }
        ] }
    ];
  }

  /* ---------- 准则定义集 ---------- */
  var STANDARDS = {
    old: {
      key: 'old',
      label: '企业会计制度（旧准则）',
      subjects: SUBJECTS_OLD,
      fxCode: '6603',                 // 期末调汇汇兑损益科目（保持改造前常量）
      carryProfitCode: '3103',        // 本年利润（结转损益目标）
      carryResidualCode: '3104',      // 利润分配
      // 业务科目角色 → 编码：自动凭证生成与默认值一律经 S.subjectRole(role) 解析，
      // 不在业务代码中散落硬编码（费用类编码随准则 5xxx/6xxx 不同）。
      roles: {
        DEPR_FEE: '5602',             // 折旧费用（管理费用）
        PAYROLL_FEE: '5602',          // 工资费用（管理费用）
        ACC_DEPR: '1602',             // 累计折旧
        FA_ASSET: '1601',             // 固定资产
        FA_CLEAN: '1606',             // 固定资产清理
        FA_IMPAIR: '1603',            // 固定资产减值准备
        PAYROLL_PAYABLE: '2211',      // 应付职工薪酬
        BANK: '1002',                 // 银行存款（工资发放）
        PROFIT_YEAR: '3103',          // 本年利润
        PROFIT_RESIDUAL: '3104',      // 利润分配
        COST_PROD: '4001',            // 生产成本（结转成本借方）
        COST_INV: '1405'              // 库存商品（结转成本贷方）
      },
      reportRules: {
        balanceSheet: BALANCE_SHEET_RULES,
        incomeStatement: incomeStatementOld()
      }
    },
    small2013: {
      key: 'small2013',
      label: '小企业会计准则（2013）',
      subjects: SUBJECTS_SMALL2013,
      fxCode: '6603',                 // 2013 准则财务费用即 6603，恰为调汇科目
      carryProfitCode: '3103',
      carryResidualCode: '3104',
      // 业务科目角色（见 old）：费用类编码不同（管理费用 6602），其余与 old 一致
      roles: {
        DEPR_FEE: '6602',             // 折旧费用（管理费用）
        PAYROLL_FEE: '6602',          // 工资费用（管理费用）
        ACC_DEPR: '1602',             // 累计折旧
        FA_ASSET: '1601',             // 固定资产
        FA_CLEAN: '1606',             // 固定资产清理
        FA_IMPAIR: '1603',            // 固定资产减值准备
        PAYROLL_PAYABLE: '2211',      // 应付职工薪酬
        BANK: '1002',                 // 银行存款（工资发放）
        PROFIT_YEAR: '3103',          // 本年利润
        PROFIT_RESIDUAL: '3104',      // 利润分配
        COST_PROD: '4001',            // 生产成本（结转成本借方）
        COST_INV: '1405'              // 库存商品（结转成本贷方）
      },
      reportRules: {
        balanceSheet: BALANCE_SHEET_RULES,
        incomeStatement: incomeStatementSmall2013()
      }
    }
  };

  // 损益类编码双向映射（仅 5xxx ↔ 6xxx，资产/负债/权益不变）；
  // 用于已有账套切换准则时的科目编码迁移（subjects + openingBalances + vouchers.entries）。
  var CODE_MAP_OLD_TO_2013 = {
    '4002': '4101',
    '5001': '6001', '5051': '6051', '5111': '6111', '5301': '6301',
    '5401': '6401', '5402': '6402', '5403': '6403',
    '5601': '6601', '5602': '6602', '5603': '6603',
    '5711': '6711', '5801': '6801'
  };
  var CODE_MAP_2013_TO_OLD = (function () {
    var m = {};
    Object.keys(CODE_MAP_OLD_TO_2013).forEach(function (k) { m[CODE_MAP_OLD_TO_2013[k]] = k; });
    return m;
  })();

  global.STANDARDS = STANDARDS;
  // 取某准则的深拷贝快照（subjects/reportRules 都深拷，避免账套间共享引用）
  global.cloneStandard = function (key) {
    var s = STANDARDS[key];
    if (!s) return null;
    function deep(v) {
      if (Array.isArray(v)) return v.map(deep);
      if (v && typeof v === 'object') {
        var o = {}; Object.keys(v).forEach(function (k) { o[k] = deep(v[k]); }); return o;
      }
      return v;
    }
    return {
      key: s.key,
      label: s.label,
      fxCode: s.fxCode,
      carryProfitCode: s.carryProfitCode,
      carryResidualCode: s.carryResidualCode,
      roles: deep(s.roles),
      subjects: deep(s.subjects),
      reportRules: deep(s.reportRules)
    };
  };
  // 损益编码迁移：old↔small2013，按映射表逐码替换（不改资产/负债/权益编码）
  global.migrateSubjectCode = function (code, fromKey, toKey) {
    if (fromKey === 'old' && toKey === 'small2013') return CODE_MAP_OLD_TO_2013[code] || code;
    if (fromKey === 'small2013' && toKey === 'old') return CODE_MAP_2013_TO_OLD[code] || code;
    return code;
  };

  /* ---------- 系统凭证模板（软件内置「常规/业务」常用凭证） ----------
   * 形态与金蝶「常用凭证」一致：只存 摘要 + 科目 + 借贷方向，套用后填金额。
   * 编码以 old（5xxx 损益码）为基准；账套为 small2013（6xxx）或明细化科目时，
   * Voucher.js 套用侧按账套科目做 code 迁移 / 同名适配，不写死两套数据。
   * 属性：{ name, word, entries:[{summary, code, name, side:'dr'|'cr'}] }
   */
  var STANDARD_VCH_TEMPLATES = [
    { name: '提现', word: '记', entries: [
      { summary: '提现', code: '1001', name: '库存现金', side: 'dr' },
      { summary: '',     code: '1002', name: '银行存款', side: 'cr' } ] },
    { name: '付银行手续费', word: '记', entries: [
      { summary: '银行手续费', code: '5603', name: '财务费用', side: 'dr' },
      { summary: '',           code: '1002', name: '银行存款', side: 'cr' } ] },
    { name: '报销差旅费', word: '记', entries: [
      { summary: '差旅费', code: '5602', name: '管理费用', side: 'dr' },
      { summary: '',        code: '1001', name: '库存现金', side: 'cr' } ] },
    { name: '收到货款', word: '记', entries: [
      { summary: '收到货款', code: '1002', name: '银行存款', side: 'dr' },
      { summary: '',         code: '1122', name: '应收账款', side: 'cr' } ] },
    { name: '支付货款', word: '记', entries: [
      { summary: '支付货款', code: '2202', name: '应付账款', side: 'dr' },
      { summary: '',         code: '1002', name: '银行存款', side: 'cr' } ] },
    { name: '赊购（挂账）', word: '记', entries: [
      { summary: '赊购入库', code: '1405', name: '库存商品', side: 'dr' },
      { summary: '',         code: '2202', name: '应付账款', side: 'cr' } ] },
    { name: '赊销（挂账）', word: '记', entries: [
      { summary: '赊销确认收入', code: '1122', name: '应收账款', side: 'dr' },
      { summary: '',             code: '5001', name: '主营业务收入', side: 'cr' } ] },
    { name: '计提所得税', word: '记', entries: [
      { summary: '计提所得税', code: '5801', name: '所得税费用', side: 'dr' },
      { summary: '',           code: '2221', name: '应交税费', side: 'cr' } ] },
    { name: '计提营业税金及附加', word: '记', entries: [
      { summary: '计提税金及附加', code: '5403', name: '税金及附加', side: 'dr' },
      { summary: '',               code: '2221', name: '应交税费', side: 'cr' } ] },
    { name: '计提盈余公积', word: '记', entries: [
      { summary: '提取盈余公积', code: '3104', name: '利润分配', side: 'dr' },
      { summary: '',             code: '3101', name: '盈余公积', side: 'cr' } ] },
    { name: '收到投资款', word: '记', entries: [
      { summary: '收到投资款', code: '1002', name: '银行存款', side: 'dr' },
      { summary: '',           code: '3001', name: '实收资本', side: 'cr' } ] },
    { name: '借入短期借款', word: '记', entries: [
      { summary: '借入短期借款', code: '1002', name: '银行存款', side: 'dr' },
      { summary: '',             code: '2001', name: '短期借款', side: 'cr' } ] },
    { name: '偿还短期借款', word: '记', entries: [
      { summary: '偿还短期借款', code: '2001', name: '短期借款', side: 'dr' },
      { summary: '',             code: '1002', name: '银行存款', side: 'cr' } ] },
    { name: '向个人借款', word: '记', entries: [
      { summary: '向个人借款', code: '1002', name: '银行存款', side: 'dr' },
      { summary: '',           code: '2241', name: '其他应付款', side: 'cr' } ] },
    { name: '归还其他应付款', word: '记', entries: [
      { summary: '归还其他应付款', code: '2241', name: '其他应付款', side: 'dr' },
      { summary: '',               code: '1002', name: '银行存款', side: 'cr' } ] },
    { name: '预借差旅费', word: '记', entries: [
      { summary: '预借差旅费', code: '1221', name: '其他应收款', side: 'dr' },
      { summary: '',           code: '1001', name: '库存现金', side: 'cr' } ] },
    { name: '报销办公费', word: '记', entries: [
      { summary: '办公费', code: '5602', name: '管理费用', side: 'dr' },
      { summary: '',        code: '1001', name: '库存现金', side: 'cr' } ] },
    { name: '支付水电费', word: '记', entries: [
      { summary: '水电费', code: '5602', name: '管理费用', side: 'dr' },
      { summary: '',        code: '1002', name: '银行存款', side: 'cr' } ] },
    { name: '收到银行利息', word: '记', entries: [
      { summary: '收到银行利息', code: '1002', name: '银行存款', side: 'dr' },
      { summary: '',             code: '5603', name: '财务费用', side: 'cr' } ] },
    { name: '购买固定资产', word: '记', entries: [
      { summary: '购买固定资产', code: '1601', name: '固定资产', side: 'dr' },
      { summary: '',             code: '1002', name: '银行存款', side: 'cr' } ] },
    { name: '发放工资', word: '记', entries: [
      { summary: '发放工资', code: '2211', name: '应付职工薪酬', side: 'dr' },
      { summary: '',          code: '1002', name: '银行存款', side: 'cr' } ] }
  ];
  global.STANDARD_VCH_TEMPLATES = STANDARD_VCH_TEMPLATES;
})(typeof window !== 'undefined' ? window : globalThis);
