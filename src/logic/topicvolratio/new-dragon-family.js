// new-dragon-family.js — 第二十八条【新题材 = 字号/字辈题材】的判定（Logic 层，纯函数，§15 可单测）
//
// ══════════════════════════════════════════════════════════════════════════════════════
// ★★ [NEW-DRAGON-FAMILY 2026-11-12 用户口径 · 推翻上一版「同题材择优」] ★★
// ══════════════════════════════════════════════════════════════════════════════════════
// 用户原话（11-12，逐字保留，这是本文件的唯一需求来源）：
//   「11月12日，20日涨幅 toggle 竞价口径排名前十的，东方题材的有三只，东方海洋排第二，
//     大东方7，日出东方8，所以东方应该作为新题材。所以应该选东方海洋和大东方，
//     东方海洋因为是之前老周期羊字辈的总龙一，老龙，现在它切换成了东方这个新题材，
//     就是它即是老龙，又是新龙。这是题材原因，不能把它一棒子打死。」
//   「当天出现东方这个新题材的股票占据 20 日涨幅竞价口径 2 只及以上，也说明这是补涨题材、
//     新题材，换新龙没错。要换到东方这个题材，因为东方符合条件，今天是三只，符合，
//     所以选东方海洋，和这个题材的大东方……如果它不是老龙变新龙（也就是不换题材，
//     或者这只股票没有东方这个题材），那么就应该选一只，大东方。」
//   「如果满足选择最强的那只，如果最强那一只含有老周期也可以选入，因为它有双重属性。」
//
// ── 上一版错在哪（11-12 实测）──────────────────────────────────────────────────────
//   上一版把「同题材」理解成【细分行业】（工业4.0）并要求「首次进前五的那只去认证它」。
//   于是 11-12 选出的是【福莱新材】（工业4.0，总龙一），而用户要的是【东方系】。
//   根因是两条：
//     ① 题材认亲只认一个大类串，看不到「东方 / 羊字辈」这类【字号、字辈】炒作线；
//     ② 「老龙一」被无条件排除（`if (ln && name === ln) continue`）⇒ 老龙换题材被一棒子打死。
//
// ── 本版规则（三步，全部基于【当日 9:25 竞价口径 20日涨幅前十】）──────────────────────
//   ① 把前十按【题材段】分组（一个题材串里可以有多个题材，如「水产品,农业,东方,羊字辈」）。
//   ② 什么算【新题材】—— 同时满足：
//        · 组内 ≥ `NEW_DRAGON_FAMILY_MIN_COUNT`（2）只；
//        · 组内**至少有一只近 N 日【没进过前五】**（= 题材新鲜度证明；全是老面孔的组 = 老周期阵营）；
//      11-12 实测：东方组 = 东方海洋(2,老面孔) + 大东方(7,新) + 日出东方(8,新) ⇒ 成立 ✅
//                  羊字辈组 = 东方海洋(2) + 襄阳轴承(3) + 光洋股份(4) + 阳光照明(5)，四只全进过前五
//                            ⇒ 不成立（那正是【老周期】本身）✅
//                  机器人概念 = 襄阳轴承(3) + 光洋股份(4)，两只都是老面孔 ⇒ 不成立 ✅
//      ⇒ 不需要另外去猜「老周期叫什么」，「全是老面孔」这个判据天然把老周期排除了。
//   ③ 多个新题材都成立 ⇒ 取【最强】的（组内最靠前那只的名次最小）。
//   ④ 买点（这是「双重属性」的落点）：
//        · 主选 = 该题材组里排名最靠前的那只（11-12 = 东方海洋，第 2）；
//        · 主选本身就是【老面孔】（= 老龙换题材 / 既是老龙又是新龙）⇒ **再补一只**该组里
//          排名最靠前的【新面孔】（11-12 = 大东方，第 7）—— 用户：「所以应该选东方海洋和大东方」；
//        · 主选是【新面孔】⇒ 只买它这一只 —— 用户：「如果它不是老龙变新龙……那么就应该选一只」。
//   ⑤ 可买闸门（与既有口径逐字一致）：非主板 / 竞价一字 / 停牌 ⇒ 买不进。
//      主选买不进（11-12 东方海洋竞价 +10.02% = 一字涨停）⇒ 它【只作题材认证】，
//      买点落在大东方 —— 用户 11-12 拍板：「一字那只只作题材认证，实际只买大东方」。
//
// ── 与其它规则的关系（⛔ 不许冲突）────────────────────────────────────────────────
//   · 只在【切换日】（二次确认退潮后第 2 个交易日）生效，由 `pickNewDragon` 调用；
//   · 判不出新题材（没有任何组满足 ②）⇒ 返回 null ⇒ 退回上一版「首次进前五那只」的旧路径
//     （10-22 冰山冷热那次就是这条路：它的题材只有它一只进前十）。
//   · ⛔ 本文件不读 state / 不发请求 / 不拼文案（§4 / §21）。
// ══════════════════════════════════════════════════════════════════════════════════════

