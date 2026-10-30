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
import { _getAuctionFormalRowsForDate, _isAuctionWatchlistIndexReady } from '../../data/watchlist-and-metrics.js';
import { fetchFuyaoDailyPctRange } from '../../data/stock-range-pct.js';
// [R20-CLOUD 2026-10-20] 与主 toggle 共用同一张结果表（stock_range20_pct）⇒ 谁先算谁落库、另一方 0 请求复用
import { readRange20Rows, pickUsableRows, upsertRange20Rows } from '../../data/stock-range20-cache.js';
// ★★ [R20-DAILY 2026-10-30 用户口径] 逐日腿原料表（与主 toggle 共用同一份原料，§6）
import { readDailyPctRows, upsertDailyPctRows } from '../../data/stock-daily-pct.js';
import { _dbgLog } from '../../data/debug-log.js';
import { getBoardKind, BOARD_MAIN, BOARD_BJ, BOARD_GROWTH, BOARD_STAR } from './limit-up.js';
import { _getLocalTodayStr } from '../tagTitles/rules.js';
import { ensureAuctionCodeMapping } from './auction-fetch-helpers.js';
import { isTradingDay } from '../date/trading-day-helpers.js';
import {
  RANGE20_WINDOW_DAYS,
  RANGE20_PROBE_DAYS,
  getRange20WindowDates,
  getRange20Pct,
  legs20FromRows,
  legs20FromDaily,
  mergeBaseLegs,
  needsKlineLegs,
  dailyRowsFromKline,
  merge20Legs,
  compound20,
  pickRealWindowDates,
  resolveT20LegMode,
  isAfterCloseOf
} from './range20.js';

/** 只取前 5 只（用户口径：「只选出5只」「取出排名前五的5只股票」） */
export const RANGE20_LEADER_TOP_N = 5;
/**
 * ★★ [NEW-DRAGON-08 2026-10-22 用户口径] 「宽榜」只数 = 8。
 *
 * 用户原话：「如果前五找到你就找前八的，不用前五的，改用排名前八的。注意竞价涨停一字涨停板
 *   是买不进的，所以前八的，在这个节点上，你只能挑选非竞价一字涨停的主板」。
 * ⇒ 第二十八条「切换日挑新龙」的候选池要看前 8 名，而「20日涨幅」toggle / 总龙一~五 标签 / 分歧买点
 *   **仍然只用前 5 名**（用户没让改那些）。所以这里在一次计算里裁两份：前 5 用于发布（展示不变），
 *   前 8 另存一份宽榜供规则层取候选 —— ⛔ 绝不为此多算一轮 K 线（同一份 rankPool 裁两次即可）。
 */
export const RANGE20_LEADER_WIDE_N = 8;
/**
 * ★★ [EBB-MAIN-TOPIC 2026-10-25 用户口径] 「题材榜」只数 = 10。
 *
 * 用户原话：「首先再说明下什么是主线龙头，20日涨幅中排名前10的，1.必须满足有3只以上同题材的
 *   才叫主线题材，也就是说主线题材必须至少有3只排在前10。2.而且总龙一是该题材的。这叫主线题材。」
 * ⇒ 退潮判定要数「前十里有几只同题材」，所以需要【前十】这一份。
 * ⛔ 与 `RANGE20_LEADER_TOP_N`(5) / `RANGE20_LEADER_WIDE_N`(8) 是三个不同用途，别互相顶替：
 *   · 5  = 展示（20日涨幅 toggle / 补位区块 / 总龙一~五 标签 / 退潮买点替补）
 *   · 8  = 第二十八条「切换日挑新龙」的候选池
 *   · 10 = 本轮的「主线题材成组」判定（只给规则层数题材，⛔ 不上屏）
 * 三份都从【同一份 rankPool、同一把 rankLeaders】裁出来 ⇒ 前 5 名逐只相同，0 新增请求。
 */
export const RANGE20_LEADER_TEN_N = 10;
/**
 * 「可信门槛」：20 日窗口内至少这么多天有腿。
 * ⚠️ 语义按阶段不同，⛔ 别混用（2026-10-20 就是因为混用才补出负涨幅的票）：
 *   · 精算阶段 = **K 线腿数**（正常票 ≈20，停牌票 ≥6）⇒ 判断这个值可不可信；
 *   · 粗筛阶段 = **库内上榜天数**（20 天里只有 4 天在名单里，数据本来就残）——
 *     所以粗筛**不能**直接用这个门槛（见 RANGE20_LEADER_COARSE_MIN_LEGS）。
 */
export const RANGE20_LEADER_MIN_LEGS = 6;
/**
 * 粗筛的「入场门槛」：只要 >= 2 天有库内腿就有资格参与近似排名。
 *
 * 🔴 为什么必须与 RANGE20_LEADER_MIN_LEGS 分开（2026-10-20 用户投诉「补出来的全是负涨幅」）：
 *   粗筛的唯一职责是「挑 25 只进精算」，所以它应该**宁滥勿缺** —— 挑「可能涨得最多」的票。
 *   旧实现拿 `minDays: 6`（上榜天数）当粗筛门槛 ⇒ 把「上榜天数少但涨幅巨大」的真龙头
 *   （停牌票、中途进名单的票）直接筛掉，只剩「长期霸榜但涨幅平庸」的票进入精算，
 *   于是前五变成一批弱势票。实测 10-20：过门槛只剩 11 只，金健米业/国芳集团/楚天龙排在前面。
 */
export const RANGE20_LEADER_COARSE_MIN_LEGS = 2;
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
 * 🔴 date -> Map<stock, Map<ymd, pct>>：本轮拿到的 K 线腿【累积】缓存。
 *
 * 为什么必须有（2026-10-20 修）：旧实现把腿放在局部变量 `extraByStock` 里，
 *   而 `_klineTried` 会把请求过的票全部登记住 ⇒ **任何一次重算（数据到齐 / 换口径）都拿不到腿**
 *   ⇒ `fresh` 只剩「T 腿」⇒ 全被可信门槛筛掉 ⇒ 前五退化成空或极少数票。
 *   累积后重算可以 0 请求复原完整腿集（与 range20.js#_klineAcc 同款范式）。
 */
