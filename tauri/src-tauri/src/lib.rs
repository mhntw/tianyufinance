// 财务软件 Tauri 后端：本地文件存储层
// 数据根目录：<用户文档>/财务软件/
//   books/<id>.json        账套
//   backups/<bookId>_<ts>.json  备份
//   changelog.json         操作日志
//   exports/<name>_<date>.json 用户手动导出备份

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::Manager;

// 数据根目录（不存在则创建）：
//   macOS:   ~/Library/Application Support/心中有数/
//   Windows: %APPDATA%\心中有数\   （即 C:\Users\<用户>\AppData\Roaming\心中有数\）
//   Linux:   ~/.local/share/心中有数/
//
// 为什么必须用「应用数据目录」而不是「文档」：
// macOS 的「桌面与文档文件夹」同步、Windows OneDrive 的「已知文件夹移动」，
// 都会把整个 Documents 搬到云同步目录里，且从软件界面完全看不出来。
// 对本软件有两个后果，第二个比第一个严重得多：
//   1. 账套被静默上传到云端；
//   2. 多设备同时读写会产生冲突副本 —— 你看到的账可能来自一个你不知道的版本。
//      对财务软件而言，账错了却不知道，比账被看到严重得多。
//      另外开启「优化储存空间」后，文件可能只剩占位符，断网时读不到账套。
// 应用数据目录是操作系统为程序数据预留的位置，默认不在任何云同步范围内。
//
// ⚠️ 重要契约：本函数必须只依赖「系统应用数据目录 + 固定的目录名」，
// 绝不可改用 Tauri 的 app_data_dir() / identifier 派生路径。
// 原因：identifier（com.chen.xzys 等）是可以改的，而它一变，
// 按它派生的路径也会跟着变 —— 现有账套会全部"消失"（文件还在，但软件找不到了）。
// 对财务软件来说这是最严重的事故之一。见测试 data_root_ignores_identifier。
fn data_root() -> Result<PathBuf, String> {
    let base = dirs::data_dir().ok_or_else(|| "无法定位应用数据目录".to_string())?;
    let root = base.join("心中有数");
    fs::create_dir_all(&root).map_err(|e| format!("创建数据目录失败: {e}"))?;
    Ok(root)
}

// 数据目录已迁离「文档/财务软件」。若旧位置仍有数据，放一个说明文件指路——
// 用户打开软件发现"账套没了"是最难解释的事故，几行字就能避免。
// 只写一次（已存在则跳过）；任何失败都静默忽略，绝不影响启动。
fn note_legacy_dir() {
    let old = match dirs::document_dir() {
        Some(d) => d.join("财务软件"),
        None => return,
    };
    if !old.is_dir() {
        return;
    }
    let marker = old.join("本目录已不再使用-请看新数据位置.txt");
    if marker.exists() {
        return;
    }
    let new = data_root()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| "（未能定位，请从软件「设置 → 打开数据目录」查看）".to_string());
    // \r\n 是为了 Windows 记事本能正常换行
    let txt = format!(
        "本目录已不再是「心中有数」的数据目录。\r\n\
         \r\n\
         为避免账套被 iCloud / OneDrive 静默同步到云端（以及多设备同时读写\r\n\
         造成账目冲突），数据目录已改为：\r\n\
         \r\n    {new}\r\n\
         \r\n\
         如果这里还有你需要的账套数据，请先复制 books/ 等文件夹到上面的新位置。\r\n\
         确认不再需要后，本文件夹可以整个删除。\r\n"
    );
    let _ = fs::write(&marker, txt);
}

