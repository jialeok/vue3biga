// plan-snapshot-rules.js — 选股结论存档的【规则指纹 / 新鲜度】判据（Logic 层，纯函数，§15 可单测）
//
// ★★ [TVRB-PLAN-SNAPSHOT-REVISABLE 2026-11-11] 用户纠正（原话）：
//   「既然历史日期能计算出来，能计算出来就要存起来啊，为什么一定要最新日期到来呢？
//     还有一个影响问题，就是题材更变，核心词的同义词更变，可能对表的历史结果有影响
//     （也就是选票结果有更换），这是很合理的……这是我本身纠错行为，不影响整体逻辑
//     ……所以建表时要注意，结果不是一成不变的。」
//
// ⇒ 上一版把「一天一行 + ignoreDuplicates 只写一次 + 只写今天」当成保护，是**设计错误**：
//   ① 历史日期算得出来就存得下来，⛔ 没有技术理由拒写；
//   ② 用户手动增删改核心词同义词会改变题材分组 ⇒ 选票结果本来就应该跟着变，
//      锁死「永不覆盖」反而把「纠错」挡在门外。
//   ⇒ 新语义：**一天一行，但可修订**；任何日期算出来都存，规则指纹变了就重算并覆盖。
//
// ── 为什么指纹必须基于【内容】而不是 `getCoreTopicsVersion()` ──────────────────
//   `getCoreTopicsVersion()` 是内存计数器，页面一刷新就归零重新计数。拿它当存档版本
//   ⇒ 每次打开页面都会误判「规则变了」⇒ 历史日期天天重算、天天覆盖，稳定性全毁。
//   ⇒ 用核心词表内容的确定性 hash：内容没变 ⇒ 跨设备 / 跨会话 / 刷新后指纹恒相同。
//
// §6 单一真相：本模块是「规则输入有没有变」的唯一判据，⛔ 别在 composable 里另写比较。
// §10：指纹算不出来 / 核心词没加载完 ⇒ 一律判「存档有效」，⛔ 绝不拿中间态当「规则变了」。

/** 规则代码版本。改了题材分组 / 选股规则的人必须手动 +1 ⇒ 所有历史存档按新规则重算一次。 */
export const TVRB_RULES_VERSION = 1;

/** FNV-1a 32bit（纯函数、无依赖、跨设备一致；只用于「变没变」，不用于安全场景） */
function _fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ('00000000' + (h >>> 0).toString(16)).slice(-8);
}

/**
 * 规则输入指纹。当前纳入：核心词表 `{name, synonyms[]}` 的**内容与顺序**。
 *
 * ⚠️ 刻意不排序：`matchTopicToCore` 是子串匹配，同义词顺序理论上不影响结果，但
 *    「用户调了顺序」也算一次编辑 ⇒ 指纹变 ⇒ 重算一次；结论没变时 selection_sig 相同，
 *    Data 层幂等跳过写库 ⇒ 不会污染存档。保守但零风险。
 * ⚠️ 将来若新增别的规则输入（题材库内容 / 规则参数），扩展入参即可；
 *    或者直接 bump `TVRB_RULES_VERSION` 强制全量重算。
 *
 * @param {Array<{name:string, synonyms?:string[]}>|null} coreTopics
 * @returns {string} 形如 'v1:1a2b3c4d'
 */
export function buildRulesFingerprint(coreTopics) {
  const arr = Array.isArray(coreTopics) ? coreTopics : [];
  const parts = arr.map(function (t) {
    if (!t || typeof t !== 'object') return '';
    const name = String(t.name == null ? '' : t.name).trim();
    const raw = Array.isArray(t.synonyms) ? t.synonyms : [];
    const syn = raw.map(function (s) { return String(s == null ? '' : s).trim(); }).join(',');
    return name + '=' + syn;
  });
  return 'v' + TVRB_RULES_VERSION + ':' + _fnv1a(parts.join('|'));
}

/**
 * 判断一份已读到的存档是「仍有效」还是「规则变了，需要重算覆盖」。
 *
 * 三条保护红线（⛔ 别「优化」掉）：
 *   ① 核心词还没从云端加载完 ⇒ 判 hit。首屏 `getCoreTopics()` 是默认词表，
 *      此刻比较必然不等 ⇒ 会在数据没齐时触发重算并覆盖一份好存档（§10/§11）。
 *   ② 当前指纹为空 ⇒ 判 hit（算不出来不等于变了）。
 *   ③ 旧存档没记 rules_sig（升级前的行）⇒ 判 stale，重算一次补齐元数据；
 *      这是**有意的自愈**，不是误判。
 *
 * @param {object} snap { status, rulesSig }
 * @param {object} opts { rulesSig, coreTopicsLoaded }
 * @returns {'hit'|'stale'|'unknown'} unknown = 不是有效存档状态，本判据不管
 */
export function resolvePlanSnapshotFreshness(snap, opts) {
  const s = snap || {};
  const o = opts || {};
  if (s.status !== 'hit' && s.status !== 'stale') return 'unknown';
  if (o.coreTopicsLoaded !== true) return 'hit';
  const cur = String(o.rulesSig || '').trim();
  if (!cur) return 'hit';
  const old = String(s.rulesSig || '').trim();
  if (!old) return 'stale';
  return old === cur ? 'hit' : 'stale';
}

/**
 * 这次定稿要不要真的写库（§32 幂等 + §11 覆盖保护）。
 *
 * ① 读档失败 ⇒ 绝不写：不知道库里那天有没有行，贸然 upsert 可能覆盖好存档（§10）。
 * ② 表不存在 ⇒ 写也没用，跳过。
 * ③ 规则指纹变了（stale）⇒ **必须写一次**，哪怕选票结论一模一样，
 *    否则 rules_sig 永远不更新，下次进页面又判 stale ⇒ 无限重算。
 * ④ 其余情况：选票指纹变了才写（结论没变不重复写，避免无意义请求）。
 * ⑤ hit（存档有效且屏幕冻结）⇒ 不会走到定稿，这里也挡一道。
 *
 * @param {object} o { status, selectionSig, nextSelectionSig }
 * @returns {{write:boolean, reason:string}}
 */
export function shouldPersistPlanSnapshot(o) {
  const x = o || {};
  const st = String(x.status || '').trim();
  if (st === 'error') return { write: false, reason: 'read-failed' };
  if (st === 'unavailable') return { write: false, reason: 'table-missing' };
  if (st === 'hit') return { write: false, reason: 'already-current' };
  if (st !== 'empty' && st !== 'stale' && st !== 'corrupt' && st !== 'loading') {
    return { write: false, reason: 'unknown-status' };
  }
  if (st === 'stale') return { write: true, reason: 'rules-changed' };
  if (st === 'corrupt') return { write: true, reason: 'repair-corrupt' };
  if (st === 'loading') return { write: false, reason: 'still-loading' };
  const prev = String(x.selectionSig || '').trim();
  const next = String(x.nextSelectionSig || '').trim();
  if (prev && prev === next) return { write: false, reason: 'selection-unchanged' };
  return { write: true, reason: 'first-or-changed' };
}
