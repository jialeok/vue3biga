// decision-chart-judge.js — 手动「竞价图形判断」的【唯一实现】（Logic 层，纯函数，可单测）
//
// ══════════════════════════════════════════════════════════════════════════════════════
// ★★ [CHART-JUDGE 2026-10-09 用户口径] 为什么会有这个文件 ★★
// ══════════════════════════════════════════════════════════════════════════════════════
// 用户原话：
//   「我希望在决策看板那里，添加一个组件，这个组件有三个选项供我选择，一个是默认请选择，
//     一个是竞图符合（预判当天走势会好），一个是竞图不符合（预判当天走势不好）。因为我发现选票是
//     没问题，但是里面买点和卖点，还是把握有些不准确，所以只能靠手动观察竞价图形变化，
//     我想自己看竞价图形进行买和卖，加入我说的那两个选项。这两个选项，会直接影响到竞价买，
//     竞价卖，尾盘买和尾盘卖，这四个选项。也就是以我看到当天股票的竞价图形然后做判断为准。」
//   「颜色显著些，可能这是我作为买卖点的最终判断。原来规则作为辅助（因为错误多，所以不得不
//     重新设计这一机制）。原来规则不变。你添加这个功能。」
//
// ⇒ 语义：**用户的图形判断是最终决定权，规则降为辅助**。一句话概括这张映射表：
//     【图好 ⇒ 敢买敢留；图差 ⇒ 买得保守、卖得果断。默认 ⇒ 一个字都不动。】
//
//     侧别   判断          结果标签          为什么
//     ────  ────────────  ──────────────  ──────────────────────────────────────
//     买点   默认          原标签           完全按原规则
//     买点   符合(ok)      【竞价买】        图好 ⇒ 有性价比、溢价更高，竞价就动手
//     买点   不符(bad)     【尾盘买】        图差 ⇒ 别追开盘，等尾盘更安全
//     卖点   默认          原标签           完全按原规则
//     卖点   符合(ok)      【尾盘卖】        图好 ⇒ 当天走势好，尾盘卖获利更高
//     卖点   不符(bad)     【竞价卖】        图差 ⇒ 果断出局，别拖着
//
//   ⚠️ 注意买点与卖点的「好 / 差」是【同一个方向】，不是各写一套：
//      图好 → 买点选【敢买】那档（竞价买）、卖点选【敢留】那档（尾盘卖）；
//      图差 → 买点选【保守】那档（尾盘买）、卖点选【果断】那档（竞价卖）。
//      ⇒ 同一只票同一天只有一个判断，买卖两侧自然一致（表主键 = date + stock，见 db/create_decision_chart_judge.sql）。
//
// ── 只对【四种基础标签】生效（用户口径「直接影响到竞价买，竞价卖，尾盘买和尾盘卖，这四个选项」）──
//   ✅ 买点：竞价买 / 尾盘买   ✅ 卖点：竞价卖 / 尾盘卖
//   ⛔ 其余【特殊标签】一律不动 —— 它们各自承载了额外的信息，覆盖掉就是丢信息：
//      买点：尾盘买（先卖后买）〔带「开盘先卖」这一半〕、下杀买（竞价异常）、补涨竞价买、龙一字持有
//      卖点：竞价卖（先卖后买）、10分钟时卖、跟龙竞价卖、竞价涨停卖、持有
//   ⇒ 这些行【不渲染选择器】（`chartJudgeTarget === false`），规则说明里也写明了原因。
//
// §6：标签 / 配色档不在这里重新写字面量，全部从 decision-rules.js 的既有常量取 ——
//     以后改标签名，这里与规则实现【必须同时变】，不可能只改一边。
// §10：缺数据（判断查不到 / 判断值不认识）一律回落【默认】，⛔ 绝不猜一个「符合」出来。
// §21：整段说明文字在本文件拼好，组件只负责渲染，⛔ 组件不拼规则句子。

import {
  BUY_NOW_TAG,
  BUY_LATE_TAG,
  BUY_LATE_SWAP_TAG,
  BUY_DIVE_TAG,
  BUY_MAKEUP_TAG,
  DRAGON_YIZI_HOLD_TAG,
  BUY_ACTION_TONE_NOW,
  BUY_ACTION_TONE_LATE,
  SELL_OUT_TAG,
  SELL_LATE_TAG,
  SELL_OUT_SWAP_TAG,
  SELL_TEN_MIN_TAG,
  SELL_FOLLOW_DRAGON_TAG,
  SELL_LIMIT_UP_TAG,
  SELL_ACTION_TONE_OUT,
  SELL_ACTION_TONE_LATE,
  HOLD_TAG
} from './decision-rules.js';

