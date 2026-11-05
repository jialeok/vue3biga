// ths-today-patch.js — 用同花顺临时补「今天」的竞价行情（Logic 层）
//
// 【用户口径 / 2026-10-26】
//   「为什么额度会用尽呢？……你用同花顺接口临时补下数据」
//   —— 猫抓（numcat）每天只有 10 次额度（见 workers/.../logic/close-workflow.js 的实测记录），
//      今天 09:25 两把 key 一启动就 403 ⇒ market_metrics 当天 0 行 ⇒ 全站看板"加载中"。
//      同花顺（fuyao）通道**免费、不限量**，项目里本来就有两条腿：
//        · K 线 historical  → 涨幅 / 开盘涨幅(=9:25 竞价成交价) / 昨日成交量
//        · 竞价快照 snapshot?stage=final → 竞价量 / 竞价涨幅 / 真换手率（仅当天有）
//          ⛔ 竞价量比（auc_vol_ratio）不在其列 —— 见下方「绝对不许用同花顺补」
//      本模块把它们组装成「补今天的 market_metrics」，一次性让所有看板恢复。
//
// 【与 logic/auction/trend-patch.js 的区别（⛔ 别搞混）】
//   trend-patch 是**纯展示**补缺，红线写着「⛔ 不写 market_metrics」。
//   本模块是**用户显式点击后写库**的临时补救（用户明确要求），两者不是一回事。
//
// 【安全约束（逐条都必须守住）】
//   · ⛔ 只 upsert，绝不 delete（§11）。
//   · ⛔ 只填【空字段】：库里已有值一律不覆盖（幂等；重复点也只补仍为空的行）。
//   · ⛔ 双重日期闸门：快照 data_status 必须 'final' 且服务端日期 == 目标日
//        （否则会把上一交易日的竞价量写到今天头上 —— trend-patch 里记过这个坑）。
//   · ⛔ 只允许补「今天」（历史日有自己的补拉链路，不从这里走）。
//   · §10：读名单 / 读库 / 写库 任一步失败都向上抛，绝不伪装成"已补好"。
//   · §32：模块级单飞，连点只跑一次；不自动触发，只能由用户按钮调用。
import { readAuctionRoster, readAuctionMetrics, upsertAuctionMetrics, AUCTION_SCOPE } from '../../data/auction-metrics-patch.js';
import { fetchDailyPctRange } from '../../data/daily-pct-range.js';
import { fuyaoApiGet, tickerToThscode } from '../../data/api/fuyao-proxy.js';
import { computeKlineDayPatch } from './trend-patch.js';
import { beijingTodayStr } from './auction-pull-window.js';
// ★ [VOL-COVER 2026-11-05] 「展示名单」唯一真相 —— 与十日涨幅的自愈目标同源（dragon-rank）。
import { getDragonTargetRows } from './dragon-rank.js';
import { getStockCode, resolveStockCodes } from '../../data/stock-code-map.js';
import { _dbgLog } from '../../data/debug-log.js';

/** 快照接口单批上限（与 suspend.js / trend-patch.js 同一契约：40 个 thscode） */
const SNAPSHOT_CHUNK = 40;
/**
 * ★★ [SNAP-BYPASS 2026-11-05] 竞价快照是本模块**唯一**的竞价量来源，必须走「受控放行」。
 *
 * 🔴 事故（就是今天第一页整列 '-' 的直接成因之一）：
 *   2026-10-30 打开 FUYAO_OFF 总闸后，`fuyaoApiGet` 要求调用方**同时**给
 *   `allowWhenOff: true` + `timeoutMs > 0` 才放行 `/api/a-share/auction/snapshot`。
 *   trend-patch.js 给了（所以五日趋势图有当天竞价量），而**本模块没给** ⇒ 每次调用都在
 *   `new URL` 之前就被拒 ⇒ `❌ 快照腿失败` ⇒ 竞价量 / 竞价涨幅 / 换手率一条都补不上。
 *   于是就出现了用户看到的那一幕：**趋势图有、第一页没有**。
 *
 * ⛔ 不要放宽成「整个 fuyao 通道打开」：那会把 10-30 的卡死放回来（见 fuyao-proxy.js 文件头）。
 *    这里只放行这一个端点，且必须带超时 —— 与 trend-patch 的用法逐字一致。
 */
const SNAPSHOT_TIMEOUT_MS = 8000;

const _inflight = new Map();

