<template>
  <!-- 股票代码映射区 -->
  <div class="section-codemap">
    <div class="section-codemap-header">
      <span class="section-codemap-title">股票代码映射（供抓取程序读取）</span>
      <label class="toggle-switch">
        <input
          v-model="modal.codeMapOpen"
          type="checkbox"
        >
        <span class="toggle-slider" />
      </label>
    </div>
    <div
      v-if="modal.codeMapOpen"
      class="section-codemap-body"
    >
      <div class="section-codemap-hint">
        两列：股票名称[TAB]股票代码（如 贵州茅台[TAB]600519）。存为「名称→代码」映射，前台不显示代码，仅供抓取程序读取。同名覆盖，长期复用。
      </div>
      <textarea
        v-model="modal.codeMapText"
        placeholder="贵州茅台&#9;600519&#10;平安银行&#9;000001&#10;..."
        class="codemap-textarea"
      />
      <div class="codemap-btns">
        <button
          class="btn btn-codemap-import"
          @click="modal.onImportCodeMap"
        >
          导入代码映射
        </button>
        <button
          class="btn btn-codemap-auto"
          @click="modal.onAutoCompleteCode"
        >
          自动补全代码
        </button>
      </div>
      <span
        v-if="modal.codeMapStatus"
        class="inline-status"
      >{{ modal.codeMapStatus }}</span>
    </div>
  </div>
</template>

<script setup>
import { inject } from 'vue';
const modal = inject('auctionEditModal');
</script>

<style scoped>
/* 股票代码映射区（原版：绿框 padding10 radius6） */
.section-codemap {
  margin-bottom: 16px;
  padding: 10px;
  background: #f0fdf4;
  border: 1px solid #bbf7d0;
  border-radius: 6px;
}
.section-codemap-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.section-codemap-title {
  font-size: 13px;
  color: #15803d;
  font-weight: 600;
}
.section-codemap-body {
  margin-top: 8px;
}
.section-codemap-hint {
  font-size: 11px;
  color: #166534;
  margin-bottom: 8px;
  line-height: 1.5;
}
.codemap-textarea {
  width: 100%;
  height: 80px;
  padding: 8px;
  font-size: 12px;
  border: 1px solid #bbf7d0;
  border-radius: 4px;
  resize: vertical;
  box-sizing: border-box;
}
.codemap-btns {
  display: flex;
  gap: 8px;
  margin-top: 8px;
  flex-wrap: wrap;
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
.btn-codemap-import { background: linear-gradient(135deg, #10b981, #059669); color: #fff; }
.btn-codemap-auto { background: linear-gradient(135deg, #8b5cf6, #7c3aed); color: #fff; }
.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
