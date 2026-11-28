// new-dragon-life.js — 第三十七条【新龙续命】（独立模块，⛔ 不并进 tvrb-blocks 的当天买通道）
//
// 用户口径（2026-11-28，逐条确认，原话）：
//   「1.范围对的空仓提醒日 2.标签是新龙续命 3.同日多票，原版可以分开，票重复不要紧，
//     这样就能相互印证，更加说明这只票的可靠性。简洁版可以合并成一只，并同时打上标签。
//     注意说明文字也一起写上。4.你说的优先级基本对的。」
//
// ── 一句话口径 ──────────────────────────────────────────────────────────────
//   **空仓日里，昨天买点侧真的买了、今天仍是所在题材龙一的票 ⇒ 续命买入**：
//     · 只认【第十九条空仓提醒】命中的日子（cashAlert.show）；
//     · 昨日「真的买了」= `collectBuyNames` 可买口径（灰行不算）；
//     · 今日「仍是龙一」= 买点侧 9:26 竞价口径龙位 rank === 1（与选股同一把尺子，§6）。
//
// ⛔ 不加「20 日内从未进前五」这个附加条件 —— 9/18 澳弘电子反例：进了前五后续也可以很强，
//    用户明确否决该方案，回到最初口径（准确率更高）。
//
// ── 三条硬约束（以后改这个文件先读这三条）──────────────────────────────────
//   ① **只认空仓提醒日**：`cashAlert.show` 不成立 ⇒ 整块不出现（零副作用）。
//   ② **昨日买过才算**：`prevBuyNames` 必须是 `collectBuyNames(上一交易日 plan)` 的结果；
//      读不到（null）⇒ 判不出 ⇒ 本块不出现并如实说明（§10，⛔ 不把「读不到」当「昨天没买」）。
//   ③ **两侧说明同步**：买点侧行内 `actionNote` + 卖点侧 `applyNewDragonLifeSellNote` 必须
//      讲同一件事（铁律 4：昨日已买、今日仍是龙一 ⇒ 续命持有，不是今天新开仓）。
//
// §2 分层：本文件只做纯数据加工（判定 + 文案拼装），⛔ 不取数、⛔ 不碰 DOM。

import {
  NEW_DRAGON_LIFE_RULE_NO,
  NEW_DRAGON_LIFE_TAG,
  NEW_DRAGON_LIFE_TONE,
  NEW_DRAGON_LIFE_BLOCK_TOPIC
} from './tvrb-constants.js';
import { _sameTopicLoose, _num } from './tvrb-utils.js';
import { formatRangePct, HOLD_TAG } from '../decision/decision-rules.js';
import { AUCTION_YIZI_WAIT_TAG } from './auction-yizi-tag.js';

/** 买点侧行内说明（唯一文案来源，买 / 卖两侧共用同一件事） */
export const NEW_DRAGON_LIFE_NOTE =
  '昨日已在买点侧买入、今天它【仍然是所在题材的龙一】⇒ 说明它没有跟着退潮，龙头还在续命' +
  ' ⇒ 今天继续持有（不是今天新开仓）。';

/**
 * 在今日题材清单里反查一只票的成员行 + 所在题材名。
 *
 * 为什么不用 `buyDragonMap.get(name).topic` 兜底到底：龙位名册的字段以 `{rank,pct}` 为主，
 *   `topic` 在不同调用方不一定挂全；从 `list`（= 今日题材块，每块含 members）反查是确定性来源。
 * §10：查不到 ⇒ 成员行 / 题材名留空（⛔ 不拿别的票或 0 顶替），行上只显示名字与龙一。
 *
 * @param {Array} list 今日题材块数组（`[{topic, members:[{name,pct,code,isYizi,...}]}]`）
 * @param {string} name
 * @returns {{member:object|null, topic:string}}
 */
function _findMemberAndTopic(list, name) {
  const nm = String(name || '').trim();
  const arr = Array.isArray(list) ? list : [];
  for (let i = 0; i < arr.length; i++) {
    const b = arr[i];
    if (!b) continue;
    const ms = Array.isArray(b.members) ? b.members : [];
    for (let j = 0; j < ms.length; j++) {
      const m = ms[j];
      if (m && String(m.name || '').trim() === nm) {
        return { member: m, topic: String(b.topic || '').trim() };
      }
    }
  }
  return { member: null, topic: '' };
}

