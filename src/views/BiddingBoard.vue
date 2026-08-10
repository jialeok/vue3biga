<!--
  BiddingBoard.vue — 竞价变化看板
  迁移自: boards-bidding.js (1844行, 35个导出函数)
  已迁移: getTodayBidding/addRow/removeRow/runDiagnostics/onInputChange/clearData/save(inline,用editRows替代DOM)
  保持委托: fetchBiddingSnapshotToForm(147行API+DOM)/onDuibanRowClick(79行DOM弹窗)/跨板副作用(syncSectorEtf/renderCircleStats/autoCalculate*/renderConsecutiveUp等)
-->
<template>
  <div class="bidding-board">
    <div class="bidding-display">
      <div class="bidding-header">
        <span class="bidding-title">竞价变化看板</span>
        <button class="bidding-edit-btn" @click="openEdit">编辑</button>
        <button class="bidding-diag-btn" @click="runDiagnostics">诊断</button>
      </div>
      <div class="bidding-table">
        <div class="bidding-row bidding-row-header">
          <span class="col-name">名称</span>
          <span class="col-time915">9:15</span>
          <span class="col-time920">9:20</span>
          <span class="col-time930">9:30</span>
          <span class="col-change">涨幅</span>
          <span class="col-close">收盘</span>
        </div>
        <div
          v-for="(row, idx) in biddingRows"
          :key="idx"
          class="bidding-row"
          :class="row.rowClass"
          @click="onRowClick($event, row)"
        >
          <span class="col-name">{{ row.name || '-' }}</span>
          <span class="col-time915">{{ row.time915 || '-' }}</span>
          <span class="col-time920">{{ row.time920 || '-' }}</span>
          <span class="col-time930">{{ row.time930 || '-' }}</span>
          <span class="col-change" :class="changeClass(row.change)">{{ row.change || '-' }}</span>
          <span class="col-close" :class="changeClass(row.close)">{{ row.close || '-' }}</span>
        </div>
        <div v-if="!biddingRows.length" class="bidding-empty">暂无数据</div>
      </div>
    </div>

    <EditModal v-model="modalActive" title="编辑竞价变化" :show-clear="true" save-text="保存" @save="save" @clear="clearData">
      <div class="bidding-edit-rows">
        <div v-for="(row, idx) in editRows" :key="idx" class="bidding-edit-row">
          <input v-model="row.name" placeholder="名称" @input="onInputChange(row)" />
          <input v-model="row.time915" placeholder="9:15" @input="onInputChange(row)" />
          <input v-model="row.time920" placeholder="9:20" @input="onInputChange(row)" />
          <input v-model="row.time930" placeholder="9:30" @input="onInputChange(row)" />
          <input v-model="row.change" placeholder="涨幅" @input="onInputChange(row)" />
          <input v-model="row.close" placeholder="收盘" @input="onInputChange(row)" />
          <button class="remove-row-btn" @click="removeRow(idx)">×</button>
        </div>
      </div>
      <div class="bidding-modal-extra-actions">
        <button class="btn-add-row" @click="addRow">+ 添加行</button>
        <button class="btn-fetch-snapshot" @click="fetchSnapshot" :disabled="fetchLoading">{{ fetchLoading ? '拉取中...' : '拉取快照' }}</button>
      </div>
      <div v-if="fetchStatus" class="bidding-fetch-status">{{ fetchStatus }}</div>
    </EditModal>

    <Teleport to="body">
      <div v-if="duibanPopup" class="duiban-history-popup-overlay" @click="closeDuibanPopup">
        <div class="duiban-history-popup" @click.stop>
          <div class="dh-row">{{ duibanPopup.initialTime ? duibanPopup.initialTime + '　' : '' }}{{ duibanPopup.initial }}%</div>
          <div class="dh-row">{{ duibanPopup.finalTime ? duibanPopup.finalTime + '　' : '' }}{{ duibanPopup.final }}%</div>
        </div>
      </div>
    </Teleport>

    <Teleport to="body">
      <div v-if="clearConfirmActive" class="clear-confirm-overlay" @click="clearConfirmActive = false">
        <div class="clear-confirm-panel" @click.stop>
          <div class="clear-confirm-title">确定要清除所有数据吗？</div>
          <div class="clear-confirm-desc">将保留第一列（要盯项目）的内容，清除其他所有列的数据。</div>
          <div class="clear-confirm-actions">
            <button class="btn-confirm-clear" @click="confirmClearData">确定清除</button>
            <button class="btn-cancel-clear" @click="clearConfirmActive = false">取消</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import { ref, watch, onMounted } from 'vue';
