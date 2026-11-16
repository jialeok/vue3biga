/**
 * second-topic-backup.js — 第二十九条「排名第二的题材量比不达标」的【唯一判定实现】（Logic 层纯函数）。
 *
 * ============================================================================
 * ★★ [TOPIC-INNER-SELECT 2026-11-17 用户口径 —— 本条规则的一次口径重写]
 *
 * 用户原话（逐字，2026-11-17，指着 11-16 的看板）：
 *   「文投控股也是ai应用的啊，为什么不选？我都说了排名第二的题材平均量比达不到，要看它竞价口径
 *     有没有在10日涨幅排名前十的，按照题材数量选，现在ai应用是9只，选两只。也是从十日涨幅里面
 *     选出来，如果他平均量比不符合，10日涨幅前十又没有票，就是灰色块。」
 *
 * 复盘（11-16 真实数据，App 自己算出的十日前十 · 9:26 竞价口径 · 只主板）：
 *   第 1 名 日出东方 +66.55%  大消费
 *   第 2 名 文投控股 +62.94%  AI应用   ← 用户问的就是它
 *   第 6 名 北纬科技 +51.12%  AI应用
 *   ⇒ AI应用 9 只里正好 2 只在十日前十，与用户「9只选两只」完全自洽。
 *
 * 旧口径（2026-10-24 ~ 11-16，**已废除**）：
 *   第二题材平均量比 < 25 ⇒ 【整块作废】（块从买点侧删除）+ 从【全市场】十日涨幅前十挑 1 只
 *   （`range10-backup.js#pickRange10Backup`）。
 *   ⛔ 问题：这个题材自己的票被扔掉了，选出来的却是别的题材的票 —— 用户看到的就变成
 *     「AI应用明明有票进了前十，你却不选它」。
 *
 * 新口径（本模块）：
 *   第二题材平均量比 < 25 ⇒ **不整块作废**，改成【在该题材内选票】：
 *     ① 候选 = 该题材成员 ∩ 当日十日涨幅前十（9:26 竞价口径 · 只主板 · 缺涨幅/非主板不占名次）；
 *     ② 过滤 = 必须仍是【首次在列】或【二次在列】（用户 2026-11-17 拍板「要保留」——
 *        这条从 2026-10-24 起一直是本规则的子条件，本次只改选票范围，⛔ 不动它）；
 *     ③ 顺序 = **首次在列优先**，同一档内按市场名次升序（涨幅高的在前）——
 *        与用户 2026-10-24 原话「有首次在列的只选一只，没有首次在列的，选二次在列的」同源；
 *     ④ 名额 = 按第二条档位（`resolveTvrbTier`）：count 4~8 ⇒ 1 只；count > 8 ⇒ 2 只；
 *     ⑤ 名额不足（合格票少于名额）⇒ **只选现有，⛔ 不补位**（用户 2026-11-17 拍板）；
 *     ⑥ 该题材在十日前十【一只都没有】/【有票但都不是首次二次在列】⇒ **灰色块**：
 *        该题材块照常列出、整块灰化、今天不买（用户原话「就是灰色块」）。
 *
 * ⛔ 与旧口径的关系（用户 2026-11-17 拍板「保留并存」）：
 *   旧的【全市场十日涨幅候补】块**不废除** —— 它在 ⑥「灰块」时照旧产出 1 只
 *   （`range10-backup.js#pickRange10Backup` 原样保留）。
 *   ①~⑤ 有票可选时**不再**额外产出全市场候补块：那只会让同一只票在「题材块」和「候补块」
 *   里各出现一次，属于纯重复（与 10-20 海洋王那次「题材通道 vs 市场通道叠加确认」不同 ——
 *   那次是两条独立通道各自成立，这次是同一条通道的替代方案）。
 * ============================================================================
 *
 * 职责边界（§3/§4/§15/§21）：
 *   · 本模块【只回答一个问题】：给定「第二题材块 + 十日涨幅名次表 + 在列次数」，
 *     该题材内有哪几只合格票、按档位该取哪几只、取不出来是为什么。
 *   · ⛔ 不取数、不落库、不发请求、不排版、不写说明文案（文案由规则层组装，§21）。
 *   · ⛔ 不判「第二题材是不是量比不达标」以外的任何题材门槛 —— 作废/灰化的执行在规则层。
 *
 * §10（判不出 ≠ 结论）：
 *   · `no-pool`  ⇒ 十日涨幅名次表不可用（池子空 / 20 天补位行未就绪 ⇒ 名次会整体错位）；
 *   · `no-row`   ⇒ 该题材的成员一只都不在名单里（我们根本没看见它们）；
 *   · `no-counts`⇒ 在列次数没读到（分不出首次/二次）；
 *   以上三种一律【不改行为】（规则层保持原样并如实写「未校验」），⛔ 绝不当成「一只都没有」去灰块。
 */

