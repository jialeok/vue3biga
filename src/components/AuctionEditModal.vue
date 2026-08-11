<template>
  <Teleport to="body">
    <div v-if="visible" class="auction-edit-overlay" @click.self="close">
      <div class="auction-edit-modal">
        <div class="auction-edit-header">
          <span class="auction-edit-title">{{ isHot ? '编辑热门股票' : '编辑最近多板早盘竞价' }}</span>
          <button class="auction-edit-close" @click="close">✕</button>
        </div>
        <div class="auction-edit-body">

          <!-- 粘贴区 -->
          <div class="section-paste">
            <textarea v-model="pasteText" placeholder="从Excel复制粘贴&#10;格式1：股票名称[TAB]竞价量[TAB]昨日成交量&#10;格式2：股票名称[TAB]涨幅[TAB]概念&#10;格式3：股票名称[TAB]涨幅 或 概念&#10;格式4：股票名称 涨幅%" class="paste-textarea"></textarea>
            <div class="paste-btns">
              <button @click="onPasteImport" class="btn btn-import">导入数据</button>
              <button @click="onReplaceConcept" class="btn btn-concept">替换概念</button>
              <button @click="onAiVision" class="btn btn-vision">📷 AI识图</button>
            </div>
          </div>

          <!-- 股票代码映射区 -->
          <div class="section-codemap">
            <div class="section-codemap-header">
              <span class="section-codemap-title">股票代码映射（供抓取程序读取）</span>
              <label class="toggle-switch">
                <input type="checkbox" v-model="codeMapOpen">
                <span class="toggle-slider"></span>
              </label>
            </div>
            <div v-if="codeMapOpen" class="section-codemap-body">
              <div class="section-codemap-hint">两列：股票名称[TAB]股票代码（如 贵州茅台[TAB]600519）。存为「名称→代码」映射，前台不显示代码，仅供抓取程序读取。同名覆盖，长期复用。</div>
              <textarea v-model="codeMapText" placeholder="贵州茅台&#9;600519&#10;平安银行&#9;000001&#10;..." class="codemap-textarea"></textarea>
              <div class="codemap-btns">
                <button @click="onImportCodeMap" class="btn btn-codemap-import">导入代码映射</button>
                <button @click="onAutoCompleteCode" class="btn btn-codemap-auto">自动补全代码</button>
                <button @click="onClearCodeMap" class="btn btn-codemap-clear">清空映射</button>
              </div>
            </div>
          </div>

          <!-- 历史数据补录区 -->
          <div class="section-history">
            <div class="section-history-header">
              <span class="section-history-title">历史数据补录模式</span>
              <label class="toggle-switch">
                <input type="checkbox" v-model="historyOpen">
                <span class="toggle-slider"></span>
              </label>
            </div>
            <div v-if="historyOpen" class="section-history-body">
              <div class="section-history-hint">只补空值；股票需在当前列表中存在才会补录；三列自动补两项，两列按右侧类型补一项；支持空格或TAB分隔</div>
              <div class="history-controls">
                <input type="date" v-model="historyDate" class="history-date">
                <label class="history-radio"><input type="radio" v-model="historyColType" value="volume"> 竞价量</label>
                <label class="history-radio"><input type="radio" v-model="historyColType" value="yestVolume"> 昨日成交量</label>
              </div>
              <textarea v-model="historyText" placeholder="三列：股票名称 竞价量 昨日成交量&#10;两列：股票名称 数字（按上方选择类型补录）&#10;空格或TAB分隔均可" class="history-textarea"></textarea>
              <button @click="onHistoryFill" class="btn btn-history-fill">补录历史数据</button>
            </div>
          </div>

          <!-- 同花顺接口 -->
          <div class="api-section api-ths">
            <div class="api-section-header">
              <span class="api-section-title">同花顺接口</span>
              <span class="api-section-tag">883410.TI · fuyao-proxy</span>
            </div>
            <div class="api-grid">
              <button @click="runBackend(thsFns.ladder)" class="btn btn-ths">获取最近多板</button>
              <button @click="runBackend(thsFns.yestVol)" class="btn btn-ths">两全昨日成交量</button>
              <button @click="runBackend(thsFns.todayYest)" class="btn btn-ths">当天昨日成交量</button>
              <button @click="runBackend(thsFns.prevYest)" class="btn btn-ths">对比日昨成交量</button>
              <button @click="runBackend(thsFns.changePct)" class="btn btn-ths">获取涨幅</button>
              <button @click="runBackend(thsFns.gapPct)" class="btn btn-ths">历史断点涨幅</button>
              <button @click="runBackend(thsFns.gapYest)" class="btn btn-ths btn-ths-wide">历史断点昨日成交量</button>
            </div>
          </div>

          <!-- 猫抓接口 -->
          <div class="api-section api-numcat">
            <div class="api-section-header">
              <span class="api-section-title">猫抓数据接口</span>
              <span class="api-section-tag">免费额度每日10次</span>
            </div>
            <div class="api-grid">
              <button @click="runBackend(numcatFns.yestAuction)" class="btn btn-numcat">补全昨日竞价量</button>
              <button @click="runBackend(numcatFns.today)" class="btn btn-numcat">获取当天竞价量</button>
              <button @click="runBackend(numcatFns.all)" class="btn btn-numcat btn-numcat-wide">全竞价量（昨日+今日）</button>
              <button @click="runBackend(numcatFns.fiveDays)" class="btn btn-numcat btn-numcat-wide">连抓五天补全</button>
              <button @click="runBackend(numcatFns.topics)" class="btn btn-numcat">补全题材</button>
              <button @click="runBackend(numcatFns.monitor)" class="btn btn-numcat">查询监管</button>
            </div>
          </div>

          <!-- 接口诊断 -->
          <div class="api-section api-diag">
            <div class="api-section-header">
              <span class="api-section-title">接口诊断</span>
              <span class="api-section-tag">独立运行</span>
            </div>
            <button @click="onRunDiag" class="btn btn-diag">🔍 运行诊断</button>
          </div>

          <!-- 接口状态 -->
          <div v-if="apiStatus" class="api-status-bar">{{ apiStatus }}</div>

          <!-- 表单行 -->
          <div class="form-scroll">
            <div v-for="(row, idx) in editRows" :key="idx" class="form-row">
              <span class="form-number">{{ idx + 1 }}</span>
              <input v-model="row.stock" placeholder="股票名称" class="form-input form-stock">
              <input v-model="row.volume" placeholder="竞价量" class="form-input form-volume">
              <input v-model="row.yestVolume" placeholder="昨日成交量" class="form-input form-yest">
              <button @click="removeRow(idx)" class="form-remove">×</button>
            </div>
          </div>
        </div>

        <!-- 底部操作按钮 -->
        <div class="edit-actions">
          <button @click="addRow" class="btn btn-add">+ 添加新行</button>
          <button @click="save" class="btn btn-save">保存</button>
          <button @click="onRollback" class="btn btn-rollback">撤回</button>
          <button @click="onClearConcepts" class="btn btn-clear-concept">清除题材</button>
          <button @click="onClearText" class="btn btn-clear-text">清除文字</button>
          <button @click="onClearNotes" class="btn btn-clear-note">清除注释</button>
          <button @click="clearAllRows" class="btn btn-clear-all">清空所有行</button>
          <button @click="onRepair" class="btn btn-repair">🔧 恢复本日数据</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, computed } from 'vue';
