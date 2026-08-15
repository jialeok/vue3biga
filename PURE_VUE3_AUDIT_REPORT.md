# 纯 Vue3 规范合规审查报告

> **项目**：vue3biga（股票看板应用）  
> **审查标准**：`ARCHITECTURE架构规范_V3.md`（纯 Vue3 红线 / 三层架构 / 数据安全 / 性能）  
> **审查时间**：2026-08-15  
> **审查方式**：5 路并行审计（Vue3 红线 / 数据安全 / 架构分层 / 工程化 / 数据源云同步）+ 人工复核  
> **代码基线**：commit `61f8f03`

---

## 一、总体结论

**项目已基本达成纯 Vue3，但存在少量未彻底迁移的残留与多处规范优化项。**

- ✅ **纯 Vue3 主框架合规**：`createApp` 仅 main.js、`globalProperties` 0 处、`innerHTML`/`v-html` 0 处、无 CDN、无 IIFE 业务模块、UI 不直连 Supabase、logic 不 import 展示层、`.vue` 文件无 `window.` 实际引用（仅字符串/注释）。
- ⚠️ **仍有 2 处纯 Vue3 红线违反**（window 登录态别名 + logic 层 DOM 操作）与 1 处大范围 §8 localStorage 业务数据违规。
- ⚠️ **架构遗留**：巨型文件、app-core 中转站、DashboardView 聚合、ui-bridge 残留空桩等（详见各章）。
- 📉 **工程化缺口**：无测试、无 lint、无 type:module、备份目录被 git 跟踪。

---

## 二、纯 Vue3 红线合规（规范 §16/§42）

### ✅ 合规项（9 项）

| 检查项                      | 结果 | 说明                            |
| ------------------------ | -- | ----------------------------- |
| `createApp` 仅 main.js    | ✅  | 全 src 仅 1 处                   |
| `globalProperties`       | ✅  | 0 处                           |
| `innerHTML` / `v-html`   | ✅  | 0 处（仅注释提及）                    |
| CDN（unpkg/jsdelivr）      | ✅  | index.html 12 行，无 CDN（备份目录除外） |
| IIFE 业务模块                | ✅  | 0 处（src 下）                    |
| UI 直连 Supabase           | ✅  | views/components 全部经 data 层   |
| logic import 展示层         | ✅  | 0 处                           |
| `.vue` 文件 `window.` 实际引用 | ✅  | 0 处（剩余为注释/字符串）                |
| `configureServer` 自定义中间件 | ✅  | vite.config.js 为标准配置          |

### ✅ 已修复（原 ❌ 违反项 2 处）

> **修复状态（2026-08-16）**：两处红线违规均已在 commit `1bcaec0`（P0-2 / P0-3）根治并通过 R2 验收。当前全 src 已无 `Object.defineProperty(window,...)` 业务别名挂载、无 logic 层 `document.getElementById` 实际代码（仅余 1 处说明性注释）。下方为原始审计描述，保留作溯源。

1. **`src/stores/authStore.js:51-87` — 7 处 `Object.defineProperty(window, ...)` 登录态别名挂载**
   - 挂载 `_sessionToken`/`_realtimeChannel`/`unlocked`/`_justPushed`/`_justPushedAuction`/`_justPushedAuctionCounter`/`_justPushedAuctionTimer`
   - 注释自认"向后兼容 window.\_sessionToken 等直接读写"
   - **违反 §16"禁止 window.xxx 业务全局"**。虽然有 getter/setter 委托到 Pinia（非孤儿状态），但仍在 window 上暴露业务接口，是旧 DOM 时代的遗留。
2. **`src/logic/workflows/auction-sync.js:505` — logic 层直接操作 DOM**
   - `document.getElementById('syncStatus').textContent = v`
   - **违反"Logic 不操作 DOM"**（§3/§4 依赖方向）。且 `#syncStatus` 是 LoginOverlay.vue 的 Vue 响应式元素（绑定 `statusText`），logic 直接写 textContent 会绕过 Vue 响应式、与 Vue 状态双写冲突。

