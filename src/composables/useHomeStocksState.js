// 从 HomeStocksView.vue 提取的「共享状态 + 业务逻辑」组合式函数。
// 设计为模块级单例：所有引用的组件（根视图及其子组件）共享同一份响应式状态，
// 以避免重复加载/重复注册事件。仅做位置迁移，逻辑与原始实现完全一致。
//
// 生命周期（onMounted / onUnmounted / watch / 事件总线 _on/_off）不在此模块顶层执行，
// 而是集中在 wireHomeStocksLifecycle() 中，仅供根视图调用一次。

import { ref, reactive, computed, shallowRef, triggerRef, watch, onMounted, onUnmounted } from 'vue';
import { getCurrentDate, setCurrentDate } from '../logic/app-core.js';
import { getStocksData } from '../data/supabase-client.js';
import { clearStarTagCache, clearProfitStatusCache } from '../logic/ui-bridge.js';
import { editStock, copyToTomorrow, copyToDate, deleteStock, openSoldEdit, openTrackEdit } from '../logic/stocks/operations.js';
import { saveStockFields, saveSoldRecords, saveTrack, importStockData } from '../logic/stocks/stocks-edit.js';
import { showToast } from './useToast.js';
import { getCurrentFilter, setCurrentFilter, getIsStockListCollapsed, setIsStockListCollapsed } from '../logic/stocks/list-state.js';
import { _on, _off } from '../stores/eventBus.js';
import { useUiStore } from '../stores/uiStore.js';
import { getPreviousTradingDay, getNextTradingDay, isTradingDay, getMostRecentTradingDay } from '../logic/date/trading-day-helpers.js';

function safe(fn, ...args) {
  try { return fn(...args); } catch (e) { console.error('[HomeStocksView]', e); return undefined; }
}

const loading = ref(true);

const stockStats = reactive({
  todayCount: 0, boughtCount: 0, soldCount: 0, holdCount: 0
});

function updateStockStats(all) {
  const list = all || [];
  stockStats.todayCount = list.length;
  stockStats.boughtCount = 0;
  stockStats.soldCount = 0;
  stockStats.holdCount = 0;
  list.forEach(s => {
    if (s.bought) stockStats.boughtCount++;
    if (s.sold) stockStats.soldCount++;
    if (s.hold) stockStats.holdCount++;
  });
}

const data = ref({ currentDate: '', list: [] });
const expandedIds = shallowRef(new Set());
const collapsedIds = shallowRef(new Set());
const expandedActionsId = ref(null);
let lastDate = null;

function allTodayData() {
  return getStocksData()[getCurrentDate()] || [];
}

function getPriority(stock) {
  if (stock.bought) return 3;
  if (stock.hold) return 2;
  if (stock.sold) return 1;
  return 0;
}

const currentFilter = ref(getCurrentFilter());
function setFilter(filter) {
  setCurrentFilter(filter);
  currentFilter.value = filter;
}

const sortedList = computed(() => {
  let list = [...(data.value.list || [])];
  const filter = currentFilter.value;
  if (filter === '已买') list = list.filter(s => s.bought);
  else if (filter === '已卖') list = list.filter(s => s.sold);
  else if (filter === '持有') list = list.filter(s => s.hold);

  list.sort((a, b) => {
    const pa = getPriority(a), pb = getPriority(b);
    if (pa !== pb) return pb - pa;
    return (b.id || 0) - (a.id || 0);
  });
  return list;
});

function refresh() {
  loading.value = true;
  clearStarTagCache();
  clearProfitStatusCache();
  const newDate = getCurrentDate();
  if (newDate !== lastDate) {
    expandedIds.value = new Set();
    collapsedIds.value = new Set();
    expandedActionsId.value = null;
    lastDate = newDate;
  }
  const list = allTodayData();
  data.value = { currentDate: newDate, list };
  updateStockStats(list);
  loading.value = false;
}