import {
  getTodayGroupList, saveData, getAuctionData,
  importAuctionFromPaste, importAuctionHistoryFill,
  importHotFromPaste, importHotHistoryFill,
  replaceConceptFromPaste, replaceHotConceptFromPaste,
  importStockCodeMap, importStockCodeMapHot, autoCompleteMissingStockCodes,
  fetchLadderConstituentsMain, fillYesterdayVolumeFromThs, fillTodayYesterdayVolumeFromThs,
  fillYesterdayYesterdayVolumeFromThs, fetchChangePctFromThs, fillAuctionHistoryGapYestVolumeFromThs,
  fillAuctionHistoryGapPctFromThs,
  fetchTodayAuctionFromNumcat, fetchAllAuctionFromNumcat, fetchFiveDaysAuctionFromNumcat,
  fillYesterdayAuctionFromNumcat, fillTopicsFromNumcat, fetchMonitorWarningFromNumcat,
  runAuctionApiDiagnostics, rollbackAuctionData, repairAuctionInWatchlistForDate,
  patchAuctionFieldBatch, markAuctionDirty, scheduleCloudPush,
  fetchHotLimitUpLadderFromThs, fillHotYesterdayVolumeFromThs, fillHotTodayYesterdayVolumeFromThs,
  fillHotYesterdayYesterdayVolumeFromThs, fetchHotChangePctFromThs, fillHotHistoryGapYestVolumeFromThs,
  fillHotHistoryGapPctFromThs,
  fetchHotTodayAuctionFromNumcat, fetchAllHotAuctionFromNumcat, fetchFiveDaysHotAuctionFromNumcat,
  fillHotYesterdayAuctionFromNumcat, fillHotTopicsFromNumcat, fetchHotMonitorWarningFromNumcat
} from '../logic/app-core.js';
import { openAiVisionModal } from '../logic/workflows/ai-vision-import.js';
import { parseNoteToFields } from '../logic/note-helpers.js';
import { syncStockTopicsFromAuction } from '../logic/auction-stock-sync.js';
import { useUiStore } from '../stores/uiStore.js';
import auctionStore from '../stores/auctionStore.js';