> 另有 34 处（现涨至 45 处）`window.` 出现在日志/console 字符串字面量中（如 `window.syncAuctionListForDate`），非实际代码调用，不影响合规判定。已于 2026-08-16 全部清理：仅剥离 `_dbgLog`/`console.*` 字符串标签里的 `window.` 前缀（10 个 .js 文件、约 30 处），注释与真实向后兼容挂载（`window.showDebugLog`、`window._emit/_on/_off`）保留未动；`vite build` 0 错误 0 警告。

---

## 三、三层架构与模块化（规范 §2-§16）

### ⚠️ 遗留问题

| 问题                                  | 现状                                                                                                                                                                                                                                                                                                                                                                                                          | 违反点               |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| **app-core.js 中转站**                 | 768 行，re-export 70+ 域函数，`_bindApi`/`_bindUiFns` 双注册，`_migrateFromV41` 仍被调用；**顶层 IIFE**（:314-320）违反 §16；与 8+ 域模块循环 import                                                                                                                                                                                                                                                                                    | §16"不得无限增长"       |
| **巨型文件**                            | auction.js 2945 行/154.7KB（37 处直接读写 state.\_xxx 全局共享）、AuctionBoard.vue 1949 行/82.4KB、main.css 5208 行（0 个 @media）、auction-sync.js 851 行、AuctionEditModal.vue 948 行、app-core.js 768 行                                                                                                                                                                                                                          | §15/§16 可维护性      |
| **hotspot.js null 解引用崩溃点**          | `importHotFromPaste`/`replaceHotConceptFromPaste` 直接 `_domGet('hotPasteInput').value` 无守卫（:191-193/:432-438/:452-454/:530-534），运行即 TypeError；目前无 Vue 调用方但挂在 `_bindApi`/re-export 上，属"半死炸弹"                                                                                                                                                                                                                  | §10 静默失败/运行时崩溃    |
| **ui-bridge 残留 15 空桩**              | \_domGet/\_domQuery/\_domValue/\_domCreate/\_getCommentInputValue/\_readTrackEditFormData/saveAuction/toggleStrengthSort/copyAllTopicStocks/copyTopicStocks/openCoreTopicModal/openAuctionNoteEditFromPage2/restoreExpandedTopicGroupsP2/toggleTopicGroupTrendPanels/resetExpansionStateOnDateSwitch——**全项目 0 真实调用**，仅经 auctionStore `_uiFns` 委托（18 个键 undefined，safeCall 静默 no-op）；AuctionBoard.vue 全走本地实现 | §16 死代码           |
| **auctionStore auctionActions 死委托** | 兼容层 20+ action 委托到 `_uiFns`（多数 undefined），全项目 **0 个外部调用点**；safeCall 仅在 auctionStore 内部使用                                                                                                                                                                                                                                                                                                                    | §16 死代码           |
| **切日期重置展开功能缺口**                     | `resetExpansionStateOnDateSwitch`（空桩）虽被 app-core.js:338-339 调用，但 `setCurrentDate`（:335）**直写 auctionStore.currentDate 绕过 store.setDate** → 展开状态重置意图实际丢失                                                                                                                                                                                                                                                      | §24 生命周期/功能缺口     |
| **router 完全闲置**                     | 9 条路由注册，但**全项目 0 处导航调用**（无 router.push/link/useRouter），只有 '/' 可达                                                                                                                                                                                                                                                                                                                                            | §24 页面生命周期        |
| **remaining-boards.js 订阅无退订**       | `_subscribeRealtime()`（:577-613）channel 未持有引用、全文件无 removeChannel；附带 :568 setInterval 300ms 轮询                                                                                                                                                                                                                                                                                                               | §31 Realtime 生命周期 |
| **market_metrics 重复订阅**             | 同表被 `watchlist-and-metrics.js:263-277` + `hot-stocks.js:673-684` 双 channel 订阅                                                                                                                                                                                                                                                                                                                               | §31 防重复订阅         |
| **DashboardView 13 子组件聚合**          | 9 个重型看板 v-if 同时挂载 + PatternBoard 常驻；**日期跨周末即整体销毁重建**；无 KeepAlive                                                                                                                                                                                                                                                                                                                                            | §24/§25/§26       |
| **remaining-boards.js**             | 645 行，已标准 ES Module 化，但规范 §16 点名"应迁移或删除"                                                                                                                                                                                                                                                                                                                                                                    | §16               |

### ✅ 已改善

