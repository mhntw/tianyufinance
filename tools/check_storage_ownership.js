#!/usr/bin/env node
/* 存储归属卡口：防止"用户设置写错地方"这类问题再长出来（2026-10-21）
 *
 * 背景：结账模板曾把**完整定义**只写 localStorage['settle_templates_v1']，账套里只留 {id,enabled}。
 *   → 双账套互相整体覆盖；换安装标识符（com.chen.xzys → com.chen.ty）/ 换电脑 / 清缓存即整体消失。
 *   这类 bug 的特征是"不报错、数据静默丢"，靠功能测试很难兜住，必须靠约定 + 静态卡口。
 *
 * 本脚本强制两条规则：
 *   规则一（存储归属）：localStorage 只允许写"本机偏好/全局设置"白名单里的键；
 *       其余一律应写进账套 state（随备份/同步/换机走）。
 *       只读键（旧版遗留）允许 getItem，禁止 setItem / removeItem。
 *   规则二（改了要落盘）：js/pages/** 里直接改 `S.state.x = ...` 的，必须在附近调用 persist()；
 *       否则重启后改动消失（资产类别曾整页漏 persist，就是这条规则要防的）。
 *       例外须进 ALLOW_STATE_WRITES 并写明理由。
 *   ⚠ 已知局限：**就地改属性**（如 `var cat = S.assetCats()[i]; cat.enabled = false;`）静态扫不出来 ——
 *     那种写法改的仍是 state 里的同一份对象，但没有赋值语句可识别。改这类代码时请自觉补 persist()
 *     （Settle.js / Asset.js 两处就地修改都留了注释说明）。
 *
 * 新增一个 localStorage 键时：先问自己"换电脑后用户会希望它还在吗？"
 *   会 → 写进账套 state；不会 → 加入下面白名单并写清理由。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const JS_DIR = path.join(ROOT, 'js');

/* 允许写入的本机键（全局设置 / UI 偏好：换电脑后重设无损失，或本就只对本机有意义） */
const WRITABLE = {
  'kis_settings': '屏保/操作员密码、新手引导完成、界面等全局设置（本机）',
  'kis_cur': '上次打开的账套指针（本机）',
  'kis_bk_remind': '上次备份提醒日期（本机）',
  'kis_ui_scale': '界面缩放比例（本机）',
  'quick_menu_keys': '快捷菜单配置（本机）',
  'tyNavCollapsed': '侧边导航折叠状态（本机）',
  'cloud_sync_last': '上次云同步时间/目录/条数（本机路径）',
  'ty_update_check': '更新检查缓存（本机）',
  'ty_update_notified': '更新提示已读标记（本机）'
};
/* 只读键：旧版遗留的存储，允许读（迁移源），禁止写/删 */
const READ_ONLY = {
  'settle_templates_v1': '结账模板旧存储：定义已改存账套 state.settleTemplates，此键仅作一次性迁移源',
  'kis_state': '旧版「整个账套一份」的 localStorage 缓存：现账套一律走磁盘 books/*.json，'
    + '仅 store.js 迁移老数据时读取，禁止写回（写回会让两套真相打架）'
};
/* 规则二的例外：写明理由，避免"为了让卡口变绿"随手加 */
const ALLOW_STATE_WRITES = [
  {
    file: 'js/pages/settle/Settle.js',
    pattern: /S\.state\.settleTemplates = \[\];/,
    reason: 'stateSettleTemplates() 的懒初始化（只补空数组，不写业务数据）；真正写盘由 persistSettleTemplates 统一负责'
  }
];
const PERSIST_WINDOW = 8;   // 赋值后多少行内必须出现 persist(

let errors = [];
function err(file, ln, msg) { errors.push(file + ':' + ln + '  ' + msg); }

function walk(dir, out) {
  for (const n of fs.readdirSync(dir)) {
    const p = path.join(dir, n);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (n.endsWith('.js')) out.push(p);
  }
  return out;
}
const files = walk(JS_DIR, []);

