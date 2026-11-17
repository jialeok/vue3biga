// abnormal-topic-ban.js — 第三十四条【延伸分支 ABN-TB】「异动后的第三天 ⇒ 同题材禁入」的唯一判定实现
//
// ══════════════════════════════════════════════════════════════════════════════════════
// ★★ 用户口径（2026-11-17 原话，逐字）★★
// ══════════════════════════════════════════════════════════════════════════════════════
//   「1.记住总龙一第一次监管异动，之后两天，次日本来现在的规则不能买，不变，在第三天都不能买
//     它题材的股票，比如东方海洋，细分题材有(水产品,农业,东方,羊字辈)，第三天，不能选入其它
//     同题材的股票进入买点侧，临时题材包括在内。
//     比如日出东方不该选入11月16日的买点侧，日出东方(家电,热泵,东方)，含有题材窜东方就不行，
//     如果它题材窜含有水产品，或者农业，或者羊字辈也不行（11月12日总龙一含有的题材窜细分题材），
//     不能选入当天买点侧。
//     也就是重点监控第三天，第四天按照正常流程走。」
//
// ── 时间轴（真实落地数据，⛔ 这就是本条的全部判据来源）────────────────────────────────────
//   11-12（周四）异动日：东方海洋 十日涨幅（9:26 竞价口径）**+100.78%** ＞ 97%
//     细分题材（当日 `auction_watchlist.note` 括号内）= `水产品,农业,东方,羊字辈`
//   11-13（周五）次日：第三十四条原口径已判【全场空仓】 —— 正确处理，本条【不接管】
//   11-16（周一）第三天：题材量比仍选出【日出东方】(家电,热泵,东方) —— **本条要堵的缺口**
//   11-17（周二）第四天：恢复正常流程 —— 本条【不生效】
//
// ── 职责边界（§3 / §4 / §21）────────────────────────────────────────────────────────
//   · 本模块只做三件事：① 把 note 拆成题材段；② 判「今天是不是第三天 + 禁令集合是什么」；
//     ③ 把结果拼成一块可渲染的提示板文案。⛔ 不取数、不落库、不发请求、不删票；
//   · 交易日链（今天是异动日 + 几个交易日）由组合式算好注入 —— 与 `detectEbbDay` 的
//     `prevDate / prevPrevDate` 同一范式，⛔ 不把 `getPreviousTradingDay` 拖进纯函数；
//   · ⛔ 不判「要不要全场空仓」：那是第三十四条原口径（abnormal-10d.js）的事，
//     本条只禁**同题材**，其它题材今天该买照买。
//
// §10 红线（⛔ 一次都不能破）：
//   · 异动日的细分题材读不到 ⇒ `unknown = true`，提示板如实写「判不出」，
//     ⛔ 绝不当成「今天没有同题材」静默放行（那是把「没数据」当成「没风险」）；
//   · 不是第三天 ⇒ 返回稳定的 NONE 引用（§19：不白白触发下游重算）。
// ══════════════════════════════════════════════════════════════════════════════════════

import { splitTopicSegments } from '../topic/core-category.js';
import {
  ABNORMAL_RULE_NO, TVRB_RANGE10_CAP, ABNORMAL_TOPIC_BAN_DAY_OFFSET,
  ABNORMAL_TOPIC_BAN_TAG, TVRB_ABNORMAL_TOPIC_BAN_NONE
} from './tvrb-constants.js';
import { isOverRange10Cap } from './abnormal-10d.js';

/** 把若干来源的题材段合并去重（大小写不敏感去重，保留首次出现的原始写法与顺序） */
function _mergeSegments(lists) {
  const seen = new Set();
  const out = [];
  (lists || []).forEach(function(list) {
    (Array.isArray(list) ? list : []).forEach(function(raw) {
      const v = String(raw === null || raw === undefined ? '' : raw).trim();
      if (!v) return;
      const key = v.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push(v);
    });
  });
  return out;
}

/**
 * 【纯函数 · §15】从竞价名单的 `note` 里取出【细分题材串】。
 *
 * 真实形态（`auction_watchlist.note`，11-12 库内原值）：
 *   `10.02%(水产品,农业,东方,羊字辈)` / `-1.68%(通信,AI应用,东方)` / `""` / `null`
 * ⇒ 只认【最后一个括号】里的内容；⛔ 不把 note 里其它文字当题材。
 *
 * ⚠️ 为什么必须从 note 取、不能只查题材库：`stock_topics` 里 东方海洋 只有 `水产品,农业`
 *   （缺 `东方 / 羊字辈`），而用户点名的正是 `水产品,农业,东方,羊字辈` ⇒ 只查库会漏掉
 *   【东方】这个临时题材，日出东方就会被放行 —— 那正是本条要修的那个错。
 *
 * @param {string|null|undefined} note
 * @returns {string[]} 题材段（读不到 / 没有括号 ⇒ 空数组，§10 不猜）
 */
