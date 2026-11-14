// index-daily-pct.js — 「官方对应指数的逐日涨幅腿」读写入口（Data 层，§5）
//
// ══════════════════════════════════════════════════════════════════════════════════════
// 【它服务谁】logic/auction/abnormal-deviation.js —— 交易所官方「收盘价格涨跌幅偏离值」
//   公式里必须减掉【对应指数】的同期涨幅。没有指数腿，偏离值一个都算不出来。
//
// 【为什么复用 market_metrics 而不是新建表】
//   那张表主键 `(date, stock, scope)`，本来就是「按 scope 分域的市场指标」——
//   `scope='auction'` 竞价、`scope='hot'` 热门，指数就是第三个域 `scope='index'`。
//   ⇒ 不新建表、不需要用户跑 DDL、不碰 §40「不许猜表名字段名」的红线；
//     读侧复用 `readMarketMetricsForDate` 同一条通道，写侧 worker 用现成的
//     `POST ?on_conflict=date,stock,scope`。
//   ⚠️ 与 `scope='auction'` 的行绝不混：题材量比 / 交易日历全部带 `.eq('scope','auction')`，
//      指数行进不了那些查询（2026-11-14 全仓 grep 核对过）。
//
// 【行形态】
//   date='2026-11-13'  stock='深证A股指数'（中文名）  code='sz399107'  scope='index'
//   change_pct='+0.55%'（**文本带百分号，与 auction 域同一约定**）
//
// 【两条来源，云端优先】
//   ① `market_metrics(scope='index')` —— worker 16:00 收盘写入 ⇒ 【关电脑也能用】；
//   ② 腾讯指数日线（直连、0 猫抓额度）—— 只在云端缺哪天时兜那几天。
//   ⛔ 反过来（腾讯优先）会让「关电脑后数据还在不在」变成一个靠浏览器的问题，违背硬件红线。
//
// 【§10 红线】
//   · 读失败 ⇒ { ready:false }，⛔ 不返回空 Map 冒充「这天没有指数」；
//   · 某个指数缺某天 ⇒ 该天不进 Map（缺口由上层 cumulativeDeviation 判 null，⛔ 不补 0）；
//   · 腾讯也取不到 ⇒ 如实记进 `missing`，⛔ 不静默。
// ══════════════════════════════════════════════════════════════════════════════════════

import { getSupabase } from './supabase-client.js';
import { _dbgLog } from './debug-log.js';
import { DEV_INDEX_CODES, DEV_INDEX, devIndexName } from '../logic/auction/abnormal-deviation.js';
import { fetchQtIndexBars } from './api/qt-kline.js';
import { numOfText } from '../logic/util/num-text.js';

const TABLE = 'market_metrics';
const SCOPE = 'index';
/** 指数中文名 → 代码（DB 里 code 列为空时的退路，⛔ 猜不出就丢弃这一行） */
const _NAME_TO_CODE = (function () {
  const m = new Map();
  Object.keys(DEV_INDEX).forEach(function (k) {
    m.set(DEV_INDEX[k].name, DEV_INDEX[k].code);
  });
  return m;
})();

/** 会话缓存：'from|to' -> { ready, map:Map<code, Map<date, number>>, missing:string[], src:string } */
const _cache = new Map();
const _inflight = new Map();
const CACHE_MAX = 8;
/** 读失败冷却（表/权限还没就绪时不白打 REST） */
let _cooldownUntil = 0;
const FAIL_COOLDOWN_MS = 30000;

function _put(key, val) {
  _cache.set(key, val);
  while (_cache.size > CACHE_MAX) {
    const oldest = _cache.keys().next().value;
    if (oldest === undefined) break;
    _cache.delete(oldest);
  }
}

/** 仅供测试 / 诊断 */
export function clearIndexDailyPctCache() {
  _cache.clear();
  _inflight.clear();
  _cooldownUntil = 0;
}

