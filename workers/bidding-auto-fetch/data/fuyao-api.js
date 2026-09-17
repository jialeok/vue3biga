// fuyao-api.js — 同花顺 fuyao 接口（proxy + 直连历史K线）
import { msToDateStr, dateStrToMs, normalizeDate } from '../../_shared-source/date-utils.js';
import { CONFIG } from '../config.js';

/**
 * [RETRY 2026-09-15] 上游「全局请求限流」重试。
 *
 * 事故背景（2026-09-15 P0）：9:25 早盘那一轮，P0-① 的第一个请求（883410 成分股）撞上
 * fuyao 的 `code=429 Global request rate limit exceeded`，**没有任何重试** →
 * fetchAndWriteWatchlist 直接 `return { error }` → runMorning 整轮 return：
 * auction_watchlist / market_metrics / stock_range_pct **一张表都没写**，
 * 用户 9:25~9:39 打开看板「第一页全空、无法操作」。
 *
 * 实测该限流是**突发性**的：同一接口相邻两次调用一次 200、一次 429，
 * 退避 1~2 秒后即可恢复。因此对「可重试错误」做短退避重试，硬指标（9:26 落库）内可承受。
 *
 * 总预算：0.9 + 1.8 + 3.6 ≈ 6.3s（4 次尝试）。仍有兜底降级（见 morning-workflow）。
 */
async function retryFuyao(fn, attempts, label) {
  const n = attempts || 4;
  let lastErr;
  for (let i = 0; i < n; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = String((e && e.message) || '');
      // 只重试「上游瞬时」类错误；业务性错误（如 thscode 不存在）重试无意义
      const retriable = /429|rate limit|5\d\d|timeout|timed out|aborted|network|fetch failed|ECONN/i.test(msg);
      if (!retriable || i === n - 1) break;
      const wait = 900 * Math.pow(2, i);
      console.warn('[FUYAO-RETRY] ' + (label || '') + ' 第' + (i + 1) + '次失败：' + msg.slice(0, 120) +
        ' → ' + wait + 'ms 后重试');
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

async function fuyaoProxyGet(env, path, params) {
  const authKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY;
  const url = new URL(CONFIG.FUYAO_PROXY_BASE);
  url.searchParams.set('path', path);
  for (const k in params) {
    if (params[k] !== undefined && params[k] !== null) {
      url.searchParams.set(k, params[k]);
    }
  }
  const resp = await fetch(url.toString(), { headers: { 'Authorization': 'Bearer ' + authKey } });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error('fuyao-proxy ' + path + ' HTTP ' + resp.status + ': ' + text.slice(0, 200));
  }
  const json = await resp.json();
  if (json.code !== 0) throw new Error('fuyao ' + path + ' 错误: ' + (json.message || 'code=' + json.code));
  return json.data;
}

// 调 fuyao 交易日历，返回最近 N 天交易日列表（升序）
// [RETRY 2026-09-15] 交易日历是 P0-①/P1/P2 的公共前置，429 会让窗口算不出来 → 必须重试。
export async function fuyaoCalendarTradingDays(env) {
  return retryFuyao(async () => {
    const authKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY;
    const url = new URL(CONFIG.FUYAO_PROXY_BASE);
    url.searchParams.set('path', '/api/a-share/calendar/trading-days');
    const resp = await fetch(url.toString(), { headers: { 'Authorization': 'Bearer ' + authKey } });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error('fuyao calendar HTTP ' + resp.status + ': ' + text.slice(0, 200));
    }
    const json = await resp.json();
    if (json.code !== 0) throw new Error('fuyao calendar 错误 code=' + json.code + ': ' + (json.message || ''));
    const items = (json.data && json.data.item) || [];
    return items.map(it => normalizeDate(it.date)).filter(Boolean).sort();
  }, 4, 'calendar/trading-days');
}