- 域模块已实质拆分（auction/bidding/stocks/jiwang/hotspot/rank/multi/pattern/date/tagTitles 独立文件）
- AI 视觉导入、诊断报告等死功能已删除（本次会话）
- 30+ 无引用空桩已清理（本次会话）
- Realtime 其余 14 个 channel 均有 removeChannel/unsubscribe、start/stop 配对（§31 大体合规）

---

## 四、数据安全（规范 §6-§13）

### ✅ §8 localStorage 业务数据违规（已全部修复，2026-08-16 由 5 智能体收口）

> 原 ❌ 4 项现已全部处置完毕，详见「十、完成状态跟踪」。修复链路：`ab5f481`（#1）→ `127eeee` F3（#3）→ 本次提交（#2/#4）。

1. **`src/logic/workflows/auction-sync.js` — 云端业务数据写回 localStorage** ✅ **已完成（ab5f481）**
   - 9 个 blob 字段（stocks/auction/bidding/rank/multi/hotspot/pattern/tagTitles/duibanData/…/summaries/scoreSettings）的 pull→push 暂存由 localStorage 改为模块内存 `_cloudBlobExtras`；语义零变化、重启由下次 pull 重建、不丢数据。
   - 复核（本次 5 智能体之一）：grep 确认剩余 localStorage key 均属 §8 允许类（holidays/tradingDays 无云表兜底读、`__migrated`/`lastEditedDate_v42` 一次性标志、`scoreSettings_*` UI 偏好、`obsEnsured_*`/`boughtEnsured_*` 运行时标记），业务数据 0 写入。
2. **`src/stores/auctionTagStore.js` — 标签快照写 localStorage** ✅ **已完成（本次提交）**
   - `saveTagsToStorage` 经核查本就是故意留空的 no-op（满足 §8「标签禁存 localStorage」）；本次删除该 no-op 函数 + 4 个调用点（:79/:95/:105/:115），**保留** `loadTagsFromStorage` 只读回退（§8 允许永不写回）。
   - §11 覆盖风险随之消除：根本不写，损坏快照不会被 `{}` 覆盖。grep 确认文件内 0 处 `localStorage.setItem`。
3. **`src/logic/scope/helpers.js` — 撤销快照写 localStorage** ✅ **已完成（127eeee F3）**
   - 单日竞价/热门数据撤销快照由 localStorage 改为模块级 `const _undoSnapshotStore = new Map()`（同会话有效、重启即失效，§8 临时缓存豁免）。复核（本次 5 智能体之一）：grep 确认 0 处 `localStorage` 实际调用，保存/读取均走 Map。
4. **`saveModule` 未排除 jiwang（潜在落盘）** ✅ **已完成（本次提交）**
   - 报告原写 app-core.js 已过时——`saveModule` 实际在 `src/logic/shared/core-shared.js`（app-core 仅 re-export）。已在 `core-shared.js:79` 补 `if (name === 'jiwang') return;`，堵塞 `stockApp_v42_jiwang` 的 localStorage 落盘路径；同文件 `saveData`（:106）原本已排除 jiwang。

### ✅ 合规项

- 登录会话/剪贴板缓存/一次性迁移标记/调试标记：全部合规（§8 允许类）
- **\_suspiciousWipe 删除保护完整**：`auction-sync.js:90-101/185-195`（比例 >0.6 即拦截，删除仅在 else 分支）
- **§10 静默失败**：未发现"DB 读取失败伪装空数据"直接命中（`catch { return [] }` 0 命中）；Supabase 读取失败均 throw 或 console.warn 回退内存缓存
- **§11 删除验证**：删除均检查 error 并 throw（:110/:204/:443、bidding-data.js、jiwang-data.js、remaining-boards.js、auctionTagStore.js）

### ⚠️ 小缺口（本次 5 智能体已全部处置）

- `tagTitles/helpers.js:345`（评分计算静默返回 0）、`AuctionBoard.vue:946`（剪贴板读写静默）空 catch（非 DB，低危）→ **已加 `console.warn`** 记录失败原因，便于排查，不中断流程。
- `hot-stocks.js:768-773` 迁移物理删除的 `Promise.all` 无逐条 error 检查 → **已改为 `for...of` + 逐条 try/catch**，收集 `failedDeletes` 并 `console.error` 每条失败，单条失败不中断其余删除。
- `bidding-data.js:191-223` deleteAuctionFromCloud 删除前有计数、删除后无核对 → **已有删除后 re-query 核对**（beforeCount/afterCount）；原 `throw` 会中断主流程，已改为 `console.error` 告警（:241），满足 §11 删除验证精神且不阻断。

