// logic/emotion-workflow.js — 情绪看板逻辑
import { CONFIG } from '../config.js';
import { beijingToday, beijingTodayCompact, normalizeDate } from '../../_shared-source/date-utils.js';
import { isTradingDay } from '../data/fuyao-api.js';
import { fetchNumCatEmotionFull, pickEmotionValue, findDateField, sortItemsByDate } from '../data/numcat-api.js';
import { sbHeaders, writeLog } from '../data/supabase-write.js';

export async function runEmotion(env, source, sharedFull) {
  const date = beijingToday();
  const logBase = { run_date: date, time_point: 't0926', source: source || 'cron', job: 'emotion', worker: 'B' };

  if (!(await isTradingDay(env))) {
    await writeLog(env, Object.assign(logBase, { ok: false, detail: { skipped: '非交易日' } }));
    return { ok: false, error: '非交易日，已跳过' };
  }

  let full;
  try {
    full = sharedFull || await fetchNumCatEmotionFull(env);
  } catch (e) {
    await writeLog(env, Object.assign(logBase, { ok: false, detail: { error: e.message } }));
    return { ok: false, error: e.message };
  }

  const fields = full.fields;
  const dateField = findDateField(fields);
  const items = sortItemsByDate(fields, full.items);

  const todayStr = beijingToday();
  const todayCompact = beijingTodayCompact();
  let todayIdx = -1;
  let yesterdayIdx = -1;

  if (dateField) {
    const dateIdx = fields.indexOf(dateField);
    todayIdx = items.findIndex(function (it) {
      const v = String(it[dateIdx] || '').replace(/-/g, '');
      return v === todayStr || v === todayCompact;
    });

    if (todayIdx >= 0) {
      yesterdayIdx = todayIdx > 0 ? todayIdx - 1 : todayIdx;
    } else {
      for (let i = items.length - 1; i >= 0; i--) {
        const v = String(items[i][dateIdx] || '').replace(/-/g, '');
        if (Number(v) < Number(todayCompact)) {
          yesterdayIdx = i;
          break;
        }
      }
      if (yesterdayIdx < 0) yesterdayIdx = items.length - 1;
    }
  }

  if (todayIdx < 0) todayIdx = items.length - 1;
  if (yesterdayIdx < 0) yesterdayIdx = todayIdx > 0 ? todayIdx - 1 : todayIdx;

  const todayItem = items[todayIdx];
  const yesterdayItem = items[yesterdayIdx];

  const metrics = {};
  const missingFields = [];
  for (const key of Object.keys(CONFIG.EMOTION_FIELDS)) {
    const item = key === 'predictVol' ? todayItem : yesterdayItem;
    const val = pickEmotionValue(fields, item, CONFIG.EMOTION_FIELDS[key]);
    metrics[key] = val;
    if (val === null) missingFields.push(key + '(' + CONFIG.EMOTION_FIELDS[key].join('/') + ')');
  }

  let predictVolFallback = false;
  if (metrics.predictVol === null && yesterdayItem) {
    const yPred = pickEmotionValue(fields, yesterdayItem, CONFIG.EMOTION_FIELDS.predictVol);
    if (yPred !== null) {
      metrics.predictVol = yPred;
      predictVolFallback = true;
    }
  }
  metrics.predictVolFallback = predictVolFallback;

  let amountDiff = null;
  const rawAmDiff = pickEmotionValue(fields, yesterdayItem, CONFIG.EMOTION_FIELDS.amountDiff);
  if (rawAmDiff !== null) {
    amountDiff = rawAmDiff / 1e8;
  } else if (yesterdayIdx > 0) {
    const prevItem = items[yesterdayIdx - 1];
    const yestAmount = pickEmotionValue(fields, yesterdayItem, CONFIG.EMOTION_FIELDS.amount);
    const prevAmount = pickEmotionValue(fields, prevItem, CONFIG.EMOTION_FIELDS.amount);
    if (yestAmount !== null && prevAmount !== null) {
      amountDiff = (yestAmount - prevAmount) / 1e8;
    }
  }
  metrics.amountDiff = amountDiff !== null ? Number(amountDiff.toFixed(2)) : null;

  const fiveDays = items.slice(Math.max(0, yesterdayIdx - 4), yesterdayIdx + 1).map(function (item) {
    const row = {};
    for (const key of Object.keys(CONFIG.EMOTION_FIELDS)) {
      row[key] = pickEmotionValue(fields, item, CONFIG.EMOTION_FIELDS[key]);
    }
    if (dateField) {
      const dIdx = fields.indexOf(dateField);
      row._date = normalizeDate(item[dIdx]);
    } else {
      row._date = '';
    }
    return row;
  });

  const url = CONFIG.SUPABASE_URL + '/rest/v1/' + CONFIG.EMOTION_TABLE;
  const body = {
    date: date,
    metrics: metrics,
    five_days: fiveDays,
    api_fields: fields,
    updated_at: new Date().toISOString()
  };

  let writeError = null;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: Object.assign(sbHeaders(env), {
        'Prefer': 'resolution=merge-duplicates, return=minimal'
      }),
      body: JSON.stringify(body)
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error('HTTP ' + resp.status + ': ' + text.slice(0, 300));
    }
  } catch (e) {
    writeError = e.message;
  }

  await writeLog(env, Object.assign(logBase, {
    ok: !writeError,
    detail: {
      todayIdx,
      yesterdayIdx,
      metrics,
      amountDiff,
      missingFields,
      availableFields: fields,
      fiveDaysCount: fiveDays.length,
      writeError
    }
  }));

  return {
    ok: !writeError,
    date,
    metrics,
    amountDiff,
    missingFields,
    availableFields: fields,
    todayDate: todayItem && dateField ? normalizeDate(todayItem[fields.indexOf(dateField)]) : '',
    yesterdayDate: yesterdayItem && dateField ? normalizeDate(yesterdayItem[fields.indexOf(dateField)]) : '',
    fiveDaysCount: fiveDays.length,
    fiveDaysPreview: fiveDays.map(function (d) { return { date: d._date, limitUp: d.limitUp }; }),
    writeError
  };
}

