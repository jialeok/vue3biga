// config.js — bidding-auto-fetch 配置
export const CONFIG = {
  SUPABASE_URL: 'https://tonqfgeyxnnwicjopshn.supabase.co',
  FUYAO_PROXY_BASE: 'https://tonqfgeyxnnwicjopshn.supabase.co/functions/v1/fuyao-proxy',

  // fuyao 直连（历史K线用新账号 key，避免拖慢主账号）
  FUYAO_DIRECT_BASE: 'https://fuyao.aicubes.cn',

  // 最近多板指数
  LADDER_THSCODE: '883410.TI',

  // numcat daily_auc 接口
  NUMCAT_DAILY_AUC_URL: 'https://numcat.net/api/reference-proxy/stock/daily_auc',
  // numcat daily 接口（收盘涨幅 pct_chg）
  NUMCAT_DAILY_URL: 'https://numcat.net/api/reference-proxy/stock/daily',
  NUMCAT_RECENT_DAYS: 5,

  // fuyao snapshot 批量大小
  SNAPSHOT_BATCH_SIZE: 40,

  // fuyao historical 并发数（同时发起的请求数，避免被限流）
  HISTORICAL_CONCURRENCY: 10,
};