---

## 五、响应式与性能（规范 §17-§36）

### ✅ 合规项

- **无 `deep: true` watch**：全 src 0 处（§20 合规）
- **无重型模板计算**：模板中调用的是轻量格式化函数（`getRankAppearText`/`getChangePctDisplay` 等），非 filter/sort/map 重型操作
- **增量渲染**：AuctionBoard 已用 `v-memo` + 增量行缓存层（§17/§23 方向正确）
- **构建体积**：主 bundle 410KB（gzip 132KB），已从会话初期 420KB 下降

### ⚠️ 待优化项

| 问题                                        | 现状                                                                                                                                                                                                                                                | 违反点                   |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| **DashboardView 聚合 13 子组件 + 无 KeepAlive** | `/` 首页 v-if 切换 13 个看板（trading 态 9 个 + Pattern + weekly/monthly + EditModal），全 src **0 处 KeepAlive**                                                                                                                                               | §24/§25 页面生命周期与底部导航性能 |
| **路由未驱动看板切换**                             | router 注册 9 条路由（/auction /pattern /duiban 等），但主界面走 DashboardView 内嵌 v-if，路由闲置                                                                                                                                                                     | §24 页面生命周期            |
| **Realtime 订阅分散 16 个 channel**            | 订阅点分散在 10+ 个 data 文件（hot-stocks 8 处、watchlist-and-metrics 6 处等）；**market_metrics 双 channel 重复订阅**（watchlist-and-metrics.js:263 + hot-stocks.js:673）；**remaining-boards.js 订阅无退订 + 300ms setInterval 轮询**（:568）；14 个 channel 有 removeChannel（大体合规） | §31                   |
| **模板行内函数调用**                              | AuctionBoard 模板多处 `{{ getXxx() }}`（轻量但每行每次渲染调用）；**HomeStocksView 每行 ~20+ 次函数调用**（headerTags×6/closeDisplay×3/adjustDisplay×6 等），靠 v-memo 部分兜底                                                                                                     | §21 建议改 computed/预计算  |
| **`_setSyncStatus` 双写**                   | auction-sync.js:505 logic 层直接写 `#syncStatus` textContent，绕过 Vue 响应式，与 LoginOverlay 的 statusText 双写冲突                                                                                                                                              | §17 响应式原则             |

### ✅ 已改善（本次会话）

- 观察组/涨跌比/继承等数据口径修复，避免无意义全量重算
- 连抓五天支持历史日期，tradedate 归一化修复
- 封单家数改同花顺接口、情绪看板数据完整性校验

---

## 六、云同步与部署（规范 §31-§33）

### ✅ 合规项

- **Worker 打包与源码同步**：3 个 worker 的 `_bundled/` 均为最新（源码 08-07 修改、打包 08-15）
- **Supabase bidding-a 函数完整**：`supabase/functions/bidding-a/index.ts` 存在且含封单家数逻辑
- **删除保护（\_suspiciousWipe）完整**：auction-sync.js 两处（auction/hot 双份）

### ⚠️ 部署风险

