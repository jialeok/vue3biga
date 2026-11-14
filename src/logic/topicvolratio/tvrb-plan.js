// tvrb-plan.js — 「题材量比」主计划构建（buildTopicVolRatioPlan + 切换日 / 新龙 判定）
//
// 从 topic-vol-ratio-rules.js 拆出。buildTopicVolRatioPlan 原本 1366 行，
// 它把前面几层的判定组装成 UI 直接消费的 out（blocks / picks / ebb / sell / cashAlert / notes）。
//
// ★★ 数据缺失 ⇒ 一只票都不选（fail-closed，用户铁律）★★
//   opts.dataGateBlocked 为真时，必须走 _clearBuySideForDataGate 把买点侧清空；
//   ⛔ 只在视图层 v-if 挡不住未来新增的买点通道。

import { TVRB_MIN_COUNT, TVRB_TOPIC_LIMIT, TVRB_SMALL_TOPIC_MAX, TVRB_CASH_ALERT_AVG_VR, EBB_NO_BUY_TAG, EBB_NO_BUY_TONE, WEAK_HUDDLE_RULE_NO, WEAK_HUDDLE_TAG, WEAK_HUDDLE_TOP_N, CATCH_UP_RULE_NO, CATCH_UP_TAG, CATCH_UP_RANK_FROM, CATCH_UP_RANK_TO, CATCH_UP_MIN_COUNT, CATCH_UP_MAX_COUNT, CATCH_UP_MIN_STREAK, TOPIC_LEADER_LIMITDOWN_RULE_NO, TOPIC_LEADER_LIMITDOWN_TAG, TOPIC_LEADER_LIMITDOWN_NO_BUY_TAG, TVRB_CASH_ALERT_NONE, NEW_DRAGON_TAG, NEW_DRAGON_LOOKBACK_DAYS, NEW_DRAGON_CERTIFY_TOP_N, NEW_DRAGON_FAMILY_MIN_COUNT, ABNORMAL_RULE_NO, ABNORMAL_NO_BUY_TAG, ABNORMAL_KIND_NEXT_DAY, ABNORMAL_KIND_LEADER_NOW, TVRB_RANGE10_CAP, TVRB_RANGE10_ABNORMAL, TVRB_ABNORMAL_NONE } from './tvrb-constants.js';
import { pickFamilyNewDragon, splitTopicSegs, isLineageTopic } from './new-dragon-family.js';
import { _normTopic, _sameTopicLoose, _num, _pct2, _streakWord, _secondTopicLeaderInTop10, _range10RankMapOf, _closeRankOf, _rankTopEntries, _topicTop10Hits, _windowTextOf, _todayRankPhrase, _rankLabelOf, _oldTopicNameOf, _oldTopicBasisOf } from './tvrb-utils.js';
import { detectEbbDay, secondEbbTopicOfPrevDay, buildEbbDayRecord } from './tvrb-ebb.js';
import { _applyPrevEbbSecondNoBuy, _applyLeaderLimitDownNoBuy, _applyEbbSellRules, _buildEbbPicksBlock, _applyEbbBuyRules, _applyCashAlertBuyRules, _applyDivergeNoBuyRules, _applyAbnormalNoBuyRules, _buildDivergeBuyBlock, _buildDivergeCashAlert, _buildWeakHuddleBlock, _buildLeaderLimitDownHuddleBlock, _buildCatchUpBlock, resolveTvrbTier, avgVolRatioOf, formatAvgVolRatio, buildCashAlert, _dragonCandidates, _buildBlock, _buildNewDragonBlock, _withAuctionLegPct, _buildRange10BackupBlock } from './tvrb-blocks.js';
// ★★ [ABNORMAL-10D 2026-11-13 用户口径] 第三十四条「监管异动 · 十日涨幅硬上限」的事实判定
//   （纯函数：把「总龙一昨日/今日十日涨幅 + 会被选中的票的十日涨幅」判成一块空仓标语）。
//   ⛔ 阈值 / 文案全在 abnormal-10d.js + tvrb-constants.js，本文件只负责【注入事实】与【收口】。
import { resolveAbnormalFact, classifyRange10, pickAbnormalSource, ABNORMAL_LEVEL_NEAR, ABNORMAL_LEVEL_ABNORMAL } from './abnormal-10d.js';
// ★★ [ABN-MAINBOARD 2026-11-13] 第三十四条「只主板」判据工厂（本文件内定义并导出，见 maxRangePctOf 下方）。

import { formatRangePct, RULE_NO, finishBuyBlock, buildSellPlan } from '../decision/decision-rules.js';
import { totalDragonLabel } from '../auction/range20-top5-label.js';
import { makeCoreTopicResolver } from '../topic/core-category.js';
import { pickRange10Backup, RANGE10_BACKUP_RULE_NO } from './range10-backup.js';
import { PRESENCE_TOP_N } from '../auction/presence-label.js';
import { getAuctionLimitState, isMainBoardRankEligible } from '../auction/limit-up.js';
// ★★ [ABN-MAINBOARD 2026-11-13] 第三十四条只认主板 ⇒ 需要「股票名 → 6 位代码」。
//   同步读内存缓存、0 请求；查不到 ⇒ ''（此时 isMainBoardRankEligible 判「有资格」= 保留，§10 方向性）。
import { getStockCode } from '../../data/stock-code-map.js';
// [TVRB-AUC-YIZI 2026-11-10] 买点行「竞价一字涨停 · 等开板后进」统一标注（只挂展示字段，不改选股）
import { annotateAuctionYizi, AUCTION_YIZI_WAIT_TAG } from './auction-yizi-tag.js';

/**
 * 【小件】从「区间涨幅 Map」里取某只票的十日涨幅。
 * Map 的值形如 `{pct, days}`（readRangePctForDate / readAuctionLegRangeMap / pctMap 都是这个形状）。
 * §10：取不到 / 非数字 ⇒ null（⛔ 不补 0）。
 * @param {Map<string,{pct:number|string|null}>|null} map
 * @param {string} name
 * @returns {number|null}
 */
function _rangePctOfMap(map, name) {
  if (!(map instanceof Map) || !name) return null;
  const hit = map.get(String(name).trim());
  return hit ? _num(hit.pct) : null;
}

/**
 * ★★ [ABNORMAL-ALL 2026-11-13] 某份【竞价口径十日涨幅 Map】里数值最高的那只票。
 *
 * 为什么需要（用户原话「昨天异动，11月12日买点侧也应该是灰色整片啊……现在还显示着
 * 东方海洋和大东方，这不合理的」）：第三十四条是【全市场硬约束】——「所有大a主板10日涨幅
 * 不能超过100%」，⛔ 不能只盯 20 日涨幅总龙一那一只。11-12 的 20 日涨幅总龙一是福莱新材
 * (150.27)，真正十日涨幅 100.78% 严重异动的是【总龙二东方海洋】(146.92)，旧判据直接漏掉。
 *
 * ⚠️ 只吃 `readAuctionLegRangeMap` 产出的【9:26 竞价口径】Map：
 *   `stock_range_pct.range_pct` 那条是收盘口径，11-11 东方海洋收盘 100.43（≥100）
 *   但竞价口径只有 95.71（未达红线）⇒ 拿收盘口径比会误判一整天。
 * §10：读不到 / 非法值一律跳过，⛔ 不补 0；空 Map ⇒ null。
 *
 * ★★ [ABN-MAINBOARD 2026-11-13 用户口径] 必须【只认主板】：
 *   用户原话「我要求的是主板的异动的有提醒，非主板就不要考虑在里面，像历史日期的
 *   10月28日，为什么把非主板的也考虑在里面呢……只有主板的才有这个条件」。
 *   注意用户最初立这条规矩时说的就是「所有大a**主板**10日涨幅不能超过100%」——
 *   是**实现漂移成了全池扫描**，这次改回原意。
 *
 *   生产取证（`.tmpdiag/_abn-history-scan.mjs`，2026-09-08 ~ 11-13 全扫）：
 *     旧口径（全池）触发 17 天，只主板口径只有 10 天 ⇒ **7 天完完全全是非主板在触发**：
 *       09-08 花溪科技 920895 北交所 121.70%（主板最高 国芳集团 84.23%）
 *       09-10 花溪科技 920895 北交所 103.00%（主板最高 龙版传媒 95.09%）
 *       10-26 凡拓数创 301313 创业板 134.65%（主板最高 冰山冷热 82.92%）
 *       10-27 凡拓数创 301313 创业板 102.59%（主板最高 大业股份 72.31%）
 *       10-28 凡拓数创 301313 创业板  89.51%（主板最高 大业股份 78.54%）← 用户点名的这天
 *     同时【旧口径漏触发 0 天】⇒ 加主板过滤不会漏掉任何一次真正的主板异动。
 *
 * ⛔ 判据不在这里另写一套代码段规则：用 `limit-up.js#isMainBoardRankEligible`
 *   （= 主板 + 代码未知 ⇒ 有资格；创业板/科创板/北交所 ⇒ 无资格）。
 *   与「十日涨幅 / 20日涨幅 只排主板」是同一把尺子（§6）。
 *   §10 方向性：代码未知一律【保留】—— 判不出板块 ≠ 判出「不是主板」，
 *   把「没查到」当「非主板」会静默漏掉本该提醒的主板异动，那比多算一只更危险。
 *
 * @param {Map<string,{pct:number|string|null}>|null} map
 * @param {(name:string)=>boolean} [isEligible] 可选：这只票要不要参与「最高票」评选
 * @returns {{name:string, pct:number}|null}
 */
export function maxRangePctOf(map, isEligible) {
  if (!(map instanceof Map) || map.size === 0) return null;
  const allow = (typeof isEligible === 'function') ? isEligible : null;
  let best = null;
  map.forEach(function (v, name) {
    const pct = v ? _num(v.pct) : null;
    const nm = String(name || '').trim();
    if (pct === null || !nm) return;
    if (allow && !allow(nm)) return;
    if (!best || pct > best.pct) best = { name: nm, pct: pct };
  });
  return best;
}

/**
 * ★★ [ABN-MAINBOARD 2026-11-13] 第三十四条专用「只主板」判据（股票名 → 要不要参与异动评选）。
 *
 * 为什么需要 name→code：`stock_range_pct` / `market_metrics` 都只按【股票名】索引，
 *   板块只能从代码前缀判（⛔ §40 绝不按名字猜板块）。
 * 代码来源 = `data/stock-code-map.js#getStockCode`（内存缓存，同步、0 请求）。
 * 名册查不到 ⇒ `isMainBoardRankEligible('')` = true ⇒ 保留（见上方 §10 方向性说明）。
 *
 * @param {(name:string)=>boolean} _isMainBoardRankEligible 注入（便于单测，⛔ 不在此写死实现）
 * @param {(name:string)=>string} _getStockCode
 * @returns {(name:string)=>boolean}
 */
export function makeAbnMainBoardFilter(_isMainBoardRankEligible, _getStockCode) {
  const eligible = (typeof _isMainBoardRankEligible === 'function') ? _isMainBoardRankEligible : function () { return true; };
  const codeOf = (typeof _getStockCode === 'function') ? _getStockCode : function () { return ''; };
  return function (name) {
    const nm = String(name || '').trim();
    if (!nm) return false;
    let code = '';
    try { code = String(codeOf(nm) || '').trim(); } catch (e) { code = ''; }
    return eligible(code) !== false;
  };
}

/**
 * 【小件】总龙一不在今日名单里时的兜底：从题材块成员行上取它的十日涨幅
 * （= 屏幕上那一列，§6 同一份真相）。
 * §10：找不到 ⇒ null（⛔ 不补 0、⛔ 不拿别的票顶替）。
 */
function _nearestMemberPct(list, name) {
  if (!name) return null;
  let pct = null;
  (list || []).forEach(function(b) {
    if (pct !== null) return;
    ((b && b.members) || []).forEach(function(m) {
      if (pct === null && m && String(m.name || '').trim() === name) pct = _num(m.pct);
    });
  });
  return pct;
}


/**
 * ★★ [TVRB-926-FACT 2026-10-24 用户口径 · 第二次修正] 买点侧说明区：只写【口径时间 + 涨幅 + 第几名】，⛔ 不解释。
 *
 * 用户原话（对上一版说明的直接反馈，逐字）：
 *   「所以买点侧的10日涨幅和20日涨幅的股票，如果有入选时也应该按照9点26分的口径，因为一般都是早上
 *     选出来，收盘看的时候就不一样的，所以你在说明文字那里说明，它排名第几名（我说有入选的时候）
 *     你不要解释，在上面说明时间他们的涨幅是多少排名第几就行了」
 *
 * ⇒ 本函数与上一版的差别【只在于文案】，判据一行没改：
 *   · 删掉「原因：十日涨幅的今天那根腿 15:00 后被换成收盘涨幅（第二十三条）」这类解释；
 *   · 删掉「⛔ 选股只认龙位 / ⛔ 不是按竞价量比高低」这类辩解；
 *   · 只留事实：`〔9:26 竞价口径〕X +35.21% 第 2 名（选入）`、`〔收盘口径〕Y +36.40% 第 2 名`。
 *
 * 根因（实测 9-24 房地产组，6 只 ⇒ 中档只取 1 只）：
 *   · 买点侧按【早上 9:26 竞价口径】的龙位选股（[TVRB-926] rankDragonsWithPctMap）——
 *     大亚圣象 龙一（竞价 +10.03% 一字，买不进已顺延）、**华远控股 龙二**、我爱我家 龙三、
 *     世联行 龙四、三峡新材 龙五、绿地控股 龙六 ⇒ 取龙二 = 华远控股；
 *   · 收盘后组内重排成：大亚圣象 龙一、**世联行 龙二**、…、华远控股 龙五。
 *   ⇒ 说明区把两个口径的【数值 + 名次】并列摆出来，用户自己一眼核对（⛔ 不再替用户下结论）。
 *
 * 发声条件（§11 零行为变化）：只有【真正出现差异】时才追加一条说明 ——
 *   9:26 口径与收盘口径的龙位完全一致时，本函数一个字都不写。
 *
 * @param {object} blk _buildBlock 的返回（含 block.members / picks / notes）；
 *        picks[].pct 已是【9:26 口径】（见 _dragonCandidates），picks[].dragonRank = 9:26 名次
 * @param {Map} closeDragonMap 收盘口径的龙位名册（= rankDragons 的返回，项含 pct）；
 *        缺省 / 空 ⇒ 无可比 ⇒ 不发声（§10 不猜「它收盘是龙几」）
 */
export function _appendDragonDriftNote(blk, closeDragonMap, byOrder) {
  if (!blk || !blk.block || !Array.isArray(blk.picks) || blk.picks.length === 0) return;
  if (!closeDragonMap || typeof closeDragonMap.get !== 'function' || closeDragonMap.size === 0) return;
  const topic = String(blk.block.topic || '').trim();
  const pickedNames = new Set();
  const aucFacts = [];        // 〔9:26 竞价口径〕被选中的那只/那几只：涨幅 + 名次
  const closeFacts = [];      // 〔收盘口径〕被选中的 + 收盘排得更前却没轮到的
  let drift = false;
  let bestPickedClose = Infinity;

  blk.picks.forEach(function(p) {
    const nm = String((p && p.name) || '').trim();
    if (!nm) return;
    pickedNames.add(nm);
    const buyRank = Number(p && p.dragonRank);
    if (isFinite(buyRank) && buyRank > 0) {
      aucFacts.push({ name: nm, pct: p.pct, rank: buyRank, picked: true });
    }
    const c = closeDragonMap.get(nm);
    if (!c || !c.rank) return;
    if (String(c.topic || '').trim() !== topic) return;   // 换题材的龙位不可比（§10）
    const closeRank = Number(c.rank);
    if (!isFinite(closeRank) || closeRank <= 0) return;
    if (closeRank < bestPickedClose) bestPickedClose = closeRank;
    closeFacts.push({ name: nm, pct: c.pct, rank: closeRank, picked: true });
    if (isFinite(buyRank) && buyRank > 0 && closeRank !== buyRank) drift = true;
  });
  if (!drift) return;   // §11：两个口径完全一致 ⇒ 一个字都不多写

  // 收盘口径下排在「被选中的那只」前面、却没被选中的同题材成员（= 用户会追问的那几只）
  (blk.block.members || []).forEach(function(m) {
    const nm = String((m && m.name) || '').trim();
    if (!nm || pickedNames.has(nm)) return;
    const c = closeDragonMap.get(nm);
    if (!c || !c.rank) return;
    if (String(c.topic || '').trim() !== topic) return;
    const closeRank = Number(c.rank);
    if (!isFinite(closeRank) || closeRank >= bestPickedClose) return;
    closeFacts.push({ name: nm, pct: c.pct, rank: closeRank, picked: false });
  });

  const _fact = function(f) {
    return f.name + ' ' + _pct2(f.pct) + ' 第 ' + f.rank + ' 名' + (f.picked ? '（选入）' : '');
  };
  closeFacts.sort(function(a, b) { return a.rank - b.rank; });

  blk.notes = Array.isArray(blk.notes) ? blk.notes : [];
  // ★ [SMALL-TOPIC 2026-10-24] 收紧档【不是】按龙位选股（按十日涨幅前十选）⇒ 括号里那句必须换：
  //   ⛔ 照抄「并按它选股」会与该块的实际情况相反（用户对文案与实际不一致特别敏感）。
  const leadLabel = byOrder
    ? 'ℹ️ 本题材龙位（买点侧按【9:26 竞价口径】排；本块按「十日涨幅前十」取票，见上一条）：'
    : 'ℹ️ 本题材龙位（买点侧按【9:26 竞价口径】排、并按它选股）：';
  blk.notes.push(leadLabel +
    '〔9:26 竞价口径〕' + aucFacts.map(_fact).join('；') + '。' +
    '〔收盘口径〕' + (closeFacts.length > 0 ? closeFacts.map(_fact).join('；') : '—') + '。');
}

/**
 * ★★ [R20-926 2026-10-24 用户口径] 买点侧【20日涨幅通道】的入选票：把「9:26 那一刻的涨幅 + 名次」写出来。
 *
 * 用户原话（逐字）：
 *   「所以买点侧的10日涨幅和20日涨幅的股票，如果有入选时也应该按照9点26分的口径，因为一般都是
 *     早上选出来，收盘看的时候就不一样的，所以你在说明文字那里说明，它排名第几名（我说有入选的时候）
 *     你不要解释，在上面说明时间他们的涨幅是多少排名第几就行了」
 *
 * 覆盖范围（= 买点侧全部走 20日涨幅 的票，别漏）：
 *   · `out.ebbBuy`   —— 退潮首日的替补（总龙二~五，第二十六条）；
 *   · `out.newDragon`—— 切换日的新龙（前八里挑，第二十八条）。
 *   ⛔ 不含十日涨幅通道（那是第二十九条，口径已在 `_buildRange10BackupBlock` 里标好）。
 *
 * 文案纪律（★ 用户明确要求「你不要解释」）：
 *   · 只写「〔口径时间〕名称 涨幅 第几名」，⛔ 不写原因、⛔ 不写「这是正常的」这类辩解；
 *   · ★★ [TVRB-AUC-BOARD 2026-11-10] 题材量比的 20 日涨幅候选池已【恒 9:25 竞价口径】，
 *     `ebbCtx.top5[].rank20` 与 `aucMap` 现在是同一份榜 ⇒ 两组数值会完全相同。
 *     ⇒ 这时【只输出竞价口径一段】，⛔ 不再并列一个写着「收盘口径」的假对照。
 *     只有在回落路径（竞价榜判不出、两组确实不同）才保留历史的两口径并列。
 *   · §10：`aucMap` 里没有这只票（该日 20 日涨幅的 9:26 口径判不出）⇒ **一行都不写**，
 *     ⛔ 绝不拿收盘口径冒充、⛔ 不猜一个名次；
 *   · §11：`aucMap` 缺省（组合式没注入 / 没读到）⇒ 本函数直接返回，一个字都不多写。
 *
 * @param {object} out buildTopicVolRatioPlan 的产出（读 ebbBuy / newDragon / notes）
 * @param {Map|null} aucMap 该日【9:25 竞价口径】20 日榜的名次表（name -> {pct, days, rank}）
 * @param {object|null} ebbCtx 采集层的事实（top5 / newDragonPool 的 rank20；现在也是竞价口径榜）
 */
export function _appendRange20AucNote(out, aucMap, ebbCtx) {
  if (!out || !aucMap || typeof aucMap.get !== 'function' || aucMap.size === 0) return;
  // 榜上的名次（top5 / newDragonPool 每项都带 rank20）——现在与 aucMap 同源，仅用于判「是否同一口径」
  const closeInfo = new Map();
  const _put = function(arr) {
    (Array.isArray(arr) ? arr : []).forEach(function(t) {
      const nm = String((t && (t.name || t.stock)) || '').trim();
      if (!nm || closeInfo.has(nm)) return;
      closeInfo.set(nm, { pct: _num(t.pct), rank: Number(t.rank20) || null });
    });
  };
  if (ebbCtx) { _put(ebbCtx.newDragonPool); _put(ebbCtx.top5); }

  const rows = [];
  const seen = new Set();
  [out.ebbBuy, out.newDragon].forEach(function(blk) {
    (blk && Array.isArray(blk.picks) ? blk.picks : []).forEach(function(p) {
      const nm = String((p && p.name) || '').trim();
      if (!nm || seen.has(nm)) return;
      const a = aucMap.get(nm);
      if (!a) return;                     // §10：这只票 9:26 口径判不出 ⇒ 不写（⛔ 不猜名次）
      const aucRank = Number(a.rank) || null;
      if (aucRank === null) return;       // 非主板 / 天数不足 ⇒ 没有名次，不写
      seen.add(nm);
      const ci = closeInfo.get(nm) || null;
      rows.push({
        name: nm,
        aucPct: _num(a.pct), aucRank: aucRank,
        closePct: ci ? ci.pct : _num(p && p.pct),
        closeRank: ci ? ci.rank : null
      });
    });
  });
  if (rows.length === 0) return;

  const _a = rows.map(function(r) { return r.name + ' ' + _pct2(r.aucPct) + ' 第 ' + r.aucRank + ' 名'; }).join('；');
  out.notes = Array.isArray(out.notes) ? out.notes : [];
  // ★★ [TVRB-AUC-BOARD 2026-11-10] 两组完全同源（数值与名次都相同）⇒ 只报竞价口径这一段。
  //   恒竞价口径后这是本板的主路径；⛔ 绝不能把同一组数字标成「收盘口径」再说一遍。
  const _sameLeg = rows.every(function(r) {
    return r.aucPct !== null && r.closePct !== null &&
      Math.abs(r.closePct - r.aucPct) < 1e-9 && r.closeRank === r.aucRank;
  });
  if (_sameLeg) {
    out.notes.push('ℹ️ 买点侧【20日涨幅通道】入选票的涨幅与名次' +
      '〔9:25 竞价口径 · 本板唯一口径，收盘后不变〕' + _a + '。');
    return;
  }
  // 回落路径（竞价榜判不出 ⇒ ebbCtx 仍是收盘口径发布榜）：保留历史的两口径并列对照。
  const _c = rows.map(function(r) {
    return r.name + ' ' + _pct2(r.closePct) + ' 第 ' + (r.closeRank === null ? '—' : r.closeRank) + ' 名';
  }).join('；');
  out.notes.push('ℹ️ 买点侧【20日涨幅通道】入选票的涨幅与名次：' +
    '〔9:26 竞价口径〕' + _a + '。〔收盘口径〕' + _c + '。');
}

/**
 * ★★ [DUAL-RANK 2026-10-24 用户口径] 「两套口径的前十名单」对照文案（复盘专用）。
 *
 * 为什么要有这一段：单看一只票的「收盘口径第 N 名」还不够 —— 用户复盘时的困惑是
 *   「为什么竞价口径是上海九百、收盘回看却是兆威机电」这种【整批名单换了】的现象。
 *   逐只给名次能对上号，但看不到「这一批到底进了谁、出了谁」。
 *
 * §10 / §11 两条安全降级：
 *   · 任一套名次表为空 ⇒ 判不出 ⇒ 返回 ''（⛔ 不写半段、不猜）；
 *   · 两套前十【名单与顺序完全一致】⇒ 没有可对照的差异 ⇒ 返回 ''（零噪声；
 *     调用方没传 9:26 口径（pctMap）时 rows 原样返回，两套必然一致 ⇒ 自动不出现）。
 *
 * ⛔ 只列事实，不下结论（选股永远用竞价口径那一份）。
 *
 * @param {Map} rank926 竞价口径名次表
 * @param {Map} rankClose 收盘口径名次表
 * @param {number} topN 「前十」的 N
 * @returns {string}
 */
export function _range10DualTopText(rank926, rankClose, topN) {
  const n = (isFinite(Number(topN)) && Number(topN) > 0) ? Math.floor(Number(topN)) : PRESENCE_TOP_N;
  const a = _rankTopEntries(rank926, n);
  const b = _rankTopEntries(rankClose, n);
  if (a.length === 0 || b.length === 0) return '';
  const same = a.length === b.length && a.every(function(x, i) { return x.name === b[i].name; });
  if (same) return '';

  const fmt = function(list) {
    return list.map(function(x) { return x.rank + '.' + x.name; }).join(' ');
  };
  const closeRankOf = new Map();
  b.forEach(function(x) { closeRankOf.set(x.name, x.rank); });
  const aNames = new Set(a.map(function(x) { return x.name; }));
  const moves = [];
  a.forEach(function(x) {
    if (!closeRankOf.has(x.name)) {
      moves.push(x.name + ' 竞价第 ' + x.rank + ' 名 → 收盘掉出前十');
    } else if (closeRankOf.get(x.name) !== x.rank) {
      moves.push(x.name + ' 竞价第 ' + x.rank + ' 名 → 收盘第 ' + closeRankOf.get(x.name) + ' 名');
    }
  });
  b.forEach(function(x) {
    if (aNames.has(x.name)) return;
    moves.push(x.name + ' 竞价没进前十 → 收盘第 ' + x.rank + ' 名');
  });
  return '📊【两套口径前十对照 · 复盘专用】⛔ 只作对照，选股与行上的名次仍固定为【竞价口径（9:26）】。' +
    '竞价口径（9:26，本看板选股用的那一份）前十：' + fmt(a) + '｜' +
    '收盘口径（现价，即早盘竞价「10日涨幅」toggle 上看到的原始排名）前十：' + fmt(b) + '｜' +
    '差异：' + (moves.length ? moves.join('；') : '名次相同') + '。';
}

