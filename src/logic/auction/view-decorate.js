// view-decorate.js — 早盘竞价第一页 items 的【后置标注】唯一实现（Logic 层，§6 / §15 / §21）
//
// ══════════════════════════════════════════════════════════════════════════
// 【这一段在干什么】
//   `computeAuctionViewData` 把 `items` 组装好（顺序 = 最终渲染顺序 fullOrder）之后，
//   还要给每一行「贴标签」。这些标签**只影响显示**，不改变归属、不改变顺序：
//     · 20日涨幅模式下的「占比列 → 名次变化（+6 / -7）」        → applyRange20RankDelta
//     · 题材统计条（数量/一字/平均竞价量比/封单合计）+ 组内序号 → applyTopicStatsAndSeqNo
//     · 非题材模式下的「主板名次」序号                        → applyTopicStatsAndSeqNo（else 支）
//
// 【为什么单独一个模块】
//   用户 2026-11-05：「把复杂功能单独放在一个组件……哪个组件出现问题就修复哪个」。
//   原来这两段挤在 1090 行的 computeAuctionViewData 里，而且**都依赖「items 已经组装完」
//   这个前置条件**（顺序 = fullOrder）。抽出来以后：
//     · 前置条件变成函数签名的一部分（参数就叫 items），⛔ 不会再有人在 items 组装前调它；
//     · 「第 0..4 名 = 总龙一~五」这类**依赖顺序**的规则，注释和代码终于在同一屏里。
//
// 【红线】
//   §6  「谁算正式成员 / 谁在名单里」不在这里判 —— 只读 `it.isFormalMember`（由 enrich 阶段写）。
//       本文件⛔ 绝不自己去查 auction_watchlist / getTodayGroupList。
//   §10 数据没到 ⇒ 不给标签（`topicStats=null` / `range20RankDeltaText='—'`），
//       ⛔ 绝不用 0 或空串冒充「已算出且为 0」。
//   §21 模板零计算：文案（"今·9:26竞价口径 vs 昨·收盘口径 ⇒ +6"）在这里拼好，
//       模板只做 `{{ it.range20RankDeltaTitle }}`。
//   §32 本文件不发请求、不读 store：所需数据全部由调用方（view-helpers）从会话缓存取好传进来。
// ══════════════════════════════════════════════════════════════════════════

import { getPreviousTradingDay } from '../date/trading-day-helpers.js';
import { getAucVolRatio } from '../../data/watchlist-helpers.js';
import { buildTopicStatsMap } from './topic-stats.js';
import { buildMainBoardSeq } from './board-seq.js';
import { sealLotsOf } from './seal-volume.js';
import { getPrevRankTable, resolvePrevRankLeg, resolveTodayLeg, PREV_LEG_AUC } from './prev-rank-table.js';
import { buildRange20RankDelta, RANGE20_DELTA_UNKNOWN_TEXT } from './range20-rank-delta.js';

