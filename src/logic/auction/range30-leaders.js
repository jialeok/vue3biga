// range30-leaders.js — 「30日涨幅前五 · 30天补位」的唯一实现（Logic 层，§15 独立业务模块）
//
// ══════════════════════════════════════════════════════════════════════════════════════
// 用户口径（2026-11-18 原话）
// ══════════════════════════════════════════════════════════════════════════════════════
//   「还有要最近多板看板的30日所有的股票，取前五进行补位，标签是30天，这个和20天补的逻辑差不多，
//     你看下怎么实现，可以参考20日补的。」
//
// 【一句话】
//   候选池 = 近 30 个真实交易日里【每一天的早盘竞价正式列表】的并集（= 同花顺「最近多板」883410
//     每天被 worker 拉进来的那批成分股，逐日累积）
//   → 算每只票的 30 日区间涨幅 → 只主板 → 取前五 → 今天列表里没有的，注入独立区块（打「30天」标）。
//
// 【与 range20-leaders.js 的关系：**参考它，但刻意不共用实现**】
//   两者「外表」一样（候选池并集 → 只主板 → 前五 → 注入 + 打标），但三点根本不同：
//     ① 数值算法：30 日 = 期末收盘 / 期初前收盘 − 1 一次性比值（见 range30.js 头注释）；
//        20 日 = 逐日涨幅复利连乘。两条口径混用任何一段代码，日后改其一都会静默改错另一条（§37）。
//     ② 精算通道：30 日走腾讯前复权日线**批量**（`fetchQtDailyBars`，一次一只但并发 4、免费、
//        0 猫抓额度）；20 日走同花顺 K 线 + 库内逐日腿两段式。
//     ③ 结果表：30 日落 `stock_range30_pct`（只 close 口径）；20 日落 `stock_range20_pct`（auc/close 双腿）。
//   ⇒ 共用的只有**纯工具**：交易日窗口、候选池并集、只主板闸门、排名截断、腿表读取（全部是 §6 的
//     「一份实现」而不是「一份业务」）。
//
// 【为什么仍然需要两级筛选（用户要求「高效」）】
//   30 天 × 每天 40~60 只 ≒ 300~500 只去重候选。腾讯是【一只票一个请求】⇒ 全量精算 = 300+ 请求
//   ≈ 1 分钟以上，不可接受。⇒
//     ① 粗筛（0 网络请求）：用 `stock_daily_pct` 逐日腿原料做 30 根复利近似 → 只主板 → 取前 20；
//        该表本来就是回填脚本按同花顺日线灌好的（与 20 日同源），精度足够「挑出可能最强的一批」。
//     ② 精算（≤20 请求，约 3~8 秒）：只对这 20 只跑 `ensureRange30`（与 toggle 共用同一个算子、
//        同一张结果表 §6）→ 用真值重排 → 取前五。
//   ★ 粗筛门槛 `>= 3 根腿`：少于 3 根的是次新股 / 长期停牌，30 日窗口根本算不出来（§10 不补 0）。
//   ★ 粗筛留 20 而不是 5：复利近似与比值真值会有出入，留 4 倍余量吸收误差。
//
// 【额度红线（用户反复强调）】
//   ⛔ 零猫抓额度：只用库内表（Supabase）+ 腾讯日线（免费）。本模块不 import 任何猫抓通道。
//
// 【红线】
//   §10 名册 `null`（还没有结论）与 `[]`（确实没有可补的）语义不同，⛔ 不许用 `|| []` 抹平。
//   §10 算不出 ⇒ 该票不参与排名（⛔ 绝不补 0）；候选池为空（索引未就绪）⇒ **不发布空结论**。
//   §11 与「30日涨幅 toggle」无关：进看板就跑（用户「每天都要检索」），但结果只进独立区块。
//   §19 发布整块替换（date + list + version 一起换），读取方拿到稳定引用。
//   §32 单飞 + 按日期会话缓存；池变大（索引逐步加载）⇒ 作废缓存重算，否则残缺池的结论会被永久缓存。

