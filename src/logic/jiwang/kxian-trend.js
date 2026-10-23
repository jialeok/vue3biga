// kxian-trend.js — 「昨多板K线」→「观察」的自动判定（纯函数，不碰 Vue / Supabase）
//
// ══════════════════════════════════════════════════════════════════════════════════════
// 需求口径（用户 2026-10-23 原话，第二版 —— 以此为准）
//   「第一次中阳 2.3%，写成这样，不要重复的，你写前缀的时候看前面是不是十字星，
//     如果上个交易日写的是十字星，那么今天昨多板k线前缀就写上，第一次就可以了，
//     十字星作为临界点，所以你扫描下，前三天的k线，比如前面两天是十字星+小阳，
//     今天的昨多板k线是中阳，那就看结果，相当于十字星+小阳+中阳，前缀应该写，
//     十字星0.5%+小阳1.2%，有数值，后面写中阳2.5%，这样更清晰，也就是三天一起」
//
// ⇒ 归纳成下面这张表（实现即此表，改代码前先改这张表）：
//   ┌──────────────────────────────────┬────────────────┬───────────────────────────────────┐
//   │ 昨多板K线                        │ 观察            │ kxianPrefix（前缀位）              │
//   ├──────────────────────────────────┼────────────────┼───────────────────────────────────┤
//   │ 中阳·上个交易日是十字星/阴线       │ 最近多板过程     │ 「第一次」→ 显示 第一次中阳 2.5%    │
//   │ 中阳·上个交易日是阳线             │ 最近多板结果     │ 序列 → 显示 十字星0.5%+小阳1.2%+中阳2.5% │
//   │ 小阳（前面 <2 根）               │ 最近多板过程     │ 空                                 │
//   │ 小阳（前面 ≥2 根）               │ 最近多板结果     │ 空                                 │
//   │ 大阳 / 十字星 / 小阴·中阴·大阴    │ 最近多板结果     │ 空                                 │
//   │ 中阳·小阳 但上个交易日数据缺失     │ 无法判断 ⇒ 不自动填（前台 '-'）                     │
//   └──────────────────────────────────┴────────────────┴───────────────────────────────────┘
//
// ⚠️ 四个关键点（前两版做错过，别再犯）：
//   ① 「第一次中阳」的判据 = **上个交易日是十字星或阴线**，不是「往前数连续中阳」。
//      反例：十字星 + 小阳 + 今天中阳 ⇒ 昨天是小阳，**不是第一次**，要看结果。
//      用户原话「相当于十字星+小阳+中阳，那就看结果」讲的就是这个。
//   ② 前缀显示的是【K 线序列 + 各自数值】，不是单一标签。
//      从最近一个十字星/阴线开始（它是临界点，且含它自己），最多取 3 天，用 '+' 连接。
//   ③ 「第一次」是标记词不是 K 线段 ⇒ 拼接时写成「第一次中阳 2.5%」，
//      ⛔ 不能写成「第一次+中阳2.5%」，更不能「第一次中阳+中阳2.5%」（重复）。
//   ④ 序列前缀只用于【中阳·非首次】这一种情况 —— 它是唯一需要「解释为什么不是第一次」
//      的场景；其余 K 线不加前缀，否则看板那一列每天都是长串，反而看不清。
// ══════════════════════════════════════════════════════════════════════════════════════

/** 回看窗口（交易日数）——用户口径「看五个交易日」 */
export const KXIAN_LOOKBACK_DAYS = 5;

/** 前缀里最多带几天 K 线（用户：「扫描下，前三天的k线」） */
export const KXIAN_PREFIX_MAX_DAYS = 3;

/** 「第一次」标记词（前缀位） */
export const PREFIX_FIRST = '第一次';

/** 前缀片段分隔符 / 「第一次」与 K 线本体之间的分隔符 */
export const KXIAN_PART_SEP = '+';
export const KXIAN_FIRST_SEP = ' ';

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
 * K 线类型名，按匹配优先级排列。
 * ⚠️ 「十字星」必须排在最前（它以「星」结尾，但以「十」开头，不会被其它词前缀命中，
 *    排序主要是可读性；真正必须靠前的是「小阳/小阴」这类同首字的短词与长词之争，
 *    长短不冲突，所以按长到短排即可）。
 */