/**
 * 第三十七条判定 + 买点块组装（纯函数，⛔ 不取数）。
 *
 * @param {object} opts
 * @param {boolean} opts.cashAlertShow 今天是否命中第十九条【空仓提醒】
 * @param {Array<string>|Set<string>|null} opts.prevBuyNames
 *        上一交易日买点侧【真的买了】的股票名（`collectBuyNames` 产出）；null/undefined = 未知
 * @param {Map} opts.buyDragonMap 买点侧 9:26 竞价口径龙位名册（`{rank,pct,topic?}`）
 * @param {Array} opts.list 今日题材块（反查成员行 / 题材名）
 * @param {Set<string>|null} [opts.skipBuyNames] 连续停牌买不进名单（停牌不选）
 * @param {Array<string>} [opts.prevBannedTopics] 昨日二次确认退潮的题材（第二十六条）—— 命中即让路
 * @param {(raw:string)=>string} [opts.coreRes] 题材大类归一（与其它规则同一把尺子）
 * @param {string} [opts.date] 今日日期（写进文案，便于复盘）
 * @param {string} [opts.prevDate] 上一交易日（写进文案）
 * @returns {{block:object|null, reason:string, names:string[]}}
 *          `block` 非空 = 今天有续命票；`reason` 说明为什么没有（no-cash-alert / no-prev / no-hit）
 */
export function buildNewDragonLifeBlock(opts) {
  const o = opts || {};
  if (o.cashAlertShow !== true) return { block: null, reason: 'no-cash-alert', names: [] };
  // ② 昨日买点侧未知 ⇒ 判不出（§10：⛔ 不把「读不到」当「昨天没买」）
  const prevArr = (o.prevBuyNames && typeof o.prevBuyNames.forEach === 'function')
    ? Array.from(o.prevBuyNames)
    : (Array.isArray(o.prevBuyNames) ? o.prevBuyNames : null);
  if (!prevArr) return { block: null, reason: 'no-prev', names: [] };

  const dm = (o.buyDragonMap instanceof Map) ? o.buyDragonMap : new Map();
  const list = Array.isArray(o.list) ? o.list : [];
  const skip = (o.skipBuyNames instanceof Set) ? o.skipBuyNames : null;
  const banned = Array.isArray(o.prevBannedTopics) ? o.prevBannedTopics.filter(function (t) { return !!t; }) : [];
  const coreRes = (typeof o.coreRes === 'function') ? o.coreRes : null;
  const dText = String(o.date || '').trim();
  const pText = String(o.prevDate || '').trim();

  const seen = new Set();
  const picked = [];
  prevArr.forEach(function (raw) {
    const name = String(raw || '').trim();
    if (!name || seen.has(name)) return;
    seen.add(name);
    // 停牌不选（连续停牌第 2 天及以上，买不进）
    if (skip && skip.has(name)) return;
    const d = dm.get(name);
    const rank = (d && d.rank) ? Number(d.rank) : null;
    // 今日必须仍是所在题材龙一
    if (rank !== 1) return;
    const found = _findMemberAndTopic(list, name);
    const topic = found.topic || String((d && d.topic) || '').trim();
    // 优先级 26 > 37：昨日二次确认退潮的题材今天禁入 ⇒ 本条让路
    if (banned.length > 0) {
      let isBanned = false;
      banned.forEach(function (bt) {
        if (_sameTopicLoose(topic, bt, coreRes)) isBanned = true;
      });
      if (isBanned) return;
    }
    const m = found.member || null;
    const pct = m ? _num(m.pct) : ((d && d.pct !== undefined) ? _num(d.pct) : null);
    const p = {
      seq: picked.length + 1,
      name: name,
      dragonLabel: '龙一',
      dragonRank: 1,
      pct: pct,
      pctText: formatRangePct(pct),
      code: String((m && m.code) || '').trim(),
      // 竞价口径字段：给 annotateAuctionYizi / 装饰器读（与其它买点行同形，⛔ 少一枚会漏标签）。
      // §10：成员行没有的值一律留 null（⛔ 不用 0 或上一帧的脏值冒充）。
      aucPct: m ? _num(m.aucPct) : null,
      // 竞价一字涨停的权威判据：成员行已判过就直接落 true（annotateAuctionYizi 优先读它，§6）。
      aucLimitUp: (m && m.isYizi === true) ? true : ((m && m.isYizi === false) ? false : undefined),
      // ⚠️ 预置 aucShare：装饰器 / finish 类逻辑会读它（与其它买点行同形，避免少一枚标签）
      aucShare: m ? _num(m.aucShare) : null,
      position: '',
      buyActionTag: NEW_DRAGON_LIFE_TAG,
      buyActionTone: NEW_DRAGON_LIFE_TONE,
      actionNote: '【第' + NEW_DRAGON_LIFE_RULE_NO + '条 · ' + NEW_DRAGON_LIFE_TAG + '】' + NEW_DRAGON_LIFE_NOTE +
        (pText ? ('（昨日买点侧 = ' + pText + '）') : '')
    };
    // 竞价一字涨停：照常选进，挂统一标签（与全通道口径一致，⛔ 无跳过 / 顺延）
    if (m && m.isYizi) p.waitBuyTag = AUCTION_YIZI_WAIT_TAG;
    picked.push(p);
  });

  if (picked.length === 0) return { block: null, reason: 'no-hit', names: [] };

  const names = picked.map(function (p) { return p.name; });
  const block = {
    // 决策看板「题材头」形状：本块不是题材排名 ⇒ 不给圆点 / 数量（§10 不拿 0 冒充）
    block: {
      topic: NEW_DRAGON_LIFE_BLOCK_TOPIC,
      rank: null,
      count: null,
      yiziCount: null,
      members: []
    },
    mode: 'new-dragon-life',
    ruleNo: NEW_DRAGON_LIFE_RULE_NO,
    reason: '今天建议空仓（第一题材平均竞价量比 < 25），但这 ' + picked.length +
      ' 只是昨日买点侧已经买过、今天仍是所在题材龙一的票 ⇒ 龙头还在续命 ⇒ 继续持有。',
    picks: picked,
    notes: [
      NEW_DRAGON_LIFE_NOTE,
      '名单来源：上一交易日（' + (pText || '—') + '）买点侧【真的买了】的票（灰行不算）' +
      ' ∩ 今天【仍是所在题材龙一】（9:26 竞价口径）；停牌不选、竞价一字照选。',
      '让路：昨天二次确认退潮的题材今天禁入（第二十六条）；越红线 / 逼近红线（三十四 / 三十六）优先级更高。' +
      '同一只票若也被第三十 / 三十一 / 三十五条选中，会各占一行、各带自己的标签（来源不同，相互印证）。'
    ],
    qualified: true,
    pickCount: picked.length,
    isNewDragonLife: true,
    newDragonLifeDate: dText
  };
  return { block: block, reason: 'hit', names: names };
}

