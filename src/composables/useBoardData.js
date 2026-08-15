import { reactive, watch, effectScope } from 'vue';
import { getSupabase } from '../data/supabase-client.js';
import { loadEtfBoardByDate, saveEtfBoardRow } from '../data/etf-board-data.js';
import { useUiStore } from '../stores/uiStore.js';
import { showToast, showWarningToast } from './useToast.js';
import { recalcDuibanFromAuction } from '../logic/ui-bridge.js';

const boardState = reactive({
  currentDate: '',
  recentMulti: null,
  earlyEtf: null,
  loadingRecent: false,
  loadingEtf: false,
  savingRecent: false,
  savingEtf: false,
  realtimeReady: false,
  lastError: ''
});

function syncDate() {
  const uiStore = useUiStore();
  if (uiStore.currentDate) boardState.currentDate = uiStore.currentDate;
}

function formatNowIso() {
  return new Date().toISOString();
}

async function loadRecentMulti(date) {
  if (!date) return;
  boardState.loadingRecent = true;
  try {
    const sb = getSupabase();
    const { data, error } = await sb
      .from('recent_multi_data')
      .select('*')
      .eq('date', date)
      .maybeSingle();
    if (error) throw error;
    boardState.recentMulti = data || null;
  } catch (e) {
    boardState.lastError = '最近多板加载失败: ' + (e.message || e);
    console.warn('[Board] loadRecentMulti error:', e);
  } finally {
    boardState.loadingRecent = false;
  }
}

async function loadEarlyEtf(date) {
  if (!date) return;
  boardState.loadingEtf = true;
  try {
    const row = await loadEtfBoardByDate(date);
    if (row === null) {
      // 读取失败或确实无数据：仅记录；若确为「无数据」才置空，若疑似异常则保留 boardState.earlyEtf 原值（§11 不要把读取失败伪装成空去触发删除）
      console.warn('[Board] loadEarlyEtf 无数据或失败 date=' + date);
      boardState.earlyEtf = row; // row 为 null 表示云端确实没有该日期
    } else {
      boardState.earlyEtf = row;
    }
  } catch (e) {
    console.warn('[Board] loadEarlyEtf error:', e);
  } finally {
    boardState.loadingEtf = false;
  }
}

async function saveRecentMulti(payload) {
  const date = boardState.currentDate;
  if (!date) return { error: '无当前日期' };
  boardState.savingRecent = true;
  try {
    const sb = getSupabase();
    const row = {
      date,
      shuliang: payload.shuliang || '',
      die_count: payload.die_count ?? null,
      zhang_count: payload.zhang_count ?? null,
      die_zhangbi: payload.die_zhangbi || '',
      jingtu: payload.jingtu || '',
      tushi: payload.tushi || '',
      comment: payload.comment || '',
      updated_at: formatNowIso()
    };
    const { data, error } = await sb
      .from('recent_multi_data')
      .upsert(row, { onConflict: 'date' })
      .select()
      .single();
    if (error) throw error;
    if (data && data.tushi !== row.tushi) {
      await sb.from('recent_multi_data').update({ tushi: row.tushi, updated_at: row.updated_at }).eq('date', date);
      data.tushi = row.tushi;
    }
    boardState.recentMulti = data;
    return { data, error: null };
  } catch (e) {
    boardState.lastError = '最近多板保存失败: ' + (e.message || e);
    return { error: e };
  } finally {
    boardState.savingRecent = false;
  }
}

async function saveEarlyEtf(payload) {
  const date = boardState.currentDate;
  if (!date) return { error: '无当前日期' };
  boardState.savingEtf = true;
  try {
    const { ok, error, data } = await saveEtfBoardRow({
      date,
      shuliang: payload.shuliang,
      die_count: payload.die_count,
      zhang_count: payload.zhang_count,
      die_zhangbi: payload.die_zhangbi,
      jingtu: payload.jingtu,
      tushi: payload.tushi,
      comment: payload.comment,
      sector_etf_close: payload.sector_etf_close ?? boardState.earlyEtf?.sector_etf_close ?? null,
      sector_etf_synced_at: payload.sector_etf_synced_at ?? boardState.earlyEtf?.sector_etf_synced_at ?? null
    });
    if (ok && data) boardState.earlyEtf = data;
    return { data: ok ? data : null, error: ok ? null : error };
  } catch (e) {
    boardState.lastError = 'ETF 保存失败: ' + (e.message || e);
    return { error: e };
  } finally {
    boardState.savingEtf = false;
  }
}

