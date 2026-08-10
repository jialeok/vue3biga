<template>
  <div class="rank-board trading-day-element">
  <div class="rank-header" @dblclick.stop="openEdit">
    <div class="rank-title">昨日最大成交额</div>
    <div class="rank-subtitle"></div>
  </div>
  <div class="rank-content" @dblclick.stop="openEdit">
    <div class="rank-header-row">
      <div class="rank-header-item rank-header-number">排名</div>
      <div class="rank-header-item rank-header-stock">股票名称</div>
      <div class="rank-header-item rank-header-jitu">竞图</div>
      <div class="rank-header-item rank-header-diezhang">涨幅</div>
      <div class="rank-header-item rank-header-concept">题材概念</div>
      <div class="rank-header-item rank-header-turnover">成交额</div>
    </div>
    <template v-if="displayList.length === 0">
      <div style="text-align:center;padding:20px;color:#9ca3af;font-size:13px">暂无排名数据</div>
    </template>
    <template v-else>
      <div v-for="(item, idx) in displayList" :key="idx" :class="['rank-item', item.kind === 'empty' ? '' : '']" :style="item.kind === 'empty' ? 'height:16px;background:transparent;' : ''">
        <template v-if="item.kind === 'empty'"></template>
        <template v-else-if="item.kind === 'separator'">
          <div class="rank-number"></div>
          <div class="rank-stock-name" style="color:#dc2626;font-weight:600;">今日排行</div>
          <div class="rank-jitu"></div>
          <div class="rank-diezhang"></div>
          <div class="rank-concept" style="color:#dc2626;font-weight:600;">{{ item.time }}</div>
          <div class="rank-turnover"></div>
        </template>
        <template v-else>
          <div class="rank-number">{{ item.index }}</div>
          <div class="rank-stock-name">{{ item.stock }}</div>
          <div class="rank-jitu" :class="item.isChecked ? 'checked' : 'unchecked'">{{ item.jitu }}</div>
          <div class="rank-diezhang" :class="percentClass(item.percent)">{{ rankPercentDisplay(item.percent) }}</div>
          <div class="rank-concept" :class="item.isChecked ? 'red-text' : ''">{{ item.concept }}</div>
          <div class="rank-turnover">{{ rankTurnoverDisplay(item.turnover) }}</div>
        </template>
      </div>
    </template>
  </div>

  <Teleport to="body">
    <div v-if="showModal" class="rank-vue-modal-backdrop" @click.self="closeEdit">
      <div class="rank-vue-modal">
        <div class="rank-vue-modal-header">
          <span>编辑昨日最大成交额</span>
          <button @click="closeEdit">&times;</button>
        </div>
        <div class="rank-vue-modal-body">
          <div class="rank-vue-paste-area">
            <textarea v-model="importText" placeholder="从 Excel 复制后直接粘贴到这里"></textarea>
            <div class="rank-vue-import-status" :style="{ color: importStatus.color }">{{ importStatus.text }}</div>
            <button type="button" class="rank-vue-add-btn" @click="onImport">导入粘贴数据</button>
          </div>

          <div v-for="(item, idx) in draft" :key="idx" :class="['rank-vue-form-row', item.type === 'empty' ? 'rank-vue-empty-row' : '', item.type === 'separator' ? 'rank-vue-separator-row' : '']">
            <template v-if="item.type === 'empty'">
              <div class="rank-vue-form-number"></div>
              <input class="rank-vue-form-stock" disabled placeholder="-" style="visibility:hidden">
              <select class="rank-vue-form-jitu" disabled style="visibility:hidden"><option>×</option></select>
              <input class="rank-vue-form-percent" disabled style="visibility:hidden">
              <input class="rank-vue-form-concept" disabled style="visibility:hidden">
              <input class="rank-vue-form-turnover" disabled style="visibility:hidden">
              <button type="button" class="rank-vue-remove-btn" @click="removeRow(idx)">&times;</button>
            </template>
            <template v-else-if="item.type === 'separator'">
              <div class="rank-vue-form-number"></div>
              <input class="rank-vue-form-stock" value="今日排行" readonly>
              <select class="rank-vue-form-jitu" disabled style="visibility:hidden"><option>×</option></select>
              <input class="rank-vue-form-percent" disabled style="visibility:hidden">
              <input class="rank-vue-form-concept" v-model="item.time" placeholder="时间">
              <input class="rank-vue-form-turnover" disabled style="visibility:hidden">
              <button type="button" class="rank-vue-remove-btn" @click="removeRow(idx)">&times;</button>
            </template>
            <template v-else>
              <div class="rank-vue-form-number">{{ idx + 1 }}</div>
              <input class="rank-vue-form-stock" v-model="item.stock" placeholder="名称">
              <select class="rank-vue-form-jitu" v-model="item.jitu">
                <option value="×">×</option>
                <option value="✓">✓</option>
              </select>
              <input class="rank-vue-form-percent" v-model="item.percent" placeholder="涨幅">
              <input class="rank-vue-form-concept" v-model="item.concept" placeholder="题材">
              <input class="rank-vue-form-turnover" v-model="item.turnover" placeholder="额">
              <button type="button" class="rank-vue-remove-btn" @click="removeRow(idx)">&times;</button>
            </template>
          </div>
          <button type="button" class="rank-vue-add-btn" @click="addRow">+ 添加新行</button>
        </div>
        <div class="rank-vue-modal-footer">
          <button type="button" class="rank-vue-save-btn" @click="save">保存</button>
          <button type="button" class="rank-vue-cancel-btn" @click="closeEdit">取消</button>
        </div>
      </div>
    </div>
  </Teleport>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { getTodayRank, getRankData, saveData, getCurrentDate } from '../logic/app-core.js';

