'use strict';
/* 固定资产「新增/编辑」改造验证（2026-09-18）
 * 覆盖：
 *   A 编辑卡片时累计折旧字段同步（P0-1，实测复现过的 bug）
 *   B 表单静态契约（字段增删与星标）
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
/* 定点化后：store 内部金额是定点整数（0.0001 元），而【表单/updateFixedAsset 入参】是「元」。
   故断言两侧分别在各自的口径上取值：内部读 num() 即整数，期望值用 amt() 从元换算。 */
const yuan = a => (global.util.yuan(a));
const amt = v => global.util.amt(v);

let pass = 0, fail = 0;
function ck(cond, label) { if (cond) { pass++; console.log('  \u2713 ' + label); } else { fail++; console.log('  \u2717 ' + label); } }

const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const ASSET = fs.readFileSync(path.join(ROOT, 'js/pages/asset/Asset.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'css/style.css'), 'utf8');
const STORE = fs.readFileSync(path.join(ROOT, 'js/store.js'), 'utf8');

console.log('\n=== A. store 层：编辑卡片时累计折旧字段同步（P0-1）===');
// 跨平台账套目录 + 无账套即跳过（原先写死 macOS 路径，CI/Linux 上抛 ENOENT 会被误判为失败）
const BOOKS = (function () {
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', '添钰财务', 'books');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), '添钰财务', 'books');
  return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), '添钰财务', 'books');
})();
if (!fs.existsSync(BOOKS) || !fs.readdirSync(BOOKS).some(f => f.endsWith('.json'))) {
  console.log('跳过：未找到账套（' + BOOKS + '）');
  console.log('本脚本需要真实账套作为样本，无账套环境（如 CI）自动跳过，返回 0，不计为失败。');
  process.exit(0);
}
const files = fs.readdirSync(BOOKS).filter(f => f.endsWith('.json')).sort().map(n => path.join(BOOKS, n));
const file = files.filter(f => { const b = JSON.parse(fs.readFileSync(f, 'utf8')); return (b.fixedAssets || []).length > 0; })[0];
if (!file) { console.log('  （无含卡片的账套，跳过 A 组）'); }
else {
  S.state = JSON.parse(fs.readFileSync(file, 'utf8'));
  /* 磁盘账套是 v5（金额=「元」）→ 按真实加载路径先迁移到 v6（定点整数）。
     不迁移的话 updateFixedAsset 会把「元」当元再 ×10000，而本脚本的期望值却是元 —— 两侧差 10000 倍。 */
  if (S.migrateAmountsToV6 && S.state.schemaVersion !== S.SCHEMA_VERSION) S.migrateAmountsToV6(S.state);
  if (S.normalizeState) S.normalizeState();
  S._glCache = {};
  const fa = S.state.fixedAssets[0];
  const b0 = num(fa.accumDeprBegin), a0 = num(fa.accumDepr);   // 内部定点整数
  ck(b0 === a0, 'A1 起点：卡片 accumDeprBegin == accumDepr（' + yuan(b0).toFixed(2) + '）');
  const name0 = fa.name;
  // 表单口径是「元」：填「原期初 + 1000 元」
  const want = yuan(b0) + 1000;
  S.updateFixedAsset(fa.id, { accumDeprBegin: want });
  const r1 = S.state.fixedAssets.filter(x => x.id === fa.id)[0];
  ck(num(r1.accumDepr) === num(r1.accumDeprBegin),
    'A2 改期初 +1000 后两字段仍相等（修复前会分离成 1698.10 / 698.10）');
  ck(num(r1.accumDepr) === amt(want), 'A3 同步值等于表单填入值，未被旧值覆盖');
  const bNow = num(r1.accumDeprBegin);
  S.updateFixedAsset(fa.id, { name: name0 + 'X', accumDeprBegin: yuan(bNow) });
  const r2 = S.state.fixedAssets.filter(x => x.id === fa.id)[0];
  ck(num(r2.accumDepr) === bNow, 'A4 仅改其他字段时不会误清累计折旧');
  ck(num(r2.accumDeprBegin) === 0 || num(r2.accumDepr) === num(r2.accumDeprBegin),
    'A5 恒等式保持：accumDepr == accumDeprBegin');
}

