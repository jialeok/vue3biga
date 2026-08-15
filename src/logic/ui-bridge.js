import { _setCoreTopicsFns } from './topic/rules.js';
import { _emit } from '../stores/eventBus.js';
import { getPreviousTradingDay } from './date/trading-day-helpers.js';
import { state } from './app-state.js';
import { getAuctionData, getGroupData } from './app-core-api.js';
import { getTopicGroups } from './topic/rules.js';
import { getSupabase, getBiddingData } from '../data/supabase-client.js';
import { _getAuctionWatchlistSet } from '../data/watchlist-and-metrics.js';
import { saveRecentMultiRow } from '../data/duiban-sync.js';
import { saveEtfBoardRow } from '../data/etf-board-data.js';
import { renderConsecutiveUp as _renderConsecutiveUp, autoCalculateRecentMultiScore as _autoCalcRecentMultiScore, getTodayTagTitles, getYesterdayDate, getTagTitlesByDate, getPreviousTradingDayWithData, getTodayBidding } from './tagTitles/helpers.js';
import { reactive } from 'vue';
import { useUiStore } from '../stores/uiStore.js';
import { useAuctionTagStore } from '../stores/auctionTagStore.js';

function _noop() {}

function _getAuctionTag(date, stockName) {
  if (!date || !stockName) return null;
  // §6/§8：标签唯一真相 = auctionTagStore（云端），不再直接读 localStorage
  return useAuctionTagStore().getTagState(date, stockName);
}

export const apiStatusMap = reactive({});

export function setApiStatus(elId, msg, isOk) {
  if (!elId) return;
  apiStatusMap[elId] = { msg: String(msg || ''), ok: !!isOk, ts: Date.now() };
}
export function renderHotForm() { _emit('auction-refresh'); }
// 覆盖/补全 选择弹窗（Vue 化）：取代原 window.confirm 系统 UI。
// 调用方（同花顺/猫抓各补全类按钮）依赖它拿到 overwrite 开关才继续执行。
// 这里只把选择状态写入响应式 numcatChoice，由 <NumcatChoiceModal> 渲染美观弹窗，
// 用户点击后通过 resolveNumcatChoice 回调 overwrite（true=覆盖 / false=补全）。
export const numcatChoice = reactive({ visible: false, title: '', cb: null, cancelSignal: 0 });

export function showNumcatChoiceModal(title, cb) {
  numcatChoice.title = title || '操作模式';
  numcatChoice.cb = typeof cb === 'function' ? cb : null;
  numcatChoice.visible = true;
}

export function resolveNumcatChoice(overwrite) {
  const cb = numcatChoice.cb;
  numcatChoice.visible = false;
  numcatChoice.cb = null;
  // overwrite 为 null/undefined 表示用户点击「取消」→ 中止本次操作，不执行回调
  if (cb && overwrite !== null && overwrite !== undefined) {
    try { cb(!!overwrite); }
    catch (e) { console.error('补全/覆盖选择回调失败:', e); }
  } else {
    // 取消：递增取消信号，供调用方（后台编辑框）解除「处理中」按钮锁定，
    // 否则因不执行回调、无 ✅/❌ 终止消息，busyKey 会永久卡在「处理中...」
    numcatChoice.cancelSignal++;
  }
}

export function renderAuction() { _emit('auction-refresh'); }
export async function pullCoreTopicsFromCloud() {
  const sb = getSupabase();
  if (!sb) return null;
  const { data, error } = await sb.from('core_topics').select('name,synonyms,updated_at').order('name', { ascending: true });
  if (error) throw error;
  if (!data || data.length === 0) return null;
  return data.map(row => {
    let syns = row.synonyms;
    if (typeof syns === 'string') { try { syns = JSON.parse(syns); } catch { syns = syns.split(','); } }
    return { name: row.name, synonyms: Array.isArray(syns) ? syns : [] };
  });
}
export async function pushCoreTopicsToCloud(topics) {
  const sb = getSupabase();
  if (!sb) return;
  const { error: delErr } = await sb.from('core_topics').delete().neq('name', '___never___');
  if (delErr) throw delErr;
  if (!topics || topics.length === 0) return;
  const rows = topics.map(t => ({ name: t.name, synonyms: JSON.stringify(t.synonyms || []), updated_at: new Date().toISOString() }));
  const { error: insErr } = await sb.from('core_topics').insert(rows);
  if (insErr) throw insErr;
}
_setCoreTopicsFns(pullCoreTopicsFromCloud, pushCoreTopicsToCloud);

