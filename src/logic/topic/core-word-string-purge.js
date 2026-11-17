// core-word-string-purge.js — 「删核心词 ⇒ 同步清理竞价名单里的题材串」的唯一实现（Logic 层）
//
// ══════════════════════════════════════════════════════════════════════════════════════
// 用户口径（2026-11-17 原话，逐字）：
//   「我希望我删除核心词后，连同同义词一起删除，之前有过同义词的股票的题材窜中的同义词也一起删除，
//     也就是早盘竞价看板的股票双击竞价量出来的那个note字段和和单击昨日成交量列显示的那个toast，
//     也要把对应的同义词删除，其它题材窜要保留，这个特别注意，不要误删，也不要错删，
//     也就是说这几个地方要同步。比如东方海洋，细分题材有(水产品,农业,东方,羊字辈)，
//     我删除核心词东方后，变成只显示东方海洋(水产品,农业,羊字辈)，
//     我删除羊字辈核心词后，变成显示(水产品,农业)」
//
// 与 core-word-purge.js 的分工（⛔ 不要混）：
//   · core-word-purge.js      → 管 **`stock_topics` 共享题材库**（一票一行，`水产品,农业`）
//   · 本模块                  → 管 **`auction_watchlist` 的 note / topics 两列**（一日一票一行，
//                               note 形如 `10.02%(水产品,农业,东方,羊字辈)`）
//   两者都改，三个看板 + 两处弹窗才真正「同步」；只改前者就会出现用户报的现象：
//   核心词删了，双击竞价量弹出来的还是四个题材。
//
// ── 为什么必须「精确等于才删」而不是子串 ──────────────────────────────────────────────
//   归类（匹配）用子串是为了收得进大类；删除用子串会误伤且不可逆（§11）：
//   实测库内删「稀土」会连「稀土永磁」一起删、删「半导体」会波及「第三代半导体」。
//   用户原话也点名了这一点：「其它题材窜要保留，这个特别注意，不要误删，也不要错删」。
//
// ── 为什么还要「读 → 计划 → 确认 → 写 → 回读验证」（§11）────────────────────────────
//   note 是历史日的当日事实，写错了不可逆；本模块只做两件事：
//     ① 摘掉整段相等的题材段；② 其余一个字不动（包括 `10.02%` 这种涨幅前缀与其它括号段）。
//   ⛔ 绝不把 note 变成 `()`、⛔ 绝不把 topics 列整行清空（整行都是这个词 ⇒ 进 blocked 跳过并上报）。
// ══════════════════════════════════════════════════════════════════════════════════════

import {
  readAuctionRowsByTopicTokens,
  writeAuctionTopicStringsBatch,
  readAuctionTopicStringsForRows,
  applyAuctionTopicStringsToMemory
} from '../../data/auction-topic-strings.js';
import { clearAuctionNoteTopicsCache } from '../../data/auction-note-topics.js';
import { _dbgLog } from '../../data/debug-log.js';

/** 题材段分隔符：英文/中文逗号、顿号、分号、加号（与 note/helpers.js 的清洗口径一致） */
const SEG_SPLIT_RE = /[+，,、;；]/;
/** note 里的括号段：半角与全角都认，且不允许嵌套（与 parseNoteToFields 同口径） */
const BRACKET_RE = /[(（]([^()（）]*)[)）]/g;

/**
 * 把一段文本切成题材段（去空白、丢空段；⛔ 不去重 —— 去重由清洗层负责，这里只做切分）。
 * @param {string} text
 * @returns {string[]}
 */
export function splitTopicSegments(text) {
  const s = String(text === null || text === undefined ? '' : text);
  if (!s.trim()) return [];
  return s.split(SEG_SPLIT_RE).map(function(t) { return t.trim(); }).filter(function(t) { return !!t; });
}

function _tokenSet(tokens) {
  const set = new Set();
  (Array.isArray(tokens) ? tokens : []).forEach(function(t) {
    const v = String(t === null || t === undefined ? '' : t).trim().toLowerCase();
    if (v) set.add(v);
  });
  return set;
}

/**
 * 从 note 文本里摘掉「整段等于 tokens」的题材段，**其余内容一个字不动**（纯函数，§15）。
 *
 * 例：`purgeNoteText('10.02%(水产品,农业,东方,羊字辈)', ['东方'])`
 *   ⇒ `{ text: '10.02%(水产品,农业,羊字辈)', removed: ['东方'] }`
 *
 * 边界（都有单测）：
 *   · 括号里删空了 ⇒ 整个括号丢掉（⛔ 不留 `()`，否则会渲染成一个空题材）；
 *   · 多个括号段 / 全角括号 / 中文逗号 ⇒ 各自处理，互不影响；
 *   · 只是包含（子串）不删 —— 例如删「稀土」不会动「稀土永磁」；
 *   · 没命中 ⇒ 原样返回（文本逐字相同 ⇒ 上层可以直接跳过这一行，不产生写请求）。
 *
 * @param {string} note
 * @param {string[]} tokens 核心词 + 同义词
 * @returns {{text:string, removed:string[]}}
 */
