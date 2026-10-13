// suspend.js — 「当日停牌」判定的唯一实现（§6 单一真相 / §15 独立业务模块）
//
// ===== 为什么需要它 =====
// 某只票停牌时，猫抓 numcat 拿不到它的竞价数据 → 看板上「竞价量(万)/占本」留空、
// 题材页「涨幅」列显示 '-'，观感与「上游没抓到数据」完全一样，会被误读成抓取故障
// （2026-10-13 新华传媒 600825.SH 实例：当天全市场 5580 只里只有 13 只零成交，它就是其一）。
// 同花顺 fuyao 免费/不限量，能明确判出「当日无竞价 / 无成交」。
//
// ===== ★ 判据（2026-10-13 盘中实测，18 只样本零例外）=====
//   主判据 = GET /api/a-share/auction/snapshot?stage=final 对该票【不返回】auction_pct。
//     · 停牌票只返回 6 个字段（thscode/ticker/name/auction_volume_ratio/pre_close_price/float_market_cap）
//       —— 缺 auction_price / auction_pct / auction_volume / auction_amount / auction_unmatched /
//       auction_turnover_pct / auction_yesterday_ratio_pct / open_price / last_price；
//     · 正常票返回 15 个字段。
//     · fuyao 文档把「停牌」明确列为该接口的返回场景（"实时、终态、停牌及 not_ready 场景均会返回"
//       讲的就是 data.timestamp）⇒「竞价字段缺席」是【有意为之】的停牌信号，不是覆盖缺口。
//   降级判据 = GET /api/a-share/prices/snapshot 该票 volume=0 && turnover=0 && last_price=null，
//     且同批中【至少一只票有成交】（否则是「尚未开盘」，全市场都是 0 成交，会全员误判）。
//
// ===== 红线 =====
//   · ⛔ 只读上游 + 只写本模块内存 ref：不写 Supabase、不碰 numcat/worker、不烧猫抓额度。
//   · ⛔ §10 宁缺勿错：两条腿都判不出来 ⇒ 返回 null（不更新缓存、不标），
//        绝不把「判不出来」当成「没停牌」写进缓存。
//   · ⛔ 上游两个快照接口【都只有当日数据】（无 date 参数）⇒ 只对「今天」判定；
//        历史日期一律不标（那天到底停没停牌无从谈起，不能拿今天的快照冒充）。
//   · 两腿都可用时取【交集】：任一条腿不认可就不标，避免把「上游覆盖缺口」误当成停牌。
//
// 状态范式与 dragon-rank.js 完全一致（模块级 ref + 单飞 + 有界重试 + 指纹令牌），
// 供 view-helpers 同步读取（§17 ref-driven，不阻塞渲染）。

import { ref } from 'vue';
import { fuyaoApiGet, tickerToThscode } from '../../data/api/fuyao-proxy.js';
import { _dbgLog } from '../../data/debug-log.js';
import { _getLocalTodayStr } from '../tagTitles/rules.js';

/** 停牌标记文案（唯一出处 —— 模板/CSS/规则文档都从这里取，不各写一份） */
export const SUSPEND_TAG_TEXT = '停牌';

/** 停牌标记悬停说明（唯一出处：早盘竞价行 + 三个选股看板的 6 个块组件共用，⛔ 别各写一份） */
export const SUSPEND_TAG_TITLE = '当日停牌：上游无竞价 / 无成交数据（不是抓取失败）';

/** auction/snapshot 单次最多 100 个 thscode（接口契约） */
const AUCTION_BATCH = 100;
/** prices/snapshot 每批 40 只（与 auction-ths.js 同口径：fuyao 对批内不认识的代码会整批报错） */
const PRICE_BATCH = 40;
/** 判定不可用时的重试间隔 / 最大次数（页面可能早于 9:25 打开，竞价终态尚未就绪） */
const RETRY_MS = 30 * 1000;
const RETRY_MAX = 8;
/** 同一日期内判定结果的有效期：过期后允许重判（上游可能补数、盘中状态会变） */
const TTL_MS = 3 * 60 * 1000;

// ===== 状态（模块级 ref，§7 不进 Pinia）=====
export const suspendState = ref({ date: '', set: new Set(), version: 0, loadedAt: 0 });
/** 单飞：{ date, promise } */
let _inflight = null;
let _inflightDate = '';
/** 有界重试（判不出来时按 RETRY_MS 再试，最多 RETRY_MAX 次） */
let _retryTimer = null;
let _retryDate = '';
let _retryCount = 0;

