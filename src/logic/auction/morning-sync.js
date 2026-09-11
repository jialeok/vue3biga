// morning-sync.js — 早盘 9:25 自动抓取的「前端自愈」闭环（Logic 层）
//
// 【用户原话】「之前的 9 点 25 分自动抓取数据功能缺失了……我要手动点击连抓五天才可以补全数据」
//
// 【真实链路】9:25 的自动抓取由 Cloudflare worker「bidding-auto-fetch」承担（cron 25 1 * * 2-6）。
// 实测 2026-09-11 它确实写了库：
//   auction_watchlist  created_at = 09:27（北京）
//   market_metrics     created_at = 09:29~09:30
// 也就是说【服务端没坏，坏的是前端拿不到】：
//   ① worker 写完数据大约要 3~5 分钟，若页面在 9:25 前打开，首屏拉取时当天还没有任何行；
//   ② 之后只能靠 Supabase Realtime 推送补齐——但该表是否开启 Realtime 复制无法从代码确认，
//      一旦没开（或频道掉线），用户就永远停在「当天一片空白」，只能手点「连抓五天」。
//
// 【本模块的方案】不依赖 Realtime 的有界自愈，只补这一处缺口：
//   · 触发条件：看板日期 == 系统今天 && 是交易日 && 北京 09:24~09:55
//   · 判定依据：当天内存里「没有任何一行带竞价涨幅 / 竞价量 / 涨幅」= 这批数据还没到
//   · 动作：重拉【当天】的云端数据（1~2 次请求），成功后 emit auction-refresh 让表格重渲染
//   · 停止条件：数据到了且行数连续两次一致（防止 worker 分批改到一半就收手），或窗口结束
//
// 【§17 合规说明】这里不用「随便 setInterval 轮询刷新」掩盖架构问题 —— 轮询窗口被严格限制在
// 早盘那 30 分钟、且每次轮询前先判断「数据是否真的还缺」，一天最多十几次请求，不是常驻心跳。
import { pullAuctionMarketDataForDate } from '../../data/watchlist-and-metrics.js';
import { beijingTodayStr } from './auction-pull-window.js';
import { isTradingDay } from '../date/trading-day-helpers.js';
import { state } from '../app-state.js';
import { _emit } from '../../stores/eventBus.js';
import { _dbgLog } from '../../data/debug-log.js';

/** 自愈窗口起点：worker 实测 9:27~9:30 才写完，留出余量 */
const WINDOW_FROM_MIN = 9 * 60 + 24;
/** 自愈窗口终点：超过则说明当天这批数据不存在（非交易日 / worker 挂了），不再无意义重试 */
const WINDOW_TO_MIN = 9 * 60 + 55;
/** 首次重试间隔 */
const RETRY_MS = 20 * 1000;
/** 拿到数据后的确认间隔（看行数是否还在增长） */
const CONFIRM_MS = 45 * 1000;
/** 收盘时刻（北京 15:00 之后不再做任何早盘补救） */
const CLOSE_HOUR_MIN = 15 * 60;
/** 一轮窗口内最多拉取次数（防止异常情况下无限请求，§32） */
const MAX_PULLS = 12;

let _started = false;
let _timer = null;
let _pullCount = 0;
let _lastRowCount = -1;
let _allowOnce = false;

function _beijingMinutes() {
    const d = new Date();
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    return local.getUTCHours() * 60 + local.getUTCMinutes();
}

function _hasVal(v) {
    return v !== undefined && v !== null && String(v).trim() !== '';
}

/** 当天这批数据是否已经到齐：至少有一行带「竞价涨幅 / 竞价量 / 涨幅」之一 */
export function _todayDataArrived(date) {
    const rows = (state._auctionMemCache && state._auctionMemCache[date]) || [];
    if (rows.length === 0) return false;
    return rows.some(function(r) {
        return r && (_hasVal(r.auc_pct_chg) || _hasVal(r.volume) || _hasVal(r.change_pct));
    });
}

function _schedule(delayMs) {
    if (_timer) clearTimeout(_timer);
    _timer = setTimeout(_tick, delayMs);
}

function _stop(reason) {
    if (_timer) { clearTimeout(_timer); _timer = null; }
    if (reason) _dbgLog('[MORNING-SYNC] 停止：' + reason);
}

