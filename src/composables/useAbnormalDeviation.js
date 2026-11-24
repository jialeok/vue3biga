// useAbnormalDeviation.js — 「官方偏离值」的取数编排（Logic 接线层，§5 依赖方向：Composable → Data / Logic）
//
// ══════════════════════════════════════════════════════════════════════════════════════
// 【用户口径（2026-11-14 原话）】
//   「这些在买点侧，也说明下，很重要，特别是竞价时，或者收盘后，我看一遍股票或者市场前十，
//     就知道怎么参考了。你看怎么设计比较合理，包括UI显示，和每天监控时间点。」
//
// ★★ [DEV-BASIS 2026-11-24 用户原话 · 本文件的中心]
//   「我要求的是在竞价时间就可以知道它的偏离值看是否触发，所以用竞价口径，等到收盘，
//     再覆盖下，再计算，这是原来我一直要求的。也就是分为竞价口径和收盘口径。」
//   「再添加一个竞价口径 toggle，我点开的时候，就可以看到竞价时间的看是否触发，
//     这样我就可以对比收盘口径……这两个都要保存起来，我以后翻开历史日期时，比较方便复盘。」
//
//   ⇒ **一次算出两套 fact，随时可切**（不是「按时间只算一套」）：
//     · 收盘口径 = `stock_daily_pct` 的当日收盘涨幅（16:00 后由 worker 写入）
//     · 竞价口径 = `market_metrics(scope=auction).auc_pct_chg` 的当日 9:25 竞价涨幅，
//                  且**对应指数当日那一根按 0 计**（9:25 指数还没有价格 —— 这是竞价时点的事实）
//   ⇒ 两套都只读**已经永久落库的原料**，所以「复盘历史某天」时能同时还原两个口径，
//     ⛔ 不需要为它新建快照表（§6 单一数据源；§40 不猜表名）。
//
//   ⚠️ 旧的实现有两个致命错（2026-11-24 审查坐实）：
//     ① 窗口锚在**指数腿**上，而 9:25 没有「今天」的指数腿 ⇒ 窗口静默前移一天 ⇒
//        竞价涨幅被窗口丢掉 ⇒ 9:25 显示的数与昨晚收盘一模一样（而文案写「截至今日 9:25 竞价」）。
//     ② `todayPctOf` 取的是 `buyRangeMap.pct` —— 那是**10 日区间涨幅**（如 +64%），
//        不是今日竞价涨幅。契约错配，只是被 ① 挡住才没炸（§38 教训：契约要看入参形态）。
//     ⇒ 现在 ① 由 `indexTodayFlat`（补/覆盖一根 pct=0 的指数腿）解决，② 由本文件直接读
//       `market_metrics.auc_pct_chg` 解决。⛔ 别再让调用方传当日涨幅进来。
//
// ── 口径判据（`deviationBasisFor`，纯函数在 Logic 层）──────────────────────────────
//   历史日 ⇒ close（§11 稳定复盘）｜今天且收盘腿已入库 ⇒ close（收盘覆盖）｜
//   今天且 9:25 竞价档就绪且未过 15:00 ⇒ auction｜其余 ⇒ close（并在 meta 里如实交代）
//
// ── 红线 ────────────────────────────────────────────────────────────────────────
//   · ⛔ 只读：不写库、不改 stock_daily_pct、不改任何选股结论；
//   · §10：日腿读失败 / 指数缺腿 / 竞价涨幅缺 ⇒ meta.ready 如实反映，⛔ 绝不把「没算出来」当「没有异动」；
//   · §32：两套口径**同一批腿**算两次 ⇒ 0 额外请求；竞价涨幅走 `readMarketMetricsForDate`（memo 缓存）；
//   · 切日期竞态：`_seq` 序号闸，晚回来的旧请求一律丢弃。
// ══════════════════════════════════════════════════════════════════════════════════════