const list = ref([]);
const showModal = ref(false);
const draft = ref([]);
const importText = ref('');
const importStatus = ref({ text: '', color: '#64748b' });
let lastDate = null;

function saveRankData(data) {
  const date = getCurrentDate();
  if (!date) return;
  getRankData()[date] = data;
  saveData();
}

function parsePercent(raw) {
  if (!raw) return '';
  return String(raw).replace('%', '').trim();
}

function parseTurnover(raw) {
  if (!raw) return '';
  return String(raw).replace('亿', '').trim();
}

function percentClass(percent) {
  if (!percent && percent !== 0) return 'empty';
  const n = parseFloat(percent) || 0;
  return n >= 0 ? 'rise' : 'fall';
}

function rankPercentDisplay(percent) {
  if (!percent && percent !== 0) return '-';
  return percent + '%';
}

function rankTurnoverDisplay(turnover) {
  if (!turnover && turnover !== 0) return '-';
  const v = String(turnover).replace('亿', '');
  return v + '亿';
}

function parseRankPaste(text) {
  const lines = text.split('\n');
  const result = [];
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    const trimmedLine = line.trim();
    if (index === 0 && (trimmedLine.includes('股票名称') || trimmedLine.includes('涨幅') || trimmedLine.includes('概念'))) return;

    let cells = line.split('\t');
    const firstCellHasSpaces = cells[0] && cells[0].trim().includes(' ');
    const firstCellIsLong = cells[0] && cells[0].trim().length > 8;
    if (firstCellHasSpaces && firstCellIsLong) {
      cells = trimmedLine.split(/\s+/);
    } else if (cells.length < 2) {
      cells = trimmedLine.split(/\s+/);
    }
    cells = cells.filter(c => c.trim() !== '');
    if (cells.length < 2) return;

    const stock = cells[0].trim();
    let percentRaw = '';
    let concept = '';
    let turnoverRaw = '';

    if (cells.length >= 4) {
      percentRaw = cells[1].trim();
      concept = cells[2].trim();
      turnoverRaw = cells[3].trim();
    } else if (cells.length === 3) {
      const second = cells[1].trim();
      const third = cells[2].trim();
      if (second.includes('%') || second.includes('+') || second.includes('-') || second.startsWith('+') || second.startsWith('-')) {
        percentRaw = second;
        concept = third;
      } else if (third.includes('亿') || third.includes('万') || (!isNaN(parseFloat(third)) && third.match(/\d/))) {
        concept = second;
        turnoverRaw = third;
      } else {
        concept = second;
        turnoverRaw = third;
      }
    } else {
      const second = cells[1].trim();
      if (second.includes('%') || second.includes('+') || second.includes('-') || second.startsWith('+') || second.startsWith('-')) {
        percentRaw = second;
      } else if (second.includes('亿') || second.includes('万') || (!isNaN(parseFloat(second)) && second.match(/\d/))) {
        turnoverRaw = second;
      } else {
        concept = second;
      }
    }

    const percent = parsePercent(percentRaw);
    const turnover = parseTurnover(turnoverRaw);
    if (!stock) return;
    result.push({ stock, jitu: '×', percent, concept, turnover });
  });
  return result;
}