fn books_dir() -> Result<PathBuf, String> {
    let d = data_root()?.join("books");
    fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

fn backups_dir() -> Result<PathBuf, String> {
    let d = data_root()?.join("backups");
    fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

fn exports_dir() -> Result<PathBuf, String> {
    let d = data_root()?.join("exports");
    fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

// 凭证附件目录：<数据根>/attachments/（与账套数据同级，便于整体备份/迁移）
fn attachments_dir() -> Result<PathBuf, String> {
    let d = data_root()?.join("attachments");
    fs::create_dir_all(&d).map_err(|e| format!("创建附件目录失败: {e}"))?;
    Ok(d)
}

// 生成不覆盖已有文件的路径：原名已存在则依次追加 _1、_2 ...（保留扩展名）
fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let p = dir.join(name);
    if !p.exists() {
        return p;
    }
    let stem = Path::new(name)
        .file_stem()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("附件")
        .to_string();
    let ext = Path::new(name)
        .extension()
        .and_then(|s| s.to_str())
        .map(|e| format!(".{e}"))
        .unwrap_or_default();
    for i in 1..10000 {
        let cand = dir.join(format!("{stem}_{i}{ext}"));
        if !cand.exists() {
            return cand;
        }
    }
    // 极端兜底：用时间戳保证唯一
    dir.join(format!("{stem}_{}{ext}", now_ts()))
}

fn now_ts() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

// 当前日期 YYYYMMDD（用于导出文件名），基于系统本地时间，不依赖额外 crate
fn chrono_date_string() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // 以 UTC 计算日期（导出文件名仅作区分，无需精确到本地时区）
    let days = secs / 86400;
    let mut y = 1970;
    let mut rem = days as i64;
    loop {
        let leap = if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 { 366 } else { 365 };
        if rem < leap { break; }
        rem -= leap;
        y += 1;
    }
    let month_days = [31, if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut m = 0;
    while m < 12 && rem >= month_days[m] {
        rem -= month_days[m];
        m += 1;
    }
    let d = rem + 1;
    format!("{:04}{:02}{:02}", y, m + 1, d)
}

// 从账套 json 中提取 company.name（失败返回 None）
fn extract_book_name(json: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    v.get("company")
        .and_then(|c| c.get("name"))
        .and_then(|n| n.as_str())
        .map(|s| s.to_string())
}

// 剔除文件名中的非法字符（/ \ : * ? " < > | 及前后空格）
fn sanitize_filename(name: &str) -> String {
    let mut s: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => c,
        })
        .collect();
    s = s.trim().to_string();
    if s.is_empty() { s = "账套".to_string(); }
    s
}

// 原子写：先写 .tmp 再 rename，避免写到一半崩溃损坏文件
fn atomic_write(path: &PathBuf, content: &str) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    {
        let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(content.as_bytes()).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    Ok(())
}

// 账套写入
#[tauri::command]
fn save_book(id: String, json: String) -> Result<(), String> {
    if id.trim().is_empty() {
        return Err("账套 id 不能为空".to_string());
    }
    let path = books_dir()?.join(format!("{id}.json"));
    // 写前对旧文件做一次滚动备份（保留最近 5 份）
    if path.exists() {
        if let Ok(old) = fs::read_to_string(&path) {
            let bdir = backups_dir()?;
            for i in (1..5).rev() {
                let src = bdir.join(format!("{id}.bak{i}"));
                let dst = bdir.join(format!("{id}.bak{}", i + 1));
                let _ = fs::rename(&src, &dst);
            }
            let _ = fs::write(bdir.join(format!("{id}.bak1")), old);
        }
    }
    atomic_write(&path, &json)
}

#[tauri::command]
fn load_book(id: String) -> Result<Option<String>, String> {
    if id.trim().is_empty() {
        return Ok(None);
    }
    let path = books_dir()?.join(format!("{id}.json"));
    if path.exists() {
        Ok(Some(fs::read_to_string(&path).map_err(|e| e.to_string())?))
    } else {
        Ok(None)
    }
}

#[tauri::command]
fn list_books() -> Result<Vec<String>, String> {
    let d = books_dir()?;
    let mut out = Vec::new();
    for e in fs::read_dir(&d).map_err(|e| e.to_string())? {
        let e = e.map_err(|e| e.to_string())?;
        let name = e.file_name().to_string_lossy().to_string();
        if let Some(stripped) = name.strip_suffix(".json") {
            out.push(stripped.to_string());
        }
    }
    Ok(out)
}

