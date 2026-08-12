<template>
  <Teleport to="body">
    <div v-if="visible" class="auction-edit-overlay" @click.self="close">
      <div class="auction-edit-modal">

        <!-- 头部（随内容一起滚动） -->
        <div class="modal-header">
          <div class="auction-edit-title">{{ isHot ? '编辑热门股票' : '编辑最近多板早盘竞价' }}</div>
          <button class="close-btn" @click="close">×</button>
        </div>

        <!-- 粘贴区 -->
        <div class="section-paste">
          <textarea v-model="pasteText" placeholder="从 Excel 复制后直接粘贴到这里&#10;格式1：股票名称[TAB]竞价量[TAB]昨日成交量&#10;格式2：股票名称[TAB]涨幅[TAB]概念（注释叠加）&#10;格式3：股票名称[TAB]涨幅 或 概念&#10;格式4：股票名称 涨幅%" class="paste-textarea"></textarea>
          <div class="paste-btns">
            <button @click="onPasteImport" class="btn btn-import">导入数据</button>
            <button @click="onReplaceConcept" class="btn btn-concept">替换概念</button>
            <button @click="onAiVision" class="btn btn-vision">📷 AI识图</button>
          </div>
          <span v-if="pasteStatus" class="inline-status">{{ pasteStatus }}</span>
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
            <span v-if="codeMapStatus" class="inline-status">{{ codeMapStatus }}</span>
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
            <span v-if="historyStatus" class="inline-status">{{ historyStatus }}</span>
          </div>
        </div>

        <!-- 同花顺接口 -->
        <div class="api-section api-ths">
          <div class="api-section-header">
            <span class="api-section-title">同花顺接口</span>
            <span class="api-section-tag">883410.TI · fuyao-proxy</span>
          </div>
          <div class="api-grid">
            <button v-for="b in thsButtons" :key="b.key"
              @click="runBackend(b.fn, b.key, 'thsApiStatus')"
              :class="['btn', 'btn-ths', { 'btn-ths-wide': b.wide }]"
              :disabled="busyKey === b.key">
              {{ busyKey === b.key ? '处理中...' : b.label }}
            </button>
          </div>
          <span class="api-status-line" :class="statusCls('thsApiStatus')">{{ statusMsg('thsApiStatus') }}</span>
        </div>

        <!-- 猫抓接口 -->
        <div class="api-section api-numcat">
          <div class="api-section-header">
            <span class="api-section-title">猫抓数据接口</span>
            <span class="api-section-tag">免费额度每日10次</span>
          </div>
          <div class="api-grid">
            <button v-for="b in numcatButtons" :key="b.key"
              @click="runBackend(b.fn, b.key, 'numcatApiStatus')"
              :class="['btn', 'btn-numcat', { 'btn-numcat-wide': b.wide }]"
              :disabled="busyKey === b.key">
              {{ busyKey === b.key ? '处理中...' : b.label }}
            </button>
          </div>
          <span class="api-status-line" :class="statusCls('numcatApiStatus')">{{ statusMsg('numcatApiStatus') }}</span>
        </div>

        <!-- 接口诊断 -->
        <div class="api-section api-diag">
          <div class="api-section-header">
            <span class="api-section-title">接口诊断</span>
            <span class="api-section-tag">独立运行</span>
          </div>
          <button @click="onRunDiag" class="btn btn-diag" :disabled="busyKey === 'diag'">{{ busyKey === 'diag' ? '诊断中...' : '🔍 运行诊断' }}</button>
          <span class="api-status-line" :class="statusCls('auctionDiagStatus')">{{ statusMsg('auctionDiagStatus') }}</span>
        </div>

        <!-- 表单行 -->
        <div class="rank-form-scroll-container">
          <div v-for="(row, idx) in editRows" :key="idx" class="auction-form-row">
            <span class="rank-form-number">{{ idx + 1 }}</span>
            <input v-model="row.stock" placeholder="股票名称" class="form-input auction-form-stock-input">
            <input v-model="row.volume" placeholder="竞价量(万股)" class="form-input auction-form-volume-input">
            <input v-model="row.yestVolume" placeholder="昨日成交量(万股)" class="form-input auction-form-yest-input">
            <button @click="removeRow(idx)" class="remove-rank-btn">×</button>
          </div>
        </div>

        <!-- 底部操作按钮（随内容一起滚动） -->
        <button @click="addRow" class="add-rank-btn">+ 添加新行</button>
        <button @click="save" class="submit-btn save">保存</button>
        <button @click="onRollback" class="submit-btn rollback">撤回</button>
        <button @click="onClearConcepts" class="submit-btn clear-concept">清除题材</button>
        <button @click="onClearText" class="submit-btn clear-text">清除文字</button>
        <button @click="onClearNotes" class="submit-btn clear-note">清除注释</button>
        <button @click="clearAllRows" class="submit-btn clear-all">清空所有行</button>
        <button @click="onRepair" class="submit-btn repair">🔧 恢复本日数据</button>

      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, computed, watch } from 'vue';
