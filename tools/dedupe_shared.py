#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
dedupe_shared.py —— 把多份逐字重复的工具函数，收敛为对单点实现的引用

背景：periodRangeValue 在 6 个页面各有一份逐字相同的实现，escHtml 在 3 个页面
各有一份（且与 app.js 的 esc 完全相同）。改一处漏五处，是典型的维护陷阱。

做法：**只替换定义，不改调用点**——把本地函数定义换成 `const xxx = H.xxx;`。
这样改动面最小、回归风险最低，各文件内部的调用处无需任何修改。

重要提醒（踩过的坑）：
  本脚本**不使用正则的贪婪跨行匹配**来定位函数体——JS 里嵌套的 `}` 会让
  `.*?\n\}\n` 提前截断，把后续代码吞掉并造成语法错误。
  这里改用「完整字面量精确匹配」，匹配不到就报错，绝不猜。

安全：默认 dry-run，加 --apply 写入。
"""

import argparse
import sys

# 各文件 periodRangeValue 前的注释不同，统一按「函数本体 + 前置注释行」精确匹配。
# 前置注释用占位标记，匹配时允许任意以 // 开头的连续注释行。
PERIOD_FN = """function periodRangeValue(prefix, def) {
  var sInp = $(prefix + 'Start'), eInp = $(prefix + 'End');
  if (sInp && eInp) {
    sInp.value = sInp.value || def;
    eInp.value = eInp.value || def;
    if (window.__EXTRA_UPDATE_PERIOD_TRIGGER__) window.__EXTRA_UPDATE_PERIOD_TRIGGER__(prefix + 'Start', prefix + 'End');
  }
  return eInp ? eInp.value : def;
}
"""

PERIOD_NEW = """// 起止期间取值：统一走 app.js 的单点实现（H.periodRangeValue）。
// 此前本文件存有一份逐字相同的拷贝，改一处漏五处，故收敛为引用。
// 口径：回填默认期间 + 同步触发器文本，返回结束期间。
const periodRangeValue = H.periodRangeValue;
"""

ESC_OLD = """function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
"""

ESC_NEW = """// HTML 转义：统一走 app.js 的单点实现（H.esc）。
// 此前本文件存有一份逐字相同的拷贝，故收敛为引用。
const escHtml = H.esc;
"""

PERIOD_FILES = [
    "js/pages/report/Report.js",
    "js/pages/salary/Salary.js",
    "js/pages/ledger/Ledger.js",
    "js/pages/cashier/Cashier.js",
    "js/pages/cashier/CashJournal.js",
    "js/pages/cashier/CashierExtra.js",
]

ESC_FILES = [
    "js/pages/ledger/Ledger.js",
    "js/pages/ledger/TrialBalance.js",
    "js/pages/voucher/Voucher.js",
]


def strip_leading_comments_before(lines, idx):
    """返回该函数定义前应一并移除的连续 // 注释行范围（起始下标）"""
    i = idx - 1
    start = idx
    while i >= 0 and lines[i].strip().startswith("//"):
        start = i
        i -= 1
    return start


def replace_period(path, apply):
    with open(path, encoding="utf-8") as f:
        src = f.read()
    if PERIOD_FN not in src:
        return False, "未找到函数本体（可能已处理或内容有差异）"
    lines = src.split("\n")
    # 定位函数定义起始行
    start_idx = None
    for i, ln in enumerate(lines):
        if ln.strip().startswith("function periodRangeValue(prefix, def) {"):
            start_idx = i
            break
    if start_idx is None:
        return False, "定位失败"
    # 函数体行数
    n = PERIOD_FN.rstrip("\n").count("\n") + 1
    end_idx = start_idx + n  # 不含
    # 连同前置注释一起移除
    rm_start = strip_leading_comments_before(lines, start_idx)
    # 若前置注释紧贴上一个代码块（上一行非空且非注释），则不吞掉
    if rm_start < start_idx and rm_start > 0 and lines[rm_start - 1].strip() == "":
        rm_start = start_idx
    new_lines = lines[:rm_start] + PERIOD_NEW.rstrip("\n").split("\n") + lines[end_idx:]
    out = "\n".join(new_lines)
    if apply:
        with open(path, "w", encoding="utf-8") as f:
            f.write(out)
    return True, "ok"


def replace_esc(path, apply):
    with open(path, encoding="utf-8") as f:
        src = f.read()
    if ESC_OLD not in src:
        return False, "未找到函数本体"
    out = src.replace(ESC_OLD, ESC_NEW, 1)
    if apply:
        with open(path, "w", encoding="utf-8") as f:
            f.write(out)
    return True, "ok"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    print("=== periodRangeValue (6 份 → 1) ===")
    for p in PERIOD_FILES:
        ok, msg = replace_period(p, args.apply)
        print(f"  {'✓' if ok else '✗'} {p}  {msg}")

    print("\n=== escHtml (3 份 → 1) ===")
    for p in ESC_FILES:
        ok, msg = replace_esc(p, args.apply)
        print(f"  {'✓' if ok else '✗'} {p}  {msg}")

    print("\n" + ("已写入" if args.apply else "dry-run，加 --apply 执行"))
    print("注意：执行后必须跑语法检查——H 的定义行必须早于引用行")


if __name__ == "__main__":
    sys.exit(main())