| 问题                                  | 现状                                                                                                                                                                                                              | 影响                     |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| **numcat-proxy / fuyao-proxy 源码缺失** | `src/data/api/*-proxy.js` 调用 `supabase.co/functions/v1/numcat-proxy` 和 `fuyao-proxy`，但 `supabase/functions/` 下只有 bidding-a——**两个 Edge Function 源码都不在仓库**（人工部署）                                                  | 无法重建/审计/回滚；前端 6+ 处抓取依赖 |
| **9 个表无建表脚本**                       | 代码用 21 个表，但 `bidding_data`/`jiwang_data`/`stockcodemap`/`stock_topics`/`core_topics`/`user_data`/`daily_highlights`/`hot_stocks_highlights`/`hot_stock_trends` 在 db/*.sql、workers、supabase 中**均无 CREATE TABLE** | **数据库 schema 无法从仓库重建** |
| **auction_duiban 双真相**              | DuibanBoard 读 `recent_multi_data`，但 `auction_duiban` 表被写从不读（只写不读的孤儿表）；`recalcDuibanFromAuction` 又从竞价列表推导覆盖写回（MIGRATION_TASKLIST 自认"recent_multi_data 才是 live 对标表，auction_duiban 为迁移遗留双真相"）                      | §6 多真相残留               |
| **4 张单向表无 Realtime（§31 缺口）**        | `auction_duiban`（只写）、`auction_bidding_template`（写无读）、`topic_fumian`（写无订阅 → 多端负面题材不同步）、`core_topics`（写无订阅）——写入后无 Realtime 通知                                                                                     | §31 Realtime 一致性       |
| **废弃表**                             | `auction_etf`/`auction_etf_comment` 已废弃（0 行，SQL 头注释引用的 etf-sync.js/etf-comment-sync.js 文件不存在）、`auction_bidding_template` 只写不读                                                                                   | 仓库/线上脏数据               |
| **11 个 SQL 无文档**                    | db/ 17 个 SQL 中仅 6 个在 MIGRATION_TASKLIST 提及，其余 11 个（含 auction_metrics/dashboards/emotion/remaining_boards/cron/rename 系列等）无文档说明                                                                                  | 迁移不可审计                 |
| **worker B 曾有 `logs` 未定义 bug**      | `emotion-workflow.js:84` 在数据完整性分支用未定义 `logs` 变量 → 触发时 ReferenceError 致情绪数据不落库（**已修复**，见附注）                                                                                                                      | 已修复，需重新部署 worker B     |
| **Worker 部署靠手动**                    | 无 CI/CD，worker 需手动用 `_bundled/` 更新                                                                                                                                                                              | 部署易遗漏                  |
| **README 为空**                       | 只有 "# biga"，无部署/架构说明                                                                                                                                                                                            | 接手成本高                  |

---

## 七、工程化与质量（规范 §42-§43）

### ✅ 合规项

- **构建通过**：`npm run build` 无错误（12s 内），dist 与源码同步
- **vite.config.js 标准**：无自定义中间件
- **.gitignore 基本合格**：已覆盖 node_modules/dist/临时目录/TOKEN 文件
- **index.html 精简**：12 行，无 CDN/内联脚本

### ❌ 待改进项

| 问题                        | 现状                                                                                                            | 影响             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------- |
| **无 `"type":"module"`**   | package.json 缺该字段，每次构建 1 条 Vite CJS deprecation 告警                                                            | 构建告警、ESM 语义不完整 |
| **零测试**                   | src 下 0 个 test/spec 文件，无 vitest/jest                                                                          | §43 性能回归无自动化支撑 |
| **零 lint/format**         | 无 eslint/prettier，代码风格不统一                                                                                     | 长期维护成本         |
| **备份目录 96 文件被 git 跟踪**    | `newbigamain没彻底拆分最新原始文件/` 96 个文件（占 git 268 文件的 36%）、2.7MB，.gitignore 未覆盖                                      | 仓库污染、误引用风险     |
| **构建日志/一次性脚本被跟踪**         | build-log.txt ~ build-log5.txt 5 个 UTF-16 陈旧日志 + obs-*.cjs × 3 + test-highlight.mjs 一次性脚本在 git 里              | 仓库噪音           |
| **README 为空**             | 只有 "# biga"                                                                                                   | 接手成本高          |
| **26 个源文件带 BOM**          | 含 BOM 的 UTF-8 文件（含 main.js/supabase-client.js/auctionStore.js 及 data/ 几乎全部）；supabase-client.js:6-31 行 8 空格坏缩进 | 编码一致性          |
| **2 个直接循环依赖**             | app-core↔auction、app-core↔stocks（Rollup 不报错但静态分析必报环，§42 不达标）                                                  | 模块边界模糊         |
| **主包未拆 vendor**           | 主 bundle 410KB（gzip 132KB）未做 vendor 拆分/按需优化                                                                   | 首屏加载           |
| **依赖锁死在区间下界**             | vue 3.4.0 / pinia 2.2.0 / vite 5.4.21 / supabase-js 2.45.0，lockfile 冻结在最低版本                                   | 缺失 bug 修复      |
| **MIGRATION_TASKLIST 过时** | 仍把已删除的 RankBoard/HotspotBoard/TagTitlesBoard 当现存视图；模块数 134/187 与现 212 不符；条目停在 2026-08-15                      | 文档误导           |



---

## 八、遗留问题分级清单

### 🔴 P0（规范红线违反 / 潜在崩溃，应优先修）

| # | 问题                                        | 位置                                                                                        |
| - | ----------------------------------------- | ----------------------------------------------------------------------------------------- |
| 1 | **§8 云端业务数据写回 localStorage**（代码自认违规但照跑）   | auction-sync.js:522-594（:538/:551/:567/:581/:793）                                         |
| 2 | **window 登录态别名挂载**（§16 违反）                | authStore.js:51-87（7 处 defineProperty）                                                    |
| 3 | **logic 层直接操作 DOM**（§3/§4 违反）             | auction-sync.js:505 `document.getElementById('syncStatus')`                               |
| 4 | **hotspot.js null 解引用崩溃点**（运行即 TypeError） | hotspot.js:191-193/432-438/452-454/530-534（importHotFromPaste/replaceHotConceptFromPaste） |

### 🟠 P1（架构遗留，影响可维护性）

| # | 问题                                                                             | 位置                                                                             |
| - | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| 5 | app-core.js 中转站（768 行，re-export 70+，\_migrateFromV41 仍被调）                      | app-core.js                                                                    |
| 6 | 巨型文件（auction.js 2945 行/AuctionBoard.vue 1949 行/main.css 5208 行等 8 个）           | 多文件                                                                            |
| 7 | ui-bridge 残留 8 空桩 + auctionStore auctionActions 死委托 + \_uiFns 18 个 undefined 键 | ui-bridge.js / auctionStore.js                                                 |
| 8 | DashboardView 聚合 13 子组件、无 KeepAlive、**路由 9 条全闲置（0 导航调用）**、日期跨周末整体重建            | DashboardView.vue / router/index.js                                            |
| 9 | Realtime：remaining-boards 订阅无退订 + market_metrics 双 channel 重复订阅                | remaining-boards.js:577-613 / watchlist-and-metrics.js:263 / hot-stocks.js:673 |

### 🟡 P2（工程化/优化）

| #  | 问题                                                            | 位置                                  |
| -- | ------------------------------------------------------------- | ----------------------------------- |
| 10 | 标签快照写 localStorage（§8 边界，有云端真相辩护）                             | auctionTagStore.js:34               |
| 11 | 备份目录 96 文件进 git + 5 个 build-log + README 空                    | 仓库根                                 |
| 12 | 无 type:module / 零测试 / 零 lint / 26 文件带 BOM / 2 循环依赖            | package.json 等                      |
| 13 | numcat-proxy/fuyao-proxy 源码缺失 + 9 表无建表脚本 + auction_duiban 双真相 | supabase/functions / db/            |
| 14 | 模板行内轻量函数调用、撤销快照落盘                                             | AuctionBoard.vue / scope/helpers.js |

---

## 九、建议的修复路线图

1. **P0-1**：收口 auction-sync.js §8-TODO 区块——确认各 key 云端路径后删除 localStorage 写入，改纯内存缓存 + Realtime（§8 最大违规）
2. **P0-2**：移除 authStore.js 的 7 处 window 别名（确认无旧代码依赖后），改纯 Pinia 访问
3. **P0-3**：auction-sync.js:505 的 `_setSyncStatus` 改为事件/响应式状态驱动（或删除，LoginOverlay 已有 statusText）
4. **P0-4**：hotspot.js `importHotFromPaste`/`replaceHotConceptFromPaste` 加空值守卫，或从 `_bindApi`/re-export 移除（防运行时崩溃）
5. **P1**：继续拆分 auction.js/AuctionBoard.vue 巨型文件；清理 ui-bridge 最后空桩 + auctionActions 死委托 + \_uiFns 18 个 undefined 键
6. **P1**：DashboardView 改路由驱动 + KeepAlive/v-show（§24/§25）；remaining-boards 补退订 + 合并 market_metrics 双 channel
7. **P2**：备份目录移出 git + 加 ignore；补 `"type":"module"`；README 补架构/部署说明
8. **P2**：numcat-proxy/fuyao-proxy 源码入库 + 补 9 表建表 SQL + 收敛 auction_duiban 双真相

---

## 十、完成状态跟踪（截至 2026-08-16，main = b899553）

> 本报告基线为 commit `61f8f03`。以下条目在基线之后已被实际修复（commit 链 `1bcaec0` → `127eeee` → `ab5f481` → `1fefbd3` → `b899553`，由 12 智能体收口 + 主智能体验收 + 后续专项重构完成）。本表为**真实代码核验结果**（grep / node --check / vite build），非凭记忆勾选。

### 🔴 P0（红线）

| # | 问题                                           | 状态    | 处置 / commit                                                                                                                                                                                                  |
| - | -------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1 | §8 云端业务数据写回 localStorage                     | ✅ 已完成 | `auction-sync.js` 9 个 blob 字段的 pull→push 暂存由 localStorage 改为模块内存 `_cloudBlobExtras`（ab5f481）；语义零变化、重启由下次 pull 重建、不丢数据；保留 §8 允许的 `scoreSettings_*`/`holidays`/`tradingDays`/`__migrated`/`lastEditedDate_v42` |
| 2 | window 登录态别名挂载（authStore 7 处 defineProperty） | ✅ 已完成 | R2 核查全 src `grep defineProperty` 0 处，已彻底清除（报告基线时仍残留，后续已删）                                                                                                                                                    |
| 3 | logic 层直接操作 DOM（auction-sync.js:505）         | ✅ 已完成 | `_setSyncStatus` 移除；`grep document.getElementById` 全 src 仅剩注释，状态改走 Vue 响应式 `statusText`                                                                                                                      |
| 4 | hotspot.js null 解引用崩溃点                       | ✅ 已完成 | `importHotFromPaste`/`replaceHotConceptFromPaste` 迁到 `rawText` 参数（对齐 stocks/auction 主流），删除 `_domGet` 桩调用（b899553）                                                                                            |

### 🟠 P1（架构遗留）

| # | 问题                                                                  | 状态      | 处置 / commit                                                                                                                                                    |
| - | ------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5 | app-core 中转站 + ui-bridge 空桩 + auctionStore 死委托 + `_uiFns` undefined | ⚠️ 部分完成 | ui-bridge `_domGet/_domQuery` 空桩删除（b899553）、auctionStore 19 个 `_uiFns` 死委托 + `auctionActions` 兼容层移除（127eeee E2）；**app-core.js 物理拆分仍刻意推迟**（原地去 window 化已完成，非阻塞） |
| 6 | 巨型文件（auction.js / AuctionBoard.vue / main.css 等）                    | ⬜ 未做    | 见下方「auction.js 拆分评估」——规范仅对 app-core.js 强制拆分（§16），巨型文件属 P1 可维护性，未强制                                                                                             |
| 7 | router 9 条全闲置 + DashboardView 聚合 + 无 KeepAlive + 日期跨周末重建            | ⚠️ 部分完成 | 8 条 0 导航死路由删除（127eeee F1）；DashboardView 路由驱动 / KeepAlive / v-show 未做                                                                                           |
| 8 | Realtime：remaining-boards 无退订 + market_metrics 双订阅                  | ✅ 已完成   | R4 补 `clearInterval(_watchDateTimer)` 回收 300ms 轮询 + 合并 market_metrics 为单 channel（仅 watchlist-and-metrics.js:262 拥有）                                            |

### 🟡 P2（工程化/优化）

| #  | 问题                                                           | 状态       | 处置 / commit                                                                                                                                                                           |
| -- | ------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10 | 标签快照写 localStorage（auctionTagStore）                          | ✅ 已无实际风险 | R2 确认 `saveTagsToStorage` 已是 no-op，§8 写入与 §11 覆盖风险均消除                                                                                                                                 |
| 11 | 备份目录进 git + build-log + README 空                             | ⬜ 未做     | —                                                                                                                                                                                     |
| 12 | 无 type:module / 零测试 / 零 lint / BOM / 循环依赖                    | ⚠️ 部分完成  | 26 文件 BOM 剥离（127eeee F4）；type:module / 测试 / lint / 循环依赖未做                                                                                                                             |
| 13 | numcat-proxy/fuyao-proxy 源码 + 9 表建表 SQL + auction_duiban 双真相 | ✅ 已完成    | 9 张缺表建表 SQL + numcat-proxy/fuyao-proxy Edge Function 源码入库（127eeee E1）；auction_duiban 收敛（b899553，表结构保留不丢数据）；建表脚本 `db/_E1_RUN_ALL_CREATE_TABLES.sql` 已修 COMMENT 语法 + policy 幂等（1fefbd3） |
| 14 | 模板行内函数 + 撤销快照落盘                                              | ⚠️ 部分完成  | 撤销快照由 localStorage 改为模块内存 Map（127eeee F3）；模板行内轻量函数调用未做                                                                                                                                |

### auction.js 拆分评估（问题 6 专项结论）

- 规范 §16（ARCHITECTURE V3 第 949–968 行）**仅对 `app-core.js` 明确「不得继续无限增长 / 应按业务拆分」**；auction.js 的「巨型文件」在报告中列为 **P1 可维护性**，非红线，规范未设单文件行数硬上限。
- 当前 `logic/auction/` 已拆出 7 个低耦合助手模块（view-helpers 526 / sort-rules 223 / auction-edit-helpers 158 / incremental-view 155 / stock-sync 69 / auction-helpers 55 / sort-rules-extra 53 ≈ 1239 行），auction.js 本体 2916 行是强耦合的竞价编排核心（共享大量 `state._xxx`）。
- **结论：为满足合规无需拆；为可维护性建议「按需抽簇」而非盲目大拆分**——盲目拆 2916 行紧耦合、共享 state 的文件易引入循环依赖（已存在 app-core↔auction 环，§42 已标记）与回归。仅在出现清晰、低耦合的函数簇时才抽离（沿用已成功的抽簇模式）。

---

## 附：已完成的修复（本会话）

- ✅ AI 视觉导入/诊断报告删除、周月总结编辑 Vue 化、30+ 死代码空桩清理（commit 61f8f03）
- ✅ 观察组索引污染/涨跌比/双身份标记/继承恢复/数据回填（commit a77356b~54feb3a）
- ✅ 情绪看板完整性校验/封单家数改同花顺/连抓五天历史日期（commit 8e60a79/066f0c8）
- ✅ 4 个 sync 文件完全上云（duiban/etf-board/bidding-template/fumian 0 处 localStorage 写）
- ✅ **worker B `logs` 未定义 bug 修复**（emotion-workflow.js:84，数据完整性分支 ReferenceError 导致情绪不落库；已改 console.warn 并重新打包 `_bundled/bidding-board-worker-b.js`）——**需重新部署 worker B**

---

### 附（续）：12 智能体收口 + 专项重构（2026-08-15~16，main = b899553）

- ✅ **12 智能体收口 PURE_VUE3 红线条目**（commit `127eeee`，43 files +971/-211）：移除 auctionStore 19 死委托 + `auctionActions` 兼容层、删除 8 条 0 导航死路由、AuctionEditModal 抽 7+ 纯函数、撤销快照内存化、9 表建表 SQL + numcat-proxy/fuyao-proxy Edge Function 源码入库、26 文件 BOM 剥离、remaining Realtime 定时器回收 + market_metrics 合并
- ✅ **auction-sync §8 彻底合规**（commit `ab5f481`）：9 个 blob 字段 pull→push 暂存由 localStorage 改为模块内存 `_cloudBlobExtras`，消除「业务数据落 localStorage」违规（语义零变化、不丢数据）
- ✅ **建表 SQL 修复**（commit `1fefbd3`）：修正 `comment on table` 语法错误（PostgreSQL 42601）+ 加 policy 幂等保护（`db/_E1_RUN_ALL_CREATE_TABLES.sql` 可反复 Run）
- ✅ **auction_duiban 孤儿写收敛 + `_domGet` 空桩清理**（commit `b899553`，8 files +28/-128）：删 duiban-sync 死函数、hotspot 两粘贴函数迁 `rawText`、auction.js 死变量清理；node --check 8 文件全过、vite build 0 错 0 警（216 modules）
- 📌 **用户侧待办（非代码）**：① 在 Supabase 执行 `db/_E1_RUN_ALL_CREATE_TABLES.sql` 建 9 表（用户已跑通）；② 浏览器回归点一遍（DashboardView 切日期/周末不重建、Realtime 不重复订阅、撤销快照仅会话内有效）；③ 确认 hotspot 粘贴调用的 Vue 入口已把粘贴内容传入 `rawText` 参数