export function parseNoteTopics(note) {
  const s = String(note === null || note === undefined ? '' : note).trim();
  if (!s) return [];
  const re = /[(（]([^()（）]*)[)）]/g;
  let last = null;
  let m = re.exec(s);
  while (m) { last = m[1]; m = re.exec(s); }
  if (last === null) return [];
  return splitTopicSegments(last);
}

/**
 * 【纯函数 · §15】某只票的题材段是否命中【第三天同题材禁令】。
 *
 * 认亲口径 = **整段相等**（大小写不敏感），⛔ 不做子串模糊：
 *   · 「东方」 vs 「东方海洋」 —— 前者是题材段、后者是股票名，不做包含匹配；
 *   · 「AI应用」 vs 「AI」 —— 子串匹配会把不相干的题材认成一家。
 *   两边都由 `splitTopicSegments` 切成段，所以 `家电,热泵,东方` 里的【东方】能命中。
 *
 * @param {string[]} segments 候选的题材段
 * @param {object|null} ban buildAbnormalTopicBan 的返回
 * @returns {boolean}
 */
export function abnormalTopicBanHit(segments, ban) {
  if (!ban || ban.active !== true) return false;
  const forbid = Array.isArray(ban.segments) ? ban.segments : [];
  if (forbid.length === 0) return false;
  const set = new Set(forbid.map(function(t) { return String(t).trim().toLowerCase(); }));
  return (Array.isArray(segments) ? segments : []).some(function(t) {
    return set.has(String(t === null || t === undefined ? '' : t).trim().toLowerCase());
  });
}

/**
 * 【纯函数 · §15】组装「今天要不要执行第三天同题材禁令」。
 *
 * @param {object} [input]
 * @param {number|null} [input.dayOffset] 今天离异动日【几个交易日】（组合式算好注入）：
 *        1 = 次日（第三十四条原口径：全场空仓）｜2 = **第三天（本条的生效日）**｜≥3 = 第四天起，不生效。
 * @param {string} [input.triggerDate] 异动日（用户说的「第一次监管异动」那天）
 * @param {string} [input.todayDate]   今天（展示日）
 * @param {string} [input.leaderName]  异动日那【一只】票（触发源，⛔ 不许拿今天的总龙一顶替）
 * @param {number|string|null} [input.leaderPct] 它异动当日的十日涨幅（竞价口径），只用于文案
 * @param {string} [input.todayPctText] 它的十日涨幅文案（已格式化，⚠️ 由调用方给，本模块不重复 format）
 * @param {string[]} [input.noteTopics] 异动日 `auction_watchlist.note` 里的细分题材（来自 parseNoteTopics）
 * @param {string[]} [input.libTopics]  异动日那只票在题材库里的题材
 * @returns {object} 与 TVRB_ABNORMAL_TOPIC_BAN_NONE 同形状：
 *   `active` = 今天真的要执行（调用方据此灰化 / 改标签 / 挂提示板）；
 *   `unknown` = 是第三天但判不出题材（§10：提示板要如实说，⛔ 不静默放行）。
 */