// ══════════════════════════════════════════════════════════════════════════════════════
// 取值域（§6 唯一实现：Data 层只存字符串，语义【只在这里】定义）
// ══════════════════════════════════════════════════════════════════════════════════════
/** 默认：不做手动判断（= 表里没有这一行）。⛔ 它不是「一个判断值」，是「没有判断」。 */
export const JUDGE_DEFAULT = 'default';
/** 竞价图符合（预判当天走势好） */
export const JUDGE_OK = 'ok';
/** 竞价图不符合（预判当天走势不好） */
export const JUDGE_BAD = 'bad';

/** 侧别常量（与 decision-rules.js / decision-collect.js 的买卖两侧同名概念） */
export const SIDE_BUY = 'buy';
export const SIDE_SELL = 'sell';

/** 三档短标签（选择器上显示的那个字；长解释放 title / 规则面板） */
export const JUDGE_DEFAULT_LABEL = '默认';
export const JUDGE_OK_LABEL = '符合';
export const JUDGE_BAD_LABEL = '不符';

/**
 * 选择器的三个选项（§6 唯一实现：⛔ 组件里不许再写一遍 labels / 顺序）。
 * label = 胶囊上显示的短字（省空间）；title = 悬停解释（完整口径）。
 */
export const CHART_JUDGE_OPTIONS = [
  { value: JUDGE_DEFAULT, label: JUDGE_DEFAULT_LABEL, title: '默认：不改动，完全按原有规则给出的标签显示' },
  { value: JUDGE_OK, label: JUDGE_OK_LABEL, title: '竞价图符合（预判当天走势会好）⇒ 买点改【' + BUY_NOW_TAG + '】、卖点改【' + SELL_LATE_TAG + '】' },
  { value: JUDGE_BAD, label: JUDGE_BAD_LABEL, title: '竞价图不符合（预判当天走势不好）⇒ 买点改【' + BUY_LATE_TAG + '】、卖点改【' + SELL_OUT_TAG + '】' }
];

/** 选择器整枚胶囊的悬停说明（组件只用这一条，⛔ 不在模板里拼字符串 §21） */
export const CHART_JUDGE_CAPTION = '竞价图';
export const CHART_JUDGE_TITLE =
  '手动「竞价图形判断」：以你看当天这只票的【竞价图形】为准（买点 / 卖点共用同一个判断，刷新不丢）\n' +
  '· 默认 = 完全按原有规则显示\n' +
  '· 符合 = 预判今天走势好 ⇒ 买点【' + BUY_NOW_TAG + '】/ 卖点【' + SELL_LATE_TAG + '】\n' +
  '· 不符 = 预判今天走势不好 ⇒ 买点【' + BUY_LATE_TAG + '】/ 卖点【' + SELL_OUT_TAG + '】\n' +
  '（只有【' + BUY_NOW_TAG + ' / ' + BUY_LATE_TAG + ' / ' + SELL_OUT_TAG + ' / ' + SELL_LATE_TAG +
  '】这四种标签受它控制；其余特殊标签不受影响）';

/** 规则面板里点名「不受手动判断影响」的特殊标签（文案用，⛔ 不留字面量） */
const _SPECIAL_TAGS_TEXT = [
  BUY_LATE_SWAP_TAG, BUY_DIVE_TAG, BUY_MAKEUP_TAG, DRAGON_YIZI_HOLD_TAG,
  SELL_OUT_SWAP_TAG, SELL_TEN_MIN_TAG, SELL_FOLLOW_DRAGON_TAG, SELL_LIMIT_UP_TAG, HOLD_TAG
].join(' / ');

/** 规则面板里写的表名（纯文档用；Data 层的 CHART_JUDGE_TABLE 是同一个表，见 db/create_decision_chart_judge.sql） */
const _TABLE_NAME_TEXT = 'decision_chart_judge';

/**
 * 任意输入 → 合法判断值（§10 不猜）。
 * 不认识的（null / undefined / '' / 'xxx' / 大小写异常）一律回落【默认】。
 * @param {*} v
 * @returns {string} JUDGE_DEFAULT | JUDGE_OK | JUDGE_BAD
 */
export function normalizeChartJudge(v) {
  if (v === JUDGE_OK) return JUDGE_OK;
  if (v === JUDGE_BAD) return JUDGE_BAD;
  return JUDGE_DEFAULT;
}

