// useDecisionBoard.js — 「决策」看板的组合式（§14 UI 瘦身 / §34 UI 状态与业务数据分离）
//
// 分层（§2）：
//   views/DecisionBoard.vue（模板）→ 本文件（UI 状态 + 触发重算的时机）
//     → logic/decision/decision-collect.js（读内存真相、组装 entries）
//     → logic/decision/decision-rules.js（纯规则，可单测）
//   ⛔ 本文件不发请求、不写库、不消费猫抓额度；⛔ 不复用任何其它看板的组件或组合式。
//
// §34：expanded / rulesOpen 都是纯展示态 —— 不落 localStorage（§8）、不进全局 store（§6）。
// §17：数据刷新（抓取 / 导入 / 收盘覆盖）后要跟着更新，因此监听事件总线 auction-refresh。

import { ref, computed, watch, onUnmounted } from 'vue';
import { useUiStore } from '../stores/uiStore.js';
import { _on, _off } from '../stores/eventBus.js';
import { collectDecisionData } from '../logic/decision/decision-collect.js';

/** §10：任何一次计算失败都要【可见】，绝不静默成「今天没有信号」 */
function _empty(reason) {
  return {
    ready: false,
    reason: reason,
    topics: [],
    buy: { heavy: null, light: null, noYizi: null, smallTopic: null, bigTopic: null },
    sell: [],
    sellTimes: []
  };
}

export function useDecisionBoard() {
  const uiStore = useUiStore();
  const currentDate = computed(() => uiStore.currentDate);

  // 纯展示态（§34）
  const expanded = ref(true);
  const rulesOpen = ref(false);

  // 手动版本号：auction 数据刷新（getTodayGroupList 读的是非响应式内存缓存）后 bump，
  // 让下面的 computed 重跑一次。龙一/龙二（dragonState 是 ref）与标签（Pinia）本身是响应式的，
  // computed 会自动追踪 —— 只有「当日列表」需要这个手动信号（与早盘竞价看板同一套路）。
  const version = ref(0);

  const errorText = ref('');

  const data = computed(function() {
    void version.value;               // 显式声明对刷新信号的依赖
    const d = currentDate.value;
    if (!d) return _empty('未选择日期');
    try {
      return collectDecisionData(d);
    } catch (e) {
      // §10：计算失败必须可见，绝不能返回「空结果」伪装成「今天没有信号」
      errorText.value = '决策计算失败：' + (e && e.message ? e.message : String(e));
      console.error('[DECISION] 计算失败', e);
      return _empty('计算失败，请看控制台');
    }
  });

  const ready = computed(() => !!data.value.ready);
  const reasonText = computed(() => (data.value.ready ? '' : (data.value.reason || '暂无数据')));

  const buyHeavy = computed(() => (data.value.buy ? data.value.buy.heavy : null));
  const buyLight = computed(() => (data.value.buy ? data.value.buy.light : null));
  // [NO-YIZI 2026-09-25] 「全部题材竞价一字 0 个」的弱市兜底方案；与 heavy / light 互斥
  const buyNoYizi = computed(() => (data.value.buy ? data.value.buy.noYizi : null));
  // [SMALL-TOPIC 2026-09-25] 「第 1 / 第 2 名题材票太少却有 1~2 个一字」的高风险兜底方案；
  // 与 noYizi 结构完全一致（{hintText, notes, emptyText, blocks}），因此 UI 合并成 buySpecial 一处渲染。
  const buySmallTopic = computed(() => (data.value.buy ? data.value.buy.smallTopic : null));
  // [BIG-TOPIC 2026-09-26] 「全部题材无一字 + 有大题材（≥10 只）」的兜底方案；结构同上
  const buyBigTopic = computed(() => (data.value.buy ? data.value.buy.bigTopic : null));
  /** 三条兜底方案共用同一段模板；与 heavy / light 互斥 */
  const buySpecial = computed(() => buyNoYizi.value || buySmallTopic.value || buyBigTopic.value || null);
  const sellGroups = computed(() => data.value.sell || []);

  const buyCount = computed(function() {
    const n = buySpecial.value;
    if (n) {
      return n.blocks.reduce(function(s, b) { return s + b.picks.length; }, 0);
    }
    const h = buyHeavy.value;
    const l = buyLight.value;
    return (h && h.qualified ? h.picks.length : 0) + (l ? l.picks.length : 0);
  });
  const sellCount = computed(function() {
    return sellGroups.value.reduce(function(n, g) { return n + g.items.length; }, 0);
  });

  const summaryText = computed(function() {
    if (!ready.value) return reasonText.value;
    // 兜底判定为「太弱」→ 头部直接写【空仓】，比「无买卖信号」更贴合用户口径
    const n = buySpecial.value;
    if (n && !n.qualified && sellCount.value === 0) return '空仓（题材太弱）';
    if (buyCount.value === 0 && sellCount.value === 0) return '今日无买卖信号';
    return '买' + buyCount.value + ' 卖' + sellCount.value;
  });

  /**
   * [2026-09-26 用户要求] 点看板条（三角）展开 / 收起时，【顺手把灰色问号的规则说明板收起】
   *   —— 说明文字要跟着一起消失，否则收起后还悬一块面板很难看。
   * ⛔ 只动纯展示态（§34），不碰任何业务数据。
   */
  function toggleExpand() {
    expanded.value = !expanded.value;
    rulesOpen.value = false;
  }
  function toggleRules() { rulesOpen.value = !rulesOpen.value; }
  /** 供规则面板自己上报开合（子组件无内部状态，开合真相在 composable 里，§6） */
  function setRulesOpen(v) { rulesOpen.value = !!v; }

  /** 供父级在「刷新」时调用（与早盘竞价 / 涨跌停看板同款契约：defineExpose({ refresh })） */
  function refresh() { version.value++; errorText.value = ''; }

  // §26 日期切换 → 规则面板收起（新的一天是全新的结论，旧展开态会误导）
  watch(currentDate, function() {
    rulesOpen.value = false;
    errorText.value = '';
  });

  const _onRefresh = function() { refresh(); };
  _on('auction-refresh', _onRefresh);
  onUnmounted(function() { _off('auction-refresh', _onRefresh); });

  return {
    expanded,
    rulesOpen,
    errorText,
    data,
    ready,
    reasonText,
    buyHeavy,
    buyLight,
    buyNoYizi,
    buySmallTopic,
    buyBigTopic,
    buySpecial,
    sellGroups,
    buyCount,
    sellCount,
    summaryText,
    toggleExpand,
    toggleRules,
    setRulesOpen,
    refresh
  };
}