function localRefresh(stockId) {
  if (stockId != null) {
    const idx = data.value.list.findIndex(s => s.id === stockId || s.id == stockId);
    if (idx !== -1) data.value.list[idx] = { ...data.value.list[idx] };
  }
  data.value = { currentDate: data.value.currentDate, list: [...data.value.list] };
}

const isCollapsedMode = ref(getIsStockListCollapsed());
const toggleText = computed(() => isCollapsedMode.value ? '展开全部' : '收起全部');
const toggleIcon = computed(() => isCollapsedMode.value ? '📋' : '📑');
function toggleCollapse() {
  isCollapsedMode.value = !isCollapsedMode.value;
  setIsStockListCollapsed(isCollapsedMode.value);
  if (isCollapsedMode.value) {
    collapsedIds.value = new Set();
  } else {
    expandedIds.value = new Set();
  }
  expandedActionsId.value = null;
}
function isExpanded(stock) {
  return isCollapsedMode.value ? expandedIds.value.has(stock.id) : !collapsedIds.value.has(stock.id);
}
function toggleExpand(stock) {
  if (isCollapsedMode.value) {
    const set = expandedIds.value;
    if (set.has(stock.id)) set.delete(stock.id); else set.add(stock.id);
    triggerRef(expandedIds);
  } else {
    const set = collapsedIds.value;
    if (set.has(stock.id)) set.delete(stock.id); else set.add(stock.id);
    triggerRef(collapsedIds);
  }
  expandedActionsId.value = null;
}
function onHeaderLeftClick(e, stock) { e.stopPropagation(); toggleExpand(stock); }
function onHeaderRightClick(e, stock) { e.stopPropagation(); toggleExpand(stock); }
function onBodyClick(e, stock) {
  e.stopPropagation();
  if (isExpanded(stock)) {
    expandedActionsId.value = expandedActionsId.value === stock.id ? null : stock.id;
  }
}

// ---- 编辑弹窗 ----
const editModalActive = ref(false);
const editModalTitle = ref('编辑股票');
const editForm = reactive({});
let editingStockId = null;
const editFields = [
  { key: 'name', label: '股票名称', type: 'text' },
  { key: 'stage', label: '阶段', type: 'select', options: ['二板', '首板', '连板', '二波', '高位', '其它'] },
  { key: 'open', label: '竞价开盘(%)', type: 'text' },
  { key: 'close', label: '收盘(%)', type: 'text' },
  { key: 'turnover', label: '换手率(%)', type: 'text' },
  { key: 'adjust', label: '调整幅度', type: 'text' },
  { key: 'pattern', label: '竞符合数形态', type: 'text' },
  { key: 'axis', label: '零轴位置', type: 'text' },
  { key: 'kbiliangkai', label: '开盘量比', type: 'text' },
  { key: 'sfliangneng', label: '缩放量能', type: 'text' },
  { key: 'xgcaiti', label: '相关题材', type: 'text' },
  { key: 'remark', label: '备注', type: 'text' },
  { key: 'bought', label: '已买', type: 'bool' },
  { key: 'sold', label: '已卖', type: 'bool' },
  { key: 'hold', label: '持有', type: 'bool' },
  { key: 'watch', label: '观察', type: 'bool' },
  { key: 'dragon', label: '龙头', type: 'bool' },
  { key: 'bomb', label: '炸板', type: 'bool' },
  { key: 'sellHigh', label: '冲高卖', type: 'bool' },
  { key: 'sell1120', label: '11:20卖', type: 'bool' },
  { key: 'sell1450', label: '14:50卖', type: 'bool' },
  { key: 'nishi', label: '逆势', type: 'bool' },
  { key: 'shunshi', label: '顺势', type: 'bool' },
  { key: 'nextDay', label: '次日预测', type: 'text' },
];

function openEditModal(id) {
  const stock = (getStocksData()[getCurrentDate()] || []).find(s => s.id === id);
  if (!stock) { showToast('未找到股票数据'); return; }
  editingStockId = id;
  editModalTitle.value = '编辑: ' + (stock.name || '');
  Object.keys(editForm).forEach(k => delete editForm[k]);
  editFields.forEach(f => {
    const val = stock[f.key] !== undefined ? stock[f.key] : '';
    if (['bought','sold','hold','watch','dragon','bomb','sellHigh','sell1120','sell1450','nishi','shunshi'].includes(f.key)) {
      editForm[f.key] = val === true || val === 1 || val === '1';
    } else {
      editForm[f.key] = val;
    }
  });
  editModalActive.value = true;
}

