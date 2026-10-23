'use strict';
/* ============================================================
 * audit_tauri_paths.js —— Tauri 命令的路径参数守卫审计
 *
 * 【为什么需要】Rust 的 `Path::join` 一旦遇到绝对路径，会**丢弃前缀**直接返回该绝对路径：
 *     books_dir().join("/etc/passwd") === "/etc/passwd"
 * 前端只要能把 `id` 传成绝对路径，就能读写磁盘上任意 .json / 任意文件。
 * 项目里已有 `is_plain_filename` / `sanitize_filename` 两道现成防线，但只用在少数命令上。
 *
 * 【检测思路】逐个 `#[tauri::command]` 函数：
 *   1. 取出参数表，挑出**类型是 String 且名字像路径/标识**的参数；
 *   2. 在函数体里看是否经过白名单函数（is_plain_filename / sanitize_filename / shell_escape 等）
 *      或做了 canonicalize + starts_with 前缀校验；
 *   3. 再看该参数是否真的参与了 `join` / `Path::new` / `File::open` 等文件操作 —— 不沾文件的不算问题。
 *
 * 退出码恒为 0：本脚本只出清单供决策，不阻断构建。
 * ============================================================ */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'tauri', 'src-tauri', 'src');

/* 名字像"路径或文件名"的参数 */
const PATHISH = /^(id|.*_id|.*Id|book|book_id|name|file|filename|file_name|path|dir|directory|url|target|src|dest|dest_path|save_path)$/;
/* 允许的守卫函数：出现即视为该参数已被收敛 */
const GUARDS = [
  'is_plain_filename', 'sanitize_filename',
  'canonicalize', 'starts_with', 'components()', 'file_name()',
];
/* 真正的文件操作：参数沾上这些才算"能落到磁盘上" */
const FILE_OPS = ['join(', 'Path::new(', 'PathBuf::from', 'File::open', 'File::create', 'OpenOptions',
  'fs::read', 'fs::read_dir', 'fs::metadata', 'fs::write', 'remove_file', 'fs::remove_dir_all',
  'rename(', 'create_dir'];

function stripComments(src) {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; out += '\n'; }
    else if (src[i] === '/' && src[i + 1] === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i++; }
    else out += src[i];
  }
  return out;
}

/* 从 `{` 起做括号配对，返回函数体（不含最外层括号） */
function bodyOf(src, braceAt) {
  let depth = 0;
  for (let i = braceAt; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(braceAt + 1, i); }
  }
  return '';
}

