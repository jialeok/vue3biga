// data/supabase-write.js — Supabase 读写
import { CONFIG } from '../config.js';

export function sbHeaders(env) {
  return {
    'apikey': env.SUPABASE_ANON_KEY,
    'Authorization': 'Bearer ' + env.SUPABASE_ANON_KEY,
    'Content-Type': 'application/json',
  };
}

export async function upsertBiddingRows(env, rows) {
  const url = CONFIG.SUPABASE_URL + '/rest/v1/bidding_data?on_conflict=date%2Cname';
  const resp = await fetch(url, {
    method: 'POST',
    headers: Object.assign(sbHeaders(env), { 'Prefer': 'resolution=merge-duplicates' }),
    body: JSON.stringify(rows),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error('upsert bidding_data 失败: HTTP ' + resp.status + ' ' + text.slice(0, 300));
  }
}

export async function writeLog(env, entry) {
  try {
    await fetch(CONFIG.SUPABASE_URL + '/rest/v1/bidding_fetch_log', {
      method: 'POST',
      headers: Object.assign(sbHeaders(env), { 'Prefer': 'return=minimal' }),
      body: JSON.stringify(entry),
    });
  } catch (e) { console.error('写 bidding_fetch_log 失败（已忽略）:', e.message); }
}

export async function updateJiwangShouguJieguo(env, date, stats) {
  const shouguJieguo = stats.down + ':' + stats.up;
  const url = CONFIG.SUPABASE_URL + '/rest/v1/' + CONFIG.JIWANG_TABLE;
  const body = { date: date, shouguJieguo: shouguJieguo, updated_at: new Date().toISOString() };
  const resp = await fetch(url, {
    method: 'POST',
    headers: Object.assign(sbHeaders(env), {
      'Prefer': 'resolution=merge-duplicates, return=minimal'
    }),
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error('Supabase upsert 失败: HTTP ' + resp.status + ': ' + text.slice(0, 300));
  }
}