# 观察组 / 竞昨数口径警示说明（2026-08-17）

> **本文件是「易错点档案」，改代码前必读。** 这是本仓库反复踩坑、且造成过
> 用户可见数据错误的严重问题，务必在涉及以下任何逻辑时对照检查。

---

## 一、一句话结论

**「竞昨高光 / 平行 / 观察组」只允许统计「当日 9:25 拉取的正式名单（watchlist 成员）」
内的股票，绝不允许把 `market_metrics` 的影子行（numcat 抓到的数据、不在正式名单的股票）
混进计算。**

8/14 曾因把影子股算进竞昨，导致：
- 8/14 竞昨全集 = **21 只**（正确应为 **16 只**）
- 8/17 观察组错误继承 = **21 只**（正确应为 **16 只**）
- 竞昨数标 16 / 蓝色高光 18 / 观察组 21，三个数字互相打架

用户在 8/17 明确指出正确语义：**观察组 = 继承「昨日竞昨高光」全集，与当天 9:25
最新名单无关**；竞昨数 = 蓝色高光 = 观察组，三者必须一致。

---

## 二、数据流与"两批数据"的真相

早盘竞价看板的数据源头有两批，**只有 9:25 那批是正式名单**：

| 时点 | 谁拉 | 写入哪张表 | 是否正式名单 |
|---|---|---|---|
| **9:25（morning cron）** | bidding-auto-fetch worker | `auction_watchlist`（拉 883410.TI 成分股）+ `market_metrics`（numcat 竞价数据）| ✅ **正式名单源头** |
| **收盘后（close cron）** | bidding-auto-fetch worker | 只读当日 watchlist → 只补 `market_metrics.change_pct` | ❌ 不改名单 |

**关键坑**：`_auctionMemCache[date]` 是 `auction_watchlist` + `market_metrics` 的**合并缓存**，
包含不在正式名单的「影子行」（numcat 抓到的数据、非 watchlist 成员）。
竞昨 / 平行 / 高光计算如果直接遍历这个合并缓存，**影子行会被误算** → 全集被撑大。

### 正确的身份判定

```js
// 正式成员身份唯一真相 = _getAuctionWatchlistSet(date)
// （§6：auction_watchlist 表天然只有正式成员；obsAutoAdded 观察组壳不计入）
const formalSet = _getAuctionWatchlistSet(dateStr);
```

### 正确的口径（三者必须一致）

- **竞昨全集** = 正式名单内 平行 + diff>0 的股票（`getJingYestHighlightSetForDate`）
- **观察组** = 继承「昨日竞昨全集」（与当天名单无关）
- **竞昨数标 = 蓝色高光** = 渲染列表 ∩ 当日竞昨全集

---

## 三、已修复的位置（2026-08-17，commit 6c6d5d2）

| 文件 | 修复 |
|---|---|
| `src/logic/auction/sort-rules.js` | `getParallelStocksForDate` / `getRatioDiffInfoForDate` 遍历时跳过不在 `_getAuctionWatchlistSet(dateStr)` 的影子行 |
| `src/logic/auction/view-helpers.js` | 观察组继承源 = 昨日竞昨全集直接继承（源头已干净，无需二次过滤）|
| `src/logic/tagTitles/rules.js` | `ensureObservationStocks` 同口径（防未来日期 / 空列表日再注入全集）|

---

## 四、⚠️ 下次改代码前必须检查的清单

1. **任何遍历 `_auctionMemCache[date]` / `getGroupData(date)` 的统计函数**（竞昨、平行、
   高放量、观察组、排序、题材分组），必须判断该股票是否在 `_getAuctionWatchlistSet(date)`
   正式名单内——**影子行永远不参与这些计算**。

2. **`getJingYestHighlightSetForDate` 是全局唯一竞昨高光真相**：观察组继承、竞昨数标、
   蓝色高光、排序 tier0 都必须调用它，禁止各自另算一套（否则数字必打架）。

3. **观察组语义 = 继承昨日竞昨全集**，与当天 9:25 名单、当天是否已抓取、前一日注入壳
   都无关。不要因为"某股不在当天名单"就把它从观察组里过滤掉（那是壳的职责）。

4. **新增统计口径时，先问**：这个数字和「竞昨数 / 蓝色高光 / 观察组」对齐吗？
   对齐不了就是口径错了，不是数据错了。

5. **历史日期同样适用**：竞昨计算对历史日期也要用该日期的正式索引
   （`_auctionWatchlistIndex` 由 `pullAuctionFromTable` 全量建立），不要假设"只有当天有索引"。

---

## 五、验证方法（防止回归）

本地按前端计算逻辑模拟（拉 Supabase `auction_watchlist` + `market_metrics` 合并，
竞昨只遍历正式名单）：

- 8/12 竞昨 = 14 只
- 8/14 竞昨 = 16 只
- 8/17 观察组 = 8/14 竞昨全集 = 16 只
- 竞昨数 = 蓝色高光 = 观察组 = 16（三者一致）

**任何改动后，跑一遍这个验证；数字对不上就是回归了。**
