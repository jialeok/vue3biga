<template>
  <div
    v-if="visible"
    class="modal active"
    @click.self="close"
  >
    <div
      class="modal-content"
      style="max-width: 500px; max-height: 80vh;"
    >
      <div
        class="modal-header"
        style="padding: 0 0 16px 0; margin-bottom: 0;"
      >
        <div style="font-weight:600;color:#1f2937">
          核心词管理
        </div>
        <button
          class="close-btn"
          @click="close"
        >
          ×
        </button>
      </div>
      <div style="margin-bottom: 16px;">
        <div style="font-size: 12px; color: #6b7280; margin-bottom: 8px;">
          添加新核心词：
        </div>
        <div style="display: flex; gap: 8px; flex-wrap: wrap;">
          <input
            v-model="newName"
            type="text"
            placeholder="核心词名称"
            style="flex: 1; min-width: 120px; padding: 8px; font-size: 13px; border: 1px solid #e2e8f0; border-radius: 4px;"
          >
          <input
            v-model="newSynonyms"
            type="text"
            placeholder="同义词（逗号分隔）"
            style="flex: 2; min-width: 150px; padding: 8px; font-size: 13px; border: 1px solid #e2e8f0; border-radius: 4px;"
          >
          <button
            type="button"
            style="padding: 8px 16px; font-size: 13px; background: linear-gradient(135deg, #8b5cf6, #7c3aed); color: #fff; border: none; border-radius: 4px; cursor: pointer;"
            @click="addCoreTopic"
          >
            添加
          </button>
        </div>
      </div>
      <div style="max-height: 400px; overflow-y: auto;">
        <div
          v-if="coreTopics.length === 0"
          style="text-align: center; color: #9ca3af; padding: 20px;"
        >
          暂无核心词，请添加
        </div>
        <div
          v-for="(core, index) in coreTopics"
          :key="core.name"
          style="display: flex; align-items: center; padding: 10px; border: 1px solid #e2e8f0; border-radius: 6px; margin-bottom: 8px; background: #fafafa;"
        >
          <div style="flex: 1;">
            <div style="font-weight: 600; color: #1f2937; font-size: 14px;">
              {{ core.name }}
            </div>
            <div style="font-size: 12px; color: #6b7280; margin-top: 4px;">
              同义词：{{ synonymsText(core) }}
            </div>
          </div>
          <button
            type="button"
            style="padding: 4px 8px; font-size: 12px; background: #e0e7ff; color: #4f46e5; border: none; border-radius: 4px; cursor: pointer; margin-right: 4px;"
            @click="editCoreTopic(index)"
          >
            编辑
          </button>
          <button
            type="button"
            style="padding: 4px 8px; font-size: 12px; background: #fee2e2; color: #dc2626; border: none; border-radius: 4px; cursor: pointer;"
            @click="deleteCoreTopic(index)"
          >
            删除
          </button>
        </div>
      </div>
      <div style="margin-top: 16px; display: flex; gap: 8px;">
        <button
          type="button"
          style="padding: 8px 16px; font-size: 13px; background: linear-gradient(135deg, #6b7280, #4b5563); color: #fff; border: none; border-radius: 4px; cursor: pointer;"
          @click="resetCoreTopics"
        >
          恢复默认
        </button>
        <button
          type="button"
          style="padding: 8px 16px; font-size: 13px; background: linear-gradient(135deg, #0ea5e9, #0284c7); color: #fff; border: none; border-radius: 4px; cursor: pointer;"
          @click="close"
        >
          完成
        </button>
      </div>
    </div>
  </div>
  <div
    v-if="editVisible"
    class="modal active"
    @click.self="closeEdit"
  >
    <div
      class="modal-content"
      style="max-width: 420px; padding-bottom: 20px;"
    >
      <div
        class="modal-header"
        style="padding: 0 0 16px 0; margin-bottom: 0;"
      >
        <div style="font-weight:600;color:#1f2937">
          编辑核心词
        </div>
        <button
          class="close-btn"
          @click="closeEdit"
        >
          ×
        </button>
      </div>
      <div style="margin-bottom: 16px;">
        <div style="font-size: 12px; color: #6b7280; margin-bottom: 8px;">
          核心词名称
        </div>
        <input
          v-model="editName"
          type="text"
          style="width: 100%; box-sizing: border-box; padding: 10px; font-size: 14px; border: 1px solid #e2e8f0; border-radius: 6px;"
        >
      </div>
      <div style="margin-bottom: 16px;">
        <div style="font-size: 12px; color: #6b7280; margin-bottom: 8px;">
          同义词（逗号分隔）
        </div>
        <textarea
          v-model="editSynonyms"
          rows="3"
          style="width: 100%; box-sizing: border-box; padding: 10px; font-size: 14px; border: 1px solid #e2e8f0; border-radius: 6px; resize: vertical; font-family: inherit;"
        />
      </div>
      <div style="display: flex; gap: 8px;">
        <button
          type="button"
          style="flex:1; padding: 10px 16px; font-size: 14px; background: #f1f5f9; color: #475569; border: none; border-radius: 6px; cursor: pointer;"
          @click="closeEdit"
        >
          取消
        </button>
        <button
          type="button"
          style="flex:1; padding: 10px 16px; font-size: 14px; background: linear-gradient(135deg, #8b5cf6, #7c3aed); color: #fff; border: none; border-radius: 6px; cursor: pointer;"
          @click="saveEdit"
        >
          保存
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, watch } from 'vue';
import { getCoreTopics, saveCoreTopics } from '../logic/topic/rules.js';
import { state } from '../logic/app-state.js';
import { _emit } from '../stores/eventBus.js';

