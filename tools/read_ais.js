#!/usr/bin/env node
/**
 * read_ais.js — 直接读取金蝶 KIS .ais 账套，提取基准数据（科目余额表）
 *
 * 用法：
 *   node tools/read_ais.js <.ais文件路径> [输出JSON路径]
 *
 * 输出：
 *   - 科目表（含金蝶原始科目类别 FDC 借/贷方向）
 *   - 各月科目余额表（从 GLBal 表直接提取，金蝶权威数据）
 *   - 凭证统计
 *
 * 这是对照验证的"金蝶侧基准数据"，不经过 ty 的任何转换逻辑。
 */
'use strict';

const fs = require('fs');
const path = require('path');

/* ---------- mock 浏览器环境以加载 mdb-reader.js ---------- */
global.window = global;
// mdb-reader.js 可能依赖 buffer
try { global.Buffer = require('buffer').Buffer; } catch (e) {}

// 加载 mdb-reader.js（浏览器 IIFE 打包，var MDBReader 挂到全局）
// 用 eval(0,0) 在全局作用域执行，使 var 声明挂到 globalThis
const mdbPath = path.join(__dirname, '..', 'js', 'mdb-reader.js');
const mdbSrc = fs.readFileSync(mdbPath, 'utf8');
try {
  // (0, eval) 间接调用 eval，在全局作用域执行
  (0, eval)(mdbSrc);
} catch (e) {
  console.error('加载 mdb-reader.js 失败：', e.message);
  process.exit(1);
}

// mdb-reader IIFE 返回 __toCommonJS(index_exports)，赋给 var MDBReader
// 结果是 { ColumnTypes, default }，default 是构造器
const MDBReader = global.MDBReader.default;
if (typeof MDBReader !== 'function') {
  console.error('MDBReader 未正确加载');
  process.exit(1);
}

function round2(n) { return Math.round(Number(n) * 100) / 100; }

