<!-- CoreTopicModal.vue — 核心词管理（§4 不用原生 alert/confirm；§10 保存必须返回可见结果）
     2026-09-18 改造要点：
       ① 增 / 删 / 改 / 恢复默认 全部 await 云端结果 → 成功 showToast、失败 showWarningToast 并【回滚列表】。
          旧实现是 fire-and-forget：saveCoreTopics 不返回任何东西，界面靠本地内存看着像成功，
          云端失败（或被队列跳过）时用户完全无感 ⇒ 表现为「删了没反应 / 前台像成功」。
       ② 删除、恢复默认改为组件内确认弹层，去掉原生 confirm/alert（原生弹窗会阻塞主线程且样式割裂）。
       ③ 全程 saving 态：写云端期间按钮禁用并显示「保存中…」，避免连点产生并发写。 -->
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
            @keyup.enter="addCoreTopic"
          >
          <input
            v-model="newSynonyms"
            type="text"
            placeholder="同义词（逗号分隔）"
            style="flex: 2; min-width: 150px; padding: 8px; font-size: 13px; border: 1px solid #e2e8f0; border-radius: 4px;"
            @keyup.enter="addCoreTopic"
          >
          <button
            type="button"
            :disabled="saving"
            style="padding: 8px 16px; font-size: 13px; background: linear-gradient(135deg, #8b5cf6, #7c3aed); color: #fff; border: none; border-radius: 4px; cursor: pointer;"
            @click="addCoreTopic"
          >
            {{ saving ? '保存中…' : '添加' }}
          </button>
        </div>
        <!-- §10：校验失败内联提示，替代原生 alert（不阻塞、不打断输入） -->
        <div
          v-if="formError"
          style="margin-top: 6px; font-size: 12px; color: #dc2626;"
        >
          {{ formError }}
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
            :disabled="saving"
            style="padding: 4px 8px; font-size: 12px; background: #e0e7ff; color: #4f46e5; border: none; border-radius: 4px; cursor: pointer; margin-right: 4px;"
            @click="editCoreTopic(index)"
          >
            编辑
          </button>
          <button
            type="button"
            :disabled="saving"
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
          :disabled="saving"
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
          :disabled="saving"
          style="flex:1; padding: 10px 16px; font-size: 14px; background: linear-gradient(135deg, #8b5cf6, #7c3aed); color: #fff; border: none; border-radius: 6px; cursor: pointer;"
          @click="saveEdit"
        >
          {{ saving ? '保存中…' : '保存' }}
        </button>
      </div>
    </div>
  </div>

  <!-- 组件内确认弹层（替代原生 confirm，§4） -->
  <Teleport to="body">
    <div
      v-if="confirmState.visible"
      class="ctm-confirm-overlay"
      @click.self="confirmCancel"
    >
      <div class="ctm-confirm-panel">
        <div class="ctm-confirm-title">
          {{ confirmState.title }}
        </div>
        <div class="ctm-confirm-desc">
          {{ confirmState.desc }}
        </div>
        <div class="ctm-confirm-actions">
          <button
            type="button"
            class="ctm-btn-danger"
            :disabled="saving"
            @click="confirmOk"
          >
            {{ saving ? '处理中…' : confirmState.okText }}
          </button>
          <button
            type="button"
            class="ctm-btn-cancel"
            @click="confirmCancel"
          >
            取消
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { ref } from 'vue';
import { getCoreTopics, saveCoreTopics } from '../logic/topic/rules.js';
import { state } from '../logic/app-state.js';
import { _emit } from '../stores/eventBus.js';
import { showToast, showWarningToast } from '../composables/useToast.js';

const visible = ref(false);
const coreTopics = ref([]);
const newName = ref('');
const newSynonyms = ref('');
const formError = ref('');
const saving = ref(false);
const editVisible = ref(false);
const editIndex = ref(null);
const editName = ref('');
const editSynonyms = ref('');
const confirmState = ref({ visible: false, title: '', desc: '', okText: '确定', onOk: null });

function refreshList() {
  coreTopics.value = getCoreTopics();
}
function open() {
  refreshList();
  formError.value = '';
  visible.value = true;
}
function close() {
  visible.value = false;
  _emit('auction-refresh');
}

function splitSynonyms(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return [];
  return t.split(/[,，]/).map(s => s.trim()).filter(s => s);
}

/**
 * 统一保存入口：把「写云端 + 成败反馈 + 失败回滚」收在一处（§10 禁止静默失败）。
 * 乐观更新列表（分组立即按新核心词重算），云端失败则连内存缓存一起回滚到上一版，
 * 保证界面与云端不会长期各说各话（§6 不留两个真相）。
 * @param {Array<{name:string, synonyms:string[]}>} nextList 目标核心词列表（不可变更新后的新数组）
 * @param {string} okMsg 成功提示文案
 * @returns {Promise<boolean>} 是否保存成功
 */