// 获取最近多板成分股 → [{ name, code }]
// [RETRY 2026-09-15] ★ 这是 9:25 早盘 P0-① 的【第一个】请求，也是本次 P0 事故的引爆点：
//   它 429 一次就会让整轮早盘抓取中断（一张表都不写）。这里必须重试。
export async function fetchLadderConstituents(env) {
  return retryFuyao(async () => {
    const data = await fuyaoProxyGet(env, '/api/a-share-index/constituents/ths-stock-list', { thscode: CONFIG.LADDER_THSCODE });
    const items = (data && data.item) || [];
    return items.map(it => {
      const name = (it.name || '').trim();
      let code = '';
      if (it.ticker) code = String(it.ticker).trim();
      else if (it.thscode) {
        const c = String(it.thscode).trim().replace(/\..*$/, '');
        if (/^\d{6}$/.test(c)) code = c;
      }
      return { name, code };
    }).filter(s => s.name && s.code);
  }, 4, 'constituents/ths-stock-list(883410)');
}

function tickerToThscode(code) {
  const c = String(code).trim();
  if (!/^\d{6}$/.test(c)) return '';
  // [FIX 2026-09-11] 北交所 2024 起启用 920 号段。必须【先于】`9 → .SH` 判断，
  // 否则 920xxx 会被当成沪市 B 股 → K 线/快照恒空 → 该股区间涨幅与当日收盘涨幅全天缺失
  // （与前端 src/data/api/fuyao-proxy.js 同口径修复）。
  if (c.slice(0, 2) === '92') return c + '.BJ';
  if (c.startsWith('6') || c.startsWith('9')) return c + '.SH';
  if (c.startsWith('4') || c.startsWith('8')) return c + '.BJ';
  return c + '.SZ';
}

// 【FIX 2026-08-03】增加 stats 参数，空值不再静默 return，而是累计 emptyField 计数
function applySnapshotItem(it, code, result, stats) {
  const pct = it.price_change_ratio_pct;
  if (pct === null || pct === undefined || pct === '') {
    if (stats) stats.emptyField++;
    return;
  }
  const n = Number(pct);
  if (isNaN(n)) {
    if (stats) stats.emptyField++;
    return;
  }
  let ratio = n;
  const priceChange = it.price_change !== undefined && it.price_change !== null ? Number(it.price_change) : null;
  const curr = it.current_price !== undefined && it.current_price !== null ? Number(it.current_price) : null;
  const prev = it.prev_close !== undefined && it.prev_close !== null ? Number(it.prev_close) : null;
  const isActuallyDown = (priceChange !== null && priceChange < 0) || (curr !== null && prev !== null && curr < prev);
  if (isActuallyDown && ratio > 0) ratio = -ratio;
  result[code] = (ratio >= 0 ? '+' : '') + ratio.toFixed(2) + '%';
}

// fuyao snapshot 批量获取收盘涨幅 → { pctMap: { code: pctStr }, stats: {...} }
export async function fetchSnapshotChangePct(env, codes) {
  const result = {};
  const stats = {
    totalInput: codes.length,
    batchOk: 0,
    batchFail: 0,
    singleOk: 0,
    singleFail: 0,
    itemsReturned: 0,
    emptyField: 0,
    notMatched: 0,
    success: 0
  };
  const batchSize = CONFIG.SNAPSHOT_BATCH_SIZE;
  for (let i = 0; i < codes.length; i += batchSize) {
    const chunk = codes.slice(i, i + batchSize);
    const thscodes = chunk.map(c => tickerToThscode(c)).filter(Boolean).join(',');
    if (!thscodes) continue;
    let data;
    try {
      data = await fuyaoProxyGet(env, '/api/a-share/prices/snapshot', { thscodes: thscodes });
      stats.batchOk++;
    } catch (batchErr) {
      stats.batchFail++;
      console.warn('snapshot 批量失败，降级逐只:', batchErr.message);
      for (const code of chunk) {
        const thscode = tickerToThscode(code);
        if (!thscode) continue;
        try {
          const d1 = await fuyaoProxyGet(env, '/api/a-share/prices/snapshot', { thscodes: thscode });
          stats.singleOk++;
          const items1 = (d1 && d1.item) || [];
          stats.itemsReturned += items1.length;
          items1.forEach(it => applySnapshotItem(it, code, result, stats));
        } catch (e1) {
          stats.singleFail++;
        }
      }
      continue;
    }
    const items = (data && data.item) || [];
    stats.itemsReturned += items.length;
    const codeSet = new Set(chunk);
    items.forEach(it => {
      const tcode = String(it.thscode || '').replace(/\..*$/, '');
      if (tcode && codeSet.has(tcode)) {
        applySnapshotItem(it, tcode, result, stats);
      } else {
        stats.notMatched++;
      }
    });
  }
  stats.success = Object.keys(result).length;
  return { pctMap: result, stats };
}

