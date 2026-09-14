// dragon-group.js — 「龙头组」评选与名册编排（Logic 层，§15 独立业务模块）
//
// ============================ 产品口径 ============================
//   · 按【题材】选龙头：某日该题材成员 >= 3 只（DRAGON_GROUP_MIN_SIZE）时，选出【唯一一只】龙头；
//   · 依据 = 该股「近 10 个交易日区间涨幅」（权威值来自 stock_range_pct，见 dragon-rank.js）；
//   · 龙头【落库】到 dragon_leaders，键 = 评选日 date（= 选出它的那一天 T）；
//   · 看板看某日 D 时，龙头组 = 名册中 date = prevTradingDay(D) 的行 —— 即「每天的龙头放到次日」。
//
// ============================ 为什么必须落库 ============================
//   ① §6 单一真相：只算一次、只存一份。前端展示（次日龙头组）与 worker 9:25 抓取名单
//      共用同一份名册 —— 否则「前端算一套、worker 算一套」必分叉，规则一改就漏改。
//   ② 需求（9:25 自动抓取要【完整获取】龙头组数据）：worker 9:25 按本表 date=前一交易日
//      把龙头并入抓取名单，本表就是 worker 的输入。
//
// ============================ 为什么评选放在前端而不是 worker ============================
//   评选的【候选池】= 当日全列表（正式成员 + 观察组继承票）。而「观察组继承票」是前端派生结果
//   （前一日竞昨高光集 ∪ 打标签继承），其中「未落库的空壳行」在云端 auction_watchlist 里并不存在
//   —— worker 只读 DB 无法还原同一份池子。若让 worker 再实现一套池子/题材分组逻辑，
//   就会产生第二个真相源（§6 红线）。因此：**评选唯一实现在前端，worker 只读结果**。
//
// 红线（§10）：读取失败必须 throw（由调用方 loud 记录），绝不返回空名册伪装成「今天没有龙头」。
// 红线（§6）：不新增第二个真相源，不写任何「回退/兼容」分支。

import { ref } from 'vue';
import { getPreviousTradingDay, isTradingDay } from '../date/trading-day-helpers.js';
import { getGroupData } from '../app-core-api.js';
import { getTopicGroups } from '../topic/rules.js';
import { getJingYestHighlightSetForDate } from './sort-rules.js';
import { getDragonRangePct, ensureDragonRangePct, isAuthoritativeCloseReached } from './dragon-rank.js';
import { readDragonLeadersForDate, upsertDragonLeaders } from '../../data/dragon-leaders.js';
// 补评选历史日时直接读云端权威区间涨幅（不碰 dragon-rank 的单日期状态，见 _computeAndPersist 注释）
import { readRangePctForDate } from '../../data/stock-range-pct.js';
import { getStockCode } from '../../data/stock-code-map.js';
// [DRAGON-GROUP 2026-09-14] 评选判定下沉到【零依赖叶子】dragon-leader-pick.js（§I 解环 + §6 单一真相 + 可单测）。
// 本文件只负责「池子组装 / 闸门 / 读写名册」，不再自己实现一遍「谁涨得最多」。
import { pickTopicLeaders } from './dragon-leader-pick.js';
import { _getLocalTodayStr } from '../tagTitles/rules.js';
import { _dbgLog } from '../../data/debug-log.js';

/** 该题材至少需要多少成员才评选龙头（需求：三只及以上） */
export const DRAGON_GROUP_MIN_SIZE = 3;

// ===== 状态（模块级 ref，§7：不进 Pinia，遵循 dragon-rank.js 同款 ref-driven 范式）=====
// date = 【展示用】日期 D（不是评选日）；map = D 的龙头组（= 评选日 prevTradingDay(D) 的名册）
const dragonGroupState = ref({ date: '', map: new Map(), version: 0 });
let _inflight = null;                 // { date, promise } 单飞保护
// 本会话已「得出终局结论」的【评选日】：要么成功评选并落库，要么确认该日无「成员>=3」的题材。
// 用途：① 幂等（同一评选日不重复评选/写入）；② 允许「区间涨幅尚未就绪」时后续自动重试（那种情况不登记）。
const _resolvedDates = new Set();
const _persistInflight = new Map();   // 评选日落库单飞（避免同一评选日并发写两次）