/**
 * 把一行（{stock,code} 或 6 位代码）转成 fuyao 的 thscode。
 * 代码优先取行上的 code 字段，缺则由调用方补；都缺 → ''（该行不参与判定）。
 * ⛔ 只认「6 位数字代码」或「已带交易所后缀的 thscode」——
 *    绝不把中文股票名当代码传下去（tickerToThscode 对非 6 位输入会原样返回）。
 * @param {{stock?:string, code?:string}|string} entry
 * @returns {string}
 */
export function toThscode(entry) {
  if (!entry) return '';
  const raw = typeof entry === 'string' ? entry : entry.code;
  const t = String(raw === undefined || raw === null ? '' : raw).trim();
  if (!/^\d{6}(\.(SH|SZ|BJ))?$/i.test(t)) return '';
  return tickerToThscode(t);
}

function _sameSet(a, b) {
  if (a === b) return true;
  if (!a || !b || a.size !== b.size) return false;
  for (const v of a) { if (!b.has(v)) return false; }
  return true;
}

/**
 * 从竞价快照 items 里挑出「竞价字段缺席」的 thscode（主判据，纯函数）。
 *
 * @param {Array<object>} items /api/a-share/auction/snapshot 的 data.item
 * @param {Set<string>} wantSet 本次关心的 thscode 集合（空集 = 不过滤）
 * @returns {{ok:boolean, suspended:Set<string>}} ok=false ⇒ 本腿不可用（不得据此判定停牌）
 */
export function pickSuspendedFromAuctionItems(items, wantSet) {
  const suspended = new Set();
  let ready = 0;
  const arr = items || [];
  for (let i = 0; i < arr.length; i++) {
    const it = arr[i];
    if (!it || !it.thscode) continue;
    if (wantSet && wantSet.size > 0 && !wantSet.has(it.thscode)) continue;
    const pct = it.auction_pct;
    if (pct === undefined || pct === null) suspended.add(it.thscode);
    else ready++;
  }
  // 「竞价数据已就绪」判据：至少有一只被请求的票拿到了 auction_pct。
  // 全部缺席 ⇒ 更可能是竞价尚未产生（或整批上游异常）⇒ 本腿不可用（§10 不猜）。
  return { ok: ready > 0, suspended };
}

/**
 * 从行情快照 items 里挑出「当日零成交」的 thscode（降级判据，纯函数）。
 *
 * @param {Array<object>} items /api/a-share/prices/snapshot 的 data.item
 * @param {Set<string>} wantSet 本次关心的 thscode 集合（空集 = 不过滤）
 * @returns {{ok:boolean, suspended:Set<string>}}
 */
export function pickSuspendedFromPriceItems(items, wantSet) {
  const arr = (items || []).filter(function(it) { return it && it.thscode; });
  let traded = 0;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i].last_price !== null && arr[i].last_price !== undefined) traded++;
  }
  // 闸门：整批都没有成交价 = 尚未开盘（或上游未就绪）⇒ 本腿不可用。
  // 这道闸门是「判据 A 不被误用成『未开盘 = 全员停牌』」的关键。
  if (traded === 0) return { ok: false, suspended: new Set() };
  const suspended = new Set();
  for (let i = 0; i < arr.length; i++) {
    const it = arr[i];
    if (wantSet && wantSet.size > 0 && !wantSet.has(it.thscode)) continue;
    const zeroVolume = Number(it.volume) === 0 && Number(it.turnover) === 0;
    const noPrice = it.last_price === null || it.last_price === undefined;
    if (zeroVolume && noPrice) suspended.add(it.thscode);
  }
  return { ok: true, suspended };
}

/** 拉取竞价快照（分批，单批失败 → 抛出，由上层决定降级） */
async function _fetchAuctionItems(thscodes) {
  const out = [];
  for (let i = 0; i < thscodes.length; i += AUCTION_BATCH) {
    const chunk = thscodes.slice(i, i + AUCTION_BATCH);
    const data = await fuyaoApiGet('/api/a-share/auction/snapshot', {
      thscodes: chunk.join(','),
      stage: 'final'
    });
    const arr = (data && data.item) || [];
    for (let k = 0; k < arr.length; k++) out.push(arr[k]);
  }
  return out;
}

