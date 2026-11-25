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

/**
 * ★ [IDX-LABEL 2026-11-14 用户原话]「对应指数同期涨幅，这个对应指数指的是什么？
 *   大盘指数？还是沪市指数，还是深市指数？你在股票名称后面标注下，顺便在提示板上面说明下」
 *
 *   答：是交易所《交易规则》异常波动指标里【按上市板块指定】的那一个，
 *   ⛔ 不是笼统的「大盘」，也⛔ 不是上证综指 000001 / 深证成指 399001 / 创业板指 399006。
 *   沪主板扣沪市的、深主板扣深市的，创业/科创扣各自板块的。
 *   ⇒ 说明文字放面板顶部（用户看得到），票名后放一枚短标签（每行各自那一个）。
 *   ⚠️ 文案必须来自 DEV_INDEX 这张表，⛔ 不许在视图里手写映射（§6 单一数据源）。
 */
export const DEV_INDEX_NOTE_LINES = [
  '「对应指数」= 交易所《交易规则》异常波动指标里【按上市板块指定】的那一个指数；' +
    '⛔ 不是笼统的「大盘指数」，也不是上证综指 000001 / 深证成指 399001 / 创业板指 399006。',
  '沪主板 60x → 上证A股指数 sh000002　｜　深主板 000/001/002/003 → 深证A股指数 sz399107',
  '创业板 300/301 → 创业板综指 sz399102　｜　科创板 688/689 → 科创50 sh000688　｜　北交所不计算',
  '偏离值 = 个股区间涨幅 − 该指数同期区间涨幅。票名后面的小标签就是本行用的那一个（悬停可看代码与板块）。'
];

/**
 * 【纯函数】票名后那枚「对应指数」小标签（§21 模板零计算）。
 * @returns {{text:string, title:string}} 判不出 ⇒ 两个空串（§10 ⛔ 不编指数名）
 */
export function deviationIndexLabel(fact) {
  const f = fact || {};
  const empty = { text: '', title: '' };
  const code = String(f.indexCode || '').trim();
  if (!code) return empty;                            // 代码都没有 ⇒ 判不出（§10 不编）
  // ⚠️ 即使 dev 值判不出（缺腿），只要代码在，【该用哪个指数】是确定的 ⇒ 照常标注。
  //   这正是用户要的「这行减的是谁」，⛔ 别因为数值未就绪就把口径也藏起来。
  const name = f.indexName || devIndexName(code);
  if (!name || name === code) return empty;           // 查不到中文名 ⇒ 原样返回的是代码，不编名字
  const pick = pickBaseIndexForCode(f.code);
  const boardText = { main: '主板', growth: '创业板', star: '科创板' }[pick && pick.board] || '';
  const market = /^sh/.test(code)
    ? '沪市'
    : (/^sz/.test(code) ? '深市' : '');
  return {
    text: name,
    title: '对应指数：' + name + '（' + code + '）· ' + market + boardText +
      '；按上市板块取，⛔ 不是上证综指/深证成指/创业板指。偏离值要减的就是它同期的区间涨幅'
  };
}

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

/**
 * 深市 ST / *ST 的三日阈值。
 * 来源：深交所《交易规则》5.4.3「ST 和 *ST 股票连续三个交易日内日收盘价涨跌幅偏离值累计达到 ±12%」。
 * ⚠️ 沪市 ST 的对应条款【未核实】⇒ 沪市 ST 仍按主板 20% 判（§40 不猜数字），详情里如实注明。
 * ⚠️ 严重异常波动那两档（10 日 +100%/−50%、30 日 +200%/−70%）官方【不区分 ST】⇒ 沿用 main。
 */
export const DEV_THRESHOLDS_SZ_ST = { dev3: 12, dev10: 100, dev30: 200, neg10: -50, neg30: -70, times10: 4 };

/** 【纯函数】票名是否 ST / *ST / 退市整理（深市三日阈值要降到 ±12%） */
export function isStName(name) {
  const s = String(name || '').replace(/\s/g, '').toUpperCase();
  return /^(S?\*?ST|退市)/.test(s);
}

/**
 * 【纯函数】按「板块 + 市场 + 是否 ST」取阈值（§6 一份实现）。
 * @param {string} board 'main' | 'growth' | 'star'
 * @param {string} [code] 6 位代码（用来区分沪深；深市 = 0 开头）
 * @param {string} [name] 票名（用来判 ST）
 */
export function thresholdsForStock(board, code, name) {
  const th = thresholdsForBoard(board);
  if (!th) return null;
  // 深市 ST/*ST 三日阈值 ±12%（沪市未核实 ⇒ 不动）
  if (isStName(name) && /^0/.test(String(code || '').trim())) return DEV_THRESHOLDS_SZ_ST;
  return th;
}

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
// ②-b 竞价口径 / 收盘口径（时点判据，纯函数 —— ⛔ 别把这段散落在 composable 里）
// ────────────────────────────────────────────────────────────────────────────────
/**
 * 收盘判定线（北京时区）。过了这条线，当天就应该用【收盘口径】重算。
 * 与 `jiwang-close-write.js#JW_CLOSE_HHMM` 同一口径（15:05 是给记忘留的抓取余量，这里只判口径）。
 */
export const DEV_CLOSE_HHMM = '15:00';

/**
 * 【纯函数】这一屏该用哪个口径。
 *
 * 🔴🔴 [DEV-BASIS 2026-11-24 用户原话第一轮]「我要求的是在竞价时间就可以知道它的偏离值看是否触发，
 *   所以用竞价口径，等到收盘，再覆盖下，再计算，这是原来我一直要求的。」
 * 🔴🔴 [DEV-BASIS-DEFAULT 2026-11-24 第二轮用户当场纠正]
 *   「我说默认打开时是竞价口径，现在怎么又是收盘口径，竞价口径要点一次才是变成竞价口径？
 *     我的意思是不用点竞价口径，默认是竞价口径，点开后才变成收盘口径。
 *     你应该把竞价口径 toggle 变成收盘口径，我想看收盘口径时点开就可以看了。」
 *   ⇒ **交易时间内的默认口径永远是 auction**，哪怕 9:25 竞价涨幅还没落库（那时面板显示「—」
 *     + 文案「竞价涨幅 09:25 抓取中，到货自动出数」，而不是退回昨天的收盘数）。
 *     「没数据」不许被翻译成「换个口径」—— 那是两种完全不同的语义（§10）。
 *
 * 判据（顺序即优先级，⛔ 别调换）：
 *   ① 不是今天（复盘历史日）⇒ close —— 历史日永远收盘腿（§11 稳定复盘）
 *   ② 今天的收盘腿已经入库 ⇒ close —— **收盘覆盖**：哪怕还在 15:00 前后，只要有真收盘涨幅就用它
 *   ③ 已过 15:00 但收盘腿还没入库（16:00 才写）⇒ close（此时窗口自然停在上一交易日，靠文案交代）
 *   ④ 其余（今天且 15:00 前）⇒ auction —— **默认口径，不看数据到没到**
 *      ⚠️ 数据没到 ⇒ `deviationBasisNote` 会如实写「09:25 抓取中」，并且 `[DEV-AUC-WAIT]`
 *         每 12 秒重读一次，到货当片切成真竞价口径。
 *
 * @param {{date:string, today:string, hhmm:string,
 *          auctionReady?:boolean, closeLegReady?:boolean}} o
 * @returns {'auction'|'close'}
 */
export function deviationBasisFor(o) {
  const x = o || {};
  const date = String(x.date || '').slice(0, 10);
  const today = String(x.today || '').slice(0, 10);
  if (!date || !today || date !== today) return 'close';
  if (x.closeLegReady === true) return 'close';
  if (String(x.hhmm || '') >= DEV_CLOSE_HHMM) return 'close';
  return 'auction';                      // ★ [DEV-BASIS-DEFAULT] 交易时间内默认就是竞价口径
}

/**
 * 【纯函数】口径说明句（面板 `meta.warnText` / 悬停用）。
 * §10：口径与事实不符是最坏的一种错 —— 所以这里必须如实写「现在算到哪一天 / 数据到没到」。
 *
 * @param {{basis:string, asOf:string, today:string, hhmm:string,
 *          auctionReady?:boolean, closeLegReady?:boolean}} o
 * @returns {string} 无需提示 ⇒ ''
 */
