<template>
  <div v-if="loading" class="loading-state trading-day-element">
    <div class="loading-icon">⏳</div>
    <div class="loading-title">加载中...</div>
  </div>
  <div v-else-if="sortedList.length === 0" class="empty-state trading-day-element" style="display:block">
    <div class="empty-icon">📈</div>
    <div class="empty-title">暂无股票记录</div>
    <div class="empty-desc">点击下方 + 按钮添加第一条记录</div>
  </div>
  <div v-for="stock in sortedList" :key="stock.id"
       :id="'stock-card-' + stock.id"
       class="stock-card"
       :class="{ bought: stock.bought, sold: stock.sold, 'single-expanded': isExpanded(stock), 'single-collapsed': !isCollapsedMode && !isExpanded(stock) }">
    <div class="stock-header">
      <div class="stock-header-left" @click="onHeaderLeftClick($event, stock)">
        <div class="stock-name">
          {{ stock.name }}
          <div class="tags-row tags-row-first">
            <span v-if="headerTags(stock).pos1" class="tag" :class="headerTags(stock).pos1.cls">{{ headerTags(stock).pos1.text }}</span>
            <span v-else class="tag tag-placeholder"></span>
            <span v-if="headerTags(stock).pos2" class="tag" :class="headerTags(stock).pos2.cls">{{ headerTags(stock).pos2.text }}</span>
            <span v-else class="tag tag-placeholder"></span>
            <span v-if="headerTags(stock).pos3" class="tag" :class="headerTags(stock).pos3.cls">
              <svg v-if="headerTags(stock).pos3.svg" width="12" height="12" viewBox="0 0 24 24" fill="#fbbf24" style="vertical-align:middle;margin-bottom:1px"><polygon points="12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26"/></svg>
              {{ headerTags(stock).pos3.text }}
            </span>
            <span v-else class="tag tag-placeholder"></span>
          </div>
          <div class="tags-row">
            <span v-for="(tag, idx) in secondTags(stock)" :key="idx" class="tag" :class="tag.cls">{{ tag.text }}</span>
          </div>
        </div>
      </div>
      <div class="stock-header-right" @click="onHeaderRightClick($event, stock)">
        <div class="close-rate-header" :class="{ up: closeDisplay(stock).isUp, down: closeDisplay(stock).isDown }">
          <span v-if="closeHeaderBadge(stock)" class="bomb-badge" :style="closeHeaderBadge(stock).style">{{ closeHeaderBadge(stock).text }}</span>
          {{ closeDisplay(stock).display }}
        </div>
        <div class="expand-icon">▼</div>
      </div>
    </div>
    <div class="stock-body" @click="onBodyClick($event, stock)" @dblclick="onEdit(stock.id)">
      <div class="info-item">
        <div class="info-label">换手率</div>
        <div class="turnover-highlight" :style="{ color: stocksTurnoverDisplay(stock).color }">{{ stocksTurnoverDisplay(stock).display }}</div>
      </div>
      <div class="info-item">
        <div class="info-label">竞价开盘</div>
        <div class="info-value" :style="{ color: openDisplay(stock).color }">{{ openDisplay(stock).display }}</div>
      </div>
      <div class="info-item">
        <div class="info-label">调整幅度</div>
        <div class="info-value" :style="{ color: adjustDisplay(stock).color }">
          <span v-if="adjustDisplay(stock).symbol" :style="{ color: adjustDisplay(stock).symbolColor }">{{ adjustDisplay(stock).text }}{{ adjustDisplay(stock).symbol }}</span>
          <template v-else>{{ adjustDisplay(stock).text }}</template>
        </div>
      </div>
      <div class="info-item">
        <div class="info-label">竞符合数形态</div>
        <div class="info-value" style="font-size:12px">{{ stock.pattern || '-' }}</div>
      </div>
      <div class="info-item">
        <div class="info-label">零轴位置</div>
        <div class="axis-value">{{ stock.axis || '-' }}</div>
      </div>
      <div class="info-item">
        <div class="info-label">备注</div>
        <div class="remark-value">
          <span v-if="remarkDisplay(stock).prefix" :style="{ color: remarkDisplay(stock).prefixColor }">{{ remarkDisplay(stock).prefix }}</span>{{ remarkDisplay(stock).text || '-' }}
        </div>
      </div>
      <div class="info-item">
        <div class="info-label">开盘量比</div>
        <div class="info-value" :style="{ color: kbkDisplay(stock).color }">{{ kbkDisplay(stock).display }}</div>
      </div>
      <div class="info-item">
        <div class="info-label">缩放量能</div>
        <div class="sfliangneng-value">{{ stock.sfliangneng || '-' }}</div>
      </div>
      <div class="info-item">
        <div class="info-label">相关题材</div>
        <div class="xgcaiti-value">{{ stock.xgcaiti ? stock.xgcaiti.replace(/[()]/g, '') : '-' }}</div>
      </div>
    </div>
    <div v-if="isExpanded(stock) && trendCache[stock.id] && trendCache[stock.id].length > 1" class="stock-trend">
      <TrendChart :points="trendCache[stock.id]" color="#f59e0b" :percent="true" />
    </div>
    <div class="stock-actions" :class="{ expanded: expandedActionsId === stock.id }" :id="'actions-' + stock.id">
      <button class="action-btn btn-edit" @click.stop="onEdit(stock.id)">编辑</button>
      <button class="action-btn btn-copy" @click.stop="onCopyTomorrow(stock.id)">复制到交易日</button>
      <button class="action-btn btn-copy-date" @click.stop="onCopyDate(stock.id)">复制到日期</button>
      <button class="action-btn btn-delete" @click.stop="onDelete(stock.id)">删除</button>
    </div>
    <div v-if="stock.isSold && stock.soldRecords && stock.soldRecords.length"
         class="sold-records-display"
         style="padding:8px 15px;background:linear-gradient(90deg, rgba(220, 38, 38, 0.05), transparent);cursor:pointer;margin:8px 0;border-radius:8px;"
         @click.stop="onSoldEdit(stock.id)">
      <div v-for="record in soldRecordsReversed(stock)" :key="record.date"
           style="font-size:12px;line-height:1.8;font-weight:500;"
           :style="{ color: profitColor(record.profit) }">
        {{ record.date }} {{ typeText(record.type) }}{{ profitText(record.profit) }}{{ (parseFloat(record.profit) >= 0 ? '+' : '') + record.profit }} {{ stocksPercentDisplay(record.percent) }}
      </div>
    </div>
    <div v-else
         class="sold-records-empty"
         style="padding:6px 15px;background:linear-gradient(90deg, rgba(59, 130, 246, 0.03), transparent);cursor:pointer;margin:8px 0;border-radius:8px;"
         @click.stop="onSoldEdit(stock.id)">
      <div style="font-size:12px;color:#94a3b8;">💰 点击添加</div>
    </div>
    <div class="track-simple" @click="onTrackEdit(stock)">
      <div v-if="trackItems(stock.track).length" class="track-scroll-container">
        <div class="track-window.content-display">
          <div v-for="(item, idx) in trackItems(stock.track)" :key="(item.date||'')+'|'+idx" class="track-item">
            <span class="track-date">{{ formatDate(item.date) }}</span>
            <span>{{ item.content || '' }}</span>
          </div>
        </div>
      </div>
      <div v-else class="track-empty-hint">暂无追踪，点击添加...</div>
    </div>
  </div>

  <EditModal v-model="editModalActive" :title="editModalTitle" @save="saveEditModal">
    <div class="edit-form-row" v-for="field in editFields" :key="field.key">
      <label>{{ field.label }}</label>
      <input v-if="field.type === 'text'" v-model="editForm[field.key]" />
      <input v-else-if="field.type === 'number'" v-model.number="editForm[field.key]" type="number" />
      <select v-else-if="field.type === 'select'" v-model="editForm[field.key]">
        <option v-for="opt in field.options" :key="opt" :value="opt">{{ opt }}</option>
      </select>
    </div>
  </EditModal>

  <EditModal v-model="soldEditModalActive" title="卖出记录编辑" @save="saveSoldEditModal">
    <div class="edit-form-row">
      <label>卖出类型</label>
      <select v-model="soldEditForm.type">
        <option value="部分卖">部分卖</option>
        <option value="全清仓">全清仓</option>
      </select>
    </div>
    <div class="edit-form-row">
      <label>盈亏</label>
      <input v-model.number="soldEditForm.profit" type="number" />
    </div>
    <div class="edit-form-row">
      <label>百分比(%)</label>
      <input v-model.number="soldEditForm.percent" type="number" />
    </div>
    <div class="edit-form-row">
      <label>日期</label>
      <input v-model="soldEditForm.date" placeholder="YYYY-MM-DD" />
    </div>
  </EditModal>

  <EditModal v-model="trackEditModalActive" title="追踪记录编辑" @save="saveTrackEditModal">
    <div class="edit-form-row">
      <label>追踪内容</label>
      <input v-model="trackEditForm.content" />
    </div>
    <div class="edit-form-row">
      <label>日期</label>
      <input v-model="trackEditForm.date" placeholder="YYYY-MM-DD" />
    </div>
  </EditModal>

  <EditModal v-model="datePickerActive" title="选择日期" :show-actions="false">
    <div class="date-picker-section">
      <div class="date-picker-nav">
        <button @click="prevPickerMonth">‹</button>
        <span>{{ pickerYear }}-{{ String(pickerMonth + 1).padStart(2, '0') }}</span>
        <button @click="nextPickerMonth">›</button>
      </div>
      <div class="date-picker-grid">
        <button v-for="day in pickerDays" :key="day.key"
                :class="{ 'date-selected': day.key === pickerSelected, 'date-today': day.isToday, 'date-disabled': !day.valid }"
                :disabled="!day.valid"
                @click="selectPickerDate(day.key)">
          {{ day.label }}
        </button>
      </div>
      <div class="date-picker-actions">
        <button @click="pickerGoToday">今天</button>
        <button @click="datePickerActive = false">取消</button>
      </div>
    </div>
  </EditModal>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted, onUnmounted } from 'vue';