import { NEW_DRAGON_FAMILY_MIN_COUNT } from './tvrb-constants.js';

/** 题材串分隔符（与 core-category.js#splitTopicSegments 同一批；本模块保持零依赖） */
const SEG_SPLIT_RE = /[,，、;；/+|]/;

/**
 * 题材串 → 题材段数组（去空、去重、保序）。
 * @param {*} raw
 * @returns {string[]}
 */
export function splitTopicSegs(raw) {
  const s = String(raw === null || raw === undefined ? '' : raw).trim();
  if (!s) return [];
  const seen = new Set();
  const out = [];
  s.split(SEG_SPLIT_RE).forEach(function (seg) {
    const v = String(seg || '').trim();
    if (!v) return;
    // 纯数字不是题材名（历史脏值，见 tvrb-utils#_normTopic 的同一条判据）
    if (/^\d+(\.\d+)?$/.test(v)) return;
    const key = v.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(v);
  });
  return out;
}

/**
 * 把前十按题材段分组。
 *
 * @param {Array} pool 20日涨幅【竞价口径前十】（每只含 name / topic / rank20 / pct / code /
 *        isYizi / suspended / mainBoard）
 * @param {Set<string>} ever 近 N 日【上过前五】的股票名集合
 * @returns {Array<{topic:string, members:Array, count:number, bestRank:number,
 *          freshCount:number, oldestEver:boolean}>}
 *          members 已按 rank20 升序；freshCount = 组内「没进过前五」的只数
 */
export function buildFamilyGroups(pool, ever) {
  const list = Array.isArray(pool) ? pool : [];
  const ev = (ever instanceof Set) ? ever : new Set();
  const map = new Map();
  list.forEach(function (c, i) {
    if (!c || !c.name) return;
    const nm = String(c.name).trim();
    if (!nm) return;
    const rank20 = Number(c.rank20) || (i + 1);
    splitTopicSegs(c.topic).forEach(function (seg) {
      let g = map.get(seg);
      if (!g) {
        g = { topic: seg, members: [] };
        map.set(seg, g);
      }
      if (g.members.some(function (m) { return m.name === nm; })) return;
      g.members.push({
        name: nm,
        rank20: rank20,
        pct: c.pct,
        code: String(c.code || '').trim(),
        isYizi: !!c.isYizi,
        suspended: !!c.suspended,
        // ⚠️ mainBoard 缺省（undefined）⇒ 不据此排除（老调用方/单测零行为变化，§11）
        mainBoard: c.mainBoard !== false,
        everBefore: ev.has(nm)
      });
    });
  });
  const out = [];
  map.forEach(function (g) {
    const members = g.members.slice().sort(function (a, b) { return a.rank20 - b.rank20; });
    const freshCount = members.filter(function (m) { return !m.everBefore; }).length;
    out.push({
      topic: g.topic,
      members: members,
      count: members.length,
      bestRank: members.length > 0 ? members[0].rank20 : 0,
      freshCount: freshCount,
      oldestEver: freshCount === 0
    });
  });
  // 确定性排序（§6）：最靠前名次 → 成员多 → 题材名字典序（⛔ 不随 Map 插入序漂移）
  out.sort(function (a, b) {
    if (a.bestRank !== b.bestRank) return a.bestRank - b.bestRank;
    if (a.count !== b.count) return b.count - a.count;
    return a.topic < b.topic ? -1 : (a.topic > b.topic ? 1 : 0);
  });
  return out;
}

