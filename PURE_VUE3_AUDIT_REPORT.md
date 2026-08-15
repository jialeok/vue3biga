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

| 检查项 | 结果 | 说明 |
|---|---|---|
| `createApp` 仅 main.js | ✅ | 全 src 仅 1 处 |
| `globalProperties` | ✅ | 0 处 |
| `innerHTML` / `v-html` | ✅ | 0 处（仅注释提及） |
| CDN（unpkg/jsdelivr） | ✅ | index.html 12 行，无 CDN（备份目录除外） |
| IIFE 业务模块 | ✅ | 0 处（src 下） |
| UI 直连 Supabase | ✅ | views/components 全部经 data 层 |
| logic import 展示层 | ✅ | 0 处 |
| `.vue` 文件 `window.` 实际引用 | ✅ | 0 处（剩余为注释/字符串） |
| `configureServer` 自定义中间件 | ✅ | vite.config.js 为标准配置 |

### ❌ 违反项（2 处）

1. **`src/stores/authStore.js:51-87` — 7 处 `Object.defineProperty(window, ...)` 登录态别名挂载**
   - 挂载 `_sessionToken`/`_realtimeChannel`/`unlocked`/`_justPushed`/`_justPushedAuction`/`_justPushedAuctionCounter`/`_justPushedAuctionTimer`
   - 注释自认"向后兼容 window._sessionToken 等直接读写"
   - **违反 §16"禁止 window.xxx 业务全局"**。虽然有 getter/setter 委托到 Pinia（非孤儿状态），但仍在 window 上暴露业务接口，是旧 DOM 时代的遗留。

2. **`src/logic/workflows/auction-sync.js:505` — logic 层直接操作 DOM**
   - `document.getElementById('syncStatus').textContent = v`
   - **违反"Logic 不操作 DOM"**（§3/§4 依赖方向）。且 `#syncStatus` 是 LoginOverlay.vue 的 Vue 响应式元素（绑定 `statusText`），logic 直接写 textContent 会绕过 Vue 响应式、与 Vue 状态双写冲突。

> 另有 34 处 `window.` 出现在日志/console 字符串字面量中（如 `window.syncAuctionListForDate`），非实际代码调用，不影响合规判定，但建议后续清理。

---

## 三、三层架构与模块化（规范 §2-§16）

### ⚠️ 遗留问题

| 问题 | 现状 | 违反点 |
|---|---|---|
| **app-core.js 中转站** | 768 行，re-export 70+ 域函数，`_bindApi`/`_bindUiFns` 双注册，`_migrateFromV41` 仍被调用 | §16"不得无限增长" |
| **巨型文件** | auction.js 2945 行/154.7KB、AuctionBoard.vue 1949 行/82.4KB、main.css 5208 行（0 个 @media）、auction-sync.js 851 行、AuctionEditModal.vue 948 行、app-core.js 768 行 | §15/§16 可维护性 |
| **hotspot.js null 解引用崩溃点** | `importHotFromPaste`/`replaceHotConceptFromPaste` 直接 `_domGet('hotPasteInput').value` 无守卫（:191-193/:432-438/:452-454/:530-534），运行即 TypeError；目前无 Vue 调用方但挂在 `_bindApi`/re-export 上，属"半死炸弹" | §10 静默失败/运行时崩溃 |
| **ui-bridge 残留 8 空桩** | toggleStrengthSort/copyAllTopicStocks/copyTopicStocks/openCoreTopicModal/openAuctionNoteEditFromPage2/restoreExpandedTopicGroupsP2/toggleTopicGroupTrendPanels/resetExpansionStateOnDateSwitch——**全项目 0 真实调用**，仅经 auctionStore `_uiFns` 委托（18 个键 undefined，safeCall 静默 no-op）；AuctionBoard.vue 全走本地实现 | §16 死代码 |
| **auctionStore auctionActions 死委托** | 兼容层 20+ action 委托到 `_uiFns`（多数 undefined），全项目 **0 个外部调用点** | §16 死代码 |
| **router 完全闲置** | 9 条路由注册，但**全项目 0 处导航调用**（无 router.push/link/useRouter），只有 '/' 可达 | §24 页面生命周期 |
| **remaining-boards.js 订阅无退订** | `_subscribeRealtime()`（:577-613）channel 未持有引用、全文件无 removeChannel；附带 :568 setInterval 300ms 轮询 | §31 Realtime 生命周期 |
| **market_metrics 重复订阅** | 同表被 `watchlist-and-metrics.js:263-277` + `hot-stocks.js:673-684` 双 channel 订阅 | §31 防重复订阅 |
| **DashboardView 13 子组件聚合** | 9 个重型看板 v-if 同时挂载 + PatternBoard 常驻；**日期跨周末即整体销毁重建**；无 KeepAlive | §24/§25/§26 |
| **remaining-boards.js** | 645 行，已标准 ES Module 化，但规范 §16 点名"应迁移或删除" | §16 |