export function deviationBasisNote(o) {
  const x = o || {};
  const asOf = String(x.asOf || '').slice(0, 10);
  const today = String(x.today || '').slice(0, 10);
  if (x.basis === 'auction') {
    // ★ [DEV-BASIS-DEFAULT] 默认口径 = 竞价；但「数据还没到」必须说清楚，⛔ 不许含糊成「就是竞价数」
    if (x.auctionReady !== true) {
      return '竞价口径（默认）：今日 9:25 竞价涨幅还没落库（09:25 抓取中）⇒ 这一屏暂时是「—」，' +
        '到货自动出数（不是「没有异动」）；收盘后自动改为收盘口径。';
    }
    return '竞价口径（默认）：今日个股用 9:25 竞价涨幅、对应指数按不动计；收盘后自动改为收盘口径。';
  }
  if (!asOf || !today || asOf !== today) return '';
  if (x.closeLegReady === true) return '收盘口径：今日收盘腿已入库，已按收盘涨幅重算。';
  if (String(x.hhmm || '') >= DEV_CLOSE_HHMM) {
    return '⚠️ 今日收盘腿尚未入库（16:00 后生成）⇒ 当前显示的是【截至上一交易日收盘】的偏离值，稍后自动刷新。';
  }
  return '';
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
 * 【内部纯函数 · 窗口核心】在【已建好、已按 asOf 过滤并排序】的日期表上取一段窗口。
 *
 * ⛔ 这是 `cumulativeDeviation` 的唯一实现体。抽出来只为让 [ABN-TRIGGER] 的逐日复算
 *    不必每天重建两次 `_legMap`（O(N) → O(窗口)），**语义与原来逐字一致**。
 *
 * @param {Map<string, number|null>} s 个股腿 Map
 * @param {Map<string, number|null>} ix 指数腿 Map
 * @param {number} k 窗口交易日数
 * @param {string[]} dates 已排序、已按 asOf 过滤的指数交易日数组
 * @param {number} endIdx 窗口末日在该数组中的下标
 */
function _deviationCore(s, ix, k, dates, endIdx) {
  if (!(k > 0)) return null;
  if (!ix || ix.size === 0) return null;
  const end = (endIdx === undefined || endIdx === null) ? dates.length - 1 : endIdx;
  if (!(end >= 0) || end + 1 < k) return null;          // 指数腿不够一整个窗口
  const win = dates.slice(end + 1 - k, end + 1);
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
  return _deviationCore(s, ix, k, dates, dates.length - 1);
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
 * 🔴 [DEV-NEG-WARN 2026-11-24] 用户要求「竞价时就知道会不会触发」之后复核出的缺陷：
 *   预警带（near / watch）原来只判【正向】（`d10 >= thr*0.9`）⇒ 一只 30 日跌 60.2%
 *   （距 −70% 只差 9.8 点）会被判成「正常」，而官方负向红线跟正向一样是要公告的。
 *   ⇒ 现在两个方向都判：正向比 dev10/dev30，负向比 neg10/neg30（−50 / −70）。
 *
 * @param {{board:string, code?:string, name?:string,
 *          dev3?:number|null, dev10?:number|null, dev30?:number|null}} o
 * @returns {{stage:string, stageText:string, hits:Array, hasSevere10:boolean, hasSevere30:boolean}}
 */
export function classifyDeviation(o) {
  const x = o || {};
  const th = thresholdsForStock(x.board, x.code, x.name);
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
  // 异常波动：连续 3 日偏离 ≥ ±dev3（ST 深市 ±12%，见 thresholdsForStock）
  push(_hit('D3', '3日偏离', th.dev3, d3, DEV_STAGE_WATCH));
  push(_hit('N3', '3日偏离（跌）', -th.dev3, d3, DEV_STAGE_WATCH));

  // 预警带：没越线但已经很近 ⇒ near（必须在 over 之后判，否则 199.9 会被判 near）
  const hitCodes = new Set(hits.filter(function (h) { return h.over; }).map(function (h) { return h.code; }));
  let stage = _pickStage(hits);
  if (stage !== DEV_STAGE_SEVERE) {
    // ★ [DEV-NEG-WARN] 两个方向都判：正向比 dev10/dev30，负向比 neg10/neg30
    const near10 = d10 !== null &&
      (d10 >= th.dev10 * DEV_NEAR_RATIO || d10 <= th.neg10 * DEV_NEAR_RATIO) &&
      !hitCodes.has('D10') && !hitCodes.has('N10');
    const near30 = d30 !== null &&
      (d30 >= th.dev30 * DEV_NEAR_RATIO || d30 <= th.neg30 * DEV_NEAR_RATIO) &&
      !hitCodes.has('D30') && !hitCodes.has('N30');
    if (near10 || near30) stage = DEV_STAGE_NEAR;
    else if (stage !== DEV_STAGE_WATCH) {
      const watch10 = d10 !== null &&
        (d10 >= th.dev10 * DEV_WATCH_RATIO || d10 <= th.neg10 * DEV_WATCH_RATIO);
      const watch30 = d30 !== null &&
        (d30 >= th.dev30 * DEV_WATCH_RATIO || d30 <= th.neg30 * DEV_WATCH_RATIO);
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

// ────────────────────────────────────────────────────────────────────────────────
// ④-b [ABN-TRIGGER 2026-11-15 用户口径] 严重异常波动的「第几次触发」
// ────────────────────────────────────────────────────────────────────────────────
// 用户原话：「你在官方偏离值那里（原版）给已达到交易所严重异常波动标准的股票，打上标签，
//   首次触发，二次触发，三次触发等字样，这样我就知道它是第几次，这样我好采取不同策略」
//
// ── 口径（必须写清楚，因为它不是交易所原文里的一个字段）─────────────────────────
//   · 「触发日」= 该交易日【收盘后】这只票的 10 日偏离或 30 日偏离任一向越线
//     （10 日 ≥ +100% 或 ≤ −50%；30 日 ≥ +200% 或 ≤ −70%；板块阈值见 DEV_THRESHOLDS）；
//   · 「第 N 次」= asOf 当天是连续第几个触发日 ⇒ **逐日递增，不是按事件合并**。
//     🔴🔴 [ABN-TRIGGER-2 2026-11-16 用户当场纠正] 旧实现把「连续的触发日合并成一次」，
//        于是 10-08 / 10-09 / 10-12（新华传媒连续 3 天越线）**三天全印「首次触发」**。
//        用户原话：「10月8日新华传媒显示首次触发，10月9日显示也是首次触发，明显不对
//        你的代码有问题……要精准啊，不要瞎改」。
//        ⇒ 「第几次」只能有一个读法：第几个触发日。10-08 首次 / 10-09 二次 / 10-12 三次。
//   · 断开条件：某一天**明确判出「未触发」**才归零（下次再从「首次」起）。
//     判不出 ≠ 未触发 ⇒ streak 保持不变（§10：不能证明它回落了）。
//   · 同时保留「累计几次独立触发」（断开计一次）：这是「被监管过几次」的信息，
//     进 title，⛔ 不上主标签（主标签一个数字就够，两个数字用户会看错）。
//   ⚠️ 官方原文：「异常/严重异常波动指标自交易所公布的次一交易日或复牌之日起重新计算」
//      ⇒ 交易所公布后窗口会重算，所以本函数的序号是【本项目复算值】，可能比官方更细。
//        这句话必须进 title，⛔ 不许让用户以为这是官方公布的次数。
//
// ── §10 红线 ────────────────────────────────────────────────────────────────────
//   · 指数腿 / 个股腿不足 ⇒ ok=false + reason，⛔ 绝不返回「首次」（那是最危险的假结论）；
//   · 某一天窗口算不出 ⇒ 跳过并计入 gapDays，**streak 与事件都保持不变**
//     （不能证明它回落了），但要在 title 里如实写出「有 N 天判不出」；
//   · asOf 当天判不出 / 未触发 ⇒ ordinal=0 ⇒ 不显示标签（⛔ 不拿上一次的序号冒充这次）。

/** 回看多少个交易日（更早的触发对「这次是第几次」没有意义，且指数腿未必覆盖） */
export const ABN_TRIGGER_LOOKBACK_DAYS = 60;

const _ORDINAL_CN = ['', '首次', '二次', '三次', '四次', '五次', '六次', '七次', '八次', '九次', '十次'];

/**
 * 【纯函数】触发序号 → 中文标签。
 *   1 ⇒ '首次触发'，2 ⇒ '二次触发'，…，10 ⇒ '十次触发'，11+ ⇒ '第 11 次触发'
 *   非法 / 0 ⇒ ''（视图据此不渲染，⛔ 不写占位）
 */
export function severeOrdinalText(n) {
  const k = Math.floor(Number(n));
  if (!(k > 0)) return '';
  const cn = (k <= 10) ? _ORDINAL_CN[k] : ('第 ' + k + ' 次');
  return cn + '触发';
}

/**
 * 【纯函数】统计「严重异常波动」的触发序号（逐日复算 + 连续天数）。
 *
 * @param {object} o
 * @param {string} o.code 6 位代码（决定板块阈值与对应指数，⛔ 不猜）
 * @param {Array<{date:string,pct:number|string}>} o.stockLegs 个股升序逐日腿
 *        ⚠️ 竞价时点调用方已把 asOf 那根换成竞价涨幅（`buildDeviationMap` 的 todayPctOf），
 *           本函数直接用 —— 这样「面板显示今天已触发」与「今天是第几次」不会互相打架。
 * @param {Array<{date:string,pct:number|string}>} o.indexLegs 对应指数升序逐日腿
 * @param {string} o.asOf 截至哪一天（含）
 * @param {number} [o.maxLookback] 最多回看多少个交易日（默认 ABN_TRIGGER_LOOKBACK_DAYS）
 * @returns {{ok:boolean, reason:string, count:number, ordinal:number,
 *            text:string, tone:string, events:Array, judgedDays:number, gapDays:number,
 *            from:string, to:string, lookback:number, title:string}}
 *          ok=false ⇒ 判不出（⛔ 不返回「首次」）；
 *          ordinal = asOf 当天是**连续第几个触发日**（1 = 首次），未触发/判不出 ⇒ 0；
 *          count  = 窗口内**独立触发次数**（断开计一次，只进 title，⛔ 不上主标签）。
 */
export function countSevereTriggers(o) {
  const x = o || {};
  const blank = function (reason) {
    return {
      ok: false, reason: reason || '',
      count: 0, ordinal: 0, text: '', tone: '',
      events: [], judgedDays: 0, gapDays: 0,
      from: '', to: '', lookback: 0, title: reason || ''
    };
  };
  const idx = pickBaseIndexForCode(x.code);
  if (!idx) return blank('北交所 / 代码不全 ⇒ 官方这套口径不适用，不计数');
  const th = thresholdsForStock(idx.board, x.code, x.name);
  if (!th) return blank('板块判不出 ⇒ 不计数');

  const sMap = _legMap(x.stockLegs);
  const ixMap = _legMap(x.indexLegs);
  if (ixMap.size === 0) return blank('对应指数腿未就绪 ⇒ 判不出第几次（不是「首次」）');
  if (sMap.size === 0) return blank('个股逐日腿未就绪 ⇒ 判不出第几次（不是「首次」）');

  const asOf = String(x.asOf || '').slice(0, 10);
  const allDates = Array.from(ixMap.keys()).sort().filter(function (d) {
    return !asOf || d <= asOf;
  });
  if (allDates.length === 0) return blank('截至 ' + (asOf || '该日') + ' 没有任何指数腿 ⇒ 判不出');

  const capRaw = Math.floor(Number(x.maxLookback));
  const cap = (isFinite(capRaw) && capRaw > 0) ? capRaw : ABN_TRIGGER_LOOKBACK_DAYS;
  const startIdx = Math.max(0, allDates.length - cap);

  const events = [];       // 独立事件（断开计一次），只用于 title
  let cur = null;
  let streak = 0;          // ★ 连续触发天数 = 本次事件内的第 N 天 ⇒ 主标签就用它
  let judged = 0;
  let gap = 0;
  let asOfStreak = 0;      // asOf【当天自己】是触发日时的 streak，否则 0

  for (let i = startIdx; i < allDates.length; i++) {
    const d = allDates[i];
    const isLast = (i === allDates.length - 1);
    const d10 = _deviationCore(sMap, ixMap, 10, allDates, i);
    const d30 = _deviationCore(sMap, ixMap, 30, allDates, i);
    const v10 = d10 ? d10.dev : null;
    const v30 = d30 ? d30.dev : null;
    if (v10 === null && v30 === null) {
      // §10：判不出 ≠ 未触发（不能证明它回落了）⇒ streak 与事件都【保持不变】；
      //     但 asOf 当天判不出 ⇒ 不许拿上一次的序号冒充（§10 红线）
      gap++;
      if (isLast) asOfStreak = 0;
      continue;
    }
    judged++;
    const severe = (v10 !== null && (v10 >= th.dev10 || v10 <= th.neg10)) ||
      (v30 !== null && (v30 >= th.dev30 || v30 <= th.neg30));
    if (severe) {
      streak++;                       // ★ 逐日递增：10-08=1、10-09=2、10-12=3
      if (!cur) {
        cur = { start: d, end: d, days: 1, peakDev10: v10, peakDev30: v30 };
        events.push(cur);
      } else {
        cur.end = d;
        cur.days++;
        if (v10 !== null && (cur.peakDev10 === null || v10 > cur.peakDev10)) cur.peakDev10 = v10;
        if (v30 !== null && (cur.peakDev30 === null || v30 > cur.peakDev30)) cur.peakDev30 = v30;
      }
      if (isLast) asOfStreak = streak;
    } else {
      streak = 0;                     // 明确判出「未触发」⇒ 归零，下次再从「首次」起
      cur = null;
      if (isLast) asOfStreak = 0;
    }
  }

  if (judged === 0) {
    return blank('指数腿不足一个完整窗口（10 日 / 30 日）⇒ 一天都判不出，不计数');
  }

  const lastDate = allDates[allDates.length - 1];
  // 🔴 asOf 必须【自己就是触发日】才算「本次是第几次」：
  //    · asOf 与最后一天不是同一天（当天没有指数腿）⇒ 0；
  //    · 当天判不出 / 未触发 ⇒ asOfStreak 已被置 0（⛔ 不沿用上一次的序号）
  const ordinal = (asOf && asOf === lastDate) ? asOfStreak : 0;
  const tone = ordinal === 0 ? '' : (ordinal === 1 ? 'first' : 'repeat');
  const from = allDates[startIdx];
  const lookback = allDates.length - startIdx;

  const fmt = function (v) {
    if (v === null || v === undefined) return '—';
    return (v >= 0 ? '+' : '') + Number(v).toFixed(1) + '%';
  };
  const parts = [];
  parts.push('「第几次触发」口径（本项目复算，⛔ 不是交易所公布的官方计数）：对近 ' + lookback +
    ' 个交易日【逐日复算】10 日 / 30 日偏离值，任一向越线（10 日 ≥ +' + th.dev10 + '% 或 ≤ ' +
    th.neg10 + '%；30 日 ≥ +' + th.dev30 + '% 或 ≤ ' + th.neg30 + '%）即算「当日触发」；' +
    '序号 = 这是连续第几个触发日（逐日递增），某天明确判出「未触发」才归零。');
  parts.push('官方原文：「异常/严重异常波动指标自交易所公布的次一交易日或复牌之日起重新计算」' +
    '⇒ 交易所公布后窗口会重算，所以这里的序号可能比官方实际公布次数更细。');
  // ★ [DEV-TIMES10 2026-11-24] 官方第①条判据（10 日内 4 次同向异动）本模块没算 —— 如实交代，
  //   ⛔ 别让用户以为「序号是 0」就等于「官方不会认定严重异动」。
  parts.push('⚠️ 官方判据①（连续 10 个交易日内 4 次同向异常波动，创业板/科创板 3 次）本面板未接入，' +
    '这里只按判据②③（10 日 / 30 日偏离）复算。');
  if (ordinal > 0) {
    parts.push('本次：连续第 ' + ordinal + ' 个触发日。');
  }
  if (events.length) {
    parts.push('近 ' + lookback + ' 个交易日内共 ' + events.length + ' 次独立触发（断开计一次）：' +
      events.map(function (e, i) {
        return '第 ' + (i + 1) + ' 段 ' + e.start + '~' + e.end + '（' + e.days + ' 个触发日，峰值 10 日 ' +
          fmt(e.peakDev10) + ' / 30 日 ' + fmt(e.peakDev30) + '）';
      }).join('；'));
  } else {
    parts.push('近 ' + judged + ' 个可判定交易日里【一次都没有】触发。');
  }
  if (gap > 0) {
    parts.push('⚠️ 其中 ' + gap + ' 个交易日因腿不足判不出（已跳过，⛔ 未当成「未触发」，' +
      '也不打断连续计数）');
  }
  parts.push('可判定 ' + judged + ' 天（指数腿覆盖 ' + from + ' → ' + lastDate + '）；对应指数 ' +
    idx.name + '（' + idx.code + '）');

  return {
    ok: true, reason: '',
    count: events.length,
    ordinal: ordinal,
    text: severeOrdinalText(ordinal),
    tone: tone,
    events: events,
    judgedDays: judged,
    gapDays: gap,
    from: from,
    to: lastDate,
    lookback: lookback,
    title: parts.join(' ')
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
 * 【纯函数】把「今天是竞价口径」这件事落成一根真实的指数腿（pct = 0）。
 *
 * 🔴🔴 [DEV-AUC-WIN 2026-11-24 用户原话]「我要求的是在竞价时间就可以知道它的偏离值看是否触发，
 *   所以用竞价口径，等到收盘，再覆盖下，再计算，这是原来我一直要求的。」
 *
 *   旧实现的死结：窗口锚在**指数腿**上，而指数没有集合竞价价 ⇒ 库里/接口里都没有「今天」那根腿
 *   ⇒ `cumulativeDeviation` 的窗口静默前移一天 ⇒ `todayPctOf` 注入的今日竞价涨幅落在窗口**外面**，
 *   被直接丢弃。表现为：9:25 显示的数与昨晚收盘一模一样，而文案却写「截至今日 9:25 竞价」。
 *   ⇒ 竞价口径下显式补一根 `{date: asOf, pct: 0}`（= 指数不动），窗口才真正含今天。
 *
 * ⚠️ `force=true`（竞价口径专用）时，即使 asOf 那天已有指数腿也**覆盖成 0** ——
 *    因为「9:25 那一刻」指数根本还没有价格，拿收盘/盘中涨幅去算就不是竞价口径了。
 *    ⛔ 只动 asOf 那一天，别的日期一律不碰（给历史日补 0 = 编造）。
 * @param {Array} indexLegs 指数逐日腿
 * @param {string} asOf 窗口末日
 * @param {number|string} [pct=0] 指数当日的假定涨幅（竞价时点 = 0）
 * @param {boolean} [force=false] 已存在也覆盖
 * @returns {Array} 新数组（不修改入参，§11）
 */
export function withIndexFlatLeg(indexLegs, asOf, pct, force) {
  const d = String(asOf || '').slice(0, 10);
  const src = Array.isArray(indexLegs) ? indexLegs : [];
  if (!d) return src.slice();
  const v = numOfText(pct);
  const flat = (v === null ? 0 : v);
  const has = src.some(function (x) { return x && String(x.date).slice(0, 10) === d; });
  if (has && force !== true) return src.slice();
  const a = src.filter(function (x) { return !(x && String(x.date).slice(0, 10) === d); });
  a.push({ date: d, pct: flat });
  a.sort(function (p, q) { return p.date < q.date ? -1 : (p.date > q.date ? 1 : 0); });
  return a;
}

/**
 * 【纯函数】偏离值 → 一行可渲染的事实（买点行徽标 / 榜单行 / 说明区共用同一份）。
 *
 * @param {object} o
 * @param {string} o.code 6 位代码
 * @param {string} [o.name] 票名（只用来判 ST：深市 ST/*ST 三日阈值 ±12%）
 * @param {Array}  o.stockLegs 升序逐日腿 [{date,pct}]
 * @param {Array}  o.indexLegs 对应指数升序逐日腿
 * @param {'close'|'auction'} [o.basis='close'] 末腿口径（只用于文案，⛔ 不参与计算）
 * @param {string} [o.asOf] 窗口末日（复盘历史日必须传，见 cumulativeDeviation）
 * @param {boolean} [o.indexTodayFlat=false] 竞价口径：指数缺 asOf 腿时补一根 pct=0（见 withIndexFlatLeg）
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
    thr3: null, thr10: null, thr30: null, thr10Neg: null, thr30Neg: null,
    gap10: null, gap30: null,
    need10: null, need30: null,
    stage: DEV_STAGE_UNKNOWN,
    stageText: STAGE_TEXT[DEV_STAGE_UNKNOWN],
    tone: STAGE_TONE[DEV_STAGE_UNKNOWN],
    hits: [],
    missingLegs: 0,
    badge: '',
    gapText: '',
    gapShort: '',
    calcText: '',
    needValueText: '',
    needDir: '涨',
    needAlert: false,
    indexBeta: null,
    indexMoveText: '',
    // ★ [ABN-TRIGGER 2026-11-15 用户口径] 「严重异常波动第几次触发」——
    //   缺省全空 / 0（⛔ 绝不写「首次」占位：那是最危险的假结论，§10）。
    trigger: null,
    triggerText: '',
    triggerTone: '',
    triggerTitle: '',
    triggerCount: 0,
    triggerOrdinal: 0,
    line: ''
  }; };
  if (!idx) return makeEmpty();                          // 北交所 / 代码缺失 ⇒ 判不出

  const th = thresholdsForStock(idx.board, code, x.name);
  const asOf = x.asOf || '';
  // ★ [DEV-AUC-WIN] 竞价口径：对应指数「当日那一根」强制按 0（9:25 指数还没有价格）
  const iLegs = x.indexTodayFlat === true ? withIndexFlatLeg(x.indexLegs, asOf, 0, true) : x.indexLegs;
  const d3 = cumulativeDeviation(x.stockLegs, iLegs, 3, asOf);
  const d10 = cumulativeDeviation(x.stockLegs, iLegs, 10, asOf);
  const d30 = cumulativeDeviation(x.stockLegs, iLegs, 30, asOf);
  if (!d3 && !d10 && !d30) {
    return Object.assign(makeEmpty(), {
      thr3: th.dev3, thr10: th.dev10, thr30: th.dev30,
      thr10Neg: th.neg10, thr30Neg: th.neg30
    });
  }

  const cls = classifyDeviation({
    board: idx.board,
    code: code,
    name: x.name,
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
    thr10Neg: th.neg10, thr30Neg: th.neg30,
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
  fact.gapShort = deviationGapShort(fact);       // 买点行用短版（只留点差），⛔ 别把长句塞进行内
  fact.calcText = deviationCalcText(fact);       // 面板第二行「自核」：个股 − 指数 = 偏离
  // ★ [IDX-MOVE 2026-11-14] 「股价再涨」是条件估算 ⇒ 数值、警示色、指数敏感度都由 Logic 层给
  fact.needValueText = deviationNeedValueText(fact);
  fact.needDir = deviationNeedDir(fact);         // '涨' / '跌'（视图据此选词，⛔ 不自己判数字）
  fact.needAlert = deviationNeedAlert(fact);
  fact.indexBeta = deviationIndexBeta(fact);
  fact.indexMoveText = deviationIndexMoveText(fact);
  fact.line = fact.badge + (fact.gapText ? ' · ' + fact.gapText : '');
  // ★★ [ABN-TRIGGER 2026-11-15 用户口径] 「首次触发 / 二次触发 / 三次触发」
  //   ⛔ 默认不跑（`withTrigger !== true`）⇒ 买点行徽标那条老路径的耗时与结果【零变化】（§11）。
  //   ⚠️ 只在面板需要逐行标序号时由 `buildDeviationMap` 透传 true。
  if (x.withTrigger === true) {
    const trg = countSevereTriggers({
      code: code,
      name: x.name,
      stockLegs: x.stockLegs,
      // ⚠️ 必须用【补齐后的】指数腿（竞价口径那根 pct=0）：逐日复算与「今天的数」必须是同一份尺子，
      //   否则 9:25 会出现「面板说已触发、序号却说没触发」这种自相矛盾。
      indexLegs: iLegs,
      asOf: asOf,
      maxLookback: x.triggerLookback
    });
    fact.trigger = trg;
    fact.triggerText = trg.text;
    fact.triggerTone = trg.tone;
    fact.triggerTitle = trg.title;
    fact.triggerCount = trg.count;
    fact.triggerOrdinal = trg.ordinal;
  }
  return fact;
}

/**
 * 【纯函数】挑「离红线最近的那一档」—— 「占本方向红线的比例」越大就越近。
 * ★ 徽标与「距红线」**必须共用同一个选择器**，否则会出现
 *   「徽标说 30日、括号里算的却是 10日」这种自相矛盾（2026-11-14 用户就是靠这行自核的）。
 *
 * 🔴 [DEV-NEG-WARN 2026-11-24] 旧实现只用 `dev / 正阈值` 当比值 ⇒ 负偏离的比值恒为负，
 *   四个候选里永远挑不出「离负向红线最近」的那一档（−60.2% 会被配到 +200% 上去）。
 *   ⇒ 现在按【方向】取各自的阈值：dev ≥ 0 比 thr10/thr30，dev < 0 比 neg10/neg30。
 *
 * @returns {{code:'D10'|'D30'|'N10'|'N30', thr:number|null, dev:number|null, ratio:number|null}}
 *          ⚠️ thr 带符号：负向档返回 −50 / −70（下游「距 X% 差 N 点」直接印它）
 */
function _nearestWindow(f) {
  const cand = [];
  const add = function (code, dev, thr) {
    const d = numOfText(dev);
    const t = numOfText(thr);
    if (d === null || t === null || t === 0) return;
    if (d >= 0 && t < 0) return;             // 正向偏离不配负向阈值
    if (d < 0 && t > 0) return;              // 负向偏离不配正向阈值
    cand.push({ code: code, thr: t, dev: d, ratio: Math.abs(d) / Math.abs(t) });
  };
  add('D10', f.dev10, f.thr10);
  add('N10', f.dev10, f.thr10Neg);
  add('D30', f.dev30, f.thr30);
  add('N30', f.dev30, f.thr30Neg);
  if (cand.length === 0) return { code: 'D10', thr: null, dev: null, ratio: null };
  // 比例最大者优先；相同则取更长窗口（与旧行为一致：r30 >= r10 时用 30 日）
  let best = cand[0];
  cand.forEach(function (c) {
    if (c.ratio > best.ratio) best = c;
    else if (c.ratio === best.ratio && _winIsLong(c.code) && !_winIsLong(best.code)) best = c;
  });
  return best;
}

/** 这一档是不是 30 日窗口（D30 / N30） */
function _winIsLong(code) { return code === 'D30' || code === 'N30'; }

/** 档位代码 → 「30 日 / 10 日」（上屏文案唯一来源，⛔ 别在视图里判 code） */
function _winName(code) { return _winIsLong(code) ? '30 日' : '10 日'; }

/** 百分点差值的显示精度：< 1 点给两位小数（否则「差 0.05 点」会印成「0.0 点」） */
function _ptsText(v) {
  const n = numOfText(v);
  if (n === null) return '—';
  if (n === 0) return '0';
  return n < 1 ? n.toFixed(2) : n.toFixed(1);
}

/**
 * 🔴🔴 【纯函数 · 屏幕上必须能相加对上】把「偏离值」与「距阈值点差」按**同一个精度**取整。
 *
 * 用户 2026-11-14 两次质疑同一个病根：「185.5% + 5.2% = 190.7%，还没到 200%」——
 *   第一次是【单位混用】（点差 vs 股价涨幅），第二次是【取整不一致】：
 *   真实偏离 199.95，徽标 `toFixed(1)` 印成 +199.9%，点差却按 199.95 算成 0.05 点
 *   ⇒ 199.9 + 0.05 = 199.95 ≠ 200，照样对不上。
 *
 * 规则（⛔ 别改，改了屏幕上就会重新出现「加起来不等于阈值」）：
 *   ① 默认 1 位小数；
 *   ② 若 1 位小数会把【未越线】显示成「已达阈值」（199.96 → 200.0），退到 2 位小数；
 *   ③ 点差 = 阈值 − 【显示出来的那个数】，精度与 ① ② 一致。
 *   ⇒ 保证 `显示偏离 + 点差 === 阈值` 逐字成立。
 *
 * @param {number} dev 真实偏离值（百分点）
 * @param {number} thr 阈值（百分点）
 * @returns {{shown:number, dp:number, gap:number}}
 */
function _devGapPair(dev, thr) {
  const d = numOfText(dev);
  const t = numOfText(thr);
  if (d === null || t === null) return { shown: null, dp: 1, gap: null };
  /** 取整后看着「已越线」但真值没越线 ⇒ 要加精度（负向阈值比较方向相反） */
  const shownOver = function (v) { return t >= 0 ? v >= t : v <= t; };
  const reallyOver = shownOver(d);
  let dp = 1;
  let shown = Number(d.toFixed(dp));
  if (shownOver(shown) && !reallyOver) {   // ② 取整把「还没到」说成「到了」⇒ 加精度
    dp = 2;
    shown = Number(d.toFixed(dp));
  }
  // 正向：差 = 阈值 − 显示值；负向：差 = 显示值 − 阈值（都是「还差多少点」，恒 ≥ 0）
  const gap = Math.max(0, Number((t >= 0 ? (t - shown) : (shown - t)).toFixed(dp)));
  return { shown: shown, dp: dp, gap: gap };
}

/** 按指定小数位印偏离值（'+199.9%' / '+199.96%'） */
function _devTextDp(v, dp) {
  const n = numOfText(v);
  if (n === null) return '—';
  return (n >= 0 ? '+' : '') + n.toFixed(dp) + '%';
}

/**
 * 股价还需涨幅的显示精度：< 1% 给两位小数（卡线票），< 10% 给一位，其余取整。
 * @param {number} v 需要变动多少（正数 = 幅度）
 * @param {'涨'|'跌'} [dir] 负向档传 '跌' ⇒ 不带 '+'（否则会读成「还要涨」）
 */
function _needPctText(v, dir) {
  const n = numOfText(v);
  if (n === null) return '';
  if (n <= 0) return '+0%';
  const s = n < 1 ? n.toFixed(2) : (n < 10 ? n.toFixed(1) : String(Math.round(n)));
  return (dir === '跌' ? '' : '+') + s + '%';
}

/**
 * 🔴🔴 【纯函数 · 一个窗口所有上屏数字的唯一来源】
 *
 * [ABN-CHECK 2026-11-14] 用户「查下 11月13日九阳股份偏离值是多少？我核对下」时实测抓到：
 *   真实库 dev30 = 199.9592 点。徽标按 2 位印 `+199.96%`，但表格「30日偏离」列和
 *   detailLine 仍用固定 1 位的 `devText()` ⇒ 印成 **`+200.0%`**（看起来已经越线！），
 *   而自核算式 `+184.87% − (-15.08%)` 又只加到 199.95，等号右边却是 199.96 ⇒ 三处互相打架。
 *
 * 根因：`round(a,dp) − round(b,dp) ≠ round(a−b,dp)`。⛔ 只修一处必然留下别处不一致。
 * ⇒ 改成【先按同一精度取整两条区间涨幅，再用它们的差作为显示的偏离值】：
 *     scS = round(个股区间涨幅, dp)、icS = round(指数区间涨幅, dp)
 *     shown = scS − icS、gap = thr − shown
 *   这样 徽标 / 点差 / 表格列 / 自核算式 / detailLine 五处**逐字相加都对得上**。
 *   dp 仍由 `_devGapPair` 定；若取整后 shown 会把「未越线」说成「已达阈值」⇒ 自动再加一位。
 *
 * @returns {{code:string, thr:number, dp:number, shown:number, gap:number,
 *            scS:number|null, icS:number|null}|null} 判不出 ⇒ null
 */
function _windowDisplay(f) {
  const x = f || {};
  if (!x.ok) return null;
  const w = _nearestWindow(x);
  if (w.dev === null || w.thr === null) return null;
  const base = _devGapPair(w.dev, w.thr);
  const isLong = _winIsLong(w.code);
  const sc = numOfText(isLong ? x.stockChain30 : x.stockChain10);
  const ic = numOfText(isLong ? x.indexChain30 : x.indexChain10);
  if (sc === null || ic === null) {
    // 合成/残缺 fact（单测夹具常缺腿）⇒ 退回旧口径，⛔ 不编造两条区间涨幅
    return { code: w.code, thr: w.thr, dp: base.dp, shown: base.shown, gap: base.gap, scS: null, icS: null };
  }
  const over = function (v) { return w.thr >= 0 ? v >= w.thr : v <= w.thr; };
  let dp = base.dp;
  let scS, icS, shown;
  for (let k = 0; k < 3; k++) {
    scS = Number(sc.toFixed(dp));
    icS = Number(ic.toFixed(dp));
    shown = Number((scS - icS).toFixed(dp));
    if (!(over(shown) && !over(w.dev))) break;
    dp += 1;
  }
  const gap = Math.max(0, Number((w.thr >= 0 ? (w.thr - shown) : (shown - w.thr)).toFixed(dp)));
  return { code: w.code, thr: w.thr, dp: dp, shown: shown, gap: gap, scS: scS, icS: icS };
}

/**
 * 【纯函数】面板「10日偏离 / 30日偏离」两列的文本（§21 视图零计算）。
 * 🔴 离红线最近的那一档必须与徽标**同一个数、同一精度**，否则表格印 `+200.0%`、
 *    徽标却印 `+199.96%`，用户会以为已经触发严重异动。
 */
export function deviationCellTexts(fact) {
  const f = fact || {};
  const fallback = { dev10Text: devText(f.dev10), dev30Text: devText(f.dev30) };
  const d = _windowDisplay(f);
  if (!d) return fallback;
  if (f.stage === DEV_STAGE_SEVERE || d.shown === null) return fallback;
  const t = _devTextDp(d.shown, d.dp);
  return _winIsLong(d.code)
    ? { dev10Text: fallback.dev10Text, dev30Text: t }
    : { dev10Text: t, dev30Text: fallback.dev30Text };
}

/**
 * 【纯函数】徽标短文本 —— 挑「离红线最近的那一档」来说，⛔ 不说废话。
 *   已触发   ⇒ '30日偏离 +200.3%'
 *   逼近     ⇒ '10日偏离 +72.7%'
 *   正常     ⇒ '10日偏离 +48.8%'
 *   判不出   ⇒ ''（视图据此不渲染，⛔ 不写「—」占位）
 * ⚠️ 取整精度与点差 / 表格列 / 自核算式**共用 `_windowDisplay`**，保证五处相加都对得上。
 */
export function deviationBadge(fact) {
  const f = fact || {};
  if (!f.ok) return '';
  const w = _nearestWindow(f);
  if (w.ratio === null || w.dev === null) return '';
  const label = _winIsLong(w.code) ? '30日偏离 ' : '10日偏离 ';
  if (f.stage === DEV_STAGE_SEVERE) return label + devText(w.dev);
  const d = _windowDisplay(f);
  if (!d) return '';
  return label + _devTextDp(d.shown, d.dp);
}

/**
 * 【纯函数】「距红线还有多远」—— ★ 必须同时给【偏离点差】与【股价还需涨幅】两个单位。
 *
 * 🔴🔴 [ABN-DEV-UNIT 2026-11-14 用户当场质疑] 用户原话：
 *   「为什么还需 5.2% 呢？185.5% + 5.2% = 190.7%，30 日还没到 200% 啊，怎么算的？」
 *
 *   他没错，是原来那行**只写了股价涨幅、没写点数差**，两个单位混在一行里没法自核。
 *     偏离（点） = 个股区间涨幅 − 指数区间涨幅      ← 官方条文原式，⛔ 不是 (1+S)/(1+I)−1
 *     股价再涨 g ⇒ 偏离增加 (1+S)·g **个点**，不是 g 个点（S = 个股区间涨幅）
 *     ⇒ 股价还需涨幅 = 点差 ÷ (1+S)，这个除法就是两个单位之间的汇率。
 *   新华传媒 10-28（真实库实测）：30 日 S = +178.91%、I = -6.57% ⇒ 汇率 (1+S) = 2.789
 *   ⇒ 差 14.5 个点只要涨 14.5/2.789 ≈ 5.2%。这就是用户看到「+185.5% 还需 +5.2%」的来历。
 *   ⇒ 现在固定写成 `距 200% 差 14.5 点（股价再涨约 +5.2%）`：
 *     前半句能与表里的「30日偏离 +185.5%」直接相加核对，后半句才是可执行的「还能涨多少」。
 *   ⚠️ 别把它俩写成同一个数：差 14.5 点 ≠ 涨 14.5%，用户第一眼就是在这里对不上。
 *
 *   已触发   ⇒ '已触发（30日偏离 +200.3%）'
 *   判不出   ⇒ ''（视图不渲染）
 */
export function deviationGapText(fact) {
  return _gapCore(fact).gapText;
}

/**
 * 【纯函数】「距红线」的**短版**（只留点差、不带「股价再涨约」那句）。
 *
 * 买点行是横向挤在一行的（龙标 + 名次 + 涨幅 + 竞价 + 量比…），塞进
 * `距 100% 差 27.3 点（股价再涨约 +16%）` 会折行、把整行挤乱。
 * ⇒ 行上印短版，完整版在「距红线」面板与鼠标悬停的 title 里。
 * ⚠️ 短版仍然是【能与徽标相加的那个数】，⛔ 不许改成股价涨幅（那正是用户对不上的原因）。
 */
export function deviationGapShort(fact) {
  return _gapCore(fact).gapShort;
}

/** 两版共用同一份计算，⛔ 不许各写一份（一旦分叉，两个地方会印出不同的数） */
function _gapCore(fact) {
  const f = fact || {};
  const none = { gapText: '', gapShort: '', needValue: null, needValueText: '', win: null, gap: null };
  if (!f.ok) return none;
  if (f.stage === DEV_STAGE_SEVERE) {
    const parts = [];
    if (f.hits && f.hits.length) {
      // ★ [DEV-WRAP 2026-11-16] 每段省掉重复的「偏离」二字（徽标本身已写「10日偏离」），
      //   两段并排时从「10日偏离 +178.6%、30日偏离 +223.4%」缩到「10日 +178.6% · 30日 +223.4%」，
      //   手机端才不会撑出卡片右边（配套 CSS 也已允许折行，双保险）。
      f.hits.forEach(function (h) {
        // ★ [DEV-NEG-WARN] 负方向的 label 是「10日偏离（跌）」，再套进 `已触发（…）` 会变成
        //   `已触发（10日（跌） -52.8%）`（括号套括号）。跌幅本身带负号，方向已一目了然
        //   ⇒ 上屏时把「（跌）」去掉，title / hits 里仍保留完整 label。
        parts.push(String(h.label || '').replace('偏离', '').replace('（跌）', '') + ' ' + devText(h.value));
      });
    }
    const s = parts.length ? '已触发（' + parts.join(' · ') + '）' : '已触发严重异动';
    return Object.assign({}, none, { gapText: s, gapShort: s });
  }
  if (f.stage === DEV_STAGE_UNKNOWN) return none;

  const d = _windowDisplay(f);                        // 与徽标/表格列/自核算式同一组显示数字
  if (!d) return none;
  const w = d;                                       // code / thr 与 _nearestWindow 一致
  const scRaw = numOfText(_winIsLong(w.code) ? f.stockChain30 : f.stockChain10);
  const cs = scRaw === null ? null : 1 + scRaw / 100;
  // 🔴 用【屏幕上那个点差】反推股价涨幅，⛔ 别拿原始 dev 另算 —— 否则
  //    「差 0.05 点」与「股价再涨 +0.01%」对不上（0.05/2.849 ≈ 0.02%）。
  const need = (cs !== null && cs > 0)
    ? d.gap / cs
    : numOfText(_winIsLong(w.code) ? f.need30 : f.need10);
  // ★ [DEV-NEG-WARN 2026-11-24] 负向档印「距 -70% 差 9.8 点（股价再跌约 24.6%）」；
  //   ⛔ 旧的「差 260 点（股价再涨约 +654%）」是拿 +200 套在跌 60% 的票上，必须消失。
  const dir = w.thr >= 0 ? '涨' : '跌';
  const short = '距 ' + w.thr + '% 差 ' + d.gap.toFixed(d.dp) + ' 点';
  const needValueText = (need !== null && need > 0) ? _needPctText(need, dir) : '';
  const long = needValueText
    ? short + '（股价再' + dir + '约 ' + needValueText + '）'
    : short;
  return {
    gapText: long, gapShort: short,
    needValue: need, needValueText: needValueText, needDir: dir,
    win: w, gap: d.gap
  };
}

/** 【纯函数】「股价再涨 / 再跌」的方向字（'涨' / '跌'）—— 视图据此选词，⛔ 不自己判数字 */
export function deviationNeedDir(fact) {
  const c = _gapCore(fact);
  return c.needDir || '涨';
}

/**
 * 【纯函数】「股价再涨」那个数值（'+5.2%'），已越线/判不出 ⇒ ''。
 * ★ 视图要把它单独上色（接近警示标红），⛔ 不许在模板里从句子里切字符串。
 */
export function deviationNeedValueText(fact) {
  return _gapCore(fact).needValueText;
}

/**
 * 🔴🔴 【纯函数 · 指数敏感度 β】(2026-11-14 用户原话)
 *   「这个不是和同期的指数一起吗？如果同期指数变化，这个股价再涨百分之几，
 *     这个不是很准确吧？只能做一个大概的推测对吧？」
 *
 *   他完全说对了。推导（本模块口径 dev = cs − ci，cs=个股复利因子、ci=指数复利因子）：
 *     股价再涨 g、指数额外涨 h  ⇒  cs(1+g) − ci(1+h) = thr/100
 *     ⇒ g(h) = g₀ + (ci/cs)·h       其中 g₀ = needGainToThreshold 给的就是「指数不动」那个数
 *     ⇒ **β = ci/cs = (1 + 指数区间涨幅) / (1 + 个股区间涨幅)**
 *
 *   因为个股涨得比指数多 ⇒ β < 1 ⇒ 指数涨跌的影响被压缩：
 *     指数【涨】⇒ 偏离被扣得更多 ⇒ 要涨【更多】；指数【跌】⇒ 更容易触发 ⇒ 要涨【更少】。
 *   新华传媒 10-28：cs=2.789、ci=0.934 ⇒ β=0.335 ⇒ 指数 ±1% 只让所需涨幅动 ±0.335 个点。
 *
 *   ⚠️ 而且 h 指的是【整段窗口指数因子的额外变动】。30 日窗口每天滚动（最老一天滚出、
 *      新一天滚进），所以「指数不动」严格说是「新进那天与滚出那天的涨幅相抵」，
 *      ⛔ 不是「明天指数不涨」。⇒ 这一列只能是**大概推测**，不是精确预测，上屏必须如实写。
 *
 * @returns {number|null} β；判不出 ⇒ null（§10 不补 0）
 */
export function deviationIndexBeta(fact) {
  const f = fact || {};
  const c = _gapCore(fact);
  if (!c.win) return null;                            // 与点差同一档（⛔ 不许拿 30 日的 β 配 10 日的 need）
  const isLong = _winIsLong(c.win.code);
  const S = numOfText(isLong ? f.stockChain30 : f.stockChain10);
  const I = numOfText(isLong ? f.indexChain30 : f.indexChain10);
  if (S === null || I === null) return null;
  const cs = 1 + S / 100;
  const ci = 1 + I / 100;
  if (!(cs > 0) || !(ci > 0)) return null;
  const beta = ci / cs;
  return isFinite(beta) ? beta : null;
}

/**
 * 【纯函数】指数额外变动 hPct 个百分点时，「股价还需涨幅」变成多少（百分数）。
 * 负数结果 = 光靠指数下跌就已经触发，股价不用涨 ⇒ 视图写「已触发」。
 * ⚠️ 条件估算，⛔ 别当预测用（见 deviationIndexBeta 的窗口滚动说明）。
 */
export function deviationNeedWithIndexMove(fact, hPct) {
  const c = _gapCore(fact);
  const h = numOfText(hPct);
  const beta = deviationIndexBeta(fact);
  if (!c.win || c.needValue === null || h === null || beta === null) return null;
  // ★ [DEV-NEG-WARN] 正负两个方向的符号相反（同一式推出来的）：
  //   正向 dev' = cs(1+g) − ci(1+h) = thr ⇒ g = g₀ + β·h（指数涨 ⇒ 要多涨）
  //   负向 dev' = cs(1−g) − ci(1+h) = thr ⇒ g = g₀ − β·h（指数涨 ⇒ 偏离更负 ⇒ 少跌即可）
  return c.needDir === '跌' ? (c.needValue - beta * h) : (c.needValue + beta * h);
}

/** 指数敏感度那行的显示文本：<=0 ⇒ 「已触发」，⛔ 不写 '+0%'（会读成「还得涨 0%」） */
function _movePctText(v, dir) {
  if (v === null) return '—';
  if (v <= 0) return '已触发';
  return _needPctText(v, dir);
}

/**
 * 【纯函数】每只票第二行尾部的「指数 ±1% 会怎样」小字（用户要「具体影响多少」）。
 * 例：'指数 ±1% ⇒ 需涨 +5.5% / +4.9%（β0.33）'
 *     负向档 → '指数 ±1% ⇒ 需跌 24.7% / 24.5%（β0.42）'
 */
export function deviationIndexMoveText(fact) {
  const beta = deviationIndexBeta(fact);
  if (beta === null) return '';
  const up = deviationNeedWithIndexMove(fact, 1);
  const dn = deviationNeedWithIndexMove(fact, -1);
  if (up === null || dn === null) return '';
  const dir = deviationNeedDir(fact);
  return '指数 ±1% ⇒ 需' + dir + ' ' + _movePctText(up, dir) + ' / ' + _movePctText(dn, dir) +
    '（β' + beta.toFixed(3) + '）';
}

/**
 * 【纯函数】「股价再涨」那个数值要不要标红（2026-11-14 用户「接近警示再标为红色」）。
 * 判据 = 已进预警带（near / severe）**或** 所需涨幅 ≤ 10%（再涨一点就触发）。
 * ⛔ 别用「距红线比率」另起一把尺子 —— 与 `isDeviationAlert` 同源，避免满屏红。
 */
export function deviationNeedAlert(fact) {
  const f = fact || {};
  if (!f.ok) return false;
  const c = _gapCore(fact);
  if (!c.needValueText || c.needValue === null) return false;
  return f.stage === DEV_STAGE_NEAR || f.stage === DEV_STAGE_SEVERE ||
    (c.needValue > 0 && c.needValue <= 10);
}

/** 「股价再涨」后面的限定语（用户质疑精度 ⇒ 这半句必须常驻，⛔ 不许省） */
export const DEV_NEED_HINT = '（同期指数不动 · 条件估算）';

/**
 * 【纯函数】说明区用的一整行（含指数名与停牌提示，§10 如实交代口径）。
 *
 * ★ [ABN-DEV-UNIT 2026-11-14] `gapText` 现在自带「哪一档 + 点数差 + 股价还需涨幅」三段，
 *   而它说的那一档**可能是 30 日**（挑最近的那档）。⛔ 不许再把它塞进「10日偏离（…）」的括号里
 *   —— 那就变成「10 日偏离 +9.8%（…距 200% 差 14.5 点…）」，两个窗口混在一句里，正是用户质疑的那类表述。
 *   现在它单独成句放在最后。
 *
 * 例：'10日偏离 +9.8%（上证A股指数 同期 +12.6%）；30日偏离 +185.5%（上证A股指数 同期 +35.5%）；
 *      ★ 距红线：距 200% 差 14.5 点（股价再涨约 +5.2%）；口径：截至最近一个收盘日'
 */
export function deviationDetailLine(fact) {
  const f = fact || {};
  if (!f.ok) {
    if (!f.code) return '';
    return '偏离值：' + (f.board ? '数据未就绪' : '北交所/代码不全 ⇒ 官方不吃这套口径，不计算');
  }
  const idxName = f.indexName || devIndexName(f.indexCode);
  const idxCode = String(f.indexCode || '').trim();
  // ★ [IDX-LABEL] 连指数代码一起写，用户才不用猜「这到底是哪个指数」
  const idxTag = idxName + (idxCode ? ' ' + idxCode : '');
  const cells = deviationCellTexts(f);                 // 🔴 与徽标同一个数（⛔ 别再印 +200.0%）
  const parts = [];
  parts.push('10日偏离 ' + cells.dev10Text + '（' + idxTag + ' 同期 ' + devText(f.indexChain10) + '）');
  parts.push('30日偏离 ' + cells.dev30Text + '（' + idxTag + ' 同期 ' + devText(f.indexChain30) + '）');
  let s = parts.join('；');
  if (f.gapText) s += '；★ 距红线：' + f.gapText;
  const d = _windowDisplay(f);
  if (d && d.scS !== null && d.icS !== null) {
    // 让用户能自核「为什么差 14.5 个点只需涨 5%」：偏离 = 个股区间涨幅 − 指数区间涨幅，
    // 而股价再涨 g 带来的是 (1+S)·g 个点（复利）—— 这个乘数就是两个单位之间的汇率。
    // ★ [ABN-CHECK] 与 calcText 同一档、同一组已取整的数，⛔ 一堆 30 日、一堆 10 日会读乱。
    const mkt = (1 + d.scS / 100);
    s += '；自核：' + _winName(d.code) + '偏离 = 个股区间涨幅 ' +
      _devTextDp(d.scS, d.dp) + ' − 指数区间涨幅 ' + _devTextDp(d.icS, d.dp) +
      ' = ' + _devTextDp(d.shown, d.dp) +
      // ★ [DEV-NEG-WARN] 负向档股价在跌 ⇒ 措辞必须跟着换，⛔ 别让跌 60% 的票说「再涨」
      (d.thr >= 0
        ? '；股价每再涨 1%，偏离约增加 ' + _ptsText(mkt) + ' 个点'
        : '；股价每再跌 1%，偏离约再降 ' + _ptsText(mkt) + ' 个点');
  }
  const beta = numOfText(f.indexBeta);
  if (beta !== null) {
    // [IDX-MOVE 2026-11-14] 用户当场指出「同期指数也在变」⇒ 悬停说明里也必须交代这是条件估算
    const dir = deviationNeedDir(f);
    s += '；⚠️「股价再' + dir + '」按同期指数不动估算：指数每额外涨 1%，所需股价' + dir +
      '幅度约 ' + (dir === '跌' ? '-' : '+') + beta.toFixed(3) + ' 个点，' +
      (dir === '跌' ? '跌 1% 则反向' : '跌 1% 则少这么多') + '（β=' + beta.toFixed(3) +
      '，窗口每日滚动，仅作推测）';
  }
  if (f.missingLegs > 0) {
    s += '；⚠️ 窗口内有 ' + f.missingLegs + ' 个交易日无成交腿（停牌/未采集），已按 0 计入';
  }
  if (f.basis === 'auction') {
    // ★ [DEV-AUC-WIN 2026-11-24] 这句现在**真的成立**了：今日竞价涨幅已进窗口，指数按不动计。
    s += '；口径：截至今日 9:25 竞价（今日个股用竞价涨幅、对应指数按不动计；收盘后自动改为收盘口径重算）';
  } else {
    s += '；口径：截至最近一个收盘日';
  }
  return s;
}

/**
 * 【纯函数】单只票的【自核算例行】—— 把「偏离值是怎么减出来的」摊开给用户自己对一遍。
 *
 * ★ [ABN-DEV-UX 2026-11-14 用户原话]「还有把计算公式具体的也一起标注在上头，我自己也要验证下。」
 *   所以这一行必须与「距红线」那一行走**同一个窗口、同一份精度**（都用 `_nearestWindow` + `_devGapPair`），
 *   否则用户算出来差 0.1 个点又会来问（§10/th 那条取整病的同源）。
 *
 *   输出例：'自核 30日：+178.9% − (-6.6%) = +185.5%'
 *     ↑ 个股区间涨幅 − 对应指数区间涨幅 = 偏离值（三个数都是屏幕上能相加对上的）
 *   判不出 ⇒ ''（视图不渲染，⛔ 不写「— = —」占位）
 *
 * @param {object} fact computeDeviation 的返回值
 * @returns {string}
 */
export function deviationCalcText(fact) {
  const d = _windowDisplay(fact);
  if (!d || d.scS === null || d.icS === null) return '';
  // 🔴 等号两边都取自同一组【已取整】的数 ⇒ 屏幕上真的加得起来（⛔ 不许一边 round(dev)、
  //    一边 round(sc)−round(ic)，那会差 0.01 点，正是用户核对时会抓到的那种不一致）
  return '自核 ' + _winName(d.code).replace(' ', '') + '：' +
    _devTextDp(d.scS, d.dp) + ' − (' + _devTextDp(d.icS, d.dp) + ') = ' +
    _devTextDp(d.shown, d.dp);
}

/**
 * 面板顶部那张「计算公式」说明（§21：文案在 Logic 层，视图只 v-for）。
 *
 * ★ [ABN-DEV-UX 2026-11-14] 用户连着两轮问「怎么算的」「我自己也要验证下」——
 *   ⇒ 把三行公式直接印在表头上方，而不是只放在悬停 title 里（他看不到 title）。
 * ⚠️ 每条都必须与代码里的等式**逐字一致**，改算法就要回来改这张表（否则说明与实现分叉）。
 */
export const DEV_FORMULA_LINES = [
  '① 偏离值（点）= 个股区间涨幅 − 对应指数同期涨幅（交易规则 5.4.2）；' +
    '例：新华传媒 10-28 三十日 +178.9% − (-6.6%) = +185.5%',
  '② 距红线点差 = 阈值 − 偏离值 ⇒ 「偏离值 + 点差」刚好等于阈值，可直接相加对账；' +
    '例：200 − 185.5 = 14.5 点',
  '③ 股价还需涨幅 = 点差 ÷ (1 + 个股区间涨幅)；例：14.5 ÷ 2.789 ≈ +5.2%' +
    '（涨得越多，涨 1% 换来的点数越多）',
  '④ 「股价再涨」只是【同期指数不动】下的条件估算，⛔ 不是精确预测：指数额外涨 h% ⇒ ' +
    '所需涨幅 + β·h%，β = (1+指数区间涨幅) ÷ (1+个股区间涨幅)；30 日窗口每天滚动' +
    '（最老一天滚出、新一天滚进），「指数不动」严格说是新进与滚出两天的涨幅相抵',
  '⑤ 指数涨 ⇒ 偏离被扣得更多 ⇒ 要涨更多；指数跌 ⇒ 更容易触发 ⇒ 要涨更少。' +
    '例（10-28 新华传媒 β=0.335）：+1% ⇒ 需涨 +5.5%，−1% ⇒ +4.9%，' +
    '+2% ⇒ +5.9%，−2% ⇒ +4.5%；每行末尾另给该票自己的 β 与 ±1% 影响',
  // ★ [DEV-NEG-WARN 2026-11-24] 负向（杀跌）同一套算法、阈值不同，必须一起印出来，
  //   否则用户看到「距 -70% 差 9.8 点（股价再跌约 24.6%）」会不知道 -70% 是哪来的。
  '⑥ 跌的方向同一套算法，只是阈值不同：10 日 ≤ −50%、30 日 ≤ −70%（交易所原文与正向并列）；' +
    '此时点差 = 偏离值 − 阈值，股价还需「跌」多少 = 点差 ÷ (1 + 个股区间涨幅)',
  // ★ [DEV-TIMES10 2026-11-24] 官方严重异常波动有三条判据，本面板只算其中两条 —— 必须如实写，
  //   否则「面板说正常」会被误读成「官方不会认定严重异动」。
  '⑦ 官方「严重异常波动」共三条判据：① 连续 10 个交易日内 4 次（创业板/科创板 3 次）同向异常波动；' +
    '② 10 日偏离 ≥ +100%（≤ −50%）；③ 30 日偏离 ≥ +200%（≤ −70%）。' +
    '本面板只算 ②③（① 需要交易所异动名单，暂未接入）⇒ 显示「正常」不等于官方一定不认定严重异动'
];

/**
 * 【纯函数】第三十四条用：这只票的偏离值是否已触发【官方严重异常波动】。
 *
 * ★★ [DEV-RULE 2026-11-25 用户口径] 现在全项目**只剩这一把尺子**：
 *   旧的自定义尺子 `abnormal-10d.js#isOverRange10Cap`（十日原始涨幅 ＞ 97%）**已删除（repealed）** ——
 *   用户原话：「之前我自定义的100%涨幅那个就触发监管异动，那个有些不准……确实是需要改下统一口径
 *   是官方偏离值那里产生异动监管，而不是自定义的。」
 *   ⇒ 规则层要判「越没越线」请用 `deviation-rule-facts.js#isDeviationOverRedLine`（同一份事实的适配层），
 *     ⛔ 不要再造第三把尺子，也 ⛔ 不要复活 97%。
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
 * @param {boolean} [o.indexTodayFlat=false] ★ [DEV-AUC-WIN] 竞价口径：指数缺 asOf 腿时补 pct=0
 * @param {boolean} [o.withTrigger=false] ★ [ABN-TRIGGER 2026-11-15] 是否额外复算「第几次触发」
 *        （面板要逐行标序号 ⇒ true；买点行徽标 ⇒ 不传，零额外耗时）
 * @param {number} [o.triggerLookback] 回看多少个交易日（缺省 ABN_TRIGGER_LOOKBACK_DAYS）
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
      name: name,                                  // ★ 只用来判 ST（深市三日阈值 ±12%）
      stockLegs: stockLegs,
      indexLegs: iLegs,
      asOf: asOf,
      basis: x.basis || 'close',
      // ★ [DEV-AUC-WIN 2026-11-24] 竞价口径：指数缺今天那根腿 ⇒ 补 pct=0，否则今日竞价涨幅被窗口丢掉
      indexTodayFlat: x.indexTodayFlat === true,
      // ★ [ABN-TRIGGER 2026-11-15] 只有面板明确要「第几次触发」才逐票复算历史；
      //   买点行徽标那条路径不传 ⇒ 一次都不多算（§11 零行为变化 / 零额外耗时）。
      withTrigger: x.withTrigger === true,
      triggerLookback: x.triggerLookback
    });
    if (fact.ok) ready++;
    out.set(name, fact);
  });

  return { map: out, ready: ready, total: names.length };
}
