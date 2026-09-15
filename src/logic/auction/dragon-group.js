// dragon-group.js — 「龙头组」评选与名册编排（Logic 层，§15 独立业务模块）
//
// ============================ 产品口径 ============================
//   · 按【题材】选龙头：某日该题材成员 >= 3 只（DRAGON_GROUP_MIN_SIZE）时，选出【唯一一只】龙头；
//   · 依据 = 该股「近 10 个交易日区间涨幅」（权威值来自 stock_range_pct，见 dragon-rank.js）；
//   · 龙头【落库】到 dragon_leaders，键 = 评选日 date（= 选出它的那一天 T）；
//   · 看板看某日 D 时，龙头组 = 名册中 date = prevTradingDay(D) 的行 —— 即「每天的龙头放到次日」。
//
// ============================ 按哪个口径分题材（2026-09-14 修正）============================
//   【必须】用「单独打开题材 toggle」时的分类，而不是第二页题材分类。二者对同一只股票给出的归属不同：
//     · 第二页 getTopicGroups：一只票命中的所有核心词都建组 → 同一只票同时出现在【多个】题材里；
//     · 题材 toggle（getPrimaryTopicMap + classifyStockPrimaryTopic）：一只票只落在一个题材组里
//       （首页是单列，无法像第二页那样同时出现在多个分节）。
//   用户实测投诉：9/11 题材 toggle 里「大消费」龙一=国芳集团 96.04%、龙二=桂林旅游 60.23%，
//   但 9/14 的龙头组里桂林旅游也在 —— 因为按第二页口径它另属某个题材并当上了那个题材的龙头，
//   于是「一个题材只有一只龙头」被破坏、龙头组里冒出多余的人。
//   → 评选改为复用题材 toggle 的同一套分类函数（§6 单一真相，不另写一份）。
//
// ============================ 为什么必须落库 ============================
//   ① §6 单一真相：只算一次、只存一份。前端展示（次日龙头组）与 worker 9:25 抓取名单
//      共用同一份名册 —— 否则「前端算一套、worker 算一套」必分叉，规则一改就漏改。
//   ② 需求（9:25 自动抓取要【完整获取】龙头组数据）：worker 9:25 按本表 date=前一交易日
//      把龙头并入抓取名单，本表就是 worker 的输入。
//
// ============================ 什么时候评选（时间口径 · 2026-09-15 明确）============================
//   评选【基准日 T】= 选出龙头的这一天；看板看第 D 天时显示的是 date = prevTradingDay(D) 的名册。
//   ⚠️ 评选【不在】次日 9:25 做，也不在 15:00 收盘那一刻做，而是等【收盘口径权威之后】：
//     · 依据 = 该股在 T 日的「近 10 个交易日区间涨幅」，其 T 腿源自 T 日【收盘涨幅】；
//     · 15:00~16:05 之间 market_metrics.change_pct 很可能还是 9:25 竞价副本（worker 16:00 才重算收盘值）
//       → 用竞价口径选出的龙一在 16:05 后会被推翻（同一题材先写 A 再写 B）；
//     · 因此闸门统一取 isAuthoritativeCloseReached(T) = 北京 16:05（= worker 收盘重算完成时刻，见 dragon-rank.js）。
//   ⇒ 结论：T 日傍晚（16:05 之后）评选 T 日名册 → T+1 当天看板即可看到【完整且已定稿】的龙头组。
//   触发方式（前端为唯一执行者，原因见下节）：
//     ① 打开看板 / 切日期 / 当日起伏 → _load 的 ② 步评选「展示日 D 自己」的名册；
//     ② 每 5 分钟轮询（useAuctionBoard 的 CLOSE_COVER_POLL_MS）在跨过 16:05 后自动补上；
//     ③ 若 T 日盘后【没有任何设备开着看板】→ 名册为空 → 次日（或更晚）打开看板时，_load 的 ①b 步
//        会就地补评选 T 日并落库（自愈），因此这笔信息不会被永久丢失。
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
import { getTodayGroupList } from '../app-core-api.js';
// [DRAGON-GROUP 2026-09-14] 题材归属改用【题材 toggle 同款】分类函数（getPrimaryTopicMap /
// classifyStockPrimaryTopic）；不再 import getTopicGroups —— 那是第二页题材分类的口径
// （一只票可属多个题材），用它选龙头会选出「一个题材多只龙头 / 一只票当别的题材的龙头」。
import { getPrimaryTopicMap, classifyStockPrimaryTopic } from './topic-sort.js';
import { getJingYestHighlightSetForDate } from './sort-rules.js';
import { getDragonRangePct, ensureDragonRangePct, isAuthoritativeCloseReached } from './dragon-rank.js';
import { readDragonLeadersForDate, upsertDragonLeaders, deleteDragonLeadersForDate } from '../../data/dragon-leaders.js';
// [DRAGON-GROUP 2026-09-14 · 龙头组消失] §10 就绪闸门：评选候选池依赖「该日正式名单」，
// 索引未就绪（= 数据还没拉到）时不得评选、更不得登记「该日没有龙头」的终局结论。
import { _isAuctionWatchlistIndexReady } from '../../data/watchlist-and-metrics.js';
// 补评选历史日时直接读云端权威区间涨幅（不碰 dragon-rank 的单日期状态，见 _computeAndPersist 注释）
import { readRangePctForDate } from '../../data/stock-range-pct.js';
import { getStockCode } from '../../data/stock-code-map.js';
// [DRAGON-GROUP 2026-09-15 · §10 题材库就绪闸门] 评选的第二条腿（题材分类）依赖共享题材库兜底；
// 库未就绪时分类会整体退化成「其它」→ 一个题材都凑不够 3 只 → 写出残缺名册（实测 9/15 只剩 1 只）。
import { isTopicLibraryReady, ensureTopicLibraryLoaded } from '../../data/stock-topics.js';
// [DRAGON-GROUP 2026-09-15] 补评选前把「前一交易日」的名单数据拉进内存（既有「按天补拉」入口，
// 幂等 + 单飞 + 窗口内日期 no-op，§32 禁止重复请求）。历史数据必然可取 → 补算必须能成功。
import { ensureAuctionDateDataLoaded } from './auction-pull-window.js';
// [DRAGON-GROUP 2026-09-14] 评选判定下沉到【零依赖叶子】dragon-leader-pick.js（§I 解环 + §6 单一真相 + 可单测）。
// 本文件只负责「池子组装 / 闸门 / 读写名册」，不再自己实现一遍「谁涨得最多」。
import { pickTopicLeaders, buildTopicGroupsFromPool, planRosterReconcile } from './dragon-leader-pick.js';
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

