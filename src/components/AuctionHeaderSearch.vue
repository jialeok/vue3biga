<!--
  AuctionHeaderSearch.vue — 早盘竞价表头上方搜索框（双击表头触发）。
  职责：输入股票名称 → 匹配行整行黄色高光（highlightStockSet 为唯一真相源，AuctionBoardTable 行据此加高光类）。
  与旧 searchActive/searchKeyword 过滤搜索完全解耦（§18 状态隔离），不修改列表数据源，仅驱动行高光。
  经 inject('auctionBoard') 共享同一 composable 实例（§3/§6）。
-->
<template>
  <div
    v-if="headerSearchActive"
    class="auction-header-search"
    @click.stop
    @dblclick.stop
  >
    <input
      ref="inputRef"
      v-model="keyword"
      type="text"
      class="auction-header-search-input"
      placeholder="模糊搜索股票名称，匹配行整行黄色高光并滚动定位..."
      @click.stop
      @dblclick.stop
      @input="onInput"
    >
    <span
      v-if="matchCount > 0"
      class="auction-header-search-count"
    >{{ matchCount }} 条</span>
    <span
      v-else-if="keyword.trim()"
      class="auction-header-search-count no-match"
    >无匹配</span>
  </div>
</template>

<script setup>
import { ref, computed, nextTick, watch } from 'vue';
import { inject } from 'vue';

const board = inject('auctionBoard');
const { headerSearchActive, highlightStockSet, obsItems, regularItems } = board;

const keyword = ref('');
const inputRef = ref(null);

const matchCount = computed(() => highlightStockSet.value.size);

function onInput() {
  const kw = keyword.value.trim().toLowerCase();
  if (!kw) {
    highlightStockSet.value = new Set();
    return;
  }
  // [FEAT 2026-08-18] 模糊匹配：子串包含（includes）——输入"沃"/"光电"/"电"均可命中"沃格光电"。
  const matched = new Set();
  for (const item of obsItems.value) {
    if (item.stock && item.stock.toLowerCase().includes(kw)) matched.add(item.stock);
  }
  for (const item of regularItems.value) {
    if (item.stock && item.stock.toLowerCase().includes(kw)) matched.add(item.stock);
  }
  highlightStockSet.value = matched;
  // 匹配后实时滚动到第一个高光行视野中央（UI 视觉定位，非业务逻辑，§17 响应式驱动后 nextTick 操作 DOM）。
  if (matched.size > 0) {
    nextTick(() => {
      const el = document.querySelector('.auction-row.auction-row-highlight');
      if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }
}

watch(headerSearchActive, (v) => {
  if (v) {
    keyword.value = '';
    highlightStockSet.value = new Set();
    nextTick(() => { if (inputRef.value) inputRef.value.focus(); });
  } else {
    keyword.value = '';
    highlightStockSet.value = new Set();
  }
});
</script>

<style scoped>
.auction-header-search {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  background: #fef9c3;
  border-bottom: 1px solid #fde047;
  position: sticky;
  top: 0;
  z-index: 2;
}
.auction-header-search-input {
  flex: 1;
  padding: 6px 10px;
  border: 1px solid #facc15;
  border-radius: 6px;
  font-size: 13px;
  outline: none;
  background: #fff;
  color: #1f2937;
}
.auction-header-search-input:focus {
  border-color: #ca8a04;
  box-shadow: 0 0 0 2px rgba(234, 179, 8, 0.25);
}
.auction-header-search-count {
  font-size: 12px;
  color: #854d0e;
  font-weight: 600;
  white-space: nowrap;
}
.auction-header-search-count.no-match {
  color: #dc2626;
}
</style>