/**
 * [SNAPSHOT-EXTRAS 2026-09-14] 同花顺「集合竞价快照」（免费、不限累计次数、单次 ≤100 个代码、stage=final）。
 *
 * 为什么需要：猫抓 daily_auc 对【当日】行不返回 auc_pct_chg / auc_vol_ratio / auc_turnover
 *   （要等结算后才出现），worker 又默认把今天排除在补漏之外 → 9:25~收盘这一整天，看板的
 *   「竞价量比 / 真换手率 / 当日竞价涨幅」全空、龙头徽章掉色、竞价一字红线判不出。
 *   本接口在 9:25 竞价一结束就能拿到【当天】终态数据，用它把当日缺口补上，0 猫抓额度消耗。
 *
 * ⚠️ 只返回「最近一个交易日」（滚动窗口：当天收盘后 → 下一交易日开盘前）；周末/节假日调用返回上一交易日终态。
 *    因此调用方必须先用 timestamp 校验「服务端日期 == 目标日」，否则拒绝写入（避免把上一日数据写到今天）。
 * ⚠️ um_vol / open_bid_pct 不在此接口能力内：snapshot.auction_unmatched 带符号，与库内 um_vol
 *    （从不出现负值）语义不同源 → 按 §40「不凭猜测改数据库」留空，仍由次日 numcat 补漏负责。
 *    量纲换算已交叉验证（见 backups/同花顺官方接口竞价能力核查_2026-09-13.md）：
 *      volume ← round(auction_volume/100)（手→万股）｜auc_pct_chg ← auction_pct
 *      auc_vol_ratio ← auction_volume_ratio ｜auc_turnover ← auction_turnover_pct
 *
 * @param {object} env
 * @param {string[]} codes 6 位股票代码
 * @returns {Promise<{items:object[], batches:Array<{timestamp:number, auction_phase:string, data_status:string}>}>}
 */
export async function fetchAuctionSnapshot(env, codes) {
  const items = [];
  const batches = [];
  const list = Array.from(new Set((codes || []).map(c => String(c).trim()).filter(c => /^\d{6}$/.test(c))));
  for (let i = 0; i < list.length; i += 100) {
    const thscodes = list.slice(i, i + 100).map(c => tickerToThscode(c)).filter(Boolean).join(',');
    if (!thscodes) continue;
    const data = await fuyaoProxyGet(env, '/api/a-share/auction/snapshot', { thscodes: thscodes, stage: 'final' });
    batches.push({
      timestamp: data && data.timestamp,
      auction_phase: data && data.auction_phase,
      data_status: data && data.data_status
    });
    const arr = (data && data.item) || [];
    for (let k = 0; k < arr.length; k++) items.push(arr[k]);
  }
  return { items: items, batches: batches };
}

// 直连 fuyao（用新账号 key，绕过 supabase proxy）
async function fuyaoDirectHistorical(env, thscode, startMs, endMs) {
  const apiKey = env.FUYAO_API_KEY_HISTORY || env.FUYAO_API_KEY;
  if (!apiKey) {
    return { thscode, error: '缺少 FUYAO_API_KEY_HISTORY' };
  }
  const url = new URL(CONFIG.FUYAO_DIRECT_BASE + '/api/a-share/prices/historical');
  url.searchParams.set('thscode', thscode);
  url.searchParams.set('interval', '1d');
  url.searchParams.set('start', String(startMs));
  url.searchParams.set('end', String(endMs));
  url.searchParams.set('adjust', 'none');
  try {
    const resp = await fetch(url.toString(), { headers: { 'X-api-key': apiKey } });
    const json = await resp.json();
    if (json.code !== 0) {
      return { thscode, error: 'fuyao historical code=' + json.code + ' ' + (json.message || '') };
    }
    const items = ((json.data && json.data.item) || []).map(it => ({
      dateStr: msToDateStr(it.date_ms),
      close: Number(it.close_price)
    })).filter(it => !isNaN(it.close));
    items.sort((a, b) => a.dateStr < b.dateStr ? -1 : (a.dateStr > b.dateStr ? 1 : 0));
    return { thscode, items };
  } catch (e) {
    return { thscode, error: e.message };
  }
}