/** 一只票能不能买（与买点侧同一把尺子：非主板 / 竞价一字 / 停牌 ⇒ 买不进） */
function _buyable(m) {
  return !!m && m.mainBoard !== false && !m.isYizi && !m.suspended;
}

/** 买不进的原因（文案由调用方拼，这里只给事实） */
function _blockReason(m) {
  if (!m) return '';
  if (m.mainBoard === false) return 'non-main-board';
  if (m.isYizi) return 'yizi';
  if (m.suspended) return 'suspended';
  return '';
}

/**
 * ★★ [NEW-DRAGON-FAMILY] 切换日：从【前十】里挑出新题材的买点（最多 2 只）。
 *
 * @param {Array} pool 当日 9:25 竞价口径 20日涨幅【前十】（含题材 / 名次 / 一字 / 停牌 / 主板）
 * @param {{everInTop5?:Set<string>, minCount?:number}} [info]
 * @returns {null|{
 *   topic:string, count:number,
 *   pick:object,            // 最终买点那一只（一定可买）
 *   extras:Array<object>,   // 补选（「主选是老龙 ⇒ 再补一只新面孔」；最多 1 只）
 *   certifier:object|null,  // 只作题材认证、不进买点的那只（竞价一字 / 停牌 / 非主板）
 *   primary:object,         // 该题材组里排名最靠前的那只（可能是 certifier）
 *   members:Array,          // 该题材组全部成员（已按名次升序）
 *   groups:Array            // 全部题材组（判定可追溯）
 * }}
 *         判不出 ⇒ null（调用方退回旧路径；§10 判不出 ≠ 判出「没有」）
 */
export function pickFamilyNewDragon(pool, info) {
  const o = info || {};
  const minCount = Number(o.minCount) > 0 ? Number(o.minCount) : NEW_DRAGON_FAMILY_MIN_COUNT;
  const groups = buildFamilyGroups(pool, o.everInTop5);

  // ② 新题材 = 组内 ≥minCount 只 且 至少一只新面孔
  const cands = groups.filter(function (g) {
    return g.count >= minCount && g.freshCount >= 1;
  });
  if (cands.length === 0) return null;

  // ③ 取最强（groups 已排序 ⇒ cands[0] 就是最靠前的那个新题材）
  const g = cands[0];
  const members = g.members;
  const primary = members[0];                 // 组内最靠前 = 主选（可能是老龙换题材）

  // ④ 补选：主选本身是老面孔（双重属性）⇒ 再补一只组内最靠前的【新面孔】
  let extras = [];
  if (primary.everBefore) {
    const fresh = members.filter(function (m) { return !m.everBefore; });
    for (let i = 0; i < fresh.length; i++) {
      if (_buyable(fresh[i])) { extras = [fresh[i]]; break; }
    }
  }

  // ⑤ 可买闸门：主选买不进 ⇒ 降级为「只作题材认证」，买点顺延到补选 / 组内下一只可买的
  let pick = null;
  let certifier = null;
  if (_buyable(primary)) {
    pick = primary;
  } else {
    certifier = {
      name: primary.name,
      rank20: primary.rank20,
      topic: g.topic,
      reason: _blockReason(primary),
      everBefore: !!primary.everBefore
    };
    if (extras.length > 0) {
      pick = extras[0];
      extras = [];
    } else {
      // 补选没有（或主选不是老面孔）⇒ 顺延到组内下一个能买的
      for (let i = 1; i < members.length; i++) {
        if (_buyable(members[i])) { pick = members[i]; break; }
      }
    }
  }
  if (!pick) return null;   // 整个题材组一只都买不进 ⇒ 判不出（⛔ 不硬凑）

  // 补选若与 pick 重复 / 不可买 ⇒ 丢掉
  extras = extras.filter(function (m) { return m && m.name !== pick.name && _buyable(m); });

  return {
    topic: g.topic,
    count: g.count,
    pick: pick,
    extras: extras,
    certifier: certifier,
    primary: primary,
    members: members,
    groups: groups
  };
}
