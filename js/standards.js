/* ============================================================
 * js/standards.js — 会计准则模板集（科目表 + 报表取数规则）
 *
 * 设计：
 *   - 统一使用小企业会计准则（2013）
 *   - 每个准则自带「科目模板 + 报表规则模板」
 *   - 建账时深拷贝写入账套 state（subjects / reportRules）
 *     拷入 state 后即为「该账套的规则快照」，可逐账套独立编辑，互不影响
 *
 * 挂载：globalThis.STANDARDS
 * 依赖：无（纯数据 + 浅函数）
 * ============================================================ */
(function (global) {
  'use strict';

  /* ---------- 小企业会计准则（2013）科目表 ----------
   * 参考财政部 2011 年 11 月发布的《小企业会计准则》科目表；
   * 资产/负债/权益编码 1xxx/2xxx/3xxx；成本类：4001 生产成本、4101 制造费用；
   * 损益类 5xxx（5001 主营业务收入 / 5401 主营业务成本 / 5601 销售费用 / 5602 管理费用 / 5603 财务费用）。
   */
  var SUBJECTS_SMALL2013 = [
    // ===== 资产类 =====
    { code: '1001', name: '库存现金',       cls: 'asset',     normal: 'dr' },
    { code: '1002', name: '银行存款',       cls: 'asset',     normal: 'dr' },
    { code: '1012', name: '其他货币资金',   cls: 'asset',     normal: 'dr' },
    { code: '1101', name: '短期投资',       cls: 'asset',     normal: 'dr' },
    { code: '1121', name: '应收票据',       cls: 'asset',     normal: 'dr' },
    { code: '1122', name: '应收账款',       cls: 'asset',     normal: 'dr' },
    { code: '1123', name: '预付账款',       cls: 'asset',     normal: 'dr' },
    { code: '1131', name: '应收股利',       cls: 'asset',     normal: 'dr' },
    { code: '1132', name: '应收利息',       cls: 'asset',     normal: 'dr' },
    { code: '1221', name: '其他应收款',     cls: 'asset',     normal: 'dr' },
    { code: '1401', name: '材料采购',       cls: 'asset',     normal: 'dr' },
    { code: '1402', name: '在途物资',       cls: 'asset',     normal: 'dr' },
    { code: '1403', name: '原材料',         cls: 'asset',     normal: 'dr', qty: true, unit: '千克' },
    { code: '1404', name: '材料成本差异',   cls: 'asset',     normal: 'dr' },
    { code: '1405', name: '库存商品',       cls: 'asset',     normal: 'dr', qty: true, unit: '件' },
    { code: '1407', name: '商品进销差价',   cls: 'asset',     normal: 'dr' },
    { code: '1408', name: '委托加工物资',   cls: 'asset',     normal: 'dr' },
    { code: '1411', name: '周转材料',       cls: 'asset',     normal: 'dr' },
    { code: '1421', name: '消耗性生物资产', cls: 'asset',     normal: 'dr' },
    { code: '1501', name: '长期债券投资',   cls: 'asset',     normal: 'dr' },
    { code: '1511', name: '长期股权投资',   cls: 'asset',     normal: 'dr' },
    { code: '1601', name: '固定资产',       cls: 'asset',     normal: 'dr' },
    { code: '1602', name: '累计折旧',       cls: 'asset',     normal: 'cr' },
    { code: '1604', name: '在建工程',       cls: 'asset',     normal: 'dr' },
    { code: '1605', name: '工程物资',       cls: 'asset',     normal: 'dr' },
    { code: '1606', name: '固定资产清理',   cls: 'asset',     normal: 'dr' },
    { code: '1621', name: '生产性生物资产', cls: 'asset',     normal: 'dr' },
    { code: '1622', name: '生产性生物资产累计折旧', cls: 'asset', normal: 'cr' },
    { code: '1701', name: '无形资产',       cls: 'asset',     normal: 'dr' },
    { code: '1702', name: '累计摊销',       cls: 'asset',     normal: 'cr' },
    { code: '1801', name: '长期待摊费用',   cls: 'asset',     normal: 'dr' },
    { code: '1901', name: '待处理财产损溢', cls: 'asset',     normal: 'dr' },
    // ===== 负债类 =====
    { code: '2001', name: '短期借款',       cls: 'liability', normal: 'cr' },
    { code: '2201', name: '应付票据',       cls: 'liability', normal: 'cr' },
    { code: '2202', name: '应付账款',       cls: 'liability', normal: 'cr' },
    { code: '2203', name: '预收账款',       cls: 'liability', normal: 'cr' },
    { code: '2211', name: '应付职工薪酬',   cls: 'liability', normal: 'cr' },
    { code: '2221', name: '应交税费',       cls: 'liability', normal: 'cr' },
    { code: '222102', name: '未交增值税',   cls: 'liability', normal: 'cr' },
    { code: '222129', name: '应交附加税',   cls: 'liability', normal: 'cr' },
    { code: '222105', name: '应交所得税',   cls: 'liability', normal: 'cr' },
    { code: '2231', name: '应付利息',       cls: 'liability', normal: 'cr' },
    { code: '2232', name: '应付利润',       cls: 'liability', normal: 'cr' },
    { code: '2241', name: '其他应付款',     cls: 'liability', normal: 'cr' },
    { code: '2401', name: '递延收益',       cls: 'liability', normal: 'cr' },
    { code: '2501', name: '长期借款',       cls: 'liability', normal: 'cr' },
    { code: '2701', name: '长期应付款',     cls: 'liability', normal: 'cr' },
    // ===== 所有者权益类 =====
    { code: '3001', name: '实收资本',       cls: 'equity', normal: 'cr' },
    { code: '3002', name: '资本公积',       cls: 'equity', normal: 'cr' },
    { code: '3101', name: '盈余公积',       cls: 'equity', normal: 'cr' },
    { code: '3103', name: '本年利润',       cls: 'equity', normal: 'cr' },
    { code: '3104', name: '利润分配',       cls: 'equity', normal: 'cr' },
    // ===== 成本类 =====
    { code: '4001', name: '生产成本',       cls: 'cost',    normal: 'dr' },
    { code: '4101', name: '制造费用',       cls: 'cost',    normal: 'dr' },
    { code: '4301', name: '研发支出',       cls: 'cost',    normal: 'dr' },
    { code: '4401', name: '工程施工',       cls: 'cost',    normal: 'dr' },
    { code: '4403', name: '机械作业',       cls: 'cost',    normal: 'dr' },
    // ===== 损益类 =====
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
   *   { id, label, codes }                      普通行：sum(codes)
   *   { type:'subtotal', id, label, formula }   小计行：formula 求值
   * formula 元素：{ codes?, ref?, sign:'+'|'-' }  codes=按编码取数，ref=引用前述 subtotal id
   *
   * id = 语义行标识（全表唯一，对应报表 itemCode）。用途：
   *   首页财务指标按 id 从利润表行取数（store.plSummary），与利润表页共用同一份行计算，
   *   杜绝「首页一套口径、利润表另一套」的漂移。
   *   首页实际消费：revenue / cost / sellExp+adminExp+finExp / netProfit。
   *   其余（taxSur、营业外收支、所得税等）一并标注，便于后续扩展。
   * 注意：codes 为空的占位行不参与老账套 id 回填（多行同签名无法唯一匹配），
   *   其 id 目前仅作占位。
   */
  function incomeStatementSmall2013() {
    return [
      { id: 'revenue', label: '一、营业收入', codes: ['5001', '5051'] },
      { id: 'cost', label: '减：营业成本', codes: ['5401', '5402'] },
      { id: 'taxSur', label: '税金及附加', codes: ['5403'] },
      { id: 'sellExp', label: '销售费用', codes: ['5601'] },
      { id: 'adminExp', label: '管理费用', codes: ['5602'] },
      { id: 'rdExp', label: '研发费用', codes: [] },
      { id: 'finExp', label: '财务费用', codes: ['5603'] },
      { id: 'otherIncome', label: '加：其他收益', codes: [] },
      { id: 'investIncome', label: '投资收益（损失以“-”填列）', codes: ['5111'] },
      { id: 'hedgeIncome', label: '净敞口套期收益（损失以“-”填列）', codes: [] },
      { id: 'fvIncome', label: '公允价值变动收益（损失以“-”填列）', codes: [] },
      { id: 'creditLoss', label: '信用减值损失（损失以“-”填列）', codes: [] },
      { id: 'assetLoss', label: '资产减值损失（损失以“-”填列）', codes: [] },
      { id: 'disposalIncome', label: '资产处置收益（损失以“-”填列）', codes: [] },
      // 期间费用合计 = 销售费用 + 管理费用 + 财务费用（可选含研发费用）
      { type: 'subtotal', id: 'periodExpenseTotal', label: '期间费用合计',
        formula: [
          { codes: ['5601'], sign: '+' },
          { codes: ['5602'], sign: '+' },
          { codes: ['5603'], sign: '+' }
        ] },
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
      { id: 'nonOpRev', label: '加：营业外收入', codes: ['5301'] },
      { id: 'nonOpExp', label: '减：营业外支出', codes: ['5711'] },
      { type: 'subtotal', id: 'totalProfit', label: '三、利润总额（亏损以“-”填列）',
        formula: [
          { ref: 'opProfit', sign: '+' },
          { codes: ['5301'], sign: '+' },
          { codes: ['5711'], sign: '-' }
        ] },
      { id: 'incomeTax', label: '减：所得税费用', codes: ['5801'] },
      { type: 'subtotal', id: 'netProfit', label: '四、净利润（亏损以“-”填列）',
        formula: [
          { ref: 'totalProfit', sign: '+' },
          { codes: ['5801'], sign: '-' }
        ] }
    ];
  }

  /* ---------- 准则定义集 ---------- */
  var STANDARDS = {
    small2013: {
      key: 'small2013',
      label: '小企业会计准则（2013）',
      subjects: SUBJECTS_SMALL2013,
      fxCode: '5603',                 // 财务费用（汇兑损益）
      carryProfitCode: '3103',
      carryResidualCode: '3104',
      roles: {
        DEPR_FEE: '5602',             // 折旧费用（管理费用）
        PAYROLL_FEE: '5602',          // 工资费用（管理费用）
        ACC_DEPR: '1602',             // 累计折旧
        FA_ASSET: '1601',             // 固定资产
        FA_CLEAN: '1606',             // 固定资产清理
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

  /* ---------- 系统凭证模板（软件内置「常规/业务」常用凭证） ----------
   * 形态与「常用凭证」一致：只存 摘要 + 科目 + 借贷方向，套用后填金额。
   * 编码以 5xxx 损益码为基准。
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