/**
 * 把「第 2 个入选题材块」整块摘掉，并重建 heavy / light / candidates 三个槽位（§6 唯一实现）。
 *
 * ⚠️ 为什么必须重建槽位：`buy.light` 若还挂着已删除的块，四个装饰器会遍历到幽灵块 ——
 *    那是「静默多渲染一段」的最短路径（第二十九条量比作废那次踩过）。
 * @param {object} out buildTopicVolRatioPlan 的产出
 * @returns {boolean} 真的摘掉了 ⇒ true（不足两块 ⇒ false，调用方据此决定要不要写说明）
 */
export function _dropSecondBlockSlot(out) {
  if (!out || !Array.isArray(out.blocks) || out.blocks.length < 2) return false;
  out.blocks.splice(1, 1);
  out.buy.heavy = null;
  out.buy.light = null;
  out.buy.candidates = [];
  out.blocks.forEach(function(b, i) {
    if (i === 0) out.buy.heavy = b;
    else if (i === 1) out.buy.light = b;
    else out.buy.candidates.push(b);
  });
  return true;
}

/**
 * 【纯函数】切换日判定：二次确认退潮是否正好发生在前两个交易日。
 *
 * @param {Array<{date:string, prevDate:string, leaderStock:string, leaderTopic:string, ebb:boolean}>|null} ebbHistory
 * @param {string} prevPrevDate 展示日的【前两个交易日】（组合式注入，⛔ 规则层不自算日期）
 * @param {(raw:string)=>string} [coreRes] ★ [CORE-CAT 2026-10-22] 题材大类归一函数（见 _normTopic）
 * @param {string} [windowFrom] ★ [EBB-20D 2026-10-22] 事件窗口起点（与 detectEbbDay 同一把尺子）
 * @returns {{ebbDate:string, topic:string, leaderName:string, since:string}|null}
 */
export function detectSwitchDay(ebbHistory, prevPrevDate, coreRes, windowFrom) {
  const ppd = String(prevPrevDate || '').trim();
  if (!ppd || !Array.isArray(ebbHistory)) return null;
  const hit = secondEbbTopicOfPrevDay(ebbHistory, ppd, coreRes, windowFrom);
  if (!hit) return null;
  return {
    ebbDate: ppd,
    topic: _normTopic(hit.topic, coreRes),
    leaderName: String(hit.leaderName || '').trim(),
    since: String(hit.since || '')
  };
}

/**
 * 【纯函数】从今日 20日涨幅【前八】里挑出【新龙】。
 *
 * 「前五 → 前八」（用户 2026-10-22 原话）：「如果前五找到你就找前八的，不用前五的，改用排名前八的。
 *   注意竞价涨停一字涨停板是买不进的，所以前八的，在这个节点上，你只能挑选非竞价一字涨停的主板」。
 * ⇒ 候选 = 20日涨幅第 1~8 名（已按「只主板」在上游 rankLeaders(mainBoardOnly) 排过），
 *   本函数再逐只过【非竞价一字 / 非停牌 / 非主板】三道闸，然后在剩下的里挑第一只。
 *
 * @param {Array<{name:string, code:string, topic:string, pct:number, pctText:string, rank20:number,
 *          isYizi:boolean, suspended:boolean, mainBoard?:boolean}>} top5
 *        采集层富化过的前八（decision-collect#_ebbCtxOf 的 newDragonPool，已带题材/代码/停牌/一字/主板）
 * @param {Set<string>} everInTop5 近 20 个交易日【上过前五】的股票名集合（data/range20-top5-history.js）
 *        ⚠️ 历史榜口径仍是【前五】（用户原话「20个交易日内……有没有上榜前五？」）——
 *           前八只是【今天】的候选放宽，⛔ 别把历史口径也放宽（会把 10-22 的冰山冷热误杀）。
 * @param {{oldTopic?:string, oldLeaderName?:string, windowDays?:number, coreRes?:Function}} info
 *        oldTopic / oldLeaderName = 老龙一（= 二次确认退潮那只总龙）
 *        windowDays = 实际覆盖的天数（写进说明，§10 覆盖度如实上报）
 *        coreRes    = ★ [CORE-CAT 2026-10-22] 题材大类归一（同题材判定必须走大类）
 * @returns {{pick:object|null, trail:Array<{name:string, rank20:number, picked:boolean, reason:string}>, oldTopic:string}}
 */
export function pickNewDragon(top5, everInTop5, info) {
  const o = info || {};
  const top = Array.isArray(top5) ? top5 : [];
  const ever = (everInTop5 instanceof Set) ? everInTop5 : new Set();
  const coreRes = (typeof o.coreRes === 'function') ? o.coreRes : null;
  const ln = String(o.oldLeaderName || '').trim();
  // 老龙题材：优先用落库的退潮行（老龙一自己的题材）；缺失 ⇒ 退回「今天榜第一名的题材」
  //   （今天的第一名就是老龙一 —— 停牌也被 20日口径排上榜，所以这条退路语义等价）。
  const lt = _normTopic(o.oldTopic, coreRes) || _normTopic(top[0] && top[0].topic, coreRes);
  const windowDays = Number(o.windowDays) || NEW_DRAGON_LOOKBACK_DAYS;
  const trail = [];
  let pick = null;
  for (let i = 0; i < top.length; i++) {
    const c = top[i];
    if (!c || !c.name) continue;
    const name = String(c.name).trim();
    const rank20 = Number(c.rank20) || (i + 1);
    // ★ 已选出新龙 ⇒ 后面的【照样留痕】但不再评估：说明文案写的是「八只去留（判定可追溯）」，
    //   提早 break 会让后面几只凭空消失（用户无法复核「为什么不是它」）。
    //   ⛔ 切换日只买一只新龙 ⇒ 后面这些本来也不可能被选中，写明原因即可（不假装评估过）。
    if (pick) {
      trail.push({ name: name, rank20: rank20, picked: false,
        reason: '前面已选出更靠前的新龙【' + String(pick.name).trim() + '】⇒ 切换日只买一只新龙，本只不再考虑' });
      continue;
    }
    if (ln && name === ln) {
      trail.push({ name: name, rank20: rank20, picked: false, reason: '它就是老龙一【' + ln + '】（被交接的一方，不算新龙）' });
      continue;
    }
    // ★ [NEW-DRAGON-08 2026-10-22] 只主板：创业板 / 科创板 / 北交所一律排除（用户「只挑主板」）。
    //   主板判定由采集层用 isMainBoardOnly 算好并带过来（§6 单一实现，本层不另写一套代码段规则）。
    //   ⚠️ mainBoard 缺省（undefined）⇒ 不据此排除（老调用方 / 单测不传时零行为变化，§11）。
    if (c.mainBoard === false) {
      trail.push({ name: name, rank20: rank20, picked: false, reason: '非主板（创业板/科创板/北交所）⇒ 排除' });
      continue;
    }
    // ★ [NEW-DRAGON-08 2026-10-22] 竞价一字涨停 ⇒ 买不进，不能当新龙（用户原话）。
    if (c.isYizi) {
      trail.push({ name: name, rank20: rank20, picked: false, reason: '今日竞价一字涨停 ⇒ 买不进，不能作新龙' });
      continue;
    }
    // ★ 停牌 ⇒ 买不进（与买点侧「连续停牌顺延」同一取舍）
    if (c.suspended) {
      trail.push({ name: name, rank20: rank20, picked: false, reason: '今日停牌 ⇒ 买不进，不能作新龙' });
      continue;
    }
    const tp = _normTopic(c.topic, coreRes);
    if (!tp) {
      trail.push({ name: name, rank20: rank20, picked: false, reason: '题材解析不到 ⇒ 无法证明是「新题材」，保守排除' });
      continue;
    }
    if (ever.has(name)) {
      trail.push({ name: name, rank20: rank20, picked: false, reason: '近 ' + _windowTextOf(windowDays) + '已上过前五 ⇒ 不是首次上榜' });
      continue;
    }
    if (lt && _sameTopicLoose(tp, lt, coreRes)) {
      trail.push({ name: name, rank20: rank20, picked: false, reason: '与老龙一同题材（' + lt + '）⇒ 老周期，退潮后不买' });
      continue;
    }
    trail.push({ name: name, rank20: rank20, picked: true,
      reason: '近 ' + _windowTextOf(windowDays) + '【首次】进入 20日涨幅前列（此前未进前五）+ '
        + _todayRankPhrase(rank20) + ' + 与老龙一【不同题材】⇒ 新龙（老龙→新龙交接）' });
    pick = c;
  }

  // ══════════════════════════════════════════════════════════════════════════════════════
  // ★★ [NEW-DRAGON-CERTIFY 2026-11-12 用户口径] 【同题材认证龙】—— 第二十八条的收紧前提。
  //
  // 用户原话（11-12，原话尽量保留）：
  //   「寻找新龙的方法，这个没错，但是还要添加下前提：**前五没有同题材的票才可以**，
  //     也就是同题材的票如果排在它前面，那么买点侧这个就会被同题材的票取代。
  //     像今天 11 月 12 日，买点侧判断的是光洋股份进入的理由也是第 28 条规则，但是同题材的
  //     襄阳轴承竞价口径排名第三，所以应该选襄阳轴承，而不是选光洋股份。因为这两只同题材的
  //     同时出现在 20 日涨幅前五，所以只买最靠前的那只襄阳轴承（工业 4.0）。」
  //   「光洋股份首次进前五，判断出题材，是工业 4.0，但还要看工业 4.0 是否有股票也进去前五
  //     （可能工业 4.0 排前五的不是第一次），像襄阳轴承同样是工业 4.0（它已经二次进入了），
  //     竞价口径排名前三，对比下选择靠前的，当然选它，而不是光洋股份，
  //     **光洋股份只做为判断条件**；当然如果没有同题材进去前五……那只有选它光洋股份作为新龙。」
  //   「襄阳轴承是叫【认证龙】。因为出现好几次在 20 日涨幅前五，靠同题材的光洋股份去认证它。」
  //   「（我说的同题材和主线题材不同的题材，这个要注意，不要搞混了）」
  //
  // ⇒ 规则（在原有四道闸之后再加一道「同题材择优」）：
  //   ① 候选 X = 上面挑出的「首次进入前五」的那只 —— 它的作用只是【证明这个题材是新的】；
  //   ② 到【前五】(rank20 ≤ 5) 里找**同题材**的其它票（同题材 = 细分题材，⛔ 不做大类归一，
  //      ⛔ 与退潮判定的「主线题材 ≥3 只」完全是两件事 —— 用户特意点明了这条）；
  //   ③ 有 ⇒ 取竞价口径【最靠前】的那只当买点（= 认证龙；X 退为「认证依据」，⛔ 不再单独买）；
  //      没有 ⇒ 仍然选 X（= 10-22 冰山冷热那次：该题材只有它一只进前五）。
  //   ④ 认证龙照样要过「可买」三道闸（非竞价一字 / 非停牌 / 主板）——
  //      买不进就退到下一个同题材票，全买不进才退回 X（⛔ 绝不因为「它是认证龙」就破例）。
  //   ⛔ 与其它规则不冲突：最终 pick 仍然进 `out.buyNames` ⇒ 别的买点块不会重复选它（§6 同一套去重）。
  let pickKind = pick ? 'new' : '';
  let certifier = null;
  let family = null;
  let extras = [];

  // ══════════════════════════════════════════════════════════════════════════════════════
  // ★★ [NEW-DRAGON-FAMILY 2026-11-12 用户口径] 新题材 = 【字号 / 字辈题材】（本版口径）
  //
  // 用户原话（11-12，逐字）：
  //   「11月12日，20日涨幅 toggle 竞价口径排名前十的，东方题材的有三只，东方海洋排第二，
  //     大东方7，日出东方8，所以东方应该作为新题材。所以应该选东方海洋和大东方，
  //     东方海洋因为是之前老周期羊字辈的总龙一，老龙，现在它切换成了东方这个新题材，
  //     就是它即是老龙，又是新龙。这是题材原因，不能把它一棒子打死。」
  //   「如果它不是老龙变新龙（也就是不换题材，或者这只股票没有东方这个题材），
  //     那么就应该选一只，大东方。」
  //   「如果最强那一只含有老周期也可以选入，因为它有双重属性。」
  //
  // ⇒ 规则本体在 `new-dragon-family.js`（纯函数 + 单测，§15），这里只负责接线与留痕：
  //   · 候选池 = **当日 9:25 竞价口径 20日涨幅前十**（= 组合式注入的 `ebbCtx.topicPool`，
  //     就是「20日涨幅 toggle」上用户看到的那一份 `market_metrics(scope=auction)` 名单）；
  //   · 判出新题材 ⇒ 直接接管 pick（可能 1 只，也可能 2 只：老龙换题材 + 一只新面孔）；
  //   · 判不出（没有任何题材组同时满足「≥2 只 + 含新面孔」）⇒ 落回下面的旧路径
  //     （10-22 冰山冷热那次就是旧路径，用户确认「寻找新龙的方法，这个没错」⇒ 保留）。
  //   ⚠️ 上一版「同题材择优 · 前五（认证龙）」不再优先，只在 family 判不出时兜底 ——
  //      它把「同题材」当成细分行业（工业4.0），11-12 因此选出福莱新材，与用户口径不符。
  // ══════════════════════════════════════════════════════════════════════════════════════
  //   ⚠️ **只有调用方显式注入 `topicPool10` 才走本路径**（老调用方 / 单测不传 ⇒ 行为与上一版逐字相同，§11）。
  //      不拿候选池（前八）冒充前十：前十是「20日涨幅 toggle」上用户看到的那份名单，条数与口径都不同。
  const pool10 = (Array.isArray(o.topicPool10) && o.topicPool10.length > 0) ? o.topicPool10 : null;
  const fam = pool10
    ? pickFamilyNewDragon(pool10, {
      everInTop5: ever,
      minCount: NEW_DRAGON_FAMILY_MIN_COUNT,
      // ★★ [NEW-DRAGON-FAMILY-OLD 2026-11-12 用户口径] 正在退潮的老题材不进候选。
      //   用户原话：「退潮的是【羊字辈】，新题材的是【东方】，你搞混了吧？」
      oldTopics: Array.isArray(o.oldTopics) ? o.oldTopics : null
    })
    : null;
  if (fam) {
    pickKind = 'family';
    // ★★ [LEADER-FIRST-TOPIC / R3 2026-11-12 用户口径] 题材一律按【核心词（大类）】展示：
    //   「我会随时改核心词，选股有时也会根据核心词的同义词进行调整，你提就要提核心词（大类）
    //    不要说一些同义词细分，这个我之前有要求过的。」
    //   ⚠️ 分组仍然按【原始题材段】（那是「同一个炒作线有几只」的事实），只是**印出来的名字**
    //     过一遍核心词归一 ⇒ 用户改了核心词，屏幕上的大类名跟着变（§6 一份实现）。
    const famTopicText = _normTopic(fam.topic, coreRes) || String(fam.topic || '').trim();
    pick = fam.pick;
    extras = fam.extras;
    certifier = fam.certifier ? {
      name: fam.certifier.name,
      topic: famTopicText,
      rank20: fam.certifier.rank20,
      everBefore: !!fam.certifier.everBefore,
      reason: fam.certifier.reason || '',
      // ★★ [NEW-DRAGON-FAMILY-OLD 2026-11-12 用户口径 · 一字那只也要进买点侧]
      //   用户原话：「不过东方海洋是竞价一字涨停，所以打上标签【竞价一字涨停 等下杀买】，
      //     买点侧一样要有。」
      //   ⇒ 竞价一字 = 竞价买不进，但**要在买点侧列出来**、挂「等下杀买」标签（开板下杀再接）；
      //     停牌 / 非主板 = 真的买不进 ⇒ 仍然只作题材认证（role='certify-only'，不进买点）。
      role: (fam.certifier.reason === 'yizi') ? 'wait-buy' : 'certify-only'
    } : null;
    family = {
      topic: famTopicText,
      count: fam.count,
      bestRank: fam.primary.rank20,
      primaryName: fam.primary.name,
      primaryEverBefore: !!fam.primary.everBefore,
      members: fam.members.map(function(m) {
        return {
          name: m.name, rank20: m.rank20,
          pct: _num(m.pct), code: String(m.code || ''),
          everBefore: !!m.everBefore, isYizi: !!m.isYizi,
          suspended: !!m.suspended, mainBoard: m.mainBoard !== false
        };
      }),
      groups: fam.groups.map(function(g) {
        // ★ [R3 用户口径] 组名同样按核心词（大类）印，⛔ 不出现同义词细分
        return { topic: _normTopic(g.topic, coreRes) || String(g.topic || ''), count: g.count, freshCount: g.freshCount };
      })
    };
    // trail 按【前十】逐只重建（判定可追溯，§10：用户要能复核「为什么不是其它几只」）
    const buyNames = [pick.name].concat(extras.map(function(m) { return m.name; }));
    const buySet = new Set(buyNames);
    const certName = certifier ? certifier.name : '';
    const certWhy = certifier
      ? (certifier.reason === 'yizi' ? '竞价一字涨停（买不进）'
        : (certifier.reason === 'suspended' ? '停牌（买不进）' : '非主板（买不进）'))
      : '';
    trail.length = 0;
    pool10.forEach(function(c, i) {
      const nm = String((c && c.name) || '').trim();
      if (!nm) return;
      const rk = Number(c && c.rank20) || (i + 1);
      let reason;
      if (nm === certName) {
        reason = '题材【' + famTopicText + '】里最靠前的那只（' + _rankLabelOf(rk) + '），但今日【' + certWhy + '】⇒ ' +
          (certifier.role === 'wait-buy'
            ? '买点侧照样列出、挂【' + AUCTION_YIZI_WAIT_TAG + '】'
            : '只作题材认证，不进买点');
      } else if (buySet.has(nm)) {
        if (nm === fam.primary.name) {
          reason = '题材【' + famTopicText + '】里竞价口径最靠前（' + _rankLabelOf(rk) + '），且本身就是老周期总龙 ⇒ ' +
            '【双重属性】既是老龙又是新龙，本只作新题材的主选';
        } else if (extras.some(function(m) { return m.name === nm; })) {
          reason = '题材【' + famTopicText + '】里的【新面孔】（' + _rankLabelOf(rk) + '，近 ' +
            _windowTextOf(windowDays) + '没进过前五）⇒ 与老龙换题材的【' + fam.primary.name +
            '】一起买（双重属性：老龙 + 一只纯新票）';
        } else {
          reason = '题材【' + famTopicText + '】里最靠前的【' + fam.primary.name + '】（' + _rankLabelOf(fam.primary.rank20) +
            '）今日【' + certWhy + '】⇒ 买点顺延到本只（' + _rankLabelOf(rk) + '）';
        }
      } else {
        reason = '不在新题材【' + famTopicText + '】的买点里（该题材已选出 ' + buyNames.join('、') +
          '）⇒ 切换日不再考虑它';
      }
      trail.push({ name: nm, rank20: rk, picked: buySet.has(nm), reason: reason });
    });
  }

  if (!family && pick) {
    const xName = String(pick.name).trim();
    // ⚠️ 同题材比较【不做大类归一】：`_normTopic(raw)` 只清洗，`_sameTopicLoose(..., 无 coreRes)`
    //    按细分题材（含分段串认亲）比 —— 正是用户强调的「同题材 ≠ 主线题材」。
    const xTopic = _normTopic(pick.topic);
    if (xTopic) {
      const peers = [];
      for (let j = 0; j < top.length; j++) {
        const c = top[j];
        if (!c || !c.name) continue;
        const nm = String(c.name).trim();
        if (nm === xName) continue;
        if (ln && nm === ln) continue;                 // 老龙一永远不算
        const rk = Number(c.rank20) || (j + 1);
        if (rk > NEW_DRAGON_CERTIFY_TOP_N) continue;   // 用户口径：只看【前五】（⛔ 不是前八）
        if (c.mainBoard === false) continue;           // 非主板买不了（与上面同一条尺子）
        if (c.isYizi) continue;                        // 竞价一字买不进
        if (c.suspended) continue;                     // 停牌买不进
        if (!_sameTopicLoose(c.topic, xTopic)) continue;   // ⛔ 不做大类归一
        peers.push({ c: c, rank20: rk });
      }
      if (peers.length > 0) {
        peers.sort(function(a, b) { return a.rank20 - b.rank20; });   // 竞价口径最靠前优先
        const best = peers[0];
        const bestName = String(best.c.name).trim();
        pickKind = 'certify';
        certifier = {
          name: xName,
          topic: xTopic,
          rank20: Number(pick.rank20) || 0,
          // 认证龙自己是「第几次进前五」—— 说明文案要用它写清「它已经进过前五」
          everBefore: ever.has(bestName)
        };
        // trail 改写：X 从「已选中」降为「认证依据」，最终 pick 换成认证龙
        trail.forEach(function(t) {
          if (t.name === xName) {
            t.picked = false;
            t.reason = '该题材【首次进入前五】的那只是它 ⇒ 用来「认证」这个新题材；' +
              '但同题材的【' + bestName + '】（' + _rankLabelOf(best.rank20) +
              '）更靠前 ⇒ 按用户口径只买最靠前的那一只，本只不再单独买';
          } else if (t.name === bestName) {
            t.picked = true;
            t.reason = '同题材【' + xTopic + '】里有首次进前五的【' + xName + '】（' +
              _rankLabelOf(certifier.rank20) + '）⇒ 该题材是新题材，本只' +
              (certifier.everBefore ? '此前已进过前五（≥2 次）' : '也已在前五') +
              '且竞价口径更靠前（' + _rankLabelOf(best.rank20) + '）⇒ 作【认证龙】买入';
          }
        });
        // 认证龙若本来不在 trail 末尾（rank 更靠前 ⇒ 循环早就把后面标成「已选出更靠前的新龙」），
        // 那些「已选出 X」的说明现在指向了错的票 ⇒ 统一改成指向认证龙。
        trail.forEach(function(t) {
          if (t.picked || t.name === xName) return;
          if (t.reason && t.reason.indexOf('前面已选出更靠前的新龙【' + xName + '】') === 0) {
            t.reason = '前面已选出更靠前的新龙【' + bestName + '】' +
              '（同题材认证龙，竞价口径更靠前）⇒ 切换日只买一只新龙，本只不再考虑';
          }
        });
        pick = best.c;
      }
    }
  }
  return {
    pick: pick, trail: trail, oldTopic: lt, pickKind: pickKind, certifier: certifier,
    // ★★ [R3 2026-11-12 用户口径] 这只票的题材按【核心词（大类）】印（"文化传媒" ⇒ "AI应用"）。
    //   ⛔ 不改 `pick.topic` 本体：它还带着分段串，是成员归属的事实（§6 单一数据源不改原值）。
    topicText: pick ? _normTopic(pick.topic, coreRes) : '',
    // ★★ [NEW-DRAGON-FAMILY 2026-11-12] 新题材（字号/字辈）相关事实 —— 供文案层拼说明
    family: family,          // null = 本次走的是旧路径
    extras: extras           // 补选（最多 1 只：老龙换题材时的那只纯新票）
  };
}

