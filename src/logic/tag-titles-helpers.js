import { getCurrentDate, getTagTitlesData, saveData, getTodayJiwang } from './app-core-api.js';
import { loadAllData, getBiddingData, getJiwangData } from '../data/supabase-client.js';
import { isTradingDay } from './trading-day-helpers.js';
import { getScoreSettings } from './score-helpers.js';

export function getPreviousTagDate(date) {
  const tagTitlesData = getTagTitlesData();
  const dates = Object.keys(tagTitlesData)
    .filter(d => d && d.length === 10)
    .sort((a, b) => new Date(a) - new Date(b));
  const currentDateObj = new Date(date);
  for (let i = dates.length - 1; i >= 0; i--) {
    const d = dates[i];
    if (new Date(d) < currentDateObj) {
      return d;
    }
  }
  return null;
}

export function getTodayTagTitles() {
  const currentDate = getCurrentDate();
  const tagTitlesData = getTagTitlesData();

  if (tagTitlesData[''] && !tagTitlesData[currentDate]) {
    tagTitlesData[currentDate] = tagTitlesData[''];
    delete tagTitlesData[''];
    saveData();
  } else if (tagTitlesData[''] && tagTitlesData[currentDate]) {
    const emptyKeyData = tagTitlesData[''];
    ['recentMulti', 'sectorEtf', 'topicDirection'].forEach(type => {
      if (emptyKeyData[type]) {
        if (!tagTitlesData[currentDate][type]) {
          tagTitlesData[currentDate][type] = emptyKeyData[type];
        } else {
          const existingTags = tagTitlesData[currentDate][type].tags || [];
          const newTags = emptyKeyData[type].tags || [];
          const mergedTags = [...new Set([...existingTags, ...newTags])];
          tagTitlesData[currentDate][type].tags = mergedTags;
          if (emptyKeyData[type].active) {
            if (!tagTitlesData[currentDate][type].active) {
              tagTitlesData[currentDate][type].active = {};
            }
            Object.assign(tagTitlesData[currentDate][type].active, emptyKeyData[type].active);
          }
        }
      }
    });
    delete tagTitlesData[''];
    saveData();
  }

  if (!tagTitlesData[currentDate]) {
    tagTitlesData[currentDate] = {
      recentMulti: { tags: [], active: {}, score: 0 },
      sectorEtf: { tags: [], active: {}, score: 0 },
      topicDirection: { tags: [], active: {}, score: 0 },
      consecutiveUp: { duoban: 0, bankuai: 0, ticai: 0 }
    };

    const prevDate = getPreviousTagDate(currentDate);
    if (prevDate && tagTitlesData[prevDate]) {
      const prevData = tagTitlesData[prevDate];
      ['recentMulti', 'sectorEtf', 'topicDirection'].forEach(type => {
        const prevTags = prevData[type]?.tags || [];
        if (prevTags.length > 0) {
          tagTitlesData[currentDate][type].tags = [...prevTags];
          tagTitlesData[currentDate][type].active = {};
          prevTags.forEach(tag => {
            tagTitlesData[currentDate][type].active[tag] = false;
          });
        }
      });
      if (prevData.consecutiveUp) {
        tagTitlesData[currentDate].consecutiveUp = { ...prevData.consecutiveUp };
      }
      saveData();
    }
  }

  const currentData = tagTitlesData[currentDate];
  ['recentMulti', 'sectorEtf', 'topicDirection'].forEach(type => {
    if (!currentData[type]) {
      currentData[type] = { tags: [], active: {}, score: 0 };
    }
    if (!currentData[type].tags) {
      currentData[type].tags = [];
    }
    if (!currentData[type].active) {
      currentData[type].active = {};
    }
    if (currentData[type].score === undefined) {
      currentData[type].score = 0;
    }
  });
  if (!currentData.consecutiveUp) {
    currentData.consecutiveUp = { duoban: 0, bankuai: 0, ticai: 0 };
  }
  return currentData;
}