import { getCurrentDate, setCurrentDate, saveData } from '../logic/app-core.js';
import { getStocksData } from '../data/supabase-client.js';
import { formatDate, getStarTagsForStock, getStockProfitStatus } from '../logic/ui-bridge.js';
import { editStock, copyToTomorrow, copyToDate, deleteStock, openSoldEdit, openTrackEdit } from '../logic/stock-operations.js';
import { showToast } from '../composables/useToast.js';
import { getCurrentFilter, setCurrentFilter, getIsStockListCollapsed } from '../logic/stock-list-state.js';
import { _on, _off } from '../stores/eventBus.js';
import { useUiStore } from '../stores/uiStore.js';
import { getPreviousTradingDay, getNextTradingDay, isTradingDay, getMostRecentTradingDay } from '../logic/trading-day-helpers.js';
import EditModal from '../components/EditModal.vue';
import TrendChart from '../components/TrendChart.vue';

const uiStore = useUiStore();
const loading = ref(true);

function safe(fn, ...args) {
  try { return fn(...args); } catch (e) { console.error('[HomeStocksView]', e); return undefined; }
}

const stockStats = reactive({
  todayCount: 0, boughtCount: 0, soldCount: 0, holdCount: 0,
  recentMultiCount: 0, sectorEtfCount: 0, topicDirectionCount: 0
});

