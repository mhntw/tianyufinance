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

  // 导出成功后提示，并提供「打开文件夹」入口（系统文件管理器打开 exports 目录）
  function toastExported(path) {
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
      box.style.cssText = 'background:#fff;border-radius:10px;max-width:520px;width:90%;box-shadow:0 10px 40px rgba(0,0,0,.25);overflow:hidden;font-size:14px;color:#222;';
      box.innerHTML =
        '<div style="padding:14px 18px;font-weight:600;border-bottom:1px solid #eee;">导出完成</div>' +
        '<div style="padding:18px;word-break:break-all;line-height:1.6;">' +
          '<div style="color:#666;margin-bottom:6px;">文件已保存到：</div>' +
          '<div style="font-family:monospace;font-size:13px;color:#1565c0;background:#e3f2fd;padding:8px 10px;border-radius:6px;">' + escHtml(path) + '</div>' +
        '</div>' +
        '<div style="padding:12px 18px;display:flex;justify-content:flex-end;gap:10px;border-top:1px solid #eee;">' +
          '<button class="kd-export-open" style="padding:7px 16px;border:1px solid #1565c0;background:#1565c0;color:#fff;border-radius:6px;cursor:pointer;font-size:14px;">打开文件夹</button>' +
          '<button class="kd-export-close" style="padding:7px 16px;border:1px solid #ccd;background:#fff;border-radius:6px;cursor:pointer;font-size:14px;">关闭</button>' +
        '</div>';
      overlay.appendChild(box);
      d.body.appendChild(overlay);
      function close() { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }
      box.querySelector('.kd-export-close').onclick = close;
      overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
      box.querySelector('.kd-export-open').onclick = function () {
        close();
        // 打开 exports 所在目录（父目录），跨平台经 Rust open_in_explorer
        var exportsPath = String(path);
        var dir = exportsPath.replace(/\/?[^\/]*$/, ''); // 去掉末尾文件名
        var tauri = global.__TAURI__ && global.__TAURI__.core;
        if (tauri && tauri.invoke) {
          tauri.invoke('open_in_explorer', { path: dir })
            .catch(function (e) { if (typeof showToast === 'function') showToast('打开文件夹失败：' + (e && e.message || e), 'error'); });
        } else if (typeof showToast === 'function') {
          showToast('文件位置：' + dir, 'success');
        }
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
    // 对外暴露唯一正确的 base64 编码实现，供 kdPrint 等复用，避免各处重复实现出错
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