// ── 格式化：与库内既有行的字符串口径逐字一致（见 2026-10-23 真实样例行） ──────────────
//   change_pct / auc_pct_chg : "+10.00%" / "-3.77%"（带符号 + 两位小数 + %）
//   volume / yest_volume     : "612" / "6137"（整数，单位万股）
//   auc_turnover                 : "2.27"（两位小数，无单位）
//   ⛔ auc_vol_ratio 不在此处格式化的范围内（同花顺口径不对，本模块永不补它）
//
// ⚠️ 三个函数都先把「空串 / 纯空白」判成缺失 —— 否则 Number('') === 0 会把"没有值"
//    写成 "0.00%"/"0"，那是**编造数据**（§10 宁缺勿错）。
function _miss(v) {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '') || !isFinite(Number(v));
}

export function fmtPct(v) {
  if (_miss(v)) return null;
  const n = Number(v);
  return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
}
export function fmtIntVol(v) {
  if (_miss(v)) return null;
  const n = Number(v);
  return n > 0 ? String(Math.round(n)) : null;
}
export function fmtRatio(v) {
  if (_miss(v)) return null;
  return Number(v).toFixed(2);
}

/** 库里这个字段算不算"空"（null / undefined / 空串 / 纯空白） */
function _isEmpty(v) {
  return v === null || v === undefined || String(v).trim() === '';
}

/** 各字段补齐计数（返回对象口径固定，便于 UI 与日志稳定消费） */
function _emptyFilled() {
  return { pct: 0, vol: 0, turnover: 0 };
}

/** 拉竞价快照（分批），返回 { items, timestamp, dataStatus } */
async function _fetchSnapshot(thscodes) {  const out = [];
  let timestamp = 0;
  let dataStatus = '';
  for (let i = 0; i < thscodes.length; i += SNAPSHOT_CHUNK) {
    const chunk = thscodes.slice(i, i + SNAPSHOT_CHUNK);
    const data = await fuyaoApiGet('/api/a-share/auction/snapshot', {
      thscodes: chunk.join(','),
      stage: 'final',
    }, { allowWhenOff: true, timeoutMs: SNAPSHOT_TIMEOUT_MS });
    if (i === 0) {
      timestamp = Number(data && data.timestamp) || 0;
      dataStatus = String((data && data.data_status) || '');
    }
    const arr = (data && data.item) || [];
    for (let k = 0; k < arr.length; k++) out.push(arr[k]);
  }
  return { items: out, timestamp: timestamp, dataStatus: dataStatus };
}

/**
 * ★★★ [VOL-COVER 2026-11-05] 「今天该有哪些票」的唯一真相 = **展示名单**，不是「worker 抓取名单」。
 *
 * 🔴 事故（2026-11-05 用户第 9 次报障）：「襄阳轴承五日趋势图有当天竞价量，第一页的竞价量却显示横杠」
 *   「上海九百 / 上海洗霸 / 大洋电机 也没有当天数据」。
 *   逐环取证：
 *     · `auction_watchlist` 今天 **76 行**，其中 21 行 `source=range20`（20 日补位）、9 行后来补的；
 *     · `market_metrics` 里这 21 行的 `volume` **全是 null**（Edge 建行时快照腿没拿到手数）；
 *     · 观察组壳行（上海洗霸/大洋电机）**在四张表里今天一行都没有** —— 它们是视图注入行，
 *       而第一页的竞价量列**只读库**，趋势图却有一条第 4 腿（前端快照现算）⇒ 天然不同步。
 *   ⇒ 根因同一类：**「读库的展示位」+「写库的人只认 worker 名单」**。
 *
 * 修法（结构性，一处）：补数的目标名单从「auction_watchlist」扩展到
 *   **`getDragonTargetRows(date)`** —— 那个函数的口径本来就是「看板当天真正会渲染出来的行」
 *   （正式成员 + 打标签继承 + 前一日竞昨高光观察组 + 20 日补位/龙头壳行），
 *   与十日涨幅自愈用的分母**同一个定义**（§6：一处定义，两处消费）。
 *
 * 这样「库里有没有行」不再取决于「它是不是 883410 成分股」，而取决于「它会不会被显示」。
 *
 * @param {string} date
 * @param {Array<{stock:string, code?:string}>} [extraStocks]
 *        ★ [VOL-COVER 2026-11-05] 调用方「当前真正渲染出来的行」。
 *        ⛔ 这一参数是为了消灭「第四份名单定义」：观察组壳行有一部分来自
 *        `obsBought_<date>`（localStorage）与龙头组名册，`getDragonTargetRows` 看不到它们，
 *        但它们**确实显示在界面上**。谁渲染谁提供，名单口径天然等于界面（§6）。
 * @returns {Promise<Array<{stock:string, code:string}>>}
 * @throws 正式名单读取失败（§10 —— 不把"读不到"伪装成"没有票"）
 */
