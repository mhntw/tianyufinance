/* ============================================================
 * 备份列表的分类判据（纯函数、零 DOM、零依赖）
 *
 * 【背景：两种备份，意义完全不同，界面此前不分】
 *   backups/ 目录里混着两类产物（Rust 侧就是两个不同的环）：
 *     · 自动存档    <bookId>_<ts>.json            每次改动落盘 / 关窗 / 高风险操作前自动留（最近 10 份环）
 *     · 覆盖前存档  <bookId>_pre_restore_<ts>.json **导入 / 恢复之前**自动留（最近 3 份环）
 *   前者对用户的意义是"某个时刻账本的样子"；后者是"我上次做危险操作之前的样子"。
 *   而恢复前的确认框与恢复后的提示都明确写着「如需撤销，可恢复『覆盖前存档』」——
 *   可列表此前一律显示「备份 · 时间」，用户**认不出是哪一条**：
 *   系统让用户去做一件事，界面却不让他做到。本模块就是补上这条闭环的判据。
 *
 * 【与 Rust 侧同一规则，但**不依赖 bookId**】tauri/src-tauri/src/lib.rs 的 backup_kind_of 用
 *   「先判 pre 再判 auto」（因为 pre 名同样以 `<bookId>_` 开头，顺序反了会被误归为自动存档）。
 *   这里保持同样的**顺序**，但判定只认 `_pre_restore_<ts>.json` 这个后缀特征，不要求调用方传 bookId：
 *     · 列表本来就已经由 Rust 按本账套过滤（list_backups(bid) 只返回 `<bid>_` 开头的文件）——
 *       再要求一次 bookId 属重复防护，且一旦 bookId 为空（浏览器/开发态、指针尚未落盘）就会**全部退化**成
 *       "自动存档"，覆盖前存档那一行随即失去标记（实测踩过：折叠时只剩 1 行、提示"还有 3 份"）。
 *     · 少一个参数、少一条失效路径 —— 判据越简单越稳。
 *   （代价：若某个账套名恰好含 `_pre_restore_数字.json` 结尾 —— 几乎不可能 —— 其普通备份会被标错标签，
 *     后果仅是标签不符，不影响任何数据。）
 * ============================================================ */

/**
 * 判定一个备份文件名属于哪一类。
 * @param {string} fileName 形如 "default_1724xxx.json" / "default_pre_restore_1724xxx.json"
 * @returns {'auto'|'pre'|null}  null = 不是 .json（调用方按"未知"处理）
 */
export function backupKindOf(fileName) {
  const name = String(fileName == null ? '' : fileName);
  if (!/\.json$/.test(name)) return null;
  if (/_pre_restore_\d+\.json$/.test(name)) return 'pre';   // ⚠ 必须先判 pre（见文件头说明）
  return 'auto';
}

/**
 * 生成列表显示用文案。**必须**含「覆盖前存档」四字 ——
 * 因为确认框 / 恢复后的提示就是用这个词指路的，两处措辞不一致等于没指。
 */
export function backupLabelOf(kind, timeText) {
  const t = String(timeText == null ? '' : timeText);
  return (kind === 'pre' ? '覆盖前存档 · ' : '自动存档 · ') + t;
}

/**
 * 折叠状态下显示哪些行：**最新一份 + 全部「覆盖前存档」**。
 * 理由：覆盖前存档很少（3 份环），而它恰恰是"撤销上一次导入 / 恢复"要用的那一条；
 * 若被折叠规则藏起来，「可恢复『覆盖前存档』」这句提示就又落空了。
 */
export function pickVisibleBackups(list, showAll) {
  const arr = list || [];
  if (showAll) return arr.slice();
  return arr.filter(function (b, i) { return i === 0 || (b && b.kind === 'pre'); });
}