import { computed, ref, shallowRef } from 'vue';
import { readDailyPctRowsFor } from '../data/stock-daily-pct.js';
import { readMarketMetricsForDate } from '../data/market-metrics.js';
import {
  readIndexLegsForDates, indexLegsOf, indexLegsGapText, shiftYmd
} from '../data/index-daily-pct.js';
import {
  buildDeviationMap, deviationCellTexts, deviationDetailLine, deviationIndexLabel,
  deviationBasisFor, deviationBasisNote, DEV_CLOSE_HHMM, pickBaseIndexForCode,
  DEV_FORMULA_LINES, DEV_INDEX_NOTE_LINES, DEV_NEED_HINT,
  DEV_STAGE_NEAR, DEV_STAGE_SEVERE, DEV_STAGE_WATCH
} from '../logic/auction/abnormal-deviation.js';
import { beijingTodayStr, beijingNowHHMM } from '../logic/auction/auction-pull-window.js';
import { numOfText } from '../logic/util/num-text.js';
import { _dbgLog } from '../data/debug-log.js';

/**
 * 窗口向前取多少自然日。
 * ★ [ABN-TRIGGER 2026-11-15] 75 → 120：面板要给「首次 / 二次 / 三次触发」标序号，
 *   就必须有足够长的历史做【逐日复算】（30 日窗口本身要吃 30 根腿）。
 *   ⚠️ 这只加宽【同一次查询】的日期范围（同一张表、同一批票），**不是新增请求**（§32）。
 */
const LOOKBACK_DAYS = 120;

// ── 会话级缓存：把「每片数据都要重读一次」变成「一个交易日只读一次」────────────────
//
// 🔴 [PERF-DEV 2026-11-24 用户报障「题材量比的响应速度有些变慢了」] 真实链路计时（node 直连真库）：
//   冷启动 4733ms / 11 个请求；其中 8 个是腾讯指数日线（全 501，见 index-daily-pct 的 [IDX-QT-BREAKER]）、
//   1 个 stock_daily_pct、1 个 market_metrics(index)、1 个 market_metrics(auction)。
//   热重算 545ms / 1 个请求 —— 说明「每片都重读」的代价完全可控，但那 1 个请求必须去掉：
//   · `auc_pct_chg` 是 9:25 一次性写入的，**当日不会再变** ⇒ 按日缓存，读一次就够；
//   · 当日收盘腿（16:00 写入）只影响「该不该切回收盘口径」，见 `_closeSeen`。
const _aucPctCache = new Map();          // date -> Map<票名, 竞价涨幅>（只存非空结果）
const _closeSeen = new Set();            // date 已确认「当日收盘腿入库」⇒ 之后不再强制 fresh
const CACHE_MAX_DATES = 12;

function _putAucCache(date, m) {
  if (!date || !(m instanceof Map) || m.size === 0) return;   // ⛔ 空结果不缓存：9:25 还没落库时要能重试
  _aucPctCache.set(date, m);
  while (_aucPctCache.size > CACHE_MAX_DATES) {
    const oldest = _aucPctCache.keys().next().value;
    if (oldest === undefined) break;
    _aucPctCache.delete(oldest);
  }
}

/** 仅供测试 / 诊断 */
export function clearDeviationSessionCaches() {
  _aucPctCache.clear();
  _closeSeen.clear();
}

function _emptyMeta(asOf) {
  return {
    asOf: asOf || '',
    ready: 0,
    total: 0,
    src: '',
    loading: false,
    /** 当前展示口径 'auction' | 'close' */
    basis: 'close',
    /** 自动判出的口径（同一份，但不受用户 toggle 影响） */
    autoBasis: 'close',
    /** 口径文案（「竞价口径…」/「收盘口径…」/「收盘腿未入库…」） */
    basisText: '',
    /** 竞价口径是否真的算出来了（数据侧） */
    aucReady: false,
    /** 收盘口径是否真的算出来了（数据侧） */
    closeReady: false,
    error: '',
    note: '',
    // ★ [ABN-DEV-UX 2026-11-14] 面板顶部「计算公式」—— 用户「我自己也要验证下」。
    //   静态常量，视图只 v-for（§21 模板零计算）。
    formulaLines: DEV_FORMULA_LINES,
    // ★ [IDX-LABEL 2026-11-14] 「对应指数是什么」说明（用户「顺便在提示板上面说明下」）。
    //   与公式块分开排版：这块回答「减的是谁」，公式块回答「怎么减」。
    indexNoteLines: DEV_INDEX_NOTE_LINES
  };
}

