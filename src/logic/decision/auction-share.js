// auction-share.js — 「决策」看板：竞价占比（竞价量 ÷ 昨日成交量）的【唯一实现】（Logic 层）
//
// ══════════════════════════════════════════════════════════════════════════════════════
// ★★ [SHARE-RULE 2026-10-03 用户口径] 占比 = 决策看板买卖点的【主判据】★★
// ══════════════════════════════════════════════════════════════════════════════════════
// 用户原话（给了 8/31、9/1、9/2 三天共 11 个已标注案例，是本文件的验收基准）：
//   · 「所以最主要看占比，前面那两个（竞价涨幅、竞价量比）都涨，有时也没有用……
//      只是说前面两个指标作为辅助，让占比更有确定性。」
//   · 「占比对决策买入和卖出作用很大」「占比占重要决策，只要占比完全符合条件，就可以大胆持有」。
//   · 「前排龙一龙二标准的占比是 4%，后排选手（非龙一龙二）标准占比 2%」。
//   · 「昨日和今日龙一和龙二有容错率 0.5%」⇒ 前排门槛 = 4% − 0.5% = 3.5%。
//   · 「竞价占比百分比后保留 1 位有效数字，这样更准确。比如金健米业实际是 0.0435，那就是 4.4%」。
//
// ── 精确定义 ──────────────────────────────────────────────────────────────────────
//   竞价占比 R(%) = 当日竞价量(volume) ÷ 昨日成交量(yestVolume) × 100
//     ⚠️ 与早盘竞价第一页显示的那个占比【同一个公式】，但【显示精度不同】：
//        早盘竞价第一页 = Math.round(R) → 整数（用户原话「那个是四舍五入算法，只取整数」）；
//        决策看板     = R 保留 1 位小数（用户原话「这样更准确」）。
//        ⇒ ⛔ 两者是【刻意不同】的展示精度，别互相「对齐」；本看板只改自己这一份。
//
//   门槛（用户口径里的两个「标准值」）：
//     前排（今日或昨日 龙一 / 龙二）→ 4%，可容错 0.5% ⇒ 实际门槛 3.5%
//     后排（其余，含今日未成组的票）→ 2%
//
//   用户给的 11 个案例（R 全部由本公式算出，逐条对上，见 auction-share.test.js）：
//     买点 → 竞价买：金健米业 4.4%(龙一) / 花溪科技 4.4% / 捷荣技术 7.0% / 楚天龙 5.5%
//                   / 龙版传媒 6.9%(后排) / 花溪科技 3.6%(昨日龙一，用容错)
//     买点 → 尾盘买：海登种业 0.2%（原始 0.15%，龙七 = 后排，远不到 2%）
//     卖点 → 尾盘卖：金健米业 3.9%(昨日龙一，用容错) / 登海种业 2.6%(龙九) / 捷荣技术 9.4%
//                   / 浙江世宝 2.6%(今日无题材=后排)
//     卖点 → 竞价出：华阳国际 1.8%(龙三，非前排，不到 2%)
//
// ── §10 红线 ─────────────────────────────────────────────────────────────────────
//   缺当日竞价量 / 缺昨日成交量 / 昨日成交量为 0（除不出来）⇒ 一律返回 null（未知），
//   ⛔ 绝不当 0 或「很小」—— 「没抓到」与「占比确实很低」会给出完全相反的建议。
//   缺值时规则层【回落旧口径】并如实写进说明文字，绝不假装算出来了。
//
// ── 边界（§4 / §32）────────────────────────────────────────────────────────────
//   · 只读：不发请求、不落库、不消费猫抓额度；
//   · 不碰 DOM、不 import 任何组件（禁止 Data → UI 反向依赖）；
//   · 取数与 vol-ratio-trend.js 同源（都走 data/watchlist-helpers#getStockHistoryValue），
//     ⛔ 绝不另起一套字段名（§6 单一真相）。

import { getStockHistoryValue } from '../../data/watchlist-helpers.js';

/** 前排（龙一 / 龙二）标准占比（%）—— 用户口径「前排龙一龙二标准的占比是 4%」 */
export const AUCTION_SHARE_FRONT_STD = 4;
/** 龙一 / 龙二容错（%）—— 用户口径「昨日和今日龙一和龙二有容错率 0.5%」 */
export const AUCTION_SHARE_TOLERANCE = 0.5;
/** 前排【实际门槛】（4 − 0.5 = 3.5）—— ⛔ 只从上面两个常量推导，别在这里另写一个 3.5 */
export const AUCTION_SHARE_FRONT_MIN = AUCTION_SHARE_FRONT_STD - AUCTION_SHARE_TOLERANCE;
/** 后排（非龙一 / 龙二）标准占比（%）—— 用户口径「后排选手标准占比 2%」 */
export const AUCTION_SHARE_BACK_STD = 2;
/** 显示精度：保留 1 位小数（用户口径「百分比后保留 1 位有效数字」） */
export const AUCTION_SHARE_DECIMALS = 1;

/**
 * 竞价占比（纯函数，可单测）。
 * @param {*} volume      当日竞价量（原始值：字符串 / 数字 / null）
 * @param {*} yestVolume  昨日成交量（原始值）
 * @returns {number|null} 占比（%，已按 AUCTION_SHARE_DECIMALS 取整到 1 位）；null = 缺数据 / 除不出来
 */
export function computeAuctionShare(volume, yestVolume) {
  const v = _toNum(volume);
  const y = _toNum(yestVolume);
  if (v === null || y === null || y <= 0) return null;
  return _roundShare((v / y) * 100);
}

