<template>
  <div :id="'stock-card-' + stock.id" class="stock-card"
       :class="{ bought: stock.bought, sold: stock.sold, 'single-expanded': expanded, 'single-collapsed': !collapsedMode && !expanded }">
    <div class="stock-header">
      <div class="stock-header-left" @click="$emit('header-left-click', $event, stock)">
        <div class="stock-name">
          {{ stock.name }}
          <div class="tags-row tags-row-first">
            <span v-if="headerTags.pos1" class="tag" :class="headerTags.pos1.cls">{{ headerTags.pos1.text }}</span>
            <span v-else class="tag tag-placeholder"></span>
            <span v-if="headerTags.pos2" class="tag" :class="headerTags.pos2.cls">{{ headerTags.pos2.text }}</span>
            <span v-else class="tag tag-placeholder"></span>
            <span v-if="headerTags.pos3" class="tag" :class="headerTags.pos3.cls">
              <svg v-if="headerTags.pos3.svg" width="12" height="12" viewBox="0 0 24 24" fill="#fbbf24" style="vertical-align:middle;margin-bottom:1px"><polygon points="12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26"/></svg>
              {{ headerTags.pos3.text }}
            </span>
            <span v-else class="tag tag-placeholder"></span>
          </div>
          <div class="tags-row">
            <span v-for="(tag, idx) in secondTags" :key="idx" class="tag" :class="tag.cls">{{ tag.text }}</span>
          </div>
        </div>
      </div>
      <div class="stock-header-right" @click="$emit('header-right-click', $event, stock)">
        <div class="close-rate-header" :class="{ up: closeInfo.isUp, down: closeInfo.isDown }">
          <span v-if="badge" class="bomb-badge" :style="badge.style">{{ badge.text }}</span>
          {{ closeInfo.display }}
        </div>
        <div class="expand-icon">▼</div>
      </div>
    </div>
    <div class="stock-body" @click="$emit('body-click', $event, stock)" @dblclick="$emit('edit', stock.id)">
      <slot name="body" :stock="stock">
        <div class="info-item">
          <div class="info-label">换手率</div>
          <div class="turnover-highlight" :style="{ color: turnover.color }">{{ turnover.display }}</div>
        </div>
        <div class="info-item">
          <div class="info-label">竞价开盘</div>
          <div class="info-value" :style="{ color: openInfo.color }">{{ openInfo.display }}</div>
        </div>
        <div class="info-item">
          <div class="info-label">调整幅度</div>
          <div class="info-value" :style="{ color: adjust.color }">
            <span v-if="adjust.symbol" :style="{ color: adjust.symbolColor }">{{ adjust.text }}{{ adjust.symbol }}</span>
            <template v-else>{{ adjust.text }}</template>
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
            <span v-if="remark.prefix" :style="{ color: remark.prefixColor }">{{ remark.prefix }}</span>{{ remark.text || '-' }}
          </div>
        </div>
        <div class="info-item">
          <div class="info-label">开盘量比</div>
          <div class="info-value" :style="{ color: kbk.color }">{{ kbk.display }}</div>
        </div>
        <div class="info-item">
          <div class="info-label">缩放量能</div>
          <div class="sfliangneng-value">{{ stock.sfliangneng || '-' }}</div>
        </div>
        <div class="info-item">
          <div class="info-label">相关题材</div>
          <div class="xgcaiti-value">{{ stock.xgcaiti ? stock.xgcaiti.replace(/[()]/g, '') : '-' }}</div>
        </div>
      </slot>
    </div>
    <div class="stock-actions" :class="{ expanded: actionsExpanded }" :id="'actions-' + stock.id">
      <button class="action-btn btn-edit" @click.stop="$emit('edit', stock.id)">编辑</button>
      <button class="action-btn btn-copy" @click.stop="$emit('copy-tomorrow', stock.id)">复制到交易日</button>
      <button class="action-btn btn-copy-date" @click.stop="$emit('copy-date', stock.id)">复制到日期</button>
      <button class="action-btn btn-delete" @click.stop="$emit('delete', stock.id)">删除</button>
    </div>
    <div v-if="stock.isSold && stock.soldRecords && stock.soldRecords.length"
         class="sold-records-display"
         style="padding:8px 15px;background:linear-gradient(90deg, rgba(220, 38, 38, 0.05), transparent);cursor:pointer;margin:8px 0;border-radius:8px;"
         @click.stop="$emit('sold-edit', stock.id)">
      <div v-for="record in soldRecordsReversed" :key="record.date"
           style="font-size:12px;line-height:1.8;font-weight:500;"
           :style="{ color: profitColor(record.profit) }">
        {{ record.date }} {{ typeText(record.type) }}{{ profitText(record.profit) }}{{ (parseFloat(record.profit) >= 0 ? '+' : '') + record.profit }} {{ percentDisplay(record.percent) }}
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  stock: { type: Object, required: true },
  expanded: { type: Boolean, default: false },
  collapsedMode: { type: Boolean, default: false },
  actionsExpanded: { type: Boolean, default: false },
  closeInfo: { type: Object, default: () => ({ display: '-', color: '', isUp: false, isDown: false }) },
  turnover: { type: Object, default: () => ({ display: '-', color: '' }) },
  openInfo: { type: Object, default: () => ({ display: '-', color: '' }) },
  badge: { type: Object, default: null },
  getStarTagsForStock: { type: Function, default: () => '' },
  getStockProfitStatus: { type: Function, default: () => '' },
  stocksData: { type: Array, default: () => [] }
});

