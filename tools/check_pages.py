#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
tools/check_pages.py — ESM 页面「裸引用」静态体检（防回归）

背景：本仓库的 ESM 页面（js/pages/**）统一从 globalThis.__TY_HELPERS__ /
      __TY_EXPORT__ 取全局依赖。若某页面「使用了某符号却既未本地定义、
      又未 import、又不以 H./EX./S./U./window./globalThis./store. 形式命名访问」，
      则该符号会在 ESM 模块作用域里抛 ReferenceError（如 Home.js/Cashier.js 曾发生
      “currentPeriod is not defined”）。

本脚本扫描 js/pages 下所有 .js，报告上述「真隐患」，供迁移/修改后自查，防止同类 bug 回归。

用法：
    python3 tools/check_pages.py          # 扫描并报告，有隐患时退出码 1
    python3 tools/check_pages.py -q       # 仅打印汇总（OK / 发现 N 处隐患）
"""
import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / 'js' / 'pages'

# 桥接层 helper（app.js __TY_HELPERS__ 直挂或经 U(util) 提供）
BRIDGE = re.compile(r'\b(__TY_HELPERS__|H|EX|S|U|window|globalThis|store)\s*\.\s*([A-Za-z_$][\w$]*)')

# 需要检查的「候选符号」：要么是桥接 helper，要么是 store 单例常用方法
CANDIDATES = {
    '$', 'money', 'fmt', 'esc', 'round2', 'showToast', 'currentPeriod',
    'lastClosedPeriod', 'goPage', 'monthOf', 'safeFillPeriod', 'nowTimeStr',
    'syncAll', 'bookKey', 'voucherBalance', 'periodVouchers', 'generalLedger',
    'detailLedger', 'openingOf', 'lastVoucherMonth', 'cashAccounts',
    'refreshCurrentReport', 'fmtDate', 'pad2', 'todayStr', 'formatPeriod',
    'fillPeriodSelect', 'allMonths', 'num', 'setEl', 'openModal', 'closeModal',
    'signed', 'U', 'S', 'moneyRed',
}

# 常见浏览器/语言内建，忽略
BUILTIN = {
    'Object', 'Array', 'String', 'Number', 'Date', 'Math', 'Regexp', 'RegExp',
    'JSON', 'console', 'window', 'document', 'globalThis', 'parseFloat',
    'parseInt', 'isNaN', 'setTimeout', 'clearTimeout', 'setInterval',
    'clearInterval', 'confirm', 'prompt', 'alert', 'fetch', 'location',
    'navigator', 'localStorage', 'sessionStorage', 'URL', 'Blob', 'File',
    'FileReader', 'encodeURIComponent', 'decodeURIComponent', 'Infinity',
    'undefined', 'NaN', 'Error', 'TypeError', 'Promise',
}


def local_names(text):
    names = set()
    names |= set(re.findall(r'\bfunction\s+([A-Za-z_$][\w$]*)\s*\(', text))
    names |= set(re.findall(r'\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=', text))
    names |= set(re.findall(r'export\s+(?:function|const)\s+([A-Za-z_$][\w$]*)', text))
    # 具名 import: import { a, b } from ...
    for block in re.findall(r'import\s*\{([^}]*)\}\s*from', text):
        for item in block.split(','):
            name = item.split(' as ')[-1].strip()
            if name:
                names.add(name)
    # import default: import Name from ...
    names |= set(re.findall(r'import\s+([A-Za-z_$][\w$]*)\s*from', text))
    # 命名空间 import: import * as Name
    names |= set(re.findall(r'import\s*\*\s*as\s+([A-Za-z_$][\w$]*)', text))
    # 函数/方法参数名（function a(x, y) 及箭头 (x, y) =>）
    for body in re.findall(r'\bfunction\s+\w*\s*\(([^)]*)\)', text) + re.findall(r'\(([^)]*)\)\s*=>', text):
        for arg in body.split(','):
            arg = arg.strip()
            if arg and re.match(r'^[A-Za-z_$][\w$]*$', arg):
                names.add(arg)
    return names


def default_used(name):
    """返回该符号默认定义（H.helper / U.util / S.method 等），供诊断提示用。"""
    if name in ('$',): return 'H.$'
    if name in ('money', 'esc', 'fmt', 'round2', 'showToast', 'currentPeriod',
                'lastClosedPeriod', 'goPage', 'safeFillPeriod', 'syncAll',
                'bookKey', 'fillPeriodSelect', 'openModal', 'closeModal',
                'signed', 'nowTimeStr', 'formatPeriod', 'allMonths', 'moneyRed'):
        return 'H.' + name
    if name in ('S',): return 'H.S || EX.store'
    if name in ('U',): return 'H.U || EX.util'
    if name in ('monthOf', 'fmtDate', 'num', 'pad2', 'todayStr'):
        return 'U.' + name
    if name in ('voucherBalance', 'periodVouchers', 'generalLedger', 'detailLedger',
                'openingOf', 'lastVoucherMonth', 'cashAccounts', 'allMonths'):
        return 'S.' + name
    return name


def strip_comments_and_strings(text):
    """移除 // 注释、/* */ 注释、以及引号字符串（按原长度用空格填充，避免
    字符串内部的单词仍被边界正则误判为裸引用），使后续扫描更接近真实代码。"""
    out = []
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        nxt = text[i + 1] if i + 1 < n else ''
        # 行注释
        if ch == '/' and nxt == '/':
            j = text.find('\n', i)
            i = j if j != -1 else n
            continue
        # 块注释
        if ch == '/' and nxt == '*':
            j = text.find('*/', i + 2)
            i = (j + 2) if j != -1 else n
            continue
        # 引号字符串（含模板串）：按原长度用空格填充
        if ch in ('"', "'", '`'):
            q = ch
            start = i
            i += 1
            while i < n:
                if text[i] == '\\':
                    i += 2
                    continue
                if text[i] == q:
                    i += 1
                    break
                i += 1
            out.append(' ' * (i - start))
            continue
        out.append(ch)
        i += 1
    return ''.join(out)


def analyze(path):
    text = path.read_text(encoding='utf-8')
    code = strip_comments_and_strings(text)
    local = local_names(code)
    named = {m.group(2) for m in BRIDGE.finditer(code)}
    issues = []
    for c in CANDIDATES:
        if c in local or c in BUILTIN:
            continue
        # 裸引用：前一个字符不能是词字符/点/美元/连字符(排除 CSS 类名 -num 等拼接词)
        bare = len(re.findall(r'(?<![\w.$\-])' + re.escape(c) + r'(?!\w)', code))
        if bare == 0:
            continue
        # 统计命名访问次数（作为 H.x / U.x / S.x 出现的部分不算裸引用）
        named_count = sum(1 for _, n in BRIDGE.findall(code) if n == c)
        real = bare - named_count
        if real > 0:
            issues.append((c, real, default_used(c)))
    return issues


def main(argv=None):
    ap = argparse.ArgumentParser(description='ESM 页面裸引用静态体检')
    ap.add_argument('-q', '--quiet', action='store_true', help='仅输出汇总')
    args = ap.parse_args(argv)

    total = 0
    bad = []
    for path in sorted(ROOT.rglob('*.js')):
        issues = analyze(path)
        if issues:
            total += len(issues)
            bad.append((path, issues))
            if not args.quiet:
                print('### ' + str(path.relative_to(ROOT.parent.parent)))
                for c, real, defn in issues:
                    print('    符号 %-18s 裸引用x%-3d  ->  应经 %s 取' % (c, real, defn))
    if bad:
        print('\n发现 %d 处潜在裸引用（ReferenceError 风险），请为每个符号补桥接/import。' % total)
        return 1
    print('OK：js/pages 全部页面自足，无裸引用隐患。' if args.quiet or True else 'OK')
    return 0


if __name__ == '__main__':
    sys.exit(main())