/**
 * 【本看板 · 买点 + 卖点的唯一实现（§6）】。
 *
 * 一次调用产出三块东西：
 *   ① 选股（本看板自己的规则）+ 买点标签（decision-rules#finishBuyBlock 收口）；
 *   ② 卖点计划（decision-rules#buildSellPlan，候选 = 昨日打过「买」标签的股票；
 *      「今天又进买点」用的是【本看板自己的买点名单】，保证本看板内部自洽）；
 *   ③ 说明文案（被排除的题材 / 不足两个题材）。
 *
 * ⛔ 卖点【不重新发明】：判据（占比门槛 / 跟龙 / 10分钟时卖 / 竞价涨停卖 / 持有）全在 buildSellPlan 里
 *    —— 用户原话「买入和卖出基本逻辑一样，只是选股不同」。
 *
 * @param {Array} topics   rankDecisionTopics(entries, MODE_VOL_RATIO) 的返回（已按平均竞价量比降序）
 * @param {Map} dragonMap  rankDragons(topics) 的返回【卖点侧用】（= 收盘口径，退潮 / 卖点逐字不变）
 * @param {{date?:string, ctx?:object, sellRows?:Array, ebbCtx?:object,
 *          buyDragonMap?:Map, pctMap?:Map, buySkipNames?:Set, prevEbbDay?:object,
 *          ebbHistory?:Array}} [opts]
 *        date     = 展示日（当前已由组合式调 decorateDecisionRows 统一装饰，这里只留作扩展位）
 *        ctx      = decision-collect#collectDecisionTopics(actionContext) 给的标记上下文
 *                   {prevDragonNames, prevBuyNames, prevBought, prevBoughtTopics, topicStreakPast}；
 *                   ⛔ 缺省 = 全部为 null ⇒ 持有 / 昨有买入 / N 次入选 / 先卖后买 / 补涨
 *                   一枚都不打（§10：未知 ≠ 没有），⛔ 绝不在这里用空集合顶替。
 *        sellRows = decision-collect 给的卖点候选行（缺省 ⇒ 不产卖点段）
 *        ebbCtx   = decision-collect#_ebbCtxOf 采好的【退潮日事实】（市场总龙 / 今日停牌 / 今日占比 /
 *                   同题材龙位成员 / 市场总龙二 / 买点侧替补与五只去留）；缺省 / ready=false ⇒ 退潮规则不生效（§10 不猜）
 *        ebbHistory = ★ [EBB-R20] 近 22 个交易日的退潮判定落库行（tvrb_ebb_days，组合式读回注入）——
 *                   「首次 / 二次确认 / 无第三次」的事件计数用；缺省 ⇒ 按 0 次事件（= 首次退潮）。
 *        ebbWindowFrom = ★ [EBB-20D 2026-10-22] 事件窗口起点（= 第 EBB_EVENT_WINDOW_DAYS 个交易日的日期）。
 *                   ⛔ 不能让规则层自己从 ebbHistory 里「取最后 20 行」来近似窗口：落库表按天写，
 *                   没开看板的日子没有行（实测 20 个交易日只有 7 行）⇒ 会数错事件数。
 *                   缺省 ⇒ 退回「按已有日期取最新 20 个」（§11 老调用方零行为变化）。
 *        coreTopics = ★★ [CORE-CAT 2026-10-22 用户口径] 核心词表（getCoreTopics() 的返回）——
 *                   规则层据此把细分题材归到【大类】（「文化传媒」⇒「AI应用」）。
 *                   缺省 / 空 ⇒ 归一是恒等（§11 零行为变化）。
 *        buyDragonMap = ★ [TVRB-926 2026-10-14 用户口径]【买点侧专用】的龙位名册（9:26 口径，
 *                   decision-rules#rankDragonsWithPctMap 的返回）；缺省 ⇒ 退回上面的 dragonMap
 *                   = 旧行为（§11 默认零行为变化）。
 *        pctMap   = ★ [TVRB-926]【买点侧专用】的 9:26 口径区间涨幅（readAuctionLegRangeMap 的返回），
 *                   行上「十日涨幅」取它；缺省 ⇒ 退回成员自带值 = 旧行为。
 *        buySkipNames = ★★ [SUSPEND-NOBUY 2026-10-14 用户口径] 买点侧的【买不进名单】
 *                   （= 连续停牌第 2 天及以上的票，decision-collect#nonFirstDaySuspendNames 的返回）；
 *                   命中者【买不进 ⇒ 占掉一个名额、不再补位】（与「竞价一字」的顺延补位刻意不同，
 *                   见 _buildBlock 的 [SUSPEND-OCCUPY 2026-10-15] 注释）。
 *                   ⛔ 缺省 / 空集 ⇒ 与旧行为逐字一致（§11）；停牌【首日】不在本名单里（仍可入选）。
 *        prevDate = ★ [EBB-D1 2026-10-21] 展示日的【上一交易日】（组合式用 getPreviousTradingDay
 *                   算好注入，§6 日期口径不进纯函数）—— 「昨日二次确认退潮 ⇒ 次日禁入买点侧」
 *                   （第二十六条）用它去 ebbHistory 里找昨日那一行；缺省 ⇒ 判不出 ⇒ 本规则不生效。
 *        prevPrevDate = ★ [SWITCH 2026-10-22] 展示日的【前两个交易日】—— 第二十八条「切换日」判据
 *                   （二次确认退潮正好发生在 D，今天 = D+2）；缺省 ⇒ 不判切换日。
 *        top5HistoryEver = ★ [SWITCH] 近 20 个交易日【上过 20日涨幅前五】的股票名集合
 *                   （data/range20-top5-history.js#everInTop5Set）；缺省 / null ⇒ 判不出「是否首次上榜」
 *                   ⇒ 切换日不收紧（并在说明里写明原因，§10）。
 *        top5HistoryDays = ★ [SWITCH] 历史榜实际覆盖的天数（只用于说明文案，⛔ 不参与判定）。
 *        range10Rows = ★★ [R10-BACKUP 2026-10-24 用户口径] 当日名单的十日涨幅池
 *                   （decision-collect#collectDecisionTopics 出口的 range10Rows：
 *                    `[{name, code, topic, pct, isYizi, aucPct}]`，pct = 该票当日十日涨幅，
 *                    isYizi = 该票【今日】是否竞价一字涨停 —— true/false/null(补位行判不出)）；
 *                    「十日涨幅前十 / 首次在列 / 与总龙一不同题材」的判定全在 range10-backup.js，
 *                    本文件只用它挑候补。缺省 ⇒ 判不出 ⇒ 候补不生效（§10，⛔ 不猜）。
 *        range10Presence = ★★ [R10-BACKUP] 十日窗口的在列次数 `{counts:Map<name,{cnt}>, coveredDays}`、
 *                   （data/auction-presence.js#getPresenceForDate(date, 10) 的返回）；
 *                   缺省 / coveredDays=0 ⇒ 判不出「首次 / 二次在列」⇒ 候补不生效（§10）。
 *        range20Auc = ★★ [TVRB-AUC-BOARD 2026-11-10] 该日【9:25 竞价口径】20 日榜的主板名次
 *                   （`topicvolratio/tvrb-auction-board.js` 的 rankMap：
 *                    `Map<股票名, {pct, days, rank}>`，与选股候选池【同一份榜】；
 *                    判不出时才回落到 range20-auction-leg#readAuctionLegRange20Rank）。
 *                   用途【只有一个】：买点侧【20日涨幅通道】的入选票（退潮替补 / 切换日新龙）
 *                   在说明区写出「9:26 那一刻的涨幅 + 第几名」（只列事实，⛔ 不解释）。
 *                   ⛔ 不参与选股；⛔ 不改 getRange20Leaders 的发布结果（20日涨幅 toggle / 决策看板
 *                   仍用收盘口径展示），但题材量比的【规则输入】已不读它。
 *                   缺省 / 判不出 ⇒ 一条说明都不写（§10 不猜名次；§11 零行为变化）。
 *        prevAuctionLeg10 = ★★ [ABNORMAL-10D 2026-11-13 用户口径] 上一交易日【9:26 竞价口径】的十日涨幅
 *                   （readAuctionLegRangeMap(prevDate) 的返回，`Map<股票名,{pct,days}>`）——
 *                   第三十四条「总龙一异动次日」的判据（用户原话「东方海洋，昨天竞价口径就超过100%了」）。
 *                   缺省 ⇒ 退回 prevRange10（收盘口径）并在文案里注明（§10 口径不许含糊）。
 *        prevRange10 = 上一交易日【收盘口径】的十日涨幅（readRangePctForDate(prevDate)）——
 *                   异动次日判定的退路 + 「昨日数值」的展示口径。
 * @returns {{topics:Array, blocks:Array, buy:object, sell:Array, excludedTopics:Array,
 *            notes:Array, pickCount:number, buyNames:Set<string>, cashAlert:object, ebb:object|null}}
 *   topics        —— 全部参与排名的题材（含被排除的），按排名，供说明 / 复核
 *   blocks        —— 入选的题材块（≤ TVRB_TOPIC_LIMIT 个），每个含 picks
 *   buy           —— 决策看板形状的买点计划（heavy / light / candidates / 三个兜底槽位）
 *                    ⚠️ 形状必须一致：通用装饰器（量比趋势 / 名次变化 / 封单额）按它遍历
 *                    ⚠️ 退潮首日已被 _applyEbbBuyRules 覆盖动作标签 ⇒ 每行只留【退潮不买】
 *   sell          —— buildSellPlan 的返回（题材分组）；退潮首日已被 _applyEbbSellRules 改写动作标签
 *   excludedTopics—— 因数量 < 4 只被排除的题材（仅统计「选够两个之前」遇到的那些）
 *   notes         —— 看板级说明（被排除题材汇总等）
 *   pickCount     —— 实际选出的股票总数
 *   buyNames      —— 买点名单（喂给 buildSellPlan 判「今天又进买点 ⇒ 持有」）
 *   cashAlert     —— ★ 空仓提醒（见 TVRB_CASH_ALERT_AVG_VR / buildCashAlert）；
 *                    ⛔ 只是【提醒文案】，不改变 blocks / picks 的任何内容
 *   ebb           —— ★ [EBB 2026-10-13] 退潮首日（detectEbbDay 的返回）；不是退潮日 ⇒ null
 */
