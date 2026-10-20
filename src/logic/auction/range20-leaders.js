// range20-leaders.js — 「20日涨幅前五 · 龙头补位」的唯一实现（Logic 层，§15 独立业务模块）
//
// ===== 产品口径（2026-10-19 用户原话）=====
//   「当天我怕错过一些不在正式列表的市场龙头……我想要的是这20天来的股票数据，就是每天的早盘竞价
//    所有股票。比如你可以做一个检查机制，只筛选出20日涨幅排前五的，放到龙头组，进行叠加，这样就不会
//    错过。比如今天的九阳股份，如果它不是继承上交易的龙头组，就消失了，我就看不见了……
//    如果消失了，我看这个20天涨幅就没多大意义，就不准确。」
//   「如果这五只也在当天列表中，那就不用重复补了……如果比如五只有三只不在当天列表中，要自动补上去，
//    补到龙头组。……要区分，就在后面添加标签"20天"……你可以新建一个小组件给它们，这样就不会乱。」
//   「注意科创板，创业板，北交所等非主板的股票不要算进去。」
//   「你补的时候注意，不要消耗的猫爪数据接口额度，非常重要。你可以用同花顺接口。」
//
// ===== 一句话 =====
//   候选池 = 近 20 个真实交易日里【每一天的早盘竞价正式列表】的并集（不是当天列表！）
//   → 算每只票的 20 日区间涨幅 → 只主板 → 取前五 → 当天列表里没有的，注入一个独立区块（打「20天」标）。
//
// ===== 为什么不能只算当天列表（本需求的立身之本）=====
//   当天正式列表是 9:25 抓的「今天上榜」名单。一只票只要今天没被选进名单，它在看板上就【根本不存在】——
//   哪怕它这 20 天涨了 180%。用户的原话「如果消失了，我看这个20天涨幅就没多大意义」说的就是这个。
//   ⇒ 候选池必须回到【历史每天的列表】，这是本模块与 range20.js（只算屏幕上已有行）的本质区别。
//
// ===== 高效怎么做到（用户明确要求「想出一个高效的方法，只选出 5 只」）=====
//   20 天 × 每天 30~60 只 ≒ 200~250 只去重后候选。同花顺 K 线是【单票一请求、并发 3】，
//   全量补 = 200+ 请求 ≈ 3 分钟，不可接受。⇒ 两级筛选：
//     ① 粗筛（0 请求，纯内存）：库内逐日行算区间涨幅，只在「窗口内上榜 >= RANGE20_LEADER_MIN_LEGS 天」
//        的主板票里按降序取前 RANGE20_LEADER_PRESELECT 只。
//     ② 精算（<=25 请求，约 15~40 秒）：只对这 25 只补满 20 天 K 线 → 重算 → 取前 5。
//   ★ 粗筛门槛为什么是「>= 6 天在名单里」：少于 6 天的票，20 天里有 14 天以上根本没在竞价体系里出现过，
//     它连「每天的早盘竞价列表」都算不上成员，算出来的也不是 20 日涨幅（而是那两三天的涨幅）。
//     ⛔ 绝不给缺的天补 0 凑数（§10：缺数据 ≠ 0%），而是【如实不参与】，并在诊断日志里记数量。
//   ★ 粗筛留 25 而不是 5：粗筛用的是「库内腿」（可能只有 14 天）+ 门槛过滤，与精算结果会有出入，
//     留 5 倍余量吸收这个误差。请求数从 200+ 降到 25，是本题的关键取舍。
//
// ===== 额度红线（用户特别强调）=====
//   ⛔ 不用猫抓 `daily`（每日 10 次额度）。只用：① 库内行（Supabase，0 额度）；
//   ② 同花顺 K 线（免费，见 data/stock-range-pct.js#fetchFuyaoDailyPctRange）。本模块【零猫抓】。
//
// ===== 不落库（同 range20.js 的理由）=====
//   `stock_range_pct` 主键 (date, stock) 且 days 列现值只有 10/8/9/7/6 ⇒ 写 20 日行会覆盖当天的
//   10 日行，污染十日涨幅 / 题材龙位 / 决策看板。⇒ 结果只放会话内存（date 键控）。

