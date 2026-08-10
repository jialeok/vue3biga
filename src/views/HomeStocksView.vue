<template>
  <div v-if="loading" class="loading-state trading-day-element">
    <div class="loading-icon">鈴?/div>
    <div class="loading-title">鍔犺浇涓?..</div>
  </div>
  <div v-else-if="sortedList.length === 0" class="empty-state trading-day-element" style="display:block">
    <div class="empty-icon">馃搱</div>
    <div class="empty-title">鏆傛棤鑲＄エ璁板綍</div>
    <div class="empty-desc">鐐瑰嚮涓嬫柟 + 鎸夐挳娣诲姞绗竴鏉¤褰?/div>
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
        <div class="expand-icon">鈻?/div>
      </div>
    </div>
    <div class="stock-body" @click="onBodyClick($event, stock)" @dblclick="onEdit(stock.id)">
      <div class="info-item">
        <div class="info-label">鎹㈡墜鐜?/div>
        <div class="turnover-highlight" :style="{ color: stocksTurnoverDisplay(stock).color }">{{ stocksTurnoverDisplay(stock).display }}</div>
      </div>
      <div class="info-item">
        <div class="info-label">绔炰环寮€鐩?/div>
        <div class="info-value" :style="{ color: openDisplay(stock).color }">{{ openDisplay(stock).display }}</div>
      </div>
      <div class="info-item">
        <div class="info-label">璋冩暣骞呭害</div>
        <div class="info-value" :style="{ color: adjustDisplay(stock).color }">
          <span v-if="adjustDisplay(stock).symbol" :style="{ color: adjustDisplay(stock).symbolColor }">{{ adjustDisplay(stock).text }}{{ adjustDisplay(stock).symbol }}</span>
          <template v-else>{{ adjustDisplay(stock).text }}</template>
        </div>
      </div>
      <div class="info-item">
        <div class="info-label">绔炵鍚堟暟褰㈡€?/div>
        <div class="info-value" style="font-size:12px">{{ stock.pattern || '-' }}</div>
      </div>
      <div class="info-item">
        <div class="info-label">闆惰酱浣嶇疆</div>
        <div class="axis-value">{{ stock.axis || '-' }}</div>
      </div>
      <div class="info-item">
        <div class="info-label">澶囨敞</div>
        <div class="remark-value">
          <span v-if="remarkDisplay(stock).prefix" :style="{ color: remarkDisplay(stock).prefixColor }">{{ remarkDisplay(stock).prefix }}</span>{{ remarkDisplay(stock).text || '-' }}
        </div>
      </div>
      <div class="info-item">
        <div class="info-label">寮€鐩橀噺姣?/div>
        <div class="info-value" :style="{ color: kbkDisplay(stock).color }">{{ kbkDisplay(stock).display }}</div>
      </div>
      <div class="info-item">
        <div class="info-label">缂╂斁閲忚兘</div>
        <div class="sfliangneng-value">{{ stock.sfliangneng || '-' }}</div>
      </div>
      <div class="info-item">
        <div class="info-label">鐩稿叧棰樻潗</div>
        <div class="xgcaiti-value">{{ stock.xgcaiti ? stock.xgcaiti.replace(/[()]/g, '') : '-' }}</div>
      </div>
    </div>
    <div v-if="isExpanded(stock) && trendCache[stock.id] && trendCache[stock.id].length > 1" class="stock-trend">
      <TrendChart :points="trendCache[stock.id]" color="#f59e0b" :percent="true" />
    </div>
    <div class="stock-actions" :class="{ expanded: expandedActionsId === stock.id }" :id="'actions-' + stock.id">
      <button class="action-btn btn-edit" @click.stop="onEdit(stock.id)">缂栬緫</button>
      <button class="action-btn btn-copy" @click.stop="onCopyTomorrow(stock.id)">澶嶅埗鍒颁氦鏄撴棩</button>
      <button class="action-btn btn-copy-date" @click.stop="onCopyDate(stock.id)">澶嶅埗鍒版棩鏈?/button>
      <button class="action-btn btn-delete" @click.stop="onDelete(stock.id)">鍒犻櫎</button>
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
      <div style="font-size:12px;color:#94a3b8;">馃挵 鐐瑰嚮娣诲姞</div>
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
      <div v-else class="track-empty-hint">鏆傛棤杩借釜锛岀偣鍑绘坊鍔?..</div>
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

  <EditModal v-model="soldEditModalActive" title="鍗栧嚭璁板綍缂栬緫" @save="saveSoldEditModal">
    <div class="edit-form-row">
      <label>鍗栧嚭绫诲瀷</label>
      <select v-model="soldEditForm.type">
        <option value="閮ㄥ垎鍗?>閮ㄥ垎鍗?/option>
        <option value="鍏ㄦ竻浠?>鍏ㄦ竻浠?/option>
      </select>
    </div>
    <div class="edit-form-row">
      <label>鐩堜簭</label>
      <input v-model.number="soldEditForm.profit" type="number" />
    </div>
    <div class="edit-form-row">
      <label>鐧惧垎姣?%)</label>
      <input v-model.number="soldEditForm.percent" type="number" />
    </div>
    <div class="edit-form-row">
      <label>鏃ユ湡</label>
      <input v-model="soldEditForm.date" placeholder="YYYY-MM-DD" />
    </div>
  </EditModal>

  <EditModal v-model="trackEditModalActive" title="杩借釜璁板綍缂栬緫" @save="saveTrackEditModal">
    <div class="edit-form-row">
      <label>杩借釜鍐呭</label>
      <input v-model="trackEditForm.content" />
    </div>
    <div class="edit-form-row">
      <label>鏃ユ湡</label>
      <input v-model="trackEditForm.date" placeholder="YYYY-MM-DD" />
    </div>
  </EditModal>

  <EditModal v-model="datePickerActive" title="閫夋嫨鏃ユ湡" :show-actions="false">
    <div class="date-picker-section">
      <div class="date-picker-nav">
        <button @click="prevPickerMonth">鈥?/button>
        <span>{{ pickerYear }}-{{ String(pickerMonth + 1).padStart(2, '0') }}</span>
        <button @click="nextPickerMonth">鈥?/button>
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
        <button @click="pickerGoToday">浠婂ぉ</button>
        <button @click="datePickerActive = false">鍙栨秷</button>
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
  if (filter === '宸蹭拱') list = list.filter(s => s.bought);
  else if (filter === '宸插崠') list = list.filter(s => s.sold);
  else if (filter === '鎸佹湁') list = list.filter(s => s.hold);
  else if (filter === '鏈€杩戝鏉?) list = list.filter(s => s.recentMulti);
  else if (filter === '鏉垮潡ETF') list = list.filter(s => s.sectorEtf);
  else if (filter === '棰樻潗鏂瑰悜') list = list.filter(s => s.topicDirection);

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
  const opts = ['浜屾澘鎴愬姛', '浜屾澘澶辫触', '涓夋澘鎴愬姛', '涓夋澘澶辫触', '鍥涙澘鎴愬姛', '鍥涙澘澶辫触', '浜旀澘鎴愬姛', '浜旀澘澶辫触'];
  if (opts.includes(v)) {
    const ok = v.includes('鎴愬姛');
    const color = ok ? '#dc2626' : '#16a34a';
    const sym = ok ? '鉁? : '鉁?;
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
  if (!stock.stage || stock.stage === '鍏跺畠') return null;
  const map = { '浜屾尝': '浜?, '楂樹綅': '楂?, '杩炴澘': '杩?, '棣栨澘': '棣? };
  const text = map[stock.stage] || stock.stage;
  const cls = (stock.stage === '杩炴澘' || stock.stage === '棣栨澘' || stock.stage === '浜屾尝' || stock.stage === '楂樹綅') ? 'tag-pink' : 'tag-default';
  return { text, cls };
}

function headerTags(stock) {
  let pos1 = null;
  if (stock.bought) pos1 = { text: '涔?, cls: 'tag-bought' };
  else if (stock.sold) pos1 = { text: '鍗?, cls: 'tag-sold' };
  else if (stock.hold) pos1 = { text: '鎸?, cls: 'tag-hold' };

  let pos2 = null;
  if (stock.topicDirection) pos2 = { text: '棰樻潗', cls: 'tag-topicdirection' };
  else if (stock.recentMulti) pos2 = { text: '澶氭澘', cls: 'tag-recentmulti' };
  else if (stock.sectorEtf) pos2 = { text: 'ETF', cls: 'tag-sectoretf' };

  let pos3 = null;
  const starTag = getStarTagsForStock(stock.name);
  if (starTag) {
    const starCls = ['鏄熺垎', '鏄熸渶澶?, '鏄熷', '鏄熷钩', '鏄熺幇'].includes(starTag) ? 'tag-star-up' : 'tag-star-down';
    pos3 = { text: starTag, cls: starCls, svg: true };
  }
  return { pos1, pos2, pos3 };
}
function secondTags(stock) {
  const pos2Tag = stock.topicDirection ? 'topicDirection' : (stock.recentMulti ? 'recentMulti' : (stock.sectorEtf ? 'sectorEtf' : null));
  const pos1Tag = stock.bought ? 'bought' : (stock.sold ? 'sold' : (stock.hold ? 'hold' : null));
  const tags = [];
  if (stock.recentMulti && pos2Tag !== 'recentMulti') tags.push({ text: '澶氭澘', cls: 'tag-recentmulti' });
  if (stock.sectorEtf && pos2Tag !== 'sectorEtf') tags.push({ text: 'ETF', cls: 'tag-sectoretf' });
  if (stock.hold && pos1Tag !== 'hold') tags.push({ text: '鎸?, cls: 'tag-hold' });
  if (stock.sold && pos1Tag !== 'sold') tags.push({ text: '鍗?, cls: 'tag-sold' });
  const st = stageTag(stock);
  if (st) tags.push({ text: st.text, cls: st.cls });
  if (stock.watch) tags.push({ text: '瑙?, cls: 'tag-watch' });
  if (stock.dragon) tags.push({ text: '榫?, cls: 'tag-dragon' });
  if (stock.nextDay === 'up') tags.push({ text: '娆℃棩娑?, cls: 'tag-next-up' });
  if (stock.nextDay === 'down') tags.push({ text: '娆℃棩璺?, cls: 'tag-next-down' });
  if (stock.sellHigh) tags.push({ text: '鍐查珮', cls: 'tag-sell-high' });
  if (stock.sell1120) tags.push({ text: '11:20', cls: 'tag-sell-1120' });
  if (stock.sell1450) tags.push({ text: '14:50', cls: 'tag-sell-1450' });
  if (stock.nishi) tags.push({ text: '閫?, cls: nishiClass(stock) });
  if (stock.shunshi) tags.push({ text: '椤?, cls: shunshiClass(stock) });
  return tags;
}
function soldRecordsReversed(stock) {
  return (stock.soldRecords || []).slice().reverse();
}
function profitText(profit) {
  const p = parseFloat(profit) || 0;
  return p >= 0 ? '璧? : '浜?;
}
function stocksPercentDisplay(percent) {
  if (!percent && percent !== 0) return '';
  const p = parseFloat(percent);
  return (p >= 0 ? '+' : '') + percent + '%';
}
function typeText(type) {
  return type === '閮ㄥ垎鍗? ? '閮ㄥ垎鍗? : (type === '鍏ㄦ竻浠? ? '鍏ㄦ竻浠? : '');
}
function profitColor(profit) {
  return (parseFloat(profit) || 0) >= 0 ? '#dc2626' : '#16a34a';
}

function closeHeaderBadge(stock) {
  const status = getStockProfitStatus(stock.name, getStocksData());
  if (status === '璧?) return { text: '璧?, style: 'background:#dc2626;color:#fff' };
  if (status === '浜?) return { text: '浜?, style: 'background:#6b7280;color:#fff' };
  if (stock.bomb) return { text: '鐐?, style: '' };
  return null;
}

function remarkDisplay(stock) {
  if (!stock || (!stock.remarkType && !stock.remark)) return { prefix: '', prefixColor: '', text: '-' };
  const typeMap = {
    'red_check': { text: '绔炲浘绗﹀悎鉁?, color: '#dc2626' },
    'orange_check': { text: '绔炲浘鍕夊己绗﹀悎鉁?, color: '#f97316' },
    'green_x': { text: '绔炲浘涓嶇鍚埫?, color: '#16a34a' },
    'green_x_strong': { text: '绔炲浘闈炲父涓嶇鍚埫?, color: '#16a34a' }
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
const editModalTitle = ref('缂栬緫鑲＄エ');
const editForm = reactive({});
let editingStockId = null;
const editFields = [
  { key: 'name', label: '鑲＄エ鍚嶇О', type: 'text' },
  { key: 'stage', label: '闃舵', type: 'select', options: ['浜屾澘', '棣栨澘', '杩炴澘', '浜屾尝', '楂樹綅', '鍏跺畠'] },
  { key: 'open', label: '绔炰环寮€鐩?%)', type: 'text' },
  { key: 'close', label: '鏀剁洏(%)', type: 'text' },
  { key: 'turnover', label: '鎹㈡墜鐜?%)', type: 'text' },
  { key: 'adjust', label: '璋冩暣骞呭害', type: 'text' },
  { key: 'pattern', label: '绔炵鍚堟暟褰㈡€?, type: 'text' },
  { key: 'axis', label: '闆惰酱浣嶇疆', type: 'text' },
  { key: 'kbiliangkai', label: '寮€鐩橀噺姣?, type: 'text' },
  { key: 'sfliangneng', label: '缂╂斁閲忚兘', type: 'text' },
  { key: 'xgcaiti', label: '鐩稿叧棰樻潗', type: 'text' },
  { key: 'remark', label: '澶囨敞', type: 'text' },
  { key: 'bought', label: '宸蹭拱(0/1)', type: 'number' },
  { key: 'sold', label: '宸插崠(0/1)', type: 'number' },
  { key: 'hold', label: '鎸佹湁(0/1)', type: 'number' },
  { key: 'watch', label: '瑙傚療(0/1)', type: 'number' },
  { key: 'dragon', label: '榫欏ご(0/1)', type: 'number' },
];

function openEditModal(id) {
  const stock = (getStocksData()[getCurrentDate()] || []).find(s => s.id === id);
  if (!stock) { showToast('鏈壘鍒拌偂绁ㄦ暟鎹?); return; }
  editingStockId = id;
  editModalTitle.value = '缂栬緫: ' + (stock.name || '');
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
  showToast('宸蹭繚瀛?);
}

const soldEditModalActive = ref(false);
const soldEditForm = reactive({ type: '閮ㄥ垎鍗?, profit: 0, percent: 0, date: '' });
let soldEditingStockId = null;

function openSoldEditModal(id) {
  soldEditingStockId = id;
  const today = getCurrentDate();
  soldEditForm.type = '閮ㄥ垎鍗?;
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
  showToast('鍗栧嚭璁板綍宸蹭繚瀛?);
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
  showToast('杩借釜璁板綍宸蹭繚瀛?);
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
  showToast('宸插鍑?);
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
        showToast('瀵煎叆鎴愬姛');
      } catch (err) {
        showToast('瀵煎叆澶辫触: ' + err.message);
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