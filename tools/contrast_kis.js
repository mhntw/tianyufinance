#!/usr/bin/env node
/**
 * contrast_kis.js — 金蝶 KIS 基准 vs ty 报表导出 逐科目逐月对照
 *
 * 用法：
 *   node tools/contrast_kis.js <金蝶baseline.json> <ty导出目录> [bookId] [--leaf-only]
 *
 * 示例：
 *   node tools/contrast_kis.js tools/_out/添钰_baseline.json tools/_out 添钰来客_2026年_金蝶KIS格式_1788134974712
 *
 * 输出：
 *   <outDir>/<bookId>_contrast_<month>.json   逐月差异清单
 *   stdout 汇总
 *
 * 对照字段（容差 0.01 元）：
 *   期初余额  begBal    vs  ty (obDr - obCr)       [借方为正 signed]
 *   本期借方  debit     vs  ty periodDr
 *   本期贷方  credit    vs  ty periodCr
 *   期末余额  endBal    vs  ty (endDr - endCr)    [借方为正 signed]
 *   本年借方  ydDebit   vs  ty ytdDr
 *   本年贷方  ydCredit  vs  ty ytdCr
 *
 * 归一化规则：金蝶 GLBal 的 begBal/endBal 已是「借方为正」signed 值
 *            （资产+、负债-、累计折旧- 等），不论科目方向。
 *            ty 用 endDr/endCr 双栏，signed = endDr - endCr（不论 normal）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const EPS = 0.01;
const round2 = n => Math.round(Number(n) * 100) / 100;

function parseArgs() {
  const argv = process.argv.slice(2);
  const leafOnly = argv.indexOf('--leaf-only') >= 0;
  const positional = argv.filter(a => !a.startsWith('--'));
  if (positional.length < 2) {
    console.error('用法: node tools/contrast_kis.js <金蝶baseline.json> <ty导出目录> [bookId] [--leaf-only]');
    process.exit(1);
  }
  return {
    baselinePath: positional[0],
    outDir: positional[1],
    bookId: positional[2] || null,
    leafOnly
  };
}

/* ---------- 加载金蝶基准 ---------- */
function loadBaseline(p) {
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  const subjects = data.subjects || [];
  // 金蝶科目 code → subject 信息（含 dc 方向、level）
  const subjMap = {};
  subjects.forEach(s => { subjMap[s.code] = s; });
  // 构建父→子集合，用于判断末级
  const childMap = {}; // code → [childCodes...]
  subjects.forEach(s => {
    // 通过编码前缀判断父子（金蝶 parentId 字段多数为空，回退到前缀法）
    subjects.forEach(x => {
      if (x.code !== s.code && x.code.indexOf(s.code) === 0) {
        if (!childMap[s.code]) childMap[s.code] = [];
        childMap[s.code].push(x.code);
      }
    });
  });
  return {
    source: data.source,
    periods: data.periods || [],
    balanceByPeriod: data.balanceByPeriod || {},
    subjMap,
    childMap,
    subjects
  };
}

/* ---------- 加载 ty generalLedger ---------- */
function loadXzysGL(outDir, bookId, month) {
  const p = path.join(outDir, bookId + '_generalLedger_' + month + '.json');
  if (!fs.existsSync(p)) return null;
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  const rowMap = {};
  (data.rows || []).forEach(r => { rowMap[r.code] = r; });
  return { month, rows: data.rows || [], rowMap };
}

/* ---------- 对单月对照 ---------- */
function contrastMonth(baseline, tyGL, opts) {
  const month = tyGL.month;
  const kisBal = baseline.balanceByPeriod[month] || {};
  const diffs = [];
  let commonCount = 0, matchCount = 0;

  const allCodes = new Set([...Object.keys(kisBal), ...Object.keys(tyGL.rowMap)]);

  allCodes.forEach(code => {
    const kisRow = kisBal[code];
    const tyRow = tyGL.rowMap[code];
    const subj = baseline.subjMap[code];
    const isLeaf = !baseline.childMap[code] || baseline.childMap[code].length === 0;

    // --leaf-only 模式跳过非末级
    if (opts.leafOnly && !isLeaf) return;

    // 一边缺失
    if (!kisRow && tyRow) {
      // 金蝶只为有发生/有余额的科目建 GLBal 行；若 ty 全 0，视为一致
      const tyAllZero = (Math.abs(tyRow.obDr) < EPS && Math.abs(tyRow.obCr) < EPS &&
        Math.abs(tyRow.periodDr) < EPS && Math.abs(tyRow.periodCr) < EPS &&
        Math.abs(tyRow.endDr) < EPS && Math.abs(tyRow.endCr) < EPS &&
        Math.abs(tyRow.ytdDr) < EPS && Math.abs(tyRow.ytdCr) < EPS);
      if (tyAllZero) { commonCount++; matchCount++; return; }
      diffs.push({
        code, name: tyRow.name, leaf: isLeaf,
        kind: 'missing_in_kis',
        detail: '金蝶基准无此科目余额，ty 有'
      });
      return;
    }
    if (kisRow && !tyRow) {
      // 金蝶有余额但 ty 无此科目——先看金蝶余额是否全 0
      const kisAllZero = (Math.abs(kisRow.begBal) < EPS && Math.abs(kisRow.debit) < EPS &&
        Math.abs(kisRow.credit) < EPS && Math.abs(kisRow.endBal) < EPS &&
        Math.abs(kisRow.ydDebit) < EPS && Math.abs(kisRow.ydCredit) < EPS);
      if (kisAllZero) { commonCount++; matchCount++; return; }
      diffs.push({
        code, name: subj ? subj.name : '', leaf: isLeaf,
        kind: 'missing_in_ty',
        detail: 'ty 无此科目，金蝶有余额'
      });
      return;
    }
    commonCount++;

    // 6 字段对比
    const fields = [
      { f: 'begBal',   kis: kisRow.begBal,            ty: tyRow.obDr - tyRow.obCr, label: '期初余额' },
      { f: 'debit',    kis: kisRow.debit,             ty: tyRow.periodDr,           label: '本期借方' },
      { f: 'credit',   kis: kisRow.credit,            ty: tyRow.periodCr,           label: '本期贷方' },
      { f: 'endBal',   kis: kisRow.endBal,            ty: tyRow.endDr - tyRow.endCr, label: '期末余额' },
      { f: 'ydDebit',  kis: kisRow.ydDebit,           ty: tyRow.ytdDr,              label: '本年借方' },
      { f: 'ydCredit', kis: kisRow.ydCredit,          ty: tyRow.ytdCr,              label: '本年贷方' }
    ];

    let rowHasDiff = false;
    fields.forEach(fd => {
      const diff = round2(fd.kis - fd.ty);
      if (Math.abs(diff) >= EPS) {
        rowHasDiff = true;
        diffs.push({
          code, name: tyRow.name, leaf: isLeaf,
          field: fd.f, label: fd.label,
          kis: round2(fd.kis), ty: round2(fd.ty), diff,
          kind: 'value_mismatch'
        });
      }
    });

    if (!rowHasDiff) matchCount++;
  });

  return { month, diffs, commonCount, matchCount, totalCodes: allCodes.size };
}

