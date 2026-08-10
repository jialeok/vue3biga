<template>
  <div id="emotionBoard" class="emotion-board">
    <div class="emotion-header" @click="toggleExpand">
      <span class="emotion-title">情绪看板</span>
      <span class="emotion-summary" id="emotionSummary">{{ summaryText }}</span>
      <span class="emotion-toggle" id="emotionToggleBtn">{{ expanded ? '▲' : '▼' }}</span>
    </div>
    <div id="emotionContent" class="emotion-content" v-show="expanded">
      <div id="emotionVolumeLine" class="emotion-volume-line">
        <template v-for="(part, idx) in volumeParts" :key="idx">
          <span>
            {{ part.label }}
            <span class="emv-val" :style="part.valueStyle">{{ part.valueText }}</span>
            <span v-if="part.hasRefresh" class="emotion-refresh-btn" title="刷新预测量能" @click.stop="refreshPredictVol">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6M1 20v-6h6M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"/></svg>
            </span>
          </span>
          <span v-if="idx < volumeParts.length - 1" class="emotion-sep">/</span>
        </template>
        <span v-if="volumeParts.length === 0">量能数据未抓取</span>
      </div>
      <div id="emotionList" class="emotion-list">
        <div v-for="cfg in rowConfigs" :key="cfg.key" class="emotion-row">
          <div class="emotion-row-header" @click="toggleRow(cfg.key)">
            <div class="emotion-row-title">{{ cfg.title }}</div>
            <div class="emotion-row-value" :class="rowValueClass(cfg)">
              <span>{{ rowValueText(cfg) }}</span>
              <span v-if="!rowIsMissing(cfg)" class="unit">{{ cfg.unit }}</span>
              <span v-if="rowExtraValue(cfg) !== null" class="row-extra" style="color:#6b7280;font-weight:500;font-size:12px;margin-left:4px;">/ {{ rowExtraValue(cfg).toFixed(1) }}%</span>
            </div>
          </div>
          <div class="emotion-trend-panel" :class="{ show: expandedRows.has(cfg.key) }">
            <template v-if="cfg.hasTrend">
              <div class="emotion-trend-title">{{ cfg.title }} 近5日</div>
              <div v-if="!trendPoints(cfg).length" style="font-size:11px;color:#94a3b8;padding:6px;">暂无趋势数据</div>
              <TrendChart v-else :points="trendPoints(cfg)" color="#f59e0b" :percent="false" />
            </template>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import TrendChart from '../components/TrendChart.vue';
import { useUiStore } from '../stores/uiStore.js';
import { getSupabase } from '../data/supabase-client.js';
import { EMOTION_ROW_CONFIG, EMOTION_WORKER_BASE, getEmotionDataCache, setEmotionDataCache } from '../data/emotion-config.js';

const uiStore = useUiStore();

const expanded = ref(true);
const data = ref(null);
const expandedRows = ref(new Set());
const refreshing = ref(false);
let realtimeChannel = null;

const rowConfigs = computed(() => EMOTION_ROW_CONFIG);
const metrics = computed(() => (data.value && data.value.metrics) || {});
const fiveDays = computed(() => (data.value && data.value.five_days) || []);

const summaryText = computed(() => {
  const m = metrics.value;
  const parts = [];
  if (m.limitUp !== null && !isNaN(m.limitUp)) parts.push('涨停 ' + Math.round(m.limitUp));
  if (m.limitDown !== null && !isNaN(m.limitDown)) parts.push('跌停 ' + Math.round(m.limitDown));
  if (m.highestLb !== null && !isNaN(m.highestLb)) parts.push('最高 ' + Math.round(m.highestLb) + '板');
  return parts.length > 0 ? parts.join(' / ') : '暂无数据';
});

function yuanToYi(v) {
  if (v === null || v === undefined || isNaN(v)) return null;
  return Number((Number(v) / 1e8).toFixed(2));
}
function formatEmotionNumber(v, decimals) {
  if (v === null || v === undefined || isNaN(v)) return '-';
  if (decimals === undefined) return String(Math.round(Number(v)));
  return Number(v).toFixed(decimals);
}

