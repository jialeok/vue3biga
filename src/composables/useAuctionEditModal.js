// 竞价编辑模态框（AuctionEditModal.vue）的逻辑层。
// 原 AuctionEditModal.vue 的 <script setup> 整体抽离到这里，组件只负责组合视图。
// 通过 provide/inject 把返回的 reactive 对象下发给子组件，逻辑与行为与原版完全一致。
import { ref, computed, watch, reactive } from 'vue';
import { apiStatusMap, numcatChoice } from '../logic/ui-bridge.js';
import {
  getTodayGroupList, saveData, getAuctionData,
  importAuctionFromPaste, importAuctionHistoryFill,
  replaceConceptFromPaste,
  importStockCodeMap, autoCompleteMissingStockCodes,
  fetchLadderConstituentsMain, fillYesterdayVolumeFromThs, fillTodayYesterdayVolumeFromThs,
  fillYesterdayYesterdayVolumeFromThs, fetchChangePctFromThs, fillAuctionHistoryGapYestVolumeFromThs,
  fillAuctionHistoryGapPctFromThs,
  fetchTodayAuctionFromNumcat, fetchAllAuctionFromNumcat, fetchFiveDaysAuctionFromNumcat,
  fillYesterdayAuctionFromNumcat, fillTopicsFromNumcat, fetchMonitorWarningFromNumcat,
  rollbackAuctionData, repairAuctionInWatchlistForDate,
  patchAuctionFieldBatch, markAuctionDirty, scheduleCloudPush
} from '../logic/app-core.js';
import { syncStockTopicsFromAuction } from '../logic/auction/stock-sync.js';
import {
  buildAuctionRows, buildAuctionSaveList, isTerminalStatus,
  apiStatusMsg, apiStatusCls,
  computeConceptClear, computeTextClear, computeNotesClear
} from '../logic/auction/auction-edit-helpers.js';
import auctionStore from '../stores/auctionStore.js';

