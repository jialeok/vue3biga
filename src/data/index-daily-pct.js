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
/**
 * ★ [IDX-QT-BREAKER 2026-11-24 用户报障「题材量比的响应速度有些变慢了」] 腾讯兜底的**熔断**。
 *
 * 🔴 实测（11-24 23:09，真实 CDP 网络）：一次冷启动发出 11 个请求，其中 **8 个是腾讯指数日线**，
 *    4 只指数 × 2 个 host，**全部 HTTP 501**（腾讯 WAF 拦 IP）。冷启动因此从 ~1s 拖到 4.7s，
 *    而且每切一次日期就再来一遍 —— 浏览器 6 条连接被这 8 个必败请求占住，整块看板都跟着慢。
 *
 * 为什么以前没暴露：云端 `market_metrics(scope='index')` 只从 09-08 开始有行，而个股逐日腿能回溯到
 *   08-12 ⇒ 前端 19 天的「缺口」恒定存在 ⇒ `need`（m.size < list.length）恒为真 ⇒ 腾讯**每次都打**。
 *   上游挡了以后，这 8 个请求就成了纯损耗。
 *
 * ⇒ 熔断：整批一根 bar 都没拿到（= 被挡/超时）就停 10 分钟，期间一律走云端（缺口如实记进 missing）。
 *   ⛔ 这不是「用延迟掩盖根因」：根因是上游按 IP 拦，我们只能不重复打；缺口由 §10 如实上报。
 */
let _qtCooldownUntil = 0;
const QT_FAIL_COOLDOWN_MS = 10 * 60 * 1000;

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
  _qtCooldownUntil = 0;
}

/** 仅供测试 / 诊断：腾讯兜底是否正在熔断中（毫秒；0 = 正常） */
export function qtCooldownLeftMs() {
  return Math.max(0, _qtCooldownUntil - Date.now());
}

/**
 * 【纯函数】这些指数里，哪些**真的还需要**去腾讯补？
 *
 * ★ [IDX-QT-BREAKER 2026-11-24] 旧判据 `m.size < list.length` 拿【条数】比【日期数】：
 *   只要云端比个股腿少一天（哪怕缺的是 3 个月前的 19 天）就判「需要兜底」⇒ 每次都打腾讯。
 *   现在改成**按日期集合**判，而且只把「云端覆盖区间内部的空洞」算作缺口：
 *     · `horizon` = 最近 needDays 个交易日（偏离值 30 日窗口 + 触发回看 60 日 ⇒ 65 足够）；
 *     · 云端**起点之前**那段（前缀）不算缺口 —— 那不是「漏了」，是「还没那么早的数据」，
 *       去腾讯也补不回来（实测 2026-11-24 腾讯两个 host 全部 HTTP 501，被 WAF 按 IP 拦）。
 *       前缀缺失只影响很久以前的复盘窗口（判不出会如实显示「—」，§10），不影响今天。
 * @param {string[]} codes 要判的指数代码（已按调用方实际用到的板块筛过）
 * @param {Map<string, Map<string, number>>} map 云端已拿到的腿
 * @param {string[]} horizon 关心的交易日（升序）
 * @returns {string[]} 仍需兜底的指数代码（[] = 云端够用，⛔ 不许再打上游）
 */
