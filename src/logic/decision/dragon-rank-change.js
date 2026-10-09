// dragon-rank-change.js — 「龙标名次变化」徽标（Logic 层，§15 独立业务模块）
//
// ══════════════════════════════════════════════════════════════════════════════════════
// ★★ [DRAGON-RANK-CHANGE 2026-10-09 用户口径] 需求原话 ★★
// ══════════════════════════════════════════════════════════════════════════════════════
//   「在决策看板那里，买点和卖点的股票旁边的龙一，龙二……等龙标旁，添加 +1，-2，-3……等
//     排名变化数字，比如昨天是龙一，今天开出来是龙三，那就是 1-3=-2，代表下滑了 2 个名次，
//     昨日是龙五，今日是龙二，上升了 5-2=3，代表上升了 3 个名次，龙二 +3，这样标注
//     （数字前有加减号，不用背景色，上升用红色，下降用绿色），我就知道那只股票的名称变化，
//     买点和卖点看板都要标。要简洁，其它不变。」
//
// ⇒ 口径（全部是用户原话的直译，⛔ 不要「优化」成别的写法）：
//   ① 数值 = 【昨日名次 − 今日名次】：正 = 上升（名次数字变小），负 = 下降；
//      用户原话的两笔账：昨日龙一→今日龙三 = 1−3 = −2（下滑 2 名）；昨日龙五→今日龙二 = 5−2 = +3；
//   ② 文案 = 【带符号】的整数（'+3' / '-2'）——⛔ 不写「上升 3 个名次」这类文字（用户要简洁），
//      符号由本层加，组件只 {{ }} 输出；
//   ③ 配色 = 只改【文字颜色】、⛔ 不加底色（上升红 / 下降绿，A 股口径；⛔ 与欧美相反，别顺手改绿）；
//   ④ 名次 = 【题材内】按十日涨幅降序的龙位（= 决策看板行上那个「龙几」，
//      唯一来源 auction/dragon-rank.js#computeDragonRankMap，§6 单一真相，⛔ 不另算一套）。
//
// ── 为什么「昨日名次」要单独取一份数据 ──────────────────────────────────────────────────
//   dragon-rank 的主状态（dragonState）是【单日期】的：它只持有「当前展示日 D」的十日涨幅
//   （getDragonRangePct(D) 在 date 不匹配时返回 null，见 dragon-rank.js 的 DATE 闸门）。
//   而昨日名次要用【前一交易日】的十日涨幅 —— 它的窗口是 [T-10, T-1]，与今天的 [T-9, T]
//   根本不是同一份数据，⛔ 不能拿今天的涨幅去倒推昨天的名次。
//   ⇒ 必须按日把前一交易日的区间涨幅读回来、按【与今日完全同一套组装】重算一次龙位。
//      取数与组装在 dragon-rank-change-store.js（异步 / 会读云端）；本文件只放两件事：
//        · 纯映射（可单测，§22）：formatDragonRankDelta / dragonDeltaOf / applyDragonRankChange；
//        · 状态（模块级单例，§6 一份）：dragonRankChangeState = 前一交易日的龙位表。
//      ⚠️ 本文件【绝不 import decision-collect.js】—— collect 要 import 本文件的映射来挂字段，
//         反向再 import 就构成 ESM 循环依赖（本项目把「循环依赖 16」当构建基线，见
//         decision-mode.js 文件头）。所以「读云端 + 调 collect」那一侧只能放 store 文件里。
//
// §10：以下任一情形 ⇒ 一律【不渲染】徽标（text = ''），⛔ 绝不拿 0 或 '-' 冒充「名次没变」：
//   · 昨日名次表还没算出来（前一交易日数据未就绪 / 云端读失败）；
//   · 今天没有龙位（龙标本身就没渲染）、或昨天没有龙位（不在任何成组题材里）；
//   · 昨今【不在同一个题材】—— 龙位是【题材内】的相对名次，换了题材两个数字不同源、相减没有意义；
//   · 名次没变（delta === 0）—— 用户口径「要简洁」，没变化就不占位置（不是「未知」，是「无需标注」）。
// §21：文案 / 配色档 / 悬停说明都在本层算好（text / tone / title），组件只拼类名。
// §34：本状态是【派生展示数据】（由行情算出来的），不是 UI 展开态 ⇒ 放 Logic 层，⛔ 不进 localStorage（§8）。