const uiStore = useUiStore();

const props = defineProps({
  dataSource: { type: String, default: 'auction' }
});

const visible = ref(false);
const editRows = ref([]);
const pasteText = ref('');
const apiStatus = ref('');

const codeMapOpen = ref(false);
const codeMapText = ref('');
const historyOpen = ref(false);
const historyDate = ref('');
const historyColType = ref('volume');
const historyText = ref('');

const isHot = computed(() => props.dataSource === 'hot');
const ds = computed(() => isHot.value ? 'hot' : 'auction');

const thsFns = computed(() => isHot.value ? {
  ladder: fetchHotLimitUpLadderFromThs,
  yestVol: fillHotYesterdayVolumeFromThs,
  todayYest: fillHotTodayYesterdayVolumeFromThs,
  prevYest: fillHotYesterdayYesterdayVolumeFromThs,
  changePct: fetchHotChangePctFromThs,
  gapPct: () => fillHotHistoryGapPctFromThs(null, 'hot'),
  gapYest: fillHotHistoryGapYestVolumeFromThs
} : {
  ladder: fetchLadderConstituentsMain,
  yestVol: fillYesterdayVolumeFromThs,
  todayYest: fillTodayYesterdayVolumeFromThs,
  prevYest: fillYesterdayYesterdayVolumeFromThs,
  changePct: fetchChangePctFromThs,
  gapPct: () => fillAuctionHistoryGapPctFromThs(null, 'auction'),
  gapYest: fillAuctionHistoryGapYestVolumeFromThs
});

const numcatFns = computed(() => isHot.value ? {
  yestAuction: fillHotYesterdayAuctionFromNumcat,
  today: fetchHotTodayAuctionFromNumcat,
  all: fetchAllHotAuctionFromNumcat,
  fiveDays: fetchFiveDaysHotAuctionFromNumcat,
  topics: fillHotTopicsFromNumcat,
  monitor: fetchHotMonitorWarningFromNumcat
} : {
  yestAuction: fillYesterdayAuctionFromNumcat,
  today: fetchTodayAuctionFromNumcat,
  all: fetchAllAuctionFromNumcat,
  fiveDays: fetchFiveDaysAuctionFromNumcat,
  topics: fillTopicsFromNumcat,
  monitor: fetchMonitorWarningFromNumcat
});

function refreshRows() {
  const list = getTodayGroupList(props.dataSource);
  editRows.value = list.map(item => ({
    stock: item.stock || '',
    volume: item.volume || '',
    yestVolume: item.yestVolume || ''
  }));
}