async function saveEditModal() {
  if (editingStockId === null) return;
  const fields = { ...editForm };
  try {
    // HS-04：缓存更新+保存交给 Logic 层（stocks-edit.js），UI 不再直接改写 Data 内部对象
    // HS-02：await 真实推送结果，成败可见
    await saveStockFields(editingStockId, fields);
    // HS-01：用 localRefresh 精准更新该行（生成新对象引用），使 v-memo 失效并刷新
    editModalActive.value = false;
    localRefresh(editingStockId);
    showToast('已保存');
  } catch (e) {
    console.error('[HomeStocksView] saveEditModal 保存失败', e);
    showToast('保存失败：' + (e && e.message ? e.message : '未知错误'));
  }
}

function openModal(id) { openEditModal(id); }
function closeModal() { editModalActive.value = false; }

// ---- 卖出记录弹窗 ----
const soldEditModalActive = ref(false);
const editingSoldRows = ref([]);
let soldEditingStockId = null;
const soldEditStockName = ref('');

function genSoldId() { return Date.now().toString() + Math.random().toString(36).substr(2, 5); }
function pad2(n) { return String(n).padStart(2, '0'); }
function nowTimeStr() { const n = new Date(); return getCurrentDate() + ' ' + pad2(n.getHours()) + ':' + pad2(n.getMinutes()); }

function openSoldEditModal(id) {
  soldEditingStockId = id;
  const list = getStocksData()[getCurrentDate()] || [];
  const stock = list.find(s => s.id === id || s.id == id);
  if (!stock) { showToast('未找到股票数据'); return; }
  soldEditStockName.value = stock.name || '股票';
  const records = (stock.soldRecords && stock.soldRecords.length > 0) ? JSON.parse(JSON.stringify(stock.soldRecords)) : [];
  editingSoldRows.value = records.length > 0
    ? records.map(r => ({ id: r.id || genSoldId(), date: r.date || '', profit: r.profit != null ? String(r.profit) : '', percent: r.percent != null ? String(r.percent) : '', type: r.type || '' }))
    : [{ id: genSoldId(), date: nowTimeStr(), profit: '', percent: '', type: '' }];
  soldEditModalActive.value = true;
}

function addSoldRow() { editingSoldRows.value.push({ id: genSoldId(), date: nowTimeStr(), profit: '', percent: '', type: '' }); }
function removeSoldRow(idx) { editingSoldRows.value.splice(idx, 1); }

async function saveSoldEditModal() {
  if (soldEditingStockId === null) return;
  try {
    // HS-04：缓存更新+保存交给 Logic 层；HS-02：await 真实推送结果，成败可见
    await saveSoldRecords(soldEditingStockId, editingSoldRows.value);
    soldEditModalActive.value = false;
    clearProfitStatusCache();
    localRefresh(soldEditingStockId);
    showToast('卖出记录已保存');
  } catch (e) {
    console.error('[HomeStocksView] saveSoldEditModal 保存失败', e);
    showToast('保存失败：' + (e && e.message ? e.message : '未知错误'));
  }
}

// ---- 追踪记录弹窗 ----
const trackEditModalActive = ref(false);
const editingTrackRows = ref([]);
let trackEditingStockId = null;
const trackEditStockName = ref('');

function openTrackEditModal(id) {
  trackEditingStockId = id;
  const list = getStocksData()[getCurrentDate()] || [];
  const stock = list.find(s => s.id === id || s.id == id);
  if (!stock) { showToast('未找到股票数据'); return; }
  trackEditStockName.value = stock.name || '股票';
  const trackData = stock.track ? JSON.parse(JSON.stringify(stock.track)) : [];
  editingTrackRows.value = trackData.length > 0
    ? trackData.map(r => ({ date: r.date || '', content: r.content || '' }))
    : [{ date: '', content: '' }];
  trackEditModalActive.value = true;
}

