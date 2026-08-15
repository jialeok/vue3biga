// 统计看板业务规则（盈亏/胜率/聚合）—— 从 WeekendStatsBoard / MonthlyStatsBoard 抽出，
// 避免业务规则内联在 .vue（违反架构规范 §3.1 / §4）。
// 读取统一走 Data 层 getter（getStocksData / getJiwangData / getEtfBoardData / getRankData），
// 这些 getter 内部读 state._xxxMemCache；state 经 WX-01 改为 reactive 后，
// 在本文件函数内读取会被 Vue computed 自动追踪，数据刷新时看板自动重算。
// 注意（周末/月统计「没有数据」根因修复）：每日盈亏与账户余额的权威来源是
// jiwang_data.stats（StatsBoard 圆形统计经 §S-01 writeStats 写入），而非 stocks 表的
// soldRecords（该表在云端已不存在，getStocksData 读不到任何盈亏）。故 computeStats /
// buildProfitPoints 优先读 jiwang.stats.profit / stats.balance，soldRecords 仅作空值回退。
import { getStocksData, getJiwangData } from '../../data/supabase-client.js';
import { getEtfBoardData } from '../../data/etf-board-data.js';
import { getRankData } from '../app-core.js';
import { isTradingDay } from '../trading-day-helpers.js';

export function computeStats(dates) {
  const r = {
    totalProfit: 0, totalLoss: 0, balance: 0,
    tradingDays: 0, emptyCount: 0, chushouCount: 0,
    emptyRight: 0, emptyWrong: 0, chushouRight: 0, chushouWrong: 0,
    emptyWinRate: 0, chushouWinRate: 0,
  };
  // 防御：getStocksData / getJiwangData 在分区分支下 _xxxMemCache 未初始化前，
  // state.allData[key] 可能短暂为 undefined；统一兜底为 {}，避免 xxx[d] 抛
  // "Cannot read properties of undefined"（§10：不得让读取失败伪装成异常崩溃）。
  const stocksData = getStocksData() || {};
  const jiwangData = getJiwangData() || {};
  let latestBalance = null; // 区间内最新的账户余额快照（stats.balance）
  dates.forEach(d => {
    // [W-BLANK-FIX] dayJiwang 提升到 forEach 块顶部：非交易日（周六/周日）也会走到下方 dayStats
    // 计算，若声明在 if 块内会触发 TDZ ReferenceError，使 computeStats 抛错、整页渲染失败（空白根因）。
    const dayJiwang = jiwangData[d];
    if (isTradingDay(d)) {
      r.tradingDays++;
      if (dayJiwang) {
        if (dayJiwang.jielun === '空仓') r.emptyCount++;
        else if (dayJiwang.jielun === '出手') r.chushouCount++;
        if (dayJiwang.chushou === '空仓对了') r.emptyRight++;
        else if (dayJiwang.chushou === '空仓错了') r.emptyWrong++;
        else if (dayJiwang.chushou === '出手对了') r.chushouRight++;
        else if (dayJiwang.chushou === '出手错了') r.chushouWrong++;
      }
    }
    // 每日盈亏：优先 jiwang.stats.profit（StatsBoard 圆形统计记录的当日盈亏，§S-01 权威源），
    // 仅当该字段为空时回退到个股卖出记录 soldRecords.profit（避免双源重复累加，§6 数据保全）。
    const dayStats = (dayJiwang && dayJiwang.stats) || null;
    let dayProfit = 0;
    const jpRaw = dayStats ? dayStats.profit : undefined;
    if (jpRaw !== undefined && jpRaw !== null && jpRaw !== '') {
      dayProfit += parseFloat(jpRaw) || 0;
    } else {
      (stocksData[d] || []).forEach(s => {
        (s.soldRecords || []).forEach(rec => { dayProfit += parseFloat(rec.profit) || 0; });
      });
    }
    if (dayProfit > 0) r.totalProfit += dayProfit;
    else if (dayProfit < 0) r.totalLoss += Math.abs(dayProfit);
    // 账户余额：取区间内最新的 stats.balance（该日缺失则不更新 latestBalance）
    if (dayStats && dayStats.balance !== undefined && dayStats.balance !== null && dayStats.balance !== '') {
      const b = parseFloat(dayStats.balance);
      if (!isNaN(b)) latestBalance = b;
    }
  });
  r.balance = latestBalance !== null ? latestBalance : (r.totalProfit - r.totalLoss);
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
  const etfData = getEtfBoardData() || {};
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
  const jiwangData = getJiwangData() || {};
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
// 每日盈亏来自 jiwang.stats.profit（§S-01 权威源，soldRecords 仅作回退）；
// 账户余额曲线来自 jiwang.stats.balance，按时间顺序 carry-forward 最近一次已知余额。
export function buildProfitPoints(getDates) {
  const dates = getDates();
  const stocksData = getStocksData() || {};
  const jiwangData = getJiwangData() || {};
  const profitPoints = [];
  const balancePoints = [];
  const asc = dates.slice().reverse();
  // 先定位区间内首个有效余额，作为 carry-forward 起点，避免曲线从 0 起跳
  let lastBalance = null;
  for (const d of asc) {
    const st = (jiwangData[d] && jiwangData[d].stats) || null;
    if (st && st.balance !== undefined && st.balance !== null && st.balance !== '') {
      const b = parseFloat(st.balance);
      if (!isNaN(b)) { lastBalance = b; break; }
    }
  }
  if (lastBalance === null) lastBalance = 0;
  asc.forEach(d => {
    const dayJiwang = jiwangData[d];
    const dayStats = (dayJiwang && dayJiwang.stats) || null;
    let dayProfit = 0;
    const jpRaw = dayStats ? dayStats.profit : undefined;
    if (jpRaw !== undefined && jpRaw !== null && jpRaw !== '') {
      dayProfit += parseFloat(jpRaw) || 0;
    } else {
      (stocksData[d] || []).forEach(s => {
        (s.soldRecords || []).forEach(r => { dayProfit += parseFloat(r.profit) || 0; });
      });
    }
    profitPoints.push({ date: d, value: dayProfit });
    if (dayStats && dayStats.balance !== undefined && dayStats.balance !== null && dayStats.balance !== '') {
      const b = parseFloat(dayStats.balance);
      if (!isNaN(b)) lastBalance = b;
    }
    balancePoints.push({ date: d, value: lastBalance });
  });
  return { profitPoints, balancePoints };
}
