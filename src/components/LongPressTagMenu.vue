<template>
  <Teleport to="body">
    <div v-if="visible" class="long-press-overlay" @click.self="close" @touchstart.self.passive="close">
      <div class="long-press-panel" :style="panelStyle">
        <span class="long-press-title">{{ stockName }}</span>
        <span class="long-press-divider"></span>
        <button
          v-for="b in buttons"
          :key="b.tag || 'cancel'"
          class="long-press-btn"
          :class="{ active: currentChoice === b.tag }"
          :style="btnStyle(b)"
          @click.stop="onSelect(b)"
        >{{ b.label }}</button>
        <button class="long-press-close-btn" @click.stop="close">✕</button>
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

const uiStore = useUiStore();

const props = defineProps({
  dataSource: { type: String, default: 'auction' }
});

const visible = ref(false);
const stockName = ref('');
const currentDate = ref('');
const posX = ref(0);
const posY = ref(0);

const buttons = [
  { label: '买入', tag: 'buy', color: '#dc2626' },
  { label: '卖出', tag: 'sell', color: '#6b7280' },
  { label: '持有', tag: 'hold', color: '#2563eb' },
  { label: '取消', tag: null, color: '#475569' }
];

const currentChoice = computed(() => {
  if (!stockName.value || !currentDate.value) return null;
  return auctionTagStore.getTagState(currentDate.value, stockName.value);
});

const panelStyle = computed(() => {
  return {
    left: posX.value + 'px',
    top: posY.value + 'px'
  };
});

function btnStyle(b) {
  const isActive = currentChoice.value === b.tag;
  return {
    border: '1px solid ' + (isActive ? b.color : '#475569'),
    background: isActive ? b.color : 'transparent',
    color: isActive ? '#fff' : b.color
  };
}

function open(name, x, y) {
  stockName.value = name;
  currentDate.value = uiStore.currentDate;
  const panelW = 320;
  const panelH = 36;
  let px = (x || 0) - 40;
  let py = (y || 0) - panelH - 6;
  if (px + panelW > window.innerWidth - 8) px = window.innerWidth - panelW - 8;
  if (px < 8) px = 8;
  if (py < 8) py = (y || 0) + 24;
  posX.value = px;
  posY.value = py;
  visible.value = true;
}
function close() {
  visible.value = false;
}

function onSelect(b) {
  auctionTagStore.setTag(currentDate.value, stockName.value, b.tag);

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
  background: transparent;
  z-index: 9999;
}
.long-press-panel {
  position: fixed;
  display: flex;
  align-items: center;
  gap: 4px;
  background: #1e293b;
  border-radius: 6px;
  padding: 4px 6px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
  white-space: nowrap;
  z-index: 10000;
}
.long-press-title {
  color: #e2e8f0;
  font-size: 10px;
  font-weight: 600;
  padding: 0 4px;
  max-width: 80px;
  overflow: hidden;
  text-overflow: ellipsis;
  flex-shrink: 0;
}
.long-press-divider {
  width: 1px;
  height: 14px;
  background: #475569;
  flex-shrink: 0;
}
.long-press-btn {
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 400;
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
}
.long-press-close-btn {
  padding: 2px 5px;
  border: none;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 400;
  cursor: pointer;
  background: #334155;
  color: #94a3b8;
  flex-shrink: 0;
}
</style>