function open() {
  refreshRows();
  if (editRows.value.length === 0) {
    editRows.value.push({ stock: '', volume: '', yestVolume: '' });
  }
  pasteText.value = '';
  codeMapText.value = '';
  historyText.value = '';
  historyDate.value = auctionStore.currentDate || '';
  apiStatus.value = '';
  visible.value = true;
}
function close() {
  visible.value = false;
}

function addRow() {
  editRows.value.push({ stock: '', volume: '', yestVolume: '' });
}
function removeRow(idx) {
  editRows.value.splice(idx, 1);
}
function clearAllRows() {
  if (!confirm('确定要清空当前所有行？')) return;
  editRows.value = [{ stock: '', volume: '', yestVolume: '' }];
}

function save() {
  const list = getTodayGroupList(props.dataSource);
  list.length = 0;
  editRows.value.forEach(row => {
    if (row.stock && row.stock.trim()) {
      list.push({
        stock: row.stock.trim(),
        volume: row.volume || '',
        yestVolume: row.yestVolume || ''
      });
    }
  });
  saveData();
  auctionStore.bumpDataVersion(ds.value);
  auctionStore.refresh();
  close();
}

const loading = ref(false);

function runBackend(fn) {
  if (!fn || loading.value) return;
  loading.value = true;
  apiStatus.value = '执行中...';
  Promise.resolve(fn()).then(() => {
    refreshRows();
    apiStatus.value = '完成';
    auctionStore.bumpDataVersion(ds.value);
  }).catch(e => {
    console.error('接口调用失败:', e);
    apiStatus.value = '失败: ' + (e && e.message ? e.message : String(e));
  }).finally(() => {
    loading.value = false;
  });
}

function onPasteImport() {
  if (!pasteText.value.trim()) return;
  const fn = isHot.value ? importHotFromPaste : importAuctionFromPaste;
  fn(pasteText.value).then(() => {
    refreshRows();
    pasteText.value = '';
    auctionStore.bumpDataVersion(ds.value);
    auctionStore.refresh();
  }).catch(e => console.error('导入失败:', e));
}

function onReplaceConcept() {
  if (!pasteText.value.trim()) return;
  const fn = isHot.value ? replaceHotConceptFromPaste : replaceConceptFromPaste;
  Promise.resolve(fn(pasteText.value)).then(() => {
    refreshRows();
    auctionStore.bumpDataVersion(ds.value);
    auctionStore.refresh();
  }).catch(e => console.error('替换概念失败:', e));
}

function onAiVision() {
  openAiVisionModal();
}

function onImportCodeMap() {
  if (!codeMapText.value.trim()) return;
  const fn = isHot.value ? importStockCodeMapHot : importStockCodeMap;
  Promise.resolve(fn(codeMapText.value)).then(() => {
    codeMapText.value = '';
  }).catch(e => console.error('导入代码映射失败:', e));
}

function onAutoCompleteCode() {
  autoCompleteMissingStockCodes(props.dataSource);
}

function onClearCodeMap() {
  if (!confirm('确定清空股票代码映射？清空后抓取程序将读不到代码。')) return;
  codeMapText.value = '';
  alert('已清空输入框（云端映射需到云端 stockcodemap 表操作）');
}

function onHistoryFill() {
  if (!historyText.value.trim()) return;
  const fn = isHot.value ? importHotHistoryFill : importAuctionHistoryFill;
  fn(historyText.value, historyDate.value, historyColType.value).then(() => {
    refreshRows();
    historyText.value = '';
    auctionStore.bumpDataVersion(ds.value);
    auctionStore.refresh();
  }).catch(e => console.error('历史填充失败:', e));
}

function onRunDiag() {
  apiStatus.value = '诊断中...';
  runAuctionApiDiagnostics().then(() => {
    apiStatus.value = '诊断完成';
  }).catch(e => {
    apiStatus.value = '诊断失败: ' + e.message;
  });
}

function onRollback() {
  rollbackAuctionData();
  refreshRows();
  auctionStore.bumpDataVersion(ds.value);
  auctionStore.refresh();
}

function onRepair() {
  repairAuctionInWatchlistForDate().then(() => {
    refreshRows();
    auctionStore.bumpDataVersion(ds.value);
    auctionStore.refresh();
  }).catch(e => console.error('恢复失败:', e));
}

