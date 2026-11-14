// abnormal-deviation.js — 【官方「收盘价格涨跌幅偏离值」】的唯一计算实现（Logic 层纯函数，§15 可单测）
//
// ══════════════════════════════════════════════════════════════════════════════════════
// 【为什么必须换算法（2026-11-14 用户原话）】
// ══════════════════════════════════════════════════════════════════════════════════════
//   「现在我自己计算的 20 日涨幅 100% 股票成异动不是很准确，它要计算和大盘指数的偏值，
//     才可以算出官方异动」「本来异动之后，这只股票就会被监管，然后停牌，但是 10 月它涨到
//     135% 都没事，说明我说的 100% 不够准确」
//
//   实测（.tmpdiag/_abn-official-dev.mjs，2026-11-14）：
//     新华传媒 600825 十日【原始涨幅】10-08 就 >100%，之后一路上到 135%+ 却照涨不误；
//     而官方 `abnormal-monitor-list` 记的严重异动 start_date 是 10-09。
//     ⇒ 「原始涨幅 ≥100%」既会误报，也会漏报。真正的官方尺子是【偏离值】。
//
// ── 官方条文（沪深《交易规则》2026 修订版 5.4.2 / 5.4.3，逐字）─────────────────────
//   收盘价格涨跌幅偏离值累计值 =
//     (单只证券期末收盘价 / 期初前收盘价 − 1) × 100%
//   − (对应指数期末收盘点数 / 期初前收盘点数 − 1) × 100%
//   如期间内证券发生过除权除息，则对收盘价格做相应调整。
//
//   三个要害（⛔ 少一个就是错，而且错得很隐蔽）：
//     ① 是【区间累计涨跌幅之差】，不是「逐日偏离相加」——
//        实测 9 个官方案例：累加式 4 只判「未触发」（系统性低估），复利式 6/6 命中。
//     ② 期初 = 窗口第一天【之前】那一日的前收盘（10 日窗口 = 倒数第 11 根腿的收盘）。
//     ③ 必须扣【对应指数】，而且「对应指数」不是上证/深证成指/创业板指（见 DEV_INDEX 表）。
//
// ── 阈值阶梯（沪深主板 / 创业板·科创板）──────────────────────────────────────────
//     异常波动：连续 3 日偏离累计            ±20%（ST ±12%）  |  ±30%
//     严重异动①：10 日内同向异动次数        4 次              |  3 次     ← 需历史名单，本次不做
//     严重异动②：连续 10 日偏离累计          +100%（−50%）    |  同
//     严重异动③：连续 30 日偏离累计          +200%（−70%）    |  同
//   ⚠️ 重置：「异常/严重异常波动指标自交易所公布的次一交易日或复牌之日起重新计算」
//      ⇒ 公布即清零，重叠窗口不重复计数。本模块只算【连续窗口】，⛔ 不假装处理了重置。
//   ⚠️ 严重异动 ≠ 停牌：官方原文是「应当于次一交易日披露核查公告；无法披露的，才申请停牌」。
//      新华传媒 10-09 就进监控、交完公告继续涨，就是这条。
//
// ── 数据来源（§5 只读原料，本模块不认识数据库）─────────────────────────────────
//   · stockLegs / indexLegs = [{ date:'YYYY-MM-DD', pct:number|'+3.21' }] 升序【逐日涨幅腿】
//     —— 用逐日腿而不是收盘价序列，是因为库里的原料就是腿（`stock_daily_pct`），
//        且复利连乘 = 官方公式的 期末/期初，两者数学等价（前复权口径）。
//   · ⛔ 本模块绝不取数、绝不落库、绝不发请求。
//
// ── §10 红线 ────────────────────────────────────────────────────────────────────
//   · 指数缺腿 ⇒ null（判不出），⛔ 绝不拿「其他指数」或「0」顶替；
//   · 个股中间缺腿 ⇒ 按 0 计入（停牌前收盘不变，数学上正确）**但必须记账** `missingLegs`，
//     上屏文案要如实写出「含 N 日停牌/缺腿」—— 缺数据 ≠ 0%（§10）；
//   · 个股末腿缺失 ⇒ null（那一日没交易，判不了这个窗口）；
//   · 北交所（4/8/92）⇒ board='' ⇒ null（官方口径不同，§40 不猜）。
// ══════════════════════════════════════════════════════════════════════════════════════