// 并发抓取所有成分股的历史K线，计算历史交易日的收盘涨幅
// 返回 { byDate: { dateStr: { code: "+X.XX%" } }, successCount, failCount }
export async function fetchHistoricalPctChg(env, constituents, historicalDates) {
  if (!constituents.length || !historicalDates.length) return { byDate: {}, successCount: 0, failCount: 0 };
  const result = {};
  historicalDates.forEach(d => { result[d] = {}; });

  const earliest = historicalDates.slice().sort()[0];
  const startMs = dateStrToMs(earliest) - 7 * 24 * 3600 * 1000;
  const endMs = Date.now();

  const targetSet = new Set(historicalDates);
  let successCount = 0, failCount = 0;

  const concurrency = CONFIG.HISTORICAL_CONCURRENCY;
  for (let i = 0; i < constituents.length; i += concurrency) {
    const chunk = constituents.slice(i, i + concurrency);
    const promises = chunk.map(c => {
      const thscode = tickerToThscode(c.code);
      if (!thscode) return Promise.resolve(null);
      return fuyaoDirectHistorical(env, thscode, startMs, endMs);
    });
    const results = await Promise.all(promises);
    results.forEach((r, idx) => {
      if (!r) return;
      const code = chunk[idx].code;
      if (r.error) {
        failCount++;
        return;
      }
      for (let j = 1; j < r.items.length; j++) {
        const dateStr = r.items[j].dateStr;
        if (!targetSet.has(dateStr)) continue;
        const prevClose = r.items[j - 1].close;
        const currClose = r.items[j].close;
        if (!prevClose || isNaN(prevClose) || prevClose === 0) continue;
        const pct = (currClose - prevClose) / prevClose * 100;
        if (isNaN(pct)) continue;
        result[dateStr][code] = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
      }
      successCount++;
    });
  }

  return { byDate: result, successCount, failCount };
}

// ===== 涨跌停池（「涨跌停」看板数据源）=====
// 上游：fuyao「涨停池 / 跌停池」两个 special-data 接口（date_ms = 北京当日午夜的 epoch ms）。
// 口径与前端 src/data/limit-pool.js 完全一致（同一张表 limit_pool、同一套字段映射），
// 保证「worker 抓的」与「前端自愈抓的」写进库里的行结构完全相同（§6 单一真相）。
const LIMIT_UP_PATH = '/api/a-share/special-data/limit-up-pool';
const LIMIT_DOWN_PATH = '/api/a-share/special-data/limit-down-pool';
// 上游文档：size ∈ 1..200
const LIMIT_POOL_PAGE_SIZE = 200;
// 分页安全上限（单日池子真实规模数十~数百只；仅用于防上游 pagination 异常导致死循环）
const LIMIT_POOL_MAX_PAGES = 10;

/** 涨幅数值 → 库内统一文本口径（与 market_metrics.change_pct 一致）；无法解析 → null（绝不用 0 顶替） */
function limitPoolPctText(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!isFinite(n)) return null;
  return (n >= 0 ? '+' : '') + n.toFixed(2);
}

/** 数值字段归一：非有限值 → null */
function limitPoolNum(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return isFinite(n) ? n : null;
}

/** 文本字段归一：空串/空白 → null */
function limitPoolText(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  return s ? s : null;
}

/**
 * 上游 item → limit_pool 入库行。
 * 涨停池有 limit_up_time / continue_day_text / seal_money 等；跌停池换成 first/last_limit_time + turnover。
 */
function limitPoolRow(it, board, date, nowIso) {
  const isUp = board === 'up';
  const code = String(it.ticker || it.thscode || '').trim().replace(/\..*$/, '');
  const name = String(it.name || '').trim();
  if (!name) return null;
  return {
    date: date,
    board: board,
    stock: name,
    code: /^\d{6}$/.test(code) ? code : null,
    thscode: limitPoolText(it.thscode),
    price: limitPoolNum(it.last_price),
    change_pct: limitPoolPctText(it.price_change_ratio_pct),
    limit_time: isUp ? limitPoolText(it.limit_up_time) : limitPoolText(it.first_limit_time),
    last_limit_time: isUp ? null : limitPoolText(it.last_limit_time),
    reason: isUp ? limitPoolText(it.limit_up_reason) : null,
    continue_text: isUp ? limitPoolText(it.continue_day_text) : null,
    continue_cnt: isUp ? limitPoolNum(it.continue_day_cnt) : null,
    seal_money: isUp ? limitPoolNum(it.seal_money) : null,
    max_seal_money: isUp ? limitPoolNum(it.max_seal_money) : null,
    turnover_ratio: isUp ? null : limitPoolNum(it.turnover_ratio_pct),
    updated_at: nowIso
  };
}