async function _resolveRoster(date, extraStocks) {
  const byName = new Map();
  const wl = await readAuctionRoster(date);           // ① 正式名单（带 code）
  wl.forEach(function(r) {
    const n = String((r && r.stock) || '').trim();
    if (!n) return;
    byName.set(n, { stock: n, code: String((r && r.code) || '').trim() });
  });
  // ② 展示名单并集（观察组继承 / 打标签继承 / 20 日补位 / 龙头壳行）
  let targets = [];
  try {
    targets = getDragonTargetRows(date) || [];
  } catch (e) {
    // 视图层名单拿不到 ⇒ 退化为「只补正式名单」，⛔ 不能让补数整条链挂掉，但必须留痕
    _dbgLog('[THS-PATCH] 展示名单读取失败（本次只补正式名单）: ' + (e && e.message || e));
  }
  targets.forEach(function(r) {
    const n = String((r && r.stock) || '').trim();
    if (!n) return;
    const c = String((r && r.code) || '').trim();
    if (byName.has(n)) {
      const cur = byName.get(n);
      if (!cur.code && c) cur.code = c;
      return;
    }
    byName.set(n, { stock: n, code: c });
  });
  // ②.5 调用方「当前真正渲染的行」（观察组 obsBought 壳行 / 龙头组壳行等 dragon-target 看不到的）
  (Array.isArray(extraStocks) ? extraStocks : []).forEach(function(r) {
    const n = String((r && (r.stock || r.name)) || '').trim();
    if (!n) return;
    const c = String((r && r.code) || '').trim();
    if (byName.has(n)) {
      const cur = byName.get(n);
      if (!cur.code && c) cur.code = c;
      return;
    }
    byName.set(n, { stock: n, code: c });
  });
  // ③ 代码兜底：壳行往往没有 code，用股票名册解析（§40 不猜代码，解析不到就留空 → 后面过滤掉）
  const noCode = [];
  byName.forEach(function(v) {
    if (!/^\d{6}$/.test(v.code)) {
      try { v.code = getStockCode(v.stock) || ''; } catch (e) { v.code = ''; }
    }
    if (!/^\d{6}$/.test(v.code)) noCode.push(v.stock);
  });
  // ③.5 内存缓存里查不到 ⇒ 按名去 stockcodemap 精确补一次（1 请求）。
  //   为什么必须有（2026-11-05 E2E 实证）：观察组壳行上海洗霸 / 大洋电机 在加载早期没有代码
  //   ⇒ 被「没 6 位代码不能查上游」这条规则静默过滤 ⇒ 它们的竞价量永远是 '-'。
  if (noCode.length > 0) {
    try {
      const got = await resolveStockCodes(noCode);
      got.forEach(function(code, name) {
        const v = byName.get(name);
        if (v && !/^\d{6}$/.test(v.code)) v.code = code;
      });
    } catch (e) {
      // §10：补不到代码不连坐 —— 其余票照补，只把这几只留空（⛔ 不猜代码）
      _dbgLog('[THS-PATCH] 按名补代码失败（这几只本次跳过）: ' + (e && e.message || e));
    }
  }
  const out = [];
  byName.forEach(function(v) { out.push({ stock: v.stock, code: v.code }); });
  return out;
}

/** 北京时间的「当天第几分钟」（与 stock-range-pct.js 同口径，⛔ 不用 UTC 切） */
function _beijingMinutes() {
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  return now.getUTCHours() * 60 + now.getUTCMinutes();
}