import { PRESENCE_TOP_N, presenceLabelOf } from '../auction/presence-label.js';
import { TVRB_CASH_ALERT_AVG_VR } from './tvrb-constants.js';
import { _topicTop10Hits } from './tvrb-utils.js';

/** 首次在列的次数（与 range10-backup.js 同一口径，§6） */
export const SECOND_TOPIC_CNT_FIRST = 1;
/** 二次在列的次数 */
export const SECOND_TOPIC_CNT_SECOND = 2;

/**
 * 【纯函数】第二题材该走哪条路 —— 第二十九条与第三条的【唯一判定点】（互斥（或）关系）。
 *
 * 用户原话（2026-11-16）：「第三条和第二十九条是或的关系，应该不冲突吧，今天就是AI应用16.82
 *   不符合，改用候补不是吗？」
 *   ⇒ 平均量比 ≥ 25 ⇒ 'gate'   （第三条：常规选票 + 「龙一进十日前十」那道闸门）
 *      平均量比 < 25 ⇒ 'backup' （第二十九条：题材内按十日涨幅前十选票）
 *
 * §10：读不出来（null / undefined / 非数字）⇒ 返回 ''（两条路都不判），
 *      ⛔ 绝不把「没数据」当成「量比低」去作废一个题材。
 *
 * @param {number|null|undefined} avgVolRatio 该题材的平均竞价量比（avgVolRatioOf 的返回）
 * @returns {'gate'|'backup'|''}
 */
export function secondTopicRouteOf(avgVolRatio) {
  if (avgVolRatio === null || avgVolRatio === undefined || avgVolRatio === '') return '';
  const n = Number(avgVolRatio);
  if (!isFinite(n)) return '';
  return n < TVRB_CASH_ALERT_AVG_VR ? 'backup' : 'gate';
}

/**
 * 【纯函数】在第二题材内按「十日涨幅前十 + 首次/二次在列 + 档位名额」选票。
 *
 * @param {object} blk  题材块（rankDecisionTopics 的一项：含 topic / count / members）
 * @param {object} opts
 *   · `rankMap`   十日涨幅名次表（9:26 竞价口径；`_range10RankMapOf` 的返回）
 *   · `counts`    auction_presence 的次数表（Map<name,{cnt}>；缺失 ⇒ judge='no-counts'）
 *   · `pickCount` 档位名额（`resolveTvrbTier(count).pickCount`：4~8 ⇒ 1；>8 ⇒ 2）
 *   · `topN`      前十门槛（缺省 PRESENCE_TOP_N = 10）
 * @returns {{
 *   judge: 'ok'|'empty'|'no-pool'|'no-row'|'no-counts',
 *   why: ''|'no-topic-in-top10'|'no-first-second',
 *   topic: string, count: number, slots: number, shortBy: number,
 *   picked: Array<object>, hits: Array<object>, rejected: Array<object>,
 *   topN: number, reason: string
 * }}
 *   `picked`   = 按顺序该选的（已截断到 slots；`shortBy` = 名额缺口，⛔ 不补位）
 *   `hits`     = 十日前十里的本题材票（逐只带 cnt / label / tier，便于写「判定可追溯」文案）
 *   `rejected` = 前十里的本题材票，但在列次数不是 1 / 2 ⇒ 被排除的那几只
 */
