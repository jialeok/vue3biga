// tvrb-blocks.js — 「题材量比」看板的【买点块 / 卖点块】组装（规则层的"手"）
//
// 从 topic-vol-ratio-rules.js 拆出。每个 _build*Block / _apply* 对应规则手册里的一条：
//   退潮（二十一 / 二十五 / 三十二）、切换日新龙（二十八）、十日涨幅候补（二十九）、
//   弱势切抱团（三十）、补涨题材（三十一）、空仓提醒（buildCashAlert）。
//
// ⚠️ 本文件里的 _build*Block 互相调用是**网状**的（_buildBlock ← _buildEbbPicksBlock /
//   _dragonCandidates / _buildNewDragonBlock / _buildRange10BackupBlock），
//   ⛔ 不要再往里二次细分，硬拆会把「谁先算」的次序弄丢。
//
// 外部依赖的口径说明（原 topic-vol-ratio-rules.js 头部的 import 注释，逐条搬过来）：

import { TVRB_MIN_COUNT, TVRB_MID_MAX, TVRB_PICK_MID, TVRB_PICK_BIG, TVRB_SMALL_TOPIC_MAX, TVRB_CASH_ALERT_AVG_VR, EBB_PICK_TAG, EBB_PICK_TONE, EBB_NO_BUY_TAG, EBB_NO_BUY_TONE, EBB_SECOND_BUY_TAG, EBB_SECOND_BUY_TONE, EBB_SECOND_RULE_NO, CASH_NO_BUY_TAG, CASH_NO_BUY_TONE, WEAK_HUDDLE_RULE_NO, WEAK_HUDDLE_TAG, WEAK_HUDDLE_BLOCK_TOPIC, WEAK_HUDDLE_TOP_N, WEAK_HUDDLE_TONE, CATCH_UP_RULE_NO, CATCH_UP_TAG, CATCH_UP_BLOCK_TOPIC, CATCH_UP_RANK_FROM, CATCH_UP_RANK_TO, CATCH_UP_MIN_COUNT, CATCH_UP_MAX_COUNT, CATCH_UP_MIN_STREAK, CATCH_UP_TONE, TOPIC_LEADER_LIMITDOWN_RULE_NO, TOPIC_LEADER_LIMITDOWN_TAG, TOPIC_LEADER_LIMITDOWN_BLOCK_TOPIC, TOPIC_LEADER_LIMITDOWN_NO_BUY_TAG, TOPIC_LEADER_LIMITDOWN_NO_BUY_TONE, DIVERGE_DIP_TAG, DIVERGE_FOLLOW_TAG, DIVERGE_NO_BUY_TAG, DIVERGE_BUY_TONE, DIVERGE_NO_BUY_TONE, DIVERGE_RULE_NO, TVRB_CASH_ALERT_NONE, SWITCH_RULE_NO, NEW_DRAGON_TAG, NEW_DRAGON_TONE, RANGE10_BACKUP_TONE, RANGE10_BACKUP_TAG } from './tvrb-constants.js';
import { _normTopic, _sameTopicLoose, _ebbEligibleNames, _ebbBuyPickNames, _num, _pct2, _findMemberByName, _streakWord, _closeRankOf, _windowTextOf, _todayRankPhrase, _rankLabelOf, _oldTopicNameOf, _oldTopicBasisOf } from './tvrb-utils.js';

import { formatRangePct, RULE_NO, finishBuyBlock, SELL_OUT_TAG, SELL_ACTION_TONE_OUT, HOLD_TAG } from '../decision/decision-rules.js';
import { getDragonLabel } from '../auction/dragon-rank.js';
import { readRangePct } from '../auction/range-pct-sort.js';
import { totalDragonLabel } from '../auction/range20-top5-label.js';
import { pickDivergeFollowers } from '../auction/leader-divergence.js';
import { RANGE10_BACKUP_RULE_NO } from './range10-backup.js';
// ★ [AUCTION-YIZI-WAIT 2026-11-12] 竞价一字那只进买点侧时的专用标签
import { AUCTION_YIZI_WAIT_TAG } from './auction-yizi-tag.js';


/**
 * 【昨日二次确认退潮题材 · 买点侧覆盖式改写】（[EBB-D1] 第二十六条的后处理，范式与
 * _applyEbbBuyRules / _applyCashAlertBuyRules 完全同一套 —— ⛔ 绝不去改 finishBuyBlock 内部）。
 *
 * 用户口径：题材【不删、照常列出】（「不用去掉，其它题材不变」），但：
 *   · 动作标签一律换成【退潮不买】（与退潮日同一枚标签 —— 语义同源：题材在退潮，不买）；
 *   · 行尾【持有】/ 仓位槽清空（同一天不可能既「禁入」又「持有」）；
 *   · 逐行说明写明原因（判定可追溯，§10）；
 *   · ⛔ 客观数据一行不动；卖点侧一行不动（用户本轮只说买点侧）。
 *
 * 视觉：整块灰化【不在本函数里做】—— 本函数只在块上挂 `prevEbbGray = true` 旗子，
 *   视图层给该块挂 `.tvrb-prev-ebb-gray`（与 .tvrb-buy-list.tvrb-ebb 同一套灰化值，
 *   ⛔ 不新造第二套灰化视觉；只灰这一个题材块，其它题材块不灰 —— 与整段灰化刻意不同）。
 *
 * ★ 它必须排在退潮 / 分歧 / 空仓提醒三条改写【之后】（调用方保证）：本规则是「按题材」的
 *   覆盖式后处理，优先级解释写进行内说明（它比前三条更具体 —— 针对的是昨日已二次确认的题材）。
 *
 * @param {Array} blocks buildTopicVolRatioPlan 的入选题材块数组（每块含 picks / notes）
 * @param {{topic:string, leaderName:string, since:string}|null} prevSecondEbb
 *        secondEbbTopicOfPrevDay 的返回；null ⇒ 零副作用（§11）
 * @param {(raw:string)=>string} [coreRes] ★ [CORE-CAT 2026-10-22] 题材大类归一函数 ——
 *        块上是细分串（「文化传媒」）、prevSecondEbb.topic 是大类（「AI应用」）⇒ 必须按大类认亲，
 *        ⛔ 不能逐字比较（否则第二十六条在题材名漂移那天静默失效）。
 */
export function _applyPrevEbbSecondNoBuy(blocks, prevSecondEbb, coreRes) {
  if (!prevSecondEbb || !prevSecondEbb.topic) return;
  const topic = String(prevSecondEbb.topic).trim();
  const lead = '【' + topic + '】昨日已【二次确认退潮】' +
    (prevSecondEbb.since ? ('（该次退潮事件自 ' + prevSecondEbb.since + ' 起）') : '') +
    ' ⇒ 第二十六条：题材退潮次日禁止买入。';
  (blocks || []).forEach(function(b) {
    if (!b) return;
    const bt = String((b.block && b.block.topic) || b.topic || '').trim();
    if (!_sameTopicLoose(bt, topic, coreRes)) return;
    b.prevEbbGray = true;                   // ★ 视图层据此给该块挂灰化类（只灰这一个题材块）
    if (!Array.isArray(b.notes)) b.notes = [];
    (b.notes).push('⚠️ ' + lead + '本题材今天【不参与买入】—— 即使它平均竞价量比排名靠前' +
      '（风险很高）；股票照常列出供参考（灰化显示），原本的买点信号一律作废，其它题材不变。');
    (b.picks || []).forEach(function(p) {
      if (!p || !p.name) return;
      p.position = '';
      p.holdTag = '';
      p.buyActionTag = EBB_NO_BUY_TAG;      // ★ 覆盖式：与退潮日同一枚标签（语义同源）
      p.buyActionTone = EBB_NO_BUY_TONE;
      p.actionNote = lead +
        '本股今天【不开新仓】—— 原本的【' + HOLD_TAG + '】/ 竞价买 / 尾盘买 / 先卖后买 等买点信号' +
        '一律作废。（等题材重新走强 —— 总龙复牌 / 竞价占比回升 / 平均量比回来 —— 再看买点。）';
    });
  });
}

/**
 * ══ [LEADER-LIMITDOWN 2026-11-02 用户口径] 第三十二条 · 买点侧改写：题材龙一竞价跌停 ══════════
 *
 * 用户原话：「排名第一的题材……题材内龙一如果跌停，就不要选」（判据长注释见
 *   TOPIC_LEADER_LIMITDOWN_RULE_NO 那一段）。
 *
 * 只改写【那一个题材块】（按题材名精确认亲，⛔ 不是按块序号 —— 块序号在删块 / 顺延之后不可靠）：
 *   · 每只票的动作标签 ⇒【龙一跌停不买】，仓位槽 / 行尾【持有】清空；
 *   · 块上挂 `leaderLimitDownGray = true`（= 视图层可据此灰化；与 prevEbbGray 同一范式）；
 *   · ⛔ 客观数据一行不动（十日涨幅 / 涨幅 / 量比 / 占比 / 龙标 / 连板 / 封单照常）；
 *   · ⛔ 卖点侧一行不动（用户本轮只谈买点侧）。
 *
 * ⛔ 与 _applyCashAlertBuyRules / _applyEbbBuyRules 同一范式（先按原口径算完，再覆盖那三处），
 *   ⛔ 绝不改 finishBuyBlock 内部（决策看板共用，§6）。
 *
 * @param {Array} blocks buildTopicVolRatioPlan 的入选题材块数组（每块含 picks / notes）
 * @param {{topic:string, name:string, aucPctText:string, avgText:string, count:number}|null} ld
 *        out.leaderLimitDown；null ⇒ 零副作用（§11）
 */
export function _applyLeaderLimitDownNoBuy(blocks, ld) {
  if (!ld || !ld.topic) return;
  const lead = '【' + ld.topic + '】的龙一【' + ld.name + '】9:25 竞价涨幅 ' + (ld.aucPctText || '—') +
    ' = 【竞价跌停】⇒ 第三十二条：题材内最强的那只都被摁在跌停板上（也买不进）⇒ 本题材今天不选股。';
  (blocks || []).forEach(function(b) {
    if (!b) return;
    const bt = String((b.block && b.block.topic) || b.topic || '').trim();
    if (bt !== String(ld.topic).trim()) return;
    b.leaderLimitDownGray = true;         // ★ 视图层据此给该块挂灰化类（只灰这一个题材块）
    if (!Array.isArray(b.notes)) b.notes = [];
    b.notes.push('⚠️ ' + lead + '原本的买点信号（竞价买 / 尾盘买 / 先卖后买 …）一律作废；' +
      '股票照常列出供参考，原本的【' + HOLD_TAG + '】也一并取消。' +
      '今天的买点在下面那段【' + TOPIC_LEADER_LIMITDOWN_TAG + '】里（市场总龙一）。');
    (b.picks || []).forEach(function(p) {
      if (!p || !p.name) return;
      p.position = '';
      p.holdTag = '';
      p.buyActionTag = TOPIC_LEADER_LIMITDOWN_NO_BUY_TAG;
      p.buyActionTone = TOPIC_LEADER_LIMITDOWN_NO_BUY_TONE;
      p.actionNote = lead +
        '本股今天【不开新仓】—— 原本的【' + HOLD_TAG + '】/ 竞价买 / 尾盘买 / 先卖后买 等买点信号' +
        '一律作废。（等这个题材重新走强 —— 龙一不再跌停、竞价占比回升 —— 再看买点。）';
    });
  });
}

/**
 * 【退潮首日 · 卖点改写】（覆盖式后处理 —— ⛔ 绝不去改 buildSellPlan 内部）。
 *
 * 为什么是「后处理」而不是「改 buildSellPlan」：那个函数是【决策看板与本看板共用的同一份实现】
 * （§6 红线），在它里面加本看板专有的分支，等于给决策看板也加了一条它不该有的规则。
 * 于是：先让它按原口径算完，再由本函数【覆盖】本看板需要改的那两枚字段
 * （`sellActionTag` / `sellActionTone` —— 它们在本看板卖点行的标签优先级里最高，见 TvrbSellBlock.vue）。
 *
 * ⛔ 保留一切【客观数据】：十日涨幅 / 竞价涨幅 / 量比 / 占比 / 龙标 / 名次变化 / 连板 / 封单额
 *   —— 退潮只改「今天怎么卖」，不篡改行情事实。
 * ⛔ 停牌票【照旧改写】：本文件是纯函数、读不到停牌事实（判定只有 suspend.js 一处，§6），
 *   而「它卖不掉」这件事由【停牌】小标 + 第十九轮的去色 CSS 表达，不在这里再判一遍。
 *
 * @param {Array} sell buildSellPlan 的返回（题材分组数组，每组含 items）
 * @param {object|null} ebb detectEbbDay 的返回
 * @param {Set<string>|null} [keepNames] [EBB-R20b] 额外放行集（二次确认 + 常规选股时 = 今日买点名单；
 *        缺省 null ⇒ 行为逐字不变）—— 与「卖点候选放行」同一不变式：今天要买的票不清仓
 */
export function _applyEbbSellRules(sell, ebb, keepNames) {
  if (!ebb) return;
  const elig = _ebbEligibleNames(ebb);
  const buyPicks = _ebbBuyPickNames(ebb);
  // ★ [EBB-R20b 2026-10-20] 可选放行集（缺省 null ⇒ 行为逐字不变，§11）：
  //   二次确认退潮 + 常规选出了补涨题材时 = 【今日买点名单】—— 这些票今天真要买，
  //   若昨天买过（在卖点候选里），保持 buildSellPlan 自己的结论（持有 / 先卖后买），
  //   ⛔ 不改写成【竞价卖】（同一天不可能既「今天要买」又「竞价清仓」—— 与替补放行同一不变式）。
  if (keepNames) keepNames.forEach(function(n) { buyPicks.add(n); });
  const topicText = ebb.leaderTopic || '—';
  const lead = '【' + ebb.phaseTitle + '】市场总龙【' + ebb.leaderName + '】（' + topicText +
    '，20日涨幅 ' + ebb.leaderPctText + '）' + ebb.whyText + ' ⇒ 题材退潮：';

  (sell || []).forEach(function(g) {
    (g.items || []).forEach(function(it) {
      if (!it || !it.name) return;
      const name = String(it.name);
      // ★ [EBB-R8 2026-10-14] 放行【今天的替补买点】（[EBB-R20] 起为 ≤2 只）：
      //   它们如果同时在卖点侧（昨天买过），按本文件退潮口径本来会被改成【竞价卖】——
      //   那就与买点侧的【退潮替补买】正面矛盾（同一天不可能既「今天要买」又「竞价清仓」）。
      //   ⇒ 它们保持 buildSellPlan 自己的结论（今天又进买点 ⇒ 持有）：留着，并在开盘买点加仓。
      if (buyPicks.has(name)) return;
      if (elig.has(name)) {
        const isSib = (name === ebb.siblingName);
        it.sellActionTag = EBB_PICK_TAG;      // ★ 覆盖式：优先级最高的那一枚
        it.sellActionTone = EBB_PICK_TONE;
        it.holdTag = '';                      // 与「看分笔卖」互斥（原口径的持有 / 先卖后买让路）
        it.buyActionTag = '';
        it.buyActionTone = '';
        // 卖点节奏提示（深低开盯盘 / 立刻出…）以【占比】为前提，与「看分笔卖」是两套口径 ⇒ 撤掉
        it.sellHint = null;
        it.actionNote = lead +
          (isSib
            ? ('本股是【' + (ebb.siblingLabel || '') + '同题材可用龙位】（' + topicText +
               ' 里龙位最靠前、且非竞价一字 / 非停牌的票）')
            : ('本股是【市场总龙二】（昨日十日涨幅第二 ' + ebb.secondPctText + '，' +
               (ebb.secondTopic || '—') + ' 的龙一）')) +
          ' ⇒ 允许【' + EBB_PICK_TAG + '】：9:25 不竞价卖，等 9:30~9:31 点开【分笔成交】看结论 —— ' +
          '提示【冲高卖】就等冲高再清、提示【立刻卖】就直接止损。' +
          '（本档【不看本股自己的占比】，也不看它原本是【' + HOLD_TAG + '】还是【' + SELL_OUT_TAG +
          '】—— 退潮日只按「是不是那两只有资格等开盘卖的票」二分。）';
      } else {
        it.sellActionTag = SELL_OUT_TAG;      // ★ 其余一律竞价卖（用户拍板：连【持有】也一起改）
        it.sellActionTone = SELL_ACTION_TONE_OUT;
        it.holdTag = '';
        it.buyActionTag = '';
        it.buyActionTone = '';
        it.sellHint = null;
        it.actionNote = lead +
          ('本股不是【同题材可用龙位】、也不是【市场总龙二】 ⇒ 一律【' + SELL_OUT_TAG +
           '】：开盘就走，降低风险。' +
           '（退潮日【不看占比】、也不因它原本标【' + HOLD_TAG + '】而留下。）');
      }
    });
  });
}

