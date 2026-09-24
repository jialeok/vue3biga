// useLadderBoard.js — 「连板天梯晋级」看板的组合式（§14 UI 瘦身 / §34 UI 状态与业务数据分离）
//
// 分层（§2）：
//   views/LadderBoard.vue（模板）→ 本文件（UI 状态 + 触发重算的时机）
//     → logic/ladder/ladder-collect.js（读内存真相、组装 rows）
//     → logic/ladder/ladder-rules.js（纯规则，可单测）
//
// ⛔ 本文件【不发任何请求、不写库、不消费猫抓额度】：
//    数据全部来自早盘竞价已经拉进内存的同一份数据（用户要求「跟着早盘竞价走，不用单独获取」）。
//    尤其是趋势图：只用内存里的 5 日历史（getAuctionStockHistory），
//    ⛔ 不做早盘竞价那条 hydrate 补齐 —— 那会为同一个数据再开一次网络请求（§32 禁止重复请求）。
//
// §34：expanded / expandedSet / trendHistory 都是纯展示态 —— 不落 localStorage（§8）、不进全局 store（§6）。
// §17：数据刷新（抓取 / 导入 / 收盘覆盖）后要跟着更新，因此监听事件总线 auction-refresh。

import { ref, computed, watch, onUnmounted } from 'vue';
import { useUiStore } from '../stores/uiStore.js';
import { _on, _off } from '../stores/eventBus.js';
import { getAuctionStockHistory } from '../logic/tagTitles/rules.js';
import { collectLadderData } from '../logic/ladder/ladder-collect.js';
import { buildTrendSeries } from '../logic/ladder/ladder-rules.js';

/** §10：任何一次计算失败都要【可见】，绝不静默成「今天没有连板股」 */
function _empty(reason) {
  return { ready: false, reason: reason, groups: [], total: 0, closeReady: false };
}

export function useLadderBoard() {
  const uiStore = useUiStore();
  const currentDate = computed(() => uiStore.currentDate);

  // 纯展示态（§34）
  const expanded = ref(true);
  const expandedSet = ref(new Set());
  const trendHistory = ref({});

  // 手动版本号：auction 数据刷新（getTodayGroupList / 内存逐日行都是非响应式缓存）后 bump，
  // 让下面的 computed 重跑一次（与早盘竞价 / 决策看板同一套路）。
  const version = ref(0);

  const errorText = ref('');

  const data = computed(function() {
    void version.value;               // 显式声明对刷新信号的依赖
    const d = currentDate.value;
    if (!d) return _empty('未选择日期');
    try {
      return collectLadderData(d);
    } catch (e) {
      // §10：计算失败必须可见，绝不能返回「空结果」伪装成「今天没有连板股」
      errorText.value = '连板天梯计算失败：' + (e && e.message ? e.message : String(e));
      console.error('[LADDER] 计算失败', e);
      return _empty('计算失败，请看控制台');
    }
  });

  const ready = computed(() => !!data.value.ready);
  const reasonText = computed(() => (data.value.ready ? '' : (data.value.reason || '暂无数据')));
  const groups = computed(() => data.value.groups || []);
  const total = computed(() => data.value.total || 0);
  const closeReady = computed(() => !!data.value.closeReady);

  const summaryText = computed(function() {
    if (!ready.value) return reasonText.value;
    if (total.value === 0) return '无二板及以上';
    return groups.value.map(function(g) { return g.label + g.count; }).join(' · ');
  });

  function toggleExpand() { expanded.value = !expanded.value; }

  /**
   * 展开 / 收起某只股票的趋势图（点序号或股票名）。
   * 数据【只读内存】：早盘竞价首屏已把最近 30 个自然日整段拉入，这里取 5 日 → 0 请求。
   */
  function toggleTrend(name) {
    const nm = String(name || '').trim();
    if (!nm) return;
    const set = new Set(expandedSet.value);
    if (set.has(nm)) {
      set.delete(nm);
      expandedSet.value = set;
      return;
    }
    const history = getAuctionStockHistory(nm, currentDate.value, 5, 'auction') || [];
    set.add(nm);
    expandedSet.value = set;
    trendHistory.value = Object.assign({}, trendHistory.value, { [nm]: buildTrendSeries(history) });
  }

  function collapseTrend() {
    expandedSet.value = new Set();
    trendHistory.value = {};
  }

  /** 供父级在「刷新」时调用（与早盘竞价 / 涨跌停 / 决策看板同款契约：defineExpose({ refresh })） */
  function refresh() {
    version.value++;
    errorText.value = '';
    // 趋势缓存跟着重取（收盘覆盖涨幅后，图上的 T 腿会变）
    const names = Array.from(expandedSet.value);
    if (names.length === 0) return;
    const next = Object.assign({}, trendHistory.value);
    names.forEach(function(nm) {
      const history = getAuctionStockHistory(nm, currentDate.value, 5, 'auction') || [];
      next[nm] = buildTrendSeries(history);
    });
    trendHistory.value = next;
  }

  // §26 日期切换 → 收起全部展开（新的一天是全新的票，旧展开态会误导）+ 清趋势缓存
  watch(currentDate, function() {
    collapseTrend();
    errorText.value = '';
  });

  const _onRefresh = function() { refresh(); };
  _on('auction-refresh', _onRefresh);
  onUnmounted(function() { _off('auction-refresh', _onRefresh); });

  return {
    expanded,
    expandedSet,
    trendHistory,
    errorText,
    data,
    ready,
    reasonText,
    groups,
    total,
    closeReady,
    summaryText,
    toggleExpand,
    toggleTrend,
    collapseTrend,
    refresh
  };
}
