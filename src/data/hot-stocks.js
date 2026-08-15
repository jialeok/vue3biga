// ============================================================
// ⚠️ 已弃用但保留（共享数据层）：本文件的 UI 渲染函数（renderHotStocks 等）已随
//    早盘竞价重构于 2026-08-15 从 app-core.js 删除（纯死代码，Vue3 UI 无入口）。
//    但本文件作为「热门股票共享数据层」必须保留：loadHotStocksFromCloud /
//    pullHotStocksHighlights / loadHotTrendsFromCloud / Realtime 订阅 / pushHotTrendsToCloud
//    等支撑「竞价看板第二页题材 + 题材星标签统计看板」的影子记录，删之会让题材统计变空。
//    详见 MIGRATION_TASKLIST.md 第十四章。请勿删除本文件或其加载/订阅/推送逻辑。
// ============================================================
// hot_stocks / hot_stocks_highlights 表操作（热门股票分组，结构与早盘竞价对应函数一致）
// 通过 dataSource='hot' 复用同一套算法函数，此处仅提供数据加载/订阅/推送
// ============================================================
// [任务 #186] 物理拆分（保守，零破坏）：
//   原 929 行按职责拆到子模块，本体仅作 barrel re-export，全部原导出符号与
//   模块级副作用（state.HOT_MERGE_FIELDS / state._hotAuctionRealtimeTimer 等）
//   由各子模块在本文件被 import 时一并执行，对外接口完全不变。
//   - hot-stocks-cloud.js      → 云读取/云写入（含受保护：loadHotStocksFromCloud /
//     pullHotStocksHighlights / loadHotTrendsFromCloud / pushHotTrendsToCloud）
//   - hot-stocks-realtime.js   → Realtime 订阅 + 统一防抖池（含受保护：startHotStocksRealtime /
//     startHotHighlightsRealtime / startHotTrendsRealtime）
//   - hot-stocks-migrate.js    → 三次一次性迁移
// ============================================================

export * from './hot-stocks-cloud.js';
export * from './hot-stocks-realtime.js';
export * from './hot-stocks-migrate.js';