import { numOfText } from '../util/num-text.js';

// ────────────────────────────────────────────────────────────────────────────────
// ① 对应指数（⛔ 不是 000001/399001/399006 —— 这是本项目最容易踩错的一格）
// ────────────────────────────────────────────────────────────────────────────────
/**
 * 官方「对应指数」表。
 * 来源：沪深交易所《交易规则》配套的《异常波动指标计算指引》里「对应指数」一栏。
 * ⛔ 上证综指(000001)/深证成指(399001)/创业板指(399006) **都不是**这一栏里的指数。
 */
export const DEV_INDEX = {
  // 沪市主板 A 股 → 上证A股指数
  shMain: { code: 'sh000002', name: '上证A股指数', board: 'main' },
  // 深市主板 A 股 → 深证A股指数
  szMain: { code: 'sz399107', name: '深证A股指数', board: 'main' },
  // 创业板 → 创业板综合指数（不是「创业板指 399006」）
  growth: { code: 'sz399102', name: '创业板综指', board: 'growth' },
  // 科创板 → 上证科创板50成份指数
  star: { code: 'sh000688', name: '科创50', board: 'star' }
};

/** 所有需要采集的指数代码（Worker 收盘写腿 / 前端兜底拉取共用，§6 单一清单） */
export const DEV_INDEX_CODES = [
  DEV_INDEX.shMain.code, DEV_INDEX.szMain.code, DEV_INDEX.growth.code, DEV_INDEX.star.code
];

/** 指数代码 → 中文名（上屏用；查不到就原样返回，⛔ 不编名字） */
export function devIndexName(code) {
  const c = String(code || '').trim();
  const keys = Object.keys(DEV_INDEX);
  for (let i = 0; i < keys.length; i++) {
    if (DEV_INDEX[keys[i]].code === c) return DEV_INDEX[keys[i]].name;
  }
  return c;
}

// ────────────────────────────────────────────────────────────────────────────────
// ② 阈值阶梯
// ────────────────────────────────────────────────────────────────────────────────
/**
 * 每个板块的阈值。
 *   dev3   = 连续 3 日偏离累计（「异常波动」，最早触发、也最容易被忽略的一档）
 *   dev10  = 连续 10 日偏离累计（「严重异常波动」正方向）
 *   dev30  = 连续 30 日偏离累计
 *   neg10 / neg30 = 负方向（官方同时管杀跌）
 *   times10 = 10 日内同向异动次数（主板 4 / 创业科创 3）—— 需要官方历史名单，本模块只带出常量
 */
export const DEV_THRESHOLDS = {
  main: { dev3: 20, dev10: 100, dev30: 200, neg10: -50, neg30: -70, times10: 4 },
  growth: { dev3: 30, dev10: 100, dev30: 200, neg10: -50, neg30: -70, times10: 3 },
  star: { dev3: 30, dev10: 100, dev30: 200, neg10: -50, neg30: -70, times10: 3 }
};

/** 「接近」系数：dev10 ≥ 90 / dev30 ≥ 180 就进预警带（= 官方红线的 90%） */
export const DEV_NEAR_RATIO = 0.9;
/** 「留意」系数：dev10 ≥ 70 / dev30 ≥ 140（只用于榜单单行提示，不吓人） */
export const DEV_WATCH_RATIO = 0.7;

/** 档位（严重度递增）。⛔ 顺序是判据的一部分，别调换。 */
export const DEV_STAGE_UNKNOWN = 'unknown';
export const DEV_STAGE_OK = 'ok';
export const DEV_STAGE_WATCH = 'watch';
export const DEV_STAGE_NEAR = 'near';
export const DEV_STAGE_SEVERE = 'severe';

const _STAGE_RANK = {
  [DEV_STAGE_UNKNOWN]: 0,
  [DEV_STAGE_OK]: 1,
  [DEV_STAGE_WATCH]: 2,
  [DEV_STAGE_NEAR]: 3,
  [DEV_STAGE_SEVERE]: 4
};

