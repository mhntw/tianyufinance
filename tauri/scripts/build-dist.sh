#!/bin/sh
# ============================================================
# build-dist.sh —— 打包前把最新运行时前端同步到干净的 dist/ 打包源
#
# 目的：
#   Tauri 的 frontendDist 必须指向一个"只含 web 资源"的目录（否则会把
#   src-tauri/target、node_modules 等当成前端资源而拒绝打包）。
#   本脚本在每次 `tauri build` 前，把 rj/ 里的运行时文件同步进 dist/，
#   排除开发/备份/IDE 残留，保证打包永远是最新的纯净源。
#
# 你平时只改 rj/ 源目录（index.html、css/、js/），dist/ 无需手动维护。
# ============================================================

set -e

# 脚本位于 tauri/scripts/。frontendDist "../dist" 相对 tauri/ 解析，因此 dist 放 tauri/dist。
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TAURI_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RJ_ROOT="$(cd "$TAURI_DIR/.." && pwd)"
DIST_DIR="$TAURI_DIR/dist"

echo "[build-dist] 同步前端到 $DIST_DIR"

# 1. 重建干净的 dist（删除旧内容，避免残留文件进包）
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR/css" "$DIST_DIR/js"

# 2. 拷贝运行时文件（仅 index.html + css + js）
cp "$RJ_ROOT/index.html" "$DIST_DIR/index.html"
cp "$RJ_ROOT/css/style.css" "$DIST_DIR/css/style.css"
cp -R "$RJ_ROOT/js/." "$DIST_DIR/js/"

# 3. 清理 IDE 残留（.codebuddy / .workbuddy 等不应进包）
find "$DIST_DIR" -type d \( -name ".codebuddy" -o -name ".workbuddy" \) -exec rm -rf {} + 2>/dev/null || true

echo "[build-dist] 完成：$(find "$DIST_DIR" -type f | wc -l | tr -d ' ') 个文件已同步"