export function purgeNoteText(note, tokens) {
  const src = String(note === null || note === undefined ? '' : note);
  const set = _tokenSet(tokens);
  if (!src || set.size === 0) return { text: src, removed: [] };
  BRACKET_RE.lastIndex = 0;
  let out = '';
  let last = 0;
  const removed = [];
  let m = BRACKET_RE.exec(src);
  while (m) {
    out += src.slice(last, m.index);
    last = m.index + m[0].length;
    const segs = splitTopicSegments(m[1]);
    const kept = [];
    let hit = 0;
    segs.forEach(function(seg) {
      if (set.has(seg.toLowerCase())) { removed.push(seg); hit++; return; }
      kept.push(seg);
    });
    // ★ 括号里【一个都没命中】⇒ 原样保留这段括号（连全角逗号 / 空格都不动）。
    //   否则「删东方」会顺手把 `-0.89%(物流，外贸)` 改写成本不该变的 `(物流,外贸)` ——
    //   那是用户没要求的改动，且会让「内容没变」的行也产生一次写请求。
    if (hit === 0) out += m[0];
    else if (kept.length > 0) out += '(' + kept.join(',') + ')';
    m = BRACKET_RE.exec(src);
  }
  out += src.slice(last);
  return { text: out, removed: removed };
}

/**
 * 从 `topics` 列（`水产品,农业,东方,羊字辈`）里摘掉整段相等的题材（纯函数，§15）。
 *
 * 结果为空串 = 「这行的题材全是这个词」——本函数如实返回，**是否允许写由计划层判**（blocked）。
 *
 * @param {string|string[]} topics
 * @param {string[]} tokens
 * @returns {{text:string, removed:string[]}}
 */
export function purgeTopicsText(topics, tokens) {
  const src = Array.isArray(topics) ? topics.join(',') : String(topics === null || topics === undefined ? '' : topics);
  const set = _tokenSet(tokens);
  if (!src.trim() || set.size === 0) return { text: src, removed: [] };
  const segs = splitTopicSegments(src);
  const kept = [];
  const removed = [];
  segs.forEach(function(seg) {
    if (set.has(seg.toLowerCase())) { removed.push(seg); return; }
    kept.push(seg);
  });
  if (removed.length === 0) return { text: src, removed: [] };
  return { text: kept.join(','), removed: removed };
}

/** 统计一段 note 里所有括号段的题材条数（用于判断「删完是不是整行都空了」） */
function _noteSegmentCount(note) {
  const src = String(note === null || note === undefined ? '' : note);
  if (!src) return 0;
  BRACKET_RE.lastIndex = 0;
  let n = 0;
  let m = BRACKET_RE.exec(src);
  while (m) {
    n += splitTopicSegments(m[1]).length;
    m = BRACKET_RE.exec(src);
  }
  return n;
}

/**
 * 算出「删掉这些词之后，每行 note / topics 各要改成什么」——纯函数，无 IO，可单测（§15）。
 *
 * @param {Array<{date:string, stock:string, note:string, topics:string}>} rows 库里读回来的行
 * @param {string[]} tokens 核心词 + 同义词
 * @returns {{
 *   tokens: string[],
 *   rows: Array<{date:string, stock:string, oldNote:string, newNote:string, oldTopics:string, newTopics:string, removed:string[]}>,
 *   blocked: Array<{date:string, stock:string, removed:string[]}>,
 *   affectedRows: number, affectedStocks: number, removedWords: number,
 *   dates: string[], dateCount: number, totalRowsRead: number
 * }}
 */