// ── 自动补竞价量（竞价时段、覆盖不足时）──────────────────────────────────
//   ⛔ 只在「展示名单里还有票缺 volume」时才跑；⛔ 不补 auc_vol_ratio（只认猫抓）；
//   ⛔ 只补今天、只在 09:25~15:00 之间补（9:25 前快照还是上一交易日，闸门也会拒）。
const AUTO_OPEN_MIN = 9 * 60 + 25;    // 北京 09:25（竞价终态最早出现的时刻）
const AUTO_CLOSE_MIN = 15 * 60;       // 北京 15:00（收盘后交给收盘覆盖链路）
const AUTO_MAX_TIMES = 3;             // 每日期每会话最多 3 次（名单分 2~3 批到货：9:25 worker / 页面注入 / 观察组壳行）
const AUTO_MIN_GAP_MS = 30 * 1000;   // 只在「缺口指纹完全相同」时用于节流（见函数内注释）
/** date -> { attempts:number, at:number } */
const _autoState = new Map();

/**
 * 竞价时段自动补齐「第一页竞价量」—— 让读库的列与趋势图（前端现算）不再打架。
 *
 * 与手动按钮的区别：只跑**快照腿**（1 请求 / 40 只，免费），不跑 K 线腿，所以很轻；
 * 其余安全约束与 `patchTodayAuctionFromThs` 完全一致（只填空 / 只 upsert / 双重日期闸门 / 单飞）。
 *
 * @param {string} [date]
 * @param {{displayStocks?:Array<{stock:string, code?:string}>}} [opts]
 *        `displayStocks` = 调用方当前**真正渲染出来的行**（补数目标名单的最后一块拼图，见 _resolveRoster）。
 * @returns {Promise<{ok:boolean, skipped?:string, missing?:number, patchedRows?:number}>} 永不抛错
 */
export async function autoFillTodayAuctionVolume(date, opts) {
  const o = opts || {};
  const extraStocks = Array.isArray(o.displayStocks) ? o.displayStocks : null;
  const d = String(date || '').trim();
  const today = beijingTodayStr();
  if (!d || d !== today) return { ok: false, skipped: '非当天（历史日的行情早已固化）' };
  const mins = _beijingMinutes();
  if (mins < AUTO_OPEN_MIN) return { ok: false, skipped: '9:25 之前（快照还不是今天）' };
  if (mins >= AUTO_CLOSE_MIN) return { ok: false, skipped: '已收盘（交给收盘覆盖链路）' };
  const st = _autoState.get(d) || { attempts: 0, at: 0, sig: '' };
  if (st.attempts >= AUTO_MAX_TIMES) return { ok: false, skipped: '本会话已自动补过 ' + st.attempts + ' 次' };
  try {
    const roster = await _resolveRoster(d, extraStocks);
    const existing = await readAuctionMetrics(d);
    const byStock = new Map();
    existing.forEach(function(r) { const k = String((r && r.stock) || '').trim(); if (k) byStock.set(k, r); });
    const missing = roster.filter(function(t) {
      const cur = byStock.get(t.stock);
      return !cur || _isEmpty(cur.volume);
    });
    if (missing.length === 0) {
      _autoState.set(d, { attempts: st.attempts, at: st.at, sig: '' });
      _dbgLog('[THS-PATCH] 自动补：展示名单 ' + roster.length + ' 只，竞价量已齐，无需补');
      return { ok: true, skipped: '无缺口', missing: 0 };
    }
    // ★ 节流判据是「缺口**指纹**」，不是时间（2026-11-05 E2E 实测踩到）：
    //   页面 6s 时名单 76 只（缺口 0），到 15s 观察组壳行注入后变 78 只（缺口 2）。
    //   用「30s 内不许再跑」会把这次真正要补的调用挡掉 ⇒ 那 2 只永远是 '-'。
    //   现在：缺口集合一样才节流（同一批没补上的别反复打），缺口集合变了立刻放行（§32 仍然不空转）。
    const sig = missing.map(function(x) { return x.stock; }).sort().join(',');
    if (st.sig === sig && (Date.now() - st.at) < AUTO_MIN_GAP_MS) {
      return { ok: true, skipped: '同一批缺口 ' + (AUTO_MIN_GAP_MS / 1000) + 's 内不重复补', missing: missing.length };
    }
    _autoState.set(d, { attempts: st.attempts + 1, at: Date.now(), sig: sig });
    _dbgLog('[THS-PATCH] 自动补：展示名单 ' + roster.length + ' 只，缺竞价量 ' + missing.length
      + ' 只（第 ' + (st.attempts + 1) + ' 次）→ 走快照腿' + (missing.length <= 8 ? '：' + missing.map(function(x) { return x.stock; }).join(',') : ''));
    const r = await patchTodayAuctionFromThs(d, { onlyVolume: true, extraStocks: extraStocks });
    return { ok: !!(r && r.ok), missing: missing.length, patchedRows: (r && r.patchedRows) || 0, filled: r && r.filled };
  } catch (e) {
    // 自动补是加分项：失败只留痕，⛔ 绝不影响看板本身的加载（§10 读失败语义仍由各自链路负责）
    _dbgLog('[THS-PATCH] 自动补失败（不影响看板）: ' + (e && e.message || e));
    return { ok: false, skipped: '异常: ' + (e && e.message || e) };
  }
}