const volumeParts = computed(() => {
  const m = metrics.value;
  const predictVol = m.predictVol;
  const predictFallback = m.predictVolFallback === true;
  const yesterdayAmount = m.amount;
  const predictYi = predictVol !== null && predictVol !== undefined ? yuanToYi(predictVol) : null;
  const yestYi = yesterdayAmount !== null && yesterdayAmount !== undefined ? yuanToYi(yesterdayAmount) : null;
  const parts = [];
  if (predictYi !== null) {
    parts.push({
      label: predictFallback ? '预测(昨)' : '预测',
      valueText: predictYi + '亿',
      valueStyle: '',
      hasRefresh: true
    });
  } else {
    parts.push({
      label: '预测',
      valueText: '待更新',
      valueStyle: 'color:#9ca3af;',
      hasRefresh: true
    });
  }
  if (yestYi !== null) {
    parts.push({
      label: '昨日',
      valueText: yestYi + '亿',
      valueStyle: '',
      hasRefresh: false
    });
  }
  return parts;
});

function rowIsMissing(cfg) {
  let val = metrics.value[cfg.key];
  if (cfg.key === 'amountDiff') val = metrics.value.amountDiff;
  return val === null || val === undefined || isNaN(val);
}
function rowValueText(cfg) {
  let val = metrics.value[cfg.key];
  if (cfg.key === 'amountDiff') val = metrics.value.amountDiff;
  return formatEmotionNumber(val, cfg.key === 'amountDiff' ? 2 : 0);
}
function rowValueClass(cfg) {
  if (rowIsMissing(cfg)) return '';
  let val = metrics.value[cfg.key];
  if (cfg.key === 'amountDiff') val = metrics.value.amountDiff;
  const n = Number(val);
  if (cfg.key === 'amountDiff') {
    return n > 0 ? 'up' : (n < 0 ? 'down' : '');
  }
  return '';
}
function rowExtraValue(cfg) {
  if (!cfg.extraKey) return null;
  const v = metrics.value[cfg.extraKey];
  if (v === null || v === undefined || isNaN(v)) return null;
  return Number(v);
}
function trendPoints(cfg) {
  const fd = fiveDays.value;
  if (!Array.isArray(fd) || fd.length === 0) return [];
  return fd.map((d) => {
    let v = d[cfg.field];
    if ((cfg.field === 'amount' || cfg.field === 'amountDiff') && v !== null && v !== undefined) v = yuanToYi(v);
    return { date: d._date || '', value: (v === null || v === undefined || isNaN(v)) ? null : Number(v) };
  });
}

function toggleExpand(e) {
  if (e) e.stopPropagation();
  expanded.value = !expanded.value;
  if (expanded.value) loadAndRender();
}
function toggleRow(key) {
  const set = expandedRows.value;
  if (set.has(key)) set.delete(key); else set.add(key);
  expandedRows.value = new Set(set);
}

async function loadEmotionData(date) {
  date = date || uiStore.currentDate;
  const cache = getEmotionDataCache();
  if (cache && cache.date === date) return cache.data;
  try {
    const sb = getSupabase();
    const { data: rows, error } = await sb.from('emotion_data')
      .select('date, metrics, five_days, updated_at')
      .eq('date', date)
      .limit(1);
    if (error) throw error;
    if (rows && rows.length > 0) {
      setEmotionDataCache({ date: date, data: rows[0] });
      return rows[0];
    }
  } catch (e) {
    console.warn('读取 emotion_data 失败:', e.message);
  }
  setEmotionDataCache({ date: date, data: null });
  return null;
}

async function loadAndRender() {
  const d = await loadEmotionData(uiStore.currentDate);
  data.value = d;
}

