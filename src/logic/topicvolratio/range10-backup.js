/**
 * range10-backup.js — 「十日涨幅 · 在列次数候补」的【唯一判定实现】（Logic 层纯函数）。
 *
 * ============================================================================
 * 用户口径（2026-10-24，逐字）：
 *   「10月20日，主线题材二次确认退潮当天，龙头首次分歧次日，按照题材平均量比排名第二的题材，
 *     比如松霖科技在的房地产，题材量比太小，只有 7.47，小于空仓门槛量比 25，题材量比太小禁止选入，
 *     应该选十日涨幅首次在列龙头而且是排名前十的，进行替换，而且排名靠前的，首次在列，
 *     排名靠前的是海洋王，排名第八。所以选它。」
 *   「排名第二的题材如果量比太小就用 10 日涨幅，首次在列进行候补，如果排名前十没有首次在列标签，
 *     就用二次在列排名靠前候补，因为龙头的量比都比题材大，那才是核心，应该用 10 日涨幅候补，
 *     这样可以选出有潜质的新龙，因为 20 日老周期结束，现在轮到十日周期。」
 *   「不管是首次在列，或者二次在列都要和 20 日涨幅的总龙一是不同题材，还有都是排名前十，
 *     这几个条件同时满足，不然如果不符合都要空仓。」
 *   「常规的是排名第一的题材如果平均量比小于标准 25，也一率作废。进入候选的是十日涨幅题材新股票的
 *     排名靠前的新股票（首次在列或者二次在列），新面孔。有首次在列的只选一只，没有首次在列的，
 *     选二次在列的。如果都没有，依旧空仓。」
 * ============================================================================
 * 用户口径（2026-10-24 第四次修正，9-29 雪龙集团事故）：
 *   「9月29日，量比题材买点侧你选择，雪龙集团，十日涨幅雪龙股份2次在列，给出理由……
 *     但是雪龙股份竞价是涨停一字板，买不进去啊，所以规则你要完善下，竞价涨幅是涨停的，
 *     一字板的你说明下就可以了，不用把股票选进去，选进去没用，也买不了。你选票的时候要注意这点，
 *     买不进去的，也不用替补，也不用选进去了。其它不变。」
 *   ⇒ ★ 新增一道否决：最强的那只若是【竞价一字涨停】⇒ 本日候补【空仓】，
 *      ⛔ **既不选入，也不顺延到下一名**（"也不用替补"）。
 *      ⚠️ 与题材块「龙一一字 ⇒ 顺延龙二」【刻意相反】：那边是买满名额的打板口径，
 *        这边是「候补只有一只」的替换口径 —— 换成第二名就用更弱的票顶掉了最强的票，
 *        那不是用户要的东西（与 10-20「不许顺延」的纪律同源，只是这次的顺延理由是买不进）。
 * ============================================================================
 * 用户口径（2026-10-24 第三次修正，10-20 事故）：
 *   「10月20日，十日候补题材你选了京城股份，实际上是海洋王，因为海洋王已经选在了下面题材
 *     商业航天题材中，所以你选排在后一名的京城股份？这是不对的。……出现多只首次在列只选一只
 *     最强的，也就是十日涨幅最高的，那就是海洋王。」
 *   「是不是因为买点侧那里也有了题材的海洋王入选了，所以你又挑选了一只？……如果不是，
 *     这种情况是题材和市场选票叠加的效果，这是好事啊，因为两边都选了海洋王，两个提示板
 *     整合成一个叠加在一起就可以了，这是确定性啊。」
 *   「意思是它即是题材选出来的，也是市场选出来的。两者叠加一起，也不用分开了。」
 *   ⇒ ★ 本模块【不排除任何票】：即使某只票已经在某个题材块里当选买点、甚至已经是今天要买的票，
 *     只要它是「十日涨幅前十 + 首次/二次在列 + 与总龙一不同题材」里【最强的那一只】，就选它。
 *     两条通道选中同一只票 = 【叠加确认】（确定性更高），两处照旧各展示一行，
 *     ⛔ 绝不允许「因为它已经被题材选中，就让它顺延到下一名」（10-20 事故就是这个顺延）。
 *     10-20 真实数据：海洋王 29.51%（首次在列，主板第 7 名）在 商业航天 题材块里已当选，
 *     却被排除后顺延到 京城股份 27.26%（首次在列，第 8 名）—— 更弱的票顶掉了最强的票。
 * ============================================================================
 *
 * 职责边界（§3/§4/§21）：
 *   · 本模块【只做一件事】：给一份「当日 10 日涨幅池」，挑出那【至多一只】候补票。
 *   · ⛔ 不取数、不落库、不发请求；池子由采集层（decision-collect#range10Rows）注入，
 *     在列次数由 Data 层（auction_presence）注入 —— 与本模块无关。
 *   · ⛔ 不判题材量比门槛（谁作废由规则层用 TVRB_CASH_ALERT_AVG_VR 一处判），
 *     本模块只回答「如果要用候补，该选谁 / 为什么选不出」。
 *
 * 「排名前十」的口径（§6 单一真相 —— 与屏幕上那枚标签同一把尺子）：
 *   = 早盘竞价看板「10 日涨幅」toggle 里**带在列次数标签**的那十只
 *     （presence-label.js#assignPresenceLabels：非主板【不占名次】、缺涨幅不占名次）。
 *   ⚠️ 10-20 实测：海洋王 按「只数主板」的名次是第 7，按屏幕行号是第 8 ——
 *      两种都能选中它；但口径必须唯一，故一律用「主板名次 ≤ PRESENCE_TOP_N」，
 *      这样「前十」与「带标签的那十只」永远是同一批（用户看到什么就能选什么）。
 *
 * 「首次在列 / 二次在列」的口径：
 *   · 首次在列 = 窗口内（含今天）在 `auction_watchlist` 只出现过 1 次；
 *   · 二次在列 = 出现过 2 次；
 *   · 次数由预计算表 auction_presence（window_days = 10）给出，标签文案复用 presenceLabelOf（§6）。
 *   §10：次数数据未到（counts = null / coveredDays = 0）⇒ 判不出 ⇒ ⛔ 绝不当 0 次用。
 *
 * 排序（§6）：复用 range-pct-sort.js#sortIndicesByRangePct（与「10 日涨幅」toggle 同一个排序函数），
 *   ⛔ 不在这里另写一份「按 pct 降序」—— 缺数据置底 / 稳定排序这两个细节一旦分叉，
 *   候补就会从「屏幕上第 8 行」滑到别的票上。
 */