let _dateWatchStarted = false;
// §6 自愈：切换到某日期时，若该日期的「最近多板 / 早盘ETF」统计行缺失（云端确无记录），
// 但早盘竞价股票列表已存在，则自动推导并写回，使看板无需手动统计即自动填充。
// 拍卖数据可能为异步加载，首次检查为空时做有限次延迟重试（避免 race 导致永远不统计）。
async function maybeAutoRecalc(date, attempt = 0) {
  if (!date) return;
  // 自动统计语义：看板数值由「竞价列表（正式成员）/ 板块ETF 收盘」源数据推导，非人工长期维护。
  // 每次切到该日期都重新推导并写回（覆盖旧值），使 8/13(87→76)/8/14 等历史错误值自愈。
  // 源数据为空（attempt 内重试仍空）时不写回、不覆盖（§11）；源存在则覆盖，让错误值被修正。
  const res = await recalcDuibanFromAuction(date).catch((e) => {
    console.warn('[Board] 自动统计失败:', e && e.message);
    return null;
  });
  if (res) {
    // 仅当仍是当前日期才回写，避免快速切日期时把旧日期结果误写入新日期的 boardState
    if (boardState.currentDate === date) {
      if (res.recentMulti) boardState.recentMulti = res.recentMulti;
      if (res.earlyEtf) boardState.earlyEtf = res.earlyEtf;
    }
    return;
  }
  // res 为 null 表示当日竞价列表为空（可能尚未加载完），有限重试
  if (attempt < 2) {
    setTimeout(() => {
      if (boardState.currentDate === date) maybeAutoRecalc(date, attempt + 1);
    }, 500 * (attempt + 1));
  }
}

// 切换日期的统一入口（§6 自愈 + 修复切日期空白 + 历史错误值自愈）：
// 1. 先清空上一切换残留的 boardState（根因：stale 旧日期值让 guard 误判「已存在」而跳过新日期的自动统计，导致 8/14 空白）；
// 2. 等云端该日期数据加载完毕；
// 3. 再触发自动推导：源数据存在则覆盖写回（修正 8/13 的 87/41 等错误值），缺失才留空（§11）。
async function onDateChanged(date) {
  if (!date) return;
  boardState.recentMulti = null;
  boardState.earlyEtf = null;
  await loadRecentMulti(date);
  await loadEarlyEtf(date);
  await maybeAutoRecalc(date);
}

function ensureDateWatch() {
  if (_dateWatchStarted) return;
  _dateWatchStarted = true;
  const uiStore = useUiStore();
  // 用 detached scope 创建全局 watcher：本 hub 是全应用共享的单一数据源，
  // 若在组件 setup 内创建的 watch 会绑定到首个调用组件的 effect scope，
  // 该组件卸载后 watcher 被销毁，而 _dateWatchStarted 守卫阻止重建，
  // 导致后续日期切换不再触发重载（boardState 卡死为空直到手动刷新）。
  const scope = effectScope(true);
  scope.run(() => {
    watch(() => uiStore.currentDate, (val) => {
      if (val && val !== boardState.currentDate) {
        boardState.currentDate = val;
        onDateChanged(val);
      }
    });
  });
  if (uiStore.currentDate) {
    boardState.currentDate = uiStore.currentDate;
    onDateChanged(uiStore.currentDate);
  }
}

export function useBoardData() {
  ensureDateWatch();
  return {
    boardState,
    loadRecentMulti,
    loadEarlyEtf,
    saveRecentMulti,
    saveEarlyEtf,
    toast: showToast,
    warnToast: showWarningToast,
  };
}