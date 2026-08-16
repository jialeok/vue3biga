<template>
  <div class="weekend-stats-board">
    <div class="weekend-header">
      <div class="weekend-title">
        📊 本周交易统计
      </div>
      <div class="weekend-subtitle">
        {{ dateRange }}
      </div>
    </div>
    <div class="weekend-content">
      <!-- 周六内容：周统计 -->
      <div
        v-show="isSaturday"
        class="saturday-content"
      >
        <!-- 1. 盈亏统计 -->
        <div class="weekend-section">
          <div class="weekend-section-title">
            💰 本周盈亏
          </div>
          <div class="weekend-profit-section">
            <div class="weekend-profit-item profit">
              <div class="weekend-profit-label">
                赚
              </div>
              <div class="weekend-profit-value">
                {{ stats.totalProfit.toFixed(0) }}
              </div>
            </div>
            <div class="weekend-profit-item loss">
              <div class="weekend-profit-label">
                亏
              </div>
              <div class="weekend-profit-value">
                {{ stats.totalLoss.toFixed(0) }}
              </div>
            </div>
            <div class="weekend-profit-item balance">
              <div class="weekend-profit-label">
                余额
              </div>
              <div class="weekend-profit-value">
                {{ stats.balance.toFixed(0) }}
              </div>
            </div>
          </div>
        </div>

        <!-- 2. 出手情况统计 -->
        <div class="weekend-section">
          <div
            class="weekend-section-title"
            style="display: flex; align-items: center;"
          >
            <span>🎯 出手情况统计</span>
            <span style="font-size: 13px; color: #64748b; font-weight: normal; margin-left: auto; margin-right: 50px;">成交天数 <span style="color: #dc2626; font-weight: 700;">{{ stats.tradingDays }}</span></span>
          </div>
          <div class="weekend-stat-grid">
            <div class="weekend-stat-item">
              <div class="weekend-stat-label">
                空仓次数
              </div><div class="weekend-stat-value">
                {{ stats.emptyCount }}
              </div>
            </div>
            <div class="weekend-stat-item">
              <div class="weekend-stat-label">
                出手次数
              </div><div class="weekend-stat-value">
                {{ stats.chushouCount }}
              </div>
            </div>
            <div class="weekend-stat-item">
              <div class="weekend-stat-label">
                空仓对了
              </div><div class="weekend-stat-value">
                {{ stats.emptyRight }}
              </div>
            </div>
            <div class="weekend-stat-item">
              <div class="weekend-stat-label">
                空仓错了
              </div><div class="weekend-stat-value">
                {{ stats.emptyWrong }}
              </div>
            </div>
            <div class="weekend-stat-item">
              <div class="weekend-stat-label">
                出手对了
              </div><div class="weekend-stat-value">
                {{ stats.chushouRight }}
              </div>
            </div>
            <div class="weekend-stat-item">
              <div class="weekend-stat-label">
                出手错了
              </div><div class="weekend-stat-value">
                {{ stats.chushouWrong }}
              </div>
            </div>
            <div class="weekend-stat-item">
              <div class="weekend-stat-label">
                空仓胜率
              </div><div class="weekend-stat-value">
                {{ stats.emptyWinRate }}%
              </div>
            </div>
            <div class="weekend-stat-item">
              <div class="weekend-stat-label">
                出手胜率
              </div><div class="weekend-stat-value">
                {{ stats.chushouWinRate }}%
              </div>
            </div>
          </div>
        </div>

        <!-- 2.5 总计统计 -->
        <div class="weekend-section">
          <div
            class="weekend-section-title"
            style="display: flex; align-items: center;"
          >
            <span>📌 总计统计</span>
            <span style="font-size: 13px; color: #64748b; font-weight: normal; margin-left: auto; margin-right: 50px;">成交天数 <span style="color: #dc2626; font-weight: 700;">{{ totalStats.tradingDays }}</span></span>
          </div>
          <div
            class="weekend-subtitle"
            style="text-align:center; color:#94a3b8; font-size:12px; margin: -4px 0 4px;"
          >
            {{ totalStats.dateRange }}
          </div>
          <div style="text-align:center; font-size:12px; color:#f59e0b; margin-bottom:8px;">
            未记录/未填写天数 <span style="font-weight:700;">{{ totalStats.unrecordedCount }}</span>
          </div>
          <div class="weekend-stat-grid">
            <div class="weekend-stat-item">
              <div class="weekend-stat-label">
                空仓次数
              </div><div class="weekend-stat-value">
                {{ totalStats.emptyCount }}
              </div>
            </div>
            <div class="weekend-stat-item">
              <div class="weekend-stat-label">
                出手次数
              </div><div class="weekend-stat-value">
                {{ totalStats.chushouCount }}
              </div>
            </div>
            <div class="weekend-stat-item">
              <div class="weekend-stat-label">
                空仓对了
              </div><div class="weekend-stat-value">
                {{ totalStats.emptyRight }}
              </div>
            </div>
            <div class="weekend-stat-item">
              <div class="weekend-stat-label">
                空仓错了
              </div><div class="weekend-stat-value">
                {{ totalStats.emptyWrong }}
              </div>
            </div>
            <div class="weekend-stat-item">
              <div class="weekend-stat-label">
                出手对了
              </div><div class="weekend-stat-value">
                {{ totalStats.chushouRight }}
              </div>
            </div>
            <div class="weekend-stat-item">
              <div class="weekend-stat-label">
                出手错了
              </div><div class="weekend-stat-value">
                {{ totalStats.chushouWrong }}
              </div>
            </div>
            <div class="weekend-stat-item">
              <div class="weekend-stat-label">
                空仓胜率
              </div><div class="weekend-stat-value">
                {{ totalStats.emptyWinRate }}%
              </div>
            </div>
            <div class="weekend-stat-item">
              <div class="weekend-stat-label">
                出手胜率
              </div><div class="weekend-stat-value">
                {{ totalStats.chushouWinRate }}%
              </div>
            </div>
          </div>
        </div>

        <!-- 3. 本周ETF板块表现 -->
        <div class="weekend-section">
          <div class="weekend-section-title">
            📊 本周ETF板块表现
          </div>
          <div class="weekend-stock-list">
            <div
              v-for="item in topEtfs"
              :key="item.name"
              class="weekend-stock-item"
            >
              <span class="weekend-stock-name">{{ item.name }}</span>
              <span class="weekend-stock-count">{{ item.count }}次</span>
            </div>
            <div
              v-if="topEtfs.length === 0"
              class="weekend-stock-item"
            >
              <span class="weekend-stock-name">暂无数据</span>
            </div>
          </div>
        </div>

        <!-- 4. 本周最近多板表现 -->
        <div class="weekend-section">
          <div class="weekend-section-title">
            📈 本周最近多板表现
          </div>
          <div class="weekend-stock-list">
            <div
              v-for="item in duibanPerformance"
              :key="item.name"
              class="weekend-stock-item"
            >
              <span class="weekend-stock-name">{{ item.name }}</span>
              <span class="weekend-stock-count">{{ item.count }}次</span>
            </div>
            <div
              v-if="duibanPerformance.length === 0"
              class="weekend-stock-item"
            >
              <span class="weekend-stock-name">暂无数据</span>
            </div>
          </div>
        </div>

        <!-- 5. 本周上榜最多 -->
        <div class="weekend-section">
          <div
            class="weekend-section-title"
            @click="toggleTopStocks"
          >
            🏆 本周上榜最多
            <span
              class="toggle-icon"
              :class="{ expanded: topStocksExpanded }"
            >▼</span>
          </div>
          <div
            class="weekend-stock-list"
            :class="{ collapsed: !topStocksExpanded, expanded: topStocksExpanded }"
          >
            <div
              v-for="item in topStocks"
              :key="item.name"
              class="weekend-stock-item"
            >
              <span class="weekend-stock-name">{{ item.name }}</span>
              <span class="weekend-stock-count">{{ item.count }}次</span>
            </div>
            <div
              v-if="topStocks.length === 0"
              class="weekend-stock-item"
            >
              <span class="weekend-stock-name">暂无数据</span>
            </div>
          </div>
        </div>

        <!-- 6. 记录统计 -->
        <div class="weekend-section">
          <div class="weekend-section-title">
            📝 记录统计
          </div>
          <div class="record-stats-container">
            <div class="record-stats-row">
              <div class="record-stats-item">
                <div class="record-stats-label">
                  最近多板记录
                </div><div class="record-stats-value">
                  {{ recordStats.duibanCount }}
                </div>
              </div>
              <div class="record-stats-item">
                <div class="record-stats-label">
                  题材方向记录
                </div><div class="record-stats-value">
                  {{ recordStats.topicCount }}
                </div>
              </div>
              <div class="record-stats-item">
                <div class="record-stats-label">
                  板块ETF记录
                </div><div class="record-stats-value">
                  {{ recordStats.etfCount }}
                </div>
              </div>
            </div>
            <div class="record-stats-row">
              <div class="record-stats-item">
                <div class="record-stats-label">
                  最近多板胜率
                </div><div class="record-stats-value">
                  {{ recordStats.duibanWinRate }}%
                </div>
              </div>
              <div class="record-stats-item">
                <div class="record-stats-label">
                  题材方向胜率
                </div><div class="record-stats-value">
                  {{ recordStats.topicWinRate }}%
                </div>
              </div>
              <div class="record-stats-item">
                <div class="record-stats-label">
                  板块ETF胜率
                </div><div class="record-stats-value">
                  {{ recordStats.etfWinRate }}%
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 7. 每日盈亏曲线图 -->
        <div class="weekend-section">
          <div class="weekend-section-title">
            📈 每日盈亏曲线
          </div>
          <div class="profit-chart-container">
            <TrendChart
              :points="profitPoints"
              color="#dc2626"
            />
          </div>
        </div>

        <!-- 8. 账户余额曲线图 -->
        <div class="weekend-section">
          <div class="weekend-section-title">
            💳 账户余额曲线
          </div>
          <div class="profit-chart-container">
            <TrendChart
              :points="balancePoints"
              color="#2563eb"
            />
          </div>
        </div>

        <!-- 9. 本周总结心得 -->
        <div class="weekend-section">
          <div class="weekend-section-title">
            💡 本周总结心得
          </div>
          <div
            class="weekend-summary-content"
            @click="openSummaryEdit"
          >
            <div
              v-if="!summaryText"
              class="weekend-summary-placeholder"
            >
              暂无总结心得，点击输入
            </div>
            <div v-else>
              {{ summaryText }}
            </div>
          </div>
        </div>
      </div>

      <!-- 周日内容：周末总结 -->
      <div
        v-show="!isSaturday"
        class="sunday-content"
      >
        <div class="weekend-section">
          <div class="weekend-section-title">
            📝 本周回顾
          </div>
          <div
            class="weekend-summary-content"
            @click="openReviewEdit"
          >
            <div
              v-if="!reviewText"
              class="weekend-summary-placeholder"
            >
              暂无内容，点击输入
            </div>
            <div v-else>
              {{ reviewText }}
            </div>
          </div>
        </div>
        <div class="weekend-section">
          <div class="weekend-section-title">
            💡 经验总结
          </div>
          <div
            class="weekend-summary-content"
            @click="openExperienceEdit"
          >
            <div
              v-if="!experienceText"
              class="weekend-summary-placeholder"
            >
              暂无内容，点击输入
            </div>
            <div v-else>
              {{ experienceText }}
            </div>
          </div>
        </div>
        <div class="weekend-section">
          <div class="weekend-section-title">
            🎯 下周计划
          </div>
          <div
            class="weekend-summary-content"
            @click="openPlanEdit"
          >
            <div
              v-if="!planText"
              class="weekend-summary-placeholder"
            >
              暂无内容，点击输入
            </div>
            <div v-else>
              {{ planText }}
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- [FIX 2026-08-15] 周/月总结编辑：原 openWeekendSummaryModal 为空桩导致点击无反应，
         改为本地 Vue EditModal + stats-logic.writeStats 持久化（同 StatsBoard 评论模式，§4/§8/§10）。 -->
    <EditModal
      v-model="editModalActive"
      :title="editModalTitle"
      show-clear
      clear-text="清空"
      @save="saveEdit"
      @clear="clearEdit"
    >
      <textarea
        v-model="editDraft"
        style="width:100%;min-height:160px;padding:10px;border:1px solid #d1d5db;border-radius:8px;font-size:14px;resize:vertical;box-sizing:border-box;"
        placeholder="输入内容..."
      />
    </EditModal>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue';