#[tauri::command]
fn delete_book(id: String) -> Result<(), String> {
    if id.trim().is_empty() {
        return Err("账套 id 不能为空".to_string());
    }
    let path = books_dir()?.join(format!("{id}.json"));
    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// —— 备份环形保留 ——
// 自动备份由前端 persist() 以 3 秒防抖窗口触发，一天正常录账会堆出上百份全量 JSON，
// 而备份目录此前从不清理，只增不减最终吃满磁盘。这里按账套保留最近 N 份，超出从旧到新删除。
// 另注：save_book 里的 bak1~bak5 是「写前滚动备份」，与本处的自动备份是两套，互不干扰。
const MAX_BACKUPS_PER_BOOK: usize = 20;
// 「恢复前快照」单独计配额：它的价值窗口是恢复后立刻发现不对、一键回滚，
// 因此不与普通自动备份混用同一配额，免得刚录几笔就被挤掉。
const MAX_RESTORE_SNAPSHOTS: usize = 5;

#[derive(Debug, PartialEq, Clone, Copy)]
enum BackupKind {
    Auto,       // 普通自动备份：<bookId>_<ts>.json
    PreRestore, // 恢复前快照：<bookId>_pre_restore_<ts>.json
}

// 从备份文件名取时间戳：<任意前缀>_<ts>.json → ts（取最后一段下划线后的数字）
fn backup_ts(name: &str) -> Option<u128> {
    let stem = name.strip_suffix(".json")?;
    let ts = stem.rsplit('_').next()?;
    ts.parse::<u128>().ok()
}

// 判定备份文件归属哪一类；不属于该账套返回 None。
// 单独抽成纯函数（不碰文件系统）以便单测——环形清理会真删文件，分类错了就是数据事故。
fn backup_kind_of(name: &str, bid: &str) -> Option<BackupKind> {
    if !name.ends_with(".json") {
        return None;
    }
    // 先判快照再判普通：快照名同样以 <bid>_ 开头，顺序反了会被误归为普通备份
    if name.starts_with(&format!("{bid}_pre_restore_")) {
        return Some(BackupKind::PreRestore);
    }
    if name.starts_with(&format!("{bid}_")) {
        return Some(BackupKind::Auto);
    }
    None
}

// 列出某账套某类备份：[(ts, 文件名)]，按 ts 升序（最旧在前）
fn list_backups_of(bid: &str, kind: BackupKind) -> Vec<(u128, String)> {
    let mut out = Vec::new();
    let d = match backups_dir() {
        Ok(d) => d,
        Err(_) => return out,
    };
    let rd = match fs::read_dir(&d) {
        Ok(rd) => rd,
        Err(_) => return out,
    };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if backup_kind_of(&name, bid) != Some(kind) {
            continue;
        }
        out.push((backup_ts(&name).unwrap_or(0), name));
    }
    out.sort();
    out
}

// 环形保留：只留最近 keep 份，其余从旧到新删除。删除失败不阻断主流程（备份失败不该影响记账）。
fn rotate_backups(bid: &str, kind: BackupKind, keep: usize) {
    let all = list_backups_of(bid, kind);
    if all.len() <= keep {
        return;
    }
    let drop = all.len() - keep;
    let dir = match backups_dir() {
        Ok(d) => d,
        Err(_) => return,
    };
    for (_, name) in all.into_iter().take(drop) {
        let _ = fs::remove_file(dir.join(&name));
    }
}

#[tauri::command]
fn save_backup(book_id: String, json: String) -> Result<String, String> {
    if book_id.trim().is_empty() {
        return Err("账套 id 不能为空".to_string());
    }
    let ts = now_ts();
    let fname = format!("{book_id}_{ts}.json");
    let path = backups_dir()?.join(&fname);
    atomic_write(&path, &json)?;
    // 写完后立即按账套环形清理，避免 backups/ 无限膨胀
    rotate_backups(&book_id, BackupKind::Auto, MAX_BACKUPS_PER_BOOK);
    Ok(fname)
}

/* ===================== 账套回收站 =====================
 * 删除账套改为「移入 trash/」，保留期内可还原，避免一次手滑毁掉一整个店的账。
 * 设计取舍：不做后台定时任务，改为在列举时惰性清理过期项——桌面软件无需常驻调度，
 * 且用户打开回收站的那一刻正是最需要看到"有哪些还能救"的时机。
 * ====================================================== */

const TRASH_KEEP_MS: u128 = 7 * 24 * 60 * 60 * 1000; // 回收站保留 7 天

