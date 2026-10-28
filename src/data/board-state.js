import { state } from '../logic/app-state.js';

const MODULE_KEYS = ['stocks', 'rank', 'multi', 'hotspot', 'pattern', 'tagTitles'];

const _stocksMemCache = state._stocksMemCache = {};
const _rankMemCache = state._rankMemCache = {};
const _multiMemCache = state._multiMemCache = {};
const _hotspotMemCache = state._hotspotMemCache = {};
const _patternMemCache = state._patternMemCache = {};
const _tagTitlesMemCache = state._tagTitlesMemCache = {};

const _caches = {
  stocks: _stocksMemCache,
  rank: _rankMemCache,
  multi: _multiMemCache,
  hotspot: _hotspotMemCache,
  pattern: _patternMemCache,
  tagTitles: _tagTitlesMemCache
};

const _dirty = {
  stocks: new Set(),
  rank: new Set(),
  multi: new Set(),
  hotspot: new Set(),
  pattern: new Set(),
  tagTitles: new Set()
};

const _lastPushed = {
  stocks: {},
  rank: {},
  multi: {},
  hotspot: {},
  pattern: {},
  tagTitles: {}
};

// ── ★★ [PATTERN-LOST 2026-10-14 事故修] 模式看板「本地写入」护栏状态 ─────────────────────
//   为什么放在这里（而不是 data/board-pattern.js）：本模块是【零依赖叶子状态模块】，
//   Logic 层（logic/pattern/pattern.js 的保存入口）也能安全 import 它。
//   ⛔ 若把这两个 map 放在 board-pattern.js，就会形成
//      logic/pattern/pattern.js → data/board-pattern.js → data/supabase-client.js 的环，
//      Vite/SSR 下会出现「getSupabase is not a function」这种初始化顺序问题（已实测踩到）。
//   语义与完整根因说明见 data/board-pattern.js 头部。
const _patternWriteSeq = {};     // date → 本地写入序号（每次本地保存 ++）
const _patternWriteGuardUntil = {}; // date → 本地写入后的保护截止时间（毫秒时间戳）
const PATTERN_LOCAL_WRITE_GUARD_MS = 5000;

/**
 * 登记一次【本地写入】（模式看板保存入口调用，§6：这一句只有一处）。
 * 从此刻起：① 发起于此刻之前的云端读回一律不许覆盖本地缓存；② 之后 5 秒内一律让本地值赢。
 * @param {string} date YYYY-MM-DD
 */
function notePatternLocalWrite(date) {
  if (!date) return;
  const d = String(date);
  _patternWriteSeq[d] = (_patternWriteSeq[d] || 0) + 1;
  _patternWriteGuardUntil[d] = Date.now() + PATTERN_LOCAL_WRITE_GUARD_MS;
}

// ── ★★ [BOARD-LOST-G3 2026-10-28 · §10/§11] 「云端到底有没有这一行」与「这次读取有没有失败」─────
//   为什么需要这两个集合：`saveXxxForDate` 原来一律 `_xxxMemCache[date] || 空值` 再 upsert，
//   于是「这一天根本没从云端读到」会被当成「用户把内容清空了」写回云端整行。两个后果：
//     ① 读取失败（网络抖 / maybeSingle 报错）后一次推送 ⇒ 用空值覆盖云端【有内容】的行 —— 真丢数据（§10 红线）；
//     ② 云端本来没有这一天 ⇒ 每次刷新都白建一条 `data: []` 的空行 —— 既污染表，又白花一次写请求。
//   实测（2026-10-28 · 生产包 + 无头 Chrome）：一次刷新即发出 rank_data / multi_data /
//   hotspot_data / tag_titles_data 四条 `{date, data:[]}` 空写（详见 .tmpdiag/audit-boot-writes.cjs）。
//   修法只用「记录事实」，不改变任何读写语义 —— 缓存该给的东西照给，只是保存时知道该不该推。
//   ⚠️ 放在本模块（零依赖叶子状态）而不是各 board-*.js：避免 logic → data → supabase-client 的环。
const _cloudRowExists = {
  stocks: new Set(), rank: new Set(), multi: new Set(),
  hotspot: new Set(), pattern: new Set(), tagTitles: new Set()
};
const _loadFailedDates = {
  stocks: new Set(), rank: new Set(), multi: new Set(),
  hotspot: new Set(), pattern: new Set(), tagTitles: new Set()
};

export {
  MODULE_KEYS,
  _stocksMemCache,
  _rankMemCache,
  _multiMemCache,
  _hotspotMemCache,
  _patternMemCache,
  _tagTitlesMemCache,
  _caches,
  _dirty,
  _lastPushed,
  _cloudRowExists,
  _loadFailedDates,
  _patternWriteSeq,
  _patternWriteGuardUntil,
  PATTERN_LOCAL_WRITE_GUARD_MS,
  notePatternLocalWrite
};