defineEmits(['header-left-click', 'header-right-click', 'body-click', 'edit', 'copy-tomorrow', 'copy-date', 'delete', 'sold-edit']);

function nishiClass(stock) {
  const close = parseFloat(stock.close);
  return !isNaN(close) && close > 0 ? 'tag-nishi-up' : 'tag-nishi-down';
}
function shunshiClass(stock) {
  const close = parseFloat(stock.close);
  return !isNaN(close) && close > 0 ? 'tag-shunshi-up' : 'tag-shunshi-down';
}
function stageTag(stock) {
  if (!stock.stage || stock.stage === '其它') return null;
  const map = { '二波': '二', '高位': '高', '连板': '连', '首板': '首' };
  const text = map[stock.stage] || stock.stage;
  const cls = (stock.stage === '连板' || stock.stage === '首板' || stock.stage === '二波' || stock.stage === '高位') ? 'tag-pink' : 'tag-default';
  return { text, cls };
}

const headerTags = computed(() => {
  const stock = props.stock;
  let pos1 = null;
  if (stock.bought) pos1 = { text: '买', cls: 'tag-bought' };
  else if (stock.sold) pos1 = { text: '卖', cls: 'tag-sold' };
  else if (stock.hold) pos1 = { text: '持', cls: 'tag-hold' };

  let pos2 = null;

  let pos3 = null;
  const starTag = props.getStarTagsForStock(stock.name);
  if (starTag) {
    const starCls = ['星爆', '星最多', '星增', '星平', '星现'].includes(starTag) ? 'tag-star-up' : 'tag-star-down';
    pos3 = { text: starTag, cls: starCls, svg: true };
  }
  return { pos1, pos2, pos3 };
});

const secondTags = computed(() => {
  const stock = props.stock;
  const pos1Tag = stock.bought ? 'bought' : (stock.sold ? 'sold' : (stock.hold ? 'hold' : null));
  const tags = [];
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
});

const adjust = computed(() => {
  const v = props.stock.adjust;
  if (v === undefined || v === '') return { text: '-', color: '#374151', symbol: '', symbolColor: '' };
  const opts = ['二板成功', '二板失败', '三板成功', '三板失败', '四板成功', '四板失败', '五板成功', '五板失败'];
  if (opts.includes(v)) {
    const ok = v.includes('成功');
    return { text: v, color: 'inherit', symbol: ok ? '✔' : '✘', symbolColor: ok ? '#dc2626' : '#16a34a' };
  }
  return { text: String(v), color: '#374151', symbol: '', symbolColor: '' };
});

const remark = computed(() => {
  const stock = props.stock;
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
});

const kbk = computed(() => {
  const v = props.stock.kbiliangkai;
  const n = parseFloat(v);
  let color = '#64748b', display = v || '-';
  if (!isNaN(n)) color = n >= 3 ? '#dc2626' : '#059669';
  return { color, display };
});

const soldRecordsReversed = computed(() => (props.stock.soldRecords || []).slice().reverse());

function profitText(profit) { return (parseFloat(profit) || 0) >= 0 ? '赚' : '亏'; }
function profitColor(profit) { return (parseFloat(profit) || 0) >= 0 ? '#dc2626' : '#16a34a'; }
function typeText(type) { return type === '部分卖' ? '部分卖' : (type === '全清仓' ? '全清仓' : ''); }
function percentDisplay(percent) {
  if (!percent && percent !== 0) return '';
  return (parseFloat(percent) >= 0 ? '+' : '') + percent + '%';
}
</script>