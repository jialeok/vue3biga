<template>
  <div class="hotspot-board trading-day-element">
  <div class="hotspot-header"><div class="hotspot-title">题材思路</div></div>
  <div class="hotspot-content" @click="startEdit">
    <div v-if="content.trim()" style="white-space: pre-wrap;">{{ content }}</div>
    <div v-else class="hotspot-placeholder">暂无题材思路，点击添加...</div>
  </div>
  <Teleport to="body">
    <div v-if="editing" class="vue-edit-overlay" @click.self="cancel">
      <div class="vue-edit-modal">
        <div class="vue-edit-header"><span>编辑题材思路</span><button @click="cancel">×</button></div>
        <textarea v-model="draft" placeholder="输入题材思路分析..."></textarea>
        <button class="vue-edit-save" @click="save">保存</button>
      </div>
    </div>
  </Teleport>
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