function addTrackRow() { editingTrackRows.value.push({ date: '', content: '' }); }
function removeTrackRow(idx) {
  if (editingTrackRows.value.length > 1) { editingTrackRows.value.splice(idx, 1); }
  else { editingTrackRows.value[0].date = ''; editingTrackRows.value[0].content = ''; }
}
function onTrackContentInput(idx) {
  const row = editingTrackRows.value[idx];
  const c = (row.content || '').trim();
  if (c && !(row.date || '').trim()) { row.date = nowTimeStr(); }
  else if (!c) { row.date = ''; }
}

async function saveTrackEditModal() {
  if (trackEditingStockId === null) return;
  try {
    // HS-04：缓存更新+保存交给 Logic 层；HS-02：await 真实推送结果，成败可见
    await saveTrack(trackEditingStockId, editingTrackRows.value);
    trackEditModalActive.value = false;
    localRefresh(trackEditingStockId);
    showToast('追踪记录已保存');
  } catch (e) {
    console.error('[HomeStocksView] saveTrackEditModal 保存失败', e);
    showToast('保存失败：' + (e && e.message ? e.message : '未知错误'));
  }
}

// ---- 日期选择器弹窗 ----
const datePickerActive = ref(false);
const pickerYear = ref(new Date().getFullYear());
const pickerMonth = ref(new Date().getMonth());
const pickerSelected = ref('');
let datePickerCallback = null;

const pickerDays = computed(() => {
  const days = [];
  const firstDay = new Date(pickerYear.value, pickerMonth.value, 1);
  const lastDay = new Date(pickerYear.value, pickerMonth.value + 1, 0);
  const startWeekday = firstDay.getDay();
  for (let i = 0; i < startWeekday; i++) days.push({ key: 'pad' + i, label: '', valid: false, isToday: false });
  const todayStr = getMostRecentTradingDay();
  for (let d = 1; d <= lastDay.getDate(); d++) {
    const dateStr = pickerYear.value + '-' + String(pickerMonth.value + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    days.push({
      key: dateStr,
      label: d,
      valid: isTradingDay(dateStr),
      isToday: dateStr === todayStr
    });
  }
  return days;
});

function openDatePicker(callback) {
  const cur = getCurrentDate();
  if (cur && /^\d{4}-\d{2}-\d{2}$/.test(cur)) {
    pickerYear.value = parseInt(cur.slice(0, 4));
    pickerMonth.value = parseInt(cur.slice(5, 7)) - 1;
    pickerSelected.value = cur;
  }
  datePickerCallback = callback;
  datePickerActive.value = true;
}
function selectPickerDate(dateStr) {
  pickerSelected.value = dateStr;
  datePickerActive.value = false;
  if (datePickerCallback) datePickerCallback(dateStr);
}
function prevPickerMonth() {
  if (pickerMonth.value === 0) { pickerMonth.value = 11; pickerYear.value--; }
  else pickerMonth.value--;
}
function nextPickerMonth() {
  if (pickerMonth.value === 11) { pickerMonth.value = 0; pickerYear.value++; }
  else pickerMonth.value++;
}
function pickerGoToday() {
  const today = getMostRecentTradingDay();
  selectPickerDate(today);
}

// ---- 列表内交互（来自根视图的原 onEdit/onCopy.../onSoldEdit/onTrackEdit） ----
function onEdit(id) { openEditModal(id); }
function onCopyTomorrow(id) { safe(copyToTomorrow, id); }
function onCopyDate(id) { safe(copyToDate, id); }
function onDelete(id) { safe(deleteStock, id); }
function onSoldEdit(id) { openSoldEditModal(id); }
function onTrackEdit(stock) { openTrackEditModal(stock.id !== undefined ? stock.id : stock.name); }

// ---- 日期导航 / 导入导出 ----
function changeDate(days) {
  const cur = getCurrentDate();
  const d = new Date(cur);
  d.setDate(d.getDate() + days);
  const dateStr = d.toISOString().split('T')[0];
  setCurrentDate(dateStr);
  refresh();
}

function goToPrevTradingDay() {
  const prev = getPreviousTradingDay(getCurrentDate());
  if (prev) { setCurrentDate(prev); refresh(); }
}
function goToNextTradingDay() {
  const next = getNextTradingDay(getCurrentDate());
  if (next) { setCurrentDate(next); refresh(); }
}

function goToday() {
  const today = getMostRecentTradingDay();
  setCurrentDate(today);
  refresh();
}

function exportData() {
  const allData = getStocksData();
  const json = JSON.stringify(allData, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'stocks-export-' + getCurrentDate() + '.json';
  a.click();
  URL.revokeObjectURL(url);
  showToast('已导出');
}

function showImportModal() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const imported = JSON.parse(ev.target.result);
        // HS-04：整体替换缓存+保存交给 Logic 层；HS-02：await 真实推送结果，成败可见
        await importStockData(imported);
        refresh();
        showToast('导入成功');
      } catch (err) {
        console.error('[HomeStocksView] 导入失败', err);
        showToast('导入失败: ' + (err && err.message ? err.message : err));
      }
    };
    reader.readAsText(file);
  };
  input.click();
}

