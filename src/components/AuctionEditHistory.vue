<template>
  <!-- 历史数据补录区 -->
  <div class="section-history">
    <div class="section-history-header">
      <span class="section-history-title">历史数据补录模式</span>
      <label class="toggle-switch">
        <input type="checkbox" v-model="modal.historyOpen">
        <span class="toggle-slider"></span>
      </label>
    </div>
    <div v-if="modal.historyOpen" class="section-history-body">
      <div class="section-history-hint">只补空值；股票需在当前列表中存在才会补录；三列自动补两项，两列按右侧类型补一项；支持空格或TAB分隔</div>
      <div class="history-controls">
        <input type="date" v-model="modal.historyDate" class="history-date">
        <label class="history-radio"><input type="radio" v-model="modal.historyColType" value="volume"> 竞价量</label>
        <label class="history-radio"><input type="radio" v-model="modal.historyColType" value="yestVolume"> 昨日成交量</label>
      </div>
      <textarea v-model="modal.historyText" placeholder="三列：股票名称 竞价量 昨日成交量&#10;两列：股票名称 数字（按上方选择类型补录）&#10;空格或TAB分隔均可" class="history-textarea"></textarea>
      <button @click="modal.onHistoryFill" class="btn btn-history-fill">补录历史数据</button>
      <span v-if="modal.historyStatus" class="inline-status">{{ modal.historyStatus }}</span>
    </div>
  </div>
</template>

<script setup>
import { inject } from 'vue';
const modal = inject('auctionEditModal');
</script>

<style scoped>
/* 历史数据补录区（原版：蓝框 padding10 radius6） */
.section-history {
  margin-bottom: 16px;
  padding: 10px;
  background: #eff6ff;
  border: 1px solid #bfdbfe;
  border-radius: 6px;
}
.section-history-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.section-history-title {
  font-size: 13px;
  color: #1d4ed8;
  font-weight: 600;
}
.section-history-body {
  margin-top: 8px;
}
.section-history-hint {
  font-size: 11px;
  color: #1e40af;
  margin-bottom: 8px;
}
.history-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}
.history-date {
  padding: 4px 6px;
  font-size: 12px;
  border: 1px solid #bfdbfe;
  border-radius: 4px;
}
.history-radio {
  font-size: 12px;
  color: #374151;
  display: flex;
  align-items: center;
  gap: 4px;
}
.history-textarea {
  width: 100%;
  height: 80px;
  padding: 8px;
  font-size: 12px;
  border: 1px solid #bfdbfe;
  border-radius: 4px;
  resize: vertical;
  box-sizing: border-box;
}
.inline-status {
  display: inline-block;
  margin-top: 6px;
  font-size: 12px;
  color: #059669;
}
/* 开关 */
.toggle-switch {
  position: relative;
  display: inline-block;
  width: 36px;
  height: 20px;
}
.toggle-switch input {
  opacity: 0;
  width: 0;
  height: 0;
}
.toggle-slider {
  position: absolute;
  cursor: pointer;
  inset: 0;
  background: #ccc;
  border-radius: 20px;
  transition: 0.3s;
}
.toggle-slider:before {
  position: absolute;
  content: "";
  height: 16px;
  width: 16px;
  left: 2px;
  bottom: 2px;
  background: #fff;
  border-radius: 50%;
  transition: 0.3s;
}
.toggle-switch input:checked + .toggle-slider {
  background: #22c55e;
}
.toggle-switch input:checked + .toggle-slider:before {
  transform: translateX(16px);
}
/* 通用小按钮 */
.btn {
  padding: 6px 12px;
  font-size: 12px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  min-height: 32px;
}
.btn-history-fill { margin-top: 8px; background: linear-gradient(135deg, #3b82f6, #2563eb); color: #fff; }
.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