import EditModal from '../components/EditModal.vue';
import { useUiStore } from '../stores/uiStore.js';
import { getBiddingData, getJiwangData, getBiddingDirtyDates, getBiddingPushInFlight } from '../data/supabase-client.js';
import { getDefaultBiddingTemplate, pushBiddingToCloud, syncBiddingDeletionsToCloud, fetchBiddingCloudRows } from '../data/bidding-data.js';
import { saveData, markJiwangDirty } from '../logic/app-core.js';
import { _dbgLog } from '../data/debug-log.js';
import { showToast, showWarningToast } from '../composables/useToast.js';
import { renderCircleStats, autoCalculateConsecutiveDays } from '../logic/jiwang-helpers.js';
import { renderConsecutiveUp } from '../logic/tag-titles-helpers.js';
import { syncBiddingCloseToEtf, syncSectorEtfZhangNum, syncJiwangKxianFromBidding, autoTagShunshiNishi, fetchBiddingSnapshotToForm, getDuibanRowHistory, autoCalculateRecentMultiScore } from '../logic/bidding-helpers.js';

const uiStore = useUiStore();

const modalActive = ref(false);
const biddingRows = ref([]);
const editRows = ref([]);
const duibanPopup = ref(null);
const fetchStatus = ref('');
const fetchLoading = ref(false);
const clearConfirmActive = ref(false);

function changeClass(v) {
  if (!v) return '';
  const n = parseFloat(v);
  if (isNaN(n)) return '';
  return n > 0 ? 'up' : (n < 0 ? 'down' : '');
}

function getTodayBidding() {
  const biddingData = getBiddingData();
  const existingData = biddingData[uiStore.currentDate];
  if (existingData !== undefined && Array.isArray(existingData)) {
    const hasValidData = existingData.some(row => {
      return (row.name && row.name.toString().trim() !== '') ||
             (row.time915 && row.time915.toString().trim() !== '') ||
             (row.time920 && row.time920.toString().trim() !== '') ||
             (row.time930 && row.time930.toString().trim() !== '') ||
             (row.change && row.change.toString().trim() !== '') ||
             (row.close && row.close.toString().trim() !== '');
    });
    if (hasValidData) return existingData;
  }
  return null;
}

function render() {
  biddingRows.value = getTodayBidding() || [];
}

function openEdit() {
  const data = getTodayBidding();
  editRows.value = data ? data.map(r => ({ ...r })) : [];
  modalActive.value = true;
}

function closeModal() { modalActive.value = false; }