import { ref } from 'vue';
import { getStockCode } from '../../data/stock-code-map.js';
import { _getAuctionFormalRowsForDate } from '../../data/watchlist-and-metrics.js';
import { fetchFuyaoDailyPctRange } from '../../data/stock-range-pct.js';
// [R20-CLOUD 2026-10-20] 与主 toggle 共用同一张结果表（stock_range20_pct）⇒ 谁先算谁落库、另一方 0 请求复用
import { readRange20Rows, pickUsableRows, upsertRange20Rows } from '../../data/stock-range20-cache.js';
import { _dbgLog } from '../../data/debug-log.js';
import { getBoardKind, BOARD_MAIN, BOARD_BJ, BOARD_GROWTH, BOARD_STAR } from './limit-up.js';
import { _getLocalTodayStr } from '../tagTitles/rules.js';
import { ensureAuctionCodeMapping } from './auction-fetch-helpers.js';
import { isTradingDay } from '../date/trading-day-helpers.js';
import {
  RANGE20_WINDOW_DAYS,
  RANGE20_PROBE_DAYS,
  getRange20WindowDates,
  legs20FromRows,
  merge20Legs,
  compound20,
  pickRealWindowDates,
  resolveT20LegMode,
  isAfterCloseOf
} from './range20.js';

/** 只取前 5 只（用户口径：「只选出5只」「取出排名前五的5只股票」） */
export const RANGE20_LEADER_TOP_N = 5;
/** 候选门槛：20 日窗口内至少这么多天出现在【早盘竞价正式列表】里（理由见文件头） */
export const RANGE20_LEADER_MIN_LEGS = 6;
/** 粗筛进入精算的只数（留 5 倍余量吸收粗筛误差，把请求数从 200+ 压到 25） */
export const RANGE20_LEADER_PRESELECT = 25;

// ===== 状态（模块级 ref，与 range20.js / dragonState 同款范式，§7 不进 Pinia）=====
// list: Array<{stock, code, pct, days}>
// ready: 结论【到了没有】—— 区别于「算出来 0 只」（§10：能不能 vs 有没有，必须是两件事）
const _state = ref({ date: '', list: [], ready: false, version: 0 });
/** 内容签名：内容没变就不重复发布（避免每次 bump version 把整个看板重排一次，§17/§36） */
const _sig = new Map();
/** 单飞：date -> Promise（切日期/重复触发都不会并发跑两遍，§32） */
const _inflight = new Map();
/** 已完整算过的日期 -> list（切日期回来直接复原，不再请求，§24 复用已有状态） */
const _cache = new Map();
/** 同花顺已请求过的「股票名@窗口首日」（跨日期复用：窗口首日相同 ⇒ 请求内容完全相同 ⇒ 不重复烧请求） */
const _klineTried = new Set();

/**
 * 当前已发布的「20日涨幅前五」。
 * @param {string} date 展示日
 * @returns {Array<{stock:string, code:string, pct:number, days:number}>|null}
 *          null = 该日【还没有结论】（⛔ 不等于「今天没有龙头补位」，见 hasRange20LeadersVerdict）
 */
export function getRange20Leaders(date) {
  const s = _state.value;
  if (!date || s.date !== date || !s.ready) return null;
  return s.list;
}

/**
 * 该日【结论到了没有】（§10 铁律：`canJudgeX` = 能不能作证；`hasXVerdict` = 结论到了没有）。
 * 用途：视图层据此区分「还在算（不渲染区块）」与「算完了，前五都在当天列表里（不注入但也不报错）」。
 * @param {string} date
 * @returns {boolean}
 */
export function hasRange20LeadersVerdict(date) {
  const s = _state.value;
  return !!(date && s.date === date && s.ready);
}

/** 增量渲染指纹令牌（异步到货必须让行缓存/视图失效，否则区块不出现或停在上一版） */
export function getRange20LeadersFingerprintToken() {
  const s = _state.value;
  return s.date + '|v' + s.version + '|n' + s.list.length + '|r' + (s.ready ? 1 : 0);
}