export function buildTopicVolRatioPlan(topics, dragonMap, opts) {
  const o = opts || {};
  const ctx = o.ctx || {};
  const list = (topics || []).filter(function(b) { return b && b.topic; });
  // ★ [TVRB-926 2026-10-14] 买点侧专用的 9:26 口径输入（缺省 ⇒ 与卖点共用同一份 = 旧行为，§11）
  const buyDragonMap = (o.buyDragonMap instanceof Map && o.buyDragonMap.size > 0) ? o.buyDragonMap : dragonMap;
  const buyPctMap = (o.pctMap instanceof Map && o.pctMap.size > 0) ? o.pctMap : null;
  // ★★ [SUSPEND-NOBUY 2026-10-14 用户口径] 买点侧「买不进名单」= 【连续停牌第 2 天及以上】的票
  //   （= decision-collect#nonFirstDaySuspendNames(rows, date, prevDate) 的返回）。
  //   ⛔ 缺省 / 空集 ⇒ 与旧行为逐字一致（§11）；只影响买点侧选股（退潮 / 卖点不看它）。
  const buySkipNames = (o.buySkipNames instanceof Set && o.buySkipNames.size > 0) ? o.buySkipNames : null;
  const out = {
    topics: [],
    blocks: [],
    // 与 buildBuyPlan 的返回【同形状】（见 §6 注释）；三个兜底槽位恒为 null —— 结构契约保留
    // ★ [EBB-R8 2026-10-14] 多加一个 `ebbSecond` 槽位 = 退潮首日买点侧唯一那只【市场龙二】。
    //   为什么要放进 buy 里（而不是只看 out.ebbBuy）：decision-collect#_buyBlocksOf 是
    //   「遍历一个买点块」的唯一实现，四个装饰器（量比趋势 / 名次变化 / 封单额 / 停牌标记）
    //   都经它取块 —— 挂进这里，龙二那一行才会和其它买点行一样带上这些客观数据（§6）。
    buy: {
      heavy: null, light: null, candidates: [],
      noYizi: null, smallTopic: null, bigTopic: null, ebbSecond: null,
      // ★ [SWITCH 2026-10-22] 第二十八条：切换日的【新龙】那一行。与 ebbSecond 同一理由挂在
      //   买点对象里 —— decision-collect#_buyBlocksOf 是「遍历一个买点块」的唯一实现，
      //   四个装饰器（量比趋势 / 名次变化 / 封单额 / 停牌）都经它取块（§6）。
      newDragon: null,
      // ★★ [R10-BACKUP 2026-10-24] 第二十九条：十日涨幅 · 在列次数候补（题材量比太小 ⇒ 作废后替换的那一只）。
      //   同一理由挂在买点对象里（四个装饰器要遍历到它）。
      range10Backup: null,
      // ★★ [WEAK-HUDDLE 2026-10-27] 第三十条：弱势切抱团（退潮题材里唯一还能买的那只）。
      //   同一理由挂在买点对象里 —— decision-collect#_buyBlocksOf 是「遍历一个买点块」的唯一实现，
      //   四个装饰器（量比趋势 / 名次变化 / 封单额 / 停牌）都经它取块（§6）。
      weakHuddle: null,
      // ★★ [CATCH-UP 2026-10-27] 第三十一条：补涨题材（6~10 名里的连板票）。同一理由挂在这里。
      catchUp: null
    },
    sell: [],
    excludedTopics: [],
    notes: [],
    pickCount: 0,
    buyNames: new Set(),
    // ★ [CASH-ALERT 2026-10-13] 空仓提醒（判据见 buildCashAlert / TVRB_CASH_ALERT_AVG_VR）。
    //   未触发时用【同一份冻结常量】⇒ 引用稳定、不触发下游重算（§19）。
    cashAlert: TVRB_CASH_ALERT_NONE,
    // ★★ [ABNORMAL-10D 2026-11-13 用户口径] 第三十四条【监管异动 · 十日涨幅硬上限】的事实：
    //   `{show, kind, leaderName, leaderPctPrev/Text, leaderPctToday/Text, names, nearNames, ...}`
    //   —— 由 `_applyAbnormalSweep` 在【所有买点通道都建完之后】一次性算出并写回（见该函数注释）。
    //   未触发时用同一份冻结常量 ⇒ 引用稳定（§19）。
    abnormal: TVRB_ABNORMAL_NONE,
    // ★ [EBB 2026-10-13 第五轮] 退潮首日（判据见 detectEbbDay）；
    //   不是退潮日 ⇒ null（一个稳定的 null ⇒ 视图的 v-if / class 绑定不会反复抖动，§19）
    ebb: null,
    // ★ [EBB-R8 2026-10-14] 退潮首日【买点侧唯一那只】的常规买点块（单只票）。
    //   ⚠️ 它与 out.ebb 同步：不是退潮日 / 算不出龙二 ⇒ null。
    ebbBuy: null,
    // ★ [EBB-R20c 2026-10-20] 二次确认退潮 + 常规选出补涨题材 ⇒ 买点侧顶部的【节点说明】横幅。
    //   纯文案（判据与 ebbSecondRegular 同一把尺子，§6），只在「二次确认 ∧ blocks 非空」时非 null
    //   （首次退潮 / 二次走兜底 ⇒ null —— 那两种场景卖点横幅 + 灰化已经把状态说满了，不再叠一条）。
    ebbNodeNote: null,
    // ★ [DIVERGE 2026-10-20] 市场总龙一【首次分歧】日的分歧买点块（总龙一 + 跟随高标 ≤2 只）。
    //   只在「总龙首次分歧 ∧ 非退潮日」时非 null（其余场景 null ⇒ 视图 v-if 不渲染）。
    divergeBuy: null,
    // ★★ [WEAK-HUDDLE 2026-10-27 用户口径] 第三十条【弱势切抱团】买点块（20日涨幅主板前三 + 与退潮题材
    //   同题材 ⇒ 选出来放在最前面）。只在「空仓提醒命中 ∧ 非退潮首日 ∧ 非分歧日 ∧ 有票进前三」时非 null
    //   （其余场景 null ⇒ 视图 v-if 不渲染 ⇒ 今天就是纯空仓，与改造前一致，§11）。
    weakHuddle: null,
    // ★★ [CATCH-UP 2026-10-27 用户口径] 第三十一条【补涨题材】买点块（20日涨幅主板第 6~10 名里，
    //   该灰色题材恰好占 2~3 只，且其中有连板票 ⇒ 选连板票放在最前面）。
    //   只在「空仓提醒命中 ∧ 非退潮首日 ∧ 非分歧日 ∧ 数量恰好 2~3 ∧ 至少 1 只连板」时非 null。
    catchUp: null,
    // ★★ [LEADER-LIMITDOWN 2026-11-02 用户口径] 第三十二条【题材龙一竞价跌停 ⇒ 切抱团】的事实：
    //   `{topic, name, code, aucPct, aucPctText, count, avgText}` —— 由扫描循环在发现
    //   「排名第一的入选题材的龙一竞价跌停」时写下；没命中 ⇒ 恒为 null（§11 零行为变化）。
    //   ⚠️ 它只是【事实】，抱团那一行在 fOpts 就绪之后才由 _buildLeaderLimitDownHuddleBlock 造出来，
    //      并挂进 weakHuddle 槽位（同一段渲染通道、同一档配色，见该函数的注释）。
    leaderLimitDown: null,
    // ★★ [SWITCH 2026-10-22] 第二十八条【新龙 / 新题材切换日】：
    //   switchDay = 今天是不是「二次确认退潮」后的第 2 个交易日（判据见 detectSwitchDay）；
    //   newDragon = 那一行新龙的买点块（独立容器、渲染在灰化容器之外）；不是切换日 / 选不出 ⇒ null。
    switchDay: null,
    newDragon: null,
    // ★★ [R10-BACKUP 2026-10-24 用户口径] 第二十九条【十日涨幅 · 在列次数候补】那一行
    //   （独立容器、渲染在灰化容器之外：今天真要买的那一只不能被 grayscale 吞掉）；
    //   不需要候补 / 选不出 ⇒ null（视图 v-if 不渲染，§10 不拿空壳冒充结论）。
    range10Backup: null,
    // ★ [EBB-R8 2026-10-14] 【落库行】= 今天这只总龙到底算不算处在坏状态（不带首日闸门）。
    //   组合式据此 upsert 到 tvrb_ebb_days（⛔ 写库放 watch，computed 必须无副作用 §4）；
    //   次日读回那一行判「是不是首日」。§10：事实未就绪 ⇒ null（⛔ 绝不落一行猜的判定）。
    ebbDayRow: null
  };

  list.forEach(function(b) {
    out.topics.push({
      rank: b.rank,
      topic: b.topic,
      count: b.count,
      yiziCount: b.yiziCount,
      avgVolRatio: avgVolRatioOf(b)
    });
  });

  // ★★ [CORE-CAT 2026-10-22 用户口径] 题材【大类】归一函数 —— 只造一次，下面所有「同题材」判定共用。
  //   用户原话：「AI应用是大类，我在核心管理里把文化传媒放到那个大类了，那个大类就是我说的题材。」
  //   ⛔ 规则层不读 core_topics（§5）：o.coreTopics 由组合式用 getCoreTopics() 注入；
  //      缺省 ⇒ 归一函数退化为恒等 ⇒ 与本参数引入前逐字同行为（§11）。
  const coreRes = makeCoreTopicResolver(o.coreTopics);

  // ★ [EBB 2026-10-13 第五轮用户口径] 退潮日判定 —— 必须排在【题材入选扫描】之前：
  //   [EBB-R20b 2026-10-20 用户口径] 二次确认退潮的买点侧【先按常规选股、排除退潮题材本身】
  //   ⇒ 题材入选扫描需要先知道「退潮的是哪个题材」。它只读【事实】（谁是总龙 / 今天停不停牌 /
  //     占比多少 + 近 20 个交易日的退潮事件），不读 state、不发请求（事实由采集层 / 组合式注入）。
  // ★ [EBB-R8 2026-10-14] 第二个入参 = 【上一交易日落库的退潮判定】（tvrb_ebb_days 表里那一行）
  //   —— 昨日闸门用它；缺省（表不存在 / 那天没记录）⇒ 退化为「用昨日行情行推断」，再取不到按可触发。
  // ★ [EBB-R20 2026-10-20] 第三个入参 = 【近 22 个交易日的退潮判定落库行】——
  //   「首次 / 二次确认 / 无第三次」的事件计数用它；缺省 ⇒ 按 0 次事件（= 首次退潮）处理。
  // ★★ [CORE-CAT 2026-10-22 用户口径] 第四个入参 = 题材【大类】归一函数：
  //   判定说的「题材」= 核心管理里的【大类】（如「AI应用」），不是每日行上的细分串（如「文化传媒」）。

  // ── ①② 先判【切换日】，再决定「今天还判不判退潮」（★ 顺序不能反，见下）──────────────
  // ★★ [CYCLE 2026-10-22 用户口径] 【周期状态】—— 用户明确「引入周期状态：这天是切换日，不再判退潮」：
  //   D      = 二次确认退潮日（10-20）
  //   D+1    = 退潮次日 ⇒ 主轴题材禁买（第二十六条，10-21）
  //   D+2    = 【切换日】（10-22）⇒ 老周期结束、选新龙；**这一天不再判退潮**：
  //            · 总龙占比再不达标 / 再停牌也不重开退潮（否则老周期会被反复「续命」）；
  //            · 买点侧只走第二十八条（新龙 + 常规收紧一只），⛔ 不再走「退潮替补」。
  //   ⛔ 因此 detectEbbDay 必须在【已知今天是不是切换日】之后才决定要不要跑。
  out.switchDay = detectSwitchDay(o.ebbHistory || null, o.prevPrevDate || '', coreRes, o.ebbWindowFrom || '');

  // ══════════════════════════════════════════════════════════════════════════════════════
  // ★★ [LEADER-FIRST-TOPIC 2026-11-12 用户口径] 【老题材（大类）】的唯一出处 —— 必须紧随
  //   `detectSwitchDay` 之后定稿，排在所有消费点之前（§6：一条结论只有一个来源）。
  //
  // 用户原话（逐字）：「我都说了提到题材的时候要说大类，你说农业（老龙一 东方海洋），
  //   要考究东方海洋的大类，首先要确定它老龙一霸榜的题材是什么，从第一次霸榜总龙一开始，
  //   你检索下历史20个交易日，它第一次霸榜总龙一是不是在11月4日，当时20日涨幅竞价口径，
  //   羊字辈就有5只……确定是羊字辈的题材。你在11月12日看来，这个就是作为老题材。」
  //
  // ── 上一版错在哪 ──────────────────────────────────────────────────────────────
  //   直接拿【退潮日落库行】的 leader_topic 当老题材（11-10 ⇒ 「农业」，因为 东方海洋 的题材串
  //   「水产品,农业,东方,羊字辈」经核心词归一后 `水产品 → 农业`）⇒ 提示板写成
  //   「农业（老龙一 东方海洋）」。
  //   而真值 = 【羊字辈】：11-04 它第一次霸榜总龙一（竞价口径第 1 名 92.48%），那天前十里有
  //   5 只羊字辈（东方海洋 1 / 百洋股份 3 / 九阳股份 4 / 海洋王 5 / 阳光照明 7）。
  //
  // ── 本版 ─────────────────────────────────────────────────────────────────────
  //   · `o.oldLeaderTopic` = 组合式（`data/leader-rank-history.js` + `leader-first-topic.js`）
  //     回看近 20 个交易日算出的判定结果，本层**只读**、不重算、不发请求（§4 / §5）；
  //   · 判得出（ready=true）⇒ `oldTopic` = 首霸日那天的题材大类（已过核心词归一），
  //     并留痕 `oldTopicDate / oldTopicCount / oldTopicMembers / oldTopicLeaderDays`；
  //   · 判不出（没传 / 读失败 / 首霸日那天题材不足 2 只）⇒ 退回原来的落库题材，
  //     由 `oldTopicSource` 如实标注（§10：⛔ 不拿「判不出」冒充「没有」）。
  //   ⚠️ §11：老调用方 / 单测不传 `oldLeaderTopic` ⇒ `oldTopic` 与 `switchDay.topic` 逐字相同
  //      ⇒ 行为与本参数引入前完全一致。
  // ══════════════════════════════════════════════════════════════════════════════════════
  if (out.switchDay) {
    const lft = o.oldLeaderTopic || null;
    const lftReady = !!(lft && lft.ready && String(lft.topic || '').trim() &&
      String(lft.firstDate || '').trim());
    const ebbTopic = _normTopic(out.switchDay.topic, coreRes);
    out.switchDay.oldTopic = lftReady ? _normTopic(lft.topic, coreRes) : ebbTopic;
    out.switchDay.oldTopicRaw = lftReady ? String(lft.rawTopic || lft.topic || '').trim() : '';
    out.switchDay.oldTopicDate = lftReady ? String(lft.firstDate || '').trim() : '';
    out.switchDay.oldTopicCount = lftReady ? (Number(lft.count) || 0) : 0;
    out.switchDay.oldTopicMembers = lftReady && Array.isArray(lft.members)
      ? lft.members.map(function(m) { return { name: String(m.name || '').trim(), rank20: Number(m.rank20) || 0 }; })
      : [];
    out.switchDay.oldTopicLeaderDays = (lftReady && Number(lft.leaderDays) > 0) ? Number(lft.leaderDays) : null;
    out.switchDay.oldTopicTopPct = (lftReady && isFinite(Number(lft.topPct))) ? Number(lft.topPct) : null;
    out.switchDay.oldTopicDays = lftReady ? (Number(lft.days) || 0) : 0;
    out.switchDay.oldTopicSource = lftReady ? 'first-leader-day' : (lft ? 'fallback-' + String(lft.reason || 'unknown') : 'fallback-ebb-row');
    // 退潮那一行落库的题材（事实留痕）：判得出老题材时它与 oldTopic 可能不同（农业 vs 羊字辈），
    // 说明区要能解释「为什么印的不是这个」（§10 判定可追溯，⛔ 不静默改写历史事实）。
    out.switchDay.ebbTopic = ebbTopic;
  }
  out.ebb = out.switchDay
    ? null
    : detectEbbDay(o.ebbCtx || null, o.prevEbbDay || null, o.ebbHistory || null, coreRes, o.ebbWindowFrom || '');
  if (out.switchDay && o.ebbCtx && o.ebbCtx.ready) {
    // §10：把「今天为什么没有退潮判定」写清楚，⛔ 不能让人误以为「今天没退潮」
    // ★★ [LEADER-FIRST-TOPIC 2026-11-12] 题材一律写【老题材（大类）】而不是退潮行落库的那一段
    //   （用户原话：「我都说了提到题材的时候要说大类，你说农业（老龙一 东方海洋）」）。
    out.notes.push('ℹ️【第二十八条 · 周期状态】' + (out.switchDay.leaderName || '老龙一') + '（' +
      (_oldTopicNameOf(out.switchDay) || '—') + '）已于 ' + out.switchDay.ebbDate +
      ' 【二次确认退潮】⇒ 老周期结束；今天（第 2 个交易日）=【切换日】，按第二十八条选新龙，' +
      '今天【不再判退潮】（占比 / 停牌不再重开退潮事件）。' +
      // ★ [LEADER-FIRST-TOPIC] 用户要求「把判断的日期选股逻辑写进选股提示」⇒ 依据必须可见，
      //   ⛔ 不能只印一个题材名让人无法复核（§10 判定可追溯）。
      (_oldTopicBasisOf(out.switchDay) ? (' 老题材怎么定：' + _oldTopicBasisOf(out.switchDay) + '。') : ''));
  }
  // ★ [EBB-R20b 2026-10-20 用户口径] 二次确认退潮 ⇒ 买点侧【先按常规选股】（排除退潮题材本身）：
  //   用户原话：「二次确认退潮的时候，应该先看常规选股，就是按题材平均量比选股（注意是新题材，
  //   不是退潮那个题材，即使是退潮时这个题材还符合常规选股，但是毕竟它退潮了，所以不选这个题材），
  //   如果符合平均量比的新题材……就按照常规选股就行了。如果排名前二的新题材都没有符合条件，
  //   兜底就是选总市场的排名前面的龙，所以才回到20日涨幅选股法。」
  //   ⇒ 只有【二次确认】走这条路；【首次退潮】维持旧口径（主线第一次坏 ⇒ 整段灰化 + 退潮不买 + 替补）。
  const ebbSecondTopic = (out.ebb && out.ebb.phase === 'second')
    ? String(out.ebb.leaderTopic || '').trim() : '';

  // ── ★★ [R10-BACKUP 2026-10-24] 第二十九条的【前置判据】—— 必须在【选股扫描之前】就知道 ──
  //   为什么提前：扫描完成后要立刻决定「排名第二的题材是不是要整块作废」（用户拍板：整块删除、
  //   只出候补），而 `out.buy.heavy / light` 的槽位赋值就在扫描之后 —— 晚一步就会留下一个
  //   指向已删除块的悬空槽位（那会让四个装饰器遍历到幽灵块）。
  //   `ld` / `divergeActive` 原本在下面（空仓提醒之后），这里只是【读 opts】+ 一步判断，无副作用；
  //   原处改为复用这两个局部常量（值一模一样，§11 零行为变化）。
  const ld = o.leaderDiverge || null;
  const divergeActive = !!(ld && ld.todayFirst && !out.ebb);
  // 本规则【不生效】的三种场景（每一种都有更具体的规则接管，⛔ 不许两条规则同时输出买点）：
  //   ① 首次退潮 / 二次确认但常规选不出（blocks 为空）= 退潮兜底通道（第二十一条退潮替补接管）；
  //   ② 切换日（第二十八条：新龙 + 常规收紧一只）；
  //   ③ 总龙首次分歧日（第二十五条：总龙一 + 高标 ≤2 只）。
  const r10Blocked = !!(out.switchDay) || divergeActive || !!(out.ebb && out.ebb.phase !== 'second');
  // ★ 用户拍板「任何一天都生效」：不再限定二次确认退潮日 ⇒ 只要不落在上面三种场景里就算。
  const r10Enabled = !r10Blocked;
  // ★★ [R10-BACKUP] 候补的【两个输入】是否就绪（§10：缺一 ⇒ 判不出 ⇒ ⛔ 既不出候补、也不作废题材）。
  //   故意写成「同步可判的纯前置检查」（不看结果、不跑判定）：上面的题材作废要在扫描后立刻决定，
  //   而 pickRange10Backup 要等买点名单定型（排除重复票）才能跑 —— 两件事必须解耦。
  //   ⚠️ `r10PoolGiven` 单独留一格：调用方【根本没传】十日涨幅池（老调用方 / 单测）⇒ 一条说明都不加
  //      （§11 零行为变化）；传了但次数没到 ⇒ 才按「数据缺口」如实说明（§10 缺口必须可见）。
  const r10PoolGiven = Array.isArray(o.range10Rows);
  // 🔴🔴 [R10-POOL 2026-10-24 事故修复] 「池子是否与屏幕同一批行」。
  //   事故现场（10-23）：候选池只含当日名单、漏了「20天」补位票（屏幕第 3 行慈文传媒），
  //   ⇒ 名次整体前移一位 ⇒ 主板第 11 名的【上海九百】（屏幕上没有标签）被当成第 10 名顶了上来。
  //   ⇒ 采集层现在会把补位行并进池子，并用 range10PoolComplete 报告「补位数据到了没有」。
  //   ⚠️ 缺省（调用方没给这个键 = 老调用方 / 单测自己造的池子）⇒ 按【完整】处理，
  //      保证 §11 零行为变化；只有采集层明确说 false（补位数据未就绪）才拦。
  const r10PoolComplete = (o.range10Complete !== false);
  const r10DataReady = !!(r10PoolGiven && r10PoolComplete && o.range10Rows.length > 0 &&
    o.range10Presence && o.range10Presence.counts &&
    Number(o.range10Presence.coveredDays) > 0);
  // 被作废的题材（供候补的「不同题材」闸门 + 说明文案用）
  const r10WeakTopics = [];
  // 「整块作废」那一块里的票（名字 -> {topic, tag}）：块被删掉了，但它们仍可能是股票级候补的候选，
  // 说明文案要能交代「它来自刚被作废的那块」（⛔ 不代表它被禁买，只是要让判定可追溯）。
  const r10RemovedPicks = new Map();
  let r10RemovedSecond = null;   // 记录「第二题材因量比太小被整块删除」，供尾部的说明文案使用
  let r10SecondWeak = null;      // 记录「第二题材量比太小」这个事实（即使因数据缺口没删）
  let r10GapNoted = false;       // 「数据缺口已说明」旗子：同一件事只说一次（⛔ 不叠两条告警）
  // ★ [SMALL-TOPIC 2026-10-24 用户口径] 被【小题材收紧】弃掉的题材（排名第一、数量 4~6 只、
  //   当天十日涨幅前十一只都没有）⇒ 尾部不再报「当日只有 N 个题材满足条件」：
  //   那是「今天本来就没这个题材」的读法，与事实（有、但一只都没进前十）相反（§10 不许含糊）。
  //   ⚠️ 必须声明在【扫描循环之前】：循环里 `continue` 之前要给它赋值（下面那段是 TDZ 陷阱高发区）。
  let r10SmallDropped = null;
  // ★★ [R10-926 2026-10-24 用户口径] 十日涨幅池 → 【9:26 竞价口径】（★ 只算一次，三处共用：
  //   ① 本文后面「排名第二题材的龙一是否进前十」这道新闸门；② 第二十九条十日涨幅候补的选股；
  //   ③ 候补 / 闸门的说明文案里的「口径时间」）。
  //   ⚠️ §11：9:26 口径没读到（老调用方 / 单测不传 pctMap）⇒ _withAuctionLegPct 原样返回，
  //     等于退回收盘口径，行为与加这一段之前逐字节相同；文案会如实标注口径时间。
  const r10Rows926Res = _withAuctionLegPct(o.range10Rows || null, buyPctMap);
  const r10Base926 = r10Rows926Res.used;
  const r10BaseText = r10Base926 ? '9:26 竞价口径' : '收盘口径（9:26 口径未读到）';
  const r10Rank926 = _range10RankMapOf(r10Rows926Res.rows);
  // ★★ [DUAL-RANK 2026-10-24 用户口径] 同一份池子的【收盘口径】名次表 —— ⛔ 只喂文案，绝不参与判定。
  //   用途：① 候补行徽标 / 悬停 / 前十去留里并列「收盘口径第 N 名」；② 看板级「两套前十对照」。
  //   §11：调用方没传 9:26 口径（buyPctMap 缺省）⇒ 上面那份 = 原样池子 ⇒ 两张表逐项相同
  //        ⇒ _range10DualTopText 判「没有差异」⇒ 一个字都不出现（零噪声）。
  const r10RankClose = _range10RankMapOf(o.range10Rows || null);
  // ★★ [AUTO-PICK-TOP20 2026-11-14 用户口径] 20日涨幅榜的【口径文案】—— 只进说明文字，⛔ 不参与判定。
  //   选股用的池子恒为 `ebbCtx.topicPool`（= tvrb-auction-board 的 9:25 竞价口径榜，§6）。
  //   §10：竞价榜判不出时组合式会回落【收盘口径发布榜】并传 `range20AucReady === false`
  //        ⇒ 文案必须如实写成「收盘口径」，⛔ 不许默认冒充「竞价口径」。
  //   缺省（老调用方 / 单测不传）⇒ 按正常态「9:25 竞价口径」—— 此时 topicPool 通常也没注入 ⇒ 该口径不生效。
  const r20BaseText = (o.range20AucReady === false)
    ? '收盘口径发布榜（9:25 竞价榜未就绪）'
    : '9:25 竞价口径';


  // ★★ [SWITCH 2026-10-22 用户口径] 第二十八条【新龙 / 新题材切换日】—— 必须排在【选股扫描之前】：
  //   它决定本次扫描是否【收紧】（只选一个题材、只取一只）。
  //   时间轴：D = 二次确认退潮日（10-20）→ D+1 禁买主轴（第二十六条，10-21）→ D+2 = 切换日（10-22）。
  //   ⇒ 判据 = 「二次确认事件」正好落在【前两个交易日】（o.prevPrevDate）。
  //   ⛔ 复用 secondEbbTopicOfPrevDay（同一把尺子），⛔ 不另写一份「昨天是不是二次确认」的计数。
  //   ★ 切换日本身已在上面算过（out.switchDay），这里只负责「从候选里挑新龙」。
  let ndResult = null;          // pickNewDragon 的返回
  let ndJudgeFail = '';         // 判不出的原因（§10 必须可见）
  if (out.switchDay) {
    // ★ [NEW-DRAGON-08 2026-10-22] 候选 = 20日涨幅【前八】（用户「改用排名前八的」）；
    //   采集层把它算在 ebbCtx.newDragonPool 上（与 top5 同一份富化结果，只是多取 3 只）。
    //   ⚠️ 老调用方 / 单测只有 top5 ⇒ 退回 top5（§11 零行为变化，只是候选少几只）。
    const pool = (o.ebbCtx && Array.isArray(o.ebbCtx.newDragonPool) && o.ebbCtx.newDragonPool.length > 0)
      ? o.ebbCtx.newDragonPool
      : ((o.ebbCtx && Array.isArray(o.ebbCtx.top5)) ? o.ebbCtx.top5 : []);
    const ever = (o.top5HistoryEver instanceof Set) ? o.top5HistoryEver : null;
    const winDays = Number(o.top5HistoryDays) || 0;
    if (pool.length === 0) {
      ndJudgeFail = '20日涨幅前八未就绪（数据未到）⇒ 新龙判定不生效';
    } else if (!ever) {
      // ⛔ 历史榜读不到 ⇒ 无法回答「今天是不是首次上榜」⇒ 判不出（⛔ 绝不把「没数据」当「首次」）
      ndJudgeFail = '20日涨幅历史榜未读到 ⇒ 无法判定「今天是否首次上榜」⇒ 新龙判定不生效';
    } else {
      // ★★ [NEW-DRAGON-FAMILY-OLD 2026-11-12 用户口径] 「正在退潮的老题材」清单
      //   = ① 【老题材（大类）】—— ★ [LEADER-FIRST-TOPIC] 现在取「第一次霸榜总龙一那天」
      //        算出来的那段（东方海洋 ⇒ 羊字辈），⛔ 不再是退潮行落库的那一段（那是「农业」）。
      //        判不出首霸日 ⇒ `oldTopic` 逐字回落成落库题材（= 上一版行为，§11）。
      //     ② 老龙一自己题材串里的【字辈线】（东方海洋 ⇒「羊字辈」）
      //   ⇒ 新题材候选里直接排除它们（用户：「退潮的是羊字辈，新题材的是东方，你搞混了吧？」）
      // ⚠️ 判得出首霸日时【不再】把落库那段（农业）也塞进来：那只是「水产品 → 农业」这条
      //   核心词归一的产物，不是老周期另立的一条线；塞进来会把真正的新【农业】题材一起排掉。
      const oldTopics = (function() {
        const arr = [];
        const push = function(v) { const s = String(v || '').trim(); if (s && arr.indexOf(s) < 0) arr.push(s); };
        push(_oldTopicNameOf(out.switchDay));
        const oldLeader = String(out.switchDay.leaderName || '').trim();
        if (oldLeader) {
          const src = (o.ebbCtx && Array.isArray(o.ebbCtx.topicPool)) ? o.ebbCtx.topicPool : pool;
          const row = (src || []).filter(function(c) { return String((c && c.name) || '').trim() === oldLeader; })[0];
          if (row) splitTopicSegs(row.topic).filter(isLineageTopic).forEach(push);
        }
        return arr;
      })();
      ndResult = pickNewDragon(pool, ever, {
        // ★ [LEADER-FIRST-TOPIC 2026-11-12] 提示板上那句「X（老龙一 东方海洋）」的 X = 老题材（大类）
        oldTopic: _oldTopicNameOf(out.switchDay),
        oldLeaderName: out.switchDay.leaderName,
        windowDays: winDays,
        coreRes: coreRes,
        // ★★ [NEW-DRAGON-FAMILY 2026-11-12] 新题材判定用【前十】（= 20日涨幅 toggle 上那份名单，
        //   采集层 ebbCtx.topicPool 已是「9:25 竞价口径 + market_metrics(scope=auction) 白名单」的富化结果）。
        //   缺省 ⇒ 退回候选池（老调用方/单测零行为变化，§11）。
        topicPool10: (o.ebbCtx && Array.isArray(o.ebbCtx.topicPool)) ? o.ebbCtx.topicPool : null,
        // ★ [NEW-DRAGON-FAMILY-OLD] 退潮中的老题材（候选组里排除）
        oldTopics: oldTopics
      });
    }
  }
  const switchNewDragon = !!(ndResult && ndResult.pick);
  // 收紧只在【新龙成立】时生效（用户口径「如果看20日涨幅没有符合条件……接下来就是常规班选股了，不做限制」）
  // ★ [CYCLE 2026-10-22] 切换日【本身】也收紧：用户原话「10月22日 = 选新龙头 + 常规只选排名第一的
  //   入选题材（只选最前面那个）」。判不出新龙时老周期也已结束 ⇒ 不能退回到「取两个题材」。
  const topicLimit = (switchNewDragon || out.switchDay) ? 1 : TVRB_TOPIC_LIMIT;
  const ndTopic = switchNewDragon ? _normTopic(ndResult.pick.topic, coreRes) : '';
  const ndName = switchNewDragon ? String(ndResult.pick.name || '').trim() : '';

  // 沿题材排名（平均竞价量比降序）往下扫：数量不足的排除并顺延，直到选够 topicLimit 个。
  for (let i = 0; i < list.length; i++) {
    if (out.blocks.length >= topicLimit) break;
    const b = list[i];
    // ★ [EBB-R20b] 二次确认退潮 ⇒ 退潮那个题材【不参与买点入选】—— 题材排名照旧（它还在
    //   out.topics 排名里），只是入选扫描在这里跳过它并顺延到下一个题材（与「数量不足顺延」同路径）。
    //   ⛔ 用户原话「即使是退潮时这个题材还符合常规选股，但是毕竟它退潮了，所以不选这个题材」。
    //   ★ [CORE-CAT 2026-10-22] 改走 _sameTopicLoose（大类归一）：块上是细分串「文化传媒」，
    //     退潮行上是大类「AI应用」⇒ 逐字相等判不出来，必须按大类认亲。
    if (ebbSecondTopic && _sameTopicLoose(b.topic, ebbSecondTopic, coreRes)) {
      out.notes.push('⚠️【' + out.ebb.phaseTitle + '】题材【' + b.topic +
        '】今天【不参与买点选股】（退潮题材不买），买点侧从其余题材按常规（平均竞价量比）顺延选股。');
      continue;
    }
    // ★★ [SWITCH 2026-10-22] 切换日：退潮的【老题材】与新龙自己的题材都不进常规扫描
    //   （老周期已结束不买；新龙题材避免同一题材出两只 —— 今日买点侧 = 新龙 + 另一个新题材各一只）。
    //   ★ [CYCLE 2026-10-22] 判不出新龙时（switchNewDragon=false）这条【老题材排除】也必须生效：
    //     老周期已结束，⛔ 不能因为「新龙没选出来」就把退潮题材重新放进买点侧。
    if (out.switchDay) {
      const bt = String(b.topic || '').trim();
      // ★ [LEADER-FIRST-TOPIC 2026-11-12] 老题材（大类）已由 `_oldTopicNameOf` 归一过，
      //   ⛔ 不再现场 `_normTopic(switchDay.topic)`（那是落库的那一段，可能与老题材不同）。
      const oldTopic = _oldTopicNameOf(out.switchDay);
      if (oldTopic && _sameTopicLoose(bt, oldTopic, coreRes)) {
        out.notes.push('⚠️【第二十八条 · 切换日】题材【' + b.topic +
          '】= 老周期（' + oldTopic + ' 二次确认退潮）⇒ 今天不参与常规选股。');
        continue;
      }
      if (ndTopic && _sameTopicLoose(bt, ndTopic, coreRes)) {
        out.notes.push('⚠️【第二十八条 · 切换日】题材【' + b.topic +
          '】= 新龙【' + ndName + '】所在题材 ⇒ 已由新龙那一行买入，常规侧不再重复选。');
        continue;
      }
    }
    let tier = resolveTvrbTier(b.count);
    if (tier.tier === 'none') {
      out.excludedTopics.push({
        rank: b.rank, topic: b.topic, count: b.count, avgVolRatio: avgVolRatioOf(b)
      });
      continue;
    }
    // ★ [SWITCH] 切换日收紧：本题材只取【一只】（龙位最前、非一字、非连续停牌 —— 取票逻辑不变）
    if (out.switchDay) {
      tier = Object.assign({}, tier, { pickCount: 1 });
    }
    // ══ ★★ [LEADER-LIMITDOWN 2026-11-02 用户口径] 第三十二条：题材龙一竞价跌停 ⇒ 本题材不选 ══
    //
    // 用户原话（逐字，见 TOPIC_LEADER_LIMITDOWN_RULE_NO 的长注释）：
    //   「排名第一的题材，不管有多少只，题材内龙一如果跌停，就不要选，要从20日涨幅里选市场总龙一，
    //    弱势切抱团，题材内的龙一都跌停了，说明弱势了，就要切抱团……所以今天题材量比选的应该是九阳股份。」
    //
    // 三个前置：
    //   ① `out.blocks.length === 0` ⇒ 只看【排名第一的入选题材】（用户口径点明「排名第一」）；
    //   ② `r10Enabled`             ⇒ 只在【常规语境】生效：退潮首日 / 切换日 / 总龙首次分歧日
    //      各有专属规则接管买点侧（§6 不叠加）；
    //   ③ `!out.leaderLimitDown`   ⇒ 只判一次（第一块就命中之后不再重复）。
    // ⚠️ 本条【不带只数门槛】（用户「不管有多少只」）—— 与第三十条的 4~6 只收紧、
    //   第三十一条的 2~3 只门槛是三条不同的规则，⛔ 别把只数条件抄进来。
    // ⚠️ 龙一 = `_dragonCandidates` 序列的第一只（买点侧官方龙位名册的第 1 名，§6 不另排序）。
    // ⛔ 这里只【记事实】+ 写看板级说明；「块内票改成不买」与「造抱团那一行」都排在
    //   finishBuyBlock / fOpts 之后（那一步之后才能算客观数据与原始买点信号）。
    if (out.blocks.length === 0 && r10Enabled && !out.leaderLimitDown) {
      const ldCands = _dragonCandidates(b, buyDragonMap, buyPctMap);
      const ldLead = ldCands.length > 0 ? ldCands[0] : null;
      // §10：竞价涨幅读不到（aucPct = null）⇒ getAuctionLimitState 返回 null ⇒ 判不出 ⇒
      //   本条不生效（⛔ 绝不把「没数据」当成跌停，也绝不当成没跌停去写说明）
      const ldState = ldLead ? getAuctionLimitState(ldLead.aucPct, ldLead.code, ldLead.name) : null;
      if (ldLead && ldState === 'down') {
        out.leaderLimitDown = {
          topic: String(b.topic || ''),
          name: String(ldLead.name).trim(),
          code: String(ldLead.code || '').trim(),
          rank: ldLead.rank,
          aucPct: ldLead.aucPct,
          aucPctText: _pct2(ldLead.aucPct),
          count: b.count,
          avgText: formatAvgVolRatio(avgVolRatioOf(b))
        };
        out.notes.push('⚠️【第' + TOPIC_LEADER_LIMITDOWN_RULE_NO + '条 · 弱势切抱团】排名第一的入选题材【' +
          out.leaderLimitDown.topic + '】（' + b.count + ' 只，平均竞价量比 ' +
          out.leaderLimitDown.avgText + '）的龙一【' + out.leaderLimitDown.name + '】9:25 竞价涨幅 ' +
          out.leaderLimitDown.aucPctText + ' = 【竞价跌停】⇒ 题材内最强的那只都被摁在跌停板上，' +
          '说明这个题材今天已经【弱势】（也根本买不进）⇒ 本题材今天【不选股】' +
          '（块内每只票的动作标签一律【' + TOPIC_LEADER_LIMITDOWN_NO_BUY_TAG + '】），' +
          '买点侧改为【从 20日涨幅里取市场总龙一】的【弱势切抱团】（抱团最强的市场龙头，竞价口径）。');
      }
    }
    // ══ ★★ [SMALL-TOPIC 2026-10-24 用户口径] 排名第一 + 数量 4~6 只 ⇒ 收紧：只买【最强的】 ══
    //
    // 用户原话（逐字，见 TVRB_SMALL_TOPIC_MAX 的注释）：
    //   「遇到入选排名第一的题材数量在4-6只时（不是4-8只，那只是入选股票数量1只条件，我说的这个是
    //     选票范围），条件要苛刻些。如果排名第一的题材数量4-6只，要看10日涨幅，看有没有同题材票
    //     进入前10，如果有就选最靠前那一只，如果没有，就弃掉了。」
    //   「因为这种数量少的，次日能存活下来的顶多有一只。所以就买最强的。要收紧下。」
    //
    // 三个前置（缺一 ⇒ 本条不生效，⛔ 绝不「拿没数据当没进前十」去弃题材）：
    //   ① `out.blocks.length === 0` ⇒ 只在【排名第一】这个块上生效（用户口径点明「排名第一」）；
    //   ② `r10Enabled`              ⇒ 退潮日 / 切换日 / 总龙首次分歧日各有专属规则接管（§6 不叠加）；
    //   ③ `r10PoolGiven`            ⇒ 调用方没传十日涨幅池（老调用方 / 单测）⇒ 整段跳过（§11 零行为变化）。
    //   另：`r10PoolComplete === false`（20 天补位行未就绪 ⇒ 名次会整体错位）⇒ 判不出 ⇒ 只写「未校验」。
    //
    // 三种结果（与第二十九条 / 第二道闸门同一把尺子）：
    //   · 判不出（no-pool / no-row）⇒ 【不弃题材】，照旧按龙位取票 + 说明「未校验」；
    //   · 一只都没进前十（judge='' 且 hits 为空）⇒ **弃掉该题材**（不入选、扫描继续往下顺延），
    //     并把「为什么弃」写成一条看板级说明（§10 缺口 / 否定都必须可见）；
    //   · 有票进前十 ⇒ 只在这几只里取票（前十之外的龙位⛔ 不再补位），顺序仍是【龙位升序】。
    //
    // ★★ 为什么「顺序仍用龙位」而不是「市场名次升序」（这是本条最容易做错的地方）：
    //   用户说的「最靠前」，比较的是【同题材那两只之间】（原话：「新能源汽车有两只入选襄阳轴承和
    //   江淮汽车，前者十日涨幅更加靠前，所以选襄阳轴承」）⇒ 「最靠前」= 组内十日涨幅最高 = 龙位第一，
    //   ⛔ 不是「全市场名次更小」。
    //   两者在数据自洽时【完全等价】（龙位就是按十日涨幅降序发的）；只有龙位名册与十日涨幅池
    //   来自不同口径（某只票 9:26 值缺 ⇒ 各自退回不同数值）时才会出现分歧 ——
    //   那一刻以【买点侧官方龙位名册】为准（§6：买点侧只有这一份名册），⛔ 不让同一只票在
    //   「题材通道」与「龙位」两处得出相反的「谁更强」。
    //   附带好处：10-23 工业4.0（4 只、兆威机电）这个用户已认可的线上结果【一个字节都没变】。
    let smallOpt = null;
    let smallTrace = null;
    // ★★ [LEADER-LIMITDOWN 2026-11-02] 第三十二条已成立（本题材龙一竞价跌停 ⇒ 整块不买）⇒
    //   小题材收紧【不再跑】：它做的是「在前十里挑最强的，一只都没有就弃掉该题材」，
    //   而本题材已经被否掉、买点侧改走抱团 —— 再算一遍既没有意义，还可能把这一块
    //   `continue` 掉，让扫描顺延到排名第二的题材（那正是第三十二条明令不许的）。
    if (out.blocks.length === 0 && r10Enabled && r10PoolGiven && !out.leaderLimitDown &&
        tier.tier === 'mid' && b.count >= TVRB_MIN_COUNT && b.count <= TVRB_SMALL_TOPIC_MAX) {
      const smallCountText = '本题材数量 ' + b.count + ' 只（落在 ' + TVRB_MIN_COUNT + '~' +
        TVRB_SMALL_TOPIC_MAX + ' 只的收紧档）';
      // §10：否掉一个题材必须点名（屏幕上有好几个题材时，不带名字的告警等于没说）
      const smallTopicText = '题材【' + String(b.topic || '—') + '】' + smallCountText;
      const probe = r10PoolComplete
        ? _topicTop10Hits(b, r10Rank926)
        : { judge: 'no-pool', hits: [], seen: 0 };
      if (probe.judge === 'no-pool' || probe.judge === 'no-row') {
        out.notes.push('⚠️【小题材收紧 · 未校验】' + smallTopicText +
          '，本该核对「当天十日涨幅〔' + r10BaseText + '〕前十里有没有本题材的票」，但' +
          (probe.judge === 'no-pool'
            ? ('十日涨幅名单' + (r10PoolComplete ? '为空' : '的 20 天补位行还没就绪（名次会整体错位）'))
            : '本题材的票一只都不在十日涨幅名单里') +
          ' ⇒ 判不出 ⇒ 本条【本次不生效】，照旧按龙位取票；数据到货后自动重判。');
      } else if (probe.hits.length === 0) {
        // ★ 弃掉：用户口径「如果没有，就弃掉了」
        r10SmallDropped = { topic: String(b.topic || ''), count: b.count };
        out.notes.push('⛔【小题材收紧 · 本题材不入选】' + smallTopicText +
          '，且【当天十日涨幅〔' + r10BaseText + '〕前十没有一只本题材的票】⇒ 放弃该题材' +
          '（连前十都进不去 = 没有启动性；这种数量少的题材次日能存活下来的顶多有一只，' +
          '不是最强的那只就不买）。买点侧从其余题材按平均竞价量比继续顺延选股。');
        continue;
      } else {
        // ★ 有票进前十 ⇒ 候选序列只保留【前十里的那几只】，顺序照旧（龙位升序 = 组内十日涨幅降序）
        const hitRank = new Map();
        probe.hits.forEach(function(h) { hitRank.set(h.name, h.rank); });
        const order = _dragonCandidates(b, buyDragonMap, buyPctMap).filter(function(c) {
          return hitRank.has(String(c.name).trim());
        });
        if (order.length === 0) {
          // 池子里有名次、龙位名册里却没有（pct 缺值 / 非主板）⇒ 数据对不上 ⇒ 判不出，退回原顺序
          out.notes.push('⚠️【小题材收紧 · 未校验】' + smallTopicText +
            '，十日涨幅名单里本题材有票进了前十，但【龙位名册里没有它们】（十日涨幅缺值）⇒ ' +
            '本次退回按龙位取票；数据补齐后自动重判。');
        } else {
          smallOpt = { order: order, smallTopic: true, baseText: r10BaseText };
          smallTrace = order.map(function(c) {
            return { name: c.name, pct: c.pct, rank: hitRank.get(String(c.name).trim()) };
          });
        }
      }
    }
    // ★★ [AUTO-PICK-TOP20 2026-11-14 用户口径] big 档（> 8 只）改用「同题材 20日涨幅前十最靠前两只」：
    //   池子 = 采集层 `ebbCtx.topicPool`（恒 9:25 竞价口径的 20日涨幅前十，见 tvrb-auction-board.js）。
    //   ⛔ 池子没注入（老调用方 / 单测 / 采集层没给）⇒ 连这个 opt 都不构造 ⇒ 规则层逐字退回
    //   「龙位顺延」旧口径、一条说明都不加（§11 零行为变化）。
    const bigPool = (o.ebbCtx && Array.isArray(o.ebbCtx.topicPool)) ? o.ebbCtx.topicPool : null;
    const bigOpt = (tier.tier === 'big' && !smallOpt && Array.isArray(bigPool)) ? {
      topicPool: bigPool,
      coreRes: coreRes,
      top20Text: r20BaseText
    } : null;
    const blk = _buildBlock(b, buyDragonMap, tier, buyPctMap, buySkipNames, smallOpt || bigOpt);
    out.blocks.push(blk);
    // ★ 收紧档：把「本题材有哪几只进了前十、最后买了最强的那只」写成事实（用户要能逐只核对）
    if (smallTrace) {
      const hitText = smallTrace.map(function(h) {
        return '第 ' + h.rank + ' 名 ' + h.name + ' ' + _pct2(h.pct);
      }).join('；');
      const got = (blk.picks || []).map(function(p) { return String(p.name || '').trim(); })
        .filter(Boolean).join('、');
      blk.notes.push('★【小题材收紧 · 判定可追溯】当日十日涨幅〔' + r10BaseText + '〕前十里有本题材的票 ' +
        smallTrace.length + ' 只：' + hitText + '（按龙位从高到低）⇒ 只在这个范围里取【最强】的那一只' +
        (got ? '：' + got : '（都在竞价一字 / 连续停牌，实际 0 只 —— 不从前十之外补位）') + '。');
    }
    // ★★ [TVRB-926-DRIFT 2026-10-24 用户口径] 「早上 9:26 龙位」与「收盘龙位」不一致时，
    //   在本题材的说明区讲清「为什么收盘回看时不选那只看似更靠前的票」——
    //   只在【真的不一致】时追加一条，口径一致时一个字都不写（§11 零行为变化）。
    _appendDragonDriftNote(out.blocks[out.blocks.length - 1], dragonMap, !!smallOpt);
    // ★★ [LEADER-LIMITDOWN 2026-11-02 用户口径] 第三十二条一旦成立 ⇒ 买点侧就【只有抱团那一只】：
    //   用户对这次的情形只给了一个答案 ——「选的应该是九阳股份」⇒ ⛔ 不继续顺延到排名第二、第三的题材
    //   （那个题材的龙一都已跌停，往下的题材只会更弱；再选一个就成了「买两只」，与口径不符）。
    //   ⚠️ 被否的这个题材块【照常留在 out.blocks 里】（块内票标签已由 _applyLeaderLimitDownNoBuy
    //     改成【龙一跌停不买】）：题材结论与股票结论是两件事，用户要能核对「为什么今天不选它」。
    if (out.leaderLimitDown) break;
  }

  // 决策看板形状的买点计划：第 1 块 → heavy、第 2 块 → light（本看板最多两块，candidates 恒空）
  out.blocks.forEach(function(b, i) {
    if (i === 0) out.buy.heavy = b;
    else if (i === 1) out.buy.light = b;
    else out.buy.candidates.push(b);
  });

  // ── ★★ [TOPIC-CASCADE 2026-10-28 用户口径] 第二题材整条线的【总前提】：
  //    排名第一的入选题材自己必须过平均量比门槛 ──────────────────────────────────────────
  //   用户原话（2026-10-28，逐字）：
  //     「工业4.0 排名入选的第二题材没错，但是要看排名第一的题材条件，排名第一的题材平均量比当天
  //       就不符合，就不用10日候选了。我之前的意思是排名第一的题材要平均量比符合，整体不算差，
  //       但是排名第二的题材不符合，这时才考虑用十日涨幅那个条件候补排名第二的。
  //       现在排名第一的题材都不符合条件，所以就不考虑排名第二的了。」
  //
  //   ⇒ 十日涨幅候补（第二十九条）与「第二题材龙一进前十」（第二道闸门）都是【修补第二题材】的手段，
  //     它们的前提是「最强题材整体不算差」。第一题材自己都 < 25 ⇒ 当天已经进入退潮/空仓语境
  //     （空仓提醒命中），此时再拿十日涨幅去补一个更弱的第二题材，等于在退潮日凭空造出可买标的
  //     —— 10-28 实盘就是这样：大消费 21.17 ＜ 25（空仓提醒命中），第二题材工业4.0 14.59 被整块
  //     作废后补出【杰克科技】，用户明确否掉这一行。
  //
  //   ⛔ 「不考虑第二题材」= 第二块直接不入选（不是「不顺延」）：
  //      用户口径只有「排名第一的那个题材」，第 2 个槽位空着。
  //   ⚠️ 只在本规则的常规语境下生效（`r10Enabled`）—— 退潮首日 / 切换日 / 总龙首次分歧日各有专属
  //      规则接管，⛔ 不叠加（§6）。
  //   ⚠️ §10：平均量比读不出来（null）⇒【判不出】⇒ 保持原规则，
  //      ⛔ 绝不把「没数据」当成「不达标」去砍掉一个题材。
  let firstTopicGate = null;   // 记录「第一题材不达标 ⇒ 第二题材整条线未启用」，供说明区留痕
  if (r10Enabled && out.blocks.length >= 2) {
    const fb = out.blocks[0];
    const fbAvg = avgVolRatioOf(fb && fb.block);
    if (fbAvg !== null && fbAvg < TVRB_CASH_ALERT_AVG_VR) {
      firstTopicGate = {
        topic: String((fb && fb.block && fb.block.topic) || ''),
        avgText: formatAvgVolRatio(fbAvg),
        droppedTopic: String((out.blocks[1] && out.blocks[1].block && out.blocks[1].block.topic) || '')
      };
      // ⚠️ 槽位必须一起重建（§6 唯一实现：_dropSecondBlockSlot）
      _dropSecondBlockSlot(out);
      out.notes.push('⚠️【排名第二题材的整体前提】排名第一的入选题材【' + firstTopicGate.topic +
        '】平均竞价量比 ' + firstTopicGate.avgText + ' ＜ ' + TVRB_CASH_ALERT_AVG_VR +
        ' ⇒ 最强的题材自己就不达标（整体已经算差），按口径【不再考虑排名第二的题材】：' +
        '排名第二的【' + firstTopicGate.droppedTopic + '】既不列入买点侧、也不作废换票，' +
        '【十日涨幅候补本次不启用】。本日买点侧只看排名第一的题材【' + firstTopicGate.topic + '】。');
    }
  }

  // ── ★★ [R10-BACKUP 2026-10-24 用户口径] 第二十九条 · 第一段：排名【第二】的题材量比太小 ⇒ 整块作废 ──
  //   用户原话：「排名第二的题材如果量比太小就用十日涨幅首次在列进行候补……题材量比太小禁止选入」
  //           + AskUserQuestion「整块删除，只出候补」。
  //   判据 = 该题材平均竞价量比 < TVRB_CASH_ALERT_AVG_VR（与空仓提醒【同一个门槛常量】，§6 不另立数字）。
  //   §10 两条硬约束（缺一不可，⛔ 否则会「拿没数据当成量比低」把整个题材误作废）：
  //     ① 平均量比读不出来（null）⇒ 【不作废】（未知 ≠ 量比低）；
  //     ② 候补的两个输入（十日涨幅池 + 在列次数）没就绪 ⇒ 【不作废】—— 作废了却给不出替换票，
  //        等于因为一次数据缺口白扔掉一个题材还宣布空仓；此时保持原规则并在说明区写明「判不出」。
  //   ⚠️ 删除后必须重建 heavy / light 槽位：否则 buy.light 还挂着一个已删除的块，
  //      四个装饰器会遍历到幽灵块（那是「静默多渲染一段」的最短路径）。
  if (!r10Blocked && out.blocks.length >= 2) {
    const secondBlk = out.blocks[1];
    const secondAvg = avgVolRatioOf(secondBlk && secondBlk.block);
    if (secondAvg !== null && secondAvg < TVRB_CASH_ALERT_AVG_VR) {
      const weakInfo = {
        topic: String((secondBlk && secondBlk.block && secondBlk.block.topic) || ''),
        avgVolRatio: secondAvg,
        avgText: formatAvgVolRatio(secondAvg)
      };
      r10SecondWeak = weakInfo;
      if (!r10DataReady) {
        // §10：数据缺口必须可见 —— 但只在「调用方确实给了池子」时提示（老调用方 / 单测不传 ⇒ 零打扰）
        if (r10PoolGiven) {
          r10GapNoted = true;
          // ★ [R10-POOL 2026-10-24] 缺口有两种，文案必须分开说：
          //   · 补位行没到 ⇒ 名次这把尺子整体错位（10-23 上海九百 事故的直接原因）；
          //   · 在列次数没到 ⇒ 分不出「首次 / 二次在列」。
          //   ⛔ 合写成一句「十日涨幅池 / 在列次数还没读到」等于把根因藏起来，用户没法判断要不要等。
          const r10GapWhy = !r10PoolComplete
            ? '十日涨幅榜的【20 天补位行】还没就绪（候选池与屏幕上那十行对不上，名次会整体错位）'
            : '【十日窗口在列次数】还没读到';
          out.notes.push('⚠️【第' + RANGE10_BACKUP_RULE_NO + '条 · 题材量比太小】排名第二的入选题材【' +
            weakInfo.topic + '】平均竞价量比 ' + weakInfo.avgText + ' ＜ ' + TVRB_CASH_ALERT_AVG_VR +
            '，本该禁止选入；但' + r10GapWhy + ' ⇒ 判不出候补票，' +
            '本次【暂不作废】该题材（保持原规则照常列出）。数据到货后会自动重判（§10：判不出 ≠ 作废）。');
        }
      } else {
        r10RemovedSecond = weakInfo;
        r10WeakTopics.push({
          topic: weakInfo.topic,
          avgText: weakInfo.avgText,
          reasonText: '排名第二的入选题材，题材量比太小 ⇒ 禁止选入（整块作废）'
        });
        // ★ [R10-STOCK-LEVEL 2026-10-24] 记下这一块里的票：块会被整块删除，但【股票级通道】的候补
        //   有可能正好选中其中一只（题材不选 ≠ 这只票不能被选）⇒ 说明文案要能讲清它的来历。
        (secondBlk.picks || []).forEach(function(p) {
          if (p && p.name) {
            const nm = String(p.name).trim();
            if (!r10RemovedPicks.has(nm)) {
              r10RemovedPicks.set(nm, { topic: weakInfo.topic, tag: '整块作废' });
            }
          }
        });
        // ⚠️ 槽位必须一起重建（§6 唯一实现：_dropSecondBlockSlot）
        _dropSecondBlockSlot(out);
        out.notes.push('⚠️【第' + RANGE10_BACKUP_RULE_NO + '条 · 题材量比太小】排名第二的入选题材【' +
          weakInfo.topic + '】平均竞价量比 ' + weakInfo.avgText + ' ＜ ' +
          TVRB_CASH_ALERT_AVG_VR + ' ⇒ 该题材【禁止选入】（已整块作废，不列股票），' +
          '改用【十日涨幅前十 + 首次在列】的主板新面孔候补。');
      }
    }
  }

  // ── ★★ [SECOND-LEADER-10 2026-10-24 用户口径] 第二道闸门：排名第二的入选题材，
  //    它的【龙一】必须进入当天十日涨幅前十（9:26 竞价口径）──────────────────────────────
  //   用户原话：「排名第二的题材规则，还需要完善下，添加规则，这个题材的龙一是否进入当天的
  //     10日涨幅前十？如果没进入，也不能选，只选排名第一的那个题材股票」
  //   「排名第二题材入选规则是，平均量比符合，题材龙一进入当天十日涨幅前十（竞价口径），
  //     只有满足这个条件。才能入选买点侧。」
  //   「连它的龙一都没有进入当天的十日涨幅，说明没有带动性，后续基本上涨概率不大，风险很高。」
  //
  //   为什么是【必要条件】（⛔ 不许有人改成「判不出就放行」）：用户给的判据是「没有带动性 ⇒
  //     上涨概率不大、风险很高」—— 没被验证过的带动性，按用户口径就是不能买。
  //
  //   ⚠️ 顺序铁律（⛔ 别把这段挪到上面）：必须排在【题材量比太小 ⇒ 整块作废 + 走十日涨幅候补】之后。
  //     那一档要留 `r10RemovedSecond` 给候补当扳机；本段若抢先摘块，候补就永远不会被触发。
  //   ⚠️ 用户明说「只选排名第一的那个题材股票」⇒ 被否后【不顺延到排名第三】：
  //     ⛔ 不补位、不 continue，第 2 个槽位直接空着（更弱的题材更不可能过这道闸）。
  //   ⚠️ §11：调用方【根本没传十日涨幅池】（老调用方 / 单测）⇒ 整段跳过，行为与加本规则之前逐字节相同。
  //   ⚠️ §10：池子不可用（传了但补位行没就绪 / 池子为空）或龙一没出现在池子里 ⇒ **判不出** ⇒
  //     本次【不启用】这道闸（保持原规则），并如实说明 —— ⛔ 绝不把「没数据」当成「没进前十」去否题材
  //     （那与第二十九条「数据缺口 ⇒ 暂不作废」是同一把尺子，两处口径必须一致）。
  //   ✅ 只有【真的算出了名次】**且名次 > 前十**（或龙一在池子里却排不出名次）时，才否掉该题材。
  let r10SecondNoLead = null;      // 本轮被这道闸否掉的第二题材（供尾部说明避免自相矛盾）
  if (r10Enabled && out.blocks.length >= 2 && r10PoolGiven) {
    const secondBlk = out.blocks[1];
    const secondTopic = String((secondBlk && secondBlk.block && secondBlk.block.topic) || '').trim();
    const firstTopic = String((out.blocks[0] && out.blocks[0].block && out.blocks[0].block.topic) || '').trim();
    const gate = r10PoolComplete
      ? _secondTopicLeaderInTop10(secondBlk.block, buyDragonMap, r10Rank926)
      : { ok: false, judge: 'no-pool', dragonName: '', rank: null, pct: null };
    // 判不出的三种情形（⛔ 不否题材，只说清楚「没校验」——§10 判不出 ≠ 判出 false）
    const undecidable = (gate.judge === 'no-pool' || gate.judge === 'no-row' || gate.judge === 'no-dragon');
    if (gate.ok) {
      // 达标也要留一行事实：用户回看时能核对「这道闸是怎么过的」（§10 判定可追溯）
      out.notes.push('ℹ️【排名第二题材的入选条件】排名第二的入选题材【' + secondTopic + '】通过：' +
        '它的龙一【' + gate.dragonName + '】当日十日涨幅〔' + r10BaseText + '〕' +
        _pct2(gate.pct) + ' 第 ' + gate.rank + ' 名（前十名内 ⇒ 有带动性）。');
    } else if (undecidable) {
      // ⛔ 同一件数据缺口只说一次（避免与第二十九条「暂不作废」那条叠成两句）
      if (!r10GapNoted) {
        r10GapNoted = true;
        const gapWhy = (gate.judge === 'no-dragon')
          ? '该题材【没有龙一】（组内没有可占龙位的主板票）'
          : (gate.judge === 'no-row'
            ? ('它的龙一【' + gate.dragonName + '】不在当天的十日涨幅名单里')
            : ('【十日涨幅名单】' + (r10PoolComplete ? '为空' : '的 20 天补位行还没就绪（名次会整体错位）')));
        out.notes.push('⚠️【排名第二题材的入选条件】排名第二的入选题材【' + secondTopic + '】本次' +
          '【未校验】（保持原规则照常列出）：' + gapWhy + ' ⇒ 判不出它的龙一进没进前十。' +
          '数据到货后会自动重判（§10：判不出 ≠ 没进前十）。');
      }
    } else {
      const rankText = (gate.rank === null)
        ? '排不出名次（没有十日涨幅 / 非主板 ⇒ 不在那十枚标签里）'
        : ('第 ' + gate.rank + ' 名');
      r10SecondNoLead = { topic: secondTopic, judge: gate.judge };
      // ⚠️ 槽位必须一起重建（§6 唯一实现：_dropSecondBlockSlot）
      _dropSecondBlockSlot(out);
      out.notes.push('⚠️【排名第二题材的入选条件】排名第二的入选题材【' + secondTopic +
        '】本次【不入选】：它的龙一【' + gate.dragonName + '】当日十日涨幅〔' + r10BaseText + '〕' +
        _pct2(gate.pct) + ' ' + rankText + '，没有进入前十（第 ' + PRESENCE_TOP_N + ' 名以内才达标）。' +
        '连它的龙一都没有进入当天的十日涨幅，说明没有带动性，后续基本上涨概率不大，风险很高。' +
        '⇒ 本日买点侧只选排名第一的题材【' + firstTopic + '】的股票' +
        '（⛔ 不顺延到排名第三的题材）。');
    }
  }

  // ★ [CASH-ALERT 2026-10-13 用户口径] 空仓提醒：只看【能入选的】排名第一题材（blocks[0]）。
  //   ⛔ 放在选股【之后】、且只读不写 —— 命中时股票照常列在下面（用户原话「还是按照原来的正常方式
  //      选出排名第一，第二的题材的股票，只是……多添加了空仓提醒文字」）。
  // ★ [EBB-R20b 2026-10-20] 标语接管口径：
  //   · 首次退潮 / 二次确认但【常规选不出补涨题材】（blocks 为空 = 排名前二的新题材都不符合条件）
  //     ⇒ 退潮口径接管 cashAlert（整段灰化 + 买点侧替补/空仓标语）—— 这就是用户说的「兜底」；
  //   · 二次确认且常规选出了补涨题材 ⇒ cashAlert 走【常规判据】（买点侧正常显示；
  //     退潮信息走行内说明 + 卖点横幅，⛔ 不再拿「建议空仓」标语顶掉常规选股的结果）。
  const ebbSecondRegular = !!(ebbSecondTopic && out.blocks.length > 0);
  out.cashAlert = buildCashAlert(out.blocks[0], (out.ebb && !ebbSecondRegular) ? out.ebb : null);

  // ★ [DIVERGE 2026-10-20 用户口径] 市场总龙一【首次分歧】日：
  //   「市场总龙一，第一次出现分歧的时候，是买点……标签应该是下杀买。题材量比买点侧只有市场总龙一，
  //    还有其它不同题材的两只高标股票（20日涨幅前五的），同题材的不要……最多三只。」
  //   ld 由组合式下发（K 线 bars + 行情竞价涨幅算出的判定，§10 判不出 ⇒ null）。
  //   ⛔ 优先级：【退潮 > 总龙首次分歧 > 空仓提醒】—— 退潮日（题材预期差）不谈分歧买点；
  //     分歧日若同时量比低，分歧接管（本日买点侧就是那 ≤3 只）。
  //   ★ [R10-BACKUP 2026-10-24] `ld` / `divergeActive` 已上移到【选股扫描之前】（见那里的长注释）。

  // ★ 买点标签收口 —— decision-rules 的【同一份实现】（占比 / 动作标签 / 持有 / 题材标记）
  const fOpts = {
    dragonMap: dragonMap,
    prevDragonNames: ctx.prevDragonNames || null,
    prevBoughtNames: ctx.prevBought || null,
    prevBoughtTopics: ctx.prevBoughtTopics || null,
    topicStreakPast: ctx.topicStreakPast || null,
    prevBuyNames: ctx.prevBuyNames || null,
    ruleNo: RULE_NO.FIRST
  };
  out.blocks.forEach(function(b) { finishBuyBlock(b, fOpts); });

  // ★★ [LEADER-LIMITDOWN 2026-11-02 用户口径] 第三十二条：龙一竞价跌停的那个题材【照常列出但今天不买】。
  //   ⛔ 必须排在 finishBuyBlock【之后】：那一步才算出每行的原始买点标签，这里做覆盖式改写。
  //   ⚠️ 排在退潮 / 分歧 / 空仓提醒三条改写【之前】是刻意的：那三条一旦成立，它们讲的是
  //     「整个买点侧都别买」（更宽的结论），标签以它们为准；本条只否一个题材，被覆盖也不影响结论。
  if (out.leaderLimitDown) _applyLeaderLimitDownNoBuy(out.blocks, out.leaderLimitDown);

  // ★★ [SWITCH 2026-10-22 用户口径] 第二十八条：把【新龙】那一行构造出来（独立容器渲染）。
  //   ① 必须先有 fOpts（finishBuyBlock 要它算客观数据与原始买点信号）；
  //   ② 它的标签随后被覆盖成【新龙买】—— 与退潮替补 / 分歧买点同一范式（⛔ 不改 finishBuyBlock 内部）。
  if (switchNewDragon) {
    out.newDragon = _buildNewDragonBlock(
      ndResult, list, fOpts, out.switchDay, Number(o.top5HistoryDays) || 0,
      (out.blocks[0] && out.blocks[0].picks && out.blocks[0].picks[0])
        ? ((out.blocks[0].picks[0].dragonLabel || '') + out.blocks[0].picks[0].name)
        : ''
    );
    if (out.newDragon) out.buy.newDragon = out.newDragon;
    // ★★ [NEW-DRAGON-CERTIFY / NEW-DRAGON-FAMILY 2026-11-12] 把「谁认证的谁、一共买几只」写进
    //   看板级说明（用户要「标清楚」）。family 路径（新题材 = 字号/字辈）优先，旧认证龙路径作兜底。
    const _cert = ndResult && ndResult.certifier;
    const _fam = ndResult && ndResult.family;
    const _extras = (ndResult && Array.isArray(ndResult.extras)) ? ndResult.extras : [];
    const _buyAll = [ndName].concat(_extras.map(function(x) { return String(x.name || '').trim(); })).join('、');
    out.notes.push('⚠️【第二十八条 · 切换日】' + (out.switchDay.leaderName || '老龙一') + '（' +
      (_oldTopicNameOf(out.switchDay) || '—') + '）二次确认退潮（' + out.switchDay.ebbDate +
      '）后第 2 个交易日 ⇒ 老周期结束、找新龙：' +
      // ★ [LEADER-FIRST-TOPIC 2026-11-12] 用户要求「把判断的日期 / 逻辑写进选股提示」⇒ 老题材的依据写在这里
      (_oldTopicBasisOf(out.switchDay) ? ('〔老题材怎么定：' + _oldTopicBasisOf(out.switchDay) + '〕') : '') +
      (_fam
        ? ('20日涨幅（9:25 竞价口径）前十里有 ' + _fam.count + ' 只【' + _fam.topic + '】（' +
           _fam.members.map(function(m) { return m.name + (m.everBefore ? '·老面孔' : '·新面孔'); }).join('、') +
           '）⇒ 构成【补涨新题材】；最强的是【' + _fam.primaryName + '】（' + _rankLabelOf(_fam.bestRank) + '）' +
           (_fam.primaryEverBefore ? '，它本身就是老周期总龙 ⇒【双重属性】既是老龙又是新龙 ⇒ 可以选入' : '') +
           (_cert && _cert.role === 'certify-only'
             ? ('；但它今日【' + (_cert.reason === 'yizi' ? '竞价一字涨停' : (_cert.reason === 'suspended' ? '停牌' : '非主板')) +
                '·买不进】⇒ 只作题材认证')
             : '') +
           ' ⇒ 买点侧 = 【新题材】' + _buyAll + '（' + (1 + _extras.length) + ' 只）')
        : ('买点侧 = 【' + (_cert ? '认证龙' : '新龙') + '】' + ndName + '（' +
           ((ndResult && ndResult.topicText) || (ndResult.pick.topic || '—')) + '）' +
           (_cert
             ? ('〔同题材【' + (_cert.topic || '—') + '】里首次进前五的是【' + _cert.name + '】（' +
                (_rankLabelOf(_cert.rank20) || '—') + '），那只只作判断条件；前五里同题材最靠前的是本只 ⇒ ' +
                '按口径只买最靠前的那一只〕')
             : ''))) +
      ' + 常规收紧后的【一只】（只选一个题材、只取一只）。');
  } else if (out.switchDay) {
    // §10：切换日到了但判不出新龙 ⇒ 必须说清原因，并明确「回落常规（但仍只取排名第一的那一个题材）」
    // ★ [CYCLE 2026-10-22] 收紧不因「判不出新龙」而取消：用户原话「10月22日……常规只选排名第一的
    //   入选题材（只选最前面那个）」—— 老周期已在昨天结束，今天不可能再买两个题材。
    out.notes.push('⚠️【第二十八条 · 切换日】' + (out.switchDay.leaderName || '老龙一') + '（' +
      (_oldTopicNameOf(out.switchDay) || '—') + '）二次确认退潮后第 2 个交易日 = 切换日，' +
      (ndJudgeFail ? (ndJudgeFail + '。') : '但 20日涨幅前八里【没有】符合「首次上榜 + 不同题材」的新龙。') +
      ' ⇒ 买点侧【回落常规选股：只选排名第一的入选题材、只取一只】（第二十八条）。' +
      ((ndResult && ndResult.trail && ndResult.trail.length > 0)
        ? (' 八只去留：' + ndResult.trail.map(function(t) {
          return '【' + (totalDragonLabel(Number(t.rank20) || 0) || '总龙?') + t.name + '】' + t.reason;
        }).join('；') + '。')
        : ''));
  }

  // ★ [EBB 2026-10-13 第六轮用户口径] 退潮首日 ⇒ 买点动作【覆盖式】重写：
  //   「退潮当天，只有卖没有买」「买点侧还标有 持有 竞价买，应该标的是『退潮不买』」。
  //   把每行的【持有】/【竞价买】/【尾盘买】…一律换成【退潮不买】（含仓位槽）。
  //   ⛔ 必须排在 finishBuyBlock【之后】（要覆盖它刚算出来的标签）；
  //   ⛔ 客观数据（十日涨幅 / 涨幅 / 量比 / 占比 / 龙标 / 连板 / 封单）一行不动。
  // ★ [CASH-ALERT-NOBUY 2026-10-16 用户口径] 空仓提醒（★ 非退潮日）⇒ 买点动作同样【覆盖式】重写：
  //   「这个提示下的买点侧，全部变成灰色（卖点侧不变），买点侧股票标签改成"分歧日不买"」。
  //   ★ 优先级：退潮（首次 / 二次确认走兜底）⇒ 【退潮不买】；其余命中空仓提醒 ⇒ 【分歧日不买】。
  //   ★ [EBB-R20b] 二次确认 + 常规选出了补涨题材 ⇒ 买点侧【按常规规则走】：
  //     常规的空仓提醒（第一新题材量比 < 25）照常生效（分歧日不买），退潮只写进行内说明 ——
  //     用户本轮口径「如果符合平均量比的新题材……就按照常规选股就行了」。
  if (out.ebb && !ebbSecondRegular) {
    _applyEbbBuyRules(out.blocks, out.ebb);
  } else if (divergeActive) {
    // ★ [DIVERGE] 分歧日：其余入选票【总龙分歧不买】（照常列出 + 灰化），
    //   大字标语接管 cashAlert（同一消费通道，视图灰化判据 = cashAlert.show 不变）。
    out.divergeBuy = _buildDivergeBuyBlock(ld, list, fOpts);
    out.cashAlert = _buildDivergeCashAlert(ld, out.divergeBuy ? (out.divergeBuy.picks || []).length : 1);
    _applyDivergeNoBuyRules(out.blocks, ld);
    out.notes.push('⚠️【总龙首次分歧】市场总龙一【' + (ld.leaderName || '—') + '】' +
      (ld.firstBoardYmd ? '自首板 ' + ld.firstBoardYmd + ' 以来' : '') +
      '首次竞价低开（' + (ld.aucPctText || '—') + '）⇒ 分歧日：买点侧只有 总龙一（下杀买）+ ' +
      '不同题材的主板高标 ≤2 只（第二十五条），其余入选票今天不开新仓。');
  } else if (out.cashAlert.show) {
    _applyCashAlertBuyRules(out.blocks, out.cashAlert);

    // ★★ [WEAK-HUDDLE 2026-10-27 用户口径] 第三十条【弱势切抱团】：
    //   空仓提醒命中 ⇒ 从【灰色题材块】出发，看 20日涨幅主板前三里有没有【同题材】的票；
    //   有 ⇒ 选出来渲染在【最前面】（独立容器、不灰）、标【弱势切抱团】；没有 ⇒ 仍然空仓。
    //   ⛔ 必须排在 _applyCashAlertBuyRules 之后：那一步才把常规块打成【分歧日不买】+ 整段灰化，
    //      本块是今天唯一还能买的那几只（渲染在灰化容器之外，语义必须一致 —— 与第二十九条同一条理由）。
    //   ⛔ 只在【常规空仓提醒】这一条分支里造：退潮首日 / 总龙首次分歧已各自接管 cashAlert，
    //      它们的买点通道（第二十一条 / 第二十五条）与本条互斥，⛔ 不许两条同时输出买点。
    //   ⚠️ 池子取 `ebbCtx.top5`（已经是【只主板 + 20日涨幅降序 + 带 topic / rank20】）——
    //      ⛔ 不在这里另排一次名次，那是第二份真相（§6）。
    const whPool = (o.ebbCtx && Array.isArray(o.ebbCtx.top5)) ? o.ebbCtx.top5 : null;
    const whTopic = String((out.cashAlert && out.cashAlert.topic) || '').trim();
    if (!whPool || whPool.length === 0) {
      // §10：判不出就如实说（⛔ 沉默会让人以为「今天本来就没有抱团票」）
      out.notes.push('⚠️【第' + WEAK_HUDDLE_RULE_NO + '条 · 弱势切抱团】20日涨幅前五（只主板）还没就绪 ⇒ ' +
        '本次【判不出】灰色题材块里有没有票进前三名。数据到货后会自动重算 —— ' +
        '（§10：判不出 ≠ 今天没有抱团票，也 ≠ 今天一定要空仓）。');
    } else {
      out.weakHuddle = _buildWeakHuddleBlock(whPool, out.cashAlert, list, fOpts, coreRes);
      if (out.weakHuddle) {
        // §6：同一份对象挂进买点槽位（四个装饰器经 _buyBlocksOf 遍历，⛔ 别在组合式里再铺一遍）
        out.buy.weakHuddle = out.weakHuddle;
        const names = (out.weakHuddle.picks || []).map(function(p) {
          return '【' + (p.dragonLabel || '') + p.name + '】';
        }).join('、');
        out.notes.push('⚠️【第' + WEAK_HUDDLE_RULE_NO + '条 · 弱势切抱团】灰色题材块【' + whTopic +
          '】已退潮（平均竞价量比 ' + out.cashAlert.avgVolRatioText + ' ＜ ' + out.cashAlert.threshold +
          '）⇒ 买点侧整段灰化；但它的票里 ' + names + ' 同时在【20日涨幅主板前三】之内 ⇒ ' +
          '行情差时资金会抱团最强的市场龙头（也是题材龙头），' +
          '这一只作为【今天可以买】的票单独列在最前面（标签【' + WEAK_HUDDLE_TAG + '】）。' +
          '⚠️ 它仍会在下面那个灰化块里出现一次（题材结论 ≠ 股票结论，两处都保留）。');
      } else if (whTopic) {
        // 有池子但没有同题材的票进前三 ⇒ 用户口径「还是要空仓的」
        const topNames = whPool.slice(0, WEAK_HUDDLE_TOP_N).map(function(t) {
          return t.name + '（' + (t.topic || '—') + '）';
        }).join('、');
        out.notes.push('⚠️【第' + WEAK_HUDDLE_RULE_NO + '条 · 弱势切抱团】20日涨幅主板前三名 = ' +
          (topNames || '—') + '，其中【没有】' + whTopic + ' 的股票 ⇒ ' +
          '灰色题材块里没有可抱团的市场龙头 ⇒ 【今天仍然空仓】（不选、不替补）。' +
          // ★ [CORE-CAT 2026-10-29] 把判据写清：上面括号里是【细分题材原文】，比对用的是【核心词大类】——
          //   ⛔ 用户看到的「家电」与块名「大消费」不是同一层级，不写清会以为是判错了（10-29 报障）。
          '（口径：上面括号里是每只票行上的【细分题材】，与块名【' + whTopic +
          '】是拿【核心词大类】归一之后再比的 —— 细分题材在该大类的核心词里就算同题材。）');
      }

      // ★★ [CATCH-UP 2026-10-27 用户口径] 第三十一条【补涨题材】：
      //   同一个灰色题材块，改看【20日涨幅主板第 6~10 名】—— 该题材恰好占 2~3 只 ⇒ 低位补涨题材
      //   ⇒ 从里面【只选连板票】。一只连板都没有 / 数量不在 2~3 ⇒ 仍然空仓。
      //   ⛔ 与第三十条【并列】而不是互斥：两条看的是【不同名次区间】（1~3 vs 6~10），
      //      同一个题材同一天理论上可以各命中一次；⛔ 不许互相顶替（用户两轮口径是两条独立规则）。
      //   ⛔ 池子取 `ebbCtx.topicPool`（20日涨幅【前十】富化，与 top5 同一份 _enrich、同一把尺子）。
      //      它缺省是空数组（前十没就绪）⇒ 走 §10「判不出」分支，⛔ 不许当成「今天没有补涨题材」。
      const cuPool = (o.ebbCtx && Array.isArray(o.ebbCtx.topicPool)) ? o.ebbCtx.topicPool : null;
      if (!whTopic) {
        // 灰色题材名取不到 ⇒ 无从比对（与第三十条同一处理：不写噪音说明）
      } else if (!cuPool || cuPool.length === 0) {
        out.notes.push('⚠️【第' + CATCH_UP_RULE_NO + '条 · 补涨题材】20日涨幅前十（只主板）还没就绪 ⇒ ' +
          '本次【判不出】灰色题材块【' + whTopic + '】在第 ' + CATCH_UP_RANK_FROM + '~' +
          CATCH_UP_RANK_TO + ' 名里占几只。（§10：判不出 ≠ 今天没有补涨题材，也 ≠ 今天一定要空仓。）');
      } else {
        const cu = _buildCatchUpBlock(cuPool, out.cashAlert, list, fOpts, coreRes);
        if (cu.block) {
          out.catchUp = cu.block;
          // §6：同一份对象挂进买点槽位（四个装饰器经 _buyBlocksOf 遍历）
          out.buy.catchUp = out.catchUp;
          const cuDetail = (cu.inRange || []).map(function(t) {
            const st = (t && t.streak !== null && t.streak !== undefined) ? Number(t.streak) : null;
            const word = _streakWord(t, st);
            return t.name + '（第 ' + Number(t.rank20) + ' 名' + (word ? '，' + word : '') + '）';
          }).join('、');
          out.notes.push('⚠️【第' + CATCH_UP_RULE_NO + '条 · 补涨题材】灰色题材块【' + whTopic +
            '】已退潮（平均竞价量比 ' + out.cashAlert.avgVolRatioText + ' ＜ ' + out.cashAlert.threshold +
            '）⇒ 买点侧整段灰化；但该题材有 ' + cu.count + ' 只票落在【20日涨幅主板第 ' +
            CATCH_UP_RANK_FROM + '~' + CATCH_UP_RANK_TO + ' 名】= ' + (cuDetail || '—') +
            ' ⇒ 属【低位补涨题材】（后期往往很好），其中【连板票】' +
            (out.catchUp.picks || []).map(function(p) { return '【' + p.name + '】'; }).join('、') +
            ' 作为【今天可以买】的票列在最前面（标签【' + CATCH_UP_TAG + '】）。' +
            '⚠️ 它仍会在下面那个灰化块里出现一次（题材结论 ≠ 股票结论，两处都保留）。');
        } else if (cu.reason === 'count') {
          out.notes.push('⚠️【第' + CATCH_UP_RULE_NO + '条 · 补涨题材】第 ' + CATCH_UP_RANK_FROM + '~' +
            CATCH_UP_RANK_TO + ' 名里，灰色题材块【' + whTopic + '】占 ' + cu.count + ' 只 ⇒ ' +
            '不在【恰好 ' + CATCH_UP_MIN_COUNT + '~' + CATCH_UP_MAX_COUNT + ' 只】的区间内' +
            (cu.count >= CATCH_UP_MIN_COUNT ? '（4 只以上说明它已是主线，不是低位补涨）' : '（不足 2 只 = 个别票，不成题材）') +
            ' ⇒ 本条不生效。');
        } else if (cu.reason === 'no-streak') {
          const det = (cu.inRange || []).map(function(t) {
            // ⚠️ §10：`Number(null)` = 0 ⇒ 会渲染成「0连板」这种假数据；null/undefined 必须显式落到「未知」
            const rawStreak = (t && t.streak !== null && t.streak !== undefined) ? Number(t.streak) : null;
            const word = _streakWord(t, rawStreak);
            return t.name + '（第 ' + Number(t.rank20) + ' 名，' + (word || '连板天数未知') + '）';
          }).join('、');
          out.notes.push('⚠️【第' + CATCH_UP_RULE_NO + '条 · 补涨题材】第 ' + CATCH_UP_RANK_FROM + '~' +
            CATCH_UP_RANK_TO + ' 名里灰色题材块【' + whTopic + '】有 ' + cu.count + ' 只：' + (det || '—') +
            '，但【一只连板票都没有】（门槛 = 连板天数 ≥ ' + CATCH_UP_MIN_STREAK + '）⇒ ' +
            '按「补涨题材只选连板票比较强势」⇒ 【今天仍然空仓】（不选、不替补）。');
        } else if (cu.reason === 'none') {
          out.notes.push('⚠️【第' + CATCH_UP_RULE_NO + '条 · 补涨题材】第 ' + CATCH_UP_RANK_FROM + '~' +
            CATCH_UP_RANK_TO + ' 名里【没有】' + whTopic + ' 的股票 ⇒ 不构成补涨题材（本条不生效）。');
        }
      }
    }
  }

  // ★★ [LEADER-LIMITDOWN 2026-11-02 用户口径] 第三十二条【题材龙一竞价跌停 ⇒ 弱势切抱团】
  //   排名第一的入选题材里【最强的那只】竞价就跌停 ⇒ 这个题材今天已经弱势、不选它；
  //   改从 20日涨幅（竞价口径、只主板）取【市场总龙一】那一只抱团。
  //   ⛔ 必须排在【所有买点改写之后】：它不在 out.blocks 里（渲染在灰化容器【之外】），
  //      是今天唯一还能买的那一只 —— 与第三十条 / 第二十九条是同一条理由。
  //   ⚠️ 池子取 `ebbCtx.top5`（已经是【只主板 + 20日涨幅降序 + 带 topic / rank20】）——
  //      ⛔ 不在这里另排一次名次，那是第二份真相（§6）。
  //   ★ 与第三十条共用 weakHuddle 槽位 / 渲染通道 / 分笔抓取 / buy-quiesce 标签（同一枚
  //     【弱势切抱团】标签、同一档紫罗兰配色）。两条同一天都成立时以本条为准：它的信号更硬
  //     （题材内最强的那只已经跌停），说明里会讲清为什么换掉第三十条那几只。
  //   ⚠️ §11：`out.leaderLimitDown` 为 null（没命中 / 不在常规语境 / 龙一竞价涨幅读不到）⇒ 整段跳过，
  //      行为与加本规则之前逐字节相同。
  if (out.leaderLimitDown) {
    const hdPool = (o.ebbCtx && Array.isArray(o.ebbCtx.top5)) ? o.ebbCtx.top5 : null;
    const tookOverWeakHuddle = !!out.weakHuddle;
    const hdBuilt = (hdPool && hdPool.length > 0)
      ? _buildLeaderLimitDownHuddleBlock(hdPool, out.leaderLimitDown, list, fOpts)
      : { block: null, reason: 'no-pool' };
    if (hdBuilt.block) {
      out.weakHuddle = hdBuilt.block;
      // §6：同一份对象挂进买点槽位（四个装饰器经 _buyBlocksOf 遍历，⛔ 别在组合式里再铺一遍）
      out.buy.weakHuddle = out.weakHuddle;
      const hdNames = (out.weakHuddle.picks || []).map(function(p) {
        return '【' + (p.dragonLabel || '') + p.name + '】';
      }).join('、');
      if (tookOverWeakHuddle) {
        out.notes.push('⚠️【第' + TOPIC_LEADER_LIMITDOWN_RULE_NO + '条】本日同时命中了第三十条【弱势切抱团】' +
          '（空仓提醒那条通道），但本题材的龙一已经【竞价跌停】= 更硬的弱势信号 ⇒ 抱团对象改为' +
          '【市场总龙一】，第三十条那几只不再作为买点（同一槽位只保留一条，⛔ 不并列出两只）。');
      }
      out.notes.push('⚠️【第' + TOPIC_LEADER_LIMITDOWN_RULE_NO + '条 · 弱势切抱团】买点侧改为抱团' +
        '【市场总龙一】' + hdNames + '（20日涨幅主板第 1 名，竞价口径）⇒ 作为【今天可以买】的票' +
        '单独列在最前面（标签【' + TOPIC_LEADER_LIMITDOWN_TAG + '】）。' +
        '⚠️ 被否掉的那个题材块照常列在下面，但块内票一律【' + TOPIC_LEADER_LIMITDOWN_NO_BUY_TAG + '】。');
    } else if (hdBuilt.reason === 'same') {
      // §10：判不出就必须说清原因（⛔ 沉默会让人以为「今天本来就没有抱团票」）
      out.notes.push('⚠️【第' + TOPIC_LEADER_LIMITDOWN_RULE_NO + '条 · 弱势切抱团】20日涨幅主板第 1 名' +
        '正是那只竞价跌停的龙一【' + out.leaderLimitDown.name + '】⇒ 今天【没有】可抱团的市场总龙一 ⇒ ' +
        '本条本次不生效（该题材块照旧不买）。数据修正后会自动重算。');
    } else {
      out.notes.push('⚠️【第' + TOPIC_LEADER_LIMITDOWN_RULE_NO + '条 · 弱势切抱团】20日涨幅前五（只主板）' +
        '还没就绪 ⇒ 本次【判不出】该抱团哪一只（那个题材块照旧不买）。数据到货后会自动重算 —— ' +
        '（§10：判不出 ≠ 今天没有抱团票）。');
    }
  }

  // ★★ [EBB-D1 2026-10-21 用户口径] 昨日【二次确认退潮】的题材 ⇒ 次日禁入买点侧（第二十六条）。
  //   用户原话：「主线题材如果昨天已经二次确认退潮了，次日就不要进入买点侧了，也就是说次日即使
  //     这个题材符合平均量比的条件，题材平均量比排名第二，也不应该买了，因为风险很高。其它题材可以。
  //     ……你把买点侧的主线题材入选的票的区域，变成灰色，不用去掉，其它题材不变。」
  //   ⛔ 为什么必须排在上面三条改写【之后】：本规则是【按题材】的覆盖式后处理（更具体的理由
  //     要写进行内说明）。
  //   ★ 优先级关系：今日若是退潮日（out.ebb 生效）⇒ 全段已被 _applyEbbBuyRules 灰化改写，本规则
  //     只是再叠一层【更具体的题材级说明】（同一枚标签，幂等）；分歧日同理（该题材块从
  //     【总龙分歧不买】细化为【退潮不买】，理由更准）。prevDate / ebbHistory 缺省 ⇒ 判不出 ⇒ 零行为（§11）。
  //   ⛔ 题材块【不删】：用户明确「不用去掉，其它题材不变」⇒ 照常入选占位 + 整块灰化 + 标签改【退潮不买】。
  //   ⚠️ 买点名单（buyNames）在本函数后段组装 ⇒ 组装完后要把禁入题材的票【剔除】（见下方
  //      [EBB-D1] 剔除段）—— 禁入的票今天不买 ⇒ 卖点侧不因它标【持有】，与退潮题材被 R20b
  //      排除出选股 ⇒ 同样不进名单，是同一不变式。
  const prevSecondEbb = secondEbbTopicOfPrevDay(o.ebbHistory || null, o.prevDate || '', coreRes, o.ebbWindowFrom || '');
  if (prevSecondEbb) {
    _applyPrevEbbSecondNoBuy(out.blocks, prevSecondEbb, coreRes);
    out.notes.push('⚠️【' + prevSecondEbb.topic + '】昨日已二次确认退潮（第二十六条）：该题材今天【禁止买入】，' +
      '入选票照常列出但整块灰化、动作标签一律【' + EBB_NO_BUY_TAG + '】；其它题材不变。');
  }

  // ── ★★ [R10-BACKUP 2026-10-24 用户口径] 第二十九条 · 第二段：造出那【一只】十日涨幅候补 ──────
  //   触发条件（用户两段原话合起来）：
  //     ① 排名【第一】的入选题材平均量比 < 25（= 空仓提醒已命中）——「也一率作废，进入候选的是
  //        十日涨幅题目新股票排名靠前的新股票」；AskUserQuestion「空仓标语保留 + 另给候补」；
  //     ② 排名【第二】的题材已被上面整块作废 —— 用户：「进行替换」。
  //   ⛔ 只造【一只】（用户：「有首次在列的只选一只」），造不出 ⇒ 依说明「依旧空仓」。
  //   ⛔ 必须排在【所有买点改写之后】：
  //     · `_applyCashAlertBuyRules` 会把常规块打成【分歧日不买】+ 整段灰化 —— 候补若先造出来就会被一起灰掉，
  //       而它是今天【唯一还能买】的那一只（视图把它渲染在灰化容器之外，语义必须一致）；
  //     · `_applyPrevEbbSecondNoBuy` 同理（题材级灰化）。
  //   ⛔ 也不许先于 `fOpts` / `out.newDragon`：候补块要走 finishBuyBlock，且要避开已被选走的票。
  const r10LeadWeak = !!(out.cashAlert && out.cashAlert.show && out.cashAlert.avgVolRatio !== null);
  // ★★ [TOPIC-CASCADE 2026-10-28 用户口径] 十日涨幅候补的【总前提】= 排名第一的入选题材必须达标。
  //   用户原话：「排名第一的题材平均量比当天就不符合，就不用10日候选了……我之前的意思是排名第一的
  //   题材要平均量比符合，整体不算差，但是排名第二的题材不符合，这时才考虑用十日涨幅那个条件
  //   候补排名第二的。」
  //   ⇒ 原来有两条触发（① 第二题材量比太小 ② 第一题材量比也 < 25 ⇒ 额外给一只候补），
  //     现在【② 整条取消】：第一题材自己不达标 = 整体已经算差 = 退潮/空仓语境，
  //     此时再补一只十日周期新面孔，等于在退潮日凭空造出可买标的（10-28 实盘：大消费 21.17 ＜ 25
  //     ⇒ 却补出了【杰克科技】，用户明确否掉）。
  //   ⛔ 于是 `!r10LeadWeak` 是硬闸门：第一题材量比 < 25 ⇒ 本通道一律不产出（含 blocks 只有一块的情形）。
  //   ⚠️ §10：第一题材量比读不出来（null）⇒ r10LeadWeak 为 false ⇒ 不拦（判不出 ≠ 不达标）。
  const r10Need = r10Enabled && r10DataReady && !r10LeadWeak && !!r10RemovedSecond;
  // §10：该给候补却因为次数没读到而给不出 ⇒ 如实说一句（⛔ 沉默会让人以为「今天本来就没有候补」）。
  //   只在「调用方确实给了池子」时提示；弱题材那条已经说过（r10GapNoted）就不重复。
  if (r10Enabled && r10PoolGiven && !r10DataReady && !r10GapNoted && (r10LeadWeak || !!r10SecondWeak)) {
    // ★ [R10-POOL 2026-10-24] 缺口有两种，文案必须分开说（口径不同、用户要采取的动作也不同）：
    //   · 补位行没到 ⇒ 名次这把尺子整体错位（10-23 上海九百 事故就是这个）；
    //   · 在列次数没到 ⇒ 分不出「首次 / 二次」。
    const r10GapWhy = !r10PoolComplete
      ? '十日涨幅榜的【20 天补位行】还没就绪 ⇒ 候选池与屏幕上那十行对不上（名次会整体错位）'
      : '十日窗口的在列次数（auction_presence）还没读到 ⇒ 无法判断「首次 / 二次在列」';
    out.notes.push('⚠️【第' + RANGE10_BACKUP_RULE_NO + '条 · 十日涨幅候补】本次【判不出候补】：' +
      r10GapWhy + '。数据到货后会自动补算（§10：判不出 ≠ 今天没有候补）。');
  }
  if (r10Need) {
    // 20日涨幅总龙一（不同题材闸门的对照物）：由采集层富化在 ebbCtx.top5[0]（§6 同一份事实）；
    //   取不到 ⇒ 判不出「是否同题材」⇒ ⛔ 不选票（§10 不猜）。
    //   🔴 [R10-GATE 2026-10-24] 从「传空就放行」改成【硬闸门】：用户口径是
    //   「和 20日涨幅的总龙一不同题材 + 排名前十，这几个条件同时满足，不然都要空仓」——
    //   总龙一题材未知时，这条「不同题材」根本没被验证过，选出来的票就是没依据的。
    const r10Top1 = (o.ebbCtx && Array.isArray(o.ebbCtx.top5) && o.ebbCtx.top5[0]) ? o.ebbCtx.top5[0] : null;
    const r10Top1Topic = r10Top1 ? String(r10Top1.topic || '').trim() : '';
    const r10Top1Name = r10Top1 ? String(r10Top1.name || '').trim() : '';
    const r10Top1Missing = !r10Top1Topic;
    // ── 上方每一只票的【身份】（只用于说明文案，⛔ 不参与选票）─────────────────────
    // 🔴🔴 [R10-STOCK-LEVEL 2026-10-24 用户口径 · 第三次修正（10-20 事故）]
    //   第一次修正：题材灰化/作废不能否决这只票（10-23 兆威机电）。
    //   第二次修正：本通道是【选股票】不是【选题材】，同一只票可以在灰化块里重复出现。
    //   ★ 第三次修正（本次）：「10月20日，十日候补题材你选了京城股份，实际上是海洋王，因为
    //     海洋王已经选在了下面题材商业航天题材中，所以你选排在后一名的京城股份？这是不对的。」
    //     「出现多只首次在列只选一只最强的，也就是十日涨幅最高的，那就是海洋王。」
    //     「这种情况是题材和市场选票叠加的效果，这是好事啊，因为两边都选了海洋王，两个提示板
    //       整合成一个叠加在一起就可以了，这是确定性啊。意思是它即是题材选出来的，也是市场
    //       选出来的。两者叠加一起，也不用分开了。」
    //   ⇒ 两条铁律：
    //     ① ⛔ 绝不因为「它已在某个题材块里当选买点」就把候补【顺延到下一名】——
    //        那等于用更弱的票顶掉最强的票（10-20：海洋王 29.51% 被顶掉，换成京城股份 27.26%）；
    //     ② 同一只票被两条通道同时选中 = 【叠加确认】，两处各展示一行 + 说明区讲清「确定性」。
    //   于是这两张 Map 只收集「它在上方是什么身份」，用来写文案：
    //     · r10NoBuyInfo    = 灰化 / 整块作废（不开新仓）⇒ 要解释「那一块照旧灰化、不恢复」；
    //     · r10RealPickInfo = 今天【确实要买】的买点 ⇒ 要解释「两条通道叠加确认」。
    //   判据用【色调】而不是标签文案：三处「不开新仓」的改写（退潮 / 分歧 / 空仓）都统一 tone = nobuy
    //   （CASH_NO_BUY_TONE = DIVERGE_NO_BUY_TONE = EBB_NO_BUY_TONE），§6 一处真相。
    const r10NoBuyInfo = new Map();      // 股票名 -> { topic, tag }：上方以「不开新仓 / 整块作废」身份出现过
    const r10RealPickInfo = new Map();   // 股票名 -> { topic, tag }：上方以【今天确实要买】身份出现过
    // 先把「被整块作废的那块」里的票铺进去（它们的块已经不在 out.blocks 里了）
    r10RemovedPicks.forEach(function(v, k) { r10NoBuyInfo.set(k, v); });
    const _r10IsNoBuyPick = function(p) {
      return !!(p && p.buyActionTone === EBB_NO_BUY_TONE);
    };
    out.blocks.forEach(function(b) {
      const bt = String((b && b.block && b.block.topic) || '').trim();
      (b.picks || []).forEach(function(p) {
        if (!p || !p.name) return;
        const nm = String(p.name).trim();
        if (_r10IsNoBuyPick(p)) {
          if (!r10NoBuyInfo.has(nm)) r10NoBuyInfo.set(nm, { topic: bt, tag: String(p.buyActionTag || '') });
          return;                        // 灰化 / 整块作废 ⇒ 只记身份，不参与排除
        }
        // ⚠️ [R10-NOEXCLUDE 2026-10-24] 今天【确实要买】的票同样只记身份，⛔ 不再排除
        //   （10-20 事故：海洋王 商业航天 已当选 ⇒ 被排除 ⇒ 顺延成京城股份，用更弱的票顶掉最强）
        if (!r10RealPickInfo.has(nm)) {
          r10RealPickInfo.set(nm, { topic: bt, tag: String(p.buyActionTag || '') });
        }
      });
    });
    [out.newDragon, out.ebbBuy].forEach(function(x) {
      if (!x) return;
      const xt = String((x.block && x.block.topic) || '').trim();
      (x.picks || []).forEach(function(p) {
        if (!p || !p.name || _r10IsNoBuyPick(p)) return;
        const nm = String(p.name).trim();
        if (!r10RealPickInfo.has(nm)) {
          r10RealPickInfo.set(nm, { topic: xt, tag: String(p.buyActionTag || '') });
        }
      });
    });
    // ── 必须避开的题材 ────────────────────────────────────────────────────────────
    // 🔴 [R10-STOCK-LEVEL] 只留【20日涨幅总龙一所在题材】这一条。
    //   用户口径里它是唯一的题材约束，而且它不是「题材筛选」而是【周期筛选】：
    //   「20 日老周期结束，现在轮到十日周期」⇒ 买老周期的同一题材 = 没换周期，等于白换。
    //   ⛔ 当日被作废的弱题材【不再】参与排除 —— 题材量比不达标是【题材块】的事（灰化/作废照旧），
    //     而本通道是「从总市场选股」，龙头自己的强度与题材平均量比本来就是两回事
    //      （用户原话：「龙头的量比都比题材大，那才是核心」）。
    const r10ExcludeTopics = [];
    if (r10Top1Topic) r10ExcludeTopics.push(r10Top1Topic);

    const r10Presence = o.range10Presence || null;
    // ★ [R10-926] 池子与口径在选股扫描之前已经算好（一次），这里直接复用（⛔ 不重算第二遍）
    const r10Rows926 = r10Rows926Res.rows;
    // ⛔ [R10-NOEXCLUDE 2026-10-24] 不传任何「已占用」名单：选票只认 涨幅名次 + 在列次数 + 总龙一题材。
    const r10Res = r10Top1Missing ? null : pickRange10Backup(r10Rows926, {
      counts: r10Presence ? r10Presence.counts : null,
      coveredDays: r10Presence ? r10Presence.coveredDays : 0,
      excludeTopics: r10ExcludeTopics,
      // 题材认亲走【大类归一】的同一把尺子（「文化传媒」与「AI应用」必须认成同一题材，§6）
      sameTopic: function(a, b) { return _sameTopicLoose(a, b, coreRes); }
    });
    if (r10Top1Missing) {
      out.notes.push('⚠️【第' + RANGE10_BACKUP_RULE_NO + '条 · 十日涨幅候补】本次【判不出候补】：' +
        '20日涨幅总龙一（及其题材）还没就绪 ⇒ 无法验证用户要求的「必须与总龙一不同题材」这道闸门 ⇒ ' +
        '不猜（§10：判不出 ≠ 今天没有候补）。');
    } else if (r10Res && r10Res.pick) {
      // ★★ [FULL-MARKET 2026-11-13 用户当场纠正] 第三十四条：候补那只的十日涨幅若超过
      //   自定义禁选上限 TVRB_RANGE10_CAP（97%，[CAP-97] 由 95 上调）⇒ 【全场级监管异动】：
      //   ⛔ 不是「这条候补空仓、换一只买」，而是整个市场整片灰 + 空仓
      //   （全场收口由 _applyAbnormalSweep / 显示层叠加统一完成）。
      //   这里只做「这条候补不选入、也不替补」，⛔ 绝不顺延到第二名（用户：波及到所有的票）。
      //   ★ 11-11 东方海洋 95.711445% 在 97 线以下 ⇒ 候补通道按原规则正常运行。
      const _r10Lv = classifyRange10(r10Res.pick.pct);
      if (_r10Lv.level === ABNORMAL_LEVEL_NEAR || _r10Lv.level === ABNORMAL_LEVEL_ABNORMAL) {
        const _blkName = r10Res.pick.name;
        const _blkPct = r10Res.pick.pct;
        r10Res.blockedBy = 'abnormal';
        r10Res.blocked = {
          name: _blkName, code: r10Res.pick.code, topic: r10Res.pick.topic,
          pct: _blkPct, pctText: _r10Lv.pctText, rank: r10Res.pick.rank,
          cnt: r10Res.pick.cnt, label: r10Res.pick.label
        };
        r10Res.tier = '';
        r10Res.reason = '十日涨幅前 ' + (r10Res.topN || PRESENCE_TOP_N) + ' 名里最强的那只【' + _blkName +
          '】（' + (r10Res.pick.topic || '—') + '，十日涨幅 ' + _r10Lv.pctText + '）' +
          '超过自定义禁选上限 ' + TVRB_RANGE10_CAP + '% ⇒ 【全场监管异动】，按用户口径【不选入、也不替补】' +
          ' ⇒ 整个市场【整片灰 + 空仓】（⛔ 不顺延、不换次强的买）。';
        r10Res.pick = null;
      }
    }
    if (!r10Top1Missing && r10Res && r10Res.pick) {
      // ★ [R10-STOCK-LEVEL 2026-10-24] 这只票在上方题材块里是什么身份 —— 决定文案怎么讲「为什么会出现两次」：
      //   · grayed（灰化 / 整块作废）：那一块照旧灰化、不恢复（10-23 兆威机电 = 工业4.0 灰化块）；
      //   · overlap（今天【确实要买】的买点）：两条通道叠加确认 = 确定性（10-20 海洋王 = 商业航天买点）。
      const r10Grayed = r10NoBuyInfo.get(String(r10Res.pick.name).trim()) || null;
      const r10Overlap = r10RealPickInfo.get(String(r10Res.pick.name).trim()) || null;
      const r10Blk = _buildRange10BackupBlock(r10Res, list, fOpts, {
        weakTopics: r10WeakTopics,
        top1Topic: r10Top1Topic,
        top1Name: r10Top1Name,
        grayed: r10Grayed,
        overlap: r10Overlap,
        // ★★ [R10-926 2026-10-24] 本次名次是按哪套口径算的（只影响文案的「口径时间」标注，§21）
        baseText: r10BaseText,
        // ★★ [DUAL-RANK 2026-10-24 用户口径] 收盘口径名次表（复盘对照用，⛔ 不改选股）
        closeRankMap: r10RankClose
      });
      if (r10Blk) {
        out.range10Backup = r10Blk;
        out.buy.range10Backup = r10Blk;
        const r10Grayed = r10NoBuyInfo.get(String(r10Res.pick.name).trim()) || null;
        const r10Overlap = r10RealPickInfo.get(String(r10Res.pick.name).trim()) || null;
        out.notes.push('⚠️【第' + RANGE10_BACKUP_RULE_NO + '条 · 十日涨幅候补】买点侧追加这一只：' +
          r10Res.pick.name + '（' + (r10Res.pick.topic || '—') + '，〔' + r10BaseText + '〕十日涨幅 ' +
          _pct2(r10Res.pick.pct) + ' 第 ' + r10Res.pick.rank +
          ' 名，' + (r10Res.pick.label || '') + '，与 20日涨幅总龙一' +
          (r10Top1Name ? ('【' + r10Top1Name + '】（' + (r10Top1Topic || '—') + '）') : '') +
          '不同题材）⇒ 十日周期的新面孔。' +
          // ★ [R10-STOCK-LEVEL 2026-10-24] 这条通道是【选股票】不是【选题材】：
          //   同一只票可能正在上方被灰化的题材块里（10-23 兆威机电 / 工业4.0）—— 题材块灰化不恢复，
          //   但它凭「十日涨幅前十 + 首次在列」独立成立，因此会重复出现一次。
          (r10Grayed
            ? ('（注：本股也在上方【' + (r10Grayed.topic || '—') + '】题材块里，那块是【' +
               (r10Grayed.tag || '不开新仓') + '】且照旧灰化、不恢复；' +
               '本行是按【股票级】通道另选的，所以同一只票会出现两次，这是设计如此。）')
            : '') +
          // ★★ [R10-NOEXCLUDE 2026-10-24 第三次修正] 与【题材通道选中同一只票】= 叠加确认：
          //   这不是重复选错，是两条独立的通道同时指向一只票 ⇒ 确定性更高（用户原话「这是好事啊」）。
          (r10Overlap
            ? ('（注：本股同时是上方【' + (r10Overlap.topic || '—') + '】题材块里的买点（' +
               (r10Overlap.tag || '买') + '）—— 【题材通道】和【市场通道】同时选中了同一只票，' +
               '这是叠加确认（确定性更高），不是重复选错；两处照旧各展示一行，不用合并也不用再选第二只。）')
            : ''));
        // ★★ [R10-YIZI 2026-10-24] §10：这只候补【今日竞价数据缺失】⇒ 判不出是否一字板。
        //   仍然选它（⛔ 不因为「不知道」就否掉一个合格候选），但必须把这个缺口如实说出来 ——
        //   「默默当成能买」正是 9-29 雪龙集团那次事故的同款风险（一字板买不进）。
        if (r10Res.yiziUnknown) {
          out.notes.push('⚠️【第' + RANGE10_BACKUP_RULE_NO + '条 · 十日涨幅候补】注意：' +
            r10Res.pick.name + ' 今日不在竞价名单里（属于「20天」补位行）⇒ 拿不到它的竞价涨幅，' +
            '【无法确认是否竞价一字涨停】⇒ 下单前自己核一眼；若它已一字涨停，按本规则的口径' +
            '【不选入、也不替补】= 今天这只候补视为空仓。');
        }
        // ★★ [TOPIC-CASCADE 2026-10-28] 原来这里有一段「第一题材量比 < 25 ⇒ 空仓标语里补一句
        //   『另有 1 只十日周期候补可以买』」—— 随 `r10Need` 加上 `!r10LeadWeak` 硬闸门，
        //   这种情形下候补【已经不产出】，该分支恒不成立，整段删除（留着就是死代码 + 误导后人）。
        //   用户口径：「排名第一的题材平均量比当天就不符合，就不用10日候选了。」
      }
    } else if (!r10Top1Missing) {
      // §10：判不出 / 没有合格票 ⇒ 必须可见（⛔ 绝不让它静默变成「今天什么都没有」）
      // ★ [R10-TRAIL 2026-10-24] 再附一句【前十逐只的去留】—— 用户两次问「为什么选了这一只 /
      //   为什么不是那一只」，光给结论没法核对；有了这一句，屏幕上点开就能逐只对上（判定可追溯）。
      const r10TrailText = (r10Res && Array.isArray(r10Res.trail) && r10Res.trail.length)
        ? ' 前十逐只看：' + r10Res.trail.map(function(t) {
            // ★★ [DUAL-RANK 2026-10-24 用户口径] 每只并一个收盘口径名次（两套不同才写）——
            //   复盘时能直接看出「竞价第 8 名的票，收盘回看是第 11 名」这类口径差。
            const cs = _closeRankOf(r10RankClose, t.name, t.rank);
            return '第' + t.rank + '名 ' + t.name + '（' + (t.label || '次数未知') +
              (cs && cs.rank !== null && !cs.same ? ('；收盘口径第 ' + cs.rank + ' 名') : '') + '）' +
              (t.reason ? '⇒ ' + t.reason : '');
          }).join('；') + '。'
        : '';
      // ★★ [R10-YIZI 2026-10-24 用户口径] 「不是选不出来，是选出来的那只买不进」——
      //   这两种空仓的原因完全不同，措辞必须分开（否则用户会以为规则又选错了票）。
      if (r10Res && r10Res.blockedBy === 'yizi') {
        out.notes.push('⚠️【第' + RANGE10_BACKUP_RULE_NO + '条 · 十日涨幅候补】今天这只候补【空仓】：' +
          (r10Res.reason || '选出来的那只今日竞价一字涨停，买不进') + '。' + r10TrailText);
      } else if (r10Res && r10Res.blockedBy === 'abnormal') {
        // ★★ [FULL-MARKET 2026-11-13] 第三十四条：它不是「选不出」，是「选出来的那只涨幅已踩
        //   自定义上限」⇒ 全场监管异动（整片灰 + 空仓），⛔ 不顺延、不替补（措辞与「一字买不进」分开）。
        out.notes.push('🚨【第' + ABNORMAL_RULE_NO + '条 · 监管异动】今天这只十日涨幅候补【空仓】：' +
          (r10Res.reason || '选出来的那只十日涨幅已超过上限') + '。' + r10TrailText);
      } else {
        out.notes.push('⚠️【第' + RANGE10_BACKUP_RULE_NO + '条 · 十日涨幅候补】本次【没有候补】' +
          ((r10Res && r10Res.reason) ? ('：' + r10Res.reason) : '') + '。' + r10TrailText);
      }
    }
  }

  // ★★ [DUAL-RANK 2026-10-24 用户口径] 【两套口径前十对照 · 复盘专用】
  //   用户原话：「复盘时出现困惑。你有没有办法让我复盘时，只看竞价口径的排名结果，
  //     但是收盘时我也想看，竞价口径我也想看原始的是怎么排名的。」
  //   ⇒ 这一条【永远】给（不限于「今天要不要用候补」）：复盘时最想知道的是「这一批名单
  //     两套口径下差在哪」，而不是「今天恰好有没有候补」。
  //   ⚠️ 三条安全降级全在 _range10DualTopText 里：池子没给 / 名次表空 ⇒ 不写（§10）；
  //      两套名单完全一致 ⇒ 不写（§11 零噪声，老调用方不传 pctMap 时必然走这条）。
  if (r10PoolGiven) {
    const r10DualTopText = _range10DualTopText(r10Rank926, r10RankClose, PRESENCE_TOP_N);
    if (r10DualTopText) out.notes.push(r10DualTopText);
  }


  // ★ [EBB-R20b 2026-10-20] 二次确认 + 常规选出 ⇒ 这些票是【今天真要买的】：
  //   卖点侧放行（保持 buildSellPlan 自己的结论 —— 通常 = 今天又进买点 ⇒ 持有 / 先卖后买），
  //   与替补的放行同一不变式：同一天不可能既「今天要买」又「竞价清仓」。首次退潮不在此列
  //   （那些票今天不买 ⇒ 卖点照旧一律竞价卖）。
  const regularPickNames = new Set();
  if (ebbSecondRegular) {
    out.blocks.forEach(function(b) {
      (b.picks || []).forEach(function(p) { if (p && p.name) regularPickNames.add(p.name); });
    });
    // 每行说明加注（用户原话「说明文字那里该加一句，主线AI应用二次确认退潮，作为补涨题材选出的股票」）。
    //   ⛔ 必须排在所有 actionNote 覆盖（finishBuyBlock / 空仓提醒改写）之后 —— 追加，不覆盖任何信息。
    //   ★ [EBB-WHY 2026-10-22 用户口径] 追加【判定依据】事实句 —— 与卖点侧横幅完全同款句式：
    //   「市场总龙【X】（题材，20日涨幅 +N%）今日竞价占比 P% ＜ 龙头门槛 3.5% ⇒ 判定为【…二次确认退潮】
    //     （题材退潮：总龙停牌 / 占比不符 ⇒ 整个题材的股票预期走势差）」。
    //   用户原话：「买点侧的提示词你没写为什么退潮，怎么判定的，很困惑……就写得很清楚（指卖点侧），所以你补充下买点侧描述」。
    const ebbWhySentence = '判定依据：市场总龙【' + (out.ebb.leaderName || '—') + '】（' +
      (out.ebb.leaderTopic || '—') + '，20日涨幅 ' + (out.ebb.leaderPctText || '—') + '）' +
      (out.ebb.whyText || '—') + ' ⇒ 判定为【' + (out.ebb.phaseTitle || '题材退潮') + '】' +
      '（题材退潮：总龙停牌 / 占比不符 ⇒ 整个题材的股票预期走势差）。';
    const tail = '主线' + (out.ebb.leaderTopic || '总龙题材') + '二次确认退潮，作为补涨题材选出的股票' +
      '（本题材是排除退潮题材后、按题材平均竞价量比常规选出的补涨题材）。' + ebbWhySentence;
    out.blocks.forEach(function(b) {
      (b.picks || []).forEach(function(p) {
        if (p && p.name) p.actionNote = (p.actionNote ? p.actionNote + ' ' : '') + tail;
      });
    });
    // ★ [EBB-R20c 2026-10-20 用户口径] 买点侧顶部的【节点说明】：用户原话「这是个退潮节点大方向，
    //   主线题材出现退潮后，新的题材符合条件，这些题材叫做补涨题材，因为这是个节点很重要，
    //   可能接下来会出现轮动行情，也就是后期排名第一或者第二的题材不断变化，会进入了常规选股规则」。
    //   ⛔ 纯说明文字（不改任何选股 / 标签 / 灰化逻辑）；文案全在 Logic 层（§21 模板零计算）。
    //   ★ [EBB-WHY 2026-10-22] detail 句首补判定依据事实句（与卖点侧横幅同款，判定可追溯）。
    out.ebbNodeNote = {
      headline: '⚠️ 主线' + (out.ebb.leaderTopic || '总龙题材') + '二次确认退潮 · 退潮节点（新题材 = 补涨题材）',
      detail: ebbWhySentence +
        '主线题材【' + (out.ebb.leaderTopic || '总龙题材') + '】二次确认退潮，这是一个重要的【退潮节点】：' +
        '主线退潮后，今天符合常规（平均竞价量比）条件的新题材叫做【补涨题材】（买点侧已按常规选股规则排除退潮题材选出）。' +
        '接下来可能出现【轮动行情】—— 排名第一、第二的题材会不断变化，买点侧随之进入【常规选股规则】' +
        '（按题材平均竞价量比选股，退潮题材不再参与）。卖点侧照旧收紧。'
    };
  }

  // ★★ [EBB-R20 2026-10-20 用户口径] 退潮日【买点侧兜底替补 · ≤2 只】：
  //   「从20日涨幅中的总龙一到总龙五选出两只排名靠前的……只选好两只，已经完成任务，后面不选了」。
  //   ★ [EBB-R20b 2026-10-20 用户口径] 兜底语义（用户本轮原话「如果排名前二的新题材都没有符合条件，
  //     兜底就是选总市场的排名前面的龙，所以才回到20日涨幅选股法」）：
  //     · 【首次退潮】⇒ 替补照旧（主线第一次坏，买点侧除替补外没有别的买点）；
  //     · 【二次确认】⇒ 只当常规选不出（blocks 为空）才启用替补；常规选出了补涨题材 ⇒ ebbBuy 恒 null。
  //   ⛔ 顺序（三步都不能换）：
  //     ① `_applyEbbBuyRules` 先跑完（把【常规题材块】的每行改成【退潮不买】+ 整段灰化）
  //        —— 用户拍板：这些票【照旧列出来】（灰化空仓视觉保留），只是不再有买点；
  //     ② 再构造替补块（它走 finishBuyBlock，拿到客观数据与原始买点信号，然后换成专属标签）
  //        —— 若反过来，第 ① 步会把它也打成【退潮不买】（那这些替补买点就没了）；
  //     ③ 同时挂进 `buy.ebbSecond` 槽位，让四个装饰器（量比趋势 / 名次变化 / 封单额 / 停牌）
  //        照常给它挂客观数据（§6 共用同一次遍历）。
  //   §10：20日前五未就绪 / 一只替补都选不出 ⇒ 构造返回 null ⇒ 买点侧不出现这一段
  //        （⛔ 绝不拿别的名次顶替），空仓标语会如实改口径（见 detectEbbDay）。
  // ★★ [CYCLE 2026-10-22 用户口径] 切换日【不得再走退潮替补】——
  //   用户 10-22 报障：「买点侧选的是九阳股份、冰山冷热，而冰山冷热下面还有重复的一次」。
  //   根因：误判成【首次退潮】⇒ 退潮替补那一路和切换日新龙那一路【同时】输出，
  //   于是九阳（20 日内多次进前五，本不该入选）+ 冰山（与新龙重复）一起冒了出来。
  //   ⇒ 一条硬闸：切换日 ⇒ 退潮替补恒为 null（当天买点侧只有「新龙 + 常规收紧那一只」）。
  out.ebbBuy = (out.ebb && !ebbSecondRegular && !out.switchDay)
    ? _buildEbbPicksBlock(out.ebb, list, fOpts)
    : null;
  if (out.ebbBuy) out.buy.ebbSecond = out.ebbBuy;

  // ★★ [SWITCH-DEDUPE 2026-10-22 用户口径] 买点侧【全局同名去重】：新龙那一行优先。
  //   用户原话：「下面还有重复的冰山冷热」——同一只票在买点侧只能出现一次。
  //   ⛔ 只删「常规块里与新龙重名的那一只」，块本身保留（用户口径是「不要重复」，不是「不要题材」）；
  //     块里被删空 ⇒ 该块整块移出（否则会渲染一个空题材）。客观数据一行不动。
  if (out.newDragon) {
    const ndNames = new Set();
    (out.newDragon.picks || []).forEach(function(p) { if (p && p.name) ndNames.add(String(p.name).trim()); });
    if (ndNames.size > 0) {
      const kept = [];
      out.blocks.forEach(function(b) {
        const before = (b.picks || []).length;
        b.picks = (b.picks || []).filter(function(p) { return !(p && ndNames.has(String(p.name || '').trim())); });
        const removed = before - b.picks.length;
        if (removed > 0) {
          if (!Array.isArray(b.notes)) b.notes = [];
          b.notes.push('本块有 ' + removed + ' 只已作为【' + NEW_DRAGON_TAG + '】列在上方 ⇒ 这里不重复显示。');
        }
        if ((b.picks || []).length > 0) kept.push(b);
      });
      out.blocks = kept;
      // 决策看板形状的三槽位要跟着重建（否则清空后的块还挂在 buy.heavy / buy.light 上）
      out.buy.heavy = null;
      out.buy.light = null;
      out.buy.candidates = [];
      out.blocks.forEach(function(b, i) {
        if (i === 0) out.buy.heavy = b;
        else if (i === 1) out.buy.light = b;
        else out.buy.candidates.push(b);
      });
    }
  }

  // ★★ [EBB-R8 2026-10-14 用户口径] 落库行：把今天的退潮【判定】存下来，供明天判「是不是首日」。
  //   ⛔ 与 out.ebb 的区别：out.ebb 带首日闸门（昨天已退潮 ⇒ 今天 null），本行不带 ——
  //      本行回答的是「今天这只总龙到底在不在坏状态」，这正是明天那个闸门的输入（§6 同一把尺子）。
  //   ⚠️ 只在【有事实】时产出（§10）；写不写（今天 / 历史日）由组合式把关，本层不做时间判断。
  out.ebbDayRow = buildEbbDayRecord(out.ebb, o.ebbCtx || null, o.date);

  // ★★ [R20-926 2026-10-24 用户口径] 买点侧【20日涨幅通道】的入选票：补一条「9:26 那一刻的涨幅 + 名次」。
  //   ⛔ 必须放在 ebbBuy / newDragon 都造好之后（它俩就是这条通道的全部产出）；
  //   ⛔ 只写事实（用户「你不要解释」）；9:26 口径判不出 ⇒ 一行都不写（§10，见函数注释）。
  _appendRange20AucNote(out, o.range20Auc || null, o.ebbCtx || null);

  // 买点名单（喂给卖点判「今天又进买点 ⇒ 持有」）
  out.blocks.forEach(function(b) {
    (b.picks || []).forEach(function(p) { if (p && p.name) out.buyNames.add(p.name); });
  });
  // ★ [EBB-R8 2026-10-14] 退潮首日唯一那只【市场龙二】同样是「今天进买点」⇒ 进名单（§6 同一个集合）。
  //   作用：它若昨天已经买过（也在卖点侧），卖点侧会标【持有】而不是被要求清仓 ——
  //   「今天唯一要买的票」与「今天要竞价卖掉」不可能同时成立（见下方 _applyEbbSellRules 的放行）。
  if (out.ebbBuy) {
    (out.ebbBuy.picks || []).forEach(function(p) { if (p && p.name) out.buyNames.add(p.name); });
  }
  // ★★ [SWITCH 2026-10-22] 切换日的【新龙】同样是「今天进买点」⇒ 进名单（同一不变式）：
  //   它若昨天已在卖点侧候选里，卖点侧要标【持有】而不是「竞价清仓」（同一天不可能既买又清）。
  if (out.newDragon) {
    (out.newDragon.picks || []).forEach(function(p) { if (p && p.name) out.buyNames.add(p.name); });
  }
  // ★★ [R10-BACKUP 2026-10-24] 第二十九条的【十日涨幅候补】同样是「今天进买点」⇒ 进名单（同一不变式）：
  //   它若昨天已在卖点侧候选里，卖点侧要标【持有】而不是「竞价清仓」（同一天不可能既买又清）。
  if (out.range10Backup) {
    (out.range10Backup.picks || []).forEach(function(p) { if (p && p.name) out.buyNames.add(p.name); });
  }
  // ★★ [EBB-D1 2026-10-21 用户口径] 第二十六条：禁入题材的票【不进买点名单】——
  //   它们今天不买（「不用去掉」只针对【展示】，不针对【买点名单】）：
  //   若留在名单里，卖点侧会因「今天又进买点」把它们标成【持有】，与「次日禁止买入」正面矛盾。
  //   （与退潮题材被 [EBB-R20b] 排除出选股 ⇒ 同样不进名单，是同一不变式。）
  if (prevSecondEbb) {
    out.blocks.forEach(function(b) {
      if (!b || !b.prevEbbGray) return;
      (b.picks || []).forEach(function(p) { if (p && p.name) out.buyNames.delete(p.name); });
    });
  }
  // ★★ [LEADER-LIMITDOWN 2026-11-02 用户口径] 第三十二条：龙一竞价跌停的那个题材【今天不买】⇒
  //   它的票不进买点名单（否则卖点侧会因「今天又进买点」把它们标成【持有】—— 与「本题材不选」正面矛盾）。
  //   与上面 [EBB-D1] 的剔除是同一条不变式（展示保留、名单剔除）。
  if (out.leaderLimitDown) {
    out.blocks.forEach(function(b) {
      if (!b || !b.leaderLimitDownGray) return;
      (b.picks || []).forEach(function(p) { if (p && p.name) out.buyNames.delete(p.name); });
    });
  }
  // ★★ [LEADER-LIMITDOWN 2026-11-02 用户口径] 反面同理：抱团那一只（市场总龙一）是【今天真要买】的票
  //   ⇒ 进买点名单（同一不变式：它若昨天已在卖点侧候选里，卖点侧要标【持有】而不是「竞价清仓」）。
  //   ⚠️ 只在本条命中时加 —— 第三十条那条通道进不进名单是它自己的既有行为，⛔ 不顺手改动（§11）。
  if (out.leaderLimitDown && out.weakHuddle) {
    (out.weakHuddle.picks || []).forEach(function(p) { if (p && p.name) out.buyNames.add(p.name); });
  }

  // ★★ [ABNORMAL-10D 2026-11-13 用户口径] 第三十四条【监管异动 · 十日涨幅硬上限】——
  //   ★ 为什么收口放在【这里】（所有买点通道都建完之后、卖点段之前）：
  //     · 常规题材块（out.blocks）/ 退潮替补 / 新龙 / 十日候补 / 弱势抱团 / 补涨题材 的票
  //       到这一刻才全部齐活 ⇒ 才能一次判「今天有没有票踩到自定义禁选上限 / 100% 红线」；
  //     · 它必须在【卖点段之前】：异动日「不买任何票」⇒ out.buyNames 要清空，
  //       否则卖点侧会把昨天买过的票标成【持有】（= 「今天又进买点」），与空仓直接矛盾。
  //   ⛔ 本调用只做「判定 + 收口」，⛔ 不取数：总龙一身份/涨幅由组合式注入（opts），§4 无副作用。
  const _abnLeaderName = (o.ebbCtx && Array.isArray(o.ebbCtx.top5) && o.ebbCtx.top5[0])
    ? String(o.ebbCtx.top5[0].name || '').trim() : '';
  const _abnLeaderTopic = (o.ebbCtx && Array.isArray(o.ebbCtx.top5) && o.ebbCtx.top5[0])
    ? String(o.ebbCtx.top5[0].topic || '').trim() : '';
  // 今日十日涨幅：9:26 竞价口径优先（与买点侧选股同一把尺子 §6）；缺 ⇒ 成员行（= 屏幕同一列）；再缺 ⇒ null（§10）
  const _abnPctToday = _rangePctOfMap(o.pctMap, _abnLeaderName);
  // 昨日：竞价口径（prevAuctionLeg10）优先，读不到才退回收盘口径（prevRange10）—— 用户原话
  //   「东方海洋，昨天竞价口径就超过 100% 了」；用了哪一份要如实带出（§10 口径不许含糊）。
  const _abnPctPrevAuc = _rangePctOfMap(o.prevAuctionLeg10, _abnLeaderName);
  const _abnPctPrevClose = _rangePctOfMap(o.prevRange10, _abnLeaderName);
  // ★★ [ABN-SAME-SOURCE 2026-11-13 用户报错后修] 第三十四条触发源的取数铁律：
  //   【名字 / 涨幅 / 口径 / 是不是总龙一】永远绑定在同一只票上，⛔ 不许拆开赋值。
  //
  //   事故现场（用户原话）：「11月13日提示那个就有错误，上面说市场总龙一闵发铝业十日涨幅
  //   100.78%，根本不是，不知道这些数据从哪里来，相差太大了」。库内真实数据：
  //     · 11-13 今日竞价口径最高 = 闽发铝业 84.88%（它昨日 87.04%）
  //     · 11-12 昨日竞价口径最高 = 东方海洋 100.78%
  //     · 闽发铝业 11-13 二十日涨幅仅 48.56%，二十日总龙一 = 东方海洋 135.61%
  //   旧实现的三处错误：①「今日分支」把名字换成闽发铝业；②「昨日分支」只把数值换成
  //   东方海洋的 100.78%；③ 文案还硬写「市场总龙一」⇒ 拼出「闵发铝业 100.78%」，
  //   数值差 13~16 个点、称谓也错。
  //   ★ 修复 = 判据抽成纯函数 `pickAbnormalSource`（§15 可单测），本文件只负责【从 Map 取候选】。
  // ★★ [ABN-MAINBOARD 2026-11-13 用户口径] 第三十四条只认主板 —— 非主板（创业板/科创板/北交所）
  //   既不参与「全市场十日涨幅最高票」评选，也不作为触发源。判据 = isMainBoardRankEligible（§6 同一把尺子）。
  const _abnEligible = makeAbnMainBoardFilter(isMainBoardRankEligible, getStockCode);
  const _abnPick = pickAbnormalSource({
    leaderName: _abnLeaderName,
    leaderTopic: _abnLeaderTopic,
    leaderToday: _abnPctToday,
    leaderPrevAuc: _abnPctPrevAuc,
    leaderPrevClose: _abnPctPrevClose,
    marketToday: maxRangePctOf(o.pctMap, _abnEligible),
    marketPrevAuc: maxRangePctOf(o.prevAuctionLeg10, _abnEligible),
    marketPrevClose: maxRangePctOf(o.prevRange10, _abnEligible)
  });

  // 定了触发源之后，两个数字都【按这个名字重新取】—— ⛔ 绝不用别的票的数值顶替
  let _abnName = _abnPick.name || _abnLeaderName;
  let _abnTopic = _abnPick.topic || (_abnPick.triggered ? '' : _abnLeaderTopic);
  let _abnIsTop1 = _abnPick.isTop1;
  let _abnToday = _rangePctOfMap(o.pctMap, _abnName);
  let _abnPrevAuc = _rangePctOfMap(o.prevAuctionLeg10, _abnName);
  let _abnPrevClose = _rangePctOfMap(o.prevRange10, _abnName);
  let _abnPrev = (_abnPrevAuc !== null) ? _abnPrevAuc : _abnPrevClose;
  let _abnBasis = (_abnPrevAuc !== null) ? 'auction' : (_abnPrevClose !== null ? 'close' : '');
  // §10：同一只票的数字读不到 ⇒ 用成员行那份（屏幕同一列，§6 同一份真相），⛔ 不补 0
  if (_abnToday === null) _abnToday = _nearestMemberPct(list, _abnName);
  if (_abnPrev === null) _abnPrev = _nearestMemberPct(list, _abnName);
  _applyAbnormalSweep(out, {
    leaderName: _abnName,
    leaderTopic: _abnTopic,
    leaderIsTop1: _abnIsTop1,
    leaderPctToday: _abnToday,
    leaderPctPrev: _abnPrev,
    leaderPctPrevBasis: _abnBasis
  });

  // ★ 卖点段 —— decision-rules 的【同一份实现】；⛔ 候选池不依赖本看板选股（= 昨日打过买标签的票），
  //   只有「今天又进买点」这一条换成【本看板自己的名单】（本看板内部自洽）。
  const sellRows = o.sellRows || [];
  // ★★ [SELL-EMPTY-GUARD 2026-11-12] 卖点成员来源统计（auto/buy/hold/excludedSell/planKnown/tagsKnown）——
  //   只给 UI 判「空态该说什么」（「没有票」vs「标签库没读回，可能缺票」，§10）。
  //   ⛔ 不参与任何选股 / 卖出判定。
  if (o.sellMemberStats) out.sellMemberStats = o.sellMemberStats;
  if (sellRows.length > 0 && list.length > 0) {
    out.sell = buildSellPlan(sellRows, list, dragonMap, ctx.prevDragonNames || null, out.buyNames);
    // ★ [SELL-AVG-VR 2026-10-11 用户报障] 卖点侧题材标题行也要显示【平均竞价量比】——
    //   用户原话：「题材量比看板的卖点侧，题材的平均量比数值没有显示出来，只出现 -，这个符号。修复下」。
    //   根因（两处叠加，缺一不可）：① 分组 g 是 buildSellPlan 产出的（那是决策看板的实现，
    //   它压根不知道「平均量比」这回事）⇒ g 上没有这个值；② 卖点标题行渲染的是 TvrbTopicHead，
    //   它读的 prop 叫 avg-vol-ratio ⇒ 调用点没传就回落到 '—'。
    //   口径：按 g.topic 从【本函数已经排好序的题材清单 list】里反查同一个题材块，
    //   用【同一个】avgVolRatioOf 算（§6 ⛔ 绝不在卖点通路里另写一份平均量比实现）。
    //   ⚠️ 卖点候选 = 昨天买过的票，它所在的题材【今天可能根本没成组】⇒ 查不到 ⇒ 如实给 '—'
    //      （§10：未知 ≠ 量比 0）。
    const topicByName = new Map();
    list.forEach(function(b) { topicByName.set(String(b.topic || ''), b); });
    const avgTextOf = function(topic) {
      const b = topicByName.get(String(topic || ''));
      return b ? formatAvgVolRatio(avgVolRatioOf(b)) : formatAvgVolRatio(null);
    };
    // 十日涨幅文案：buildSellPlan 只给数值（决策看板的卖点组件是在模板里自己 format 的），
    // 本文件按 §21「模板零计算」的口径统一在这里补上（⛔ 不在组件里再 format 一次）。
    out.sell.forEach(function(g) {
      if (!g.avgVolRatioText) g.avgVolRatioText = avgTextOf(g.topic);
      (g.items || []).forEach(function(it) {
        if (!it.pctText) it.pctText = formatRangePct(it.pct);
      });
    });
    // ★ [EBB 2026-10-13 第五轮用户口径] 退潮首日 ⇒ 卖点动作【覆盖式】重写：
    //   只有【同题材可用龙位】【市场总龙二】两只标「看分笔卖」（等开盘看分笔、不看占比），
    //   其余（含原本标【持有】的）一律改【竞价卖】。
    //   ⛔ 排在平均量比 / 涨幅文案补全【之后】：那两项是客观数据，本改写一律不碰。
    if (out.ebb) _applyEbbSellRules(out.sell, out.ebb, ebbSecondRegular ? regularPickNames : null);
  }

  // ★★ [TVRB-DATA-GATE 2026-11-04 用户口径 · 第七轮] 数据缺失 ⇒ **硬空仓**（fail-closed）。
  //
  // 用户原话：「题材没有平均量比的时候，题材量比看板选股就不能选票了，应该空仓或者提醒用户修复
  //   程序数据，那里应该有一个专门的提示板，写出不能选票的理由……还交代了选股条件的数据缺失，
  //   也不能选票，比如竞价量比，20日涨幅，10日涨幅缺失等，数据缺失都不要选股，要有提示，
  //   如果竞价量比缺失选出的票本身就是错误的，只会误导。不要把股票放进去了，这是个常识」
  //
  // ⛔ 为什么清在【规则层】而不是让视图「不渲染」：清在这里 = 任何消费方（未来的新组件 /
  //   导出 / 分笔预取 / 统计条）都拿不到票，是真正的 fail-closed；只在视图加 v-if 的话，
  //   以后任何一条新通道读到 out.blocks 就又把票放出去了（那是最难查的一类回归）。
  // ⚠️ 判据本体在 `logic/topicvolratio/buy-data-gate.js#resolveBuyDataGate`（纯函数 + 单测），
  //   本函数只负责「清」，⛔ 不在这里判覆盖率（判定唯一出口，§6）。
  // 🔴 维护提醒：以后新增买点槽位（out.xxx / out.buy.xxx），**必须同步加进这个函数**，
  //   否则「数据缺失日」新槽位会把票漏出去。`buy-data-gate.test.js` 有锁。
  if (o.dataGateBlocked) _clearBuySideForDataGate(out);

  // ★★ [TVRB-AUC-YIZI 2026-11-10 用户口径] 竞价一字涨停的票【照常选进】，但要统一标注
  //   「竞价一字涨停 · 等开板后进」。⛔ 不改任何选股过滤（常规块的一字顺延是 10-15 用户拍板口径）。
  //   收口在 return 前 + 数据闸门之后：既覆盖全部买点通道，也不会给「数据缺失硬空仓」日留脏标记。
  annotateAuctionYizi(out);

  // ★★ [R10-NOEXCLUDE 2026-10-24] 「选股 N 只」按【去重后的股票数】算：
  //   同一只票可能同时出现在「灰化题材块 + 十日涨幅候补」或「题材买点 + 十日涨幅候补」里
  //   （用户口径：两条通道叠加是确定性，两处都展示）⇒ 数行数会把它算成两只，与实际能下单的只数不符。
  const _pickSeen = new Set();
  const _countUnique = function(arr) {
    (arr || []).forEach(function(p) {
      const nm = String((p && p.name) || '').trim();
      if (nm) _pickSeen.add(nm);
    });
  };
  // ★★ [LEADER-LIMITDOWN 2026-11-02] 第三十二条：龙一竞价跌停那个题材【今天不买】⇒ 它的票不计入
  //   「实际选出几只」（用户口径「数只数」数的是【今天能下单的】；那一块的票只作展示）。
  out.blocks.forEach(function(blk) {
    if (blk && blk.leaderLimitDownGray) return;
    _countUnique(blk.picks);
  });
  // ★ [SWITCH 2026-10-22] 新龙那一只也要计入「实际选出几只」（summary 文案读它）
  if (out.newDragon) _countUnique(out.newDragon.picks);
  // ★★ [R10-BACKUP 2026-10-24] 十日涨幅候补那一只同理（它就是今天能不能下单的那一只）
  if (out.range10Backup) _countUnique(out.range10Backup.picks);
  // ★★ [WEAK-HUDDLE 2026-10-27] 弱势切抱团那一只同理（今天唯一还能买的就是它）。
  //   ⚠️ 它通常【同时】在下面那个灰化题材块的 picks 里（同一只票、两条通道）—— _pickSeen 是
  //   【按名字去重】的 Set，所以这里再数一遍不会把「实际能下单的只数」数多（用户口径「数只数不数行数」）。
  if (out.weakHuddle) _countUnique(out.weakHuddle.picks);
  // ★★ [CATCH-UP 2026-10-27] 补涨题材那几只同理（与弱抱团同一个理由：按名字去重，不数多）。
  if (out.catchUp) _countUnique(out.catchUp.picks);
  out.pickCount = _pickSeen.size;
  // ★★ [ABNORMAL-10D 2026-11-13 用户口径] 第三十四条：监管异动日「不再选票」⇒ 一律按 0 只计。
  //   ⚠️ 票【仍然列在屏幕上】（用户「不用去掉」），只是不计入「选出 N 只」——
  //     数的是【今天能下单的只数】，异动日一只都不能下单，所以必须是 0（与第三十二条同一条口径）。
  if (out.abnormal && out.abnormal.show) out.pickCount = 0;

  if (out.excludedTopics.length > 0) {
    const names = out.excludedTopics.map(function(t) {
      return t.topic + '（' + t.count + ' 只，量比 ' + formatAvgVolRatio(t.avgVolRatio) + '）';
    }).join('、');
    out.notes.push('⚠️ 按平均竞价量比排名靠前、但股票数量不足 ' + TVRB_MIN_COUNT +
      ' 只 ⇒ 不入选并顺延到下一题材：' + names);
  }
  // ★ [R10-BACKUP] 第二题材因【量比太小】被整块作废时，不再报「只有 1 个题材满足条件」——
  //   那样读起来像「今天本来就没第二个题材」，与事实（有、但被作废）相反（§10 不许含糊）。
  // ★ [SECOND-LEADER-10 2026-10-24] 第二题材被【龙一没进前十】否掉时同理：不再报「只有 1 个题材
  //   满足条件」—— 那是「今天本来就没第二个题材」的读法，与事实（有、但没带动性）相反（§10 不许含糊）。
  // ★ [SMALL-TOPIC 2026-10-24] 第一题材被【小题材收紧】弃掉时同理（见 r10SmallDropped 的注释）。
  // ★ [TOPIC-CASCADE 2026-10-28] 第二题材因【第一题材自己就不达标】而整条线未启用时同理：
  //   那时已经有「整体前提」那一条说明，再报「只有 1 个题材满足条件」会读成「今天本来没第二个题材」，
  //   与事实（有、但按口径不考虑）相反（§10 不许含糊）。
  if (out.blocks.length < TVRB_TOPIC_LIMIT && list.length > 0 &&
      !r10RemovedSecond && !r10SecondNoLead && !r10SmallDropped && !firstTopicGate) {
    out.notes.push('当日只有 ' + out.blocks.length + ' 个题材满足条件（数量 ≥ ' + TVRB_MIN_COUNT +
      ' 只），不足 ' + TVRB_TOPIC_LIMIT + ' 个。');
  }
  // ★★ [TOPIC-CASCADE 2026-10-28 用户口径] 第一题材自己不达标 ⇒ 第二十九条整条不启用时，如实说一句。
  //   ⛔ 沉默会让人以为「今天本来就没有十日涨幅候补」（§10 判不出 / 不启用 ≠ 没有）。
  //   ⚠️ 只在【没有】`firstTopicGate` 那条说明时补（两块的情形已经说过一次，⛔ 不重复）；
  //      典型 = 当天只有一个入选题材、它自己 < 25（10-23 就是这种形状）。
  if (r10Enabled && r10LeadWeak && !firstTopicGate) {
    out.notes.push('⚠️【第' + RANGE10_BACKUP_RULE_NO + '条 · 十日涨幅候补】排名第一的入选题材【' +
      String((out.cashAlert && out.cashAlert.topic) || (out.blocks[0] && out.blocks[0].block &&
        out.blocks[0].block.topic) || '') + '】平均竞价量比 ' +
      String((out.cashAlert && out.cashAlert.avgVolRatioText) || '') +
      ' ＜ ' + TVRB_CASH_ALERT_AVG_VR + ' ⇒ 最强题材自己不达标（整体已经算差）⇒ ' +
      '本通道【不启用】：不用十日涨幅去补一个更弱的题材。当天买不买，只看第一题材自己的候补规则' +
      '（第三十条【弱势切抱团】/ 第三十一条【补涨题材】），它们也不生效时当天就是空仓。');
  }
  if (out.sell.length > 0) {
    out.notes.push('卖点候选 = 上一交易日打过「买」标签的股票（与决策看板同一份数据源）；' +
      '「今天又进买点 ⇒ 持有」用的是【本看板自己选出来的买点名单】。');
  }

  return out;
}