/** 腿 Map（票名 → {日期→涨幅}）里出现过的全部交易日（升序） */
function _datesOf(dailyMap) {
  const set = new Set();
  if (dailyMap && typeof dailyMap.forEach === 'function') {
    dailyMap.forEach(function (dayMap) {
      if (dayMap && typeof dayMap.forEach === 'function') {
        dayMap.forEach(function (_v, d) { if (d) set.add(String(d).slice(0, 10)); });
      }
    });
  }
  return Array.from(set).sort();
}

/** 这批票里有没有任何一只在 date 那天有腿（= 当日收盘腿已入库） */
function _hasLegAt(dailyMap, date) {
  const d = String(date || '').slice(0, 10);
  if (!d || !(dailyMap instanceof Map)) return false;
  let hit = false;
  dailyMap.forEach(function (dayMap) {
    if (hit) return;
    if (dayMap && typeof dayMap.has === 'function' && dayMap.has(d)) hit = true;
  });
  return hit;
}

/**
 * 读某日的【9:25 竞价涨幅】（`market_metrics(scope=auction).auc_pct_chg`）。
 * ⛔ 这是「今日竞价涨幅」的**唯一**来源：不许拿 10 日区间涨幅、也不许拿收盘涨幅顶替。
 * ★ [PERF-DEV] 按日缓存：竞价涨幅是 9:25 一次性写入的，当日不会再变 ⇒ 一次读取、整日复用。
 *   ⚠️ 只在**读到行**时缓存；9:25 还没落库那次返回空 Map 必须能重试（见 `_scheduleAucWait`）。
 * @returns {Promise<Map<string, number>|null>} null = 读取失败（§10，⛔ 不当空数据）
 */
async function _readAucPctMap(date) {
  const d = String(date || '').slice(0, 10);
  const hit = _aucPctCache.get(d);
  if (hit) return hit;
  try {
    const rows = await readMarketMetricsForDate(date, 'auction');
    const m = new Map();
    (rows || []).forEach(function (r) {
      if (!r || !r.stock) return;
      const v = numOfText(r.auc_pct_chg);
      if (v === null) return;
      const n = String(r.stock).trim();
      if (n && !m.has(n)) m.set(n, v);
    });
    _putAucCache(d, m);
    return m;
  } catch (e) {
    _dbgLog('[ABN-DEV] ' + date + ' 竞价涨幅（auc_pct_chg）读取失败：' + ((e && e.message) || e));
    return null;
  }
}

/** 档位 → 面板行色调（视图只读字符串，§21） */
function _toneOf(fact) {
  if (!fact || fact.ok !== true) return '';
  if (fact.stage === DEV_STAGE_SEVERE) return 'severe';
  if (fact.stage === DEV_STAGE_NEAR) return 'near';
  if (fact.stage === DEV_STAGE_WATCH) return 'watch';
  return 'normal';
}