/**
 * 【纯函数】6 位代码 → 官方「对应指数」。
 * @param {string} code '600825' / '002242' / '301313' / '688137'
 * @returns {{code:string, name:string, board:string}|null} 北交所 / 非法代码 ⇒ null（§40 不猜）
 */
export function pickBaseIndexForCode(code) {
  const c = String(code || '').trim();
  if (!/^\d{6}$/.test(c)) return null;
  if (/^68/.test(c)) return DEV_INDEX.star;      // 688/689 科创板
  if (/^30/.test(c)) return DEV_INDEX.growth;    // 300/301 创业板
  if (/^6/.test(c)) return DEV_INDEX.shMain;     // 60x 沪主板
  if (/^0/.test(c)) return DEV_INDEX.szMain;     // 000/001/002/003 深主板
  return null;                                    // 43/83/87/88/92 北交所 ⇒ 官方口径不同
}

/** 板块 key → 阈值；板块判不出 ⇒ null（§10） */
export function thresholdsForBoard(board) {
  const b = String(board || '').trim();
  return DEV_THRESHOLDS[b] || null;
}

// ────────────────────────────────────────────────────────────────────────────────
// ③ 官方公式本体
// ────────────────────────────────────────────────────────────────────────────────
/** 腿数组 → Map<date, number|null>（pct 用 numOfText 解析，兼容 '+3.21' 这种 DB 文本） */
function _legMap(legs) {
  const m = new Map();
  (legs || []).forEach(function (x) {
    if (!x || !x.date) return;
    const d = String(x.date).slice(0, 10);
    const v = numOfText(x.pct);
    m.set(d, (v === null ? null : v));
  });
  return m;
}

/**
 * 【纯函数 · 官方公式】连续 n 个交易日的收盘价格涨跌幅偏离值累计值（单位 = %）。
 *
 * ★★ 这是整个模块的心脏，⛔ 三个要害一个都不能省：
 *   ① 复利连乘（区间累计涨跌幅之差），不是逐日偏离相加；
 *   ② 窗口 = 指数日历的最后 n 个交易日（指数不停牌，它才是交易日历的权威）；
 *      「期初前收盘」= 这 n 根腿之前那一根 ⇒ 正好等价于 ∏(1+pct) 而不是 ∏ 从第 1 根起；
 *   ③ 个股与指数【同一天对齐】扣减。
 *
 * @param {Array<{date:string,pct:number|string}>} stockLegs 升序逐日涨幅腿
 * @param {Array<{date:string,pct:number|string}>} indexLegs 升序逐日涨幅腿（对应指数）
 * @param {number} n 窗口交易日数（3 / 10 / 30）
 * @param {string} [asOf] 窗口末日（'YYYY-MM-DD'）。缺省 = 指数腿最后一天。
 *        ★ 复盘某个历史交易日时必须显式传 —— 否则永远算「最新那天」，历史回测全错。
 * @returns {{dev:number, stockChain:number, indexChain:number,
 *            from:string, to:string, missingLegs:number}|null}
 *          dev = 偏离值（%）；stockChain/indexChain = 同期区间涨幅（%）。
 *          判不出 ⇒ null（⛔ 不补 0、不换指数）。
 */
export function cumulativeDeviation(stockLegs, indexLegs, n, asOf) {
  const k = Math.floor(Number(n));
  if (!(k > 0)) return null;
  const s = _legMap(stockLegs);
  const ix = _legMap(indexLegs);
  if (ix.size === 0) return null;                       // 指数一股都没有 ⇒ 判不出
  const cutoff = asOf ? String(asOf).slice(0, 10) : '';
  let dates = Array.from(ix.keys()).sort();
  if (cutoff) dates = dates.filter(function (d) { return d <= cutoff; });
  if (dates.length < k) return null;                    // 指数腿不够一整个窗口
  const win = dates.slice(dates.length - k);
  const lastDate = win[win.length - 1];
  if (!s.has(lastDate) || s.get(lastDate) === null) return null;  // 末腿没有 ⇒ 这个窗口判不了

  let cs = 1;
  let ci = 1;
  let missing = 0;
  for (let i = 0; i < win.length; i++) {
    const d = win[i];
    const iv = ix.get(d);
    if (iv === null || iv === undefined) return null;   // 指数缺腿 ⇒ 判不出（⛔ 不补 0）
    let sv = s.has(d) ? s.get(d) : null;
    if (sv === null) { missing++; sv = 0; }            // 个股缺腿 = 当日无成交（停牌）⇒ 按 0，但记账
    cs *= 1 + sv / 100;
    ci *= 1 + iv / 100;
  }
  const dev = (cs - ci) * 100;
  if (!isFinite(dev)) return null;
  return {
    dev: dev,
    stockChain: (cs - 1) * 100,
    indexChain: (ci - 1) * 100,
    from: win[0],
    to: lastDate,
    missingLegs: missing
  };
}

