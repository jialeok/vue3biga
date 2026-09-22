// useAuctionTopicTrend.js — 「题材统计条 → 点击展开五日趋势图」的 UI 组合式（§14 UI 瘦身 / §34 UI 状态分离）
//
// 需求（2026-09-20）：
//   题材 toggle【单独】开启时，每个题材上方那条统计条可以点击：
//     · 默认【收起】（省空间）；
//     · 点一下展开 → 出现两张五日趋势图：上图 = 题材名次（1=最强），下图 = 每天的一字数量；
//     · 再点一下收起。
//   ⛔ 趋势里的「一字数量」只算当日早盘竞价列表自己的一字（同统计条口径），
//      「补竞价一字」补进来的股票不算 —— 由 Logic 层结构性保证（见 logic/auction/topic-trend.js）。
//
// 架构位置（§2 UI → Logic → Data）：
//   components/AuctionTopicStatsBar.vue（点击 + 收展）+ AuctionTopicTrendPanel.vue（两张图）
//     → 本文件（纯 UI 状态：展开集合 / 序列缓存 / 文案）
//     → logic/auction/topic-trend.js（纯计算 + 只读内存的采集）
//   ⛔ 不碰早盘竞价的数据层 / 排序 / 高光；⛔ 不发请求、不写库、不消费猫抓额度。
//
// §34：`expanded` / `seriesMap` 都是纯展示态 —— 不落 localStorage（§8）、不进全局 store（§6）；
//   日期切换 / 题材 toggle 关闭 → 自动归位（无记忆），天然满足「默认收起」。
// §19：序列只在【点击展开那一刻】按当天现算一次并缓存，绝不塞进 computed 让每次渲染重算 5 天。

import { ref, computed, watch, onUnmounted } from 'vue';
import { useUiStore } from '../stores/uiStore.js';
import { _on, _off } from '../stores/eventBus.js';
import { _dbgLog } from '../data/debug-log.js';
import {
  collectTopicTrendSeries,
  clearTopicTrendCache,
  TOPIC_TREND_DAYS
} from '../logic/auction/topic-trend.js';

function _key(topic) {
  return String(topic === null || topic === undefined ? '' : topic).trim();
}

/**
 * @param {object} [board] useAuctionBoard() 的返回值（早盘竞价看板的 composable 实例）。
 *   只用来读「题材 toggle 是否还单独开着」这一个既成事实（行上有 groupTopic ⇒ 分组成立），
 *   ⚠️ 必须显式传入而不是 inject：本组合式在 AuctionBoard.vue（provide 的那一层）里被调用，
 *   自己 provide 的东西 inject 不到（与 useAuctionYiziSupplement 同一个坑）。
 * @returns {object} 供 AuctionTopicStatsBar / AuctionTopicTrendPanel 使用的状态与回调
 */
export function useAuctionTopicTrend(board) {
  const uiStore = useUiStore();
  const currentDate = computed(() => uiStore.currentDate);

  // ===== 展开态（§34 纯展示态：默认全部收起、无记忆）=====
  const expanded = ref(new Set());
  /** 题材名 → buildTopicTrendSeries 的产物（只保存【已展开】过的题材） */
  const seriesMap = ref({});
  const errorText = ref('');

  function isExpanded(topic) {
    return expanded.value.has(_key(topic));
  }

  function seriesOf(topic) {
    return seriesMap.value[_key(topic)] || null;
  }

  /**
   * 现算某题材的五日趋势并写入缓存（同步：数据源全在内存里）。
   * §10：抛错要可见，绝不静默成「没有数据」。
   */
  function _build(topic) {
    const name = _key(topic);
    if (!name) return null;
    const d = currentDate.value;
    if (!d) return null;
    try {
      const s = collectTopicTrendSeries(name, d, TOPIC_TREND_DAYS);
      const next = Object.assign({}, seriesMap.value);
      next[name] = s;
      seriesMap.value = next;
      return s;
    } catch (e) {
      errorText.value = '题材趋势计算失败：' + (e && e.message ? e.message : String(e));
      _dbgLog('[AUCTION-TOPIC-TREND] 计算失败 ' + name + ': ' + (e && e.message || e));
      return null;
    }
  }

  /** 点击统计条：展开 / 收起（再点一次收起，与股票五日趋势图同一交互） */
  function toggle(topic) {
    const name = _key(topic);
    if (!name) return;
    errorText.value = '';
    const set = new Set(expanded.value);
    if (set.has(name)) {
      set.delete(name);
      expanded.value = set;
      // 收起即丢弃缓存（下次展开重新现算，保证看到的是最新数据）
      const next = Object.assign({}, seriesMap.value);
      delete next[name];
      seriesMap.value = next;
      return;
    }
    set.add(name);
    expanded.value = set;
    _build(name);
  }

  /** 全部收起（题材 toggle 关闭 / 日期切换时调用） */
  function collapseAll() {
    if (expanded.value.size === 0 && Object.keys(seriesMap.value).length === 0) return;
    expanded.value = new Set();
    seriesMap.value = {};
    errorText.value = '';
  }

  /** 数据刷新后：清掉单日统计缓存 + 已展开题材重算一次（避免停留在旧快照） */
  function refreshExpanded() {
    clearTopicTrendCache();
    const names = Array.from(expanded.value);
    if (names.length === 0) return;
    const next = {};
    names.forEach(function(n) {
      try {
        next[n] = collectTopicTrendSeries(n, currentDate.value, TOPIC_TREND_DAYS);
      } catch (e) {
        _dbgLog('[AUCTION-TOPIC-TREND] 重算失败 ' + n + ': ' + (e && e.message || e));
      }
    });
    seriesMap.value = next;
  }

  // §34 题材 toggle 关掉（或切进叠加主排序模式）→ 统计条整体消失，展开态跟着归位。
  // ⚠️ 判据刻意【不重算】topicOnlyMode（那是 view-helpers 的口径，这里再写一份必然分叉）：
  //    直接看既成事实 —— Logic 层只在「题材单独开启」时给每行标 groupTopic（其余模式恒为 ''）。
  const visible = computed(() => {
    const items = (board && board.viewData && board.viewData.value && board.viewData.value.items) || [];
    return items.length > 0 && !!items[0].groupTopic;
  });

  // §26 日期切换 → 展开态与缓存归位（新的一天是全新的名次，旧展开态会误导）。
  // 单日统计缓存也必须清：不清就会拿上一天的行画新一天的图。
  watch(currentDate, function() {
    clearTopicTrendCache();
    collapseAll();
  });
  watch(visible, function(v) {
    if (!v) collapseAll();
  });

  // §17 数据刷新（抓取/导入/收盘覆盖）后已展开的图要跟着更新，⛔ 不靠用户手动收起再展开。
  const _onRefresh = function() { refreshExpanded(); };
  _on('auction-refresh', _onRefresh);
  onUnmounted(function() { _off('auction-refresh', _onRefresh); });

  return {
    expanded,
    seriesMap,
    errorText,
    isExpanded,
    seriesOf,
    toggle,
    collapseAll,
    refreshExpanded
  };
}
