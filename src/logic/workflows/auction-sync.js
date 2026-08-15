// auction-sync.js — 云端拉取/推送调度（从 app-core.js 抽离）
// 物理拆分后的薄 barrel：原导出全部从子模块 re-export，保证零破坏。
// 逻辑实现已迁移至：
//   - auction-sync-pull.js   （云端拉取 pullFromCloud）
//   - auction-sync-push.js   （云端推送/导入/同步各函数）
//   - auction-sync-helpers.js（辅助函数 syncCloseChunk 与共享内存 _cloudBlobExtras）
// 仅做物理拆分，未改动任何同步逻辑实现。
export { pullFromCloud } from './auction-sync-pull.js';
export { pushToCloud, pushAuctionToCloud, pushAuctionDataToCloud, pushAuctionCodeToCloud, pushAuctionStatusForDate, syncAuctionListForDate, syncHotStocksListForDate, pushHotStocksDataToCloud } from './auction-sync-push.js';
export { syncCloseChunk } from './auction-sync-helpers.js';