/**
 * 【纯函数】指数不动假设下，个股还要涨多少（%）才能把偏离值顶到 thr。
 *
 * 推导：(1+S)(1+r) / (1+I) = 1 + thr/100  ⇒  r = (1 + I + thr/100) / (1 + S) − 1
 *   其中 S = 个股区间涨幅（小数）、I = 指数区间涨幅（小数）、thr = 偏离阈值（百分点）。
 *   ★ 用户 11-13 那句「九阳股份 30 日偏离 199.9 ⇒ 周一只要不跌就构成严重异常波动」，
 *     就是这条公式在 thr=200 时算出 r ≈ +0.05% 的结果。
 *
 * @param {number|null} stockChain 个股区间涨幅（%）
 * @param {number|null} indexChain 指数区间涨幅（%）
 * @param {number|null} thr 偏离阈值（百分点，如 100 / 200）
 * @returns {number|null} 还需涨幅（%）；已越线 ⇒ ≤ 0；判不出 ⇒ null
 */
export function needGainToThreshold(stockChain, indexChain, thr) {
  const S = numOfText(stockChain);
  const I = numOfText(indexChain);
  const T = numOfText(thr);
  if (S === null || I === null || T === null) return null;
  const base = 1 + S / 100;
  if (!(base > 0)) return null;                          // 个股区间跌幅 ≥ 100% ⇒ 数据异常，判不出
  const g = (1 + I / 100 + T / 100) / base - 1;
  if (!isFinite(g)) return null;
  return g * 100;
}

// ────────────────────────────────────────────────────────────────────────────────
// ④ 分级
// ────────────────────────────────────────────────────────────────────────────────
function _pickStage(hits) {
  let st = DEV_STAGE_OK;
  hits.forEach(function (h) {
    if (_STAGE_RANK[h.stage] > _STAGE_RANK[st]) st = h.stage;
  });
  return st;
}

/** 单条判据 → { code, label, thr, value, over, stage } */
function _hit(code, label, thr, value, stageWhenOver) {
  const v = numOfText(value);
  const t = numOfText(thr);
  if (v === null || t === null) return null;
  const over = t >= 0 ? v >= t : v <= t;                 // 负阈值（−50/−70）方向相反
  return { code: code, label: label, thr: t, value: v, over: over, stage: over ? stageWhenOver : '' };
}

/**
 * 【纯函数】把三档偏离值判成一个档位 + 一串命中项。
 *
 * @param {{board:string, dev3?:number|null, dev10?:number|null, dev30?:number|null}} o
 * @returns {{stage:string, stageText:string, hits:Array, hasSevere10:boolean, hasSevere30:boolean}}
 */
