<!--
  StatsBoard.vue — 圆形统计看板（行情阶段+复选框+圆形卡片+评论区）
  结构对照原始 HTML index没拆分的整体UI设计.html 第5920-6008行
-->
<template>
  <div class="market-stage-container trading-day-element">
    <div class="market-stage-inner">
      <!-- 第一行：行情阶段选择框 + 仓位选择框 -->
      <div class="first-row-layout">
        <div class="layout-item" style="flex: 1;">
          <div class="market-stage-selector">
            <select class="market-stage-select" v-model="marketStage" @change="updateMarketStage">
              <option value="">空仓行情</option>
              <option value="轮动行情">轮动行情</option>
              <option value="主线行情">主线行情</option>
              <option value="主跌行情">主跌行情</option>
              <option value="主升行情">主升行情</option>
              <option value="超跌反弹">超跌反弹</option>
              <option value="抢购高潮">抢购高潮</option>
            </select>
          </div>
        </div>
        <div class="layout-item" style="flex: 1;">
          <div class="market-stage-selector" style="padding: 0 5px;">
            <select class="market-stage-select" v-model="position" @change="updatePosition" style="width: calc(100% + 5px);">
              <option value="">请选择</option>
              <option value="全仓">全仓</option>
              <option value="二分之一仓">二分之一仓</option>
              <option value="三分之一仓">三分之一仓</option>
              <option value="三分之二仓">三分之二仓</option>
              <option value="空仓">空仓</option>
            </select>
          </div>
        </div>
      </div>

      <!-- 第二行：三个复选框 -->
      <!-- 第三行：三个圆形统计卡片 -->
      <div class="second-row-layout">
        <HeaderStats :profit="profit" :gain="gain" :balance="balance" @edit="openCircleEdit" />
      </div>
    </div>

    <!-- 评论区 -->
    <div class="comment-board" @dblclick="openCommentEdit">
      <div class="comment-content">
        <div v-if="comment" style="white-space: pre-wrap;">{{ comment }}</div>
        <div v-else class="comment-placeholder">暂无评论，双击添加...</div>
      </div>
    </div>

    <!-- 编辑圆形统计弹窗 -->
    <EditModal v-model="circleModalActive" title="编辑圆形统计" :show-clear="true" @save="saveCircleStats" @clear="clearCircleStats">
      <div class="stats-form-row">
        <label>今日盈亏</label>
        <input v-model.number="circleForm.profit" />
      </div>
      <div class="stats-form-row">
        <label>账户涨幅(%)</label>
        <input v-model.number="circleForm.gain" />
      </div>
      <div class="stats-form-row">
        <label>账户余额</label>
        <input v-model.number="circleForm.balance" />
      </div>
    </EditModal>

    <!-- 编辑评论弹窗 -->
    <EditModal v-model="commentModalActive" title="编辑评论" @save="saveComment">
      <textarea v-model="commentDraft" style="width:100%;min-height:120px;padding:8px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;resize:vertical;" placeholder="输入评论..."></textarea>
    </EditModal>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted, onUnmounted, watch } from 'vue';
import HeaderStats from '../components/HeaderStats.vue';
import EditModal from '../components/EditModal.vue';
import { useUiStore } from '../stores/uiStore.js';
import { getJiwangData } from '../data/supabase-client.js';
import { saveData } from '../logic/app-core.js';
import { _on, _off } from '../stores/eventBus.js';

const uiStore = useUiStore();

const profit = ref('');
const gain = ref('');
const balance = ref('');
const marketStage = ref('');
const position = ref('');
const comment = ref('');

const circleModalActive = ref(false);
const commentModalActive = ref(false);
const commentDraft = ref('');

const circleForm = reactive({
  profit: '', gain: '', balance: ''
});

function getStats() {
  const jiwangData = getJiwangData();
  if (!jiwangData[uiStore.currentDate]) {
    jiwangData[uiStore.currentDate] = {};
  }
  if (!jiwangData[uiStore.currentDate].stats) {
    jiwangData[uiStore.currentDate].stats = {};
  }
  return jiwangData[uiStore.currentDate].stats;
}

function render() {
  const s = getStats();
  profit.value = s.profit ?? '';
  gain.value = s.gain ?? '';
  balance.value = s.balance ?? '';
  marketStage.value = s.marketStage || '';
  position.value = s.position || '';
  comment.value = s.comment || '';
}

function updateMarketStage() {
  const s = getStats();
  s.marketStage = marketStage.value;
  saveData();
}

function updatePosition() {
  const s = getStats();
  s.position = position.value;
  saveData();
}

function toggleCheckbox(key) {
  // 保留接口供扩展使用
  saveData();
}

function openCircleEdit() {
  const s = getStats();
  circleForm.profit = s.profit ?? '';
  circleForm.gain = s.gain ?? '';
  circleForm.balance = s.balance ?? '';
  circleModalActive.value = true;
}

function saveCircleStats() {
  const s = getStats();
  s.profit = circleForm.profit;
  s.gain = circleForm.gain;
  s.balance = circleForm.balance;
  saveData();
  circleModalActive.value = false;
  render();
}

function clearCircleStats() {
  circleForm.profit = '';
  circleForm.gain = '';
  circleForm.balance = '';
}

function openCommentEdit() {
  commentDraft.value = comment.value;
  commentModalActive.value = true;
}

function saveComment() {
  const s = getStats();
  s.comment = commentDraft.value;
  saveData();
  comment.value = commentDraft.value;
  commentModalActive.value = false;
}

// 1) 挂载时先渲染一次（此时云端可能尚未拉回，渲染后会由下方 jiwang-refresh 再次刷新）
// 2) 监听 currentDate 切换（DashboardView 内 StatsBoard 常驻挂载，切日期不会重新挂载，必须主动监听）
// 3) 监听云端拉取 / Realtime 完成后的 jiwang-refresh 事件重新渲染
onMounted(() => { render(); });
_on('jiwang-refresh', render);
watch(() => uiStore.currentDate, () => render());
onUnmounted(() => { _off('jiwang-refresh', render); });

defineExpose({ render });
</script>

<style>
.stats-form-row {
  display: flex;
  align-items: center;
  margin-bottom: 10px;
  gap: 8px;
}
.stats-form-row label {
  width: 100px;
  color: #6b7280;
  font-size: 13px;
}
.stats-form-row input {
  flex: 1;
  padding: 6px 8px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 13px;
}
</style>