/**
 * 分页拉一个池的全部条目（上游 size 上限 200）。
 * 每个分页请求都走 retryFuyao（该上游限流是突发性的，见本文件顶部 RETRY 说明）。
 *
 * @returns {Promise<{items:object[], total:number, complete:boolean}>}
 *   complete=false 表示「返回条目数 < 上游声明的 total」→ 调用方【不得】据此删除旧行（§11 删除安全）。
 */
async function fetchLimitPoolBoardPages(env, path, dateMs) {
  const items = [];
  let total = -1;
  let complete = false;
  for (let page = 1; page <= LIMIT_POOL_MAX_PAGES; page++) {
    const data = await retryFuyao(
      () => fuyaoProxyGet(env, path, { date_ms: dateMs, page: page, size: LIMIT_POOL_PAGE_SIZE }),
      3, path + ' page' + page
    );
    const arr = (data && data.item) || [];
    arr.forEach(it => { if (it && it.name) items.push(it); });
    const pg = (data && data.pagination) || null;
    total = pg && typeof pg.total === 'number' ? pg.total : items.length;
    if (arr.length === 0) { complete = true; break; }
    if (items.length >= total) { complete = true; break; }
    if (pg && page >= pg.pages) { complete = items.length >= total; break; }
  }
  return { items: items, total: total < 0 ? items.length : total, complete: complete };
}

/**
 * 抓取某交易日的涨停池 + 跌停池。
 *
 * ⚠️ 两个池【都要成功】才返回：任一失败直接 throw，调用方据此放弃写入
 *    （宁可保持旧快照，也不写出「只有涨停、没有跌停」的半张表）。
 *
 * @param {object} env
 * @param {string} date YYYY-MM-DD
 * @returns {Promise<{date:string, up:object[], down:object[], upTotal:number, downTotal:number,
 *                    upComplete:boolean, downComplete:boolean}>}
 */
export async function fetchLimitPoolSnapshot(env, date) {
  if (!date) throw new Error('limit-pool: 缺少日期');
  const dateMs = dateStrToMs(date);
  if (!isFinite(dateMs)) throw new Error('limit-pool: 日期非法 ' + date);
  const nowIso = new Date().toISOString();

  const upRes = await fetchLimitPoolBoardPages(env, LIMIT_UP_PATH, dateMs);
  const downRes = await fetchLimitPoolBoardPages(env, LIMIT_DOWN_PATH, dateMs);

  const up = upRes.items.map(it => limitPoolRow(it, 'up', date, nowIso)).filter(Boolean);
  const down = downRes.items.map(it => limitPoolRow(it, 'down', date, nowIso)).filter(Boolean);

  console.log('[LIMIT-POOL] 抓取 ' + date + '：涨停 ' + up.length + '/' + upRes.total +
    (upRes.complete ? '（完整）' : '（不完整）') + ' 只，跌停 ' + down.length + '/' + downRes.total +
    (downRes.complete ? '（完整）' : '（不完整）') + ' 只');

  return {
    date: date,
    up: up,
    down: down,
    upTotal: upRes.total,
    downTotal: downRes.total,
    upComplete: upRes.complete,
    downComplete: downRes.complete
  };
}

