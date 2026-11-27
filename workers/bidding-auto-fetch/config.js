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
  // 说明：「近 10 个交易日区间涨幅」的窗口天数不在这里配置 ——
  // 直接复用 src/logic/auction/range-window.js 的 RANGE_WINDOW_DAYS（前后端单一真相），
  // 避免出现「前端窗口 10 天 / worker 窗口 5 天」的静默失配。见 logic/morning-workflow.js 步骤5。

  // fuyao snapshot 批量大小
  SNAPSHOT_BATCH_SIZE: 40,

  // fuyao historical 并发数（同时发起的请求数，避免被限流）
  HISTORICAL_CONCURRENCY: 10,

  // [BARS-BATCH-CLOUD 2026-11-20] 同花顺批量历史日线的单次代码上限（官方 10）。
  //   20/30 日涨幅补腿靠它把 33 只压到 4 次 subrequest（⛔ 逐只打会把 50 次配额顶爆）。
  HISTORICAL_BATCH_SIZE: 10,

  // [BARS-BATCH-CLOUD 2026-11-20] 补腿 / 补 30 日涨幅的单趟时间预算（毫秒）。
  //   9:26 那趟有「不超过 9:27」的硬指标 ⇒ 超预算就停手，把剩下的留给 9:27 / 16:03 幂等重跑。
  BARS_FILL_BUDGET_MS: 20000,
};