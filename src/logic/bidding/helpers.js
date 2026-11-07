import { autoCalculateRecentMultiScore } from '../tagTitles/helpers.js';
import { getKxianTypeByClose } from '../jiwang/helpers.js';
import { getNextTradingDay } from '../date/trading-day-helpers.js';
import { getBiddingData, getJiwangData, getStocksData } from '../../data/supabase-client.js';
import { getEtfBoardData, saveEtfBoardRow } from '../../data/etf-board-data.js';
import { saveData, markJiwangDirty } from '../app-core-api.js';
import { pushJiwangNow } from '../../data/jiwang-data.js';
import { fuyaoApiGet } from '../../data/api/fuyao-proxy.js';
import { _emit } from '../../stores/eventBus.js';
import { _dbgLog } from '../../data/debug-log.js';
import { useUiStore } from '../../stores/uiStore.js';
// [BIDDING-CLOSE-CLOUD 2026-11-07] 快照取值口径改走共享纯模块：
//   Cloudflare Worker 16:00 轮用同一份常量/算法把「收盘」列幂等写进 bidding_data，
//   不再依赖人工点保存。⛔ 不要在 helpers.js 里再留一份私有常量（§6 单一真相）。
import {
  LADDER_THSCODE,
  TOP10_THSCODE,
  BIDDING_BIG_ETFS,
  biddingSnapshotCodeGroups,
  normalizeFuyaoSnapshotPct,
  computeBiddingCloseValues
} from './snapshot-spec.js';

export { autoCalculateRecentMultiScore };

// [ACC-PREMIUM] 账户溢价收盘 ↔ 圆形统计今日盈亏 双向同步镜像：
// 把 stats.profit 镜像回 bidding_data 的「账号溢价」行 close（保持持久化一致；
// 展示侧已改为直接读 stats.profit，本镜像仅为诊断/遗留读取一致性）。
export function syncProfitToBiddingCloseMirror(date, profit) {
  if (!date) return;
  const biddingData = getBiddingData();
  if (!biddingData[date]) biddingData[date] = [];
  let row = biddingData[date].find(r => r && r.name === '账号溢价');
  if (!row) {
    row = { name: '账号溢价' };
    biddingData[date].push(row);
  }
  row.close = (profit === '' || profit === undefined || profit === null) ? '' : String(profit);
  saveData();
}

export async function syncSectorEtfZhangNum(zhangNum) {
  zhangNum = parseInt(zhangNum) || 0;
  const uiStore = useUiStore();
  const currentDate = uiStore.currentDate;

  const etfData = getEtfBoardData();
  let todayEtf = etfData[currentDate];

  if (!todayEtf || todayEtf.length === 0) {
    todayEtf = [{ shuliang: '48', dieZhangbi: '', jingtu: '', tushi: '' }];
  }

  const firstEtf = todayEtf[0];
  if (!firstEtf.shuliang) firstEtf.shuliang = '48';
  const total = parseInt(firstEtf.shuliang) || 48;
  const dieValue = total - zhangNum;
  firstEtf.dieZhangbi = dieValue + ':' + zhangNum;
  // §6 收敛：板块ETF 唯一真相源 = early_etf_data；写入该行（按 date upsert），不再写空表 auction_etf。
  const res = await saveEtfBoardRow({
    date: currentDate,
    shuliang: firstEtf.shuliang,
    die_zhangbi: firstEtf.dieZhangbi,
    jingtu: firstEtf.jingtu || '',
    tushi: firstEtf.tushi || ''
  });
  if (!res.ok) console.error('[SECTOR-ETF] 上云失败：', res.error && res.error.message);

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


// [BIDDING-CLOSE-CLOUD 2026-11-07] 48 个板块ETF / 4 个宽基ETF / 指数映射 /
// biddingEtfToSnapshotCode 已迁到 ./snapshot-spec.js（前端与 Worker 共用），本文件不再保留副本。

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
  // [A2-03] 改为标准 fetch + 正则解析，移除 document.createElement('script') 注入与
  // window['v_'+code] 全局读写（§16 纯 Vue3 红线：禁止向 DOM/业务全局挂数据）。
  // 解析方式对齐 Supabase Edge Function 侧的腾讯行情实现
  // （supabase/functions/bidding-a/index.ts 的 _tencentFetchOnce，与原 Cloudflare worker-a 的
  //   data/tencent-api.js 同源）。⚠️ Cloudflare worker-a 已于 2026-09-29 下线删除，该实现现只在 Supabase 侧维护。
  return new Promise((resolve, reject) => {
    const tqCodes = thscodes.map(c => {
      const num = c.split('.')[0];
      return (c.slice(-2) === 'SZ' ? 'sz' : 'sh') + num;
    });
    const url = 'https://qt.gtimg.cn/q=' + tqCodes.join(',');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    fetch(url, { signal: controller.signal })
      .then(resp => {
        if (!resp.ok) throw new Error('腾讯行情请求失败：HTTP ' + resp.status);
        return resp.text();
      })
      .then(text => {
        const result = {};
        // 从返回文本中提取 v_<code> 赋值内容（不再依赖全局 window['v_'+code]），按 ~ 分隔取第 33 字段（涨幅%）
        const re = /v_([a-z]{2}\d{6})="([^"]*)"/g;
        let m;
        while ((m = re.exec(text)) !== null) {
          const pct = parseFloat(m[2].split('~')[32]);
          if (!isNaN(pct)) {
            const num = m[1].slice(2);
            result[num + (m[1].slice(0, 2) === 'sz' ? '.SZ' : '.SH')] = pct;
          }
        }
        resolve(result);
      })
      .catch(e => {
        if (e && e.name === 'AbortError') reject(new Error('腾讯行情请求超时'));
        else reject(new Error('腾讯行情加载失败: ' + (e && e.message || e)));
      })
      .finally(() => clearTimeout(timer));
  });
}