/**
 * [KLINE-FALLBACK 2026-09-11] 同花顺 K 线窗口涨幅（前复权）——供收盘区间涨幅「缺腿行」重算。
 *
 * 为什么需要：猫抓 daily 每天只有 10 次额度，收盘（16:00）时经常已被白天用尽 →
 * 区间涨幅的「整段重算」拿不到 10 天窗口 → 只能退化为「只换 T 腿」，而
 * 缺腿行（days < 窗口）根本无法修复（2026-09-11 实测 7 只错值，国芳集团 91.11%）。
 * 同花顺 K 线【没有每日额度限制】（当日收盘涨幅兜底一直用它），因此这里提供窗口级
 * K 线涨幅，让缺腿行重算完全不依赖猫抓额度。
 *
 * 口径与前端 src/data/stock-range-pct.js#fetchFuyaoDailyPctRange 完全一致：
 *   · 前复权（不复权在除权除息日会出现假暴跌，与交易所涨跌幅不可比）；
 *   · date_ms 是北京时间午夜 → 加 8h 取 UTC 日期才是正确交易日；
 *   · 起点前移 20 自然日（窗口首日涨幅需要「上一交易日收盘价」，长假也够）；
 *   · 并发固定 3（实测并发 4~6 会返回被截断的少数 K 线）+ 覆盖不足重试 + 熔断。
 *
 * @param {object} env
 * @param {Array<{name:string, code:string}>} items
 * @param {string[]} dates 需要的交易日（YYYY-MM-DD，顺序任意）
 * @param {{concurrency?:number}} [opts]
 * @returns {Promise<Map<string, Map<string, number>>>} name -> (YYYYMMDD -> 日涨幅%)
 */
export async function fetchFuyaoKlineWindowPct(env, items, dates, opts) {
  const out = new Map();
  const list = (items || []).filter(it => it && it.name && it.code);
  const ymdList = (dates || []).map(d => String(d).replace(/-/g, '')).filter(Boolean);
  if (list.length === 0 || ymdList.length === 0) return out;

  const sorted = ymdList.slice().sort();
  const toDash = y => y.slice(0, 4) + '-' + y.slice(4, 6) + '-' + y.slice(6, 8);
  // 起点前移 20 个自然日：首日涨幅需要「上一个交易日收盘价」作为基准（抗长假）。
  const startMs = dateStrToMs(toDash(sorted[0])) - 20 * 86400000;
  const endMs = dateStrToMs(toDash(sorted[sorted.length - 1])) + 2 * 86400000;
  const wantSet = new Set(ymdList);

  // 并发度固定 3：该上游在并发 4~6 时会返回被截断的少数几根 K 线。
  const conc = (opts && opts.concurrency) || 3;
  // 熔断阈值：连续这么多只都取不到完整窗口 → 判定上游整体不可用，放弃剩余（避免跑满重试）。
  const CIRCUIT_LIMIT = 6;
  let consecutiveShort = 0;
  let circuitOpen = false;

  async function fetchOnce(code) {
    const data = await fuyaoProxyGet(env, '/api/a-share/prices/historical', {
      thscode: tickerToThscode(code),
      interval: '1d',
      start: String(startMs),
      end: String(endMs),
      adjust: 'forward'
    });
    const rows = (data && data.item) || [];
    const series = [];
    rows.forEach(r => {
      if (!r || r.date_ms === null || r.date_ms === undefined || r.close_price === null || r.close_price === undefined) return;
      const close = Number(r.close_price);
      if (!isFinite(close) || close <= 0) return;
      series.push({ ymd: msToDateStr(Number(r.date_ms)).replace(/-/g, ''), close: close });
    });
    series.sort((a, b) => (a.ymd < b.ymd ? -1 : (a.ymd > b.ymd ? 1 : 0)));
    const keep = new Map();
    for (let k = 1; k < series.length; k++) {
      if (!wantSet.has(series[k].ymd)) continue;
      const prev = series[k - 1].close;
      if (!prev) continue;
      keep.set(series[k].ymd, (series[k].close / prev - 1) * 100);
    }
    return keep;
  }

  for (let i = 0; i < list.length; i += conc) {
    if (circuitOpen) break;
    const batch = list.slice(i, i + conc);
    await Promise.all(batch.map(async it => {
      if (circuitOpen) return;
      let best = null;
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          const keep = await fetchOnce(it.code);
          if (!best || keep.size > best.size) best = keep;
          if (best.size >= wantSet.size) break; // 已覆盖整个窗口
          if (best.size === 0) break;           // 代码错 / 长期停牌，重试无意义
          if (attempt < 2) await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
        }
      } catch (e) {
        console.warn('K线窗口失败 ' + it.name + '(' + it.code + '): ' + e.message);
      }
      if (best && best.size > 0) out.set(String(it.name).trim(), best);
      if (!best || best.size < wantSet.size) {
        consecutiveShort++;
        if (consecutiveShort >= CIRCUIT_LIMIT) circuitOpen = true;
      } else {
        consecutiveShort = 0;
      }
    }));
  }

  return out;
}