/**
 * 这一行的原标签，是不是【手动判断能覆盖的四种基础标签】之一？
 *
 * ⛔ 只有这里说 true 的行，UI 才会渲染那枚三档选择器 ——
 *    所以「哪些标签受控」这条口径只有一处（§6），组件 / 规则文案都从这里派生。
 *
 * @param {string} side SIDE_BUY | SIDE_SELL
 * @param {string} actionTag 该行的原标签（买点 = buyActionTag；卖点 = sellActionTag）
 * @returns {boolean}
 */
export function isChartJudgeTarget(side, actionTag) {
  const t = String(actionTag === null || actionTag === undefined ? '' : actionTag);
  if (!t) return false;
  if (side === SIDE_BUY) return t === BUY_NOW_TAG || t === BUY_LATE_TAG;
  if (side === SIDE_SELL) return t === SELL_OUT_TAG || t === SELL_LATE_TAG;
  return false;
}

/**
 * 判断 → 目标标签 + 配色档（上表那三行的【唯一实现】）。
 *
 * §10：judge 非法 / 缺省 ⇒ 返回 `{ judge: '默认', tag: '', tone: '' }`，
 *      tag 给空串表示「不改动」—— 调用方据此判断「要不要覆盖」，⛔ 不猜一个标签出来。
 *
 * @param {string} side SIDE_BUY | SIDE_SELL
 * @param {string} judge JUDGE_DEFAULT | JUDGE_OK | JUDGE_BAD
 * @returns {{judge:string, tag:string, tone:string, label:string, why:string}}
 */
export function resolveChartJudge(side, judge) {
  const j = normalizeChartJudge(judge);
  if (j === JUDGE_DEFAULT) {
    return { judge: j, tag: '', tone: '', label: JUDGE_DEFAULT_LABEL, why: '' };
  }
  if (side === SIDE_BUY) {
    return j === JUDGE_OK
      // 图好 ⇒ 竞价就买（有性价比、溢价更高）
      ? { judge: j, tag: BUY_NOW_TAG, tone: BUY_ACTION_TONE_NOW, label: JUDGE_OK_LABEL, why: '更有性价比、溢价更高' }
      // 图差 ⇒ 别追开盘，等尾盘更安全
      : { judge: j, tag: BUY_LATE_TAG, tone: BUY_ACTION_TONE_LATE, label: JUDGE_BAD_LABEL, why: '更安全，别追开盘' };
  }
  if (side === SIDE_SELL) {
    return j === JUDGE_OK
      // 图好 ⇒ 当天走势好，尾盘卖获利更高
      ? { judge: j, tag: SELL_LATE_TAG, tone: SELL_ACTION_TONE_LATE, label: JUDGE_OK_LABEL, why: '走势好、尾盘获利更高' }
      // 图差 ⇒ 果断出局
      : { judge: j, tag: SELL_OUT_TAG, tone: SELL_ACTION_TONE_OUT, label: JUDGE_BAD_LABEL, why: '果断出局' };
  }
  return { judge: JUDGE_DEFAULT, tag: '', tone: '', label: JUDGE_DEFAULT_LABEL, why: '' };
}

/**
 * 逐行说明文字（§21：整段在 Logic 层拼好，组件只渲染）。
 *
 * ⚠️ 原标签与目标标签【相同】时也要如实说「与原规则一致」——
 *    否则用户会以为「我选了符合，怎么什么都没变、是不是没保存」。
 *
 * @param {string} side
 * @param {string} judge
 * @param {string} originalTag 原规则给的标签
 * @param {string} newTag 手动判断后的标签（可能与 originalTag 相同）
 * @returns {string} 默认档返回空串（不产说明，保持行内干净）
 */
export function chartJudgeNoteText(side, judge, originalTag, newTag) {
  const r = resolveChartJudge(side, judge);
  if (r.judge === JUDGE_DEFAULT) return '';
  const seen = (r.judge === JUDGE_OK)
    ? ('竞价图符合（预判当天走势好）')
    : ('竞价图不符合（预判当天走势不好）');
  const head = '🔴【手动「竞价图形判断」· 以你看的图为准】你选了【' + seen + '】⇒ ';
  const same = (String(originalTag || '') === String(newTag || ''));
  const body = same
    ? ('本行标签仍是【' + newTag + '】（' + r.why + '）—— 与原规则一致，按此执行。')
    : ('本行标签由原规则的【' + originalTag + '】改为【' + newTag + '】（' + r.why + '）。');
  return head + body + '（原有规则一条都没改，只是给手动判断让位。）';
}

/** 把一个题材块（wrapper：`{ block, picks }`）里的选股逐行套用判断 */
function _applyBlock(blockWrapper, side, map, seen) {
  if (!blockWrapper || !Array.isArray(blockWrapper.picks)) return;
  blockWrapper.picks.forEach(function(row) {
    _applyRow(row, side, map, seen);
  });
}

