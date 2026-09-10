#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
remove_dead_code.py —— 删除全项目确认无调用的死代码

重要：本项目存在多处「同名不同物」的函数（如 setEl 在 app.js 与 Home.js 各有一份，
monthsBetween 在 store.js / _shared.js / app.js 各有一份）。因此删除必须按
「文件 + 完整函数文本」精确匹配，绝不能按函数名全局替换。

每项删除前均已人工核对：grep 全项目引用数 == 1（仅定义处），且未挂到
globalThis / __TY_HELPERS__ / 路由表。

安全：默认 dry-run，加 --apply 写入。
"""

import argparse
import sys

# (文件, 待删除的完整文本片段, 说明)
ITEMS = [
    # ---------------- app.js ----------------
    ("js/app.js",
     "  function setEl(id, val) { var el = $(id); if (el) el.textContent = val; }\n",
     "app.js 的 setEl 无人调用（Home.js 另有一份同名实现，那份在用）"),

    ("js/app.js",
     "  function closeAllNavGroups() {\n    hideNavPopover();\n  }\n",
     "closeAllNavGroups 零调用，各处直接调 hideNavPopover()"),

    ("js/app.js",
     "  /* ---------- 导入金蝶 KIS 账套 (.ais) ---------- */\n"
     "  // 由设置菜单「导入金蝶账套」子项触发（原 topbar 按钮已移入设置菜单）\n"
     "  function triggerImportAis() {\n"
     "    var file = $('aisFile');\n"
     "    if (file) file.click();\n"
     "  }\n",
     "triggerImportAis 零调用（设置菜单走 goPage，不经过本函数）"),

    ("js/app.js",
     "  // monthsBetween 被 report 尾巴与资产域共用，保留为全局工具（不随区块迁出）\n"
     "  function monthsBetween(start, end) {\n"
     "    if (!start || !end) return 0;\n"
     "    var a = start.split('-'), b = end.split('-');\n"
     "    var y1 = +a[0], m1 = +a[1], y2 = +b[0], m2 = +b[1];\n"
     "    return Math.max(0, (y2 - y1) * 12 + (m2 - m1));\n"
     "  }\n",
     "app.js 的 monthsBetween 零调用（实际用 store.js 的 U.monthsBetween 与 _shared.js 的版本）"),

    # ---------------- store.js ----------------
    ("js/store.js",
     "  function curBookId() {\n"
     "    try { return localStorage.getItem('kis_cur') || ''; } catch (e) { return ''; }\n"
     "  }\n",
     "curBookId 零调用（setCurBookId 仍在用，保留）"),

    ("js/store.js",
     "  function allMonths() {\n"
     "    var startRaw = self.state.company && self.state.company.startMonth ? self.state.company.startMonth : '2026-01';\n"
     "    // 规范化：空账套常见 '202600'（月份00），回退到同年01月，避免生成非法月 '2026-00'\n"
     "    var sp = startRaw.split('-');\n"
     "    var sy = +sp[0] || 2026, sm = +sp[1];\n"
     "    if (!sm || sm < 1 || sm > 12) sm = 1;\n"
     "    var start = sy + '-' + ('0' + sm).slice(-2);\n"
     "    var cur = (function () { var d = new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1); })();\n"
     "    var end = self.period && self.period > cur ? self.period : cur;\n"
     "    if (end < start) end = start; // 防御：当前期早于启用期\n"
     "    var list = [];\n"
     "    var y = +start.split('-')[0], m = +start.split('-')[1];\n"
     "    var ey = +end.split('-')[0], em = +end.split('-')[1];\n"
     "    while (y < ey || (y === ey && m <= em)) {\n"
     "      list.push(y + '-' + pad2(m));\n"
     "      if (m === 12) { y++; m = 1; } else { m++; }\n"
     "    }\n"
     "    return list;\n"
     "  }\n",
     "模块级 allMonths 零调用（S.allMonths 是另一份在用实现）"),

    # ---------------- store.js: S.xxx 死方法 ----------------
    ("js/store.js",
     "    _checkServerStatus: function () {\n"
     "      var self = this;\n"
     "      var ok = (typeof window.Storage !== 'undefined') && window.Storage.isFileMode();\n"
     "      self._setServerStatus(ok);\n"
     "    },\n",
     "S._checkServerStatus 零调用"),

    ("js/store.js",
     "    // 判断当前账套是否\"无业务数据\"（无任何凭证即视为空账/新账）\n"
     "    _isEmptyBook: function () {\n"
     "      var st = this.state;\n"
     "      return !st || !st.vouchers || !st.vouchers.length;\n"
     "    },\n",
     "S._isEmptyBook 零调用"),

    ("js/store.js",
     "    // 取指定账套的完整 state（以磁盘真实文件为准，不再依赖 localStorage 缓存容器）。\n"
     "    getBookState: function (id) {\n"
     "      if (id === this.bookId && this.state) return this.state;\n"
     "      // 非当前账套：从磁盘读取权威数据（同步接口不可用，调用方应改用 loadBook 异步）。\n"
     "      // 此处返回 null 以明确标识「内存无缓存」，迫使调用方走磁盘（符合磁盘为真设计）。\n"
     "      return null;\n"
     "    },\n",
     "S.getBookState 零调用"),

    ("js/store.js",
     "    reset: function () {\n"
     "      this.state = emptyState();\n"
     "      this.persist();\n"
     "    },\n",
     "S.reset 零调用"),

    ("js/store.js",
     "    voucherStatusText: function (st) {\n"
     "      return st === 'reviewed' ? '已复核' : st === 'audited' ? '已审核' : '待审核';\n"
     "    },\n",
     "S.voucherStatusText 零调用"),

    ("js/store.js",
     "    deprSummary: function (month) {\n"
     "      var self = this;\n"
     "      return this.state.fixedAssets.map(function (fa) {\n"
     "        return {\n"
     "          fa: fa,\n"
     "          monthly: self.assetMonthlyDepr(fa),\n"
     "          accum: num(fa.accumDepr)\n"
     "        };\n"
     "      });\n"
     "    },\n",
     "S.deprSummary 零调用（折旧汇总表由 Asset.js 自己算）"),

    ("js/store.js",
     "    accountsOfSubject: function (subjectCode) {\n"
     "      return (this.state.bankAccounts || []).filter(function (a) { return a.subjectCode === String(subjectCode); });\n"
     "    },\n",
     "S.accountsOfSubject 零调用"),

    ("js/store.js",
     "    exportBackup: function () {\n"
     "      // 导出现有账套的全部数据为 JSON 字符串（纯只读：不写备份记录、不触发持久化）\n"
     "      return JSON.stringify(this.state);\n"
     "    },\n",
     "S.exportBackup 零调用（导出走 Settings.js 的 XLSX）"),

    # ---------------- 页面死代码 ----------------
    ("js/pages/report/Report.js",
     "function emptyRptCells(n) {\n"
     "  var s = '';\n"
     "  for (var i = 0; i < n; i++) s += '<td></td>';\n"
     "  return s;\n"
     "}\n",
     "emptyRptCells 零调用"),

    ("js/main.js",
     "globalThis.__CASHEXTRA__ = { refreshAccountList: refreshAccountList, refreshIes: refreshIes, refreshCheckGeneral: refreshCheckGeneral, bindCashierExtraEvents: bindCashierExtraEvents };\n",
     "__CASHEXTRA__ 在 main.js 与 CashierExtra.js 各注册一次，全项目无读取点"),
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    removed, missing = 0, []
    for path, frag, note in ITEMS:
        try:
            with open(path, "r", encoding="utf-8") as f:
                src = f.read()
        except FileNotFoundError:
            missing.append((path, "文件不存在"))
            continue
        if frag not in src:
            missing.append((path, note[:40]))
            continue
        removed += 1
        if args.apply:
            with open(path, "w", encoding="utf-8") as f:
                f.write(src.replace(frag, "", 1))
        print(f"  [{'删除' if args.apply else '待删'}] {path}: {note}")

    print(f"\n合计 {removed} 项" + ("已删除" if args.apply else "（待删除，加 --apply 执行）"))
    if missing:
        print("\n未匹配（需人工确认，可能已被前序改动影响）:")
        for p, n in missing:
            print(f"  - {p}: {n}")
    if not args.apply:
        print("\n注意：删除后必须跑语法检查与页面自检")


if __name__ == "__main__":
    sys.exit(main())