function onInputChange(row) {
  row._touched = true;

  const time920Val = parseFloat(row.time920);
  const time930Val = parseFloat(row.time930);
  if (row.time920 && row.time920.toString().trim() && row.time930 && row.time930.toString().trim() && !isNaN(time920Val) && !isNaN(time930Val)) {
    if (time930Val > time920Val) row.change = '增';
    else if (time930Val < time920Val) row.change = '减';
    else row.change = '平';
  } else {
    row.change = '';
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

function addRow() {
  editRows.value.push({ name: '', time915: '', time920: '', time930: '', change: '', close: '' });
}

function removeRow(idx) {
  editRows.value.splice(idx, 1);
}

async function save() {
  const _dirtyDates = getBiddingDirtyDates();
  if (_dirtyDates) _dirtyDates.add(uiStore.currentDate);

  const rawRows = editRows.value.map(row => ({
    name: (row.name || '').toString().trim(),
    time915: (row.time915 || '').toString().trim(),
    time920: (row.time920 || '').toString().trim(),
    time930: (row.time930 || '').toString().trim(),
    change: (row.change || '').toString().trim(),
    close: (row.close || '').toString().trim(),
    touched: {
      time915: !!row._touched,
      time920: !!row._touched,
      time930: !!row._touched,
      change: !!row._touched,
      close: !!row._touched,
    }
  }));

  const oldBiddingDataForMerge = getTodayBidding() || [];
  const FIELDS_TO_MERGE = ['time915', 'time920', 'time930', 'change', 'close'];
  const biddingData = rawRows.map(function(newRow, i) {
    let oldRow = null;
    if (newRow.name) {
      oldRow = oldBiddingDataForMerge.find(r => r && r.name === newRow.name);
    }
    if (!oldRow) {
      oldRow = oldBiddingDataForMerge[i] || null;
    }
    if (!oldRow) {
      const { touched, ...rest } = newRow;
      return rest;
    }
    const merged = { ...newRow };
    FIELDS_TO_MERGE.forEach(function(field) {
      if (merged.touched && merged.touched[field]) return;
      if (merged[field] === '' && oldRow[field] !== undefined && oldRow[field] !== '') {
        merged[field] = oldRow[field];
      }
    });
    delete merged.touched;
    return merged;
  });

  (function lockDuibanTime930History() {
    const oldBiddingData = getTodayBidding();
    const newRow = biddingData.find(r => r.name && r.name.trim() === '最近多板%');
    if (!newRow) return;
    const oldRow = oldBiddingData ? oldBiddingData.find(r => r.name && r.name.trim() === '最近多板%') : null;
    if (oldRow && oldRow.time930_initial !== undefined && oldRow.time930_initial !== '') {
      newRow.time930_initial = oldRow.time930_initial;
      newRow.time930_initial_modifiedAt = oldRow.time930_initial_modifiedAt;
      newRow.time930_modifiedAt = Date.now();
    } else if (newRow.time930 && newRow.time930.trim() !== '') {
      newRow.time930_initial = newRow.time930;
      newRow.time930_initial_modifiedAt = Date.now();
      newRow.time930_modifiedAt = undefined;
    } else {
      newRow.time930_initial = undefined;
      newRow.time930_initial_modifiedAt = undefined;
      newRow.time930_modifiedAt = undefined;
    }
  })();

  getBiddingData()[uiStore.currentDate] = biddingData;
  saveData();

  const sectorEtfRow = biddingData.find(row => row.name && row.name.startsWith('板块ETF'));
  if (sectorEtfRow) {
    const rawValue = (sectorEtfRow.close && sectorEtfRow.close.trim() !== '')
      ? sectorEtfRow.close.trim()
      : (sectorEtfRow.time930 && sectorEtfRow.time930.trim() !== '')
        ? sectorEtfRow.time930.trim()
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

  let cloudErr = null;
  try {
    await pushBiddingToCloud(uiStore.currentDate);
    await syncBiddingDeletionsToCloud(uiStore.currentDate);
    _dbgLog('[BIDDING-SAVE] 云端同步完成 ' + uiStore.currentDate);
  } catch (e) {
    cloudErr = e;
    console.warn('saveBidding 云端同步失败:', e);
  } finally {
    modalActive.value = false;
    if (cloudErr) {
      const detail = (cloudErr && (cloudErr.message || cloudErr.details || cloudErr.hint || cloudErr.code)) || String(cloudErr);
      showWarningToast('⚠️ 本地已保存，但云端同步失败！原因: ' + detail, 10000);
    } else {
      showToast('✅ 竞价变化保存成功（已同步云端）！');
    }
  }

  autoTagShunshiNishi();
}

function clearData() {
  clearConfirmActive.value = true;
}

function confirmClearData() {
  clearConfirmActive.value = false;

  let biddingData = getTodayBidding();
  if (!biddingData || biddingData.length === 0) {
    showToast('没有数据需要清除');
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
    row.time930 = '';
    row.change = '';
    row.close = '';
    delete row.time930_initial;
    delete row.time930_initial_modifiedAt;
    delete row.time930_modifiedAt;
  });

  getBiddingData()[uiStore.currentDate] = biddingData;
  saveData();

  pushBiddingToCloud(uiStore.currentDate).catch(function(e) {
    _dbgLog('[BIDDING-CLEAR] pushBiddingToCloud 失败: ' + (e && e.message));
    showWarningToast('⚠️ 云端清除失败，旧数据可能仍在：' + (e && e.message), 8000);
  });

  const jiwangData = getJiwangData();
  if (!jiwangData[uiStore.currentDate]) jiwangData[uiStore.currentDate] = {};
  if (!jiwangData[uiStore.currentDate].stats) jiwangData[uiStore.currentDate].stats = {};
  jiwangData[uiStore.currentDate].stats.profit = '';
  markJiwangDirty(uiStore.currentDate);
  saveData();
  renderCircleStats();

  openEdit();
  showToast('已清除数据');
  autoCalculateConsecutiveDays();
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
      const time930Val = parseFloat(row.time930);
      if (row.time920 && row.time930 && !isNaN(time920Val) && !isNaN(time930Val)) {
        if (time930Val > time920Val) row.change = '增';
        else if (time930Val < time920Val) row.change = '减';
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

function onRowClick(event, row) {
  if (row.name && row.name.trim() === '最近多板%') {
    const history = getDuibanRowHistory(row);
    if (history && (history.initial || history.final)) {
      duibanPopup.value = history;
    }
  }
}

function closeDuibanPopup() {
  duibanPopup.value = null;
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
         ' 920=' + (r.time920 || '-') + ' 930=' + (r.time930 || '-') +
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
      const hasValue = (r.time915 || r.time920 || r.time930 || r.change || r.close);
      push('  ' + (r.name || '(无名)') + (hasValue ? ' [有值]' : ' [空]'));
    });
  } catch (e) {
    push('读取云端失败: ' + (e && e.message || e));
  }
  push('===== 诊断结束 =====');
  return lines.join('\n');
}

onMounted(render);

watch(() => uiStore.currentDate, () => { render(); });

defineExpose({ render, openEdit, closeModal, save, addRow, removeRow, clearData, fetchSnapshot, runDiagnostics });
</script>

