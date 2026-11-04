#!/usr/bin/env node
'use strict';
/* ============================================================
 * tools/verify_asset_io.js —— 固定资产卡片 Excel 导出/导入的**金额单位**验证
 *
 * 【为什么要有这个脚本】2026-09-30 金额定点化后，卡片在内存里是
 *   「0.0001 元整数」，而导出的 xlsx 必须是「元」。换算只有单点：
 *   js/ty-io.js 的 fmt()（÷ util.AMT_SCALE）。这条路径此前**零自动化覆盖** ——
 *   若哪天 fmt 写漏、或把某个金额列改走别的分支，用户导出/导入的金额会整体
 *   差 10000 倍，且没有任何测试会拦住。本脚本补上这道保护（方案文档风险 #2 的要求）。
 *
 * 【测什么】用内部整数造一张卡片 → 导出 → 读回单元格：① 金额列必须已换回「元」，
 *   且**绝不等原整数**（反 10000 倍卡口）；②「残值率%」是比率，不得被 ÷AMT_SCALE；
 *   ③ 导出结果再导入，金额应回到「元」口径的同一数值（round-trip）。
 *
 * 【不依赖真实账套】纯合成数据，CI 上也会真正执行（不跳过）。
 * 用法：node tools/verify_asset_io.js
 * ============================================================ */
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
function ck(cond, label, detail) {
  if (cond) { pass++; return; }
  fail++; console.log('  ✗ ' + label + (detail !== undefined ? '  → ' + detail : ''));
}

/* ---------- 最小运行环境（与其他 store 测试同款） ---------- */
const mem = {};
global.localStorage = { getItem: k => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; } };
global.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} };
global.window = global; global.__TAURI__ = {}; global.isTauri = false;
require(path.join(ROOT, 'js', 'storage.js'));
require(path.join(ROOT, 'js', 'store.js'));
const U = global.util;                       // amt / yuan / AMT_SCALE 的唯一来源

/* SheetJS：与运行时**同一个文件**（js/xlsx.full.min.js），避免测试与生产用两套解析器 */
global.XLSX = require(path.join(ROOT, 'js', 'xlsx.full.min.js'));
require(path.join(ROOT, 'js', 'ty-io.js'));
const TyIo = global.TyIo;

ck(typeof TyIo === 'object' && typeof TyIo.buildAssetWorkbook === 'function',
  '0 前置：TyIo.buildAssetWorkbook 已装载');
ck(U && U.AMT_SCALE === 10000 && typeof U.amt === 'function' && typeof U.yuan === 'function',
  '0 前置：util 定点底座可用（AMT_SCALE=10000，amt/yuan 存在）', U && U.AMT_SCALE);

/* ---------- 造一张内部整数口径的卡片 ----------
 * 金额刻意选「除不尽 4 位」的值（如 12345.6789 → 整数 123456789），
 * 这样「导出时 ÷10000」与「原样输出整数」两种实现会给出可区分的字符串。 */
const YUAN = {
  original: 12345.6789, accumDeprBegin: 1000, accumDepr: 1500.5, assetMonthlyDepr: 200.25,
  salvage: 617.28, impairment: 0, netValueBegin: 11345.6789, netValueEnd: 10845.1789
};
const fa = {
  code: 'FA001', name: '测试设备', category: '机器设备', dept: '生产部', acqDate: '2026-01-15',
  original: U.amt(YUAN.original),
  accumDeprBegin: U.amt(YUAN.accumDeprBegin),
  accumDepr: U.amt(YUAN.accumDepr),
  assetMonthlyDepr: U.amt(YUAN.assetMonthlyDepr),
  life: 5, periodUsed: 12,
  salvage: U.amt(YUAN.salvage),
  salvageRate: 5,                            // 比率（%），不是金额 —— 不得被 ÷AMT_SCALE
  impairment: U.amt(YUAN.impairment),
  netValueBegin: U.amt(YUAN.netValueBegin),
  netValueEnd: U.amt(YUAN.netValueEnd),
  method: '平均年限法', status: '正常'
};

/* ---------- 导出 → 读回单元格 ---------- */
const wb = TyIo.buildAssetWorkbook([fa]);
const sheetName = (wb.SheetNames || [])[0];
const aoa = global.XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '', raw: false });
const H = aoa[0] || [], R = aoa[1] || [];
const cell = k => { const i = H.indexOf(k); return i < 0 ? undefined : String(R[i]); };
const expect2 = v => Number(v).toFixed(2);   // 元 → 2 位字符串（与 ty-io 的 fmt 同形态）

const MONEY = [
  ['原值', 'original'], ['期初累计折旧', 'accumDeprBegin'], ['期末累计折旧', 'accumDepr'],
  ['月折旧', 'assetMonthlyDepr'], ['残值', 'salvage'], ['减值准备', 'impairment'],
  ['期初净值', 'netValueBegin'], ['期末净值', 'netValueEnd']
];

