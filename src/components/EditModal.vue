<template>
  <Teleport to="body">
    <div
      v-if="modelValue"
      class="edit-modal-backdrop"
      @click.self="$emit('update:modelValue', false)"
    >
      <div class="edit-modal-panel">
        <div class="edit-modal-header">
          {{ title }}
        </div>
        <div class="edit-modal-body">
          <slot />
        </div>
        <div
          v-if="showActions"
          class="edit-modal-actions"
        >
          <button
            class="btn-save"
            :disabled="saving"
            @click="$emit('save')"
          >
            <span
              v-if="saving"
              class="btn-spinner"
            />
            <span>{{ saveLabel() }}</span>
          </button>
          <button
            v-if="showClear"
            :class="clearClass"
            @click="$emit('clear')"
          >
            {{ clearText }}
          </button>
          <button
            class="btn-cancel"
            @click="$emit('update:modelValue', false)"
          >
            {{ cancelText }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
const props = defineProps({
  modelValue: { type: Boolean, default: false },
  title: { type: String, default: '编辑' },
  showActions: { type: Boolean, default: true },
  showClear: { type: Boolean, default: false },
  saveText: { type: String, default: '保存' },
  clearText: { type: String, default: '清空' },
  cancelText: { type: String, default: '取消' },
  // 保存中进度态：禁用保存按钮并显示转圈 + "保存中..."（对标旧版 setBtnLoading）
  saving: { type: Boolean, default: false },
  // 各看板可定制清除按钮样式（如竞价看板用灰色 btn-clear-gray，其它看板沿用默认红色）
  clearClass: { type: String, default: 'btn-clear' }
});

defineEmits(['update:modelValue', 'save', 'clear']);

// 保存按钮文案：处理中显示「保存中...」，否则显示 saveText（原为模板内联三元，渲染不变）
function saveLabel() {
  return props.saving ? '保存中...' : props.saveText;
}
</script>

<style scoped>
.edit-modal-backdrop {
  position: fixed; inset: 0; background: rgba(0, 0, 0, 0.5);
  z-index: 9999; display: flex; align-items: flex-end; justify-content: center;
}
.edit-modal-panel {
  background: #fff; border-radius: 24px 24px 0 0; padding: 20px;
  width: 100%; max-width: 400px; max-height: 85vh; overflow-y: auto;
  padding-bottom: 40px; box-shadow: 0 -4px 20px rgba(0, 0, 0, 0.1);
}
.edit-modal-header { font-size: 16px; font-weight: 600; margin-bottom: 16px; }
.edit-modal-body { margin-bottom: 16px; }
.edit-modal-actions { display: flex; gap: 8px; }
.edit-modal-actions button {
  flex: 1; padding: 12px 16px; border: none; border-radius: 12px;
  cursor: pointer; font-size: 15px; font-weight: 600;
  display: inline-flex; align-items: center; justify-content: center;
}
.btn-save { background: linear-gradient(135deg, #3b82f6, #2563eb); color: #fff; }
.btn-save:disabled { opacity: 0.7; cursor: not-allowed; }
.btn-clear { background: #fee2e2; color: #dc2626; }
.btn-clear-gray { background: #6b7280; color: #fff; }
.btn-cancel { background: #e5e7eb; color: #374151; }

/* 保存进度转圈（对标旧版 setBtnLoading 的「处理中...」文字提示，叠加视觉 spinner） */
.btn-spinner {
  display: inline-block;
  width: 14px; height: 14px;
  border: 2px solid rgba(255, 255, 255, 0.45);
  border-top-color: #fff;
  border-radius: 50%;
  margin-right: 6px;
  animation: btn-spin 0.7s linear infinite;
}
@keyframes btn-spin { to { transform: rotate(360deg); } }
</style>