async function _tick() {
    _timer = null;
    try {
        const today = beijingTodayStr();
        const mins = _beijingMinutes();
        const allowOnce = _allowOnce;
        _allowOnce = false; // 一次性豁免，用完即失效

        // 窗口外：不再调度（早盘过了就彻底停下来，不留后台心跳）。
        // 唯一例外：启动时的「窗口后一次补救」（_allowOnce），用完即失效。
        if (!allowOnce && (mins < WINDOW_FROM_MIN || mins > WINDOW_TO_MIN)) {
            _stop('已过自愈窗口（' + String(Math.floor(mins / 60)).padStart(2, '0') + ':' + String(mins % 60).padStart(2, '0') + '）');
            return;
        }
        if (!isTradingDay(today)) {
            _stop('非交易日 ' + today);
            return;
        }
        if (_pullCount >= MAX_PULLS) {
            _stop('已达拉取上限，避免无限请求');
            return;
        }

        // 只补「系统今天」——用户正在看历史日期时不打扰
        const date = today;

        if (_todayDataArrived(date)) {
            const rows = (state._auctionMemCache[date] || []).length;
            if (rows === _lastRowCount) {
                _stop('数据已到且行数稳定（' + rows + ' 行）');
                return;
            }
            // 行数还在增长 → worker 可能还在分批写，再确认一次
            _lastRowCount = rows;
            _schedule(CONFIRM_MS);
            return;
        }

        _pullCount++;
        // 单次 + 单日期请求（1 次 watchlist + 1 次 market_metrics + 1 次 hot 回退），不做全表扫描
        let ok = false;
        try {
            await pullAuctionMarketDataForDate(date);
            ok = true;
        } catch (e) {
            _dbgLog('[MORNING-SYNC] 第 ' + _pullCount + " 次补拉失败: " + (e && e.message || e));
        }
        const arrived = _todayDataArrived(date);
        if (arrived) {
            _lastRowCount = (state._auctionMemCache[date] || []).length;
            _emit('auction-refresh');
            _dbgLog('[MORNING-SYNC] 第 ' + _pullCount + ' 次补拉命中，当天 ' + _lastRowCount + ' 行已渲染');
            // 确认一次行数是否还在增长，避免拿到半批数据就收手
            _schedule(CONFIRM_MS);
            return;
        }
        if (ok) {
            _schedule(RETRY_MS);
            return;
        }
        _schedule(RETRY_MS * 2);
    } catch (e) {
        // §10：异常不许静默；窗口内仍可继续下一次尝试
        _dbgLog('[MORNING-SYNC] 自愈异常: ' + (e && e.message || e));
        _schedule(RETRY_MS * 2);
    }
}

/**
 * 启动早盘自愈（幂等，多处调用只生效一次）。
 * 典型调用点：登录成功后（useAppBootstrap#onLoginSuccess）。
 * 若在窗口之前（如 9:10）调用，会自行等到 09:24 才开始，不白跑。
 */
export function startMorningSync() {
    if (_started) return;
    _started = true;

    const today = beijingTodayStr();
    if (!isTradingDay(today)) {
        _dbgLog('[MORNING-SYNC] 非交易日，不启动');
        return;
    }
    const mins = _beijingMinutes();
    if (mins > WINDOW_TO_MIN && mins <= CLOSE_HOUR_MIN) {
        // 页面开在窗口之后（如 10:30）：不轮询，但做【一次】补救拉取 ——
        // 覆盖「worker 迟到」「页面晚开」这两种情况。拿不到就收手，不留心跳。
        if (_todayDataArrived(today)) {
            _dbgLog('[MORNING-SYNC] 当天数据已在内存，无需补救');
            return;
        }
        _dbgLog('[MORNING-SYNC] 已过 9:55 窗口但当天无数据 → 做一次补救拉取');
        _allowOnce = true;
        _schedule(0);
        return;
    }
    if (mins > CLOSE_HOUR_MIN) {
        _dbgLog('[MORNING-SYNC] 已过收盘，不启动早盘自愈');
        return;
    }
    const delayMs = mins < WINDOW_FROM_MIN
        ? (WINDOW_FROM_MIN - mins) * 60 * 1000
        : 0;
    _dbgLog('[MORNING-SYNC] 将在 ' + Math.round(delayMs / 1000) + 's 后开始，窗口 ' +
        Math.floor(WINDOW_FROM_MIN / 60) + ':' + String(WINDOW_FROM_MIN % 60).padStart(2, '0') + ' ~ ' +
        Math.floor(WINDOW_TO_MIN / 60) + ':' + String(WINDOW_TO_MIN % 60).padStart(2, '0'));
    _schedule(delayMs);
}

/** 仅供测试：重置模块状态 */
export function _resetMorningSyncState() {
    if (_timer) { clearTimeout(_timer); _timer = null; }
    _started = false;
    _pullCount = 0;
    _lastRowCount = -1;
    _allowOnce = false;
}