import { apiStatusMap } from '../logic/ui-bridge.js';
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

const codeMapOpen = ref(false);
const codeMapText = ref('');
const historyOpen = ref(false);
const historyDate = ref('');
const historyColType = ref('volume');
const historyText = ref('');

const isHot = computed(() => props.dataSource === 'hot');
const ds = computed(() => isHot.value ? 'hot' : 'auction');

const pasteStatus = ref('');
const codeMapStatus = ref('');
const historyStatus = ref('');

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

const thsButtons = computed(() => [
  { key: 'ths-ladder', label: '获取最近多板', fn: thsFns.value.ladder },
  { key: 'ths-yestVol', label: '两全昨日成交量', fn: thsFns.value.yestVol },
  { key: 'ths-todayYest', label: '当天昨日成交量', fn: thsFns.value.todayYest },
  { key: 'ths-prevYest', label: '对比日昨成交量', fn: thsFns.value.prevYest },
  { key: 'ths-changePct', label: '获取涨幅', fn: thsFns.value.changePct },
  { key: 'ths-gapPct', label: '历史断点涨幅', fn: thsFns.value.gapPct },
  { key: 'ths-gapYest', label: '历史断点昨日成交量', fn: thsFns.value.gapYest, wide: true }
]);

const numcatButtons = computed(() => [
  { key: 'nc-yestAuction', label: '补全昨日竞价量', fn: numcatFns.value.yestAuction },
  { key: 'nc-today', label: '获取当天竞价量', fn: numcatFns.value.today },
  { key: 'nc-all', label: '全竞价量（昨日+今日一次请求）', fn: numcatFns.value.all, wide: true },
  { key: 'nc-fiveDays', label: '连抓五天补全（竞价量+昨成交量+涨幅）', fn: numcatFns.value.fiveDays, wide: true },
  { key: 'nc-topics', label: '补全题材', fn: numcatFns.value.topics },
  { key: 'nc-monitor', label: '查询监管', fn: numcatFns.value.monitor }
]);

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
  pasteStatus.value = '';
  codeMapStatus.value = '';
  historyStatus.value = '';
  // 清除上次会话残留的接口进度，并复位忙碌锁
  delete apiStatusMap.thsApiStatus;
  delete apiStatusMap.numcatApiStatus;
  delete apiStatusMap.auctionDiagStatus;
  busyKey.value = '';
  activeElId.value = '';
  if (busyTimer) { clearTimeout(busyTimer); busyTimer = null; }
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

const busyKey = ref('');
const activeElId = ref('');       // 当前正在执行的接口对应的状态 id
let busyTimer = null;             // 兜底解锁计时器

// 读取 app-core 业务层已经写到 apiStatusMap 的真实进度（原版 setApiStatus 的迁移植）
function statusMsg(elId) {
  const e = apiStatusMap[elId];
  return e ? e.msg : '';
}
function statusCls(elId) {
  const e = apiStatusMap[elId];
  return { ok: !!(e && e.ok === true), err: !!(e && e.ok === false) };
}
// 终止消息：原版每条接口函数收尾都会写 ✅ 成功 / ❌ 失败，据此判定任务完成
function isTerminal(msg) {
  return typeof msg === 'string' && (msg.indexOf('✅') >= 0 || msg.indexOf('❌') >= 0);
}