export function useAuctionEditModal() {
  const visible = ref(false);
  const editRows = ref([]);
  const pasteText = ref('');

  const codeMapOpen = ref(false);
  const codeMapText = ref('');
  const historyOpen = ref(false);
  const historyDate = ref('');
  const historyColType = ref('volume');
  const historyText = ref('');

  const pasteStatus = ref('');
  const codeMapStatus = ref('');
  const historyStatus = ref('');

  const thsFns = {
    ladder: fetchLadderConstituentsMain,
    yestVol: fillYesterdayVolumeFromThs,
    todayYest: fillTodayYesterdayVolumeFromThs,
    prevYest: fillYesterdayYesterdayVolumeFromThs,
    changePct: fetchChangePctFromThs,
    gapPct: () => fillAuctionHistoryGapPctFromThs(null, 'auction'),
    gapYest: fillAuctionHistoryGapYestVolumeFromThs
  };

  const numcatFns = {
    yestAuction: fillYesterdayAuctionFromNumcat,
    today: fetchTodayAuctionFromNumcat,
    all: fetchAllAuctionFromNumcat,
    fiveDays: fetchFiveDaysAuctionFromNumcat,
    topics: fillTopicsFromNumcat,
    monitor: fetchMonitorWarningFromNumcat
  };

  const thsButtons = computed(() => [
    { key: 'ths-ladder', label: '获取最近多板', fn: thsFns.ladder },
    { key: 'ths-yestVol', label: '两全昨日成交量', fn: thsFns.yestVol },
    { key: 'ths-todayYest', label: '当天昨日成交量', fn: thsFns.todayYest },
    { key: 'ths-prevYest', label: '对比日昨成交量', fn: thsFns.prevYest },
    { key: 'ths-changePct', label: '获取涨幅', fn: thsFns.changePct },
    { key: 'ths-gapPct', label: '历史断点涨幅', fn: thsFns.gapPct },
    { key: 'ths-gapYest', label: '历史断点昨日成交量', fn: thsFns.gapYest, wide: true }
  ]);

  const numcatButtons = computed(() => [
    { key: 'nc-yestAuction', label: '补全昨日竞价量', fn: numcatFns.yestAuction },
    { key: 'nc-today', label: '获取当天竞价量', fn: numcatFns.today },
    { key: 'nc-all', label: '全竞价量（昨日+今日一次请求）', fn: numcatFns.all, wide: true },
    { key: 'nc-fiveDays', label: '连抓五天补全（竞价量+昨成交量+涨幅）', fn: numcatFns.fiveDays, wide: true },
    { key: 'nc-topics', label: '补全题材', fn: numcatFns.topics },
    { key: 'nc-monitor', label: '查询监管', fn: numcatFns.monitor }
  ]);

  function refreshRows() {
    const list = getTodayGroupList('auction');
    editRows.value = buildAuctionRows(list);
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
    const list = getTodayGroupList('auction');
    list.length = 0;
    buildAuctionSaveList(editRows.value).forEach(row => {
      list.push({ stock: row.stock, volume: row.volume, yestVolume: row.yestVolume });
    });
    saveData();
    auctionStore.bumpDataVersion('auction');
    auctionStore.refresh();
    close();
  }

  const busyKey = ref('');
  const activeElId = ref('');       // 当前正在执行的接口对应的状态 id
  let busyTimer = null;             // 兜底解锁计时器

  // 读取 app-core 业务层已经写到 apiStatusMap 的真实进度（原版 setApiStatus 的迁移植）
  function statusMsg(elId) {
    return apiStatusMsg(apiStatusMap[elId]);
  }
  function statusCls(elId) {
    return apiStatusCls(apiStatusMap[elId]);
  }
  // 终止消息：原版每条接口函数收尾都会写 ✅ 成功 / ❌ 失败，据此判定任务完成
  function isTerminal(msg) {
    return isTerminalStatus(msg);
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
          auctionStore.bumpDataVersion('auction');
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

  // 用户点击「取消」关闭覆盖/补全选择弹窗时，解除按钮「处理中...」锁定。
  // 原因：选择类接口函数（如 fetchTodayAuctionFromNumcat）只在 showNumcatChoiceModal 打开弹窗后立即返回，
  // 真正的抓取被延迟到用户选择之后；取消时不执行回调、不产生 ✅/❌ 终止消息，
  // 上面那条 watch 不会触发，busyKey 会永久卡在「处理中...」。这里用取消信号即时解锁。
  watch(
    () => numcatChoice.cancelSignal,
    () => {
      if (!busyKey.value) return;
      const id = activeElId.value;
      busyKey.value = '';
      activeElId.value = '';
      if (busyTimer) { clearTimeout(busyTimer); busyTimer = null; }
      if (id && apiStatusMap[id]) {
        apiStatusMap[id] = { msg: '已取消操作', ok: true, ts: Date.now() };
      }
    }
  );

  function onPasteImport() {
    if (!pasteText.value.trim()) return;
    const fn = importAuctionFromPaste;
    pasteStatus.value = '导入中...';
    fn(pasteText.value).then((msg) => {
      refreshRows();
      pasteText.value = '';
      pasteStatus.value = msg || '完成';
      auctionStore.bumpDataVersion('auction');
      auctionStore.refresh();
    }).catch(e => {
      console.error('导入失败:', e);
      pasteStatus.value = '失败: ' + (e && e.message ? e.message : String(e));
    });
  }

  function onReplaceConcept() {
    if (!pasteText.value.trim()) return;
    const fn = replaceConceptFromPaste;
    pasteStatus.value = '替换中...';
    Promise.resolve(fn(pasteText.value)).then((msg) => {
      refreshRows();
      pasteStatus.value = msg || '完成';
      auctionStore.bumpDataVersion('auction');
      auctionStore.refresh();
    }).catch(e => {
      console.error('替换概念失败:', e);
      pasteStatus.value = '失败: ' + (e && e.message ? e.message : String(e));
    });
  }

  function onImportCodeMap() {
    if (!codeMapText.value.trim()) {
      codeMapStatus.value = '请先粘贴映射数据（格式：股票名[TAB]代码）';
      return;
    }
    const fn = importStockCodeMap;
    codeMapStatus.value = '导入中...';
    Promise.resolve(fn(codeMapText.value)).then((msg) => {
      codeMapText.value = '';
      codeMapStatus.value = msg || '完成';
    }).catch(e => {
      console.error('导入代码映射失败:', e);
      codeMapStatus.value = '失败: ' + (e && e.message ? e.message : String(e));
    });
  }

  function onAutoCompleteCode() {
    codeMapStatus.value = '补全中...';
    Promise.resolve(autoCompleteMissingStockCodes('auction')).then((msg) => {
      codeMapStatus.value = msg || '补全完成';
    }).catch(e => {
      console.error('自动补全代码失败:', e);
      codeMapStatus.value = '失败: ' + (e && e.message ? e.message : String(e));
    });
  }

  function onHistoryFill() {
    if (!historyText.value.trim()) return;
    const fn = importAuctionHistoryFill;
    historyStatus.value = '补录中...';
    fn(historyText.value, historyDate.value, historyColType.value).then((msg) => {
      refreshRows();
      historyText.value = '';
      historyStatus.value = msg || '完成';
      auctionStore.bumpDataVersion('auction');
      auctionStore.refresh();
    }).catch(e => {
      console.error('历史填充失败:', e);
      historyStatus.value = '失败: ' + (e && e.message ? e.message : String(e));
    });
  }

  function onRollback() {
    rollbackAuctionData();
    refreshRows();
    auctionStore.bumpDataVersion('auction');
    auctionStore.refresh();
  }

  function onRepair() {
    repairAuctionInWatchlistForDate().then(() => {
      refreshRows();
      auctionStore.bumpDataVersion('auction');
      auctionStore.refresh();
    }).catch(e => console.error('恢复失败:', e));
  }

  function _clearAllConcepts() {
    const targetDate = auctionStore.currentDate;
    const auctionData = getAuctionData();
    const existingList = auctionData[targetDate] || [];
    if (existingList.length === 0) { alert('当前没有数据可清除！'); return; }
    const { clearCount, patch } = computeConceptClear(existingList);
    if (clearCount > 0) {
      patchAuctionFieldBatch(targetDate, patch);
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
    const { clearCount, patch } = computeTextClear(existingList);
    if (clearCount > 0) {
      patchAuctionFieldBatch(targetDate, patch);
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
    const { clearCount, patch } = computeNotesClear(existingList);
    if (clearCount > 0) {
      patchAuctionFieldBatch(targetDate, patch);
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
    auctionStore.bumpDataVersion('auction');
    auctionStore.refresh();
  }
  function onClearText() {
    _clearAllText();
    refreshRows();
    auctionStore.bumpDataVersion('auction');
    auctionStore.refresh();
  }
  function onClearNotes() {
    _clearAllNotes();
    refreshRows();
    auctionStore.bumpDataVersion('auction');
    auctionStore.refresh();
  }

  // 把全部 state + 方法包成一个 reactive 对象，组件通过 provide/inject 共享：
  // - 嵌套 ref 自动解包，子组件模板里 v-model="modal.xxx" 直接读写底层 ref，行为不变；
  // - 方法就是普通属性，子组件通过 modal.xxx() 调用；
  // - 逻辑函数内部仍用 .value 操作原始 ref，与原版一致。
  const api = reactive({
    visible, editRows, pasteText,
    codeMapOpen, codeMapText,
    historyOpen, historyDate, historyColType, historyText,
    pasteStatus, codeMapStatus, historyStatus,
    busyKey, activeElId,
    thsButtons, numcatButtons,
    open, close,
    addRow, removeRow, clearAllRows, save,
    runBackend, statusMsg, statusCls, isTerminal,
    onPasteImport, onReplaceConcept, onImportCodeMap, onAutoCompleteCode, onHistoryFill,
    onRollback, onRepair, onClearConcepts, onClearText, onClearNotes
  });
  return api;
}