export async function refreshEmotionPredictVol(env, source) {
  const date = beijingToday();
  const logBase = { run_date: date, time_point: 't0926', source: source || 'http', job: 'emotion-refresh', worker: 'B' };

  let full;
  try {
    full = await fetchNumCatEmotionFull(env);
  } catch (e) {
    await writeLog(env, Object.assign(logBase, { ok: false, detail: { error: e.message } }));
    return { ok: false, error: e.message };
  }

  const fields = full.fields;
  const dateField = findDateField(fields);
  const items = sortItemsByDate(fields, full.items);

  const todayStr = beijingToday();
  const todayCompact = beijingTodayCompact();
  let todayIdx = items.length - 1;

  if (dateField) {
    const dateIdx = fields.indexOf(dateField);
    const found = items.findIndex(function (it) {
      const v = String(it[dateIdx] || '').replace(/-/g, '');
      return v === todayStr || v === todayCompact;
    });
    if (found >= 0) {
      todayIdx = found;
    } else {
      for (let i = items.length - 1; i >= 0; i--) {
        const v = String(items[i][dateIdx] || '').replace(/-/g, '');
        if (Number(v) < Number(todayCompact)) {
          todayIdx = i;
          break;
        }
      }
    }
  }

  let predictVol = pickEmotionValue(fields, items[todayIdx], CONFIG.EMOTION_FIELDS.predictVol);
  let predictVolFallback = false;
  if (predictVol === null) {
    const fbItem = items[Math.max(0, todayIdx - 1)];
    const yPred = pickEmotionValue(fields, fbItem, CONFIG.EMOTION_FIELDS.predictVol);
    if (yPred !== null) {
      predictVol = yPred;
      predictVolFallback = true;
    } else {
      await writeLog(env, Object.assign(logBase, { ok: false, detail: { error: '未找到 am_pred 字段' } }));
      return { ok: false, error: 'NumCat 返回中未找到 am_pred 预测量能字段' };
    }
  }

  const readUrl = CONFIG.SUPABASE_URL + '/rest/v1/' + CONFIG.EMOTION_TABLE + '?date=eq.' + encodeURIComponent(date) + '&select=metrics';
  let metrics = {};
  try {
    const readResp = await fetch(readUrl, { headers: sbHeaders(env) });
    if (readResp.ok) {
      const rows = await readResp.json();
      if (rows && rows[0] && rows[0].metrics) metrics = rows[0].metrics;
    }
  } catch (e) {
    console.warn('读取 emotion_data 失败:', e.message);
  }
  metrics.predictVol = predictVol;
  metrics.predictVolFallback = predictVolFallback;

  const updateUrl = CONFIG.SUPABASE_URL + '/rest/v1/' + CONFIG.EMOTION_TABLE + '?date=eq.' + encodeURIComponent(date);
  let writeError = null;
  try {
    const resp = await fetch(updateUrl, {
      method: 'POST',
      headers: Object.assign(sbHeaders(env), {
        'Prefer': 'resolution=merge-duplicates, return=minimal'
      }),
      body: JSON.stringify({ date: date, metrics: metrics, updated_at: new Date().toISOString() })
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error('HTTP ' + resp.status + ': ' + text.slice(0, 300));
    }
  } catch (e) {
    writeError = e.message;
  }

  await writeLog(env, Object.assign(logBase, {
    ok: !writeError,
    detail: { todayIdx, predictVol, predictYi: predictVol / 1e8, writeError }
  }));

  return {
    ok: !writeError,
    date,
    predictVol,
    predictYi: predictVol / 1e8,
    writeError
  };
}