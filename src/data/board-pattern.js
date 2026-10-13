// 模式看板（pattern_data）· Data 层唯一读写入口
//
// ═══════════════════════════════════════════════════════════════════════════
// ★★ [PATTERN-LOST 2026-10-14 事故修 · 根因] 「写入很长的文字，显示了，之后就消失了」
//
// 现场（线上 pattern_data 表实测）：**每一天那行的 content 全是空的**（连 9 月的都是），
//   用户明明保存过内容 ⇒ 说明每次保存都被「擦掉」了。
//
// 根因（已用 mock fetch 写回归复现）：**一次「在途的旧读回」把刚保存的内容覆盖成空**：
//   ① 用户点保存 ⇒ 组件先把内容写进内存缓存、再 await 直连 upsert（云端 = 新内容 ✅）；
//   ② 与此同时有一次【在它之前发起】的 loadPatternForDate（来源：pattern_data 的 Realtime
//      回显 / 日期切换 / 首载兜底）正在飞行中，它带的是【旧值（空）】；
//   ③ 它落地时【无条件】把内存缓存覆盖成空 —— 刚保存的内容就此消失；
//   ④ 紧接着 saveData() 的 1.2s 防抖脏推送（saveData 会把 pattern 一起标脏）把
//      【已经被污染成空的缓存】写回云端 ⇒ 云端内容被真抹掉；
//   ⑤ 云端这次的写入又触发一次 Realtime 回显 ⇒ 再读一次（这次读到空）⇒ UI 也变空。
//   ⇒ 用户看到的就是「显示了（乐观更新）→ 之后就消失了（云端已被抹）」，并且**永远存不住**。
//
// 为什么偏偏是「很长的文字」：长文本要写/改更久 ⇒ 保存那一刻「有在途读回」的概率接近 1。
//
// 修法（§10 宁缺勿错 / §6 一处收口 / §11 默认零行为变化）：
//   · G1【根因】读回护栏 —— 本地写过的内容，绝不被一次「发起于本地写之前的旧读回」覆盖：
//     读发起时快照本地写入序号，落地时序号变过 ⇒ 这次读回是旧值 ⇒ **丢弃**（不写缓存）。
//     另设一个短的「本地刚写过」保护窗，盖住「读发起于本地写之后、但云端还没提交」的窄窗。
//   · G2【放大器】§10 —— 缓存里**没有**这个日期时，绝不凭空造一个空对象推上云端
//     （未知 ≠ 空；旧实现 `_patternMemCache[date] || {content:''}` 会把「没加载过」写成「空内容」）。
//
// ⛔ 不改列名、不改表、不改调用方语义：只在「读回能不能覆盖缓存」「能不能推这个日期」两处加闸门。
// ═══════════════════════════════════════════════════════════════════════════
import { getSupabase } from './supabase-client.js';
import { _warn } from './board-helpers.js';
import {
  _patternMemCache,
  _lastPushed,
  _patternWriteSeq,
  _patternWriteGuardUntil
} from './board-state.js';

/**
 * 这次云端读回【能不能覆盖本地缓存】（G1 的判据收口，§6）。
 *
 * ⛔ 护栏状态（_patternWriteSeq / _patternWriteGuardUntil）住在 data/board-state.js ——
 *    那边是零依赖叶子模块，Logic 层的保存入口才能安全共用（放本文件会成环，已实测踩到）。
 *
 * @param {string} date 日期
 * @param {number} seqAtIssue 读发起时的本地写入序号（调用方在 await 之前快照）
 * @returns {boolean} true = 可以覆盖；false = 这次读回是【旧值】⇒ 丢弃（保住本地内容）
 */
function canApplyPatternCloudRead(date, seqAtIssue) {
  if (!date) return false;
  const d = String(date);
  // ① 读期间本地写过 ⇒ 这次读回发起于本地写之前 ⇒ 一定是旧值（★ 线上事故的直接原因）
  if ((_patternWriteSeq[d] || 0) !== (seqAtIssue || 0)) return false;
  // ② 本地刚写过（保护窗内）⇒ 云端可能还没提交完，读回来的是旧值 ⇒ 让本地赢
  if ((_patternWriteGuardUntil[d] || 0) > Date.now()) return false;
  return true;
}

async function loadPatternForDate(date) {
  if (!date) return;
  // ★ [PATTERN-LOST G1] 在【发起读之前】快照本地写入序号；读回落地时用它判「这次读回是不是旧的」。
  const seqAtIssue = _patternWriteSeq[String(date)] || 0;
  try {
    const sb = getSupabase();
    const { data, error } = await sb
      .from('pattern_data')
      .select('*')
      .eq('date', date)
      .maybeSingle();
    if (error) throw error;
    // ★ [PATTERN-LOST G1] 读回护栏：本地写过之后，旧读回不许覆盖缓存（否则用户刚存的内容会被抹掉）
    if (!canApplyPatternCloudRead(date, seqAtIssue)) return;
    const defaultVal = { content: '', update: false, keep: false };
    const val = data
      ? { content: data.content || '', update: !!data.update_flag, keep: !!data.keep_flag }
      : (_patternMemCache[date] || defaultVal);
    _patternMemCache[date] = val;
    _lastPushed.pattern[date] = JSON.stringify(val);
  } catch (e) {
    _warn('loadPatternForDate ' + date + ' 失败: ' + (e.message || e));
  }
}

async function savePatternForDate(date) {
  if (!date) return;
  const cached = _patternMemCache[date];
  // ★ [PATTERN-LOST G2 · §10 宁缺勿错] 缓存里【没有】这一天 ⇒ 不推。
  //   旧实现 `_patternMemCache[date] || {content:'', ...}` 会把「这一天根本没加载过」当成
  //   「用户把内容清空了」写进云端 —— 那是拿未知当已知（线上所有日期 content 全空，正是被它放大的）。
  if (!cached) return;
  const p = cached;
  try {
    const sb = getSupabase();
    await sb.from('pattern_data').upsert({
      date,
      content: p.content || '',
      update_flag: !!p.update,
      keep_flag: !!p.keep
    }, { onConflict: 'date' });
    _lastPushed.pattern[date] = JSON.stringify(p);
  } catch (e) {
    _warn('savePatternForDate ' + date + ' 失败: ' + (e.message || e));
    throw e;
  }
}

export { loadPatternForDate, savePatternForDate };
