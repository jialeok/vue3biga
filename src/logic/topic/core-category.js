// core-category.js — 「题材 → 核心词（大类）」归一的唯一实现（Logic 层 · 纯函数 · §15 独立业务模块）
//
// ══════════════════════════════════════════════════════════════════════════════════════
// 需求口径（用户 2026-10-22 原话）：
//   「AI应用是大类，我在早盘竞价看板的第二页双击题材时，有个核心管理编辑框，我做了大类整理，
//     把文化传媒放到那个大类了，那个大类就是我说的题材。因为每天的股票太少，只能用大类分。不细分。」
//
// ⇒ 「退潮 / 分歧 / 新龙」这些规则说的「题材」= 核心词管理里的【大类名】，不是每日行上的细分题材串。
//   二者不是一回事：10-22 新华传媒行上是「文化传媒」，而大类是「AI应用」——
//   按细分串认亲会把它和老周期（10-14/10-15/10-20 的「AI应用」）认成两个题材，
//   于是「近 20 个交易日的退潮事件数」从 2 变成 0 ⇒ 误报【首次退潮】。
//
// ⚠️ 为什么单独成一个模块：规则层（topic-vol-ratio-rules.js）是【纯函数】，不能自己去读 core_topics
//   （那是 Data 层的职责，§5）。这里只提供「给我一份 coreTopics 数组，还你一个归一函数」的纯工具，
//   由组合式把 `getCoreTopics()` 的结果注入 —— 规则层拿到的永远是「数组 + 函数」。
//
// ⚠️ 匹配语义与既有的 `topic/rules.js#matchTopicToCore` 【同一套】：
//   先按分隔符切开，再看每段【是否包含】核心词名 / 同义词（子串匹配，不要求完全相等）。
//   ⛔ 别在这里另写一套（比如改成完全相等）—— 那会让「AI应用」类的大类在这条链上失效。
//   唯一的增强：**长词优先**（「文化传媒」比「传媒」更具体），保证结果稳定可复现。
// ══════════════════════════════════════════════════════════════════════════════════════

/**
 * 题材串分隔符。与 `topic/rules.js#TOPIC_WORD_SEP_RE` 同一批分隔符，另加 `/ + |`
 * （每日行上确实出现过「AI应用+算力」这种写法，不切开会整段匹配不上）。
 *
 * ⚠️ 为什么不直接 import TOPIC_WORD_SEP_RE：那个常量住在 `topic/rules.js`，而该模块链着
 *   app-state / uiStore / 云端读写（有副作用与会话状态）。本模块被【纯函数】规则层依赖，
 *   必须保持零依赖，否则单测会被拖进整条 store 链路。
 */
const TOPIC_SEG_SPLIT_RE = /[,，、;；/+|]/;

/**
 * 按统一分隔符把题材串切成段（去空、去重、保持原顺序）。
 * @param {string|null|undefined} text
 * @returns {string[]}
 */
export function splitTopicSegments(text) {
  const t = String(text === null || text === undefined ? '' : text).trim();
  if (!t) return [];
  const seen = new Set();
  const out = [];
  t.split(TOPIC_SEG_SPLIT_RE).forEach(function (s) {
    const v = String(s || '').trim();
    if (!v) return;
    const key = v.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(v);
  });
  return out;
}

/**
 * 把核心词表摊平成「token（名字 + 同义词）→ 大类名」的索引，按 token 长度降序。
 * @param {Array<{name:string, synonyms?:string[]}>|null} coreTopics
 * @returns {Array<{lower:string, name:string}>}
 */
export function buildCoreTokenIndex(coreTopics) {
  const idx = [];
  (Array.isArray(coreTopics) ? coreTopics : []).forEach(function (core) {
    if (!core || typeof core.name !== 'string' || !core.name.trim()) return;
    const name = core.name.trim();
    const toks = [name].concat(Array.isArray(core.synonyms) ? core.synonyms : []);
    toks.forEach(function (tok) {
      const s = String(tok === null || tok === undefined ? '' : tok).trim();
      if (!s) return;
      idx.push({ lower: s.toLowerCase(), name: name });
    });
  });
  // 长词优先：'文化传媒' 应先于 '传媒' 命中；同长按 token 字典序，保证结果可复现（§6 不随加载顺序漂移）
  idx.sort(function (a, b) {
    if (b.lower.length !== a.lower.length) return b.lower.length - a.lower.length;
    return a.lower < b.lower ? -1 : (a.lower > b.lower ? 1 : 0);
  });
  return idx;
}

/**
 * 单个题材段 → 大类名（子串匹配；匹配不到 ⇒ 空串）。
 * @param {string} segment
 * @param {Array<{lower:string, name:string}>} index buildCoreTokenIndex 的返回
 * @returns {string}
 */
export function coreTopicOf(segment, index) {
  const s = String(segment === null || segment === undefined ? '' : segment).trim();
  if (!s) return '';
  const lower = s.toLowerCase();
  const idx = Array.isArray(index) ? index : [];
  for (let i = 0; i < idx.length; i++) {
    if (lower.indexOf(idx[i].lower) >= 0) return idx[i].name;
  }
  return '';
}

/**
 * 造一个「题材串 → 大类串」的归一函数。
 *
 * @param {Array<{name:string, synonyms?:string[]}>|null} coreTopics 核心词表（组合式从 getCoreTopics() 注入）
 * @returns {(raw:string) => string}
 *          返回归一大类串（多段命中不同大类时用「,」连接）；**匹配不到 ⇒ 原样返回该段**
 *          （⛔ 不返回空串：没登记进核心词的题材仍然是它自己，不能因为「不认识」就丢掉）。
 *          输入为空 / 纯空白 ⇒ 返回 ''（§10：空就是空，不造值）。
 */
export function makeCoreTopicResolver(coreTopics) {
  const index = buildCoreTokenIndex(coreTopics);
  if (index.length === 0) {
    // 核心词表还没读到 ⇒ 恒等（原样返回）—— 与「不传这个参数」零差别（§11）
    return function (raw) {
      return String(raw === null || raw === undefined ? '' : raw).trim();
    };
  }
  return function (raw) {
    const segs = splitTopicSegments(raw);
    if (segs.length === 0) return '';
    const out = [];
    for (let i = 0; i < segs.length; i++) {
      const c = coreTopicOf(segs[i], index) || segs[i];
      if (out.indexOf(c) < 0) out.push(c);
    }
    return out.join(',');
  };
}