/** 仅供测试 / 诊断：重置「自动补」的会话状态 */
export function _resetAutoFillForTest() {
  _autoState.clear();
}

/**
 * 用同花顺补齐「今天」的竞价行情并写库。
 *
 * @param {string} [date] 目标日（缺省 = 北京今天）；⛔ 只接受今天
 * @param {{onProgress?:(stage:string,done:number,total:number)=>void, requestTimeoutMs?:number,
 *          onlyVolume?:boolean, extraStocks?:Array<{stock:string, code?:string}>}} [opts]
 *        `onlyVolume=true` = 只走快照腿补竞价量（跳过 K 线腿）。自动补用的就是这条轻量路径。
 *        `extraStocks` = 调用方当前真正渲染的行（补进名单，见 _resolveRoster ②.5）。
 * @returns {Promise<{ok:boolean, date:string, roster:number, patchedRows:number, filled:{pct:number,vol:number,turnover:number}, reason?:string, logs:string[]}>}
 */
export async function patchTodayAuctionFromThs(date, opts) {
  const o = opts || {};
  const logs = [];
  const log = function(m) { logs.push(m); _dbgLog('[THS-PATCH] ' + m); };
  const report = function(stage, done, total) {
    if (typeof o.onProgress === 'function') {
      try { o.onProgress(stage, done, total); } catch (e) { /* 进度回调失败不影响主流程 */ }
    }
  };

  const today = beijingTodayStr();
  const d = date || today;
  if (d !== today) {
    // ⛔ 只补今天：历史日有专门的按天补拉链路，不走这条"临时救急"
    return { ok: false, date: d, roster: 0, patchedRows: 0, filled: _emptyFilled(), reason: '只允许补今天（' + today + '），收到 ' + d, logs: logs };
  }

  const fly = _inflight.get(d);
  if (fly) return fly;

  const p = (async function() {
    // ① 今天应该有哪些票 —— **展示名单**（正式成员 ∪ 观察组/打标签继承 ∪ 20 日补位 ∪ 龙头壳行）。
    //    读失败直接抛（§10）。⛔ 别退回「只认 auction_watchlist」：那正是今天第一页整列 '-' 的根因。
    const roster = await _resolveRoster(d, o.extraStocks);
    if (roster.length === 0) {
      log('名单为空（auction_watchlist ' + d + ' 无行 且 无可注入壳行）⇒ 无可补对象');
      return { ok: false, date: d, roster: 0, patchedRows: 0, filled: _emptyFilled(), reason: '当天名单为空', logs: logs };
    }
    // 只有 6 位代码的才能查上游（§40 不猜代码）
    const targets = roster
      .map(function(r) { return { stock: String(r.stock || '').trim(), code: String(r.code || '').trim() }; })
      .filter(function(t) { return t.stock && /^\d{6}$/.test(t.code); });
    log('展示名单 ' + roster.length + ' 只，其中带 6 位代码 ' + targets.length + ' 只');
    if (targets.length === 0) {
      return { ok: false, date: d, roster: roster.length, patchedRows: 0, filled: _emptyFilled(), reason: '名单没有可用代码', logs: logs };
    }

    // ② 库里现状 —— 决定"哪些字段还空着"
    const existing = await readAuctionMetrics(d);
    const byStock = new Map();
    existing.forEach(function(r) {
      const k = String(r.stock || '').trim();
      if (k) byStock.set(k, r);
    });
    log('库内已有 ' + existing.length + ' 行（缺字段的会被补，已有的绝不覆盖）');

    // ③ K 线腿：涨幅 / 开盘涨幅(竞价) / 昨日成交量 —— 一次请求三样，0 猫抓额度
    //    ★ [VOL-COVER 2026-11-05] `onlyVolume` 时【整条跳过】：自动补只关心竞价量，
    //      而 K 线腿是「每只票一次上游请求」的重活 —— 竞价时段每秒都在刷，⛔ 不许把它带进自动路径。
    const openOut = new Map();
    const volOut = new Map();
    let pctMap = null;
    if (o.onlyVolume) {
      report('kline', targets.length, targets.length);
      log('只补竞价量模式：跳过 K 线腿（涨幅/昨量本次不动）');
    } else {
      report('kline', 0, targets.length);
      try {
        pctMap = await fetchDailyPctRange(
          targets,
          [d],
          { requestTimeoutMs: o.requestTimeoutMs || 20000, openOut: openOut, volOut: volOut }
        );
      } catch (e) {
        // §10：K 线腿失败只降级这一腿（快照腿照走），但不伪装成"没有数据"
        log('❌ K 线腿失败（涨幅/竞价涨幅/昨量本次补不上）: ' + (e && e.message || e));
      }
    }

    // ④ 快照腿：竞价量 / 竞价涨幅(终态) / 真换手率 —— 仅当天有，必须过双重闸门
    //    ⛔ 竞价量比（auc_vol_ratio）刻意不在其中：同花顺口径与猫爪不同源，补了就是错数据。
    report('snapshot', 0, targets.length);
    let snapByName = new Map();
    try {
      const snap = await _fetchSnapshot(targets.map(function(t) { return tickerToThscode(t.code); }));
      const snapYmd = snap.timestamp > 0
        ? new Date(snap.timestamp + 8 * 3600 * 1000).toISOString().slice(0, 10) : '';
      if (snap.dataStatus !== 'final' || snapYmd !== d) {
        // 闸门拒绝：⛔ 绝不把上一交易日的竞价量写到今天头上
        log('⚠️ 快照闸门拒绝（data_status=' + snap.dataStatus + ' 服务端日=' + snapYmd + ' 目标日=' + d + '）⇒ 竞价量/换手本次不补');
      } else {
        // 双键登记：响应里的 thscode 带 .SH/.SZ 后缀，裸码也要能命中
        const nameOf = {};
        targets.forEach(function(t) {
          nameOf[t.code] = t.stock;
          const ths = tickerToThscode(t.code);
          if (ths !== t.code) nameOf[ths] = t.stock;
        });
        (snap.items || []).forEach(function(it) {
          if (!it || !it.thscode) return;
          const name = nameOf[String(it.thscode).trim()] || nameOf[String(it.thscode).split('.')[0]];
          if (!name) return;
          // 同名的后写覆盖先写（同一只票只应有一条）
          snapByName.set(name, it);
        });
        log('快照命中 ' + snapByName.size + '/' + targets.length + ' 只（data_status=final，服务端日 ' + snapYmd + '）');
      }
    } catch (e) {
      log('❌ 快照腿失败（竞价量/换手本次补不上）: ' + (e && e.message || e));
    }

    // ⑤ 组装：只放「库里为空 + 上游拿到了」的字段
    const ymd = d.replace(/-/g, '');
    const rows = [];
    const filled = _emptyFilled();
    targets.forEach(function(t) {
      const cur = byStock.get(t.stock) || null;
      const keep = pctMap ? pctMap.get(t.stock) : null;
      const k = computeKlineDayPatch(
        ymd,
        keep || null,
        openOut.get(t.stock) || null,
        volOut.get(t.stock) || null
      );
      const snap = snapByName.get(t.stock) || null;

      // 基础键 —— 新行要带 code / source；已有行只带键（其余字段靠 merge 保留原值）
      const row = { date: d, stock: t.stock, code: t.code, scope: AUCTION_SCOPE };
      if (!cur) {
        // 如实标注来源，⛔ 不冒充 worker（追溯时能一眼分清哪些是临时补的）
        row.source = 'ths-patch';
        row.updated_by = 'ths-patch';
      }

      // 涨幅
      if (!cur || _isEmpty(cur.change_pct)) {
        const v = fmtPct(k.changePct);
        if (v !== null) { row.change_pct = v; filled.pct++; }
      }
      // 竞价涨幅：快照终态值优先（K线 open 换算是兜底）
      if (!cur || _isEmpty(cur.auc_pct_chg)) {
        const fromSnap = snap && snap.auction_pct != null && isFinite(Number(snap.auction_pct))
          ? Number(snap.auction_pct) : null;
        const v = fmtPct(fromSnap !== null ? fromSnap : k.aucPctChg);
        if (v !== null) row.auc_pct_chg = v;
      }
      // 昨日成交量（万股）
      if (!cur || _isEmpty(cur.yest_volume)) {
        const v = fmtIntVol(k.yestVolume);
        if (v !== null) row.yest_volume = v;
      }
      // 竞价量（手 → 万股）
      if (!cur || _isEmpty(cur.volume)) {
        const raw = snap && snap.auction_volume != null && isFinite(Number(snap.auction_volume))
          ? Number(snap.auction_volume) / 100 : null;
        const v = fmtIntVol(raw);
        if (v !== null) { row.volume = v; filled.vol++; }
      }
      // ⛔⛔ 竞价量比（auc_vol_ratio）【绝对不许用同花顺补】—— 2026-10-26 用户口径：
      //   「早盘竞价看板的股票中的竞价量比统计不对吧，这个是同花顺统计不出来的，
      //     是猫爪数据才可以统计出来，现在的竞价量比就很小怎么可能，导致题材量比选股失真，
      //     这个要用猫爪数据接口的，如果额度用完了，就留空，就行了，不要强行补上去。」
      //
      //   为什么必须留空而不是"尽力补"：
      //     同花顺快照里的 auction_volume_ratio 与猫爪（numcat）的 auc_vol_ratio
      //     **不是同一个指标**，两者分母口径不同（同花顺按自身统计窗口，猫爪按昨日成交量）。
      //     数值会系统性偏小 ⇒ 题材量比看板按「题材平均竞价量比」排序、决策看板把
      //     auc_vol_ratio 当【选票依据】（logic/decision/decision-rules.js:67）⇒ 直接选错股。
      //     宁可空着让 UI 显示「-」，也不能填一个看起来像真的错数字（§10 宁缺勿错 / §40 不猜）。
      //   ⇒ 本字段的唯一合法来源是猫爪；额度用完就空着，等猫爪下次补漏（worker 侧负责）。
      //
      //   （历史教训：本文件最初照抄了 workers/bidding-auto-fetch/data/fuyao-api.js 里
      //     「auc_vol_ratio ← auction_volume_ratio」这条换算，那条注记写的是"量纲已交叉验证"，
      //     但两个平台的分子分母并不是同一件事，量纲对不代表口径对。）

      // 真换手率 ← snapshot.auction_turnover_pct（量纲换算已交叉验证，见
      //   workers/bidding-auto-fetch/data/fuyao-api.js 的 [SNAPSHOT-EXTRAS] 注记）
      // ⛔ um_vol / open_bid_pct 不在同花顺快照能力内（auction_unmatched 带符号，
      //    与库内 um_vol 语义不同源）⇒ 按 §40 留空，绝不猜。
      if (!cur || _isEmpty(cur.auc_turnover)) {
        const raw = snap && snap.auction_turnover_pct != null && isFinite(Number(snap.auction_turnover_pct))
          ? Number(snap.auction_turnover_pct) : null;
        const v = fmtRatio(raw);
        if (v !== null) { row.auc_turnover = v; filled.turnover++; }
      }

      // 没有任何一个字段要补 ⇒ 不提交（省请求，也让"全部已完整"能被观察到）
      const hasPayload = Object.keys(row).some(function(key) {
        return key !== 'date' && key !== 'stock' && key !== 'code' && key !== 'scope';
      });
      if (hasPayload) rows.push(row);
    });

    report('write', 0, rows.length);
    if (rows.length === 0) {
      log('✅ 库内字段已完整，无需补写');
      return { ok: true, date: d, roster: roster.length, patchedRows: 0, filled: filled, reason: '已完整', logs: logs };
    }

    // ⑥ 写库（只 upsert，⛔ 不 delete）
    const written = await upsertAuctionMetrics(rows);
    log('✅ 补写 ' + written + ' 行（其中涨幅 ' + filled.pct + '、竞价量 ' + filled.vol + '、换手 ' + filled.turnover + '）');
    log('ℹ️ 竞价量比(auc_vol_ratio) 按口径不补 —— 只认猫爪，额度不足时留空');
    report('done', written, rows.length);
    return { ok: true, date: d, roster: roster.length, patchedRows: written, filled: filled, logs: logs };
  })().finally(function() {
    _inflight.delete(d);
  });

  _inflight.set(d, p);
  return p;
}

/** 仅供测试 / 诊断 */
export function _resetThsPatchForTest() {
  _inflight.clear();
}
