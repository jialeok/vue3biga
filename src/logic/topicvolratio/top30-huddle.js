// top30-huddle.js — 第三十五条【30日涨幅抱团 · 补涨让路版】的判定与文案（Logic 层 · 纯函数 · §15）
//
// ══════════════════════════════════════════════════════════════════════════════════════
// 用户口径（2026-11-18，逐字）：
//   「11月17日，题材量比选股，选的是广百集团，选择理由：…（第三十一条补涨题材）…这个理由没有错，
//     但现在新增了30日涨幅，需要在约束下，需要再新添新规，当天三十日涨幅中排名第三的是九阳股份（大消费），
//     冰山冷热，东方海洋，如果有同题材的股票在30日涨幅中排前三，那么就优先选，记住是竞价口径，
//     上面的那个补涨题材选票要让路（也就是三十一条让路，不选，不用这条），
//     因为同题材的龙在30日涨幅前三，说明强势，还没死透，在行情差时，会抱团，所以还没轮到补涨，
//     应该继续抱团选最强的，假如30日涨幅当天排前三没有同题材的股票排名前三，
//     再考虑原有的补涨票也就是那条三十一条。新增这条规则，按照规范新增。」
//
// ── 这条规则在解决什么 ────────────────────────────────────────────────────────────────
//   空仓日（第十九条命中）原来的兜底只有【20日涨幅】一把尺子：
//     · 第三十条 = 20日涨幅前三有同题材 ⇒ 抱团；
//     · 第三十一条 = 20日涨幅 6~10 名里该题材占 2~3 只 ⇒ 选连板票（**补涨**）；
//     · 第三十二条 = 题材龙一竞价跌停 ⇒ 改买市场总龙一。
//   11-17 的结论是【广百股份】（第三十一条 · 补涨票）。但如果 30 日涨幅前三里还有【同大类的龙】，
//   说明这个题材的龙头【强势、还没死透】—— 行情差时资金会继续抱团最强的那个，
//   ⇒ **还没轮到补涨**。这时候去选补涨票是「跳级」，选错层了。
//   ⇒ 新股则：先看 30 日涨幅前三有没有同题材的龙，有 ⇒ 抱团它；没有 ⇒ 才轮到补涨。
//
// ── 三条口径（用户 2026-11-18 逐项拍板，⛔ 不许自行改动）──────────────────────────────
//   ① 覆盖范围：「三十/三十一/三十二**全部让路**」—— 命中三十五时，那三条一条都不出票。
//   ② 只选几只：「只选最强的 **1** 只」—— ⛔ 不是「前三里同题材的全部选」（那是第三十条的行为）。
//   ③ 同题材口径：「**核心词大类归一**」—— 与第三十条同一把尺子（`_sameTopicLoose` + coreRes）。
//      为什么必须是大类：11-17 灰色块 =【大消费】，九阳股份行上是【家电,电子商务】，
//      归一后才是「大消费」；按细分串比 ⇒ 认不上 ⇒ 当天不命中 ⇒ 等于这条规则不存在
//      （而用户在 11-18 的原话里正是用「九阳股份（大消费）」点明这一层）。
//
// ── 与第三十条的关系（同为「空仓日抱团」，只是尺子不同）──────────────────────────────
//   第三十条：20日涨幅**前三**，同题材的【全部】选；
//   第三十五条：30日涨幅**前三**，同题材的只选【最靠前 1 只】。
//   两条同一天都成立时【以本条为准】（C10）；不成立时第三十条照常 —— 它的守卫只看 `out.top30Huddle`。
//
// ── 红线 ─────────────────────────────────────────────────────────────────────────────
//   §10 池子不可用 / 判不出 ⇒ 返回 `{pick:null, reason:'no-pool'}`，由计划层**如实标注判不出**
//       并**不接管**（三十/三十一/三十二照常）。⛔ 绝不因为「30日没数据」就替用户默认一条结论。
//   §6  名次不在这里重排：池子进门前必须已按 30 日涨幅降序（`tvrb-auction-board30.js` 排好），
//        本模块只做「过滤 + 取第一个」。
//   §11 没有同题材命中 ⇒ `reason:'no-match'`，调用方保持原链路，行为与加本规则之前逐字相同。

import { _normTopic, _sameTopicLoose } from './tvrb-utils.js';
// ★ 常量只有一处定义（`tvrb-constants.js`，与第三十条 WEAK_HUDDLE_* 同族）；
//   ⛔ 本文件不再自己写一份「三十五」/标签串 —— 那会让手册、提示板、测试三处各自漂移（§6）。
import {
  TOP30_HUDDLE_RULE_NO,
  TOP30_HUDDLE_TAG,
  TOP30_HUDDLE_TONE,
  TOP30_HUDDLE_TOP_N,
  TOP30_HUDDLE_BLOCK_TOPIC,
  TOP30_HUDDLE_PICK_COUNT
} from './tvrb-constants.js';