MONEY.forEach(([col, f]) => {
  if (YUAN[f] === 0) {
    ck(cell(col) === '', 'A 金额列「' + col + '」为 0 时导出为空串（既有行为，不因定点化改变）', cell(col));
    return;
  }
  const want = expect2(YUAN[f]);                       // 期望值：÷10000 后的「元」
  ck(cell(col) === want, 'A 金额列「' + col + '」导出为「元」（' + want + '）', cell(col));
  // 反 10000 倍卡口：绝不允许把内部整数原样写出
  ck(cell(col) !== String(fa[f]),
    'A 金额列「' + col + '」不得原样输出内部整数（若为 ' + fa[f] + ' 即未 ÷AMT_SCALE，用户看到 10000 倍）', cell(col));
});

/* 残值率是比率：必须原样 5.00，绝不能被 ÷10000 变成 0.00 */
ck(cell('残值率%') === '5.00',
  'B 「残值率%」是比率，应导出 5.00（不得走金额换算）', cell('残值率%'));

/* ---------- round-trip：导出的工作簿再导入，金额回到「元」 ---------- */
const back = TyIo.parseAssetWorkbook(wb);
ck(back.length === 1 && back[0].code === 'FA001' && back[0].name === '测试设备',
  'C 导出结果可被导入回同一张卡片', JSON.stringify(back.map(x => x.code)));
if (back.length === 1) {
  const b = back[0];
  ck(b.original === 12345.68, 'C 导入「原值」回到元口径 12345.68', b.original);
  ck(b.accumDepr === 1500.5, 'C 导入「期末累计折旧」回到元口径 1500.5', b.accumDepr);
  ck(b.netValueEnd === 10845.18, 'C 导入「期末净值」回到元口径 10845.18', b.netValueEnd);
  ck(b.life === 5, 'C 导入「预计使用期限」回到 5 年（"5年" → 5）', b.life);
  ck(Number(b.salvageRate) === 5, 'C 导入「残值率」仍是 5（比率不加倍/不缩小）', b.salvageRate);
  // 反向一致性：导入值(元) 必须等于 内部整数 ÷ AMT_SCALE 的 2 位近似（而非整数本身）
  ck(b.original !== fa.original,
    'C 导入「原值」不得等于内部整数（再证一次方向没搞反）', b.original + ' vs ' + fa.original);
}

/* ---------- D 「月折旧」列：卡片无快照时必须现算 ----------
 * 2026-11-04 修复前该列读 `fa.assetMonthlyDepr`（把函数名当字段名）→ 生产账套导出的
 * 这一列永远空白，用户拿导出表核对时看不到月折旧。这里守住「无字段也能导出真值」。 */
{
  const S = global.S;
  S.state = {};
  S.normalizeState();
  S.state.subjects = [
    { code: '1602', name: '累计折旧', cls: 'asset', normal: 'cr', level: 0, enabled: true },
    { code: '6602', name: '管理费用', cls: 'expense', normal: 'dr', level: 0, enabled: true }
  ];
  S.state.company = Object.assign({}, S.state.company, { startMonth: '2024-01', bookkeeper: '测试' });
  S.state.closedPeriods = []; S.state.vouchers = []; S.state.fixedAssets = [];
  S.addFixedAsset({
    code: 'FA002', name: '现算月折旧', acqDate: '2024-08-31', status: '正常',
    original: 123100, salvage: 0, life: 5, periodUsed: 23,
    accumDepr: 47188.41, accumDeprBegin: 47188.41, deprMonth: '2026-07',
    depFeeAcct: '6602', accDeprAcct: '1602'
  });
  const fa2 = S.state.fixedAssets[0];
  ck(fa2 && fa2.assetMonthlyDepr === undefined,
    'D 前提：生产卡片没有 assetMonthlyDepr 字段（旧写法读它 → 列恒为空）');
  const wb2 = TyIo.buildAssetWorkbook([fa2]);
  const aoa2 = global.XLSX.utils.sheet_to_json(wb2.Sheets[wb2.SheetNames[0]], { header: 1, defval: '', raw: false });
  const H2 = aoa2[0] || [], R2 = aoa2[1] || [];
  const c2 = k => { const i = H2.indexOf(k); return i < 0 ? undefined : String(R2[i]); };
  ck(c2('月折旧') === '2051.67',
    'D 无快照时「月折旧」由 store 现算为 2051.67（金蝶同口径，修复前为空串）', c2('月折旧'));
}

/* ---------- 汇总 ---------- */
console.log('\n固定资产卡片 导出/导入 金额单位验证：通过 ' + pass + ' / 失败 ' + fail);
if (fail) {
  console.log('  ✗ 存在未通过项：导出/导入的金额单位可能已偏离「元」口径');
  process.exit(1);
}
console.log('  ✓ 全部通过：导出为元、导入回元，且不存在 10000 倍放大');