export function resetExpansionStateOnDateSwitch() {}
export function getAuctionTagState(stockName, date) {
  const d = date || useUiStore().currentDate;
  const prevDay = getPreviousTradingDay(d);
  const tag = prevDay ? _getAuctionTag(prevDay, stockName) : null;
  return { bought: tag === 'buy', sold: tag === 'sell', selected: tag === 'hold', source: tag ? 'inherited' : 'none' };
}
const _starTagCache = new Map();
export function clearStarTagCache() { _starTagCache.clear(); }
export function getStarTagsForStock(stockName) {
  if (!stockName) return null;
  const cacheKey = useUiStore().currentDate + '|' + stockName.trim();
  if (_starTagCache.has(cacheKey)) return _starTagCache.get(cacheKey);
  const auctionData = getAuctionData();
  const todayAuctionList = auctionData[useUiStore().currentDate] || [];
  const prevDate = getPreviousTradingDay(useUiStore().currentDate);
  const prevAuctionList = prevDate ? (auctionData[prevDate] || []) : [];
  if (todayAuctionList.length === 0) { _starTagCache.set(cacheKey, null); return null; }

  const todayGroups = getTopicGroups(todayAuctionList);
  const prevGroups = prevDate ? getTopicGroups(prevAuctionList) : [];

  const stockTopics = [];
  todayGroups.forEach(group => {
    if (group.topic === '其它' || group.topic === '并购重组') return;
    const hasStock = group.stocks.some(s => s.stock && s.stock.trim() === stockName.trim());
    if (!hasStock) return;
    const todayStarCount = group.starCount || 0;
    const prevGroup = prevGroups.find(g => g.topic === group.topic);
    const prevStarCount = prevGroup ? (prevGroup.starCount || 0) : 0;
    stockTopics.push({ topic: group.topic, todayStarCount, prevStarCount, starChange: todayStarCount - prevStarCount });
  });
  if (stockTopics.length === 0) { _starTagCache.set(cacheKey, null); return null; }

  let maxStarTopic = null, maxStarCount = 0;
  todayGroups.forEach(group => {
    if (group.topic === '其它' || group.topic === '并购重组') return;
    if ((group.starCount || 0) > maxStarCount) { maxStarCount = group.starCount || 0; maxStarTopic = group.topic; }
  });

  let bestTag = null, bestPriority = 0;
  stockTopics.forEach(st => {
    let tag = null, priority = 0;
    if (st.todayStarCount > st.prevStarCount && st.todayStarCount > 5) { tag = '星爆'; priority = 1; }
    else if (st.topic === maxStarTopic && maxStarCount > 0) { tag = '星最多'; priority = 2; }
    else if (st.todayStarCount > 0 && st.prevStarCount === 0) { tag = '星现'; priority = 3; }
    else if (st.todayStarCount > st.prevStarCount) { tag = '星增'; priority = 4; }
    else if (st.todayStarCount === st.prevStarCount && st.todayStarCount > 0) { tag = '星平'; priority = 5; }
    else if (st.todayStarCount < st.prevStarCount && st.todayStarCount > 0) { tag = '星减'; priority = 6; }
    else if (st.todayStarCount === 0 && st.prevStarCount > 0) { tag = '星无'; priority = 7; }
    if (tag && (priority < bestPriority || bestPriority === 0)) { bestTag = tag; bestPriority = priority; }
  });
  _starTagCache.set(cacheKey, bestTag);
  return bestTag;
}

const _profitStatusCache = new Map();
export function clearProfitStatusCache() { _profitStatusCache.clear(); }
export function getStockProfitStatus(stockName, stocksData) {
  if (!stockName || !stocksData) return null;
  const cacheKey = useUiStore().currentDate + '|' + stockName.trim();
  if (_profitStatusCache.has(cacheKey)) return _profitStatusCache.get(cacheKey);
  const todayStocks = stocksData[useUiStore().currentDate] || [];
  const stock = todayStocks.find(s => s.name && s.name.trim() === stockName.trim());
  if (!stock || !stock.soldRecords || stock.soldRecords.length === 0) { _profitStatusCache.set(cacheKey, null); return null; }
  const sortedRecords = [...stock.soldRecords].sort((a, b) => new Date(b.date) - new Date(a.date));
  const latestRecord = sortedRecords[0];
  if (!latestRecord || latestRecord.profit === undefined || latestRecord.profit === null) { _profitStatusCache.set(cacheKey, null); return null; }
  const profitStr = String(latestRecord.profit).replace(/[^\d.-]/g, '');
  const profitValue = parseFloat(profitStr);
  if (isNaN(profitValue)) { _profitStatusCache.set(cacheKey, null); return null; }
  const result = profitValue >= 0 ? '赚' : '亏';
  _profitStatusCache.set(cacheKey, result);
  return result;
}


