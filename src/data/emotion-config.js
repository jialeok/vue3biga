export const EMOTION_WORKER_BASE = 'https://bidding-board-worker.834696737hgl.workers.dev';

export const EMOTION_ROW_CONFIG = [
  { key: 'amountDiff', title: '昨日成交额环比差值', unit: '亿', hasTrend: true, field: 'amountDiff' },
  { key: 'onceLimit', title: '昨日一字板家数', unit: '家', hasTrend: true, field: 'onceLimit' },
  { key: 'highestLb', title: '昨日最高连板天数', unit: '天', hasTrend: true, field: 'highestLb' },
  { key: 'limitUp', title: '昨日涨停家数', unit: '家', hasTrend: true, field: 'limitUp' },
  { key: 'limitDown', title: '昨日跌停家数', unit: '家', hasTrend: true, field: 'limitDown' },
  { key: 'zhaban', title: '昨日炸板家数', unit: '家', hasTrend: true, field: 'zhaban', extraKey: 'zhabanRate', extraUnit: '%' }
];

let _emotionDataCache = null;

export function getEmotionDataCache() { return _emotionDataCache; }
export function setEmotionDataCache(val) { _emotionDataCache = val; }