/**
 * ★★ [ABNORMAL-10D 2026-11-13 用户口径] 第三十四条【监管异动 · 十日涨幅硬上限】的收口（只判 + 只改，不取数）。
 *
 * 用户原话（见 tvrb-constants.js 第三十四条常量块；11-13 早间）：
 *   「十日涨幅竞价口径不能超过 95%……十日达到 100% 异动，提示空仓，选出的票整块变灰色（不用去掉），
 *     还有总龙一异动次日……也要空仓，不再选票……不在买进任何股票。」
 * ★ [CAP-97 2026-11-13 晚间修订] 自定义禁选上限 95 → 97（让 11-11 的 95.711445% 正常运行）；
 *   ⚠️ 本收口只判【≥100 ⇒ 全市场空仓】，97~100 的票 / 题材级禁选由 `_buildBlock` 与候补闸门负责。
 *
 * 三步（顺序不能反）：
 *   ① 判事实（`resolveAbnormalFact`，纯函数）：总龙一昨日 ≥100 ⇒ 异动次日；今日 ≥100 ⇒ 当日异动；
 *      某只【会被选中的票】≥100 ⇒ 票级异动。⛔ 只喂【十日涨幅】口径的票（常规块 picks + 十日候补），
 *      ⛔ 绝不把 20日涨幅通道（退潮替补 / 新龙 / 抱团 / 补涨）的 pct 塞进来（口径串用比不判更坏）。
 *   ② 命中 ⇒ 空仓标语接管 `cashAlert`（视图的整段灰化条件就是它，⛔ 不新造第二套灰化）；
 *      逐行覆盖成【异动不买】（`_applyAbnormalNoBuyRules`），客观数据一行不动。
 *   ③ 清掉【今天还能买】的特殊通道（退潮替补 / 新龙 / 十日候补 / 弱势抱团 / 补涨题材 / 分歧买点）：
 *      用户「不再选票」「不再买进任何股票」—— 留着它们等于在空仓日还给一份买入清单。
 *      同时清空 `buyNames` ⇒ 卖点侧不会把昨天买过的票标成【持有】（「今天又进买点」自相矛盾）。
 *
 * ⛔ 票【不删】（用户「不用去掉」）：blocks 与 picks 原样保留，只改标签 + 加灰化旗子。
 * ⛔ 卖点侧一行不动。
 *
 * @param {object} out buildTopicVolRatioPlan 正在组装的计划对象（原地改）
 * @param {{leaderName?:string, leaderTopic?:string, leaderIsTop1?:boolean,
 *          leaderPctToday?:number|string|null, leaderPctPrev?:number|string|null,
 *          leaderPctPrevBasis?:string}} [opts]
 *        ★ [ABN-SAME-SOURCE] 这几个字段必须描述【同一只票】：`leaderName` 是触发源那
 *        一只，`leaderPctToday` / `leaderPctPrev` 都是它自己的数值，`leaderIsTop1`
 *        说明它是不是二十日涨幅总龙一（false ⇒ 文案写「市场十日涨幅最高票」）。
 * @returns {object} 判定出的异动事实（与 TVRB_ABNORMAL_NONE 同形状；show=false ⇒ 零改动）
 */
