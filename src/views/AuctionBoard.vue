<!--
  AuctionBoard.vue — 早盘竞价看板主组件（纯 Vue3 / Vite / Pinia）
  数据源：auctionStore.dataVersions['auction'] 失效信号 + useUiStore().currentDate；
  派生展示：computeAuctionViewDataIncremental（logic/auction/incremental-view.js）之上叠加增量行缓存层。
  模板行级 v-memo 保证未变化行（单元格）不重渲染（§17/§23/§29）。
  单格编辑/选择经 Logic 层写入后 bump 数据版本触发重算，不直接写 Supabase（§2/§10）。

  §P1-7 物理重组：组合式逻辑已抽离到 src/composables/useAuctionBoard.js（provide/inject 共享同一实例）；
  模板按区块拆为 src/components/AuctionBoardToolbar.vue / AuctionBoardTable.vue /
  AuctionBoardPageTopics.vue / AuctionBoardPageHistory.vue / AuctionBoardPageCopied.vue。
  本根组件仅：调用 composable、provide 上下文、defineExpose 受保护契约、聚合子组件、保留全局样式。
  受保护契约：<AuctionEditModal ref="editModalRef" /> 仅经 ref 调 open/close；根自身亦可被外部以 ref 调用
  refresh / toggleSort / expandAll / collapseAll（签名不变）。
-->
<template>
  <div
    class="auction-board trading-day-element"
    :class="{ collapsed: !expanded }"
    data-source="auction"
  >
    <div
      class="auction-header"
      style="cursor:pointer"
      @click="toggleBoard"
    >
      <div>
        <div class="auction-title">
          <span>早盘竞价</span>
          <span style="margin-left: 8px; font-weight: 600;">强度：<span style="color: #ffffff;">{{ todayStrengthText }}</span></span>
        </div>
        <div class="auction-subtitle" />
      </div>
      <div class="auction-header-right">
        <div class="auction-page-indicator">
          <span
            v-for="p in 4"
            :key="p"
            class="page-dot"
            :class="{ active: currentPage === p - 1 }"
            @click.stop="switchPage(p - 1)"
          />
        </div>
        <div class="auction-toggle-btn">
          {{ expanded ? '▲' : '▼' }}
        </div>
      </div>
    </div>
    <div
      v-show="expanded"
      class="auction-swipe-container"
      @touchstart.passive="onSwipeStart"
      @touchend.passive="onSwipeEnd"
    >
      <div
        v-if="currentPage === 0"
        class="auction-scroll-container"
        @dblclick="openEditModal"
      >
        <AuctionBoardToolbar />
        <AuctionBoardTable />
      </div>
      <AuctionBoardPageTopics />
      <AuctionBoardPageHistory />
      <AuctionBoardPageCopied />
    </div>

    <LongPressTagMenu ref="longPressMenuRef" />
    <CoreTopicModal ref="coreTopicModalRef" />
    <AuctionEditModal ref="editModalRef" />

    <!-- [FIX 2026-08-16] 昨成交量单击 → 黑色小 toast 显示涨幅+题材（贴数值下方，点击/滚动关闭）；
         竞价量双击 → 涨幅题材编辑弹窗（替代原双击股票名 prompt）。 -->
    <div
      v-if="notePopup"
      class="auction-note-popup"
      :style="notePopupStyle"
      @click="closeNotePopup"
    >
      {{ notePopupText }}
    </div>

    <EditModal
      v-model="volumeNoteModalActive"
      title="编辑涨幅与题材"
      show-clear
      clear-text="清空"
      @save="saveVolumeNote"
      @clear="clearVolumeNote"
    >
      <div style="font-size:12px;color:#6b7280;margin-bottom:8px;">
        格式：涨幅(题材1,题材2)，如 2.6%(机器人,人工智能,AI应用)
      </div>
      <input
        v-model="volumeNoteDraft"
        placeholder="如 2.6%(机器人,人工智能,AI应用)"
        class="volume-note-input"
        style="width:100%;padding:10px;border:1px solid #d1d5db;border-radius:8px;font-size:14px;box-sizing:border-box;"
      >
    </EditModal>
  </div>
</template>