export function classifyDeviation(o) {
  const x = o || {};
  const th = thresholdsForBoard(x.board);
  const d3 = numOfText(x.dev3);
  const d10 = numOfText(x.dev10);
  const d30 = numOfText(x.dev30);
  if (!th || (d3 === null && d10 === null && d30 === null)) {
    return {
      stage: DEV_STAGE_UNKNOWN, stageText: '偏离值判不出', hits: [],
      hasSevere10: false, hasSevere30: false
    };
  }
  const hits = [];
  const push = function (h) { if (h) hits.push(h); };
  // 严重异动②：连续 10 日偏离 ≥ +100% / ≤ −50%
  push(_hit('D10', '10日偏离', th.dev10, d10, DEV_STAGE_SEVERE));
  push(_hit('N10', '10日偏离（跌）', th.neg10, d10, DEV_STAGE_SEVERE));
  // 严重异动③：连续 30 日偏离 ≥ +200% / ≤ −70%
  push(_hit('D30', '30日偏离', th.dev30, d30, DEV_STAGE_SEVERE));
  push(_hit('N30', '30日偏离（跌）', th.neg30, d30, DEV_STAGE_SEVERE));
  // 异常波动：连续 3 日偏离 ≥ ±dev3
  push(_hit('D3', '3日偏离', th.dev3, d3, DEV_STAGE_WATCH));
  push(_hit('N3', '3日偏离（跌）', -th.dev3, d3, DEV_STAGE_WATCH));

  // 预警带：没越线但已经很近 ⇒ near（必须在 over 之后判，否则 199.9 会被判 near）
  const hitCodes = new Set(hits.filter(function (h) { return h.over; }).map(function (h) { return h.code; }));
  let stage = _pickStage(hits);
  if (stage !== DEV_STAGE_SEVERE) {
    const near10 = d10 !== null && d10 >= th.dev10 * DEV_NEAR_RATIO && !hitCodes.has('D10');
    const near30 = d30 !== null && d30 >= th.dev30 * DEV_NEAR_RATIO && !hitCodes.has('D30');
    if (near10 || near30) stage = DEV_STAGE_NEAR;
    else if (stage !== DEV_STAGE_WATCH) {
      const watch10 = d10 !== null && d10 >= th.dev10 * DEV_WATCH_RATIO;
      const watch30 = d30 !== null && d30 >= th.dev30 * DEV_WATCH_RATIO;
      if (watch10 || watch30) stage = DEV_STAGE_WATCH;
    }
  }

  const hasSevere10 = hitCodes.has('D10') || hitCodes.has('N10');
  const hasSevere30 = hitCodes.has('D30') || hitCodes.has('N30');
  return {
    stage: stage,
    stageText: STAGE_TEXT[stage] || '',
    hits: hits.filter(function (h) { return h.over; }),
    hasSevere10: hasSevere10,
    hasSevere30: hasSevere30
  };
}

/** 档位中文（§21：文案在 Logic 层拼好，模板零计算） */
export const STAGE_TEXT = {
  [DEV_STAGE_UNKNOWN]: '偏离值判不出',
  [DEV_STAGE_OK]: '正常',
  [DEV_STAGE_WATCH]: '偏离放大（留意）',
  [DEV_STAGE_NEAR]: '逼近交易所偏离红线',
  [DEV_STAGE_SEVERE]: '已达交易所严重异常波动标准'
};

/** 档位 → 色调标记（模板只读这个字符串，⛔ 不在模板里判数字） */
export const STAGE_TONE = {
  [DEV_STAGE_UNKNOWN]: 'muted',
  [DEV_STAGE_OK]: 'normal',
  [DEV_STAGE_WATCH]: 'watch',
  [DEV_STAGE_NEAR]: 'near',
  [DEV_STAGE_SEVERE]: 'severe'
};

// ────────────────────────────────────────────────────────────────────────────────
// ⑤ 上屏文案
// ────────────────────────────────────────────────────────────────────────────────
/** 偏离值 → 文本：'+72.7%' / '—'（⛔ 判不出就写 —，不写 0.0%） */
export function devText(v) {
  const n = numOfText(v);
  if (n === null) return '—';
  return (n >= 0 ? '+' : '') + n.toFixed(1) + '%';
}

/** 还需涨幅 → 文本：'还需 +16%' / '已越线' / '—' */
export function needText(n) {
  const v = numOfText(n);
  if (v === null) return '—';
  if (v <= 0) return '已越线';
  return '还需 +' + (v >= 10 ? Math.round(v) : v.toFixed(1)) + '%';
}

/**
 * 【纯函数】偏离值 → 一行可渲染的事实（买点行徽标 / 榜单行 / 说明区共用同一份）。
 *
 * @param {object} o
 * @param {string} o.code 6 位代码
 * @param {Array}  o.stockLegs 升序逐日腿 [{date,pct}]
 * @param {Array}  o.indexLegs 对应指数升序逐日腿
 * @param {'close'|'auction'} [o.basis='close'] 末腿口径（只用于文案，⛔ 不参与计算）
 * @param {string} [o.asOf] 窗口末日（复盘历史日必须传，见 cumulativeDeviation）
 * @returns {object} 形状见返回值；判不出 ⇒ { ok:false, ... } 且 dev10/dev30 全 null（§10）
 */