/** 名册行的「区间涨幅」取值：兼容两种形状 —— 云端读出的是 rangePct，评选产出的是 pct。 */
function _pctOf(r) {
  if (!r) return null;
  const v = (r.rangePct !== undefined) ? r.rangePct : r.pct;
  if (v === null || v === undefined || v === '' || isNaN(Number(v))) return null;  // 绝不当 0
  return Number(v);
}

/**
 * 同步读取某【展示日】的龙头组（仅当已加载且日期匹配时有效，否则返回 null）。
 * 供 view-helpers 在渲染期同步调用（§17 ref-driven，绝不阻塞渲染）。
 * @param {string} date 展示日 D
 * @returns {Map<string, {topic:string, pct:number|null, groupSize:number, code:string}>|null}
 */
export function getDragonLeadersForDisplay(date) {
  const s = dragonGroupState.value;
  if (!date || s.date !== date) return null;
  return s.map;
}

/** 增量渲染指纹令牌：龙头组变化时必须让行缓存整体失效。 */
export function getDragonGroupFingerprintToken() {
  const s = dragonGroupState.value;
  return s.date + '|v' + s.version + '|n' + s.map.size;
}

export function clearDragonGroup() {
  if (dragonGroupState.value.date === '' && dragonGroupState.value.map.size === 0) return;
  dragonGroupState.value = { date: '', map: new Map(), version: dragonGroupState.value.version + 1 };
}

function _publish(date, map) {
  dragonGroupState.value = { date: date, map: map, version: dragonGroupState.value.version + 1 };
}

/**
 * 确保「展示日 D 的龙头组」已加载，并在条件满足时评选 + 落库 D 自己的名册（供 D+1 展示）。
 * @param {string} date 展示日 D（= 看板当前日期）
 * @param {{force?:boolean}} [opts]
 * @returns {Promise<Map<string, object>|null>}
 */
export async function ensureDragonGroup(date, opts) {
  const force = !!(opts && opts.force);
  if (!date) return null;
  if (_inflight && _inflight.date === date && !force) return _inflight.promise;
  const p = _load(date, force);
  _inflight = { date: date, promise: p };
  try {
    return await p;
  } finally {
    if (_inflight && _inflight.promise === p) _inflight = null;
  }
}