/**
 * [R20-DELTA 2026-10-28 用户口径] 「20日涨幅」模式：把占比列换成【名次变化】（对比昨日排名）。
 *
 * 用户原话：「你把20日涨幅toggle的占比列改成排名变化，对比昨天，排名上升就用红色+数字，
 *   比如+6，排名下降就用绿色，比如-7……这个数值变化，也很重要，可以看出个股突破。」
 *
 * ⛔ 只在【20日涨幅单独排序】时生效：
 *   · `sortState.byRangePct20` 关闭 ⇒ 一行都不赋（走 _enrichAuctionItem 的默认 null/''）；
 *   · 题材单独模式（顺序是按题材分组，不是涨幅降序）⇒ 名次没有意义 ⇒ 不赋（§10 宁可没有）。
 *
 * ★★ [R20-DELTA 2026-10-28 15:49 口径终版 —— 用户口述举例定死]
 *   基准腿【恒为昨日收盘口径】，与今天那一列是竞价还是收盘无关（见 prev-rank-table.js 头注释）。
 *   用户举例：10-27 早上看到襄阳轴承「竞价口径」的排名，比的是 **10-26 襄阳轴承的【收盘】口径**
 *   名次（62.39% 那一版），⛔ 不是 10-26 的竞价口径（58.37% 那一版）。
 *   ⇒ 今天竞价 vs 昨收；今天收盘 vs 昨收。收盘后只是「今天那列」换成收盘值，基准不变。
 *
 * §10：昨日收盘口径下判不出（该票昨天只有 auc 腿 / 名次表还没到货）⇒ 显示 '—'
 *   （⛔ 绝不用 0 冒充「没变化」，也⛔ 绝不拿竞价口径的表顶替）。
 *
 * @param {Array} items 已组装好的行（顺序 = 最终渲染顺序）
 * @param {Object} o
 * @param {Object} o.sortState
 * @param {boolean} o.topicOnlyMode
 * @param {string} o.currentDate
 * @param {Function} o.range20MapOf () => Map（**惰性**：只在生效分支里调）
 * @returns {boolean} 是否真的执行了标注（false = 本模式下不该有这一列）
 */
export function applyRange20RankDelta(items, o) {
  if (!o || !o.sortState || !o.sortState.byRangePct20 || o.topicOnlyMode) return false;
  const currentDate = o.currentDate;
  const _r20Map = typeof o.range20MapOf === 'function' ? o.range20MapOf() : null;
  const _prevDate = getPreviousTradingDay(currentDate);
  // 基准恒 close；今天这列的口径【只用来拼文案】，两个语义别合并（见 prev-rank-table.js）
  const _prevLeg = resolvePrevRankLeg();
  const _todayLeg = resolveTodayLeg(currentDate, o.sortState.byAuctionLeg);
  const _prevRec = _prevDate ? getPrevRankTable(_prevDate, _prevLeg) : null;
  const _deltaMap = buildRange20RankDelta(_r20Map, _prevRec);
  // 文案在这里拼好（§21 模板零计算）：两边各写清是哪把尺子，用户才能【一眼分辨】
  //   （原话「这样才能分辨出来」「不要搞混了」）。
  const _todayText = _todayLeg === PREV_LEG_AUC ? '今·9:26竞价口径' : '今·收盘口径';
  const _prevText = '昨·收盘口径';
  items.forEach(function(it) {
    const _nm = String(it.stock || '').trim();
    if (!_nm) return;
    const _d = _deltaMap.get(_nm) || null;
    it.range20RankDelta = _d;
    it.range20RankDeltaText = _d ? _d.text : RANGE20_DELTA_UNKNOWN_TEXT;
    it.range20RankDeltaTone = _d ? _d.tone : '';
    it.range20RankDeltaLeg = _todayLeg;
    it.range20RankDeltaTitle = _d
      ? '20日涨幅排名 ' + _todayText + ' vs ' + _prevText + ' ⇒ ' + _d.text + '（正数=上升，负数=下降）'
      : '昨日收盘口径名次未判出（该票昨天只有竞价腿 / 名次表还没到货）';
  });
  return true;
}

/**
 * 题材统计条 + 组内序号（题材单独模式）／ 主板名次序号（其它模式）。
 *
 * 【为什么两件事在一个函数里】
 *   它们互斥地占同一个字段位（`seqNo`）：题材单独模式下 seqNo = 组内序号，
 *   其它模式下 seqNo = 主板名次。分成两个函数就要在两处各判一次 `topicOnlyMode`，
 *   一旦哪天模式判定改了口径，就会漏改一处 → 屏幕上序号重复或全空。
 *
 * @param {Array} items 已组装好的行（顺序 = 最终渲染顺序）
 * @param {Object} o
 * @param {string} o.currentDate
 * @param {boolean} o.topicOnlyMode       题材 toggle **单独**开启（无任何主排序叠加）
 * @param {Function|null} o.primaryTopicOfForColor (idx) => 主题材名
 * @param {Function} o.range10MapOf       () => 十日涨幅 Map（惰性，只取一次）
 * @param {Array} o.renderList            items[idx].index 指向它（取原始行算竞价涨幅）
 * @param {Object} o.sortState
 * @param {Function} o.auctionPctOf       (rawRow) => 竞价涨幅
 * @returns {Map|null} 题材统计条映射（供诊断用；不参与后续计算）
 */