/**
 * 【退潮日 · 买点侧替补（≤2 只）】构造（第八轮建立 · [EBB-R20 2026-10-20 用户口径] 本轮升级）。
 *
 * 用户口径（本轮原话）：「从20日涨幅中的总龙一到总龙五选出两只排名靠前的。而且是不同总龙一题材的
 *   股票……也就是从这五只中，要判断是不是创业板，科创板，北交所等非主板的股票，如果是先排除，
 *   剩下的看是不是和总龙一是同题材，是也排除，剩下的就选排名靠前的那两只。」
 * （替补名单与五只去留由采集层 _ebbCtxOf 选好 / 留痕，本函数只负责【组装成可渲染的买点块】。）
 *
 * 产出 = 一个【常规买点块】（形状与 _buildBlock 完全一致）里放替补的 1~2 只票 ——
 *   ⇒ 它可以直接喂给 TvrbBuyBlock 渲染，也可以进 `buy.ebbSecond` 槽位让四个装饰器统一挂客观数据
 *   （量比趋势 / 名次变化 / 封单额 / 停牌标记，见 decision-collect#_buyBlocksOf）。
 *
 * ⚠️ 顺序（决定了本函数里那两次「覆盖」的必要性）：
 *   ① 先 `finishBuyBlock` —— 它不是用来给动作标签的，而是为了把【客观数据 + 原始买点信号】
 *      （竞价涨幅徽标 / 占比 + 门槛 / 量比方向 / 仓位 / 持有 / 逐行说明）一次算齐；
 *   ② 再【覆盖】动作标签为【退潮替补买】（用户明确要专属标签）并把原始信号写进行内说明
 *      —— 覆盖而不改写逻辑：占比达标与否这条结论一枚不丢，只是换了标签的外观。
 *   ⛔ 绝不改 finishBuyBlock 内部（那是决策看板与本看板共用的实现，§6 红线）。
 *
 * ⚠️ 为什么 `block.block` 用【合成的题材头】而不是替补票所在的真实题材块：
 *   真实题材块的 `rank` 是「题材排名圆点」，挂在这一行上会被读成本行的名次；
 *   而且本行第一行标题要写清楚它是什么（退潮替补 / 20日涨幅总龙一~五里选出来的），不是某个题材。
 *   ⚠️ `members` 放【真实成员行】—— `finishBuyBlock` 的徽标反查（_decorateAucBadge）
 *     要按名字从 members 里取 aucPct / aucShare / volRatioDelta / code。
 *   ⚠️ 替补票【不在今日列表】（20日补位票 / 停牌票）时拿不到成员行 ⇒ 该行照样给出
 *     （名字 / 代码 / 20日涨幅 / 总龙N 都是采集层的事实），只是少几个竞价徽标，并在说明里如实标注。
 *
 * @param {object} ebb detectEbbDay 的返回（必须 buyPicksOn=true）
 * @param {Array} list rankDecisionTopics 的返回 —— 用来找替补票的【真实成员行】（含代码 / 占比 / 量比）
 * @param {object} fOpts finishBuyBlock 的入参（与正常题材块同一份，保证标记口径一致）
 * @returns {object|null} 常规买点块；一只替补都没有 ⇒ null（§10 不猜）
 */
export function _buildEbbPicksBlock(ebb, list, fOpts) {
  if (!ebb || !ebb.buyPicksOn || !Array.isArray(ebb.buyPicks) || ebb.buyPicks.length === 0) return null;
  const picks = [];

  // 真实成员行：先按【它所属题材块】找（同名的其它题材成员不存在），找不到再全题材按名字兜一次
  const _memberOf = function(name, topic) {
    let member = null;
    (list || []).forEach(function(b) {
      if (member) return;
      if (topic && String(b && b.topic || '').trim() !== topic) return;
      (b.members || []).forEach(function(m) {
        if (!member && m && String(m.name || '').trim() === name) member = m;
      });
    });
    if (!member) {
      (list || []).forEach(function(b) {
        if (member) return;
        (b.members || []).forEach(function(m) {
          if (!member && m && String(m.name || '').trim() === name) member = m;
        });
      });
    }
    return member;
  };

  const members = [];
  ebb.buyPicks.forEach(function(p, idx) {
    const member = _memberOf(p.name, p.topic);
    if (member && !members.some(function(m) { return m && m.name === p.name; })) members.push(member);
    picks.push({
      seq: idx + 1,
      name: p.name,
      dragonLabel: p.label,
      dragonRank: null,
      pct: p.pct,
      // 代码优先取采集层给的（与 members 同一个值，§6 只搬运）
      code: p.code || String((member && member.code) || '').trim(),
      pctText: p.pctText,
      // ⚠️ 预置：_decorateAucBadge 之前 _markHold 要读它（与 _buildBlock 同一做法）；
      //    替补票不在今日列表 ⇒ member 为 null ⇒ 只能按缺数据处理（§10 不猜）
      aucShare: member ? _num(member.aucShare) : null,
      position: ''
    });
  });

  const namesText = ebb.buyPicks.map(function(p) {
    return '【' + (p.label || '') + p.name + '】（' + (p.topic || '—') + '，20日涨幅 ' + p.pctText + '）';
  }).join('、');

  const notes = [
    '⚠️ 本行【不是】题材选股的结果，而是【' + ebb.phaseTitle + '的退潮替补】：市场总龙【' + ebb.leaderName + '】' +
      ebb.whyText + ' ⇒ 买点侧只留替补（总龙自己今天不买）。',
    '【替补怎么选】= 从【20日涨幅】的总龙一到总龙五里：先排非主板（创业板/科创板/北交所），' +
      '再排与总龙一同题材，剩下的取排名最靠前的前两只 —— 本日 = ' + namesText + '。',
    (ebb.buyTrailText ? ('五只去留（判定可追溯）：' + ebb.buyTrailText + '。') : ''),
    '⚠️ 涨幅口径 = 【当日 20日涨幅】（与「20日涨幅」toggle 的总龙一~五同一列）——' +
      '停牌票按它自己的交易日回溯、靠补位照样进榜，这正是总龙用 20日口径的原因。'
  ].filter(function(s) { return !!s; });
  if (ebb.buySecondTrouble) notes.push(ebb.buySecondTrouble);

  const block = {
    // ── ① 决策看板形状的字段（finishBuyBlock / 装饰器要读的）──
    block: {
      topic: '退潮替补 · ' + (ebb.leaderTopic || '—'),
      rank: null,          // ⛔ 不给圆点：本行不是题材排名
      count: null,
      yiziCount: null,
      // ★ 真实成员行 —— 徽标 / 占比 / 量比方向 / 代码都从它反查（见函数头注释）
      members: members
    },
    rankWord: '',
    pickRank: null,
    reason: ebb.phaseTitle + '【退潮替补】：' + namesText +
      ' —— 总龙【' + ebb.leaderName + '】' + ebb.whyText +
      ' ⇒ 今天只买这 ' + ebb.buyPicks.length + ' 只替补（其余入选票一律【' + EBB_NO_BUY_TAG + '】）',
    mode: 'ebb',
    ruleNo: EBB_SECOND_RULE_NO,
    isCandidate: false,
    candidateTag: '',
    qualified: true,
    notQualifiedText: '',
    picks: picks,
    notes: notes,

    // ── ② 本看板自己的平铺字段（组件直接读）──
    topic: '退潮替补 · ' + (ebb.leaderTopic || '—'),
    rank: null,
    count: null,
    yiziCount: null,
    avgVolRatio: null,
    avgVolRatioText: '',
    tier: 'ebb',
    pickCount: 0,
    rangeText: '',
    skippedNames: [],
    // ★ 供视图判断「这是退潮替补那一行」（避免模板靠 tier 字符串比较，§21）
    isEbbSecond: true
  };

  // ① 让它按决策看板的同一份实现把【客观数据 + 原始买点信号】算齐
  finishBuyBlock(block, fOpts);
  // ② 再覆盖动作标签为专属的【退潮替补买】（用户拍板），并原始信号原文留进行内说明
  const lead = '【' + ebb.phaseTitle + ' · 退潮替补】市场总龙【' + ebb.leaderName + '】' + ebb.whyText +
    ' ⇒ 今天买点侧只有替补这几只（【' + EBB_SECOND_BUY_TAG + '】）：';
  (block.picks || []).forEach(function(p) {
    const me = ebb.buyPicks.filter(function(x) { return x.name === p.name; })[0] || null;
    const rawTag = p.buyActionTag || '';
    const rawNote = p.actionNote || '';
    p.buyActionTag = EBB_SECOND_BUY_TAG;      // ★ 覆盖式：本行唯一那枚标签
    p.buyActionTone = EBB_SECOND_BUY_TONE;
    p.holdTag = '';                           // 与「今天要买」互斥（原本的持有 / 先卖后买让路）
    p.position = '';
    p.actionNote = lead + '它是【' + ((me && me.label) || '') + p.name + '】= 20日涨幅全市场排名第 ' +
      ((me && me.rank20) || '—') + ' 的替补（' + ((me && me.pctText) || '') +
      '，' + ((me && me.topic) || '—') + '）。' +
      (rawTag ? ('它的常规买点信号是【' + rawTag + '】——' + (rawNote || '')) : '') +
      (me && me.trouble ? (' ' + me.trouble) : '') +
      ' 退潮日不按常规买点罗列：只留替补这几只，其余入选票一律【' + EBB_NO_BUY_TAG + '】（灰色）。';
  });
  return block;
}

/**
 * 【退潮首日 · 买点改写】（覆盖式后处理 —— ⛔ 绝不去改 finishBuyBlock 内部）。
 *
 * 用户口径（2026-10-13 第六轮）：「退潮当天，只有卖没有买」「新华文轩买点侧还标有 持有 竞价买，
 *   应该标的是，『退潮不买』」。
 *
 * 为什么是「后处理」：finishBuyBlock 是【决策看板与本看板共用的同一份实现】（§6 红线），
 *   在它里面加本看板专有的分支，等于给决策看板也加了一条它不该有的规则。
 *   于是：先让它按原口径算完，再由本函数【覆盖】买点行上那几枚「买」的字段。
 *
 * 覆盖的三处（模板 TvrbBuyBlock.vue 里买点行上所有「买」的出口，一个不漏）：
 *   · `p.buyActionTag` / `p.buyActionTone` —— 竞价买 / 尾盘买 / 先卖后买 / 下杀买 / 补涨 / 龙一字持有
 *     ⇒ 一律换成【退潮不买】；
 *   · `p.holdTag` —— 行尾【持有】（今天又进买点）
 *   · `p.position` —— 仓位槽（本看板只有「昨天真买过 ⇒ 持有」会落在这里）
 * ⛔ 只动这三处；题材级的【昨有买入】/【N 次入选】是【历史统计标记】而不是「今天的买点动作」，
 *   保留不动（用户「其它不变」）。
 * ⛔ 一切【客观数据】照旧：十日涨幅 / 竞价涨幅 / 竞价量比 / 占比 / 龙标 / 名次变化 / 连板 / 封单额
 *   —— 退潮只改「今天买不买」，不篡改行情事实。
 * ⛔ 停牌票【照旧改写】：停牌事实由【停牌】小标 + 去色 CSS 表达（判定只有 suspend.js 一处，§6），
 *   本纯函数不重复判一遍。
 *
 * @param {Array} blocks buildTopicVolRatioPlan 的入选题材块数组（每块含 picks）
 * @param {object|null} ebb detectEbbDay 的返回
 */
export function _applyEbbBuyRules(blocks, ebb) {
  if (!ebb) return;
  const topicText = ebb.leaderTopic || '—';
  const lead = '【' + ebb.phaseTitle + '】市场总龙【' + ebb.leaderName + '】（' + topicText +
    '，20日涨幅 ' + ebb.leaderPctText + '）' + ebb.whyText +
    ' ⇒ 判定为【' + ebb.phaseTitle + '】（题材退潮：总龙停牌 / 占比不符 ⇒ 整个题材的股票预期走势差）。' +
    '题材退潮【今天不买】：';
  (blocks || []).forEach(function(b) {
    (b.picks || []).forEach(function(p) {
      if (!p || !p.name) return;
      p.position = '';                      // 仓位槽（本看板此处只会是【持有】）
      p.holdTag = '';                       // 行尾【持有】
      p.buyActionTag = EBB_NO_BUY_TAG;      // ★ 覆盖式：买点行上唯一那枚「买」的标签
      p.buyActionTone = EBB_NO_BUY_TONE;
      p.actionNote = lead +
        '本股今天【不开新仓】—— 退潮日除【' + EBB_SECOND_BUY_TAG + '】替补外没有其它买点，' +
        '原本的【' + HOLD_TAG + '】/ 竞价买 / 尾盘买 / 先卖后买 等买点信号一律作废。' +
        '（等题材重新走强 —— 总龙复牌 / 竞价占比回升 / 平均量比回来 —— 再看买点。）';
    });
  });
}

/**
 * 【空仓提醒 · 买点改写】（覆盖式后处理 —— ⛔ 绝不去改 finishBuyBlock 内部）。
 *
 * 用户口径（2026-10-16 第十六轮原话）：
 *   「题材量比有这个提示时：⚠️ 今日建议空仓 · 不开仓……这个提示下的买点侧，全部变成灰色
 *     （卖点侧不变），买点侧股票标签改成"分歧日不买"。那个灰色的样式类似 10月13日的退潮首日
 *     那个买点侧整版灰色，你可以参考下。其它不变。」
 *
 * 判据 = `cashAlert.show`（= 能入选的排名第一题材 平均竞价量比 < TVRB_CASH_ALERT_AVG_VR）。
 *   ⛔ 本函数【只读】cashAlert 那个已算好的对象，⛔ 绝不自己去重算一遍量比门槛（§6 判据唯一）。
 *
 * 与 _applyEbbBuyRules 同一范式（先按原口径算完，再【覆盖】买点行上那几枚「买」的字段）：
 *   · `p.buyActionTag` / `p.buyActionTone` —— 竞价买 / 尾盘买 / 先卖后买 / 下杀买 / 补涨 / 龙一字持有
 *     ⇒ 一律换成【分歧日不买】；
 *   · `p.holdTag` —— 行尾【持有】（今天又进买点）
 *   · `p.position` —— 仓位槽（本看板只有「昨天真买过 ⇒ 持有」会落在这里）
 * ⛔ 只动这三处；题材级的【昨有买入】/【N 次入选】是【历史统计标记】而不是「今天的买点动作」，保留不动。
 * ⛔ 一切【客观数据】照旧：十日涨幅 / 竞价涨幅 / 竞价量比 / 占比 / 龙标 / 名次变化 / 连板 / 封单额
 *   —— 空仓提醒只改「今天买不买」，不篡改行情事实。
 * ⛔ 【卖点侧】一行不动（用户「卖点侧不变」）。
 * ⛔ 【整段灰化】不在本函数里做：视觉由视图层挂同一个 `.tvrb-ebb` 类表达
 *   （与退潮首日【完全同一套】灰化视觉，用户「你可以参考下」，⛔ 不新造第二套 CSS）。
 * ⛔ 停牌票【照旧改写】：停牌事实由【停牌】小标 + 去色 CSS 表达（判定只有 suspend.js 一处，§6），
 *   本纯函数不重复判一遍。
 *
 * ★ 优先级（★ 调用方保证，见 buildTopicVolRatioPlan）：退潮首日 > 空仓提醒。
 *   两者【可能同时成立】（退潮日的空仓标语本来就是走退潮口径）⇒ 退潮首日走【退潮不买】，
 *   本函数只在【非退潮日】命中空仓提醒时才介入。
 *
 * @param {Array} blocks buildTopicVolRatioPlan 的入选题材块数组（每块含 picks）
 * @param {object|null} cashAlert buildCashAlert 的返回（show=false ⇒ 直接返回，⛔ 零副作用）
 */
export function _applyCashAlertBuyRules(blocks, cashAlert) {
  if (!cashAlert || !cashAlert.show) return;
  const lead = '【空仓提醒】能入选的排名第一题材【' + cashAlert.topic + '】平均竞价量比 ' +
    cashAlert.avgVolRatioText + ' ＜ ' + cashAlert.threshold +
    ' ⇒ 题材退潮（最强的题材量比都这么低，当天什么票都容易走弱）· 分歧日：';
  (blocks || []).forEach(function(b) {
    (b.picks || []).forEach(function(p) {
      if (!p || !p.name) return;
      p.position = '';                        // 仓位槽（本看板此处只会是【持有】）
      p.holdTag = '';                         // 行尾【持有】
      p.buyActionTag = CASH_NO_BUY_TAG;       // ★ 覆盖式：买点行上唯一那枚「买」的标签
      p.buyActionTone = CASH_NO_BUY_TONE;
      p.actionNote = lead +
        '本股今天【不开新仓】—— 分歧日的买点信号一律作废，原本的【' + HOLD_TAG + '】/ 竞价买 / ' +
        '尾盘买 / 先卖后买 等买点信号不再作数。' +
        '（等题材重新走强 —— 平均竞价量比回到 ' + TVRB_CASH_ALERT_AVG_VR + ' 以上 —— 再看买点。）' +
        '⚠️ 下方股票仍按原规则【照常列出】，供你参考。';
    });
  });
}

