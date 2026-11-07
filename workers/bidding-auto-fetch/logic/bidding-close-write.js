// bidding-close-write.js — 竞价变化看板「收盘」列【纯云端自动落库】
//
// [BIDDING-CLOSE-CLOUD 2026-11-07] 事故与根因
//   用户报障：2026-11-05 记忘看板「昨多板K线」没有三天数据。生产取证：
//     · 2026-11-04 bidding_data 7 行 close 全是 ''，其余 13 个交易日都有 5~6 行 close；
//     · bidding_fetch_log 近 30 天 352 条里 `http | bidding | close` = **0 条**
//       ⇒ db/supabase_bidding_t0925_cron.sql 里 point=close 的 pg_cron 从未成功执行过
//         （SQL 文件里 URL 还是 <PROJECT_REF>/<TOKEN> 占位符）；
//     · 前端 fetchBiddingSnapshotToForm() 只是把快照【填进编辑表单】，状态文案明确写
//       「请检查后点"保存"」，只有 useBiddingBoard.save() 才把 close 写进 bidding_data。
//   ⇒ 收盘列真实语义 = 「自动抓数 + 人工点保存」，不是无人值守。11-04 那天没点保存
//     （11-07 点开历史记录保存时反而把空字符串写进去了），于是
//     syncJiwangKxianFromBidding() / viewKxianSeries() 拿不到 11-04「最近多板%」收盘涨幅
//     ⇒ 11-05 的 K 线推导不出来。与「昨日跌涨 1:6 识别」完全无关。
//
// 【本模块做什么】
//   16:00 close 轮末尾，用与前端【同一份口径】(src/logic/bidding/snapshot-spec.js)
//   重算收盘列，幂等 upsert 到 bidding_data.close。之后即使没人开电脑、没人点保存，
//   收盘列与次日「昨多板K线」也能闭环。
//
// 【硬红线】
//   ⛔ 只允许【当天】：fuyao /api/a-share/prices/snapshot 是「最近一个交易日」滚动快照，
//      给历史日期 ?date= 会把今天的收盘涨幅错写到过去（§10/§11）。历史缺口不可无损回补，
//      只能人工补录，本模块绝不猜值、绝不用 market_metrics / 竞价涨幅冒充收盘。
//   ⛔ 只填空：已有非空 close 一律不覆盖（用户手工修正优先）。
//   ⛔ 读取失败 ≠ 0：任何一路快照拿不到就不给该行赋值，绝不写 0 家 / +0.00%。
//   ⛔ 失败不连坐：本模块任何异常都只记日志、返回 ok:false，不影响 runClose 主流程。
//   ⛔ 0 猫抓额度：全部走同花顺快照，与竞价量比（只认猫抓）无关。

import { CONFIG } from '../config.js';
import { beijingToday } from '../../_shared-source/date-utils.js';
import { fuyaoProxyGet, fetchLadderConstituents, fetchSnapshotChangePct } from '../data/fuyao-api.js';
import { sbHeaders } from '../data/supabase-write.js';
import {
  TOP10_THSCODE,
  BIDDING_BIG_ETFS,
  biddingSnapshotCodeGroups,
  normalizeFuyaoSnapshotPct,
  computeBiddingCloseValues,
  resolveBiddingRowTargets
} from '../../../src/logic/bidding/snapshot-spec.js';

const SB_TIMEOUT_MS = 12000;
const PROXY_TIMEOUT_MS = 9000;
const BCW_LADDER_ROW = '最近多板%';

function bcwFetch(url, opts) {
  const base = opts || {};
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return fetch(url, Object.assign({}, base, { signal: AbortSignal.timeout(SB_TIMEOUT_MS) }));
  }
  return fetch(url, base);
}

function bareCode(thscode) {
  const s = String(thscode || '').trim().replace(/\..*$/, '');
  return /^\d{6}$/.test(s) ? s : '';
}

async function readExistingRows(env, date) {
  const url = CONFIG.SUPABASE_URL + '/rest/v1/bidding_data?date=eq.' + encodeURIComponent(date) +
    '&select=name,close';
  const resp = await bcwFetch(url, { headers: sbHeaders(env) });
  if (!resp.ok) throw new Error('读取 bidding_data 失败: HTTP ' + resp.status);
  const rows = await resp.json();
  return Array.isArray(rows) ? rows : [];
}

/** 883901「昨日资金前十」成分股；失败返回空数组（该行留空，不写 0） */
async function fetchTop10Codes(env, logs) {
  try {
    const data = await fuyaoProxyGet(env, '/api/a-share-index/constituents/ths-stock-list',
      { thscode: TOP10_THSCODE }, PROXY_TIMEOUT_MS);
    const codes = ((data && data.item) || [])
      .map(it => bareCode(it && (it.ticker || it.thscode)))
      .filter(Boolean);
    logs.push('883901 成分股 ' + codes.length + ' 只');
    return Array.from(new Set(codes));
  } catch (e) {
    logs.push('⚠️ 883901 成分股获取失败（该行留空）: ' + (e && e.message));
    return [];
  }
}

/** 指数快照（886078.TI / 885939.TI / 000001.SH） */
async function fetchIndexPcts(env, allIndexCodes, logs) {
  const out = {};
  try {
    const data = await fuyaoProxyGet(env, '/api/a-share-index/prices/snapshot',
      { thscodes: allIndexCodes.join(',') }, PROXY_TIMEOUT_MS);
    ((data && data.item) || []).forEach(it => {
      if (!it || !it.thscode) return;
      const v = normalizeFuyaoSnapshotPct(it);
      if (v !== null) out[String(it.thscode).trim()] = v;
    });
    logs.push('指数快照可用 ' + Object.keys(out).length + '/' + allIndexCodes.length);
  } catch (e) {
    logs.push('⚠️ 指数快照失败（大盘（%）/板块ETF 留空）: ' + (e && e.message));
  }
  return out;
}

