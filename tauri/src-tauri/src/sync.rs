// 云同步（WebDAV）—— 手动、全量、单向。
//
// 设计边界（改动前请先读）：
//   1. 软件永不在后台联网：只有用户在「云同步」卡点「云备份 / 云同步」时才发起请求；
//      不自动检测、不定时、不提醒。
//   2. 同步只做「补齐与覆盖」，**永不删除**：本机删除不会删云端，云端删除也不会删本机。
//   3. Pull（云端→本机）覆盖前，必须先给本机被覆盖的账套留安全垫（复制进 backups/）。
//   4. 云端 meta.json 最后写入，作为一次同步的提交点：中途失败重来即可，不会读到半套。
//   5. 凭据只存本机 sync.json，不进账套、不进操作日志、不随导出。

use std::fs;
use std::fs::OpenOptions;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, UNIX_EPOCH};

use reqwest::Client;
use reqwest::Method;
use serde::{Deserialize, Serialize};

use crate::{atomic_write, backups_dir, books_dir, data_root, now_ts};

// 同一账套两端时间戳相差 60s 以内视为一致（避免秒级抖动误报冲突）
const SAME_TOLERANCE_MS: u128 = 60_000;
const DEFAULT_CLOUD_DIR: &str = "添钰财务同步";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncConfig {
    /// WebDAV 根地址，如 https://dav.jianguoyun.com/dav/
    pub url: String,
    /// 账号（坚果云为完整登录邮箱）
    pub user: String,
    /// 第三方应用密码（非登录密码）
    pub pass: String,
    /// 云端子目录名，留空用默认「添钰财务同步」
    pub dir: String,
    /// 上次成功「云备份」时间（毫秒）；首页据此做"长期未备份"本地提醒（旧配置无此字段=未备份过）
    pub last_push: Option<u128>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CloudBook {
    pub id: String,
    pub name: String,
    pub start_month: String,
    /// 该文件在写入端的修改时间（毫秒）
    pub updated_at: u128,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CloudMeta {
    pub version: u32,
    pub last_sync_at: u128,
    pub last_direction: String,
    pub books: Vec<CloudBook>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    /// 上传到云端的账套数
    pub pushed: usize,
    /// 从云端覆盖/新增到本机的账套数
    pub pulled: usize,
    /// 其中本机原本没有、本次新增的
    pub added: usize,
    /// 冲突账套（对端更新的账套名）；非空且未 force 时不执行
    pub conflicts: Vec<String>,
    /// 本次涉及的账套总数
    pub total: usize,
}

struct LocalBook {
    id: String,
    name: String,
    start_month: String,
    mtime: u128,
    size: u64,
    path: PathBuf,
}

/* ---------------- 配置存取（存本机 sync.json） ---------------- */

fn sync_cfg_path() -> Result<PathBuf, String> {
    Ok(data_root()?.join("sync.json"))
}

fn read_cfg() -> SyncConfig {
    match sync_cfg_path() {
        Ok(p) => fs::read_to_string(p)
            .ok()
            .and_then(|s| serde_json::from_str::<SyncConfig>(&s).ok())
            .unwrap_or_default(),
        Err(_) => SyncConfig::default(),
    }
}

fn write_cfg(cfg: &SyncConfig) -> Result<(), String> {
    let p = sync_cfg_path()?;
    let s = serde_json::to_string_pretty(cfg).map_err(|e| format!("配置序列化失败: {e}"))?;
    atomic_write(&p, &s)
}

fn require_cfg() -> Result<SyncConfig, String> {
    let c = read_cfg();
    if c.url.trim().is_empty() || c.user.trim().is_empty() || c.pass.is_empty() {
        return Err("尚未配置云端（需填写服务器地址、账号、应用密码）".to_string());
    }
    Ok(c)
}

/* ---------------- WebDAV 基础 ---------------- */

fn client() -> Result<Client, String> {
    Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| format!("网络初始化失败: {e}"))
}

/// 同步互斥：同一时刻只允许一个 push/pull 在跑。
/// 场景：启动时的自动备份与用户手动点击可能撞车，两边都写 meta.json 会交错出半个提交点。
/// 用原子标志而非 Mutex——async 中跨 await 持 MutexGuard 会破坏 Send，这里只需"占坑/释放"。
static SYNC_BUSY: AtomicBool = AtomicBool::new(false);

struct SyncGuard;
impl Drop for SyncGuard {
    fn drop(&mut self) {
        SYNC_BUSY.store(false, Ordering::SeqCst);
    }
}

fn lock_sync() -> Result<SyncGuard, String> {
    if SYNC_BUSY
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("上一次云同步还在进行中，请稍候再试".to_string());
    }
    Ok(SyncGuard)
}

