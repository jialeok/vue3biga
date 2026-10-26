<!--
  FetchHealthHint.vue — 今日行情未到时的「一行淡灰提示 + 一键同花顺补」（UI 层）

  【用户口径】
    2026-10-26 第一轮：「下面很多看板都是数据在加载中，一直没有加载出来」
              → 加了黑色原因提示条（说明额度用尽）
    2026-10-26 第二轮：「去掉那个黑色的额度用尽的提示板太难看」「你用同花顺接口临时补下数据」
              → 本版把黑块去掉，只留一行淡灰小字 + 一个补数按钮

  【为什么不干脆全部隐藏】
    数据真的没到时，全藏起来用户就无从判断是"没数据"还是"页面坏了"，
    只能继续反复刷新（§10：失败要可见）。所以保留一行**不抢眼**的说明，
    并把"能自己动手解决"的按钮放在同一行 —— 比让他干等更有用。

  【§2 三层】UI → Logic（patchTodayAuctionFromThs / diagnoseTodayAuction）
                  → Data（auction-metrics-patch.js / fetch-log.js），⛔ 本组件不碰 Supabase。
  【§31 成对清理】事件订阅在 onUnmounted 解绑。
  【§32 不重复请求】诊断有 60s 缓存；补数逻辑本身有单飞，连点只跑一次。
-->
<template>
  <div v-if="hint" class="auction-health-hint">
    <span
      class="auction-health-note"
      :title="hint.text"
    >{{ noteText }}</span>
    <button
      class="auction-health-btn"
      :disabled="busy"
      :title="hint.text"
      @click="onPatch"
    >{{ btnText }}</button>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useUiStore } from '../../stores/uiStore.js';
import { diagnoseTodayAuction } from '../../logic/auction/fetch-health.js';
import { patchTodayAuctionFromThs } from '../../logic/auction/ths-today-patch.js';
import { pullAuctionMarketDataForDate } from '../../data/watchlist-and-metrics.js';
import { _on, _off, _emit } from '../../stores/eventBus.js';

const uiStore = useUiStore();
const hint = ref(null);
const busy = ref(false);
const busyStage = ref('');
const resultText = ref('');
// 竞态令牌：诊断是异步的，期间用户切了日期 ⇒ 丢弃过期结果
let _seq = 0;

// 提示文字尽量短（这一行的目的是"告知 + 给出口"，不是让人读长文；详情在 title 里）
const noteText = computed(function() {
  const h = hint.value;
  if (!h) return '';
  if (resultText.value) return resultText.value;
  return h.level === 'warn' ? '今日行情未到（数据源额度不足）' : '今日行情未到';
});

const btnText = computed(function() {
  if (!busy.value) return '用同花顺补今日';
  const map = { kline: '拉K线…', snapshot: '拉快照…', write: '写入…' };
  return map[busyStage.value] || '补齐中…';
});

async function _refresh() {
  const d = uiStore.currentDate;
  const my = ++_seq;
  try {
    const r = await diagnoseTodayAuction(d);
    if (my !== _seq) return;
    hint.value = (r && r.need) ? r : null;
  } catch (e) {
    if (my === _seq) hint.value = null;
  }
}

/**
 * 一键用同花顺补今天。
 * 顺序必须是：写库 → 重拉内存 → emit（否则看板拿到的还是旧内存）。
 */
async function onPatch() {
  if (busy.value) return;
  const d = uiStore.currentDate;
  busy.value = true;
  busyStage.value = '';
  resultText.value = '';
  try {
    const r = await patchTodayAuctionFromThs(d, {
      onProgress: function(stage) { busyStage.value = stage; },
    });
    if (r && r.ok && r.patchedRows > 0) {
      // ① 把刚写进去的行重新读回内存（pullAuctionFromTable 式的按日合并，§6 单一真相）
      await pullAuctionMarketDataForDate(d);
      // ② 再通知所有看板重算
      _emit('auction-refresh');
      resultText.value = '已补 ' + r.patchedRows + ' 行';
      busy.value = false;
      setTimeout(function() { resultText.value = ''; _refresh(); }, 2000);
      return;
    }
    resultText.value = (r && r.reason) ? ('未补：' + r.reason) : '没有可补的数据';
    busy.value = false;
    setTimeout(function() { resultText.value = ''; _refresh(); }, 2500);
  } catch (e) {
    // §10：失败必须让用户看见（不许静默）
    resultText.value = '补齐失败：' + (e && e.message ? e.message.slice(0, 40) : '未知错误');
    busy.value = false;
    setTimeout(function() { resultText.value = ''; }, 3500);
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