async function commit(nextList, okMsg) {
  const prevList = coreTopics.value.slice();
  saving.value = true;
  coreTopics.value = nextList.slice();
  try {
    const res = await saveCoreTopics(nextList);
    if (res && res.ok === false) throw new Error('云端写入未生效');
    refreshList();
    showToast(okMsg);
    return true;
  } catch (e) {
    coreTopics.value = prevList;
    // 内存缓存也回滚（saveCoreTopics 会更新 _coreTopicsMemCache）。不 await：
    // 失败已由下面的 toast 反馈，这里只是让缓存与界面一致；若这次反而写成功，结果也与界面一致。
    saveCoreTopics(prevList);
    console.error('[CORE-TOPICS] 保存失败:', e);
    showWarningToast('❌ 同步云端失败，已还原上一版：' + (e && e.message ? e.message : '未知错误'), 8000);
    return false;
  } finally {
    saving.value = false;
  }
}

async function addCoreTopic() {
  const name = newName.value.trim();
  if (!name) { formError.value = '请输入核心词名称'; return; }
  if (coreTopics.value.find(c => c.name === name)) { formError.value = '该核心词已存在'; return; }
  formError.value = '';
  const next = coreTopics.value.concat([{ name, synonyms: splitSynonyms(newSynonyms.value) }]);
  const ok = await commit(next, '✅ 已添加核心词「' + name + '」');
  if (ok) {
    newName.value = '';
    newSynonyms.value = '';
  }
}
function editCoreTopic(index) {
  const core = coreTopics.value[index];
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
async function saveEdit() {
  const idx = editIndex.value;
  if (idx === null) return;
  const cur = coreTopics.value[idx];
  if (!cur) { closeEdit(); return; }
  const finalName = editName.value.trim() || cur.name;
  const next = coreTopics.value.map((c, i) => (
    i === idx ? { name: finalName, synonyms: splitSynonyms(editSynonyms.value) } : c
  ));
  const ok = await commit(next, '✅ 已保存核心词「' + finalName + '」');
  if (ok) closeEdit();
}
function deleteCoreTopic(index) {
  const core = coreTopics.value[index];
  if (!core) return;
  askConfirm(
    '确定删除核心词「' + core.name + '」？',
    '删除会同步到云端，三个看板（涨跌停 / 竞价一字 / 早盘竞价）的题材分组都会立即按新核心词重算。',
    '确定删除',
    async () => {
      const next = coreTopics.value.filter((_, i) => i !== index);
      await commit(next, '✅ 已删除核心词「' + core.name + '」');
    }
  );
}
function resetCoreTopics() {
  askConfirm(
    '确定恢复默认核心词？',
    '当前自定义的核心词配置将被默认词库覆盖，并同步到云端（此操作不可撤销）。',
    '确定恢复',
    async () => {
      const defaults = (state.defaultCoreTopics || []).slice();
      await commit(defaults, '✅ 已恢复默认核心词（' + defaults.length + ' 个）');
    }
  );
}

function askConfirm(title, desc, okText, onOk) {
  confirmState.value = { visible: true, title, desc, okText, onOk };
}
function confirmCancel() {
  confirmState.value.visible = false;
}
async function confirmOk() {
  const fn = confirmState.value.onOk;
  confirmState.value.visible = false;
  if (typeof fn === 'function') await fn();
}

// 同义词展示：原为模板内联「&& + .join() + 三元」逻辑，抽取后渲染不变
function synonymsText(core) {
  return core.synonyms && core.synonyms.length > 0 ? core.synonyms.join('、') : '无';
}

defineExpose({ open, close });
</script>

<style scoped>
.ctm-confirm-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  z-index: 10001; /* 必须盖在「核心词管理」弹层之上 */
  display: flex;
  align-items: center;
  justify-content: center;
}
.ctm-confirm-panel {
  background: #fff;
  border-radius: 12px;
  padding: 24px;
  min-width: 320px;
  max-width: 420px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.18);
}
.ctm-confirm-title {
  font-size: 16px;
  font-weight: 600;
  color: #1f2937;
  margin-bottom: 8px;
}
.ctm-confirm-desc {
  font-size: 13px;
  color: #6b7280;
  line-height: 1.6;
  margin-bottom: 18px;
}
.ctm-confirm-actions {
  display: flex;
  gap: 8px;
}
.ctm-btn-danger {
  flex: 1;
  padding: 9px 16px;
  border: none;
  border-radius: 6px;
  background: #dc2626;
  color: #fff;
  font-size: 13px;
  cursor: pointer;
}
.ctm-btn-danger:disabled {
  opacity: 0.6;
  cursor: default;
}
.ctm-btn-cancel {
  flex: 1;
  padding: 9px 16px;
  border: none;
  border-radius: 6px;
  background: #e5e7eb;
  color: #374151;
  font-size: 13px;
  cursor: pointer;
}
</style>