/** 清空会话缓存（仅供测试 / 换数据源） */
export function clearRange20Leaders() {
  _sig.clear();
  _inflight.clear();
  _cache.clear();
  _klineTried.clear();
  _state.value = { date: '', list: [], ready: false, version: _state.value.version + 1 };
}

/**
 * 诊断出口（只读，不产生任何副作用；供排查「区块为什么不出现」）。
 * 返回内部状态快照：能看到「结论到没到」「是不是被缓存/单飞挡住」。
 * @param {string} date
 * @returns {object}
 */
export function inspectRange20LeadersState(date) {
  const s = _state.value;
  return {
    stateDate: s.date,
    ready: s.ready,
    version: s.version,
    listLen: s.list.length,
    verdictForDate: !!(date && s.date === date && s.ready),
    cachedDates: Array.from(_cache.keys()),
    sigDates: Array.from(_sig.keys()),
    inflight: Array.from(_inflight.keys()),
    klineTried: _klineTried.size
  };
}

/**
 * 【纯函数】某行对应的股票代码：行内 code 优先 → 名册兜底 → ''（未知）。
 * ⚠️ §10：拿不到就是 ''，⛔ 不猜（猜错会把它当成主板放进来，或把主板误排除）。
 * @param {object} row 当日行
 * @returns {string}
 */
export function codeOfRow(row) {
  if (!row) return '';
  const raw = row.code !== undefined ? row.code : (row.stock_code !== undefined ? row.stock_code : '');
  const c = String(raw || '').replace(/\D/g, '');
  if (c.length === 6) return c;
  const nm = row.stock ? String(row.stock).trim() : '';
  if (!nm) return '';
  const mapped = String(getStockCode(nm) || '').replace(/\D/g, '');
  return mapped.length === 6 ? mapped : '';
}

/**
 * 【纯函数】是否「只主板」（用户本轮口径）。
 *
 * ⚠️ 与 `dragon-rank.js#isDragonBoardEligible` 的差别（⛔ 别把两者合并成一份）：
 *   · `isDragonBoardEligible` 是【龙标签发放】口径 —— 它**放行北交所**（历史用户口径：
 *     「你标准创业板或者科创板就可以了」），且【代码缺失时放行】（宁可发标也不静默删票）。
 *   · 本函数是【本轮补位】口径 —— 用户明确要求「科创板，创业板，**北交所**等非主板不要算进去」，
 *     且代码缺失 ⇒ **不算主板**（这是主动往看板里加票，宁可少加也不加错）。
 *   两者用途不同、判据不同，故并存；各自都只有一份实现（§6）。
 *
 * @param {string} code 6 位代码
 * @returns {boolean}
 */
export function isMainBoardOnly(code) {
  return getBoardKind(String(code || '')) === BOARD_MAIN;
}

/**
 * 【纯函数】候选池 = 若干天的正式列表并集（按股票名去重，先到先得）。
 * @param {Map<string, Map<string, object>>} rowsByDate 日期 -> (股票名 -> 当日行)
 * @returns {Array<{stock:string, code:string}>}
 */
export function unionPoolFromDates(rowsByDate) {
  const out = [];
  const seen = new Set();
  if (!rowsByDate) return out;
  rowsByDate.forEach(function(dayMap) {
    if (!dayMap) return;
    dayMap.forEach(function(row, name) {
      const n = String(name || '').trim();
      if (!n || seen.has(n)) return;
      seen.add(n);
      out.push({ stock: n, code: codeOfRow(row) });
    });
  });
  return out;
}

/**
 * 【纯函数】排名 + 截断（降序；同涨幅按「天数多者优先」再按名字，保证稳定可复现）。
 *
 * @param {Array<{stock:string, pct:number, days:number, code?:string}>} rows
 * @param {{limit?:number, minDays?:number, mainBoardOnly?:boolean}} [opts]
 * @returns {Array} 新数组（不修改入参）
 */