// statusRef 改为 elId（thsApiStatus / numcatApiStatus / auctionDiagStatus），
// 进度文本完全来自 app-core 内部的 setApiStatus（正在抓取 N 只 / ✅覆盖 X 跳过 Y / ❌...），
// 不再写自造的「执行中/完成」，从而保证用户能看到真实的抓取进度与成功/失败计数。
function runBackend(fn, key, elId) {
  if (!fn || busyKey.value) return;
  busyKey.value = key;
  activeElId.value = elId;
  if (apiStatusMap[elId]) delete apiStatusMap[elId]; // 清掉上次残留，避免立即被判定为终止
  // 用 Promise.resolve().then 包裹，确保 fn 同步抛错也能被捕获
  // （原 window.setBtnLoading 在 Vue 下无 DOM 目标会同步抛错）
  Promise.resolve().then(() => fn()).catch(e => {
    console.error('接口调用异常:', e);
    apiStatusMap[elId] = { msg: '❌ ' + (e && e.message ? e.message : String(e)), ok: false, ts: Date.now() };
  });
  // 兜底：60s 内无任何终止消息（异常漏报）时强制解锁，避免按钮永久卡死
  if (busyTimer) clearTimeout(busyTimer);
  busyTimer = setTimeout(() => { busyKey.value = ''; activeElId.value = ''; }, 60000);
}

// 监听三个接口状态 id 的时间戳：一旦出现终止消息（✅/❌），回填表单行并解锁按钮。
// 终止消息保留 1.2s 便于用户看清「覆盖 X 只 / 跳过 Y 只」后再解锁。
watch(
  () => [
    apiStatusMap.thsApiStatus && apiStatusMap.thsApiStatus.ts,
    apiStatusMap.numcatApiStatus && apiStatusMap.numcatApiStatus.ts,
    apiStatusMap.auctionDiagStatus && apiStatusMap.auctionDiagStatus.ts
  ],
  () => {
    const elId = activeElId.value;
    if (!elId) return;
    const entry = apiStatusMap[elId];
    if (entry && isTerminal(entry.msg)) {
      if (entry.ok) {
        refreshRows();
        auctionStore.bumpDataVersion(ds.value);
        auctionStore.refresh();
      }
      setTimeout(() => {
        const e2 = apiStatusMap[elId];
        if (e2 && isTerminal(e2.msg)) {
          busyKey.value = '';
          activeElId.value = '';
          if (busyTimer) { clearTimeout(busyTimer); busyTimer = null; }
        }
      }, 1200);
    }
  }
);

function onPasteImport() {
  if (!pasteText.value.trim()) return;
  const fn = isHot.value ? importHotFromPaste : importAuctionFromPaste;
  pasteStatus.value = '导入中...';
  fn(pasteText.value).then(() => {
    refreshRows();
    pasteText.value = '';
    pasteStatus.value = '完成';
    auctionStore.bumpDataVersion(ds.value);
    auctionStore.refresh();
  }).catch(e => {
    console.error('导入失败:', e);
    pasteStatus.value = '失败: ' + (e && e.message ? e.message : String(e));
  });
}

function onReplaceConcept() {
  if (!pasteText.value.trim()) return;
  const fn = isHot.value ? replaceHotConceptFromPaste : replaceConceptFromPaste;
  pasteStatus.value = '替换中...';
  Promise.resolve(fn(pasteText.value)).then(() => {
    refreshRows();
    pasteStatus.value = '完成';
    auctionStore.bumpDataVersion(ds.value);
    auctionStore.refresh();
  }).catch(e => {
    console.error('替换概念失败:', e);
    pasteStatus.value = '失败: ' + (e && e.message ? e.message : String(e));
  });
}

function onAiVision() {
  openAiVisionModal();
}

function onImportCodeMap() {
  if (!codeMapText.value.trim()) return;
  const fn = isHot.value ? importStockCodeMapHot : importStockCodeMap;
  codeMapStatus.value = '导入中...';
  Promise.resolve(fn(codeMapText.value)).then(() => {
    codeMapText.value = '';
    codeMapStatus.value = '完成';
  }).catch(e => {
    console.error('导入代码映射失败:', e);
    codeMapStatus.value = '失败: ' + (e && e.message ? e.message : String(e));
  });
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
  historyStatus.value = '补录中...';
  fn(historyText.value, historyDate.value, historyColType.value).then(() => {
    refreshRows();
    historyText.value = '';
    historyStatus.value = '完成';
    auctionStore.bumpDataVersion(ds.value);
    auctionStore.refresh();
  }).catch(e => {
    console.error('历史填充失败:', e);
    historyStatus.value = '失败: ' + (e && e.message ? e.message : String(e));
  });
}