/// 云端根地址（**不带**结尾斜杠）。拼接路径由 full_url 统一加 '/'，
/// 避免历史 bug：base 自带 '/' 又拼一个 → 出现 // 双斜杠，坚果云会判为路径不存在(409)
fn remote_base(cfg: &SyncConfig) -> Result<String, String> {
    let u = cfg.url.trim().trim_end_matches('/').to_string();
    if !u.starts_with("http://") && !u.starts_with("https://") {
        return Err("服务器地址需以 http:// 或 https:// 开头".to_string());
    }
    Ok(u)
}

fn cloud_dir(cfg: &SyncConfig) -> String {
    let d = cfg.dir.trim();
    if d.is_empty() {
        DEFAULT_CLOUD_DIR.to_string()
    } else {
        d.trim_matches('/').to_string()
    }
}

/// 段内百分号编码（中文目录名必须编码），保留路径分隔符由调用方用 '/' 分段
fn enc(seg: &str) -> String {
    let mut out = String::new();
    for b in seg.as_bytes() {
        match *b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// 拼接完整 URL；rel 为相对云端的路径（'/' 分隔）
fn full_url(cfg: &SyncConfig, rel: &str) -> Result<String, String> {
    // 相对路径统一挂在「云端子目录」之下
    let mut acc = cloud_dir(cfg);
    for seg in rel.split('/') {
        if !seg.is_empty() {
            acc.push('/');
            acc.push_str(seg);
        }
    }
    let mut s = remote_base(cfg)?;
    for seg in acc.split('/') {
        if !seg.is_empty() {
            s.push('/');
            s.push_str(&enc(seg));
        }
    }
    Ok(s)
}

fn auth_err() -> String {
    "账号或应用密码无效（第三方应用请用「应用密码」，非登录密码）".to_string()
}

fn status_hint(st: u16) -> String {
    match st {
        401 | 403 => "账号或应用密码无效，或本月云端流量已用尽",
        404 => "云端路径不存在",
        405 => "云端目录已存在或不允许该操作",
        409 => "云端父目录不存在，请检查服务器地址",
        413 | 507 => "云端空间不足或超出单文件限制",
        423 => "云端文件被锁定，请稍后重试",
        502 | 503 | 504 => "云端服务暂时不可用，请稍后重试",
        _ => "云端返回异常",
    }
    .to_string()
}

/// 逐级 MKCOL 建目录（已存在 405 视为成功）
async fn mkcol_all(cli: &Client, cfg: &SyncConfig, rel: &str) -> Result<(), String> {
    // 先建云端子目录本身，再逐级建其下子目录
    mkcol_one(cli, cfg, "").await?;
    let root = cloud_dir(cfg);
    let mut acc = root.clone();
    for seg in rel.split('/').filter(|s| !s.is_empty()) {
        acc.push('/');
        acc.push_str(seg);
        mkcol_one(cli, cfg, &acc[root.len()..]).await?;
    }
    Ok(())
}

/// 探测云端根地址是否可用（PROPFIND Depth:0）。
/// 目的：把「地址填错」与「账号密码错」明确区分开——坚果云应为 https://dav.jianguoyun.com/dav/
async fn probe_root(cli: &Client, cfg: &SyncConfig) -> Result<(), String> {
    let url = format!("{}/", remote_base(cfg)?);
    let r = cli
        .request(
            Method::from_bytes(b"PROPFIND").map_err(|e| format!("请求构造失败: {e}"))?,
            &url,
        )
        .basic_auth(&cfg.user, Some(&cfg.pass))
        .header("Depth", "0")
        .send()
        .await
        .map_err(|e| format!("无法连接云端（{e}）"))?;
    let st = r.status().as_u16();
    match st {
        207 | 200 | 204 | 301 | 302 => Ok(()),
        401 | 403 => Err(auth_err()),
        404 => Err(format!(
            "云端根地址不存在：{url}\n请检查服务器地址（坚果云应为 https://dav.jianguoyun.com/dav/ ，注意是 dav. 开头，不是 www.）"
        )),
        _ => Err(format!("云端根地址不可用（{st}）：{}", status_hint(st))),
    }
}

/// PROPFIND Depth:1 列出某目录下的条目名（轻量字符串提取，避免引入 XML 依赖）
async fn propfind_names(cli: &Client, cfg: &SyncConfig, rel: &str) -> Vec<String> {
    let Ok(url) = full_url(cfg, rel) else {
        return vec![];
    };
    let Ok(m) = Method::from_bytes(b"PROPFIND") else {
        return vec![];
    };
    let Ok(r) = cli
        .request(m, &url)
        .basic_auth(&cfg.user, Some(&cfg.pass))
        .header("Depth", "1")
        .send()
        .await
    else {
        return vec![];
    };
    let Ok(body) = r.text().await else {
        return vec![];
    };
    let mut out: Vec<String> = Vec::new();
    let mut rest: &str = body.as_str();
    while let Some(idx) = rest.find("displayname") {
        let Some(gt) = rest[idx..].find('>') else { break };
        let start = idx + gt + 1;
        let Some(lt) = rest[start..].find('<') else { break };
        let name = rest[start..start + lt].trim();
        if !name.is_empty() {
            out.push(name.to_string());
        }
        rest = &rest[start + lt..];
    }
    out
}

/// 列出 WebDAV 根地址下的条目名（用于"根目录不允许建文件夹"时自动挑选落点）
async fn propfind_root_names(cli: &Client, cfg: &SyncConfig) -> Vec<String> {
    let Ok(url) = remote_base(cfg).map(|u| format!("{u}/")) else {
        return vec![];
    };
    let Ok(m) = Method::from_bytes(b"PROPFIND") else {
        return vec![];
    };
    let Ok(r) = cli
        .request(m, url)
        .basic_auth(&cfg.user, Some(&cfg.pass))
        .header("Depth", "1")
        .send()
        .await
    else {
        return vec![];
    };
    let Ok(body) = r.text().await else {
        return vec![];
    };
    let mut out: Vec<String> = Vec::new();
    let mut rest: &str = body.as_str();
    while let Some(idx) = rest.find("displayname") {
        let Some(gt) = rest[idx..].find('>') else { break };
        let start = idx + gt + 1;
        let Some(lt) = rest[start..].find('<') else { break };
        let name = rest[start..start + lt].trim();
        if !name.is_empty() {
            out.push(name.to_string());
        }
        rest = &rest[start + lt..];
    }
    out
}

/// 自动确定云端落点：默认用「添钰财务同步」；
/// 若云端根目录不允许新建文件夹（坚果云常见，MKCOL 返回 409），
/// 则自动落到根下已存在的第一个文件夹内（如「我的坚果云/添钰财务同步」）。
/// 解析成功后写回 cfg.dir 并由调用方保存，后续同步不再重复探测。
async fn ensure_dir(cli: &Client, cfg: &mut SyncConfig) -> Result<(), String> {
    // 已解析过（形如 "父目录/添钰财务同步"）→ 直接校验
    if !cfg.dir.trim().is_empty() {
        return mkcol_all(cli, cfg, "books").await;
    }
    // 只落到「根下已存在的第一个文件夹」内（坚果云实测：根只读，真实同步文件夹可写，
    // 如「我的坚果云/添钰财务同步」）。刻意**不在根目录新建文件夹**——坚果云网页端
    // 会把根下的新目录当成独立同步文件夹展示，曾造成「两个添钰财务同步」的历史遗留。
    let names = propfind_root_names(cli, cfg).await;
    let parent = names.into_iter().skip(1).find(|n| n != DEFAULT_CLOUD_DIR);
    match parent {
        Some(p) => {
            cfg.dir = format!("{p}/{DEFAULT_CLOUD_DIR}");
            mkcol_all(cli, cfg, "books").await
        }
        None => Err(format!(
            "无法定位云端文件夹：WebDAV 根目录下没有可用的文件夹。\n请先在坚果云里新建一个文件夹（如「我的坚果云」），再点测试连接。"
        )),
    }
}

async fn mkcol_one(cli: &Client, cfg: &SyncConfig, rel: &str) -> Result<(), String> {
    let url = full_url(cfg, rel)?;
    let r = cli
        .request(
            Method::from_bytes(b"MKCOL").map_err(|e| format!("请求构造失败: {e}"))?,
            &url,
        )
        .basic_auth(&cfg.user, Some(&cfg.pass))
        .send()
        .await
        .map_err(|e| format!("无法连接云端（{e}）"))?;
    let st = r.status().as_u16();
    match st {
        201 | 200 | 405 => Ok(()),
        401 | 403 => Err(auth_err()),
        409 => {
            // 坚果云等服务的 WebDAV 根目录常不允许新建文件夹：改为"探测写入"判定，
            // 能写说明书目录其实可用；写不了再把云端现有目录列给用户选择。
            let probe_rel = if rel.is_empty() {
                ".typrobe".to_string()
            } else {
                format!("{rel}/.typrobe")
            };
            if put_bytes(cli, cfg, &probe_rel, b"probe".to_vec())
                .await
                .is_ok()
            {
                return Ok(());
            }
            let names = propfind_names(cli, cfg, "").await;
            let list: Vec<String> = names.into_iter().skip(1).take(20).collect(); // 第 1 项是自身
            let hint = if list.is_empty() {
                String::new()
            } else {
                format!("\n云端根地址下现有：{}", list.join("、"))
            };
            Err(format!(
                "无法在云端创建目录（409）：{url}\n请先在坚果云里手动创建这个文件夹，或把「云端目录」改成已存在的文件夹名{hint}"
            ))
        }
        _ => Err(format!(
            "创建云端目录失败（{st}）：{}（{url}）",
            status_hint(st)
        )),
    }
}

async fn put_bytes(cli: &Client, cfg: &SyncConfig, rel: &str, data: Vec<u8>) -> Result<(), String> {
    let url = full_url(cfg, rel)?;
    let r = cli
        .put(&url)
        .basic_auth(&cfg.user, Some(&cfg.pass))
        .body(data)
        .send()
        .await
        .map_err(|e| format!("无法连接云端（{e}）"))?;
    let st = r.status().as_u16();
    match st {
        200 | 201 | 204 => Ok(()),
        401 | 403 => Err(auth_err()),
        _ => Err(format!("上传失败（{st}）：{}", status_hint(st))),
    }
}

/// 先传 .tmp 再 MOVE 改名：避免中断后云端留下半截账套；服务不支持 MOVE 时退回直接覆盖写入
/// 删除云端文件（失败不影响主流程，仅供清理临时文件）
async fn delete_silently(cli: &Client, cfg: &SyncConfig, rel: &str) {
    if let Ok(url) = full_url(cfg, rel) {
        if let Ok(m) = Method::from_bytes(b"DELETE") {
            let _ = cli
                .request(m, &url)
                .basic_auth(&cfg.user, Some(&cfg.pass))
                .send()
                .await;
        }
    }
}

async fn put_atomic(cli: &Client, cfg: &SyncConfig, rel: &str, data: Vec<u8>) -> Result<(), String> {
    let tmp_rel = format!("{rel}.tmp");
    put_bytes(cli, cfg, &tmp_rel, data.clone()).await?;
    let src = full_url(cfg, &tmp_rel)?;
    let dst = full_url(cfg, rel)?;
    let mv = cli
        .request(
            Method::from_bytes(b"MOVE").map_err(|e| format!("请求构造失败: {e}"))?,
            &src,
        )
        .basic_auth(&cfg.user, Some(&cfg.pass))
        .header("Destination", dst)
        .header("Overwrite", "T")
        .send()
        .await;
    match mv {
        Ok(r) if r.status().as_u16() < 400 => Ok(()),
        _ => {
            // 退化：直接覆盖写入。顺手删掉临时文件，否则每失败一次云端就多一个 .tmp
            delete_silently(cli, cfg, &tmp_rel).await;
            put_bytes(cli, cfg, rel, data).await
        }
    }
}

async fn get_bytes(cli: &Client, cfg: &SyncConfig, rel: &str) -> Result<Option<Vec<u8>>, String> {
    let url = full_url(cfg, rel)?;
    let r = cli
        .get(&url)
        .basic_auth(&cfg.user, Some(&cfg.pass))
        .send()
        .await
        .map_err(|e| format!("无法连接云端（{e}）"))?;
    let st = r.status().as_u16();
    if st == 404 {
        return Ok(None);
    }
    if st == 401 || st == 403 {
        return Err(auth_err());
    }
    if st >= 400 {
        return Err(format!("读取云端失败（{st}）：{}", status_hint(st)));
    }
    let b = r
        .bytes()
        .await
        .map_err(|e| format!("读取云端内容失败（{e}）"))?
        .to_vec();
    Ok(Some(b))
}

async fn read_cloud_meta(cli: &Client, cfg: &SyncConfig) -> Result<CloudMeta, String> {
    match get_bytes(cli, cfg, "meta.json").await? {
        Some(b) => serde_json::from_slice::<CloudMeta>(&b)
            .map_err(|_| "云端索引(meta.json)格式异常，请重新执行一次云备份".to_string()),
        None => Ok(CloudMeta::default()),
    }
}

/* ---------------- 本机账套 ---------------- */

/// 把本机文件的修改时间对齐为「内容产生时间」（云端记录的 updated_at）。
/// 必须对齐的原因：atomic_write 会把 mtime 刷成写入时刻，若不还原，
/// 取回后本机 mtime 永远新于云端记录，此后每次「云同步」都会误报"本机比云端新"的假冲突。
fn set_mtime(p: &std::path::Path, ms: u128) {
    if let Ok(f) = OpenOptions::new().write(true).open(p) {
        let t = UNIX_EPOCH + Duration::from_millis(ms as u64);
        let _ = f.set_modified(t);
    }
}

fn mtime_of(p: &std::path::Path) -> u128 {
    fs::metadata(p)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn list_local() -> Result<Vec<LocalBook>, String> {
    let d = books_dir()?;
    let mut out = Vec::new();
    for e in fs::read_dir(&d).map_err(|e| format!("读取本机账套失败: {e}"))? {
        let e = e.map_err(|e| e.to_string())?;
        let p = e.path();
        if p.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let id = p
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        if id.is_empty() {
            continue;
        }
        let txt = fs::read_to_string(&p).unwrap_or_default();
        let v = serde_json::from_str::<serde_json::Value>(&txt).unwrap_or(serde_json::Value::Null);
        let name = v["company"]["name"]
            .as_str()
            .unwrap_or(&id)
            .to_string();
        let start_month = v["company"]["startMonth"].as_str().unwrap_or("").to_string();
        let size = fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
        out.push(LocalBook {
            id,
            name,
            start_month,
            mtime: mtime_of(&p),
            size,
            path: p,
        });
    }
    Ok(out)
}

fn build_meta(books: &[LocalBook], direction: &str) -> CloudMeta {
    CloudMeta {
        version: 1,
        last_sync_at: now_ts(),
        last_direction: direction.to_string(),
        books: books
            .iter()
            .map(|b| CloudBook {
                id: b.id.clone(),
                name: b.name.clone(),
                start_month: b.start_month.clone(),
                updated_at: b.mtime,
                size: b.size,
            })
            .collect(),
    }
}

/* ---------------- 命令 ---------------- */

#[tauri::command]
pub fn sync_get_config() -> SyncConfig {
    // 不把密码透出给界面：界面只用它判断"是否已配置"
    let c = read_cfg();
    SyncConfig {
        url: c.url,
        user: c.user,
        pass: if c.pass.is_empty() {
            String::new()
        } else {
            "******".to_string()
        },
        dir: c.dir,
        last_push: c.last_push,
    }
}

#[tauri::command]
pub fn sync_set_config(url: String, user: String, pass: String, dir: String) -> Result<(), String> {
    // 「重新配置」时密码框可留空：表示沿用已保存的应用密码
    let pass = if pass.is_empty() {
        read_cfg().pass
    } else {
        pass
    };
    let cfg = SyncConfig {
        url: url.trim().to_string(),
        user: user.trim().to_string(),
        pass,
        dir: dir.trim().to_string(),
        last_push: read_cfg().last_push, // 仅更新连接信息，保留上次云备份时间
    };
    if cfg.url.is_empty() || cfg.user.is_empty() || cfg.pass.is_empty() {
        return Err("服务器地址、账号、应用密码不能为空".to_string());
    }
    remote_base(&cfg)?; // 地址格式校验
    write_cfg(&cfg)
}

#[tauri::command]
pub fn sync_clear_config() -> Result<(), String> {
    let p = sync_cfg_path()?;
    if p.exists() {
        fs::remove_file(&p).map_err(|e| format!("清除配置失败: {e}"))?;
    }
    Ok(())
}

/// 测试连接：建目录 + 读一次 meta.json（没有也算连通）
#[tauri::command]
pub async fn sync_test(url: String, user: String, pass: String, dir: String) -> Result<String, String> {
    // 与 sync_set_config 一致：密码留空时沿用已保存的应用密码（重新配置时不强制重输）
    let pass = if pass.is_empty() {
        read_cfg().pass
    } else {
        pass
    };
    let cfg = SyncConfig {
        url: url.trim().to_string(),
        user: user.trim().to_string(),
        pass,
        dir: dir.trim().to_string(),
        last_push: read_cfg().last_push,
    };
    if cfg.url.is_empty() || cfg.user.is_empty() || cfg.pass.is_empty() {
        return Err("请先填写服务器地址、账号、应用密码".to_string());
    }
    remote_base(&cfg)?;
    let cli = client()?;
    probe_root(&cli, &cfg).await?;
    let mut c = cfg.clone();
    ensure_dir(&cli, &mut c).await?;
    let meta = read_cloud_meta(&cli, &c).await?;
    // 已保存过配置时，顺手固化自动解析出的云端落点（首次配置未保存则不写盘）
    let cur = read_cfg();
    if !cur.url.is_empty() && cur.dir != c.dir {
        let mut s = cur;
        s.dir = c.dir.clone();
        let _ = write_cfg(&s);
    }
    Ok(format!(
        "连接成功（云端目录：{}），已有 {} 本账套",
        c.dir,
        meta.books.len()
    ))
}

/// 云备份（本机 → 云端）：force=false 且云端存在更新账套时，只返回冲突不执行
#[tauri::command]
pub async fn sync_push(force: bool) -> Result<SyncResult, String> {
    let _guard = lock_sync()?;
    let cfg0 = require_cfg()?;
    let cli = client()?;
    probe_root(&cli, &cfg0).await?;
    let mut cfg = cfg0.clone();
    ensure_dir(&cli, &mut cfg).await?;
    if cfg.dir != cfg0.dir {
        let _ = write_cfg(&cfg); // 固化自动解析出的云端落点
    }

    let local = list_local()?;
    let cloud = read_cloud_meta(&cli, &cfg).await?;

    // 冲突：云端版本比本机新（容差 60s），继续上传会覆盖它
    let mut conflicts: Vec<String> = Vec::new();
    for lb in &local {
        if let Some(cb) = cloud.books.iter().find(|c| c.id == lb.id) {
            if cb.updated_at > lb.mtime + SAME_TOLERANCE_MS {
                conflicts.push(cb.name.clone());
            }
        }
    }
    if !conflicts.is_empty() && !force {
        return Ok(SyncResult {
            conflicts,
            total: local.len(),
            ..Default::default()
        });
    }

    for lb in &local {
        let data = fs::read(&lb.path).map_err(|e| format!("读取账套「{}」失败: {e}", lb.name))?;
        put_atomic(&cli, &cfg, &format!("books/{}.json", lb.id), data).await?;
    }
    // meta 最后写：作为本次同步的提交点
    let meta = build_meta(&local, "push");
    let body = serde_json::to_vec_pretty(&meta).map_err(|e| format!("索引序列化失败: {e}"))?;
    put_bytes(&cli, &cfg, "meta.json", body).await?;

    // 记录本次云备份时间：供首页「超 7 天未备份且有改动」的本地提醒
    cfg.last_push = Some(now_ts());
    let _ = write_cfg(&cfg);

    Ok(SyncResult {
        pushed: local.len(),
        total: local.len(),
        ..Default::default()
    })
}

/// 云同步（云端 → 本机）：覆盖前先给本机被覆盖的账套留安全垫
#[tauri::command]
pub async fn sync_pull(force: bool) -> Result<SyncResult, String> {
    let _guard = lock_sync()?;
    let cfg0 = require_cfg()?;
    let cli = client()?;
    let mut cfg = cfg0.clone();
    ensure_dir(&cli, &mut cfg).await?;
    if cfg.dir != cfg0.dir {
        let _ = write_cfg(&cfg);
    }
    let cloud = read_cloud_meta(&cli, &cfg).await?;
    if cloud.books.is_empty() {
        return Ok(SyncResult::default());
    }
    let local = list_local()?;

    // 冲突：本机版本比云端新，取回会覆盖本机较新的账
    let mut conflicts: Vec<String> = Vec::new();
    for cb in &cloud.books {
        if let Some(lb) = local.iter().find(|l| l.id == cb.id) {
            if lb.mtime > cb.updated_at + SAME_TOLERANCE_MS {
                conflicts.push(lb.name.clone());
            }
        }
    }
    if !conflicts.is_empty() && !force {
        return Ok(SyncResult {
            conflicts,
            total: cloud.books.len(),
            ..Default::default()
        });
    }

    let bd = books_dir()?;
    let bk = backups_dir()?;
    let ts = now_ts();
    let mut pulled = 0usize;
    let mut added = 0usize;

    for cb in &cloud.books {
        let Some(data) = get_bytes(&cli, &cfg, &format!("books/{}.json", cb.id)).await? else {
            continue; // 云端索引有、文件缺失：跳过，不破坏本机
        };
        let target = bd.join(format!("{}.json", cb.id));
        if target.exists() {
            // 安全垫：覆盖前先把本机现有版本复制进 backups/（可在「查看备份」里恢复）
            let _ = fs::copy(&target, bk.join(format!("{}_pre_sync_{ts}.json", cb.id)));
        } else {
            added += 1;
        }
        let s = String::from_utf8(data).map_err(|_| format!("账套「{}」内容编码异常", cb.name))?;
        atomic_write(&target, &s)?;
        // 文件时间还原为云端记录的内容时间，避免后续同步误判"本机更新"
        set_mtime(&target, cb.updated_at);
        pulled += 1;
    }

    // 取回后本机内容已与云端一致：刷新「上次备份时间」，避免刚取回就误报"待备份"
    cfg.last_push = Some(now_ts());
    let _ = write_cfg(&cfg);

    Ok(SyncResult {
        pulled,
        added,
        total: cloud.books.len(),
        ..Default::default()
    })
}

/// 首页本地提醒：距上次云备份 ≥ 7 天、且此后本机账套有改动 → 建议云备份。
/// 纯本地判定（读配置里的 lastPush + books 文件时间），不联网、无后台。
const PENDING_AFTER_MS: u128 = 7 * 24 * 60 * 60 * 1000;
/// 自动备份节奏：距上次云备份 ≥ 1 天且之后有改动，软件正常退出时静默执行一次
const AUTO_AFTER_MS: u128 = 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncPending {
    pub pending: bool,
    pub count: usize,
    /// 本机有账套但尚未配置云同步 → 首页引导去配置（不打扰原则之外的唯一入口提示）
    pub unconfigured: bool,
    /// 已配置但一次都没备份过（last_push 为空）
    pub never_pushed: bool,
}

#[tauri::command]
pub fn sync_pending() -> Result<SyncPending, String> {
    let books = list_local().unwrap_or_default();
    let cfg = read_cfg();
    // 未配置云端：本机有账套才提示去配置（全新空账套不打扰）
    if cfg.url.is_empty() || cfg.user.is_empty() || cfg.pass.is_empty() {
        return Ok(SyncPending {
            unconfigured: !books.is_empty(),
            ..Default::default()
        });
    }
    // 已配置但一次都没备份过 → 必须提醒。否则会形成死循环：
    // 自动备份要求 last_push 有历史值才启动，而用户不手动备份就永远没有这个值，
    // 结果是"配置好了却一次都没备份过"，且没有任何提示。
    let Some(last) = cfg.last_push else {
        return Ok(SyncPending {
            pending: !books.is_empty(),
            count: books.len(),
            never_pushed: true,
            ..Default::default()
        });
    };
    let now = now_ts();
    if now < last + PENDING_AFTER_MS {
        return Ok(SyncPending::default());
    }
    let count = books.iter().filter(|b| b.mtime > last).count();
    Ok(SyncPending {
        pending: count > 0,
        count,
        unconfigured: false,
        never_pushed: false,
    })
}

/// 自动备份（软件**启动**时调用，静默、非强制）：
/// 已配置 且 距上次云备份 ≥1 天 且 之后有改动 → 执行云备份。
/// 注：首备份必须手动——自动备份以 last_push 为基准，从未备份过则不启动（避免刚配好就联网）。
/// 云端较新时 force=false 会跳过（绝不覆盖更新的云端数据）；任何失败静默。
pub async fn run_auto_backup() -> bool {
    let cfg = read_cfg();
    if cfg.url.is_empty() || cfg.user.is_empty() || cfg.pass.is_empty() {
        return false;
    }
    let Some(last) = cfg.last_push else {
        return false; // 从未备份过，不自动（避免新配置首次启动就联网）
    };
    let now = now_ts();
    if now < last + AUTO_AFTER_MS {
        return false;
    }
    let Ok(books) = list_local() else {
        return false;
    };
    if !books.iter().any(|b| b.mtime > last) {
        return false; // 无新改动，无需备份
    }
    // force=false：云端较新时仅返回 conflicts，不覆盖云端
    match sync_push(false).await {
        Ok(r) => r.pushed > 0 || !r.conflicts.is_empty(),
        Err(_) => false,
    }
}