import { sortIndicesByRangePct } from '../auction/range-pct-sort.js';
// [MAIN-BOARD-RANK] 「只有主板占名次」的判据走 limit-up.js 的唯一实现（§6），
//   ⛔ 不在这里手写 /^30|68|43/ 前缀（板块分类只有 getBoardKind 一处真相）。
import { isMainBoardRankEligible } from '../auction/limit-up.js';
import { PRESENCE_TOP_N, presenceLabelOf, PRESENCE_WINDOW_10 } from '../auction/presence-label.js';

/** 用户口径编号（规则手册「第二十九条」；本模块只供文案引用，⛔ 不参与判定） */
export const RANGE10_BACKUP_RULE_NO = '二十九';
/** 窗口天数：候补看的是「10 日涨幅」周期（用户：「20 日老周期结束，现在轮到十日周期」） */
export const RANGE10_BACKUP_WINDOW_DAYS = PRESENCE_WINDOW_10;
/** 首次在列的次数 */
export const RANGE10_CNT_FIRST = 1;
/** 二次在列的次数 */
export const RANGE10_CNT_SECOND = 2;

/**
 * 涨幅 → 「+49.00%」文案（仅用于【说明文字】，⛔ 不参与任何判定）。
 * §21：文案在 Logic 层拼好，模板零计算；缺值 ⇒ '—'（⛔ 不补 0，§10）。
 * @param {number|null} n
 * @returns {string}
 */
