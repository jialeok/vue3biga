import { reactive, watch, effectScope } from 'vue';
import { getSupabase } from '../data/supabase-client.js';
import { loadEtfBoardByDate, saveEtfBoardRow } from '../data/etf-board-data.js';
import { useUiStore } from '../stores/uiStore.js';
import { showToast, showWarningToast } from './useToast.js';

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
        loadRecentMulti(val);
        loadEarlyEtf(val);
      }
    });
  });
  if (uiStore.currentDate) {
    boardState.currentDate = uiStore.currentDate;
    loadRecentMulti(uiStore.currentDate);
    loadEarlyEtf(uiStore.currentDate);
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