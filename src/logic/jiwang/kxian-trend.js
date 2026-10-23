// kxian-trend.js — 「昨多板K线」→「观察」的自动判定（纯函数，不碰 Vue / Supabase）
//
// ══════════════════════════════════════════════════════════════════════════════════════
// 需求口径（用户 2026-10-23 原话）：
//   「观察那里，看昨多板K线，如果是十字星，小阴，大阴，观察那里选最近多板结果，
//     如果那里是中阳，而且第一次出现中阳，那么选最近多板过程，如果前面两次中阳，
//     那么看最近多板结果，前面两次以上，都是选最近多板结果。」
//   「大阳的话看结果，小阳看过程（但是前面有两根小阳，看结果），中阴也是看结果，
//     阴线基本看结果（阴线十字星也是，阳线十字星也是）」
//   「第一次出现中阳……你要倒退看昨天是什么，如果是十字星（或者阴线），今天就是第一次中阳
//     （前面空格写上第一次中阳，后面写数值），第一次中阳看过程，第二次中阳看结果，
//     一般不用看 10 个交易日，看五个交易日……十字星作为临界点，相当于重新计算」
//
// ⇒ 归纳成下面这张表（实现即此表，改代码前先改这张表）：
//   ┌────────────┬──────────────────────────────┬──────────────┐
//   │ 昨多板K线   │ 观察                          │ kxianPrefix  │
//   ├────────────┼──────────────────────────────┼──────────────┤
//   │ 大阳        │ 最近多板结果                  │ —            │
//   │ 中阳·首次   │ 最近多板过程                  │ 第一次中阳    │
//   │ 中阳·非首次 │ 最近多板结果                  │ —            │
//   │ 小阳（<2根）│ 最近多板过程                  │ —            │
//   │ 小阳（≥2根）│ 最近多板结果                  │ —            │
//   │ 十字星      │ 最近多板结果（且是计数临界点） │ —            │
//   │ 小阴/中阴/大阴 │ 最近多板结果               │ —            │
//   └────────────┴──────────────────────────────┴──────────────┘
//
// ⚠️ 计数规则（中阳 / 小阳 共用）：
//   · 只回看 **5 个交易日**（用户明确「不用看 10 个交易日」）；
//   · 从「昨多板K线」那一天往前数，**遇到十字星就停**（用户：「十字星作为临界点，相当于重新计算」）；
//   · 遇到其它 K 线类型也停 —— 因为用户对中阳的定义是「昨天是十字星（或者阴线）⇒ 今天第一次」，
//     即只有【连续同类】才算累加。
// ══════════════════════════════════════════════════════════════════════════════════════

/** 回看窗口（交易日数）——用户口径固定 5 */
export const KXIAN_LOOKBACK_DAYS = 5;

/** 观察选项（与 JiwangBoard.vue 的 guancha 下拉同源） */
export const GUANCHA_PROCESS = '最近多板过程';
export const GUANCHA_RESULT = '最近多板结果';

/** K 线类型枚举 */
export const KXIAN_KIND = {
  DAYANG: 'dayang',        // 大阳
  ZHONGYANG: 'zhongyang',  // 中阳
  XIAOYANG: 'xiaoyang',    // 小阳
  CROSS: 'cross',          // 十字星（阳/阴都算）
  XIAOYIN: 'xiaoyin',      // 小阴
  ZHONGYIN: 'zhongyin',    // 中阴
  DAYIN: 'dayin'           // 大阴
};

/**
 * K 线文案 → 类型。输入形如「大阳3.6%」「十字星0.03%」「小阴-2.18%」。
 * ⚠️ 必须按前缀匹配（数值在前面的写法不存在，但顺序不能反：先「小阳」再「阳」同理）。
 * @param {string} label
 * @returns {string} KXIAN_KIND 之一；认不出 ⇒ ''（⛔ 不猜）
 */
export function kxianKind(label) {
  const s = String(label == null ? '' : label).trim();
  if (!s) return '';
  if (s.indexOf('十字星') === 0) return KXIAN_KIND.CROSS;
  if (s.indexOf('大阳') === 0) return KXIAN_KIND.DAYANG;
  if (s.indexOf('中阳') === 0) return KXIAN_KIND.ZHONGYANG;
  if (s.indexOf('小阳') === 0) return KXIAN_KIND.XIAOYANG;
  if (s.indexOf('小阴') === 0) return KXIAN_KIND.XIAOYIN;
  if (s.indexOf('中阴') === 0) return KXIAN_KIND.ZHONGYIN;
  if (s.indexOf('大阴') === 0) return KXIAN_KIND.DAYIN;
  return '';
}

/**
 * 往前数「连续同类」的根数（不含序列第 0 项）。
 * 遇十字星停（临界点重置），遇其它类型也停（只认连续）。
 *
 * @param {Array<{label:string}>} series 按时间【倒序】：[昨多板K线当天, 前一天, …]
 * @param {string} kind 目标类型
 * @returns {number}
 */
function countConsecutiveBefore(series, kind) {
  let n = 0;
  for (let i = 1; i < series.length; i++) {
    const k = kxianKind(series[i] && series[i].label);
    if (!k) break;                 // 数据缺口 ⇒ 停（⛔ 不跳过继续数，§10）
    if (k === KXIAN_KIND.CROSS) break;   // 十字星是临界点，重新计算
    if (k !== kind) break;         // 只认连续同类
    n++;
  }
  return n;
}

/**
 * 由「昨多板K线」序列推导观察 + 前缀标注。
 *
 * @param {Array<{ymd?:string, label:string}>} series
 *        按时间【倒序】，series[0] = 昨多板K线那一天（即前一交易日），series[1] = 再前一天…
 *        最多只需要 KXIAN_LOOKBACK_DAYS + 1 项。
 * @returns {{guancha:string, kxianPrefix:string, isFirstZhongyang:boolean}|null}
 *          series 为空 / 首项认不出 K 线类型 ⇒ null（⛔ 不猜，前台保持 '-'）
 */
export function deriveGuanchaByKxian(series) {
  const list = Array.isArray(series) ? series : [];
  if (list.length === 0) return null;

  const cur = kxianKind(list[0] && list[0].label);
  if (!cur) return null;

  // 中阳：只有「第一次」看过程，第 2 次起都看结果
  if (cur === KXIAN_KIND.ZHONGYANG) {
    const n = countConsecutiveBefore(list, KXIAN_KIND.ZHONGYANG);
    if (n === 0) {
      return { guancha: GUANCHA_PROCESS, kxianPrefix: '第一次中阳', isFirstZhongyang: true };
    }
    return { guancha: GUANCHA_RESULT, kxianPrefix: '', isFirstZhongyang: false };
  }

  // 小阳：前面已有 2 根小阳 ⇒ 看结果，否则看过程
  if (cur === KXIAN_KIND.XIAOYANG) {
    const n = countConsecutiveBefore(list, KXIAN_KIND.XIAOYANG);
    return {
      guancha: n >= 2 ? GUANCHA_RESULT : GUANCHA_PROCESS,
      kxianPrefix: '',
      isFirstZhongyang: false
    };
  }

  // 大阳 / 十字星 / 阴线（小阴 / 中阴 / 大阴）⇒ 一律看结果
  return { guancha: GUANCHA_RESULT, kxianPrefix: '', isFirstZhongyang: false };
}
