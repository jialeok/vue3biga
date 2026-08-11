<template>
  <Teleport to="body">
    <div v-if="visible" class="auction-edit-overlay" @click.self="close">
      <div class="auction-edit-modal">
        <div class="auction-edit-header">
          <span class="auction-edit-title">{{ dataSource === 'hot' ? '编辑热门股票' : '编辑早盘竞价' }}</span>
          <button class="auction-edit-close" @click="close">✕</button>
        </div>
        <div class="auction-edit-body">
          <div class="auction-edit-paste">
            <textarea v-model="pasteText" placeholder="从Excel复制粘贴&#10;格式：股票名称[TAB]竞价量[TAB]昨日成交量" class="auction-edit-textarea"></textarea>
            <div class="auction-edit-paste-btns">
              <button @click="onPasteImport" class="api-btn api-import">导入数据</button>
              <button @click="onHistoryFill" class="api-btn api-history">历史填充</button>
            </div>
          </div>
          <div class="api-section api-ths">
            <div class="api-section-title">同花顺接口</div>
            <div class="api-grid">
              <button @click="runBackend(thsFns.ladder)" class="api-btn api-ths-btn">获取最近多板</button>
              <button @click="runBackend(thsFns.yestVol)" class="api-btn api-ths-btn">两全昨日成交量</button>
              <button @click="runBackend(thsFns.todayYest)" class="api-btn api-ths-btn">当天昨日成交量</button>
              <button @click="runBackend(thsFns.prevYest)" class="api-btn api-ths-btn">对比日昨成交量</button>
              <button @click="runBackend(thsFns.changePct)" class="api-btn api-ths-btn">获取涨幅</button>
              <button @click="runBackend(thsFns.gapYest)" class="api-btn api-ths-btn">历史断点昨量</button>
            </div>
          </div>
          <div class="api-section api-numcat">
            <div class="api-section-title">猫抓数据接口</div>
            <div class="api-grid">
              <button @click="runBackend(numcatFns.today)" class="api-btn api-numcat-btn">获取当天竞价量</button>
              <button @click="runBackend(numcatFns.all)" class="api-btn api-numcat-btn">全竞价量</button>
              <button @click="runBackend(numcatFns.threeDays)" class="api-btn api-numcat-btn">连抓三天补全</button>
              <button @click="runBackend(numcatFns.topics)" class="api-btn api-numcat-btn">补全题材</button>
              <button @click="runBackend(numcatFns.monitor)" class="api-btn api-numcat-btn">查询监管</button>
            </div>
          </div>
          <div class="auction-edit-scroll">
            <div v-for="(row, idx) in editRows" :key="idx" class="auction-form-row">
              <span class="auction-form-number">{{ idx + 1 }}</span>
              <input v-model="row.stock" placeholder="股票名称" class="auction-form-stock">
              <input v-model="row.volume" placeholder="竞价量" class="auction-form-volume">
              <input v-model="row.yestVolume" placeholder="昨日成交量" class="auction-form-yest">
              <button @click="removeRow(idx)" class="auction-form-remove">×</button>
            </div>
          </div>
        </div>
        <div class="auction-edit-actions">
          <button @click="addRow" class="api-btn api-add">+ 添加新行</button>
          <button @click="save" class="api-btn api-save">保存</button>
          <button @click="clearAllRows" class="api-btn api-clear">清空所有行</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, computed } from 'vue';
import { getTodayGroupList, saveData, importAuctionFromPaste, importAuctionHistoryFill,
  importHotFromPaste, importHotHistoryFill,
  fetchLadderConstituentsMain, fillYesterdayVolumeFromThs, fillTodayYesterdayVolumeFromThs,
  fillYesterdayYesterdayVolumeFromThs, fetchChangePctFromThs, fillAuctionHistoryGapYestVolumeFromThs,
  fetchTodayAuctionFromNumcat, fetchAllAuctionFromNumcat, fetchThreeDaysAuctionFromNumcat,
  fillTopicsFromNumcat, fetchMonitorWarningFromNumcat,
  fetchHotLimitUpLadderFromThs, fillHotYesterdayVolumeFromThs, fillHotTodayYesterdayVolumeFromThs,
  fillHotYesterdayYesterdayVolumeFromThs, fetchHotChangePctFromThs, fillHotHistoryGapYestVolumeFromThs,
  fetchHotTodayAuctionFromNumcat, fetchAllHotAuctionFromNumcat, fetchThreeDaysHotAuctionFromNumcat,
  fillHotTopicsFromNumcat, fetchHotMonitorWarningFromNumcat
} from '../logic/app-core.js';
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

const isHot = computed(() => props.dataSource === 'hot');
const ds = computed(() => isHot.value ? 'hot' : 'auction');

