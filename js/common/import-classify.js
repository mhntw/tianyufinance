/* ============================================================
 * 导入账套的**分流判据**（纯函数、零 DOM、零依赖）
 *
 * 【核心不变量：导入 = 新增】
 *   「导入账套」这个入口**只做新增**，绝不覆盖当前账套。用户看到"导入"二字时，
 *   心里想的是"加一本 / 打开别人给的账"，不会预期自己正在用的账被换掉 ——
 *   名字与行为不符是最坏的一类不一致，因为他不会去细读确认框（他"已经知道"这个按钮干什么了）。
 *
 *   于是全应用只有一处能"覆盖当前账本"：「查看备份」列表里每行的「恢复」（从应用内快照回滚），
 *   其保护为：明确确认 → 覆盖前自动留存档 → 恢复 → 告知可撤销。
 *   （外部文件曾短暂支持过"覆盖当前账本"，2026-09-28 按用户要求删除：外部副本只能新增为一本账套。）
 *
 * 【三条分流】（按**文件种类 + 数量**判定，不让用户再选一次"我要哪种导入"）
 *     ① 1 个 .ais  → 解析后**新建**一个独立账套            （action 'new-ais'）
 *     ② ≥2 个 .ais → 逐文件解析后**合并新建**连续多年账套   （action 'merge-ais'）
 *     ③ 1 个 .json → **作为新账套导入**                     （action 'new-json'）
 *   ⚠ ③ 在 2026-09-28 之前是"覆盖当前账套"——那是历史遗留的例外，已按上述不变量改掉。
 *
 * 【为什么不做"聪明猜测"】判不出就明确报错（混选 .ais/.json、多个 .json、选了别的类型）。
 *   不猜：猜错的代价不对称 —— 从前猜成"覆盖"会换掉账本，现在猜成"新建"会多出一本。
 *
 * 【为什么单独放一个文件】它是要被测的判据 —— 放在页面模块里就只能靠加载整个页面来测，
 *   而这里是纯函数，测试可直接加载本文件逐条断言（见 tools/verify_import_entry.js）。
 * ============================================================ */

/**
 * @param {ArrayLike<{name?:string}>} list 用户选中的文件（File 或任何带 name 的对象）
 * @returns {{action:'new-ais'|'merge-ais'|'new-json'|'error', files:Array, msg?:string}}
 *   action：new-ais=单本金蝶账套新建 / merge-ais=多年合并新建 / new-json=备份作为新账套导入 /
 *           error=不执行（msg 直接提示用户）
 *   files ：该动作要处理的文件（error 时保持原列表，仅供提示用）
 *   ⚠ 任何 action 都**不含"覆盖当前账套"** —— 覆盖请走「查看备份」。
 */
export function importPlanOf(list) {
  const files = [];
  for (let i = 0; i < (list ? list.length : 0); i++) if (list[i]) files.push(list[i]);
  if (!files.length) return { action: 'error', files: [], msg: '未选择文件' };

  const nameOf = f => String((f && f.name) || '').toLowerCase();
  const jsons = files.filter(f => /\.json$/.test(nameOf(f)));
  const ais = files.filter(f => /\.ais$/.test(nameOf(f)));
  const others = files.length - jsons.length - ais.length;

  if (others > 0) {
    return { action: 'error', files: files, msg: '只支持金蝶账套（.ais）与本软件账套备份（.json），请勿选入其它类型文件' };
  }
  if (jsons.length && ais.length) {
    return { action: 'error', files: files, msg: '请勿把账套备份(.json)与金蝶账套(.ais)混在一起导入：一次只做一件事' };
  }
  if (jsons.length > 1) {
    return { action: 'error', files: jsons, msg: '一次只能导入一个 .json 账套备份（多份备份无法合并）' };
  }
  if (jsons.length === 1) return { action: 'new-json', files: jsons };    // ③ 作为新账套导入
  if (ais.length === 1) return { action: 'new-ais', files: ais };         // ① 新建账套
  return { action: 'merge-ais', files: ais };                             // ② 合并新建
}