/* 把某文件里的 `var/let/const NAME = 'value'` 解析出来，供 `localStorage.setItem(NAME, …)` 使用 */
function resolveConst(src, name) {
  const m = src.match(new RegExp('(?:var|let|const)\\s+' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*=\\s*[\'`"]([^\'`"]+)[\'`"]'));
  return m ? m[1] : null;
}

for (const abs of files) {
  const rel = path.relative(ROOT, abs).split(path.sep).join('/');
  const src = fs.readFileSync(abs, 'utf8');
  const lines = src.split('\n');

  /* ---------- 规则一：localStorage 键归属 ---------- */
  lines.forEach((raw, i) => {
    const line = raw.replace(/^\s*\/\/.*$/, '');                   // 整行注释跳过
    const re = /localStorage\s*\.\s*(setItem|getItem|removeItem)\s*\(\s*([^,)]+)/g;
    let m;
    while ((m = re.exec(line))) {
      const op = m[1], expr = m[2].trim();
      let key = null;
      const lit = expr.match(/^['"`]([^'"`]+)['"`]$/);
      if (lit) key = lit[1];
      else if (/^[A-Za-z_$][\w$]*$/.test(expr)) key = resolveConst(src, expr);
      if (!key) { err(rel, i + 1, '无法静态解析 localStorage 的键名「' + expr + '」——请写成字符串常量，便于归属审查'); continue; }

      if (READ_ONLY[key]) {
        if (op !== 'getItem') err(rel, i + 1, '只读键「' + key + '」禁止 ' + op + '（' + READ_ONLY[key] + '）');
        continue;
      }
      if (op === 'setItem' && !WRITABLE[key]) {
        err(rel, i + 1, '不允许写 localStorage「' + key + '」——'
          + '用户设置/数据请写进账套 state（随备份/同步/换机走；先例见 Settle.js 的 settleTemplates）；'
          + '确属本机偏好，请加入 tools/check_storage_ownership.js 的 WRITABLE 并写明理由');
      }
    }
  });

  /* ---------- 规则二：页面直接改 state 必须落盘 ---------- */
  if (rel.indexOf('js/pages/') === 0) {
    lines.forEach((raw, i) => {
      const line = raw.replace(/^\s*\/\/.*$/, '');
      if (!/S\.state\.[A-Za-z_$][\w$]*(\.[\w$]+)*\s*=[^=]/.test(line)) return;
      const allowed = ALLOW_STATE_WRITES.some(a => a.file === rel && a.pattern.test(line));
      if (allowed) return;
      const win = lines.slice(i, i + PERSIST_WINDOW).join('\n');
      if (!/persist\s*\(/.test(win)) {
        err(rel, i + 1, '直接修改了账套 state 却没有在 ' + PERSIST_WINDOW + ' 行内调用 persist() —— '
          + '重启后这次改动会消失（资产类别曾整页漏 persist）。'
          + '若确属"随下次正常写盘落库"的只读语义，请加入 ALLOW_STATE_WRITES 并写明理由');
      }
    });
  }
}

/* ---------- 规则三：关窗兜底必须判 r.ok（2026-10-22） ----------
 * Storage.saveBook / saveBackup **内部已 catch、恒 resolve**，写盘失败藏在 r.ok === false。
 * 只挂 `.catch(...)` 收不到它 → 关窗最后一笔写失败完全静默（连日志都不打）。
 * 因此 store._flushOnExit 的主账本必须走 _saveBookChecked（判成败 + 触发告警），
 * 不得退回「Storage.saveBook(...).catch(...)」的写法。 */
{
  const storeAbs = path.join(JS_DIR, 'store.js');
  const storeSrc = fs.readFileSync(storeAbs, 'utf8');
  const m = /_flushOnExit:\s*function\s*\(\)\s*\{([\s\S]*?)\n    \},/.exec(storeSrc);
  if (!m) {
    err('js/store.js', 0, '找不到 _flushOnExit —— 若已改名，请同步更新本卡口');
  } else {
    const ln = storeSrc.slice(0, storeSrc.indexOf('_flushOnExit')).split('\n').length;
    if (/Storage\.saveBook\s*\(/.test(m[1])) {
      err('js/store.js', ln, '_flushOnExit 不得直接调 Storage.saveBook —— saveBook 恒 resolve，'
        + '写失败藏在 r.ok=false，必须走 _saveBookChecked 判成败');
    }
    if (!/_saveBookChecked\s*\(/.test(m[1])) {
      err('js/store.js', ln, '_flushOnExit 应通过 _saveBookChecked 落主账本（判 r.ok）');
    }
  }
}

if (errors.length) {
  console.log('✗ 存储归属检查未通过（' + errors.length + ' 项）：\n');
  errors.forEach(e => console.log('  ' + e));
  console.log('\n提示：新增 localStorage 键前先问「换电脑后用户希望它还在吗？」会 → 进账套；不会 → 进白名单。');
  process.exit(1);
}
console.log('✓ 存储归属检查通过：' + files.length + ' 个 js 文件，可写键 ' + Object.keys(WRITABLE).length
  + ' 个、只读键 ' + Object.keys(READ_ONLY).length + ' 个、state 写入例外 ' + ALLOW_STATE_WRITES.length + ' 处');
process.exit(0);