export function _applyAbnormalSweep(out, opts) {
  if (!out) return TVRB_ABNORMAL_NONE;
  const o = opts || {};
  // ① 会被选中的票（只收【十日涨幅】口径的那两处）
  const rows = [];
  (out.blocks || []).forEach(function(b) {
    const topic = (b && (b.topic || (b.block && b.block.topic))) || '';
    ((b && b.picks) || []).forEach(function(p) {
      if (p && p.name) rows.push({ name: p.name, topic: topic, pct: p.pct });
    });
  });
  if (out.range10Backup) {
    (out.range10Backup.picks || []).forEach(function(p) {
      if (p && p.name) rows.push({ name: p.name, topic: p.topic || '十日涨幅候补', pct: p.pct });
    });
  }
  const fact = resolveAbnormalFact({
    leaderName: o.leaderName,
    leaderTopic: o.leaderTopic,
    leaderIsTop1: o.leaderIsTop1,
    leaderPctToday: o.leaderPctToday,
    leaderPctPrev: o.leaderPctPrev,
    leaderPctPrevBasis: o.leaderPctPrevBasis,
    rows: rows
  });
  out.abnormal = fact;
  if (!fact.show) return fact;

  // ② 标语 + 逐行覆盖（异动优先级最高 ⇒ 覆盖掉退潮 / 分歧 / 量比低三种已有改写）
  out.cashAlert = buildCashAlert(null, null, fact);
  _applyAbnormalNoBuyRules(out.blocks, fact);
  if (out.range10Backup) _applyAbnormalNoBuyRules([out.range10Backup], fact);

  // ③ 清掉「今天还能买」的通道（⛔ 别只清 out.*：out.buy.* 是同一批票的第二份引用，
  //    四个装饰器经 decision-collect#_buyBlocksOf 遍历它）
  out.ebbBuy = null;
  out.divergeBuy = null;
  out.newDragon = null;
  out.range10Backup = null;
  out.weakHuddle = null;
  out.catchUp = null;
  out.ebbNodeNote = null;
  if (out.buy) {
    out.buy.ebbSecond = null;
    out.buy.newDragon = null;
    out.buy.range10Backup = null;
    out.buy.weakHuddle = null;
    out.buy.catchUp = null;
  }
  out.buyNames = new Set();

  out.notes.push('🚨【第' + ABNORMAL_RULE_NO + '条 · 全场监管异动】' +
    (fact.kind === ABNORMAL_KIND_NEXT_DAY
      ? ((fact.leaderLabel || '市场总龙一') + '【' + (fact.leaderName || '—') + '】昨日十日涨幅 ' +
         (fact.leaderPctPrevText || '—') + ' ＞ ' + TVRB_RANGE10_CAP + '% ⇒ 今天是【异动次日】')
      : (fact.kind === ABNORMAL_KIND_LEADER_NOW
        ? ((fact.leaderLabel || '市场总龙一') + '【' + (fact.leaderName || '—') + '】今日十日涨幅 ' +
           (fact.leaderPctTodayText || '—') + ' ＞ ' + TVRB_RANGE10_CAP + '% ⇒ 今日异动')
        : ('入选票 ' + (fact.names || []).join('、') + ' 十日涨幅 ＞ ' + TVRB_RANGE10_CAP + '%'))) +
    ' ⇒ 【整个市场整片灰 + 空仓】，今天一张票都不买（用户：总龙一影响范围波及到所有的票）。' +
    '⚙️ 已同时下线：退潮替补 / 新龙 / 十日涨幅候补 / 弱势切抱团 / 补涨题材 ' +
    '（用户口径：「不再选票」「不再买进任何股票」）。⚠️ 下方股票仍照原规则列出（不删不改），' +
    '买点标签一律【' + ABNORMAL_NO_BUY_TAG + '】、不计入「选出 N 只」；卖点侧不受影响。' +
    '📌 判定口径：十日涨幅（竞价口径）＞ ' + TVRB_RANGE10_CAP + '% 即【全场禁买】' +
    '（[CAP-97] 由 95 上调，11-11 的 95.71% 正常运行）；达到 ' + TVRB_RANGE10_ABNORMAL +
    '% 是交易所「严重异常波动」，只说明程度更重、⛔ 后果完全相同（⛔ 不再有票级顺延）；十日涨幅 = ' +
    (fact.leaderPctPrevBasis === 'auction' ? '昨日按【竞价口径】' : '昨日按【收盘口径】（竞价口径那份未读到）') + '。');
  return fact;
}