import { getJiwangData } from '../data/supabase-client.js';
import { useUiStore } from '../stores/uiStore.js';
import { isTradingDay } from '../logic/date/trading-day-helpers.js';
import { readStats, writeStats } from '../logic/stats/stats-logic.js';
import {
  computeStats,
  computeTopStocks,
  computeTopEtfs,
  computeRecordStats,
  buildProfitPoints,
} from '../logic/stats/stats-calc.js';
// [分层] 日期解析/周区间/格式化统一收口到 Logic 层（架构规范 §4：日期逻辑归属 Logic），
// 不再在 .vue 内联（原 parseLocalDate / getWeekDates / formatDate 已搬出）。
import { parseLocalDate, getWeekDates, formatDate } from '../logic/stats/weekend-logic.js';
import TrendChart from '../components/TrendChart.vue';
import EditModal from '../components/EditModal.vue';
import { showToast } from '../composables/useToast.js';

const uiStore = useUiStore();

const topStocksExpanded = ref(false);
// [FIX 2026-08-15] 周/月总结编辑本地化：summaryText/reviewText/experienceText/planText
// 从 jiwang stats 读取（readStats），点击经本地 EditModal → writeStats 持久化（§4/§8/§10）。
// 字段约定：weekSummary（周六总结）/ weekReview（周日回顾）/ weekExperience（周日经验）/ weekPlan（周日计划）。
const summaryStats = readStats(uiStore.currentDate || '');
const summaryText = ref(summaryStats.weekSummary || '');
const reviewText = ref(summaryStats.weekReview || '');
const experienceText = ref(summaryStats.weekExperience || '');
const planText = ref(summaryStats.weekPlan || '');
// [FIX 2026-08-15] 日期切换时重新从 stats 加载总结文本（看板可能复用而不重新挂载，§17/§24）
watch(() => uiStore.currentDate, () => {
  const s = readStats(uiStore.currentDate || '');
  summaryText.value = s.weekSummary || '';
  reviewText.value = s.weekReview || '';
  experienceText.value = s.weekExperience || '';
  planText.value = s.weekPlan || '';
});