/** 纯函数：腾讯日线（收盘序列）→ 逐日涨幅腿 [{date, pct}]（第一根没有前收 ⇒ 不出腿） */
export function barsToPctLegs(bars) {
  const out = [];
  const arr = Array.isArray(bars) ? bars : [];
  for (let i = 1; i < arr.length; i++) {
    const prev = numOfText(arr[i - 1] && arr[i - 1].close);
    const cur = numOfText(arr[i] && arr[i].close);
    if (prev === null || cur === null || prev <= 0 || cur <= 0) continue;
    out.push({ date: String(arr[i].date).slice(0, 10), pct: (cur / prev - 1) * 100 });
  }
  return out;
}

/**
 * 【纯函数】把若干「日腿」并进 Map<date, pct>；已有的日期不覆盖（云端优先）。
 * @param {Map<string,number>} target
 * @param {Array<{date:string,pct:number|string}>} legs
 * @returns {number} 实际新写入的条数
 */
export function mergeLegs(target, legs) {
  let n = 0;
  (legs || []).forEach(function (x) {
    if (!x || !x.date) return;
    const d = String(x.date).slice(0, 10);
    if (target.has(d)) return;
    const v = numOfText(x.pct);
    if (v === null) return;
    target.set(d, v);
    n++;
  });
  return n;
}

/** 读云端 scope='index' 的行（date in 列表；行数少，不需要分页） */
async function _readCloud(dates) {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase 客户端未初始化，无法读取指数腿');
  const { data, error } = await sb
    .from(TABLE)
    .select('date,stock,code,change_pct')
    .eq('scope', SCOPE)
    .in('date', dates);
  if (error) throw new Error('读取 market_metrics(scope=index) 失败: ' + (error.message || error));
  return Array.isArray(data) ? data : [];
}

/**
 * 读指数逐日涨幅腿（云端优先，缺的日期用腾讯日线兜）。
 *
 * @param {string[]} dates 需要的交易日列表（升序或乱序都行；调用方一般传自己窗口里的日期）
 * @param {object} [opts]
 * @param {boolean} [opts.allowQt=true] 云端不够时是否允许直连腾讯兜底
 * @param {number}  [opts.qtDaysBack=45] 腾讯兜底时向前多取的自然日（保证窗口首日有前收）
 * @returns {Promise<{ready:boolean, map:Map<string, Map<string, number>>,
 *                    missing:string[], src:string, error:string}>}
 *          map: 指数代码 -> Map<date, 涨幅%>；
 *          ready=false ⇒ 云端与腾讯都没拿到可用腿（§10：缺数据 ≠ 0）
 */