export function planTopicStringPurge(rows, tokens) {
  const list = Array.isArray(rows) ? rows : [];
  const tokenList = (Array.isArray(tokens) ? tokens : []).map(function(t) {
    return String(t === null || t === undefined ? '' : t).trim();
  }).filter(Boolean);
  const plan = {
    tokens: tokenList,
    rows: [],
    blocked: [],
    affectedRows: 0,
    affectedStocks: 0,
    removedWords: 0,
    dates: [],
    dateCount: 0,
    totalRowsRead: list.length
  };
  if (tokenList.length === 0) return plan;

  const stockSet = new Set();
  const dateSet = new Set();
  list.forEach(function(r) {
    if (!r || !r.stock || !r.date) return;
    const note = String(r.note === null || r.note === undefined ? '' : r.note);
    const topics = Array.isArray(r.topics) ? r.topics.join(',') : String(r.topics === null || r.topics === undefined ? '' : r.topics);
    const n = purgeNoteText(note, tokenList);
    const t = purgeTopicsText(topics, tokenList);
    const removed = n.removed.concat(t.removed);
    if (removed.length === 0) return;

    // §11：删完「这一行的题材一条不剩」⇒ 跳过并上报，⛔ 不把整行清空
    const beforeCount = _noteSegmentCount(note) + splitTopicSegments(topics).length;
    const afterCount = _noteSegmentCount(n.text) + splitTopicSegments(t.text).length;
    if (beforeCount > 0 && afterCount === 0) {
      plan.blocked.push({ date: r.date, stock: r.stock, removed: removed });
      return;
    }

    plan.rows.push({
      date: String(r.date).trim(),
      stock: String(r.stock).trim(),
      oldNote: note,
      newNote: n.text,
      oldTopics: topics,
      newTopics: t.text,
      removed: removed
    });
    stockSet.add(String(r.stock).trim());
    dateSet.add(String(r.date).trim());
  });

  plan.affectedRows = plan.rows.length;
  plan.affectedStocks = stockSet.size;
  plan.removedWords = plan.rows.reduce(function(a, r) { return a + r.removed.length; }, 0);
  plan.dates = Array.from(dateSet).sort();
  plan.dateCount = plan.dates.length;
  return plan;
}

/**
 * 读云端 + 出计划（**只读，不写**）。
 *
 * §10：读失败直接把异常抛给调用方（⛔ 不返回「0 行」的假计划 —— 那会让上层以为「库里本来就没有」）。
 *
 * @param {string[]} tokens
 * @returns {Promise<object>} planTopicStringPurge 的返回
 */
export async function previewTopicStringPurge(tokens) {
  const rows = await readAuctionRowsByTopicTokens(tokens);
  return planTopicStringPurge(rows, tokens);
}

/**
 * 执行清理：写云端 → 同步内存 → 作废 note 缓存 → **回读验证**（§11 执行后必须验证）。
 *
 * @param {object} plan planTopicStringPurge 的返回
 * @returns {Promise<{written:number, verified:boolean, stillBad:Array, memoryRows:number}>}
 * @throws 写入失败（调用方据此提示「核心词已删、题材串未清理」）
 */
export async function applyTopicStringPurge(plan) {
  const p = plan || {};
  const rows = Array.isArray(p.rows) ? p.rows : [];
  if (rows.length === 0) return { written: 0, verified: true, stillBad: [], memoryRows: 0 };

  const payload = rows.map(function(r) {
    return { date: r.date, stock: r.stock, note: r.newNote, topics: r.newTopics };
  });
  const res = await writeAuctionTopicStringsBatch(payload);
  _dbgLog('[CORE-PURGE] 已从 ' + res.count + ' 行竞价名单里移除 ' + p.removedWords + ' 个题材段');

  // ① 内存同步：不刷内存的话「云端改了、屏幕没变」（用户看到的就是旧题材）
  const memoryRows = applyAuctionTopicStringsToMemory(payload);

  // ② 作废「按日期读 note/topics」的会话缓存（第三十四条延伸 ABN-TB 用的就是它，
  //    不作废会继续按旧题材判「异动第三天同题材」）
  clearAuctionNoteTopicsCache();

  // ③ 回读验证：目标词必须真的从这些行里消失
  const tokenSet = _tokenSet(p.tokens);
  let after = null;
  try {
    after = await readAuctionTopicStringsForRows(payload);
  } catch (e) {
    _dbgLog('[CORE-PURGE] 题材串回读校验失败: ' + (e && e.message || e));
  }
  const stillBad = [];
  if (after) {
    rows.forEach(function(r) {
      const cur = after.get(String(r.date).trim() + '|' + String(r.stock).trim());
      if (!cur) return;
      const stillNote = splitTopicSegments(cur.note).filter(function(s) { return tokenSet.has(s.toLowerCase()); });
      const stillTopics = splitTopicSegments(cur.topics).filter(function(s) { return tokenSet.has(s.toLowerCase()); });
      const still = stillNote.concat(stillTopics);
      if (still.length > 0) stillBad.push({ date: r.date, stock: r.stock, still: still });
    });
  }
  return {
    written: res.count,
    verified: !!after && stillBad.length === 0,
    stillBad: stillBad,
    memoryRows: memoryRows
  };
}