/* 拆分参数表（忽略泛型里的逗号） */
function splitParams(s) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of s) {
    if ('<([{'.includes(ch)) depth++;
    if ('>)]}'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function commandsOf(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const src = stripComments(raw);
  const list = [];
  const re = /#\[tauri::command\][\s\S]{0,200}?\bfn\s+([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\(([\s\S]*?)\)\s*(?:->\s*[^{]+)?\{/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const braceAt = re.lastIndex - 1;
    const body = bodyOf(src, braceAt);
    const params = splitParams(m[2]).map(p => p.trim()).filter(Boolean).map(p => {
      const pm = p.match(/^([A-Za-z_]\w*)\s*:\s*([\s\S]+)$/);
      return pm ? { name: pm[1], type: pm[2].replace(/\s+/g, ' ').trim() } : { name: p, type: '?' };
    });
    list.push({
      file: path.relative(ROOT, file),
      name: m[1],
      line: src.slice(0, m.index).split('\n').length,
      params, body,
      bodyStart: braceAt,
    });
  }
  return list;
}

const findings = [];
const all = [];
const helpers = Object.create(null);   // 普通函数名 → 函数体，用于识别"守卫被收敛到 helper 里"的情况

fs.readdirSync(SRC_DIR).filter(n => n.endsWith('.rs')).forEach(n => {
  const raw = fs.readFileSync(path.join(SRC_DIR, n), 'utf8');
  const src = stripComments(raw);
  // 先收集所有 fn（不只是命令）作为 helper 候选
  const fnRe = /\bfn\s+([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\(/g;
  let fm;
  while ((fm = fnRe.exec(src)) !== null) {
    const braceAt = src.indexOf('{', fm.index + fm[0].length);
    if (braceAt < 0) continue;
    helpers[fm[1]] = helpers[fm[1]] || bodyOf(src, braceAt);
  }

  commandsOf(path.join(SRC_DIR, n)).forEach(c => {
    all.push(c);
    c.params.forEach(p => {
      if (!/^String$/.test(p.type) || !PATHISH.test(p.name)) return;
      // 该参数在函数体里出现的位置（去掉其它同名干扰：按单词边界）
      const useRe = new RegExp('\\b' + p.name.replace(/[$]/g, '\\$') + '\\b', 'g');
      const occurrences = (c.body.match(useRe) || []).length;
      if (!occurrences) return;
      const directGuard = GUARDS.some(g => {
        // 守卫必须作用在同一个参数上：`is_plain_filename(&id)` 或 `is_plain_filename(name)`
        const gre = new RegExp(g.replace(/[()]/g, '\\$&') + '[\\s\\S]{0,60}?' + p.name + '\\b');
        return gre.test(c.body) || new RegExp(p.name + '\\b[\\s\\S]{0,60}?' + g.replace(/[()]/g, '\\$&')).test(c.body);
      });
      // 一层调用收敛：参数交给了某个 helper，而该 helper 内部做了文件名净化。
      // 必须确认**这个参数真的作为实参传给了该 helper** —— 否则同文件里任意一个
      // 带守卫的 helper 调用都会把无关路径参数"洗白"（如 sync_set_config(dir) 借 remote_base 放行）。
      let viaHelper = false;
      let helperName = '';
      if (!directGuard) {
        Object.keys(helpers).some(hn => {
          const callRe = new RegExp('\\b' + hn + '\\s*\\(((?:[^()]|\\([^()]*\\))*)\\)', 'g');
          const paramRe = new RegExp('\\b' + p.name.replace(/[$]/g, '\\$') + '\\b');
          let cm, passed = false;
          while ((cm = callRe.exec(c.body))) {
            if (paramRe.test(cm[1])) { passed = true; break; }
          }
          if (!passed) return false;
          if (GUARDS.some(g => helpers[hn].includes(g))) { viaHelper = true; helperName = hn; return true; }
          return false;
        });
      }
      const guarded = directGuard || viaHelper;
      // 落盘判定：函数体直接做文件操作，或把参数交给一个会落盘的 helper
      const directFs = FILE_OPS.some(op => {
        const fre = new RegExp(op.replace(/[()]/g, '\\$&') + '[\\s\\S]{0,80}?' + p.name + '\\b|' + p.name + '\\b[\\s\\S]{0,80}?' + op.replace(/[()]/g, '\\$&'));
        return fre.test(c.body);
      });
      const helperFs = !!helperName && Object.keys(helpers).some(hn =>
        new RegExp('\\b' + hn + '\\s*\\(').test(c.body) && FILE_OPS.some(op => helpers[hn].includes(op)));
      const touchesFs = directFs || helperFs;
      findings.push({
        file: c.file, cmd: c.name, line: c.line,
        param: p.name, type: p.type,
        guarded, viaHelper, helperName, touchesFs,
        severity: (!guarded && touchesFs) ? 'OPEN' : 'OK',
      });
    });
  });
});

const open = findings.filter(f => f.severity === 'OPEN');
const ok = findings.filter(f => f.severity === 'OK');

console.log('Tauri 命令路径参数审计');
console.log('════════════════════════════════════════════════════════════════');
console.log(`命令总数 ${all.length}；字符串型路径参数 ${findings.length} 个；有文件操作但无守卫 ${open.length} 个`);
console.log('');
console.log('★ 无守卫且参与文件操作（可被绝对路径绕过）');
console.log('────────────────────────────────────────────────────────────────');
if (!open.length) console.log('  （无）');
open.forEach(f => {
  console.log(`  ${f.file}:${f.line}  ${f.cmd}(${f.param})`);
});
console.log('');
console.log('已守卫 / 不落盘（供对照）');
console.log('────────────────────────────────────────────────────────────────');
if (!ok.length) console.log('  （无）');
ok.forEach(f => {
  const why = f.guarded ? (f.viaHelper ? '经 ' + f.helperName + ' 净化' : '已守卫') : '未守卫但不落盘';
  console.log(`  ${f.file}:${f.line}  ${f.cmd}(${f.param})  ${why}`);
});

if (process.argv.includes('--json')) {
  fs.writeFileSync(path.join(require('os').tmpdir(), 'ty_paths.json'), JSON.stringify({ all: findings }, null, 2));
  console.log('\nJSON 已写入 ' + path.join(require('os').tmpdir(), 'ty_paths.json'));
}

/* --gate：作为门禁运行时，只要存在「用户可控的路径参数 + 落盘操作 + 无 is_plain_filename 守卫」就失败。
   判据只看 OPEN：已守卫或不落盘的 OK 项不参与（后者本就无害）。
   任一新命令忘了守卫，这里立刻转红 —— 这是 Tauri 侧最危险的一类回归（Path::join 遇绝对路径会丢弃基路径）。 */
if (process.argv.includes('--gate')) {
  if (open.length) {
    console.log('\n✗ 门禁失败：' + open.length + ' 个命令的路径参数无守卫且参与文件操作');
    process.exit(1);
  }
  console.log('\n✓ 通过：全部路径参数已守卫（' + ok.length + ' 个 OK）');
}