function updateStockStats(all) {
  const list = all || [];
  stockStats.todayCount = list.length;
  stockStats.boughtCount = 0;
  stockStats.soldCount = 0;
  stockStats.holdCount = 0;
  stockStats.recentMultiCount = 0;
  stockStats.sectorEtfCount = 0;
  stockStats.topicDirectionCount = 0;
  list.forEach(s => {
    if (s.bought) stockStats.boughtCount++;
    if (s.sold) stockStats.soldCount++;
    if (s.hold) stockStats.holdCount++;
    if (s.recentMulti) stockStats.recentMultiCount++;
    if (s.sectorEtf) stockStats.sectorEtfCount++;
    if (s.topicDirection) stockStats.topicDirectionCount++;
  });
}

const data = ref({ currentDate: '', list: [] });
const expandedIds = ref(new Set());
const collapsedIds = ref(new Set());
const expandedActionsId = ref(null);
const trendCache = ref({});
let lastDate = null;

function allTodayData() {
  return getStocksData()[getCurrentDate()] || [];
}

function getStockCloseTrend(stockName, count) {
  const points = [];
  const stocksData = getStocksData();
  let d = getCurrentDate();
  for (let i = 0; i < count; i++) {
    if (!d) break;
    const dayStocks = stocksData[d] || [];
    const stock = dayStocks.find(s => s.name && s.name.trim() === stockName.trim());
    const closeVal = stock && stock.close !== undefined && stock.close !== '' ? parseFloat(stock.close) : null;
    points.push({ date: d, value: closeVal });
    d = getPreviousTradingDay(d);
  }
  return points.reverse();
}

