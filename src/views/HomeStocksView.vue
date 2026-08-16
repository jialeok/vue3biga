<template>
  <div
    v-if="loading"
    class="loading-state trading-day-element"
  >
    <div class="loading-icon">
      ⏳
    </div>
    <div class="loading-title">
      加载中...
    </div>
  </div>

  <HomeStocksSummary v-if="!loading" />
  <HomeStocksList v-if="!loading" />

  <div
    v-if="!loading && sortedList.length === 0"
    class="empty-state trading-day-element"
    style="display:block"
  >
    <div class="empty-icon">
      📈
    </div>
    <div class="empty-title">
      暂无股票记录
    </div>
    <div class="empty-desc">
      点击下方 + 按钮添加第一条记录
    </div>
  </div>

  <HomeStocksEditModal />
  <HomeStocksSoldModal />
  <HomeStocksTrackModal />
  <HomeStocksDatePicker />
</template>

<script setup>
import { useHomeStocksState } from '../composables/useHomeStocksState.js';
import HomeStocksSummary from '../components/HomeStocksSummary.vue';
import HomeStocksList from '../components/HomeStocksList.vue';
import HomeStocksEditModal from '../components/HomeStocksEditModal.vue';
import HomeStocksSoldModal from '../components/HomeStocksSoldModal.vue';
import HomeStocksTrackModal from '../components/HomeStocksTrackModal.vue';
import HomeStocksDatePicker from '../components/HomeStocksDatePicker.vue';

const {
  loading,
  sortedList,
  stockStats,
  refresh,
  setFilter,
  changeDate,
  goToday,
  openModal,
  closeModal,
  exportData,
  showImportModal,
  openDatePicker,
  goToPrevTradingDay,
  goToNextTradingDay,
  wireHomeStocksLifecycle
} = useHomeStocksState();

// 仅由根视图调用一次：绑定 onMounted/_on/_off/watch 与全局刷新事件
wireHomeStocksLifecycle();

defineExpose({
  refresh, setFilter, changeDate, goToday, openModal, closeModal,
  exportData, showImportModal, openDatePicker,
  goToPrevTradingDay, goToNextTradingDay, stockStats
});
</script>

<style>
.track-empty-hint {
  font-size: 12px;
  color: #94a3b8;
  padding: 4px 0;
}
.loading-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 60px 20px;
  color: #64748b;
}
.loading-icon {
  font-size: 32px;
  margin-bottom: 8px;
}
.loading-title {
  font-size: 14px;
}
.edit-tags-wrap {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}
.edit-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  border-radius: 8px;
  border: 1px solid #e2e8f0;
  background: #f8fafc;
  font-size: 13px;
  color: #374151;
  cursor: pointer;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
}
.edit-tag input { width: 16px; height: 16px; }
.tag-amber { color: #d97706; font-weight: 600; }
.tag-red { color: #dc2626; font-weight: 600; }
.tag-amber-bg { background: #fef3c7; border-color: #fcd34d; color: #d97706; font-weight: 600; }
.tag-blue-bg { background: #dbeafe; border-color: #93c5fd; color: #2563eb; font-weight: 600; }
.tag-pink-bg { background: #fce7f3; border-color: #f9a8d4; color: #db2777; font-weight: 600; }
.tag-purple-bg { background: #faf5ff; border-color: #e9d5ff; color: #9333ea; font-weight: 600; }
.tag-green-bg { background: #f0fdf4; border-color: #bbf7d0; color: #16a34a; font-weight: 600; }
.tag-red-bg { background: #fef2f2; border-color: #fecaca; color: #dc2626; font-weight: 600; }
.tag-emerald-bg { background: #ecfdf5; border-color: #a7f3d0; color: #059669; font-weight: 600; }
.edit-nextday {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.edit-nextday-label { font-size: 13px; color: #374151; font-weight: 600; }
.nextday-pill {
  padding: 6px 12px;
  border-radius: 20px;
  border: 1px solid #e2e8f0;
  background: #f8fafc;
  font-size: 13px;
  color: #64748b;
  cursor: pointer;
}
.nextday-pill.active {
  background: linear-gradient(135deg, #3b82f6, #2563eb);
  color: #fff;
  border-color: transparent;
  font-weight: 600;
}
.track-simple-head {
  font-size: 12px;
  font-weight: 600;
  color: #3b82f6;
  margin-bottom: 6px;
}
</style>
