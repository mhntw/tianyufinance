#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
normalize_kingdee_refs.py —— 收敛代码注释中的参考产品溯源表述

背景：开发期间为对齐参考产品（金蝶精斗云·云会计），代码中积累了 350+ 处
「复刻金蝶 / 对标金蝶 / （金蝶：xxx）」注释。这些表述在每处重复溯源，
既冗长又让"这段到底在说什么业务"被淹没。

原则（重要）：
  1. 溯源信息收敛到 README 唯一一处，代码注释只讲业务。
  2. **绝不能删掉硬业务信息**——科目编码（3103/6603/222102 等）、业务规则、
     源码定位坐标，这些删了就找不回来。
  3. **只改注释，绝不改字符串**——字符串里的「金蝶」是给用户看的功能文案
     （如"建议回到金蝶规范后重新导出账套"），改了反而让用户困惑。
  4. 保留 C 类源码定位（开发期导航天天要用）。
  5. 涉及数据格式的「金蝶 .ais」「精斗云」属功能描述，不是溯源，保留。

安全：默认 dry-run（只报告不写文件），加 --apply 才真正写入。
"""

import argparse
import os
import re
import shutil
import sys

# ============================================================
# 第 0 步 PRE：先处理「金蝶 + 保护词」的组合。
# 必须早于 protect，否则「金蝶源码」被换成占位符后，
# 下面这些规则就再也匹配不到了。
# ============================================================
PRE_RULES = [
    (r"，与金蝶源码口径一致", r"，口径与参考实现一致"),
    (r"金蝶\s*KIS", r"__KEEP_KIS__"),            # 金蝶 KIS：另一款产品，属格式/功能名
    (r"对应金蝶精斗云云会计各菜单", r"对应参考产品各菜单"),
    (r"金蝶精斗云", r"参考产品"),
]

# ============================================================
# 保护列表：这些「金蝶」是功能/格式/定位，不是溯源，原样保留
# ============================================================
PROTECT_PATTERNS = [
    (r"金蝶源码", "__KEEP_KDSRC__"),        # 源码阅读导航
    (r"金蝶\s*\.?ais", "__KEEP_AIS__"),     # .ais 账套文件格式
    (r"精斗云", "__KEEP_JDY__"),            # 产品名（数据互通功能）
]

# ============================================================
# D 类：含硬业务信息，删溯源但增强自解释（改后比原来更清楚）
# 必须先于通用规则
# ============================================================
BUSINESS_RULES = [
    (r"（金蝶默认\s*3103）", r"（本年利润科目，默认 3103）"),
    (r"// 与金蝶 decimal 分位精度一致。",
     r"// 金额统一按 decimal 分位精度处理。"),
    (r"（金蝶口径：", r"（口径："),
    (r"，与金蝶源码口径一致", r"，口径与参考实现一致"),
    (r"与金蝶利润表口径一致", r"采用标准利润表口径"),
]

# ============================================================
# A/B 类：纯溯源或溯源+业务复述，去掉溯源留业务
# ============================================================
GENERAL_RULES = [
    # --- 行尾/行内括号中的溯源 ---
    # 注意：含「」时必须把左引号「补回去。早期写成 [「：:]? 会连「一起吃掉，
    # 产生「（单例 popover」」这种引号残缺的注释，故拆成两条分别处理。
    (r"（复刻金蝶[：:]", r"（"),
    (r"（复刻金蝶「", r"（「"),
    (r"（对标金蝶\s*[：:]", r"（"),
    (r"（对标金蝶\s*「", r"（「"),
    (r"（金蝶式[：:]", r"（"),
    (r"（金蝶类\s+", r"（此类 "),
    (r"（金蝶[：:]", r"（"),
    (r"（金蝶默认", r"（默认"),
    (r"（金蝶标准", r"（标准"),
    (r"（金蝶\s+", r"（"),
    (r"，金蝶默认）", r"）"),
    (r"（金蝶", r"（"),

    # --- 注释引导（行首） ---
    (r"//\s*金蝶开关[：:]", r"// 开关："),
    (r"//\s*金蝶[「]", r"// 「"),
    (r"//\s*金蝶[：:]", r"// "),
    (r"//\s*金蝶\s+", r"// "),
    (r"\*\s+对标金蝶\s*「?", r"* 「"),
    (r"\*\s+金蝶[「]", r"* 「"),
    (r"\*\s+金蝶[：:]", r"* "),

    # --- "复刻/对标/对照 + 金蝶" 前缀 ---
    (r"复刻金蝶\s*「", r"「"),
    (r"对标金蝶\s*「", r"「"),
    (r"复刻金蝶[：:]", r""),
    (r"对标金蝶[：:]", r""),
    (r"复刻金蝶", r""),
    (r"对标金蝶", r""),
    (r"（对照金蝶[：:]", r"（对照："),
    (r"（对照金蝶", r"（对照："),
    (r"对照金蝶[：:]", r"对照："),
    (r"字段对照金蝶[：:]", r"字段说明："),

    # --- 「行中」模式（首轮遗漏，二轮补齐）---
    (r"金蝶开关", r"开关"),
    (r"金蝶标准", r"标准"),
    (r"金蝶模板", r"标准模板"),
    (r"金蝶利润表", r"标准利润表"),
    (r"金蝶卡片", r"卡片"),
    (r"金蝶工资凭证模板", r"工资凭证模板"),
    (r"金蝶新增卡片表单", r"新增卡片表单"),
    (r"严格对照金蝶", r"严格对照标准"),
    (r"严格对齐金蝶", r"严格对齐"),
    (r"按金蝶标准", r"按标准"),
    (r"构建金蝶标准", r"构建标准"),
    (r"金蝶以红字", r"以红字"),
    (r"在金蝶以", r"以"),
    (r"含金蝶", r"含"),
    (r"金蝶字段[：:]", r"字段："),
    (r"金蝶为持久化", r"参考实现为持久化"),
    (r"金蝶[「]", r"「"),

    # --- 三轮补充：形如「金蝶风格/金蝶式/金蝶规格」的修饰语 ---
    (r"金蝶风格起止期间选择器", r"起止期间选择器"),
    (r"金蝶风格", r""),
    (r"金蝶式金额位格", r"金额位格"),
    (r"金蝶式", r""),
    (r"金蝶规格[：:]", r"规格："),
    (r"金蝶列结构[：:]", r"列结构："),
    (r"金蝶合计行", r"合计行"),
    (r"金蝶分类\s*Tab", r"分类 Tab"),
    (r"金蝶系统预置", r"系统预置"),
    (r"对齐金蝶布局", r"保持布局一致"),
    (r"贴近金蝶（默认", r"（默认"),
    (r"，金蝶\s*quick-search\s*复刻）", r"，quick-search 组件）"),
    (r"（金蝶\s*quick-search\s*复刻）", r"（quick-search 组件）"),
    (r"金蝶为动态计算", r"为动态计算"),
    (r"金蝶顶栏", r"参考实现顶栏"),
    (r"金蝶首页容器", r"首页容器"),
    (r"金蝶结账页[：:]", r"结账页："),
    (r"金蝶规范下", r"标准规范下"),
    (r"（金蝶\s*range\s*picker\s*对齐）", r"（range picker 对齐）"),

    # --- 二轮补充：文件头、句中残留 ---
    (r"，金蝶复刻\)", r")"),
    (r"金蝶复刻", r"对齐参考实现"),
    (r"：金蝶月份方块", r"：月份方块"),
    (r"与金蝶默认选当期一致", r"默认选当期"),
    (r"（与金蝶默认", r"（默认"),
    (r"与金蝶默认", r"默认"),
    (r"与金蝶一致", r"与参考实现一致"),
    (r"金蝶原则[：:]", r"原则："),
    (r"金蝶口径[：:]", r"口径："),
    (r"（按金蝶截图", r"（按参考截图"),
    (r"金蝶菜单字形图标", r"菜单字形图标"),

    # --- 散落句中 ---
    (r"，金蝶规范", r"，标准规范"),
    (r"回到金蝶规范", r"回到标准规范"),
]

# ============================================================
# 清理：上面规则可能留下空括号、多余空格
# ============================================================
CLEANUP_RULES = [
    (r"（）", r""),
    (r"（\s+", r"（"),
    (r"\s+）", r"）"),
    (r"//\s{3,}", r"// "),
    (r"[ \t]+$", r""),
]


def protect(text):
    for pat, ph in PROTECT_PATTERNS:
        text = re.sub(pat, ph, text)
    return text


def unprotect(text):
    for pat, ph in PROTECT_PATTERNS:
        text = text.replace(ph, pat.replace("\\", "").replace(r"\s*", " ").strip())
    # PRE 阶段的占位符（金蝶 KIS）同样要还原
    text = text.replace("__KEEP_KIS__", "金蝶 KIS")
    return text


def find_comment_start(line, is_html=False):
    """
    返回该行「注释部分」的起始下标；没有注释则返回 -1。
    用状态机正确跳过字符串字面量，避免把 'http://' 或文案里的引号误判为注释。

    JS  处理：行注释 //、JSDoc/块注释行（以 * 或 /* 开头）
    HTML 处理：<!-- ... -->（行内含 <!-- 即视为注释行）
    """
    if is_html:
        # 只处理含 <!-- 的行；title/placeholder 等属性里的文案不受影响
        return line.find("<!--")

    s = line.strip()
    # JSDoc / 块注释行：整行都是注释
    if s.startswith("*") or s.startswith("/*"):
        return 0

    i, n = 0, len(line)
    in_s, in_d, in_t = False, False, False   # 单引号 / 双引号 / 模板串
    while i < n:
        c = line[i]
        if c == "\\" and (in_s or in_d or in_t):
            i += 2
            continue
        if c == "'" and not in_d and not in_t:
            in_s = not in_s
        elif c == '"' and not in_s and not in_t:
            in_d = not in_d
        elif c == "`" and not in_s and not in_d:
            in_t = not in_t
        elif not (in_s or in_d or in_t):
            if c == "/" and i + 1 < n and line[i + 1] == "/":
                return i
            if c == "/" and i + 1 < n and line[i + 1] == "*":
                return i
        i += 1
    return -1


def normalize_line(line, is_html=False):
    """只处理注释部分，字符串/属性内容原样保留"""
    start = find_comment_start(line, is_html)
    if start < 0:
        return line                      # 纯代码行（金蝶只在字符串里）→ 不动
    head, comment = line[:start], line[start:]
    for pat, rep in PRE_RULES:
        comment = re.sub(pat, rep, comment)
    comment = protect(comment)
    for pat, rep in BUSINESS_RULES:
        comment = re.sub(pat, rep, comment)
    for pat, rep in GENERAL_RULES:
        comment = re.sub(pat, rep, comment)
    for pat, rep in CLEANUP_RULES:
        comment = re.sub(pat, rep, comment)
    return head + unprotect(comment)


def normalize(text, is_html=False):
    lines = text.split("\n")
    out = [normalize_line(ln, is_html) for ln in lines]
    return "\n".join(out)


def process_file(path, apply=False):
    is_html = path.endswith(".html")
    with open(path, "r", encoding="utf-8") as f:
        src = f.read()
    out = normalize(src, is_html)
    if src == out:
        return 0, 0
    if apply:
        with open(path, "w", encoding="utf-8") as f:
            f.write(out)
    before = len(re.findall("金蝶", src))
    after = len(re.findall("金蝶", out))
    return before - after, after


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default="js", help="要处理的目录或文件")
    ap.add_argument("--ext", default="js", help="扩展名，逗号分隔，如 js 或 js,html")
    ap.add_argument("--apply", action="store_true", help="真正写入（默认只报告）")
    ap.add_argument("--backup", default=None, help="备份目录（--apply 时建议给）")
    args = ap.parse_args()

    if args.apply and args.backup:
        if os.path.exists(args.backup):
            shutil.rmtree(args.backup)
        os.makedirs(args.backup, exist_ok=True)

    exts = tuple("." + e.strip().lstrip(".") for e in args.ext.split(","))

    if os.path.isfile(args.root):
        files = [args.root]
    else:
        files = []
        for dirpath, dirnames, filenames in os.walk(args.root):
            dirnames[:] = [d for d in dirnames if d not in (".codebuddy", "node_modules")]
            for fn in filenames:
                if fn.endswith(exts):
                    files.append(os.path.join(dirpath, fn))

    total, remain = 0, 0
    changed = []
    for p in sorted(files):
        n, left = process_file(p, apply=args.apply)
        remain += left
        if n:
            changed.append((p, n))
            total += n
            if args.apply and args.backup:
                dst = os.path.join(args.backup, p)
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                shutil.copy2(p, dst)

    mode = "已写入" if args.apply else "试跑（未写入）"
    print(f"[{mode}] 扫描 {len(files)} 个文件，{len(changed)} 个变更，去掉溯源表述 {total} 处")
    print(f"        保留（源码定位/.ais格式/产品名等）{remain} 处")
    for p, n in sorted(changed, key=lambda x: -x[1])[:15]:
        print(f"  {n:>4}  {p}")
    if not args.apply:
        print("\n确认无误后加 --apply 执行（建议同时给 --backup）")


if __name__ == "__main__":
    sys.exit(main())
