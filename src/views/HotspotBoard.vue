<template>
  <div class="hotspot-board trading-day-element">
  <div class="hotspot-header"><div class="hotspot-title">题材思路</div></div>
  <div class="hotspot-content" @click="startEdit">
    <div v-if="content.trim()" style="white-space: pre-wrap;">{{ content }}</div>
    <div v-else class="hotspot-placeholder">暂无题材思路，点击添加...</div>
  </div>
  <div v-if="editing" class="vue-edit-overlay" @click.self="cancel">
    <div class="vue-edit-modal">
      <div class="vue-edit-header"><span>编辑题材思路</span><button @click="cancel">×</button></div>
      <textarea v-model="draft" placeholder="输入题材思路分析..."></textarea>
      <button class="vue-edit-save" @click="save">保存</button>
    </div>
  </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { getCurrentDate, getHotspotData, saveData } from '../logic/app-core.js';
import { showToast } from '../composables/useToast.js';

const editing = ref(false);
const draft = ref('');
const content = ref('');

function loadContent() {
  content.value = getHotspotData()[getCurrentDate()] || '';
}
function refresh() {
  editing.value = false;
  draft.value = '';
}

function startEdit() {
  draft.value = content.value;
  editing.value = true;
}
function cancel() { editing.value = false; }
function save() {
  const val = draft.value.trim();
  const hotspotData = getHotspotData();
  hotspotData[getCurrentDate()] = val;
  saveData();
  loadContent();
  editing.value = false;
  showToast('✅ 题材思路已保存');
}

onMounted(() => loadContent());


defineExpose({ refresh });
</script>

<style>
.vue-edit-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.45);
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}
.vue-edit-modal {
  background: #fff;
  border-radius: 12px;
  width: 100%;
  max-width: 560px;
  max-height: 85vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 20px 50px rgba(0,0,0,0.25);
}
.vue-edit-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid #e5e7eb;
  font-weight: 600;
  color: #1f2937;
}
.vue-edit-header button {
  background: transparent;
  border: none;
  font-size: 22px;
  line-height: 1;
  cursor: pointer;
  color: #6b7280;
}
.vue-edit-modal textarea {
  width: 100%;
  padding: 14px;
  border: none;
  resize: vertical;
  outline: none;
  font-size: 14px;
  flex: 1;
  min-height: 140px;
  font-family: inherit;
}
.vue-edit-save {
  margin: 0 16px 16px;
  padding: 12px;
  border: none;
  border-radius: 8px;
  background: linear-gradient(135deg, #8b5cf6, #7c3aed);
  color: #fff;
  font-size: 15px;
  cursor: pointer;
}
.vue-edit-save:hover {
  opacity: 0.95;
}
</style>