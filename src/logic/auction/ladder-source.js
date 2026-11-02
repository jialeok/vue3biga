// src/logic/auction/ladder-source.js
// [LADDER-SRC 2026-11-03 用户口径] 「同花顺最近多板」源数据条数 —— 第一页显示，供用户与炒股软件对账。
//
// 用户原话：
//   「你添加下同花顺的接口9点25分最近多板自动获取程序自动拉取的数量是多少，这个才是重点，
//     这样我就能对准炒股软件，看是否正确。就是worker每天9点25分自动拉取那个最近多板数量。
//     这个是源数据。添加一个数量给他」
//
// 【源数据是什么（唯一真相）】
//   cloudflare worker `bidding-auto-fetch` 每天 9:25 第一个请求就是拉同花顺「最近多板」指数
//   883410 的成分股（`data/fuyao-api.js#fetchLadderConstituents` →
//   `/api/a-share-index/constituents/ths-stock-list?thscode=883410.TI`），
//   拿到的条数 = `logs` 里那行「成分股数量: N」。
//   ⚠️ 它与 `auction_watchlist` 行数不是同一个数：worker 会把「前一日名单 ∪ 打标签 ∪ 龙头名册」
//      并入【抓取名单】（constituents），但只把 883410 成分股写进 watchlist。
//      ⇒ 源数据条数是用户唯一能与同花顺软件「最近多板」列表直接对上的数字。
//
// 【数据从哪读】不新增任何请求通道：复用 `data/fetch-log.js#fetchMorningFetchLog`（已有的
//   `bidding_fetch_log` 只读入口 + 60s 缓存 + 单飞）。detail 里两种形态都认：
//     ① 结构化字段 `detail.ladderCount`（新 worker 写入，优先）
//     ② 老日志兜底：`detail.logs` 里的「成分股数量: N」行（历史落库记录都在，无需重跑 worker）
//   ⛔ 不读 auction_watchlist 行数来「推算」—— 那是另一个口径（见上），推算就是第二把尺子。
//
// 【§10 三段式】宁可显示 `--`，也不显示一个编出来的数：
//   · 读日志抛错            → status='error'   （不知道，不说 0）
//   · 没有 morning 记录     → status='empty'   （那天的抓取没跑）
//   · 有记录但降级运行      → status='degraded'（名单源不可用，条数无意义）
//   · 有记录但两种形态都没有→ status='none'    （老日志没写这行）
//   · 拿到条数              → status='ready'
import { ref } from 'vue';
import { fetchMorningFetchLog } from '../../data/fetch-log.js';
import { beijingTodayStr } from './auction-pull-window.js';
import { _dbgLog } from '../../data/debug-log.js';

/** 与 UI 约定的空态（形状唯一，⛔ 别在别处手写字面量） */
const EMPTY_INFO = {
  date: '', status: 'idle', count: null, degraded: false, via: '', at: '', text: ''
};

/** 状态容器：ref ⇒ 到货后所有读它的 computed 自动更新（与 dragon-group / suspend 同款模式） */
const _state = ref(Object.assign({}, EMPTY_INFO));

/** 每个日期最多多久重试一次（今天还没记录时靠它节流；timer 20s 一跳也不会打爆） */
const RETRY_MS = 12 * 1000;
const _lastTry = new Map();   // date -> ts
const _inflight = new Map();  // date -> Promise

/** 仅供测试 / 诊断：重置模块内状态与缓存 */
export function _resetLadderSourceForTest() {
  _state.value = Object.assign({}, EMPTY_INFO);
  _lastTry.clear();
  _inflight.clear();
}

/**
 * 从 `bidding_fetch_log.detail` 里取出「最近多板成分股条数」。
 *
 * 纯函数（⛔ 无 IO、无 Vue 依赖）⇒ 可单测。
 *
 * 判定顺序（先结构化、再老日志，⛔ 不反过来：日志是给人看的字符串，随时可能被改文案）：
 *   ① detail.ladderDegraded === true → 条数无意义（名单源不可用）⇒ count=null / degraded=true
 *   ② detail.ladderCount 是有限非负数 → 用它（via='field'）
 *   ③ 从 detail.logs 找「成分股数量: N」→ 用它（via='log'）
 *   ④ 都没有 → count=null（via='none'）
 *
 * @param {object} detail `bidding_fetch_log.detail`（JSONB）
 * @returns {{count:number|null, via:string, degraded:boolean}}
 */
export function extractLadderCount(detail) {
  const none = { count: null, via: 'none', degraded: false };
  if (!detail || typeof detail !== 'object') return none;

  // ① 降级运行：本轮 883410 拿不到，条数是 0 但那是"没抓到"而不是"只有 0 只"
  if (detail.ladderDegraded === true) return { count: null, via: '', degraded: true };

  // ② 结构化字段（新 worker 写入；也接受字符串数字，历史 JSONB 手工修正时可能出现）
  const raw = detail.ladderCount;
  if (raw !== undefined && raw !== null && raw !== '') {
    const n = Number(raw);
    if (isFinite(n) && n >= 0) return { count: Math.floor(n), via: 'field', degraded: false };
  }

  // ③ 老日志兜底：worker 一直都会 push('成分股数量: N' + 可能跟一个降级后缀)
  const logs = Array.isArray(detail.logs) ? detail.logs : [];
  for (let i = 0; i < logs.length; i++) {
    const line = String(logs[i] || '');
    // 只要「成分股数量: 56」这种以数字开头的一行；后面的「（⬇️ 降级模式…）」不影响取值
    const m = line.match(/成分股数量[:：]\s*(\d+)/);
    if (m) return { count: Number(m[1]), via: 'log', degraded: false };
  }

  return none;
}

