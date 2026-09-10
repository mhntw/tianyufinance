#!/usr/bin/env python3
"""生成「汉字 → 拼音首字母」映射，输出 js/pinyin-abbr.js（前端本地数据，运行期零依赖）。
    只收录 GB2312 可编码的常用字（6763 个），会计科目名称的用字基本都在其中。
    用法: python3 tools/_gen_pinyin_abbr.py"""
import json, os
import pypinyin

OUT = os.path.join(os.path.dirname(__file__), '..', 'js', 'pinyin-abbr.js')

data = {}
for cp in range(0x4E00, 0xA000):
    ch = chr(cp)
    try:
        ch.encode('gb2312')          # 只在 GB2312 常用字范围内
    except UnicodeEncodeError:
        continue
    p = pypinyin.lazy_pinyin(ch)[0]  # 多音字取常见读音，会计科目几乎不踩
    if p and p[0].isascii() and p[0].isalpha():
        data[ch] = p[0].lower()

# 特殊常用但 gb2312 之外的极少；补充个别：数字/零忽略。
body = json.dumps(data, ensure_ascii=False, separators=(',', ':'))
with open(OUT, 'w', encoding='utf-8') as f:
    f.write('// 自动生成：汉字 → 拼音首字母（GB2312 常用字）。改动请运行 tools/_gen_pinyin_abbr.py\n')
    f.write('(function (g) { g.__PINYIN_ABBR__ = ')
    f.write(body)
    f.write('; })(typeof globalThis !== "undefined" ? globalThis : this);\n')

print('生成完成:', OUT, '汉字数 =', len(data), '文件大小 =', os.path.getsize(OUT), 'B')
