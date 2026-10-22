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
 * 【分流】（按**文件种类 + 数量**判定，不让用户再选一次"我要哪种导入"）
 *     ① ≥1 个 .ais → **不再由本软件解析**，明确指向独立转换工具（action 'error'）
 *     ② 1 个 .json → **作为新账套导入**                            （action 'new-json'）
 *   ⚠ ② 在 2026-09-28 之前是"覆盖当前账套"——那是历史遗留的例外，已按上述不变量改掉。
 *
 * 【为什么 .ais 被移出（2026-10-22）】金蝶 .ais 解析是一整条独立链路
 *   （mdb-reader 二进制解析 + kis-import 转换，合计约 2.4 万行，占本项目 JS 的一半），
 *   而它只在"建账时用一次"，此后长期只读已导入的数据。现已拆到仓库根的
 *   `ais-tool/`（独立转换页 + 自己的测试），主软件只保留 .json 导入：
 *     · 主软件安装包不再携带这 2.4 万行；
 *     · 用户选到 .ais 时得到的不是"不支持"，而是"用哪个工具、转成什么"——这是他能执行的下一句话。
 *   两侧的契约（转换器产出什么、主软件怎么读）由 tools/verify_import_contract.js 兜住。
 *
 * 【为什么不做"聪明猜测"】判不出就明确报错（多个 .json、选了别的类型）。
 *   不猜：猜错的代价不对称 —— 从前猜成"覆盖"会换掉账本，现在猜成"新建"会多出一本。
 *
 * 【为什么单独放一个文件】它是要被测的判据 —— 放在页面模块里就只能靠加载整个页面来测，
 *   而这里是纯函数，测试可直接加载本文件逐条断言（见 tools/verify_import_entry.js）。
 * ============================================================ */

/**
 * @param {ArrayLike<{name?:string}>} list 用户选中的文件（File 或任何带 name 的对象）
 * @returns {{action:'new-json'|'error', files:Array, msg?:string}}
 *   action：new-json=备份作为新账套导入 / error=不执行（msg 直接提示用户）
 *   files ：该动作要处理的文件（error 时保持原列表，仅供提示用）
 *   ⚠ 任何 action 都**不含"覆盖当前账套"** —— 覆盖请走「查看备份」。
 *   ⚠ 2026-10-22 起不再有 'new-ais' / 'merge-ais'：.ais 一律转 error 并指向 ais-tool/。
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
    return { action: 'error', files: files, msg: '只支持本软件账套备份（.json），请勿选入其它类型文件' };
  }
  /* .ais 不再由本软件解析（2026-10-22 拆至 ais-tool/）。混选也走这条：
     用户手里有 .ais 时，他最需要的下一句话就是"用哪个工具、转成什么"，
     而不是一句干巴巴的"不支持该格式"。 */
  if (ais.length) {
    return {
      action: 'error', files: files,
      msg: '金蝶账套(.ais)需先用独立的「ais-tool 账套转换工具」转成本软件账套(.json)，再在此导入'
    };
  }
  if (jsons.length > 1) {
    return { action: 'error', files: jsons, msg: '一次只能导入一个 .json 账套备份（多份备份无法合并）' };
  }
  if (jsons.length === 1) return { action: 'new-json', files: jsons };    // ② 作为新账套导入
  return { action: 'error', files: files, msg: '未选择可导入的文件' };
}

/**
 * 由「账套名称」拼出 id 片段：**必须净化**，因为 id 会被 Rust 直接当文件名用。
 *
 * 【为什么需要】id 的生成散落在三处（.json 导入 / 单本 .ais / 多年合并），而 Rust 侧
 *   save_book 是 `books_dir().join(format!("{id}.json"))` —— **不净化 id**（只有导出文件名
 *   走 sanitize_filename）。于是名字里的 `/` `\` 会被当成路径分隔符：轻则因父目录不存在
 *   而落盘失败（用户看到"导入成功"、账套却不在列表里），重则写到 books/ 之外（`../`）。
 *   Windows 上 `: * ? " < > |` 同样是非法文件名字符。名字过长还会撑破文件名长度上限，
 *   落盘同样失败 —— 故一并限长。
 *   规则与 js/app.js、js/pages/voucher/Voucher.js 的导出文件名净化**同一条**。
 *
 * 【为什么放这里】它是要被测的纯函数（测试可直接加载本文件断言），见 tools/test_import_e2e.js。
 *
 * @param {any} name 账套名称（或文件名去后缀）
 * @returns {string} 可直接拼进 id 的安全片段（可能为空串，调用方自行兜底默认名）
 */
export function safeIdOf(name) {
  const s = String(name == null ? '' : name).replace(/[\\/:*?"<>|]/g, '_').trim();
  // 按**码点**切，避免把代理对切成半个字符（半个字符进 JSON 会让 invoke 直接失败）
  return Array.from(s).slice(0, 60).join('');
}

/**
 * 把**导入器的原始异常**翻成用户能懂的一句话（纯函数，便于直接断言）。
 *
 * 【背景】2026-09-28 真机发现：选一个不是金蝶账套的 .ais 时，用户看到的是
 *   `系统异常：Error: Wrong page type. Expected 0 but received 110. @ assertPageType (http…`
 *   —— 既看不出"文件选错了"，也看不出下一步该干什么。原始异常来自 mdb-reader，
 *   那是给开发者看的，不是给记账的人看的。
 *
 * 【为什么不干脆吞掉错误】"什么都提示成导入失败"会掩盖真问题；故只翻**能确定**的两类，
 *   其余**原样透出**（导入器自己的报错如"不支持的输入类型"信息量本就足够）。
 *   原文一律附在末尾 —— 用户可复制上报，我们也还能定位。
 *
 * @param {any} e 捕获到的异常（Error 或任何值）
 * @returns {string} 直接可以 showToast 的一整句话
 */
export function importErrText(e) {
  const d = String((e && e.message) || e || '').trim() || '未知错误';
  // ① 选错文件 / 文件损坏：mdb-reader 在页类型断言处失败（英文、含内部常量名）
  if (/Wrong page type|assertPageType|Expected \d+ but received|Invalid page|not a valid/i.test(d)) {
    return '这不是有效的金蝶账套文件（.ais），或文件已损坏；'
      + '请确认导出的是金蝶「账套文件(.ais)」（报表、凭证列表、Excel 都不是账套文件）。技术详情：' + d;
  }
  // ② 解析库没就绪：给出可执行的下一步，而不是把库名（MDBReader）甩给用户
  if (/MDBReader|解析库/.test(d)) return '解析模块未加载，请刷新页面后重试';
  // ③ 其余不猜，原样透出
  return d;
}
