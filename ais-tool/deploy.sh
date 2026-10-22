#!/usr/bin/env bash
# 一键部署「金蝶 .ais 账套转换工具」到 CloudBase 静态托管（Mac / Linux）
# 用法：cd ais-tool && bash deploy.sh
#
# 本目录（ais-tool）既是转换器的【唯一真源】，也是它的部署根：
#   · index.html / convert.js / js/ 是纯前端转换器（可 file:// 双击直接用）；
#   · 本脚本把整个目录暂存到临时副本、补 ?v= 缓存戳后再上传，【不修改】目录内的源文件
#     （所以源 index.html 保持无 ?v=，file:// 双击仍可用）。
#
# 首次使用请先完成两件事：
#   1) 安装 CLI：npm install -g @cloudbase/cli
#   2) 登录授权：tcb login   （会弹出浏览器/设备码，按提示操作一次即可，之后长期有效）
# 之后每次更新转换器，直接 bash deploy.sh 即可。
set -e

ENV_ID="${CLOUD_ENV:-cloud1-d6gy9gmgva37f14b8}"
HERE="$(cd "$(dirname "$0")" && pwd)"   # ais-tool 自身

# 暂存（避免污染真源；部署失败也绝不留下半成品到真源目录）
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/ais-tool-stage.XXXXXX")"
cp -R "$HERE/." "$STAGE/"

# ==================== 数据安全声明（财务数据不受部署影响）====================
# 本脚本只部署【前端转换工具】到静态托管，完全不触碰财务数据：
#   · 转换器纯前端运行，.ais 只在用户浏览器内存里解析，结果经浏览器下载，不上传任何服务器；
#   · 静态托管仅 index.html / js / convert.js 代码（.gitignore 已把 tools/、*.md、
#     .codebuddy/ 等本地专用文件排除在上传之外）；
#   · CloudBase 云数据库（如有）与本工具无关，本脚本不读写。
# 随后的清理步骤 built-in fail-safe：待删文件若带任何数据/备份特征将直接中止，绝不删除。
# ==========================================================================

echo "==> 部署金蝶 .ais 账套转换工具到 CloudBase 静态托管（仅前端，不接触任何财务数据）"
echo "    环境: $ENV_ID"
echo "    真源: $HERE"
echo "    暂存: $STAGE"

# 统一静态资源版本号（时间戳），使 CDN/浏览器一年强缓存失效。
# CloudBase 静态托管对 js/css 下发 max-age=31536000（一年强缓存），且 CDN 按
# 【完整 URL 含 query】做缓存键 —— 任何「漏写 ?v=」的引用都会被钉死在旧版本上。
# 详见 tools/bump_asset_versions.py 顶部注释（含 2026-09-28 实测证据）。
TS=$(date +%Y%m%d%H%M%S)
echo "    资源版本: v$TS"
python3 "$STAGE/tools/bump_asset_versions.py" "$TS" "$STAGE"

# 用 .gitignore 自动排除本地专用文件（tools/、*.md、.codebuddy/ 等不上传）
tcb hosting deploy "$STAGE" / -e "$ENV_ID" --enable-git-ignore

# 全覆盖部署：上传后清理云端旧的云应用残留（app.js / pages/ 等），只留转换器。
# 受保护的 __auth/ cloud-admin/（CloudBase 身份认证基础设施）会自动跳过，不会误删。
echo ""
echo "==> 清理云端旧版本残留（旧云应用文件会被移除，转换器不受影响）..."
python3 "$STAGE/tools/cleanup_hosting.py" "$ENV_ID"

rm -rf "$STAGE"
echo ""
echo "✅ 部署完成。"
echo "   访问地址：CloudBase 控制台 → 环境 → 静态网站托管 → 基础配置 → 域名"
