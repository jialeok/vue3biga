<!--
  StatsBoard.vue 鈥?缁熻鐪嬫澘
  杩佺Щ鑷? boards-stats.js (3845琛? 61涓鍑哄嚱鏁?
  宸茶縼绉? getStats(import)銆乻aveData(import)銆丠eaderStats/EditModal缁勪欢銆乽seScoreCalculation composable(璇勫垎/杩炴定杩炶穼/鍛ㄦ湀缁熻)
  window.* 寮曠敤: 0 澶勶紙璇勫垎閫昏緫濮旀墭宸茬Щ鍏?composable锛?
-->
<template>
  <div class="stats-board">
    <HeaderStats :profit="profit" :gain="gain" :editable="true" @edit="openCircleEdit" />

    <div class="stats-stage-section">
      <span class="stage-label">琛屾儏闃舵</span>
      <span class="stage-value">{{ marketStage || '-' }}</span>
    </div>

    <div class="stats-consecutive-section">
      <div class="consecutive-item">
        <span class="consecutive-label">鏈€杩戝鏉?/span>
        <span class="consecutive-value">{{ consecutiveUp.duoban || 0 }}</span>
      </div>
      <div class="consecutive-item">
        <span class="consecutive-label">鏉垮潡ETF</span>
        <span class="consecutive-value">{{ consecutiveUp.bankuai || 0 }}</span>
      </div>
      <div class="consecutive-item">
        <span class="consecutive-label">棰樻潗鏂瑰悜</span>
        <span class="consecutive-value">{{ consecutiveUp.ticai || 0 }}</span>
      </div>
    </div>

    <div class="stats-score-section">
      <div class="score-item">
        <span class="score-label">鏈€杩戝鏉胯瘎鍒?/span>
        <span class="score-value" :style="{ color: scoreColor(recentMultiScore) }">{{ recentMultiScore }}</span>
      </div>
      <div class="score-item">
        <span class="score-label">鏉垮潡ETF璇勫垎</span>
        <span class="score-value" :style="{ color: scoreColor(sectorEtfScore) }">{{ sectorEtfScore }}</span>
      </div>
      <div class="score-item">
        <span class="score-label">棰樻潗鏂瑰悜璇勫垎</span>
        <span class="score-value" :style="{ color: scoreColor(topicDirectionScore) }">{{ topicDirectionScore }}</span>
      </div>
    </div>

    <div class="stats-period-section">
      <button class="period-btn" @click="showWeekly">鏈懆缁熻</button>
      <button class="period-btn" @click="showLastWeek">涓婂懆缁熻</button>
      <button class="period-btn" @click="showMonthly">鏈湀缁熻</button>
      <button class="period-btn" @click="openWeekendSummary">鍛ㄦ湯鎬荤粨</button>
      <button class="period-btn" @click="openWeekendReview">鍛ㄦ湯澶嶇洏</button>
      <button class="period-btn" @click="openMonthlySummary">鏈堝害鎬荤粨</button>
    </div>

    <EditModal v-model="circleModalActive" title="缂栬緫鍦嗗舰缁熻" :show-clear="true" @save="saveCircleStats" @clear="clearCircleStats">
      <div class="stats-form-row">
        <label>浠婃棩鐩堜簭</label>
        <input v-model.number="circleForm.profit" />
      </div>
      <div class="stats-form-row">
        <label>璐︽埛娑ㄥ箙(%)</label>
        <input v-model.number="circleForm.gain" />
      </div>
      <div class="stats-form-row">
        <label>璐︽埛浣欓</label>
        <input v-model.number="circleForm.balance" />
      </div>
      <div class="stats-form-row">
        <label>琛屾儏闃舵</label>
        <select v-model="circleForm.marketStage">
          <option value="">璇烽€夋嫨</option>
          <option v-for="s in stageOptions" :key="s" :value="s">{{ s }}</option>
        </select>
      </div>
      <div class="stats-form-row" v-for="t in checkboxTypes" :key="t.key">
        <label>{{ t.label }}</label>
        <span class="checkbox-option" :class="circleForm[t.key] ? 'checked' : 'unchecked'" @click="circleForm[t.key] = !circleForm[t.key]">{{ circleForm[t.key] ? '鉁? : '脳' }}</span>
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

const stageOptions = ['涓诲崌', '闇囪崱', '涓嬭穼', '鍙嶅脊', '绛戝簳'];
const checkboxTypes = [
  { key: 'recentMulti', label: '鏈€杩戝鏉? },
  { key: 'sectorEtf', label: '鏉垮潡ETF' },
  { key: 'topicDirection', label: '棰樻潗鏂瑰悜' }
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

<style>
.stats-board {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.stats-stage-section {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 13px;
}
.stage-label { color: #6b7280; }
.stage-value { font-weight: 600; color: #1f2937; }
.stats-consecutive-section {
  display: flex;
  gap: 16px;
}
.consecutive-item {
  display: flex;
  gap: 4px;
  align-items: center;
  font-size: 13px;
}
.consecutive-label { color: #6b7280; }
.consecutive-value { font-weight: 600; color: #dc2626; }
.stats-score-section {
  display: flex;
  gap: 16px;
}
.score-item {
  display: flex;
  gap: 4px;
  align-items: center;
  font-size: 13px;
}
.score-label { color: #6b7280; }
.score-value { font-weight: 600; }
.stats-period-section {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.period-btn {
  padding: 6px 12px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  background: #fff;
  font-size: 12px;
  cursor: pointer;
}
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
.stats-form-row input,
.stats-form-row select {
  flex: 1;
  padding: 6px 8px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 13px;
}
.checkbox-option {
  width: 24px;
  height: 24px;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.checkbox-option.checked { background: #dc2626; color: #fff; }
.checkbox-option.unchecked { background: #fff; color: #9ca3af; }
</style>
