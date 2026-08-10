
import { autoCalculateRecentMultiScore as _calcRecentMultiScore, renderConsecutiveUp as _calcConsecutiveUp } from '../logic/tag-titles-helpers.js';
import { autoCalculateSectorEtfScore, autoCalculateTopicDirectionScore, openMonthlySummaryModal, openWeekendReviewModal, openWeekendSummaryModal, showLastWeekStats, showMonthlyStats, showWeeklyStats } from '../logic/ui-bridge.js';
import { ref } from 'vue';
import { getScoreSettings, checkHasFumianTopic } from '../logic/score-helpers.js';
import { getTodayJiwang, getGroupData, getTodayGroupList, saveData } from '../logic/app-core.js';
import { getTopicGroups } from '../logic/topic-rules.js';
import { getBiddingData } from '../data/supabase-client.js';
import { useUiStore } from '../stores/uiStore.js';

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

  function showWeekly() { if (typeof showWeeklyStats === 'function') showWeeklyStats(); }
  function showLastWeek() { if (typeof showLastWeekStats === 'function') showLastWeekStats(); }
  function showMonthly() { if (typeof showMonthlyStats === 'function') showMonthlyStats(); }
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
