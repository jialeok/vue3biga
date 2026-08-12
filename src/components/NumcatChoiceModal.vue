<template>
  <Teleport to="body">
    <transition name="numcat-fade">
      <div v-if="numcatChoice.visible" class="numcat-choice-mask" @click.self="cancel">
        <div class="numcat-choice-card" role="dialog" aria-modal="true">
          <div class="numcat-choice-icon">⚖️</div>
          <div class="numcat-choice-title">{{ numcatChoice.title }}</div>
          <div class="numcat-choice-desc">请选择本次数据的写入模式：</div>
          <div class="numcat-choice-actions">
            <button class="numcat-choice-btn overwrite" @click="resolve(true)">
              <span class="numcat-choice-btn-title">覆盖模式</span>
              <span class="numcat-choice-btn-sub">覆盖已有值</span>
            </button>
            <button class="numcat-choice-btn fill" @click="resolve(false)">
              <span class="numcat-choice-btn-title">补全模式</span>
              <span class="numcat-choice-btn-sub">仅填充空值</span>
            </button>
          </div>
          <button class="numcat-choice-cancel" @click="cancel">取消</button>
        </div>
      </div>
    </transition>
  </Teleport>
</template>

<script setup>
import { numcatChoice, resolveNumcatChoice } from '../logic/ui-bridge.js';

function resolve(overwrite) {
  resolveNumcatChoice(overwrite);
}
function cancel() {
  // 取消 = 不执行本次操作（区别于「补全模式」仍会执行）
  resolveNumcatChoice(null);
}
</script>

<style scoped>
.numcat-choice-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  /* 必须高于所有后台模态框（AuctionEditModal 9998 / DebugLogModal 99999 / LoginOverlay 99998），
     否则在编辑框内点接口按钮弹出的选择框会被压在编辑框后面 */
  z-index: 100000;
  padding: 20px;
}
.numcat-choice-card {
  width: 100%;
  max-width: 320px;
  background: #ffffff;
  border-radius: 16px;
  padding: 24px 20px 16px;
  box-shadow: 0 20px 50px rgba(15, 23, 42, 0.25);
  text-align: center;
}
.numcat-choice-icon {
  font-size: 34px;
  line-height: 1;
  margin-bottom: 10px;
}
.numcat-choice-title {
  font-size: 17px;
  font-weight: 700;
  color: #1f2937;
  margin-bottom: 6px;
}
.numcat-choice-desc {
  font-size: 13px;
  color: #6b7280;
  margin-bottom: 18px;
}
.numcat-choice-actions {
  display: flex;
  gap: 12px;
  margin-bottom: 12px;
}
.numcat-choice-btn {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 14px 8px;
  border: none;
  border-radius: 12px;
  cursor: pointer;
  color: #fff;
  transition: transform 0.12s ease, opacity 0.12s ease;
}
.numcat-choice-btn:active { transform: scale(0.97); }
.numcat-choice-btn:hover { opacity: 0.92; }
.numcat-choice-btn.overwrite {
  background: linear-gradient(135deg, #f59e0b, #d97706);
}
.numcat-choice-btn.fill {
  background: linear-gradient(135deg, #ec4899, #db2777);
}
.numcat-choice-btn-title {
  font-size: 15px;
  font-weight: 700;
}
.numcat-choice-btn-sub {
  font-size: 11px;
  opacity: 0.92;
}
.numcat-choice-cancel {
  width: 100%;
  padding: 9px 0;
  border: none;
  background: transparent;
  color: #9ca3af;
  font-size: 13px;
  cursor: pointer;
  border-radius: 8px;
}
.numcat-choice-cancel:hover { background: #f3f4f6; color: #6b7280; }

.numcat-fade-enter-active,
.numcat-fade-leave-active {
  transition: opacity 0.18s ease;
}
.numcat-fade-enter-from,
.numcat-fade-leave-to {
  opacity: 0;
}
.numcat-fade-enter-active .numcat-choice-card,
.numcat-fade-leave-active .numcat-choice-card {
  transition: transform 0.18s ease;
}
.numcat-fade-enter-from .numcat-choice-card,
.numcat-fade-leave-to .numcat-choice-card {
  transform: scale(0.92);
}
</style>
