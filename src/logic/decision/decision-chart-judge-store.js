// decision-chart-judge-store.js — 手动「竞价图形判断」的【响应式状态 + 加载 / 保存 / 订阅】（Logic 层）
//
// 分层（§15 一个业务模块 = View + Logic + Data）：
//   components/decision/ChartJudgeSelect.vue（点击）
//     → composables/useDecisionBoard.js（接线 + Toast，UI 侧入口）
//     → 本文件（状态 + 工作流：加载、乐观更新 / 回滚、Realtime 订阅）
//     → logic/decision/decision-chart-judge.js（三档映射，纯函数）
//     → data/decision-chart-judge.js（Supabase 读写 + Realtime）
//
// 为什么单独成文件而不是塞进 useDecisionBoard.js：
//   ① useDecisionBoard.js 的文件头写明「本文件不发请求、不写库」——那条红线的本意是
//     「决策看板自身不抓数据、不消费额度」。本功能是【用户手动输入】的持久化，性质完全不同，
//     但仍不该把 I/O 混进那个只做「读内存真相 + 组装」的 composable；
//   ② 与「涨跌停」看板同一套路（logic/limitpool/limit-pool.js 持有响应式 state + loadXxx，
//     composables/useLimitBoard.js 只负责 UI 时机与 Toast）—— §6 单一真相：状态只此一份。
//
// §34：本状态是【业务数据】（用户自己下的判断，要跨设备同步），不是 UI 展开态
//   ⇒ 进 Logic 层 + Supabase；⛔ 不进 localStorage（§8）、⛔ 不进纯展示态那一堆 ref。
// §10：加载失败 / 保存失败都必须【可见】（error 字段 + 向上抛），绝不静默。
// §4：乐观更新 + 回滚在【本层】做（Logic 负责工作流），UI 只负责把错误说出来。

import { reactive } from 'vue';
import {
  readDecisionChartJudgeForDate,
  saveDecisionChartJudge,
  startChartJudgeRealtime,
  stopChartJudgeRealtime
} from '../../data/decision-chart-judge.js';
import { JUDGE_DEFAULT, normalizeChartJudge } from './decision-chart-judge.js';

// Realtime 的两个函数本层【原样转发】—— ⛔ 不重写一遍：
//   协议（start 先 stop、单模块持有 channel、stop 配对 removeChannel）已经在 Data 层实现，
//   这里再包一层只会多一处可能忘记清理的地方（§6）。
export { startChartJudgeRealtime, stopChartJudgeRealtime };

/**
 * 看板级状态（模块单例，全应用一份）。
 *   map     : { 股票名: 'ok' | 'bad' }  —— 当日的判断，UI 按名字查
 *   date    : 当前这份 map 属于哪一天（防止「切了日期、旧请求回来了」把 A 日的判断盖到 B 日）
 *   loaded  : 是否成功加载过（失败时保持 false，UI 才不会把「没读到」当成「没判断」§10）
 *   loading : 是否正在加载（仅供 UI 展示，不参与业务判断）
 *   error   : 加载 / 保存失败的原文（看板红字直接显示它）
 */
export const chartJudgeState = reactive({
  map: {},
  date: '',
  loaded: false,
  loading: false,
  error: ''
});

/**
 * 加载某交易日的判断（日期切换 / 看板刷新 / Realtime 通知时调用）。
 *
 * §10 三条：
 *   ① 失败必须【抛出去】（调用方 showToast），且 error 落在 state 里给看板红字用；
 *   ② 失败时【不清空】map？—— 恰恰相反：这里显式清成 {} 并把 loaded 置 false，
 *      因为「读失败」时留着上一份 map 会让用户看到「我明明选过、怎么全变默认了」和
 *      「我选的还在这（其实是别的日期的）」两种都错的表现。清空 + 红字 = 状态诚实。
 *   ③ 请求【回来后日期已经变了】⇒ 丢弃这次结果（⛔ 不把 A 日的判断写到 B 日上）。
 *
 * @param {string} date YYYY-MM-DD
 * @returns {Promise<void>}
 */
export async function loadChartJudge(date) {
  const d = String(date || '').trim();
  if (!d) {
    chartJudgeState.date = '';
    chartJudgeState.map = {};
    chartJudgeState.loaded = false;
    chartJudgeState.loading = false;
    chartJudgeState.error = '';
    return;
  }
  chartJudgeState.date = d;
  chartJudgeState.loading = true;
  try {
    const map = await readDecisionChartJudgeForDate(d);
    if (chartJudgeState.date !== d) return;   // 期间切走了 ⇒ 丢弃（§10 ③）
    chartJudgeState.map = map || {};
    chartJudgeState.loaded = true;
    chartJudgeState.error = '';
  } catch (e) {
    if (chartJudgeState.date !== d) return;
    chartJudgeState.map = {};
    chartJudgeState.loaded = false;
    chartJudgeState.error = '竞价图形判断加载失败：' + ((e && e.message) || e);
    throw e;                                   // §10 ①不静默：让 UI 也能感知
  } finally {
    if (chartJudgeState.date === d) chartJudgeState.loading = false;
  }
}

/**
 * 保存一条判断（用户点选择器时调用）。
 *
 * 流程严格按 §4 / §8 / §10：
 *   ① 乐观更新：先改本地 map（屏上立刻响应，早盘不卡手）；
 *   ② 写云端：Data 层 upsert 单行（选回默认 = 精确删那一行）；
 *   ③ 失败【回滚】到上一个值 + 落 error + 抛出去（UI showToast）——
 *      ⛔ 绝不让「看起来改成功了、其实没存上」留在屏上。
 *
 * @param {string} date YYYY-MM-DD
 * @param {string} stock 股票简称
 * @param {string} judge JUDGE_DEFAULT | JUDGE_OK | JUDGE_BAD
 * @returns {Promise<string>} 归一后的判断值（UI 可据此做提示）
 */
export async function saveChartJudge(date, stock, judge) {
  const d = String(date || '').trim();
  const s = String(stock || '').trim();
  if (!d || !s) throw new Error('竞价图形判断：缺少日期或股票名，无法保存');
  const j = normalizeChartJudge(judge);

  const prev = chartJudgeState.map[s];      // 可能是 undefined（原本没有判断 = 默认）
  // ① 乐观更新（换引用 → 驱动看板重算，与 trendOpenSet 同一范式；⛔ 不原地改 map 对象）
  const optimistic = Object.assign({}, chartJudgeState.map);
  if (j === JUDGE_DEFAULT) delete optimistic[s];
  else optimistic[s] = j;
  chartJudgeState.map = optimistic;

  try {
    // ② 落库：默认档传空串 ⇒ Data 层删行（表里没有行 = 默认，§6 不留两条同义路径）
    await saveDecisionChartJudge(d, s, j === JUDGE_DEFAULT ? '' : j);
    chartJudgeState.error = '';
    return j;
  } catch (e) {
    // ③ 回滚：把上一个值写回去（§10 保存失败必须让用户看见，不能假装成功）
    const back = Object.assign({}, chartJudgeState.map);
    if (prev === undefined) delete back[s];
    else back[s] = prev;
    chartJudgeState.map = back;
    chartJudgeState.error = '竞价图形判断保存失败：' + ((e && e.message) || e);
    throw e;
  }
}