/**
 * ══ [DIVERGE 2026-10-20 用户口径] 总龙首次分歧日 · 买点侧改写（覆盖式后处理）══════════════
 *
 * 用户原话：「题材量比买点侧只有市场总龙一，还有其它不同题材的两只高标股票（20日涨幅前五的），
 *   同题材的不要……最多三只。」⇒ 分歧日的【其余入选票】今天不开新仓：动作标签一律换成
 *   【总龙分歧不买】（照常列出 + 整段灰化 —— 视觉走 cashAlert.show 那一条既有通道）。
 *
 * ⛔ 与 _applyEbbBuyRules / _applyCashAlertBuyRules 同一范式：先按原口径算完，再覆盖那三处
 *   （buyActionTag / holdTag / position），⛔ 绝不改 finishBuyBlock 内部（决策看板共用，§6）。
 * ⛔ 客观数据一行不动；卖点侧一行不动（用户本轮未提卖点）。
 *
 * @param {Array} blocks buildTopicVolRatioPlan 的入选题材块数组
 * @param {object} ld leaderDiverge（todayFirst=true 才会被调用方传入）
 */
export function _applyDivergeNoBuyRules(blocks, ld) {
  if (!ld) return;
  const lead = '【总龙首次分歧】市场总龙一【' + (ld.leaderName || '—') + '】' +
    (ld.firstBoardYmd ? ('自首板 ' + ld.firstBoardYmd + ' 以来') : '') +
    '首次竞价低开（' + (ld.aucPctText || '—') + '）⇒ 分歧日：';
  (blocks || []).forEach(function(b) {
    (b.picks || []).forEach(function(p) {
      if (!p || !p.name) return;
      p.position = '';
      p.holdTag = '';
      p.buyActionTag = DIVERGE_NO_BUY_TAG;
      p.buyActionTone = DIVERGE_NO_BUY_TONE;
      p.actionNote = lead +
        '分歧日的买点侧【只有总龙一（下杀买）+ 不同题材的主板高标（≤2 只）】，本股今天【不开新仓】——' +
        '原本的【' + HOLD_TAG + '】/ 竞价买 / 尾盘买 / 先卖后买 等买点信号一律作废。' +
        '⚠️ 下方股票仍按原规则【照常列出】，供你参考。';
    });
  });
}

/**
 * ══ [DIVERGE 2026-10-20 用户口径] 总龙首次分歧日 · 买点块（总龙一 + 跟随高标 ≤2 只）════════
 *
 * 用户原话：「市场总龙一，第一次出现分歧的时候，是买点……一般开盘它会下杀，然后反弹，
 *   所以标签应该是下杀买。也就是题材量比买点侧只有市场总龙一，还有其它不同题材的两只高标股票
 *   （20日涨幅前五的），同题材的不要……最多三只。」
 *
 * 结构与 _buildEbbPicksBlock 同款（§6 两步走）：
 *   ① 真实成员行（今日题材成员）反查客观数据，凑不齐的按缺数据渲染（§10）；
 *   ② finishBuyBlock 按决策看板同一份实现算齐客观数据与原始买点信号，
 *      然后【覆盖式】把动作标签换成 总龙一【下杀买】/ 高标【高标跟随买】，原文留进行内说明。
 *
 * @param {object} ld 组合式下发的 leaderDiverge（todayFirst=true；含 top5 / firstBoardYmd 等）
 * @param {Array} list 今日题材块（rankDecisionTopics 的返回，成员行 = 客观数据来源）
 * @param {object} fOpts finishBuyBlock 的选项（与常规块共用同一份，§6）
 * @returns {object|null} null = 不渲染（调用方保证 todayFirst 才调）
 */
export function _buildDivergeBuyBlock(ld, list, fOpts) {
  if (!ld || !ld.todayFirst || !ld.leaderName) return null;
  const sel = pickDivergeFollowers(ld.top5 || [], ld.leaderName, ld.leaderTopic || '');
  const buyPicks = [{ name: ld.leaderName, label: '总龙一', topic: ld.leaderTopic || '',
    code: ld.leaderCode || '', pct: ld.leaderPct, pctText: ld.leaderPctText || '',
    rank20: 1, isDip: true }].concat(sel.followers.map(function(c) {
      return { name: c.name, label: '总龙' + (c.rank20 || '—'), topic: c.topic || '',
        code: c.code || '', pct: c.pct, pctText: (isFinite(Number(c.pct)) ? Number(c.pct).toFixed(2) + '%' : ''),
        rank20: c.rank20, isDip: false };
    }));

  // 真实成员行：先按【它所属题材块】找，找不到再全题材按名字兜一次（与替补块同一份查找，§6 同法）
  const _memberOf = function(name) {
    let member = null;
    (list || []).forEach(function(b) {
      if (member) return;
      (b.members || []).forEach(function(m) {
        if (!member && m && String(m.name || '').trim() === name) member = m;
      });
    });
    return member;
  };

  const members = [];
  const picks = buyPicks.map(function(p, idx) {
    const member = _memberOf(p.name);
    if (member && !members.some(function(m) { return m && m.name === p.name; })) members.push(member);
    return {
      seq: idx + 1,
      name: p.name,
      dragonLabel: p.label,
      dragonRank: null,
      pct: p.pct,
      code: p.code || String((member && member.code) || '').trim(),
      pctText: p.pctText,
      aucShare: member ? _num(member.aucShare) : null,
      position: ''
    };
  });

  const namesText = buyPicks.map(function(p) {
    return '【' + (p.label || '') + p.name + '】（' + (p.topic || '—') + '，20日涨幅 ' +
      (p.pctText || '—') + '）';
  }).join('、');
  const trailText = sel.trail.map(function(t) {
    return t.name + '（' + t.reason + '）';
  }).join('；');

  const block = {
    block: {
      topic: '总龙首次分歧 · 买点',
      rank: null,
      count: null,
      yiziCount: null,
      members: members
    },
    rankWord: '',
    pickRank: null,
    reason: '【总龙首次分歧】市场总龙一【' + ld.leaderName + '】' +
      (ld.firstBoardYmd ? '自首板 ' + ld.firstBoardYmd + ' 以来' : '') +
      '首次竞价低开（' + (ld.aucPctText || '—') + '）⇒ 分歧日买点 = 总龙一（下杀买）+ 不同题材主板高标 ≤2 只：' +
      namesText,
    mode: 'diverge',
    ruleNo: DIVERGE_RULE_NO,
    isCandidate: false,
    candidateTag: '',
    qualified: true,
    notQualifiedText: '',
    picks: picks,
    notes: [
      '⚠️ 本行【不是】题材选股的结果，而是【总龙首次分歧】的买点：总龙一连续上涨后首次竞价低开，' +
        '一般开盘下杀然后反弹 ⇒【下杀买】（别在竞价追）；同时它只会带动【不同题材】的主板高标' +
        '（20日涨幅前五里选，同题材的今天跌得厉害），最多两只。',
      '【高标怎么选】= 从【20日涨幅】总龙二~总龙五里：先排非主板（创业板/科创板/北交所），' +
        '再排与总龙一同题材，剩下的取排名最靠前的前两只 —— 本日 = ' + namesText + '。',
      (trailText ? '五只去留（判定可追溯）：' + trailText + '。' : ''),
      '⚠️ 涨幅口径 = 【当日 20日涨幅】（与「20日涨幅」toggle 的总龙一~五同一列）。' +
        '题材退潮日（如有）优先走退潮规则，本规则不叠加。',
      '★ 术语对照：首板 = 20 日内第一个涨停日（分歧计数从它起算）；首次分歧 = 首板后首次竞价涨幅 < 0；' +
        '分歧转一致 = 分歧日后再度涨停（本轮仅记录，暂不参与买点）。'
    ].filter(function(s) { return !!s; }),

    topic: '总龙首次分歧 · 买点',
    rank: null,
    count: null,
    yiziCount: null,
    avgVolRatio: null,
    avgVolRatioText: '',
    tier: 'diverge',
    pickCount: 0,
    rangeText: '',
    skippedNames: [],
    isDiverge: true
  };

  // ① 客观数据 + 原始买点信号算齐（决策看板同一份实现）
  finishBuyBlock(block, fOpts);
  // ② 覆盖式：动作标签换成分歧专属（下杀买 / 高标跟随买），原文留行内说明
  (block.picks || []).forEach(function(p) {
    const me = buyPicks.filter(function(x) { return x.name === p.name; })[0] || null;
    const rawTag = p.buyActionTag || '';
    const rawNote = p.actionNote || '';
    p.buyActionTag = (me && me.isDip) ? DIVERGE_DIP_TAG : DIVERGE_FOLLOW_TAG;
    p.buyActionTone = DIVERGE_BUY_TONE;
    p.holdTag = '';
    p.position = '';
    p.actionNote = (me && me.isDip)
      ? ('【总龙首次分歧 · 下杀买】市场总龙一【' + p.name + '】自首板 ' + (ld.firstBoardYmd || '—') +
        ' 以来首次竞价低开（' + (ld.aucPctText || '—') + '）—— 一般开盘下杀然后反弹，等下杀再买、别在竞价追。' +
        (rawTag ? ('它的常规买点信号是【' + rawTag + '】——' + (rawNote || '')) : ''))
      : ('【总龙首次分歧 · 高标跟随买】它是【' + ((me && me.label) || '') + p.name + '】= 20日涨幅全市场第 ' +
        ((me && me.rank20) || '—') + '（' + ((me && me.pctText) || '—') + '，' + ((me && me.topic) || '—') +
        '），与总龙一不同题材 ⇒ 分歧日跟着总龙一走。' +
        (rawTag ? ('它的常规买点信号是【' + rawTag + '】——' + (rawNote || '')) : ''));
  });
  return block;
}

/**
 * [DIVERGE] 分歧日的大字标语（接管 cashAlert 的顶栏 —— 与退潮接管同一形状，§6 同一消费通道）。
 * @param {object} ld leaderDiverge
 * @param {number} n 分歧买点只数（总龙一 + 跟随高标）
 */
export function _buildDivergeCashAlert(ld, n) {
  return {
    show: true,
    topic: ld.leaderTopic || '',
    rank: null,
    avgVolRatio: null,
    avgVolRatioText: '—',
    threshold: TVRB_CASH_ALERT_AVG_VR,
    headline: '⚠️ 市场总龙一【' + ld.leaderName + '】首次分歧 · 分歧买点只有这 ' + n + ' 只（下杀买）',
    detail: '市场总龙一【' + ld.leaderName + '】' + (ld.leaderTopic ? '（' + ld.leaderTopic + '）' : '') +
      '自首板 ' + (ld.firstBoardYmd || '—') + ' 以来首次竞价低开（' + (ld.aucPctText || '—') +
      '）⇒ 首次分歧。分歧日买点侧只有：总龙一（下杀买）+ 不同题材的主板高标（20日涨幅前五，≤2 只）。' +
      '其余入选票照常列出但今天不开新仓（总龙分歧不买）；卖点侧不变。' +
      '⚠️ 若当天同时命中【题材退潮】，退潮规则优先，本规则让位。'
  };
}

/**
 * ══ [WEAK-HUDDLE 2026-10-27 用户口径] 第三十条 · 【弱势切抱团】买点块 ══════════════════════
 *
 * 用户原话与判据长注释见 WEAK_HUDDLE_RULE_NO 那一段（常量区）。
 * 一句话：空仓提醒命中 ⇒ 那个灰色题材块里，若有票同时是【20日涨幅主板前三】+ 同题材 ⇒ 选出来，
 * 渲染在【最前面】、标【弱势切抱团】。一只都没有 ⇒ 仍然空仓。
 *
 * 结构与 _buildDivergeBuyBlock / _buildNewDragonBlock 完全同款（§6 两步走）：
 *   ① 先把行装出来（真实题材成员行反查客观数据，凑不齐的按缺数据渲染，§10）；
 *   ② finishBuyBlock 按决策看板同一份实现算齐客观数据与原始买点信号，
 *      再【覆盖式】把动作标签换成【弱势切抱团】（⛔ 绝不去改 finishBuyBlock 内部 —— 决策看板共用）。
 *
 * ⛔ 不许自己再排一次 20日涨幅名次：池子直接吃 `ebbCtx.top5`（已是主板降序、带 rank20 / topic）。
 * ⛔ 不许因为「它已经在下面那个灰化块里出现过」就跳过 —— 那正是本条的主角
 *   （用户 10-26 / 10-27 的例子都是同一只：大业股份既是灰色块里的龙一，又是 20日涨幅主板前三）。
 *
 * @param {Array} pool        ebbCtx.top5（主板 20日涨幅降序，已富化 topic / rank20 / suspended / isYizi）
 * @param {object} cashAlert  buildCashAlert 的返回（读 .topic = 灰色题材块的题材名）
 * @param {Array} list        今日题材块（rankDecisionTopics 的返回，成员行 = 客观数据来源）
 * @param {object} fOpts      finishBuyBlock 的选项（与常规块共用同一份，§6）
 * @param {(raw:string)=>string} [coreRes] ★ [CORE-CAT 2026-10-29 用户口径] 题材大类归一函数（见 _normTopic）
 * @returns {object|null} null = 不渲染（该题材没有票进前三 / 题材名缺失 ⇒ 调用方保持空仓）
 */
export function _buildWeakHuddleBlock(pool, cashAlert, list, fOpts, coreRes) {
  const topic = _normTopic((cashAlert && cashAlert.topic) || '', coreRes);
  if (!topic) return null;
  // ① 前 WEAK_HUDDLE_TOP_N 名里，挑【与灰色题材块同题材】的
  // ★★ [CORE-CAT 2026-10-29 用户报障] 必须过【核心词大类归一】（_sameTopicLoose + coreRes），
  //   ⛔ 不能再用严格字符串相等 —— 这两侧天生是【两个层级】的名字：
  //     · `cashAlert.topic` = 题材块的块名 = 核心管理里的【大类名】（getTopicGroups 用 coreName 建组，
  //       见 topic/rules.js#getTopicGroups ⇒ 「大消费」）；
  //     · `pool[i].topic`  = 池里那票【行上的细分题材原文】（decision-collect#_topicOf 取不到今日行时
  //       退回上一交易日行情行的 topics 串 ⇒ 「家电」）。
  //   10-29 实测：灰色块【大消费】、20日涨幅主板前三含 九阳股份（家电），严格相等 ⇒ 判成
  //   「其中【没有】大消费 的股票 ⇒ 今天仍然空仓」（用户原话）。同一文件里 classifyMainTopic /
  //   detectEbbDay / _applyPrevEbbSecondNoBuy 早就走 coreRes 归一 ⇒ 这里是【第二把尺子】（违反 §6）。
  const hits = (Array.isArray(pool) ? pool.slice(0, WEAK_HUDDLE_TOP_N) : []).filter(function(t) {
    return t && t.name && _sameTopicLoose(t.topic, topic, coreRes);
  });
  if (hits.length === 0) return null;

  const buyPicks = hits.map(function(t) {
    return {
      name: String(t.name).trim(),
      label: totalDragonLabel(Number(t.rank20)) || '',
      topic: t.topic || '',
      code: t.code || '',
      pct: t.pct,
      pctText: isFinite(Number(t.pct)) ? Number(t.pct).toFixed(2) + '%' : '',
      rank20: t.rank20
    };
  });

  // 真实成员行：全题材按名字兜一次（§6 唯一实现 = _findMemberByName，第三十二条共用同一份查找）
  const members = [];
  const picks = buyPicks.map(function(p, idx) {
    const member = _findMemberByName(list, p.name);
    if (member && !members.some(function(m) { return m && m.name === p.name; })) members.push(member);
    return {
      seq: idx + 1,
      name: p.name,
      dragonLabel: p.label,
      dragonRank: null,
      pct: p.pct,
      code: p.code || String((member && member.code) || '').trim(),
      pctText: p.pctText,
      aucShare: member ? _num(member.aucShare) : null,
      position: ''
    };
  });

  const namesText = buyPicks.map(function(p) {
    return '【' + (p.label || '') + p.name + '】（' + (p.topic || '—') + '，20日涨幅 ' +
      (p.pctText || '—') + '，主板第 ' + (p.rank20 || '—') + ' 名）';
  }).join('、');

  const block = {
    block: {
      topic: WEAK_HUDDLE_BLOCK_TOPIC,
      rank: null,
      count: null,
      yiziCount: null,
      members: members
    },
    rankWord: '',
    pickRank: null,
    reason: '【弱势切抱团】能入选的排名第一题材【' + topic + '】平均竞价量比 ' +
      cashAlert.avgVolRatioText + ' ＜ ' + cashAlert.threshold + ' ⇒ 题材退潮（第十九条：买点侧整段灰化、' +
      '建议空仓）。但它的票里有【20日涨幅主板前三】⇒ 行情差时资金会抱团最强的市场龙头，' +
      '这一只可以作为当天买入的票：' + namesText,
    mode: 'weakhuddle',
    ruleNo: WEAK_HUDDLE_RULE_NO,
    isCandidate: false,
    candidateTag: '',
    qualified: true,
    notQualifiedText: '',
    picks: picks,
    notes: [
      '⚠️ 本行【不是】题材选股的结果，也不是「题材没退潮」—— 那个题材照旧退潮、下面那一块照旧灰化。' +
        '本行是【从市场龙头里选】：行情差时资金会抱团最强的市场龙头（也是题材龙头），叫【弱势切抱团】。',
      '【怎么选】= 取【20日涨幅主板前三名】（只数主板：创业板 300/301、科创板 688/689、北交所一律不算名次；' +
        '与「20日涨幅」toggle 的总龙一~三名同一把尺子），再在其中挑【与灰色题材块同题材】的 —— 本日 = ' +
        namesText + '。',
      '⚠️ 一只都不在前三名 ⇒ 仍然空仓（不选、不替补）。',
      '⚠️ 它同时仍会在下面那个灰化块里出现一次：那一块是【题材结论】（整块灰化、标签【' +
        CASH_NO_BUY_TAG + '】），这一行是【股票结论】—— 题材结论与股票结论是两件事，' +
        '⛔ 不用合并、也不用删掉任何一处。',
      '⚠️ 涨幅口径 = 【当日 20日涨幅】（与「20日涨幅」toggle 的总龙一~五同一列）。'
    ],
    topic: WEAK_HUDDLE_BLOCK_TOPIC,
    rank: null,
    count: null,
    yiziCount: null,
    avgVolRatio: null,
    avgVolRatioText: '',
    tier: 'weakhuddle',
    pickCount: 0,
    rangeText: '',
    skippedNames: [],
    isWeakHuddle: true
  };

  // ① 客观数据 + 原始买点信号算齐（决策看板同一份实现）
  finishBuyBlock(block, fOpts);
  // ② 覆盖式：动作标签换成【弱势切抱团】，原文留进行内说明
  (block.picks || []).forEach(function(p) {
    const me = buyPicks.filter(function(x) { return x.name === p.name; })[0] || null;
    const rawTag = p.buyActionTag || '';
    const rawNote = p.actionNote || '';
    p.buyActionTag = WEAK_HUDDLE_TAG;
    p.buyActionTone = WEAK_HUDDLE_TONE;
    p.holdTag = '';
    p.position = '';
    p.actionNote = '【第' + WEAK_HUDDLE_RULE_NO + '条 · 弱势切抱团】它是【' + topic + '】的股票，' +
      '该题材平均竞价量比只有 ' + cashAlert.avgVolRatioText + '（＜ ' + cashAlert.threshold +
      '）⇒ 题材已退潮、下面那一块整段灰化不开新仓；' +
      '但它是【20日涨幅主板第 ' + ((me && me.rank20) || '—') + ' 名】（' + ((me && me.pctText) || '—') +
      '），在【前三】之内 ⇒ 行情差时资金会抱团最强的市场龙头，这一只今天可以买（弱势切抱团）。' +
      // [TVRB-AUC-YIZI 2026-11-10 用户口径] 一字票照常选进，但必须说清「等开板后进」；
      //   行上那枚橙色虚线徽标由 tvrb-plan.js 的统一后处理 annotateAuctionYizi 挂（§6 单一真相）。
      '⚠️ 停牌 / 竞价一字的信息照常显示；竞价一字涨停的票【可以买，但要等开板后再进】，别在封板上硬追。' +
      (rawTag ? ('它的常规买点信号是【' + rawTag + '】——' + (rawNote || '')) : '');
  });
  return block;
}