/** 拉取行情快照（分批；整批失败 → 降级逐只，与 auction-ths.js 同款对策） */
async function _fetchPriceItems(thscodes) {
  const out = [];
  for (let i = 0; i < thscodes.length; i += PRICE_BATCH) {
    const chunk = thscodes.slice(i, i + PRICE_BATCH);
    let data;
    try {
      data = await fuyaoApiGet('/api/a-share/prices/snapshot', { thscodes: chunk.join(',') });
    } catch (batchErr) {
      _dbgLog('[SUSPEND] prices/snapshot 整批失败，降级逐只: ' + (batchErr && batchErr.message || batchErr));
      const rescued = [];
      for (let j = 0; j < chunk.length; j++) {
        try {
          const d1 = await fuyaoApiGet('/api/a-share/prices/snapshot', { thscodes: chunk[j] });
          if (d1 && d1.item) { for (let k = 0; k < d1.item.length; k++) rescued.push(d1.item[k]); }
        } catch (e1) { /* 该只上游不认识 → 跳过（本腿对它不判定） */ }
      }
      data = { item: rescued };
    }
    const arr = (data && data.item) || [];
    for (let k = 0; k < arr.length; k++) out.push(arr[k]);
  }
  return out;
}

/**
 * 判定「停牌股票名集合」。
 * @returns {Promise<Set<string>|null>} null = 两腿都判不出来（§10：不更新缓存）
 */
async function _loadSuspendedNameSet(entries) {
  const thscodes = [];
  const nameOf = new Map(); // thscode -> 股票名（判定结果按【股票名】落库，展示层直接可查）
  const list = Array.isArray(entries) ? entries : [];
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    // 名字字段兼容两种形状：早盘竞价行用 `stock`，三个选股看板的行用 `name`（⛔ 别逼调用方转换）。
    const nm = String((e && (e.stock || e.name)) || (typeof e === 'string' ? e : '') || '').trim();
    const code = toThscode(e);
    if (!nm || !code || nameOf.has(code)) continue;
    nameOf.set(code, nm);
    thscodes.push(code);
  }
  if (thscodes.length === 0) return null;
  const want = new Set(thscodes);

  let auction = { ok: false, suspended: new Set() };
  let auctionErr = null;
  try {
    auction = pickSuspendedFromAuctionItems(await _fetchAuctionItems(thscodes), want);
  } catch (e) { auctionErr = e; }

  let price = { ok: false, suspended: new Set() };
  let priceErr = null;
  try {
    price = pickSuspendedFromPriceItems(await _fetchPriceItems(thscodes), want);
  } catch (e) { priceErr = e; }

  let hit = null;
  if (auction.ok && price.ok) {
    // 两腿都可用 → 取交集（任一条腿不认可就不标，最大化避免误标）
    hit = new Set();
    auction.suspended.forEach(function(t) { if (price.suspended.has(t)) hit.add(t); });
  } else if (auction.ok) {
    hit = auction.suspended;   // 9:25~9:30 集合竞价已终态、但连续竞价尚未成交 → 只信主判据
  } else if (price.ok) {
    hit = price.suspended;     // 主判据异常时的降级
  }

  if (hit === null) {
    _dbgLog('[SUSPEND] 两腿均不可用 au=' + (auctionErr && auctionErr.message || '-') +
      ' px=' + (priceErr && priceErr.message || '-'));
    return null;
  }

  const names = new Set();
  hit.forEach(function(t) { const n = nameOf.get(t); if (n) names.add(n); });
  return names;
}

function _stopRetry() {
  if (_retryTimer) { clearTimeout(_retryTimer); _retryTimer = null; }
  _retryDate = '';
  _retryCount = 0;
}

/**
 * 判不出来时安排一次重试（有界：最多 RETRY_MAX 次；拿到结果立刻停止）。
 * 典型场景：页面在 9:25 之前打开，竞价终态还没生成。
 */
function _scheduleRetry(date, entries) {
  if (_retryDate !== date) { _retryDate = date; _retryCount = 0; }
  if (_retryTimer || _retryCount >= RETRY_MAX) return;
  _retryTimer = setTimeout(function() {
    _retryTimer = null;
    _retryCount++;
    const s = suspendState.value;
    if (s.date === date && s.loadedAt > 0) return; // 已拿到结果（或已切日期）→ 不再重试
    ensureSuspendSet(date, entries).catch(function(e) {
      _dbgLog('[SUSPEND] 重试失败: ' + (e && e.message || e));
    });
  }, RETRY_MS);
}