// 编辑弹窗状态：editField 标记当前编辑字段
const editModalActive = ref(false);
const editModalTitle = ref('');
const editDraft = ref('');
let editField = '';

function openSummaryEdit() {
  editField = 'weekSummary';
  editModalTitle.value = '本周总结心得';
  editDraft.value = summaryText.value;
  editModalActive.value = true;
}
function openReviewEdit() {
  editField = 'weekReview';
  editModalTitle.value = '本周回顾';
  editDraft.value = reviewText.value;
  editModalActive.value = true;
}
function openExperienceEdit() {
  editField = 'weekExperience';
  editModalTitle.value = '经验总结';
  editDraft.value = experienceText.value;
  editModalActive.value = true;
}
function openPlanEdit() {
  editField = 'weekPlan';
  editModalTitle.value = '下周计划';
  editDraft.value = planText.value;
  editModalActive.value = true;
}
async function saveEdit() {
  const val = editDraft.value.trim();
  const patch = {};
  patch[editField] = val;
  try {
    await writeStats(uiStore.currentDate, patch, '✅ 已保存并同步到云端');
    if (editField === 'weekSummary') summaryText.value = val;
    else if (editField === 'weekReview') reviewText.value = val;
    else if (editField === 'weekExperience') experienceText.value = val;
    else if (editField === 'weekPlan') planText.value = val;
    editModalActive.value = false;
  } catch (e) {
    showToast('保存失败：' + (e && e.message ? e.message : '未知错误'));
  }
}
async function clearEdit() {
  const patch = {};
  patch[editField] = '';
  try {
    await writeStats(uiStore.currentDate, patch, '✅ 已清空并同步到云端');
    if (editField === 'weekSummary') summaryText.value = '';
    else if (editField === 'weekReview') reviewText.value = '';
    else if (editField === 'weekExperience') experienceText.value = '';
    else if (editField === 'weekPlan') planText.value = '';
    editModalActive.value = false;
  } catch (e) {
    showToast('清空失败：' + (e && e.message ? e.message : '未知错误'));
  }
}