import { ref } from 'vue';
import { _dbgLog } from '../../data/debug-log.js';
import { readDailyPctRowsFor } from '../../data/stock-daily-pct.js';
import { _getAuctionFormalRowsForDate, _isAuctionWatchlistIndexReady } from '../../data/watchlist-and-metrics.js';
import { isTradingDay } from '../date/trading-day-helpers.js';
import { _getLocalTodayStr } from '../tagTitles/rules.js';
// ── 复用 range20-leaders 的**纯工具**（见文件头「刻意不共用实现」的说明：共用的不是业务口径）
import {
  unionPoolFromDates,
  rankLeaders,
  codeOfRow
} from './range20-leaders.js';
import {
  getRange20WindowDates,
  legs20FromDaily,
  compound20
} from './range20.js';
// ── 30 日自己的算法与结果表
import {
  RANGE30_WINDOW_DAYS,
  RANGE30_MIN_LEGS,
  buildRange30Window,
  ensureRange30,
  getRange30Pct
} from './range30.js';

/** 补位只数（用户：「取前五进行补位」） */
export const RANGE30_LEADER_TOP_N = 5;
/** 粗筛进入精算的只数（留 4 倍余量吸收复利近似误差，把请求数从 300+ 压到 20） */
export const RANGE30_LEADER_PRESELECT = 20;
/**
 * 粗筛门槛：窗口内至少这么多根逐日腿才有资格参与近似排名。
 * ⚠️ 只有 1~2 根腿的票压根算不出 30 日涨幅（多半是次新股），放进精算纯属白烧请求。
 */
export const RANGE30_LEADER_COARSE_MIN_LEGS = 3;

// ===== 状态（模块级 ref，与 range20-leaders / range30 同款范式，§7 不进 Pinia）=====
const _state = ref({ date: '', list: [], ready: false, version: 0 });
/** 内容签名：内容没变就不重复发布（否则每次 bump version 都把整个看板重排一次，§17） */
const _sig = new Map();
/** 单飞：date -> Promise（切日期/重复触发都不并发跑两遍，§32） */
const _inflight = new Map();
/** date -> list（切日期回来直接复原，不再请求，§24） */
const _cache = new Map();
/** date -> 候选池大小（池来自异步分批加载的索引 ⇒ 池变大必须重算） */
const _poolSig = new Map();
/** date 集合：该日结论已发布过（含「算出来 0 只」）—— §10「能不能」与「有没有」是两件事 */
const _verdictDates = new Set();

/** 清空会话缓存（仅供测试 / 换数据源时调用） */
export function clearRange30Leaders() {
  _sig.clear();
  _inflight.clear();
  _cache.clear();
  _poolSig.clear();
  _verdictDates.clear();
  _state.value = { date: '', list: [], ready: false, version: _state.value.version + 1 };
}

/**
 * 读某日的「30日涨幅前五补位」名册。
 *
 * @param {string} date 展示日
 * @returns {Array<{stock:string, code:string, pct:number, days:number}>|null}
 *          null = 该日【还没有结论】（§10：能不能 ≠ 有没有，⛔ 不要拿空数组冒充）
 */
export function getRange30Leaders(date) {
  const d = String(date || '').trim();
  if (!d) return null;
  const cached = _cache.get(d);
  if (Array.isArray(cached)) return cached;
  const s = _state.value;
  if (s.date === d && s.ready) return s.list;
  if (!_verdictDates.has(d)) return null;
  return [];
}

/** 该日【结论到了没有】（true 只表示「来了」，可能是 0 只 —— §10） */
export function hasRange30LeadersVerdict(date) {
  const d = String(date || '').trim();
  return !!d && (_verdictDates.has(d) || (_state.value.date === d && _state.value.ready));
}