export function computeDeviation(o) {
  const x = o || {};
  const code = String(x.code || '').trim();
  const idx = pickBaseIndexForCode(code);
  // ⚠️ 必须是【函数】而不是共享常量对象：`hits: []` 是引用，共享会被下游 push 污染（跨股票串味）。
  const makeEmpty = function () { return {
    ok: false,
    code: code,
    board: idx ? idx.board : '',
    indexCode: idx ? idx.code : '',
    indexName: idx ? idx.name : '',
    basis: x.basis || 'close',
    dev3: null, dev10: null, dev30: null,
    stockChain3: null, stockChain10: null, stockChain30: null,
    indexChain3: null, indexChain10: null, indexChain30: null,
    thr3: null, thr10: null, thr30: null,
    gap10: null, gap30: null,
    need10: null, need30: null,
    stage: DEV_STAGE_UNKNOWN,
    stageText: STAGE_TEXT[DEV_STAGE_UNKNOWN],
    tone: STAGE_TONE[DEV_STAGE_UNKNOWN],
    hits: [],
    missingLegs: 0,
    badge: '',
    gapText: '',
    line: ''
  }; };
  if (!idx) return makeEmpty();                          // 北交所 / 代码缺失 ⇒ 判不出

  const th = thresholdsForBoard(idx.board);
  const asOf = x.asOf || '';
  const d3 = cumulativeDeviation(x.stockLegs, x.indexLegs, 3, asOf);
  const d10 = cumulativeDeviation(x.stockLegs, x.indexLegs, 10, asOf);
  const d30 = cumulativeDeviation(x.stockLegs, x.indexLegs, 30, asOf);
  if (!d3 && !d10 && !d30) {
    return Object.assign(makeEmpty(), { thr3: th.dev3, thr10: th.dev10, thr30: th.dev30 });
  }

  const cls = classifyDeviation({
    board: idx.board,
    dev3: d3 ? d3.dev : null,
    dev10: d10 ? d10.dev : null,
    dev30: d30 ? d30.dev : null
  });

  const need10 = d10 ? needGainToThreshold(d10.stockChain, d10.indexChain, th.dev10) : null;
  const need30 = d30 ? needGainToThreshold(d30.stockChain, d30.indexChain, th.dev30) : null;
  const gap10 = (d10 && cls.hasSevere10 === false) ? Math.max(0, th.dev10 - d10.dev) : 0;
  const gap30 = (d30 && cls.hasSevere30 === false) ? Math.max(0, th.dev30 - d30.dev) : 0;

  const fact = Object.assign(makeEmpty(), {
    ok: true,
    thr3: th.dev3, thr10: th.dev10, thr30: th.dev30,
    dev3: d3 ? d3.dev : null,
    dev10: d10 ? d10.dev : null,
    dev30: d30 ? d30.dev : null,
    stockChain3: d3 ? d3.stockChain : null,
    stockChain10: d10 ? d10.stockChain : null,
    stockChain30: d30 ? d30.stockChain : null,
    indexChain3: d3 ? d3.indexChain : null,
    indexChain10: d10 ? d10.indexChain : null,
    indexChain30: d30 ? d30.indexChain : null,
    gap10: gap10,
    gap30: gap30,
    need10: need10,
    need30: need30,
    stage: cls.stage,
    stageText: cls.stageText,
    tone: STAGE_TONE[cls.stage] || 'muted',
    hits: cls.hits,
    missingLegs: Math.max(d3 ? d3.missingLegs : 0, d10 ? d10.missingLegs : 0, d30 ? d30.missingLegs : 0)
  });
  fact.badge = deviationBadge(fact);
  fact.gapText = deviationGapText(fact);
  fact.line = fact.badge + (fact.gapText ? ' · ' + fact.gapText : '');
  return fact;
}

/**
 * 【纯函数】徽标短文本 —— 挑「离红线最近的那一档」来说，⛔ 不说废话。
 *   已触发   ⇒ '30日偏离 +200.3%'
 *   逼近     ⇒ '10日偏离 +72.7%'
 *   正常     ⇒ '10日偏离 +48.8%'
 *   判不出   ⇒ ''（视图据此不渲染，⛔ 不写「—」占位）
 */