export async function fetchBiddingSnapshotToForm() {
  const point = biddingCurrentPoint();
  if (!point) {
    throw new Error('当前不在抓取时段（09:10-09:40 或 15:00 后），请直接手动填写');
  }

  const ladderData = await fuyaoApiGet('/api/a-share-index/constituents/ths-stock-list', { thscode: LADDER_THSCODE });
  const ladderCodes = ((ladderData && ladderData.item) || []).map(it => it.thscode).filter(Boolean);

  const { etfCodes, allIndexCodes } = biddingSnapshotCodeGroups();

  const top10Data = await fuyaoApiGet('/api/a-share-index/constituents/ths-stock-list', { thscode: TOP10_THSCODE });
  const top10Codes = ((top10Data && top10Data.item) || []).map(it => it.thscode).filter(Boolean);

  const bigEtfCodes = BIDDING_BIG_ETFS.map(c => c + '.SH');

  const allStockCodes = Array.from(new Set([].concat(ladderCodes, top10Codes)));
  const stockPcts = {};
  for (let i = 0; i < allStockCodes.length; i += 40) {
    const chunk = allStockCodes.slice(i, i + 40);
    const snap = await fuyaoApiGet('/api/a-share/prices/snapshot', { thscodes: chunk.join(',') });
    ((snap && snap.item) || []).forEach(it => {
      if (!it || !it.thscode) return;
      const ratio = normalizeFuyaoSnapshotPct(it);
      if (ratio !== null) stockPcts[it.thscode] = ratio;
    });
  }

  const etfPcts = await biddingGetTencentPcts(Array.from(new Set([].concat(etfCodes, bigEtfCodes))));
  const indexPcts = {};
  if (allIndexCodes.length > 0) {
    const idxSnap = await fuyaoApiGet('/api/a-share-index/prices/snapshot', { thscodes: allIndexCodes.join(',') });
    ((idxSnap && idxSnap.item) || []).forEach(it => {
      if (!it || !it.thscode) return;
      const ratio = normalizeFuyaoSnapshotPct(it);
      if (ratio !== null) indexPcts[it.thscode] = ratio;
    });
  }

  // [BIDDING-CLOSE-CLOUD 2026-11-07] 计算口径与 Worker 16:00 轮共用同一份纯函数。
  // 注意：这里仍然【只填表单】，落库由 save()；云端 Worker 会另行幂等填空，两条路不冲突
  // （云端绝不覆盖已有非空值，人工修正永远优先）。
  const values = computeBiddingCloseValues({ ladderCodes, top10Codes, stockPcts, etfPcts, indexPcts });

  return { point, values };
}