/**
 * 等「今日 9:25 竞价档」落库的重试参数。
 *
 * ★★ [DEV-AUC-WAIT 2026-11-24 用户原话]
 *   「那个官方偏离值竞价口径是默认打开的……早上 9 点 25 分左右，我就可以看到的是竞价口径，
 *     而不是昨天的收盘口径，这个很重要」。收盘口径只是复盘用。
 *
 * 🔴 真实时点取证（11-24 `bidding_fetch_log`）：09:25:05 起抓、**09:25:32 morning 收工**、
 *   09:26:39 ladder26、09:27:25 snapshot 把量比补齐。也就是说 9:25:35 之后 `auc_pct_chg` 才在库里。
 *   ⇒ 用户在 9:24 打开页面、或者 9:25:10 就打开，那一刻**数据客观上还不存在**。
 *     这不是「算错了」，是「还没到货」—— 所以不能永远停在收盘口径（那就是昨天的数），
 *     也不能假装竞价口径（会显示一片「—」）。
 *   ⇒ 有界重试：竞价窗口内、竞价档没就绪、且当日收盘腿也还没入库时，每 12 秒重读一次，
 *     最多 15 次（≈3 分钟）。数据一落地就当片切成竞价口径并停止。
 *   ⛔ 这不是「用 setTimeout 掩盖根因」（§35）：根因是上游写入时刻，我们只负责「到货即见」；
 *      次数与时长都写死上限，绝不常驻轮询。
 */
const AUC_WAIT_MS = 12000;
const AUC_WAIT_MAX = 15;
/** 竞价窗口起点：9:15 开始集合竞价，之前没必要等（那时候连竞价数据都不该有） */
const AUC_WINDOW_FROM = '09:10';

/**
 * @returns {{
 *   devMap: object, meta: object, basis: object, load: Function, rowsFor: Function,
 *   setBasis: Function, toggleBasis: Function, clear: Function
 * }}
 */