export function deviationBadge(fact) {
  const f = fact || {};
  if (!f.ok) return '';
  const d10 = numOfText(f.dev10);
  const d30 = numOfText(f.dev30);
  const t10 = numOfText(f.thr10);
  const t30 = numOfText(f.thr30);
  const r10 = (d10 !== null && t10) ? d10 / t10 : null;
  const r30 = (d30 !== null && t30) ? d30 / t30 : null;
  const use30 = (r30 !== null) && (r10 === null || r30 > r10);
  if (use30) return '30日偏离 ' + devText(d30);
  if (r10 !== null) return '10日偏离 ' + devText(d10);
  return '';
}

/**
 * 【纯函数】「还差多少」短文本。
 *   已触发     ⇒ '已触发严重异动'（⛔ 不写「还需 +0%」）
 *   逼近/正常  ⇒ '还需 +16%'  ← 用户 11-13 的表就是这个口径
 *   30 日那档更近 ⇒ '距 200% 仅 0.1 点'
 */
export function deviationGapText(fact) {
  const f = fact || {};
  if (!f.ok) return '';
  if (f.stage === DEV_STAGE_SEVERE) {
    const parts = [];
    if (f.hits && f.hits.length) {
      f.hits.forEach(function (h) { parts.push(h.label + ' ' + devText(h.value)); });
    }
    return parts.length ? '已触发（' + parts.join('、') + '）' : '已触发严重异动';
  }
  if (f.stage === DEV_STAGE_UNKNOWN) return '';
  const g30 = numOfText(f.gap30);
  const g10 = numOfText(f.gap10);
  const t30 = numOfText(f.thr30);
  const t10 = numOfText(f.thr10);
  // 30 日那档更近（差得不足 5 个点）⇒ 用「距 200% 仅 X 点」的说法，与用户原话一致
  if (g30 !== null && t30 !== null && g30 <= 5 && (g10 === null || g10 > 5)) {
    return '距 ' + t30 + '% 仅 ' + g30.toFixed(1) + ' 点';
  }
  const n10 = numOfText(f.need10);
  const n30 = numOfText(f.need30);
  // 两档都要涨才到 ⇒ 取「更近的那一档」的还需涨幅（哪个先到说哪个）
  const cands = [];
  if (n10 !== null && n10 > 0) cands.push(n10);
  if (n30 !== null && n30 > 0) cands.push(n30);
  if (cands.length === 0) {
    if (g10 !== null && g10 > 0 && t10 !== null) return '距 ' + t10 + '% 还差 ' + g10.toFixed(1) + ' 点';
    return '';
  }
  const best = Math.min.apply(null, cands);
  return needText(best);
}

/**
 * 【纯函数】说明区用的一整行（含指数名与停牌提示，§10 如实交代口径）。
 * 例：'10日偏离 +72.7%（闽发铝业 vs 深证A股指数 +5.1%，还需 +16%）；30日偏离 +48.4%'
 */
export function deviationDetailLine(fact) {
  const f = fact || {};
  if (!f.ok) {
    if (!f.code) return '';
    return '偏离值：' + (f.board ? '数据未就绪' : '北交所/代码不全 ⇒ 官方不吃这套口径，不计算');
  }
  const parts = [];
  parts.push('10日偏离 ' + devText(f.dev10) +
    '（' + (f.indexName || f.indexCode) + ' 同期 ' + devText(f.indexChain10) + '，' +
    (f.gapText || '—') + '）');
  parts.push('30日偏离 ' + devText(f.dev30) +
    '（' + (f.indexName || f.indexCode) + ' 同期 ' + devText(f.indexChain30) + '）');
  let s = parts.join('；');
  if (f.missingLegs > 0) {
    s += '；⚠️ 窗口内有 ' + f.missingLegs + ' 个交易日无成交腿（停牌/未采集），已按 0 计入';
  }
  if (f.basis === 'auction') {
    s += '；口径：截至今日 9:25 竞价（今日指数按不动计）';
  } else {
    s += '；口径：截至最近一个收盘日';
  }
  return s;
}