/**
 * ══ [LEADER-LIMITDOWN 2026-11-02 用户口径] 第三十二条 · 【题材龙一竞价跌停 ⇒ 弱势切抱团】买点块 ══
 *
 * 判据与用户原话见常量区 TOPIC_LEADER_LIMITDOWN_RULE_NO 的长注释。一句话：
 *   排名第一的入选题材里【最强的那只】竞价就跌停 ⇒ 这个题材今天已经弱势 ⇒ 不选它，
 *   改从 20日涨幅（竞价口径、只主板）取【市场总龙一】那一只抱团。
 *
 * ⛔ 与第三十条 _buildWeakHuddleBlock 的关系（同一枚标签、同一档紫罗兰配色，但是两条规则）：
 *   · 第三十条：池子 = 前三名，筛【与退潮题材同题材】的那几只 ⇒ 可能 ≥1 只；
 *   · 本条    ：池子 = 第 1 名，⛔ 不做题材筛选（抱团对象就是市场总龙一本身）⇒ 恒定 1 只。
 *   两者共用【weakHuddle 槽位 / 渲染通道 / 分笔抓取 / buy-quiesce 标签】，⛔ 不新开一套视觉。
 *
 * @param {Array} pool 20日涨幅主板前五富化（`ebbCtx.top5`，已按名次降序 + 带 topic / rank20）
 * @param {{topic:string, name:string, aucPctText:string, count:number, avgText:string}} ld
 *        out.leaderLimitDown（第三十二条的事实）
 * @param {Array} list 题材块数组（用来找那只票的真实成员行：code / aucShare）
 * @param {object} fOpts finishBuyBlock 的入参（§6 决策看板同一份实现）
 * @returns {{block:object|null, reason:string}} reason：'' 成功 / 'no-pool' 池子空 / 'same' 与跌停的龙一是同一只
 */
export function _buildLeaderLimitDownHuddleBlock(pool, ld, list, fOpts) {
  const arr = Array.isArray(pool) ? pool : [];
  const t = arr.length > 0 ? arr[0] : null;   // ★ 市场总龙一 = 20日涨幅主板第 1 名（池子已按名次降序）
  if (!t || !t.name) return { block: null, reason: 'no-pool' };
  const pickName = String(t.name).trim();
  // ⛔ 同一只票不可能既是「竞价跌停的题材龙一」又是「今天要抱团买的票」：
  //   数据若真的这样给（池子名次还没跟上今天的跌停），本条就判不出可买标的，如实交回调用方。
  if (ld && String(ld.name || '').trim() === pickName) return { block: null, reason: 'same' };

  const pctNum = Number(t.pct);
  const pick = {
    name: pickName,
    label: totalDragonLabel(Number(t.rank20)) || '',
    topic: t.topic || '',
    code: String(t.code || '').trim(),
    pct: t.pct,
    pctText: isFinite(pctNum) ? pctNum.toFixed(2) + '%' : '',
    rank20: t.rank20
  };
  const member = _findMemberByName(list, pickName);
  const members = member ? [member] : [];
  const picks = [{
    seq: 1,
    name: pickName,
    dragonLabel: pick.label,
    dragonRank: null,
    pct: pick.pct,
    code: pick.code || String((member && member.code) || '').trim(),
    pctText: pick.pctText,
    aucShare: member ? _num(member.aucShare) : null,
    position: ''
  }];
  const nameText = '【' + (pick.label || '') + pickName + '】（' + (pick.topic || '—') +
    '，20日涨幅 ' + (pick.pctText || '—') + '，主板第 ' + (pick.rank20 || '—') + ' 名）';
  const ldTopic = String((ld && ld.topic) || '—');
  const ldName = String((ld && ld.name) || '—');
  const ldPctText = String((ld && ld.aucPctText) || '—');

  const block = {
    block: {
      topic: TOPIC_LEADER_LIMITDOWN_BLOCK_TOPIC,
      rank: null,
      count: null,
      yiziCount: null,
      members: members
    },
    rankWord: '',
    pickRank: null,
    reason: '【弱势切抱团】排名第一的题材【' + ldTopic + '】的龙一【' + ldName + '】9:25 竞价涨幅 ' +
      ldPctText + ' = 【竞价跌停】⇒ 题材内【最强】的那只都被摁在跌停板上（也根本买不进）⇒ ' +
      '这个题材今天已经【弱势】、不再作为当日主线 ⇒ 本题材不选股；改从【20日涨幅】取【市场总龙一】' +
      '抱团：' + nameText,
    mode: 'weakhuddle',
    ruleNo: TOPIC_LEADER_LIMITDOWN_RULE_NO,
    isCandidate: false,
    candidateTag: '',
    qualified: true,
    notQualifiedText: '',
    picks: picks,
    notes: [
      '⚠️ 本行【不是】题材选股的结果：那个题材照常列在买点侧，但整块今天【不买】' +
        '（块内每只票的标签是【' + TOPIC_LEADER_LIMITDOWN_NO_BUY_TAG + '】）。' +
        '本行是【从市场龙头里选】：题材里最强的那只都跌停了，就去抱团全市场最强的那一只。',
      '【怎么选】= 取【20日涨幅主板第 1 名】（只数主板：创业板 300/301、科创板 688/689、北交所一律' +
        '不算名次；与「20日涨幅」toggle 的总龙一同一把尺子、同一份竞价口径），⛔ 不在这里另排一次名次。',
      '【为什么跌停就不选这个题材】用户口径：题材内的龙一都跌停了，说明这个题材【弱势】了 ——' +
        '龙位是题材内最强的那只，它被摁在跌停板上，龙二龙三只会更弱；从一个走弱的题材里挑次强的票，' +
        '正是本条要否掉的选法。',
      '⚠️ 跌停判据 = 该股 9:25 竞价涨幅打在【跌停价】上（主板 10% / 创业板·科创板 20% / 北交所 30% /' +
        ' ST 5%，容差 0.15），与「涨跌停」看板【同一份实现】（limit-up.js）。',
      '⚠️ 龙一的竞价涨幅读不到 ⇒ 判不出 ⇒ 本条不生效（⛔ 不把「没数据」当跌停，也不当没跌停）。',
      '⚠️ 本条成立时买点侧【只有这一只】：⛔ 不取第二只、⛔ 不顺延到排名第二的题材。',
      '⚠️ 涨幅口径 = 【当日 20日涨幅】（竞价口径，与「20日涨幅」toggle 的总龙一同一列）。'
    ],
    topic: TOPIC_LEADER_LIMITDOWN_BLOCK_TOPIC,
    rank: null,
    count: null,
    yiziCount: null,
    avgVolRatio: null,
    avgVolRatioText: '',
    tier: 'weakhuddle',
    pickCount: 0,
    rangeText: '',
    skippedNames: [],
    isWeakHuddle: true,
    // ★ 与第三十条区分用（单测 / 排查文案时能一眼看出是哪一条规则产出的）
    isLeaderLimitDownHuddle: true
  };

  // ① 客观数据 + 原始买点信号算齐（决策看板同一份实现）
  finishBuyBlock(block, fOpts);
  // ② 覆盖式：动作标签换成【弱势切抱团】，原文留进行内说明
  (block.picks || []).forEach(function(p) {
    const rawTag = p.buyActionTag || '';
    const rawNote = p.actionNote || '';
    p.buyActionTag = TOPIC_LEADER_LIMITDOWN_TAG;
    p.buyActionTone = WEAK_HUDDLE_TONE;
    p.holdTag = '';
    p.position = '';
    p.actionNote = '【第' + TOPIC_LEADER_LIMITDOWN_RULE_NO + '条 · 弱势切抱团】排名第一的题材【' +
      ldTopic + '】的龙一【' + ldName + '】竞价就跌停（' + ldPctText + '）⇒ 那个题材今天【弱势】、不选股；' +
      '本股是【20日涨幅主板第 ' + (pick.rank20 || '—') + ' 名】（' + (pick.pctText || '—') +
      '）= 【市场总龙一】⇒ 题材走弱时资金会抱团最强的市场龙头，这一只今天可以买（弱势切抱团）。' +
      // [TVRB-AUC-YIZI 2026-11-10 用户口径] 一字票照常选进，但必须说清「等开板后进」；
      //   行上那枚橙色虚线徽标由 tvrb-plan.js 的统一后处理 annotateAuctionYizi 挂（§6 单一真相）。
      '⚠️ 停牌 / 竞价一字的信息照常显示；竞价一字涨停的票【可以买，但要等开板后再进】，别在封板上硬追。' +
      (rawTag ? ('它的常规买点信号是【' + rawTag + '】——' + (rawNote || '')) : '');
  });
  return { block: block, reason: '' };
}

/**
 * ══ [CATCH-UP 2026-10-27 用户口径] 第三十一条 · 【补涨题材】买点块 ═════════════════════════
 *
 * 用户原话与判据长注释见 CATCH_UP_RULE_NO 那一段（常量区）。
 * 一句话：空仓提醒命中 ⇒ 灰色题材块里若有【恰好 2~3 只】票落在【20日涨幅主板第 6~10 名】，
 * 该题材叫【补涨题材】（低位补涨、后期往往很好）⇒ 从这几只里【只选连板票】。
 *
 * 结构与 _buildWeakHuddleBlock 完全同款（§6 两步走）：先装行 → finishBuyBlock 算客观数据 →
 * 覆盖式换动作标签。⛔ 不去改 finishBuyBlock 内部（决策看板共用）。
 *
 * @param {Array} topicPool   ebbCtx.topicPool（20日涨幅【前十】富化：name/pct/days/code/topic/rank20/streak）
 * @param {object} cashAlert  buildCashAlert 的返回（读 .topic = 灰色题材块的题材名）
 * @param {Array} list        今日题材块（成员行 = 客观数据来源）
 * @param {object} fOpts      finishBuyBlock 的选项
 * @param {(raw:string)=>string} [coreRes] ★ [CORE-CAT 2026-10-29 用户口径] 题材大类归一函数（见 _normTopic）
 * @returns {{block:object|null, reason:string}} reason = 不渲染的原因（供调用方写说明，§10 不沉默）
 */
export function _buildCatchUpBlock(topicPool, cashAlert, list, fOpts, coreRes) {
  const topic = _normTopic((cashAlert && cashAlert.topic) || '', coreRes);
  if (!topic) return { block: null, reason: 'no-topic' };
  // ① 名次区间内 ∧ 同题材（★ 与第三十条同一把尺子：走核心词大类归一，见那边的长注释）
  const inRange = (Array.isArray(topicPool) ? topicPool : []).filter(function(t) {
    if (!t || !t.name) return false;
    const r = Number(t.rank20);
    if (!isFinite(r) || r < CATCH_UP_RANK_FROM || r > CATCH_UP_RANK_TO) return false;
    return _sameTopicLoose(t.topic, topic, coreRes);
  });
  if (inRange.length === 0) return { block: null, reason: 'none' };
  // ② 数量门槛：恰好 2~3 只（4 只以上 = 已是主线，不是低位补涨）
  if (inRange.length < CATCH_UP_MIN_COUNT || inRange.length > CATCH_UP_MAX_COUNT) {
    return { block: null, reason: 'count', count: inRange.length };
  }
  // ③ 只留连板票（streak 未知 ⇒ 不算连板，§10 不猜）
  //   ⚠️ 必须显式挡 null / undefined / ''：`Number(null)` = 0、`Number('')` = 0 ⇒ 会被当成「趋势」，
  //      而「趋势」与「读不到」在文案上是两回事（§10：未知 ≠ 没有）。
  const streakOf = function(t) {
    if (!t || t.streak === null || t.streak === undefined || t.streak === '') return null;
    const n = Number(t.streak);
    return isFinite(n) ? n : null;
  };
  const hits = inRange.filter(function(t) {
    const st = streakOf(t);
    return st !== null && st >= CATCH_UP_MIN_STREAK;
  });
  if (hits.length === 0) return { block: null, reason: 'no-streak', count: inRange.length, inRange: inRange };

  const buyPicks = hits.map(function(t) {
    const st = streakOf(t);
    return {
      name: String(t.name).trim(),
      label: '',
      topic: t.topic || '',
      code: t.code || '',
      pct: t.pct,
      pctText: isFinite(Number(t.pct)) ? Number(t.pct).toFixed(2) + '%' : '',
      rank20: Number(t.rank20),
      streak: st,
      streakText: _streakWord(t, st)
    };
  });

  // 真实成员行：全题材按名字兜一次（与替补 / 分歧 / 弱抱团同一份查找，§6 同法）
  const _memberOf = function(name) {
    let member = null;
    (list || []).forEach(function(b) {
      if (member) return;
      (b.members || []).forEach(function(m) {
        if (!member && m && String(m.name || '').trim() === name) member = m;
      });
    });
    return member;
  };

  const members = [];
  const picks = buyPicks.map(function(p, idx) {
    const member = _memberOf(p.name);
    if (member && !members.some(function(m) { return m && m.name === p.name; })) members.push(member);
    return {
      seq: idx + 1,
      name: p.name,
      dragonLabel: p.label,
      dragonRank: null,
      pct: p.pct,
      code: p.code || String((member && member.code) || '').trim(),
      pctText: p.pctText,
      aucShare: member ? _num(member.aucShare) : null,
      position: ''
    };
  });

  const namesText = buyPicks.map(function(p) {
    return '【' + p.name + '】（' + (p.topic || '—') + '，20日涨幅 ' + (p.pctText || '—') +
      '，主板第 ' + p.rank20 + ' 名，' + (p.streakText || '连板天数未知') + '）';
  }).join('、');
  const inRangeText = inRange.map(function(t) {
    const st = streakOf(t);
    return t.name + '（第 ' + Number(t.rank20) + ' 名' + (st === null ? '' : '，' + _streakWord(t, st)) + '）';
  }).join('、');

  const block = {
    block: {
      topic: CATCH_UP_BLOCK_TOPIC,
      rank: null,
      count: null,
      yiziCount: null,
      members: members
    },
    rankWord: '',
    pickRank: null,
    reason: '【补涨题材】能入选的排名第一题材【' + topic + '】平均竞价量比 ' +
      cashAlert.avgVolRatioText + ' ＜ ' + cashAlert.threshold + ' ⇒ 题材退潮（第十九条：买点侧整段灰化、' +
      '建议空仓）。但该题材有 ' + inRange.length + ' 只票落在【20日涨幅主板第 ' + CATCH_UP_RANK_FROM +
      '~' + CATCH_UP_RANK_TO + ' 名】⇒ 属【低位补涨题材】（后期往往很好），' +
      '其中连板票是：' + namesText,
    mode: 'catchup',
    ruleNo: CATCH_UP_RULE_NO,
    isCandidate: false,
    candidateTag: '',
    qualified: true,
    notQualifiedText: '',
    picks: picks,
    notes: [
      '⚠️ 本行【不是】题材选股的结果，也不是「题材没退潮」—— 那个题材照旧退潮、下面那一块照旧灰化。' +
        '本行是【按市场排名选】：处在前三之外、第 6~10 名（后段）的票，往往是低位补涨资金在接。',
      '【怎么选】= 先数【20日涨幅主板第 ' + CATCH_UP_RANK_FROM + '~' + CATCH_UP_RANK_TO + ' 名】里' +
        '与灰色题材块【同题材】的票，必须【恰好 ' + CATCH_UP_MIN_COUNT + '~' + CATCH_UP_MAX_COUNT +
        ' 只】（4 只以上说明它已是主线、不是低位补涨）；再在其中【只留连板票】' +
        '（连板天数 ≥ ' + CATCH_UP_MIN_STREAK + '，收盘口径，与「连板天梯」同一把尺子）—— ' +
        '本日候选 = ' + inRangeText + '。',
      '⚠️ 数量不落在 ' + CATCH_UP_MIN_COUNT + '~' + CATCH_UP_MAX_COUNT + ' 只、或这几只里【一只连板都没有】' +
        '⇒ 仍然空仓（不选、不替补）。',
      '⚠️ 与第三十条【弱势切抱团】是两个不同名次区间：前三走第三十条，第 ' + CATCH_UP_RANK_FROM +
        '~' + CATCH_UP_RANK_TO + ' 名走本条 —— 互不影响，同一天可能各出一只。',
      '⚠️ 它同时仍会在下面那个灰化块里出现一次：那一块是【题材结论】（整块灰化、标签【' +
        CASH_NO_BUY_TAG + '】），这一行是【股票结论】—— 两处都保留。',
      '⚠️ 涨幅口径 = 【当日 20日涨幅】（9:26 竞价口径那一列），与「20日涨幅」toggle 同一列。'
    ],
    topic: CATCH_UP_BLOCK_TOPIC,
    rank: null,
    count: null,
    yiziCount: null,
    avgVolRatio: null,
    avgVolRatioText: '',
    tier: 'catchup',
    pickCount: 0,
    rangeText: '',
    skippedNames: [],
    isCatchUp: true
  };

  // ① 客观数据 + 原始买点信号算齐（决策看板同一份实现）
  finishBuyBlock(block, fOpts);
  // ② 覆盖式：动作标签换成【补涨题材】
  (block.picks || []).forEach(function(p) {
    const me = buyPicks.filter(function(x) { return x.name === p.name; })[0] || null;
    const rawTag = p.buyActionTag || '';
    const rawNote = p.actionNote || '';
    p.buyActionTag = CATCH_UP_TAG;
    p.buyActionTone = CATCH_UP_TONE;
    p.holdTag = '';
    p.position = '';
    p.actionNote = '【第' + CATCH_UP_RULE_NO + '条 · 补涨题材】它是【' + topic + '】的股票，' +
      '该题材平均竞价量比只有 ' + cashAlert.avgVolRatioText + '（＜ ' + cashAlert.threshold +
      '）⇒ 题材已退潮、下面那一块整段灰化不开新仓；' +
      '但这个题材有 ' + inRange.length + ' 只票落在【20日涨幅主板第 ' + CATCH_UP_RANK_FROM + '~' +
      CATCH_UP_RANK_TO + ' 名】⇒ 属【低位补涨题材】；它是【主板第 ' + ((me && me.rank20) || '—') +
      ' 名】（' + ((me && me.pctText) || '—') + '）、' + ((me && me.streakText) || '连板天数未知') +
      '，是这几只里【最强势的连板票】⇒ 这一只今天可以买（补涨题材只选连板票）。' +
      // [TVRB-AUC-YIZI 2026-11-10 用户口径] 一字票照常选进，但必须说清「等开板后进」；
      //   行上那枚橙色虚线徽标由 tvrb-plan.js 的统一后处理 annotateAuctionYizi 挂（§6 单一真相）。
      '⚠️ 停牌 / 竞价一字的信息照常显示；竞价一字涨停的票【可以买，但要等开板后再进】，别在封板上硬追。' +
      (rawTag ? ('它的常规买点信号是【' + rawTag + '】——' + (rawNote || '')) : '');
  });
  return { block: block, reason: 'hit', count: inRange.length, inRange: inRange };
}

