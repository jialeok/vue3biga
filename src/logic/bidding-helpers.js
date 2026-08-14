import { autoCalculateRecentMultiScore } from './tag-titles-helpers.js';
import { getKxianTypeByClose } from './jiwang-helpers.js';
import { getNextTradingDay } from './trading-day-helpers.js';
import { getBiddingData, getJiwangData, getStocksData, getEtfData } from '../data/supabase-client.js';
import { saveData, markJiwangDirty } from './app-core-api.js';
import { pushJiwangNow } from '../data/jiwang-data.js';
import { fuyaoApiGet } from '../data/api/fuyao-proxy.js';
import { _emit } from '../stores/eventBus.js';
import { _dbgLog } from '../data/debug-log.js';
import { useUiStore } from '../stores/uiStore.js';

export { autoCalculateRecentMultiScore };

export function syncSectorEtfZhangNum(zhangNum) {
  zhangNum = parseInt(zhangNum) || 0;
  const uiStore = useUiStore();
  const currentDate = uiStore.currentDate;

  const etfData = getEtfData();
  let todayEtf = etfData[currentDate];

  if (!todayEtf || todayEtf.length === 0) {
    todayEtf = [{ shuliang: '48', dieZhangbi: '', jingtu: '', tushi: '' }];
  }

  const firstEtf = todayEtf[0];
  if (!firstEtf.shuliang) firstEtf.shuliang = '48';
  const total = parseInt(firstEtf.shuliang) || 48;
  const dieValue = total - zhangNum;
  firstEtf.dieZhangbi = dieValue + ':' + zhangNum;
  etfData[currentDate] = todayEtf;
  // §8 违规标注（业务数据落 localStorage）：stockEtfData = { [date]: [{shuliang, dieZhangbi, jingtu, tushi}] } 属板块ETF业务数据。
  // 迁云方案：新增 Supabase 表 auction_etf(date text PK, data jsonb, updated_at timestamptz)，或复用 market_metrics(scope='auction') 新增 etf_data jsonb 列；
  //   - 写：本函数改为 upsert 该表（替代本行 localStorage.setItem）；
  //   - 读：supabase-client.js getEtfData() 改为 select 该表（当前仍读 localStorage，归其他 agent 所有，本 agent 禁止编辑）。
  //   读站点未迁云前若改写 Supabase 会导致 getEtfData() 返回 {}、板块ETF看板丢数据，故暂保留下方 localStorage 写入；待读站点一并迁云后移除。
  localStorage.setItem('stockEtfData', JSON.stringify(etfData));

  _dbgLog('[SECTOR-ETF] 同步到ETF看板: 总 ' + total + ', 涨 ' + zhangNum + ', 跌:涨 = ' + firstEtf.dieZhangbi);

  _emit('board-refresh');
}

export function syncBiddingCloseToEtf(row) {
  if (!row || !row.name || !row.name.startsWith('板块ETF')) return;
  const value = (row.close || '').toString().trim();
  const zhangNum = parseInt(value) || 0;
  syncSectorEtfZhangNum(zhangNum);
}

export function syncJiwangKxianFromBidding() {
  const uiStore = useUiStore();
  const currentDate = uiStore.currentDate;

  const nextDate = getNextTradingDay(currentDate);
  if (!nextDate) return;

  const biddingData = getBiddingData();
  const currentBidding = biddingData[currentDate];
  if (!currentBidding || !Array.isArray(currentBidding)) return;

  const multiBoardRow = currentBidding.find(row => row.name === '最近多板%');
  if (!multiBoardRow || !multiBoardRow.close) return;

  const kxianValue = getKxianTypeByClose(multiBoardRow.close);
  if (!kxianValue) return;

  const jiwangData = getJiwangData();
  if (!jiwangData[nextDate]) jiwangData[nextDate] = {};

  jiwangData[nextDate].kxian = kxianValue;
  markJiwangDirty(nextDate);
  saveData();
  pushJiwangNow(nextDate).catch(e => {
    _dbgLog('[BIDDING-KXIAN] pushJiwangNow 失败: ' + (e && e.message));
  });

  if (nextDate === currentDate) {
    _emit('board-refresh');
  }
}

