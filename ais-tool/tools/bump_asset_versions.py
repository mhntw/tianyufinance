#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
静态资源版本号统一工具（部署前调用，deploy.sh / deploy.bat 共用）。

为什么必须有这一步：
  CloudBase 静态托管的 CDN 按【完整 URL（含 query string）】做缓存键，
  且对 js / css 下发 Cache-Control: max-age=31536000（一年强缓存）。于是：
    · 同一路径只要被访问过一次，就被 CDN 钉住一年；
    · 只有 URL 变化（?v= 变新）才会回源取新内容。

2026-09-28 实测证据：
  GET /js/pages/report/_shared.js            → 9-18 的旧文件（x-cache: Hit, age 141521s）
  GET /js/pages/report/_shared.js?v=<新戳>   → 新文件
  旧版只导出 fmt，新版 ExpenseDetail.js 要导入 absFmt → 具名导入缺失，
  ESM 链接期报错 → 整张模块图不执行 → 所有菜单页面只剩静态表头、内容空白。

所以「import 漏写 ?v=」等同于「该模块永远停留在旧版本」，必须统一补齐。

本工具做两件事（幂等，可反复执行）：
  1. index.html：所有本地 js / css / svg / png 引用统一改写/补齐 ?v=<version>
  2. js/**.js（跳过第三方大 bundle）：把已有 ?v= 改写为新值，并给漏写 ?v= 的
     相对模块引用补上：
       import ... from './x.js'  /  import { a } from '../y.js'
       import('./x.js')          /  import './x.js'
       loadScript('js/x.js')     （kis-import.js 按需加载 buffer/mdb-reader）

用法：
    python3 tools/bump_asset_versions.py <version> [项目根目录]
    # 例：python3 tools/bump_asset_versions.py 20260928125508 .
"""
import os
import re
import sys

# 第三方 bundle：体积大（合计 ~4MB），内部字符串不是我们的模块引用，不要动
SKIP_JS = {'xlsx.full.min.js', 'cloudbase.full.js', 'mdb-reader.js', 'buffer.js'}

# index.html 里的本地引用：js/ 或 css/ 子路径，也含根级本地文件（如 convert.js）；
# (?!\w+:) 排除 http:// / https:// 等绝对地址，避免给 CDN 资源错加 ?v=。
# 2026-10-22 扩展：原正则只认 js/|css/ 前缀，导致 ais-tool 的 <script src="convert.js">
# （根级引用）漏加 ?v= —— CloudBase 一年强缓存会把首页主脚本钉死在旧版（同 9-28 线上事故根因）。
HTML_ASSET = re.compile(r'((?:src|href)="(?!\w+:)(?:js/|css/)?[^"?]*\.(?:js|css|svg|png))(")')

# 改写【已有】?v= 时必须限定在「引号包裹的资源路径」内，且版本号只允许 token 字符集。
# 教训（2026-09-28 线上事故）：旧 deploy.sh 用的是 `s|\?v=[^'\"]*|?v=$TS|g` ——
# `[^'\"]*` 贪婪且能跨越任意代码，在压缩过的 cloudbase.full.js 里命中
#   `c>v+16384?v="overflow"`   （三元表达式给 v 赋字符串）
# 后被改写成 `c>v+16384?v=20260928125508"overflow"`，直接吞掉代码 → SyntaxError: Unexpected string
# → cloudbase 全局不存在 → 登录彻底不可用。这里用「引号内 + 资源扩展名 + 受限字符集」三重约束杜绝复发。
HTML_V = re.compile(r'((?:src|href)="[^"]*?[?&]v=)[0-9A-Za-z._-]*(")')
JS_V = re.compile(r"(['\"])([^'\"]*?\.(?:js|css|svg|png)\?v=)[0-9A-Za-z._-]*\1")

# js 里的模块引用；`(?:^|[^{])` 是为了避开 mdb-reader.js 注释里的
# JSDoc 类型写法 `@param {import('./Expression.js').default}`（不是真实引用）
SPEC = re.compile(
    r"((?:from|loadScript\s*\(|(?:^|[^{])import\s*\(?)\s*['\"])"
    r"((?:\.{1,2}/|js/)[^'\"?]*\.js)"
    r"(['\"])",
    re.M,
)


def bump_html(path, ts):
    with open(path, encoding='utf-8') as f:
        s = f.read()
    orig = s
    s, n1 = HTML_V.subn(lambda m: m.group(1) + ts + m.group(2), s)
    s, n2 = re.subn(HTML_ASSET, lambda m: m.group(1) + '?v=' + ts + m.group(2), s)
    if s != orig:
        with open(path, 'w', encoding='utf-8') as f:
            f.write(s)
    return n1, n2


def bump_js(path, ts):
    with open(path, encoding='utf-8') as f:
        s = f.read()
    orig = s
    s, n1 = JS_V.subn(lambda m: m.group(1) + m.group(2) + ts + m.group(1), s)
    s, n2 = re.subn(SPEC, lambda m: m.group(1) + m.group(2) + '?v=' + ts + m.group(3), s)
    if s != orig:
        with open(path, 'w', encoding='utf-8') as f:
            f.write(s)
    return n1, n2


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    ts = sys.argv[1]
    root = os.path.abspath(sys.argv[2] if len(sys.argv) > 2 else '.')

    idx = os.path.join(root, 'index.html')
    if not os.path.isfile(idx):
        print('❌ 找不到 index.html：%s' % idx)
        return 1
    h1, h2 = bump_html(idx, ts)
    print('    index.html：改写 %d 处、补齐 %d 处' % (h1, h2))

    files = 0
    j1 = j2 = 0
    for dp, _, fns in os.walk(os.path.join(root, 'js')):
        for fn in fns:
            if not fn.endswith('.js') or fn in SKIP_JS:
                continue
            a, b = bump_js(os.path.join(dp, fn), ts)
            if a or b:
                files += 1
            j1 += a
            j2 += b
    print('    js/：%d 个文件改写 %d 处、补齐 %d 处裸引用（已跳过 %d 个第三方 bundle）'
          % (files, j1, j2, len(SKIP_JS)))
    return 0


if __name__ == '__main__':
    sys.exit(main())