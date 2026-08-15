// 从 HomeStocksView.vue 提取的「纯展示/格式化」函数集合。
// 这些函数无状态、不依赖组件实例，仅根据传入的 stock 与外部 helper 计算展示信息。
// 仅做位置迁移，逻辑与原始实现完全一致。

import { getStarTagsForStock, getStockProfitStatus } from '../logic/ui-bridge.js';
import { getStocksData } from '../data/supabase-client.js';

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

  let pos3 = null;
  const starTag = getStarTagsForStock(stock.name);
  if (starTag) {
    const starCls = ['星爆', '星最多', '星增', '星平', '星现'].includes(starTag) ? 'tag-star-up' : 'tag-star-down';
    pos3 = { text: starTag, cls: starCls, svg: true };
  }
  return { pos1, pos2, pos3 };
}

function secondTags(stock) {
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

function trackItems(track) {
  return (track || []).slice().reverse();
}

export function useStockDisplay() {
  return {
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
  };
}