### ✅ 已改善

- 域模块已实质拆分（auction/bidding/stocks/jiwang/hotspot/rank/multi/pattern/date/tagTitles 独立文件）
- AI 视觉导入、诊断报告等死功能已删除（本次会话）
- 30+ 无引用空桩已清理（本次会话）
- Realtime 其余 14 个 channel 均有 removeChannel/unsubscribe、start/stop 配对（§31 大体合规）

---

## 四、数据安全（规范 §6-§13）

### ❌ §8 localStorage 业务数据违规（最严重）

1. **`src/logic/workflows/auction-sync.js:522-594` — 云端业务数据写回 localStorage（§8-TODO 区块）**
   - 代码注释自认："下方整段把云端业务数据写回 localStorage，违反 §8…待单独决策"
   - **但代码照跑**：`:538` 写 stocks/auction/bidding/rank/multi/hotspot/pattern/tagTitles 全量；`:551` 写 duibanData/duibanComment/stockEtfComment/coreTopics/biddingDefaultTemplate_v41/copiedStocksData；`:567` 写 summaries；`:581` 写 scoreSettings；`:793` 写 biddingDefaultTemplate_v41
   - 每次解锁后 pullFromCloud 执行 → 业务数据持续落 localStorage
   - **修复方向**：确认这些 key 的云端路径已存在后，删除 localStorage 写入，改为纯内存缓存 + Realtime

2. **`src/stores/auctionTagStore.js:34` — 标签快照写 localStorage**
   - 注释辩护"云端 auction_board_tags 为持久真相、本地仅兜底、非唯一真相"
   - 严格按 §8（明文禁"标签"）属违规，但云端真相完整，风险低；建议保留待决策标注或彻底移除

3. **`src/logic/scope/helpers.js:46-47` — 撤销快照写 localStorage（⚠️ 待评估）**
   - 单日竞价/热门数据备份，有界功能，注释称"非业务真相源"；边界上可算临时缓存豁免

### ✅ 合规项

- 登录会话/剪贴板缓存/一次性迁移标记/调试标记：全部合规（§8 允许类）
- **_suspiciousWipe 删除保护完整**：`auction-sync.js:92-93/187-188`（比例 >0.6 即拦截）
- **§10 静默失败**：未发现"DB 读取失败伪装空数据"直接命中；Supabase 读取失败均 throw/warn
- **§11 删除验证**：删除均检查 error 并 throw

### ⚠️ 小缺口

- `tagTitles/helpers.js:345`、`AuctionBoard.vue:946`、`auctionTagStore.js:35` 空 catch（非 DB，低危）
- `hot-stocks.js:768-773` 迁移物理删除的 Promise.all 无逐条 error 检查
- `bidding-data.js` 删除前有计数、删除后无核对

---

## 五、响应式与性能（规范 §17-§36）

### ✅ 合规项

- **无 `deep: true` watch**：全 src 0 处（§20 合规）
- **无重型模板计算**：模板中调用的是轻量格式化函数（`getRankAppearText`/`getChangePctDisplay` 等），非 filter/sort/map 重型操作
- **增量渲染**：AuctionBoard 已用 `v-memo` + 增量行缓存层（§17/§23 方向正确）
- **构建体积**：主 bundle 410KB（gzip 132KB），已从会话初期 420KB 下降

### ⚠️ 待优化项

| 问题 | 现状 | 违反点 |
|---|---|---|
| **DashboardView 聚合 13 子组件 + 无 KeepAlive** | `/` 首页 v-if 切换 13 个看板（trading 态 9 个 + Pattern + weekly/monthly + EditModal），全 src **0 处 KeepAlive** | §24/§25 页面生命周期与底部导航性能 |
| **路由未驱动看板切换** | router 注册 9 条路由（/auction /pattern /duiban 等），但主界面走 DashboardView 内嵌 v-if，路由闲置 | §24 页面生命周期 |
| **Realtime 订阅分散 16 个 channel** | 订阅点分散在 10+ 个 data 文件（hot-stocks 8 处、watchlist-and-metrics 6 处等），需确认生命周期统一管理、离开页面 unsubscribe | §31 |
| **模板行内函数调用** | AuctionBoard 模板多处 `{{ getXxx() }}`（轻量但每行每次渲染调用） | §21 建议改 computed/预计算 |
| **`_setSyncStatus` 双写** | auction-sync.js:505 logic 层直接写 `#syncStatus` textContent，绕过 Vue 响应式，与 LoginOverlay 的 statusText 双写冲突 | §17 响应式原则 |

