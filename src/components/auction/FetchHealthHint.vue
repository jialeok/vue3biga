<!--
  FetchHealthHint.vue — 「今天行情为什么没到」的提示条（UI 层）

  【用户口径】2026-10-26：「早盘竞价看板今天没有数据……是不是我 一直刷新，把数据刷新没了？
   你要修复下，下面很多看板都是数据在加载中，一直没有加载出来」

  实测：名单 50 行完好、market_metrics 今天 0 行、worker 09:25 那条 ok=false
  （numcat 两把 key 都 403 额度用尽）⇒ 数据确实没到，不是用户刷掉的。

  本组件只做一件事：把 Logic 层诊断出的原因显示出来，让用户知道
  「不是你的问题、刷新也没用」，而不是面对无限"加载中"反复刷屏。

  【§2 三层】UI → Logic（diagnoseTodayAuction）→ Data（fetchMorningFetchLog），
  ⛔ 本组件不碰 Supabase。
  【§21 模板零计算】文案全由 Logic 下发，模板只插值。
  【§31 成对清理】事件订阅在 onUnmounted 里解绑。
  【§32 不重复请求】诊断本身有 60s 缓存 + 单飞（见 logic/auction/fetch-health.js）。
-->
<template>
  <div
    v-if="hint"
    class="auction-health-hint"
    :class="'auction-health-' + hint.level"
  >
    <span class="auction-health-title">{{ hint.title }}</span>
    <span class="auction-health-text">{{ hint.text }}</span>
  </div>
</template>

<script setup>
import { ref, watch, onMounted, onUnmounted } from 'vue';
import { useUiStore } from '../../stores/uiStore.js';
import { diagnoseTodayAuction } from '../../logic/auction/fetch-health.js';
import { _on, _off } from '../../stores/eventBus.js';

const uiStore = useUiStore();
const hint = ref(null);
// 竞态令牌：诊断是异步的，期间用户切了日期 ⇒ 丢弃过期结果（与看板其它异步链同款做法）
let _seq = 0;

async function _refresh() {
  const d = uiStore.currentDate;
  const my = ++_seq;
  try {
    const r = await diagnoseTodayAuction(d);
    if (my !== _seq) return;
    hint.value = (r && r.need) ? r : null;
  } catch (e) {
    // 诊断失败只影响这条提示，⛔ 绝不影响看板本体（§10 fail-soft）
    if (my === _seq) hint.value = null;
  }
}

watch(() => uiStore.currentDate, _refresh, { immediate: true });

onMounted(function() {
  // 行情到齐 / 抓取重跑后都要重判一次（morning-sync 拿到数据会 emit）
  _on('auction-refresh', _refresh);
});

onUnmounted(function() {
  _off('auction-refresh', _refresh);
});
</script>