console.log('\n=== B. 表单静态契约 ===');
ck(!/id="aStatus"/.test(HTML), 'B1 已移除「状态」字段（消除无凭证清理入口）');
ck(!/id="aCleanPeriod"/.test(HTML), 'B2 已移除「清理期间」字段');
ck(!/id="aCategory"/.test(HTML), 'B3 卡片表单已无「类别」字段（2026-10-27 移除）');
ck(/id="aCode"[^>]*placeholder="留空自动生成/.test(HTML), 'B3b 资产编码不再必填（留空自动生成）');
ck(/<label>期初累计折旧<\/label>/.test(HTML), 'B4 期初累计折旧去星标（非必填）');
ck(/<label>本年已折旧<\/label>/.test(HTML), 'B5 本年已折旧去星标');
ck(/<label>数量<\/label>/.test(HTML), 'B6 数量去星标（非必填）');
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

console.log('\n=== D. 资产类别档案下线后的契约（2026-10-27）===');
ck(!/id="aCategory"/.test(HTML) && !/id="assetCatList"/.test(HTML),
  'D1 卡片表单与 datalist 中的类别输入已删除');
ck(/function _nextAssetCode/.test(ASSET) && !/if \(!fa\.code\) return showToast/.test(ASSET),
  'D1b 资产编码自动生成（KH0001 递增），不再强制手填');
ck(/function _deprGroups\(month, showCleaned, startMonth\)/.test(ASSET) && !/byDept/.test(ASSET),
  'D1c 折旧分组固定按部门（byDept 死参数已清除）');
ck(!/id="btnAssetCatMgr"/.test(HTML) && !/id="assetCatListModal"/.test(HTML) && !/id="catModal"/.test(HTML),
  'D2 类别维护弹窗 / 类别编辑弹窗 / 工具条入口 均已删除');
ck(!/id="assetCatTree"/.test(HTML), 'D3 左树类别筛选已删除');
/* 只查真实标记（class/id 属性），不查注释里的类名提及 —— 注释里保留 .orig-sider 字样是有意的溯源说明 */
ck(!/class="orig-sider|id="assetSider"|id="assetDeptTree"/.test(HTML), 'D3b 右侧部门树面板整体下线（2026-10-31，筛选改首行下拉）');
ck(/id="aDeptFilter"/.test(HTML) && /function renderAssetDeptFilter/.test(ASSET), 'D3c 首行部门下拉存在且有渲染函数');
ck(!/assetCats\(\)/.test(ASSET), 'D4 前端不再读取类别档案');
ck(!/normalizeAssetCategory\s*:\s*function/.test(STORE), 'D5 store 不再有「编码↔名称」归一方法');
ck(/function migrateAssetCategoryToName/.test(STORE) && /migrateAssetCategoryToName\(this\.state\)/.test(STORE),
  'D6 store 在 normalizeState 里调用幂等迁移（编码 → 名称）');
ck(/assetCats: \[\],/.test(STORE), 'D7 emptyState 保留 assetCats 空数组键（旧版本回退时的兼容位）');

console.log('\n=== E. 长文本列不撑宽表格（2026-10-31）===');
/* 背景：.grid td 上的 max-width 在 table-layout:auto 下不参与列宽计算，
   备注一长整张表就跟着变宽。真正生效的是内层 .cell-clip（inline-block 的 max-width
   会进入单元格 max-content）。这两条断言锁住"别再退回只用 td max-width"的写法。 */
ck(/<td><span class="cell-clip" title="\$\{fa\.memo \|\| ''\}">\$\{fa\.memo \|\| ''\}<\/span><\/td>/.test(ASSET),
  'E1 备注列内容包在 .cell-clip 内并带 title 全文');
const clipRule = (CSS.match(/\.cell-clip\s*\{[^}]*\}/) || [''])[0];
ck(/max-width:\s*220px/.test(clipRule), 'E2 .cell-clip 有 max-width（否则列宽仍随内容增长）');
ck(/display:\s*inline-block/.test(clipRule) && /text-overflow:\s*ellipsis/.test(clipRule),
  'E3 .cell-clip 是 inline-block 且超长省略号');

console.log('\n结果：通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