/**
 * 【题材股票数量 → 本看板档位】（§6 唯一实现）。
 *
 * 用户口径（2026-10-11）：
 *   < 4 只     → 'none'：该题材【不入选】（排除，顺延到下一题材）
 *   4 ~ 8 只   → 'mid' ：入选 1 只
 *   > 8 只     → 'big' ：入选 2 只
 *
 * §10：count 缺失 / 非法 → 按 0 处理 ⇒ 落到 'none'（不入选），
 *      ⛔ 绝不因为「数字没读到」就假装它是一只大题材去铺票。
 *
 * @param {number|string|null} count 题材在早盘竞价里的股票只数（block.count）
 * @returns {{tier:'none'|'mid'|'big', count:number, pickCount:number, rangeText:string}}
 */
export function resolveTvrbTier(count) {
  const n = _num(count);
  const c = (n === null || n < 0) ? 0 : Math.floor(n);
  if (c < TVRB_MIN_COUNT) {
    return { tier: 'none', count: c, pickCount: 0, rangeText: '不足 ' + TVRB_MIN_COUNT + ' 只' };
  }
  if (c <= TVRB_MID_MAX) {
    return {
      tier: 'mid', count: c, pickCount: TVRB_PICK_MID,
      rangeText: TVRB_MIN_COUNT + ' ~ ' + TVRB_MID_MAX + ' 只'
    };
  }
  return {
    tier: 'big', count: c, pickCount: TVRB_PICK_BIG,
    rangeText: '> ' + TVRB_MID_MAX + ' 只'
  };
}

/**
 * 题材的【平均竞价量比】—— 与 rankDecisionTopics 用来排序的口径【完全一致】（§6 单一真相）。
 *
 * 口径 = 该题材组内【所有拿到量比的行】的量比之和 ÷ 拿到量比的行数。
 *   · 含灰行（不可计数的继承票）—— 与早盘竞价统计条同一个分母；
 *   · 一行都拿不到 ⇒ null（§10：绝不返回 0，那会被读成「量比极小」）。
 *
 * ⛔ 排序本身【不在这里做】：题材顺序由 rankDecisionTopics（= sortByTopicGroups）给出，
 *   本函数只负责把那个顺序背后的数值【显示出来】，两处若各写一份必然分叉。
 *
 * @param {object} block rankDecisionTopics 返回的题材块（members 里有 aucVolRatio）
 * @returns {number|null}
 */
export function avgVolRatioOf(block) {
  const ms = (block && block.members) || [];
  let sum = 0;
  let n = 0;
  ms.forEach(function(m) {
    const v = _num(m && m.aucVolRatio);
    if (v === null) return;
    sum += v;
    n++;
  });
  return n > 0 ? (sum / n) : null;
}

/** 平均竞价量比 → 展示文案（缺值 → '—'，§10 不补 0.00） */
export function formatAvgVolRatio(v) {
  const n = _num(v);
  return n === null ? '—' : n.toFixed(2);
}

/**
 * 【空仓提醒】判据 —— 见 TVRB_CASH_ALERT_AVG_VR 的长注释（用户第四轮口径）。
 *
 * 入参必须是【入选题材里排名第一的那个块】（= blocks[0]，即 buy.heavy），
 * ⛔ 不是「全部题材排名第一」——量比最高的题材常常因为数量不足 4 只已经被排除了
 *    （用户举的例子：电力新能源 45.92 / 3 只被排除 ⇒ 看 AI应用 21.51 / 14 只）。
 *
 * 三种「不提示」都必须显式处理，⛔ 绝不退化成「提示」或「不提示」的默认值：
 *   ① 没有入选题材（leadBlock 为空）⇒ 不提示（那是「没有合格题材」，看板另有说明）；
 *   ② 该题材平均量比读不出来（null）⇒ 不提示（§10：未知 ≠ 低）；
 *   ③ 平均量比 ≥ 门槛 ⇒ 不提示。
 *
 * @param {object|null} leadBlock 入选题材里排名第一的块（buildTopicVolRatioPlan 里的 blocks[0]）
 * @param {object|null} [ebb] detectEbbDay 的返回 —— ★ [EBB 2026-10-13 第五轮] 退潮首日【优先】：
 *        退潮日直接给退潮口径的空仓标语（用户口径「买点侧是提示空仓的……把买点侧的文字或者 UI
 *        全部变成灰色，这样空仓效果更加强烈些」），⛔ 不再去算平均量比那条（退潮是更强、更具体的原因）。
 * @returns {{show:boolean, topic:string, rank:number|null, avgVolRatio:number|null,
 *            avgVolRatioText:string, threshold:number, headline:string, detail:string}}
 */
export function buildCashAlert(leadBlock, ebb) {
  // ★ [EBB 2026-10-13] 退潮首日 ⇒ 空仓（理由比「量比低」更硬：最强的那只都停了 / 占比不达标）
  if (ebb) {
    return {
      show: true,
      topic: ebb.leaderTopic || '',
      rank: null,
      avgVolRatio: null,
      avgVolRatioText: '—',
      threshold: TVRB_CASH_ALERT_AVG_VR,
      headline: ebb.buyHeadline,
      detail: ebb.buyDetail
    };
  }
  if (!leadBlock || !leadBlock.block) return TVRB_CASH_ALERT_NONE;
  const avg = avgVolRatioOf(leadBlock.block);
  if (avg === null) return TVRB_CASH_ALERT_NONE;           // §10：缺数据 ⇒ 不提示
  if (!(avg < TVRB_CASH_ALERT_AVG_VR)) return TVRB_CASH_ALERT_NONE;

  const topic = String(leadBlock.topic || '');
  const avgText = formatAvgVolRatio(avg);
  return {
    show: true,
    topic: topic,
    rank: leadBlock.rank === undefined ? null : leadBlock.rank,
    avgVolRatio: avg,
    avgVolRatioText: avgText,
    threshold: TVRB_CASH_ALERT_AVG_VR,
    // 大字标语（§21：文案在 Logic 层拼好，模板零计算）
    headline: '⚠️ 今日建议空仓 · 不开仓',
    // 小字说明：把「为什么」「股票照常列出」讲清楚 —— 用户原话「看到这些文字，我就不开仓了」
    detail: '能入选的排名第一题材【' + topic + '】平均竞价量比 ' + avgText + ' ＜ ' +
      TVRB_CASH_ALERT_AVG_VR + ' ⇒ 题材退潮（最强题材的量比都这么低，当天什么票都容易走弱）。' +
      '⚠️ 下方股票仍按原规则【照常列出】（供参考、不删不改），但看到本提示建议今天不开仓。'
  };
}

/**
 * 题材块 → 本看板的【可买候选序列】（按【龙位升序】：龙一 → 龙二 → …）。
 *
 * 成分（§6：只做「成员 × 龙位名册」的联结与排序，⛔ 不自己判板块）：
 *   · 龙位取自 dragonMap（= rankDragons 的返回）。⭐【只发主板龙标签】的闸门就在
 *     computeDragonRankMap 里：创业板 300/301、科创板 688/689 的 rank 恒为 null ⇒
 *     这里 `rank === null` 直接剔除，与早盘竞价「没有龙标签」的判定完全同源
 *     （⛔ 绝不在这里另写 getBoardKind / startsWith('30') 之类的板块判断 —— 那就是第二份规则）。
 *   · ⛔ 竞价一字的成员【保留】在序列里（由调用方跳过并顺延）——
 *     用户口径是「龙一竞价涨停的，看龙二」，所以它必须占在序列里才能被识别为「被跳过的那一档」。
 *   · 排序：龙位升序；同龙位（理论上不会出现）按股票名，保证结果可复现、不随机。
 *
 * ⚠️ 同时带上 `aucShare`（竞价占比）：它是【选票无关】的展示 / 判定输入 ——
 *    decision-rules#_markHold（跑在 _decorateAucBadge 之前）要靠它判【先卖后买】，
 *    所以必须在进 finishBuyBlock 之前就挂在 pick 上（与决策看板 _buyCandidates 同一做法，§6）。
 *
 * @param {object} block 题材块（含 members；members 里有 name / isYizi / pct / aucPct / aucVolRatio / aucShare）
 * @param {Map} dragonMap 龙位名册（rankDragons / rankDragonsWithPctMap 的返回）
 * @param {Map<string,{pct:number|null}>} [pctMap] ★ [TVRB-926] 【9:26 口径】的区间涨幅
 *        （readAuctionLegRangeMap 的返回）—— 有它时，行上的十日涨幅取它（与龙位同源），
 *        ⛔ 缺这只票 ⇒ 退回成员自带的 pct（§10 不补 0，理由见 decision-rules#rankDragonsWithPctMap）。
 * @returns {Array<{name:string, isYizi:boolean, pct:number|null, aucPct:number|null,
 *                  aucVolRatio:number|null, aucShare:number|null, rank:number}>}
 */
export function _dragonCandidates(block, dragonMap, pctMap) {
  const dm = dragonMap || new Map();
  const out = [];
  ((block && block.members) || []).forEach(function(m) {
    if (!m || !m.name) return;
    const d = dm.get(m.name);
    const rank = (d && d.rank) ? d.rank : null;
    if (rank === null) return;   // 无龙位（创业板 / 科创板）⇒ 不参与本看板选股（与决策看板同口径）
    // ★ [TVRB-926 2026-10-14] 十日涨幅 = 【9:26 口径】那份（与上面算龙位用的是同一份，§6）：
    //   ⛔ 绝不让「龙一」的标签配着收盘口径的数值 —— 那是最难查的一种内部不一致。
    const p926 = pctMap ? readRangePct(pctMap, m.name) : null;
    out.push({
      name: m.name,
      isYizi: !!m.isYizi,
      pct: (p926 === null) ? _num(m.pct) : p926,
      aucPct: _num(m.aucPct),
      aucVolRatio: _num(m.aucVolRatio),
      aucShare: _num(m.aucShare),
      // 股票代码：原样透传（§6 不另查一份）。用途 = 分笔抓取的目标代码
      //   （logic/tick/tick-minute.js#decorateTickRow 优先读行上的 code）。
      code: String(m.code || '').trim(),
      rank: rank
    });
  });
  out.sort(function(a, b) {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
  });
  return out;
}

/**
 * 构造一个入选题材的块 —— ★形状与 decision-rules#_buildTopicBuyBlock【完全一致】★。
 *
 * ⛔ 为什么必须同形状（这是本文件最容易踩的坑）：块要交给 decision-rules#finishBuyBlock
 *    做标签收口，而收口里的每一步都在读固定字段（block.block.topic / block.block.members /
 *    picks[].name / picks[].dragonRank / picks[].aucShare …）。少一个字段就是【静默】少一枚标签
 *    （不报错、不显示，最难查的那种）。
 *
 * 选股（用户口径「按龙一龙二……，龙一竞价涨停的看龙二……」）：
 *   ① 候选序列 = _dragonCandidates(block, dragonMap, pctMap) —— 已剔除无龙位票（创业板 / 科创板）、
 *      已按【龙位升序】排好（龙一 → 龙二 → …）；
 *   ② 从高到低依次取票，直到【名额】用满（本档只数 1 或 2 个名额）；
 *   ③ 【竞价涨停（竞价一字）】买不进 ⇒ 跳过、**不占名额**（顺延补位）；
 *      【连续停牌】买不进 ⇒ 跳过、**占掉一个名额**（不补位，题材跟着少取）。
 *      ⛔ 与决策看板的「占名次不递补」不同：本看板用户明确要求往下顺延（一字）／名额作废（停牌）。
 *
 * ⛔ 本看板【没有仓位口径】：picks 的 position 一律留空（用户第二轮点名的标签里没有重仓 / 轻仓，
 *    而本看板按龙位取票、本来就没有「前 N 只重仓」这回事 —— ⛔ 不凭空造一条仓位规则）。
 *    昨天真买过的票仍会被 finishBuyBlock 内部的 _markPrevBought 改写成【持有】（那是决策看板的口径）。
 *
 * ★ [TVRB-926 2026-10-14 用户口径] `dragonMap` / `pctMap` 都是【9:26 口径】那一套
 *   （rankDragonsWithPctMap + readAuctionLegRangeMap 的产物，由组合式注入）：
 *   用户要的是「早上 9:26 那一刻选中的股票，任何时候翻回来都是同一批」——
 *   收盘后 T 腿换腿会把组内十日涨幅重排、进而换掉龙一，必须用竞价腿那一份才稳定。
 *
 * ★★ [SMALL-TOPIC 2026-10-24 用户口径] `opt.order` / `opt.smallTopic` —— 小题材收紧专用：
 *   · `order`      = 指定【候选序列】（只含「当天十日涨幅前十」里的同题材票，顺序 = 龙位升序）。
 *                    给了就用它，⛔ 不再走 `_dragonCandidates` 的全量龙位序列。只用于
 *                    【排名第一 + 数量 4~6 只】那一段（见 TVRB_SMALL_TOPIC_MAX）；
 *                    ⚠️ 序列里的元素仍是 `_dragonCandidates` 的产物（同一形状、同一字段），
 *                    所以下面「竞价一字顺延 / 连续停牌占档」那一套逻辑【一行都不用改】。
 *   · `smallTopic` = 说明文案标记：本块走的是收紧口径（`reason` 里讲清「只在十日涨幅前十的同题材票里
 *                    取组内最强的那一只」），⛔ 不传 ⇒ 文案与加规则之前逐字相同（§11 零行为变化）。
 *   · `baseText`   = 十日涨幅池的口径时间文案（'9:26 竞价口径' / '收盘口径（…未读到）'），只进文案。
 *
 * @param {object} block   题材块（含 rank / topic / count / yiziCount / members）
 * @param {Map} dragonMap  龙位名册（rankDragons / rankDragonsWithPctMap 的返回）
 * @param {object} tier    resolveTvrbTier 的返回
 * @param {Map} [pctMap]   ★ [TVRB-926] 9:26 口径区间涨幅（行上十日涨幅取它；缺 ⇒ 退回成员自带值）
 * @param {Set} [skipBuyNames] 连续停牌第 2 天及以上的票（买不进 ⇒ 占档不补位）
 * @param {object} [opt]   ★★ [SMALL-TOPIC 2026-10-24] 收紧可选开关：{order, smallTopic, baseText}
 * @returns {object} 决策看板形状的买点块（+ 本看板自己的几个平铺别名，见返回值末尾）
 */