function getPriority(stock) {
  if (stock.bought) return 3;
  if (stock.hold) return 2;
  if (stock.sold) return 1;
  return 0;
}
function getTagPriority(stock) {
  if (stock.recentMulti) return 3;
  if (stock.sectorEtf) return 2;
  if (stock.topicDirection) return 1;
  return 0;
}

const sortedList = computed(() => {
  let list = [...(data.value.list || [])];
  const filter = getCurrentFilter();
  if (filter === '已买') list = list.filter(s => s.bought);
  else if (filter === '已卖') list = list.filter(s => s.sold);
  else if (filter === '持有') list = list.filter(s => s.hold);
  else if (filter === '最近多板') list = list.filter(s => s.recentMulti);
  else if (filter === '板块ETF') list = list.filter(s => s.sectorEtf);
  else if (filter === '题材方向') list = list.filter(s => s.topicDirection);

  list.sort((a, b) => {
    const pa = getPriority(a), pb = getPriority(b);
    if (pa !== pb) return pb - pa;
    const ta = getTagPriority(a), tb = getTagPriority(b);
    if (ta !== tb) return tb - ta;
    return (b.id || 0) - (a.id || 0);
  });
  return list;
});

function refresh() {
  loading.value = true;
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
  const cache = {};
  list.forEach(s => {
    if (s.name) cache[s.id] = getStockCloseTrend(s.name, 5);
  });
  trendCache.value = cache;
  loading.value = false;
}

