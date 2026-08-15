// useBiddingBoard.js — 竞价变化看板组合式逻辑
// 物理重组自 BiddingBoard.vue 的 <script setup>：reactive/ref 与共享方法统一打包，
// 供根组件 provide 后由子组件 inject 使用。逻辑/样式表现保持与迁移前完全一致。
import { ref, watch, onMounted, onUnmounted, computed } from 'vue';
import { useUiStore } from '../stores/uiStore.js';
import { _on, _off } from '../stores/eventBus.js';
import { getBiddingData, getJiwangData, getBiddingDirtyDates, getBiddingPushInFlight } from '../data/supabase-client.js';
import { BIDDING_ROW_ORDER, getDefaultBiddingTemplate, orderBiddingRows, pushBiddingToCloud, syncBiddingDeletionsToCloud, deleteBiddingFromCloud, fetchBiddingCloudRows } from '../data/bidding-data.js';
import { saveData, markJiwangDirty } from '../logic/app-core.js';
import { _dbgLog } from '../data/debug-log.js';
import { showToast, showWarningToast } from '../composables/useToast.js';
import { renderCircleStats, autoCalculateConsecutiveDays } from '../logic/jiwang/helpers.js';
import { renderConsecutiveUp } from '../logic/tagTitles/helpers.js';
import { syncBiddingCloseToEtf, syncSectorEtfZhangNum, syncJiwangKxianFromBidding, autoTagShunshiNishi, fetchBiddingSnapshotToForm, autoCalculateRecentMultiScore } from '../logic/bidding/helpers.js';