export function _buildBlock(block, dragonMap, tier, pctMap, skipBuyNames, opt) {
  const o = opt || {};
  const avg = avgVolRatioOf(block);
  const cands = (Array.isArray(o.order) && o.order.length > 0)
    ? o.order
    : _dragonCandidates(block, dragonMap, pctMap);
  const picked = [];
  const skipped = [];
  const skippedSuspend = [];
  // ★★ [SUSPEND-OCCUPY 2026-10-15 用户口径] 「档位」计数（= 已经用掉几只的名额）。
  //
  // 用户原话（逐字）：
  //   「比如龙一停牌占位，龙二是一字，那就顺位取龙三，只取一只，如果龙一没停牌，也不是一字，
  //     买龙一或者顺位下一只，买两只，相当于有龙一可以买两只，如果龙一是一字，那就可以买龙二和龙三，
  //     因为龙一比较强。停牌看不出来，舍掉龙一，只买一只靠前的」
  //
  // ⇒ 两种「买不进」的语义【不同】，必须分开算：
  //   · 【竞价一字】买不进 ⇒ **不占档位**（顺延补位）：龙一是一字 ⇒ 照样买满 N 只（龙二 + 龙三）。
  //     理由：一字是「很强」的票，用户口径明确要「看龙二、龙三」把名额买满。
  //   · 【连续停牌】买不进 ⇒ **占档位**（不补位）：龙一停牌 ⇒ 该档作废 ⇒ 只剩 1 个名额。
  //     理由：停牌票连竞价都没有，占着龙位也买不到，名额跟着作废才符合「实际能买到的票」。
  //     实测（2026-10-14 AI应用，13 只 ⇒ 取 2 只）：龙一 新华传媒【连续停牌】占掉 1 档
  //     ⇒ 只选龙二 慈文传媒 1 只（用户口径：「AI应用题材当天只选一只更加合理」）。
  let slotsUsed = 0;
  for (let i = 0; i < cands.length && slotsUsed < tier.pickCount; i++) {
    const c = cands[i];
    if (c.isYizi) { skipped.push(c); continue; }   // 竞价涨停 → 买不进 ⇒ 顺延下一龙位（⛔ 不占档位）
    // ★★ [SUSPEND-NOBUY 2026-10-14 用户口径] 连续停牌（第 2 天及以上）⇒ 买不进 ⇒ 占档位、不补位。
    //   用户原话：「停牌的股票根本不能买，也买不进……停牌首日可选入（已实现），
    //   次日还是停牌（没有竞价涨幅，竞价量，昨日成交量等），就不要选进去了……
    //   相当于一字买不进」（[SUSPEND-OCCUPY 2026-10-15] 名额语义已按用户口径区分，见上）。
    //   ⛔ 这里只【跳过 + 占一档】，不改 tier（题材只数照旧按全部成员算，用户：「当天有 14 只，选 2 只」）。
    if (skipBuyNames && skipBuyNames.has(c.name)) { skippedSuspend.push(c); slotsUsed++; continue; }
    picked.push(c);
    slotsUsed++;
  }

  const picks = picked.map(function(c, i) {
    return {
      seq: i + 1,
      name: c.name,
      dragonLabel: c.rank ? getDragonLabel(c.rank) : '',
      dragonRank: c.rank,
      pct: c.pct,
      // 股票代码（分笔抓取目标用；与决策看板卖点行的 code 同一含义，§6 只透传）
      code: c.code || '',
      // 十日涨幅文案：与决策看板同一份格式化函数（§6），模板零计算（§21）
      pctText: formatRangePct(c.pct),
      // ⚠️ 必须【预置】：decision-rules#_markHold 跑在 _decorateAucBadge 之前，
      //   它要靠 p.aucShare 判「先卖后买档」（与决策看板 _buyCandidates → _toPick 同一口径，§6）。
      aucShare: c.aucShare,
      // ⛔ 见函数头：本看板无仓位口径，留空；昨天买过的会被 _markPrevBought 改写为【持有】
      position: ''
    };
  });

  const skippedNames = skipped.map(function(c) {
    return (c.rank ? getDragonLabel(c.rank) : '') + c.name;
  });
  // ★ [SUSPEND-NOBUY 2026-10-14] 被【连续停牌】跳过的那几只（与一字分开列，文案不同、理由不同）
  const skippedSuspendNames = skippedSuspend.map(function(c) {
    return (c.rank ? getDragonLabel(c.rank) : '') + c.name;
  });

  // ★★ [SMALL-TOPIC 2026-10-24 用户口径] 收紧档的 reason 必须换口径说明：
  //   用户原话「如果排名第一的题材数量4-6只，要看10日涨幅，看有没有同题材票进入前10，
  //   如果有就选最靠前那一只」⇒ 这一档【不是】按龙一 → 龙二 顺序取票，而是按【当天十日涨幅名次】取。
  //   ⛔ 文案与判定同处一处（§6）：改取票口径时这两句必须一起改。
  const reason = o.smallTopic
    ? ('按【平均竞价量比 ' + formatAvgVolRatio(avg) + '】排第 ' + block.rank +
       '，股票数量 ' + tier.count + ' 只（' + tier.rangeText + '）⇒ 取 ' + tier.pickCount +
       ' 只；★ 本题材数量落在【' + TVRB_MIN_COUNT + '~' + TVRB_SMALL_TOPIC_MAX +
       ' 只】且是排名第一 ⇒ 收紧：只在【当天十日涨幅〔' + (o.baseText || '9:26 竞价口径') +
       '〕前十】的同题材票里取【组内最强（龙位最前）】的那一只（数量少的题材次日顶多活一只，' +
       '只买最强的）；买不进照旧：竞价一字顺延、连续停牌作废。')
    : ('按【平均竞价量比 ' + formatAvgVolRatio(avg) + '】排第 ' + block.rank +
       '，股票数量 ' + tier.count + ' 只（' + tier.rangeText + '）⇒ 取 ' + tier.pickCount +
       ' 只；按【龙一 → 龙二 → …】从高到低依次取票：遇到【竞价涨停（竞价一字）】买不进 ⇒ ' +
       '顺延到下一个龙位；遇到【连续停牌】买不进 ⇒ 该龙位【不再补位】（本题材实际少取相应只数）。');

  const notes = [];
  notes.push(o.smallTopic
    ? ('本题材按平均竞价量比排第 ' + block.rank + '（量比 ' + formatAvgVolRatio(avg) +
       '），数量 ' + tier.count + ' 只 → ' + tier.rangeText + ' ⇒ 取 ' + tier.pickCount +
       ' 只；★【小题材收紧】数量落在 ' + TVRB_MIN_COUNT + '~' + TVRB_SMALL_TOPIC_MAX +
       ' 只且是排名第一 ⇒ 不按全部龙位取票，只在【当天十日涨幅〔' + (o.baseText || '9:26 竞价口径') +
       '〕前十】的同题材票里取【组内最强（龙位最前）】的那一只（用户口径：这种数量少的，' +
       '次日能存活下来的顶多有一只，所以就买最强的）。买不进照旧：竞价一字顺延下一只、连续停牌该名额作废。')
    : ('本题材按平均竞价量比排第 ' + block.rank + '（量比 ' + formatAvgVolRatio(avg) +
       '），数量 ' + tier.count + ' 只 → ' + tier.rangeText + ' ⇒ 取 ' + tier.pickCount +
       ' 只；入选股票按龙位从高到低依次取：' +
       '【竞价涨停（竞价一字）】买不进 ⇒ 顺延到下一个龙位（名额照买满）；' +
       '【连续停牌】买不进 ⇒ 该龙位【不再补位】（停牌票连竞价都没有，占着龙位也买不到，名额跟着作废）。'));
  if (skippedNames.length > 0) {
    notes.push('⚠️ 龙位 ' + skippedNames.join('、') +
      ' 竞价涨停（买不进）⇒ 已顺延到下一个龙位（用户口径：龙一涨停看龙二，龙二涨停看龙三……）。');
  }
  if (skippedSuspendNames.length > 0) {
    notes.push('⚠️ 龙位 ' + skippedSuspendNames.join('、') +
      ' 【连续停牌】（今天停牌、昨天也停牌：没有竞价涨幅 / 竞价量 / 昨日成交量）⇒ 买不进，' +
      '该龙位【不再补位】（⛔ 与「竞价一字」不同：一字是顺延补位把那一名额买满，' +
      '停牌是该名额直接作废、本题材少取 ' + skippedSuspendNames.length + ' 只）。' +
      '⚠️ 停牌【首日】不跳（用户口径：昨天首日停牌还可以入选）——' +
      '只有连着第 2 天及以上停牌才按「买不进」处理。');
  }
  if (picks.length < tier.pickCount) {
    notes.push(o.smallTopic
      ? ('⚠️ 本题材【当天十日涨幅前十】里可买入（非竞价涨停、非连续停牌）的票不足 ' +
         tier.pickCount + ' 只 ⇒ 实际取 ' + picks.length +
         ' 只（⛔ 不从第十名之外补位 —— 收紧口径就是【只买最强的】）。')
      : ('⚠️ 本题材有龙位、且可买入（非竞价涨停、非连续停牌）的票不足 ' + tier.pickCount +
         ' 只 ⇒ 实际取 ' + picks.length + ' 只（⛔ 不从其它题材补位）。'));
  }

  return {
    // ── ① 决策看板形状的字段（finishBuyBlock / decorateDecisionRows / 通用装饰器要读的）──
    block: block,
    rankWord: '第 ' + block.rank + ' 名',
    // 圆点里的数字：本看板内按平均竞价量比的排名（数量不足 4 只的题材已剔除、不占名次）
    pickRank: block.rank,
    reason: reason,
    // mode = 档位（'mid' / 'big'）—— 与决策看板的 mode 同字段同含义（'small'/'mid'/'big'）
    mode: tier.tier,
    // 规则编号借决策看板买点段的 ①：本看板的选股口径就是「按题材数量分档、题材内取票」，
    // 说明文字里出现【规则①】时用户能对着决策看板的规则清单读（⛔ 不另立一套编号）。
    ruleNo: RULE_NO.FIRST,
    isCandidate: false,
    candidateTag: '',
    qualified: picks.length > 0,
    notQualifiedText: '',
    picks: picks,
    // 本看板自己的说明（顺延 / 少取）—— finishBuyBlock 会往同一个数组里追加 ③④⑤ 的说明
    notes: notes,

    // ── ② 本看板自己的平铺字段（组件直接读；⛔ 与决策看板字段名不冲突）──
    topic: block.topic,
    rank: block.rank,
    count: block.count,
    yiziCount: block.yiziCount,
    avgVolRatio: avg,
    avgVolRatioText: formatAvgVolRatio(avg),
    tier: tier.tier,
    pickCount: tier.pickCount,
    rangeText: tier.rangeText,
    skippedNames: skippedNames
  };
}

/**
 * 【新龙 · 买点块】—— 与退潮替补（_buildEbbPicksBlock）/ 分歧买点同一形态：
 * 单只票、独立容器、渲染在灰化容器【之外】（今天真要买的票不能被 grayscale 吞掉）。
 *
 * ⛔ 仍然要过 finishBuyBlock：客观数据（十日涨幅 / 竞价涨幅 / 量比 / 占比 / 龙标 / 连板 / 封单）
 *   全部由它算齐（§6 同一实现），本函数只在【算完之后】把动作标签覆盖成【新龙买】。
 *
 * @param {object} nd pickNewDragon 的返回（pick 必须非空）
 * @param {Array} list 当日题材块列表（反查成员行，拿量比 / 占比 / 代码）
 * @param {object} fOpts finishBuyBlock 的入参（与常规块同一份）
 * @param {{topic:string, leaderName:string, ebbDate:string}} switchDay
 * @param {number} windowDays 历史榜实际覆盖天数
 * @returns {object} 决策看板形状的买点块（+ 本看板平铺字段）
 */