const KIND_WORDS = ['十字星', '大阳', '中阳', '小阳', '小阴', '中阴', '大阴'];

/**
 * K 线文案 → 类型。输入形如「大阳3.6%」「十字星0.03%」「小阴-2.18%」。
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
 * 是否为「临界点」K 线 —— 十字星与阴线（小阴/中阴/大阴）。
 * 用户：「十字星作为临界点」「如果是十字星（或者阴线），今天就是第一次中阳」
 * @param {string} kind
 * @returns {boolean}
 */
export function isBoundaryKind(kind) {
  return kind === KXIAN_KIND.CROSS
    || kind === KXIAN_KIND.XIAOYIN
    || kind === KXIAN_KIND.ZHONGYIN
    || kind === KXIAN_KIND.DAYIN;
}

/**
 * 往前数「连续同类」的根数（不含序列第 0 项）。
 * 遇十字星停（临界点重置），遇其它类型也停（只认连续），遇数据缺口也停（§10 不跳过）。
 *
 * @param {Array<{label:string}>} series 按时间【倒序】：[昨多板K线当天, 前一天, …]
 * @param {string} kind 目标类型
 * @returns {number}
 */
function countConsecutiveBefore(series, kind) {
  let n = 0;
  for (let i = 1; i < series.length; i++) {
    const k = kxianKind(series[i] && series[i].label);
    if (!k) break;                       // 数据缺口 ⇒ 停（⛔ 不跳过继续数，§10）
    if (k === KXIAN_KIND.CROSS) break;   // 十字星是临界点，重新计算
    if (k !== kind) break;               // 只认连续同类
    n++;
  }
  return n;
}

/**
 * 拼「前面几天」的 K 线序列前缀（带各自数值）。
 *
 * 规则：从 series[1] 往前扫，扫到【最近一个十字星或阴线】为止（含它自己），
 *      最多 KXIAN_PREFIX_MAX_DAYS 天，最后按时间正序用 '+' 连接。
 *      例：series = [中阳2.5%, 小阳1.2%, 十字星0.5%, …] ⇒ 「十字星0.5%+小阳1.2%」
 *
 * @param {Array<{label:string}>} series 按时间【倒序】
 * @returns {string} 无可用前序时返回 ''
 */
export function buildKxianPrefix(series) {
  const list = Array.isArray(series) ? series : [];
  const parts = [];
  for (let i = 1; i < list.length && parts.length < KXIAN_PREFIX_MAX_DAYS; i++) {
    const item = list[i] || {};
    const label = String(item.label == null ? '' : item.label).trim();
    const kind = kxianKind(label);
    if (!kind) break;                    // 数据缺口 ⇒ 停（⛔ 不跨过空格继续拼，§10）
    parts.push(label);
    if (isBoundaryKind(kind)) break;     // 到临界点就停（含它自己）
  }
  return parts.reverse().join(KXIAN_PART_SEP);
}

/**
 * 把 K 线文案拆成「类型词 + 数值尾巴」。认不出类型词时 word=''。
 * @param {string} text
 * @returns {{word:string, rest:string}}
 */
function splitKindWord(text) {
  const s = String(text == null ? '' : text).trim();
  for (let i = 0; i < KIND_WORDS.length; i++) {
    const w = KIND_WORDS[i];
    if (s.indexOf(w) === 0) return { word: w, rest: s.slice(w.length) };
  }
  return { word: '', rest: s };
}

/**
 * 去掉前缀尾部与 K 线本体重复的类型词。
 * 场景：旧数据/人工填的前缀写着「第一次中阳」，本体又是「中阳2.3%」⇒ 会显示成
 *       「第一次中阳+中阳2.3%」。用户明确要求「不要重复的」，这里兜住。
 *
 * @param {string} prefix
 * @param {string} kxian
 * @returns {string}
 */
