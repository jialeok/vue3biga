import { getJiwangData, getBiddingData } from '../data/supabase-client.js';
import { useUiStore } from '../stores/uiStore.js';
import { getTagTitlesByDate, renderConsecutiveUp } from './tag-titles-helpers.js';
import { saveData } from './app-core-api.js';

export function getStats() {
  const uiStore = useUiStore();
  const jiwangData = getJiwangData();
  if (!jiwangData[uiStore.currentDate]) jiwangData[uiStore.currentDate] = {};
  if (!jiwangData[uiStore.currentDate].stats) jiwangData[uiStore.currentDate].stats = {};
  return jiwangData[uiStore.currentDate].stats;
}

export function autoCalculateConsecutiveDays() {
  const biddingAllData = getBiddingData();
  const jiwangAllData = getJiwangData();

  const allDatesSet = new Set([
    ...Object.keys(biddingAllData),
    ...Object.keys(jiwangAllData)
  ]);
  const allDates = Array.from(allDatesSet).sort();

  if (allDates.length === 0) return;

  const nameMapping = {
    '最近多板%': 'duoban',
    '板块ETF(48)': 'bankuai',
    '昨成交额前五': 'ticai'
  };

  const consecutiveState = {
    duoban: { direction: 0, count: 0 },
    bankuai: { direction: 0, count: 0 },
    ticai: { direction: 0, count: 0 },
    dapan: { direction: 0, count: 0 }
  };

  allDates.forEach(date => {
    const dayData = biddingAllData[date];
    const jiwangData = jiwangAllData[date];
    const tagData = getTagTitlesByDate(date);
    if (!tagData.consecutiveUp) tagData.consecutiveUp = { duoban: 0, bankuai: 0, ticai: 0, dapan: 0 };

    if (dayData && Array.isArray(dayData)) {
      dayData.forEach(row => {
        const itemName = row.name || '';
        let targetKey = nameMapping[itemName];
        if (!targetKey && itemName.startsWith('板块ETF')) {
          targetKey = 'bankuai';
        }
        if (!targetKey) return;

        const time925Str = (row.time925 || '').toString().trim();
        const closeStr = (row.close || '').toString().trim();
        const time925 = parseFloat(time925Str);
        const close = parseFloat(closeStr);
        if (time925Str === '' || closeStr === '' || isNaN(time925) || isNaN(close)) return;

        let todayDirection;
        if (targetKey === 'ticai') {
          if (close === time925) {
            todayDirection = (close >= 3) ? 1 : -1;
          } else {
            todayDirection = (close > time925) ? 1 : -1;
          }
        } else {
          todayDirection = (close > time925) ? 1 : -1;
        }

        const st = consecutiveState[targetKey];
        if (todayDirection !== st.direction) {
          st.direction = todayDirection;
          st.count = todayDirection;
        } else {
          st.count += (todayDirection > 0 ? 1 : -1);
        }
        if (st.count > 10) st.count = 10;
        if (st.count < -10) st.count = -10;
        tagData.consecutiveUp[targetKey] = st.count;
      });
    }

    if (jiwangData && jiwangData.shouguJieguo) {
      const shouguJieguo = jiwangData.shouguJieguo.trim();
      if (shouguJieguo !== '' && shouguJieguo !== ':') {
        const parts = shouguJieguo.split(':');
        if (parts.length === 2) {
          const dieCount = parseFloat(parts[0].trim());
          const zhangCount = parseFloat(parts[1].trim());
          if (!isNaN(dieCount) && !isNaN(zhangCount) && zhangCount > 0) {
            const ratio = dieCount / zhangCount;
            const todayDirection = ratio > 1 ? -1 : 1;
            const st = consecutiveState.dapan;
            if (todayDirection !== st.direction) {
              st.direction = todayDirection;
              st.count = todayDirection;
            } else {
              st.count += (todayDirection > 0 ? 1 : -1);
            }
            if (st.count > 10) st.count = 10;
            if (st.count < -10) st.count = -10;
            tagData.consecutiveUp.dapan = st.count;
          }
        }
      }
    }
  });

  saveData();
  renderConsecutiveUp();
}

export function renderCircleStats() {}

export function getKxianTypeByClose(closeValue) {
  if (!closeValue) return '';
  const value = parseFloat(closeValue);
  if (isNaN(value)) return '';
  if (value >= 3.6) return `大阳${value}%`;
  else if (value >= 2.6) return `中阳${value}%`;
  else if (value >= 1.0) return `小阳${value}%`;
  else if (value > -1.0) return `十字星${value}%`;
  else if (value >= -2.5) return `小阴${value}%`;
  else if (value >= -3.5) return `中阴${value}%`;
  else return `大阴${value}%`;
}
