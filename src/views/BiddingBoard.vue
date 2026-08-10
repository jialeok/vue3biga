<!--
  BiddingBoard.vue 鈥?绔炰环鍙樺寲鐪嬫澘
  杩佺Щ鑷? boards-bidding.js (1844琛? 35涓鍑哄嚱鏁?
  宸茶縼绉? getTodayBidding/addRow/removeRow/runDiagnostics/onInputChange/clearData/save(inline,鐢╡ditRows鏇夸唬DOM)
  淇濇寔濮旀墭: fetchBiddingSnapshotToForm(147琛孉PI+DOM)/onDuibanRowClick(79琛孌OM寮圭獥)/璺ㄦ澘鍓綔鐢?syncSectorEtf/renderCircleStats/autoCalculate*/renderConsecutiveUp绛?
-->
<template>
  <div class="bidding-board">
    <div class="bidding-display">
      <div class="bidding-header">
        <span class="bidding-title">绔炰环鍙樺寲鐪嬫澘</span>
        <button class="bidding-edit-btn" @click="openEdit">缂栬緫</button>
        <button class="bidding-diag-btn" @click="runDiagnostics">璇婃柇</button>
      </div>
      <div class="bidding-table">
        <div class="bidding-row bidding-row-header">
          <span class="col-name">鍚嶇О</span>
          <span class="col-time915">9:15</span>
          <span class="col-time920">9:20</span>
          <span class="col-time930">9:30</span>
          <span class="col-change">娑ㄥ箙</span>
          <span class="col-close">鏀剁洏</span>
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
        <div v-if="!biddingRows.length" class="bidding-empty">鏆傛棤鏁版嵁</div>
      </div>
    </div>

    <EditModal v-model="modalActive" title="缂栬緫绔炰环鍙樺寲" :show-clear="true" save-text="淇濆瓨" @save="save" @clear="clearData">
      <div class="bidding-edit-rows">
        <div v-for="(row, idx) in editRows" :key="idx" class="bidding-edit-row">
          <input v-model="row.name" placeholder="鍚嶇О" @input="onInputChange(row)" />
          <input v-model="row.time915" placeholder="9:15" @input="onInputChange(row)" />
          <input v-model="row.time920" placeholder="9:20" @input="onInputChange(row)" />
          <input v-model="row.time930" placeholder="9:30" @input="onInputChange(row)" />
          <input v-model="row.change" placeholder="娑ㄥ箙" @input="onInputChange(row)" />
          <input v-model="row.close" placeholder="鏀剁洏" @input="onInputChange(row)" />
          <button class="remove-row-btn" @click="removeRow(idx)">脳</button>
        </div>
      </div>
      <div class="bidding-modal-extra-actions">
        <button class="btn-add-row" @click="addRow">+ 娣诲姞琛?/button>
        <button class="btn-fetch-snapshot" @click="fetchSnapshot" :disabled="fetchLoading">{{ fetchLoading ? '鎷夊彇涓?..' : '鎷夊彇蹇収' }}</button>
      </div>
      <div v-if="fetchStatus" class="bidding-fetch-status">{{ fetchStatus }}</div>
    </EditModal>

    <Teleport to="body">
      <div v-if="duibanPopup" class="duiban-history-popup-overlay" @click="closeDuibanPopup">
        <div class="duiban-history-popup" @click.stop>
          <div class="dh-row">{{ duibanPopup.initialTime ? duibanPopup.initialTime + '銆€' : '' }}{{ duibanPopup.initial }}%</div>
          <div class="dh-row">{{ duibanPopup.finalTime ? duibanPopup.finalTime + '銆€' : '' }}{{ duibanPopup.final }}%</div>
        </div>
      </div>
    </Teleport>

    <Teleport to="body">
      <div v-if="clearConfirmActive" class="clear-confirm-overlay" @click="clearConfirmActive = false">
        <div class="clear-confirm-panel" @click.stop>
          <div class="clear-confirm-title">纭畾瑕佹竻闄ゆ墍鏈夋暟鎹悧锛?/div>
          <div class="clear-confirm-desc">灏嗕繚鐣欑涓€鍒楋紙瑕佺洴椤圭洰锛夌殑鍐呭锛屾竻闄ゅ叾浠栨墍鏈夊垪鐨勬暟鎹€?/div>
          <div class="clear-confirm-actions">
            <button class="btn-confirm-clear" @click="confirmClearData">纭畾娓呴櫎</button>
            <button class="btn-cancel-clear" @click="clearConfirmActive = false">鍙栨秷</button>
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
    if (time930Val > time920Val) row.change = '澧?;
    else if (time930Val < time920Val) row.change = '鍑?;
    else row.change = '骞?;
  } else {
    row.change = '';
  }

  syncBiddingCloseToEtf(row);

  if (row.name === '璐﹀彿婧环') {
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
    const newRow = biddingData.find(r => r.name && r.name.trim() === '鏈€杩戝鏉?');
    if (!newRow) return;
    const oldRow = oldBiddingData ? oldBiddingData.find(r => r.name && r.name.trim() === '鏈€杩戝鏉?') : null;
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

  const sectorEtfRow = biddingData.find(row => row.name && row.name.startsWith('鏉垮潡ETF'));
  if (sectorEtfRow) {
    const rawValue = (sectorEtfRow.close && sectorEtfRow.close.trim() !== '')
      ? sectorEtfRow.close.trim()
      : (sectorEtfRow.time930 && sectorEtfRow.time930.trim() !== '')
        ? sectorEtfRow.time930.trim()
        : '';
    if (rawValue !== '') {
      syncSectorEtfZhangNum(rawValue);
      _dbgLog('[BIDDING-SAVE] 淇濆瓨鏃跺悓姝ユ澘鍧桬TF娑ㄦ暟: ' + rawValue);
    }
  }

  const accountPremiumRow = biddingData.find(row => row.name === '璐﹀彿婧环');
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
    _dbgLog('[BIDDING-SAVE] 浜戠鍚屾瀹屾垚 ' + uiStore.currentDate);
  } catch (e) {
    cloudErr = e;
    console.warn('saveBidding 浜戠鍚屾澶辫触:', e);
  } finally {
    modalActive.value = false;
    if (cloudErr) {
      const detail = (cloudErr && (cloudErr.message || cloudErr.details || cloudErr.hint || cloudErr.code)) || String(cloudErr);
      showWarningToast('鈿狅笍 鏈湴宸蹭繚瀛橈紝浣嗕簯绔悓姝ュけ璐ワ紒鍘熷洜: ' + detail, 10000);
    } else {
      showToast('鉁?绔炰环鍙樺寲淇濆瓨鎴愬姛锛堝凡鍚屾浜戠锛夛紒');
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
    showToast('娌℃湁鏁版嵁闇€瑕佹竻闄?);
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
    _dbgLog('[BIDDING-CLEAR] pushBiddingToCloud 澶辫触: ' + (e && e.message));
    showWarningToast('鈿狅笍 浜戠娓呴櫎澶辫触锛屾棫鏁版嵁鍙兘浠嶅湪锛? + (e && e.message), 8000);
  });

  const jiwangData = getJiwangData();
  if (!jiwangData[uiStore.currentDate]) jiwangData[uiStore.currentDate] = {};
  if (!jiwangData[uiStore.currentDate].stats) jiwangData[uiStore.currentDate].stats = {};
  jiwangData[uiStore.currentDate].stats.profit = '';
  markJiwangDirty(uiStore.currentDate);
  saveData();
  renderCircleStats();

  openEdit();
  showToast('宸叉竻闄ゆ暟鎹?);
  autoCalculateConsecutiveDays();
}

async function fetchSnapshot() {
  fetchStatus.value = '姝ｅ湪鎷夊彇蹇収...';
  fetchLoading.value = true;
  try {
    const { point, values } = await fetchBiddingSnapshotToForm();
    let filledRows = 0;
    let sectorEtfFilledValue = null;
    editRows.value.forEach(row => {
      const rowName = (row.name || '').trim();
      let value;
      if (values[rowName] !== undefined) value = values[rowName];
      else if (rowName.indexOf('鏉垮潡ETF') === 0 && values['鏉垮潡ETF'] !== undefined) value = values['鏉垮潡ETF'];
      if (value === undefined) return;
      row[point.col] = value;
      filledRows++;
      if (rowName.indexOf('鏉垮潡ETF') === 0) sectorEtfFilledValue = value;
      const time920Val = parseFloat(row.time920);
      const time930Val = parseFloat(row.time930);
      if (row.time920 && row.time930 && !isNaN(time920Val) && !isNaN(time930Val)) {
        if (time930Val > time920Val) row.change = '澧?;
        else if (time930Val < time920Val) row.change = '鍑?;
        else row.change = '骞?;
      }
    });
    if (sectorEtfFilledValue !== null) {
      syncSectorEtfZhangNum(sectorEtfFilledValue);
    }
    fetchStatus.value = '鉁?宸插～鍏?' + point.label + ' 鍒楀叡 ' + filledRows + ' 琛岋紝璇锋鏌ュ悗鐐?淇濆瓨"';
  } catch (err) {
    console.error('fetchBiddingSnapshotToForm 澶辫触:', err);
    let msg = err && err.message ? err.message : '鎶撳彇澶辫触';
    if (msg.indexOf('Failed to fetch') >= 0) msg = '浠ｇ悊璇锋眰澶辫触锛岃妫€鏌ョ綉缁?;
    fetchStatus.value = '鉂?' + msg;
    showWarningToast('鉂?' + msg, 8000);
  } finally {
    fetchLoading.value = false;
  }
}

function onRowClick(event, row) {
  if (row.name && row.name.trim() === '鏈€杩戝鏉?') {
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
  push('===== 绔炰环鍙樺寲鐪嬫澘璇婃柇 =====');
  push('褰撳墠鏃ユ湡: ' + uiStore.currentDate);
  const localRows = (getBiddingData()[uiStore.currentDate] || []);
  push('鏈湴鍐呭瓨琛屾暟: ' + localRows.length);
  localRows.forEach(function(r) {
    push('  ' + (r.name || '(鏃犲悕)') + ' | 915=' + (r.time915 || '-') +
         ' 920=' + (r.time920 || '-') + ' 930=' + (r.time930 || '-') +
         ' change=' + (r.change || '-') + ' close=' + (r.close || '-'));
  });
  push('榛樿妯℃澘: ' + getDefaultBiddingTemplate().map(function(t) { return t.name; }).join('銆?));
  const _pushInFlight = getBiddingPushInFlight();
  push('鎺ㄩ€佷腑鏃ユ湡: ' + (_pushInFlight ? Array.from(_pushInFlight).join(',') : '鏃?));
  const _dirtyDates = getBiddingDirtyDates();
  push('鑴忔棩鏈燂紙鏈悓姝ワ級: ' + (_dirtyDates ? Array.from(_dirtyDates).join(',') : '鏃?));
  try {
    const cloudRows = await fetchBiddingCloudRows(uiStore.currentDate);
    push('浜戠褰撳墠鏃ユ湡琛屾暟: ' + cloudRows.length);
    cloudRows.forEach(function(r) {
      const hasValue = (r.time915 || r.time920 || r.time930 || r.change || r.close);
      push('  ' + (r.name || '(鏃犲悕)') + (hasValue ? ' [鏈夊€糫' : ' [绌篯'));
    });
  } catch (e) {
    push('璇诲彇浜戠澶辫触: ' + (e && e.message || e));
  }
  push('===== 璇婃柇缁撴潫 =====');
  return lines.join('\n');
}

onMounted(render);

watch(() => uiStore.currentDate, () => { render(); });

defineExpose({ render, openEdit, closeModal, save, addRow, removeRow, clearData, fetchSnapshot, runDiagnostics });
</script>

<style>
.bidding-board {
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  margin: 8px 0;
  background: #fff;
}
.bidding-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid #f3f4f6;
}
.bidding-title {
  font-weight: 600;
  color: #1f2937;
  flex: 1;
}
.bidding-edit-btn, .bidding-diag-btn {
  padding: 4px 12px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  background: #fff;
  font-size: 12px;
  cursor: pointer;
}
.bidding-table {
  padding: 4px 0;
}
.bidding-row {
  display: grid;
  grid-template-columns: 2fr 1fr 1fr 1fr 1fr 1fr;
  gap: 4px;
  padding: 6px 14px;
  font-size: 13px;
  border-bottom: 1px solid #f9fafb;
}
.bidding-row-header {
  font-weight: 600;
  color: #6b7280;
  background: #f9fafb;
}
.bidding-row .up { color: #dc2626; }
.bidding-row .down { color: #059669; }
.bidding-empty {
  text-align: center;
  color: #9ca3af;
  padding: 20px;
}
.bidding-edit-row {
  display: grid;
  grid-template-columns: 2fr 1fr 1fr 1fr 1fr 1fr auto;
  gap: 4px;
  margin-bottom: 6px;
}
.bidding-edit-row input {
  padding: 4px 6px;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  font-size: 12px;
}
.remove-row-btn {
  border: none;
  background: #fee2e2;
  color: #dc2626;
  border-radius: 4px;
  cursor: pointer;
  font-size: 16px;
  width: 28px;
}
.bidding-modal-extra-actions {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}
.btn-add-row { background: #e0f2fe; color: #0284c7; padding: 8px 16px; border: none; border-radius: 6px; cursor: pointer; font-size: 13px; }
.btn-fetch-snapshot { background: #fef3c7; color: #b45309; padding: 8px 16px; border: none; border-radius: 6px; cursor: pointer; font-size: 13px; }
.btn-fetch-snapshot:disabled { opacity: 0.6; cursor: not-allowed; }
.bidding-fetch-status { font-size: 12px; color: #6b7280; margin-top: 8px; }
.duiban-history-popup-overlay { position: fixed; inset: 0; z-index: 9998; }
.duiban-history-popup {
  position: fixed; z-index: 9999; background: #fff; border: 1px solid #d1d5db;
  border-radius: 8px; padding: 8px 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.15);
  font-size: 13px; top: 50%; left: 50%; transform: translate(-50%, -50%);
}
.dh-row { padding: 4px 0; white-space: nowrap; }
.clear-confirm-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 10000; display: flex; align-items: center; justify-content: center; }
.clear-confirm-panel { background: #fff; border-radius: 12px; padding: 24px; min-width: 320px; }
.clear-confirm-title { font-size: 16px; font-weight: 600; margin-bottom: 8px; }
.clear-confirm-desc { font-size: 13px; color: #6b7280; margin-bottom: 16px; }
.clear-confirm-actions { display: flex; gap: 8px; }
.btn-confirm-clear { flex: 1; padding: 8px 16px; border: none; border-radius: 6px; background: #dc2626; color: #fff; cursor: pointer; font-size: 13px; }
.btn-cancel-clear { flex: 1; padding: 8px 16px; border: none; border-radius: 6px; background: #e5e7eb; color: #374151; cursor: pointer; font-size: 13px; }
</style>