const _klineAcc = new Map();
/**
 * 🔴 date -> 'auc' | 'close'：该日结果是用哪套 T 腿口径算出来的。
 *
 * 跨 15:00 口径会变（盘中竞价 → 收盘），`_cache` 里的旧结果必须作废重算，
 * 否则整个会话一直显示早上那份数（主看板有 `_legMode` 护栏，本模块此前漏了）。
 */
const _legMode = new Map();
/**
 * 🔴 date -> 候选池大小（`pool.length`）：缓存判据之一。
 *   候选池来自异步分批加载的正式列表索引 ⇒ 池会「先小后大」；池变大时必须重算，
 *   否则第一次那份残缺池的结论会被永久缓存（见 [R20-POOL-GROW]）。
 */
const _poolSig = new Map();
/**
 * ★★ [NEW-DRAGON-08 2026-10-22] date -> 该日的「宽榜」（20日涨幅前八，只主板）。
 *
 * 为什么不塞进 `_state`：`_state.list` 是「20日涨幅 toggle / 补位区块 / 总龙一~五 标签」的唯一来源，
 * 改成 8 只会让展示层多出 3 只（用户没让改）。⇒ 宽榜独立存一份，只给第二十八条取候选。
 * 生命周期与 `_cache` 完全同步（每一处 `_cache.delete` 都必须同步 `_wideCache.delete`）。
 */
const _wideCache = new Map();
/**
 * ★ [EBB-MAIN-TOPIC 2026-10-25] date -> 该日的「前十」（20日涨幅前 10，只主板）。
 *
 * 只给退潮判定的「主线题材成组」计数用（用户口径「前十里有 3 只以上同题材」）。
 * 生命周期与 `_cache` / `_wideCache` 完全同步（每一处它们的 delete/clear 都要同步本表）。
 */
const _tenCache = new Map();
/**
 * 🔴 date -> { n:number, timer:any }：索引预热期的退避重算计数（见 [R20-WARM]）。
 *   4 次封顶后不再重试 —— 剩下的日子可能本来就没有名单数据，无限重试只会烧 CPU。
 */
const _warmRetry = new Map();
/** 退避间隔（毫秒）：由近到远，覆盖「首次打开应用后 2 分钟内索引补齐」这段窗口 */
const WARM_RETRY_DELAYS = [3000, 10000, 30000, 60000];

/**
 * ★★ [NEW-DRAGON-08 2026-10-22] 该日的「宽榜」= 20日涨幅【前八】（只主板）。
 *
 * 与 `getRange20Leaders` 的区别只有长度：前者 5（展示 / 总龙一~五 / 分歧买点用），本函数 8
 * （第二十八条切换日「挑新龙」的候选池用，用户「改用排名前八的」）。
 * ⚠️ 同一份 `rankPool` 裁出来的，同一天两者【前 5 名逐只相同】，⛔ 不会出现两套口径打架。
 *
 * @param {string} date 展示日
 * @returns {Array<{stock:string, code:string, pct:number, days:number}>|null}
 *          null = 该日【还没有结论】（§10：能不能 ≠ 有没有，⛔ 不要拿空数组冒充）
 */
export function getRange20LeadersWide(date) {
  if (!date) return null;
  const cached = _wideCache.get(date);
  return (Array.isArray(cached) && cached.length > 0) ? cached : null;
}

/**
 * ★★ [EBB-MAIN-TOPIC 2026-10-25 用户口径] 该日的「前十」= 20日涨幅【前 10】（只主板）。
 *
 * 唯一消费方：退潮判定的「主线题材」判定（`classifyMainTopic`）——
 *   用户口径「主线题材必须至少有 3 只排在前 10，而且总龙一是该题材的」。
 * ⚠️ 与 `getRange20Leaders`(5) / `getRange20LeadersWide`(8) 同源同口径（同一份 rankPool 裁三次），
 *   ⛔ 不会出现「前十里的第 6 名比前八里的第 6 名还不一样」这种两套口径打架。
 *
 * @param {string} date 展示日
 * @returns {Array<{stock:string, code:string, pct:number, days:number}>|null}
 *          null = 该日【还没有结论】（§10：能不能 ≠ 有没有，⛔ 不要拿空数组冒充）
 */
export function getRange20LeadersTop10(date) {
  if (!date) return null;
  const cached = _tenCache.get(date);
  return (Array.isArray(cached) && cached.length > 0) ? cached : null;
}

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
  _klineAcc.clear();
  _legMode.clear();
  _poolSig.clear();
  _wideCache.clear();
  _tenCache.clear();
  _warmRetry.forEach(function(st) { if (st && st.timer) clearTimeout(st.timer); });
  _warmRetry.clear();
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
 * ★★ [DIVERGE-GUESS 2026-10-24] 【纯函数】从「某日已落库的 20 日涨幅」里挑出【总龙一候选】——
 *   只给「总龙首次分歧判定」的**预热通道**用（见 useTopicVolRatioBoard#ensureDivergeGuess）。
 *
 * 为什么需要它（用户 2026-10-24 原话：「为什么这个提示总是过很久才显示出来……计算判断有那么久吗？
 * 要再优化下」）：
 *   分歧判定必须知道【今天的总龙一是谁】，而总龙一来自 20 日涨幅前五的**精算**（<=25 只票的 K 线，
 *   十几~几十秒）。判定本身只要【1 只票】的 K 线（1~3 秒）⇒ 全部等待都在「等身份」上。
 *   于是先用【上一交易日已落库的总龙一】把这只票的判定**提前算出来**当「猜测」：
 *     · 猜「是分歧日」⇒ 买点侧【秒挂】占位（不等精算，用户不用先看到一堆会变的旧规则选票）；
 *     · 猜「不是分歧日」⇒ 照常渲染（⛔ 不为每天的主路径凭空多加等待）。
 *   ⚠️ 它产出的是**猜测**，绝不当结论用：精算给出真·总龙一后必须以真身份重核（名字不同 ⇒ 重算），
 *      买点侧最终结论 100% 来自 `ensureLeaderDivergence` 的正规链路（§10 不拿猜测冒充结论）。
 *
 * @param {Map<string,{pct:number,days:number}>} usable 某日 pickUsableRows 的结果（口径已过滤）
 * @param {(name:string)=>string} codeOf 股票名 -> 6 位代码（名册查询，失败返回 ''）
 * @returns {{stock:string, code:string, pct:number, days:number}|null}
 *          null = 挑不出来（没有可用行 / 全部拿不到代码或非主板）⇒ 调用方降级为「不预热」
 */
