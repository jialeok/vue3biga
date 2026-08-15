import { useAuctionStore } from '../stores/auctionStore.js';
import { state } from '../logic/app-state.js';
        // ============================================================
        // 云同步调试日志：手机上没有控制台，出问题时只能靠这个环形缓冲区
        // 查看。最多保留最近 200 条，每条带时间戳。通过 showDebugLog()
        // 弹出查看（也可在浏览器控制台里调用 window.showDebugLog()）。
        // 用 sessionStorage 持久化：之前是纯内存数组，一刷新（下拉刷新/
        // 切后台太久被系统回收）就清空了，导致"出问题前发生了什么"永远看不到——
        // 而这类 bug 恰恰是在刷新那一刻才暴露出来的，日志必须跨刷新保留。
        // ============================================================
        const _DBG_LOG_KEY = 'jiwang_dbg_log_v1';
        let _dbgLogBuffer = (function() {
            try {
                const saved = sessionStorage.getItem(_DBG_LOG_KEY);
                return saved ? JSON.parse(saved) : [];
            } catch (e) { return []; }
        })();
        // [PERF-CORE] sessionStorage 写入改为 500ms 合批异步落盘。
        let _dbgFlushTimer = null;
        function _getAuctionStore() { try { return useAuctionStore(); } catch { return null; } }
export function _dbgFlushToSession() {
            if (_dbgFlushTimer) return;
            _dbgFlushTimer = setTimeout(function () {
                _dbgFlushTimer = null;
                try { sessionStorage.setItem(_DBG_LOG_KEY, JSON.stringify(_dbgLogBuffer)); } catch (e) {}
            }, 500);
        }
        // 高频调试日志开关：默认关闭。需要排查时在控制台执行 state._DBG_VERBOSE = true。
        let _DBG_VERBOSE = (typeof window !== 'undefined' && state._DBG_VERBOSE) || false;
        export function _dbgLogVerbose(msg) { if (_DBG_VERBOSE) _dbgLog(msg); }
        export function _dbgLog(msg) {
            const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
            const line = '[' + time + '] ' + msg;
            _dbgLogBuffer.push(line);
            if (_dbgLogBuffer.length > 200) _dbgLogBuffer.shift();
            _dbgFlushToSession();
            // [FIX 2026-08-16] §33 性能：移除「每条日志 fetch('/event') 转发调试服务器」遗留实验代码。
            // 该转发让每条 _dbgLog 都发一个网络请求，高频路径（如 loadAllData 500ms 短路日志）下
            // 一次渲染可触发数百条日志 + 数百个 fetch，DevTools 打开时 console.log 同步慢输出
            // 直接卡死主线程（表现为"打开控制台就点不动、关掉才能操作"）。
            // 日志仍完整写入 sessionStorage 环形缓冲（window.showDebugLog() 可查）。
            console.log(line);
        }

        // ============================================================
        // [PERF-DEBUG] Vue 看板性能诊断日志（临时调试用，问题定位后可整块删除）
        // ============================================================
        let _perfPending = [];
        let _perfFrameScheduled = false;
        export function _perfLog(boardName, dataSource, ms) {
            _perfPending.push(boardName + '/' + dataSource + ':' + ms.toFixed(1) + 'ms');
            if (_perfFrameScheduled) return;
            _perfFrameScheduled = true;
            setTimeout(function () {
                _perfFrameScheduled = false;
                const items = _perfPending;
                _perfPending = [];
                if (items.length === 0) return;
                const total = items.reduce(function (sum, s) { return sum + parseFloat(s.split(':')[1]); }, 0);
                _dbgLog('[PERF] 同帧内 computed 重算 x' + items.length + '，合计 ' + total.toFixed(1) + 'ms → ' + items.join(' | '));
            });
        }
        // renderAuction 调用频率计数器
        let _renderAuctionCallCount = 0;
        let _renderAuctionLastLogTs = 0;
        export function _logRenderAuctionCall(caller) {
            _renderAuctionCallCount++;
            const now = performance.now();
            if (now - _renderAuctionLastLogTs > 300) {
                _renderAuctionLastLogTs = now;
                _dbgLog('[PERF] window.renderAuction() 累计调用 ' + _renderAuctionCallCount + ' 次（来源: ' + caller + '），stocksDataVersion=' + (typeof window !== 'undefined' && _getAuctionStore() ? _getAuctionStore().stocksDataVersion : '?'));
            }
        }

        export function getDbgLogBuffer() { return _dbgLogBuffer; }
        export function clearDbgLogBuffer() {
            _dbgLogBuffer.length = 0;
            try { sessionStorage.removeItem(_DBG_LOG_KEY); } catch (e) {}
        }
        export const DBG_LOG_KEY = _DBG_LOG_KEY;

        // 向后兼容：保留 window 挂载（其他未迁移模块仍通过 window.xxx 访问）
        if (typeof window !== 'undefined') {
            state._DBG_LOG_KEY = _DBG_LOG_KEY;
            state._dbgLogBuffer = _dbgLogBuffer;
            state._dbgFlushTimer = _dbgFlushTimer;
            state._DBG_VERBOSE = _DBG_VERBOSE;
            state._perfPending = _perfPending;
            state._perfFrameScheduled = _perfFrameScheduled;
            state._perfLog = _perfLog;
            state._renderAuctionCallCount = _renderAuctionCallCount;
            state._renderAuctionLastLogTs = _renderAuctionLastLogTs;
            state._logRenderAuctionCall = _logRenderAuctionCall;

            state._dbgFlushToSession = _dbgFlushToSession;
        }