function stripDuplicatedKind(prefix, kxian) {
  const { word } = splitKindWord(kxian);
  if (!word) return prefix;
  if (prefix.length <= word.length) return prefix;
  if (prefix.slice(-word.length) === word) return prefix.slice(0, -word.length);
  return prefix;
}

/**
 * 前缀 + K 线本体 → 最终展示文案（单一出口，⛔ 各处不要自己拼）。
 *
 *   ('第一次', '中阳2.5%')            ⇒ '第一次中阳 2.5%'
 *   ('十字星0.5%+小阳1.2%', '中阳2.5%') ⇒ '十字星0.5%+小阳1.2%+中阳2.5%'
 *   ('', '中阳2.5%')                  ⇒ '中阳2.5%'
 *
 * @param {string} prefix
 * @param {string} kxian
 * @returns {string}
 */
export function formatKxianWithPrefix(prefix, kxian) {
  const k = String(kxian == null ? '' : kxian).trim();
  let p = String(prefix == null ? '' : prefix).trim();
  if (!k) return p;
  if (!p) return k;

  p = stripDuplicatedKind(p, k).trim();
  if (!p) return k;

  if (p === PREFIX_FIRST) {
    // 「第一次」是标记词 ⇒ 贴着 K 线类型写，数值前留一个空格：第一次中阳 2.5%
    // ⚠️ 本体认不出类型词（如「普涨」）时直接贴着写，⛔ 不许在中间硬塞一个空格
    const { word, rest } = splitKindWord(k);
    return word && rest ? PREFIX_FIRST + word + KXIAN_FIRST_SEP + rest : PREFIX_FIRST + k;
  }
  return p + KXIAN_PART_SEP + k;
}

/**
 * 由「昨多板K线」序列推导观察 + 前缀标注。
 *
 * @param {Array<{ymd?:string, label:string}>} series
 *        按时间【倒序】，series[0] = 昨多板K线那一天（即前一交易日），series[1] = 再前一天…
 *        最多只需要 KXIAN_LOOKBACK_DAYS + 1 项。
 * @returns {{guancha:string, kxianPrefix:string, isFirstZhongyang:boolean}|null}
 *          series 为空 / 首项认不出 K 线类型 / 中阳·小阳但上个交易日数据缺失 ⇒ null
 *          （⛔ 不猜，前台保持 '-'）
 */
export function deriveGuanchaByKxian(series) {
  const list = Array.isArray(series) ? series : [];
  if (list.length === 0) return null;

  const cur = kxianKind(list[0] && list[0].label);
  if (!cur) return null;

  // ① 大阳 / 十字星 / 阴线：不看前面，一律看结果
  if (cur === KXIAN_KIND.DAYANG || isBoundaryKind(cur)) {
    return { guancha: GUANCHA_RESULT, kxianPrefix: '', isFirstZhongyang: false };
  }

  // ② 中阳 / 小阳：必须先知道上个交易日是什么，否则「第几次」无从判断
  //    ⛔ 不许拿「缺口」当「不是中阳/小阳」直接判过程，那是拿缺失冒充真值（§10）
  const prevKind = kxianKind(list[1] && list[1].label);
  if (!prevKind) return null;

  // ③ 中阳：上个交易日是十字星/阴线 ⇒ 第一次（看过程）；是阳线 ⇒ 看结果
  if (cur === KXIAN_KIND.ZHONGYANG) {
    if (isBoundaryKind(prevKind)) {
      return { guancha: GUANCHA_PROCESS, kxianPrefix: PREFIX_FIRST, isFirstZhongyang: true };
    }
    return {
      guancha: GUANCHA_RESULT,
      kxianPrefix: buildKxianPrefix(list),
      isFirstZhongyang: false
    };
  }

  // ④ 小阳：前面已有 2 根小阳 ⇒ 看结果，否则看过程
  const n = countConsecutiveBefore(list, KXIAN_KIND.XIAOYANG);
  return {
    guancha: n >= 2 ? GUANCHA_RESULT : GUANCHA_PROCESS,
    kxianPrefix: '',
    isFirstZhongyang: false
  };
}