/**
 * ★★ [TVRB-DATA-GATE 2026-11-04 用户口径 · 第七轮] 数据缺失 ⇒ 把【买点侧的一切票】清空。
 *
 * 注入点：`buildTopicVolRatioPlan` 里 `o.dataGateBlocked === true` 时、算 `pickCount` 之前。
 * 判据：`logic/topicvolratio/buy-data-gate.js#resolveBuyDataGate`（谁缺了、为什么缺、怎么修）。
 *
 * 清的东西分两类（⛔ 别只清一类）：
 *   ① `out.*` —— 视图直接渲染的那几个容器（blocks / 退潮替补 / 分歧买点 / 新龙 / 十日候补 /
 *      弱势抱团 / 补涨题材 / 节点说明 / 空仓提醒）；
 *   ② `out.buy.*` —— 买点对象里给【四个装饰器】遍历的那几个槽位。⚠️ 它们与 ① 是**同一批票的
 *      第二份引用**：只清 ① 的话，`decorateDecisionRows(plan.buy, …)` 仍会把这批票当买点块
 *      遍历一遍（分笔 / 量比趋势 / 封单额全照算）⇒ 一旦将来有消费方读 `plan.buy`，票就漏出去了。
 *
 * ⛔ 刻意**不清**的三样（它们不是「选股结论」，是事实 / 卖点侧输入）：
 *   · `out.ebb`         退潮判定（卖点侧横幅也读它，且它是「为什么空仓」的依据之一）
 *   · `out.sell`        卖点候选（卖出不吃这些输入 —— 用户「卖点侧不受影响」）
 *   · `out.notes`       说明区（含「为什么某个题材没入选」，是排障唯一线索）
 *
 * 🔴 维护提醒：新增任何买点槽位（本文件 `out.xxx` 或 `out.buy.xxx` 里放 `picks` 的那种），
 *   **必须同步加进本函数**，否则「数据缺失日」新槽位会把票漏出去。
 *   `buy-data-gate.test.js` 里有一条「槽位清单」用例会红，提醒你来改这里。
 *
 * @param {object} out buildTopicVolRatioPlan 正在组装的计划对象（原地清空，§11 不返回新对象）
 * @returns {void}
 */
export function _clearBuySideForDataGate(out) {
  if (!out) return;
  // ① 视图直接渲染的容器
  out.blocks = [];
  out.ebbBuy = null;
  out.divergeBuy = null;
  out.newDragon = null;
  out.range10Backup = null;
  out.weakHuddle = null;
  out.catchUp = null;
  out.ebbNodeNote = null;
  // 空仓提醒换成「未触发」常量：数据缺失日由提示板（TvrbDataGate）说话，
  // ⛔ 不能让「平均量比 < 25」那种基于数值的标语在没数值时出现（那就是编出来的结论）。
  out.cashAlert = TVRB_CASH_ALERT_NONE;
  // ② 买点对象里的第二份引用（四个装饰器遍历的那一批）
  if (out.buy) {
    out.buy.heavy = null;
    out.buy.light = null;
    out.buy.candidates = [];
    out.buy.noYizi = null;
    out.buy.smallTopic = null;
    out.buy.bigTopic = null;
    out.buy.ebbSecond = null;
    out.buy.newDragon = null;
    out.buy.range10Backup = null;
    out.buy.weakHuddle = null;
    out.buy.catchUp = null;
  }
  out.buyNames = new Set();
  out.pickCount = 0;
}