export function rankLeaders(rows, opts) {
  const o = opts || {};
  const limit = (o.limit === null || o.limit === undefined) ? RANGE20_LEADER_TOP_N : Number(o.limit);
  const minDays = (o.minDays === null || o.minDays === undefined) ? 0 : Number(o.minDays);
  const mainOnly = !!o.mainBoardOnly;
  const keep = [];
  (rows || []).forEach(function(r) {
    if (!r || !r.stock) return;
    const pct = Number(r.pct);
    if (r.pct === null || r.pct === undefined || !isFinite(pct)) return;   // §10 无值不参与排名
    const days = Number(r.days) || 0;
    if (minDays > 0 && days < minDays) return;
    if (mainOnly) {
      const c = r.code ? String(r.code) : codeOfRow(r);
      if (!isMainBoardOnly(c)) return;
    }
    keep.push({ stock: r.stock, code: r.code || '', pct: pct, days: days });
  });
  keep.sort(function(a, b) {
    if (b.pct !== a.pct) return b.pct - a.pct;
    if (b.days !== a.days) return b.days - a.days;
    return a.stock < b.stock ? -1 : (a.stock > b.stock ? 1 : 0);
  });
  const n = (isFinite(limit) && limit > 0) ? Math.floor(limit) : keep.length;
  return keep.slice(0, n);
}