/* ---------- 主流程 ---------- */
function main() {
  const opts = parseArgs();
  const baseline = loadBaseline(opts.baselinePath);
  console.log('=== 金蝶 KIS vs ty 对照 ===');
  console.log('金蝶基准: ' + baseline.source + ' (' + baseline.subjects.length + ' 科目)');
  console.log('金蝶期间: ' + baseline.periods.join(', '));
  console.log('ty 导出目录: ' + opts.outDir);
  console.log('bookId: ' + (opts.bookId || '(未指定，将自动推断)'));
  console.log('模式: ' + (opts.leafOnly ? '仅末级科目' : '全部科目（含父级）'));
  console.log('');

  // 推断 bookId
  let bookId = opts.bookId;
  if (!bookId) {
    const files = fs.readdirSync(opts.outDir).filter(f => /_generalLedger_/.test(f));
    if (!files.length) { console.error('未在 ' + opts.outDir + ' 找到 generalLedger 文件，请指定 bookId'); process.exit(1); }
    bookId = files[0].replace(/_generalLedger_.*$/, '');
    console.log('自动推断 bookId: ' + bookId);
  }

  let totalDiff = 0, totalCommon = 0, totalMatch = 0;
  const summary = [];

  baseline.periods.forEach(month => {
    const tyGL = loadXzysGL(opts.outDir, bookId, month);
    if (!tyGL) {
      console.log('[' + month + '] ty 无此月导出，跳过');
      return;
    }
    const r = contrastMonth(baseline, tyGL, opts);
    totalDiff += r.diffs.length;
    totalCommon += r.commonCount;
    totalMatch += r.matchCount;

    // 写差异清单
    const outPath = path.join(opts.outDir, bookId + '_contrast_' + month + '.json');
    fs.writeFileSync(outPath, JSON.stringify(r, null, 2));

    // 分类统计
    const byKind = {};
    r.diffs.forEach(d => { byKind[d.kind] = (byKind[d.kind] || 0) + 1; });
    const leafDiff = r.diffs.filter(d => d.leaf).length;
    const parentDiff = r.diffs.length - leafDiff;

    console.log('[' + month + '] 共同科目=' + r.commonCount +
      '  完全一致=' + r.matchCount +
      '  差异=' + r.diffs.length +
      ' (末级:' + leafDiff + ' 父级:' + parentDiff + ')' +
      (r.diffs.length ? '  ' + Object.entries(byKind).map(([k, v]) => k + '=' + v).join(' ') : ''));
    summary.push({ month, ...r, diffFile: outPath });
  });

  console.log('');
  console.log('=== 总计 ===');
  console.log('共同科目对比次数: ' + totalCommon);
  console.log('完全一致: ' + totalMatch + ' (' + (totalCommon ? (totalMatch / totalCommon * 100).toFixed(1) : 0) + '%)');
  console.log('差异条目: ' + totalDiff);

  if (totalDiff > 0) {
    console.log('');
    console.log('--- 差异分类汇总 ---');
    const kindMap = {};
    summary.forEach(s => s.diffs.forEach(d => {
      if (!kindMap[d.kind]) kindMap[d.kind] = { count: 0, samples: [] };
      kindMap[d.kind].count++;
      if (kindMap[d.kind].samples.length < 3) kindMap[d.kind].samples.push(d);
    }));
    Object.keys(kindMap).forEach(k => {
      console.log('  ' + k + ': ' + kindMap[k].count + ' 条');
      kindMap[k].samples.forEach(s => {
        if (s.kind === 'value_mismatch') {
          console.log('    示例: ' + s.code + ' ' + s.name + ' ' + s.label +
            '  金蝶=' + s.kis + '  ty=' + s.ty + '  差=' + s.diff + (s.leaf ? '' : ' (父级)'));
        } else {
          console.log('    示例: ' + s.code + ' ' + s.name + '  ' + s.detail + (s.leaf ? '' : ' (父级)'));
        }
      });
    });
  }

  // 输出建议下一步
  console.log('');
  console.log('--- 差异清单文件 ---');
  summary.filter(s => s.diffs.length > 0).forEach(s => {
    console.log('  ' + s.diffFile);
  });

  process.exit(totalDiff > 0 ? 1 : 0);
}

main();