async function _load(date, force) {
  // ---- ① 读「展示用」名册：评选日 = 前一交易日 ----
  // 读取失败必须向上抛（§10）：绝不用空名册顶替「今天没有龙头」——
  // 由调用方 loud 记录并把该行留空，而不是显示成「龙头组为空」。
  const prevDate = getPreviousTradingDay(date);
  const stale = dragonGroupState.value.date !== date;
  if (force || stale) {
    let rows = prevDate ? await readDragonLeadersForDate(prevDate) : [];   // 失败 → throw

    // ---- ①b 补评选（自愈）：前一交易日名册为空 → 就地评选 + 落库 ----
    // 为什么必须有这一步（否则功能会「时有时无」）：
    //   评选只在「评选日收盘口径已权威之后」发生（见 _computeAndPersist 的闸门），而 15:00 之后
    //   是「有没有设备开着看板」决定的 —— 若那天盘后没人打开看板，名册就没人写，
    //   于是次日龙头组整天为空，而这笔信息【永久丢失】（用户需求恰恰就是「次日看龙头」）。
    //   在这里补：次日（或更晚）打开看板、发现前一交易日名册为空时，就地评选并落库。
    // 安全性（三条）：
    //   ① 闸门复用同一套（_computeAndPersist）：评选日必须是「今天或过去的交易日」且已过收盘权威口径
    //      → 用的是权威收盘口径，不会产出一份「收盘后需要被推翻」的名单；
    //   ② 幂等：_resolvedDates 保证同一评选日每会话只算/写一次（跨会话也只会在仍为空时补算）；
    //   ③ 空名册有两种成因——「该日没有成员>=3 的题材」或「那天没人开页面」——两种都值得补算一次，
    //      算完若确实没有龙头，就登记为终局结论，不再反复重算。
    if (prevDate && rows.length === 0) {
      try {
        const picked = await _computeAndPersist(prevDate, { isDisplayDate: false });
        if (picked && picked.length > 0) rows = picked;
      } catch (e) {
        _dbgLog('[DRAGON-GROUP] 补评选 ' + prevDate + ' 失败（不影响本次展示）: ' + (e && e.message || e));
      }
    }

    const map = new Map();
    rows.forEach(function(r) {
      if (!r || !r.stock) return;
      const nm = String(r.stock).trim();
      if (!nm) return;
      map.set(nm, { topic: r.topic, pct: _pctOf(r), groupSize: Number(r.groupSize) || 0, code: r.code || '' });
    });
    _publish(date, map);
  }

  // ---- ② 评选 + 落库 D 自己的名册（best-effort：失败只留痕，绝不阻断看板渲染）----
  // isDisplayDate: true → 复用 dragon-rank 已按当前展示日发布的区间涨幅（同一天，不会互相覆盖）。
  try {
    await _computeAndPersist(date, { isDisplayDate: true });
  } catch (e) {
    _dbgLog('[DRAGON-GROUP] 评选/落库失败（不影响本次展示）: ' + (e && e.message || e));
  }
  return dragonGroupState.value.date === date ? dragonGroupState.value.map : null;
}

/**
 * 评选并落库【评选日 date】的龙头名册。幂等：同一评选日每会话最多写一次；
 * 且只在「收盘口径已权威」后评选（否则会拿竞价腿选出一份需要被推翻的名单）。
 * @param {string} date 评选日 T
 * @param {{isDisplayDate?:boolean}} [opts] isDisplayDate=true 表示 date 就是看板当前展示日
 *        （走 ensureDragonRangePct，可复用/发布 dragon-rank 的区间涨幅状态）；
 *        false/缺省 = 补评选历史日（只读云端，绝不触碰 dragon-rank 的单日期状态）。
 * @returns {Promise<Array<object>>} 本次评选结果（未评选则为空数组）
 */