export function getYesterdayDate(date) {
  const d = new Date(date);
  d.setDate(d.getDate() - 1);
  const toISODate = (dt) => {
    const year = dt.getFullYear();
    const month = String(dt.getMonth() + 1).padStart(2, '0');
    const day = String(dt.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };
  while (!isTradingDay(toISODate(d))) {
    d.setDate(d.getDate() - 1);
  }
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function getTagTitlesByDate(date) {
  const allData = loadAllData();
  if (!allData.tagTitles[date]) {
    allData.tagTitles[date] = {
      recentMulti: { tags: [], active: {}, score: 0 },
      sectorEtf: { tags: [], active: {}, score: 0 },
      topicDirection: { tags: [], active: {}, score: 0 },
      consecutiveUp: { duoban: 0, bankuai: 0, ticai: 0 }
    };
  }
  return allData.tagTitles[date];
}

export function getPreviousTradingDayWithData(date) {
  const biddingAllData = getBiddingData();
  const jiwangAllData = getJiwangData();
  const allDatesSet = new Set([...Object.keys(biddingAllData), ...Object.keys(jiwangAllData)]);
  const allDates = Array.from(allDatesSet).sort().reverse();

  for (const d of allDates) {
    if (d >= date) continue;
    const bidding = biddingAllData[d];
    const jiwang = jiwangAllData[d];
    let hasValidData = false;

    if (bidding && Array.isArray(bidding)) {
      for (const row of bidding) {
        const time930 = (row.time930 || '').toString().trim();
        const close = (row.close || '').toString().trim();
        if ((row.name === '最近多板%' || row.name.startsWith('板块ETF') || row.name === '昨成交额前五')
          && time930 !== '' && close !== '') {
          hasValidData = true;
          break;
        }
      }
    }

    if (!hasValidData && jiwang && jiwang.shouguJieguo) {
      const shougu = jiwang.shouguJieguo.trim();
      if (shougu !== '' && shougu !== ':') {
        const parts = shougu.split(':');
        if (parts.length === 2 && parts[0].trim() !== '' && parts[1].trim() !== '') {
          hasValidData = true;
        }
      }
    }

    if (hasValidData) return d;
  }
  return null;
}

export function getTodayBidding() {
  const currentDate = getCurrentDate();
  const biddingData = getBiddingData();
  const existingData = biddingData[currentDate];
  if (existingData !== undefined && Array.isArray(existingData)) {
    const hasValidData = existingData.some(row => {
      return (row.name && row.name.toString().trim() !== '') ||
        (row.time915 && row.time915.toString().trim() !== '') ||
        (row.time920 && row.time920.toString().trim() !== '') ||
        (row.time930 && row.time930.toString().trim() !== '') ||
        (row.change && row.change.toString().trim() !== '') ||
        (row.close && row.close.toString().trim() !== '');
    });
    if (hasValidData) {
      return existingData;
    }
  }
  return null;
}

export function renderConsecutiveUp() {
  const currentDate = getCurrentDate();
  if (!isTradingDay(currentDate)) {
    return { duoban: 0, bankuai: 0, ticai: 0, dapan: 0 };
  }

  const data = getTodayTagTitles();
  const todayConsecutiveUp = data.consecutiveUp || { duoban: 0, bankuai: 0, ticai: 0, dapan: 0 };

  const todayBidding = getTodayBidding();
  const todayJiwang = getTodayJiwang();

  const hasTodayData = { duoban: false, bankuai: false, ticai: false, dapan: false };

  if (todayBidding && Array.isArray(todayBidding)) {
    todayBidding.forEach(row => {
      const time930 = (row.time930 || '').toString().trim();
      const close = (row.close || '').toString().trim();
      if (row.name === '最近多板%' && time930 !== '' && close !== '') hasTodayData.duoban = true;
      if (row.name && row.name.startsWith('板块ETF') && time930 !== '' && close !== '') hasTodayData.bankuai = true;
      if (row.name === '昨成交额前五' && time930 !== '' && close !== '') hasTodayData.ticai = true;
    });
  }

  if (todayJiwang && todayJiwang.shouguJieguo) {
    const shougu = todayJiwang.shouguJieguo.trim();
    if (shougu !== '' && shougu !== ':') {
      const parts = shougu.split(':');
      if (parts.length === 2 && parts[0].trim() !== '' && parts[1].trim() !== '') {
        hasTodayData.dapan = true;
      }
    }
  }

  const prevDate = getPreviousTradingDayWithData(currentDate);
  let prevConsecutiveUp = { duoban: 0, bankuai: 0, ticai: 0, dapan: 0 };
  if (prevDate) {
    const prevData = getTagTitlesByDate(prevDate);
    prevConsecutiveUp = prevData.consecutiveUp || { duoban: 0, bankuai: 0, ticai: 0, dapan: 0 };
  }

  return {
    duoban: hasTodayData.duoban ? todayConsecutiveUp.duoban : prevConsecutiveUp.duoban,
    bankuai: hasTodayData.bankuai ? todayConsecutiveUp.bankuai : prevConsecutiveUp.bankuai,
    ticai: hasTodayData.ticai ? todayConsecutiveUp.ticai : prevConsecutiveUp.ticai,
    dapan: hasTodayData.dapan ? todayConsecutiveUp.dapan : prevConsecutiveUp.dapan
  };
}

export function autoCalculateRecentMultiScore() {
  const currentDate = getCurrentDate();
  const tagData = getTodayTagTitles();
  const yesterdayDate = getYesterdayDate(currentDate);
  const yesterdayTagData = getTagTitlesByDate(yesterdayDate);
  const yesterdayConsecutiveUp = yesterdayTagData.consecutiveUp || { duoban: 0, bankuai: 0, ticai: 0 };
  const todayJiwang = getTodayJiwang() || {};
  const rawSettings = getScoreSettings('recentMulti');
  const s = {};
  Object.keys(rawSettings).forEach(key => {
    const val = rawSettings[key];
    s[key] = (val === '' || val === null || val === undefined) ? 0 : val;
  });

  let score = 0;
  const yesterdayDuobanDays = yesterdayConsecutiveUp.duoban || 0;
  const yesterdayBankuaiDays = yesterdayConsecutiveUp.bankuai || 0;
  const yesterdayTicaiDays = yesterdayConsecutiveUp.ticai || 0;

  if (yesterdayDuobanDays === -1) {
    score = s.die1;
  } else if (yesterdayDuobanDays === -2) {
    score = s.die2;
  } else if (yesterdayDuobanDays === -3) {
    score = s.die3;
  } else if (yesterdayDuobanDays === -4) {
    score = s.die4;
  } else if (yesterdayDuobanDays <= -5) {
    score = s.die5;
  } else if (yesterdayDuobanDays === 1) {
    score = s.zhang1;
  } else if (yesterdayDuobanDays === 2) {
    score = s.zhang2;
  } else if (yesterdayDuobanDays >= 3) {
    score = s.zhang3;
  }

  if (todayJiwang.jielun === '空仓') {
    score += s.kongcang;
  } else if (todayJiwang.jielun === '出手') {
    score += s.chushou;
  }

  const bankuaiIsDown = yesterdayBankuaiDays < 0;
  const bankuaiIsUp = yesterdayBankuaiDays > 0;
  const ticaiIsDown = yesterdayTicaiDays < 0;
  const ticaiIsUp = yesterdayTicaiDays > 0;

  if (yesterdayDuobanDays <= -1) {
    if (bankuaiIsDown && ticaiIsDown) {
      score += s.yangqun1;
    } else if (bankuaiIsUp && ticaiIsUp) {
      score += s.yangqun2;
    } else if (bankuaiIsUp && ticaiIsDown) {
      score += s.yangqun3;
    } else if (bankuaiIsDown && ticaiIsUp) {
      score += s.yangqun4;
    }
  } else if (yesterdayDuobanDays >= 1 && yesterdayDuobanDays <= 2) {
    if (bankuaiIsUp && ticaiIsUp) {
      score += s.yangqun5;
    } else if (bankuaiIsUp && ticaiIsDown) {
      score += s.yangqun6;
    } else if (bankuaiIsDown && ticaiIsUp) {
      score += s.yangqun7;
    }
  } else if (yesterdayDuobanDays >= 3) {
    if (bankuaiIsUp && ticaiIsUp) {
      score += s.yangqun8;
    } else if (bankuaiIsDown && ticaiIsUp) {
      score += s.yangqun9;
    } else if (bankuaiIsUp && ticaiIsDown) {
      score += s.yangqun10;
    } else if (bankuaiIsDown && ticaiIsDown) {
      score += s.yangqun11;
    }
  }

  try {
    const biddingData = getBiddingData();
    const currentBidding = biddingData[currentDate];
    if (currentBidding && currentBidding.length > 0) {
      const duobanRow = currentBidding.find(row => row.name && row.name.trim() === '最近多板%');
      if (duobanRow && duobanRow.time930) {
        const time930Value = parseFloat(duobanRow.time930);
        if (!isNaN(time930Value) && time930Value < -1) {
          score += s.jingjiaDie1;
        }
      }
      const dapanRow = currentBidding.find(row => row.name && row.name.trim() === '大盘（%）');
      if (dapanRow && dapanRow.time930) {
        const dapanValue = parseFloat(dapanRow.time930);
        if (!isNaN(dapanValue)) {
          if (dapanValue > 1) {
            score += s.dapanMore1;
          } else if (dapanValue < -1) {
            score += s.dapanLess1;
          } else if (dapanValue <= -0.5) {
            score += s.dapanLess05;
          }
        }
      }
    }
  } catch {}

  return score;
}