export function useBiddingBoard() {
  const uiStore = useUiStore();

  const modalActive = ref(false);
  const biddingRows = ref([]);
  const editRows = ref([]);

  const fetchStatus = ref('');
  const fetchLoading = ref(false);
  const saving = ref(false);
  const clearing = ref(false);
  const clearConfirmActive = ref(false);
  const expanded = ref(false);

  const visibleBiddingRows = computed(() => biddingRows.value.filter(r => r.name !== '最近多板%time26'));

  const time26Change = computed(() => {
    const row = biddingRows.value.find(r => r.name === '最近多板%time26');
    return row ? (row.change || '') : '';
  });

  function duibanTime925Class(row) {
    if (row.name !== '最近多板%') return '';
    if (time26Change.value === '增') return 'up';
    if (time26Change.value === '减') return 'down';
    return '';
  }

  function toggleExpand(e) {
    if (e) e.stopPropagation();
    expanded.value = !expanded.value;
  }

  function changeClass(v) {
    if (!v) return '';
    const n = parseFloat(v);
    if (isNaN(n)) return '';
    return n > 0 ? 'up' : (n < 0 ? 'down' : '');
  }

  // 增减列样式（迁移自老版 boards-bidding.js:614-621）：增=红加粗、减=绿、平=深灰加粗
  function changeTagClass(v) {
    if (v === '增') return 'tag-up';
    if (v === '减') return 'tag-down';
    if (v === '平') return 'tag-flat';
    return '';
  }

  // 增减逻辑（迁移自老版 boards-bidding.js:1141-1156 / 当前 onInputChange）：9:25 与 9:20 比较
  function computeChange(time920, time925) {
    const t920 = parseFloat(time920);
    const t930 = parseFloat(time925);
    if (time920 && time920.toString().trim() && time925 && time925.toString().trim() && !isNaN(t920) && !isNaN(t930)) {
      if (t930 > t920) return '增';
      if (t930 < t920) return '减';
      return '平';
    }
    return '';
  }

  // 最近多板%time26 行增减：自身 time925 与上方"最近多板%"行的 time925 比较
  function computeTime26Change(time26Row, duibanRow) {
    if (!time26Row || !duibanRow) return '';
    const t925 = parseFloat(duibanRow.time925);
    const t26 = parseFloat(time26Row.time925);
    if (duibanRow.time925 && duibanRow.time925.toString().trim() &&
        time26Row.time925 && time26Row.time925.toString().trim() &&
        !isNaN(t925) && !isNaN(t26)) {
      if (t26 > t925) return '增';
      if (t26 < t925) return '减';
      return '平';
    }
    return '';
  }

  function formatPercent(v) {
    if (!v && v !== 0) return '-';
    const n = parseFloat(v);
    if (isNaN(n)) return v;
    return n + '%';
  }

  // 收盘列单位：昨日资金前十 / 板块ETF 类为「红盘家数」，单位用「红」而非「%」；其余行沿用 %（当前逻辑正确）。
  function formatClose(v, name) {
    if (!v && v !== 0) return '-';
    if (name === '昨日资金前十' || (name && name.indexOf('板块ETF') === 0)) {
      const n = parseFloat(v);
      return (isNaN(n) ? v : n) + '红';
    }
    return formatPercent(v);
  }

  function getTodayBidding() {
    const biddingData = getBiddingData();
    const existing = biddingData[uiStore.currentDate];
    const existingMap = new Map();
    if (Array.isArray(existing)) {
      existing.forEach(r => {
        if (r && r.name) existingMap.set(r.name.toString().trim(), r);
      });
    }
    return BIDDING_ROW_ORDER.map(name => {
      const row = existingMap.get(name);
      if (!row) return { name, time915: '', time920: '', time925: '', change: '', close: '' };
      return {
        name,
        time915: row.time915 || '',
        time920: row.time920 || '',
        time925: row.time925 || '',
        change: row.change || '',
        close: row.close || ''
      };
    });
  }

  function render() {
    biddingRows.value = getTodayBidding();
  }

  function openEdit() {
    const rows = getTodayBidding().map(r => {
      const copied = { ...r };
      copied.change = computeChange(copied.time920, copied.time925);
      return copied;
    });
    const duibanRow = rows.find(r => r.name === '最近多板%');
    rows.forEach(r => {
      if (r.name === '最近多板%time26') r.change = computeTime26Change(r, duibanRow);
    });
    editRows.value = rows;
    saving.value = false;
    modalActive.value = true;
  }

  function closeModal() { modalActive.value = false; }

  function onInputChange(row) {
    row._touched = true;

    if (row.name === '最近多板%time26') {
      const duibanRow = editRows.value.find(r => r.name === '最近多板%');
      row.change = computeTime26Change(row, duibanRow);
    } else {
      row.change = computeChange(row.time920, row.time925);
      if (row.name === '最近多板%') {
        const time26Row = editRows.value.find(r => r.name === '最近多板%time26');
        if (time26Row) time26Row.change = computeTime26Change(time26Row, row);
      }
    }

    syncBiddingCloseToEtf(row);

    if (row.name === '账号溢价') {
      const jiwangData = getJiwangData();
      if (!jiwangData[uiStore.currentDate]) jiwangData[uiStore.currentDate] = {};
      if (!jiwangData[uiStore.currentDate].stats) jiwangData[uiStore.currentDate].stats = {};
      const stats = jiwangData[uiStore.currentDate].stats;
      if (row.close && row.close.toString().trim() !== '') {
        const profitNum = parseFloat(row.close.toString().trim());
        if (!isNaN(profitNum)) {
          stats.profit = profitNum;
          markJiwangDirty(uiStore.currentDate);
          renderCircleStats();
        }
      } else {
        stats.profit = '';
        markJiwangDirty(uiStore.currentDate);
        renderCircleStats();
      }
    }

    autoCalculateConsecutiveDays();
  }


  async function save() {
    saving.value = true;
    let cloudErr = null;
    try {
      const _dirtyDates = getBiddingDirtyDates();
      if (_dirtyDates) _dirtyDates.add(uiStore.currentDate);


      const biddingData = editRows.value.map(row => {
        const name = (row.name || '').toString().trim();
        return {
          name,
          time915: (row.time915 || '').toString().trim(),
          time920: (row.time920 || '').toString().trim(),
          time925: (row.time925 || '').toString().trim(),
          change: (row.change || '').toString().trim(),
          close: (row.close || '').toString().trim()
        };
      });

      getBiddingData()[uiStore.currentDate] = orderBiddingRows(biddingData);
      saveData();

      const sectorEtfRow = biddingData.find(row => row.name && row.name.startsWith('板块ETF'));
      if (sectorEtfRow) {
        const rawValue = (sectorEtfRow.close && sectorEtfRow.close.trim() !== '')
          ? sectorEtfRow.close.trim()
          : (sectorEtfRow.time925 && sectorEtfRow.time925.trim() !== '')
            ? sectorEtfRow.time925.trim()
            : '';
        if (rawValue !== '') {
          syncSectorEtfZhangNum(rawValue);
          _dbgLog('[BIDDING-SAVE] 保存时同步板块ETF涨数: ' + rawValue);
        }
      }

      const accountPremiumRow = biddingData.find(row => row.name === '账号溢价');
      if (accountPremiumRow && accountPremiumRow.close && accountPremiumRow.close.trim() !== '') {
        const profitNum = parseFloat(accountPremiumRow.close.trim());
        if (!isNaN(profitNum)) {
          const jiwangData = getJiwangData();
          if (!jiwangData[uiStore.currentDate]) jiwangData[uiStore.currentDate] = {};
          if (!jiwangData[uiStore.currentDate].stats) jiwangData[uiStore.currentDate].stats = {};
          jiwangData[uiStore.currentDate].stats.profit = profitNum;
          markJiwangDirty(uiStore.currentDate);
          saveData();
          renderCircleStats();
        }
      }

      render();
      autoCalculateRecentMultiScore();
      autoCalculateConsecutiveDays();
      renderConsecutiveUp();
      syncJiwangKxianFromBidding();

      const withTimeout = (p, ms, label) => Promise.race([
        p,
        new Promise((_, reject) => setTimeout(() => reject(new Error(label + ' 超时（' + ms + 'ms）')), ms))
      ]);
      try {
        await withTimeout(pushBiddingToCloud(uiStore.currentDate), 15000, '推送竞价数据');
        await withTimeout(syncBiddingDeletionsToCloud(uiStore.currentDate), 15000, '同步删除行');
        _dbgLog('[BIDDING-SAVE] 云端同步完成 ' + uiStore.currentDate);
      } catch (e) {
        cloudErr = e;
        console.warn('saveBidding 云端同步失败:', e);
      }

      autoTagShunshiNishi();
    } catch (e) {
      cloudErr = cloudErr || e;
      console.error('saveBidding 失败:', e);
    } finally {
      saving.value = false;
      modalActive.value = false;
      if (cloudErr) {
        const detail = (cloudErr && (cloudErr.message || cloudErr.details || cloudErr.hint || cloudErr.code)) || String(cloudErr);
        showWarningToast('⚠️ 保存失败：' + detail, 10000);
      } else {
        showToast('✅ 竞价变化保存成功（已同步云端）！');
      }
    }
  }

  function clearData() {
    clearConfirmActive.value = true;
  }

  async function confirmClearData() {
    clearing.value = true;
    clearConfirmActive.value = false;

    let biddingData = getTodayBidding();
    if (!biddingData || biddingData.length === 0) {
      showToast('没有数据需要清除');
      clearing.value = false;
      return;
    }

    const bidding = getBiddingData();
    const isNewDate = !bidding[uiStore.currentDate] || bidding[uiStore.currentDate].length === 0;
    if (isNewDate) {
      biddingData = biddingData.map(row => ({ ...row }));
    }

    biddingData.forEach(row => {
      row.time915 = '';
      row.time920 = '';
      row.time925 = '';
      row.change = '';
      row.close = '';

    });

    getBiddingData()[uiStore.currentDate] = biddingData;
    saveData();

    // [A2-01] 清除=删除操作。本地清空后必须显式删除云端当日数据：
    // pushBiddingToCloud 对全空 7 行直接 return 不删云端，故改用 deleteBiddingFromCloud。
    // 仅删当日 date（§11 删除安全），失败 throw、不静默（§10）；按云端结果提示成功/失败。
    let cloudErr = null;
    try {
      await deleteBiddingFromCloud(uiStore.currentDate);
    } catch (e) {
      cloudErr = e;
      console.error('[BIDDING-CLEAR] deleteBiddingFromCloud 失败:', e);
    }

    const jiwangData = getJiwangData();
    if (!jiwangData[uiStore.currentDate]) jiwangData[uiStore.currentDate] = {};
    if (!jiwangData[uiStore.currentDate].stats) jiwangData[uiStore.currentDate].stats = {};
    jiwangData[uiStore.currentDate].stats.profit = '';
    markJiwangDirty(uiStore.currentDate);
    saveData();
    renderCircleStats();

    render();
    openEdit();
    autoCalculateConsecutiveDays();

    clearing.value = false;
    if (cloudErr) {
      const detail = (cloudErr && (cloudErr.message || cloudErr.details || cloudErr.hint || cloudErr.code)) || String(cloudErr);
      showWarningToast('⚠️ 云端清除失败，旧数据可能仍在：' + detail, 8000);
    } else {
      showToast('✅ 已清除数据并同步云端');
    }
  }

  async function fetchSnapshot() {
    fetchStatus.value = '正在拉取快照...';
    fetchLoading.value = true;
    try {
      const { point, values } = await fetchBiddingSnapshotToForm();
      let filledRows = 0;
      let sectorEtfFilledValue = null;
      editRows.value.forEach(row => {
        const rowName = (row.name || '').trim();
        let value;
        if (values[rowName] !== undefined) value = values[rowName];
        else if (rowName.indexOf('板块ETF') === 0 && values['板块ETF'] !== undefined) value = values['板块ETF'];
        if (value === undefined) return;
        row[point.col] = value;
        filledRows++;
        if (rowName.indexOf('板块ETF') === 0) sectorEtfFilledValue = value;
        const time920Val = parseFloat(row.time920);
        const time925Val = parseFloat(row.time925);
        if (row.time920 && row.time925 && !isNaN(time920Val) && !isNaN(time925Val)) {
          if (time925Val > time920Val) row.change = '增';
          else if (time925Val < time920Val) row.change = '减';
          else row.change = '平';
        }
      });
      if (sectorEtfFilledValue !== null) {
        syncSectorEtfZhangNum(sectorEtfFilledValue);
      }
      fetchStatus.value = '✅ 已填入 ' + point.label + ' 列共 ' + filledRows + ' 行，请检查后点"保存"';
    } catch (err) {
      console.error('fetchBiddingSnapshotToForm 失败:', err);
      let msg = err && err.message ? err.message : '抓取失败';
      if (msg.indexOf('Failed to fetch') >= 0) msg = '代理请求失败，请检查网络';
      fetchStatus.value = '❌ ' + msg;
      showWarningToast('❌ ' + msg, 8000);
    } finally {
      fetchLoading.value = false;
    }
  }


  async function runDiagnostics() {
    const lines = [];
    const push = function(s) { lines.push(s); console.log(s); };
    push('===== 竞价变化看板诊断 =====');
    push('当前日期: ' + uiStore.currentDate);
    const localRows = (getBiddingData()[uiStore.currentDate] || []);
    push('本地内存行数: ' + localRows.length);
    localRows.forEach(function(r) {
      push('  ' + (r.name || '(无名)') + ' | 915=' + (r.time915 || '-') +
           ' 920=' + (r.time920 || '-') + ' 930=' + (r.time925 || '-') +
           ' change=' + (r.change || '-') + ' close=' + (r.close || '-'));
    });
    push('默认模板: ' + getDefaultBiddingTemplate().map(function(t) { return t.name; }).join('、'));
    const _pushInFlight = getBiddingPushInFlight();
    push('推送中日期: ' + (_pushInFlight ? Array.from(_pushInFlight).join(',') : '无'));
    const _dirtyDates = getBiddingDirtyDates();
    push('脏日期（未同步）: ' + (_dirtyDates ? Array.from(_dirtyDates).join(',') : '无'));
    try {
      const cloudRows = await fetchBiddingCloudRows(uiStore.currentDate);
      push('云端当前日期行数: ' + cloudRows.length);
      cloudRows.forEach(function(r) {
        const hasValue = (r.time915 || r.time920 || r.time925 || r.change || r.close);
        push('  ' + (r.name || '(无名)') + (hasValue ? ' [有值]' : ' [空]'));
      });
    } catch (e) {
      push('读取云端失败: ' + (e && e.message || e));
    }
    push('===== 诊断结束 =====');
    return lines.join('\n');
  }

  function onRealtimeUpdate(payload) {
    if (!payload || payload.boards === 'bidding' || payload.boards === 'all') render();
  }

  onMounted(() => {
    render();
    _on('bidding-refresh', render);
    _on('data:realtime-update', onRealtimeUpdate);
  });

  onUnmounted(() => {
    _off('bidding-refresh', render);
    _off('data:realtime-update', onRealtimeUpdate);
  });

  watch(() => uiStore.currentDate, () => { render(); });

  return {
    // 响应式状态
    modalActive,
    biddingRows,
    editRows,
    fetchStatus,
    fetchLoading,
    saving,
    clearing,
    clearConfirmActive,
    expanded,
    // 计算属性
    visibleBiddingRows,
    time26Change,
    // 展示辅助方法
    duibanTime925Class,
    toggleExpand,
    changeClass,
    changeTagClass,
    formatClose,
    // 业务方法
    getTodayBidding,
    render,
    openEdit,
    closeModal,
    onInputChange,
    save,
    clearData,
    confirmClearData,
    fetchSnapshot,
    runDiagnostics
  };
}

export const BIDDING_BOARD_KEY = 'biddingBoard';