/**
 * 把判断套用到【单行】上（买点行 / 卖点行共用这一份实现）。
 *
 * 写入行的字段：
 *   · chartJudge        —— 当前判断值（UI 选择器的高亮档）
 *   · chartJudgeTarget  —— 是否受控（false ⇒ 组件不渲染选择器）
 *   · chartJudgeSide    —— 侧别（组件透传给 Logic 的 setChartJudge，⛔ 组件不自己判买卖）
 *   · chartJudgeNote    —— 手动判断的说明文字（默认档 = 空串）
 *   · 命中的话再改 actionTag / actionTone（买点 = buyAction*，卖点 = sellAction*）
 *
 * ⚠️ 用 seen 去重：`buy.light` 与 `buy.candidates[0]` 是【同一个对象引用】
 *   （见 useDecisionBoard.js 的注释：降级后的第 2 名同时出现在两处）
 *   ⇒ 不去重就会把同一行处理两遍、说明文字被拼两次。
 */
function _applyRow(row, side, map, seen) {
  if (!row || typeof row !== 'object') return;
  if (seen.has(row)) return;
  seen.add(row);

  const isBuy = (side === SIDE_BUY);
  const tagKey = isBuy ? 'buyActionTag' : 'sellActionTag';
  const toneKey = isBuy ? 'buyActionTone' : 'sellActionTone';

  const name = String(row.name || '').trim();
  // §10：表里查不到这一只 ⇒ 默认（⛔ 不猜）
  const judge = name ? normalizeChartJudge(map[name]) : JUDGE_DEFAULT;
  const originalTag = String(row[tagKey] || '');
  const target = isChartJudgeTarget(side, originalTag);

  row.chartJudge = judge;
  row.chartJudgeTarget = target;
  row.chartJudgeSide = side;

  if (!target || judge === JUDGE_DEFAULT) {
    row.chartJudgeNote = '';
    return;
  }

  const r = resolveChartJudge(side, judge);
  const note = chartJudgeNoteText(side, judge, originalTag, r.tag);
  row.chartJudgeNote = note;
  // 目标是空串表示「不改动」——但走到这里必然非空（isChartJudgeTarget 通过 + 非默认），
  // 仍然显式判断，避免以后改映射表时静默把标签清成空串（§10 不做「看起来没变其实坏了」的事）。
  if (r.tag) {
    row[tagKey] = r.tag;
    row[toneKey] = r.tone;
  }
  // 说明文字接在既有 actionNote 后面：「这一行为什么这么给」的原文 + 「你又手动改成了什么」。
  const prev = String(row.actionNote || '');
  row.actionNote = prev ? (prev + ' ' + note) : note;
}

/**
 * 把当日判断 map 套用到决策数据上（**原地**写回，返回同一个对象）。
 *
 * ⚠️ 为什么要原地改：`useDecisionBoard#data` 是个 computed，每次重算都【重新跑一遍
 *   collectDecisionData】，拿到的是【全新构造】的一套对象，没有任何外部引用会看到旧值
 *   （§6 无第二份真相）。原地改 = 零深拷贝开销，对早盘高频刷新最友好（§22）。
 *   ⛔ 若哪天改成「缓存 collectDecisionData 的结果」，本函数必须同时改成返回新对象。
 *
 * ⛔ 遍历范围严格对齐 UI 的渲染范围：
 *      买点 = buy.heavy / buy.light / buy.candidates[] / buy.noYizi|smallTopic|bigTopic.blocks[]
 *      卖点 = sell[].items[]
 *   （`buySpecial` 是 composable 从后三者派生出来的引用，不在这里遍历 —— 遍历它就重复了。）
 *
 * @param {object} decisionData collectDecisionData 的返回
 * @param {object} judgeMap { 股票名: 'ok' | 'bad' }（data/decision-chart-judge.js#readDecisionChartJudgeForDate 的返回）
 * @returns {object} 同一个 decisionData（便于 computed 里链式写）
 */