import { reactive } from 'vue';
import { getDragonLabel } from '../auction/dragon-rank.js';

/** 上升（名次数字变小）→ 红（A 股口径：涨红跌绿） */
export const DRAGON_DELTA_TONE_UP = 'up';
/** 下降（名次数字变大）→ 绿 */
export const DRAGON_DELTA_TONE_DOWN = 'down';

/**
 * 【前一交易日】的题材龙位表（模块级单例，全应用一份，§6）。
 *   date    —— 这份表属于哪一个交易日（= 决策看板当前展示日的前一交易日）
 *              ⚠️ 与展示日比对由【调用方】做（collect 手里就有 prevDate）：只有 date 对上才可以用，
 *                 否则会把「上上一天的名次」当成「昨天的名次」算出一个假的变化值。
 *   map     —— Map<股票名, {rank, seq, pct, topic, groupSize}>（computeDragonRankMap 的原样输出）
 *   loaded  —— 是否成功算出来过（false ⇒ 屏上一枚徽标都不显示）
 *   version —— 换引用次数（排查 / 指纹用）
 */
export const dragonRankChangeState = reactive({ date: '', map: new Map(), loaded: false, version: 0 });

/**
 * 发布前一交易日的龙位表（只由 dragon-rank-change-store 在【算成功之后】调用）。
 * ⚠️ 必须【换引用】（新建 Map）而不是原地改，才能驱动看板重算 —— 与 trendOpenSet 同一范式。
 * @param {string} date 前一交易日 YYYY-MM-DD
 * @param {Map} map computeDragonRankMap 的输出
 */
export function publishPrevDragonRank(date, map) {
  dragonRankChangeState.date = String(date || '');
  dragonRankChangeState.map = (map instanceof Map) ? map : new Map();
  dragonRankChangeState.loaded = true;
  dragonRankChangeState.version += 1;
}

/**
 * 清空（切日期 / 前一交易日算不出来时）。
 * §10：清空之后屏上【不显示】任何徽标 —— 绝不能留着上一个展示日的名次，
 *   那会显示成「昨天到今天的名次变化」，而它其实是「前天到昨天的」。
 */
export function clearPrevDragonRank() {
  if (!dragonRankChangeState.date && dragonRankChangeState.map.size === 0 && !dragonRankChangeState.loaded) return;
  dragonRankChangeState.date = '';
  dragonRankChangeState.map = new Map();
  dragonRankChangeState.loaded = false;
  dragonRankChangeState.version += 1;
}

/** 名次必须是 >= 1 的整数（§10：null / undefined / 0 / NaN / 空串 → 一律视为「没有名次」） */
function _rankOf(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!isFinite(n) || n < 1) return null;
  return Math.round(n);
}

/**
 * 【名次变化】唯一实现（§6）。
 *
 * 用户原话的两笔账都在这里成立：
 *   昨日龙一 → 今日龙三 ⇒ 1 − 3 = −2（下降 2 个名次，绿）
 *   昨日龙五 → 今日龙二 ⇒ 5 − 2 = +3（上升 3 个名次，红）
 *
 * @param {number|null} prevRank  昨日题材内龙位（1 起；null / 缺失 = 不知道）
 * @param {number|null} todayRank 今日题材内龙位
 * @returns {{delta:number, text:string, tone:string}|null}
 *          null = 无可比（任一侧缺名次 / 名次没变）⇒ 调用方【不渲染】徽标
 */
export function formatDragonRankDelta(prevRank, todayRank) {
  const p = _rankOf(prevRank);
  const t = _rankOf(todayRank);
  if (p === null || t === null) return null;
  const delta = p - t;                       // 正 = 名次数字变小 = 上升
  if (delta === 0) return null;              // 没变化 → 不占位置（用户口径「要简洁」）
  return {
    delta: delta,
    text: delta > 0 ? ('+' + delta) : String(delta),
    tone: delta > 0 ? DRAGON_DELTA_TONE_UP : DRAGON_DELTA_TONE_DOWN
  };
}

