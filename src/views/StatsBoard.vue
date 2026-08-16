<!--
  StatsBoard.vue — 圆形统计看板（行情阶段+复选框+圆形卡片+评论区）
  结构对照原始 HTML index没拆分的整体UI设计.html 第5920-6008行
-->
<template>
  <div class="market-stage-container trading-day-element">
    <div class="market-stage-inner">
      <!-- 第一行：行情阶段选择框 + 仓位选择框 -->
      <div class="first-row-layout">
        <div
          class="layout-item"
          style="flex: 1;"
        >
          <div class="market-stage-selector">
            <select
              v-model="marketStage"
              class="market-stage-select"
            >
              <option value="">
                空仓行情
              </option>
              <option value="轮动行情">
                轮动行情
              </option>
              <option value="主线行情">
                主线行情
              </option>
              <option value="主跌行情">
                主跌行情
              </option>
              <option value="主升行情">
                主升行情
              </option>
              <option value="超跌反弹">
                超跌反弹
              </option>
              <option value="抢购高潮">
                抢购高潮
              </option>
            </select>
          </div>
        </div>
        <div
          class="layout-item"
          style="flex: 1;"
        >
          <div
            class="market-stage-selector"
            style="padding: 0 5px;"
          >
            <select
              v-model="position"
              class="market-stage-select"
              style="width: calc(100% + 5px);"
            >
              <option value="">
                请选择
              </option>
              <option value="全仓">
                全仓
              </option>
              <option value="二分之一仓">
                二分之一仓
              </option>
              <option value="三分之一仓">
                三分之一仓
              </option>
              <option value="三分之二仓">
                三分之二仓
              </option>
              <option value="空仓">
                空仓
              </option>
            </select>
          </div>
        </div>
      </div>

      <!-- 第二行：三个复选框 -->
      <!-- 第三行：三个圆形统计卡片 -->
      <div class="second-row-layout">
        <HeaderStats
          :profit="profit"
          :gain="gain"
          :balance="balance"
          @edit="openCircleEdit"
        />
      </div>
    </div>

    <!-- 评论区 -->
    <div
      class="comment-board"
      @dblclick="openCommentEdit"
    >
      <div class="comment-content">
        <div
          v-if="comment"
          style="white-space: pre-wrap;"
        >
          {{ comment }}
        </div>
        <div
          v-else
          class="comment-placeholder"
        >
          暂无评论，双击添加...
        </div>
      </div>
    </div>

    <!-- 编辑圆形统计弹窗 -->
    <EditModal
      v-model="circleModalActive"
      title="编辑圆形统计"
      :show-clear="true"
      @save="saveCircleStats"
      @clear="clearCircleStats"
    >
      <div class="stats-form-row">
        <label>今日盈亏</label>
        <input v-model.number="circleForm.profit">
      </div>
      <div class="stats-form-row">
        <label>账户涨幅(%)</label>
        <input v-model.number="circleForm.gain">
      </div>
      <div class="stats-form-row">
        <label>账户余额</label>
        <input v-model.number="circleForm.balance">
      </div>
    </EditModal>

    <!-- 编辑评论弹窗 -->
    <EditModal
      v-model="commentModalActive"
      title="编辑评论"
      @save="saveComment"
    >
      <textarea
        v-model="commentDraft"
        style="width:100%;min-height:120px;padding:8px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;resize:vertical;"
        placeholder="输入评论..."
      />
    </EditModal>
  </div>
</template>

<script setup>
import { ref, reactive, computed } from 'vue';
import HeaderStats from '../components/HeaderStats.vue';
import EditModal from '../components/EditModal.vue';
import { useUiStore } from '../stores/uiStore.js';
// [S-01] StatsBoard 经 Logic 层（src/logic/stats/）受控读写 jiwang.stats，不再直接原地改 allData.jiwang
import { writeStats } from '../logic/stats/stats-logic.js';
import { getJiwangData } from '../data/supabase-client.js';

const uiStore = useUiStore();

const circleModalActive = ref(false);
const commentModalActive = ref(false);
const commentDraft = ref('');

const circleForm = reactive({
  profit: '', gain: '', balance: ''
});

// §17/§18：直接派生自响应式 jiwang 数据源，任何对 jiwang[date].stats 的变更
// （本看板 writeStats 或云端 Realtime 拉取）都会立即重算并刷新 UI，无需手动 render/事件总线。
const statsOf = computed(() => {
  const jiwang = getJiwangData();
  const d = uiStore.currentDate;
  return (jiwang && d && jiwang[d] && jiwang[d].stats) ? jiwang[d].stats : {};
});

const profit = computed(() => statsOf.value.profit ?? '');
const gain = computed(() => statsOf.value.gain ?? '');
const balance = computed(() => statsOf.value.balance ?? '');
const comment = computed(() => statsOf.value.comment || '');

// 行情阶段 / 仓位为双向绑定控件：getter 派生自响应式源，setter 经 Logic 层写回（§2）。
const marketStage = computed({
  get: () => statsOf.value.marketStage || '',
  set: (v) => updateMarketStage(v)
});
const position = computed({
  get: () => statsOf.value.position || '',
  set: (v) => updatePosition(v)
});

async function updateMarketStage(value) {
  await writeStats(uiStore.currentDate, { marketStage: value }, '');
}

async function updatePosition(value) {
  await writeStats(uiStore.currentDate, { position: value }, '');
}

// [S-02] 旧的 toggleCheckbox 为死代码（无任何复选框调用，且其 saveData() 不持久化任何改动），
// 移除无效防抖/死写，避免误导。如需复选框，应经 writeStats(..., successMsg) 真正持久化。

function openCircleEdit() {
  const s = statsOf.value;
  circleForm.profit = s.profit ?? '';
  circleForm.gain = s.gain ?? '';
  circleForm.balance = s.balance ?? '';
  circleModalActive.value = true;
}

async function saveCircleStats() {
  await writeStats(uiStore.currentDate, {
    profit: circleForm.profit,
    gain: circleForm.gain,
    balance: circleForm.balance,
  }, '✅ 圆形统计已保存并同步到云端');
  circleModalActive.value = false;
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

async function saveComment() {
  await writeStats(uiStore.currentDate, { comment: commentDraft.value }, '✅ 评论已保存并同步到云端');
  commentModalActive.value = false;
}
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