export function _buildNewDragonBlock(nd, list, fOpts, switchDay, windowDays, tierPick) {
  const p = nd && nd.pick;
  if (!p || !p.name) return null;
  const name = String(p.name).trim();
  // ★★ [R3 2026-11-12 用户口径] 题材按【核心词（大类）】印（规则层已归一，见 `nd.topicText`）。
  //   用户原话：「你提就要提核心词（大类）不要说一些同义词细分」。
  const topic = String((nd && nd.topicText) || '').trim() || String(p.topic || '').trim();
  const oldTopic = _oldTopicNameOf(switchDay) || String(nd.oldTopic || '').trim() || '老龙题材';
  // ★★ [LEADER-FIRST-TOPIC 2026-11-12 用户口径] 「老题材怎么定」的完整依据（判定日 + 成员 + 霸榜天数）。
  //   用户原话：「顺便你把判断的日期选股逻辑写进选股提示那里，这样更清晰。」
  //   ⛔ 判不出首霸日 ⇒ 空串（不硬编一句话），说明文案里自然不会出现这段。
  const oldTopicBasis = _oldTopicBasisOf(switchDay);
  // ★★ [NEW-DRAGON-CERTIFY 2026-11-12] 认证龙 vs 新龙本身（两者都用第二十八条同一个买点信号）
  const cert = (nd && nd.certifier) || null;
  const isCert = !!cert && cert.name !== name;
  // ★★ [NEW-DRAGON-FAMILY 2026-11-12] 新题材（字号 / 字辈）路径 —— 最多 2 只买点
  const fam = (nd && nd.family) || null;
  const extraList = (nd && Array.isArray(nd.extras)) ? nd.extras : [];

  // 真实成员行（与退潮替补同一取法：先按题材块找，再全表按名字兜一次）
  const _findMember = function(nm) {
    let hit = null;
    (list || []).forEach(function(b) {
      if (hit) return;
      (b.members || []).forEach(function(m) {
        if (!hit && m && String(m.name || '').trim() === nm) hit = m;
      });
    });
    return hit;
  };
  const _mkPick = function(src, seq) {
    const nm = String((src && src.name) || '').trim();
    const mm = _findMember(nm);
    return {
      seq: seq,
      name: nm,
      dragonLabel: totalDragonLabel(Number(src && src.rank20) || 0),
      dragonRank: null,
      pct: _num(src && src.pct),
      code: String((src && src.code) || (mm && mm.code) || '').trim(),
      pctText: formatRangePct(_num(src && src.pct)),
      // ⚠️ 预置：finishBuyBlock 内部 _markHold 要读它（§6 与 _buildBlock 同一做法）
      aucShare: mm ? _num(mm.aucShare) : null,
      position: ''
    };
  };
  // ★★ [NEW-DRAGON-FAMILY-OLD 2026-11-12 用户口径] 竞价一字那只【也要进买点侧】，挂「等下杀买」。
  //   用户原话：「东方海洋是竞价一字涨停，所以打上标签【竞价一字涨停 等下杀买】，买点侧一样要有。」
  //   ⚠️ 停牌 / 非主板 仍然只作题材认证（真的买不进），只有 `role==='wait-buy'` 才进 picks。
  const waitBuy = !!(cert && cert.role === 'wait-buy' && String(cert.name || '').trim() !== name);
  const certSrc = (waitBuy && fam)
    ? (fam.members || []).filter(function(m) { return String(m.name || '').trim() === String(cert.name || '').trim(); })[0]
    : null;
  const certRow = waitBuy ? Object.assign(_mkPick(certSrc || cert, 1), { waitBuyTag: AUCTION_YIZI_WAIT_TAG }) : null;
  const picks = (certRow ? [certRow] : [])
    .concat([_mkPick(p, certRow ? 2 : 1)])
    .concat(extraList.map(function(x, i) { return _mkPick(x, i + (certRow ? 3 : 2)); }));

  const windowText = _windowTextOf(windowDays);
  const trailText = (nd.trail || []).map(function(t) {
    return '【' + _rankLabelOf(t.rank20) + t.name + '】' + t.reason;
  }).join('；');

  // ── 新题材路径的说明文字（§21：文案在 Logic 层拼好，模板零计算）──
  const famMemberText = fam
    ? (fam.members || []).map(function(m) {
      return m.name + '（' + _rankLabelOf(m.rank20) + (m.everBefore ? '·老面孔' : '·新面孔') + '）';
    }).join('、')
    : '';
  const famBuyText = [name].concat(extraList.map(function(x) { return String(x.name || '').trim(); })).join('、');
  // ★ [NEW-DRAGON-FAMILY-OLD] 一字那只进买点侧后，「买点」要把两只都算上（用户「买点侧一样要有」）
  const famBuyAllText = (waitBuy ? [String(cert.name || '').trim()].concat([name]) : [name])
    .concat(extraList.map(function(x) { return String(x.name || '').trim(); })).join('、');
  const famReason = fam
    ? ('【' + SWITCH_RULE_NO + '】切换日新龙·新题材【' + fam.topic + '】：' + oldTopic +
       '（老龙一 ' + (switchDay.leaderName || '—') + '）二次确认退潮（= 第二十五条【二次分歧】）后的第 2 个交易日 ⇒ 老周期结束。' +
       // ★ [LEADER-FIRST-TOPIC] 「老题材」为什么是它 —— 判定日 + 当天十几成员 + 霸榜天数（用户要的「逻辑写进提示」）
       (oldTopicBasis ? ('〔老题材怎么定：' + oldTopicBasis + '〕') : '') +
       '今日 20日涨幅（9:25 竞价口径）前十里有 ' + fam.count + ' 只【' + fam.topic + '】：' +
       famMemberText + ' ⇒ 同一题材 ≥' + fam.count + ' 只，构成【补涨新题材】。' +
       '最强的那只是【' + fam.primaryName + '】（' + _rankLabelOf(fam.bestRank) + '）' +
       (fam.primaryEverBefore
         ? '，它本身就是老周期总龙 ⇒ 具备【双重属性】（既是老龙、又是新龙），按用户口径不能一棒子打死 ⇒ 可以选入；'
         : '（不是老面孔）⇒ 只买它这一只；') +
       (cert && cert.role === 'wait-buy'
         ? ('但它今日【竞价一字涨停】⇒ 买点侧照样列出、挂【' + AUCTION_YIZI_WAIT_TAG +
            '】；实际能竞价成交的买点 = ' + famBuyText + '。')
         : (cert && cert.role === 'certify-only'
           ? ('但它今日【' + (cert.reason === 'suspended' ? '停牌' : '非主板') +
              '·买不进】⇒ 只作题材认证，实际买点 = ' + famBuyText + '。')
           : '')) +
       '⇒ 买点 = 【' + famBuyAllText + '】。')
    : null;

  const reason = fam
    ? famReason
    : ('【' + SWITCH_RULE_NO + '】切换日' + (isCert ? '新龙·认证龙' : '新龙') + '：' + (oldTopic) +
      '（老龙一 ' + (switchDay.leaderName || '—') +
      '）二次确认退潮后的第 2 个交易日 ⇒ 老周期结束。' +
      (oldTopicBasis ? ('〔老题材怎么定：' + oldTopicBasis + '〕') : '') +
      (isCert
        ? (name + '（' + (topic || '—') + '，20日涨幅 ' + formatRangePct(_num(p.pct)) + '，' +
           _rankLabelOf(p.rank20) + '）为【认证龙】：同题材【' + (cert.topic || topic || '—') +
           '】里由【' + cert.name + '】（' + _rankLabelOf(cert.rank20) + '，近 ' + windowText +
           '【首次】进入前五）认证该题材为新题材；' + name + ' 同题材且竞价口径【更靠前】' +
           '（' + _rankLabelOf(p.rank20) + '）⇒ 按口径只买最靠前的那一只，' + cert.name +
           ' 只作为判断条件。且与老龙一【不同题材】⇒ 新龙（老龙→新龙交接）。')
        : (name + '（' + (topic || '—') + '，20日涨幅 ' + formatRangePct(_num(p.pct)) + '，' +
           _rankLabelOf(p.rank20) + '）近 ' + windowText + '【首次】进入前列（此前未进前五），' +
           _todayRankPhrase(p.rank20) + '，且与老龙一【不同题材】⇒ 新龙（老龙→新龙交接）。')));

  const block = {
    block: {
      topic: (fam ? '新题材 · ' : '新龙 · ') + (topic || '—'),
      rank: null,          // ⛔ 不给圆点：本行不是题材排名
      count: null,
      yiziCount: null,
      members: picks.map(function(x) { return _findMember(x.name); }).filter(function(m) { return !!m; })
    },
    rankWord: '',
    pickRank: null,
    reason: reason,
    mode: 'newdragon',
    ruleNo: SWITCH_RULE_NO,
    isCandidate: false,
    candidateTag: '',
    qualified: true,
    notQualifiedText: '',
    picks: picks,
    notes: [
      // ★★ [LEADER-FIRST-TOPIC 2026-11-12 用户口径] 「老题材」是怎么定出来的 —— 放在第一条，
      //   因为下面所有句子里的「老题材」都取它（用户：「顺便你把判断的日期选股逻辑写进选股提示」）。
      ('【老题材怎么定】= 老龙一在近 20 个交易日内【第一次霸榜总龙一】那天，' +
       '它所在的题材组里【成员最多的那一段】（≥2 只才算）⇒ 那就是老周期炒的那条线（大类）。' +
       '⛔ 不拿「退潮当天那条落库题材」直接下结论 —— 那一条可能只是核心词归一出来的细分' +
       '（例：东方海洋的「水产品」被归成「农业」），不是它霸榜时的炒作线。' +
       (oldTopicBasis
         ? ('本日命中：' + oldTopicBasis + '。')
         : ('本日【没算出首霸日】（组合式未读到历史竞价榜 / 当天题材不足 2 只）⇒ 暂用退潮行落库题材【' +
            oldTopic + '】。'))),
      // ★★ [NEW-DRAGON-FAMILY 2026-11-12] 新题材（字号 / 字辈）—— 本轮口径，放在第一条
      (fam
        ? ('【新题材怎么找 · 字号字辈】把今日 20日涨幅（9:25 竞价口径）前十按【题材段】分组' +
           '（一个题材串可以有多段，如「水产品,农业,东方,羊字辈」）：' +
           '一个题材要算【新题材】，必须①同一题材在前十里有 ≥2 只；②组内至少有一只近 ' + windowText +
           '【没进过前五】（全是老面孔的组 = 老周期阵营，不算新题材）。' +
           '多个都成立 ⇒ 取最强的（组内最靠前那只名次最小）。' +
           '买点 = 该题材最靠前那只；它本身就是老面孔（老龙换题材）⇒ 再补一只该题材的【新面孔】；' +
           '它买不进（竞价一字 / 停牌 / 非主板）⇒ 只作题材认证。' +
           '本日各组：' + (fam.groups || []).map(function(g) {
             return g.topic + ' ' + g.count + ' 只（新面孔 ' + g.freshCount + '）';
           }).join('；') + '。')
        : ''),
      '【新龙怎么选】= 今日 20日涨幅前八（前五不够就顺延到前八）自上而下：跳过老龙一自己 → ' +
        '跳过非主板 / 竞价一字 / 停牌（买不进）→ 跳过近 ' + windowText +
        ' 已上过前五的（不是首次上榜）→ 跳过与老龙一同题材的（老周期）⇒ 剩下第一只即新龙。'
        + '⚠️ 名次按【当前时点】口径：15:00 前 = 前 19 日收盘 × 今日竞价（auc），15:00 后 = 20 日全收盘（close）'
        + '—— 同一只票早晚名次会不一样，属正常。',
      // ★★ [NEW-DRAGON-CERTIFY 2026-11-12 用户口径] 同题材择优（认证龙）—— 旧路径兜底时才生效
      (fam
        ? ''
        : ('【同题材择优 · 前五】新龙那只只用来【证明这个题材是新的】：拿到它的题材后，再回【前五】里找' +
          '同题材的其它票（同题材 = 细分题材；⛔ 与退潮判定的「主线题材 ≥3 只」不是一回事），' +
          '有 ⇒ 只买【竞价口径最靠前】的那只（= 认证龙），首次进前五的那只【只作判断条件、不单独买】；' +
          '没有 ⇒ 就买它自己（例：10-22 冰山冷热）。认证龙同样要能买进（非主板 / 竞价一字 / 停牌一律跳过）。' +
          (isCert
            ? '本日命中：' + cert.name + '（' + _rankLabelOf(cert.rank20) + '）⇒ ' + name +
              '（' + _rankLabelOf(p.rank20) + '，同题材 ' + (cert.topic || topic || '—') + '）。'
            : '本日未命中：前五里没有与它同题材的其它票 ⇒ 直接买它自己。'))),
      (trailText ? ('前十去留（判定可追溯）：' + trailText + '。') : ''),
      '⚠️ 常规侧同日【收紧】：切换日只选一个题材、只取一只（排名最前且数量达标，退潮题材与新题材跳过）'
        + (tierPick ? ('——本日常规那只 = ' + tierPick + '。') : '。')
    ].filter(function(s) { return !!s; })
  };

  // ① 客观数据 + 原始买点信号（同一份实现）
  finishBuyBlock(block, fOpts);
  // ② 覆盖动作标签为【新龙买】（fam 路径同样覆盖，最多两只）
  (block.picks || []).forEach(function(row) {
    const rawTag = row.buyActionTag || '';
    const rawNote = row.actionNote || '';
    row.buyActionTag = NEW_DRAGON_TAG;
    row.buyActionTone = NEW_DRAGON_TONE;
    row.holdTag = '';       // 与「今天要买」互斥
    row.position = '';
    row.actionNote = '【第二十八条 · ' + (fam ? '新题材' : (isCert ? '新龙 · 认证龙' : '新龙')) + '】' + oldTopic +
      '（老龙一 ' + (switchDay.leaderName || '—') +
      '）二次确认退潮后第 2 个交易日 = 切换日：老周期结束、新周期开启。' +
      // ★ [LEADER-FIRST-TOPIC] 行内只印「首霸日 + 当天几只」（完整成员在说明区，⛔ 不让行内说明失控）
      (oldTopicBasis
        ? ('〔老题材 ' + oldTopic + ' = 它第一次霸榜总龙一那天（' + String(switchDay.oldTopicDate || '—') +
           '）的题材大类，当天前十有 ' + (Number(switchDay.oldTopicCount) || 0) + ' 只〕')
        : '') +
      (fam
        ? ('今日 20日涨幅前十里有 ' + fam.count + ' 只【' + fam.topic + '】⇒ 构成补涨新题材；本只是该题材' +
           (fam.primaryName === String(row.name || '').trim()
             ? '最靠前的那只' + (fam.primaryEverBefore ? '，且本身就是老周期总龙 ⇒【双重属性】（既是老龙、又是新龙）' : '')
             : '里的【新面孔】（近 ' + windowText + ' 没进过前五）⇒ 与老龙换题材的【' + fam.primaryName + '】一起买') +
           '；买点共 ' + picks.length + ' 只（' + famBuyText + '）。')
        : (isCert
          ? ('它【不是】首次进前五的那只 —— 首次进前五的是同题材的【' + cert.name + '】（' +
             _rankLabelOf(cert.rank20) + '），那只只用来认证「' + (cert.topic || topic || '—') +
             ' 是新题材」；本只同样是 ' + (cert.topic || topic || '—') + '，且竞价口径【更靠前】（' +
             _rankLabelOf(p.rank20) + '）⇒ 按用户口径只买最靠前的那一只 ⇒ 判定为【认证龙】。' +
             '与老龙一【不同题材】⇒ 新龙（老龙→新龙交接）。')
          : ('它近 ' + windowText + '【首次】进入前列（此前未进前五），' + _todayRankPhrase(p.rank20) +
             '，且与老龙一【不同题材】（' + (topic || '—') + '）⇒ 判定为新龙（前五里没有同题材的其它票）。'))) +
      (rawTag ? ('它的常规买点信号是【' + rawTag + '】——' + (rawNote || '')) : '') +
      ' 切换日买点侧只有【' + (fam ? '新题材' : (isCert ? '认证龙' : '新龙')) + '】+ 常规收紧后的那【一只】（第二十八条）。';
    // ★ [AUCTION-YIZI-WAIT] 一字那只：明确「竞价买不进 / 等下杀接」
    if (row.waitBuyTag) {
      row.actionNote = row.actionNote + ' ⚠️ 本只今日【竞价一字涨停】⇒ 竞价阶段买不进，' +
        '按【' + AUCTION_YIZI_WAIT_TAG + '】处理：等开板、等一次下杀再接；真正能在竞价成交的是同题材的另一只。';
    }
  });

  // 本看板平铺字段
  block.topic = (fam ? '新题材 · ' : (isCert ? '认证龙 · ' : '新龙 · ')) + (topic || '—');
  block.rank = null;
  block.count = null;
  block.yiziCount = null;
  block.avgVolRatio = null;
  block.avgVolRatioText = '';
  block.tier = 'newdragon';
  block.pickCount = picks.length;
  block.rangeText = '';
  block.skippedNames = [];
  block.isNewDragon = true;
  // ★ [NEW-DRAGON-CERTIFY] 认证龙标记（UI / 说明 / 复盘据此区分「新龙」与「认证龙」）
  block.isCertifyDragon = isCert;
  // ★ [NEW-DRAGON-FAMILY 2026-11-12] 新题材标记（复盘要能看出「这是字辈/字号题材选出来的」）
  block.isFamilyDragon = !!fam;
  block.familyTopic = fam ? fam.topic : '';
  block.familyMembers = fam ? fam.members.map(function(m) { return m.name + (m.everBefore ? '·老' : '·新'); }) : [];
  // 认证那只（竞价一字 / 停牌 / 非主板）不进 picks，但必须在行上标出来「它只作题材认证」
  block.certifiedOnlyName = (cert && cert.role === 'certify-only') ? cert.name : '';
  // ★ [NEW-DRAGON-FAMILY-OLD] 竞价一字那只已进买点侧 ⇒ 单独留痕（复盘能看出「这只是等下杀买」）
  block.waitBuyName = (cert && cert.role === 'wait-buy') ? String(cert.name || '') : '';
  block.waitBuyTag = block.waitBuyName ? AUCTION_YIZI_WAIT_TAG : '';
  return block;
}

/**
 * ★★ [R10-926 2026-10-24 用户口径] 把十日涨幅候选池的 `pct` 换成【9:26 竞价口径】那一份。
 *
 * 用户原话：「所以买点侧的10日涨幅和20日涨幅的股票，如果有入选时也应该按照9点26分的口径，
 *   因为一般都是早上选出来，收盘看的时候就不一样的」。
 *
 * 为什么能直接换（而不是另算一遍）：
 *   · `o.range10Rows`（decision-collect#range10Rows）与 `pctMap`（range-auction-leg#readAuctionLegRangeMap）
 *     **同源** —— 都是 `stock_range_pct` 那一天的行，前者取原值（收盘口径），后者用
 *     `market_metrics.auc_pct_chg / change_pct` 把 T 腿反解回竞价口径（§6 同一把尺子）。
 *     ⇒ 键集合一致，只需逐行覆盖 `pct`，⛔ 不需要补票、也不会漏票。
 *   · 覆盖后排序 / 主板名次 / 「前十」判定全部自动走 9:26 口径 —— 因为 `range10-backup.js`
 *     只认 `pct` 一个输入（sortIndicesByRangePct 与 presence-label 同一把尺子）。
 *
 * §10 / §11 两条安全降级：
 *   · `pctMap` 缺失 / 为空（该日 9:26 口径还没读到、或反解前提不满足）⇒ **原样返回**，
 *     一个字都不改（= 退回收盘口径，行为与加本函数之前逐字节相同）；
 *   · 某只票在 `pctMap` 里没有 / 值为空 ⇒ 保留该行原 `pct`（⛔ 不补 0、不当 0%）。
 *
 * @param {Array|null} rows decision-collect#range10Rows（含「20天」补位行）
 * @param {Map|null} pctMap 9:26 口径区间涨幅（readAuctionLegRangeMap 的返回）
 * @returns {{rows:Array|null, used:boolean}} used=true 表示本次真的用了 9:26 口径（文案据此标注）
 */
export function _withAuctionLegPct(rows, pctMap) {
  if (!Array.isArray(rows) || rows.length === 0) return { rows: rows || null, used: false };
  if (!pctMap || typeof pctMap.get !== 'function' || pctMap.size === 0) return { rows: rows, used: false };
  let used = false;
  const out = rows.map(function(r) {
    const nm = String((r && r.name) || '').trim();
    if (!nm) return r;
    const v = pctMap.get(nm);
    const p = v ? _num(v.pct) : null;
    if (p === null) return r;
    if (_num(r.pct) === p) return r;          // 值没变 ⇒ 保持原对象（§19 引用稳定，不白触发下游重算）
    used = true;
    return Object.assign({}, r, { pct: p });
  });
  return { rows: out, used: used };
}

