#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
remove_refresh_buttons.py —— 删除无意义的刷新按钮

判断标准（经 code-explorer 全量分析）：
本项目是纯前端单机软件，数据全来自内存 S.state，persist/loadBook 落盘后经
window.__refreshAll() 自动刷新当前页；goPage 切页自动渲染各页。因此绝大多数
「刷新」按钮只是重复调用与切页/自动刷新相同的 renderXxx，点击时数据无变化，属冗余。
仅 3 个带业务计算语义的按钮（btnCgRefresh 核对 / btnBrRefresh 对账 / btnBaRefresh 生成调节表）
予以保留。

安全：每处删除都按「id + 所在行」精确匹配，删除前先 dry-run 报告。
"""

import argparse
import re
import shutil
import sys

# 30 个无意义刷新按钮
USELESS = [
    'btnGlRefresh','btnDlRefresh','btnMlRefresh','btnQgRefresh','btnQdRefresh',
    'btnAxRefresh','btnAbRefresh','btnAcRefresh','btnTbRefresh','btnBsRefresh',
    'btnPlRefresh','btnCfRefresh','btnTxRefresh','btnSumRefresh','btnCjRefresh',
    'btnBsRefresh2','btnIesRefresh','btnRbRefresh','btnSalRefresh','btnSstRefresh',
    'btnSalaryTplRefresh','btnSubjRefresh','btnAssetRefresh','btnDasRefresh',
    'btnDadRefresh','btnAclRefresh','btnAuxRefresh','btnCfOpenRefresh','origRefresh',
    'btnEdRefresh',
]

# 每个按钮在 index.html 的按钮行（用脚本自动定位），删除该行
# 在每个 JS 文件的绑定行，删除该行


def remove_lines_containing(path, ids, dry):
    """删除指定文件中包含任一 id 的整行"""
    with open(path, encoding='utf-8') as f:
        lines = f.readlines()
    out = []
    removed = []
    for ln in lines:
        if any(i in ln for i in ids):
            removed.append(ln.strip())
            continue
        out.append(ln)
    if removed and not dry:
        with open(path, 'w', encoding='utf-8') as f:
            f.writelines(out)
    return removed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true')
    args = ap.parse_args()

    # index.html：删除按钮 DOM
    html_removed = remove_lines_containing('index.html', USELESS, not args.apply)
    print(f'index.html: 删除 {len(html_removed)} 个按钮行')
    for r in html_removed:
        print(f'  - {r.strip()[:80]}')

    # 各 JS：删除绑定行（只删含 id 且含 addEventListener 的行，避免误删变量定义）
    js_files = [
        'js/app.js', 'js/pages/voucher/Voucher.js', 'js/pages/cashier/CashJournal.js',
        'js/pages/cashier/Cashier.js', 'js/pages/cashier/CashierExtra.js',
        'js/pages/asset/Asset.js', 'js/pages/settings/Settings.js',
        'js/pages/salary/Salary.js', 'js/pages/subject/Subject.js',
        'js/pages/original/Original.js', 'js/pages/expense/ExpenseDetail.js',
    ]
    total_js = 0
    for p in js_files:
        try:
            with open(p, encoding='utf-8') as f:
                lines = f.readlines()
        except FileNotFoundError:
            continue
        out = []
        removed = []
        for ln in lines:
            # 只删绑定行：行内含 id + addEventListener
            if any(i in ln for i in USELESS) and 'addEventListener' in ln:
                removed.append(ln.strip())
                continue
            out.append(ln)
        if removed and args.apply:
            with open(p, 'w', encoding='utf-8') as f:
                f.writelines(out)
        total_js += len(removed)
        if removed:
            print(f'{p}: 删除 {len(removed)} 条绑定')
            for r in removed:
                print(f'  - {r.strip()[:80]}')

    print(f'\n合计: index.html {len(html_removed)} 按钮 + JS {total_js} 条绑定')
    if args.apply:
        print('已写入')
    else:
        print('（dry-run，加 --apply 写入）')


if __name__ == '__main__':
    sys.exit(main())
