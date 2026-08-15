import { ref, computed } from 'vue';
import { useUiStore } from '../stores/uiStore.js';
import { isWeekend } from '../logic/trading-day-helpers.js';

/**
 * useStatsView.js — 「显示哪个看板」的单一真相源（Logic / ViewModel 层）
 *
 * 架构定位（architechure SKILL §4 / §6 / §15 / §7）：
 * - 视图模式（trading / weekly / monthly）属于「当前显示哪个看板」的视图状态，
 *   不应散落在 DashboardView 的局部 ref 中，统一收口到本 ViewModel 模块。
 * - 唯一持久真相由 uiStore.currentDate 持有（§7：Pinia 持有 currentDate）。
 * - 手动覆盖（本周统计 / 本月统计 按钮）属于跨组件共享的瞬时视图模式，
 *   用模块级 ref 单例承载，避免放进 Pinia（不是持久化业务数据，也不是第二个真相源），
 *   也避免放进某个组件导致其它调用方拿不到同一份状态（§6 单一真相源）。
 *
 * 派生规则：
 * - 有手动覆盖（manualMode 非空）时优先使用覆盖值；
 * - 否则按 uiStore.currentDate 是否周末派生：周末 → 'weekly'（周末板），交易日 → 'trading'（主看板）。
 * - currentDate 为空时的安全默认：'trading'。
 */

// 模块级单例：手动覆盖（本周统计 / 本月统计 按钮设置；日期导航后清空，让模板跟随日期）
const manualMode = ref(null); // null | 'weekly' | 'monthly'

export function useStatsView() {
  const uiStore = useUiStore();
  // boardView：'trading' | 'weekly' | 'monthly'
  // 有手动覆盖时优先；否则按 currentDate 是否周末派生（周末→weekly 周末板，交易日→trading 主看板）
  const boardView = computed(() => {
    if (manualMode.value) return manualMode.value;
    const cd = uiStore.currentDate;
    if (!cd) return 'trading'; // currentDate 为空时的安全默认
    return isWeekend(cd) ? 'weekly' : 'trading';
  });
  function setMode(m) { manualMode.value = m; }       // m: 'weekly' | 'monthly'
  function resetToAuto() { manualMode.value = null; }
  function onDateChanged() { manualMode.value = null; } // 任何日期导航后调用，模板回归"跟随日期"
  return { boardView, setMode, resetToAuto, onDateChanged };
}
