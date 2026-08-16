<template>
  <!-- 粘贴区 -->
  <div class="section-paste">
    <textarea
      v-model="modal.pasteText"
      placeholder="从 Excel 复制后直接粘贴到这里&#10;格式1：股票名称[TAB]竞价量[TAB]昨日成交量&#10;格式2：股票名称[TAB]涨幅[TAB]概念（注释叠加）&#10;格式3：股票名称[TAB]涨幅 或 概念&#10;格式4：股票名称 涨幅%"
      class="paste-textarea"
    />
    <div class="paste-btns">
      <button
        class="btn btn-import"
        @click="modal.onPasteImport"
      >
        导入数据
      </button>
      <button
        class="btn btn-concept"
        @click="modal.onReplaceConcept"
      >
        替换概念
      </button>
    </div>
    <span
      v-if="modal.pasteStatus"
      class="inline-status"
    >{{ modal.pasteStatus }}</span>
  </div>
</template>

<script setup>
import { inject } from 'vue';
const modal = inject('auctionEditModal');
</script>

<style scoped>
/* 粘贴区（原版无边框，仅 margin-bottom 16px） */
.section-paste {
  margin-bottom: 16px;
}
.paste-textarea {
  width: 100%;
  height: 100px;
  padding: 8px;
  font-size: 12px;
  border: 1px solid #e2e8f0;
  border-radius: 4px;
  resize: vertical;
  box-sizing: border-box;
  -webkit-user-select: text;
  user-select: text;
}
.paste-btns {
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
/* 通用小按钮（粘贴/映射/历史区） */
.btn {
  padding: 6px 12px;
  font-size: 12px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  min-height: 32px;
}
.btn-import { background: linear-gradient(135deg, #0ea5e9, #0284c7); color: #fff; }
.btn-concept { background: linear-gradient(135deg, #8b5cf6, #7c3aed); color: #fff; }
.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