const isCollapsedMode = computed(() => getIsStockListCollapsed());
function isExpanded(stock) {
  return isCollapsedMode.value ? expandedIds.value.has(stock.id) : !collapsedIds.value.has(stock.id);
}
function toggleExpand(stock) {
  if (isCollapsedMode.value) {
    const set = expandedIds.value;
    if (set.has(stock.id)) set.delete(stock.id); else set.add(stock.id);
    expandedIds.value = new Set(set);
  } else {
    const set = collapsedIds.value;
    if (set.has(stock.id)) set.delete(stock.id); else set.add(stock.id);
    collapsedIds.value = new Set(set);
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

function openDisplay(stock) {
  const v = stock.open;
  let color = '#374151', display = (v !== undefined && v !== '') ? v + '%' : '-';
  const n = parseFloat(v);
  if (v !== undefined && v !== '' && !isNaN(n)) {
    color = n > 0 ? '#dc2626' : (n < 0 ? '#059669' : '#374151');
    if (n > 0) display = '+' + v + '%';
  }
  return { color, display };
}
function stocksTurnoverDisplay(stock) {
  const v = stock.turnover;
  let color = '#64748b', display = (v !== undefined && v !== '') ? v + '%' : '-';
  const n = parseFloat(v);
  if (v !== undefined && v !== '' && !isNaN(n)) color = n <= 25 ? '#d97706' : '#dc2626';
  return { color, display };
}
function closeDisplay(stock) {
  const v = stock.close;
  let color = '#64748b', display = (v !== undefined && v !== '') ? v + '%' : '-%';
  const n = parseFloat(v);
  if (v !== undefined && v !== '' && !isNaN(n)) {
    color = n > 0 ? '#dc2626' : '#059669';
    display = (n > 0 ? '+' : (n < 0 ? '-' : '')) + String(v).replace(/^[+-]/, '') + '%';
  }
  return { color, display, isUp: n > 0, isDown: n < 0 };
}
function adjustDisplay(stock) {
  const v = stock.adjust;
  if (v === undefined || v === '') return { text: '-', color: '#374151', symbol: '', symbolColor: '' };
  const opts = ['二板成功', '二板失败', '三板成功', '三板失败', '四板成功', '四板失败', '五板成功', '五板失败'];
  if (opts.includes(v)) {
    const ok = v.includes('成功');
    const color = ok ? '#dc2626' : '#16a34a';
    const sym = ok ? '✔' : '✘';
    return { text: v, color: 'inherit', symbol: sym, symbolColor: color };
  }
  return { text: String(v), color: '#374151', symbol: '', symbolColor: '' };
}
function kbkDisplay(stock) {
  const v = stock.kbiliangkai;
  const n = parseFloat(v);
  let color = '#64748b', display = v || '-';
  if (!isNaN(n)) color = n >= 3 ? '#dc2626' : '#059669';
  return { color, display };
}
function nishiClass(stock) {
  const close = parseFloat(stock.close);
  const up = !isNaN(close) && close > 0;
  return up ? 'tag-nishi-up' : 'tag-nishi-down';
}
function shunshiClass(stock) {
  const close = parseFloat(stock.close);
  const up = !isNaN(close) && close > 0;
  return up ? 'tag-shunshi-up' : 'tag-shunshi-down';
}
function stageTag(stock) {
  if (!stock.stage || stock.stage === '其它') return null;
  const map = { '二波': '二', '高位': '高', '连板': '连', '首板': '首' };
  const text = map[stock.stage] || stock.stage;
  const cls = (stock.stage === '连板' || stock.stage === '首板' || stock.stage === '二波' || stock.stage === '高位') ? 'tag-pink' : 'tag-default';
  return { text, cls };
}

function headerTags(stock) {
  let pos1 = null;
  if (stock.bought) pos1 = { text: '买', cls: 'tag-bought' };
  else if (stock.sold) pos1 = { text: '卖', cls: 'tag-sold' };
  else if (stock.hold) pos1 = { text: '持', cls: 'tag-hold' };

  let pos2 = null;
  if (stock.topicDirection) pos2 = { text: '题材', cls: 'tag-topicdirection' };
  else if (stock.recentMulti) pos2 = { text: '多板', cls: 'tag-recentmulti' };
  else if (stock.sectorEtf) pos2 = { text: 'ETF', cls: 'tag-sectoretf' };

  let pos3 = null;
  const starTag = getStarTagsForStock(stock.name);
  if (starTag) {
    const starCls = ['星爆', '星最多', '星增', '星平', '星现'].includes(starTag) ? 'tag-star-up' : 'tag-star-down';
    pos3 = { text: starTag, cls: starCls, svg: true };
  }
  return { pos1, pos2, pos3 };
}
function secondTags(stock) {
  const pos2Tag = stock.topicDirection ? 'topicDirection' : (stock.recentMulti ? 'recentMulti' : (stock.sectorEtf ? 'sectorEtf' : null));
  const pos1Tag = stock.bought ? 'bought' : (stock.sold ? 'sold' : (stock.hold ? 'hold' : null));
  const tags = [];
  if (stock.recentMulti && pos2Tag !== 'recentMulti') tags.push({ text: '多板', cls: 'tag-recentmulti' });
  if (stock.sectorEtf && pos2Tag !== 'sectorEtf') tags.push({ text: 'ETF', cls: 'tag-sectoretf' });
  if (stock.hold && pos1Tag !== 'hold') tags.push({ text: '持', cls: 'tag-hold' });
  if (stock.sold && pos1Tag !== 'sold') tags.push({ text: '卖', cls: 'tag-sold' });
  const st = stageTag(stock);
  if (st) tags.push({ text: st.text, cls: st.cls });
  if (stock.watch) tags.push({ text: '观', cls: 'tag-watch' });
  if (stock.dragon) tags.push({ text: '龙', cls: 'tag-dragon' });
  if (stock.nextDay === 'up') tags.push({ text: '次日涨', cls: 'tag-next-up' });
  if (stock.nextDay === 'down') tags.push({ text: '次日跌', cls: 'tag-next-down' });
  if (stock.sellHigh) tags.push({ text: '冲高', cls: 'tag-sell-high' });
  if (stock.sell1120) tags.push({ text: '11:20', cls: 'tag-sell-1120' });
  if (stock.sell1450) tags.push({ text: '14:50', cls: 'tag-sell-1450' });
  if (stock.nishi) tags.push({ text: '逆', cls: nishiClass(stock) });
  if (stock.shunshi) tags.push({ text: '顺', cls: shunshiClass(stock) });
  return tags;
}
function soldRecordsReversed(stock) {
  return (stock.soldRecords || []).slice().reverse();
}
function profitText(profit) {
  const p = parseFloat(profit) || 0;
  return p >= 0 ? '赚' : '亏';
}
function stocksPercentDisplay(percent) {
  if (!percent && percent !== 0) return '';
  const p = parseFloat(percent);
  return (p >= 0 ? '+' : '') + percent + '%';
}
function typeText(type) {
  return type === '部分卖' ? '部分卖' : (type === '全清仓' ? '全清仓' : '');
}
function profitColor(profit) {
  return (parseFloat(profit) || 0) >= 0 ? '#dc2626' : '#16a34a';
}

function closeHeaderBadge(stock) {
  const status = getStockProfitStatus(stock.name, getStocksData());
  if (status === '赚') return { text: '赚', style: 'background:#dc2626;color:#fff' };
  if (status === '亏') return { text: '亏', style: 'background:#6b7280;color:#fff' };
  if (stock.bomb) return { text: '炸', style: '' };
  return null;
}

function remarkDisplay(stock) {
  if (!stock || (!stock.remarkType && !stock.remark)) return { prefix: '', prefixColor: '', text: '-' };
  const typeMap = {
    'red_check': { text: '竞图符合✔', color: '#dc2626' },
    'orange_check': { text: '竞图勉强符合✔', color: '#f97316' },
    'green_x': { text: '竞图不符合×', color: '#16a34a' },
    'green_x_strong': { text: '竞图非常不符合×', color: '#16a34a' }
  };
  let prefix = '', prefixColor = '';
  if (stock.remarkType && typeMap[stock.remarkType]) {
    prefix = typeMap[stock.remarkType].text;
    prefixColor = typeMap[stock.remarkType].color;
  }
  return { prefix, prefixColor, text: stock.remark || '' };
}

function onEdit(id) { openEditModal(id); }
function onCopyTomorrow(id) { safe(copyToTomorrow, id); }
function onCopyDate(id) { safe(copyToDate, id); }
function onDelete(id) { safe(deleteStock, id); }
function onSoldEdit(id) { openSoldEditModal(id); }
function onTrackEdit(stock) { openTrackEditModal(stock.id !== undefined ? stock.id : stock.name); }

function trackItems(track) {
  return (track || []).slice().reverse();
}

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
  { key: 'bought', label: '已买(0/1)', type: 'number' },
  { key: 'sold', label: '已卖(0/1)', type: 'number' },
  { key: 'hold', label: '持有(0/1)', type: 'number' },
  { key: 'watch', label: '观察(0/1)', type: 'number' },
  { key: 'dragon', label: '龙头(0/1)', type: 'number' },
];

function openEditModal(id) {
  const stock = (getStocksData()[getCurrentDate()] || []).find(s => s.id === id);
  if (!stock) { showToast('未找到股票数据'); return; }
  editingStockId = id;
  editModalTitle.value = '编辑: ' + (stock.name || '');
  Object.keys(editForm).forEach(k => delete editForm[k]);
  editFields.forEach(f => { editForm[f.key] = stock[f.key] !== undefined ? stock[f.key] : ''; });
  editModalActive.value = true;
}

function saveEditModal() {
  if (editingStockId === null) return;
  const list = getStocksData()[getCurrentDate()] || [];
  const stock = list.find(s => s.id === editingStockId);
  if (!stock) { editModalActive.value = false; return; }
  Object.keys(editForm).forEach(k => {
    if (['bought','sold','hold','watch','dragon'].includes(k)) {
      stock[k] = !!editForm[k];
    } else {
      stock[k] = editForm[k];
    }
  });
  saveData();
  editModalActive.value = false;
  refresh();
  showToast('已保存');
}

const soldEditModalActive = ref(false);
const soldEditForm = reactive({ type: '部分卖', profit: 0, percent: 0, date: '' });
let soldEditingStockId = null;

function openSoldEditModal(id) {
  soldEditingStockId = id;
  const today = getCurrentDate();
  soldEditForm.type = '部分卖';
  soldEditForm.profit = 0;
  soldEditForm.percent = 0;
  soldEditForm.date = today;
  soldEditModalActive.value = true;
}

function saveSoldEditModal() {
  if (soldEditingStockId === null) return;
  const list = getStocksData()[getCurrentDate()] || [];
  const stock = list.find(s => s.id === soldEditingStockId);
  if (!stock) { soldEditModalActive.value = false; return; }
  if (!stock.soldRecords) stock.soldRecords = [];
  stock.soldRecords.push({
    type: soldEditForm.type,
    profit: soldEditForm.profit,
    percent: soldEditForm.percent,
    date: soldEditForm.date
  });
  stock.isSold = true;
  stock.sold = true;
  saveData();
  soldEditModalActive.value = false;
  refresh();
  showToast('卖出记录已保存');
}

const trackEditModalActive = ref(false);
const trackEditForm = reactive({ content: '', date: '' });
let trackEditingStockId = null;

function openTrackEditModal(id) {
  trackEditingStockId = id;
  trackEditForm.content = '';
  trackEditForm.date = getCurrentDate();
  trackEditModalActive.value = true;
}

function saveTrackEditModal() {
  if (trackEditingStockId === null) return;
  const list = getStocksData()[getCurrentDate()] || [];
  const stock = list.find(s => s.id === trackEditingStockId);
  if (!stock) { trackEditModalActive.value = false; return; }
  if (!stock.track) stock.track = [];
  stock.track.push({ content: trackEditForm.content, date: trackEditForm.date });
  saveData();
  trackEditModalActive.value = false;
  refresh();
  showToast('追踪记录已保存');
}

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

function setFilter(filter) {
  setCurrentFilter(filter);
  refresh();
}

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

function openModal(id) { openEditModal(id); }
function closeModal() { editModalActive.value = false; }

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
    reader.onload = (ev) => {
      try {
        const imported = JSON.parse(ev.target.result);
        const stocksData = getStocksData();
        Object.keys(imported).forEach(date => {
          stocksData[date] = imported[date];
        });
        saveData();
        refresh();
        showToast('导入成功');
      } catch (err) {
        showToast('导入失败: ' + err.message);
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

defineExpose({
  refresh, setFilter, changeDate, goToday, openModal, closeModal,
  exportData, showImportModal, openDatePicker,
  goToPrevTradingDay, goToNextTradingDay, stockStats
});
</script>

<style>
.track-empty-hint {
  font-size: 12px;
  color: #94a3b8;
  padding: 4px 0;
}
.loading-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 60px 20px;
  color: #64748b;
}
.loading-icon {
  font-size: 32px;
  margin-bottom: 8px;
}
.loading-title {
  font-size: 14px;
}
.stock-trend {
  padding: 8px 15px;
  background: linear-gradient(90deg, rgba(245, 158, 11, 0.04), transparent);
  border-radius: 8px;
  margin: 4px 0;
}
</style>