export function pickSecondTopicBackup(blk, opts) {
  const o = opts || {};
  const rawSlots = Number(o.pickCount);
  const slots = (isFinite(rawSlots) && rawSlots > 0) ? Math.floor(rawSlots) : 1;
  const rawN = Number(o.topN);
  const topN = (isFinite(rawN) && rawN > 0) ? Math.floor(rawN) : PRESENCE_TOP_N;
  const counts = (o.counts && typeof o.counts.get === 'function') ? o.counts : null;

  const out = {
    judge: '',
    why: '',
    topic: String((blk && blk.topic) || '').trim(),
    count: (function() { const n = Number(blk && blk.count); return isFinite(n) ? n : 0; })(),
    slots: slots,
    shortBy: 0,
    picked: [],
    hits: [],
    rejected: [],
    topN: topN,
    reason: ''
  };

  if (!counts) {
    out.judge = 'no-counts';
    out.reason = '十日窗口的在列次数（auction_presence）未读到 ⇒ 分不出「首次 / 二次在列」';
    return out;
  }

  const probe = _topicTop10Hits(blk, o.rankMap);
  if (probe.judge === 'no-pool') {
    out.judge = 'no-pool';
    out.reason = '当日十日涨幅名单不可用（为空 / 20 天补位行未就绪 ⇒ 名次会整体错位）';
    return out;
  }
  if (probe.judge === 'no-row') {
    out.judge = 'no-row';
    out.reason = '本题材的票一只都不在当日十日涨幅名单里 ⇒ 判不出它们进没进前十';
    return out;
  }
  if (probe.hits.length === 0) {
    out.judge = 'empty';
    out.why = 'no-topic-in-top10';
    out.reason = '当日十日涨幅前 ' + topN + ' 名里【没有一只本题材的票】';
    return out;
  }

  // 在列次数：命中不到 ⇒ 窗口内真的一次都没进过名单（今天在名单里的票必然 cnt ≥ 1）⇒ 0 次
  const judged = probe.hits.map(function(h) {
    const hit = counts.get(h.name);
    const rawCnt = hit ? Number(hit.cnt) : 0;
    const cnt = (isFinite(rawCnt) && rawCnt >= 0) ? Math.floor(rawCnt) : 0;
    return {
      name: h.name,
      rank: h.rank,
      pct: h.pct,
      cnt: cnt,
      label: presenceLabelOf(cnt),
      tier: (cnt === SECOND_TOPIC_CNT_FIRST) ? 'first' : ((cnt === SECOND_TOPIC_CNT_SECOND) ? 'second' : '')
    };
  });
  out.hits = judged;

  const first = judged.filter(function(j) { return j.tier === 'first'; });
  const second = judged.filter(function(j) { return j.tier === 'second'; });
  out.rejected = judged.filter(function(j) { return !j.tier; });

  // 首次在列优先；同档内保持 probe.hits 的顺序（= 市场名次升序，涨幅高的在前）
  const seq = first.concat(second);
  out.picked = seq.slice(0, slots);
  out.shortBy = Math.max(0, slots - out.picked.length);

  if (out.picked.length === 0) {
    out.judge = 'empty';
    out.why = 'no-first-second';
    out.reason = '当日十日涨幅前 ' + topN + ' 名里有本题材的票（' +
      judged.map(function(j) { return '第' + j.rank + '名 ' + j.name + '（' + (j.label || '—') + '）'; }).join('；') +
      '），但都不是【首次在列 / 二次在列】⇒ 按本条选不出票';
    return out;
  }

  out.judge = 'ok';
  return out;
}
