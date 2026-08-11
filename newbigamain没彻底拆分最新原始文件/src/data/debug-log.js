        // ============================================================
        // ============================================================
        // 云同步调试日志：手机上没有控制台，出问题时只能靠这个环形缓冲区
        // 查看。最多保留最近 200 条，每条带时间戳。通过 showDebugLog()
        // 弹出查看（也可在浏览器控制台里调用 window.showDebugLog()）。
        // 用 sessionStorage 持久化：之前是纯内存数组，一刷新（下拉刷新/
        // 切后台太久被系统回收）就清空了，导致"出问题前发生了什么"永远看不到——
        // 而这类 bug 恰恰是在刷新那一刻才暴露出来的，日志必须跨刷新保留。
        // ============================================================
        window._DBG_LOG_KEY = 'jiwang_dbg_log_v1';
        window._dbgLogBuffer = (function() {
            try {
                const saved = sessionStorage.getItem(window._DBG_LOG_KEY);
                return saved ? JSON.parse(saved) : [];
            } catch (e) { return []; }
        })();
        // [PERF-CORE] sessionStorage 写入改为 500ms 合批异步落盘。
        // 原实现每打一条日志就 JSON.stringify + 同步写 sessionStorage（单次数 ms，
        // 高峰期一帧几十上百条日志——EXPAND 每行一条、RANK-CACHE 每次计算两条），
        // 日志本身成了卡顿来源。内存 buffer 照旧，落盘合并为静默后台动作。
        window._dbgFlushTimer = null;
        export function _dbgFlushToSession() {
            if (window._dbgFlushTimer) return;
            window._dbgFlushTimer = setTimeout(function () {
                window._dbgFlushTimer = null;
                try { sessionStorage.setItem(window._DBG_LOG_KEY, JSON.stringify(window._dbgLogBuffer)); } catch (e) {}
            }, 500);
        }
        // 高频调试日志开关：默认关闭。需要排查时在控制台执行 window._DBG_VERBOSE = true。
        window._DBG_VERBOSE = window._DBG_VERBOSE || false;
        export function _dbgLogVerbose(msg) { if (window._DBG_VERBOSE) _dbgLog(msg); }
        export function _dbgLog(msg) {
            const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
            const line = '[' + time + '] ' + msg;
            window._dbgLogBuffer.push(line);
            if (window._dbgLogBuffer.length > 200) window._dbgLogBuffer.shift();
            window._dbgFlushToSession();
            console.log(line);
            // #region debug-point Z:forward-to-debug-server
            try {
                window._debugServerQueue = window._debugServerQueue || [];
                window._debugServerQueue.push({ sessionId: 'auction-cross-date-leak', runId: 'post-fix', hypothesisId: 'Z', location: location.href, msg: line, ts: Date.now() });
                if (!window._debugServerTimer) {
                    window._debugServerTimer = setInterval(function () {
                        if (!window._debugServerQueue || !window._debugServerQueue.length) return;
                        var batch = window._debugServerQueue.splice(0, window._debugServerQueue.length);
                        fetch('/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(batch.length === 1 ? batch[0] : batch), keepalive: true }).catch(function () {});
                    }, 500);
                }
            } catch (e) {}
            // #endregion
        }

        // ============================================================
        // [PERF-DEBUG] Vue 看板性能诊断日志（临时调试用，问题定位后可整块删除）
        // ------------------------------------------------------------
        // 诊断目标：验证"一次交互 → renderAuction 触发 stocksDataVersion++ →
        // 四块看板 computed 全部失效重算"的猜想，并量化每块的重算耗时。
        // 用 requestAnimationFrame 把同一帧内的多次 computed 重算聚合成一条
        // 日志，这样能直接看到"4 块是否总在同一帧里一起重算"。
        // ============================================================
        window._perfPending = window._perfPending || [];
        window._perfFrameScheduled = false;
        window._perfLog = function (boardName, dataSource, ms) {
            window._perfPending.push(boardName + '/' + dataSource + ':' + ms.toFixed(1) + 'ms');
            if (window._perfFrameScheduled) return;
            window._perfFrameScheduled = true;
            setTimeout(function () {
                window._perfFrameScheduled = false;
                const items = window._perfPending;
                window._perfPending = [];
                if (items.length === 0) return;
                const total = items.reduce(function (sum, s) { return sum + parseFloat(s.split(':')[1]); }, 0);
                window._dbgLog('[PERF] 同帧内 computed 重算 x' + items.length + '，合计 ' + total.toFixed(1) + 'ms → ' + items.join(' | '));
            });
        };
        // renderAuction 调用频率计数器：每次 stocksDataVersion++ 都会强制让
        // 四块看板的 computed 在下次访问时重新判定为脏，用它来看交互频率
        // 是否远高于"真正需要重算"的频率。
        window._renderAuctionCallCount = 0;
        window._renderAuctionLastLogTs = 0;
        window._logRenderAuctionCall = function (caller) {
            window._renderAuctionCallCount++;
            const now = performance.now();
            // 频率太高时不是每次都打日志（避免日志本身拖慢速度），改为按 300ms 节流汇总
            if (now - window._renderAuctionLastLogTs > 300) {
                window._renderAuctionLastLogTs = now;
                window._dbgLog('[PERF] window.renderAuction() 累计调用 ' + window._renderAuctionCallCount + ' 次（来源: ' + caller + '），stocksDataVersion=' + (window.auctionStore ? window.auctionStore.stocksDataVersion : '?'));
            }
        };