/** 把某日的正式列表建索引（日期 -> 股票名 -> 行）—— 候选池与腿的唯一来源（§6 单一真相） */
function _formalRowsByDate(dates) {
  const out = new Map();
  for (let i = 0; i < dates.length; i++) {
    const d = dates[i];
    const m = new Map();
    let rows = [];
    try {
      rows = _getAuctionFormalRowsForDate(d) || [];
    } catch (e) {
      _dbgLog('[RANGE20-TOP5] ' + d + ' 正式列表读取失败（按空处理, 不影响其它日期）: ' + (e && e.message || e));
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

/** 内容签名（防止内容没变却重复发布 ⇒ 整个看板重排一次） */
function _sigOf(list) {
  if (!list || list.length === 0) return '0';
  return list.length + '|' + list.map(function(r) {
    return r.stock + ':' + Number(r.pct).toFixed(4) + ':' + (r.days || 0);
  }).join(',');
}

/** 发布（签名相同 ⇒ 不发布、不 bump version） */
function _publish(date, list) {
  const sig = _sigOf(list);
  if (_sig.get(date) === sig && _state.value.date === date) return _state.value.list;
  _sig.set(date, sig);
  const copy = (list || []).slice();
  // 🔴 [FIX 2026-10-19] **空结果不进会话缓存**（只标记"算过了"）。
  //   事故：页面刚加载时正式列表索引还没就绪 ⇒ 候选池为空 ⇒ 发布了一次空结论并写进 _cache；
  //   之后数据到了、watch 再触发，开头的 `_cache.has(date)` 短路直接返回那个空结论 ⇒
  //   整个会话再也算不出来（表现为「区块永远不出现」，而手动调用却一切正常）。
  //   ⇒ 只有非空结果才缓存；空结论只写 _sig（防重复发布），下次仍会重算。
  if (copy.length > 0) _cache.set(date, copy);
  _state.value = { date: date, list: copy, ready: true, version: _state.value.version + 1 };
  return copy;
}

/** 日期闸门（未来日 / 非交易日 ⇒ 不产出数据，与 range20.js/_notTradable 同口径） */
function _notTradable(date) {
  const today = _getLocalTodayStr();
  if (today && date > today) return true;
  try {
    return !isTradingDay(date);
  } catch (e) {
    _dbgLog('[RANGE20-TOP5] 交易日历读取失败（放行）: ' + (e && e.message || e));
    return false;
  }
}

/**
 * 确保某日的「20日涨幅前五（补位）」已就绪（幂等 / 单飞 / 会话缓存）。
 *
 * @param {string} date 展示日 T
 * @param {{onProgress?:(done:number,total:number)=>void, skipKline?:boolean}} [opts]
 *        skipKline：只跑粗筛（不请求 K 线）—— 供单测/诊断用
 * @returns {Promise<Array<{stock:string,code:string,pct:number,days:number}>>}
 */
export async function ensureRange20Leaders(date, opts) {
  if (!date) return [];
  if (_notTradable(date)) {
    _publish(date, []);
    return _state.value.list;
  }
  // 已算完且有结果 ⇒ 直接用缓存（切日期回来不再请求，§24）
  //   ⚠️ 判据只看 `_cache`（非空结果才写），不看 `_sig` —— 空结论不缓存的理由见 _publish。
  if (_cache.has(date)) {
    if (_state.value.date !== date) _publish(date, _cache.get(date));
    if (!(opts && opts.force)) return _state.value.list;
  }
  const key = date + '|top5';
  const fly = _inflight.get(key);
  if (fly) return fly;

  const probeDates = getRange20WindowDates(date, RANGE20_PROBE_DAYS);
  const tIsToday = (date === _getLocalTodayStr());
  // 🔴 [R20-TSWITCH] 必须与 range20.js 主 toggle 用同一套 T 腿口径（§6），否则「前五补位」的
  //   涨幅会和同一屏的 20日涨幅列对不上（同一个日期、同一只票出现两个数）。
  const afterClose = isAfterCloseOf(date);
  const legMode = resolveT20LegMode(tIsToday, afterClose);

  const p = (async function() {
    const rowsByDate = _formalRowsByDate(probeDates);
    const pool = unionPoolFromDates(rowsByDate);
    if (pool.length === 0) {
      // 正式列表索引还没就绪（§10：未就绪 ≠ 没有股票）⇒ 不发布「空结论」
      _dbgLog('[RANGE20-TOP5] ' + date + ' 候选池为空（正式列表索引可能未就绪），本次不产出');
      return _state.value.list;
    }
    // 🔴 这里要【两份】baseLegs，用途严格分离（2026-10-19 实测踩过，⛔ 别合成一份）：
    //   ① `baseLegsDb`（库内历史腿）—— **只给粗筛**。`legs20FromRows` 默认
    //      `useDbLegsForHistory = false`（主看板历史日只认 K 线，见 range20.js 的 R20-CLOSE-LEG），
    //      不传这个开关 ⇒ 只剩 T 腿一根 ⇒ `minDays: 6` 筛掉所有票 ⇒ 前五补位**静默失效**。
    //   ② `baseLegs`（干净：历史日不采用库内）—— **给精算结果**。库内 `change_pct` 可能是早盘写入的
    //      竞价涨幅或整日缺行，混进最终复利就会偏（实测 10-19 新华传媒粗筛版算出 207.91%，
    //      而真值 210.98%，差 1 根假腿）⇒ 精算必须只信 K 线 + T 腿。
    const baseLegsDb = legs20FromRows(pool, probeDates, rowsByDate, {
      tIsToday: tIsToday,
      afterClose: afterClose,
      useDbLegsForHistory: true,
    });
    const baseLegs = legs20FromRows(pool, probeDates, rowsByDate, {
      tIsToday: tIsToday,
      afterClose: afterClose,
    });
    // 阶段① 粗筛（0 请求）：库内腿 + 门槛 + 只主板
    // 🔴 [R20-PERSTOCK-WIN] 传完整 probeDates（⛔ 不再 slice(-20)）：`compound20` 按每票自己的
    //   最近 20 个有腿日取窗，先截断 20 天会让停牌票无法回溯、粗筛把真龙头筛掉。
    const guessDates = probeDates;
    const coarse = compound20(baseLegsDb, guessDates);
    // 🔴 [R20-CLOUD 2026-10-20] 云端结果表优先：主 toggle 已经用 K 线算过的票直接拿来排名，
    //   ⛔ 不再为它们重打一遍同花顺（这就是「打开应用要等很久」的主因 —— 本模块以前无条件
    //   跑 25 次 K 线，哪怕主看板/上一次打开早就算过了）。
    //   ⚠️ 表里的票可能不在候选池（pool 只含「近 20 日正式名单并集」）⇒ 先按 pool 过滤。
    const cloudAll = (opts && opts.skipCloud)
      ? new Map()
      : pickUsableRows(await readRange20Rows(date), legMode);
    const poolNames = new Set(pool.map(function(t) { return t.stock; }));
    const cloudMap = new Map();
    cloudAll.forEach(function(v, n) { if (poolNames.has(n)) cloudMap.set(n, v); });
    if (cloudMap.size > 0) {
      _dbgLog('[RANGE20-TOP5] ' + date + ' 云端表命中 ' + cloudMap.size + ' 只（0 请求复用）');
    }
    // 粗筛排序用「库内近似 ∪ 云端真值」（同名以云端为准 —— 云端是 K 线算的，必然更准）
    const coarseMerged = (function() {
      const m = new Map();
      coarse.forEach(function(r) { m.set(r.stock, r); });
      cloudMap.forEach(function(v, n) {
        if (!poolNames.has(n)) return;
        m.set(n, { stock: n, pct: v.pct, days: v.days });
      });
      return Array.from(m.values());
    })();
    const coarseTop = rankLeaders(coarseMerged, {
      limit: RANGE20_LEADER_PRESELECT,
      minDays: RANGE20_LEADER_MIN_LEGS,
      mainBoardOnly: true
    });
    _dbgLog('[RANGE20-TOP5] ' + date + ' 候选池=' + pool.length + ' 有腿=' + coarseMerged.length
      + ' 粗筛(>= ' + RANGE20_LEADER_MIN_LEGS + '天/主板)=' + coarseTop.length);
    if (opts && opts.skipKline) {
      return _publish(date, coarseTop.slice(0, RANGE20_LEADER_TOP_N));
    }
    if (coarseTop.length === 0) {
      _publish(date, []);
      return _state.value.list;
    }

    // 阶段② 精算（<=25 请求）：补满 20 天 K 线后重算
    //   跨日期复用：同一只票 + 同一窗口首日 ⇒ 请求内容完全相同 ⇒ 只发一次（切日期不重复烧请求）
    //   🔴 [R20-CLOUD] 云端表已有真值的票不再请求（0 请求复用）。
    const winKey = probeDates[0] || '';
    const todo = coarseTop.filter(function(t) {
      return !_klineTried.has(t.stock + '@' + winKey) && !cloudMap.has(t.stock);
    });
    const extraByStock = new Map();
    if (todo.length > 0) {
      _fillCodes(todo);
      if (todo.some(function(t) { return !t.code; })) {
        try {
          await ensureAuctionCodeMapping(todo);
        } catch (e) {
          _dbgLog('[RANGE20-TOP5] 补码失败: ' + (e && e.message || e));
        }
        _fillCodes(todo);
      }
      const list = todo.filter(function(t) { return !!t.code; });
      if (list.length > 0) {
        list.forEach(function(t) { _klineTried.add(t.stock + '@' + winKey); });
        const onProgress = (opts && typeof opts.onProgress === 'function') ? opts.onProgress : null;
        const extra = await fetchFuyaoDailyPctRange(
          list.map(function(t) { return { stock: t.stock, code: t.code }; }),
          probeDates,
          // 与 range20.js 同一套参数（理由见该文件阶段② 注释）：上游偶发只回 12 根 / 挂住 / 凑不满窗口
          { concurrency: 3, retryShortWindow: true, requestTimeoutMs: 15000, minCoverage: RANGE20_WINDOW_DAYS, onProgress: onProgress }
        );
        extra.forEach(function(v, k) { extraByStock.set(k, v); });
      }
    }
    // 🔴 必须传 tDate（主看板漏掉过这个参数 ⇒ 盘中会把竞价腿换成 K 线的"今天盘中价"）：
    //   盘中保护 T 腿（竞价口径），收盘后让 K 线的今日收盘覆盖它（见 range20.js#merge20Legs）。
    const merged = merge20Legs(baseLegs, extraByStock, probeDates, {
      tDate: date,
      tKeepAuctionLeg: (legMode === 'auc'),
    });
    // 🔴 [R20-PERSTOCK-WIN] 不截到 20：每票在 compound20 内自取最近 20 个有腿日（与主看板同口径）
    const realDates = pickRealWindowDates(merged, probeDates, probeDates.length);
    const fresh = compound20(merged, realDates);
    // 🔴 [R20-CLOUD] 参与排名 = 本轮算出的 ∪ 云端表真值（同名以本轮为准）。
    //   否则「表里命中但本轮没算」的票（例如前五里的 4 只本就在正式列表）会从排名里消失 ⇒
    //   补位候选判断全错（用户要的是「前五里哪些今天看不到」）。
    const rankPool = (function() {
      const m = new Map();
      cloudMap.forEach(function(v, n) { m.set(n, { stock: n, pct: v.pct, days: v.days }); });
      fresh.forEach(function(r) { if (r && r.stock) m.set(r.stock, r); });
      return Array.from(m.values());
    })();
    const top = rankLeaders(rankPool, {
      limit: RANGE20_LEADER_TOP_N,
      minDays: RANGE20_LEADER_MIN_LEGS,
      mainBoardOnly: true
    });
    // 把代码补回结果里（`compound20` 只产 {stock,pct,days}，不含 code）：
    //   视图层注入补位行时可以直接用，省一次名册查询；也给「只有代码才能判板块」留了可追溯的痕迹。
    const _coarseCode = new Map();
    coarseTop.forEach(function(t) { if (t.code) _coarseCode.set(t.stock, t.code); });
    top.forEach(function(t) { if (!t.code) t.code = _coarseCode.get(t.stock) || ''; });
    _dbgLog('[RANGE20-TOP5-PUB] ' + date + ' 精算 realDays=' + realDates.length
      + ' 补算=' + extraByStock.size + ' 云端=' + cloudMap.size
      + ' 前五=' + top.map(function(t) { return t.stock + ' ' + t.pct.toFixed(2) + '%/' + t.days + 'd'; }).join(' , '));
    _publish(date, top);
    // 🔴 [R20-CLOUD] 把本轮真拿到 K 线的票落库 ⇒ 主 toggle 下次打开可 0 请求复用（两个模块共享同一张表）。
    //   只写「确实有 K 线腿的票」，⛔ 不写只有 T 腿的残缺值（§10：宁缺勿错，残缺值落库会永久污染）。
    try {
      const _toSave = fresh.filter(function(r) {
        return r && r.stock && extraByStock.has(r.stock) && r.days >= RANGE20_LEADER_MIN_LEGS;
      });
      if (_toSave.length > 0) await upsertRange20Rows(date, _toSave, legMode);
    } catch (e) { /* 落库失败静默：正确性不依赖它 */ }
    return _state.value.list;
  })().finally(function() {
    if (_inflight.get(key) === p) _inflight.delete(key);
  });
  _inflight.set(key, p);
  return p;
}

/** 代码兜底：粗筛结果 → 名册（与 range20.js#_fillCodes 同源，§6 不另造一套代码解析） */
function _fillCodes(targets) {
  (targets || []).forEach(function(t) {
    if (!t.code) {
      const c = String(getStockCode(t.stock) || '').replace(/\D/g, '');
      if (c.length === 6) t.code = c;
    }
  });
}

/**
 * 诊断：20 天候选池的规模画像（供调试/日志，不在生产路径上）。
 * @param {string} date
 * @returns {{poolSize:number, dates:number, byBoard:object}}
 */
export function inspectRange20Pool(date) {
  const probeDates = getRange20WindowDates(date, RANGE20_PROBE_DAYS);
  const rowsByDate = _formalRowsByDate(probeDates);
  const pool = unionPoolFromDates(rowsByDate);
  const byBoard = { main: 0, growth: 0, star: 0, bj: 0, unknown: 0 };
  pool.forEach(function(t) {
    const k = getBoardKind(String(t.code || ''));
    if (k === BOARD_MAIN) byBoard.main++;
    else if (k === BOARD_GROWTH) byBoard.growth++;
    else if (k === BOARD_STAR) byBoard.star++;
    else if (k === BOARD_BJ) byBoard.bj++;
    else byBoard.unknown++;
  });
  return { poolSize: pool.length, dates: probeDates.length, byBoard: byBoard };
}