// 响应式根：uiStore.currentDate 变化 → 所有依赖它的 computed 自动重算（架构规范 §17）。
// DashboardView 按日期切换挂载本板子，切换后 currentDate 变化即驱动重算，无需额外 watch。
const currentDate = computed(() => uiStore.currentDate || '');

// [语义修复] 原 isSaturday 仅在「交易日 getDay()===6」为真 → 周一~周五均为 false，
// 导致交易日也显示「周日总结」那 3 个空占位框（不当）。新语义：
// 只要不是周日（getDay()!==0）就显示「周统计」内容（周六与交易日都显示统计）；
// 仅周日（getDay()===0）显示回顾/经验/计划总结。空/无效日期兜底显示统计，避免空白。
const isSaturday = computed(() => {
  const d = parseLocalDate(currentDate.value);
  return !d || d.getDay() !== 0; // 无效/空 → 默认显示统计；仅周日(0)显示总结
});

const dateRange = computed(() => {
  const dates = getWeekDates(currentDate.value);
  if (dates.length === 0) return '--';
  return `${dates[dates.length - 1]} 至 ${dates[0]}`;
});

const stats = computed(() => computeStats(getWeekDates(currentDate.value)));

const totalStats = computed(() => {
  const startDate = '2026-02-01';
  const end = currentDate.value || formatDate(new Date());
  const dates = [];
  const d = new Date(startDate + 'T00:00:00');
  const endD = new Date(end + 'T00:00:00');
  while (d <= endD) {
    dates.push(formatDate(d));
    d.setDate(d.getDate() + 1);
  }
  const r = computeStats(dates);
  r.dateRange = `${startDate} 至 ${end}`;
  let unrecorded = 0;
  dates.forEach(dt => {
    if (isTradingDay(dt)) {
      const jiwangData = getJiwangData() || {};
      const dayJiwang = jiwangData[dt];
      if (!dayJiwang || !dayJiwang.jielun) unrecorded++;
    }
  });
  r.unrecordedCount = unrecorded;
  return r;
});