function _clearAllConcepts() {
  const targetDate = auctionStore.currentDate;
  const auctionData = getAuctionData();
  const existingList = auctionData[targetDate] || [];
  if (existingList.length === 0) { alert('当前没有数据可清除！'); return; }
  let clearCount = 0;
  existingList.forEach(item => {
    if ((item.note && item.note.includes('(')) || item.topics) {
      let newNote = item.note || '';
      newNote = newNote.replace(/\(([^)]+)\)/g, '');
      item.note = newNote;
      item.topics = '';
      const parsed = parseNoteToFields(newNote);
      item.changePct = parsed.changePct;
      clearCount++;
    }
  });
  if (clearCount > 0) {
    patchAuctionFieldBatch(targetDate, existingList.filter(i => i.stock).map(i => ({ stock: i.stock.trim(), note: i.note || '', topics: '', change_pct: i.changePct || '' })));
    markAuctionDirty(targetDate);
    scheduleCloudPush();
    saveData();
    syncStockTopicsFromAuction(targetDate);
    alert('✅ 已清除 ' + clearCount + ' 条题材数据');
  } else {
    alert('没有找到需要清除的题材数据');
  }
}

function _clearAllText() {
  const targetDate = auctionStore.currentDate;
  const auctionData = getAuctionData();
  const existingList = auctionData[targetDate] || [];
  if (existingList.length === 0) { alert('当前没有数据可清除！'); return; }
  let clearCount = 0;
  existingList.forEach(item => {
    if (item.note) {
      const percentMatches = item.note.match(/-?\d+\.?\d*%/g) || [];
      const bracketMatches = item.note.match(/\([^)]+\)/g) || [];
      const ztDtMatches = item.note.match(/涨停|跌停/g) || [];
      const uniqueZtDt = [...new Set(ztDtMatches)];
      const newNote = percentMatches.join('') + uniqueZtDt.join('') + bracketMatches.join('');
      if (newNote !== item.note) {
        item.note = newNote;
        const parsed = parseNoteToFields(newNote);
        item.changePct = parsed.changePct;
        item.topics = parsed.topics;
        clearCount++;
      }
    }
  });
  if (clearCount > 0) {
    patchAuctionFieldBatch(targetDate, existingList.filter(i => i.stock).map(i => ({ stock: i.stock.trim(), note: i.note || '', change_pct: i.changePct || '', topics: i.topics || '' })));
    markAuctionDirty(targetDate);
    scheduleCloudPush();
    saveData();
    syncStockTopicsFromAuction(targetDate);
    alert('✅ 已清除 ' + clearCount + ' 条文字数据');
  } else {
    alert('没有找到需要清除的文字数据');
  }
}

function _clearAllNotes() {
  const targetDate = auctionStore.currentDate;
  const auctionData = getAuctionData();
  const existingList = auctionData[targetDate] || [];
  if (existingList.length === 0) { alert('当前没有数据可清除！'); return; }
  let clearCount = 0;
  existingList.forEach(item => {
    if (item.note) { item.note = ''; clearCount++; }
  });
  if (clearCount > 0) {
    patchAuctionFieldBatch(targetDate, existingList.filter(i => i.stock).map(i => ({ stock: i.stock.trim(), note: '' })));
    markAuctionDirty(targetDate);
    scheduleCloudPush();
    saveData();
    syncStockTopicsFromAuction(targetDate);
    alert('✅ 已清除 ' + clearCount + ' 条注释数据');
  } else {
    alert('没有找到需要清除的注释数据');
  }
}

function onClearConcepts() {
  _clearAllConcepts();
  refreshRows();
  auctionStore.bumpDataVersion(ds.value);
  auctionStore.refresh();
}
function onClearText() {
  _clearAllText();
  refreshRows();
  auctionStore.bumpDataVersion(ds.value);
  auctionStore.refresh();
}
function onClearNotes() {
  _clearAllNotes();
  refreshRows();
  auctionStore.bumpDataVersion(ds.value);
  auctionStore.refresh();
}

defineExpose({ open, close });
</script>

