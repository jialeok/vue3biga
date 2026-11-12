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

/**
 * 规则代码版本。改了题材分组 / 选股规则的人必须手动 +1 ⇒ 存档判过期、按新规则重算一次。
 *
 * 版本史：
 *   v1 = 初版（核心词表内容 hash）。
 *   v2 = ★★ [NEW-DRAGON-CERTIFY 2026-11-12 用户口径] 第二十八条新增【同题材择优】：
 *        同题材在前五有两只及以上时，只买竞价口径最靠前的那只（认证龙），
 *        首次进前五的那只只作判断条件。**选股结论会变**（11-12：光洋股份 → 襄阳轴承）
 *        ⇒ 必须 bump，否则那一份按 v1 规则定稿的存档会永久 hit，屏幕上一直是错的那只。
 *   ⚠️ 历史日不因 bump 重算（库内行情会漂移、会把复盘结论改写）—— 见
 *     `resolvePlanSnapshotFreshness` 的 `allowRulesInvalidation`。
 */
export const TVRB_RULES_VERSION = 2;

/**
 * 输入完整性指纹版本。新增 / 删除「完整性判据」时 +1 ⇒ 所有存档按新判据重算一次。
 */
export const TVRB_INPUTS_VERSION = 1;

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
 * ★★ [SNAPSHOT-INPUTS 2026-11-11 · 整类修复] 选股结论的【输入完整性指纹】。
 *
 * 为什么必须有（11-11 P0 实证）：
 *   21:22 把一份 `pickCount=1` 的结论按 `rules_sig` 命中写进了存档。当晚库里
 *   `stock_range20_pct` 当天的 **auc 腿是 0 行**（9:26/9:27 云端预填撞 42P10 全灭），
 *   前端拿「只有 close 腿」的表判「竞价口径还没有」⇒ 20 日补位池空。
 *   ⇒ 结论是在**输入残缺**时算出来的。存档只记了 rules_sig（核心词没变），
 *     于是它**永久 hit**：数据后来补全了，屏幕也永远显示那份残缺结论。
 *     用户体感就是「昨天修好了，今天又不见」「越改越乱」。
 *
 * ⇒ 判据：把「这份结论是在什么完整度的输入上算出来的」也存进存档。
 *   数据从「残缺」变「完整」时，存档必须判 stale ⇒ 重算并覆盖（用户口径：结果不是一成不变的）。
 *
 * 三位（顺序固定，⛔ 别改顺序 —— 改了等于换了语义，必须 bump TVRB_INPUTS_VERSION）：
 *   ① 竞价口径 20 日涨幅榜是否就绪（`tvrb-auction-board` ready 且前五非空）
 *   ② 量比闸门是否通过（`resolveBuyDataGate` 未 blocked ⇒ 整表量比覆盖达标）
 *   ③ 20 日补位池是否非空（竞价榜 wide 或收盘口径发布榜任一有票）
 *
 * ⚠️ 刻意只记【布尔完整度】不记条数：行数在 9:25→16:00 之间本来就会正常增长，
 *   若记条数，下午打开历史日会天天误判 stale ⇒ 天天重算覆盖（正是要避免的抖动）。
 *
 * @param {{aucBoardReady?:boolean, volRatioOk?:boolean, poolOk?:boolean}} o
 * @returns {string} 形如 'v1:111'（空入参 ⇒ 'v1:000'）
 */
export function buildInputsFingerprint(o) {
  const x = o || {};
  const bits = [
    x.aucBoardReady === true ? '1' : '0',
    x.volRatioOk === true ? '1' : '0',
    x.poolOk === true ? '1' : '0'
  ].join('');
  return 'v' + TVRB_INPUTS_VERSION + ':' + bits;
}

/** 指纹是否表示「三元判据全部达标」（='v1:111'）。算不出来 / 非字符串 ⇒ false（⛔ 不当成完整）。 */
export function isInputsFingerprintComplete(sig) {
  const s = String(sig || '').trim();
  if (!s) return false;
  const m = /^v\d+:([01]{3})$/.exec(s);
  return !!m && m[1] === '111';
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
 * ★★ [SNAPSHOT-INPUTS 2026-11-11] 规则没变之后再比【输入完整性】：
 *   ④ 存档没记 inputs_sig（升级前的行 / 上一版写的历史行）⇒ 判 stale，自愈一次。
 *      这就是「11-11 21:22 那份 pickCount=1 的残缺存档」被自动重算覆盖的入口。
 *   ⑤ 当前输入算不出来（''）或仍不完整（含 0）⇒ 判 hit：
 *      数据还没齐时不反复重算（避免抖动 / 反复覆盖），等齐了自然走 ⑥。
 *   ⑥ 存档的完整度和当前不一样 ⇒ 判 stale。
 *      典型：存档时 `v1:110`（auc 腿缺失导致补位池空），现在 `v1:111`
 *      ⇒ 必须用完整输入重算并覆盖，⛔ 不许把残缺结论冻结到今天以后。
 *
 * @param {object} snap { status, rulesSig, inputsSig }
 * @param {object} opts { rulesSig, coreTopicsLoaded, inputsSig }
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
  if (old !== cur) {
    // ★★ [RULES-BUMP-GUARD 2026-11-12] 规则升级（bump `TVRB_RULES_VERSION` / 改核心词）时：
    //   · 当日（还在用它做决策的那一天）⇒ 判 stale，按新规则重算并修订存档（revision +1）；
    //   · 历史日 ⇒ 判 hit，**保持定稿**。理由：历史日的库内行情会被后续 worker / 收盘覆盖，
    //     拿它重算会把「当天 9:25 那份结论」改写成另一份（11-10 实证过）⇒ 复盘失真。
    //     这里刻意把「改规则」和「改历史」解耦：新规则服务今天与以后，历史照样冻结。
    if (o.allowRulesInvalidation === false) return 'hit';
    return 'stale';
  }
  // ── 规则没变 ⇒ 再核对「输入完整度」（④⑤⑥）
  //  ⚠️ 库里还没有 inputs_sig 列（降级模式）⇒ 这一位不支持，⛔ 不许把「没有该字段」当过期，
  //     否则每次打开页面都会判 stale 重算一遍（而降级模式下永远补不上这一列）。
  if (o.inputsSigSupported === false) return 'hit';
  const oldInputs = String(s.inputsSig || '').trim();
  if (!oldInputs) return 'stale';                 // ④ 元数据缺失 ⇒ 自愈一次
  const curInputs = String(o.inputsSig || '').trim();
  if (!curInputs) return 'hit';                   // ⑤ 当前算不出来 ⇒ 不动存档
  if (!isInputsFingerprintComplete(curInputs)) return 'hit';  // ⑤ 数据还没齐 ⇒ 不抖动
  if (oldInputs !== curInputs) return 'stale';    // ⑥ 从残缺变完整 ⇒ 用完整输入重算覆盖
  return 'hit';
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