export function autoTagShunshiNishi(skipRender) {
  const uiStore = useUiStore();
  const currentDate = uiStore.currentDate;

  const biddingData = getBiddingData()[currentDate];
  if (!biddingData || !Array.isArray(biddingData) || biddingData.length === 0) return;

  const duibanRow = biddingData.find(row => row.name && row.name.trim() === '最近多板%');
  if (!duibanRow) return;

  const time925 = parseFloat(duibanRow.time925);
  const close = parseFloat(duibanRow.close);
  if (isNaN(time925) || isNaN(close)) return;

  const isShunshi = time925 < close;

  const stocks = getStocksData()[currentDate] || [];
  let hasUpdate = false;

  stocks.forEach(stock => {
    const closeValue = parseFloat(stock.close);
    if (isNaN(closeValue)) return;

    if (stock.nishi || stock.shunshi) {
      stock.nishi = false;
      stock.shunshi = false;
      stock.autoNishi = false;
      stock.autoShunshi = false;
    }

    if (closeValue >= 2) {
      if (isShunshi) {
        stock.shunshi = true;
        stock.autoShunshi = true;
      } else {
        stock.nishi = true;
        stock.autoNishi = true;
      }
      hasUpdate = true;
    } else {
      if (isShunshi) {
        stock.nishi = true;
        stock.autoNishi = true;
      } else {
        stock.shunshi = true;
        stock.autoShunshi = true;
      }
      hasUpdate = true;
    }
  });

  if (hasUpdate && !skipRender) {
    saveData();
    _emit('stocks-refresh');
  }
  return hasUpdate;
}


const BIDDING_SECTOR_ETFS = [
  { code: '560780', name: '半导体设备ETF' }, { code: '159995', name: '芯片ETF华夏' },
  { code: '512480', name: '半导体ETF国' }, { code: '159732', name: '消费电子ETF' },
  { code: '515880', name: '通信ETF国泰' }, { code: '560800', name: '数字经济ETF' },
  { code: '159819', name: '人工智能ETF' }, { code: '159206', name: '卫星ETF永赢' },
  { code: '515750', name: '科技50ETF' }, { code: '159608', name: '稀有金属ETF' },
  { code: '159998', name: '计算机ETF天弘' }, { code: '561160', name: '电池ETF富国' },
  { code: '159857', name: '光伏ETF天弘' }, { code: '516780', name: '稀土ETF华泰' },
  { code: '562500', name: '机器人ETF华夏' }, { code: '515400', name: '大数据ETF富国' },
  { code: '560860', name: '工业有色ETF' }, { code: '516510', name: '云计算ETF易' },
  { code: '516390', name: '新能源车ETF' }, { code: '563010', name: '电信ETF易方达' },
  { code: '159875', name: '新能源ETF嘉实' }, { code: '516100', name: '金融科技ETF' },
  { code: '886078', name: '商业航天' }, { code: '512660', name: '军工ETF国泰' },
  { code: '560280', name: '工程机械ETF' }, { code: '515230', name: '软件ETF国泰' },
  { code: '159996', name: '家电ETF国泰' }, { code: '885939', name: '海峡两岸' },
  { code: '159227', name: '航空航天ETF' }, { code: '518880', name: '黄金ETF华安' },
  { code: '1A0001', name: '上证指数' }, { code: '159869', name: '游戏ETF华夏' },
  { code: '515150', name: '一带一路ETF' }, { code: '516620', name: '影视ETF国泰' },
  { code: '515120', name: '创新药ETF广发' }, { code: '516910', name: '物流ETF富国' },
  { code: '159842', name: '券商ETF银华' }, { code: '159666', name: '交通运输ETF' },
  { code: '512200', name: '房地产ETF南方' }, { code: '159766', name: '旅游ETF富国' },
  { code: '562600', name: '医疗器械ETF' }, { code: '159611', name: '电力ETF广发' },
  { code: '167301', name: '保险主题LOF' }, { code: '159825', name: '农业ETF富国' },
  { code: '159309', name: '油气ETF汇添富' }, { code: '512690', name: '酒ETF鹏华' },
  { code: '515220', name: '煤炭ETF国泰' }, { code: '159887', name: '银行ETF富国' }
];
const BIDDING_BIG_ETFS = ['510500', '512100', '510300', '510050'];
const BIDDING_INDEX_CODES = { '886078': '886078.TI', '885939': '885939.TI', '1A0001': '000001.SH' };

