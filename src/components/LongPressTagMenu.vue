<template>
  <!-- 长按标签菜单：从 showAuctionBuyPrompt 迁移，纯 Vue 路径替代原 document.createElement -->
  <Teleport to="body">
    <div
      v-if="visible"
      class="long-press-overlay"
      @click.self="close"
    >
      <div class="long-press-panel">
        <div class="long-press-title">
          {{ stockName }}
        </div>
        <button
          v-for="b in buttons"
          :key="b.tag || 'cancel'"
          class="long-press-btn"
          :class="{ active: currentChoice === b.tag }"
          :style="btnStyle(b)"
          :title="b.tip"
          @click="onSelect(b)"
        >
          {{ b.label }}<span v-if="currentChoice === b.tag"> ✓</span>
        </button>
        <button
          class="long-press-close-btn"
          @click="close"
        >
          关闭
        </button>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, computed } from 'vue';
import { useUiStore } from '../stores/uiStore.js';
import auctionTagStore from '../stores/auctionTagStore.js';
import auctionStore from '../stores/auctionStore.js';
import { ensureStockInNextDay } from '../logic/auction/stock-sync.js';

import { deriveAuctionTagState } from '../logic/tagTitles/rules.js';
import { showToast } from '../composables/useToast.js';

const uiStore = useUiStore();

const visible = ref(false);
const stockName = ref('');
const currentDate = ref('');

/**
 * ★★ [SELL-AUTO 2026-11-12 用户口径] 三枚标签对【次日题材量比卖点侧】的影响，逐枚写清楚。
 *
 * 用户原话：「包括打标签的逻辑，也要标清楚。那些持有，卖出的标签你看怎么不冲突，要区分开来。
 *   还有手动的添加买入也不要冲突。」
 *
 * 卖点侧成员规则（唯一实现 `logic/topicvolratio/sell-members.js`，⛔ 别在这里另写一份）：
 *   · 昨日【买点侧】选中的票 —— 次日**自动**进卖点侧，**不需要打任何标签**；
 *   · 打「买入」—— 与自动继承的票【去重合并】，只显示「手动买」（手动优先，不冲突）；
 *   · 打「持有」—— 仍留在次日卖点侧（还拿着，继续看卖点）；
 *   · 打「卖出」—— **一票否决**，次日不再自动进入卖点侧（已经卖了，不该再被推回来）。
 * ⇒ 标签是「覆盖 / 否决」用的，不是「入场券」：不打也能进去，打了只是改变来源与去留。
 */
const buttons = [
  { label: '买入', tag: 'buy', color: '#dc2626', tip: '标记「今天买入了」。次日题材量比看板的卖点侧会收录它（与「昨日买点侧自动继承」去重，手动优先）。' },
  { label: '卖出', tag: 'sell', color: '#6b7280', tip: '标记「今天卖掉了」。次日卖点侧【不再】收录它 —— 即使它昨天在买点侧，也不会自动推回来。' },
  { label: '持有', tag: 'hold', color: '#2563eb', tip: '标记「还拿着没卖」。次日卖点侧继续收录它，好让你接着盯卖点。' },
  { label: '取消标签', tag: null, color: '#475569', tip: '只取消你手动打的标签。自动继承来自昨日买点侧（不写标签），取消不了。' }
];

const currentChoice = computed(() => {
  if (!stockName.value || !currentDate.value) return null;
  return auctionTagStore.getTagState(currentDate.value, stockName.value);
});

function btnStyle(b) {
  const isActive = currentChoice.value === b.tag;
  return {
    border: '1px solid ' + (isActive ? b.color : '#334155'),
    background: isActive ? b.color : '#0f172a',
    color: isActive ? '#fff' : b.color
  };
}

function open(name) {
  stockName.value = name;
  currentDate.value = uiStore.currentDate;
  visible.value = true;
}
function close() {
  visible.value = false;
}

function onSelect(b) {
  // [REFACTOR 2026-08-14] 取消标签：继承的不能取消，只有当天手动打的才能取消
  if (b.tag === null) {
    const inheritState = deriveAuctionTagState(stockName.value.trim(), currentDate.value, null, true);
    if (inheritState.source === 'inherited') {
      showToast('继承的标签不能取消，请重新打标签');
      close();
      return;
    }
  }

  // [REFACTOR 2026-08-14] 竞价看板标签完全独立，只写 auctionTagStore，不写 stocksData
  auctionTagStore.setTag(currentDate.value, stockName.value, b.tag);

  if (b.tag === 'buy' || b.tag === 'sell' || b.tag === 'hold') {
    ensureStockInNextDay(stockName.value, currentDate.value);
  }
  close();
  auctionStore.bumpDataVersion('auction');
  auctionStore.refresh();
}

defineExpose({ open, close });
</script>

<style scoped>
.long-press-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
}
.long-press-panel {
  background: #1e293b;
  border-radius: 12px;
  padding: 20px;
  min-width: 280px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
}
.long-press-title {
  color: #e2e8f0;
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 16px;
  text-align: center;
}
.long-press-btn {
  display: block;
  width: 100%;
  padding: 10px;
  margin-bottom: 8px;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
.long-press-close-btn {
  display: block;
  width: 100%;
  padding: 10px;
  border: none;
  border-radius: 8px;
  font-size: 14px;
  cursor: pointer;
  background: #334155;
  color: #94a3b8;
}
</style>