/**
 * 确保「该日期的停牌集合」已加载（幂等、单飞、有界重试）。
 *
 * @param {string} date 看板日期 'YYYY-MM-DD'
 * @param {Array<{stock?:string, name?:string, code?:string}>} entries 当日渲染名单（股票名 + 代码）
 *        ⚠️ 名字给 `stock`（早盘竞价行）或 `name`（三个选股看板行）都认，见 _loadSuspendedNameSet。
 * @returns {Promise<object>} suspendState.value
 */
export async function ensureSuspendSet(date, entries) {
  if (!date) return suspendState.value;

  // 上游两个快照接口都【只有当日数据】⇒ 历史日期不判定、不标（§10 不能拿今天的快照冒充历史）。
  if (date !== _getLocalTodayStr()) {
    _stopRetry();
    if (suspendState.value.date !== date) {
      suspendState.value = { date, set: new Set(), version: suspendState.value.version + 1, loadedAt: Date.now() };
    }
    return suspendState.value;
  }

  const s = suspendState.value;
  if (s.date === date && s.loadedAt > 0 && (Date.now() - s.loadedAt) < TTL_MS) return s;
  if (_inflight && _inflightDate === date) return _inflight;
  // 名单还没到（首屏 items 为空）→ 不发请求、也不安排重试；
  // 「行数变化」本身会再次触发本函数（见 useAuctionBoard 的 watch），那时再判。
  if (!Array.isArray(entries) || entries.length === 0) return s;

  _inflightDate = date;
  _inflight = (async function() {
    try {
      const set = await _loadSuspendedNameSet(entries);
      if (set === null) { _scheduleRetry(date, entries); return suspendState.value; }
      _stopRetry();
      const prev = suspendState.value;
      const changed = !(prev.date === date && _sameSet(prev.set, set));
      suspendState.value = {
        date: date,
        set: set,
        // 集合没变就不升版本：指纹不变 → 行缓存不整体失效（§23 局部优先）
        version: changed ? prev.version + 1 : prev.version,
        loadedAt: Date.now()
      };
      return suspendState.value;
    } finally {
      _inflight = null;
    }
  })();
  return _inflight;
}

/**
 * 同步读取：该日期、该股票是否停牌。日期不匹配 / 未加载 / 判不出来 → false（不标）。
 * @param {string} date
 * @param {string} stockName
 * @returns {boolean}
 */
export function isSuspended(date, stockName) {
  const s = suspendState.value;
  if (!date || !stockName || s.date !== date || s.set.size === 0) return false;
  return s.set.has(String(stockName).trim());
}

/**
 * 给一行展示行挂上停牌展示字段（**唯一收口**，§6）。
 *
 * 谁调它：`decision-collect` 的 `_decorateSuspend`（早盘竞价看板之外的**三个选股看板** ——
 * 决策 / 题材量比 / 分笔买卖 —— 都从这里一次性覆盖，⛔ 绝不在各自的规则层或组件里另判一遍）。
 * 为什么挂在 Logic 层：判定要读模块级 ref（业务真相），组件是纯展示、模板零计算（§21）。
 *
 * §10：非今日 / 尚未加载 / 判不出来 / 不在集合 ⇒ `''` ⇒ 模板 `v-if` 不渲染（⛔ 不显示「未知」占位）。
 * ⚠️ 它是【同步读】：不发起任何请求，加载由各看板的组合式另外触发（见 `ensureSuspendSet`）。
 *
 * @param {object} row 任意含 `name` 的展示行（买点 pick / 卖点 item）
 * @param {string} date 展示日
 * @returns {object} 同一个 row（原地写 `suspendTag`）
 */
export function decorateSuspendField(row, date) {
  if (!row) return row;
  row.suspendTag = isSuspended(date, row.name) ? SUSPEND_TAG_TEXT : '';
  return row;
}

/** 增量渲染指纹令牌：停牌集合变化必须让行缓存整体失效（与 dragon= 同款理由）。 */
export function getSuspendFingerprintToken() {
  const s = suspendState.value;
  return s.date + '|v' + s.version + '|n' + s.set.size;
}

/** 切数据源 / 卸载时清空（幂等）。 */
export function clearSuspendSet() {
  _stopRetry();
  _inflight = null;
  _inflightDate = '';
  if (suspendState.value.date === '' && suspendState.value.set.size === 0) return;
  suspendState.value = { date: '', set: new Set(), version: suspendState.value.version + 1, loadedAt: 0 };
}
