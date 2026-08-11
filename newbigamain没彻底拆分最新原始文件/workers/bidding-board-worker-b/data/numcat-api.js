// data/numcat-api.js — NumCat 情绪周期接口
import { CONFIG } from '../config.js';
import { normalizeDate, beijingToday } from '../../_shared-source/date-utils.js';

export async function fetchNumCatEmotionFull(env) {
  const resp = await fetch(CONFIG.NUMCAT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apiname: CONFIG.NUMCAT_APINAME,
      apikey: env.NUMCAT_API_KEY,
      params: { recentdays: CONFIG.NUMCAT_RECENT_DAYS }
    })
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error('NumCat API HTTP ' + resp.status + ': ' + text.slice(0, 200));
  }
  const json = await resp.json();
  if (json.code !== 200) throw new Error('NumCat API 错误: ' + (json.message || JSON.stringify(json)));
  const fields = json.data.fields;
  const items = json.data.items;
  if (!Array.isArray(fields) || !Array.isArray(items) || items.length === 0) {
    throw new Error('NumCat API 返回数据格式异常');
  }
  return { fields, items };
}

export async function numcatEmoindic(env) {
  const { fields, items } = await fetchNumCatEmotionFull(env);
  const latest = findTodayItem(fields, items);
  if (!latest) {
    throw new Error('NumCat 情绪周期接口未找到今日数据，可用日期字段: ' + fields.join(', '));
  }
  const sealCount = pickEmotionValue(fields, latest, CONFIG.SEAL_FIELD_CANDIDATES);
  if (sealCount === null) {
    throw new Error('NumCat 封单家数字段全部缺失，候选: ' + CONFIG.SEAL_FIELD_CANDIDATES.join(', ') + '，可用字段: ' + fields.join(', '));
  }
  return { sealCount: sealCount, availableFields: fields };
}

export function pickEmotionValue(fields, item, candidates) {
  for (const name of candidates) {
    const idx = fields.indexOf(name);
    if (idx >= 0) {
      const v = item[idx];
      if (v !== null && v !== undefined && v !== '') return Number(v);
    }
  }
  return null;
}

export function findDateField(fields) {
  return ['tradedate', 'trade_date', 'trading_day', 'date'].find(name => fields.indexOf(name) >= 0);
}

export function sortItemsByDate(fields, items) {
  const dateField = findDateField(fields);
  if (!dateField) return items.slice();
  const idx = fields.indexOf(dateField);
  return items.slice().sort(function (a, b) {
    const da = String(a[idx] || '').replace(/-/g, '');
    const db = String(b[idx] || '').replace(/-/g, '');
    return Number(da) - Number(db);
  });
}

export function findLatestItemIndex(fields, items) {
  const sorted = sortItemsByDate(fields, items);
  return { sorted, index: sorted.length - 1 };
}

export function findTodayItem(fields, items) {
  const sorted = sortItemsByDate(fields, items);
  if (sorted.length === 0) return null;
  const dateField = findDateField(fields);
  if (!dateField) return sorted[sorted.length - 1];
  const idx = fields.indexOf(dateField);
  const today = beijingToday();
  for (let i = sorted.length - 1; i >= 0; i--) {
    const itemDate = normalizeDate(sorted[i][idx]);
    if (itemDate === today) return sorted[i];
  }
  return null;
}

export function buildJiwangStats(fields, items) {
  const latest = findTodayItem(fields, items);
  const upIdx = fields.indexOf('s2');
  const downIdx = fields.indexOf('s6');
  if (upIdx < 0 || downIdx < 0) throw new Error('NumCat API 响应缺少 s2/s6 字段，可用字段: ' + fields.join(', '));
  return { up: Number(latest[upIdx]), down: Number(latest[downIdx]) };
}

export async function fetchNumCatMarketStats(env) {
  const { fields, items } = await fetchNumCatEmotionFull(env);
  return buildJiwangStats(fields, items);
}