const visible = ref(false);
const coreTopics = ref([]);
const newName = ref('');
const newSynonyms = ref('');
const editVisible = ref(false);
const editIndex = ref(null);
const editName = ref('');
const editSynonyms = ref('');

function refreshList() {
  coreTopics.value = getCoreTopics();
}
function open() {
  refreshList();
  visible.value = true;
}
function close() {
  visible.value = false;
  _emit('auction-refresh');
}
function addCoreTopic() {
  const name = newName.value.trim();
  if (!name) { alert('请输入核心词名称'); return; }
  const list = getCoreTopics();
  if (list.find(c => c.name === name)) { alert('该核心词已存在'); return; }
  const synonyms = newSynonyms.value.trim() ? newSynonyms.value.trim().split(/[,，]/).map(s => s.trim()).filter(s => s) : [];
  list.push({ name, synonyms });
  saveCoreTopics(list);
  newName.value = '';
  newSynonyms.value = '';
  refreshList();
}
function editCoreTopic(index) {
  const list = getCoreTopics();
  const core = list[index];
  if (!core) return;
  editIndex.value = index;
  editName.value = core.name || '';
  editSynonyms.value = core.synonyms ? core.synonyms.join(',') : '';
  editVisible.value = true;
}
function closeEdit() {
  editVisible.value = false;
  editIndex.value = null;
}
function saveEdit() {
  if (editIndex.value === null) return;
  const list = getCoreTopics();
  if (!list[editIndex.value]) { closeEdit(); return; }
  list[editIndex.value].name = editName.value.trim() || list[editIndex.value].name;
  list[editIndex.value].synonyms = editSynonyms.value.trim() ? editSynonyms.value.trim().split(/[,，]/).map(s => s.trim()).filter(s => s) : [];
  saveCoreTopics(list);
  refreshList();
  closeEdit();
}
function deleteCoreTopic(index) {
  if (!confirm('确定删除该核心词？')) return;
  const list = getCoreTopics();
  list.splice(index, 1);
  saveCoreTopics(list);
  refreshList();
}
function resetCoreTopics() {
  if (!confirm('确定恢复默认核心词？当前设置将被覆盖。')) return;
  saveCoreTopics(state.defaultCoreTopics || []);
  refreshList();
}

// 同义词展示：原为模板内联「&& + .join() + 三元」逻辑，抽取后渲染不变
function synonymsText(core) {
  return core.synonyms && core.synonyms.length > 0 ? core.synonyms.join('、') : '无';
}

defineExpose({ open, close });
</script>