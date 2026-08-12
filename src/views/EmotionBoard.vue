<template>
  <div id="emotionBoard" class="emotion-board">
    <div class="emotion-header" @click="toggleExpand">
      <span class="emotion-title">情绪看板</span>
      <span class="emotion-summary" id="emotionSummary">{{ summaryText }}</span>
      <span class="emotion-toggle-btn" id="emotionToggleBtn">{{ expanded ? '▲' : '▼' }}</span>
    </div>
      <div id="emotionContent" class="emotion-content" v-show="expanded">
      <div v-if="fallbackDate" class="emotion-fallback-hint">数据未更新至 {{ uiStore.currentDate }}，显示最近可用：{{ fallbackDate }}</div>
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
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
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
// 当展示的数据日期与当前选择日期不一致（回退到最近可用），给出提示
const fallbackDate = computed(() => {
  if (!data.value || !data.value.date) return null;
  const cd = uiStore.currentDate;
  return (data.value.date !== cd) ? data.value.date : null;
});

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
    // [FALLBACK] 当前日期暂无数据（如当日 worker 尚未产出），回退到最近一个有数据的日期，
    // 避免情绪看板在大清早/数据未就绪时整片空白（emotion_data 按天产出，当天行要等约北京时间16:00）
    const { data: latest, error: e2 } = await sb.from('emotion_data')
      .select('date, metrics, five_days, updated_at')
      .order('date', { ascending: false })
      .limit(1);
    if (e2) throw e2;
    if (latest && latest.length > 0) {
      const fb = latest[0];
      setEmotionDataCache({ date: date, data: fb });
      return fb;
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
// 切换日期时重新拉取（之前仅在 mounted/expand 时加载，日期选择器切换后不会刷新）
watch(() => uiStore.currentDate, () => {
  if (expanded.value) loadAndRender();
  else { setEmotionDataCache(null); }
});
onUnmounted(() => {
  if (realtimeChannel && getSupabase) {
    try { getSupabase().removeChannel(realtimeChannel); } catch (e) {}
  }
});

defineExpose({ loadAndRender, refreshPredictVol, toggleExpand, toggleRow, startRealtime });
</script>