export function buildAbnormalTopicBan(input) {
  const i = input || {};
  const off = (typeof i.dayOffset === 'number' && isFinite(i.dayOffset)) ? i.dayOffset : null;
  const leaderName = String(i.leaderName || '').trim();
  const triggerDate = String(i.triggerDate || '').trim();
  const todayDate = String(i.todayDate || '').trim();
  const pctN = Number(String(i.leaderPct === null || i.leaderPct === undefined ? '' : i.leaderPct)
    .replace('%', '').trim());
  const pctText = String(i.todayPctText || '').trim() || (isFinite(pctN) ? (pctN > 0 ? '+' : '') + pctN.toFixed(2) + '%' : '—');

  const noteTopics = _mergeSegments([i.noteTopics]);
  const libTopics = _mergeSegments([i.libTopics]);
  const segments = _mergeSegments([noteTopics, libTopics]);

  // ① 不是第三天 ⇒ 稳定 NONE（§19：同一引用，不触发下游重算）
  if (off !== ABNORMAL_TOPIC_BAN_DAY_OFFSET) return TVRB_ABNORMAL_TOPIC_BAN_NONE;

  // ①-b ★ 触发线自检：调用方给了【具体数值】就必须自己先过线，否则本条不生效。
  //   为什么放在本模块而不是只靠调用方：这条判据一旦被调用方漏掉，就会出现
  //   「D-2 根本没异动、今天却被禁买」这种**反向错误**（比漏禁更坏 —— 会白白错过买点）。
  //   ⚠️ 只在给到有限数字时校验；null（没读到）⇒ 交给下面的 unknown 分支如实交代（§10）。
  if (isFinite(pctN) && !isOverRange10Cap(pctN)) return TVRB_ABNORMAL_TOPIC_BAN_NONE;

  const base = {
    active: false,
    unknown: false,
    dayOffset: off,
    triggerDate: triggerDate,
    todayDate: todayDate,
    leaderName: leaderName,
    leaderPctText: pctText,
    segments: Object.freeze(segments),
    noteTopics: Object.freeze(noteTopics),
    libTopics: Object.freeze(libTopics),
    headline: '',
    detail: ''
  };

  // ② 是第三天但触发源 / 细分题材判不出 ⇒ 如实标 unknown（§10，⛔ 不静默放行）
  if (!leaderName) {
    return Object.assign(base, {
      unknown: true,
      detail: '⚠️【第' + ABNORMAL_RULE_NO + '条 · 延伸】今天是异动日后的【第三天】，' +
        '但判不出「异动日那只票」是谁（当日竞价口径十日涨幅读不到 / 主板过滤后无票）' +
        '⇒ 本条【判不出】，买点侧不做同题材剔除（§10：判不出 ≠ 没有同题材，请复核云端数据）。'
    });
  }
  if (segments.length === 0) {
    return Object.assign(base, {
      unknown: true,
      detail: '⚠️【第' + ABNORMAL_RULE_NO + '条 · 延伸】今天是【' + (triggerDate || '异动日') + '】' +
        '之后的【第三天】（异动日：' + leaderName + ' 十日涨幅 ' + pctText + ' ＞ ' + TVRB_RANGE10_CAP +
        '%），但读不到它的细分题材（当日竞价名单 note 为空、题材库也没有这只票）' +
        '⇒ 本条【判不出要禁哪些题材】，买点侧不做同题材剔除（§10：判不出 ≠ 没有同题材）。'
    });
  }

  return Object.assign(base, { active: true });
}

/**
 * 【纯函数 · §21 文案在 Logic 层拼好，模板零计算】生成提示板文案。
 *
 * @param {object|null} ban buildAbnormalTopicBan 的返回
 * @param {string[]} [hitNames] 本次实际被剔除的股票（`_applyAbnormalTopicBan` 的产出）
 * @returns {{headline:string, detail:string}} 空字符串对 = 不渲染
 */
export function buildAbnormalTopicBanNotice(ban, hitNames) {
  if (!ban || (ban.active !== true && ban.unknown !== true)) return { headline: '', detail: '' };
  const seg = (Array.isArray(ban.segments) ? ban.segments : []).join('、');
  const trig = '【' + (ban.triggerDate || '异动日') + '】' + (ban.leaderName || '—') +
    ' 十日涨幅（9:26 竞价口径）' + (ban.leaderPctText || '—') + ' ＞ ' + TVRB_RANGE10_CAP + '%';

  if (ban.unknown === true) return { headline: '⚠️ 异动第三天 · 同题材监控【判不出】', detail: ban.detail };

  const names = (Array.isArray(hitNames) ? hitNames : []).filter(Boolean);
  const hitText = names.length > 0
    ? '本次已剔除：' + names.join('、') + '。'
    : '本次没有命中同题材的票（买点侧照常）。';
  return {
    headline: '⚠️ 异动第三天 · 同题材不买（其它题材照常）',
    detail: '第' + ABNORMAL_RULE_NO + '条【监管异动】的延伸：' + trig +
      ' ⇒ 今天是异动后的【第三天】（' + (ban.todayDate || '今天') + '）：' +
      '总龙一所在细分题材【' + seg + '】的股票今天【一律不进买点侧】（临时题材也算在内）。' +
      hitText +
      ' ★ 为什么：用户「总龙一影响范围很大的」——异动当天全场空仓、次日继续空仓，' +
      '但题材的崩盘节奏往往拖到第三天（11-16 的日出东方就是这样被选出来的）⇒ 第三天只禁同题材，' +
      '其它题材不受影响。⚠️ 明天（第四天）按正常流程走。' +
      '⚠️ 被剔除的票【照常列出】（灰化），只把买点标签改成【' + ABNORMAL_TOPIC_BAN_TAG +
      '】、不计入「选出 N 只」。'
  };
}
