<template>
  <!-- 股票列表 -->
  <div class="stock-list trading-day-element" :class="{ collapsed: isCollapsedMode }">
  <div v-for="stock in sortedList" :key="stock.id"
       v-memo="[stock, isExpanded(stock), expandedActionsId === stock.id]"
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
      <div class="track-simple-head">📌 追踪记录</div>
      <div v-if="trackItems(stock.track).length" class="track-scroll-container">
        <div class="track-window content-display">
          <div v-for="(item, idx) in trackItems(stock.track)" :key="(item.date||'')+'|'+idx" class="track-item">
            <span class="track-date">{{ formatDate(item.date) }}</span>
            <span>{{ item.content || '' }}</span>
          </div>
        </div>
      </div>
      <div v-else class="track-empty-hint">暂无追踪，点击添加...</div>
    </div>
  </div>
  </div>
</template>

<script setup>
import { formatDate } from '../logic/ui-bridge.js';
import { useHomeStocksState } from '../composables/useHomeStocksState.js';
import { useStockDisplay } from '../composables/useStockDisplay.js';

const {
  sortedList,
  isCollapsedMode,
  isExpanded,
  expandedActionsId,
  onHeaderLeftClick,
  onHeaderRightClick,
  onBodyClick,
  onEdit,
  onCopyTomorrow,
  onCopyDate,
  onDelete,
  onSoldEdit,
  onTrackEdit
} = useHomeStocksState();

const {
  openDisplay,
  stocksTurnoverDisplay,
  closeDisplay,
  adjustDisplay,
  kbkDisplay,
  headerTags,
  secondTags,
  soldRecordsReversed,
  profitText,
  stocksPercentDisplay,
  typeText,
  profitColor,
  closeHeaderBadge,
  remarkDisplay,
  trackItems
} = useStockDisplay();
</script>
