<template>
  <Teleport to="body">
    <div v-if="modelValue" class="edit-modal-backdrop" @click.self="$emit('update:modelValue', false)">
      <div class="edit-modal-panel">
        <div class="edit-modal-header">{{ title }}</div>
        <div class="edit-modal-body">
          <slot />
        </div>
        <div v-if="showActions" class="edit-modal-actions">
          <button class="btn-save" @click="$emit('save')">{{ saveText }}</button>
          <button v-if="showClear" class="btn-clear" @click="$emit('clear')">{{ clearText }}</button>
          <button class="btn-cancel" @click="$emit('update:modelValue', false)">{{ cancelText }}</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
defineProps({
  modelValue: { type: Boolean, default: false },
  title: { type: String, default: '编辑' },
  showActions: { type: Boolean, default: true },
  showClear: { type: Boolean, default: false },
  saveText: { type: String, default: '保存' },
  clearText: { type: String, default: '清空' },
  cancelText: { type: String, default: '取消' }
});

defineEmits(['update:modelValue', 'save', 'clear']);
</script>

<style scoped>
.edit-modal-backdrop {
  position: fixed; inset: 0; background: rgba(0, 0, 0, 0.5);
  z-index: 9999; display: flex; align-items: center; justify-content: center;
}
.edit-modal-panel {
  background: #fff; border-radius: 12px; padding: 20px;
  min-width: 400px; max-height: 90vh; overflow: auto;
}
.edit-modal-header { font-size: 16px; font-weight: 600; margin-bottom: 16px; }
.edit-modal-body { margin-bottom: 16px; }
.edit-modal-actions { display: flex; gap: 8px; }
.edit-modal-actions button {
  flex: 1; padding: 8px 16px; border: none; border-radius: 6px;
  cursor: pointer; font-size: 13px;
}
.btn-save { background: #2563eb; color: #fff; }
.btn-clear { background: #fee2e2; color: #dc2626; }
.btn-cancel { background: #e5e7eb; color: #374151; }
</style>