<script setup>
import { provide, defineExpose, computed } from 'vue';
import { useAuctionBoard } from '../composables/useAuctionBoard.js';
import AuctionBoardToolbar from '../components/AuctionBoardToolbar.vue';
import AuctionBoardTable from '../components/AuctionBoardTable.vue';
import AuctionBoardPageTopics from '../components/AuctionBoardPageTopics.vue';
import AuctionBoardPageHistory from '../components/AuctionBoardPageHistory.vue';
import AuctionBoardPageCopied from '../components/AuctionBoardPageCopied.vue';
import LongPressTagMenu from '../components/LongPressTagMenu.vue';
import CoreTopicModal from '../components/CoreTopicModal.vue';
import AuctionEditModal from '../components/AuctionEditModal.vue';
import EditModal from '../components/EditModal.vue';

// §P1-7 组合式逻辑统一在本根组件初始化一次，provide 给所有子组件共享同一响应式实例。
const board = useAuctionBoard();
provide('auctionBoard', board);

// 根模板直接引用的最小集合（其余由子组件经 inject 使用，保持行为一致）。
const {
  viewData, currentPage, expanded, switchPage, onSwipeStart, onSwipeEnd, toggleBoard, openEditModal,
  longPressMenuRef, coreTopicModalRef, editModalRef,
  notePopup, notePopupStyle, notePopupText, closeNotePopup,
  volumeNoteModalActive, volumeNoteDraft, saveVolumeNote, clearVolumeNote
} = board;

// § 模板重构：强度显示复杂条件链抽取为 computed（渲染结果 100% 不变）
const todayStrengthText = computed(() => {
  return viewData.value.stats && viewData.value.stats.todayStrength != null
    ? viewData.value.stats.todayStrength + '%'
    : '-';
});

// §16 受保护契约：外部（如 DashboardView）可能以 ref 调用以下方法，签名保持不变。
defineExpose({
  refresh: board.refresh,
  toggleSort: board.toggleSort,
  expandAll: board.expandAll,
  collapseAll: board.collapseAll
});
</script>