### ✅ 已改善（本次会话）

- 观察组/涨跌比/继承等数据口径修复，避免无意义全量重算
- 连抓五天支持历史日期，tradedate 归一化修复
- 封单家数改同花顺接口、情绪看板数据完整性校验

---

## 六、云同步与部署（规范 §31-§33）

### ✅ 合规项

- **Worker 打包与源码同步**：3 个 worker 的 `_bundled/` 均为最新（源码 08-07 修改、打包 08-15）
- **Supabase bidding-a 函数完整**：`supabase/functions/bidding-a/index.ts` 存在且含封单家数逻辑
- **删除保护（_suspiciousWipe）完整**：auction-sync.js 两处（auction/hot 双份）

### ⚠️ 部署风险

| 问题 | 现状 | 影响 |
|---|---|---|
| **numcat-proxy / fuyao-proxy 源码缺失** | `src/data/api/*-proxy.js` 调用 `supabase.co/functions/v1/numcat-proxy` 和 `fuyao-proxy`，但 `supabase/functions/` 下只有 bidding-a——**两个 Edge Function 源码都不在仓库**（人工部署） | 无法重建/审计/回滚；前端 6+ 处抓取依赖 |
| **9 个表无建表脚本** | 代码用 21 个表，但 `bidding_data`/`jiwang_data`/`stockcodemap`/`stock_topics`/`core_topics`/`user_data`/`daily_highlights`/`hot_stocks_highlights`/`hot_stock_trends` 在 db/*.sql、workers、supabase 中**均无 CREATE TABLE** | **数据库 schema 无法从仓库重建** |
| **auction_duiban 双真相** | DuibanBoard 读 `recent_multi_data`，但 `auction_duiban` 表被写从不读（只写不读的孤儿表）；`recalcDuibanFromAuction` 又从竞价列表推导覆盖写回 | §6 多真相残留 |
| **废弃表** | `auction_etf`/`auction_etf_comment` 已废弃（0 行）、`auction_bidding_template` 只写不读 | 仓库/线上脏数据 |
| **worker B 曾有 `logs` 未定义 bug** | `emotion-workflow.js:84` 在数据完整性分支用未定义 `logs` 变量 → 触发时 ReferenceError 致情绪数据不落库（**已修复**，见附注） | 已修复，需重新部署 worker B |
| **Worker 部署靠手动** | 无 CI/CD，worker 需手动用 `_bundled/` 更新 | 部署易遗漏 |
| **README 为空** | 只有 "# biga"，无部署/架构说明 | 接手成本高 |

---

## 七、工程化与质量（规范 §42-§43）

### ✅ 合规项

- **构建通过**：`npm run build` 无错误（12s 内），dist 与源码同步
- **vite.config.js 标准**：无自定义中间件
- **.gitignore 基本合格**：已覆盖 node_modules/dist/临时目录/TOKEN 文件
- **index.html 精简**：12 行，无 CDN/内联脚本

### ❌ 待改进项

| 问题 | 现状 | 影响 |
|---|---|---|
| **无 `"type":"module"`** | package.json 缺该字段，每次构建 1 条 Vite CJS deprecation 告警 | 构建告警、ESM 语义不完整 |
| **零测试** | src 下 0 个 test/spec 文件，无 vitest/jest | §43 性能回归无自动化支撑 |
| **零 lint/format** | 无 eslint/prettier，代码风格不统一 | 长期维护成本 |
| **备份目录 96 文件被 git 跟踪** | `newbigamain没彻底拆分最新原始文件/` 96 个文件（占 git 268 文件的 36%）、2.7MB，.gitignore 未覆盖 | 仓库污染、误引用风险 |
| **构建日志被跟踪** | build-log.txt ~ build-log5.txt 5 个日志文件在 git 里 | 仓库噪音 |
| **README 为空** | 只有 "# biga" | 接手成本高 |
| **26 个源文件带 BOM** | 含 BOM 的 UTF-8 文件（Vite/Node 可能警告） | 编码一致性 |
| **2 个直接循环依赖** | app-core↔auction、app-core↔stocks | 模块边界模糊 |

---

## 八、遗留问题分级清单

### 🔴 P0（规范红线违反 / 潜在崩溃，应优先修）

| # | 问题 | 位置 |
|---|---|---|
| 1 | **§8 云端业务数据写回 localStorage**（代码自认违规但照跑） | auction-sync.js:522-594（:538/:551/:567/:581/:793） |
| 2 | **window 登录态别名挂载**（§16 违反） | authStore.js:51-87（7 处 defineProperty） |
| 3 | **logic 层直接操作 DOM**（§3/§4 违反） | auction-sync.js:505 `document.getElementById('syncStatus')` |
| 4 | **hotspot.js null 解引用崩溃点**（运行即 TypeError） | hotspot.js:191-193/432-438/452-454/530-534（importHotFromPaste/replaceHotConceptFromPaste） |

### 🟠 P1（架构遗留，影响可维护性）

| # | 问题 | 位置 |
|---|---|---|
| 5 | app-core.js 中转站（768 行，re-export 70+，_migrateFromV41 仍被调） | app-core.js |
| 6 | 巨型文件（auction.js 2945 行/AuctionBoard.vue 1949 行/main.css 5208 行等 8 个） | 多文件 |
| 7 | ui-bridge 残留 8 空桩 + auctionStore auctionActions 死委托 + _uiFns 18 个 undefined 键 | ui-bridge.js / auctionStore.js |
| 8 | DashboardView 聚合 13 子组件、无 KeepAlive、**路由 9 条全闲置（0 导航调用）**、日期跨周末整体重建 | DashboardView.vue / router/index.js |
| 9 | Realtime：remaining-boards 订阅无退订 + market_metrics 双 channel 重复订阅 | remaining-boards.js:577-613 / watchlist-and-metrics.js:263 / hot-stocks.js:673 |

### 🟡 P2（工程化/优化）

| # | 问题 | 位置 |
|---|---|---|
| 10 | 标签快照写 localStorage（§8 边界，有云端真相辩护） | auctionTagStore.js:34 |
| 11 | 备份目录 96 文件进 git + 5 个 build-log + README 空 | 仓库根 |
| 12 | 无 type:module / 零测试 / 零 lint / 26 文件带 BOM / 2 循环依赖 | package.json 等 |
| 13 | numcat-proxy/fuyao-proxy 源码缺失 + 9 表无建表脚本 + auction_duiban 双真相 | supabase/functions / db/ |
| 14 | 模板行内轻量函数调用、撤销快照落盘 | AuctionBoard.vue / scope/helpers.js |

---

## 九、建议的修复路线图

1. **P0-1**：收口 auction-sync.js §8-TODO 区块——确认各 key 云端路径后删除 localStorage 写入，改纯内存缓存 + Realtime（§8 最大违规）
2. **P0-2**：移除 authStore.js 的 7 处 window 别名（确认无旧代码依赖后），改纯 Pinia 访问
3. **P0-3**：auction-sync.js:505 的 `_setSyncStatus` 改为事件/响应式状态驱动（或删除，LoginOverlay 已有 statusText）
4. **P0-4**：hotspot.js `importHotFromPaste`/`replaceHotConceptFromPaste` 加空值守卫，或从 `_bindApi`/re-export 移除（防运行时崩溃）
5. **P1**：继续拆分 auction.js/AuctionBoard.vue 巨型文件；清理 ui-bridge 最后空桩 + auctionActions 死委托 + _uiFns 18 个 undefined 键
6. **P1**：DashboardView 改路由驱动 + KeepAlive/v-show（§24/§25）；remaining-boards 补退订 + 合并 market_metrics 双 channel
7. **P2**：备份目录移出 git + 加 ignore；补 `"type":"module"`；README 补架构/部署说明
8. **P2**：numcat-proxy/fuyao-proxy 源码入库 + 补 9 表建表 SQL + 收敛 auction_duiban 双真相

---

## 附：已完成的修复（本会话）

- ✅ AI 视觉导入/诊断报告删除、周月总结编辑 Vue 化、30+ 死代码空桩清理（commit 61f8f03）
- ✅ 观察组索引污染/涨跌比/双身份标记/继承恢复/数据回填（commit a77356b~54feb3a）
- ✅ 情绪看板完整性校验/封单家数改同花顺/连抓五天历史日期（commit 8e60a79/066f0c8）
- ✅ 4 个 sync 文件完全上云（duiban/etf-board/bidding-template/fumian 0 处 localStorage 写）
- ✅ **worker B `logs` 未定义 bug 修复**（emotion-workflow.js:84，数据完整性分支 ReferenceError 导致情绪不落库；已改 console.warn 并重新打包 `_bundled/bidding-board-worker-b.js`）——**需重新部署 worker B**