/**
 * 悬停说明（纯文案，§21 不在组件里拼句子）。
 * 写清【两个名次本身】，用户核对时不必自己去翻昨天。
 */
function _deltaTitle(prevRank, todayRank, delta) {
  const dir = delta > 0
    ? ('上升 ' + delta + ' 个名次')
    : ('下降 ' + Math.abs(delta) + ' 个名次');
  return '题材内龙位：昨日 ' + getDragonLabel(prevRank) + ' → 今日 ' + getDragonLabel(todayRank) +
    '（' + dir + '）';
}

/** 无徽标时的行字段（⛔ 用空串而不是 null：模板 v-if 一个判断就够，与其它徽标同一口径 §10） */
function _emptyFields() {
  return { text: '', tone: '', title: '' };
}

/**
 * 给【一行】算名次变化字段（纯函数）。
 *
 * ⚠️ 今日 / 昨日两个名次都从【龙位表】里取（而不是直接用行上的 dragonLabel）：
 *   行上的 dragonRank 就是这两张表给的，直接查表能顺带拿到 topic，从而做「题材是否一致」这个
 *   必须的判断（见下面的 §10 注释）——⛔ 那一项判断不能省。
 *
 * @param {object} row 决策看板的一行（买点 pick / 卖点 item；只用 name）
 * @param {Map|null} prevRankMap  前一交易日的龙位表（dragonRankChangeState.map）
 * @param {Map|null} todayRankMap 今日龙位表（collectDecisionData 里的 dragonMap）
 * @returns {{text:string, tone:string, title:string}}
 */
export function dragonDeltaOf(row, prevRankMap, todayRankMap) {
  if (!row || !prevRankMap || !todayRankMap) return _emptyFields();
  if (!prevRankMap.size || !todayRankMap.size) return _emptyFields();
  const name = String(row.name || '').trim();
  if (!name) return _emptyFields();

  const today = todayRankMap.get(name) || null;
  const prev = prevRankMap.get(name) || null;
  // 今天没有龙位（创业板 / 科创板弃权、或今天不在成组题材里）⇒ 行上根本没有龙标，无处可标；
  // 昨天没有龙位 ⇒ 没有「昨日名次」可比（§10 不猜它昨天排第几）。
  if (!today || !prev) return _emptyFields();

  const d = formatDragonRankDelta(prev.rank, today.rank);
  if (!d) return _emptyFields();

  // 🔴 题材必须一致：龙位是【题材内】的相对名次。换题材之后「昨日龙一」与「今日龙三」
  //    分属两个不同的排行榜，相减出来的数字没有意义（会显示成一个看着很像真的假变化）。
  //    §10：宁可什么都不显示，也不给一个错的数字。
  const prevTopic = String(prev.topic || '').trim();
  const todayTopic = String(today.topic || '').trim();
  if (prevTopic !== todayTopic) return _emptyFields();

  return { text: d.text, tone: d.tone, title: _deltaTitle(prev.rank, today.rank, d.delta) };
}

/**
 * 把名次变化字段写回行上（collect 的行遍历唯一出口，§6 一处收口）。
 * 无可比时写空串 ⇒ 组件 v-if 不渲染（§10）。
 *
 * @param {object} row 行（会被原地写入三个字段）
 * @param {Map|null} prevRankMap 前一交易日龙位表
 * @param {Map|null} todayRankMap 今日龙位表
 * @returns {object} 同一个行对象（方便链式 / 调试）
 */
export function applyDragonRankChange(row, prevRankMap, todayRankMap) {
  const f = dragonDeltaOf(row, prevRankMap, todayRankMap);
  row.dragonDeltaText = f.text;
  row.dragonDeltaTone = f.tone;
  row.dragonDeltaTitle = f.title;
  return row;
}