fn trash_dir() -> Result<PathBuf, String> {
    let d = data_root()?.join("trash");
    fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

// 回收站文件名：<id>__<ts>.json
// 用双下划线分隔：id 由前端生成为 B<时间戳> 或 default，本身不含下划线，
// 但双下划线能把「id 含单下划线」的历史数据也一并容错，解析时用 rsplit_once 取末段。
fn trash_file_name(id: &str, ts: u128) -> String {
    format!("{id}__{ts}.json")
}

fn parse_trash_name(name: &str) -> Option<(String, u128)> {
    let stem = name.strip_suffix(".json")?;
    let (id, ts) = stem.rsplit_once("__")?;
    if id.is_empty() {
        return None;
    }
    Some((id.to_string(), ts.parse::<u128>().ok()?))
}

#[derive(Serialize, Clone)]
struct TrashItem {
    file: String,
    id: String,
    name: String,
    ts: u128,
    size: u64,
}

fn read_trash_items() -> Result<Vec<TrashItem>, String> {
    let d = trash_dir()?;
    let mut out = Vec::new();
    for e in fs::read_dir(&d).map_err(|e| e.to_string())?.flatten() {
        let fname = e.file_name().to_string_lossy().to_string();
        let (id, ts) = match parse_trash_name(&fname) {
            Some(v) => v,
            None => continue, // 非本机制产生的残留文件，跳过（不删，避免误伤）
        };
        let size = e.metadata().map(|m| m.len()).unwrap_or(0);
        let json = fs::read_to_string(e.path()).unwrap_or_default();
        let name = extract_book_name(&json).unwrap_or_else(|| id.clone());
        out.push(TrashItem { file: fname, id, name, ts, size });
    }
    out.sort_by(|a, b| b.ts.cmp(&a.ts)); // 最近删除的在前
    Ok(out)
}

// 惰性清理过期项。只在列举时调用，删除失败不阻断（回收站清理失败不该挡住用户看列表）。
fn purge_expired_trash() {
    let items = match read_trash_items() {
        Ok(v) => v,
        Err(_) => return,
    };
    let now = now_ts();
    let dir = match trash_dir() {
        Ok(d) => d,
        Err(_) => return,
    };
    for it in items {
        if now.saturating_sub(it.ts) > TRASH_KEEP_MS {
            let _ = fs::remove_file(dir.join(&it.file));
        }
    }
}

// 只接受纯文件名，杜绝 ../ 之类的路径穿越
fn is_plain_filename(name: &str) -> bool {
    !name.is_empty()
        && Path::new(name).file_name().and_then(|s| s.to_str()) == Some(name)
}

// 删除账套 → 移入回收站（不真删，保留 7 天）
#[tauri::command]
fn trash_book(id: String) -> Result<String, String> {
    if id.trim().is_empty() {
        return Err("账套 id 不能为空".to_string());
    }
    let src = books_dir()?.join(format!("{id}.json"));
    if !src.exists() {
        return Err("账套文件不存在".to_string());
    }
    let fname = trash_file_name(&id, now_ts());
    let dst = trash_dir()?.join(&fname);
    // 移动的原子性在本机同分区 rename 上足够，失败即保留原文件，不会两头空
    fs::rename(&src, &dst).map_err(|e| format!("移入回收站失败: {e}"))?;
    purge_expired_trash();
    Ok(fname)
}

#[tauri::command]
fn list_trash() -> Result<Vec<TrashItem>, String> {
    purge_expired_trash();
    read_trash_items()
}

// 还原：把回收站项移回 books/。若同名 id 已被占用（删后新建了同 id 账套），
// 改用新 id 落回而不是覆盖——覆盖会毁掉用户后来录的数据，改名最多是列表多一行。
#[tauri::command]
fn restore_book_from_trash(file: String) -> Result<String, String> {
    if !is_plain_filename(&file) {
        return Err("文件名无效".to_string());
    }
    let (id, _ts) = parse_trash_name(&file).ok_or_else(|| "回收站项无效".to_string())?;
    let bd = books_dir()?;
    let src = trash_dir()?.join(&file);
    if !src.exists() {
        return Err("回收站项不存在或已过期清理".to_string());
    }
    let target = if bd.join(format!("{id}.json")).exists() {
        format!("{id}_{}", now_ts())
    } else {
        id
    };
    fs::rename(&src, bd.join(format!("{target}.json")))
        .map_err(|e| format!("还原失败: {e}"))?;
    Ok(target)
}

#[tauri::command]
fn delete_trash_item(file: String) -> Result<(), String> {
    if !is_plain_filename(&file) {
        return Err("文件名无效".to_string());
    }
    let p = trash_dir()?.join(&file);
    if p.exists() {
        fs::remove_file(&p).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn empty_trash() -> Result<usize, String> {
    let dir = trash_dir()?;
    let mut n = 0;
    for it in read_trash_items()? {
        if fs::remove_file(dir.join(&it.file)).is_ok() {
            n += 1;
        }
    }
    Ok(n)
}

/* ===================== 备份健康度 =====================
 * 只有"备份在自动跑"是不够的——用户真正需要知道的是：备份占多大、最后一次是什么时候、
 * 以及有没有把副本放到本机之外。落盘备份挡不住硬盘损坏，导出到 U 盘/网盘才行。
 * ==================================================== */

#[derive(Serialize)]
struct BackupStats {
    count: usize,         // 自动备份份数
    snapshot_count: usize,// 恢复前快照份数
    total_bytes: u64,     // 自动备份占用
    last_ts: u128,        // 最新一次自动备份时间
    last_export_ts: u128, // exports/ 目录最新文件时间（0 = 从未导出过）
}

// exports/ 下最新文件的修改时间，用于提示"多久没做本机外副本"
fn last_export_ts() -> u128 {
    let d = match exports_dir() {
        Ok(d) => d,
        Err(_) => return 0,
    };
    let mut newest = 0u128;
    for e in fs::read_dir(&d).into_iter().flatten().flatten() {
        let ts = e
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis())
            .unwrap_or(0);
        if ts > newest {
            newest = ts;
        }
    }
    newest
}

#[tauri::command]
fn backup_stats(book_id: String) -> Result<BackupStats, String> {
    let dir = backups_dir()?;
    let autos = list_backups_of(&book_id, BackupKind::Auto);
    let mut total = 0u64;
    let mut last = 0u128;
    for (ts, name) in &autos {
        if let Ok(m) = fs::metadata(dir.join(name)) {
            total += m.len();
        }
        if *ts > last {
            last = *ts;
        }
    }
    Ok(BackupStats {
        count: autos.len(),
        snapshot_count: list_backups_of(&book_id, BackupKind::PreRestore).len(),
        total_bytes: total,
        last_ts: last,
        last_export_ts: last_export_ts(),
    })
}

// 恢复/导入前的强制快照：<bookId>_pre_restore_<ts>.json。
// 与 save_backup 分开设命令，是为了让快照在备份列表里可识别（UI 标注为「恢复前快照」），
// 用户覆盖错了能一眼找到回滚点，而不是在一堆同名备份里猜。
#[tauri::command]
fn save_restore_snapshot(book_id: String, json: String) -> Result<String, String> {
    if book_id.trim().is_empty() {
        return Err("账套 id 不能为空".to_string());
    }
    let fname = format!("{book_id}_pre_restore_{}.json", now_ts());
    let path = backups_dir()?.join(&fname);
    atomic_write(&path, &json)?;
    rotate_backups(&book_id, BackupKind::PreRestore, MAX_RESTORE_SNAPSHOTS);
    Ok(fname)
}

#[tauri::command]
fn list_backups(book_id: Option<String>) -> Result<Vec<String>, String> {
    let d = backups_dir()?;
    let mut out = Vec::new();
    for e in fs::read_dir(&d).map_err(|e| e.to_string())? {
        let e = e.map_err(|e| e.to_string())?;
        let name = e.file_name().to_string_lossy().to_string();
        if name.ends_with(".json") {
            if let Some(bid) = &book_id {
                if name.starts_with(&format!("{bid}_")) {
                    out.push(name);
                }
            } else {
                out.push(name);
            }
        }
    }
    out.sort();
    Ok(out)
}

#[tauri::command]
fn load_backup(filename: String) -> Result<Option<String>, String> {
    let path = backups_dir()?.join(&filename);
    if path.exists() {
        Ok(Some(fs::read_to_string(&path).map_err(|e| e.to_string())?))
    } else {
        Ok(None)
    }
}

#[tauri::command]
fn append_changelog(entry: String) -> Result<(), String> {
    let path = data_root()?.join("changelog.json");
    let mut logs: Vec<String> = if path.exists() {
        serde_json::from_str(&fs::read_to_string(&path).map_err(|e| e.to_string())?)
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    logs.push(entry);
    // 只保留最近 1000 条
    if logs.len() > 1000 {
        logs.drain(0..logs.len() - 1000);
    }
    atomic_write(&path, &serde_json::to_string(&logs).map_err(|e| e.to_string())?)
}

#[tauri::command]
fn list_changelog() -> Result<Vec<String>, String> {
    let path = data_root()?.join("changelog.json");
    if path.exists() {
        Ok(serde_json::from_str(&fs::read_to_string(&path).map_err(|e| e.to_string())?)
            .unwrap_or_default())
    } else {
        Ok(Vec::new())
    }
}

// 导出单个账套为独立 .json 到 exports/（用户可在「导出备份」时拿到可携带文件）。
// 文件名：<账套名或id>_<YYYYMMDD>.json（账套名取自 json 内 company.name，剔除非法字符）。
#[tauri::command]
fn export_book(id: String, json: String) -> Result<String, String> {
    let date = chrono_date_string();
    let name = extract_book_name(&json).unwrap_or_else(|| id.clone());
    let safe = sanitize_filename(&name);
    let fname = format!("{safe}_{date}.json");
    let path = exports_dir()?.join(&fname);
    atomic_write(&path, &json)?;
    Ok(fname)
}

// 解码前端传来的 base64。
// 先走严格解码（正常路径）。若失败，说明串中间出现了 padding '=' —— 这是前端
// "分块 btoa 再拼接"的典型产物：每块独立编码都会在块尾补 '='，拼接后 '=' 落在串中间，
// STANDARD 引擎报 Invalid symbol 61。此时按 '=' 切分、每段补回 padding 独立解码再拼字节流，
// 即可无损还原原始数据（base64 以 3 字节为组，块边界独立编码，分段解正是其逆运算）。
fn decode_base64_lenient(input: &str) -> Result<Vec<u8>, String> {
    use base64::Engine as _;
    let s: String = input.chars().filter(|c| !c.is_whitespace()).collect();
    if let Ok(v) = base64::engine::general_purpose::STANDARD.decode(&s) {
        return Ok(v);
    }
    let mut out: Vec<u8> = Vec::new();
    for seg in s.split('=') {
        if seg.is_empty() {
            continue;
        }
        let pad = (4 - seg.len() % 4) % 4;
        let mut norm = seg.to_string();
        norm.extend(std::iter::repeat('=').take(pad));
        let mut v = base64::engine::general_purpose::STANDARD
            .decode(&norm)
            .map_err(|e| e.to_string())?;
        out.append(&mut v);
    }
    Ok(out)
}

// 保存前端生成的导出文件（Excel/CSV 等）到 exports/ 目录。
// 前端用 XLSX.write(wb, {type:'array'}) 或 Blob 得到二进制后，编码为 base64 字符串 invoke 本命令，
// 由 Rust 解码写盘。改用 base64 而非 Vec<u8> 是为了绕开 Tauri IPC 对 Vec<u8> 的序列化限制，最稳。
#[tauri::command]
fn save_export_file(name: String, base64: String) -> Result<String, String> {
    let name = sanitize_filename(&name);
    if name.is_empty() {
        return Err("文件名无效".to_string());
    }
    let bytes = decode_base64_lenient(&base64)
        .map_err(|e| format!("文件内容解码失败: {e}"))?;
    if bytes.is_empty() {
        return Err("文件内容为空".to_string());
    }
    let path = exports_dir()?.join(&name);
    fs::write(&path, &bytes).map_err(|e| format!("写入导出文件失败: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

// 保存凭证附件（图片 / PDF 等）到 attachments/，返回落盘绝对路径。
// 与 save_export_file 同样以 base64 传参，并复用 decode_base64_lenient 保持容错一致。
#[tauri::command]
fn save_attachment(name: String, base64: String) -> Result<String, String> {
    let bytes = decode_base64_lenient(&base64).map_err(|e| format!("附件内容解码失败: {e}"))?;
    if bytes.is_empty() {
        return Err("附件内容为空".to_string());
    }
    let safe = sanitize_filename(&name);
    if safe.is_empty() {
        return Err("附件名无效".to_string());
    }
    let dir = attachments_dir()?;
    let path = unique_path(&dir, &safe);
    fs::write(&path, &bytes).map_err(|e| format!("写入附件失败: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn get_data_dir() -> Result<String, String> {
    Ok(data_root()?.to_string_lossy().to_string())
}

// 账套元信息（轻量、与账套数据分离的可靠存储）。
// 用于保存「当前账套指针(lastBook)」与「停用标记(disabled)」，
// 不再依赖易失的 localStorage，保证多账套切换/记忆可靠。
// meta.json 结构：{ "lastBook": "id", "disabled": { "id": true } }
#[derive(serde::Serialize, serde::Deserialize, Default, Clone)]
struct BookMeta {
    #[serde(default)]
    last_book: Option<String>,
    #[serde(default)]
    disabled: std::collections::HashMap<String, bool>,
}

fn meta_path() -> Result<PathBuf, String> {
    Ok(data_root()?.join("meta.json"))
}

fn read_meta() -> BookMeta {
    let p = match meta_path() {
        Ok(p) => p,
        Err(_) => return BookMeta::default(),
    };
    match fs::read_to_string(&p) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => BookMeta::default(),
    }
}

#[tauri::command]
fn read_meta_cmd() -> BookMeta {
    read_meta()
}

#[tauri::command]
fn write_meta_cmd(meta_json: String) -> Result<(), String> {
    let m: BookMeta = serde_json::from_str(&meta_json).map_err(|e| format!("meta 格式错误: {e}"))?;
    let p = meta_path()?;
    atomic_write(&p, &serde_json::to_string_pretty(&m).map_err(|e| e.to_string())?)?;
    Ok(())
}

#[derive(Serialize)]
struct DirResult {
    dir: String,
    books: Vec<String>,
}

#[tauri::command]
fn debug_status() -> Result<DirResult, String> {
    let dir = data_root()?.to_string_lossy().to_string();
    let books = list_books()?;
    Ok(DirResult { dir, books })
}

// 在系统文件管理器中打开指定目录（macOS Finder / Windows 资源管理器）。
// 由前端「打开文件夹」按钮调用，绕过 opener 插件的 scope 限制，跨平台统一、最稳。
#[tauri::command]
fn open_in_explorer(path: String) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("路径为空".to_string());
    }
    open::that(&path).map_err(|e| format!("无法打开文件夹: {e}"))?;
    Ok(())
}

/// 唤出并聚焦主窗口（用于单实例：已有实例在跑时把它的窗口提到前台）
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 启动时留一次旧目录指引（内部已做幂等与容错，不影响启动速度）
    note_legacy_dir();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // 已有一个实例在跑时，直接唤出它的窗口并让新进程退出，
        // 绝不允许两个进程同时读写同一份账套文件（后写的会静默覆盖先写的）。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main_window(app);
        }))
        .invoke_handler(tauri::generate_handler![
            save_book,
            load_book,
            list_books,
            delete_book,
            save_backup,
            save_restore_snapshot,
            list_backups,
            backup_stats,
            trash_book,
            list_trash,
            restore_book_from_trash,
            delete_trash_item,
            empty_trash,
            load_backup,
            append_changelog,
            list_changelog,
            export_book,
            get_data_dir,
            read_meta_cmd,
            write_meta_cmd,
            debug_status,
            open_in_explorer,
            save_export_file,
            save_attachment
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{
        backup_kind_of, backup_ts, data_root, decode_base64_lenient, is_plain_filename,
        note_legacy_dir, now_ts, parse_trash_name, unique_path, BackupKind,
    };
    use base64::Engine as _;
    use std::fs;

    const CHUNK: usize = 0x8000; // 与前端 chunk 一致

    // 模拟前端"分块 btoa 再拼接"的错误产物（历史 kdPrint 的行为）
    fn chunked_encode(data: &[u8]) -> String {
        let mut out = String::new();
        for c in data.chunks(CHUNK) {
            out.push_str(&base64::engine::general_purpose::STANDARD.encode(c));
        }
        out
    }

    #[test]
    fn strict_input_decodes() {
        let data: Vec<u8> = (0..50_000u32).map(|i| (i % 251) as u8).collect();
        let good = base64::engine::general_purpose::STANDARD.encode(&data);
        assert_eq!(decode_base64_lenient(&good).unwrap(), data);
    }

    // 关键回归：分块编码产物中间含 '='，必须仍能无损还原
    #[test]
    fn chunked_padding_input_still_decodes() {
        for n in [10usize, 100, CHUNK - 1, CHUNK, CHUNK + 1, CHUNK * 2, 151_931] {
            let data: Vec<u8> = (0..n as u32).map(|i| ((i * 7 + 3) % 256) as u8).collect();
            let bad = chunked_encode(&data);
            // 前提：该产物确实会让严格解码失败（即复现 Invalid symbol 61）
            if n > CHUNK {
                assert!(
                    base64::engine::general_purpose::STANDARD.decode(&bad).is_err(),
                    "n={n} 应触发严格解码失败，否则测试失去意义"
                );
            }
            assert_eq!(
                decode_base64_lenient(&bad).unwrap(),
                data,
                "n={n} 分块编码产物应无损还原"
            );
        }
    }

    // 守门员：数据路径必须与 identifier 无关。
    // 若有人把 data_root 改成 Tauri 的 app_data_dir()（按 identifier com.chen.xzys 派生），
    // 路径里就会出现 "xzys"，本测试立即失败 —— 那意味着改一次 identifier 就会让账套"消失"。
    #[test]
    fn data_root_ignores_identifier() {
        let s = data_root().unwrap().to_string_lossy().to_string();
        for seg in ["xzys", "com.chen"] {
            assert!(
                !s.to_lowercase().contains(seg),
                "数据目录不得由 identifier 派生（否则改 identifier 会丢账套），实际: {s}"
            );
        }
    }

    // 需要真实读写 ~/Documents，故 #[ignore] 不进常规测试。手工验证：
    //   cargo test --lib -- --ignored --nocapture
    #[test]
    #[ignore]
    fn note_legacy_dir_writes_pointer() {
        note_legacy_dir();
        let old = match dirs::document_dir() {
            Some(d) => d.join("财务软件"),
            None => return,
        };
        if !old.is_dir() {
            println!("旧目录不存在，无需留指引（正常情况）");
            return;
        }
        let marker = old.join("本目录已不再使用-请看新数据位置.txt");
        assert!(marker.exists(), "旧目录存在时应留下说明文件");
        println!("说明文件已生成：{}", marker.display());
        println!("内容：\n{}", fs::read_to_string(&marker).unwrap_or_default());
    }

    // 本测试是「数据目录迁出云同步区」这一改动的守门员：
    // 一旦有人把 data_root 改回文档目录，这里会立即失败。
    #[test]
    fn data_root_is_outside_document_dir() {
        let root = data_root().unwrap();
        let s = root.to_string_lossy().to_string();
        assert!(s.ends_with("心中有数"), "应以应用名结尾，实际: {s}");
        // 核心断言：绝不能落在文档目录下——Documents 是各家云盘的默认同步目标
        if let Some(doc) = dirs::document_dir() {
            let d = doc.to_string_lossy().to_string();
            assert!(
                !s.starts_with(&d),
                "数据目录不能位于文档目录内（会被 iCloud/OneDrive 同步），实际: {s}"
            );
        }
    }

    // 环形清理靠文件名里的时间戳排序，解析错了会删错文件，必须覆盖两种命名
    #[test]
    fn backup_ts_parses_both_kinds() {
        assert_eq!(backup_ts("default_1724000000000.json"), Some(1724000000000));
        assert_eq!(
            backup_ts("default_pre_restore_1724000000001.json"),
            Some(1724000000001)
        );
        // 非法/异常输入不应 panic，交给调用方 unwrap_or(0) 兜底
        assert_eq!(backup_ts("default_abc.json"), None);
        assert_eq!(backup_ts("nojson"), None);
        assert_eq!(backup_ts(""), None);
    }

    // 环形清理按此分类删文件，误判会删掉快照（或别家账套的备份），必须单测
    #[test]
    fn backup_kind_classifies_by_filename() {
        assert_eq!(
            backup_kind_of("B1_1724000000000.json", "B1"),
            Some(BackupKind::Auto)
        );
        assert_eq!(
            backup_kind_of("B1_pre_restore_1724000000000.json", "B1"),
            Some(BackupKind::PreRestore)
        );
        // 账套 id 互为前缀时不得误判（B1 是 B12 的前缀，靠 "_" 边界区分）
        assert_eq!(backup_kind_of("B12_1724000000000.json", "B1"), None);
        assert_eq!(backup_kind_of("B2_1724000000000.json", "B1"), None);
        // 非 json / 空名一律不归类，避免误删无关文件
        assert_eq!(backup_kind_of("B1_1724000000000.txt", "B1"), None);
        assert_eq!(backup_kind_of("", "B1"), None);
    }

    // 回收站靠文件名还原 id；解析错了会导致还原出错误账套或当作垃圾跳过
    #[test]
    fn parse_trash_name_roundtrip() {
        assert_eq!(
            parse_trash_name("B1724000000000__1724000000001.json"),
            Some(("B1724000000000".to_string(), 1724000000001))
        );
        assert_eq!(parse_trash_name("default__1.json"), Some(("default".to_string(), 1)));
        // id 含单下划线也要正确切分（rsplit_once 取末段）
        assert_eq!(parse_trash_name("A_B__9.json"), Some(("A_B".to_string(), 9)));
        // 非法输入一律 None，交给调用方跳过
        assert_eq!(parse_trash_name("B1.json"), None);
        assert_eq!(parse_trash_name("__1.json"), None);
        assert_eq!(parse_trash_name("B1__abc.json"), None);
    }

    // 回收站命令接受前端传来的文件名拼路径，必须挡住路径穿越
    #[test]
    fn plain_filename_blocks_traversal() {
        assert!(is_plain_filename("B1__1724.json"));
        assert!(!is_plain_filename("../books/B1.json"));
        assert!(!is_plain_filename("sub/B1__1724.json"));
        assert!(!is_plain_filename(".."));
        assert!(!is_plain_filename(""));
    }

    #[test]
    fn whitespace_is_tolerated() {
        let data = "hello 中文内容".as_bytes().to_vec();
        let enc = base64::engine::general_purpose::STANDARD.encode(&data);
        let with_ws = enc.chars().enumerate().fold(String::new(), |mut a, (i, c)| {
            if i % 8 == 0 { a.push('\n'); }
            a.push(c);
            a
        });
        assert_eq!(decode_base64_lenient(&with_ws).unwrap(), data);
    }

    #[test]
    fn empty_input_is_empty() {
        assert!(decode_base64_lenient("").unwrap().is_empty());
    }

    // 附件同名不得互相覆盖，且扩展名要保留
    #[test]
    fn unique_path_avoids_overwrite() {
        let dir = std::env::temp_dir().join(format!("xzys_attach_test_{}", now_ts()));
        fs::create_dir_all(&dir).unwrap();

        let first = unique_path(&dir, "发票.pdf");
        assert_eq!(first.file_name().unwrap(), "发票.pdf");
        fs::write(&first, b"a").unwrap();

        let second = unique_path(&dir, "发票.pdf");
        assert_eq!(second.file_name().unwrap(), "发票_1.pdf", "同名应追加序号");
        fs::write(&second, b"b").unwrap();

        let third = unique_path(&dir, "发票.pdf");
        assert_eq!(third.file_name().unwrap(), "发票_2.pdf");

        // 无扩展名也不能崩，且不与已有文件冲突
        let noext = unique_path(&dir, "附件");
        assert!(!noext.exists());

        fs::remove_dir_all(&dir).unwrap();
    }
}
