// date-utils.js — 北京时间日期工具（源文件，各 Worker 复制使用）

export function beijingNow() {
  return new Date(Date.now() + 8 * 3600 * 1000);
}

export function beijingToday() {
  const d = beijingNow();
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}

export function beijingTodayCompact() {
  return beijingToday().replace(/-/g, '');
}

export function normalizeDate(value) {
  if (!value) return '';
  const s = String(value).trim().replace(/-/g, '');
  if (/^\d{8}$/.test(s)) return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return '';
}

export function compactToDateStr(compact) {
  if (!compact) return '';
  const s = String(compact).replace(/-/g, '');
  if (s.length === 8) return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
  return normalizeDate(compact);
}

export function isWeekend(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const day = d.getDay();
  return day === 0 || day === 6;
}

export function msToDateStr(ms) {
  const d = new Date(ms + 8 * 3600 * 1000);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}

export function dateStrToMs(dateStr) {
  return Date.parse(dateStr + 'T00:00:00+08:00');
}