/** 增量渲染指纹令牌（异步到货必须让行缓存/视图失效，否则区块不出现或停在上一版） */
export function getRange30LeadersFingerprintToken() {
  const s = _state.value;
  return s.date + '|v' + s.version + '|n' + s.list.length + '|r' + (s.ready ? 1 : 0);
}

/** 发布（内容签名相同 ⇒ 不发布、不 bump version；空结论不进 `_cache`） */
function _publish(date, list) {
  if (date) _verdictDates.add(date);
  const sig = _sigOf(list);
  const prev = _sig.get(date);
  const sameDate = (_state.value.date === date);
  const changed = (prev !== sig);
  if (!changed && sameDate) return _state.value.list;
  _sig.set(date, sig);
  const copy = (list || []).slice();
  // 🔴 空结果【不进】会话缓存（与 range20-leaders#_publish 同一条教训）：
  //   索引未就绪时算出的「0 只」若被缓存，此后每次调用都会早退返回它 ⇒ 整个会话再也补不出票。
  if (copy.length > 0) _cache.set(date, copy);
  _state.value = {
    date: date,
    list: copy,
    ready: true,
    version: changed ? _state.value.version + 1 : _state.value.version
  };
  return copy;
}

function _sigOf(list) {
  if (!list || list.length === 0) return '0';
  return list.length + '|' + list.map(function(r) {
    return r.stock + ':' + (Number(r.pct) || 0).toFixed(4) + ':' + (r.days || 0);
  }).join(',');
}

/** 日期闸门（未来日 / 非交易日 ⇒ 不产出数据） */
function _notTradable(date) {
  const today = _getLocalTodayStr();
  if (today && date > today) return true;
  try {
    return !isTradingDay(date);
  } catch (e) {
    _dbgLog('[RANGE30-TOP5] 交易日历读取失败（放行）: ' + ((e && e.message) || e));
    return false;
  }
}

/** 某日的正式列表建索引（日期 -> 股票名 -> 行）—— 候选池的唯一来源（§6） */
function _formalRowsByDate(dates) {
  const out = new Map();
  for (let i = 0; i < dates.length; i++) {
    const d = dates[i];
    const m = new Map();
    let rows = [];
    try {
      rows = _getAuctionFormalRowsForDate(d) || [];
    } catch (e) {
      _dbgLog('[RANGE30-TOP5] ' + d + ' 正式列表读取失败（按空处理，不影响其它日期）: ' + ((e && e.message) || e));
      rows = [];
    }
    for (let k = 0; k < rows.length; k++) {
      const r = rows[k];
      if (!r || !r.stock) continue;
      const n = String(r.stock).trim();
      if (n && !m.has(n)) m.set(n, r);
    }
    out.set(d, m);
  }
  return out;
}

/**
 * 确保某日的「30日涨幅前五（30天补位）」已就绪（幂等 / 单飞 / 会话缓存）。
 *
 * @param {string} date 展示日 T
 * @param {{force?:boolean}} [opts] force = 用户手动重试（清掉会话缓存重跑）
 * @returns {Promise<Array<{stock:string, code:string, pct:number, days:number}>>}
 */