function _fmtPct(n) {
  const v = (n === null || n === undefined || n === '') ? null : Number(n);
  if (v === null || !isFinite(v)) return '—';
  return (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
}

/**
 * 【纯函数】把注入的十日涨幅池排成「屏幕顺序 + 主板名次」。
 *
 * @param {Array<{name:string, code?:string, topic?:string, pct:number|string|null}>} pool
 *        当日名单（decision-collect#range10Rows：name / code / topic / pct=十日涨幅）
 * @returns {Array<{name:string, code:string, topic:string, pct:number|null,
 *                  mainBoard:boolean, rank:number|null}>}
 *         按涨幅降序（= 屏幕行序）；rank = 主板名次（非主板 / 缺涨幅 ⇒ null，不占名次）
 */
export function buildRange10Ranked(pool) {
  const items = [];
  const seen = new Set();
  (pool || []).forEach(function(r) {
    if (!r) return;
    const name = String(r.name || r.stock || '').trim();
    if (!name || seen.has(name)) return;
    seen.add(name);
    const raw = r.pct;
    let pct = null;
    if (raw !== null && raw !== undefined && raw !== '') {
      const n = Number(raw);
      if (isFinite(n)) pct = n;
    }
    items.push({
      name: name,
      code: String(r.code || '').trim(),
      topic: String(r.topic || '').trim(),
      pct: pct,
      // ★★ [R10-YIZI 2026-10-24] 该票【今日】是否竞价一字涨停（买不进）。
      //   三态，⛔ 不许把「不知道」塌成 false（§10）：
      //     true  = 采集层用 limit-up.js#isAuctionYiZi 判出来了（读 auc_pct_chg，唯一实现 §6）；
      //     false = 明确不是一字；
      //     null  = 拿不到该票今日的竞价数据（典型 = 「20天」补位行：它【不在】今日竞价名单里）
      //             ⇒ 判不出，⛔ 不能当成「能买」也不当成「买不进」（见 pickRange10Backup 的说明）。
      isYizi: (r.isYizi === true) ? true : (r.isYizi === false ? false : null),
      // 竞价涨幅（%，仅用于说明文案：「竞价涨幅 +10.00% ⇒ 一字板」）；null = 缺数据
      aucPct: (function() {
        const v = r.aucPct;
        if (v === null || v === undefined || v === '') return null;
        const n = Number(v);
        return isFinite(n) ? n : null;
      })(),
      // sortIndicesByRangePct 的行契约是 `row.stock`（与早盘竞价的 renderList 同形）
      stock: name
    });
  });
  if (items.length === 0) return [];

  // 排序走【同一个实现】（§6）：把「池」映射成它要的 rows + rangeMap，索引数组自己造。
  const rangeMap = new Map();
  items.forEach(function(it) { rangeMap.set(it.name, { pct: it.pct }); });
  const order = sortIndicesByRangePct(items.map(function(_, i) { return i; }), items, rangeMap);

  const out = [];
  let rank = 0;
  order.forEach(function(idx, i) {
    const it = items[idx];
    const mainBoard = isMainBoardRankEligible(it.code);
    let r = null;
    // 与 presence-label.js#assignPresenceLabels 完全同序：缺涨幅 / 非主板 ⇒ 跳过且【不占名次】
    if (it.pct !== null && mainBoard) {
      rank += 1;
      r = rank;
    }
    out.push({
      name: it.name, code: it.code, topic: it.topic, pct: it.pct,
      mainBoard: mainBoard, rank: r,
      isYizi: it.isYizi, aucPct: it.aucPct,
      // ⚠️ 屏幕行号（1 起，含非主板）—— 只用于【说明文案】帮用户核对，
      //    ⛔ 绝不拿它当名次口径：用户问的是「排名前十」，而屏幕上的标签按【主板名次】发
      //    （2026-10-23 实测：兆威机电 主板第 8 名 / 屏幕第 9 行 —— 两种数法都能进前十，但混用就会出现
      //      「第 8 名」与「第 9 行」看着矛盾的口径争执）。
      rowNo: i + 1
    });
  });
  return out;
}

/**
 * 【纯函数】挑出那至多一只「十日涨幅候补」。
 *
 * 判定顺序（每一步都写进 trail，可追溯 —— §10 结论必须能被复核）：
 *   ① 取「主板名次 ≤ topN」的那十只（缺涨幅 / 非主板不占名次）；
 *   ② 逐只剔除：题材未知（判不出是否同题材）/ 与排除题材同类；
 *      ★ [R10-NOEXCLUDE 2026-10-24] ⛔ 不剔除「已在今日买点侧」的票 —— 见文件头的第三次修正：
 *        题材通道与市场通道选中同一只票是【叠加确认】，顺延到下一名反而会选出更弱的票（10-20 事故）。
 *   ③ 第一档 = 首次在列（cnt=1），第二档 = 二次在列（cnt=2）；
 *      按名次从前往后取第一只（用户：「有首次在列的只选一只，没有首次在列的，选二次在列的」）。
 *      ⚠️ 「没有首次在列」按【剔除后仍可用】解释：一档里全是同题材的，
 *         等于「没有可用的首次在列」⇒ 才看二档；两档都空 ⇒ 返回 pick=null（= 空仓）。
 *   ④ 选中即停，⛔ 绝不多选（用户：「有首次在列的只选一只」）。
 *   ⑤ ★★ [R10-YIZI 2026-10-24] 若选中的那只【今日竞价一字涨停】⇒ 买不进 ⇒
 *      pick=null、blockedBy='yizi'、blocked=那只票，⛔ **不换下一名替补**（本日候补空仓）。
 *
 * @param {Array} pool 见 buildRange10Ranked
 * @param {{counts?:Map<string,{cnt:number}>|null, coveredDays?:number, topN?:number,
 *          excludeTopics?:string[], sameTopic?:(a:string,b:string)=>boolean}} [opts]
 *        counts        = auction_presence 的次数表（null ⇒ 数据未到 ⇒ 判不出）
 *        coveredDays   = 窗口内实际有名单数据的天数（0 ⇒ 判不出）
 *        excludeTopics = 必须避开的题材（20 日涨幅总龙一的题材）—— 这是本通道唯一的题材约束
 *        sameTopic     = 题材认亲（规则层注入【大类归一】后的比较函数，§6）；缺省严格相等
 *        ⛔ 没有 excludeName（2026-10-24 移除）：本通道是【从全市场选股】，
 *           「是否已被题材块选中」不参与判定。要表达「同一只票两条通道都选中」，
 *           请在规则层的说明文案里讲（_buildRange10BackupBlock 的 overlap）。
 * @returns {{ready:boolean, reason:string, pick:object|null, tier:'first'|'second'|'',
 *            trail:Array<object>, topN:number, coveredDays:number, windowDays:number,
 *            blockedBy:string, blocked:object|null, yiziUnknown:boolean}}
 */
export function pickRange10Backup(pool, opts) {
  const o = opts || {};
  const rawN = Number(o.topN);
  const topN = (isFinite(rawN) && rawN > 0) ? Math.floor(rawN) : PRESENCE_TOP_N;
  const counts = (o.counts && typeof o.counts.get === 'function') ? o.counts : null;
  const coveredDays = Number(o.coveredDays) > 0 ? Math.floor(Number(o.coveredDays)) : 0;
  const sameTopic = (typeof o.sameTopic === 'function')
    ? o.sameTopic
    : function(a, b) { return !!a && !!b && String(a) === String(b); };
  const excludeTopics = (Array.isArray(o.excludeTopics) ? o.excludeTopics : [])
    .map(function(t) { return String(t || '').trim(); })
    .filter(function(t) { return !!t; });

  const out = {
    ready: false,
    reason: '',
    pick: null,
    tier: '',
    trail: [],
    topN: topN,
    coveredDays: coveredDays,
    windowDays: RANGE10_BACKUP_WINDOW_DAYS,
    // ★★ [R10-YIZI 2026-10-24 用户口径] 买不进（竞价一字涨停）的三件事实：
    //   · blockedBy = 'yizi'  ⇒ 「不是选不出，是选出来的那只买不进」—— 规则层据此换文案；
    //   · blocked   = 被否掉的那只（name/topic/pct/rank/cnt/label/aucPct），用于说明区点名；
    //   · yiziUnknown = 选中的票今日竞价数据缺失（补位行）⇒ 无法确认是否一字，需用户自核。
    //   ⚠️ 三个都是【附加信息】，缺省值 = 没有发生（§11：老调用方 / 老单测零行为变化）。
    blockedBy: '',
    blocked: null,
    yiziUnknown: false
  };

  const ranked = buildRange10Ranked(pool);
  if (ranked.length === 0) {
    out.reason = '当日十日涨幅名单未就绪（数据未到）⇒ 判不出候补';
    return out;
  }
  // §10：次数未到 ⇒ 判不出（⛔ 绝不把「不知道」当成「首次在列」）
  if (!counts || coveredDays <= 0) {
    out.reason = '十日窗口的在列次数（auction_presence）未读到 ⇒ 判不出「首次 / 二次在列」⇒ 候补不生效';
    return out;
  }
  out.ready = true;

  const top = ranked.filter(function(it) { return it.rank !== null && it.rank <= topN; });
  if (top.length === 0) {
    out.reason = '十日涨幅前 ' + topN + ' 名里没有主板票 ⇒ 无可选候补';
    return out;
  }

  const judged = top.map(function(it) {
    const hit = counts.get(it.name);
    // 命中不到 ⇒ 窗口内真的一次都没进过名单（今天在名单里的票必然 cnt ≥ 1）⇒ 0 次
    const rawCnt = hit ? Number(hit.cnt) : 0;
    const cnt = (isFinite(rawCnt) && rawCnt >= 0) ? Math.floor(rawCnt) : 0;
    let reason = '';
    if (!it.topic) {
      reason = '题材未知 ⇒ 判不出是否与总龙一同题材（§10 不猜）';
    } else {
      for (let i = 0; i < excludeTopics.length; i++) {
        if (sameTopic(it.topic, excludeTopics[i])) {
          reason = '与【' + excludeTopics[i] + '】同题材（老周期 / 已作废题材）';
          break;
        }
      }
    }
    return {
      name: it.name, code: it.code, topic: it.topic, pct: it.pct, rank: it.rank,
      rowNo: it.rowNo,
      cnt: cnt, label: presenceLabelOf(cnt), reason: reason,
      // [R10-YIZI 2026-10-24] 今日竞价一字涨停（true / false / null=判不出，见 buildRange10Ranked）
      isYizi: it.isYizi, aucPct: it.aucPct
    };
  });
  out.trail = judged;

  const first = judged.filter(function(j) { return !j.reason && j.cnt === RANGE10_CNT_FIRST; });
  const second = judged.filter(function(j) { return !j.reason && j.cnt === RANGE10_CNT_SECOND; });
  const tier1 = first[0] || null;
  const tier2 = second[0] || null;
  const pick = tier1 || tier2;
  if (!pick) {
    out.reason = '十日涨幅前 ' + topN + ' 名里没有【首次在列 / 二次在列】且与总龙一不同题材的主板票' +
      '（有首次在列只选一只；没有首次在列才看二次在列）⇒ 今天空仓';
    return out;
  }
  // ★★ [R10-YIZI 2026-10-24 用户口径] 「买不进去的，也不用替补，也不用选进去了」：
  //   最强的那只若是【竞价一字涨停】⇒ 一字板竞价买不进（开盘也基本买不到）⇒
  //   ⛔ 不选入，⛔ 也不顺延到下一名（下一名更弱，替换没有意义），本日候补直接空仓。
  //   ⚠️ 只对【会被选中的那一只】生效：一字票若排在更后面（前面已有可用票），它不影响结论。
  if (pick.isYizi === true) {
    // 让「前十逐只去留」那段文字也能看见它被否掉的真实原因（可追溯，§10）
    pick.reason = '今日【竞价涨停（一字板）】⇒ 竞价买不进 ⇒ 不选入，也不替补';
    out.blockedBy = 'yizi';
    out.blocked = {
      name: pick.name, code: pick.code, topic: pick.topic,
      pct: pick.pct, rank: pick.rank, rowNo: pick.rowNo,
      cnt: pick.cnt, label: pick.label, aucPct: pick.aucPct
    };
    out.tier = '';          // ⛔ 一档都没成（别让下游误读成「首次在列档选出来的」）
    out.pick = null;
    out.reason = '十日涨幅前 ' + topN + ' 名里最强的那只【' + pick.name + '】' +
      '（' + (pick.topic || '—') + '，十日涨幅 ' + _fmtPct(pick.pct) +
      '，第 ' + pick.rank + ' 名，' + (pick.label || '次数未知') + '）' +
      '今日【竞价涨停（一字板）】' +
      (pick.aucPct === null ? '' : ('（竞价涨幅 ' + _fmtPct(pick.aucPct) + '）')) +
      ' ⇒ 一字板竞价买不进、开盘也基本买不到；' +
      '按用户口径【不选入、也不替补】⇒ 今天这只候补【空仓】（⛔ 没有换成下一名顶上来）';
    return out;
  }
  out.pick = pick;
  out.tier = tier1 ? 'first' : 'second';
  // §10：补位行（「20天」票）不在今日竞价名单里 ⇒ 拿不到竞价涨幅 ⇒ 判不出是否一字。
  //   仍然选它（⛔ 不因为「不知道」就否掉一个合格候选），但要把这个缺口如实说出去，
  //   让用户自己核一眼 —— 这比「默默当成能买」安全。
  if (pick.isYizi === null) out.yiziUnknown = true;
  return out;
}