export function renderBidding() { _emit('bidding-refresh'); }
export function getTodayDuiban() {
  const auctionData = getAuctionData();
  return (auctionData && auctionData[useUiStore().currentDate]) || [];
}
export function renderDuiban() { _emit('board-refresh'); }
/**
 * 从「早盘竞价股票列表」自动推导 最近多板 的总数量与跌涨比，写回 recent_multi_data。
 * 口径（对齐竞价看板实际展示）：
 *   - 总数量 = 竞价看板列表实际展示的股票支数（与 AuctionBoard 同口径：_getAuctionWatchlistSet 过滤；
 *             watchlist 尚未加载时回退全量，避免误判为 0/空白）。
 *   - 涨数   = 列表中 note 含「涨停」，或首个百分比 > 0（且非「跌停」）的支数。
 *   - 跌数   = 总数量 − 涨数；跌涨比 = `${跌}:${涨}`。
 * 看板只读 boardState（Realtime 自愈更新），本函数只负责「推导 + 写回」，不引入第二真相源（§6）。
 * 列表为空（total===0）时返回 null，不写回、不覆盖已有统计（§11）。
 *
 * @param {string} date 目标日期
 * @returns {{total:number,rise:number,fall:number,die_zhangbi:string}|null}
 */
function getAuctionBoardList(date) {
  const list = getAuctionData()[date] || [];
  const watchlistSet = _getAuctionWatchlistSet(date);
  // 按「正式成员索引」(_auctionWatchlistIndex[date]) 过滤 —— 唯一真相源（§6）。
  // 该索引来自 auction_watchlist 表（天然只有正式成员），排除影子/观察股（病灶 B/D 的额外股，即列表里多出来的 7~11 只）。
  // 严禁回退全量：watchlist 未加载（size===0）时返回空，交由 maybeAutoRecalc 重试，绝不把非成员算进总数（否则 83→87）。
  return list.filter(function (r) {
    return r && r.stock && watchlistSet.has(r.stock.trim());
  });
}

function computeAuctionCounts(date) {
  const list = getAuctionBoardList(date);
  const total = list.length;
  if (total === 0) return null;
  let rise = 0;
  let judged = 0; // 有涨跌依据的股票数（note 或 changePct 任一有值）
  list.forEach(function (item) {
    const note = item.note || '';
    if (note.includes('涨停')) { rise++; judged++; return; }
    if (note.includes('跌停')) { judged++; return; }
    const m = note.match(/-?\d+\.?\d*%/);
    if (m) {
      judged++;
      const v = parseFloat(m[0]);
      if (v > 0) rise++;
      return;
    }
    // 回退：note 无涨跌信息时，用 changePct / change_pct 字段判断（worker 抓取的涨跌幅存在此字段）
    const pct = item.changePct != null ? item.changePct : item.change_pct;
    if (pct !== undefined && pct !== null && String(pct).trim() !== '') {
      judged++;
      const v = parseFloat(String(pct));
      if (!isNaN(v) && v > 0) rise++;
    }
  });
  // 有依据的股票才参与涨跌判定；无任何依据的行（纯观察组壳/无数据）不计入涨也不计入跌，
  // 跌数 = total − 涨数 − 无依据数（与看板"跌 = 总 − 涨"口径一致，但不再把无数据行误判为跌）。
  const fall = total - rise - (total - judged);
  return { total: total, rise: rise, fall: fall, die_zhangbi: fall + ':' + rise };
}

/**
 * 从「竞价变化看板」的 板块ETF 行收盘值 自动推导 早盘板块ETF 的总数量与跌涨比，写回 early_etf_data。
 * 口径（用户定义）：
 *   - 总数量 = 固定 48（板块ETF 行数）。
 *   - 涨数   = 板块ETF 行的 收盘 值（即 48 只板块ETF 中红盘家数，BiddingBoard 以「X红」展示）。
 *   - 跌数   = 48 − 涨数；跌涨比 = `${跌}:${涨}`。
 * 板块ETF 行无收盘值时返回 null，不写回、不覆盖已有统计（§11）。
 *
 * @param {string} date 目标日期
 * @returns {{total:number,rise:number,fall:number,die_zhangbi:string}|null}
 */