/**
 * 内容比对：两份名册 Map 是否等价（用于幂等发布）。
 * 只比「会渲染出来的字段」——topic / pct / groupSize / code。
 */
function _sameDragonMap(a, b) {
  if (a === b) return true;
  if (!a || !b || a.size !== b.size) return false;
  let same = true;
  a.forEach(function(v, k) {
    if (!same) return;
    const w = b.get(k);
    if (!w) { same = false; return; }
    if (w.topic !== v.topic || w.pct !== v.pct || w.groupSize !== v.groupSize || w.code !== v.code) same = false;
  });
  return same;
}

/**
 * 发布名册（幂等）。
 * 为什么必须幂等（2026-09-14 · 病灶 G）：version 参与增量渲染指纹
 *   （getDragonGroupFingerprintToken = date|vN|nM）→ 指纹一变 → rowCache 全清 + viewData 重算
 *   → 可能再次触发 ensure（watch 链）→ 又 publish …即每秒循环。
 *   而空名册（前一交易日补不出来 / 非交易日 / 未来日）会反复走到这里，
 *   只有「内容未变则不发布」才能从根上斩断循环（与 dragon-rank 的 DATE-GATE 幂等同一范式）。
 */
function _publish(date, map) {
  const s = dragonGroupState.value;
  if (s.date === date && _sameDragonMap(s.map, map)) return;   // 内容未变化 → 不发布、不 bump version
  dragonGroupState.value = { date: date, map: map, version: s.version + 1 };
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
  const cur = dragonGroupState.value;
  const stale = cur.date !== date;

  // 展示名册为空、且该评选日并非「已确认无龙头」→ 需要重读补齐。
  //   为什么不能只看 stale（用户实测「龙头组整块不见」的成因之一）：
  //     首屏加载中第一次读到的名册可能是空（数据尚未就绪），而 stale 之后恒为 false
  //     → 不再重读 → 即使数据到货，龙头组**整个会话都空**。needFill 让它在数据到货后自动补齐。
  //   ⚠️ 此处刻意**不加**「前一交易日名单已就绪」闸门：名册是云端既有事实，就绪与否都必须能读到并展示。
  const needFill = !stale && prevDate && (!cur.map || cur.map.size === 0) && !_resolvedDates.has(prevDate);
  // [DRAGON-GROUP 2026-09-15 · 残缺名册自愈] 触发条件从「名册为空」升级为「收盘口径已权威、且本会话尚未对齐过」。
  //   为什么必须升级（实测事故 9/15 → 9/16 只剩 1 只龙头）：
  //     旧条件只看 rows.length===0。而 9/15 那次评选因【题材库未就绪】只写出了 1 行 → 名册非空
  //     → 补评选被跳过 → upsert 又只增不删 → 这行残缺被永久冻结：9/16 整天只显示 1 只龙头，
  //     且无论刷新多少次都不会自愈。
  //   新条件让「权威评选日」在每会话至少被**整表对齐**一次（upsert 本次结果 + 清掉已不成立的题材行），
  //   于是残缺名册会被正确结果覆盖，而不是永久冻结。
  //   成本可控：对齐成功即登记 _resolvedDates（同一评选日每会话只做一次）；未就绪时返回空且**不登记**，
  //   数据到货后由 needFill / 轮询自动重试。
  //   ⚠️ 只在「收盘口径权威」后对齐：否则等于用竞价口径产出一份马上要被推翻的名单。
  const needReconcile = !!prevDate && isAuthoritativeCloseReached(prevDate) && !_resolvedDates.has(prevDate);
  if (force || stale || needFill || needReconcile) {
    let rows = prevDate ? await readDragonLeadersForDate(prevDate) : [];   // 失败 → throw

    // ---- ①b 补评选 / 整表对齐（自愈）：权威评选日的名册为空【或残缺】时，就地重评选 + 落库 ----
    // 为什么必须有这一步（否则功能会「时有时无」）：
    //   评选只在「评选日收盘口径已权威之后」发生（见 _computeAndPersist 的闸门），而 16:05 之后
    //   是「有没有设备开着看板」决定的 —— 若那天盘后没人打开看板，名册就没人写，
    //   于是次日龙头组整天为空，而这笔信息【永久丢失】（用户需求恰恰就是「次日看龙头」）。
    //   在这里补：次日（或更晚）打开看板、发现前一交易日名册为空/残缺时，就地重评选并落库。
    // 安全性（四条）：
    //   ① 闸门复用同一套（_computeAndPersist）：评选日必须是「今天或过去的交易日」且已过收盘权威口径
    //      → 用的是权威收盘口径，不会产出一份「收盘后需要被推翻」的名单；
    //   ② 幂等：_resolvedDates 保证同一评选日每会话只算/写一次（跨会话也只会在仍为空/残缺时补算）；
    //   ③ 落库走 _reconcileRoster（整表对齐）→ 残缺行会被覆盖而不是叠加；
    //   ④ 空名册有两种成因——「该日没有成员>=3 的题材」或「那天没人开页面」——两种都值得补算一次，
    //      算完若确实没有龙头，就登记为终局结论，不再反复重算。
    if (needReconcile) {
      // [DRAGON-GROUP 2026-09-15] 补评选前**先确保该历史日的名单数据已加载**（否则补算必白跑）。
      //   评选的候选池与题材分组都建立在「该日正式名单」（getTodayGroupList）之上，而它在
      //   `_isAuctionWatchlistIndexReady(prevDate)` 为 false 时会退化为原始列表（§10）→ 题材成员数虚低
      //   → 一只龙头也选不出来（且刻意不登记终局，于是本次纯属白跑，只能等下轮重试）。
      //   该日数据是【历史数据、必然可取】→ 走既有「按天补拉」入口把它拉进内存即可：
      //   这次拉取会同时写回该日索引 ⇒ 紧随其后的评选必然拿到正确名单。
      //   §32：该入口幂等 + 单飞；窗口内日期是 no-op（不会产生任何额外请求）。
      try {
        await ensureAuctionDateDataLoaded(prevDate);
      } catch (e) {
        _dbgLog('[DRAGON-GROUP] 补拉 ' + prevDate + ' 名单数据失败（本次不补评选）: ' + (e && e.message || e));
      }
      try {
        const picked = await _computeAndPersist(prevDate, { isDisplayDate: false });
        if (picked && picked.length > 0) {
          rows = picked;
        } else if (_resolvedDates.has(prevDate)) {
          // 评选已跑完并定稿 —— 但它可能刚刚被「整表对齐」清空（该日确实没有成员>=3 的题材）。
          // 此时必须按云端【重读一次】，否则会把对齐前的旧行继续显示出去（用户会看到已作废的龙头）。
          rows = await readDragonLeadersForDate(prevDate);
        }
      } catch (e) {
        _dbgLog('[DRAGON-GROUP] 补评选 ' + prevDate + ' 失败（不影响本次展示）: ' + (e && e.message || e));
      }
    }

    // ⛔ 刻意**不设**「补不出来就显示当日龙头」的兜底（2026-09-15 按用户要求删除）：
    //   · 口径上它是错的 —— 龙头组的定义就是「上一交易日的龙头」，混进当日龙头 = 破坏唯一口径；
    //   · 表现上它很乱 —— 用户实测「一个区块里混着两天的龙头，内容和顺序都不对」；
    //   · 本文件顶部红线本就写着「不写任何回退/兼容分支」（§6），上一版加它是自违约定。
    //   名册补不出来只有两种可能：① 该日数据确实取不到（会 loud 留痕，见上）；② 该日确实没有
    //   成员>=3 的题材。两种情况下「空」都是正确结论，必须如实呈现空，而不是拿别的数据顶上。
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

  // [DRAGON-GROUP 2026-09-14 · 龙头组消失 · §10 就绪闸门] 正式名单未就绪 → 不评选、**不登记终局**。
  //   候选池与题材分组都建立在「该日正式名单」（getTodayGroupList）之上；索引未就绪时它会**退化返回原始列表**
  //   （含影子行 / 残缺），于是组内成员数虚低 → pickTopicLeaders 返回空 → 被误判成
  //   「该日确实没有成员>=3 的题材」并**永久写进 _resolvedDates** → 该评选日整会话不再重算。
  //   实测链（已用 REST 核实：dragon_leaders 对 9/11 = 0 行、stock_range_pct 对 9/11 = 47 行 days=10）：
  //     首屏加载时 display=D 的 _load 立刻为 prevDate 补评选 → 此刻 prevDate 名单尚未就绪 → 误登记终局
  //     → 之后数据到货也不再补 → 次日（display=D）龙头组永远为空（用户看到「只有观察组」）。
  //   未就绪时返回空**但不登记**，由 _load 的 needFill 在数据到货后自动重试。
  if (!_isAuctionWatchlistIndexReady(date)) {
    _dbgLog('[DRAGON-GROUP] ' + date + ' 正式名单索引未就绪 → 本次不评选（数据到货后自动重试，不登记终局）');
    return [];
  }

  // [DRAGON-GROUP 2026-09-15 · §10 题材库就绪闸门] 「题材分类」这条腿未就绪 → 不评选、**不登记终局**、**不落库**。
  //   为什么必须有（实测事故：9/15 只写出 1 只龙头，9/16 一整天只显示桂林旅游）：
  //     题材归属的常规路径是「当日 note/topics 为空 → 回退共享题材库」。实测 9/15 的 39 只正式成员里
  //     有 33 只 topics 字段为空 —— 也就是说【绝大多数股票只能靠这份库分类】。
  //     若评选抢在题材库到货之前，这些股票全部落「其它」→ 每个题材都凑不够 3 只 →
  //     写出「只有 1 只龙头」的残缺名册，并被主键 (date,topic) 与「非空即视为已评选」双重冻结。
  //   对照（同一份 9/15 数据，离线用真实分类函数复算）：
  //     题材库未就绪 → 39 只里 33 只落「其它」，只有 1 个题材达门槛；
  //     题材库就绪   → 只有 2 只落「其它」，4 个题材达门槛（AI应用/CPO/一带一路/农业）。
  //   未就绪时先尝试补拉一次（幂等，已就绪则 0 请求）；仍不可用则返回空且不登记，由轮询/needFill 重试。
  if (!isTopicLibraryReady()) {
    await ensureTopicLibraryLoaded();
    if (!isTopicLibraryReady()) {
      _dbgLog('[DRAGON-GROUP] ' + date + ' 共享题材库未就绪 → 本次不评选（§10 读取失败≠空；不落库、不登记终局，稍后自动重试）');
      return [];
    }
  }

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
    // [DRAGON-GROUP 2026-09-15 · §10 继承源就绪闸门] 池子的第二条腿 = 前一交易日的「竞昨高光」继承票。
    //   该日数据不在内存时高光集必然是空集（不是「那天没有高光」）→ 池子静默缩水 → 少选/漏选龙头。
    //   该日数据是【历史数据、必然可取】→ 走既有「按天补拉」入口拉进内存（幂等 + 单飞 + 窗口内 no-op），
    //   拉完校验索引就绪；仍未就绪则本次不评选、不落库、不登记终局（等下轮重试）。
    const prevT = getPreviousTradingDay(date);
    if (prevT) {
      try {
        await ensureAuctionDateDataLoaded(prevT);
      } catch (e) {
        _dbgLog('[DRAGON-GROUP] ' + date + ' 继承源 ' + prevT + ' 数据补拉失败 → 本次不评选（不登记终局）: ' + (e && e.message || e));
        return [];
      }
      if (!_isAuctionWatchlistIndexReady(prevT)) {
        _dbgLog('[DRAGON-GROUP] ' + date + ' 继承源 ' + prevT + ' 名单索引未就绪 → 本次不评选（§10 读取失败≠空名单；不登记终局）');
        return [];
      }
    }
    const list = _buildPool(date);
    if (!list || list.length === 0) {
      _dbgLog('[DRAGON-GROUP] ' + date + ' 候选池为空 → 本次不评选');
      return [];
    }
    // 题材分组 = 题材 toggle 的口径（见 _groupByPrimaryTopic 注释）：一只票只归一个题材
    const groups = _groupByPrimaryTopic(date, list);
    if (!groups || groups.length === 0) {
      // 一个题材都分不出来（池子全落「其它」/ 核心词全不命中）→ 说明【题材分类不可信】。
      // 这不是「该日没有龙头」的结论，而是分类输入有问题 → 不落库、**不登记终局**，等下一轮重试。
      _dbgLog('[DRAGON-GROUP] ' + date + ' 题材分组为空（分类退化）→ 本次不评选、不落库、不登记终局');
      return [];
    }
    // 「本次仍然成立」的题材 = 成员数达门槛者。整表对齐时只有它们的旧行会被保留（见 _reconcileRoster）。
    const qualifyingTopics = new Set(
      groups.filter(function(g) { return g && g.stocks && g.stocks.length >= DRAGON_GROUP_MIN_SIZE; })
            .map(function(g) { return g.topic; })
    );
    const picked = pickTopicLeaders(groups, rp, DRAGON_GROUP_MIN_SIZE, getStockCode);
    // 落库 = 整表对齐（upsert 本次结果 + 清掉已不成立的题材行）——修「upsert 只增不删 ⇒ 残缺永久冻结」。
    await _reconcileRoster(date, picked, qualifyingTopics);
    _resolvedDates.add(date);
    if (picked.length === 0) {
      // 终局结论：该日确实没有「成员>=3」的题材 → 不再重算（名册已在上面对齐为「无龙头」）
      _dbgLog('[DRAGON-GROUP] ' + date + ' 无「成员>=3」的题材 → 本次无龙头');
      return [];
    }
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
 * 让云端名册「等于」本次权威评选结果 —— 整表对齐（§11 删除安全：小范围、有回读校验）。
 *
 * 为什么不能只 upsert（原实现缺陷，实测 9/15 → 9/16）：
 *   主键是 (date,topic)，upsert **只增不删**。只要某一次评选因输入不全（如题材库未就绪）
 *   只算出 1 行，这行残缺就会一直在——「名册非空」还会让补评选跳过 → 永久冻结。
 *   所以权威评选之后必须把「本次已不成立」的题材行清掉，表才等于真相。
 *
 * 删除范围刻意收窄到「成员数已不足门槛」的题材（§10 宁缺勿错）：
 *   · 只删「本次分组里成员数 < DRAGON_GROUP_MIN_SIZE」的题材对应的旧行；
 *   · 「成员数够、但暂时查不到区间涨幅」的题材**保留旧行** —— 那是数据未到（会重试），
 *     不是「这个题材没有龙头」的结论，删了就再也回不来了；
 *   · 旧名册读失败 → 只写不删（不知道删哪几行，宁可留给下一轮）；
 *   · 结果与旧名册逐字段一致 → 完全不写（避免每次打开看板都刷 updated_at / 无谓网络往返）。
 *
 * @param {string} date 评选日
 * @param {Array<{topic:string,stock:string,code:string,pct:number,groupSize:number}>} picked 本次权威评选结果
 * @param {Set<string>} qualifyingTopics 本次「成员数达门槛」的题材集合
 */
async function _reconcileRoster(date, picked, qualifyingTopics) {
  let existing = [];
  try {
    existing = await readDragonLeadersForDate(date);
  } catch (e) {
    // 读不到旧名册 → 不敢删（不知道删哪几行），只 upsert 新结果，删除留到下一轮
    _dbgLog('[DRAGON-GROUP] ' + date + ' 读取旧名册失败（本次只写不删）: ' + (e && e.message || e));
    if (picked.length > 0) await upsertDragonLeaders(date, picked);
    return;
  }
  const plan = planRosterReconcile(existing, picked, qualifyingTopics);
  if (plan.unchanged) return;                       // 内容已一致 → 一个字节都不写
  if (picked.length > 0) await upsertDragonLeaders(date, picked);
  if (plan.expired.length > 0) {
    const removed = await deleteDragonLeadersForDate(date, plan.expired);
    _dbgLog('[DRAGON-GROUP] ' + date + ' 整表对齐：清掉已不成立的题材行 ' + removed + ' 条（' +
      plan.expired.join('、') + '）');
  }
}

/**
 * 把候选池按【主题材】分组 —— 与「单独打开题材 toggle」时看到的分类【逐字同源】。
 *
 * 为什么不能直接拿 getTopicGroups 的输出分组（上一版的错，用户实测投诉）：
 *   getTopicGroups 是【第二页题材分类】的口径：一只股票命中的所有核心词都会建组，
 *   同一只票同时出现在多个题材里。用它评选 → 一只票可能当上「它并不属于的那个题材」的龙头，
 *   于是次日龙头组里冒出多余的人（需求是「一个题材只有一只龙头」）。
 * 现改为复用题材 toggle 的两步分类（与 view-helpers#primaryTopicOf 完全同序）：
 *   ① 该日【正式列表】→ getPrimaryTopicMap：一只票只落在「第一个包含它的题材组」里
 *      （首页是单列，只可能落一个题材）；
 *   ② 池中不在正式列表内的行（观察组继承壳行）→ classifyStockPrimaryTopic 兜底（同一个兜底）。
 * 另外排掉 '其它'：它不是题材，题材 toggle 侧也不给它上色、不排龙一，因此不评它的龙头。
 *
 * ⚠️ 分组用的正式列表必须按【评选日 date】取（getTodayGroupList 的第二个参数），
 *    否则补评选历史日时会拿「今天」的名单去分类，口径必错。
 *
 * @param {string} date 评选日 T
 * @param {object[]} pool 候选池行（_buildPool 输出）
 * @returns {Array<{topic:string, stocks:Array<{stock:string, code:string}>}>} 供 pickTopicLeaders 使用
 */
function _groupByPrimaryTopic(date, pool) {
  const formalList = getTodayGroupList('auction', date);
  const primaryMap = getPrimaryTopicMap(formalList);
  // 与 view-helpers#primaryTopicOf 同序：先查映射；未命中（= 注入壳行）再按核心词单独匹配一次
  const resolveTopic = function(row) {
    const nm = row && row.stock ? String(row.stock).trim() : '';
    if (!nm) return '';
    return primaryMap.get(nm) || classifyStockPrimaryTopic(row) || '其它';
  };
  // 纯函数在零依赖叶子里（§I），这里只负责注入「题材归属解析器」（§6 单一真相）
  return buildTopicGroupsFromPool(pool, resolveTopic, getStockCode);
}

/**
 * 评选候选池 = 当日【全列表】：
 *   ① 当日正式列表（getTodayGroupList：正式成员 + 已落库的观察组行）★ 与题材 toggle 同一个来源；
 *   ② 前一日「竞昨高光」继承票（= 观察组主来源，可能只在视图层存在、未落库）；
 *   ③ 前一日打标签买入继承票（obsBought_<date>，与 view-helpers 同源同口径）。
 * 三者合起来 === 题材 toggle 渲染时的 renderList，因此「题材成员数」与 toggle 看到的分组一致。
 * 口径必须与 view-helpers#computeAuctionViewData 的观察组归属保持一致（§6 同一判定不写两份）。
 * @param {string} date
 * @returns {object[]} 供 _groupByPrimaryTopic 分组的行（至少含 stock；尽量带上 note/topics）
 */
function _buildPool(date) {
  const byName = new Map();
  function _put(row) {
    if (!row || !row.stock) return;
    const n = String(row.stock).trim();
    if (n && !byName.has(n)) byName.set(n, row);
  }
  // [DRAGON-GROUP 2026-09-14] 起点从「该日原始数据（含影子行）」改为「该日正式列表」：
  //   原始列表会把「既不在当日名单、也不是观察组行」的影子记录也算作题材成员，
  //   导致某个题材的成员数被抬高（可能凑够 3 只而 toggle 里其实只有 2 只）→ 多选出一只龙头。
  //   改用 getTodayGroupList 后与题材 toggle 的 auctionList 完全一致（§10 索引未就绪时同样退化为原始列表）。
  const dayList = getTodayGroupList('auction', date);
  dayList.forEach(_put);

  const prevDate = getPreviousTradingDay(date);
  const extraNames = new Set();
  // [DRAGON-GROUP 2026-09-15 · §10] 前一日「竞昨高光」是池子的【继承票来源】，读失败必须抛。
  //   原实现是 try {...} catch { 只打一条日志 } → 高光集静默变成空集 → 池子「少了观察组继承票」
  //   而这些票往往正是某个题材凑够 3 只的关键 → 题材成员数虚低 → 少选/漏选龙头，
  //   且结果一样会被落库冻结（与题材库未就绪的 9/15 事故同源，只是发生在另一条腿上）。
  //   §10 红线：读取失败 ≠ 空集合。抛给调用方（_computeAndPersist 不落库、不登记终局）。
  const set = prevDate ? getJingYestHighlightSetForDate(prevDate) : null;
  if (set && typeof set.forEach === 'function') set.forEach(function(n) { if (n) extraNames.add(String(n).trim()); });
  try {
    // 合规（§8）：obsBought_<date> 是「防重复/调试标记」型本地缓存，与 view-helpers 同源；
    // 它不是业务真相源（业务真相 = auctionTagStore），此处只用于还原观察组继承池。
    // 该来源缺失（无 localStorage / 解析失败）不影响主池，故单独兜住，不牵连上一条读失败。
    const bought = JSON.parse(localStorage.getItem('obsBought_' + date) || '[]');
    bought.forEach(function(n) { if (n) extraNames.add(String(n).trim()); });
  } catch (e) { /* 无 localStorage / 解析失败 → 忽略该来源，不影响主池 */ }

  extraNames.forEach(function(n) {
    if (!n || byName.has(n)) return;
    byName.set(n, { stock: n, code: getStockCode(n) });
  });
  return Array.from(byName.values());
}