export function applyChartJudge(decisionData, judgeMap) {
  const d = decisionData;
  if (!d || typeof d !== 'object') return decisionData;
  const map = (judgeMap && typeof judgeMap === 'object') ? judgeMap : {};
  const seen = new Set();

  const buy = d.buy || null;
  if (buy) {
    _applyBlock(buy.heavy, SIDE_BUY, map, seen);
    _applyBlock(buy.light, SIDE_BUY, map, seen);
    if (Array.isArray(buy.candidates)) {
      buy.candidates.forEach(function(b) { _applyBlock(b, SIDE_BUY, map, seen); });
    }
    // 三条兜底方案（无一字 / 小题材 / 大题材）结构一致：{ blocks: [wrapper...] }
    ['noYizi', 'smallTopic', 'bigTopic'].forEach(function(k) {
      const special = buy[k];
      if (!special || !Array.isArray(special.blocks)) return;
      special.blocks.forEach(function(b) { _applyBlock(b, SIDE_BUY, map, seen); });
    });
  }

  if (Array.isArray(d.sell)) {
    d.sell.forEach(function(g) {
      if (!g || !Array.isArray(g.items)) return;
      g.items.forEach(function(row) { _applyRow(row, SIDE_SELL, map, seen); });
    });
  }

  return d;
}

/**
 * 规则面板文案（灰色问号里显示的那些行）—— 由 decision-mode.js#buildRulesLines
 * 【前置】到两套模式的条文之前（用户口径「颜色显著些……这是我作为买卖点的最终判断」⇒ 必须最显眼）。
 *
 * ⛔ 与实现同处一处（§6）：改了上面那张映射表，本段文字必须同时改。
 * ⛔ 不许出现「题材连扳」四个字（decision-mode.test.js 用它区分两套模式的买点段）。
 * @returns {string[]}
 */
export function chartJudgeRulesLines() {
  const o = CHART_JUDGE_OPTIONS;
  const labelOf = function(v) {
    const hit = o.find(function(x) { return x.value === v; });
    return hit ? hit.label : '';
  };
  return [
    '★★【手动「竞价图形判断」】= 买卖时机的【最终决定权】，原来那套规则降为【辅助】★★',
    '　· 位置：买点 / 卖点的【每一行】行尾，一枚三档小选择器 ——【' +
      labelOf(JUDGE_DEFAULT) + '】｜【' + labelOf(JUDGE_OK) + '】｜【' + labelOf(JUDGE_BAD) + '】。',
    '　· 含义：你看【当天这只票的竞价图形】自己下的判断 ——',
    '　　　【' + labelOf(JUDGE_DEFAULT) + '】不改动，完全按下面原有规则给出的标签显示；',
    '　　　【' + labelOf(JUDGE_OK) + '】= 竞价图形【符合】⇒ 预判【今天走势会好】；',
    '　　　【' + labelOf(JUDGE_BAD) + '】= 竞价图形【不符合】⇒ 预判【今天走势不好】。',
    '　· 🔴 它【只对这四种基础标签生效】：' +
      BUY_NOW_TAG + ' / ' + BUY_LATE_TAG + '（买点）、' + SELL_OUT_TAG + ' / ' + SELL_LATE_TAG + '（卖点）。',
    '　　　【买点】' + labelOf(JUDGE_DEFAULT) + ' → 原标签；【' + labelOf(JUDGE_OK) + '】→ ' + BUY_NOW_TAG +
      '（更有性价比、溢价更高）；【' + labelOf(JUDGE_BAD) + '】→ ' + BUY_LATE_TAG + '（更安全，别追开盘）。',
    '　　　【卖点】' + labelOf(JUDGE_DEFAULT) + ' → 原标签；【' + labelOf(JUDGE_OK) + '】→ ' + SELL_LATE_TAG +
      '（走势好，尾盘获利更高）；【' + labelOf(JUDGE_BAD) + '】→ ' + SELL_OUT_TAG + '（果断出局）。',
    '　· ⛔ 其余【特殊标签】一律【不受影响】（它们各自还带着别信息，覆盖掉就丢信息）：',
    '　　　' + _SPECIAL_TAGS_TEXT + '。',
    '　　　这些行【不显示】选择器 —— 显示不了「可选择」却是空转，比不显示更误导。',
    '　· ⚠️ 原来那套规则【一条都没改】，只是【让位】：一旦你选了【' + labelOf(JUDGE_OK) + '】或【' +
      labelOf(JUDGE_BAD) + '】，就以你看的图为准，并按上面的对应关系改标签。',
    '　· 💾 保存：按【日期 + 股票】存在云端表 ' + _TABLE_NAME_TEXT +
      ' ⇒ 刷新 / 关页面 / 换设备都不会丢（§8 业务数据不上 localStorage）。',
    '　　　一只票一天只有【一个】判断，买点与卖点【共用】它（同一张图，不可能得出两个结论）；',
    '　　　选回【' + labelOf(JUDGE_DEFAULT) + '】= 删掉这条记录，与「从没选过」完全一样。',
    '　· 若看板出现红字说这张表不存在：去 Supabase SQL Editor 执行 db/create_decision_chart_judge.sql（一次性）。'
  ];
}