function onStockEdit(id) { openEditModal(id); }
function onStockSoldEdit(id) { openSoldEditModal(id); }
function onStockTrackEdit(id) { openTrackEditModal(id); }
function onStocksRefresh() { refresh(); }

let wired = false;
function wireHomeStocksLifecycle() {
  if (wired) return;
  wired = true;

  const uiStore = useUiStore();

  watch(() => uiStore.currentDate, (newDate) => {
    if (newDate && newDate !== getCurrentDate()) {
      setCurrentDate(newDate);
      refresh();
    }
  });

  onMounted(() => {
    refresh();
    _on('stock-edit', onStockEdit);
    _on('stock-sold-edit', onStockSoldEdit);
    _on('stock-track-edit', onStockTrackEdit);
    _on('stocks-refresh', onStocksRefresh);
  });

  onUnmounted(() => {
    _off('stock-edit', onStockEdit);
    _off('stock-sold-edit', onStockSoldEdit);
    _off('stock-track-edit', onStockTrackEdit);
    _off('stocks-refresh', onStocksRefresh);
  });
}

export function useHomeStocksState() {
  return {
    // 状态
    loading,
    stockStats,
    data,
    expandedIds,
    collapsedIds,
    expandedActionsId,
    currentFilter,
    isCollapsedMode,
    toggleText,
    toggleIcon,
    sortedList,
    editModalActive,
    editModalTitle,
    editForm,
    editFields,
    soldEditModalActive,
    editingSoldRows,
    soldEditStockName,
    trackEditModalActive,
    editingTrackRows,
    trackEditStockName,
    datePickerActive,
    pickerYear,
    pickerMonth,
    pickerSelected,
    pickerDays,
    // 方法
    updateStockStats,
    setFilter,
    refresh,
    localRefresh,
    toggleCollapse,
    isExpanded,
    toggleExpand,
    onHeaderLeftClick,
    onHeaderRightClick,
    onBodyClick,
    openEditModal,
    saveEditModal,
    openModal,
    closeModal,
    openSoldEditModal,
    addSoldRow,
    removeSoldRow,
    saveSoldEditModal,
    openTrackEditModal,
    addTrackRow,
    removeTrackRow,
    onTrackContentInput,
    saveTrackEditModal,
    openDatePicker,
    selectPickerDate,
    prevPickerMonth,
    nextPickerMonth,
    pickerGoToday,
    onEdit,
    onCopyTomorrow,
    onCopyDate,
    onDelete,
    onSoldEdit,
    onTrackEdit,
    changeDate,
    goToPrevTradingDay,
    goToNextTradingDay,
    goToday,
    exportData,
    showImportModal,
    wireHomeStocksLifecycle
  };
}
