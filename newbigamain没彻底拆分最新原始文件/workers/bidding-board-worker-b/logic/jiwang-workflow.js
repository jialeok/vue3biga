// logic/jiwang-workflow.js — 记忘看板 + 收盘主流程
import { beijingToday } from '../../_shared-source/date-utils.js';
import { isTradingDay, getNextTradingDay } from '../data/fuyao-api.js';
import { fetchNumCatEmotionFull, buildJiwangStats, fetchNumCatMarketStats } from '../data/numcat-api.js';
import { writeLog, updateJiwangShouguJieguo } from '../data/supabase-write.js';
import { runEmotion } from './emotion-workflow.js';

export async function runJiwang(env, source, sharedFull) {
  const date = beijingToday();
  const logBase = { run_date: date, time_point: 'close', source: source || 'cron', job: 'jiwang', worker: 'B' };

  if (!(await isTradingDay(env))) {
    await writeLog(env, Object.assign(logBase, { ok: false, detail: { skipped: '非交易日' } }));
    return { ok: false, error: '非交易日，已跳过' };
  }

  try {
    const stats = sharedFull
      ? buildJiwangStats(sharedFull.fields, sharedFull.items)
      : await fetchNumCatMarketStats(env);
    const nextTradingDay = await getNextTradingDay(env, date);
    await updateJiwangShouguJieguo(env, nextTradingDay, stats);
    await writeLog(env, Object.assign(logBase, { ok: true, detail: { today: date, nextTradingDay, stats } }));
    return { ok: true, today: date, nextTradingDay, stats };
  } catch (e) {
    await writeLog(env, Object.assign(logBase, { ok: false, detail: { error: e.message } }));
    return { ok: false, error: e.message };
  }
}

export async function runClose(env, source) {
  let sharedFull = null;
  let sharedFullError = null;
  try {
    sharedFull = await fetchNumCatEmotionFull(env);
  } catch (e) {
    sharedFullError = e.message;
  }

  const jiwangPromise = sharedFull
    ? runJiwang(env, source, sharedFull)
    : Promise.resolve({ ok: false, error: 'NumCat 共享接口失败: ' + sharedFullError });

  const emotionPromise = sharedFull
    ? runEmotion(env, source, sharedFull)
    : Promise.resolve({ ok: false, error: 'NumCat 共享接口失败: ' + sharedFullError });

  const [jiwangResult, emotionResult] = await Promise.allSettled([
    jiwangPromise,
    emotionPromise
  ]);

  return {
    ok: (jiwangResult.status === 'fulfilled' && jiwangResult.value.ok) &&
        (emotionResult.status === 'fulfilled' && emotionResult.value.ok),
    jiwang: jiwangResult.status === 'fulfilled' ? jiwangResult.value : { ok: false, error: jiwangResult.reason?.message },
    emotion: emotionResult.status === 'fulfilled' ? emotionResult.value : { ok: false, error: emotionResult.reason?.message },
    sharedFullError
  };
}