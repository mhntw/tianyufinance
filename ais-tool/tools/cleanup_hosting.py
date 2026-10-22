#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
清理 CloudBase 静态托管中的【旧版本残留文件】（全覆盖部署的核心步骤）。

背景：
  tcb hosting deploy 同名文件默认覆盖，但【不会删除远端有、本地已不存在的文件】，
  旧版本会一直堆积在云端浪费空间（本项目实测残留 xzys/ 目录 37 个文件 / 3.85MB）。

原理：
  1) tcb hosting list --json 列出云端全部文件
  2) 生成本地即将部署的文件清单（按 .gitignore 规则过滤，与 deploy.sh --enable-git-ignore 一致）
  3) 差集 = 云端有 & 本地没有，且不在【受保护目录】内 → 删除
     · 受保护目录(__auth/ cloud-admin/) 是 CloudBase 身份认证基础设施，删了登录会坏，严禁触碰
     · 若差集恰好覆盖某一顶层目录的全部文件（如整目录 xzys/），用 delete --dir 一次删净，更快

用法：
  python3 tools/cleanup_hosting.py <envId> [--dry-run]
  # --dry-run 只预览将删除哪些文件，不实际删除（建议首次使用先预览）
"""
import fnmatch
import json
import os
import subprocess
import sys

LOCAL_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GITIGNORE = os.path.join(LOCAL_DIR, '.gitignore')
PROTECTED = ('__auth/', 'cloud-admin/')   # CloudBase 认证基础设施，禁止删除


def load_gitignore():
    """读取 .gitignore 规则（忽略注释与空行）。"""
    rules = []
    if os.path.exists(GITIGNORE):
        with open(GITIGNORE, encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#'):
                    rules.append(line)
    return rules


def is_ignored(rel, rules):
    """判断相对路径是否被 .gitignore 忽略（支持通配 * 与目录结尾 /）。"""
    parts = rel.split('/')
    # 逐级前缀：先判目录再判文件，目录被忽略则其下所有文件都忽略
    for i in range(1, len(parts) + 1):
        prefix = '/'.join(parts[:i])
        base = parts[i - 1]
        for r in rules:
            r2 = r.rstrip('/')
            if '/' in r2:
                # 含斜杠的规则仅相对项目根匹配
                if prefix == r2 or prefix.startswith(r2 + '/'):
                    return True
            else:
                # 无斜杠按文件名/目录名匹配任意层级
                if fnmatch.fnmatch(base, r2) or fnmatch.fnmatch(prefix, r2 + '/*'):
                    return True
    return False


def local_files(rules):
    """生成本次部署会存在的文件集合（与 deploy.sh --enable-git-ignore 一致）。"""
    result = set()
    for root, dirs, files in os.walk(LOCAL_DIR):
        dirs[:] = [d for d in dirs if d != '.git']
        for name in files:
            abspath = os.path.join(root, name)
            rel = os.path.relpath(abspath, LOCAL_DIR)
            if is_ignored(rel, rules):
                continue
            result.add(rel)
    return result


# ==================== 财务数据红线保护（fail-safe） ====================
# 无论何时何地，以下特征的文件【禁止删除】。即使云端静态托管里出现过
# 数据文件（可能是历史上误传上去的），也只提示、不删除，由管理员人工处理。
DATA_BLOCKED_PREFIXES = ('data/', 'books/', 'backups/', 'imports/', 'sj/', 'kfck/')
DATA_BLOCKED_NAMES = ('globals.json', 'books.json', 'news_cache.json')
DATA_BLOCKED_EXT = ('.ais', '.mdb', '.bak', '.xlsx', '.xlsm')


def is_data_path(key):
    """判断云端文件 key 是否属于【数据/备份】特征（命中即绝对禁止删除）。"""
    low = key.lower()
    if key.startswith(DATA_BLOCKED_PREFIXES):
        return True
    if low.endswith(DATA_BLOCKED_EXT):
        return True
    name = key.rsplit('/', 1)[-1].lower()
    if name in DATA_BLOCKED_NAMES:
        return True
    # 目录片段级防御：路径任一层出现数据目录名
    parts = key.lower().split('/')
    return any(p in ('books', 'backups', 'imports', 'data', 'sj') for p in parts)


def cloud_files(env_id):
    """拉取云端全部文件 key 列表。"""
    out = subprocess.check_output(
        ['tcb', 'hosting', 'list', '--json', '-e', env_id],
        text=True, errors='ignore',
    )
    data = json.loads(out)
    return [f['key'] for f in data.get('data', [])]


def delete_keys(env_id, keys, dry_run):
    """逐个删除文件（单文件不需 --dir）。"""
    for k in sorted(keys):
        if dry_run:
            print('  [DRY-RUN 将删除] %s' % k)
            continue
        subprocess.run(['tcb', 'hosting', 'delete', k, '-e', env_id, '--yes'],
                       check=True, text=True, errors='ignore')
        print('  [已删除] %s' % k)


def delete_dir(env_id, top, dry_run):
    """整目录删除（快）。"""
    if dry_run:
        print('  [DRY-RUN 将整目录删除] %s/ (共该目录全部文件)' % top)
        return
    subprocess.run(['tcb', 'hosting', 'delete', top, '--dir', '-e', env_id, '--yes'],
                   check=True, text=True, errors='ignore')
    print('  [已整目录删除] %s/' % top)


def main():
    if len(sys.argv) < 2:
        print('用法: python3 tools/cleanup_hosting.py <envId> [--dry-run]')
        sys.exit(2)
    env_id = sys.argv[1]
    dry_run = '--dry-run' in sys.argv[2:]

    rules = load_gitignore()
    local = local_files(rules)
    cloud = cloud_files(env_id)

    # 差集：云端有、本地没有、且不属于受保护目录
    diff = set()
    for k in cloud:
        if k.startswith(PROTECTED):
            continue
        if k not in local:
            diff.add(k)

    if not diff:
        print('无需清理：云端文件与本地一致（受保护目录已跳过）。')
        return

    # ========== 数据红线 fail-safe：待删清单出现任何数据特征 → 中止清理 ==========
    stray_data = sorted(k for k in diff if is_data_path(k))
    if stray_data:
        print('!!! 安全保护已触发：待清理列表中检测到「数据/备份」特征文件，')
        print('    已【中止】清理，数据未被删除。请人工确认下列文件后再处理：')
        for k in stray_data:
            print('    - %s' % k)
        print('提示：静态托管理论上只应存放代码，若出现数据文件可能是历史上误传，')
        print('      请先下载备份（tcb hosting download <path>），确认无引用后再手动清理。')
        sys.exit(3)

    # 顶层目录归类：若某目录的全部云端文件都在差集里 → 整目录一次删净
    by_top = {}
    cloud_by_top = {}
    for k in cloud:
        top = k.split('/', 1)[0] if '/' in k else None
        if top is not None:
            cloud_by_top.setdefault(top, set()).add(k)
    for k in diff:
        top = k.split('/', 1)[0] if '/' in k else None
        if top is not None:
            by_top.setdefault(top, set()).add(k)
    tops_whole = [t for t, s in by_top.items()
                  if t in cloud_by_top and s == cloud_by_top[t]]

    remaining = {k for k in diff
                 if not (k.split('/', 1)[0] in tops_whole if '/' in k else False)}

    print('云端 %d 个文件 / 待清理 %d 个（其中整目录 %d 个：%s）'
          % (len(cloud), len(diff), len(tops_whole), ', '.join(tops_whole) or '-'))
    if dry_run:
        print('\n==== 预览（--dry-run，未实际删除）====')
    else:
        print('\n==== 开始清理 ====')
    for t in sorted(tops_whole):
        delete_dir(env_id, t, dry_run)
    if remaining:
        remaining = sorted(remaining)
        # 已整目录删除的顶层目录里的文件不重复删
        delete_keys(env_id, remaining, dry_run)
    print('\n完成。建议执行 tcb hosting list -e %s 复核剩余文件。' % env_id)


if __name__ == '__main__':
    main()