// boot-phases.js — 首屏「分期」调度的唯一实现（Logic 层，无依赖）
//
// ============================================================================
// 【为什么需要这个模块】§33「首次加载 与 后续刷新 必须分离」
//
// 🔴 改造前的事实（.tmpdiag/pw/perf-timeline.cjs，真实网络，2026-10-31）：
//   一次首屏发出 **90~95 条** Supabase 请求，最后一条在 **+34s** 才结束。
//   其中有一条 **10.7 秒**的写请求（`auction_watchlist?on_conflict=...`）和一片
//   8 页【串行】的全表分页（`auction_data`，+4.2s → +11.8s）——
//   它们全部来自「一次性历史迁移」，与首屏要显示的任何一个数字都无关。
//
//   用户原话：「特别是首次加载时要快，因为早上我不可能等那么长时间，
//             不然竞价时间一过就没法交易了。」
//   竞价窗口只有 9:15~9:25 这 10 分钟，让历史迁移在这种时刻的**关键路径**上排队，
//   属于架构级错误——不是某条 SQL 慢，是**任务分层错了**。
//
// ✅ 本模块提供的分界线（全项目唯一，⛔ 不许在别处再写 setTimeout 排期）：
//
//   · `whenFirstPaint(fn, opts)`  —— 首屏「已经画出东西」之后才执行。
//        判据不是某个固定毫秒数，而是 DOM 事实：`#app` 里已经有元素
//        （＝用户真的看到内容了），再等 2 帧（＝这一次绘制已提交）。
//
//   · `whenIdle(fn, opts)`        —— 首屏画完之后，再等浏览器真正的空闲期
//        （requestIdleCallback）。用于「可以慢、不能抢连接」的补齐 / 迁移。
//
// 【§35 红线】这里**不是**用延迟去掩盖问题：被推迟的任务全部属于
//   「首屏不需要它的结果」这一类（历史迁移、对账、标签清洗、老历史补齐）。
//   凡是首屏要用的数据，一律不许进这两个队列。
//
// 【§10 失败必须可见】回调里的异常会被捕获并记日志，⛔ 不静默吞掉；
//   调度器自身等到超时也会照常执行（宁可晚，不可丢）。
// ============================================================================

/** 首屏已画出内容（#app 有子元素 且 两帧已提交） */
let _firstPaintDone = false;
/** 首屏之后的空闲期已到 */
let _idleDone = false;

/** whenFirstPaint 的回调队列（按注册顺序执行，保证先后关系可预期） */
const _firstPaintQueue = [];
/** whenIdle 的回调队列 */
const _idleQueue = [];

/** 首次绘制等待上限：超过就用「兜底放行」（页面可能被遮罩盖着，但队列不能永远卡住） */
const FIRST_PAINT_MAX_WAIT_MS = 4000;
/** 空闲等待上限：浏览器一直不空闲也必须执行，避免迁移/补齐被永久饿死 */
const IDLE_TIMEOUT_MS = 3000;

const _firstPaintStartAt = Date.now();

// 日志函数由 boot 入口注入（可选）。不在此处 import debug-log，避免 boot 最早期
// 引入链上出现环；不注入时静默，调度行为完全一样。
let _dbgLogRef = null;
/** 由 boot 入口注入日志函数（可选；不注入则静默） */
export function _setBootLog(fn) { _dbgLogRef = fn; }

function _log(msg) {
    try {
        if (typeof _dbgLogRef === 'function') _dbgLogRef(msg);
    } catch (e) { /* 日志失败不影响调度 */ }
}

/** 两帧之后（＝这一次绘制已提交给合成器） */
function _afterTwoFrames(fn) {
    if (typeof requestAnimationFrame !== 'function') { fn(); return; }
    requestAnimationFrame(function () {
        requestAnimationFrame(function () { fn(); });
    });
}

/** DOM 事实判据：#app 里已经有元素（用户确实看到内容了） */
function _hasVisibleContent() {
    try {
        const el = document.getElementById('app');
        return !!(el && el.childElementCount > 0);
    } catch (e) {
        return false;
    }
}

function _flushFirstPaint() {
    if (_firstPaintDone) return;
    _firstPaintDone = true;
    _log('[BOOT-PHASE] 首屏已渲染（用时 ' + (Date.now() - _firstPaintStartAt) + 'ms）⇒ 开始执行 ' +
        _firstPaintQueue.length + ' 个「首屏后」任务');
    const q = _firstPaintQueue.splice(0, _firstPaintQueue.length);
    q.forEach(function (job) {
        try { job(); } catch (e) {
            _log('[BOOT-PHASE] 首屏后任务异常（已隔离，不影响其它任务）: ' + ((e && e.message) || e));
        }
    });
    // 首屏后的任务跑完 ⇒ 再去等空闲期
    _scheduleIdleProbe();
}