export function pickLeaderFromUsableRows(usable, codeOf) {
  if (!usable || typeof usable.forEach !== 'function' || !usable.size) return null;
  const fn = (typeof codeOf === 'function') ? codeOf : null;
  let best = null;
  usable.forEach(function(v, name) {
    const nm = String(name || '').trim();
    if (!nm || !v) return;
    const pct = (v.pct === null || v.pct === undefined) ? NaN : Number(v.pct);
    if (!isFinite(pct)) return;
    // ⛔ §10：代码缺席 ⇒ K 线请求发不出去（⛔ 不用名字硬试）；非主板 ⇒ 不符合总龙口径。
    //   与 codeOfRow 同一套规范化（只留数字 + 必须 6 位），⛔ 别让带市场前缀的代码漏进 isMainBoardOnly。
    const raw = fn ? String(fn(nm) || '') : '';
    const code = raw.replace(/\D/g, '');
    if (code.length !== 6 || !isMainBoardOnly(code)) return;
    if (!best || pct > best.pct) {
      best = { stock: nm, code: code, pct: pct, days: Number(v.days) || 0 };
    }
  });
  return best;
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
 * 【纯函数】构建「20日涨幅前五」的排名池 —— 四层由可信到兜底合并（本次修复的核心）。
 *
 * ★★ 为什么必须有「粗筛近似」这一层底座（2026-10-20 用户投诉「补出来的全是负涨幅」的正解）：
 *   排名池原来只装「精算成功的票」∪「云端真值」。而精算只覆盖粗筛前 25 只，一旦上游限流/超时
 *   让大部分请求失败，这 25 只里只有极少数有 K 线腿 ⇒ 其余在 `fresh` 里只剩一根 T 腿
 *   ⇒ 被 `minDays: 6` 筛掉 ⇒ **前五只能从「侥幸精算成功的少数票」里出**，而那些恰恰是
 *   粗筛排 7/11/30/42 名的弱势票 ⇒ 用户看到 -2.88% / -16.09% 这种「前五」。
 *   §10 的正解不是「丢弃」，而是「**如实降级**」：精算没拿到就用粗筛近似值参与排名，
 *   保证前五的**成员**永远来自全池最强的一批（数值精度另说，绝不换成弱票）。
 *
 * 优先级（后者覆盖前者，越靠后越可信）：
 *   ④ 粗筛近似（库内 change_pct 复利，可能混竞价口径）—— 兜底底座，保证强票不消失
 *   ③ 云端结果表 `stock_range20_pct`（K 线算过的真值，0 请求）
 *   ② 主看板内存 map（`getRange20Pct`，今天正式列表的票正在/已被主 toggle 算成真值，0 请求）
 *   ① 本轮精算 `fresh`（K 线真值，最新）
 *
 * @param {{
 *   coarseTop: Array<{stock:string, code?:string, pct:number, days:number}>,
 *   cloudMap?: Map<string,{pct:number,days:number}>,
 *   liveMap?: Map<string,{pct:number,days:number}>|null,
 *   fresh?: Array<{stock:string, pct:number, days:number}>,
 *   poolNames?: Set<string>,
 *   minLegs?: number
 * }} input
 * @returns {Array<{stock:string, code:string, pct:number, days:number, approx:boolean}>}
 */
export function buildLeaderRankPool(input) {
  const o = input || {};
  const minLegs = (o.minLegs === null || o.minLegs === undefined)
    ? RANGE20_LEADER_MIN_LEGS : Number(o.minLegs);
  const poolNames = o.poolNames || null;
  const m = new Map();

  // ④ 粗筛近似（底座：⛔ 绝不因为后面几层没有就把它删掉）
  (o.coarseTop || []).forEach(function(t) {
    if (!t || !t.stock) return;
    m.set(t.stock, { stock: t.stock, code: t.code || '', pct: t.pct, days: t.days || 0, approx: true });
  });
  // ③ 云端结果表
  if (o.cloudMap) {
    o.cloudMap.forEach(function(v, n) {
      if (!v || v.pct === null || v.pct === undefined || isNaN(v.pct)) return;
      m.set(n, { stock: n, code: '', pct: Number(v.pct), days: v.days || 0, approx: false });
    });
  }
  // ② 主看板真值（今天正式列表的票）
  if (o.liveMap && o.liveMap.size > 0) {
    o.liveMap.forEach(function(v, n) {
      if (poolNames && !poolNames.has(n)) return;
      if (!v || v.pct === null || v.pct === undefined || isNaN(v.pct)) return;
      m.set(n, { stock: n, code: '', pct: Number(v.pct), days: v.days || 0, approx: false });
    });
  }
  // ① 本轮精算 —— 🔴 只有「腿数够」的才算真值：days=1 的残缺值不许覆盖近似底座
  //   （否则强票又被拉回「T 日当天涨幅」，正是本轮要修的病）
  (o.fresh || []).forEach(function(r) {
    if (!r || !r.stock) return;
    if (!(Number(r.days) >= minLegs)) return;
    m.set(r.stock, { stock: r.stock, code: '', pct: r.pct, days: Number(r.days), approx: false });
  });
  return Array.from(m.values());
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

/**
 * 发布（签名相同 ⇒ 不发布、不 bump version）
 *
 * 🔴 [R20-PUB-GUARD 2026-10-26] 与 `range20.js#_publish` 同一处修正（理由与实测数据见那边）：
 *   本模块**同时维护多个日期**（看板展示日 + 前沿交易日的 TOP5 补位检索），而 `_state.value`
 *   只有一个 `date` 字段 ⇒ 交替发布必然把 `_state.date` 顶来顶去。
 *   旧守卫 `_sig.get(date) === sig && _state.value.date === date` 因此**几乎永远不成立**：
 *   每次调用都走到下面 `version + 1` ⇒ 看板行缓存指纹变化 ⇒ 整块重排 ⇒ 触发新的
 *   `ensureRange20Leaders` ⇒ 自激循环（实测同一天同一内容 1 秒内被重复发布 3 次）。
 *
 *   ⇒ 拆成两种情形：内容变了才 bump；内容没变、只是日期被顶掉，只把日期拨回来。
 *     `getRange20LeadersFingerprintToken()` 里本来就含 `s.date`，日期一变指纹就变，
 *     消费方照样会重算，**不需要**用 version 再踢一脚。
 */
function _publish(date, list, cacheable) {
  const sig = _sigOf(list);
  const prevSig = _sig.get(date);
  const sameDate = (_state.value.date === date);
  const contentChanged = (prevSig !== sig);
  if (!contentChanged && sameDate) return _state.value.list;
  _sig.set(date, sig);
  const copy = (list || []).slice();
  // 🔴 [FIX 2026-10-19] **空结果不进会话缓存**（只标记"算过了"）。
  //   事故：页面刚加载时正式列表索引还没就绪 ⇒ 候选池为空 ⇒ 发布了一次空结论并写进 _cache；
  //   之后数据到了、watch 再触发，开头的 `_cache.has(date)` 短路直接返回那个空结论 ⇒
  //   整个会话再也算不出来（表现为「区块永远不出现」，而手动调用却一切正常）。
  //   ⇒ 只有非空结果才缓存；空结论只写 _sig（防重复发布），下次仍会重算。
  //   ★ [R20-WARM 2026-10-20] 同理：**索引还在预热（候选池会继续变大）时的非空结论也不缓存** ——
  //     那一刻的前五是从一份残缺池里选出来的，缓存住就再也不改（实测补出第 6 名的弱票）。
  if (copy.length > 0 && cacheable !== false) _cache.set(date, copy);
  _state.value = {
    date: date,
    list: copy,
    ready: true,
    version: contentChanged ? _state.value.version + 1 : _state.value.version
  };
  return copy;
}

/**
 * 【纯函数】预热退避到达次数上限后，还能不能继续重算。
 *
 * ★ [R20-WARM-GROW 2026-10-26] 这是「题材量比永久不出数据」的判定核心，单独抽出来是为了可测。
 *
 * 背景：索引是**按日异步补齐**的，`_readyDays` 单调不减（只加不丢）。
 *   · 池空场景（`cheapCase = true`，本次 0 请求）：只要索引还在长 ⇒ 数据还在路上 ⇒ 重置退避继续算。
 *     收敛性有保证：`_readyDays` 上界 = `probeDates.length`，涨到头就不满足 `>`，自然停。
 *   · 已精算场景（`cheapCase = false`）：每次重算都要再打一批同花顺 K 线 ⇒ 到上限必须停（§32）。
 *
 * @param {{n:number, readyDays:number}} st  当前重试状态（n = 已重试次数）
 * @param {number} readyDays                 本次观测到的「索引已就绪天数」
 * @param {boolean} cheapCase                本次重试是否 0 请求（候选池为空 ⇒ 只读内存）
 * @returns {'continue'|'reset'|'stop'} continue = 未到上限，正常退避；reset = 索引在长，退避次数归零；stop = 真放弃
 */
export function decideWarmRetry(st, readyDays, cheapCase) {
  const n = Number(st && st.n) || 0;
  if (n < WARM_RETRY_DELAYS.length) return 'continue';
  if (!cheapCase) return 'stop';
  const prevRaw = (st && st.readyDays !== undefined) ? st.readyDays : -1;
  const prev = Number(prevRaw);
  const now = Number(readyDays);
  // ⚠️ 严格大于：索引停在原地（真的没有更多名单数据）⇒ 停，⛔ 别用 >= 变成无限轮询
  return (isFinite(now) && now > prev) ? 'reset' : 'stop';
}

/**
 * [R20-WARM] 索引预热期结束后自动重算（退避 4 次封顶）。
 *
 * ⛔ 为什么不能指望 watch 再触发：`useAuctionBoard` 的 watch 盯的是
 *   「`uiStore.currentDate` + 展示日行数」，而**历史日索引补齐不会改变展示日的行数**
 *   ⇒ 池从 43 涨到 424 时一次触发都没有，缓存（或那次错结论）就永久留在屏幕上。
 *
 * ★★ [R20-WARM-GROW 2026-10-26 用户报障「题材量比一直不产出」] 封顶规则分两档：
 *
 *   · `cheapCase = true`（候选池为空，本次**一个请求都没发**）：
 *       封顶后**不放弃**，改看「索引是否还在长」—— 索引只加不减、按日补齐 ⇒ `readyDays` 单调，
 *       只要它比上次大就说明数据还在路上，重置退避继续重算；等它稳定后仍为空，才是真的没数据。
 *       ⚠️ 这里重试是 0 请求（只读内存索引），放宽不违反 §32。
 *   · `cheapCase = false`（已烧过 K 线精算、只是索引未预热）：
 *       保持原 4 次封顶 —— 每次重算都会再打一批同花顺 K 线，无限重试就是 §32 红线。
 *       这条链路有别的兜底：补齐完成后 `auction-sync-pull` 会 emit('auction-refresh')
 *       ⇒ 看板 bumpVersion ⇒ 重新调用本函数（此时 `_warm` 已为 true，结论才会进缓存）。
 */
function _scheduleWarmRetry(date, readyDays, totalDays, cheapCase) {
  const st = _warmRetry.get(date) || { n: 0, timer: 0, readyDays: -1 };
  const verdict = decideWarmRetry(st, readyDays, cheapCase);
  if (verdict === 'stop') {
    _dbgLog('[RANGE20-TOP5-WARM] ' + date + ' 索引停在 ' + readyDays + '/' + totalDays
      + ' 且不再增长 ⇒ 停止重算（剩下的日子可能本来就没有名单数据）');
    return;
  }
  // 🔴 [R20-WARM-ONCE 2026-10-26] **已经排了一个待执行的重算 ⇒ 不要再排第二个。**
  //
  //   踩过的坑（实测，必须保留这段说明）：`ensureRange20Leaders` 是被 watch / 数据到货反复调用的，
  //   每次调用都会走到这里。旧实现每次都 `clearTimeout(st.timer)` 重排 `WARM_RETRY_DELAYS[st.n]`
  //   ⇒ 只要新调用比 3s 更密（实测每秒 1~3 次，5 个日期同时循环），**倒计时永远回到起点、
  //     `st.n` 永远停在 0** ⇒ 3s/10s/30s/60s 的退避与「封顶 4 次」形同虚设，变成每 3 秒一次
  //   全量重算（含 25 只同花顺精算）。日志长这样，`第 1 次` 从不递增：
  //     [RANGE20-TOP5-WARM] 2026-10-20 索引就绪 17/45 ⇒ 3s 后第 1 次重算（已精算 · 封顶 4 次）
  //   后果：主线程被占满，切完日期后「20 日涨幅」要 ~20 秒才出数，用户感知为「逐批、很卡、几分钟」。
  //
  //   ⚠️ 只更新 `readyDays` 不重排：`decideWarmRetry` 的 `reset` 分支正是靠「readyDays 变大」
  //      判断「数据还在路上」，所以这个字段必须刷新（否则会把正在变长的池误判成已停止）。
  //   ⚠️ `verdict === 'reset'` 例外：那是「索引在长、退避次数归零」的情况，本就该更早重算。
  if (st.timer && verdict !== 'reset') {
    st.readyDays = Number(readyDays);
    _warmRetry.set(date, st);
    return;
  }
  if (verdict === 'reset') {
    _dbgLog('[RANGE20-TOP5-WARM] ' + date + ' 索引仍在增长（' + st.readyDays + '→' + readyDays
      + '/' + totalDays + '）⇒ 重置退避继续重算（池空，本次 0 请求）');
    st.n = 0;
  }
  const delay = WARM_RETRY_DELAYS[st.n];
  if (st.timer) clearTimeout(st.timer);
  st.readyDays = Number(readyDays);
  st.timer = setTimeout(function() {
    _warmRetry.set(date, { n: st.n + 1, timer: 0, readyDays: st.readyDays });
    Promise.resolve(ensureRange20Leaders(date, { force: true })).catch(function(e) {
      _dbgLog('[RANGE20-TOP5-WARM] ' + date + ' 预热重算失败（下次再试）: ' + (e && e.message || e));
    });
  }, delay);
  _warmRetry.set(date, st);
  _dbgLog('[RANGE20-TOP5-WARM] ' + date + ' 索引就绪 ' + readyDays + '/' + totalDays
    + ' ⇒ 本次结论不缓存，' + (delay / 1000) + 's 后第 ' + (st.n + 1) + ' 次重算'
    + (cheapCase ? '（池空 · 0 请求，索引继续长就继续算）' : '（已精算 · 封顶 4 次）'));
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
    _wideCache.delete(date);
    _tenCache.delete(date);
    _publish(date, []);
    return _state.value.list;
  }
  const probeDates = getRange20WindowDates(date, RANGE20_PROBE_DAYS);
  const tIsToday = (date === _getLocalTodayStr());
  // 🔴 [R20-TSWITCH] 必须与 range20.js 主 toggle 用同一套 T 腿口径（§6），否则「前五补位」的
  //   涨幅会和同一屏的 20日涨幅列对不上（同一个日期、同一只票出现两个数）。
  const afterClose = isAfterCloseOf(date);
  const legMode = resolveT20LegMode(tIsToday, afterClose);

  // 🔴 [R20-TOP5-TSWITCH 2026-10-20] 口径跨 15:00 变化 ⇒ 会话缓存必须作废重算。
  //   漏掉这条 ⇒ 页面从早盘开到现在会一直显示「前19收盘 × 今天竞价」，与看板另一列的收盘口径打架。
  const prevLeg = _legMode.get(date);
  if (prevLeg && prevLeg !== legMode) {
    _cache.delete(date);
    _wideCache.delete(date);
    _tenCache.delete(date);
    _sig.delete(date);
    _dbgLog('[RANGE20-TOP5-TSWITCH] ' + date + ' 口径 ' + prevLeg + ' → ' + legMode + '：作废缓存并重算');
  }
  // 🔴 [R20-POOL-GROW 2026-10-20] 候选池来自「正式列表索引」，而它是**异步分批加载**的
  //   ⇒ 第一次调用常常只拿到当天那 40 来行（历史日还没到），于是把「前五」算在一份残缺池上
  //   并写进 `_cache`；此后真·第一（10-19 新华传媒 210.98%）永远进不了池 ⇒ 区块显示的是
  //   「残缺池里的第一」。E2E 实测：同一日期两次会话，一次 候选池=175（正确）、一次 43（错）。
  //   判据：池变大 ⇒ 作废缓存重算。池只会单调增长（索引只加不减）⇒ 必然收敛，不会反复重算。
  const rowsByDate = _formalRowsByDate(probeDates);
  const pool = unionPoolFromDates(rowsByDate);
  const poolSig = pool.length;
  // 🔴 [R20-WARM 2026-10-20] 索引预热判据：候选池来自「日 -> 正式列表」索引，索引是按日分批加载的。
  //   未预热完时算出来的前五是从「只加载了一部分日期」的池里选的（实测 10-19 池只有 43 只 =
  //   当天那 43 行，真·第一新华传媒 210.98% 根本不在池里，反而把第 6 名时代万恒补了上去）。
  //   ⇒ 结论照发（用户能尽快看到东西），但**不写会话缓存** + 起一个退避重算。
  const _readyDays = probeDates.reduce(function(a, d) {
    return a + (_isAuctionWatchlistIndexReady(d) ? 1 : 0);
  }, 0);
  const _warm = _readyDays >= Math.ceil(probeDates.length * 0.8);
  const prevPoolSig = _poolSig.get(date);
  if (_cache.has(date) && prevPoolSig !== undefined && poolSig > prevPoolSig) {
    _cache.delete(date);
    _wideCache.delete(date);
    _tenCache.delete(date);
    _sig.delete(date);
    _dbgLog('[RANGE20-TOP5-POOLGROW] ' + date + ' 候选池 ' + prevPoolSig + ' → ' + poolSig + '：作废缓存重算');
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

  const p = (async function() {
    // rowsByDate / pool 已在上面的 [R20-POOL-GROW] 处算好（缓存判据要用池大小）
    if (pool.length === 0) {
      // 正式列表索引还没就绪（§10：未就绪 ≠ 没有股票）⇒ 不发布「空结论」
      _dbgLog('[RANGE20-TOP5] ' + date + ' 候选池为空（正式列表索引可能未就绪），本次不产出');
      // [R20-WARM] 同样起退避重算：索引补齐不改展示日行数 ⇒ 不能只靠 watch。
      // ★ [R20-WARM-GROW 2026-10-26] 第 4 参 true = 池空场景（本次 0 请求）⇒ 索引继续长就继续重算，
      //   不封顶。这是「题材量比永久不出数据」的第二道锁：旧实现 4 次(共 103s)后彻底放弃，
      //   而历史补齐要到首屏 10s + 空闲 + 拉取之后才完成，必然错过这个窗口。
      _scheduleWarmRetry(date, _readyDays, probeDates.length, true);
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
    const tLegsClean = legs20FromRows(pool, probeDates, rowsByDate, {
      tIsToday: tIsToday,
      afterClose: afterClose,
    });
    // ★★ [R20-DAILY 2026-10-30 用户口径] 历史腿改从【逐日腿原料表】取（同花顺日线换算，可信）。
    //   用户原话：「历史数据先存好，次日在算次日……看表里有没有数据，有的话看哪天没有补哪天」。
    //   读失败 / 表还没建 ⇒ dailyMap = null ⇒ dailyLegs 为空 ⇒ 行为与改造前完全一致（§11）。
    //   ⚠️ 粗筛用的 baseLegsDb 也叠上原料腿：库内腿可能是竞价涨幅或整日缺行，
    //      原料腿能覆盖的部分一律以原料为准（更准的粗筛 ⇒ 更少的好票被门槛误杀）。
    const dailyMap = (opts && opts.skipDaily) ? null : await readDailyPctRows(probeDates[0], date);
    const dailyLegs = legs20FromDaily(pool, probeDates, dailyMap);
    const baseLegs = mergeBaseLegs(tLegsClean, dailyLegs);
    const baseLegsDbMerged = mergeBaseLegs(baseLegsDb, dailyLegs);
    if (dailyMap) {
      _dbgLog('[RANGE20-TOP5-DAILY] ' + date + ' 逐日腿表命中 ' + dailyLegs.size + '/' + pool.length + ' 只');
    }
    // 阶段① 粗筛（0 请求）：库内腿 + 门槛 + 只主板
    // 🔴 [R20-PERSTOCK-WIN] 传完整 probeDates（⛔ 不再 slice(-20)）：`compound20` 按每票自己的
    //   最近 20 个有腿日取窗，先截断 20 天会让停牌票无法回溯、粗筛把真龙头筛掉。
    const guessDates = probeDates;
    const coarse = compound20(baseLegsDbMerged, guessDates);
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
    // 🔴 [R20-COARSE-CODE 2026-10-20] `compound20` 只产 `{stock,pct,days}`，**不含 code**
    //   ⇒ 粗筛的「只主板」闸门只能靠 `codeOfRow` 反查股票名册；名册这一刻还没就绪时
    //   全部返回 '' ⇒ `isMainBoardOnly('')` = false ⇒ **428 只候选被一刀切光，粗筛归零**，
    //   表现成「补位区块整块消失」（E2E 实测 tier1=0 tier2=0 进精算=0，而离线诊断算出 73/287）。
    //   修法：候选池 `pool` 里的 code 是从正式列表行 `codeOfRow` 取的，回填给粗筛行（§6 同一套解析）。
    const poolCode = new Map();
    pool.forEach(function(t) { if (t && t.stock && t.code) poolCode.set(t.stock, t.code); });
    // 粗筛排序用「库内近似 ∪ 云端真值」（同名以云端为准 —— 云端是 K 线算的，必然更准）
    const coarseMerged = (function() {
      const m = new Map();
      coarse.forEach(function(r) {
        m.set(r.stock, { stock: r.stock, code: poolCode.get(r.stock) || '', pct: r.pct, days: r.days });
      });
      cloudMap.forEach(function(v, n) {
        if (!poolNames.has(n)) return;
        m.set(n, { stock: n, code: poolCode.get(n) || '', pct: v.pct, days: v.days });
      });
      return Array.from(m.values());
    })();
    // 粗筛分两档，⛔ 别用一个 minDays 一刀切（2026-10-20 的负涨幅补位就是这个错）：
    //   tier1 = 「库内上榜 >= 6 天」⇒ 数据完整，可信度高，优先占精算名额；
    //   tier2 = 「2~5 天」⇒ 数据残缺但**可能是真龙头**（停牌票 / 中途进名单），
    //           只有 tier1 不满 25 只时才补进来。⛔ 绝不能因为天数少就把它们直接丢掉。
    const _allCoarse = rankLeaders(coarseMerged, {
      limit: 0,                       // 0 = 不截断，先拿全量排序
      minDays: RANGE20_LEADER_COARSE_MIN_LEGS,
      mainBoardOnly: true
    });
    const _tier1 = _allCoarse.filter(function(r) { return r.days >= RANGE20_LEADER_MIN_LEGS; });
    const _tier2 = _allCoarse.filter(function(r) {
      return r.days >= RANGE20_LEADER_COARSE_MIN_LEGS && r.days < RANGE20_LEADER_MIN_LEGS;
    });
    const coarseTop = _tier1.concat(_tier2).slice(0, RANGE20_LEADER_PRESELECT);
    // 诊断：粗筛归零时必须能一眼区分「天数不够」还是「代码缺失被主板闸门切光」
    //   （2026-10-20 就是后者：daysMax=20 却 tier1=0，浪费了一轮 rebuild 才发现）
    const _maxDays = coarseMerged.reduce(function(a, r) { return Math.max(a, Number(r.days) || 0); }, 0);
    const _passDays = coarseMerged.filter(function(r) {
      return Number(r.days) >= RANGE20_LEADER_COARSE_MIN_LEGS;
    }).length;
    _dbgLog('[RANGE20-TOP5] ' + date + ' 候选池=' + pool.length + ' 有腿=' + coarseMerged.length
      + ' 粗筛 tier1(>=' + RANGE20_LEADER_MIN_LEGS + '天)=' + _tier1.length
      + ' tier2(' + RANGE20_LEADER_COARSE_MIN_LEGS + '~' + (RANGE20_LEADER_MIN_LEGS - 1) + '天)=' + _tier2.length
      + ' 进精算=' + coarseTop.length + '（只主板）'
      + ' [过门槛=' + _passDays + ' daysMax=' + _maxDays + ']');
    _dbgLog('[RANGE20-TOP5] ' + date + ' 粗筛前 10：' + coarseTop.slice(0, 10).map(function(t) {
      return t.stock + ' ' + t.pct.toFixed(2) + '%/' + t.days + 'd';
    }).join(' , '));
    if (opts && opts.skipKline) {
      // ★ [EBB-MAIN-TOPIC 2026-10-25] 诊断/单测路径只跑粗筛：宽榜与前十也按同一份粗筛结果裁出来，
      //   ⛔ 不能留空 —— 否则调用方（退潮判定）会误以为「该日没有前十结论」而退回前五去数题材。
      if (coarseTop.length > 0) {
        _wideCache.set(date, coarseTop.slice(0, RANGE20_LEADER_WIDE_N));
        _tenCache.set(date, coarseTop.slice(0, RANGE20_LEADER_TEN_N));
      }
      return _publish(date, coarseTop.slice(0, RANGE20_LEADER_TOP_N));
    }
    if (coarseTop.length === 0) {
      _wideCache.delete(date);
      _tenCache.delete(date);
      _publish(date, []);
      return _state.value.list;
    }

    // 阶段② 精算（<=25 请求）：补满 20 天 K 线后重算
    //   跨日期复用：同一只票 + 同一窗口首日 ⇒ 请求内容完全相同 ⇒ 只发一次（切日期不重复烧请求）
    //   🔴 [R20-CLOUD] 云端表已有真值的票不再请求（0 请求复用）。
    //   🔴 [R20-KACC] 上一轮已拿到的 K 线腿从 `_klineAcc` 复用 ⇒ 重算时 0 请求且**不会丢腿**。
    const winKey = probeDates[0] || '';
    const extraByStock = _klineAcc.get(date) || new Map();
    // ★★ [R20-REQT 2026-10-30] 收盘口径下「缺 T 腿」也算要补（与 range20.js 同一份判据，§6）。
    //   原因：候选池里大量票今天没上正式名单 ⇒ 没有当天行 ⇒ 没有 T 腿。若因「历史腿够」就跳过，
    //   `compound20` 会往前多取一根凑满 20 ⇒ 锚点变成「截至昨天收盘」，
    //   而同屏上了榜的票锚点是「今天收盘」⇒ **前10 内部基准不一致**（排名会串）。
    //   ⚠️ 盘中（'auc'）不传：K 线的今日是现价，补了也用不上。
    //   ⚠️ 代价可控：coarseTop 最多 25 只，一天一次；早盘主场景（'auc'）仍然 0 请求。
    const _legOpts = { requireT: (legMode === 'close') };
    const todo = coarseTop.filter(function(t) {
      if (extraByStock.has(t.stock)) return false;
      if (_klineTried.has(t.stock + '@' + winKey)) return false;
      if (cloudMap.has(t.stock)) return false;
      // ★★ [R20-DAILY 2026-10-30] 原料表里腿够的票 ⇒ 一个请求都不发（秒开的关键）。
      //   表空 / 表不可用 ⇒ 每只都不够 ⇒ todo = 全部 ⇒ 与改造前一致（§11）。
      return needsKlineLegs(baseLegs, t.stock, date, undefined, _legOpts);
    });
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
        _klineAcc.set(date, extraByStock);
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

    // ========================================================================
    // 🔴🔴 [R20-TOP5-POOL 2026-10-20] 排名池 = 四层【由可信到兜底】，⛔ 绝不允许「精算失败 ⇒ 强票消失」
    //   合并规则与踩坑经过全部收敛在 `buildLeaderRankPool` 的注释里（纯函数，可单测）。
    //   一句话：粗筛近似是**底座**，云端/主看板/本轮精算依次覆盖它；
    //   这样「前五的成员」永远来自全池最强的一批，不会因为上游限流降级成一批弱势票。
    // ========================================================================
    const _live = (function() {
      try { return getRange20Pct(date); } catch (e) { return null; }
    })();
    const rankPool = buildLeaderRankPool({
      coarseTop: coarseTop,
      cloudMap: cloudMap,
      liveMap: _live,
      fresh: fresh,
      poolNames: poolNames,
      minLegs: RANGE20_LEADER_MIN_LEGS
    });
    // 🔴 [R20-COARSE-CODE] 排名池里「云端 / 主看板 / 本轮精算」这三层都不带 code
    //   （它们的来源分别是表行与内存 map，只有 pct+days）⇒ 必须在这里统一回填，
    //   否则下面的「只主板」闸门会把这三层全切掉，前五只剩粗筛层 —— 又是一个静默失效。
    rankPool.forEach(function(r) { if (!r.code) r.code = poolCode.get(r.stock) || ''; });
    const rankMap = new Map();
    rankPool.forEach(function(r) { rankMap.set(r.stock, r); });
    // ★★ [NEW-DRAGON-08 2026-10-22] 一次裁两份：宽榜（前 8，给第二十八条挑新龙）+ 前 5（发布，展示不变）。
    //   ⛔ 别为了宽榜再跑一轮：同一份 rankPool、同一把 rankLeaders，前 5 名逐只相同。
    // ★★ [EBB-MAIN-TOPIC 2026-10-25] 改成「裁一次前十，再切出前八 / 前五」——三份必然同源：
    //   切法 = 数组前缀，与「分别以 limit 5/8/10 各调一次 rankLeaders」逐只等价（同一把 sort），
    //   但只有一次排序开销，且从结构上保证「前十的前五 ≠ 前五」这种漂移不可能发生（§6）。
    const ten = rankLeaders(rankPool, {
      limit: RANGE20_LEADER_TEN_N,
      minDays: RANGE20_LEADER_MIN_LEGS,
      mainBoardOnly: true
    });
    const wide = ten.slice(0, RANGE20_LEADER_WIDE_N);
    const top = ten.slice(0, RANGE20_LEADER_TOP_N);
    // 把代码补回结果里（`compound20` 只产 {stock,pct,days}，不含 code）：
    //   视图层注入补位行时可以直接用，省一次名册查询；也给「只有代码才能判板块」留了可追溯的痕迹。
    const _coarseCode = new Map();
    coarseTop.forEach(function(t) { if (t.code) _coarseCode.set(t.stock, t.code); });
    top.forEach(function(t) { if (!t.code) t.code = _coarseCode.get(t.stock) || ''; });
    // ★ [NEW-DRAGON-08 2026-10-22] 宽榜同样补码（第 6~8 名不在 top 里，必须单独补一次）
    wide.forEach(function(t) { if (!t.code) t.code = _coarseCode.get(t.stock) || ''; });
    // ★ [EBB-MAIN-TOPIC 2026-10-25] 前十同样补码（第 9~10 名不在宽榜里）
    ten.forEach(function(t) { if (!t.code) t.code = _coarseCode.get(t.stock) || ''; });
    // 诊断：前五里哪些是「精算真值」、哪些是「粗筛近似」（approx=1 说明这只票的 K 线没拿到）
    let _approxCnt = 0;
    rankMap.forEach(function(v) { if (v.approx) _approxCnt++; });
    _dbgLog('[RANGE20-TOP5-PUB] ' + date + ' 精算 realDays=' + realDates.length
      + ' 精算腿=' + extraByStock.size + '/' + coarseTop.length
      + ' 云端=' + cloudMap.size + ' 主看板真值=' + (_live ? _live.size : 0)
      + ' 近似兜底=' + _approxCnt
      + ' 前五=' + top.map(function(t) {
        const r = rankMap.get(t.stock);
        return t.stock + ' ' + t.pct.toFixed(2) + '%/' + t.days + 'd' + (r && r.approx ? '(近似)' : '');
      }).join(' , '));
    _publish(date, top, _warm);
    // ★ [NEW-DRAGON-08 2026-10-22] 宽榜（前八）独立存一份：只给第二十八条挑新龙，
    //   ⛔ 不进 `_state.list`（否则 20日涨幅 toggle 会平白多出 3 只 —— 用户没让改那个）。
    if (wide.length > 0) _wideCache.set(date, wide); else _wideCache.delete(date);
    // ★ [EBB-MAIN-TOPIC 2026-10-25] 前十同样独立存一份：只给退潮判定的「主线题材成组」计数，
    //   ⛔ 不进 `_state.list` / 不上屏（用户只让改判定，没让多看两行）。
    if (ten.length > 0) _tenCache.set(date, ten); else _tenCache.delete(date);
    // 🔴 [R20-POOL-GROW] 记下本次用的池大小 ⇒ 池变大时据此作废缓存重算
    _poolSig.set(date, poolSig);
    // 🔴 [R20-WARM] 索引没预热完 ⇒ 退避重算（4 次封顶：3s/10s/30s/60s）。
    //   ⛔ 不能只靠 watch 再触发：watch 盯的是「展示日的行数」，历史日索引加载完并不会改行数。
    //   ★ 第 4 参 false = 已经烧过 K 线精算 ⇒ 保持封顶（重算会再打一批同花顺，§32）。
    //     这条链路由「补齐完成 → emit('auction-refresh')」兜底，不依赖时间重试。
    if (!_warm) _scheduleWarmRetry(date, _readyDays, probeDates.length, false);
    // 🔴 [R20-TOP5-TSWITCH] 记录本次口径 ⇒ 跨 15:00 时据此作废缓存重算（见函数开头）
    _legMode.set(date, legMode);
    // 🔴 [R20-CLOUD] 把本轮真拿到 K 线的票落库 ⇒ 主 toggle 下次打开可 0 请求复用（两个模块共享同一张表）。
    //   只写「确实有 K 线腿的票」，⛔ 不写只有 T 腿的残缺值（§10：宁缺勿错，残缺值落库会永久污染）。
    try {
      const _toSave = fresh.filter(function(r) {
        return r && r.stock && extraByStock.has(r.stock) && r.days >= RANGE20_LEADER_MIN_LEGS;
      });
      if (_toSave.length > 0) await upsertRange20Rows(date, _toSave, legMode);
    } catch (e) { /* 落库失败静默：正确性不依赖它 */ }
    // ★★ [R20-DAILY 2026-10-30 用户口径] 把本轮拿到的逐日腿写进原料表 ⇒ 明天/换设备都不用再拉。
    //   ⚠️ 只写 T 日之前的腿（盘中"今天"那根是现价，写进原料表会被当成收盘腿，静默算错）。
    try {
      const _dailyRows = dailyRowsFromKline(extraByStock, date);
      if (_dailyRows.length > 0) {
        const n = await upsertDailyPctRows(_dailyRows);
        if (n > 0) _dbgLog('[RANGE20-TOP5-DAILY] ' + date + ' 写入逐日腿 ' + n + ' 行');
      }
    } catch (e) { /* 原料落库失败不影响本次结果 */ }
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
