'use strict';
/* 固定资产「新增/编辑」改造验证（2026-09-18）
 * 覆盖：
 *   A 编辑卡片时累计折旧字段同步（P0-1，实测复现过的 bug）
 *   B 表单静态契约 —— 对齐金蝶新增页（字段增删与星标）
 *   C 校验与提示的静态契约
 * 仅读真实账套文件做只读加载；所有写操作都落内存 localStorage，不动账套。
 */
const path = require('path'), fs = require('fs'), os = require('os');
const ROOT = path.resolve(__dirname, '..');

const mem = {};
global.localStorage = { getItem: k => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; } };
global.document = { getElementById: () => null, addEventListener: () => {} };
global.window = global; global.__TAURI__ = {}; global.isTauri = false;
require(path.join(ROOT, 'js/storage.js'));
require(path.join(ROOT, 'js/store.js'));
const S = global.S;
const num = v => { const x = parseFloat(v); return isFinite(x) ? x : 0; };

let pass = 0, fail = 0;
function ck(cond, label) { if (cond) { pass++; console.log('  \u2713 ' + label); } else { fail++; console.log('  \u2717 ' + label); } }

const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const ASSET = fs.readFileSync(path.join(ROOT, 'js/pages/asset/Asset.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'css/style.css'), 'utf8');

console.log('\n=== A. store 层：编辑卡片时累计折旧字段同步（P0-1）===');
const BOOKS = path.join(os.homedir(), 'Library/Application Support/添钰财务/books');
const files = fs.readdirSync(BOOKS).filter(f => f.endsWith('.json')).sort().map(n => path.join(BOOKS, n));
const file = files.filter(f => { const b = JSON.parse(fs.readFileSync(f, 'utf8')); return (b.fixedAssets || []).length > 0; })[0];
if (!file) { console.log('  （无含卡片的账套，跳过 A 组）'); }
else {
  S.state = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (S.normalizeState) S.normalizeState();
  S._glCache = {};
  const fa = S.state.fixedAssets[0];
  const b0 = num(fa.accumDeprBegin), a0 = num(fa.accumDepr);
  ck(Math.abs(b0 - a0) < 0.005, 'A1 起点：卡片 accumDeprBegin == accumDepr（' + b0.toFixed(2) + '）');
  const name0 = fa.name;
  S.updateFixedAsset(fa.id, { accumDeprBegin: b0 + 1000 });
  const r1 = S.state.fixedAssets.filter(x => x.id === fa.id)[0];
  ck(Math.abs(num(r1.accumDepr) - num(r1.accumDeprBegin)) < 0.005,
    'A2 改期初 +1000 后两字段仍相等（修复前会分离成 1698.10 / 698.10）');
  ck(Math.abs(num(r1.accumDepr) - (b0 + 1000)) < 0.005, 'A3 同步值等于表单填入值，未被旧值覆盖');
  const bNow = num(r1.accumDeprBegin);
  S.updateFixedAsset(fa.id, { name: name0 + 'X', accumDeprBegin: bNow });
  const r2 = S.state.fixedAssets.filter(x => x.id === fa.id)[0];
  ck(Math.abs(num(r2.accumDepr) - bNow) < 0.005, 'A4 仅改其他字段时不会误清累计折旧');
  ck(num(r2.accumDeprBegin) === 0 || Math.abs(num(r2.accumDepr) - num(r2.accumDeprBegin)) < 0.005,
    'A5 恒等式保持：accumDepr == accumDeprBegin');
}

console.log('\n=== B. 表单静态契约（对齐金蝶新增页）===');
ck(!/id="aStatus"/.test(HTML), 'B1 已移除「状态」字段（金蝶无此字段，消除无凭证清理入口）');
ck(!/id="aCleanPeriod"/.test(HTML), 'B2 已移除「清理期间」字段');
ck(/<label class="req">类别<\/label>/.test(HTML), 'B3 资产类别改必填（金蝶为必填）');
ck(/<label>期初累计折旧<\/label>/.test(HTML), 'B4 期初累计折旧去星标（金蝶非必填）');
ck(/<label>本年已折旧<\/label>/.test(HTML), 'B5 本年已折旧去星标');
ck(/<label>数量<\/label>/.test(HTML), 'B6 数量去星标（金蝶非必填）');
ck(/id="aSalvageHint"/.test(HTML) && /id="aAccumHint"/.test(HTML) && /id="aMonthDeprHint"/.test(HTML),
  'B7 三个辅助提示位已就位');
ck(/\.form-hint/.test(CSS), 'B8 .form-hint 样式已定义');
ck(/\.form-hint:empty/.test(CSS), 'B9 空提示自动隐藏（不占位）');

console.log('\n=== C. 校验与提示静态契约 ===');
ck(!/status: \$\('aStatus'\)\.value/.test(ASSET) && !/cleanPeriod: \$\('aCleanPeriod'\)\.value/.test(ASSET),
  'C1 _collectAsset 不再采集 status / cleanPeriod（编辑不覆盖原值）');
ck(/rawPeriod === ''/.test(ASSET) && /rawBegin === ''/.test(ASSET),
  'C2 校验改用原始字符串（原先被 U.num 转成 0，三项必填形同虚设）');
ck(/U\.num\(rawPeriod\) > U\.num\(rawLife\)/.test(ASSET), 'C3 已折旧期间不得大于预计使用期数');
ck(/U\.num\(rawRate\) < 0 \|\| U\.num\(rawRate\) > 100/.test(ASSET), 'C4 残值率范围 0~100');
ck(/var dup = S\.state\.fixedAssets\.filter/.test(ASSET), 'C5 资产编码查重已加入');
ck(/=== '1606'/.test(ASSET), 'C6 新增时资产清理科目默认带出 1606');
ck(/function _anchorMonth/.test(ASSET) && /function _updateHints/.test(ASSET), 'C7 锚点推导与提示函数已就位');
ck(/'aAcq', 'aPeriodUsed'/.test(ASSET), 'C8 锚点相关字段变动会刷新时点提示');
ck(/_editingDeprMonth \|\| _anchorMonth\(\)/.test(ASSET), 'C9 编辑已计提卡片时优先用卡片自带锚点月');

console.log('\n结果：通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