<style scoped>
.auction-edit-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 9998;
  display: flex;
  align-items: center;
  justify-content: center;
}
.auction-edit-modal {
  background: #fff;
  border-radius: 10px;
  width: 95vw;
  max-width: 500px;
  max-height: 88vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.auction-edit-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid #e5e7eb;
  flex-shrink: 0;
}
.auction-edit-title {
  font-size: 14px;
  font-weight: 600;
  color: #1f2937;
}
.auction-edit-close {
  border: none;
  background: none;
  font-size: 18px;
  color: #6b7280;
  cursor: pointer;
  padding: 0 4px;
}
.auction-edit-body {
  flex: 1;
  overflow-y: auto;
  padding: 0;
}

/* 粘贴区 */
.section-paste {
  padding: 10px 14px;
  border-bottom: 1px solid #f3f4f6;
}
.paste-textarea {
  width: 100%;
  height: 80px;
  padding: 6px 8px;
  font-size: 11px;
  border: 1px solid #e2e8f0;
  border-radius: 4px;
  resize: vertical;
  box-sizing: border-box;
}
.paste-btns {
  display: flex;
  gap: 6px;
  margin-top: 6px;
  flex-wrap: wrap;
}

/* 股票代码映射区 */
.section-codemap {
  padding: 10px 14px;
  border-bottom: 1px solid #f3f4f6;
  background: #f0fdf4;
  border-left: 3px solid #bbf7d0;
}
.section-codemap-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.section-codemap-title {
  font-size: 12px;
  color: #15803d;
  font-weight: 600;
}
.section-codemap-body {
  margin-top: 8px;
}
.section-codemap-hint {
  font-size: 10px;
  color: #166534;
  margin-bottom: 6px;
  line-height: 1.5;
}
.codemap-textarea {
  width: 100%;
  height: 60px;
  padding: 6px 8px;
  font-size: 11px;
  border: 1px solid #bbf7d0;
  border-radius: 4px;
  resize: vertical;
  box-sizing: border-box;
}
.codemap-btns {
  display: flex;
  gap: 6px;
  margin-top: 6px;
  flex-wrap: wrap;
}

/* 历史数据补录区 */
.section-history {
  padding: 10px 14px;
  border-bottom: 1px solid #f3f4f6;
  background: #eff6ff;
  border-left: 3px solid #bfdbfe;
}
.section-history-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.section-history-title {
  font-size: 12px;
  color: #1d4ed8;
  font-weight: 600;
}
.section-history-body {
  margin-top: 8px;
}
.section-history-hint {
  font-size: 10px;
  color: #1e40af;
  margin-bottom: 6px;
  line-height: 1.5;
}
.history-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  flex-wrap: wrap;
}
.history-date {
  padding: 3px 6px;
  font-size: 11px;
  border: 1px solid #bfdbfe;
  border-radius: 4px;
}
.history-radio {
  font-size: 11px;
  color: #374151;
  display: flex;
  align-items: center;
  gap: 3px;
}
.history-textarea {
  width: 100%;
  height: 60px;
  padding: 6px 8px;
  font-size: 11px;
  border: 1px solid #bfdbfe;
  border-radius: 4px;
  resize: vertical;
  box-sizing: border-box;
}

/* 开关 */
.toggle-switch {
  position: relative;
  display: inline-block;
  width: 36px;
  height: 20px;
}
.toggle-switch input {
  opacity: 0;
  width: 0;
  height: 0;
}
.toggle-slider {
  position: absolute;
  cursor: pointer;
  inset: 0;
  background: #ccc;
  border-radius: 20px;
  transition: 0.3s;
}
.toggle-slider:before {
  position: absolute;
  content: "";
  height: 16px;
  width: 16px;
  left: 2px;
  bottom: 2px;
  background: #fff;
  border-radius: 50%;
  transition: 0.3s;
}
.toggle-switch input:checked + .toggle-slider {
  background: #22c55e;
}
.toggle-switch input:checked + .toggle-slider:before {
  transform: translateX(16px);
}