// 便捷再导出：消费者（计划层 / 手册 / 测试）从「这条规则的模块」取也行，从常量文件取也行 ——
// 两者指向同一份值（ESM live binding），⛔ 不存在第二份真相。
export {
  TOP30_HUDDLE_RULE_NO,
  TOP30_HUDDLE_TAG,
  TOP30_HUDDLE_TONE,
  TOP30_HUDDLE_TOP_N,
  TOP30_HUDDLE_BLOCK_TOPIC,
  TOP30_HUDDLE_PICK_COUNT
};

/**
 * 【纯函数】从 30 日涨幅榜里挑出「与灰色题材块同大类、名次最靠前」的那 1 只。
 *
 * @param {Array<{name:string, pct:number, days?:number, code?:string, topic?:string, rank30?:number}>|null} pool
 *        30 日涨幅榜（**已按涨幅降序、只主板**，由 `tvrb-auction-board30.js` 产出/`_ebbCtxOf` 富化）。
 *        ⛔ 本函数不排序、不重排名次（§6：名次只有一份真相）。
 * @param {string} greyTopic 灰色题材块的块名（= `cashAlert.topic`，通常是核心词大类名）
 * @param {(raw:string)=>string} [coreRes] 核心词大类归一函数（与第三十条同一份）
 * @param {number} [topN] 只在前 N 名里找，缺省 `TOP30_HUDDLE_TOP_N`(3)
 * @returns {{pick:object|null, reason:string, topNames:string, greyCore:string}}
 *          reason: '' 命中 / 'no-pool' 池子空或不可用 / 'no-topic' 灰色题材名取不到 / 'no-match' 前三没有同题材
 */
export function pickTop30Huddle(pool, greyTopic, coreRes, topN) {
  const arr = Array.isArray(pool) ? pool : [];
  const greyCore = _normTopic(greyTopic, coreRes);
  if (arr.length === 0) {
    return { pick: null, reason: 'no-pool', topNames: '', greyCore: greyCore };
  }
  if (!greyCore) {
    // 灰色题材名取不到 ⇒ 无从比对（与第三十条同一处理：不写噪音说明）
    return { pick: null, reason: 'no-topic', topNames: '', greyCore: '' };
  }
  const n = (isFinite(Number(topN)) && Number(topN) > 0) ? Number(topN) : TOP30_HUDDLE_TOP_N;
  const top = arr.slice(0, n);
  // 名字兼容 `name` / `stock`：采集层富化后是 `name`，榜单原始元素是 `stock`（`buildAuctionLegBoard` 的产出）。
  // ⚠️ 两种都认，是因为这条链上确实存在两种来源；⛔ 但只认这两个字段，别扩展到别的别名（免得认错票）。
  const nameOf = function(t) {
    return String((t && (t.name || t.stock)) || '').trim();
  };
  // 前三的名单串（提示板要写「前三 = 谁（什么大类）」—— 用户看得见才判断得了）
  const topNames = top.map(function(t) {
    const nm = nameOf(t);
    if (!nm) return '';
    const core = _normTopic(t.topic, coreRes) || '—';
    const pct = isFinite(Number(t.pct)) ? (Number(t.pct).toFixed(2) + '%') : '—';
    return nm + '（' + core + '，' + pct + '）';
  }).filter(Boolean).join('、');

  for (let i = 0; i < top.length; i++) {
    const t = top[i];
    if (!t) continue;
    const nm = nameOf(t);
    if (!nm) continue;
    // ★ 口径③：同题材 = 核心词大类归一（与 _buildWeakHuddleBlock 逐字同一把尺子）
    if (!_sameTopicLoose(t.topic, greyCore, coreRes)) continue;
    // 命中第一只就停 —— 口径②「只选最强的 1 只」，榜已降序 ⇒ 第一个命中者就是最强的
    return {
      pick: {
        name: nm,
        code: String(t.code || '').trim(),
        pct: Number(t.pct),
        days: Number(t.days) || 0,
        topic: String(t.topic || ''),
        topicCore: _normTopic(t.topic, coreRes) || '',
        rank30: Number(t.rank30) || (i + 1)
      },
      reason: '',
      topNames: topNames,
      greyCore: greyCore
    };
  }
  return { pick: null, reason: 'no-match', topNames: topNames, greyCore: greyCore };
}