function _scheduleIdleProbe() {
    if (_idleDone) return;
    const run = function () {
        if (_idleDone) return;
        _idleDone = true;
        _log('[BOOT-PHASE] 浏览器空闲期已到 ⇒ 开始执行 ' + _idleQueue.length + ' 个「空闲」任务');
        const q = _idleQueue.splice(0, _idleQueue.length);
        q.forEach(function (job) {
            try { job(); } catch (e) {
                _log('[BOOT-PHASE] 空闲任务异常（已隔离）: ' + ((e && e.message) || e));
            }
        });
    };
    if (typeof requestIdleCallback === 'function') {
        try { requestIdleCallback(run, { timeout: IDLE_TIMEOUT_MS }); return; } catch (e) { /* 降级 */ }
    }
    // 不支持 requestIdleCallback（Safari 旧版）：给固定 1.5s 缓冲，不与首屏抢
    setTimeout(run, 1500);
}

// 启动探针：每 120ms 看一眼「#app 是否已经有内容」。命中即结算。
// ⛔ 不是靠猜时间：绝大多数情况下第 1~3 次探测就命中（实测首屏 +1.8s 出元素）。
(function _startProbe() {
    const tick = function () {
        if (_firstPaintDone) return;
        if (_hasVisibleContent() || (Date.now() - _firstPaintStartAt) >= FIRST_PAINT_MAX_WAIT_MS) {
            _afterTwoFrames(_flushFirstPaint);
            return;
        }
        setTimeout(tick, 120);
    };
    if (typeof document !== 'undefined' && document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { setTimeout(tick, 0); }, { once: true });
    } else {
        setTimeout(tick, 0);
    }
})();

/**
 * 首屏「已经画出东西」之后执行。
 *
 * ⚠️ 只有「首屏不需要它的结果」的任务才允许进这里（历史迁移 / 对账 / 标签清洗 /
 *    老历史补齐 / 非关键补充数据）。⛔ 首屏要显示的数字绝不许走这条队列。
 *
 * @param {Function} fn
 * @param {Object} [opts]
 *   · opts.delayMs —— 首屏之后再多等多少毫秒（默认 0）
 *   · opts.name    —— 日志用的任务名
 * @returns {Function} 取消函数（一般不需要；调试 / 组件卸载时可用）
 */
export function whenFirstPaint(fn, opts) {
    const o = opts || {};
    const name = o.name || '(未命名)';
    const delayMs = Math.max(0, Number(o.delayMs) || 0);
    let cancelled = false;
    const job = function () {
        if (cancelled) return;
        const go = function () {
            if (cancelled) return;
            try { fn(); } catch (e) {
                _log('[BOOT-PHASE] ' + name + ' 执行异常: ' + ((e && e.message) || e));
            }
        };
        if (delayMs > 0) setTimeout(go, delayMs);
        else go();
    };
    if (_firstPaintDone) job();
    else _firstPaintQueue.push(job);
    return function () { cancelled = true; };
}

/**
 * 首屏画完之后，再等浏览器真正空闲时才执行（比 whenFirstPaint 更晚、更让路）。
 *
 * @param {Function} fn
 * @param {Object} [opts]
 *   · opts.delayMs —— 空闲之后再多等多少毫秒
 *   · opts.name    —— 日志用的任务名
 * @returns {Function} 取消函数
 */
export function whenIdle(fn, opts) {
    const o = opts || {};
    const name = o.name || '(未命名)';
    const delayMs = Math.max(0, Number(o.delayMs) || 0);
    let cancelled = false;
    const job = function () {
        if (cancelled) return;
        if (delayMs > 0) setTimeout(function () {
            if (cancelled) return;
            try { fn(); } catch (e) {
                _log('[BOOT-PHASE] ' + name + ' 执行异常: ' + ((e && e.message) || e));
            }
        }, delayMs);
        else {
            try { fn(); } catch (e) {
                _log('[BOOT-PHASE] ' + name + ' 执行异常: ' + ((e && e.message) || e));
            }
        }
    };
    if (_idleDone) job();
    else {
        _idleQueue.push(job);
        // 若首屏还没结算，probe 会在结算后自动进入空闲探针
        if (_firstPaintDone) _scheduleIdleProbe();
    }
    return function () { cancelled = true; };
}

/** 仅供诊断 / 测试：首屏是否已结算 */
export function isFirstPaintDone() { return _firstPaintDone; }
/** 仅供诊断 / 测试：空闲期是否已结算 */
export function isIdleDone() { return _idleDone; }
/** 仅供测试：重置调度器状态（⛔ 正常业务流程不要调用） */
export function _resetBootPhasesForTest() {
    _firstPaintDone = false;
    _idleDone = false;
    _firstPaintQueue.length = 0;
    _idleQueue.length = 0;
}