/**
 * 把「日志行」整理成 UI 可直接渲染的信息（status / count / 一句说明）。
 * 纯函数，⛔ 无 IO ⇒ 可单测。
 *
 * @param {Array<object>} rows fetchMorningFetchLog 的返回（最多 1 条，最新一条）
 * @param {string} date 展示日
 * @returns {{date:string,status:string,count:number|null,degraded:boolean,via:string,at:string,text:string}}
 */
export function buildLadderSourceInfo(rows, date) {
  const base = Object.assign({}, EMPTY_INFO, { date: date || '' });
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) {
    // 没有任何 morning 记录 ⇒ 那天的抓取没跑（§10：与"读失败"严格区分）
    return Object.assign(base, { status: 'empty', text: '当天没有自动抓取记录（9:25 那一轮没跑）' });
  }
  const row = list[0] || {};
  const detail = row.detail || {};
  const got = extractLadderCount(detail);
  if (got.degraded) {
    return Object.assign(base, {
      status: 'degraded', degraded: true,
      text: '当天名单源（同花顺最近多板 883410）不可用，条数无意义'
    });
  }
  if (got.count === null) {
    return Object.assign(base, {
      status: 'none',
      text: '抓取记录里没有「成分股数量」这一项（旧版 worker 没记）'
    });
  }
  return Object.assign(base, {
    status: 'ready',
    count: got.count,
    via: got.via,
    at: row.created_at || '',
    text: 'worker 9:25 从同花顺「最近多板」(883410) 拉到的源数据条数'
  });
}

/**
 * 同步读取某日的源数据信息（视图层/computed 用；不触发任何请求）。
 * ⚠️ 未加载过 / 日期不匹配 ⇒ status='idle'、count=null（§10：未知就是未知）。
 * @param {string} date
 */
export function getLadderSourceInfo(date) {
  const s = _state.value;
  if (!date || s.date !== date) return Object.assign({}, EMPTY_INFO, { date: date || '' });
  return s;
}

/**
 * 确保某日的源数据条数已读取（单飞 + 按状态节流）。
 *
 * 为什么要节流：界面在 9:25 前就被打开是常态，那时 worker 还没写日志 ⇒ 必须能"到点了自己变"。
 * 节流规则（⛔ 不是 setTimeout 掩盖问题，是明确的轮询边界）：
 *   · 已拿到（ready）⇒ 直接返回，**永不再请求**
 *   · 非今天 ⇒ 只尝试一次（历史日志不会再新增）
 *   · 今天 + empty/error ⇒ 每次调用都重试，但同一日期 12s 内不重复发
 *
 * @param {string} date YYYY-MM-DD
 * @param {{force?:boolean}} [opts]
 */
export async function ensureLadderSource(date, opts) {
  if (!date) return getLadderSourceInfo(date);
  const cur = _state.value;
  const force = !!(opts && opts.force);
  if (!force && cur.date === date && cur.status === 'ready') return cur;

  const isToday = date === beijingTodayStr();
  const last = _lastTry.get(date) || 0;
  if (!force) {
    // 历史日只试一次；今天按 RETRY_MS 节流
    if (!isToday && last > 0) return getLadderSourceInfo(date);
    if (isToday && (Date.now() - last) < RETRY_MS) return getLadderSourceInfo(date);
  }
  const fly = _inflight.get(date);
  if (fly) return fly;

  // 先把 state 标成 loading（同一天才改，避免把别的日期的已就绪状态覆盖掉）
  if (cur.date !== date) _state.value = Object.assign({}, EMPTY_INFO, { date, status: 'loading' });
  else if (cur.status !== 'ready') _state.value = Object.assign({}, cur, { status: 'loading' });

  const p = (async function() {
    _lastTry.set(date, Date.now());
    let rows;
    try {
      rows = await fetchMorningFetchLog(date);
    } catch (e) {
      // §10：读失败 ≠ 没有记录 ⇒ 状态单独一档，⛔ 不当成 0 只
      const info = Object.assign({}, EMPTY_INFO, {
        date, status: 'error', text: '抓取日志读取失败：' + ((e && e.message) || e)
      });
      if (_state.value.date === date) _state.value = info;
      _dbgLog('[LADDER-SRC] 读 bidding_fetch_log 失败: ' + ((e && e.message) || e));
      return info;
    } finally {
      _inflight.delete(date);
    }
    const info = buildLadderSourceInfo(rows, date);
    // 只写「当前正在看的那一天」：异步回来时用户可能已经翻到别的日期了
    if (_state.value.date === date) _state.value = info;
    return info;
  })();
  _inflight.set(date, p);
  return p;
}