export async function ensureRange30Leaders(date, opts) {
  const d = String(date || '').trim();
  if (!d) return [];
  if (_notTradable(d)) {
    _publish(d, []);
    return _state.value.list;
  }
  // 窗口：升序 [T-29 ... T]（真实交易日）；探测范围延长到 60 个槽位，
  //   让停牌 / 缺腿的票能往前多回溯几根（与 range20-leaders 的 RANGE20_PROBE_DAYS 同款理由）。
  const probeDates = getRange20WindowDates(d, 60);
  if (probeDates.length === 0) {
    _dbgLog('[RANGE30-TOP5] ' + d + ' 交易日历为空，本次不产出');
    return _state.value.list;
  }
  const win = buildRange30Window(d, RANGE30_WINDOW_DAYS);
  if (!win) {
    _dbgLog('[RANGE30-TOP5] ' + d + ' 窗口构造失败（日历不足），本次不产出');
    return _state.value.list;
  }
  // ★★ [POOL-RANGE 2026-11-18 用户口径] 候选【范围】= 近 30 个交易日名单并集，与「30天」标签一致。
  //   用户原话：「有30天补的标签是三十个交易日内的股票吧？不是像20日补的，范围只有20个交易日，这个你要区分？」
  //   🔴 之前把「探测期」（上面那 60 个槽位）直接当候选范围用了 —— 那是【取腿的回溯深度】
  //   （假期 / 停牌票要多往前够几天才凑得满 30 根腿），不是业务范围。后果：一只 50 个交易日
  //   没进过名单的票照样能被选成「30天补」，与标签说的「近 30 个交易日」不符。
  //   实测（11-18）：近 30 个交易日并集 286 只、近 60 个 479 只 ⇒ 旧口径多出 193 只候选。
  //   ⇒ 候选范围直接取**涨幅窗口那 30 个交易日**（`win.dates`，同一份日历、同一个窗口，§6 不分叉）；
  //     `probeDates`（60）保留给取腿 / 粗筛用。
  const poolDates = win.dates;

  const rowsByDate = _formalRowsByDate(poolDates);
  const pool = unionPoolFromDates(rowsByDate);
  const poolSig = pool.length;

  // 🔴 [RANGE30-POOLGROW] 候选池来自异步分批加载的索引 ⇒ 池变大必须作废缓存重算，
  //   否则第一次那份「只含今天几十行」的残缺池结论会被永久缓存（range20 在 2026-10-20 踩过）。
  const prevPoolSig = _poolSig.get(d);
  if (_cache.has(d) && prevPoolSig !== undefined && poolSig > prevPoolSig) {
    _cache.delete(d);
    _sig.delete(d);
    _dbgLog('[RANGE30-TOP5-POOLGROW] ' + d + ' 候选池 ' + prevPoolSig + ' → ' + poolSig + '：作废缓存重算');
  }
  const force = !!(opts && opts.force);
  if (_cache.has(d) && !force) {
    if (_state.value.date !== d) _publish(d, _cache.get(d));
    return _state.value.list;
  }
  const fly = _inflight.get(d);
  if (fly) return fly;

  const p = (async function() {
    if (pool.length === 0) {
      // §10：索引未就绪 ≠ 没有股票 ⇒ ⛔ 不发布空结论（发布一次就会把「0 只」钉在屏幕上）
      _dbgLog('[RANGE30-TOP5] ' + d + ' 候选池为空（正式列表索引可能未就绪），本次不产出');
      return _state.value.list;
    }

    // ── 阶段① 粗筛（0 网络请求：只读逐日腿原料表）──────────────────────────────
    const poolNames = pool.map(function(t) { return t.stock; });
    let dailyMap = null;
    try {
      dailyMap = await readDailyPctRowsFor(poolNames, probeDates[0], d);
    } catch (e) {
      dailyMap = null;
    }
    if (!dailyMap) {
      // 原料表不可用（未建 / 读失败）⇒ 无法粗筛，⛔ 不能拿「全池 300 只」去烧腾讯请求（§32）
      _dbgLog('[RANGE30-TOP5] ' + d + ' 逐日腿原料表不可用 ⇒ 本次不产出（不拿全池硬算，避免无界请求）');
      return _state.value.list;
    }
    const dailyLegs = legs20FromDaily(pool, probeDates, dailyMap);
    const coarseAllRaw = compound20(dailyLegs, probeDates, { windowDays: RANGE30_WINDOW_DAYS });
    // 🔴 [RANGE30-COARSE-CODE] `compound20` 只产 {stock,pct,days}，**不含 code**；
    //   而「只主板」闸门靠 code 判 ⇒ 不回填会把 300 只候选一刀切光（range20 在 2026-10-20 踩过，
    //   表现成「区块整块消失」而日志里 daysMax 却正常）。code 来自候选池行（同一套解析，§6）。
    const poolCode = new Map();
    pool.forEach(function(t) { if (t && t.stock && t.code) poolCode.set(t.stock, t.code); });
    const coarseAll = coarseAllRaw.map(function(r) {
      return { stock: r.stock, code: poolCode.get(r.stock) || codeOfRow({ stock: r.stock }), pct: r.pct, days: r.days };
    });
    const coarseTop = rankLeaders(coarseAll, {
      limit: RANGE30_LEADER_PRESELECT,
      minDays: RANGE30_LEADER_COARSE_MIN_LEGS,
      mainBoardOnly: true
    });
    _dbgLog('[RANGE30-TOP5] ' + d + ' 候选池=' + pool.length + ' 有腿=' + coarseAll.length
      + ' 进精算=' + coarseTop.length + '（只主板）');
    if (coarseTop.length === 0) {
      _publish(d, []);
      _poolSig.set(d, poolSig);
      return _state.value.list;
    }

    // ── 阶段② 精算（≤20 请求 · 腾讯日线批量）──────────────────────────────────
    // 复用 `ensureRange30`：与「30日涨幅 toggle」同一个算子、同一张结果表（§6 单一真相）。
    // 它内部幂等 + 单飞 + `_tried` 登记 ⇒ 与 toggle 那条链并发时不会打两份请求。
    try {
      await ensureRange30(d, coarseTop, { force: force });
    } catch (e) {
      _dbgLog('[RANGE30-TOP5] ' + d + ' 精算失败，退化为粗筛近似排名: ' + ((e && e.message) || e));
    }
    let truth = null;
    try { truth = getRange30Pct(d); } catch (e) { truth = null; }
    const rankPool = coarseTop.map(function(t) {
      const v = (truth && truth.get(t.stock)) || null;
      if (v && v.pct !== null && v.pct !== undefined && !isNaN(Number(v.pct))) {
        return { stock: t.stock, code: t.code, pct: Number(v.pct), days: Number(v.days) || 0 };
      }
      // §10 如实降级：精算没拿到 ⇒ 用粗筛近似值参与排名（成员仍是全池最强的一批，
      //   ⛔ 不因为「没精算成功」就把强票换成弱票 —— 这正是 range20 在 2026-10-20 的病）。
      return { stock: t.stock, code: t.code, pct: t.pct, days: t.days, approx: true };
    });
    const top = rankLeaders(rankPool, {
      limit: RANGE30_LEADER_TOP_N,
      minDays: RANGE30_MIN_LEGS,
      mainBoardOnly: true
    });
    _dbgLog('[RANGE30-TOP5-PUB] ' + d + ' 真值=' + (truth ? truth.size : 0)
      + ' 前五=' + top.map(function(t) {
        return t.stock + ' ' + Number(t.pct).toFixed(2) + '%/' + t.days + 'd'
          + (rankPool.filter(function(x) { return x.stock === t.stock && x.approx; }).length ? '(近似)' : '');
      }).join(' , '));
    _poolSig.set(d, poolSig);
    _publish(d, top);
    return _state.value.list;
  })().finally(function() {
    if (_inflight.get(d) === p) _inflight.delete(d);
  });
  _inflight.set(d, p);
  return p;
}

/** 诊断出口（只读，不产生任何副作用；供排查「区块为什么不出现」） */
export function inspectRange30LeadersState(date) {
  const d = String(date || '').trim();
  const s = _state.value;
  return {
    stateDate: s.date,
    ready: s.ready,
    version: s.version,
    listLen: s.list.length,
    verdictForDate: !!d && (_verdictDates.has(d) || (s.date === d && s.ready)),
    cachedDates: Array.from(_cache.keys()),
    inflight: Array.from(_inflight.keys()),
    indexReadyDays: getRange20WindowDates(d, 60).reduce(function(a, x) {
      return a + (_isAuctionWatchlistIndexReady(x) ? 1 : 0);
    }, 0)
  };
}
