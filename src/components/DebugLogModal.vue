<template>
  <Teleport to="body">
    <div v-if="visible" class="debug-log-overlay" @click.self="close">
      <div class="debug-log-panel">
        <div class="debug-log-header">
          <span class="debug-log-title">同步调试日志</span>
          <div class="debug-log-actions">
            <button class="debug-log-btn btn-copy" @click="copy">复制</button>
            <button class="debug-log-btn btn-clear" @click="clear">清空</button>
            <button class="debug-log-btn btn-close" @click="close">关闭</button>
          </div>
        </div>
        <pre class="debug-log-content">{{ displayLines }}</pre>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, computed, watch } from 'vue';
import { getDbgLogBuffer, clearDbgLogBuffer } from '../data/debug-log.js';
import { showToast } from '../composables/useToast.js';

const visible = ref(false);

const buffer = computed(() => getDbgLogBuffer());
const displayLines = computed(() => buffer.value.length ? buffer.value.join('\n') : '（暂无调试日志）');

function open() { visible.value = true; }
function close() { visible.value = false; }

function copy() {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(displayLines.value).then(() => {
      showToast('✅ 已复制调试日志');
    }).catch(() => {});
  }
}

function clear() {
  clearDbgLogBuffer();
  visible.value = false;
  showToast('已清空调试日志');
}

defineExpose({ open, close });
</script>

<style scoped>
.debug-log-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.75);
  z-index: 99999;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}
.debug-log-panel {
  background: #111827;
  color: #d1fae5;
  border-radius: 12px;
  max-width: 100%;
  width: 100%;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  font-family: monospace;
}
.debug-log-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid #374151;
}
.debug-log-title {
  color: #fff;
  font-weight: 600;
}
.debug-log-actions {
  display: flex;
  gap: 8px;
}
.debug-log-btn {
  color: #fff;
  border: none;
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 12px;
  cursor: pointer;
}
.btn-copy { background: #059669; }
.btn-clear { background: #b91c1c; }
.btn-close { background: #374151; }
.debug-log-content {
  margin: 0;
  padding: 12px 16px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
  font-size: 11px;
  line-height: 1.5;
}
</style>