/**
 * 占比 → 展示文案（§21：格式化在 Logic 层做完，模板只渲染）。
 * ⛔ 缺值 ⇒ 空串（模板 v-if 整个不渲染），绝不显示「0.0%」（§10）。
 * @param {number|null} share
 * @returns {string} 如「4.4%」；缺值「」
 */
export function formatAuctionShare(share) {
  const v = _shareNum(share);
  if (v === null) return '';
  return v.toFixed(AUCTION_SHARE_DECIMALS) + '%';
}

/**
 * 该股适用的【占比门槛】（%）：前排 3.5 / 后排 2。
 * @param {boolean} isFront 是否前排（今日或昨日 龙一 / 龙二）
 * @returns {number}
 */
export function auctionShareThresholdOf(isFront) {
  return isFront ? AUCTION_SHARE_FRONT_MIN : AUCTION_SHARE_BACK_STD;
}

/**
 * 占比是否【达到门槛】（= 用户说的「占比完全符合条件」）。
 * §10：share 为 null ⇒ false（未知不算达标），由调用方走回落分支并如实说明。
 * @param {number|null} share
 * @param {boolean} isFront
 * @returns {boolean}
 */
export function passesAuctionShare(share, isFront) {
  const v = _shareNum(share);
  if (v === null) return false;
  return v >= auctionShareThresholdOf(isFront);
}

/**
 * 占比的【绝对强度档】—— 只描述这个数值本身有多强，与前排 / 后排判定无关。
 *   ≥ 前排标准 4%  → 'strong'（完全达标，用户口径「更加确定」）
 *   ≥ 后排标准 2%  → 'meet'（后排正常水平 / 前排的容错区）
 *   其余           → 'weak'
 * §10：缺值 ⇒ ''（模板回落默认底色，⛔ 不涂色、更不写 0.0%）。
 * @param {number|null} share
 * @returns {'strong'|'meet'|'weak'|''}
 */
export function auctionShareZoneOf(share) {
  const v = _shareNum(share);
  if (v === null) return '';
  if (v >= AUCTION_SHARE_FRONT_STD) return 'strong';
  if (v >= AUCTION_SHARE_BACK_STD) return 'meet';
  return 'weak';
}

/**
 * 取某只股票【展示日】的竞价占比（读内存真相，§6 与早盘竞价第一页的占比同源同公式）。
 *   当日竞价量   = auction_watchlist 该行的 volume
 *   昨日成交量   = 同一行的 yest_volume（云端）/ yestVolume（内存）
 * ⚠️ 两者都在【同一行】里，所以【不需要】走 getPreviousTradingDay —— 昨天是假期也无所谓，
 *    yest_volume 由抓取端按「上一交易日」填好（与早盘竞价第一页完全一致的口径）。
 * @param {string} date 展示日 YYYY-MM-DD
 * @param {string} stockName
 * @returns {number|null}
 */
export function getAuctionShare(date, stockName) {
  const name = String(stockName || '').trim();
  if (!date || !name) return null;
  return computeAuctionShare(
    getStockHistoryValue(date, name, 'volume'),
    getStockHistoryValue(date, name, 'yestVolume')
  );
}

/**
 * 字符串 / 数字 → 数值；空串 / null / 非数字一律 → null（§10 缺数据 ≠ 0）。
 * @param {*} v
 * @returns {number|null}
 */
function _toNum(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const s = String(v).trim().replace(/,/g, '');
  if (s === '') return null;
  const n = Number(s);
  return isFinite(n) ? n : null;
}

/**
 * 占比入参 → 【已按 AUCTION_SHARE_DECIMALS 取整】的数值；缺值 / 非数字 → null（§10）。
 * ⚠️ 为什么要先取整再判定：让「行内标签显示的数值」与「规则实际比较的数值」是【同一个数】。
 *   否则会出现「屏幕上写着占比 3.5%，规则却说不达标」这种自相矛盾的显示。
 * ⚠️ 空串必须当缺值：Number('') === 0，不拦住就会被当成「占比 0.0%」（§10 红线）。
 * @param {*} v
 * @returns {number|null}
 */
function _shareNum(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = Number(v);
  if (!isFinite(n)) return null;
  return _roundShare(n);
}

/**
 * 十进制「四舍五入到 AUCTION_SHARE_DECIMALS 位」（半值进位），并兜住 JS 浮点误差。
 *
 * ⚠️ 为什么不能直接 `Math.round(raw * 10) / 10`：
 *   JS 浮点把 4.35 存成 4.3499999999999996、0.15 存成 0.14999999999999999，
 *   ×10 后分别得到 43.49999999999999 / 1.4999999999999998，直接 Math.round 会【向下】跑到
 *   4.3 / 0.1 —— 与用户口径「0.0435 → 4.4%」正面冲突（同一个数，除法算出来是 4.4、字面量却是 4.3）。
 *   ⇒ 在进位判定前加一个【与自身量级成比例】的极小量（1e-12 倍）：
 *       · 正好压在小数点后第 N 位为 5、被浮点压低的数（4.35 / 0.15 / 2.65 …）会被救回，正常进位；
 *       · 真正小于半值的数（如 4.3499999）离半值差得远，不会被误抬。
 * @param {number} raw
 * @returns {number|null}
 */
function _roundShare(raw) {
  const n = Number(raw);
  if (!isFinite(n)) return null;
  const f = Math.pow(10, AUCTION_SHARE_DECIMALS);
  const scaled = n * f;
  const eps = Math.abs(scaled) * 1e-12;
  const r = n >= 0 ? Math.round(scaled + eps) : -Math.round(-scaled + eps);
  return r / f;
}
