// numcat-api.js — 猫抓 numcat daily_auc + daily 接口
import { CONFIG } from '../config.js';

export async function numcatDailyAuc(env, symbols, startDateYMD, endDateYMD) {
  // 【FIX 2026-08-03】改用显式 startdate/enddate（YYYYMMDD），不再用 recentdays
  const body = {
    apiname: 'daily_auc',
    apikey: env.NUMCAT_API_KEY,
    fields: 'symbol,name,tradedate,auc_vol,auc_pct_chg,auc_to_pre_vol_pct',
    params: {
      symbols: symbols,
      startdate: startDateYMD,
      enddate: endDateYMD
    }
  };
  const resp = await fetch(CONFIG.NUMCAT_DAILY_AUC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error('numcat daily_auc HTTP ' + resp.status + ': ' + text.slice(0, 200));
  }
  const json = await resp.json();
  if (json.code !== 200) throw new Error('numcat daily_auc 错误: ' + (json.message || JSON.stringify(json)));
  return json.data;
}

export async function numcatDaily(env, symbols, startDateYMD, endDateYMD) {
  const body = {
    apiname: 'daily',
    apikey: env.NUMCAT_API_KEY,
    fields: 'symbol,tradedate,pct_chg',
    params: {
      symbols: symbols,
      startdate: startDateYMD,
      enddate: endDateYMD
    }
  };
  const resp = await fetch(CONFIG.NUMCAT_DAILY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error('numcat daily HTTP ' + resp.status + ': ' + text.slice(0, 200));
  }
  const json = await resp.json();
  if (json.code !== 200) throw new Error('numcat daily 错误: ' + (json.message || JSON.stringify(json)));
  return json.data;
}