export async function readIndexLegsForDates(dates, opts) {
  const o = opts || {};
  const allowQt = o.allowQt !== false;
  const list = Array.from(new Set((dates || []).map(function (d) { return String(d || '').slice(0, 10); })
    .filter(Boolean))).sort();
  const emptyFail = function (msg) {
    return { ready: false, map: new Map(), missing: DEV_INDEX_CODES.slice(), src: 'none', error: msg || '' };
  };
  if (list.length === 0) return emptyFail('没有需要计算的交易日');

  const key = list[0] + '|' + list[list.length - 1] + '|' + list.length + '|' + (allowQt ? 'qt' : 'db');
  if (_cache.has(key)) return _cache.get(key);
  if (_inflight.has(key)) return _inflight.get(key);
  if (Date.now() < _cooldownUntil) return emptyFail('读取失败冷却中（30 秒后自动重试）');

  const task = (async function () {
    const map = new Map();
    DEV_INDEX_CODES.forEach(function (c) { map.set(c, new Map()); });
    let cloudError = '';

    // ① 云端
    try {
      const rows = await _readCloud(list);
      rows.forEach(function (r) {
        const code = String(r.code || '').trim() || _NAME_TO_CODE.get(String(r.stock || '').trim()) || '';
        if (!code || !map.has(code)) return;                 // ⛔ 不属于 4 个官方指数的行一律忽略
        const v = numOfText(r.change_pct);
        if (v === null) return;
        map.get(code).set(String(r.date).slice(0, 10), v);
      });
    } catch (e) {
      cloudError = (e && e.message) || String(e);
      _cooldownUntil = Date.now() + FAIL_COOLDOWN_MS;
      _dbgLog('[INDEX-LEGS] 云端读取失败：' + cloudError);
    }

    // ② 腾讯兜底：哪个指数缺哪天，就整窗拉一次再补（不覆盖云端值）
    const need = DEV_INDEX_CODES.filter(function (c) {
      const m = map.get(c);
      return m.size < list.length;
    });
    let qtUsed = false;
    if (allowQt && need.length > 0) {
      const from = _shiftDays(list[0], -(o.qtDaysBack || 45));
      const to = list[list.length - 1];
      try {
        const bars = await fetchQtIndexBars(need, from, to, { timeoutMs: 9000, concurrency: 4 });
        need.forEach(function (c) {
          const b = bars.get(c);
          if (!b || b.length === 0) return;
          const n = mergeLegs(map.get(c), barsToPctLegs(b));
          if (n > 0) qtUsed = true;
        });
      } catch (e) {
        _dbgLog('[INDEX-LEGS] 腾讯兜底失败：' + ((e && e.message) || e));
      }
    }

    const missing = DEV_INDEX_CODES.filter(function (c) { return map.get(c).size === 0; });
    const ready = DEV_INDEX_CODES.some(function (c) { return map.get(c).size > 0; });
    const res = {
      ready: ready,
      map: map,
      missing: missing,
      src: ready ? (qtUsed ? (missing.length === DEV_INDEX_CODES.length ? 'qt' : 'db+qt') : 'db') : 'none',
      error: cloudError
    };
    if (ready) {
      _cooldownUntil = 0;
      _put(key, res);
    }
    return res;
  })();

  _inflight.set(key, task);
  try {
    return await task;
  } finally {
    _inflight.delete(key);
  }
}

/** 'YYYY-MM-DD' ± n 天（不足两位补零；⛔ 不用 Date 的本地时区，避免跨时区偏一天） */
export function shiftYmd(ymd, n) {
  const s = String(ymd || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const t = Date.parse(s + 'T00:00:00Z');
  if (!isFinite(t)) return s;
  const d = new Date(t + n * 86400000);
  return d.toISOString().slice(0, 10);
}

const _shiftDays = shiftYmd;

/**
 * 把「指数腿 Map」整理成 abnormal-deviation 要的升序腿数组。
 * @param {Map<string, Map<string, number>>} map readIndexLegsForDates 的 map
 * @param {string} code 指数代码
 * @param {string} [asOf] 只取 ≤ 这一天的腿
 */
export function indexLegsOf(map, code, asOf) {
  const m = (map && typeof map.get === 'function') ? map.get(code) : null;
  if (!(m instanceof Map)) return [];
  const cutoff = asOf ? String(asOf).slice(0, 10) : '';
  const out = [];
  m.forEach(function (pct, date) {
    if (cutoff && date > cutoff) return;
    out.push({ date: date, pct: pct });
  });
  out.sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); });
  return out;
}

/** 上屏用的「指数腿缺了几个」一句话（§10 缺数据必须可见） */
export function indexLegsGapText(res) {
  const r = res || {};
  if (!r.ready) {
    return '⚠️ 官方对应指数的日线【没读到】⇒ 偏离值算不出（这不是「没有异动」）。' +
      (r.error ? '（' + r.error + '）' : '');
  }
  if (!r.missing || r.missing.length === 0) return '';
  return '⚠️ 以下指数缺腿，相关板块的偏离值算不出：' +
    r.missing.map(function (c) { return devIndexName(c) + '（' + c + '）'; }).join('、');
}
