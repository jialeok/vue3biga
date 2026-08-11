        export function showDebugLog() {
            const lines = window._dbgLogBuffer.length ? window._dbgLogBuffer.join('\n') : '（暂无调试日志）';
            const overlay = document.createElement('div');
            overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px;';
            overlay.onclick = function(e) { if (e.target === overlay) overlay.remove(); };
            overlay.innerHTML = `
                <div style="background:#111827;color:#d1fae5;border-radius:12px;max-width:100%;width:100%;max-height:80vh;display:flex;flex-direction:column;font-family:monospace;">
                    <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid #374151;">
                        <span style="color:#fff;font-weight:600;">同步调试日志</span>
                        <div>
                            <button id="_dbgLogCopyBtn" style="margin-right:8px;background:#059669;color:#fff;border:none;border-radius:6px;padding:6px 10px;font-size:12px;">复制</button>
                            <button id="_dbgLogClearBtn" style="margin-right:8px;background:#b91c1c;color:#fff;border:none;border-radius:6px;padding:6px 10px;font-size:12px;">清空</button>
                            <button id="_dbgLogCloseBtn" style="background:#374151;color:#fff;border:none;border-radius:6px;padding:6px 10px;font-size:12px;">关闭</button>
                        </div>
                    </div>
                    <pre style="margin:0;padding:12px 16px;overflow:auto;white-space:pre-wrap;word-break:break-all;font-size:11px;line-height:1.5;">${lines.replace(/</g, '&lt;')}</pre>
                </div>
            `;
            document.body.appendChild(overlay);
            document.getElementById('_dbgLogCloseBtn').onclick = function() { overlay.remove(); };
            document.getElementById('_dbgLogCopyBtn').onclick = function() {
                navigator.clipboard && navigator.clipboard.writeText(lines).then(function() {
                    window.showToast('✅ 已复制调试日志');
                }).catch(function() {});
            };
            document.getElementById('_dbgLogClearBtn').onclick = function() {
                window._dbgLogBuffer = [];
                try { sessionStorage.removeItem(window._DBG_LOG_KEY); } catch (e) {}
                overlay.remove();
                window.showToast('已清空调试日志');
            };
        }
        window.showDebugLog = window.showDebugLog;