/** 纯函数：组装最终要 upsert 的行（便于单测锁住幂等 / 只填当天 / 键集一致） */
export function buildBiddingCloseWriteRows(existingRows, values, date, nowIso) {
  const targets = resolveBiddingRowTargets(existingRows, values);
  const names = {};
  (existingRows || []).forEach(r => { names[String((r && r.name) || '').trim()] = true; });
  // 当天已有别的行，但「最近多板%」这一行不存在（9:25 漏写）⇒ 允许补建该行。
  // 它是「昨多板K线」的唯一原料；其余行不自动新建，避免造出残缺行。
  if ((existingRows || []).length > 0 && !names[BCW_LADDER_ROW] &&
      values && values[BCW_LADDER_ROW] !== undefined &&
      String(values[BCW_LADDER_ROW]).trim() !== '') {
    targets.push({ name: BCW_LADDER_ROW, close: String(values[BCW_LADDER_ROW]).trim(), from: BCW_LADDER_ROW });
  }
  return targets.map(t => ({
    date: date,
    name: t.name,
    close: t.close,
    updated_at: nowIso || new Date().toISOString()
  }));
}

export async function runBiddingCloseWrite(env, opts) {
  const logs = [];
  const today = beijingToday();
  const date = (opts && opts.date) || today;

  // ★ 硬闸：/api/a-share/prices/snapshot 只返回「最近一个交易日」，历史日期绝不写。
  if (date !== today) {
    logs.push('⛔ 跳过：目标日期 ' + date + ' ≠ 今天 ' + today + '（快照是滚动窗口，禁止回写历史）');
    return { ok: true, skipped: true, date, written: 0, values: {}, logs };
  }

  let existingRows;
  try {
    existingRows = await readExistingRows(env, date);
  } catch (e) {
    logs.push('❌ 读取 bidding_data 失败（本次不写任何值）: ' + (e && e.message));
    return { ok: false, date, written: 0, values: {}, logs };
  }
  logs.push('bidding_data 当日已有 ' + existingRows.length + ' 行');
  if (existingRows.length === 0) {
    logs.push('⛔ 当日无任何行（竞价链路未跑/非交易日）⇒ 不造行，跳过');
    return { ok: true, skipped: true, date, written: 0, values: {}, logs };
  }

  let ladderCodes = [];
  try {
    ladderCodes = (await fetchLadderConstituents(env)).map(s => bareCode(s.code)).filter(Boolean);
    logs.push('883410 成分股 ' + ladderCodes.length + ' 只');
  } catch (e) {
    logs.push('⚠️ 883410 成分股获取失败（最近多板% 留空）: ' + (e && e.message));
  }
  const top10Codes = await fetchTop10Codes(env, logs);
  const groups = biddingSnapshotCodeGroups();
  const etfBare = groups.etfCodes.map(bareCode).filter(Boolean);
  const stockCodes = Array.from(new Set([].concat(ladderCodes, top10Codes, etfBare, BIDDING_BIG_ETFS)));

  const stockPcts = {};
  if (ladderCodes.length === 0 && top10Codes.length === 0 && etfBare.length === 0) {
    logs.push('⛔ 三路名单全空 ⇒ 不发快照请求（§10：读取失败不造 0）');
  } else {
    try {
      const snap = await fetchSnapshotChangePct(env, stockCodes);
      Object.assign(stockPcts, (snap && snap.pctMap) || {});
      logs.push('个股/ETF 快照可用 ' + Object.keys(stockPcts).length + '/' + stockCodes.length);
    } catch (e) {
      logs.push('⚠️ 个股/ETF 快照失败（相关行留空）: ' + (e && e.message));
    }
  }

  // 前端用腾讯行情拿 ETF，Worker 统一用同花顺；computeBiddingCloseValues 的
  // biddingPctLookup 兼容「带后缀 thscode」与「6 位代码」两种 key，无需在这里改 key 形态。
  const etfPcts = stockPcts;
  const indexPcts = await fetchIndexPcts(env, groups.allIndexCodes, logs);

  const values = computeBiddingCloseValues({
    ladderCodes, top10Codes, stockPcts, etfPcts, indexPcts
  });
  logs.push('算出收盘列 ' + JSON.stringify(values));

  if (Object.keys(values).length === 0) {
    logs.push('⛔ 五路快照全没数据 ⇒ 一行不写（绝不写 0）');
    return { ok: false, date, written: 0, values, logs };
  }

  const rows = buildBiddingCloseWriteRows(existingRows, values, date, new Date().toISOString());
  if (rows.length === 0) {
    logs.push('✅ 收盘列已完整（或用户已手工填写）⇒ 幂等跳过，不覆盖');
    return { ok: true, date, written: 0, values, logs };
  }
  logs.push('待写 ' + rows.length + ' 行: ' + rows.map(r => r.name + '=' + r.close).join(' / '));

  try {
    const url = CONFIG.SUPABASE_URL + '/rest/v1/bidding_data?on_conflict=date%2Cname';
    const resp = await bcwFetch(url, {
      method: 'POST',
      headers: Object.assign(sbHeaders(env), { 'Prefer': 'resolution=merge-duplicates' }),
      body: JSON.stringify(rows)
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error('HTTP ' + resp.status + ' ' + text.slice(0, 240));
    }
    logs.push('✅ 云端已写入 bidding_data.close ' + rows.length + ' 行（无需人工点保存）');
    return { ok: true, date, written: rows.length, values, rows, logs };
  } catch (e) {
    logs.push('❌ 写 bidding_data.close 失败: ' + (e && e.message));
    return { ok: false, date, written: 0, values, rows, logs };
  }
}
