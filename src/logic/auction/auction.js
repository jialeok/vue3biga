// §16 域拆分 barrel re-export —— auction 域已物理拆分为三簇子模块：
//   - ./auction-helpers.js  纯工具/辅助函数簇（repair/reconcile/patch/merge/dirty/backup/rollback/get/import + 域常量 + §P1-6 纯函数）
//   - ./auction-ths.js      同花顺(THS)相关簇（fetchLadderConstituentsMain / fetchDayVolumes / fill*FromThs / fetchChangePctFromThs / fillAuctionHistoryGap*FromThs）
//   - ./auction-numcat.js   猫抓/编号分类(numcat)相关簇（fill*FromNumcat / fetch*FromNumcat / fillTopicsFromNumcat / fetchMonitorWarningFromNumcat / fetchAuctionFromNumcat）
// 本文件仅做 barrel re-export，不持有任何业务逻辑，确保外部 import 路径零破坏（§16 零破坏约束）。
// 所有导出符号与拆分前逐一对应，函数体实现/参数/返回值均未改动。

export {
  repairAuctionInWatchlistForDate,
  reconcileAuctionWatchlistFromLocalStorage,
  reconcileAuctionWatchlist,
  _sanitizeAuctionPatch,
  _splitAuctionPatch,
  _mergeAuctionPatchLocal,
  patchAuctionField,
  patchAuctionFieldBatch,
  markAuctionDirty,
  clearAuctionDateData,
  deleteAuctionDateData,
  mergeAuctionDateRows,
  clearAllAuctionDates,
  backupAuctionData,
  rollbackAuctionData,
  getAuctionData,
  getTodayAuction,
  getTodayGroupList,
  importAuctionFromPaste,
  importAuctionHistoryFill,
  parseVolumeOnlyText,
  splitHistoryFillLine,
  AUCTION_WATCHLIST_FIELDS,
  AUCTION_METRICS_FIELDS,
  AUCTION_PATCHABLE_FIELDS,
  _auctionFirstClearDumped
} from './auction-helpers.js';

export {
  fetchLadderConstituentsMain,
  fetchDayVolumes,
  fillYesterdayVolumeFromThs,
  fillTodayYesterdayVolumeFromThs,
  _fillTodayYesterdayVolumeFromThsImpl,
  fillYesterdayYesterdayVolumeFromThs,
  _fillYesterdayYesterdayVolumeFromThsImpl,
  fetchChangePctFromThs,
  _fetchChangePctFromThsImpl,
  fillAuctionHistoryGapPctFromThs,
  fillAuctionHistoryGapYestVolumeFromThs
} from './auction-ths.js';

export {
  fillYesterdayAuctionFromNumcat,
  fetchTodayAuctionFromNumcat,
  fetchAllAuctionFromNumcat,
  fetchThreeDaysAuctionFromNumcat,
  fetchFiveDaysAuctionFromNumcat,
  fillTopicsFromNumcat,
  fetchMonitorWarningFromNumcat,
  fetchAuctionFromNumcat
} from './auction-numcat.js';