function computeEtfCounts(date) {
  const TOTAL_ETF = 48;
  const bidding = getBiddingData()[date] || [];
  // 与竞价变化看板 getTodayBidding 同口径：按行名建 Map（后者覆盖，last-wins），取「板块ETF(48)」正式行。
  // 严禁 startsWith('板块ETF') 直接 find —— 历史数据里可能存在同名/快照重复行（某行 close=41 在前），
  // startsWith 会命中第一条而竞价看板按 last-wins 显示 11，导致 ETF 涨数算成 41（#92/#93 复现 bug）。
  const rowMap = new Map();
  bidding.forEach(function (r) { if (r && r.name) rowMap.set(r.name.toString().trim(), r); });
  const sectorRow = rowMap.get('板块ETF(48)')
    || rowMap.get('板块ETF')
    || Array.from(rowMap.values()).find(function (r) {
        return r && r.name && r.name.indexOf('板块ETF') === 0 && r.name.indexOf('time26') === -1;
      });
  if (!sectorRow || sectorRow.close === '' || sectorRow.close == null) return null;
  const rise = parseInt(String(sectorRow.close).trim(), 10) || 0;
  const fall = Math.max(0, TOTAL_ETF - rise);
  return { total: TOTAL_ETF, rise: rise, fall: fall, die_zhangbi: fall + ':' + rise };
}

export async function recalcDuibanFromAuction(date) {
  const targetDate = date || useUiStore().currentDate;
  if (!targetDate) return null;
  const auctionCounts = computeAuctionCounts(targetDate);
  const etfCounts = computeEtfCounts(targetDate);
  let recentMulti = null;
  let earlyEtf = null;
  // 最近多板：总数量=竞价列表支数，涨=上涨支数，跌=总−涨
  if (auctionCounts) {
    const row = {
      date: targetDate,
      shuliang: String(auctionCounts.total),
      die_count: auctionCounts.fall,
      zhang_count: auctionCounts.rise,
      die_zhangbi: auctionCounts.die_zhangbi
    };
    try {
      const r1 = await saveRecentMultiRow(row);
      if (r1 && r1.ok && r1.data) recentMulti = r1.data;
    } catch (e) {
      console.warn('[recalc] 最近多板写回失败:', e && e.message);
    }
  }
  // 早盘板块ETF：总数量=48，涨=板块ETF行收盘(红盘家数)，跌=48−涨（与竞价股票统计完全独立，不串数据 §6）
  if (etfCounts) {
    const row = {
      date: targetDate,
      shuliang: String(etfCounts.total),
      die_count: etfCounts.fall,
      zhang_count: etfCounts.rise,
      die_zhangbi: etfCounts.die_zhangbi
    };
    try {
      const r2 = await saveEtfBoardRow(row);
      if (r2 && r2.ok && r2.data) earlyEtf = r2.data;
    } catch (e) {
      console.warn('[recalc] 早盘ETF写回失败:', e && e.message);
    }
  }
  return { recentMulti: recentMulti, earlyEtf: earlyEtf };
}

export function renderEmotionBoard() { _emit('board-refresh'); }
export function renderEtf() { _emit('board-refresh'); }
export function renderJiwang() { _emit('board-refresh'); }
export function getNthPreviousTradingDay(date, n) {
  let d = date;
  for (let i = 0; i < n; i++) d = getPreviousTradingDay(d);
  return d;
}
export function renderMulti() { _emit('board-refresh'); }
export function renderHotspot() { _emit('board-refresh'); }
export function renderPattern() { _emit('board-refresh'); }
export function renderRank() { _emit('board-refresh'); }

export function autoCalculateRecentMultiScore() { return _autoCalcRecentMultiScore(); }
export function renderConsecutiveUp() { return _renderConsecutiveUp(); }
export { getTodayTagTitles, getYesterdayDate, getTagTitlesByDate, getPreviousTradingDayWithData, getTodayBidding };

export function renderList() { _emit('stocks-refresh'); }
export function formatDate(d) { return d || ''; }
