// logic/seal-workflow.js — 封单家数
import { CONFIG, SEAL_COLUMN } from '../config.js';
import { beijingToday } from '../../_shared-source/date-utils.js';
import { isTradingDay } from '../data/fuyao-api.js';
import { numcatEmoindic } from '../data/numcat-api.js';
import { upsertBiddingRows, writeLog } from '../data/supabase-write.js';

export async function runSeal(env, source) {
  const date = beijingToday();
  const logBase = { run_date: date, time_point: 't0925', source: source || 'cron', job: 'seal', worker: 'B' };

  if (!(await isTradingDay(env))) {
    await writeLog(env, Object.assign(logBase, { ok: false, detail: { skipped: '非交易日' } }));
    return { ok: false, error: '非交易日，已跳过' };
  }

  let sealResult;
  try {
    const numcat = await numcatEmoindic(env);
    const seal = numcat.sealCount;
    if (seal === null || isNaN(seal)) {
      sealResult = { value: null, error: 'NumCat 封单家数字段全部缺失，候选: ' + CONFIG.SEAL_FIELD_CANDIDATES.join(', ') + '，可用字段: ' + numcat.availableFields.join(', ') };
    } else {
      sealResult = { value: String(Math.round(seal)) };
    }
  } catch (e) {
    sealResult = { value: null, error: e.message };
  }

  const now = new Date().toISOString();
  const row = { date: date, name: CONFIG.ROW_SEAL, updated_at: now };
  row[SEAL_COLUMN] = sealResult.value;

  let ok = true, writeError = null;
  if (sealResult.value !== null && sealResult.value !== undefined) {
    try { await upsertBiddingRows(env, [row]); }
    catch (e) { ok = false; writeError = e.message; }
  }
  await writeLog(env, Object.assign(logBase, { ok, detail: { written: sealResult.value !== null ? [row] : [], row: sealResult, writeError } }));
  return { ok, date, point: 't0925-seal', column: SEAL_COLUMN, written: sealResult.value !== null ? [row] : [], row: sealResult, writeError };
}