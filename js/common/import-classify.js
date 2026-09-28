/* ============================================================
 * 导入账套的**分流判据**（纯函数、零 DOM、零依赖）
 *
 * 【背景】原先设置页「账套管理」有三个并列入口，用户反馈"重复、太复杂"：
 *     · 导入账套            —— 选 .ais → 新建账套；选 .json → **覆盖当前账套**
 *     · 多年合并导入        —— 多选 .ais → 合并新建一个连续多年账套
 *     · 导入备份            —— 选 .json → **覆盖当前账套**
 *   逐条比对后，三者**唯一的行为差异只有三条**：
 *     ① 1 个 .json  → 覆盖恢复**当前**账套
 *     ② 1 个 .ais   → 解析后**新建**一个独立账套
 *     ③ ≥2 个 .ais  → 逐文件解析后**合并新建**一个连续多年账套
 *   所以不需要三个按钮，也不该让用户先选"我要哪种导入"（那等于把复杂度又还给他）——
 *   按**文件种类 + 数量**即可判定。
 *
 * 【为什么不做"聪明猜测"】判不出就明确报错（混选 .ais/.json、多个 .json、选了别的类型），
 *   不猜。猜错的代价不对称：猜成"覆盖"会毁掉当前账套（虽可回滚），猜成"新建"会多出一个账套。
 *   ⚠ 尤其是**覆盖是破坏性操作**：调用方在拿到 action==='overwrite' 时，
 *     必须**先明确告知将覆盖哪一本账套并取得确认**，不能静默执行。
 *
 * 【为什么单独放一个文件】它是要被测的判据 —— 放在页面模块里就只能靠加载整个页面来测，
 *   而这里是纯函数，测试可直接加载本文件逐条断言（见 tools/verify_import_entry.js）。
 * ============================================================ */

/**
 * @param {ArrayLike<{name?:string}>} list 用户选中的文件（File 或任何带 name 的对象）
 * @returns {{action:'overwrite'|'new'|'merge'|'error', files:Array, msg?:string}}
 *   action：overwrite=覆盖当前账套 / new=新建账套 / merge=合并新建 / error=不执行（msg 直接提示用户）
 *   files ：该动作要处理的文件（error 时保持原列表，仅供提示用）
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
    return { action: 'error', files: files, msg: '只支持金蝶账套（.ais）与本软件备份（.json），请勿选入其它类型文件' };
  }
  if (jsons.length && ais.length) {
    return { action: 'error', files: files, msg: '请勿把备份(.json)与金蝶账套(.ais)混在一起导入：一次只做一件事' };
  }
  if (jsons.length > 1) {
    return { action: 'error', files: jsons, msg: '一次只能导入一个 .json 备份（多个备份无法合并）' };
  }
  if (jsons.length === 1) return { action: 'overwrite', files: jsons };   // ①
  if (ais.length === 1) return { action: 'new', files: ais };             // ②
  return { action: 'merge', files: ais };                                 // ③
}
