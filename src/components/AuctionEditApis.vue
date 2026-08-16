<template>
  <!-- 同花顺接口 -->
  <div class="api-section api-ths">
    <div class="api-section-header">
      <span class="api-section-title">同花顺接口</span>
      <span class="api-section-tag">883410.TI · fuyao-proxy</span>
    </div>
    <div class="api-grid">
      <button
        v-for="b in modal.thsButtons"
        :key="b.key"
        :class="['btn', 'btn-ths', { 'btn-ths-wide': b.wide }]"
        :disabled="modal.busyKey === b.key"
        @click="modal.runBackend(b.fn, b.key, 'thsApiStatus')"
      >
        {{ busyBtnLabel(b) }}
      </button>
    </div>
    <span
      class="api-status-line"
      :class="modal.statusCls('thsApiStatus')"
    >{{ modal.statusMsg('thsApiStatus') }}</span>
  </div>

  <!-- 猫抓接口 -->
  <div class="api-section api-numcat">
    <div class="api-section-header">
      <span class="api-section-title">猫抓数据接口</span>
      <span class="api-section-tag">免费额度每日10次</span>
    </div>
    <div class="api-grid">
      <button
        v-for="b in modal.numcatButtons"
        :key="b.key"
        :class="['btn', 'btn-numcat', { 'btn-numcat-wide': b.wide }]"
        :disabled="modal.busyKey === b.key"
        @click="modal.runBackend(b.fn, b.key, 'numcatApiStatus')"
      >
        {{ busyBtnLabel(b) }}
      </button>
    </div>
    <span
      class="api-status-line"
      :class="modal.statusCls('numcatApiStatus')"
    >{{ modal.statusMsg('numcatApiStatus') }}</span>
  </div>
</template>

<script setup>
import { inject } from 'vue';
const modal = inject('auctionEditModal');

// 按钮文案：忙碌时显示「处理中...」，否则显示标签（原为模板内联三元，渲染不变）
function busyBtnLabel(b) {
  return modal.busyKey === b.key ? '处理中...' : b.label;
}
</script>

<style scoped>
/* API 区块 */
.api-section {
  margin-bottom: 16px;
  padding: 10px;
  border-radius: 6px;
}
.api-ths {
  background: #fffbeb;
  border: 1px solid #fcd34d;
}
.api-numcat {
  background: #fdf2f8;
  border: 1px solid #f9a8d4;
}
.api-diag {
  background: #f0fdf4;
  border: 1px solid #86efac;
}
.api-section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.api-section-title {
  font-size: 13px;
  font-weight: 600;
}
.api-ths .api-section-title { color: #92400e; }
.api-numcat .api-section-title { color: #831843; }
.api-diag .api-section-title { color: #166534; }
.api-section-tag {
  font-size: 10px;
  font-family: monospace;
}
.api-ths .api-section-tag { color: #b45309; }
.api-numcat .api-section-tag { color: #be185d; }
.api-diag .api-section-tag { color: #16a34a; }
.api-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.api-grid .btn {
  padding: 10px 8px;
  font-size: 12px;
  min-height: 40px;
}
/* 每个接口区块独立的进度状态行（对应原版 #thsApiStatus / #numcatApiStatus / #auctionDiagStatus） */
.api-status-line {
  display: block;
  margin-top: 6px;
  font-size: 12px;
  min-height: 16px;
  line-height: 1.5;
  word-break: break-all;
}
.api-ths .api-status-line { color: #92400e; }
.api-numcat .api-status-line { color: #831843; }
.api-diag .api-status-line { color: #166534; }
/* 成功/失败按原版 setApiStatus 的 isOk 着色（绿=成功/进行中，红=失败） */
.api-status-line.ok { color: #059669 !important; font-weight: 600; }
.api-status-line.err { color: #dc2626 !important; font-weight: 600; }
/* 通用小按钮（接口区） */
.btn {
  padding: 6px 12px;
  font-size: 12px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  min-height: 32px;
}
.btn-ths { background: linear-gradient(135deg, #f59e0b, #d97706); color: #fff; }
.btn-ths-wide { grid-column: span 2; font-weight: 600; }
.btn-numcat { background: linear-gradient(135deg, #ec4899, #db2777); color: #fff; }
.btn-numcat-wide { grid-column: span 2; background: linear-gradient(135deg, #be185d, #9d174d); font-weight: 600; }
.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