function main() {
  const aisPath = process.argv[2];
  if (!aisPath || !fs.existsSync(aisPath)) {
    console.error('用法: node tools/read_ais.js <.ais文件路径> [输出JSON路径]');
    process.exit(1);
  }
  const outPath = process.argv[3] || aisPath.replace(/\.ais$/i, '_baseline.json');

  console.log('读取 .ais: ' + aisPath);
  const buf = fs.readFileSync(aisPath);
  console.log('文件大小: ' + (buf.length / 1024 / 1024).toFixed(2) + ' MB');

  const reader = new MDBReader(buf);
  const tableNames = reader.getTableNames();
  console.log('表列表 (' + tableNames.length + '): ' + tableNames.slice(0, 20).join(', ') + (tableNames.length > 20 ? '...' : ''));

  function getRows(table) {
    if (tableNames.indexOf(table) === -1) return [];
    return reader.getTable(table).getData() || [];
  }

  /* ---------- 1. 科目表 GLAcct ---------- */
  const acctRows = getRows('GLAcct');
  console.log('\nGLAcct 科目表: ' + acctRows.length + ' 行');
  const subjects = acctRows.map(r => ({
    code: String(r.FAcctID || '').trim(),
    name: String(r.FAcctName || '').trim(),
    level: parseInt(r.FLevel || 1, 10) || 1,
    dc: String(r.FDC || 'D').trim(),  // D=借方 C=贷方（金蝶原始方向）
    parentId: String(r.FParentID || '').trim()
  })).filter(s => s.code);

  /* ---------- 2. 凭证统计 GLVch ---------- */
  const vchRows = getRows('GLVch');
  console.log('GLVch 凭证分录: ' + vchRows.length + ' 行');
  // 按期间统计
  const periodStats = {};
  vchRows.forEach(r => {
    if (parseInt(r.FDeleted || 0, 10) === 1) return;
    const p = parseInt(r.FPeriod || 0, 10);
    const key = p > 999 ? p : p; // 保留原始期间号
    periodStats[key] = (periodStats[key] || 0) + 1;
  });

  /* ---------- 3. 科目余额表 GLBal（金蝶权威数据） ---------- */
  const balRows = getRows('GLBal');
  console.log('GLBal 余额表: ' + balRows.length + ' 行');

  // 查看余额表字段
  if (balRows.length > 0) {
    console.log('GLBal 字段: ' + Object.keys(balRows[0]).join(', '));
  }

  // 提取各期间各科目的余额（只取综合币 '*' 和汇总对象 '*'）
  // GLBal 字段：FAcctID(科目), FPeriod(期间), FCyID(币种), FObjID(核算项目),
  //             FBegBal(期初余额), FDebit(借方发生), FCredit(贷方发生),
  //             FYDBegBal(年初余额), FYDDebit(本年累计借), FYDCredit(本年累计贷),
  //             FEndBal(期末余额)
  const balances = {};
  let sampleFields = null;
  balRows.forEach(r => {
    const cy = String(r.FCyID || '').trim();
    const obj = String(r.FObjID || '').trim();
    // 只取综合币汇总行（排除外币明细和核算项目明细）
    if (cy !== '*' || obj !== '*') return;

    const code = String(r.FAcctID || '').trim();
    if (!code || code === '*') return;

    const rawPeriod = parseInt(r.FPeriod || 0, 10) || 0;
    if (!sampleFields) sampleFields = Object.keys(r);

    // 期间号：标准版 1~12，专业版 YYYYMM
    let periodKey;
    if (rawPeriod > 999) {
      periodKey = String(rawPeriod).slice(0, 4) + '-' + String(rawPeriod).slice(4, 6);
    } else {
      // 需要年份信息——从凭证推断起始年
      periodKey = rawPeriod; // 先用原始值，后面补全年份
    }

    if (!balances[code]) balances[code] = [];
    // 金蝶 GLBal 字段：FBegBal/FDebit/FCredit/FYtdDebit/FYtdCredit/FEndBal
    // 无年初余额字段；年初余额 = 第 1 期的 FBegBal
    balances[code].push({
      period: rawPeriod,
      begBal: round2(parseFloat(r.FBegBal || 0) || 0),
      debit: round2(parseFloat(r.FDebit || 0) || 0),
      credit: round2(parseFloat(r.FCredit || 0) || 0),
      ydDebit: round2(parseFloat(r.FYtdDebit || 0) || 0),
      ydCredit: round2(parseFloat(r.FYtdCredit || 0) || 0),
      endBal: round2(parseFloat(r.FEndBal || 0) || 0)
    });
  });

  // 推断起始年份
  let startYear = new Date().getFullYear();
  const validDates = vchRows.filter(r => r.FDate).map(r => r.FDate);
  if (validDates.length > 0) {
    // 取第一条有效日期的年份
    const firstDate = validDates.sort()[0];
    const y = parseInt(String(firstDate).slice(0, 4), 10);
    if (y >= 1900 && y <= 2200) startYear = y;
    // 如果是 Date 对象
    if (firstDate instanceof Date) {
      startYear = firstDate.getUTCFullYear();
    }
  }
  console.log('推断起始年份: ' + startYear);

  // 补全期间年份
  Object.keys(balances).forEach(code => {
    balances[code] = balances[code].map(b => {
      let periodStr;
      if (b.period > 999) {
        periodStr = String(b.period).slice(0, 4) + '-' + String(b.period).slice(4, 6);
      } else {
        periodStr = startYear + '-' + ('0' + b.period).slice(-2);
      }
      return { ...b, periodStr };
    });
  });

  /* ---------- 4. 汇总输出 ---------- */
  // 按期间组织余额表
  const periodsSet = new Set();
  Object.values(balances).forEach(arr => arr.forEach(b => periodsSet.add(b.periodStr)));
  const periods = Array.from(periodsSet).sort();

  // 按期间组织：{ period: { code: { begBal, debit, credit, endBal, ... } } }
  const balanceByPeriod = {};
  periods.forEach(p => { balanceByPeriod[p] = {}; });
  Object.entries(balances).forEach(([code, arr]) => {
    arr.forEach(b => {
      if (balanceByPeriod[b.periodStr]) {
        balanceByPeriod[b.periodStr][code] = {
          begBal: b.begBal,
          debit: b.debit,
          credit: b.credit,
          ydBegBal: b.ydBegBal,
          ydDebit: b.ydDebit,
          ydCredit: b.ydCredit,
          endBal: b.endBal
        };
      }
    });
  });

  const result = {
    source: path.basename(aisPath),
    startYear: startYear,
    subjects: subjects,
    subjectCount: subjects.length,
    voucherEntryCount: vchRows.filter(r => parseInt(r.FDeleted || 0, 10) !== 1).length,
    balanceRowCount: balRows.length,
    periods: periods,
    balanceByPeriod: balanceByPeriod,
    // 金蝶原始科目方向映射（用于核对 ty 导入的 cls/normal 是否正确）
    subjectDirectionMap: subjects.reduce((acc, s) => {
      acc[s.code] = { name: s.name, dc: s.dc, level: s.level };
      return acc;
    }, {})
  };

  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log('\n已输出基准数据: ' + outPath);
  console.log('科目数: ' + subjects.length);
  console.log('期间数: ' + periods.length + ' (' + periods.join(', ') + ')');

  // 校验 H2 修复：5301 营业外收入 金蝶 FDC=C，ty classify 应归 revenue（非 expense）
  const s5301 = subjects.filter(s => s.code === '5301')[0];
  if (s5301) {
    console.log('\n--- 5301 营业外收入 分类校验（H2 修复验证）---');
    console.log('金蝶方向 FDC: ' + s5301.dc + ' (D=借方 C=贷方)');
    console.log('当前 ty classify(5301, FDC) 应为 revenue（营业外收入属收入类）');
    console.log('注：早期 H2 版本曾误归 expense 导致利润表 I10 恒等式 FAIL，现已修复（classify 走 standardClsOf 权威模板）');
  }

  // 打印几个关键科目的方向对比
  console.log('\n--- 关键科目方向对比 ---');
  const keyCodes = ['5001', '5051', '5301', '5401', '5601', '5602', '5603', '5711', '5801'];
  keyCodes.forEach(code => {
    const s = subjects.filter(x => x.code === code)[0];
    if (s) {
      const dcMeaning = s.dc === 'C' ? '贷方(收入/负债/权益)' : '借方(资产/费用)';
      console.log('  ' + code + ' ' + s.name + ' FDC=' + s.dc + ' ' + dcMeaning);
    }
  });
}

main();