function onRunDiag() {
  if (busyKey.value) return;
  busyKey.value = 'diag';
  activeElId.value = 'auctionDiagStatus';
  if (apiStatusMap.auctionDiagStatus) delete apiStatusMap.auctionDiagStatus;
  Promise.resolve().then(() => runAuctionApiDiagnostics())
    .catch(e => {
      console.error('诊断异常:', e);
      apiStatusMap.auctionDiagStatus = { msg: '❌ ' + (e && e.message ? e.message : String(e)), ok: false, ts: Date.now() };
    });
  if (busyTimer) clearTimeout(busyTimer);
  busyTimer = setTimeout(() => { busyKey.value = ''; activeElId.value = ''; }, 60000);
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
/* ===== 模态框容器：原版 .modal + .modal-content + .modal-content-rank =====
   整个内容是一个滚动容器（底部抽屉形态），所有区块 + 底部按钮都在同一滚动流内 */
.auction-edit-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 9998;
  display: flex;
  align-items: flex-end;
  justify-content: center;
}
.auction-edit-modal {
  background: #fff;
  width: 100%;
  max-width: 400px;
  border-radius: 24px 24px 0 0;
  max-height: 85vh;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: 24px;
  box-sizing: border-box;
  box-shadow: 0 -4px 20px rgba(0, 0, 0, 0.1);
}

/* 头部（随内容一起滚动，与原版 modal-header 一致） */
.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
  padding-bottom: 10px;
  border-bottom: 1px solid #f1f5f9;
}
.auction-edit-title {
  font-size: 14px;
  font-weight: 600;
  color: #1f2937;
}
.close-btn {
  background: #f8fafc;
  border: none;
  color: #64748b;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  font-size: 20px;
  cursor: pointer;
}

/* 粘贴区（原版无边框，仅 margin-bottom 16px） */
.section-paste {
  margin-bottom: 16px;
}
.paste-textarea {
  width: 100%;
  height: 100px;
  padding: 8px;
  font-size: 12px;
  border: 1px solid #e2e8f0;
  border-radius: 4px;
  resize: vertical;
  box-sizing: border-box;
  -webkit-user-select: text;
  user-select: text;
}
.paste-btns {
  display: flex;
  gap: 8px;
  margin-top: 8px;
  flex-wrap: wrap;
}

/* 股票代码映射区（原版：绿框 padding10 radius6） */
.section-codemap {
  margin-bottom: 16px;
  padding: 10px;
  background: #f0fdf4;
  border: 1px solid #bbf7d0;
  border-radius: 6px;
}
.section-codemap-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.section-codemap-title {
  font-size: 13px;
  color: #15803d;
  font-weight: 600;
}
.section-codemap-body {
  margin-top: 8px;
}
.section-codemap-hint {
  font-size: 11px;
  color: #166534;
  margin-bottom: 8px;
  line-height: 1.5;
}
.codemap-textarea {
  width: 100%;
  height: 80px;
  padding: 8px;
  font-size: 12px;
  border: 1px solid #bbf7d0;
  border-radius: 4px;
  resize: vertical;
  box-sizing: border-box;
}
.codemap-btns {
  display: flex;
  gap: 8px;
  margin-top: 8px;
  flex-wrap: wrap;
}