/**
 * 【纯函数】第三十四条用：这只票的偏离值是否已触发【官方严重异常波动】。
 * ⚠️ 与 `abnormal-10d.js#isOverRange10Cap`（自定义 97% 原始涨幅上限）是**两把不同的尺子**：
 *   · 本函数 = 官方口径，只认 10 日 / 30 日偏离；
 *   · isOverRange10Cap = 项目自定义的保守兜底，认十日原始涨幅。
 *   ⛔ 不许把两者混成一个布尔——口径混用是这类事故里最难查的一类。
 */
export function isDeviationSevere(fact) {
  return !!(fact && fact.ok && fact.stage === DEV_STAGE_SEVERE);
}

/** 【纯函数】档位是否进「预警带」（near / severe）—— 上屏才需要提醒的那批 */
export function isDeviationAlert(fact) {
  return !!(fact && fact.ok &&
    (fact.stage === DEV_STAGE_NEAR || fact.stage === DEV_STAGE_SEVERE));
}

/**
 * 【纯函数】批量算一批票的偏离值 —— 买点侧 / 前十榜的唯一入口（§6 一份实现）。
 *
 * @param {object} o
 * @param {string[]} o.names 要算的票名
 * @param {Map<string, Map<string, number|string>>} o.dailyByStock
 *        `stock_daily_pct` 的读回形态：票名 → { 交易日 → 当日涨幅 }
 * @param {Map<string, Array<{date:string,pct:number}>>} o.indexLegs 指数代码 → 升序腿
 * @param {function(string):string} o.codeOf 票名 → 6 位代码（取名册，⛔ 不猜）
 * @param {string} o.asOf 窗口末日（YYYY-MM-DD）
 * @param {function(string):(number|string|null)} [o.todayPctOf]
 *        末腿替换：竞价时点用「今日竞价涨幅」顶替当日收盘腿（收盘后不传）
 * @param {'close'|'auction'} [o.basis='close']
 * @returns {{ map: Map<string, object>, ready: number, total: number }}
 *          map = 票名 → computeDeviation 的 fact（判不出也有 fact，ok=false）
 */
export function buildDeviationMap(o) {
  const x = o || {};
  const names = Array.isArray(x.names) ? x.names : [];
  const daily = x.dailyByStock;
  const idxMap = x.indexLegs;
  const codeOf = typeof x.codeOf === 'function' ? x.codeOf : function () { return ''; };
  const todayPctOf = typeof x.todayPctOf === 'function' ? x.todayPctOf : null;
  const asOf = String(x.asOf || '').slice(0, 10);
  const out = new Map();
  let ready = 0;

  names.forEach(function (rawName) {
    const name = String(rawName || '').trim();
    if (!name) return;
    const code = String(codeOf(name) || '').trim();
    // 个股腿：Map<date, pct> → 升序数组；竞价时点用今日竞价涨幅顶替末腿
    const dayMap = (daily && typeof daily.get === 'function') ? daily.get(name) : null;
    const stockLegs = [];
    if (dayMap && typeof dayMap.forEach === 'function') {
      dayMap.forEach(function (pct, date) {
        const d = String(date || '').slice(0, 10);
        if (!d) return;
        if (asOf && d > asOf) return;
        stockLegs.push({ date: d, pct: pct });
      });
    }
    stockLegs.sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); });
    if (todayPctOf && asOf) {
      const tp = numOfText(todayPctOf(name));
      if (tp !== null) {
        const hit = stockLegs.filter(function (l) { return l.date === asOf; })[0];
        if (hit) hit.pct = tp;
        else stockLegs.push({ date: asOf, pct: tp });
        stockLegs.sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); });
      }
    }
    const idxInfo = pickBaseIndexForCode(code);
    const iLegs = (idxInfo && idxMap && typeof idxMap.get === 'function')
      ? (idxMap.get(idxInfo.code) || [])
      : [];
    const fact = computeDeviation({
      code: code,
      stockLegs: stockLegs,
      indexLegs: iLegs,
      asOf: asOf,
      basis: x.basis || 'close'
    });
    if (fact.ok) ready++;
    out.set(name, fact);
  });

  return { map: out, ready: ready, total: names.length };
}