function biddingEtfToSnapshotCode(code) {
  if (BIDDING_INDEX_CODES[code]) return { thscode: BIDDING_INDEX_CODES[code], type: 'index' };
  if (code.charAt(0) === '5') return { thscode: code + '.SH', type: 'stock' };
  return { thscode: code + '.SZ', type: 'stock' };
}

function biddingCurrentPoint() {
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (mins >= 9 * 60 + 10 && mins < 9 * 60 + 17) return { col: 'time915', label: '9:15' };
  if (mins >= 9 * 60 + 17 && mins < 9 * 60 + 22) return { col: 'time920', label: '9:20' };
  if (mins >= 9 * 60 + 22 && mins < 9 * 60 + 40) return { col: 'time925', label: '9:25' };
  if (mins >= 15 * 60) return { col: 'close', label: '收盘' };
  return null;
}

function biddingGetTencentPcts(thscodes) {
  return new Promise((resolve, reject) => {
    const tqCodes = thscodes.map(c => {
      const num = c.split('.')[0];
      return (c.slice(-2) === 'SZ' ? 'sz' : 'sh') + num;
    });
    const s = document.createElement('script');
    s.src = 'https://qt.gtimg.cn/q=' + tqCodes.join(',');
    s.charset = 'gbk';
    const timer = setTimeout(() => { s.remove(); reject(new Error('腾讯行情请求超时')); }, 10000);
    s.onload = () => {
      clearTimeout(timer);
      const result = {};
      tqCodes.forEach(code => {
        const raw = window['v_' + code];
        if (!raw) return;
        const pct = parseFloat(String(raw).split('~')[32]);
        if (!isNaN(pct)) {
          result[code.slice(2) + (code.slice(0, 2) === 'sz' ? '.SZ' : '.SH')] = pct;
        }
      });
      s.remove();
      resolve(result);
    };
    s.onerror = () => { clearTimeout(timer); s.remove(); reject(new Error('腾讯行情加载失败')); };
    document.head.appendChild(s);
  });
}