function mergeImportedRows(existing, imported) {
  const hasStockData = existing.some(item => item && item.stock);
  if (!hasStockData) return imported;

  let beforeSeparator = [];
  let separatorIndex = -1;
  let afterSeparator = [];
  existing.forEach((item, index) => {
    if (item.type === 'separator') separatorIndex = index;
    else if (separatorIndex === -1) beforeSeparator.push(item);
    else afterSeparator.push(item);
  });

  const allExisting = [...beforeSeparator, ...afterSeparator];
  imported.forEach(newItem => {
    let existingIndex = beforeSeparator.findIndex(item => item && item.stock === newItem.stock);
    if (existingIndex === -1) existingIndex = afterSeparator.findIndex(item => item && item.stock === newItem.stock);
    if (existingIndex !== -1) {
      const arr = existingIndex < beforeSeparator.length ? beforeSeparator : afterSeparator;
      const idx = existingIndex < beforeSeparator.length ? existingIndex : existingIndex - beforeSeparator.length;
      const item = arr[idx];
      if (!item.percent && newItem.percent) item.percent = newItem.percent;
      if (!item.concept && newItem.concept) item.concept = newItem.concept;
      if (!item.turnover && newItem.turnover) item.turnover = newItem.turnover;
    } else {
      afterSeparator.push(newItem);
    }
  });

  const hasCompleteData = afterSeparator.some(item => item && item.stock && item.percent && item.concept && item.turnover);
  beforeSeparator = beforeSeparator.filter(item => item && item.stock);
  afterSeparator = afterSeparator.filter(item => item && item.stock);

  const final = [...beforeSeparator];
  if (hasCompleteData && afterSeparator.length > 0) {
    final.push({ type: 'empty' });
    const now = new Date();
    const timeStr = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
    final.push({ type: 'separator', time: timeStr });
  }
  return [...final, ...afterSeparator];
}

function refresh() {
  const date = getCurrentDate();
  if (date !== lastDate) {
    lastDate = date;
    showModal.value = false;
  }
  list.value = getTodayRank();
}

const displayList = computed(() => {
  const result = [];
  let displayIndex = 0;
  (list.value || []).forEach(item => {
    if (item && item.type === 'empty') {
      result.push({ kind: 'empty' });
    } else if (item && item.type === 'separator') {
      result.push({ kind: 'separator', time: item.time || '' });
      displayIndex = 0;
    } else {
      displayIndex++;
      result.push({
        kind: 'stock',
        index: displayIndex,
        stock: item.stock || '-',
        jitu: item.jitu || '×',
        percent: item.percent || '',
        concept: item.concept || '-',
        turnover: item.turnover || '',
        isChecked: item.jitu === '✓'
      });
    }
  });
  return result;
});

function openEdit() {
  draft.value = JSON.parse(JSON.stringify(list.value || []));
  importText.value = '';
  importStatus.value = { text: '', color: '#64748b' };
  showModal.value = true;
}

function closeEdit() {
  showModal.value = false;
}

function addRow() {
  draft.value.push({ stock: '', jitu: '×', percent: '', concept: '', turnover: '' });
}

function removeRow(index) {
  draft.value.splice(index, 1);
}

function onImport() {
  const imported = parseRankPaste(importText.value);
  if (imported.length === 0) {
    importStatus.value = { text: '未能解析到有效数据！', color: '#dc2626' };
    return;
  }
  draft.value = mergeImportedRows(draft.value, imported);
  importText.value = '';
  importStatus.value = { text: `✅ 成功导入 ${imported.length} 条数据`, color: '#059669' };
}

function save() {
  const result = [];
  draft.value.forEach(item => {
    if (item.type === 'empty') {
      result.push({ type: 'empty' });
    } else if (item.type === 'separator') {
      result.push({ type: 'separator', time: item.time || '' });
    } else {
      const stock = (item.stock || '').trim();
      if (stock) {
        result.push({
          stock,
          jitu: item.jitu || '×',
          percent: parsePercent(item.percent),
          concept: (item.concept || '').trim(),
          turnover: parseTurnover(item.turnover)
        });
      }
    }
  });
  list.value = result;
  saveRankData(result);
  showModal.value = false;
}

let timer = setInterval(() => {
  if (getCurrentDate() !== lastDate) refresh();
}, 200);
onMounted(refresh);
onUnmounted(() => clearInterval(timer));

defineExpose({ refresh, openEdit });
</script>

