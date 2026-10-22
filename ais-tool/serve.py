#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
极简静态文件服务器（仅依赖 Python 标准库）。

仅用于本地双击「启动.command」调试「金蝶 .ais 账套转换工具」用。
转换器是纯前端（FileReader 读 .ais → 转换 → 浏览器下载），不需要任何后端；
因此这里只托管当前目录的静态资源，不再提供 /api 接口。
（真正的线上部署请用 deploy.sh 推到 CloudBase 静态托管。）
"""
import http.server
import os
import socketserver
import sys


class Handler(http.server.SimpleHTTPRequestHandler):
    # 防止目录穿越：只允许访问当前目录内的文件
    def translate_path(self, path):
        p = super().translate_path(path)
        root = os.path.abspath(os.getcwd())
        ap = os.path.abspath(p)
        if not ap.startswith(root):
            return os.path.join(root, 'index.html')
        return p

    def end_headers(self):
        # 本地调试关闭强缓存，改完刷新即生效
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("[serve] " + (fmt % args) + "\n")


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("", port), Handler) as httpd:
        print("本地调试服务器已启动： http://localhost:%d  （Ctrl+C 退出）" % port)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n已停止。")


if __name__ == '__main__':
    main()
