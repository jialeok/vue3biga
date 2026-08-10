<!--
  StatsBoard.vue — 统计看板
  迁移自: boards-stats.js (3845行, 61个导出函数)
  已迁移: getStats(import)、saveData(import)、HeaderStats/EditModal组件、useScoreCalculation composable(评分/连涨连跌/周月统计)
  window.* 引用: 0 处（评分逻辑委托已移入 composable）
-->
<template>
  <div class="stats-board">
    <HeaderStats :profit="profit" :gain="gain" :editable="true" @edit="openCircleEdit" />

    <div class="stats-stage-section">
      <span class="stage-label">行情阶段</span>
      <span class="stage-value">{{ marketStage || '-' }}</span>
    </div>

    <div class="stats-consecutive-section">
      <div class="consecutive-item">
        <span class="consecutive-label">最近多板</span>
        <span class="consecutive-value">{{ consecutiveUp.duoban || 0 }}</span>
      </div>
      <div class="consecutive-item">
        <span class="consecutive-label">板块ETF</span>
        <span class="consecutive-value">{{ consecutiveUp.bankuai || 0 }}</span>
      </div>
      <div class="consecutive-item">
        <span class="consecutive-label">题材方向</span>
        <span class="consecutive-value">{{ consecutiveUp.ticai || 0 }}</span>
      </div>
    </div>

    <div class="stats-score-section">
      <div class="score-item">
        <span class="score-label">最近多板评分</span>
        <span class="score-value" :style="{ color: scoreColor(recentMultiScore) }">{{ recentMultiScore }}</span>
      </div>
      <div class="score-item">
        <span class="score-label">板块ETF评分</span>
        <span class="score-value" :style="{ color: scoreColor(sectorEtfScore) }">{{ sectorEtfScore }}</span>
      </div>
      <div class="score-item">
        <span class="score-label">题材方向评分</span>
        <span class="score-value" :style="{ color: scoreColor(topicDirectionScore) }">{{ topicDirectionScore }}</span>
      </div>
    </div>

    <div class="stats-period-section">
      <button class="period-btn" @click="showWeekly">本周统计</button>
      <button class="period-btn" @click="showLastWeek">上周统计</button>
      <button class="period-btn" @click="showMonthly">本月统计</button>
      <button class="period-btn" @click="openWeekendSummary">周末总结</button>
      <button class="period-btn" @click="openWeekendReview">周末复盘</button>
      <button class="period-btn" @click="openMonthlySummary">月度总结</button>
    </div>

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
      <div class="stats-form-row">
        <label>行情阶段</label>
        <select v-model="circleForm.marketStage">
          <option value="">请选择</option>
          <option v-for="s in stageOptions" :key="s" :value="s">{{ s }}</option>
        </select>
      </div>
      <div class="stats-form-row" v-for="t in checkboxTypes" :key="t.key">
        <label>{{ t.label }}</label>
        <span class="checkbox-option" :class="circleForm[t.key] ? 'checked' : 'unchecked'" @click="circleForm[t.key] = !circleForm[t.key]">{{ circleForm[t.key] ? '✓' : '×' }}</span>
      </div>
    </EditModal>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue';
import HeaderStats from '../components/HeaderStats.vue';
import EditModal from '../components/EditModal.vue';
import { useUiStore } from '../stores/uiStore.js';
import { getJiwangData } from '../data/supabase-client.js';
import { saveData } from '../logic/app-core.js';
import { useScoreCalculation } from '../composables/useScoreCalculation.js';

const uiStore = useUiStore();
const {
  recentMultiScore, sectorEtfScore, topicDirectionScore, consecutiveUp,
  calculateAll, renderConsecutiveUp,
  showWeekly, showLastWeek, showMonthly,
  openWeekendSummary, openWeekendReview, openMonthlySummary
} = useScoreCalculation();

const profit = ref('');
const gain = ref('');
const marketStage = ref('');

const circleModalActive = ref(false);

const stageOptions = ['主升', '震荡', '下跌', '反弹', '筑底'];
const checkboxTypes = [
  { key: 'recentMulti', label: '最近多板' },
  { key: 'sectorEtf', label: '板块ETF' },
  { key: 'topicDirection', label: '题材方向' }
];

const circleForm = reactive({
  profit: '', gain: '', balance: '', marketStage: '',
  recentMulti: false, sectorEtf: false, topicDirection: false
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

function scoreColor(s) { return s >= 5 ? '#ef4444' : '#10b981'; }

function render() {
  const s = getStats();
  profit.value = s.profit;
  gain.value = s.gain;
  marketStage.value = s.marketStage || '';
  renderConsecutiveUp();
  calculateAll();
}

function openCircleEdit() {
  const s = getStats();
  circleForm.profit = s.profit !== undefined ? s.profit : '';
  circleForm.gain = s.gain !== undefined ? s.gain : '';
  circleForm.balance = s.balance || '';
  circleForm.marketStage = s.marketStage || '';
  circleForm.recentMulti = s.recentMulti || false;
  circleForm.sectorEtf = s.sectorEtf || false;
  circleForm.topicDirection = s.topicDirection || false;
  circleModalActive.value = true;
}
function closeCircleModal() { circleModalActive.value = false; }

function saveCircleStats() {
  const s = getStats();
  s.profit = circleForm.profit;
  s.gain = circleForm.gain;
  s.balance = circleForm.balance;
  s.marketStage = circleForm.marketStage;
  s.recentMulti = circleForm.recentMulti;
  s.sectorEtf = circleForm.sectorEtf;
  s.topicDirection = circleForm.topicDirection;
  saveData();
  closeCircleModal();
  render();
}

function clearCircleStats() {
  circleForm.profit = '';
  circleForm.gain = '';
  circleForm.balance = '';
  circleForm.marketStage = '';
}


onMounted(render);

defineExpose({ render, openCircleEdit, closeCircleModal, saveCircleStats, clearCircleStats });
</script>

