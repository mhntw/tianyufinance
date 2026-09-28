/* 文件导出桥接：统一 Excel/CSV 导出到用户目录，兼容 Tauri 与浏览器。
 *
 * 为什么需要：浏览器里 XLSX.writeFile / Blob+a.click() 走的是浏览器下载机制，
 * 在 Tauri webview 下路径不可控、常常静默失败（文件下到未知位置或根本不出现）。
 * 本桥接在 Tauri 下改用 invoke('save_export_file', {name, base64}) 由 Rust 写入
 *   <应用数据目录>/添钰财务/exports/
 * 浏览器（无 __TAURI__）下回退到原生下载，保证 dev 兼容。
 *
 * 依赖（全局已加载）：XLSX（SheetJS）。showToast 由调用方自行处理提示。
 */
(function (global) {
  'use strict';

  function getInvoke() {
    var t = global.__TAURI__ && global.__TAURI__.core;
    return (t && t.invoke) ? t.invoke : null;
  }

  // XLSX.write 的 array 输出是 ArrayBuffer；转成 Uint8Array 交给 invoke
  function arrayBufferToUint8(arrbuf) {
    return new Uint8Array(arrbuf);
  }

  // 把 Uint8Array 编码成 base64 字符串（Tauri 端 base64::decode 还原）。
  // 用 base64 传参而非直接传 Vec<u8>，绕开 Tauri IPC 对二进制参数的序列化限制，最稳。
  function bytesToBase64(u8) {
    var bin = '';
    var chunk = 0x8000; // 分块避免 call stack 溢出（大文件）
    for (var i = 0; i < u8.length; i += chunk) {
      bin += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  // 浏览器回退：用 Blob + a.download 触发下载
  function browserDownload(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  // 保存 Excel 工作簿。wb: XLSX workbook；filename: 不含扩展名的文件名（自动补 .xlsx）
  function saveExcel(wb, filename) {
    return new Promise(function (resolve, reject) {
      try {
        var name = (filename || '导出') + '.xlsx';
        var invoke = getInvoke();
        if (!invoke) {
          // 非 Tauri：浏览器原生下载
          XLSX.writeFile(wb, name);
          return resolve(null);
        }
        if (typeof XLSX === 'undefined') return reject(new Error('XLSX 未加载'));
        var out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
        var u8 = arrayBufferToUint8(out);
        invoke('save_export_file', { name: name, base64: bytesToBase64(u8) })
          .then(resolve)
          .catch(reject);
      } catch (e) {
        reject(e);
      }
    });
  }

  // 保存 CSV/文本。content: 字符串；filename: 完整文件名（含扩展名）
  function saveText(content, filename) {
    return new Promise(function (resolve, reject) {
      try {
        var invoke = getInvoke();
        if (!invoke) {
          browserDownload(new Blob([content], { type: 'text/csv;charset=utf-8;' }), filename);
          return resolve(null);
        }
        var u8 = new Uint8Array(new TextEncoder().encode(content));
        invoke('save_export_file', { name: filename, base64: bytesToBase64(u8) })
          .then(resolve)
          .catch(reject);
      } catch (e) {
        reject(e);
      }
    });
  }

  // 导出成功后提示，并提供「在文件夹中显示」入口（在系统文件管理器里定位并选中刚导出的文件）
  // opts（可选）：
  //   desc     路径上方那行说明，默认「文件已保存到：」
  //   select   要定位并选中的文件**绝对路径数组**；多文件会一次全部选中（各平台实现都支持多选）。
  //            不传时默认把 path 当作单个文件（单文件导出的场景）。
  //            账套导出是多文件、且 path 传的是目录，故必须显式给 select。
  //   openPath 定位失败时兜底要打开的**目录**；默认取 path 的父目录。
  //            ⚠ 账套导出传进来的是**目录本身**，必须显式给 openPath，
  //            否则会被当文件名切掉最后一段、打开到上一级。
  function toastExported(path, opts) {
    var o = opts || {};
    if (!path) {
      if (typeof showToast === 'function') showToast('导出完成', 'success');
      else alert('导出完成');
      return;
    }
    // 展示带「打开文件夹」按钮的结果浮层，替代纯文本 toast，让用户能一键到达文件位置
    try {
      var d = document;
      var overlay = d.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;z-index:2147483646;';
      var box = d.createElement('div');
      box.style.cssText = 'background:#fff;border-radius:10px;max-width:520px;width:90%;box-shadow:0 10px 40px rgba(0,0,0,.25);overflow:hidden;font-size:var(--fs-md);color:#222;';
      box.innerHTML =
        '<div style="padding:14px 18px;font-weight:600;border-bottom:1px solid #eee;">导出完成</div>' +
        '<div style="padding:18px;word-break:break-all;line-height:1.6;">' +
          '<div style="color:#666;margin-bottom:6px;">' + escHtml(o.desc || '文件已保存到：') + '</div>' +
          '<div style="font-family:monospace;font-size:var(--fs-sm);color:#1565c0;background:#e3f2fd;padding:8px 10px;border-radius:6px;">' + escHtml(path) + '</div>' +
        '</div>' +
        '<div style="padding:12px 18px;display:flex;justify-content:flex-end;gap:10px;border-top:1px solid #eee;">' +
          '<button class="ty-export-open" style="padding:7px 16px;border:1px solid #1565c0;background:#1565c0;color:#fff;border-radius:6px;cursor:pointer;font-size:var(--fs-md);">在文件夹中显示</button>' +
          '<button class="ty-export-close" style="padding:7px 16px;border:1px solid #ccd;background:#fff;border-radius:6px;cursor:pointer;font-size:var(--fs-md);">关闭</button>' +
        '</div>';
      overlay.appendChild(box);
      d.body.appendChild(overlay);
      function close() { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }
      box.querySelector('.ty-export-close').onclick = close;
      overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
      box.querySelector('.ty-export-open').onclick = function () {
        close();
        var exportsPath = String(path);
        // 跨平台切出父目录：Windows 路径用反斜杠 \，macOS/Linux 用 /，
        // 故同时匹配两种分隔符，避免 Windows 下把整条路径当文件名切掉导致打开失败。
        // 调用方给了 openPath 就直接用它 —— 账套导出传的是目录本身，不能再往上切一级。
        var dir = o.openPath || exportsPath.replace(/[\\/][^\\/]*$/, ''); // 去掉末尾文件名
        // 本次要定位选中的文件：调用方给了 select 就用它；否则 path 本身即文件（单文件导出）
        var files = (o.select && o.select.length) ? o.select.slice() : (o.openPath ? [] : [exportsPath]);
        var tauri = global.__TAURI__ && global.__TAURI__.core;
        if (!tauri || !tauri.invoke) {
          if (typeof showToast === 'function') showToast('文件位置：' + (dir || exportsPath), 'success');
          return;
        }
        // 兜底：只打开目录（不选中文件）。极端路径切不出父目录时改为直接展示位置，避免「路径为空」死提示
        function openDirOnly() {
          if (!dir) {
            if (typeof showToast === 'function') showToast('文件位置：' + exportsPath, 'success', 4000);
            return;
          }
          tauri.invoke('open_in_explorer', { path: dir })
            .catch(function (e) { if (typeof showToast === 'function') showToast('打开文件夹失败：' + (e && e.message || e), 'error'); });
        }
        if (!files.length) return openDirOnly();
        /* 首选 opener 插件的原生「在文件管理器中定位并选中」：
             macOS = NSWorkspace.activateFileViewerSelectingURLs、Windows = SHOpenFolderAndSelectItems、
             Linux = org.freedesktop.FileManager1 —— 三平台**都支持一次选中多个文件**，
             正好对上「一次导出多个账套」的场景（旧写法 open_in_explorer 只打开目录、不选中任何文件，
             用户面对一目录几十个文件根本认不出哪几个是刚导出的）。
           该命令不做 scope 校验，权限由默认能力 opener:default 授予，故无需改 Rust 或权限配置。
           旧构建若没有这个命令会 reject，catch 后回落到 openDirOnly，行为不退化。 */
        tauri.invoke('plugin:opener|reveal_item_in_dir', { paths: files })
          .catch(openDirOnly);
      };
    } catch (e) {
      // 浮层构建失败兜底：退回 toast
      if (typeof showToast === 'function') showToast('已导出到：' + path, 'success', 4000);
    }
  }

  function escHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  global.__fileSaveBridge = {
    saveExcel: saveExcel,
    saveText: saveText,
    toastExported: toastExported,
    // 对外暴露唯一正确的 base64 编码实现，供 tyPrint 等复用，避免各处重复实现出错
    bytesToBase64: bytesToBase64
  };

  // —— 安全包装：供各页面导出按钮直接调用，任何异常都显式提示，杜绝「静默无反应」 ——
  // 用法：__safeExportExcel(wb, '固定资产卡片_2026-08')  /  __safeExportCsv(csvText, '报表.csv')
  function failToast(msg) {
    console.error('[export]', msg);
    if (typeof showToast === 'function') {
      try { showToast(msg, 'error'); return; } catch (e) {}
    }
    // 兜底：确保用户一定能看到失败原因
    alert(msg);
  }

  global.__safeExportExcel = function (wb, name) {
    try {
      if (!global.__fileSaveBridge) { failToast('导出模块未加载(__fileSaveBridge 缺失)'); return; }
      return global.__fileSaveBridge.saveExcel(wb, name)
        .then(function (p) { global.__fileSaveBridge.toastExported(p); })
        .catch(function (e) { failToast('导出失败：' + (e && e.message || e)); });
    } catch (e) {
      failToast('导出失败：' + (e && e.message || e));
    }
  };
  global.__safeExportCsv = function (content, filename) {
    try {
      if (!global.__fileSaveBridge) { failToast('导出模块未加载(__fileSaveBridge 缺失)'); return; }
      return global.__fileSaveBridge.saveText(content, filename)
        .then(function (p) { global.__fileSaveBridge.toastExported(p); })
        .catch(function (e) { failToast('导出失败：' + (e && e.message || e)); });
    } catch (e) {
      failToast('导出失败：' + (e && e.message || e));
    }
  };
})(window);