/**
 * ★★ [R10-BACKUP 2026-10-24 用户口径] 第二十九条：把 range10-backup#pickRange10Backup 选出的
 * 【那一只候补】组装成买点块（形状与 _buildNewDragonBlock / 退潮替补【完全一致】）。
 *
 * ⛔ 为什么必须同形状：块要交给 decision-rules#finishBuyBlock 收口（占比 / 动作标签 / 持有 /
 *   题材标记），少一个字段就是【静默】少一枚标签（不报错、不显示，最难查的那种）。
 *
 * ⛔ 顺序（与另外三段同一条铁律）：
 *   ① 先 finishBuyBlock（拿到客观数据 + 原始买点信号）；
 *   ② 再【覆盖】动作标签为【十日涨幅候补买】—— 它是「常规题材作废后的替换买点」，
 *      不是竞价买 / 尾盘买，也不是退潮替补（用户拍板：单独一枚标签）。
 *
 * §10：票的十日涨幅读不到 ⇒ pctText 显示 '—'，⛔ 不补 0；龙标【留空】
 *   （它不是本题材的龙N，冒充「龙一」会让人以为它是题材龙头）。
 *
 * @param {object} bk   pickRange10Backup 的返回
 * @param {Array} list  当日题材块（取 member 拿 aucShare / code，与另外三段同一取法）
 * @param {object} fOpts finishBuyBlock 的入参
 * @param {{weakTopics?:Array<{topic:string,avgText:string,reasonText:string}>,
 *          top1Topic?:string, top1Name?:string,
 *          grayed?:{topic:string,tag:string}|null, overlap?:{topic:string,tag:string}|null}} [info]
 *        说明文案用的事实（谁作废了 / 总龙一是谁 / 同一只票在上方是什么身份）：
 *        · grayed  = 上方那一块已被改成「不开新仓」并灰化（10-23 兆威机电）；
 *        · overlap = 上方那一块里它是【今天要买】的买点（10-20 海洋王 ⇒ 两条通道叠加确认）。
 * @returns {object|null}
 */
export function _buildRange10BackupBlock(bk, list, fOpts, info) {
  const p = bk && bk.pick;
  if (!p || !p.name) return null;
  const name = String(p.name).trim();
  const topic = String(p.topic || '').trim();
  const inf = info || {};
  // ★★ [R10-926 2026-10-24] 本次「十日涨幅 / 名次」用的口径时间（'9:26 竞价口径' / '收盘口径（…未读到）'）。
  //   ⛔ 只在文案里出现，不参与任何判定（§21：模板零计算，文案在 Logic 层拼好）。
  const baseText = String(inf.baseText || '');
  // ★★ [DUAL-RANK 2026-10-24 用户口径] 同一只票在【收盘口径】下的名次（复盘对照，⛔ 不参与选股）。
  //   名次表缺失 / 这只票不在原始池里 ⇒ null ⇒ 下面三处文案一个字都不加（§10 判不出就不猜）。
  const closeInfo = _closeRankOf(inf.closeRankMap, name, p.rank);

  // 真实成员行（与退潮替补 / 新龙同一取法：先按题材块找，再全表按名字兜一次）
  let member = null;
  (list || []).forEach(function(b) {
    if (member) return;
    (b.members || []).forEach(function(m) {
      if (!member && m && String(m.name || '').trim() === name) member = m;
    });
  });

  const pct = _num(p.pct);
  const picks = [{
    seq: 1,
    name: name,
    // ⛔ 龙标留空：它来自十日涨幅榜，与题材内的龙位无关（§10 不冒充「龙一」）
    dragonLabel: '',
    dragonRank: null,
    pct: pct,
    code: String(p.code || (member && member.code) || '').trim(),
    pctText: formatRangePct(pct),
    // ★ 本行专属徽标（Logic 层拼好，模板零计算 §21）：
    //   「9:26 竞价口径 · 十日涨幅第 N 名 · 首次在列」—— ★ [R10-926 2026-10-24] 必须写明【口径时间】：
    //   名次是按早上 9:26 那一刻算的，收盘回看时数值会变，⛔ 不能让人以为那一列是收盘口径。
    range10Label: (baseText ? ('〔' + baseText + '〕') : '') + '十日涨幅第 ' +
      (p.rank === null || p.rank === undefined ? '—' : p.rank) +
      ' 名 · ' + (p.label || '在列次数未知') +
      // ★★ [DUAL-RANK 2026-10-24 用户口径] 收盘口径名次【并列】写在后面（只在两套不同时写，
      //   §11 零噪声）—— 复盘时一眼能看出「早上第 8 名、收盘回看是第 11 名」这种错觉的来源。
      //   ⛔ 前半段（竞价口径）永远是选股用的那一份，顺序不许颠倒。
      (closeInfo && closeInfo.rank !== null && !closeInfo.same
        ? (' · 收盘口径第 ' + closeInfo.rank + ' 名')
        : '') +
      // ★ [R10-NOEXCLUDE 2026-10-24] 与题材买点重叠时把「叠加确认」直接写进徽标 ——
      //   用户要的是「一眼看见确定性」，⛔ 不能只藏在点开后的说明里。
      (inf.overlap ? ' · 叠加确认' : ''),
    // ★ [R10-TRAIL 2026-10-24] 徽标的悬停说明：把「名次」与「屏幕行号」两个数一次讲清，
    //   ⛔ 免得用户看到「第 8 名」却在第 9 行找不到对不上的感觉（两种数法都没错，是口径不同）。
    range10Title: (baseText ? ('涨幅与名次都按【' + baseText + '】算（' + _pct2(pct) +
      '）；收盘后这个数会变，但选股与名次固定为早上那一刻。') : '') +
      '十日涨幅第 ' + (p.rank === null || p.rank === undefined ? '—' : p.rank) +
      ' 名（只算主板名次：创业板 / 科创板 / 北交所不占名次，所以它在屏幕上是第 ' +
      (p.rowNo === undefined || p.rowNo === null ? '—' : p.rowNo) + ' 行）｜' +
      (p.label || '在列次数未知') + ' = 这 10 个交易日里它出现在当日名单的次数' +
      '（含今天；1 次 = 首次在列，2 次 = 二次在列）' +
      // ★★ [DUAL-RANK 2026-10-24 用户口径] 悬停里把两套口径一次讲清。
      //   ⚠️ 只在【确实不同】时才写（§11 零噪声）：老调用方不传 pctMap ⇒ 两张名次表逐项相同
      //      ⇒ 悬停逐字回到加本功能之前的样子（⛔ 不拿一句「两套相同」去污染一条旧文案）；
      //      而且此时 baseText 本身就是「收盘口径（9:26 口径未读到）」，再写一段「收盘口径是第 N 名」
      //      等于同一句话说了两遍。
      //   §10：收盘口径下它【不占名次】这种情况必须写（那是一句新信息，不是重复）。
      (closeInfo && !closeInfo.same
        ? (closeInfo.rank === null
          ? '｜【复盘对照】同一只票在【收盘口径（现价）】下不占名次（非主板 / 缺十日涨幅）—— 屏幕上那一份也没有它。'
          : ('｜【复盘对照】同一只票在【收盘口径（现价）】是第 ' + closeInfo.rank + ' 名（' +
             _pct2(closeInfo.pct) + '） ⇒ 名次与竞价口径不同：这是同一批票在两个时刻' +
             '（早上 9:26 与现价）的排序差异，不是算错了。' +
             '选股永远用【竞价口径】那一份，这里的收盘名次只用于复盘对照。'))
        : '') +
      (inf.overlap
        ? ('｜叠加确认：它同时是上方【' + (inf.overlap.topic || '—') + '】题材块的买点 —— ' +
           '题材通道与市场通道选中同一只票，确定性更高，两处各显示一行')
        : ''),
    // ⚠️ 预置：finishBuyBlock 内部 _markHold 要读它（§6 与 _buildBlock 同一做法）
    aucShare: member ? _num(member.aucShare) : null,
    position: ''
  }];

  const weakText = (inf.weakTopics || []).map(function(w) {
    return '【' + w.topic + '】平均竞价量比 ' + w.avgText + ' ＜ ' + TVRB_CASH_ALERT_AVG_VR +
      '（' + (w.reasonText || '题材量比太小') + '）';
  }).join('；');
  // ★ [R10-926 2026-10-24] 每一只都带【涨幅 + 名次】（只列事实，便于用户逐只核对，⛔ 不下结论）
  // ★★ [DUAL-RANK 2026-10-24 用户口径] 括号里再并一个【收盘口径名次】（两套不同才写）——
  //   复盘时逐只对上号，⛔ 不用再去早盘竞价看板比对一遍。
  let closeDiffN = 0;
  const trailParts = (bk.trail || []).map(function(t) {
    const cs = _closeRankOf(inf.closeRankMap, t.name, t.rank);
    const csText = (cs && cs.rank !== null && !cs.same) ? ('（收盘口径第 ' + cs.rank + ' 名）') : '';
    if (csText) closeDiffN += 1;
    return '【第 ' + t.rank + ' 名 ' + t.name + ' ' + _pct2(t.pct) + csText + '】' +
      (t.reason ? t.reason : (t.label || '') + (t.cnt === 1 || t.cnt === 2 ? ' ⇒ 候选' : '（不是首次 / 二次在列）'));
  });
  const trailText = trailParts.join('；');
  const tierText = (bk.tier === 'first')
    ? '前十名里【有首次在列】⇒ 只选这一只（首次在列优先）'
    : '前十名里【没有可用的首次在列】⇒ 退到【二次在列】里取排名最靠前的这一只';
  const top1Text = inf.top1Name
    ? ('20日涨幅总龙一【' + inf.top1Name + '】（' + (inf.top1Topic || '—') + '）')
    : '20日涨幅总龙一';
  // ★★ [R10-STOCK-LEVEL 2026-10-24 用户口径] 同一只票在上方以「不开新仓」身份出现过
  //   （10-23 兆威机电 属工业4.0，题材平均量比 15.18 ＜ 25 ⇒ 整块灰化空仓）⇒ 必须讲清为什么还选它：
  //   本规则是【股票级】通道（从总市场选股），题材块灰化是【题材级】结论，两者互不否决
  //   ⇒ 同一只票会重复出现一次，这是设计如此（用户原话「上面是重复出现的兆威机电也是逻辑」）。
  const grayed = inf.grayed || null;
  // ★★ [R10-NOEXCLUDE 2026-10-24 第三次修正] 同一只票是上方某题材块的【买点】（10-20 海洋王 / 商业航天）
  //   ⇒ 两条通道叠加确认，⛔ 这不是「重复选错」，也⛔ 不许因为它已被选中就顺延到下一名。
  const overlap = inf.overlap || null;
  const dupText = grayed
    ? ('本股同时也在上方【' + (grayed.topic || '—') + '】题材块里（那一块已被改成【' +
       (grayed.tag || '不开新仓') + '】并灰化，照旧展示、不恢复）—— ' +
       '但本行不是按题材选的，是按【十日涨幅前十 + 在列次数 + 与总龙一不同题材】从全市场选的，' +
       '所以同一只票会重复出现一次。')
    : '';
  const overlapText = overlap
    ? ('本股同时是上方【' + (overlap.topic || '—') + '】题材块里的买点（' +
       (overlap.tag || '买') + '）—— 【题材通道】和【市场通道】同时选中了同一只票：' +
       '这是叠加确认（确定性更高），不是重复选错，也不用分成两只。' +
       '两处照旧各显示一行，看到两次不必担心。')
    : '';

  const block = {
    block: {
      topic: '十日周期候补 · ' + (topic || '—'),
      rank: null,          // ⛔ 不给圆点：本行不是题材排名
      count: null,
      yiziCount: null,
      members: member ? [member] : []
    },
    rankWord: '',
    pickRank: null,
    reason: '【第' + RANGE10_BACKUP_RULE_NO + '条】十日涨幅候补（★ 股票级通道：从全市场选股，不是选题材）：' +
      (weakText ? (weakText + ' ⇒ 该题材作废；') : '') +
      dupText + overlapText +
      '按「十日涨幅前十 + ' + (bk.tier === 'first' ? '首次在列' : '二次在列') + ' + 与' + top1Text +
      '不同题材」选出 ' + name + '（' + (topic || '—') + '，〔' + (baseText || '当日口径') +
      '〕十日涨幅 ' + _pct2(pct) +
      '，第 ' + p.rank + ' 名，' + (p.label || '') + '）—— 十日周期的新面孔。',
    mode: 'r10backup',
    ruleNo: RANGE10_BACKUP_RULE_NO,
    isCandidate: false,
    candidateTag: '',
    qualified: true,
    notQualifiedText: '',
    picks: picks,
    notes: [
      '【本规则的性质】科目【股票级】——从【总市场】选股，不参与题材排名、也不受题材量比门槛约束。' +
        '和「题材量比买点」是两条线：那条线先选题材再在题材里选股，这条线只认股票自己的三个条件' +
        '（十日涨幅前十 + 首次/二次在列 + 与 20日涨幅总龙一不同题材）。',
      '【候补怎么选】十日涨幅前 ' + (bk.topN || 10) + ' 名（只算主板名次，非主板不占名次）自上而下：' +
        '跳过题材未知的（判不出是否与总龙一同题材）→ 跳过与' + top1Text + '同类的 ⇒ ' + tierText + '。' +
        '⛔ 不会因为某只票【已经在题材块里当选】就跳过它 —— 那会把最强的票换成更弱的票' +
        '（10-20 事故：海洋王 29.51% 被跳过、换成京城股份 27.26%）。',
      grayed ? ('⚠️ ' + dupText) : '',
      overlap ? ('✅ ' + overlapText) : '',
      '⚠️ 为什么用十日涨幅而不是 20日涨幅：20 日老周期已经结束（总龙二次确认退潮），现在轮到【十日周期】 ——' +
        '龙头的量比都比题材大，十日周期的新面孔才是接下来的核心。20日涨幅列表里的老票会逐渐换成新票，' +
        '本看板 20日涨幅榜上的老面孔也会一天天被十日周期的新票替换掉（这是正常的周期切换，不是数据错乱）。',
      '十个名次去留（' + (baseText || '当日口径') + '，判定可追溯）：' + (trailText || '—') + '。' +
        // ★★ [DUAL-RANK 2026-10-24 用户口径] 括号里的收盘口径名次是什么，一句话交代清楚
        //   （§10：有差异就必须能解释，⛔ 不能让两个数字并排摆着却没人说明）。
        (closeDiffN > 0
          ? ('（括号里的「收盘口径第 N 名」= 同一只票在【收盘口径（现价）】下排第 N 名，' +
             '仅用于复盘对照；【选股与前面的名次一律用竞价口径（9:26）】。' +
             '两套对不上不是算错，是同一批票在早上 9:26 与现价两个时刻的排序差异。）')
          : ''),
      '⚠️ 窗口覆盖：' + (bk.coveredDays || 0) + ' / ' + (bk.windowDays || 10) +
        ' 个交易日有名单数据（在列次数 = 这 ' + (bk.coveredDays || 0) + ' 天里它出现在早盘竞价名单的几次）。'
    ].filter(function(s) { return !!s; })
  };

  // ① 客观数据 + 原始买点信号（同一份实现）
  finishBuyBlock(block, fOpts);
  // ② 覆盖动作标签为【十日涨幅候补买】
  (block.picks || []).forEach(function(row) {
    const rawTag = row.buyActionTag || '';
    const rawNote = row.actionNote || '';
    row.buyActionTag = RANGE10_BACKUP_TAG;
    row.buyActionTone = RANGE10_BACKUP_TONE;
    row.holdTag = '';       // 与「今天要买」互斥
    row.position = '';
    row.actionNote = '【第' + RANGE10_BACKUP_RULE_NO + '条 · 十日涨幅候补】' +
      (weakText ? (weakText + ' ⇒ 该题材【作废】；') : '') +
      (grayed ? ('⚠️ 本股在上方【' + (grayed.topic || '—') + '】题材块里已被改成【' +
        (grayed.tag || '不开新仓') + '】（题材量比不达标 ⇒ 那一块照旧灰化、不恢复）；' +
        '但本行是【股票级】通道另选出来的，不是那个题材块要买它 —— ') : '') +
      // ★ [R10-NOEXCLUDE 2026-10-24] 与题材通道叠加时也要在行内讲一句（用户会点开行看说明）
      (overlap ? ('✅ 本股同时是上方【' + (overlap.topic || '—') + '】题材块的买点 —— ' +
        '两条通道叠加确认（确定性更高），不是重复选错 —— ') : '') +
      '按「十日涨幅前十 + ' + (bk.tier === 'first' ? '首次在列' : '二次在列') + ' + 与' + top1Text +
      '不同题材」选出本股（〔' + (baseText || '当日口径') + '〕十日涨幅 ' + _pct2(pct) +
      '，第 ' + p.rank + ' 名，' + (p.label || '') + '）。' +
      (rawTag ? ('它的常规买点信号是【' + rawTag + '】——' + (rawNote || '')) : '') +
      ' 这是十日周期的新面孔买点（20日老周期已结束），不是题材量比买点。';
  });

  // 本看板平铺字段
  block.topic = '十日周期候补 · ' + (topic || '—');
  block.rank = null;
  block.count = null;
  block.yiziCount = null;
  block.avgVolRatio = null;
  block.avgVolRatioText = '';
  block.tier = 'r10backup';
  block.pickCount = 1;
  block.rangeText = '';
  block.skippedNames = [];
  block.isRange10Backup = true;
  return block;
}