export function indicesNeedingQt(codes, map, horizon) {
  const hs = Array.isArray(horizon) ? horizon : [];
  const out = [];
  (codes || []).forEach(function (c) {
    const m = map && typeof map.get === 'function' ? map.get(c) : null;
    if (!m || m.size === 0) { out.push(c); return; }        // 一根都没有 ⇒ 当然要兜
    if (hs.length === 0) return;                            // 没有窗口信息 ⇒ 不主动打上游
    let earliest = '';
    m.forEach(function (_v, d) { if (!earliest || d < earliest) earliest = d; });
    const hole = hs.some(function (d) { return d > earliest && !m.has(d); });
    if (hole) out.push(c);
  });
  return out;
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
 * @param {number}  [opts.needDays=65] 「够不够用」按最近多少个交易日判（30 日窗口 + 60 日触发回看）
 * @param {string[]} [opts.codes] 只取这几只指数（缺省 = 官方 4 只）。调用方知道自己的票都在哪些板块时
 *        应当传进来 —— 腾讯 fan-out 与云端解析量都跟着减半（[IDX-QT-BREAKER]）
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
  // ★ [IDX-QT-BREAKER] 调用方只关心自己那几只指数时，别把 4 只都算进来（腾讯 fan-out 直接减半）
  const wantCodes = Array.isArray(o.codes) && o.codes.length
    ? o.codes.filter(function (c) { return DEV_INDEX_CODES.indexOf(String(c)) >= 0; })
    : DEV_INDEX_CODES;
  const emptyFail = function (msg) {
    return { ready: false, map: new Map(), missing: wantCodes.slice(), src: 'none', error: msg || '' };
  };
  if (list.length === 0) return emptyFail('没有需要计算的交易日');

  const key = list[0] + '|' + list[list.length - 1] + '|' + list.length + '|' +
    (allowQt ? 'qt' : 'db') + '|' + wantCodes.join(',');
  if (_cache.has(key)) return _cache.get(key);
  if (_inflight.has(key)) return _inflight.get(key);
  if (Date.now() < _cooldownUntil) return emptyFail('读取失败冷却中（30 秒后自动重试）');

  const task = (async function () {
    const map = new Map();
    wantCodes.forEach(function (c) { map.set(c, new Map()); });
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

    // ② 腾讯兜底（★ [IDX-QT-BREAKER] 只补「云端覆盖区间内部的空洞」，且熔断期内一律不打）
    //   旧判据 m.size < list.length 把「云端起点之前的前缀」也算成缺口 ⇒ 19 天恒定缺口
    //   ⇒ 每次冷启动 8 个必败请求（实测全 501）。见 indicesNeedingQt 注释。
    const horizon = list.slice(-(o.needDays || 65));
    const need = indicesNeedingQt(wantCodes, map, horizon);
    let qtUsed = false;
    const qtLeft = _qtCooldownUntil - Date.now();
    if (allowQt && need.length > 0 && qtLeft <= 0) {
      const from = _shiftDays(list[0], -(o.qtDaysBack || 45));
      const to = list[list.length - 1];
      let gotBars = 0;
      try {
        const bars = await fetchQtIndexBars(need, from, to, { timeoutMs: 9000, concurrency: 4 });
        need.forEach(function (c) {
          const b = bars.get(c);
          if (!b || b.length === 0) return;
          gotBars++;
          const n = mergeLegs(map.get(c), barsToPctLegs(b));
          if (n > 0) qtUsed = true;
        });
      } catch (e) {
        _dbgLog('[INDEX-LEGS] 腾讯兜底失败：' + ((e && e.message) || e));
      }
      // 整批一根都没拿到 ⇒ 上游在挡（WAF/超时）⇒ 熔断 10 分钟，⛔ 不再每片都去打一遍
      if (gotBars === 0) {
        _qtCooldownUntil = Date.now() + QT_FAIL_COOLDOWN_MS;
        _dbgLog('[INDEX-LEGS] 腾讯兜底整批失败（' + need.length + ' 只）⇒ 熔断 ' +
          Math.round(QT_FAIL_COOLDOWN_MS / 60000) + ' 分钟，期间只用云端腿（缺口如实上报）');
      }
    }

    const missing = wantCodes.filter(function (c) { return map.get(c).size === 0; });
    const ready = wantCodes.some(function (c) { return map.get(c).size > 0; });
    const res = {
      ready: ready,
      map: map,
      missing: missing,
      src: ready ? (qtUsed ? (missing.length === wantCodes.length ? 'qt' : 'db+qt') : 'db') : 'none',
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
