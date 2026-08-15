// Logic 层（§2/§4/§15）：月度日期与聚合纯函数。
// 仅做日期运算与轻量聚合，不碰 Supabase（§5），不直接操作 DOM（§16）。
// 2026-02-01 为统计累计起点（与 MonthlyStatsBoard.totalStats 同源约定）。

// 返回 base 所在自然月的全部日期 YYYY-MM-DD（1 号到月末）
export function getMonthDates(base) {
  if (!base) return [];
  const d = new Date(base + 'T00:00:00');
  if (isNaN(d.getTime())) return [];
  const year = d.getFullYear();
  const month = d.getMonth();
  const lastDay = new Date(year, month + 1, 0).getDate();
  const dates = [];
  for (let i = 1; i <= lastDay; i++) {
    dates.push(`${year}-${String(month + 1).padStart(2, '0')}-${String(i).padStart(2, '0')}`);
  }
  return dates;
}

// 聚合当月「最近多板」记录：读取 jiwangData[date].stats.recentMulti === true 的交易日
// 返回 { name, count, result }[]（count 恒 1，按日期计；如需按股票名聚合可自行扩展）
export function computeDuibanPerformance(jiwangData, dates) {
  const items = [];
  (dates || []).forEach(d => {
    const day = jiwangData && jiwangData[d];
    if (day && day.stats && day.stats.recentMulti === true) {
      items.push({ name: d, count: 1, result: day.chushou || '' });
    }
  });
  return items;
}

function formatDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export { formatDate };