/* 历史数据补录区（原版：蓝框 padding10 radius6） */
.section-history {
  margin-bottom: 16px;
  padding: 10px;
  background: #eff6ff;
  border: 1px solid #bfdbfe;
  border-radius: 6px;
}
.section-history-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.section-history-title {
  font-size: 13px;
  color: #1d4ed8;
  font-weight: 600;
}
.section-history-body {
  margin-top: 8px;
}
.section-history-hint {
  font-size: 11px;
  color: #1e40af;
  margin-bottom: 8px;
}
.history-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}
.history-date {
  padding: 4px 6px;
  font-size: 12px;
  border: 1px solid #bfdbfe;
  border-radius: 4px;
}
.history-radio {
  font-size: 12px;
  color: #374151;
  display: flex;
  align-items: center;
  gap: 4px;
}
.history-textarea {
  width: 100%;
  height: 80px;
  padding: 8px;
  font-size: 12px;
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
  margin-bottom: 16px;
  padding: 10px;
  border-radius: 6px;
}
.api-ths {
  background: #fffbeb;
  border: 1px solid #fcd34d;
}
.api-numcat {
  background: #fdf2f8;
  border: 1px solid #f9a8d4;
}
.api-diag {
  background: #f0fdf4;
  border: 1px solid #86efac;
}
.api-section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.api-section-title {
  font-size: 13px;
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
  gap: 8px;
}
.api-grid .btn {
  padding: 10px 8px;
  font-size: 12px;
  min-height: 40px;
}
/* 每个接口区块独立的进度状态行（对应原版 #thsApiStatus / #numcatApiStatus / #auctionDiagStatus） */
.api-status-line {
  display: block;
  margin-top: 6px;
  font-size: 12px;
  min-height: 16px;
  line-height: 1.5;
  word-break: break-all;
}
.api-ths .api-status-line { color: #92400e; }
.api-numcat .api-status-line { color: #831843; }
.api-diag .api-status-line { color: #166534; }
/* 成功/失败按原版 setApiStatus 的 isOk 着色（绿=成功/进行中，红=失败） */
.api-status-line.ok { color: #059669 !important; font-weight: 600; }
.api-status-line.err { color: #dc2626 !important; font-weight: 600; }

/* 通用小按钮（粘贴/映射/历史区） */
.btn {
  padding: 6px 12px;
  font-size: 12px;
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
.btn-diag { width: 100%; padding: 10px 8px; font-size: 12px; min-height: 40px; background: linear-gradient(135deg, #22c55e, #16a34a); color: #fff; font-weight: 600; }
.btn-codemap-import { background: linear-gradient(135deg, #10b981, #059669); color: #fff; }
.btn-codemap-auto { background: linear-gradient(135deg, #8b5cf6, #7c3aed); color: #fff; }
.btn-codemap-clear { background: #fee2e2; color: #dc2626; border: 1px solid #fecaca; }
.btn-history-fill { margin-top: 8px; background: linear-gradient(135deg, #3b82f6, #2563eb); color: #fff; }
.inline-status {
  display: inline-block;
  margin-top: 6px;
  font-size: 12px;
  color: #059669;
}
.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

/* 表单行（原版 .auction-form-row / .rank-form-number / .auction-form-*-input / .remove-rank-btn） */
.rank-form-scroll-container {
  width: 100%;
  overflow-x: auto;
  overflow-y: hidden;
  -webkit-overflow-scrolling: touch;
  padding-right: 10px;
}
.rank-form-scroll-container::-webkit-scrollbar { height: 4px; }
.rank-form-scroll-container::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 2px; }
.rank-form-scroll-container::-webkit-scrollbar-track { background: #f1f5f9; border-radius: 2px; }

.auction-form-row {
  display: flex;
  gap: 6px;
  margin-bottom: 16px;
  align-items: center;
  height: 44px;
  flex-shrink: 0;
}
.rank-form-number {
  flex: 0 0 28px;
  width: 28px;
  font-size: 12px;
  font-weight: 600;
  color: #64748b;
  text-align: center;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 2px;
  background: #f8fafc;
  border-radius: 4px;
}
.form-input {
  height: 40px;
  font-size: 13px;
  padding: 0 8px;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  box-sizing: border-box;
  background: #fff;
  color: #1f2937;
  outline: none;
}
.auction-form-stock-input { flex: 1.5; min-width: 100px; }
.auction-form-volume-input,
.auction-form-yest-input { flex: 1; min-width: 80px; }
.remove-rank-btn {
  flex: 0 0 32px;
  width: 32px;
  height: 32px;
  margin-left: 6px;
  background: #fee2e2;
  border: 1px solid #fecaca;
  color: #dc2626;
  border-radius: 6px;
  font-size: 16px;
  cursor: pointer;
  flex-shrink: 0;
  align-self: center;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* 底部操作按钮（原版 .add-rank-btn / .submit-btn，均在滚动流内） */
.add-rank-btn {
  background: #f1f5f9;
  border: 1px solid #e2e8f0;
  color: #64748b;
  padding: 12px;
  border-radius: 8px;
  font-size: 13px;
  cursor: pointer;
  width: 100%;
  margin-top: 8px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.submit-btn {
  width: 100%;
  background: linear-gradient(135deg, #3b82f6, #2563eb);
  border: none;
  color: white;
  padding: 16px;
  border-radius: 12px;
  font-size: 16px;
  font-weight: 600;
  margin-top: 10px;
  cursor: pointer;
}
.submit-btn.save { margin-top: 16px; }
.submit-btn.rollback { background: linear-gradient(135deg, #3b82f6, #2563eb); }
.submit-btn.clear-concept { background: linear-gradient(135deg, #ef4444, #dc2626); }
.submit-btn.clear-text { background: linear-gradient(135deg, #f97316, #ea580c); }
.submit-btn.clear-note { background: linear-gradient(135deg, #6b7280, #4b5563); }
.submit-btn.clear-all { background: linear-gradient(135deg, #7f1d1d, #991b1b); }
.submit-btn.repair { background: linear-gradient(135deg, #0d9488, #0f766e); }
</style>