const topStocks = computed(() => computeTopStocks(getWeekDates(currentDate.value)));
const topEtfs = computed(() => computeTopEtfs(getWeekDates(currentDate.value)));

// [已知缺口] duibanPerformance 当前恒为 []（占位）→ 第 4 区块「本周最近多板表现」恒显「暂无数据」。
// 真实数据源为「多板/对板」看板（duiban 域，跨模块，本板子无所有权），需聚合本周内多板记录按股票计数。
// 正确修复路径：在 stats-calc 增加 computeTopDuiban(dates) 读取 duiban 域并返回 {name,count}[]；
// 本板子仅占位 []，待与负责对板/月度看板的 Agent 对齐接口后接入，避免越界读 duiban 域引入 bug。
// 保留该 section 而非删除，避免误删功能；接入前用户可见「暂无数据」占位（已知缺口，不阻塞）。
const duibanPerformance = computed(() => []);

const recordStats = computed(() => computeRecordStats(getWeekDates(currentDate.value)));

function toggleTopStocks() { topStocksExpanded.value = !topStocksExpanded.value; }

// W-03：复用 <TrendChart> 组件替代自绘 canvas（遵循 §30 图表性能规范）。
// buildProfitPoints(getDates) 内部调用 getDates() 取日期数组；getWeekDates 现需 base 参数，
// 故传入 () => getWeekDates(currentDate.value)，确保随 currentDate 响应式重算。
const profitPoints = computed(() => buildProfitPoints(() => getWeekDates(currentDate.value)).profitPoints);
const balancePoints = computed(() => buildProfitPoints(() => getWeekDates(currentDate.value)).balancePoints);
</script>
