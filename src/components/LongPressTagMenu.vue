<template>
  <!-- 长按标签菜单：从 showAuctionBuyPrompt 迁移，纯 Vue 路径替代原 document.createElement -->
  <Teleport to="body">
    <div v-if="visible" class="long-press-overlay" @click.self="close">
      <div class="long-press-panel">
        <div class="long-press-title">{{ stockName }}</div>
        <button
          v-for="b in buttons"
          :key="b.tag || 'cancel'"
          class="long-press-btn"
          :class="{ active: currentChoice === b.tag }"
          :style="btnStyle(b)"
          @click="onSelect(b)"
        >{{ b.label }}<span v-if="currentChoice === b.tag"> ✓</span></button>
        <button class="long-press-close-btn" @click="close">关闭</button>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, computed } from 'vue';
import { useUiStore } from '../stores/uiStore.js';
import auctionTagStore from '../stores/auctionTagStore.js';
import auctionStore from '../stores/auctionStore.js';
import { ensureStockInNextDay } from '../logic/auction-stock-sync.js';
import { getStocksData } from '../data/supabase-client.js';
import { saveModule } from '../logic/app-core.js';
import { getPreviousTradingDay } from '../logic/trading-day-helpers.js';

const uiStore = useUiStore();

const props = defineProps({
  dataSource: { type: String, default: 'auction' }
});

const visible = ref(false);
const stockName = ref('');
const currentDate = ref('');

const buttons = [
  { label: '买入', tag: 'buy', color: '#dc2626' },
  { label: '卖出', tag: 'sell', color: '#6b7280' },
  { label: '持有', tag: 'hold', color: '#2563eb' },
  { label: '取消标签', tag: null, color: '#475569' }
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
  auctionTagStore.setTag(currentDate.value, stockName.value, b.tag);
  if (b.tag === null) {
    const prevDay = getPreviousTradingDay(currentDate.value);
    if (prevDay) auctionTagStore.removeTag(prevDay, stockName.value);
  }

  const stocksData = getStocksData();
  const date = currentDate.value;
  if (!stocksData[date]) stocksData[date] = [];
  const stockNameTrim = stockName.value.trim();
  let stockRec = stocksData[date].find(s => s && s.name && s.name.trim() === stockNameTrim);
  if (!stockRec) {
    stockRec = { name: stockNameTrim };
    stocksData[date].push(stockRec);
  }
  stockRec.bought = (b.tag === 'buy');
  stockRec.sold = (b.tag === 'sell');
  stockRec.hold = (b.tag === 'hold');
  saveModule('stocks');

  if (b.tag === 'buy' || b.tag === 'sell' || b.tag === 'hold') {
    ensureStockInNextDay(stockName.value, currentDate.value);
  }
  close();
  const ds = props.dataSource === 'hot' ? 'hot' : 'auction';
  auctionStore.bumpDataVersion(ds);
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