<style>
.auction-row {
  display: flex;
  align-items: center;
  border-bottom: 1px solid #f1f5f9;
  transition: background 0.2s;
  position: relative;
  flex-wrap: wrap;
}
.auction-row:hover { background: #f8fafc; }
.auction-obs-separator {
  margin: 10px 12px;
  border-top: 1.5px dashed #cbd5e1;
}
.auction-row.obs-row { background: #f0f9ff; }

/* 行标签状态（买/卖/选中）只用「左侧色条 + 文字色」表达，背景色一律交给行内 style
   （题材分组高光底色 / item.topicBg）。禁止用 background:!important 覆盖行内背景——
   否则标记买/卖后题材分组高光底色会被强制清空，正是「加标签后高光消失」的根因。
   竞昨/竞昨占比/三天竞跌的高光（box-shadow 左竖条）本就独立于标签，互不影响。 */
.auction-item.sold {
  background: transparent;
  border-left: 3px solid #9ca3af;
}
.auction-item.sold:hover { background: #f3f4f6; }
.auction-item.bought {
  background: transparent;
  border-left: 3px solid #ef4444;
}
.auction-item.bought:hover { background: #fee2e2; }
.auction-item.selected {
  background: transparent;
  border-left: 3px solid #8b5cf6;
}
.auction-item.selected:hover { background: #f3e8ff; }
.auction-item.manual-selected {
  background: transparent;
  border-left: 3px solid #f97316;
}
.auction-item.manual-selected:hover { background: #ffedd5; }
.auction-item.high-ratio { box-shadow: inset 4px 0 0 #f59e0b; }
.auction-item.parallel-match { box-shadow: inset 4px 0 0 #10b981; }
.auction-item.jing-yest-match { box-shadow: inset 4px 0 0 #3b82f6; }
.auction-item.three-day-jing-die { box-shadow: inset 4px 0 0 #059669; }
/* [FEAT 2026-08-18] 双击表头搜索 → 匹配行外框圈选（不要背景色，只要低调灰色外框）。
   行 div 类为 auction-item；用 box-shadow inset 模拟内边框，不影响布局、不被相邻行遮挡；
   放在状态类之后确保覆盖 sold/bought/selected 等的 box-shadow（同特异性同 important，后定义胜出）。 */
.auction-item.auction-row-highlight { box-shadow: inset 0 0 0 2px #64748b !important; }
.auction-item.auction-row-highlight:hover { box-shadow: inset 0 0 0 2px #475569 !important; }
/* 股票名称列作为 badge 的定位父级。
   - position:relative 让内部 absolute 的 badge-group 相对它定位。
   - 不再用 padding-right 预留角标空间(那会撑宽名称列、挤动后面四列)。
   - badge 改为 absolute 浮动角标, 完全脱离文档流, 五列位置固定不变。
   - overflow:visible 确保角标不被裁剪(父级容器已是 visible)。 */
.auction-stock-name {
  position: relative;
  overflow: visible;
}
.auction-trend-panel {
  width: 100%;
  flex-basis: 100%;
  padding: 8px;
  background: #f9fafb;
  border-top: 1px solid #e5e7eb;
}
.auction-daily-metrics {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  padding: 4px 2px 6px;
  margin-bottom: 4px;
  border-bottom: 1px dashed #e5e7eb;
  font-size: 11px;
  color: #475569;
  line-height: 1.4;
}
.adm-item {
  white-space: nowrap;
}
.adm-item > b {
  color: #334155;
  font-weight: 600;
}
.trend-chart-item {
  margin-bottom: 4px;
}
.trend-chart-label {
  font-size: 10px;
  color: #94a3b8;
  margin-bottom: 2px;
}
.trend-chart-label-with-stats {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
.trend-chart-label-with-stats > span:first-child {
  flex: 0 0 auto;
}
.trend-chart-label-with-stats > span:not(:first-child) {
  flex: 0 0 auto;
}
.auction-swipe-container {
  flex: 1;
  position: relative;
  overflow: visible !important;
  touch-action: auto !important;
  overscroll-behavior: auto !important;
}
.auction-scroll-container {
  overflow: visible !important;
  padding: 4px 0;
  touch-action: auto !important;
  overscroll-behavior: auto !important;
}
.auction-search-container {
  padding: 8px 12px;
  background: #f9fafb;
  border-bottom: 1px solid #e5e7eb;
}
.auction-search-input {
  width: 100%;
  padding: 6px 10px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 13px;
  outline: none;
}
.auction-board-vue {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.auction-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  border-bottom: 1px solid #e5e7eb;
  flex-wrap: wrap;
}
.toolbar-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: #374151;
  cursor: pointer;
}
.toolbar-btn {
  padding: 4px 10px;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  background: #fff;
  font-size: 12px;
  cursor: pointer;
}
.toolbar-search {
  padding: 4px 8px;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  font-size: 12px;
  width: 120px;
}
.auction-stats-bar {
  display: flex;
  gap: 16px;
  padding: 6px 12px;
  background: #f9fafb;
  font-size: 12px;
  color: #6b7280;
  border-bottom: 1px solid #e5e7eb;
}
.stat-item {
  font-weight: 500;
}
.auction-empty {
  text-align: center;
  color: #9ca3af;
  padding: 40px 0;
  font-size: 14px;
}
.auction-obs-group {
  border-bottom: 2px solid #fbbf24;
  margin-bottom: 4px;
}
.auction-group-label {
  padding: 4px 12px;
  font-size: 11px;
  color: #f59e0b;
  font-weight: 600;
}
.auction-trend-panel {
  padding: 6px 8px 8px;
  background: #f8fafc;
  margin-top: 4px;
}
.page-indicator {
  margin-left: auto;
  display: inline-flex;
  gap: 4px;
}
.page-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.4);
  cursor: pointer;
  transition: all 0.3s;
}
.page-dot.active {
  background: #ffffff;
  transform: scale(1.2);
}
.backend-toggle {
  margin-left: 8px;
  background: #f3f4f6;
  font-weight: 600;
}
.auction-backend-panel {
  padding: 8px 10px;
  background: #f9fafb;
  border-bottom: 1px solid #e5e7eb;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.backend-block {
  padding: 10px;
  border-radius: 6px;
  border: 1px solid transparent;
}
.backend-block-ths {
  background: #fffbeb;
  border-color: #fcd34d;
}
.backend-block-numcat {
  background: #fdf2f8;
  border-color: #f9a8d4;
}
.backend-block-import {
  background: #f0fdf4;
  border-color: #86efac;
}
.backend-block-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.backend-block-title {
  font-size: 13px;
  font-weight: 600;
}
.backend-block-ths .backend-block-title { color: #92400e; }
.backend-block-numcat .backend-block-title { color: #831843; }
.backend-block-import .backend-block-title { color: #166534; }
.backend-block-sub {
  font-size: 10px;
  font-family: monospace;
  opacity: 0.7;
}
.backend-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.backend-btn {
  padding: 8px 6px;
  border: none;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  color: #fff;
  min-height: 36px;
  transition: opacity 0.2s;
}
.backend-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.backend-btn-ths {
  background: linear-gradient(135deg, #f59e0b, #d97706);
}
.backend-btn-numcat {
  background: linear-gradient(135deg, #ec4899, #db2777);
}
.backend-btn-import {
  background: linear-gradient(135deg, #22c55e, #16a34a);
}
.backend-btn:hover:not(:disabled) {
  opacity: 0.85;
}
.auction-backend-panel.is-loading .backend-btn {
  pointer-events: none;
  opacity: 0.5;
}
.backend-status {
  display: block;
  margin-top: 6px;
  font-size: 12px;
  min-height: 16px;
  font-weight: 500;
}
.topic-group {
  border-bottom: 1px solid #e5e7eb;
  padding: 6px 12px;
}
.topic-group-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 4px;
}
.topic-name {
  font-size: 13px;
  font-weight: 600;
  color: #1f2937;
}
.topic-strength {
  font-size: 11px;
  color: #dc2626;
  font-weight: 500;
}
.topic-count {
  font-size: 11px;
  color: #6b7280;
  margin-left: auto;
}
.topic-group-body {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.topic-stock-item {
  font-size: 12px;
  color: #374151;
  background: #f3f4f6;
  padding: 2px 6px;
  border-radius: 3px;
}
.topic-stock-item small {
  color: #6b7280;
  font-size: 10px;
}
/* ===== 第二页题材分组样式（复刻原始 HTML） ===== */
.auction-toolbar-row2 {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 12px;
  border-bottom: 1px solid #e5e7eb;
  flex-wrap: wrap;
}
.auction-header-change { flex: 0.6; text-align: center; }
.auction-topic-group {
  margin-bottom: 12px;
  border-bottom: 1px solid #e2e8f0;
  padding-bottom: 8px;
}
.auction-topic-group:last-child {
  margin-bottom: 0;
  border-bottom: none;
  padding-bottom: 0;
}
.auction-topic-header {
  background: linear-gradient(135deg, #f3e8ff, #ede9fe);
  padding: 6px 2px;
  font-size: 12px;
  font-weight: 600;
  color: #7c3aed;
  display: flex;
  align-items: center;
  border-radius: 6px;
  margin-bottom: 6px;
  user-select: none;
  -webkit-user-select: none;
}
.auction-topic-left {
  flex: 0 0 130px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.auction-topic-stars {
  flex: 0 0 80px;
  text-align: left;
  color: #dc2626;
  font-size: 13px;
  letter-spacing: 1px;
}
.auction-topic-strength {
  flex: 0 0 70px;
  font-size: 12px;
}
.auction-topic-count {
  font-size: 11px;
  color: #9333ea;
  background: rgba(147, 51, 234, 0.1);
  padding: 2px 8px;
  border-radius: 10px;
  margin-left: auto;
}
.auction-topic-expand-row {
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 9px 0;
  cursor: pointer;
}
.auction-topic-expand-arrow {
  font-size: 12px;
  color: #9333ea;
  background: rgba(147, 51, 234, 0.12);
  transition: transform 0.2s;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;
}
.auction-topic-expand-arrow.expanded {
  transform: rotate(180deg);
}
.auction-topic-row {
  display: flex;
  border-bottom: 1px solid #f1f5f9;
  padding: 6px 0;
  user-select: none;
  -webkit-user-select: none;
}
.auction-topic-row:last-child {
  border-bottom: none;
}
.auction-topic-row.sold { background: #f3f4f6; }
.auction-topic-row.bought { background: #fee2e2; }
.auction-topic-row.selected { background: #f3e8ff; }
.auction-topic-row.high-ratio { box-shadow: inset 4px 0 0 #f59e0b; }
.auction-topic-row.parallel-match { box-shadow: inset 4px 0 0 #10b981; }
.auction-topic-row.jing-yest-match { box-shadow: inset 4px 0 0 #3b82f6; }
.auction-topic-row.three-day-jing-die { box-shadow: inset 4px 0 0 #059669; }
.auction-topic-stock {
  flex: 0 0 75px;
  font-size: 13px;
  font-weight: 500;
  color: #1f2937;
  padding-left: 10px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  box-sizing: border-box;
}
.auction-topic-change {
  flex: 0 0 55px;
  font-size: 12px;
  color: #374151;
  text-align: center;
}
.auction-change-red { color: #dc2626; font-weight: 600; }
.auction-change-green { color: #16a34a; font-weight: 600; }
.auction-topic-name {
  flex: 1;
  font-size: 12px;
  color: #6b7280;
  text-align: left;
  padding-left: 8px;
  overflow: hidden;
  text-overflow: ellipsis;
  box-sizing: border-box;
}
.auction-topic-ratio {
  flex: 0 0 50px;
  font-size: 13px;
  font-weight: 500;
  color: #374151;
  text-align: center;
  padding-right: 10px;
  box-sizing: border-box;
}
.strength-sort-active { color: #7c3aed; font-weight: 700; }
.auction-trend-trigger-p2 { cursor: pointer; }
/* ===== 第三页样式 ===== */
.auction-topic-history-group {
  margin-bottom: 0;
  border-bottom: 1px solid #e2e8f0;
  padding-bottom: 8px;
}
.auction-topic-history-group:last-child {
  margin-bottom: 0;
  border-bottom: none;
  padding-bottom: 0;
}
.auction-topic-history-title {
  background: linear-gradient(135deg, #dbeafe, #e0e7ff);
  padding: 12px 10px;
  font-size: 14px;
  font-weight: 600;
  color: #3b82f6;
  border-radius: 6px;
  margin-bottom: 6px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.auction-topic-copy-btn {
  font-size: 11px;
  padding: 2px 8px;
  background: #3b82f6;
  color: #fff;
  border-radius: 4px;
  cursor: pointer;
  font-weight: 500;
}
.auction-topic-copy-btns {
  display: flex;
  gap: 4px;
  margin-left: auto;
}
.auction-topic-copy-btn:active { background: #2563eb; }
.auction-topic-history-header {
  display: flex;
  padding: 4px 10px;
  font-size: 11px;
  color: #64748b;
  background: #f8fafc;
  border-radius: 4px;
  margin-bottom: 4px;
}
.auction-topic-history-row {
  display: flex;
  padding: 5px 10px;
  font-size: 11px;
  border-bottom: 1px solid #f1f5f9;
  user-select: none;
  -webkit-user-select: none;
  cursor: pointer;
}
.auction-topic-history-row:last-child { border-bottom: none; }
.auction-topic-history-row.today { background: rgba(239, 68, 68, 0.1); }
.auction-history-col { text-align: center; }
.auction-history-date { flex: 0 0 50px; text-align: left; }
.auction-topic-history-row .auction-history-date { font-size: 12px; }
.auction-history-rank { flex: 0 0 60px; font-size: 11px; }
.auction-history-star { flex: 0 0 75px; letter-spacing: 1px; }
.auction-topic-history-row .auction-history-star { font-size: 12px; }
.auction-history-strength { flex: 0 0 50px; }
.auction-history-count { flex: 0 0 40px; }
.auction-history-arrow { flex: 0 0 35px; }
/* ===== 第四页样式 ===== */
.auction-page-4 { padding-top: 20px; padding-bottom: 100px; }
.auction-copied-row {
  display: flex;
  align-items: center;
  padding: 6px 10px;
  border-bottom: 1px solid #f1f5f9;
  font-size: 12px;
}
.auction-copied-row:last-child { border-bottom: none; }
.auction-copied-stock { flex: 0 0 70px; font-size: 13px; font-weight: 500; }
.auction-copied-topic { flex: 1; color: #64748b; padding: 0 8px; text-align: center; }
.auction-copied-ratio { flex: 0 0 70px; text-align: right; font-weight: 500; padding-right: 5px; }
.auction-copied-ratio.highlight { color: #dc2626; font-weight: 600; }
.auction-copied-ratio.highlight-light { color: #f87171; font-weight: 600; }
.auction-copied-delete { flex: 0 0 30px; text-align: center; color: #ef4444; cursor: pointer; font-size: 14px; }
.auction-clear-all-btn {
  position: relative;
  margin: 20px auto 0;
  padding: 8px 20px;
  background: #ef4444;
  color: #fff;
  border-radius: 6px;
  font-size: 12px;
  cursor: pointer;
  font-weight: 500;
  display: inline-block;
  left: 50%;
  transform: translateX(-50%);
}
.auction-clear-all-btn:active { background: #dc2626; }
.auction-copied-placeholder { text-align: center; padding: 40px 20px; color: #9ca3af; font-size: 12px; }
</style>
