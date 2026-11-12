// auction-share-read.js — 竞价占比的【取数】入口（Logic 层，读内存真相）
//
// ══════════════════════════════════════════════════════════════════════════════════════
// ★★ [SHARE-SPLIT 2026-11-13] 为什么从 auction-share.js 拆出来 ★★
// ══════════════════════════════════════════════════════════════════════════════════════
//   `auction-share.js` 里混着两类东西：
//     ① **纯口径**（占比公式 `computeAuctionShare` / 门槛 `auctionShareThresholdOf` / 展示精度）——
//        任何运行环境（浏览器 / Cloudflare Worker / 单测）都该能直接用；
//     ② **取数**（`getAuctionShare` / `getAuctionVolume`）—— 依赖 `data/watchlist-helpers.js`
//        这份【浏览器内存真相】。
//   只要②还在，任何 `import ... from 'auction-share.js'` 的纯逻辑模块就都被钉在浏览器上
//   ⇒ **第二十五条（总龙分歧）的判定无法在云端 Worker 里复用同一把尺子**（用户 2026-11-13
//   口径：「都是在云端运行，关电脑也能用，不要电脑本地的」）。
//
//   ⇒ 把②搬到这里，① 保持不动。调用方只有 `decision-collect.js` 一处，改导入即可（§11）。
//   ⛔ 公式仍然只有一份：本文件**不实现任何计算**，只把两个字段喂给
//      `auction-share.js#computeAuctionShare`（§6 单一实现，别在这里再写 v/y*100）。
//
// ── 口径（与早盘竞价第一页完全一致）────────────────────────────────────────────────
//   当日竞价量 = auction_watchlist 该行的 volume
//   昨日成交量 = 同一行的 yest_volume（云端）/ yestVolume（内存）
//   ⚠️ 两者在【同一行】里 ⇒ 不需要 getPreviousTradingDay（昨天是假期也无所谓，
//      yest_volume 由抓取端按「上一交易日」填好）。
//
// ── 红线 ────────────────────────────────────────────────────────────────────────────
//   §10：行不存在 / 缺量 / 缺昨量 / 昨量为 0 ⇒ null（未知），⛔ 绝不当 0 或「很小」。
//   §4/§32：只读内存，不发请求、不落库、不碰 DOM。

import { getStockHistoryValue } from '../../data/watchlist-helpers.js';
import { computeAuctionShare } from './auction-share.js';

/**
 * 取某只股票【展示日】的竞价占比（读内存真相，§6 与早盘竞价第一页的占比同源同公式）。
 *
 * @param {string} date 展示日 YYYY-MM-DD
 * @param {string} stockName
 * @returns {number|null} 占比（%，已取整到 1 位）；null = 缺数据 / 除不出来
 */
export function getAuctionShare(date, stockName) {
  const name = String(stockName || '').trim();
  if (!date || !name) return null;
  return computeAuctionShare(
    getStockHistoryValue(date, name, 'volume'),
    getStockHistoryValue(date, name, 'yestVolume')
  );
}

/**
 * 取某只股票【某日】的竞价量（原始数值）。
 *
 * 为什么要单独暴露它（§6 别在别处再读一遍 auction_watchlist）：
 *   「当日有没有参与竞价」= 退潮首日判据里【昨日停牌】那一条腿的判据 ——
 *   竞价量 0 / 取不到 ⇒ 那天它没有竞价（停牌；与 suspend.js 的『无竞价』同一语义）。
 *   而 getAuctionShare 在这两处都会返回 null（缺量 / 缺昨量除不出来），
 *   分不清「没竞价」与「昨量缺失」，所以必须把【量】本身单独取出来。
 *
 * §10：行不存在 / 空串 ⇒ null（= 未知），⛔ 绝不返回 0 去冒充「没竞价」；
 *   0 只可能来自行里真的写着 0（那才是「当日零竞价」这个事实）。
 *
 * @param {string} date 展示日 / 历史日 YYYY-MM-DD
 * @param {string} stockName
 * @returns {number|null} 竞价量（股/手，按库里的原值）；未知 ⇒ null
 */
export function getAuctionVolume(date, stockName) {
  const name = String(stockName || '').trim();
  if (!date || !name) return null;
  return getStockHistoryValue(date, name, 'volume');
}