async function refreshPredictVol(e) {
  if (e) e.stopPropagation();
  if (!uiStore.currentDate) return;
  refreshing.value = true;
  try {
    const url = EMOTION_WORKER_BASE.replace(/\/$/, '') + '/refresh-emotion';
    const resp = await fetch(url, { method: 'POST' });
    const result = await resp.json();
    if (!result.ok) throw new Error(result.error || '刷新失败');
    const cache = getEmotionDataCache();
    if (cache && cache.date === uiStore.currentDate && cache.data) {
      cache.data.metrics = cache.data.metrics || {};
      cache.data.metrics.predictVol = result.predictVol;
      cache.data.metrics.predictVolFallback = false;
      cache.data.updated_at = new Date().toISOString();
      data.value = { ...cache.data };
    }
  } catch (e) {
    console.error('[EMOTION-REFRESH] 刷新预测量能失败:', e.message);
    alert('刷新预测量能失败：' + e.message);
  } finally {
    refreshing.value = false;
  }
}

function startRealtime() {
  if (realtimeChannel) return;
  try {
    const sb = getSupabase();
    realtimeChannel = sb
      .channel('emotion_data_changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'emotion_data' }, (payload) => {
        const changedDate = payload.new && payload.new.date;
        if (changedDate === uiStore.currentDate) {
          setEmotionDataCache(null);
          loadAndRender();
        }
      })
      .subscribe((status) => {
      });
  } catch (e) {
    console.warn('emotion_data Realtime 订阅失败:', e.message);
  }
}

onMounted(() => {
  loadAndRender();
  startRealtime();
});
onUnmounted(() => {
  if (realtimeChannel && getSupabase) {
    try { getSupabase().removeChannel(realtimeChannel); } catch (e) {}
  }
});

defineExpose({ loadAndRender, refreshPredictVol, toggleExpand, toggleRow, startRealtime });
</script>

<style scoped>
.emotion-board {
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  margin: 8px 0;
  background: #fff;
}
.emotion-header {
  display: flex;
  align-items: center;
  padding: 10px 14px;
  cursor: pointer;
  user-select: none;
}
.emotion-title {
  font-weight: 600;
  color: #1f2937;
  margin-right: 12px;
}
.emotion-summary {
  flex: 1;
  color: #6b7280;
  font-size: 13px;
}
.emotion-toggle {
  color: #9ca3af;
  font-size: 12px;
}
.emotion-content {
  padding: 8px 14px;
  border-top: 1px solid #f3f4f6;
}
.emotion-volume-line {
  font-size: 13px;
  color: #374151;
  padding: 6px 0;
  margin-bottom: 6px;
}
.emotion-volume-line :deep(.emv-val) {
  font-weight: 600;
}
.emotion-volume-line :deep(.emotion-refresh-btn) {
  cursor: pointer;
  color: #6b7280;
  margin-left: 4px;
  display: inline-flex;
  vertical-align: middle;
}
.emotion-sep {
  color: #d1d5db;
  margin: 0 6px;
}
.emotion-list {
  display: flex;
  flex-direction: column;
}
.emotion-row {
  border-bottom: 1px solid #f3f4f6;
}
.emotion-row-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 4px;
  cursor: pointer;
}
.emotion-row-title {
  color: #374151;
  font-size: 13px;
}
.emotion-row-value {
  font-size: 13px;
  font-weight: 600;
  color: #1f2937;
}
.emotion-row-value.up {
  color: #dc2626;
}
.emotion-row-value.down {
  color: #059669;
}
.emotion-row-value .unit {
  font-weight: 400;
  color: #9ca3af;
  margin-left: 2px;
  font-size: 11px;
}
.emotion-trend-panel {
  max-height: 0;
  overflow: hidden;
  transition: max-height 0.2s ease;
}
.emotion-trend-panel.show {
  max-height: 200px;
  padding: 6px 4px;
}
.emotion-trend-title {
  font-size: 11px;
  color: #6b7280;
  margin-bottom: 4px;
}
</style>