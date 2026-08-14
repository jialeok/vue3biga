<template>
  <div id="emotionBoard" class="emotion-board">
    <div class="emotion-header" @click="toggleExpand">
      <span class="emotion-title">情绪看板</span>
      <span class="emotion-summary" id="emotionSummary">{{ summaryText }}</span>
      <span class="emotion-toggle-btn" id="emotionToggleBtn">{{ expanded ? '▲' : '▼' }}</span>
    </div>
      <div id="emotionContent" class="emotion-content" v-show="expanded">
      <div v-if="fallbackDate" class="emotion-fallback-hint">数据未更新至 {{ uiStore.currentDate }}，显示最近可用：{{ fallbackDate }}</div>
      <div v-if="error" class="emotion-error-hint">加载失败：{{ error }}（请重试）</div>
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
import { EMOTION_ROW_CONFIG, EMOTION_WORKER_BASE, getEmotionDataCache } from '../data/emotion-config.js';
import {
  loadEmotionSafe,
  subscribeEmotion,
  unsubscribeEmotion,
  yuanToYi,
  formatEmotionNumber,
  emotionRowIsMissing,
  emotionRowValueText,
  emotionRowValueClass,
  emotionRowExtraValue,
  emotionTrendPoints,
} from '../logic/emotion/emotion-workflow.js';
import { showToast } from '../composables/useToast.js';

const uiStore = useUiStore();

const expanded = ref(true);
const data = ref(null);
const error = ref(null);
const expandedRows = ref(new Set());
const refreshing = ref(false);

const rowConfigs = computed(() => EMOTION_ROW_CONFIG);
const metrics = computed(() => (data.value && data.value.metrics) || {});
const fiveDays = computed(() => (data.value && data.value.five_days) || []);
// 真实「今天」（北京时间）。仅当查询日期等于今天时才允许回退到最近可用数据；
// 历史日期 / 未来日期一律不回退，避免未来每一天都挂着陈旧数据。
const realToday = computed(() => {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
});
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

// 亿元换算 / 数值格式化由 emotion-workflow.js 提供（E-03 业务规则下沉 Logic），此处复用导入。

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

// 以下为模板薄包装：真正业务规则已下沉到 emotion-workflow.js（E-03）。
function rowIsMissing(cfg) {
  return emotionRowIsMissing(metrics.value, cfg);
}
function rowValueText(cfg) {
  return emotionRowValueText(metrics.value, cfg);
}
function rowValueClass(cfg) {
  return emotionRowValueClass(metrics.value, cfg);
}
function rowExtraValue(cfg) {
  return emotionRowExtraValue(metrics.value, cfg);
}
function trendPoints(cfg) {
  return emotionTrendPoints(fiveDays.value, cfg);
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

async function loadAndRender() {
  const date = uiStore.currentDate;
  // §10/§11 / E-02：读取失败由 loadEmotionSafe 返回 {ok:false}，此处置错误态 + toast，
  // 绝不把失败的结果写进缓存伪装成 null；只有「成功但查无此日」才会得到 data:null。
  const res = await loadEmotionSafe(date, { allowFallback: date === realToday.value });
  if (res.ok) {
    error.value = null;
    data.value = res.data;
  } else {
    data.value = null;
    error.value = (res.error && res.error.message) ? res.error.message : '未知错误';
    showToast('加载失败，请重试');
  }
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
    showToast('刷新预测量能失败：' + e.message); // E-04：alert 阻塞弹窗改 toast
  } finally {
    refreshing.value = false;
  }
}

function onRealtimeChange(changedDate) {
  // §10/§11：Realtime 变更只触发刷新，不顺手把缓存写成 null（那是失败伪装空数据的旧坑）
  if (changedDate === uiStore.currentDate) loadAndRender();
}

onMounted(() => {
  loadAndRender();
  subscribeEmotion(onRealtimeChange); // E-05：模块级统一订阅，离开页面 unsubscribe
});
// 切换日期时重新拉取（之前仅在 mounted/expand 时加载，日期选择器切换后不会刷新）
watch(() => uiStore.currentDate, () => {
  if (expanded.value) loadAndRender();
});
onUnmounted(() => {
  unsubscribeEmotion(); // E-05：离开页面退订，避免重复订阅
});

defineExpose({ loadAndRender, refreshPredictVol, toggleExpand, toggleRow });
</script>