/**
 * 卖点侧说明同步（铁律 4）：续命那几只票在卖点侧要继续标【持有】，并写明为什么。
 *
 * ⛔ 只改【说明 / 持有标签】，⛔ 不动分组、不改客观数据、不删行；
 *    它们在 `buyNames` 里（由 plan 层加进去），`buildSellPlan` 本来就会标【持有】，
 *    这里补的是「为什么持有 = 新龙续命」，避免用户看到「持有」却不知道为什么。
 *
 * @param {object} out 计划对象（`out.sell` 已产出）
 * @returns {number} 被改写说明的行数
 */
export function applyNewDragonLifeSellNote(out) {
  if (!out || !out.newDragonLife || !Array.isArray(out.newDragonLife.picks)) return 0;
  if (!Array.isArray(out.sell) || out.sell.length === 0) return 0;
  const names = new Set(out.newDragonLife.picks.map(function (p) { return String((p && p.name) || '').trim(); }));
  if (names.size === 0) return 0;
  let n = 0;
  out.sell.forEach(function (g) {
    (g && Array.isArray(g.items) ? g.items : []).forEach(function (it) {
      if (!it || !it.name) return;
      if (!names.has(String(it.name).trim())) return;
      // ⛔ 更高优先级已经改写过的行（第三十六条「异动卖」/ 逼近红线）不再追加续命说明 ——
      //   那一行的动作是「今天必须出掉」，与「续命持有」正面矛盾（优先级 36 > 37）。
      if (it.devRuleStage) return;
      const lead = '【第' + NEW_DRAGON_LIFE_RULE_NO + '条 · ' + NEW_DRAGON_LIFE_TAG + '】' + NEW_DRAGON_LIFE_NOTE +
        '卖点侧动作 = 【' + HOLD_TAG + '】（昨日已买过，今天仍在买点里 ⇒ 不是今天新开仓，也不必今天卖出）。';
      it.actionNote = String(it.actionNote || '').trim()
        ? (lead + ' ' + String(it.actionNote))
        : lead;
      n++;
    });
  });
  return n;
}
