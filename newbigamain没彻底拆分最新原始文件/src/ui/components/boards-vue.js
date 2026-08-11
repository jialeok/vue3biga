/**
 * boards-vue.js
 * 将 stocks / hotspot / pattern 三个看板改造为 Vue 3 组件化渲染。
 * - 仍复用现有数据层与编辑模态框（stocks 编辑弹窗保留原逻辑）
 * - 覆盖原 renderList / renderHotspot / renderPattern，切断原生 DOM 渲染
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof document === 'undefined' || typeof Vue === 'undefined') return;

  const { createApp, ref, computed, onMounted, onUnmounted } = Vue;

  // 注入组件级通用样式（编辑浮层）
  (function injectStyles() {
    if (document.getElementById('boards-vue-styles')) return;
    const style = document.createElement('style');
    style.id = 'boards-vue-styles';
    style.textContent = `
      .vue-edit-overlay {
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,0.45);
        z-index: 1000;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 16px;
      }
      .vue-edit-modal {
        background: #fff;
        border-radius: 12px;
        width: 100%;
        max-width: 560px;
        max-height: 85vh;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        box-shadow: 0 20px 50px rgba(0,0,0,0.25);
      }
      .vue-edit-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 12px 16px;
        border-bottom: 1px solid #e5e7eb;
        font-weight: 600;
        color: #1f2937;
      }
      .vue-edit-header button {
        background: transparent;
        border: none;
        font-size: 22px;
        line-height: 1;
        cursor: pointer;
        color: #6b7280;
      }
      .vue-edit-modal textarea {
        width: 100%;
        padding: 14px;
        border: none;
        resize: vertical;
        outline: none;
        font-size: 14px;
        flex: 1;
        min-height: 140px;
        font-family: inherit;
      }
      .vue-edit-checkboxes {
        display: flex;
        gap: 20px;
        padding: 4px 16px 12px;
      }
      .vue-edit-checkboxes label {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 14px;
        color: #374151;
        cursor: pointer;
      }
      .vue-edit-checkboxes input[type="checkbox"] {
        width: 18px;
        height: 18px;
      }
      .vue-edit-window.save {
        margin: 0 16px 16px;
        padding: 12px;
        border: none;
        border-radius: 8px;
        background: linear-gradient(135deg, #8b5cf6, #7c3aed);
        color: #fff;
        font-size: 15px;
        cursor: pointer;
      }
      .vue-edit-save:hover {
        opacity: 0.95;
      }
    `;
    document.head.appendChild(style);
  })();

  const formatDate = window.formatDate || function (d) { return d || ''; };
  const getRemarkDisplay = window.getRemarkDisplay || function () { return '-'; };
  const getStarTagsForStock = window.getStarTagsForStock || function () { return ''; };
  const getStockProfitStatus = window.getStockProfitStatus || function () { return ''; };

  function safe(fn, ...args) {
    try { return fn(...args); } catch (e) { console.error('[boards-vue]', e); return undefined; }
  }
  window.safe = safe;

  // ========================================================================
  // 公共：更新顶部统计数字
  // ========================================================================
  function updateStockStats(all) {
    const list = all || [];
    const counts = {
      todayCount: list.length,
      boughtCount: 0,
      soldCount: 0,
      holdCount: 0,
      recentMultiCount: 0,
      sectorEtfCount: 0,
      topicDirectionCount: 0
    };
    list.forEach(s => {
      if (s.bought) counts.boughtCount++;
      if (s.sold) counts.soldCount++;
      if (s.hold) counts.holdCount++;
      if (s.recentMulti) counts.recentMultiCount++;
      if (s.sectorEtf) counts.sectorEtfCount++;
      if (s.topicDirection) counts.topicDirectionCount++;
    });
    Object.keys(counts).forEach(id => {
      const el = document.getElementById(id);
      if (el) el.textContent = String(counts[id]);
    });
    const stockListCount = document.getElementById('stockListCount');
    if (stockListCount) stockListCount.textContent = '(' + list.length + ')';
  }
  window.updateStockStats = updateStockStats;

  // ========================================================================
  // 1. 热股 / 主股票列表
  // ========================================================================
  const TrackDisplay = {
    props: ['track'],
    setup(props) {
      const items = computed(() => (props.track || []).slice().reverse());
      return { items, formatDate: window.formatDate };
    },
    template: `
      <div v-if="items.length" class="track-scroll-container">
        <div class="track-window.content-display">
          <div v-for="(item, idx) in items" :key="(item.date||'')+'|'+idx" class="track-item">
            <span class="track-date">{{ window.formatDate(item.date) }}</span>
            <span>{{ item.content || '' }}</span>
          </div>
        </div>
      </div>
      <div v-else class="track-empty-hint">暂无追踪，点击添加...</div>
    `
  };

  const StocksBoard = {
    components: { TrackDisplay },
    setup() {
      const data = ref({ currentDate: '', list: [] });
      const expandedIds = ref(new Set());
      const collapsedIds = ref(new Set());
      const expandedActionsId = ref(null);
      let lastDate = null;

      function allTodayData() {
        return (window.getStocksData ? window.getStocksData() : {})[window.currentDate] || [];
      }
      window.allTodayData = allTodayData;

      function getPriority(stock) {
        if (stock.bought) return 3;
        if (stock.hold) return 2;
        if (stock.sold) return 1;
        return 0;
      }
      window.getPriority = getPriority;
      function getTagPriority(stock) {
        if (stock.recentMulti) return 3;
        if (stock.sectorEtf) return 2;
        if (stock.topicDirection) return 1;
        return 0;
      }
      window.getTagPriority = getTagPriority;

      const sortedList = computed(() => {
        let list = [...(data.value.list || [])];
        const filter = window.currentFilter;
        if (filter === '已买') list = list.filter(s => s.bought);
        else if (filter === '已卖') list = list.filter(s => s.sold);
        else if (filter === '持有') list = list.filter(s => s.hold);
        else if (filter === '最近多板') list = list.filter(s => s.recentMulti);
        else if (filter === '板块ETF') list = list.filter(s => s.sectorEtf);
        else if (filter === '题材方向') list = list.filter(s => s.topicDirection);

        list.sort((a, b) => {
          const pa = window.getPriority(a), pb = window.getPriority(b);
          if (pa !== pb) return pb - pa;
          const ta = window.getTagPriority(a), tb = window.getTagPriority(b);
          if (ta !== tb) return tb - ta;
          return (b.id || 0) - (a.id || 0);
        });
        return list;
      });

      function refresh() {
        const newDate = window.currentDate;
        if (newDate !== lastDate) {
          expandedIds.value = new Set();
          collapsedIds.value = new Set();
          expandedActionsId.value = null;
          lastDate = newDate;
        }
        const list = window.allTodayData();
        data.value = { currentDate: newDate, list };
        window.updateStockStats(list);
      }
      window.refresh = refresh;
      window.vueStocksBoardRefresh = window.refresh;

      const isCollapsedMode = computed(() => !!window.isStockListCollapsed);
      function isExpanded(stock) {
        return isCollapsedMode.value ? expandedIds.value.has(stock.id) : !collapsedIds.value.has(stock.id);
      }
      window.isExpanded = isExpanded;
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
      window.toggleExpand = toggleExpand;
      function onHeaderLeftClick(e, stock) { e.stopPropagation(); toggleExpand(stock); }
      window.onHeaderLeftClick = onHeaderLeftClick;
      function onHeaderRightClick(e, stock) { e.stopPropagation(); toggleExpand(stock); }
      window.onHeaderRightClick = onHeaderRightClick;
      function onBodyClick(e, stock) {
        e.stopPropagation();
        if (window.isExpanded(stock)) {
          expandedActionsId.value = expandedActionsId.value === stock.id ? null : stock.id;
        }
      }
      window.onBodyClick = onBodyClick;

      // 显示辅助方法
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
      window.openDisplay = openDisplay;
      function stocksTurnoverDisplay(stock) {
        const v = stock.turnover;
        let color = '#64748b', display = (v !== undefined && v !== '') ? v + '%' : '-';
        const n = parseFloat(v);
        if (v !== undefined && v !== '' && !isNaN(n)) color = n <= 25 ? '#d97706' : '#dc2626';
        return { color, display };
      }
      window.stocksTurnoverDisplay = stocksTurnoverDisplay;
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
      window.closeDisplay = closeDisplay;
      function adjustDisplay(stock) {
        const v = stock.adjust;
        if (v === undefined || v === '') return { html: '-', color: '#374151' };
        const opts = ['二板成功', '二板失败', '三板成功', '三板失败', '四板成功', '四板失败', '五板成功', '五板失败'];
        if (opts.includes(v)) {
          const ok = v.includes('成功');
          const color = ok ? '#dc2626' : '#16a34a';
          const sym = ok ? '✔' : '✘';
          return { html: `<span style="color:${color}">${v}${sym}</span>`, color: 'inherit' };
        }
        return { html: String(v).replace(/</g, '&lt;'), color: '#374151' };
      }
      window.adjustDisplay = adjustDisplay;
      function kbkDisplay(stock) {
        const v = stock.kbiliangkai;
        const n = parseFloat(v);
        let color = '#64748b', display = v || '-';
        if (!isNaN(n)) color = n >= 3 ? '#dc2626' : '#059669';
        return { color, display };
      }
      window.kbkDisplay = kbkDisplay;
      function nishiClass(stock) {
        const close = parseFloat(stock.close);
        const up = !isNaN(close) && close > 0;
        return up ? 'tag-nishi-up' : 'tag-nishi-down';
      }
      window.nishiClass = nishiClass;
      function shunshiClass(stock) {
        const close = parseFloat(stock.close);
        const up = !isNaN(close) && close > 0;
        return up ? 'tag-shunshi-up' : 'tag-shunshi-down';
      }
      window.shunshiClass = shunshiClass;
      function stageTag(stock) {
        if (!stock.stage || stock.stage === '其它') return null;
        const map = { '二波': '二', '高位': '高', '连板': '连', '首板': '首' };
        const text = map[stock.stage] || stock.stage;
        const cls = (stock.stage === '连板' || stock.stage === '首板' || stock.stage === '二波' || stock.stage === '高位') ? 'tag-pink' : 'tag-default';
        return { text, cls };
      }
      window.stageTag = stageTag;

      function headerTagsHtml(stock) {
        const pos1 = stock.bought ? '<span class="tag tag-bought">买</span>' :
          (stock.sold ? '<span class="tag tag-sold">卖</span>' :
            (stock.hold ? '<span class="tag tag-hold">持</span>' : ''));
        const pos2 = stock.topicDirection ? '<span class="tag tag-topicdirection">题材</span>' :
          (stock.recentMulti ? '<span class="tag tag-recentmulti">多板</span>' :
            (stock.sectorEtf ? '<span class="tag tag-sectoretf">ETF</span>' : ''));
        const starTag = window.getStarTagsForStock(stock.name);
        const pos3 = starTag ? '<span class="tag ' + (['星爆', '星最多', '星增', '星平', '星现'].includes(starTag) ? 'tag-star-up' : 'tag-star-down') + '"><svg width="12" height="12" viewBox="0 0 24 24" fill="#fbbf24" style="vertical-align:middle;margin-bottom:1px"><polygon points="12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26"/></svg>' + starTag + '</span>' : '';
        if (!pos1 && !pos2 && !pos3) return '';
        const placeholder = '<span class="tag tag-placeholder"></span>';
        return '<div class="tags-row tags-row-first">' + (pos1 || placeholder) + (pos2 || placeholder) + (pos3 || placeholder) + '</div>';
      }
      window.headerTagsHtml = headerTagsHtml;
      function secondTagsHtml(stock) {
        const pos2Tag = stock.topicDirection ? 'topicDirection' : (stock.recentMulti ? 'recentMulti' : (stock.sectorEtf ? 'sectorEtf' : null));
        const pos1Tag = stock.bought ? 'bought' : (stock.sold ? 'sold' : (stock.hold ? 'hold' : null));
        let html = '';
        if (stock.recentMulti && pos2Tag !== 'recentMulti') html += '<span class="tag tag-recentmulti">多板</span>';
        if (stock.sectorEtf && pos2Tag !== 'sectorEtf') html += '<span class="tag tag-sectoretf">ETF</span>';
        if (stock.hold && pos1Tag !== 'hold') html += '<span class="tag tag-hold">持</span>';
        if (stock.sold && pos1Tag !== 'sold') html += '<span class="tag tag-sold">卖</span>';
        const st = window.stageTag(stock);
        if (st) html += '<span class="tag ' + st.cls + '">' + st.text + '</span>';
        if (stock.watch) html += '<span class="tag tag-watch">观</span>';
        if (stock.dragon) html += '<span class="tag tag-dragon">龙</span>';
        if (stock.nextDay === 'up') html += '<span class="tag tag-next-up">次日涨</span>';
        if (stock.nextDay === 'down') html += '<span class="tag tag-next-down">次日跌</span>';
        if (stock.sellHigh) html += '<span class="tag tag-sell-high">冲高</span>';
        if (stock.sell1120) html += '<span class="tag tag-sell-1120">11:20</span>';
        if (stock.sell1450) html += '<span class="tag tag-sell-1450">14:50</span>';
        if (stock.nishi) html += '<span class="tag ' + window.nishiClass(stock) + '">逆</span>';
        if (stock.shunshi) html += '<span class="tag ' + window.shunshiClass(stock) + '">顺</span>';
        return html;
      }
      window.secondTagsHtml = secondTagsHtml;
      function soldRecordsReversed(stock) {
        return (stock.soldRecords || []).slice().reverse();
      }
      window.soldRecordsReversed = soldRecordsReversed;
      function profitText(profit) {
        const p = parseFloat(profit) || 0;
        return p >= 0 ? '赚' : '亏';
      }
      window.profitText = profitText;
      function stocksPercentDisplay(percent) {
        if (!percent && percent !== 0) return '';
        const p = parseFloat(percent);
        return (p >= 0 ? '+' : '') + percent + '%';
      }
      window.stocksPercentDisplay = stocksPercentDisplay;
      function typeText(type) {
        return type === '部分卖' ? '部分卖' : (type === '全清仓' ? '全清仓' : '');
      }
      window.typeText = typeText;
      function profitColor(profit) {
        return (parseFloat(profit) || 0) >= 0 ? '#dc2626' : '#16a34a';
      }
      window.profitColor = profitColor;
      function closeHeaderBadge(stock) {
        const status = window.getStockProfitStatus(stock.name, window.getStocksData());
        if (status === '赚') return '<span class="bomb-badge" style="background:#dc2626;color:#fff">赚</span>';
        if (status === '亏') return '<span class="bomb-badge" style="background:#6b7280;color:#fff">亏</span>';
        if (stock.bomb) return '<span class="bomb-badge">炸</span>';
        return '';
      }
      window.closeHeaderBadge = closeHeaderBadge;

      // 操作按钮
      function onEdit(id) { safe(window.editStock, id); }
      window.onEdit = onEdit;
      function onCopyTomorrow(id) { safe(window.copyToTomorrow, id); }
      window.onCopyTomorrow = onCopyTomorrow;
      function onCopyDate(id) { safe(window.copyToDate, id); }
      window.onCopyDate = onCopyDate;
      function onDelete(id) { safe(window.deleteStock, id); }
      window.onDelete = onDelete;
      function onSoldEdit(id) { safe(window.openSoldEdit, id); }
      window.onSoldEdit = onSoldEdit;
      function onTrackEdit(stock) { safe(window.openTrackEdit, stock.id !== undefined ? stock.id : stock.name); }
      window.onTrackEdit = onTrackEdit;

      // 日期/数据变化轮询
      let timer = setInterval(() => {
        if (data.value.currentDate !== window.currentDate) window.refresh();
      }, 200);
      onMounted(window.refresh);
      onUnmounted(() => clearInterval(timer));

      return {
        sortedList,
        isCollapsedMode,
        isExpanded: window.isExpanded,
        expandedActionsId,
        onHeaderLeftClick: window.onHeaderLeftClick,
        onHeaderRightClick: window.onHeaderRightClick,
        onBodyClick: window.onBodyClick,
        openDisplay: window.openDisplay,
        stocksTurnoverDisplay: window.stocksTurnoverDisplay,
        closeDisplay: window.closeDisplay,
        adjustDisplay: window.adjustDisplay,
        kbkDisplay: window.kbkDisplay,
        headerTagsHtml: window.headerTagsHtml,
        secondTagsHtml: window.secondTagsHtml,
        getRemarkDisplay: window.getRemarkDisplay,
        soldRecordsReversed: window.soldRecordsReversed,
        profitText: window.profitText,
        stocksPercentDisplay: window.stocksPercentDisplay,
        typeText: window.typeText,
        profitColor: window.profitColor,
        closeHeaderBadge: window.closeHeaderBadge,
        onEdit: window.onEdit,
        onCopyTomorrow: window.onCopyTomorrow,
        onCopyDate: window.onCopyDate,
        onDelete: window.onDelete,
        onSoldEdit: window.onSoldEdit,
        onTrackEdit: window.onTrackEdit,
      };
    },
    template: `
      <div v-if="sortedList.length === 0" class="empty-state trading-day-element" style="display:block">
        <div class="empty-icon">📈</div>
        <div class="empty-title">暂无股票记录</div>
        <div class="empty-desc">点击下方 + 按钮添加第一条记录</div>
      </div>
      <div v-for="stock in sortedList" :key="stock.id"
           :id="'stock-card-' + stock.id"
           class="stock-card"
           :class="{ bought: stock.bought, sold: stock.sold, 'single-expanded': window.isExpanded(stock), 'single-collapsed': !isCollapsedMode && !window.isExpanded(stock) }">
        <div class="stock-header">
          <div class="stock-header-left" @click="window.onHeaderLeftClick($event, stock)">
            <div class="stock-name">
              {{ stock.name }}
              <div v-html="window.headerTagsHtml(stock)"></div>
              <div class="tags-row" v-html="window.secondTagsHtml(stock)"></div>
            </div>
          </div>
          <div class="stock-header-right" @click="window.onHeaderRightClick($event, stock)">
            <div class="close-rate-header" :class="{ up: window.closeDisplay(stock).isUp, down: window.closeDisplay(stock).isDown }">
              <span v-html="window.closeHeaderBadge(stock)"></span>
              {{ window.closeDisplay(stock).display }}
            </div>
            <div class="expand-icon">▼</div>
          </div>
        </div>
        <div class="stock-body" @click="window.onBodyClick($event, stock)" @dblclick="window.onEdit(stock.id)">
          <div class="info-item">
            <div class="info-label">换手率</div>
            <div class="turnover-highlight" :style="{ color: window.stocksTurnoverDisplay(stock).color }">{{ window.stocksTurnoverDisplay(stock).display }}</div>
          </div>
          <div class="info-item">
            <div class="info-label">竞价开盘</div>
            <div class="info-value" :style="{ color: window.openDisplay(stock).color }">{{ window.openDisplay(stock).display }}</div>
          </div>
          <div class="info-item">
            <div class="info-label">调整幅度</div>
            <div class="info-value" :style="{ color: window.adjustDisplay(stock).color }" v-html="window.adjustDisplay(stock).html"></div>
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
            <div class="remark-value" v-html="window.getRemarkDisplay(stock)"></div>
          </div>
          <div class="info-item">
            <div class="info-label">开盘量比</div>
            <div class="info-value" :style="{ color: window.kbkDisplay(stock).color }">{{ window.kbkDisplay(stock).display }}</div>
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
        <div class="stock-actions" :class="{ expanded: expandedActionsId === stock.id }" :id="'actions-' + stock.id">
          <button class="action-btn btn-edit" @click.stop="window.onEdit(stock.id)">编辑</button>
          <button class="action-btn btn-copy" @click.stop="window.onCopyTomorrow(stock.id)">复制到交易日</button>
          <button class="action-btn btn-copy-date" @click.stop="window.onCopyDate(stock.id)">复制到日期</button>
          <button class="action-btn btn-delete" @click.stop="window.onDelete(stock.id)">删除</button>
        </div>
        <div v-if="stock.isSold && stock.soldRecords && stock.soldRecords.length"
             class="sold-records-display"
             style="padding:8px 15px;background:linear-gradient(90deg, rgba(220, 38, 38, 0.05), transparent);cursor:pointer;margin:8px 0;border-radius:8px;"
             @click.stop="window.onSoldEdit(stock.id)">
          <div v-for="record in window.soldRecordsReversed(stock)" :key="record.date"
               style="font-size:12px;line-height:1.8;font-weight:500;"
               :style="{ color: window.profitColor(record.profit) }">
            {{ record.date }} {{ window.typeText(record.type) }}{{ window.profitText(record.profit) }}{{ (parseFloat(record.profit) >= 0 ? '+' : '') + record.profit }} {{ window.stocksPercentDisplay(record.percent) }}
          </div>
        </div>
        <div v-else
             class="sold-records-empty"
             style="padding:6px 15px;background:linear-gradient(90deg, rgba(59, 130, 246, 0.03), transparent);cursor:pointer;margin:8px 0;border-radius:8px;"
             @click.stop="window.onSoldEdit(stock.id)">
          <div style="font-size:12px;color:#94a3b8;">💰 点击添加</div>
        </div>
        <div class="track-simple" @click="window.onTrackEdit(stock)">
          <TrackDisplay :track="stock.track" />
        </div>
      </div>
    `
  };

  // ========================================================================
  // 2. 题材思路
  // ========================================================================
  const HotspotBoard = {
    setup() {
      const editing = ref(false);
      const draft = ref('');
      function content() {
        return window.getTodayHotspot ? window.getTodayHotspot() : '';
      }
      window.content = content;
      function refresh() {
        editing.value = false;
        draft.value = '';
      }
      window.refresh = refresh;
      window.vueHotspotBoardRefresh = window.refresh;

      function startEdit() {
        draft.value = window.content();
        editing.value = true;
      }
      window.startEdit = startEdit;
      function cancel() { editing.value = false; }
      window.cancel = cancel;
      function save() {
        const val = draft.value.trim();
        const hotspotData = window.getHotspotData ? window.getHotspotData() : {};
        hotspotData[window.currentDate] = val;
        if (window.saveData) window.saveData();
        if (window.renderHotspot) window.renderHotspot();
        if (window.renderWeekendStats) window.renderWeekendStats();
        editing.value = false;
        if (window.showToast) window.showToast('✅ 题材思路已保存');
      }
      window.save = save;

      let timer = setInterval(() => { /* 日期切换时 Vue 会重新读取 window.content() */ }, 500);
      onUnmounted(() => clearInterval(timer));

      return { editing, draft, content: window.content, startEdit: window.startEdit, cancel: window.cancel, save: window.save };
    },
    template: `
      <div class="hotspot-header"><div class="hotspot-title">题材思路</div></div>
      <div class="hotspot-window.content" @click="window.startEdit">
        <div v-if="window.content().trim()" style="white-space: pre-wrap;">{{ window.content() }}</div>
        <div v-else class="hotspot-placeholder">暂无题材思路，点击添加...</div>
      </div>
      <div v-if="editing" class="vue-edit-overlay" @click.self="window.cancel">
        <div class="vue-edit-modal">
          <div class="vue-edit-header"><span>编辑题材思路</span><button @click="window.cancel">×</button></div>
          <textarea v-model="draft" placeholder="输入题材思路分析..."></textarea>
          <button class="vue-edit-window.save" @click="window.save">保存</button>
        </div>
      </div>
    `
  };

  // ========================================================================
  // 3. 模式
  // ========================================================================
  const PatternBoard = {
    setup() {
      const expanded = ref(false);
      const editing = ref(false);
      const draftContent = ref('');
      const draftUpdate = ref(false);
      const draftKeep = ref(false);

      function todayPattern() {
        return window.getTodayPattern ? window.getTodayPattern() : { content: '', update: false, keep: false };
      }
      window.todayPattern = todayPattern;
      function refresh() {
        editing.value = false;
        draftContent.value = '';
        draftUpdate.value = false;
        draftKeep.value = false;
      }
      window.refresh = refresh;
      window.vuePatternBoardRefresh = window.refresh;

      function toggleExpand() {
        expanded.value = !expanded.value;
        const el = document.getElementById('patternBoard');
        if (el) {
          if (expanded.value) el.classList.remove('minimized');
          else el.classList.add('minimized');
        }
      }
      window.toggleExpand = toggleExpand;
      function startEdit() {
        const p = window.todayPattern();
        draftContent.value = p.content || '';
        draftUpdate.value = !!p.update;
        draftKeep.value = !!p.keep;
        editing.value = true;
      }
      window.startEdit = startEdit;
      function cancel() { editing.value = false; }
      window.cancel = cancel;
      function save() {
        const content = draftContent.value.trim();
        const update = draftUpdate.value;
        const keep = draftKeep.value;
        const patternData = window.getPatternData ? window.getPatternData() : {};
        patternData[window.currentDate] = { content, update, keep };

        if (update || keep) {
          const nextDate = window.getNextDate ? window.getNextDate(window.currentDate) : null;
          if (nextDate) {
            const nextPattern = patternData[nextDate];
            if (nextPattern && (!nextPattern.content || nextPattern.content.trim() === '')) {
              nextPattern.content = content;
              nextPattern.update = false;
              nextPattern.keep = false;
            }
          }
        }

        if (window.saveData) window.saveData();
        if (window.renderPattern) window.renderPattern();
        if (window.renderWeekendStats) window.renderWeekendStats();
        editing.value = false;
        if (window.showToast) window.showToast('✅ 模式数据已保存' + ((update || keep) ? '，已检查后一天数据' : ''));
      }
      window.save = save;

      let timer = setInterval(() => {}, 500);
      onUnmounted(() => clearInterval(timer));

      return { expanded, editing, draftContent, draftUpdate, draftKeep, todayPattern: window.todayPattern, toggleExpand: window.toggleExpand, startEdit: window.startEdit, cancel: window.cancel, save: window.save };
    },
    template: `
      <div class="pattern-header" @click="window.toggleExpand">
        <div class="pattern-title">模式
          <div class="pattern-tags">
            <div v-if="window.todayPattern().update" class="pattern-tag update">更新</div>
            <div v-if="window.todayPattern().keep" class="pattern-tag keep">坚守</div>
          </div>
        </div>
        <div class="pattern-toggle-btn">{{ expanded ? '▲' : '▼' }}</div>
      </div>
      <div v-show="expanded" class="pattern-content" @click="window.startEdit">
        <div v-if="window.todayPattern().content && window.todayPattern().content.trim()" style="white-space: pre-wrap;">{{ window.todayPattern().content }}</div>
        <div v-else class="pattern-placeholder">暂无模式心得，点击添加...</div>
      </div>
      <div v-if="editing" class="vue-edit-overlay" @click.self="window.cancel">
        <div class="vue-edit-modal">
          <div class="vue-edit-header"><span>编辑模式心得</span><button @click="window.cancel">×</button></div>
          <textarea v-model="draftContent" placeholder="输入模式完善心得..."></textarea>
          <div class="vue-edit-checkboxes">
            <label><input type="checkbox" v-model="draftUpdate"> 更新</label>
            <label><input type="checkbox" v-model="draftKeep"> 坚守</label>
          </div>
          <button class="vue-edit-save" @click="window.save">保存模式</button>
        </div>
      </div>
    `
  };

  // ========================================================================
  // 挂载并覆盖原渲染函数
  // ========================================================================
  function mountStocksBoards() {
    const stockEl = document.getElementById('stockList');
    const hotspotEl = document.getElementById('hotspotBoard');
    const patternEl = document.getElementById('patternBoard');

    // [GRACE-DEGRADE] 保存原生容器内容。本环境 Vue 组件 createApp().mount() 可能抛错
    // （c2Vue=false，组件运行时挂载失败）。Vue 的 mount 会先清空容器再渲染，一旦抛错，
    // 容器已被清空却未回退 → 模式/题材等看板只剩空框架（紫色边框线）。故逐个 try/catch，
    // 失败时还原容器原始 innerHTML，并保留原生 innerHTML 渲染路径（与 rank-vue.js 一致）。
    const savedStock = stockEl ? stockEl.innerHTML : '';
    const savedHotspot = hotspotEl ? hotspotEl.innerHTML : '';
    const savedPattern = patternEl ? patternEl.innerHTML : '';

    // [VUE-PROD-SWALLOW] Vue 3 生产构建 (vue.global.prod.js) 中 render 抛错只 console.error
    // 不 re-throw，故 try/catch 抓不到。挂载后必须检查容器是否真的有内容；空则视为失败，
    // 还原 innerHTML 并保留原生渲染函数（否则 renderXxx 被改成空 Vue stub → 看板只剩边框线）。
    function _hasContent(el) { return el && el.children.length > 0; }

    let stockOk = false, hotspotOk = false, patternOk = false;

    if (stockEl) {
      try { createApp(StocksBoard).mount(stockEl); stockOk = _hasContent(stockEl); }
      catch (e) { stockOk = false; }
      if (!stockOk) { stockEl.innerHTML = savedStock; if (window._dbgLog) window._dbgLog('[BOARD-VUE] stock 挂载失败/空内容，回退原生渲染'); }
    }
    if (hotspotEl) {
      try { createApp(HotspotBoard).mount(hotspotEl); hotspotOk = _hasContent(hotspotEl); }
      catch (e) { hotspotOk = false; }
      if (!hotspotOk) { hotspotEl.innerHTML = savedHotspot; if (window._dbgLog) window._dbgLog('[BOARD-VUE] hotspot 挂载失败/空内容，回退原生渲染'); }
    }
    if (patternEl) {
      try { createApp(PatternBoard).mount(patternEl); patternOk = _hasContent(patternEl); }
      catch (e) { patternOk = false; }
      if (!patternOk) { patternEl.innerHTML = savedPattern; if (window._dbgLog) window._dbgLog('[BOARD-VUE] pattern 挂载失败/空内容，回退原生渲染'); }
      patternEl.classList.add('minimized');
    }

    // 仅当对应看板挂载成功才接管其 render 函数；失败则保留原生 innerHTML 版本。
    if (stockOk) {
    // 接管 renderList：保留统计与其他看板调度，股票列表交给 Vue
    // [RESILIENT-RENDER] 与原生 renderList 一致：每个看板渲染互相隔离，单一看板抛错不再中断
    // 整条链路（否则排名看板 Vue 挂载失败时，竞价变化看板 renderBidding 会被一起跳过变白板）。
    window.renderList = function (skipOtherBoards, skipAuction) {
      try { window.updateStockStats(window.getTodayData ? window.getTodayData() : []); }
      catch (e) { if (window._dbgLog) window._dbgLog('[RENDER-LIST-VUE] updateStockStats 失败（已隔离）: ' + (e && e.message)); }
      try { if (window.updateDateDisplay) window.updateDateDisplay(); }
      catch (e) { if (window._dbgLog) window._dbgLog('[RENDER-LIST-VUE] updateDateDisplay 失败（已隔离）: ' + (e && e.message)); }
      if (!skipOtherBoards) {
        const _safe = (label, fn) => { try { fn(); } catch (e) { if (window._dbgLog) window._dbgLog('[RENDER-LIST-VUE] ' + label + ' 失败（已隔离）: ' + (e && e.message)); } };
        // 竞价变化看板优先，确保一定能显示
        _safe('renderBidding', () => window.renderBidding && window.renderBidding());
        _safe('renderPattern', () => window.renderPattern && window.renderPattern());
        _safe('renderJiwang', () => window.renderJiwang && window.renderJiwang());
        _safe('renderTagTitles', () => window.renderTagTitles && window.renderTagTitles());
        _safe('renderRank', () => window.renderRank && window.renderRank());
        if (!skipAuction) _safe('renderAuction', () => window.renderAuction && window.renderAuction());
        _safe('renderHotStocks', () => window.renderHotStocks && window.renderHotStocks());
        _safe('renderMulti', () => window.renderMulti && window.renderMulti());
        _safe('renderHotspot', () => window.renderHotspot && window.renderHotspot());
        _safe('renderEtf', () => window.renderEtf && window.renderEtf());
        _safe('renderDuiban', () => window.renderDuiban && window.renderDuiban());
        _safe('renderWeekendStats', () => window.renderWeekendStats && window.renderWeekendStats());
      }
      try { if (window.vueStocksBoardRefresh) window.vueStocksBoardRefresh(); }
      catch (e) { if (window._dbgLog) window._dbgLog('[RENDER-LIST-VUE] vueStocksBoardRefresh 失败（已隔离）: ' + (e && e.message)); }
    };
    } // end if (stockOk)

    // 仅当对应看板挂载成功才接管 render 函数；失败则保留原生 innerHTML 渲染（已还原容器）。
    if (hotspotOk) {
      window.renderHotspot = function () {
        if (window.vueHotspotBoardRefresh) window.vueHotspotBoardRefresh();
      };
    }

    if (patternOk) {
      window.renderPattern = function () {
        if (window.vuePatternBoardRefresh) window.vuePatternBoardRefresh();
      };
    }

    // 通知 Vue 刷新一次（应对 DOMContentLoaded 之前已经触发过的渲染）
    if (window.vueStocksBoardRefresh) window.vueStocksBoardRefresh();
    if (window.vueHotspotBoardRefresh) window.vueHotspotBoardRefresh();
    if (window.vuePatternBoardRefresh) window.vuePatternBoardRefresh();
  }
  window.mountStocksBoards = mountStocksBoards;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', window.mountStocksBoards);
  } else {
    window.mountStocksBoards();
  }
})();
