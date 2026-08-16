<template>
  <!-- 底部操作按钮（随内容一起滚动） -->
  <button
    class="add-rank-btn"
    @click="modal.addRow"
  >
    + 添加新行
  </button>
  <button
    class="submit-btn save"
    @click="modal.save"
  >
    保存
  </button>
  <button
    class="submit-btn rollback"
    @click="modal.onRollback"
  >
    撤回
  </button>
  <button
    class="submit-btn clear-concept"
    @click="modal.onClearConcepts"
  >
    清除题材
  </button>
  <button
    class="submit-btn clear-text"
    @click="modal.onClearText"
  >
    清除文字
  </button>
  <button
    class="submit-btn clear-note"
    @click="modal.onClearNotes"
  >
    清除注释
  </button>
  <button
    class="submit-btn clear-all"
    @click="modal.clearAllRows"
  >
    清空所有行
  </button>
  <button
    class="submit-btn repair"
    @click="modal.onRepair"
  >
    🔧 恢复本日数据
  </button>
</template>

<script setup>
import { inject } from 'vue';
const modal = inject('auctionEditModal');
</script>

<style scoped>
/* 底部操作按钮（原版 .add-rank-btn / .submit-btn，均在滚动流内） */
.add-rank-btn {
  background: #f1f5f9;
  border: 1px solid #e2e8f0;
  color: #64748b;
  padding: 12px;
  border-radius: 8px;
  font-size: 13px;
  cursor: pointer;
  width: 100%;
  margin-top: 8px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.submit-btn {
  width: 100%;
  background: linear-gradient(135deg, #3b82f6, #2563eb);
  border: none;
  color: white;
  padding: 16px;
  border-radius: 12px;
  font-size: 16px;
  font-weight: 600;
  margin-top: 10px;
  cursor: pointer;
}
.submit-btn.save { margin-top: 16px; }
.submit-btn.rollback { background: linear-gradient(135deg, #3b82f6, #2563eb); }
.submit-btn.clear-concept { background: linear-gradient(135deg, #ef4444, #dc2626); }
.submit-btn.clear-text { background: linear-gradient(135deg, #f97316, #ea580c); }
.submit-btn.clear-note { background: linear-gradient(135deg, #6b7280, #4b5563); }
.submit-btn.clear-all { background: linear-gradient(135deg, #7f1d1d, #991b1b); }
.submit-btn.repair { background: linear-gradient(135deg, #0d9488, #0f766e); }
</style>
