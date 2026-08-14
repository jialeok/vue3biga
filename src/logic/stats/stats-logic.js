/**
 * stats-logic.js — StatsBoard 圆形统计 / 评论的受控读写层（§2 / §6）。
 *
 * 历史问题（S-01 红线）：StatsBoard 直接对 allData.jiwang[date].stats 做原地写，
 * 绕过 Logic 层。本模块作为 Logic 层统一出口：
 *   - readStats(date)            受控读取（含惰性初始化），返回 jiwang 缓存下的 stats 对象引用；
 *   - writeStats(date, patch, msg) 受控局部写入 + 标记脏 + 落盘 + 推送云端，
 *     失败必须可见（toast + 抛出），满足 §10 保存错误红线。
 *
 * 说明：
 * - jiwang 仍是内存缓存别名（§6，非真相源）；真正的持久化由 Data 层（jiwang_data 表）
 *   经 pushJiwangNow 完成。UI 不再直接触碰 allData.jiwang。
 * - 读取路径 getJiwangData() 返回内存缓存引用，已在 supabase-client 内做 500ms 短路
 *   与 _xxxMemCache 引用稳定化，避免 S-03 的重复 loadAllData 重建。
 */
import { getJiwangData } from '../../data/supabase-client.js';
import { markJiwangDirty, saveData } from '../app-core.js';
import { pushJiwangNow } from '../../data/jiwang-data.js';
import { showToast } from '../../composables/useToast.js';

// 受控读取：返回指定日期 stats 对象（缺失则惰性初始化，仍落在 jiwang 缓存下）
export function readStats(date) {
  const jiwang = getJiwangData();
  if (!jiwang[date]) jiwang[date] = {};
  if (!jiwang[date].stats) jiwang[date].stats = {};
  return jiwang[date].stats;
}

// 受控写入：局部 patch，标记脏 + 落盘 + 推送云端；失败必须可见（§10）。
export async function writeStats(date, patch, successMsg) {
  if (!date) {
    const msg = '统计保存失败：当前日期为空';
    showToast('⚠️ ' + msg);
    throw new Error(msg);
  }
  if (!patch || typeof patch !== 'object') {
    const msg = '统计保存失败：缺少写入字段';
    showToast('⚠️ ' + msg);
    throw new Error(msg);
  }
  const stats = readStats(date);
  Object.assign(stats, patch);
  markJiwangDirty(date);
  try {
    saveData();
  } catch (e) {
    showToast('⚠️ 统计本地保存失败：' + (e && e.message ? e.message : e));
    throw e;
  }
  try {
    await pushJiwangNow(date, successMsg);
  } catch (e) {
    // pushJiwangNow 内部已 toast 云端失败；此处向上抛出以便调用方感知（§10 不得静默）。
    throw e;
  }
}
