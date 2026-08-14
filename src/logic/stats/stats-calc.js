// 统计看板业务规则（盈亏/胜率/聚合）—— 从 WeekendStatsBoard / MonthlyStatsBoard 抽出，
// 避免业务规则内联在 .vue（违反架构规范 §3.1 / §4）。
// 读取统一走 Data 层 getter（getStocksData / getJiwangData / getEtfData / getRankData），
// 这些 getter 内部读 state._xxxMemCache；state 经 WX-01 改为 reactive 后，
// 在本文件函数内读取会被 Vue computed 自动追踪，数据刷新时看板自动重算。
import { getStocksData, getJiwangData, getEtfData } from '../../data/supabase-client.js';
import { getRankData } from '../app-core.js';
import { isTradingDay } from '../trading-day-helpers.js';

export function computeStats(dates) {
  const r = {
    totalProfit: 0, totalLoss: 0, balance: 0,
    tradingDays: 0, emptyCount: 0, chushouCount: 0,
    emptyRight: 0, emptyWrong: 0, chushouRight: 0, chushouWrong: 0,
    emptyWinRate: 0, chushouWinRate: 0,
  };
  const stocksData = getStocksData();
  const jiwangData = getJiwangData();
  dates.forEach(d => {
    if (isTradingDay(d)) {
      r.tradingDays++;
      const dayJiwang = jiwangData[d];
      if (dayJiwang) {
        if (dayJiwang.jielun === '空仓') r.emptyCount++;
        else if (dayJiwang.jielun === '出手') r.chushouCount++;
        if (dayJiwang.chushou === '空仓对了') r.emptyRight++;
        else if (dayJiwang.chushou === '空仓错了') r.emptyWrong++;
        else if (dayJiwang.chushou === '出手对了') r.chushouRight++;
        else if (dayJiwang.chushou === '出手错了') r.chushouWrong++;
      }
    }
    const list = stocksData[d] || [];
    list.forEach(s => {
      if (s.soldRecords) {
        s.soldRecords.forEach(rec => {
          const p = parseFloat(rec.profit) || 0;
          if (p >= 0) r.totalProfit += p;
          else r.totalLoss += Math.abs(p);
        });
      }
    });
  });
  r.balance = r.totalProfit - r.totalLoss;
  r.emptyWinRate = r.emptyRight + r.emptyWrong > 0 ? Math.round(r.emptyRight / (r.emptyRight + r.emptyWrong) * 100) : 0;
  r.chushouWinRate = r.chushouRight + r.chushouWrong > 0 ? Math.round(r.chushouRight / (r.chushouRight + r.chushouWrong) * 100) : 0;
  return r;
}

export function computeTopStocks(dates) {
  const rankData = getRankData() || {};
  const counts = {};
  dates.forEach(d => {
    const dayRank = rankData[d];
    if (dayRank && Array.isArray(dayRank)) {
      dayRank.forEach(item => {
        if (item.stock) counts[item.stock] = (counts[item.stock] || 0) + 1;
      });
    }
  });
  return Object.entries(counts).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 10);
}

export function computeTopEtfs(dates) {
  const etfData = getEtfData() || {};
  const counts = {};
  dates.forEach(d => {
    const dayEtf = etfData[d];
    if (dayEtf && Array.isArray(dayEtf)) {
      dayEtf.forEach(item => {
        if (item.name) counts[item.name] = (counts[item.name] || 0) + 1;
      });
    }
  });
  return Object.entries(counts).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 10);
}

export function computeRecordStats(dates) {
  const jiwangData = getJiwangData();
  let duibanCount = 0, topicCount = 0, etfCount = 0;
  let duibanRight = 0, topicRight = 0, etfRight = 0;
  dates.forEach(d => {
    const dayJiwang = jiwangData[d];
    if (!dayJiwang) return;
    const st = dayJiwang.stats || {};
    const isRight = dayJiwang.chushou === '空仓对了' || dayJiwang.chushou === '出手对了';
    if (st.recentMulti === true) { duibanCount++; if (isRight) duibanRight++; }
    if (st.topicDirection === true) { topicCount++; if (isRight) topicRight++; }
    if (st.sectorEtf === true) { etfCount++; if (isRight) etfRight++; }
  });
  return {
    duibanCount, topicCount, etfCount,
    duibanWinRate: duibanCount > 0 ? Math.round(duibanRight / duibanCount * 100) : 0,
    topicWinRate: topicCount > 0 ? Math.round(topicRight / topicCount * 100) : 0,
    etfWinRate: etfCount > 0 ? Math.round(etfRight / etfCount * 100) : 0,
  };
}

// 构建 TrendChart 所需的 points：{ date, value }（按时间升序）
export function buildProfitPoints(getDates) {
  const dates = getDates();
  const stocksData = getStocksData();
  const profitPoints = [];
  const balancePoints = [];
  let cum = 0;
  dates.slice().reverse().forEach(d => {
    let dayProfit = 0;
    (stocksData[d] || []).forEach(s => {
      (s.soldRecords || []).forEach(r => { dayProfit += parseFloat(r.profit) || 0; });
    });
    profitPoints.push({ date: d, value: dayProfit });
    cum += dayProfit;
    balancePoints.push({ date: d, value: cum });
  });
  return { profitPoints, balancePoints };
}
