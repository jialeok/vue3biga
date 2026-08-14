import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://tonqfgeyxnnwicjopshn.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRvbnFmZ2V5eG5ud2ljam9wc2huIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2NjY3NzEsImV4cCI6MjA5NDI0Mjc3MX0.el-W10JIjr9iQXEKNxV7nLNdhZfOQp6waTY7ZSH27Jg';
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

function getNumericVolume(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === '' || s === '--' || s === '—') return null;
  const n = parseFloat(s);
  if (isNaN(n)) return null;
  return n;
}

function getDigitCount(num) {
  const intPart = Math.floor(Math.abs(num));
  return String(intPart).length;
}

function getPreviousTradingDay(dateStr) {
  const date = new Date(dateStr + 'T00:00:00');
  date.setDate(date.getDate() - 1);
  for (let i = 0; i < 60; i++) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const check = `${y}-${m}-${d}`;
    const dow = new Date(check + 'T00:00:00').getDay();
    if (dow !== 0 && dow !== 6) return check;
    date.setDate(date.getDate() - 1);
  }
  return null;
}

async function pullAllAuctionData() {
  const cloudByDate = {};
  // 1) auction_watchlist
  let offset = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await sb.from('auction_watchlist')
      .select('date,stock,code,volume,yest_volume,note,change_pct,selected,bought,sold,fixed')
      .range(offset, offset + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    data.forEach(row => {
      if (!cloudByDate[row.date]) cloudByDate[row.date] = {};
      const key = (row.stock || '').trim();
      if (!key) return;
      cloudByDate[row.date][key] = {
        stock: row.stock, volume: row.volume || '', yestVolume: row.yest_volume || '',
        changePct: row.change_pct || '', selected: row.selected || false,
        bought: row.bought || false, sold: row.sold || false,
      };
    });
    if (data.length < pageSize) break;
    offset += pageSize;
  }
  // 2) market_metrics scope=auction
  offset = 0;
  while (true) {
    const { data, error } = await sb.from('market_metrics')
      .select('date,stock,volume,yest_volume,change_pct')
      .eq('scope', 'auction')
      .range(offset, offset + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    data.forEach(row => {
      if (!cloudByDate[row.date]) cloudByDate[row.date] = {};
      const key = (row.stock || '').trim();
      if (!key) return;
      const existing = cloudByDate[row.date][key];
      if (existing) {
        if (row.volume && !existing.volume) existing.volume = row.volume;
        if (row.yest_volume && !existing.yestVolume) { existing.yestVolume = row.yest_volume; }
        if (row.change_pct && !existing.changePct) existing.changePct = row.change_pct;
      } else {
        cloudByDate[row.date][key] = {
          stock: row.stock, volume: row.volume || '', yestVolume: row.yest_volume || '',
          changePct: row.change_pct || '',
        };
      }
    });
    if (data.length < pageSize) break;
    offset += pageSize;
  }
  // Convert to arrays
  const result = {};
  for (const date of Object.keys(cloudByDate)) {
    result[date] = Object.values(cloudByDate[date]);
  }
  return result;
}

function getStockHistoryValue(cache, date, stockName, field) {
  const rows = cache[date];
  if (!rows) return null;
  for (const r of rows) {
    if (r && r.stock && r.stock.trim() === stockName) {
      const val = field === 'volume' ? r.volume : field === 'yestVolume' ? r.yestVolume : null;
      return getNumericVolume(val);
    }
  }
  return null;
}

function computeJingYestHighlight(dateStr, fullCache) {
  const todayList = fullCache[dateStr] || [];
  const t1Date = getPreviousTradingDay(dateStr);
  console.log(`\n=== computeJingYestHighlight(${dateStr}) ===`);
  console.log(`T-1 date: ${t1Date}`);
  console.log(`Today list size: ${todayList.length}`);
  console.log(`T-1 cache size: ${fullCache[t1Date] ? fullCache[t1Date].length : 'MISSING'}`);

  // getParallelStocksForDate
  const parallelStocks = new Set();
  todayList.forEach(item => {
    if (!item || !item.stock) return;
    const name = item.stock.trim();
    const todayVolume = getNumericVolume(item.volume);
    const t1OwnVolume = getNumericVolume(item.yestVolume);
    const t1Volume = getStockHistoryValue(fullCache, t1Date, name, 'volume');
    const t2OwnVolume = getStockHistoryValue(fullCache, t1Date, name, 'yestVolume');
    if (todayVolume === null || t1Volume === null) return;
    if (!(todayVolume > t1Volume)) return;
    if (t1OwnVolume === null || t2OwnVolume === null) return;
    if (!(t1OwnVolume > t2OwnVolume)) return;
    parallelStocks.add(name);
  });
  console.log(`Parallel stocks: ${parallelStocks.size} -> ${[...parallelStocks].join(', ')}`);

  // getRatioDiffInfoForDate
  const infoMap = new Map();
  todayList.forEach(item => {
    if (!item || !item.stock) return;
    const name = item.stock.trim();
    const todayVolume = getNumericVolume(item.volume);
    const t1Volume = getStockHistoryValue(fullCache, t1Date, name, 'volume');
    if (todayVolume === null || t1Volume === null || t1Volume === 0) return;
    const jingRatio = todayVolume / t1Volume;
    const yestVolume = getNumericVolume(item.yestVolume);
    const prevVolume = getStockHistoryValue(fullCache, t1Date, name, 'yestVolume');
    if (yestVolume === null || prevVolume === null || prevVolume === 0) return;
    const yestRatio = yestVolume / prevVolume;
    const digitGap = Math.abs(getDigitCount(todayVolume) - getDigitCount(yestVolume));
    infoMap.set(name, { diff: jingRatio - yestRatio, digitGap, jingRatio });
  });
  console.log(`RatioDiff info: ${infoMap.size} stocks`);

  // getJingYestHighlightSetForDate: parallel + diff > 0
  const result = new Set();
  parallelStocks.forEach(name => {
    const info = infoMap.get(name);
    if (info && info.diff > 0) {
      result.add(name);
    }
  });
  console.log(`>>> HIGHLIGHT SET: ${result.size} stocks -> ${[...result].join(', ')}`);
  return result;
}

async function main() {
  console.log('Pulling auction data from Supabase...');
  const fullCache = await pullAllAuctionData();
  console.log('Dates available:', Object.keys(fullCache).sort().join(', '));

  // Compute highlight for 2026-08-12 (same as 8月12日 page blue highlight)
  const hl0812 = computeJingYestHighlight('2026-08-12', fullCache);

  // Compute highlight for 2026-08-11 (same as 8月13日 page observation group's prev day highlight)
  const hl0811 = computeJingYestHighlight('2026-08-11', fullCache);

  // The observation group on 8月13日 = getJingYestHighlightSetForDate('2026-08-12') + obsBought
  console.log('\n=== COMPARISON ===');
  console.log(`8月12日 blue highlight (getJingYestHighlightSetForDate('2026-08-12')): ${hl0812.size} stocks`);
  console.log(`8月13日 observation group source (getJingYestHighlightSetForDate('2026-08-12')): ${hl0812.size} stocks`);
  console.log(`They should be IDENTICAL since both call getJingYestHighlightSetForDate('2026-08-12')`);

  // Also check obsBought
  console.log('\n=== obsBought check ===');
  console.log('obsBought_2026-08-13 (extra stocks in observation group):');
  // We can't read localStorage from Node, but we can check if ensureObservationStocks wrote anything
}

main().catch(e => console.error('Error:', e.message));