const thsFns = computed(() => isHot.value ? {
  ladder: fetchHotLimitUpLadderFromThs,
  yestVol: fillHotYesterdayVolumeFromThs,
  todayYest: fillHotTodayYesterdayVolumeFromThs,
  prevYest: fillHotYesterdayYesterdayVolumeFromThs,
  changePct: fetchHotChangePctFromThs,
  gapYest: fillHotHistoryGapYestVolumeFromThs
} : {
  ladder: fetchLadderConstituentsMain,
  yestVol: fillYesterdayVolumeFromThs,
  todayYest: fillTodayYesterdayVolumeFromThs,
  prevYest: fillYesterdayYesterdayVolumeFromThs,
  changePct: fetchChangePctFromThs,
  gapYest: fillAuctionHistoryGapYestVolumeFromThs
});

const numcatFns = computed(() => isHot.value ? {
  today: fetchHotTodayAuctionFromNumcat,
  all: fetchAllHotAuctionFromNumcat,
  threeDays: fetchThreeDaysHotAuctionFromNumcat,
  topics: fillHotTopicsFromNumcat,
  monitor: fetchHotMonitorWarningFromNumcat
} : {
  today: fetchTodayAuctionFromNumcat,
  all: fetchAllAuctionFromNumcat,
  threeDays: fetchThreeDaysAuctionFromNumcat,
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

function runBackend(fn) {
  if (!fn) return;
  apiStatus.value = '执行中...';
  Promise.resolve(fn()).then(() => {
    refreshRows();
    apiStatus.value = '完成';
    auctionStore.bumpDataVersion(ds.value);
    auctionStore.refresh();
  }).catch(e => {
    console.error('接口调用失败:', e);
    apiStatus.value = '失败: ' + e.message;
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

function onHistoryFill() {
  if (!pasteText.value.trim()) return;
  const fn = isHot.value ? importHotHistoryFill : importAuctionHistoryFill;
  fn(pasteText.value).then(() => {
    refreshRows();
    pasteText.value = '';
    auctionStore.bumpDataVersion(ds.value);
    auctionStore.refresh();
  }).catch(e => console.error('历史填充失败:', e));
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
.auction-edit-paste {
  padding: 8px 14px;
  border-bottom: 1px solid #f3f4f6;
}
.auction-edit-textarea {
  width: 100%;
  height: 60px;
  padding: 6px 8px;
  font-size: 11px;
  border: 1px solid #e2e8f0;
  border-radius: 4px;
  resize: vertical;
  box-sizing: border-box;
}
.auction-edit-paste-btns {
  display: flex;
  gap: 6px;
  margin-top: 5px;
}
.api-section {
  padding: 8px 14px;
  border-bottom: 1px solid #f3f4f6;
}
.api-ths {
  background: #fffbeb;
}
.api-numcat {
  background: #fdf2f8;
}
.api-section-title {
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 5px;
}
.api-ths .api-section-title {
  color: #92400e;
}
.api-numcat .api-section-title {
  color: #831843;
}
.api-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 5px;
}
.api-btn {
  padding: 6px 8px;
  font-size: 11px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  min-height: 32px;
}
.api-ths-btn {
  background: linear-gradient(135deg, #f59e0b, #d97706);
  color: #fff;
}
.api-numcat-btn {
  background: linear-gradient(135deg, #ec4899, #db2777);
  color: #fff;
}
.api-import {
  background: linear-gradient(135deg, #0ea5e9, #0284c7);
  color: #fff;
}
.api-history {
  background: linear-gradient(135deg, #8b5cf6, #7c3aed);
  color: #fff;
}
.auction-edit-scroll {
  padding: 8px 14px;
}
.auction-form-row {
  display: flex;
  align-items: center;
  gap: 3px;
  margin-bottom: 3px;
}
.auction-form-number {
  flex-shrink: 0;
  width: 20px;
  text-align: center;
  font-size: 11px;
  color: #6b7280;
}
.auction-form-stock {
  flex: 2;
  min-width: 0;
}
.auction-form-volume {
  flex: 1;
  min-width: 0;
}
.auction-form-yest {
  flex: 1;
  min-width: 0;
}
.auction-form-stock,
.auction-form-volume,
.auction-form-yest {
  padding: 3px 5px;
  font-size: 11px;
  border: 1px solid #e2e8f0;
  border-radius: 4px;
  box-sizing: border-box;
}
.auction-form-remove {
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
.auction-edit-actions {
  display: flex;
  gap: 6px;
  padding: 8px 14px;
  border-top: 1px solid #e5e7eb;
  flex-shrink: 0;
}
.api-add {
  background: #f0f9ff;
  color: #0284c7;
  border: 1px solid #bae6fd;
}
.api-save {
  background: linear-gradient(135deg, #22c55e, #16a34a);
  color: #fff;
}
.api-clear {
  background: #fee2e2;
  color: #dc2626;
  border: 1px solid #fecaca;
}
</style>