/* API 区块 */
.api-section {
  padding: 10px 14px;
  border-bottom: 1px solid #f3f4f6;
}
.api-ths {
  background: #fffbeb;
}
.api-numcat {
  background: #fdf2f8;
}
.api-diag {
  background: #f0fdf4;
}
.api-section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}
.api-section-title {
  font-size: 12px;
  font-weight: 600;
}
.api-ths .api-section-title { color: #92400e; }
.api-numcat .api-section-title { color: #831843; }
.api-diag .api-section-title { color: #166534; }
.api-section-tag {
  font-size: 10px;
  font-family: monospace;
}
.api-ths .api-section-tag { color: #b45309; }
.api-numcat .api-section-tag { color: #be185d; }
.api-diag .api-section-tag { color: #16a34a; }
.api-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 5px;
}

/* 按钮 */
.btn {
  padding: 6px 8px;
  font-size: 11px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  min-height: 32px;
}
.btn-import { background: linear-gradient(135deg, #0ea5e9, #0284c7); color: #fff; }
.btn-concept { background: linear-gradient(135deg, #8b5cf6, #7c3aed); color: #fff; }
.btn-vision { background: linear-gradient(135deg, #f59e0b, #d97706); color: #fff; }
.btn-ths { background: linear-gradient(135deg, #f59e0b, #d97706); color: #fff; }
.btn-ths-wide { grid-column: span 2; font-weight: 600; }
.btn-numcat { background: linear-gradient(135deg, #ec4899, #db2777); color: #fff; }
.btn-numcat-wide { grid-column: span 2; background: linear-gradient(135deg, #be185d, #9d174d); font-weight: 600; }
.btn-diag { width: 100%; background: linear-gradient(135deg, #22c55e, #16a34a); color: #fff; font-weight: 600; }
.api-status-bar { padding: 6px 14px; font-size: 11px; color: #059669; background: #f0fdf4; border-bottom: 1px solid #f3f4f6; }
.btn-codemap-import { background: linear-gradient(135deg, #10b981, #059669); color: #fff; }
.btn-codemap-auto { background: linear-gradient(135deg, #8b5cf6, #7c3aed); color: #fff; }
.btn-codemap-clear { background: #fee2e2; color: #dc2626; border: 1px solid #fecaca; }
.btn-history-fill { margin-top: 6px; background: linear-gradient(135deg, #3b82f6, #2563eb); color: #fff; }

/* 表单 */
.form-scroll {
  padding: 8px 14px;
}
.form-row {
  display: flex;
  align-items: center;
  gap: 3px;
  margin-bottom: 3px;
}
.form-number {
  flex-shrink: 0;
  width: 20px;
  text-align: center;
  font-size: 11px;
  color: #6b7280;
}
.form-input {
  padding: 3px 5px;
  font-size: 11px;
  border: 1px solid #e2e8f0;
  border-radius: 4px;
  box-sizing: border-box;
}
.form-stock { flex: 2; min-width: 0; }
.form-volume { flex: 1; min-width: 0; }
.form-yest { flex: 1; min-width: 0; }
.form-remove {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 4px;
  background: #fee2e2;
  color: #dc2626;
  font-size: 13px;
  cursor: pointer;
}

/* 底部操作 */
.edit-actions {
  display: flex;
  gap: 6px;
  padding: 8px 14px;
  border-top: 1px solid #e5e7eb;
  flex-shrink: 0;
  flex-wrap: wrap;
}
.btn-add { background: #f0f9ff; color: #0284c7; border: 1px solid #bae6fd; }
.btn-save { background: linear-gradient(135deg, #22c55e, #16a34a); color: #fff; }
.btn-rollback { background: linear-gradient(135deg, #3b82f6, #2563eb); color: #fff; }
.btn-clear-concept { background: linear-gradient(135deg, #ef4444, #dc2626); color: #fff; }
.btn-clear-text { background: linear-gradient(135deg, #f97316, #ea580c); color: #fff; }
.btn-clear-note { background: linear-gradient(135deg, #6b7280, #4b5563); color: #fff; }
.btn-clear-all { background: linear-gradient(135deg, #7f1d1d, #991b1b); color: #fff; }
.btn-repair { background: linear-gradient(135deg, #0d9488, #0f766e); color: #fff; }
</style>