export function useAbnormalDeviation() {
  const mapClose = shallowRef(new Map());
  const mapAuc = shallowRef(new Map());
  /** 当前展示口径（用户 toggle 之后以用户为准；切换时只切 Map，⛔ 不重新取数） */
  const basis = ref('close');
  /** 当前口径对应的 Map —— 买点行徽标与面板必须读同一份（§6 一把尺子） */
  const devMap = computed(function () {
    return basis.value === 'auction' ? mapAuc.value : mapClose.value;
  });
  const meta = shallowRef(_emptyMeta(''));
  let _seq = 0;
  /**
   * 用户在当前日期上手动选过的口径（date -> 'auction'|'close'）。
   * ★ [DEV-BASIS-DEFAULT 2026-11-24] 用户第二轮原话：「不用点竞价口径，默认是竞价口径，
   *   点开后才变成收盘口径。我想看收盘口径时点开就可以看了。」
   * ⇒ 默认（没点过）= 竞价口径；点了之后**在本日期内保持**，不许被行情刷新（version++）弹回去
   *   —— 否则他刚点开看收盘，几秒后又被弹回竞价，等于点了没用。
   *   ⛔ 也**不设「自动判据变了就作废」**：16:30 之后自动判据本来就是 close，那样会让
   *   「收盘后想看竞价口径对比」变成刷新即丢失，与「翻开历史日期比较复盘」的诉求相冲。
   */
  const _userBasis = new Map();
  // ── 「等竞价档到货」的有界重试（见 AUC_WAIT_* 注释）──────────────────────────
  let _aucTimer = null;
  let _aucLeft = 0;
  let _lastArgs = null;

  function _stopAucWait() {
    if (_aucTimer) { clearTimeout(_aucTimer); _aucTimer = null; }
    _aucLeft = 0;
  }

  function _scheduleAucWait() {
    if (_aucTimer || _aucLeft <= 0) return;
    _aucTimer = setTimeout(function () {
      _aucTimer = null;
      _aucLeft--;
      if (_lastArgs) void load(Object.assign({}, _lastArgs, { quiet: true }));
    }, AUC_WAIT_MS);
  }

  function setBasis(b) {
    const v = b === 'auction' ? 'auction' : 'close';
    if (basis.value === v) return;
    basis.value = v;
    // 记住「这个日期上用户想看哪一套」（同一天内的重算不许把他弹回去）
    const d = String(meta.value.asOf || '').slice(0, 10);
    if (d) _userBasis.set(d, v);
    // 口径切换要顺带刷新 meta 上的「当前口径」字段（视图靠它显示 toggle 状态与说明）
    meta.value = Object.assign({}, meta.value, {
      basis: v,
      ready: _readyOf(v),
      total: meta.value.total || 0,
      basisText: meta.value.basisNoteAuto || meta.value.basisText
    });
  }

  function _readyOf(b) {
    const m = b === 'auction' ? mapAuc.value : mapClose.value;
    let n = 0;
    if (m instanceof Map) m.forEach(function (f) { if (f && f.ok) n++; });
    return n;
  }

  /** 用户点 toggle：竞价口径 ⇄ 收盘口径（纯切换，⛔ 不重新请求、⛔ 不改任何结论） */
  function toggleBasis() {
    setBasis(basis.value === 'auction' ? 'close' : 'auction');
  }

  function clear() {
    _seq++;
    _stopAucWait();
    _lastArgs = null;
    mapClose.value = new Map();
    mapAuc.value = new Map();
    meta.value = _emptyMeta('');
  }

  /**
   * 拉一次偏离值（**一次算两套口径**，随时可切）。
   * @param {object} o
   * @param {string[]} o.names 要算的票（买点侧选中票 + 市场前十）
   * @param {string} o.asOf 窗口末日（当天 = 今日）
   * @param {function(string):string} o.codeOf 票名 → 6 位代码
   * @param {string} [o.today] 北京今天（缺省现取；仅供测试注入）
   * @param {string} [o.hhmm] 北京当前 HH:MM（缺省现取；仅供测试注入）
   * @returns {Promise<void>}
   */
  async function load(o) {
    const opt = o || {};
    const names = Array.from(new Set((opt.names || [])
      .map(function (n) { return String(n || '').trim(); })
      .filter(Boolean)));
    const asOf = String(opt.asOf || '').slice(0, 10);
    if (names.length === 0 || !asOf) { clear(); return; }

    const today = String(opt.today || '').slice(0, 10) || beijingTodayStr();
    const hhmm = String(opt.hhmm || '').slice(0, 5) || beijingNowHHMM();
    const isToday = asOf === today;

    const my = ++_seq;
    _lastArgs = { names: names, asOf: asOf, codeOf: opt.codeOf, today: opt.today, hhmm: opt.hhmm };
    // 重试时用 quiet：不把 meta 打回 loading（否则每 12 秒闪一次「读取中…」）
    if (opt.quiet !== true) {
      meta.value = Object.assign(_emptyMeta(asOf), {
        loading: true, total: names.length, basis: basis.value
      });
    }

    try {
      const from = shiftYmd(asOf, -LOOKBACK_DAYS);
      // 🔴 [DEV-BASIS] 收盘后（≥15:00）的当天必须绕过会话缓存：`_subCache` 里可能是 9:25 读的、
      //   还没有「今天那根收盘腿」的旧结果 ⇒ 不绕过就永远判不出「收盘腿已就绪」，
      //   面板会整晚停在竞价口径（实测 16:01 全表才写入）。
      // ★ [PERF-DEV] 但只绕过到「第一次确认今天收盘腿已入库」为止：之后每片都强制 fresh
      //   就等于把缓存删了（切日期 / 每次刷新都重打一次 stock_daily_pct）。
      const fresh = isToday && hhmm >= DEV_CLOSE_HHMM && !_closeSeen.has(asOf);
      // ★ [PERF-DEV] 竞价涨幅与个股逐日腿**互不依赖** ⇒ 同时发出，别串行等（冷启动实测省 ~1/3）
      const aucPromise = _readAucPctMap(asOf);
      const daily = await readDailyPctRowsFor(names, from, asOf, { fresh: fresh });
      if (my !== _seq) return;                                  // 切日期了，丢弃
      if (!daily) {
        // §10：读失败 ≠ 没有数据。⛔ 不拿空 Map 顶替，也不清空已有结果（可能是同一份数据的旧值）
        meta.value = Object.assign(_emptyMeta(asOf), {
          total: names.length,
          error: '逐日涨幅腿（stock_daily_pct）读取失败'
        });
        _dbgLog('[ABN-DEV] ' + asOf + ' 逐日腿读取失败 ⇒ 本次偏离值判不出（§10）');
        return;
      }

      const closeLegReady = _hasLegAt(daily, asOf);
      if (closeLegReady) _closeSeen.add(asOf);
      const dates = _datesOf(daily);
      // ★ [IDX-QT-BREAKER] 只取这批票真正用到的对应指数（通常 1~2 只，不是 4 只）
      const idxCodes = Array.from(new Set(names.map(function (n) {
        const c = String((typeof opt.codeOf === 'function' ? opt.codeOf(n) : '') || '').trim();
        const info = c ? pickBaseIndexForCode(c) : null;
        return info ? info.code : '';
      }).filter(Boolean)));
      const idxRes = await readIndexLegsForDates(dates, idxCodes.length ? { codes: idxCodes } : {});
      if (my !== _seq) return;

      const idxLegs = new Map();
      idxRes.map.forEach(function (_m, code) { idxLegs.set(code, indexLegsOf(idxRes.map, code, asOf)); });

      const codeOf = typeof opt.codeOf === 'function' ? opt.codeOf : function () { return ''; };
      const base = {
        names: names,
        dailyByStock: daily,
        indexLegs: idxLegs,
        codeOf: codeOf,
        asOf: asOf,
        // ★★ [ABN-TRIGGER 2026-11-15] 面板要「首次 / 二次 / 三次触发」——
        //   逐票在同一份腿上复算历史（零新增请求）。买点行徽标不走本函数，不受影响。
        withTrigger: true
      };

      // ① 收盘口径（库里当日收盘腿，缺就判不出 —— ⛔ 不拿竞价涨幅冒充收盘）
      const closeBuilt = buildDeviationMap(Object.assign({}, base, { basis: 'close' }));

      // ② 竞价口径：当日个股腿换成 9:25 竞价涨幅；对应指数当日那根**强制按 0**
      const aucMap = await aucPromise;
      if (my !== _seq) return;
      let aucBuilt = null;
      if (aucMap && aucMap.size > 0) {
        aucBuilt = buildDeviationMap(Object.assign({}, base, {
          basis: 'auction',
          todayPctOf: function (n) {
            const v = aucMap.get(String(n || '').trim());
            return v === undefined ? null : v;
          },
          indexTodayFlat: true
        }));
      }

      mapClose.value = closeBuilt.map;
      mapAuc.value = aucBuilt ? aucBuilt.map : new Map();

      const aucReady = !!aucBuilt && aucBuilt.ready > 0;
      const autoBasis = deviationBasisFor({
        date: asOf, today: today, hhmm: hhmm,
        auctionReady: aucReady,
        closeLegReady: closeLegReady
      });
      // ★ [DEV-BASIS-DEFAULT] 默认 = 自动判（交易时间内 = 竞价）；用户在本日期点过则以他为准，
      //   ⛔ 不许被行情刷新（version++）弹回去 —— 否则他刚点开收盘口径对比，几秒后又弹回竞价，等于点了没用。
      //   ⛔ 也不许「自动判据变了就把记录作废」：16:30 之后自动判据本来就是 close，那样会让
      //      「收盘后想看竞价口径对比」变成一次性动作（刷新即丢失），与「翻开历史日期比较复盘」相冲。
      const shownBasis = _userBasis.get(asOf) || autoBasis;
      basis.value = shownBasis;
      const basisText = deviationBasisNote({
        basis: shownBasis, asOf: asOf, today: today, hhmm: hhmm,
        auctionReady: aucReady,
        closeLegReady: closeLegReady
      });

      const gapNote = indexLegsGapText(idxRes);
      // ⚠️ 用 shownBasis（可能是用户点出来的收盘口径），⛔ 别用 autoBasis —— 否则点了还显示竞价那套数
      const built = shownBasis === 'auction' && aucBuilt ? aucBuilt : closeBuilt;
      meta.value = Object.assign(_emptyMeta(asOf), {
        basis: shownBasis,
        autoBasis: autoBasis,
        basisText: basisText,
        basisNoteAuto: basisText,
        aucReady: aucReady,
        closeReady: closeBuilt.ready > 0,
        ready: built.ready,
        total: built.total,
        src: idxRes.src,
        error: idxRes.ready ? '' : (idxRes.error || '指数腿未就绪'),
        note: gapNote
      });
      _dbgLog('[ABN-DEV] ' + asOf + ' 偏离值 收盘 ' + closeBuilt.ready + '/' + closeBuilt.total +
        ' · 竞价 ' + (aucBuilt ? (aucBuilt.ready + '/' + aucBuilt.total) : '0/' + closeBuilt.total) +
        '（默认口径 ' + autoBasis + '，指数腿来源 ' + idxRes.src + '，北京 ' + hhmm + '）');

      // ★★ [DEV-AUC-WAIT] 早盘「到货即切竞价口径」：
      //   竞价窗口内（09:10~15:00）+ 今天 + 竞价档还没就绪 + 当日收盘腿也还没入库
      //   ⇒ 数据客观上还没到（9:25:32 morning 才收工），有界重试；一旦就绪立刻停。
      const inAucWindow = isToday && hhmm >= AUC_WINDOW_FROM && hhmm < DEV_CLOSE_HHMM;
      if (inAucWindow && !aucReady && !closeLegReady) {
        if (_aucLeft <= 0) _aucLeft = AUC_WAIT_MAX;
        _scheduleAucWait();
      } else {
        _stopAucWait();                     // 已就绪 / 已收盘 / 历史日 ⇒ 一次都不再等
      }
    } catch (e) {
      if (my !== _seq) return;
      meta.value = Object.assign(_emptyMeta(asOf), {
        total: names.length,
        error: (e && e.message) || String(e)
      });
      _dbgLog('[ABN-DEV] ' + asOf + ' 计算失败：' + ((e && e.message) || e));
    }
  }

  /**
   * 面板行（市场前十 / 买点票）—— 按传入顺序出，判不出的票【仍然出行但数值为 —】，
   * ⛔ 不隐藏（§10：缺数据必须看得见，不能当成「没有异动」悄悄消失）。
   *
   * @param {string[]} names 有序票名
   * @returns {Array<{name:string, indexLabelText:string, indexLabelTitle:string,
   *   triggerText:string, triggerTone:string, triggerTitle:string, triggerCount:number,
   *   dev10Text:string, dev30Text:string} &
   *   {gapText:string, calcText:string, needValueText:string, needHintText:string,
   *    needTone:string, gapTailText:string, indexMoveText:string, stageText:string,
   *    stage:number|string, tone:string, ok:boolean, title:string}>}
   */
  function rowsFor(names) {
    const out = [];
    const m = devMap.value;
    (names || []).forEach(function (raw) {
      const name = String(raw || '').trim();
      if (!name) return;
      const f = (m instanceof Map) ? m.get(name) : null;
      const needText = f && f.ok ? (f.needValueText || '') : '';
      // 🔴 [ABN-CHECK 2026-11-14] 表格列必须与徽标/自核用【同一个已取整的数】：
      //   真实库九阳 11-13 dev30=199.9592，固定 1 位会印成 +200.0%（看着像已越线），
      //   而徽标是 +199.96% ⇒ 三个地方打架。统一走 deviationCellTexts。
      const cells = (f && f.ok) ? deviationCellTexts(f) : null;
      const idxLabel = f ? deviationIndexLabel(f) : { text: '', title: '' };
      out.push({
        name: name,
        ok: !!(f && f.ok === true),
        // ★ [IDX-LABEL] 票名后那枚「对应指数」小标签：每行各自那一个，判不出 ⇒ 空串（§10）
        indexLabelText: idxLabel.text,
        indexLabelTitle: idxLabel.title,
        // ★★ [ABN-TRIGGER 2026-11-15 用户口径] 「首次触发 / 二次触发 / 三次触发」——
        //   用户原话：「给已达到交易所严重异常波动标准的股票，打上标签……这样我就知道它是第几次，
        //   这样我好采取不同策略」。⇒ 双闸门都满足才渲染：
        //     ① `stage === DEV_STAGE_SEVERE`（今天真的已达标准 —— 用户要的就是这批票）；
        //     ② `triggerOrdinal > 0`（历史复算也认为今天是触发日）。
        //   任一不满足 ⇒ 空串（⛔ 绝不写「首次」占位：那是最危险的假结论，§10）。
        triggerText: (f && f.ok && f.stage === DEV_STAGE_SEVERE && f.triggerOrdinal > 0)
          ? (f.triggerText || '') : '',
        triggerTone: (f && f.ok && f.stage === DEV_STAGE_SEVERE && f.triggerOrdinal > 0)
          ? (f.triggerTone || '') : '',
        triggerTitle: (f && f.ok && f.trigger) ? (f.triggerTitle || '') : '',
        // 累计触发过一次以上的票（哪怕今天不是触发日）也要能看出来 ⇒ 悬停有据可查
        triggerCount: (f && f.ok && f.trigger) ? (f.triggerCount || 0) : 0,
        dev10Text: cells ? cells.dev10Text : '—',
        dev30Text: cells ? cells.dev30Text : '—',
        gapText: f && f.ok ? (f.gapText || '') : '未就绪',
        // ★ [IDX-MOVE 2026-11-14 用户定的第二行顺序]
        //   主段「股价再涨约 +5.2%（同期指数不动 · 条件估算）」→ 灰字「自核…」→
        //   灰字「距 200% 差 14.5 点」→ 灰字「指数 ±1% ⇒ 需涨 …（β…）」。
        //   ⛔ 点差不再抢主位，但仍是能与徽标相加核对的那个数。
        needValueText: needText,
        // ★ [DEV-NEG-WARN 2026-11-24] 负向档（杀跌）是「股价再跌约」，⛔ 不许印成「再涨」
        needLabel: (f && f.ok && f.needDir === '跌') ? '跌' : '涨',
        needHintText: needText ? DEV_NEED_HINT : '',
        needTone: (f && f.ok && f.needAlert) ? 'alert' : '',   // 接近警示 ⇒ 数值标红（§21 判据在 Logic）
        calcText: f && f.ok ? (f.calcText || '') : '',
        gapTailText: needText ? (f.gapShort || '') : '',
        indexMoveText: f && f.ok ? (f.indexMoveText || '') : '',
        stage: f && f.ok ? f.stage : '',
        stageText: f && f.ok ? (f.stageText || '') : '',
        tone: _toneOf(f),
        need10: f && f.ok ? f.need10 : null,
        need30: f && f.ok ? f.need30 : null,
        // ★ [ABN-DEV-UNIT 2026-11-14] 悬停给【完整说明】：两张偏离值 + 指数同期 + 距红线 +
        //   「自核：30 日偏离 = 个股区间涨幅 − 指数区间涨幅；股价每再涨 1%，偏离约增加 N 个点」+ 口径。
        //   用户就是靠这一句自己验「差 14.5 个点为什么只值 +5.2%」，⛔ 别只给一行摘要。
        title: f && f.ok ? deviationDetailLine(f) : '偏离值未就绪（指数腿或逐日腿缺）'
      });
    });
    return out;
  }

  return {
    devMap: devMap, meta: meta, basis: basis,
    load: load, rowsFor: rowsFor, setBasis: setBasis, toggleBasis: toggleBasis, clear: clear
  };
}