export async function fetchBiddingSnapshotToForm() {
  const point = biddingCurrentPoint();
  if (!point) {
    throw new Error('当前不在抓取时段（09:10-09:40 或 15:00 后），请直接手动填写');
  }

  const ladderData = await fuyaoApiGet('/api/a-share-index/constituents/ths-stock-list', { thscode: '883410.TI' });
  const ladderCodes = ((ladderData && ladderData.item) || []).map(it => it.thscode).filter(Boolean);

  const etfCodes = [], indexCodes = [];
  BIDDING_SECTOR_ETFS.forEach(e => {
    const c = biddingEtfToSnapshotCode(e.code);
    if (c.type === 'index') indexCodes.push(c.thscode); else etfCodes.push(c.thscode);
  });

  const top10Data = await fuyaoApiGet('/api/a-share-index/constituents/ths-stock-list', { thscode: '883901.TI' });
  const top10Codes = ((top10Data && top10Data.item) || []).map(it => it.thscode).filter(Boolean);

  const bigEtfCodes = BIDDING_BIG_ETFS.map(c => c + '.SH');

  const allStockCodes = Array.from(new Set([].concat(ladderCodes, top10Codes)));
  const stockPcts = {};
  for (let i = 0; i < allStockCodes.length; i += 40) {
    const chunk = allStockCodes.slice(i, i + 40);
    const snap = await fuyaoApiGet('/api/a-share/prices/snapshot', { thscodes: chunk.join(',') });
    ((snap && snap.item) || []).forEach(it => {
      if (it && it.thscode && it.price_change_ratio_pct !== null && it.price_change_ratio_pct !== undefined) {
        let ratio = Number(it.price_change_ratio_pct);
        const priceChange = it.price_change !== undefined && it.price_change !== null ? Number(it.price_change) : null;
        const curr = it.current_price !== undefined && it.current_price !== null ? Number(it.current_price) : null;
        const prev = it.prev_close !== undefined && it.prev_close !== null ? Number(it.prev_close) : null;
        const isActuallyDown = (priceChange !== null && priceChange < 0) || (curr !== null && prev !== null && curr < prev);
        if (isActuallyDown && ratio > 0) ratio = -ratio;
        stockPcts[it.thscode] = ratio;
      }
    });
  }

  const etfPcts = await biddingGetTencentPcts(Array.from(new Set([].concat(etfCodes, bigEtfCodes))));
  const indexPcts = {};
  const allIndexCodes = Array.from(new Set(indexCodes.concat(['000001.SH'])));
  if (allIndexCodes.length > 0) {
    const idxSnap = await fuyaoApiGet('/api/a-share-index/prices/snapshot', { thscodes: allIndexCodes.join(',') });
    ((idxSnap && idxSnap.item) || []).forEach(it => {
      if (it && it.thscode && it.price_change_ratio_pct !== null && it.price_change_ratio_pct !== undefined) {
        let ratio = Number(it.price_change_ratio_pct);
        const priceChange = it.price_change !== undefined && it.price_change !== null ? Number(it.price_change) : null;
        const curr = it.current_price !== undefined && it.current_price !== null ? Number(it.current_price) : null;
        const prev = it.prev_close !== undefined && it.prev_close !== null ? Number(it.prev_close) : null;
        const isActuallyDown = (priceChange !== null && priceChange < 0) || (curr !== null && prev !== null && curr < prev);
        if (isActuallyDown && ratio > 0) ratio = -ratio;
        indexPcts[it.thscode] = ratio;
      }
    });
  }

  const values = {};
  const ladderVals = ladderCodes.map(c => stockPcts[c]).filter(v => typeof v === 'number' && !isNaN(v));
  if (ladderVals.length > 0) {
    values['最近多板%'] = (ladderVals.reduce((a, b) => a + b, 0) / ladderVals.length).toFixed(2);
  }
  let sectorRed = 0;
  BIDDING_SECTOR_ETFS.forEach(e => {
    const c = biddingEtfToSnapshotCode(e.code);
    const v = c.type === 'index' ? indexPcts[c.thscode] : etfPcts[c.thscode];
    if (typeof v === 'number' && !isNaN(v) && v > 0) sectorRed++;
  });
  values['板块ETF'] = String(sectorRed);
  if (top10Codes.length > 0) {
    let top10Red = 0;
    top10Codes.forEach(c => { const v = stockPcts[c]; if (typeof v === 'number' && !isNaN(v) && v > 0) top10Red++; });
    values['昨日资金前十'] = String(top10Red);
  }
  const bigVals = bigEtfCodes.map(c => etfPcts[c]).filter(v => typeof v === 'number' && !isNaN(v));
  if (bigVals.length > 0) {
    values['大盘ETF'] = (bigVals.reduce((a, b) => a + b, 0) / bigVals.length).toFixed(2);
  }
  if (typeof indexPcts['000001.SH'] === 'number') {
    values['大盘（%）'] = indexPcts['000001.SH'].toFixed(2);
  }

  return { point, values };
}
