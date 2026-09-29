// ⚠️ [2026-09-29] 该 Cloudflare Worker（bidding-board-worker-a / -b）已下线，业务逻辑整体移植到
//    Supabase Edge Function（supabase/functions/bidding-a）—— worker 源码目录与 wrangler-a/b.toml
//    均已删除。但下面这个常量仍指向已停服的 workers.dev 域名，因此
//    EmotionBoard 的「刷新预测量能」按钮（POST /refresh-emotion）当前【必然失败】。
//    这是 a/b 下线的既然后果，不是前端 bug。修法二选一：
//      ① 在 bidding-a 里补一个 /refresh-emotion 路由，然后把这里改指向它；
//      ② 若该按钮已无用，连同 EmotionBoard.vue 的 refreshPredictVol 一并删除。
//    ⛔ 别以为它还是活的 —— 排查「刷新预测量能失败」时先看这里。
//    注意：本常量只服务这一个按钮；情绪看板的数据读取走 data/emotion-data.js（直连 Supabase 表）。
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