export function applyTopicStatsAndSeqNo(items, o) {
  const currentDate = o.currentDate;
  const primaryTopicOfForColor = o.primaryTopicOfForColor;
  let topicStatsMap = null;

  if (o.topicOnlyMode && primaryTopicOfForColor) {
    // ★ [TOPIC-AUCTION-LEG 2026-11-01] 统计条里的「龙头 + 十日涨幅」必须与龙位/组内顺序
    //   用【同一把尺子】：竞价口径打开时同样换成 9:26 那一份，否则会出现
    //   「组内第一行（龙一）不是统计条写的那个龙头」—— 正是三套口径各说各话的老坑。
    //   关闭时 range10MapOf() 返回 getDragonRangePct ⇒ 逐字回到改造前。
    const _rangeMap = o.range10MapOf();
    // [LISTED-TODAY 2026-09-23] 计数类统计（数量 / 一字 / 竞价高开 / 收盘 / 龙头）只认【当天正式列表里的行】
    //   （观察组/龙头继承空壳不计数）—— 与 sortByTopicGroups 的 countableOf、趋势图
    //   collectTopicDayStats 完全同一口径，是「统计条数字 == 题材块顺序 == 趋势图名次」的结构性保证
    //   （不是靠三处各写一遍 if）。该口径【原样保留】，由 row.formal 标记交给 topic-stats.js 内部分流。
    //
    // 🔴 [AVG-VRATIO 2026-10-01 用户口径] 但「平均竞价量比」是【另一套分母】：用户明确要求
    //   「数量不分灰色和常规，只要显示在上面的都要算进去，这个和那个只算正式列表有区别要注意」。
    //   所以这里把【items 全部（= 最终渲染顺序 = 列表上真正显示的每一行，含灰行）】都送进去，
    //   由 topic-stats.js 自己按 formal 分流：计数走正式成员、平均量比走全部行。
    //   ⚠️ 成组门槛（不足 2 只正式成员的题材不出统计条）仍在 topic-stats.js 内部按 formal 判，
    //      因此「哪些题材会出现统计条」与改造前【逐字一致】。
    // [SEAL-VOLUME 2026-10-11 用户口径] 封单量（手）的同步读取器（Data 层内存缓存，⛔ 不发请求、
    //   不消费猫抓额度）。合计 / 变化的口径与格式化全在 topic-stats.js + seal-volume.js。
    const _sealPrevDate = getPreviousTradingDay(currentDate);
    const _entries = items.map(function(it) {
      const rp = (_rangeMap && _rangeMap.has(it.stock)) ? _rangeMap.get(it.stock).pct : null;
      return {
        topic: primaryTopicOfForColor(it.index),
        name: it.stock,
        isYiZi: !!it.isYiZi,
        aucPct: o.auctionPctOf(o.renderList[it.index]),
        rangePct: (rp === undefined ? null : rp),
        // [CLOSE-COUNT 2026-09-11] 收盘口径下才带收盘涨幅（否则为 null → 逻辑层不产出该段）
        closePct: it.closePct,
        // [NOT-FORMAL 2026-09-23] 是否今日 9:25 正式名单成员（false = 灰行）。
        //   计数类统计只看 true（口径不变）；[AVG-VRATIO] 平均竞价量比【不分】；
        //   [SEAL-VOLUME] 封单合计同样【不分】（与平均量比同一分母口径）。
        formal: !!it.isFormalMember,
        // [AVG-VRATIO 2026-10-01 用户口径] 当日竞价量比（倍数）→ 题材平均量比的分母/分子。
        volRatio: getAucVolRatio(currentDate, it.stock),
        // [SEAL-VOLUME 2026-10-11 用户口径] 封单量（手）：当日 + 上一交易日（后者只用于算「变化」）。
        //   非涨停 / 没有封单数据 ⇒ null（§10 ⛔ 不补 0，不会被算进合计，也算不出变化）。
        sealLots: sealLotsOf(currentDate, it.stock),
        sealLotsPrev: _sealPrevDate ? sealLotsOf(_sealPrevDate, it.stock) : null
      };
    });
    topicStatsMap = buildTopicStatsMap(_entries);

    // 统计条挂在每个题材块的【第一行】（其余行 null）；同时给出组内序号。
    // 二者共用同一个「题材切换」判断，保证统计条所在行 === 序号从 1 重新开始的那一行。
    // ⚠️⚠️ 落点必须是块的【第一行】，⛔ 不能跳过灰色行去找「第一行正式成员」（2026-09-23 事故）：
    //   统计条是整块的【表头】（flex-basis:100% 的整行），挂在第二行 ⇒ 第一行会渲染在统计条【上面】，
    //   看起来就像"飘在题材组外面"。而块首恰恰常是龙一（rankFn 排第一）—— 会稽山 / 澳弘电子
    //   作为各自题材的龙一，就是这样被挤出组外的。表头本来就属于整块，不属于某一行。
    let lastTopicKey = null;
    let seqInTopic = 0;
    let statsAssigned = false;
    items.forEach(function(it) {
      const tp = (primaryTopicOfForColor(it.index) || '其它').trim() || '其它';
      // [YIZI-SUP 2026-09-20] 把「本行所属题材组」原样透出（值就是上面这个 tp，零额外计算）：
      // 「补竞价一字」按题材融入时要定位到具体分组，见 _enrichAuctionItem 里 groupTopic 的说明。
      it.groupTopic = tp;
      if (tp !== lastTopicKey) {
        lastTopicKey = tp;
        seqInTopic = 0;
        statsAssigned = false;
      }
      if (!statsAssigned) {
        it.topicStats = topicStatsMap.get(tp) || null;
        statsAssigned = true;
      } else {
        it.topicStats = null;
      }
      seqInTopic++;
      it.seqNo = seqInTopic;
    });
    return topicStatsMap;
  }

  // 非「题材单独开启」：不加统计条，序号保持 0 → 模板沿用原来的全局序号（行为不变）
  items.forEach(function(it) { it.topicStats = null; it.groupTopic = ''; });
  // ★★ [BOARD-SEQ 2026-10-25 用户口径] 区间涨幅模式（十日 / 20日）下，序号改成「主板名次」：
  //   非主板【位置不变、但不占序号】（序号列留空），主板按屏幕顺序 1,2,3…
  //   ⇒ 屏幕上的号与规则文案里的「第 N 名」是同一把尺子（都能被
  //     topic-vol-ratio-rules.js#buildRange10Ranked 的主板名次复核）。
  //   用户原话：「……因为有两只非主板的也在十日涨幅前十里面，我想把非主板的序号去掉，
  //     这样冰山冷热就和下面提示文案口径相同了。也就是非主板的位置可以不变，但是没有序号，
  //     因为我是看序号来判断排名的。」
  //   ⚠️ 口径/判据全在 board-seq.js（唯一实现，§6）；其它模式它一律返回 seqNo=0 / seqBlank=false
  //      ⇒ 本段在默认 / 题材 / 竞昨模式下零行为变化（§11）。
  const _seq = buildMainBoardSeq(items, o.sortState);
  items.forEach(function(it, i) {
    it.seqNo = _seq[i].seqNo;
    it.seqBlank = _seq[i].seqBlank;
  });
  return null;
}
