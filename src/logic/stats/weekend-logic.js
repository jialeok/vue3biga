// 周末看板日期相关纯函数（Logic 层）。
// 从 WeekendStatsBoard.vue 内联搬出，收口到 Logic 层（架构规范 §4：日期逻辑归属 Logic）。
// 这些函数无副作用、不触碰 Supabase/DOM，仅做日期解析与周区间计算，便于单测与复用。

// 跨浏览器稳健解析；未零填充或无效日期先补正，补正失败返回 null。
// 返回本地时间 Date（按 'T00:00:00' 解析，避免 UTC 偏移导致跨天）。
export function parseLocalDate(s) {
  if (!s) return null;
  let d = new Date(s + 'T00:00:00');
  if (!isNaN(d.getTime())) return d;
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) {
    const norm = `${m[1]}-${String(+m[2]).padStart(2, '0')}-${String(+m[3]).padStart(2, '0')}`;
    d = new Date(norm + 'T00:00:00');
    if (!isNaN(d.getTime())) return d;
  }
  return null;
}

// 返回包含 base 所在「周」的 7 个日期（周六为起点，向前推 6 天到周日），YYYY-MM-DD。
// base 为空或无效时返回空数组（避免遍历出 NaN-NaN-NaN）。
export function getWeekDates(base) {
  const dates = [];
  if (!base) return dates;
  const d = parseLocalDate(base);
  if (!d) return dates;
  const dow = d.getDay();
  const saturday = new Date(d);
  saturday.setDate(d.getDate() + (6 - dow + 7) % 7);
  for (let i = 0; i < 7; i++) {
    const dt = new Date(saturday);
    dt.setDate(saturday.getDate() - i);
    dates.push(formatDate(dt));
  }
  return dates;
}

// 本地日期格式化为 YYYY-MM-DD（Logic 层统一拥有，避免 .vue 内联重复）。
export function formatDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
