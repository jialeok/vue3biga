<template>
  <Teleport to="body">
    <div v-if="visible" class="auction-edit-overlay" @click.self="close">
      <div class="auction-edit-modal">
        <div class="auction-edit-header">
          <span class="auction-edit-title">{{ dataSource === 'hot' ? '编辑热门股票' : '编辑早盘竞价' }}</span>
          <button class="auction-edit-close" @click="close">✕</button>
        </div>
        <div class="auction-edit-paste">
          <textarea v-model="pasteText" placeholder="从Excel复制粘贴到这里&#10;格式：股票名称[TAB]竞价量[TAB]昨日成交量" class="auction-edit-textarea"></textarea>
          <div class="auction-edit-paste-btns">
            <button @click="onPasteImport" class="auction-edit-btn import-btn">导入数据</button>
            <button @click="onHistoryFill" class="auction-edit-btn history-btn">历史填充</button>
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
        <div class="auction-edit-actions">
          <button @click="addRow" class="auction-edit-btn add-btn">+ 添加新行</button>
          <button @click="save" class="auction-edit-btn save-btn">保存</button>
          <button @click="clearAllRows" class="auction-edit-btn clear-btn">清空所有行</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { ref } from 'vue';
import { getTodayGroupList, saveData, importAuctionFromPaste, importAuctionHistoryFill,
  importHotFromPaste, importHotHistoryFill } from '../logic/app-core.js';
import { useUiStore } from '../stores/uiStore.js';
import auctionStore from '../stores/auctionStore.js';

const uiStore = useUiStore();

const props = defineProps({
  dataSource: { type: String, default: 'auction' }
});

const visible = ref(false);
const editRows = ref([]);
const pasteText = ref('');

function open() {
  const list = getTodayGroupList(props.dataSource);
  editRows.value = list.map(item => ({
    stock: item.stock || '',
    volume: item.volume || '',
    yestVolume: item.yestVolume || ''
  }));
  if (editRows.value.length === 0) {
    editRows.value.push({ stock: '', volume: '', yestVolume: '' });
  }
  pasteText.value = '';
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
  const ds = props.dataSource === 'hot' ? 'hot' : 'auction';
  auctionStore.bumpDataVersion(ds);
  auctionStore.refresh();
  close();
}

function onPasteImport() {
  if (!pasteText.value.trim()) return;
  const isHot = props.dataSource === 'hot';
  const fn = isHot ? importHotFromPaste : importAuctionFromPaste;
  fn(pasteText.value).then(() => {
    const list = getTodayGroupList(props.dataSource);
    editRows.value = list.map(item => ({
      stock: item.stock || '',
      volume: item.volume || '',
      yestVolume: item.yestVolume || ''
    }));
    pasteText.value = '';
    const ds = isHot ? 'hot' : 'auction';
    auctionStore.bumpDataVersion(ds);
    auctionStore.refresh();
  }).catch(e => console.error('导入失败:', e));
}

function onHistoryFill() {
  if (!pasteText.value.trim()) return;
  const isHot = props.dataSource === 'hot';
  const fn = isHot ? importHotHistoryFill : importAuctionHistoryFill;
  fn(pasteText.value).then(() => {
    const list = getTodayGroupList(props.dataSource);
    editRows.value = list.map(item => ({
      stock: item.stock || '',
      volume: item.volume || '',
      yestVolume: item.yestVolume || ''
    }));
    pasteText.value = '';
    const ds = isHot ? 'hot' : 'auction';
    auctionStore.bumpDataVersion(ds);
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
  max-height: 85vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.auction-edit-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid #e5e7eb;
}
.auction-edit-title {
  font-size: 15px;
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
.auction-edit-paste {
  padding: 10px 16px;
  border-bottom: 1px solid #f3f4f6;
}
.auction-edit-textarea {
  width: 100%;
  height: 70px;
  padding: 6px 8px;
  font-size: 12px;
  border: 1px solid #e2e8f0;
  border-radius: 4px;
  resize: vertical;
  box-sizing: border-box;
}
.auction-edit-paste-btns {
  display: flex;
  gap: 8px;
  margin-top: 6px;
}
.auction-edit-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 8px 16px;
}
.auction-form-row {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 4px;
}
.auction-form-number {
  flex-shrink: 0;
  width: 24px;
  text-align: center;
  font-size: 12px;
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
  padding: 4px 6px;
  font-size: 12px;
  border: 1px solid #e2e8f0;
  border-radius: 4px;
  box-sizing: border-box;
}
.auction-form-remove {
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 4px;
  background: #fee2e2;
  color: #dc2626;
  font-size: 14px;
  cursor: pointer;
}
.auction-edit-actions {
  display: flex;
  gap: 8px;
  padding: 10px 16px;
  border-top: 1px solid #e5e7eb;
}
.auction-edit-btn {
  padding: 6px 12px;
  font-size: 12px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
}
.import-btn {
  background: linear-gradient(135deg, #0ea5e9, #0284c7);
  color: #fff;
}
.history-btn {
  background: linear-gradient(135deg, #8b5cf6, #7c3aed);
  color: #fff;
}
.add-btn {
  background: #f0f9ff;
  color: #0284c7;
  border: 1px solid #bae6fd;
}
.save-btn {
  background: linear-gradient(135deg, #22c55e, #16a34a);
  color: #fff;
}
.clear-btn {
  background: #fee2e2;
  color: #dc2626;
  border: 1px solid #fecaca;
}
</style>