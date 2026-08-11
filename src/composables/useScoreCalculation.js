
import { autoCalculateRecentMultiScore as _calcRecentMultiScore, renderConsecutiveUp as _calcConsecutiveUp } from '../logic/tag-titles-helpers.js';
import { autoCalculateSectorEtfScore, autoCalculateTopicDirectionScore, openMonthlySummaryModal, openWeekendReviewModal, openWeekendSummaryModal, showLastWeekStats, showMonthlyStats, showWeeklyStats } from '../logic/ui-bridge.js';
import { ref } from 'vue';
import { getScoreSettings, checkHasFumianTopic } from '../logic/score-helpers.js';
import { getTodayJiwang, getGroupData, getTodayGroupList, saveData } from '../logic/app-core-api.js';
import { getTopicGroups } from '../logic/topic-rules.js';
import { getBiddingData } from '../data/supabase-client.js';
import { useUiStore } from '../stores/uiStore.js';
import { setCurrentDate } from '../logic/app-core.js';
import { setCurrentFilter } from '../logic/stock-list-state.js';
import { _emit } from '../stores/eventBus.js';

export function useScoreCalculation() {
  const uiStore = useUiStore();
  const recentMultiScore = ref(0);
  const sectorEtfScore = ref(0);
  const topicDirectionScore = ref(0);
  const consecutiveUp = ref({ duoban: 0, bankuai: 0, ticai: 0 });

  function calculateAll() {
    if (typeof _calcRecentMultiScore === 'function') {
      recentMultiScore.value = _calcRecentMultiScore();
    }
    if (typeof autoCalculateSectorEtfScore === 'function') {
      sectorEtfScore.value = autoCalculateSectorEtfScore();
    }
    if (typeof autoCalculateTopicDirectionScore === 'function') {
      topicDirectionScore.value = autoCalculateTopicDirectionScore();
    }
  }

  function renderConsecutiveUp() {
    if (typeof _calcConsecutiveUp === 'function') {
      const result = _calcConsecutiveUp();
      if (result && typeof result === 'object') consecutiveUp.value = result;
    }
  }

  function _formatDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  function _isWeekend(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    const day = d.getDay();
    return day === 0 || day === 6;
  }
  function _emitAllRefresh() {
    _emit('stocks-refresh');
    _emit('auction-refresh');
    _emit('bidding-refresh');
    _emit('board-refresh');

  }
  function showWeekly() {
    const baseDate = new Date(uiStore.currentDate + 'T00:00:00');
    const dayOfWeek = baseDate.getDay();
    let daysToSaturday = dayOfWeek === 0 ? -1 : (6 - dayOfWeek + 7) % 7;
    const saturday = new Date(baseDate);
    saturday.setDate(baseDate.getDate() + daysToSaturday);
    const dateStr = _formatDate(saturday);
    uiStore.setDate(dateStr);
    setCurrentDate(dateStr);
    setCurrentFilter('all');
    _emitAllRefresh();
  }
  function showLastWeek() {
    const baseDate = new Date(uiStore.currentDate + 'T00:00:00');
    const dayOfWeek = baseDate.getDay();
    const daysToLastSaturday = -((dayOfWeek + 1) % 7 + 6) % 7 - 1;
    const lastSaturday = new Date(baseDate);
    lastSaturday.setDate(baseDate.getDate() + daysToLastSaturday);
    const dateStr = _formatDate(lastSaturday);
    uiStore.setDate(dateStr);
    setCurrentDate(dateStr);
    setCurrentFilter('all');
    _emitAllRefresh();
  }
  function showMonthly() {
    if (!_isWeekend(uiStore.currentDate)) {
      const baseDate = new Date(uiStore.currentDate + 'T00:00:00');
      const dayOfWeek = baseDate.getDay();
      let daysToSaturday = (6 - dayOfWeek + 7) % 7;
      const saturday = new Date(baseDate);
      saturday.setDate(baseDate.getDate() + daysToSaturday);
      const dateStr = _formatDate(saturday);
      uiStore.setDate(dateStr);
      setCurrentDate(dateStr);
      setCurrentFilter('all');
      _emitAllRefresh();
    }
  }
  function openWeekendSummary() { if (typeof openWeekendSummaryModal === 'function') openWeekendSummaryModal(); }
  function openWeekendReview() { if (typeof openWeekendReviewModal === 'function') openWeekendReviewModal(); }
  function openMonthlySummary() { if (typeof openMonthlySummaryModal === 'function') openMonthlySummaryModal(); }

  return {
    recentMultiScore,
    sectorEtfScore,
    topicDirectionScore,
    consecutiveUp,
    calculateAll,
    renderConsecutiveUp,
    showWeekly,
    showLastWeek,
    showMonthly,
    openWeekendSummary,
    openWeekendReview,
    openMonthlySummary,
  };
}