async function _computeAndPersist(date, opts) {
  const isDisplayDate = !!(opts && opts.isDisplayDate);
  if (!date) return [];
  const today = _getLocalTodayStr();
  if (today && date > today) return [];                  // 未来日：不评选（§10 宁缺勿错）
  try {
    if (!isTradingDay(date)) return [];                  // 非交易日：不评选
  } catch (e) {
    return [];                                           // 交易日历读不到 → 不猜（不评选）
  }
  // 收盘口径闸门：15:00~16:05 之间 change_pct 可能仍是 9:25 竞价副本，
  // 用它选出龙头会在 16:05 后被推翻（一个题材先写 A 再写 B）。统一等权威收盘口径。
  if (!isAuthoritativeCloseReached(date)) return [];

  if (_resolvedDates.has(date)) return [];
  if (_persistInflight.has(date)) return _persistInflight.get(date);
  const p = (async function() {
    // 十日区间涨幅（0 请求优先，必要时走 dragon-rank 既有兜底链）
    let rp = null;
    if (isDisplayDate) {
      await ensureDragonRangePct(date);
      rp = getDragonRangePct(date);
    } else {
      // [DRAGON-GROUP 2026-09-14] 补评选（非展示日）：【绝不】调用 ensureDragonRangePct ——
      // 它是单日期状态（dragonState 只持有一个 date），传历史日会把「当前展示日」的
      // 10 日涨幅 / 题材龙头徽章 / 展开面板的「10日涨幅」一起覆盖成历史日数据（表现为徽章掉色、展开缺项）。
      // 补评选只需要「那一天已落库的权威区间涨幅」，直接读云端即可（失败不抛，只留痕）。
      try {
        rp = await readRangePctForDate(date);
      } catch (e) {
        _dbgLog('[DRAGON-GROUP] 补评选读区间涨幅失败(' + date + '): ' + (e && e.message || e));
        return [];
      }
    }
    if (!rp || rp.size === 0) {
      // ⚠️ 刻意【不登记】_resolvedDates：区间涨幅这次没就绪（如 9:25 早盘云端还没写行），
      // 要允许后续（跨过收盘口径 / 云端到货后）再自动重试，否则该日龙头会永久缺失。
      _dbgLog('[DRAGON-GROUP] ' + date + ' 区间涨幅为空 → 本次不评选（等其就绪，后续会自动重试）');
      return [];
    }
    const list = _buildPool(date);
    if (!list || list.length === 0) {
      _dbgLog('[DRAGON-GROUP] ' + date + ' 候选池为空 → 本次不评选');
      return [];
    }
    const groups = getTopicGroups(list);
    const picked = pickTopicLeaders(groups, rp, DRAGON_GROUP_MIN_SIZE, getStockCode);
    if (picked.length === 0) {
      _resolvedDates.add(date);          // 终局结论：该日确实没有「成员>=3」的题材 → 不再重算
      _dbgLog('[DRAGON-GROUP] ' + date + ' 无「成员>=3」的题材 → 本次无龙头');
      return [];
    }
    await upsertDragonLeaders(date, picked);
    _resolvedDates.add(date);
    _dbgLog('[DRAGON-GROUP] ' + date + ' 评选并落库 ' + picked.length + ' 只龙头：' +
      picked.map(function(r) { return r.topic + '→' + r.stock + '(' + Number(r.pct).toFixed(2) + '%)'; }).join('、'));
    return picked;
  })();
  _persistInflight.set(date, p);
  try {
    return await p;
  } finally {
    _persistInflight.delete(date);
  }
}

/**
 * 评选候选池 = 当日【全列表】：
 *   ① 当日 auction_watchlist 行（正式成员 + 已落库的观察组行）；
 *   ② 前一日「竞昨高光」继承票（= 观察组主来源，可能只在视图层存在、未落库）；
 *   ③ 前一日打标签买入继承票（obsBought_<date>，与 view-helpers 同源同口径）。
 * 口径必须与 view-helpers#computeAuctionViewData 的观察组归属保持一致（§6 同一判定不写两份）。
 * @param {string} date
 * @returns {object[]} 供 getTopicGroups 分组的行（至少含 stock；尽量带上 note/topics）
 */
function _buildPool(date) {
  const byName = new Map();
  function _put(row) {
    if (!row || !row.stock) return;
    const n = String(row.stock).trim();
    if (n && !byName.has(n)) byName.set(n, row);
  }
  const dayList = (getGroupData('auction') || {})[date] || [];
  dayList.forEach(_put);

  const prevDate = getPreviousTradingDay(date);
  const extraNames = new Set();
  try {
    const set = prevDate ? getJingYestHighlightSetForDate(prevDate) : null;
    if (set) set.forEach(function(n) { if (n) extraNames.add(String(n).trim()); });
  } catch (e) {
    _dbgLog('[DRAGON-GROUP] 前一日竞昨高光读取失败: ' + (e && e.message || e));
  }
  try {
    // 合规（§8）：obsBought_<date> 是「防重复/调试标记」型本地缓存，与 view-helpers 同源；
    // 它不是业务真相源（业务真相 = auctionTagStore），此处只用于还原观察组继承池。
    const bought = JSON.parse(localStorage.getItem('obsBought_' + date) || '[]');
    bought.forEach(function(n) { if (n) extraNames.add(String(n).trim()); });
  } catch (e) { /* 无 localStorage / 解析失败 → 忽略该来源，不影响主池 */ }

  extraNames.forEach(function(n) {
    if (!n || byName.has(n)) return;
    byName.set(n, { stock: n, code: getStockCode(n) });
  });
  return Array.from(byName.values());
}
