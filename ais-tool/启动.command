#!/bin/bash
# 双击此文件即可启动财务软件（自动避开被占用的端口）
cd "$(dirname "$0")"
PYTHON=$(command -v python3 || echo /usr/bin/python3)
PORT_FILE=".server_port"
rm -f "$PORT_FILE"
echo "正在启动财务软件..."
$PYTHON serve.py &
SERVER_PID=$!

# 等待服务器写出端口文件（最多 10 秒）
for i in $(seq 1 20); do
  if [ -f "$PORT_FILE" ]; then break; fi
  sleep 0.5
done

PORT=$(cat "$PORT_FILE" 2>/dev/null || echo 8000)

# 自动打开浏览器
open "http://localhost:${PORT}"

echo "浏览器已打开，地址：http://localhost:${PORT}"
echo "按 Ctrl+C 停止（关闭终端窗口也会停止服务器）"
wait $SERVER_PID
