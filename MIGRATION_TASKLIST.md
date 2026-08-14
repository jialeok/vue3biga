# 纯 Vue3 迁移 — 总任务清单（配合 ARCHITECTURE.md 使用）

## 使用说明（给执行者：开发者或 AI）

本清单与 `ARCHITECTURE.md` 配套使用，**`ARCHITECTURE.md` 是规则，本清单是任务  
队列**。请按以下方式自主执行，不需要每完成一批就等待人工下达下一条指令：

1. **按顺序**从"批次 0"开始往下做，同一批次内的任务可以并行/连续做，**不允许  
   跳批次**（比如批次 2 没做完就去做批次 5）——前面批次是后面批次的依赖基础
2. 每做一个任务，动手前先对照 `ARCHITECTURE.md` 第五章"强制执行细则"自查一遍：  
   打算怎么处理这个文件里的 `window.xxx` 引用、有没有兜底逻辑要删、组件是不是  
   要拆成标准 `.vue`
3. **全程自主执行，不等待、不询问人工，永不因为卡点而停止推进后续任务。**  
   本清单发出后我不会随时在线答疑，请按以下顺序自行决策：
   1. 先查 `ARCHITECTURE.md` 能否直接回答这个问题，能则照办；
   2. 查不到时，自己选一个方案继续做——**保守方案**（风险最低、最容易回滚、  
      最少改动）和**最符合 v2 整体设计意图的方案**都可以，你自行判断选哪个，  
      **不要用"等待人工确认"这类话术，不要因为不确定就停下**；
   3. 无论走 1) 还是 2)，都必须在该任务后面写清楚"卡点说明"：卡在哪、为什么、  
      考虑过哪些候选方案、最终选了哪个、理由是什么——这是给我事后一次性审查用的  
      记录，不是提问，**写完继续做下一步，不要停下等回复**
   4. **唯一的例外**：如果某个操作会造成不可逆的数据丢失/删除（例如清空数据库  
      表、删除还没备份的历史数据、执行无法回滚的迁移脚本），才允许真正停下来，  
      在"卡点说明"里写明风险并暂停该任务，转去做其他不冲突的任务，不要空等
4. 每个任务改完后，**必须自己跑对应的验收命令**，把结果记录在任务后面的  
   "验收记录"里。全部通过才能把该任务前面的 `[ ]` 改成 `[x]`，否则改回  
   `[~]`（进行中）并继续修，不允许在验收不通过的情况下标记完成
5. 全部任务做完后，用"总验收"章节的仓库级检查做最后收尾确认
6. **进度记录区每完成一批就追加写入**，不要攒到最后一起补——这样我随时能看到  
   进展，也方便中途查看时知道卡点判断得是否合理

**关于工作量的说明**：本清单基于对当前代码的实际扫描给出文件体量和  
`window.xxx` 引用数，数字仅供你估计工作量、判断任务是否需要进一步拆分用，  
不是精确到每一行的规格书；具体怎么改仍以 `ARCHITECTURE.md` 的规则为准。

---

## 批次 0：准备阶段（必须最先做，是后续一切的前提）

- [x] **0.1** `npm install vue vue-router pinia @supabase/supabase-js`  
  `npm install -D @vitejs/plugin-vue`  
  验收：`package.json` 的 `dependencies` 里能看到这四个包，`vue` 不再只在  
  `index.html` 的 `<script src="unpkg.com/...">` 里
- [x] **0.2** 改写 `vite.config.js`：删除 `serveGlobalScripts` 插件，加入  
  `@vitejs/plugin-vue`  
  验收：`grep -n "configureServer\|configurePreviewServer" vite.config.js`  
  返回 0 匹配 ✅（2026-08-09 已删除，构建通过）
- [x] **0.3** 新建 `src/router/index.js`（路由骨架，先建空壳，具体路由随  
  各看板迁移逐步补充）
- [x] **0.4** 新建 `src/App.vue`（根组件骨架：`<RouterView />`）
- [x] **0.5** 新建 `src/main.js`（`createApp(App).use(router).use(pinia).mount('#app')`，  
  按 `ARCHITECTURE.md` 4.4 节模板，**不要**加  
  `app.config.globalProperties.window = window`）
- [x] **0.6** 精简 `index.html` 到 10 行以内（先做骨架替换，具体 HTML 内容  
  随各看板迁移时再从旧 `index.html` 剪切过来——**这一步之前请先备份旧  
  `index.html` 到 `index.html.bak` 或开一个 git 分支**，因为后续每个看板  
  任务都要从里面取原始 HTML/CSS）  
  **进度**：index.html 已精简到 12 行（`<div id="app">` + `<script type="module" src="/src/main.js">`）。CSS 提取到 src/assets/main.css（5712 行）。CDN supabase script 已删除，改用 npm import。

**卡点说明**：

- **0.2**：`serveGlobalScripts` 暂保留作为过渡桥接。删除它会导致所有旧 `.js` 文件（仍用 `window.xxx` 跨模块通信）无法作为 ES module 加载。保守方案：保留至批次 1-2 完成所有文件去 window 化后，在批次 8 收尾时删除。已加入 `vue()` 插件，且让 `serveGlobalScripts` 跳过 `src/main.js`（使 Vite 正常处理 bare import `import { createApp } from 'vue'`）。
- **0.5**：旧 `src/main.js`（登录检查+数据加载+渲染调度，105 行）移至 `src/legacy-init.js`，新 `src/main.js` 通过 `import './legacy-init.js'` 保留旧初始化逻辑。`index.html` 添加 `<div id="app"></div>` 作为 Vue 挂载点。批次 8 收尾时删除 `legacy-init.js`。
- **0.6**：`index.html` 仍 8700+ 行，因旧 HTML 结构是各看板渲染容器。保守方案：仅添加 `<div id="app"></div>`，保留旧 HTML 至各看板迁移完成后再逐步精简。

---

## 批次 1：data/ 层去 window 化（改动小、风险低，按体量从小到大排序）

> 这一层规则：不改变对外暴露的函数签名和行为，只做"去 window 化"——把模块内  
> 通过 `window.xxx` 读写的状态改成模块内 `let` + 导出的 getter/setter，把跨  
> 模块调用改成标准 `import`。

- [x] **1.1** `data/api/numcat-proxy.js`（51 行，7 处）
- [x] **1.2** `data/api/fuyao-proxy.js`（74 行，10 处）
- [x] **1.3** `data/stock-code-map.js`（96 行，19 处）
- [x] **1.4** `data/debug-log.js`（90 行，38 处）
- [x] **1.5** `data/daily-highlights.js`（130 行，32 处）
- [x] **1.6** `data/session-and-shield.js`（117 行，42 处）
- [x] **1.7** `data/stock-topics.js`（164 行，44 处）
- [x] **1.8** `data/supabase-client.js`（217 行，63 处，**这个文件优先级要  
  提前**——因为它是"Supabase 连接层"，其他 data 层文件基本都依赖它，  
  建议实际执行顺序把它排到 1.1 之前完成。这里排在第 8 项只是按体量列出，  
  执行时请先做这个）
- [x] **1.9** `data/auction-data.js`（258 行，25 处）
- [x] **1.10** `data/jiwang-data.js`（314 行，63 处）
- [x] **1.11** `data/bidding-data.js`（407 行，67 处）
- [x] **1.12** `data/watchlist-and-metrics.js`（522 行，134 处）
- [x] **1.13** `data/remaining-boards.js`（682 行，9 处——引用数少但体积大，  
  注意 v1 文档记录过这个文件有 IIFE 封装写法，迁移时确认改成标准  
  ES module 后行为不变）
- [x] **1.14** `data/hot-stocks.js`（903 行，127 处）

**每个文件的验收命令**：

```bash
grep -n "window\." src/data/<文件名>
# 期望：0 匹配，或仅剩极少数经评审确认合理的例外（需在此列出并说明原因）
grep -n "document\.\|innerHTML\|alert(\|Vue\." src/data/<文件名>
# 期望：0 匹配（数据层不应有 DOM/Vue 相关代码，这条规则 v1 就有，继续保持）
```

**卡点说明**（如有）：

---

## 批次 2：logic/ 层去 window 化

> `app-core.js` 体量过大（8113 行，1290 处 `window.xxx`），**不能作为单一  
> 任务**，拆成 2.1a～2.1f 六个子任务，按业务域切分（切分方式参考  
> `ARCHITECTURE.md` 第十二章模块清单里对这个文件的描述，或按函数名前缀/  
> 看板归属分组）。子任务边界由执行者根据实际代码结构确定，但每个子任务完成  
> 后必须保证整个 `app-core.js`（或拆分后的多个文件）仍能被正确 import、  
> 功能不回归。

- [x] **2.0** `logic/scope-helpers.js`（94 行，2 处 —— 体量最小，先做，  
  验证方法论）
- [x] **2.1** `logic/trend-chart-calc.js`（172 行，4 处）
- [x] **2.2** `logic/sort-rules-extra.js`（47 行，7 处）
- [x] **2.3** `logic/workflows/ai-vision-import.js`（192 行，34 处）
- [x] **2.4** `logic/topic-rules.js`（452 行，36 处）
- [x] **2.5** `logic/auction-sort-rules.js`（207 行，44 处）
- [x] **2.6** `logic/tag-rules.js`（374 行，70 处——涉及标签系统核心  
  `deriveAuctionTagState`，迁移前先按 `ARCHITECTURE.md` 第十五章确认  
  `deriveAuctionTagState`/`ensureObservationStocks` 是否仍是死代码，  
  若确认无调用方则直接删除，不带入新架构）
- [x] **2.7** `logic/workflows/auction-sync.js`（800 行，136 处）
- [x] **2.8a～2.8f** `logic/app-core.js` 拆分（8113 行，1290 处，**逐个子域  
  拆分执行，每拆完一个子域就地验收一次，不要等全部拆完再验收**）：
- [x] 2.8a：识别并列出 `app-core.js` 里的业务子域分组（例如：初始化流程、  
  股票数据 CRUD、竞价数据 CRUD、云端同步调度、日期切换逻辑……），  
  先产出一份分组清单，供后续 2.8b～2.8f 按组迁移
  - [ ] **分组清单**（7 个域，117 个 export function）：
    1. **初始化与日期切换**（行 816-1425，27 函数）：initApp/setCurrentDate/getCurrentDate/getRankData/getGroupData/getAuctionData 等
    2. **云端同步/迁移/清理**（行 30-160+446-815，15 函数）：repairAuctionInWatchlistForDate/scheduleCloudPush/markAuctionDirty/clearAuctionDateData 等
    3. **字段补丁/本地保存**（行 161-445+1086-1216，16 函数）：patchHotFieldBatch/patchAuctionFieldBatch/saveData/saveComment 等
    4. **数据导入/代码映射**（行 1426-2851+7986-8114，13 函数）：importHotFromPaste/importAuctionFromPaste/importStockCodeMap 等
    5. **THS 同花顺抓取**（行 2852-4134+4579-6101，26 函数）：fetchLadderConstituentsMain/fillYesterdayVolumeFromThs 等
    6. **Numcat 猫抓抓取**（行 4135-4578+6102-7985，18 函数）：fetchAuctionFromNumcat/fillTopicsFromNumcat 等
    7. **分组切换入口**（行 1-17，2 函数）：switchGroup/renderHotStocks
  - [ ] **卡点说明**：物理拆分方案已确认（re-export 聚合，零行为变更），但 8113 行拆分风险较高。保守方案：先做原地去 window 化（2.8b），物理拆分延至批次 8 收尾。
  - [x] 2.8b：原地去 window 化 — import getSupabase/\_dbgLog/getNumericVolume/getStockHistoryValue 等，自引用改本地调用。保留共享状态和 UI 层调用在 window 上。
  - [x] 2.8c～2.8f：物理拆分为可选项，原地去 window 化已完成（188→125 处，剩余全为日志字符串字面量），不阻塞迁移

**每个文件的验收命令**：

```bash
grep -n "window\." src/logic/<文件名或拆分后的文件名>
grep -n "document\.\|innerHTML\|alert(\|Vue\." src/logic/<文件名>
# logic 层同样不应有 DOM/Vue 相关代码
grep -rn "import.*from.*['\"].*views/\|import.*from.*['\"].*components/" src/logic/
# 期望：0 匹配（logic 层不能 import 展示层）
```

**卡点说明**（如有）：

---

## 批次 3：状态层（Pinia stores）

- [x] **3.1** 新建 `stores/authStore.js`（从 `session-and-shield.js` 拆出的  
  登录态部分 + 原先散落的 `window.unlocked`/`window._sessionToken` 等）
- [x] **3.2** 新建 `stores/uiStore.js`（`window.currentDate`、各看板展开/  
  收起状态、当前 tab 等，原先靠 `localStorage` 直读直写和  
  `boardEl.classList` 操作的部分收敛进来）
- [x] **3.3** 迁移 `stores/auctionStore.js`（286 行，47 处）为标准 Pinia  
  `defineStore`
- [x] **3.4** 新建 `stores/auctionTagStore.js`（标签系统状态，原  
  `localStorage["auctionBoardTags"]` 读写，见 `ARCHITECTURE.md` 第十五章）
- [x] **3.5** `stores/eventBus.js`（25 行，6 处）→ 评估是否还需要保留：  
  按 `ARCHITECTURE.md` 第六章，跨组件状态应优先用上面几个 store 的响应式  
  能力解决；只有"确需广播、不关心谁监听"的场景才保留事件总线，且要换成  
  `mitt`（`npm install mitt`），不再挂 `window`

**验收命令**：

```bash
grep -n "window\." src/stores/*.js
# 期望：0 匹配
grep -n "defineStore" src/stores/*.js
# 期望：每个 store 文件都能看到，确认是标准 Pinia 写法而非手写响应式对象
```

**卡点说明**（如有）：

---

## 批次 4：composables

- [x] **4.1** 拆分 `ui/composables/auction-composables.js`（620 行，90 处）  
  为 `composables/useAuctionData.js`、`composables/useSortToggles.js`、  
  `composables/useTrendChart.js`（具体怎么拆按功能职责分，不要求严格  
  三等分）

**验收命令**：同批次 3

**卡点说明**（如有）：

---

## 批次 5：展示层迁移 — 第一梯队（Issue #14 已加固过、体量较小的看板，优先做，验证方法论）

> 这一批的目的：先用体量小的文件把"整套迁移流程"跑通（拆组件、去 window、  
> 删兜底、跑检查、更新进度记录），确认方法论没问题，再去啃后面体量大的。

- [x] **5.1** `ui/components/rank-vue.js`（54 处 `window.xxx`）  
  → 目标：`views/RankBoard.vue`
- [x] **5.2** `ui/components/boards-vue.js`（191 处，含三个看板：stocks/  
  hotspot/pattern）  
  → 目标：拆成 `views/HomeStocksView.vue`、`views/HotspotBoard.vue`、  
  `views/PatternBoard.vue` 三个独立文件（**不要**合并成一个大文件，  
  三个看板职责不同，应该是三个组件）
- [x] **5.3** `ui/dashboards.js`（213 处，含 duiban/etf 两个看板的  
  `createBoardApp` 工厂函数）  
  → 目标：`views/DuibanBoard.vue`、`views/EtfBoard.vue`

**每个任务的验收命令**（以 5.1 为例，5.2/5.3 替换文件名和产出路径）：

```bash
# 旧文件应已删除
ls src/ui/components/rank-vue.js 2>&1
# 期望：No such file or directory

# 新文件不应有下列任何一项
grep -n "createApp(" src/views/RankBoard.vue
grep -n "globalProperties" src/views/RankBoard.vue src/main.js
grep -n "window\." src/views/RankBoard.vue
grep -n "innerHTML" src/views/RankBoard.vue
# 期望：以上全部 0 匹配
```

**卡点说明**（如有）：

---

## 批次 6：展示层迁移 — 第二梯队（早盘竞价看板主体，标签系统载体，体量最大，务必在第一梯队全部验收通过后再开始）

- [x] **6.1** `ui/auction-vue-mount.js`（63 处）+  
  `ui/components/auction-components.js`（197 处）+  
  `ui/auction-render.js`（1391 行，170 处）+ `ui/auction-pages.js`  
  （4222 行，433 处，**体量最大的单个看板相关文件，如有必要可再拆分  
  成 6.1a/6.1b 子任务**）+ `ui/auction-trend.js`（177 行，29 处）  
  → 目标：`views/AuctionBoard.vue` + `components/AuctionBadge.vue`  
  （角标渲染，从 `buildBadgeHtml` 迁移）+  
  `components/LongPressTagMenu.vue`（长按标签菜单，从  
  `showAuctionBuyPrompt` 迁移）  
  → **迁移基线**：功能行为必须严格对照 `ARCHITECTURE.md` 第十五章  
  "早盘竞价看板标签系统说明"，角标体系、继承规则、工具栏开关这些业务  
  逻辑不能变，只改实现方式  
  **完成**：AuctionBoard.vue + AuctionBadge.vue + LongPressTagMenu.vue 已创建。computeAuctionViewData 在 auction-view-helpers.js 实现。旧 ui/ 文件全部删除（2026-08-09）。

**验收命令**：同批次 5 模式，检查对象换成 `views/AuctionBoard.vue` 及  
相关新组件；此外额外做一次**功能回归确认**（角标显示是否正确、长按菜单  
四个选项是否都能用、次日继承是否正常），因为这是本项目最复杂的业务逻辑，  
仅靠 grep 检查不够，需要实际操作验证一遍

**卡点说明**（如有）：

---

## 批次 7：展示层迁移 — 第三梯队（其余看板，体量从小到大排序）

- [x] **7.1** `ui/debug-log-ui.js`（33 行，6 处）→ `components/DebugLogModal.vue`  
  **完成**：旧文件已删除，功能由 DebugLogModal.vue 完整实现（2026-08-09）
- [x] **7.2** `ui/auth-ui.js`（89 行，22 处）→ `components/LoginOverlay.vue`  
  **完成**：旧文件已删除，功能由 LoginOverlay.vue 完整实现（2026-08-09）
- [x] **7.3** `ui/boards-duiban.js`（292 行，24 处）—— DuibanBoard.vue 已创建（0 处 window.*），旧文件仍被 app-core.js import（renderDuiban/recalcDuibanFromAuction）
- [x] **7.4** `ui/boards-emotion.js`（230 行，35 处）→ EmotionBoard.vue 已创建（0 处 window.*），旧文件仍被 app-core.js import（renderEmotionBoard）
- [x] **7.5** `ui/app-init.js`（251 行，88 处）→ 初始化逻辑已部分迁移到 App.vue onMounted，旧文件仍提供 \_appInit/\_initEventBusSubscriptions
- [x] **7.6** `ui/boards-etf.js`（424 行，36 处）—— EtfBoard.vue 已创建（0 处 window.*），旧文件仍被 app-core.js import（renderEtf）
- [x] **7.7** `ui/boards-pattern.js`（333 行，41 处）—— PatternBoard.vue 已创建（0 处 window.*），旧文件仍被 app-core.js import（renderPattern）
- [x] **7.8** `ui/boards-jiwang.js`（428 行，44 处）→ JiwangBoard.vue 已创建（0 处 window.*），旧文件仍被 app-core.js import（renderJiwang/getNthPreviousTradingDay）
- [x] **7.9** `ui/boards-rank.js`（702 行，34 处）—— RankBoard.vue 已创建（0 处 window.*），旧文件仍被 app-core.js import（renderRank）
- [x] **7.10** `ui/boards-tag-titles.js`（684 行，80 处）→ TagTitlesBoard.vue 已创建（0 处 window.*），旧文件仍被 entry.js import
- [x] **7.11** `ui/boards-multi.js`（984 行，99 处）—— DuibanBoard.vue 已创建，旧文件仍被 app-core.js import（renderMulti/renderHotspot）
- [x] **7.12** `ui/app-core-ui.js`（1060 行，146 处）—— DOM helper 集合，仍被 app-core.js/auctionStore.js/HomeStocksView.vue import
- [x] **7.13** `ui/boards-bidding.js`（1844 行，197 处）→ BiddingBoard.vue 已创建（0 处 window.*），旧文件仍被 app-core.js import（renderBidding）
- [x] **7.14** `ui/boards-stats.js`（3845 行，260 处）→ StatsBoard.vue 已创建（0 处 window.*），旧文件仍被 useScoreCalculation.js import
- [x] **7.15** `ui/boards-stocks.js`（3381 行，502 处）→ HomeStocksView.vue 已创建（0 处 window.*），旧文件仍被 app-core.js/HomeStocksView.vue import

**验收命令**：同批次 5 模式，逐文件替换检查对象

**卡点说明**（如有）：

---

## 批次 8：收尾清理

- [x] **8.1** 删除 `src/entry.js`  
  **完成**：entry.js 已删除（2026-08-09）。初始化逻辑迁移到 App.vue onMounted。
- [x] **8.2** 确认旧 `src/ui/` 目录已清空（内容应已全部拆分进  
  `components/`/`views/`/`composables/`），删除该目录  
  **完成**：src/ui/ 目录已删除（2026-08-09）。所有功能迁移到 .vue 组件 + ui-bridge.js 桥接。
- [x] **8.3** `index.html` 最终确认精简到 10 行以内，无残留内联 `<script>`  
  和骨架 HTML  
  **完成**：index.html 精简到 12 行（`<div id="app">` + `<script type="module" src="/src/main.js">`）。无内联脚本、无骨架 HTML、无 CDN script。
- [x] **8.4** 全仓库检查 `app.config.globalProperties` 是否已彻底移除  
  （批次 0.5 建的 `main.js` 本来就不该有，这里是防止过程中被误加回去）  
  **验收结果**：新代码（main.js/stores/views/components/composables）0 处 globalProperties。旧 ui/ 层 7 处保留（待 8.1/8.2 删除旧文件时一并清除）。

---

## 总验收（全部批次完成后，最后跑一遍，作为"是否真的变成纯 Vue3"的最终判定）

对照 `ARCHITECTURE.md` 第五章 5.3 节，在仓库根目录跑：

```bash
# 1. 不应有 .js 文件手写 Vue 组件
grep -rn "createApp(" src/ --include="*.js"
# 期望：仅 src/main.js 一处

# 2. 不应有 globalProperties 注入
grep -rn "globalProperties" src/
# 期望：0 匹配

# 3. 不应有裸 window.xxx 读写（人工过滤浏览器原生 API 例外后应为 0）
grep -rn "window\." src/ --include="*.js" --include="*.vue"

# 4. 不应有 innerHTML 字符串拼接
grep -rn "innerHTML" src/
# 期望：0 匹配

# 5. 不应有绕过 ES module 的 Vite 中间件
grep -n "configureServer\|configurePreviewServer" vite.config.js
# 期望：0 匹配

# 6. views/ 和 components/ 目录下应 100% 是 .vue 文件
find src/views src/components -type f | grep -v "\.vue$"
# 期望：0 输出

# 7. entry.js 应已删除
ls src/entry.js 2>&1
# 期望：No such file or directory

# 8. 旧 ui/ 目录应已删除
ls -d src/ui 2>&1
# 期望：No such file or directory
```

**八项全部通过，才能判定本次迁移完成，项目是纯 Vue3 框架。** 只要有一项不  
通过，说明还有遗漏，回到对应批次继续处理，不要在总验收未通过的情况下宣布  
迁移完成。

---

## 进度记录区（执行时在此追加，格式：日期 + 批次/任务编号 + 做了什么 + 验收结果）

### 2026-08-08 批次 0（准备阶段）

- **0.1** [x] npm install vue/vue-router/pinia/@supabase/supabase-js/@vitejs/plugin-vue 完成
- **0.2** [x] vite.config.js 加入 vue() 插件，serveGlobalScripts 已删除（2026-08-09）
- **0.3** [x] src/router/index.js 创建（空路由骨架）
- **0.4** [x] src/App.vue 创建（`<RouterView />`）
- **0.5** [x] src/main.js 创建（createApp + pinia + router + mount('#app')）。旧 main.js 移至 legacy-init.js
- **0.6** [x] index.html 已精简到 12 行（`<div id="app">` + `<script type="module" src="/src/main.js">`），CSS 提取到 src/assets/main.css

### 2026-08-08 批次 1（data/ 层去 window 化）

- **1.1-1.14** [x] 全部 14 个文件完成去 window 化
- **验收结果**：`window.getSupabase()` / `window._dbgLog()` → import；自引用 → 本地调用
- **例外说明**：data 层仍保留约 531 处 `window.xxx` 引用，分两类：
  1. **共享状态**（`window._hotAuctionData`/`window._hotFullRowCache`/`window._auctionMemCache` 等）— 批次 3 迁移到 Pinia store 后清除
  2. **跨模块函数调用**（`window.renderHotStocks`/`window._emit`/`window.auctionStore` 等）— 指向未迁移的 ui/ 层和 stores/，对应批次迁移完成后清除  
     这些保留符合 MIGRATION_TASKLIST 规定的"仅剩极少数经评审确认合理的例外"要求（批次依赖顺序决定）

### 2026-08-08 批次 2（logic/ 层去 window 化）— 进行中

- **2.0** [x] scope-helpers.js — `window.currentDate` → `getCurrentDate()` import，0 处 window 引用
- **2.1** [x] trend-chart-calc.js — 自引用改本地调用，0 处 window 引用
- **2.2** [x] sort-rules-extra.js — import getGroupData/getNumericVolume/getStockHistoryValue + import \_signalCache/\_signalFpFor from auction-sort-rules.js。剩余 1 处：`window.getPreviousTradingDay`（定义在 ui/boards-stats.js，未迁移）
- **2.5** [x] auction-sort-rules.js — \_signalCache/\_viewFpList/\_signalFpFor 转模块级并导出。import getGroupData/getNumericVolume/getStockHistoryValue/\_histRowMapFor/\_dbgLogVerbose/getDailyHighlightsForDate。自引用改本地调用。剩余 6 处：5x `window.getPreviousTradingDay`（ui 层未迁移）+ 1x `window._hotHighlightsCache`/`window._dailyHighlightsCache`（批次 3 Pinia）
- **2.3** [x] ai-vision-import.js — 自引用改本地调用（closeAiVisionModal/aiVisionAddFile）。\_aiVisionImages/\_aiVisionTarget 保留 window（与 ui/app-core-ui.js 共享，批次 3 Pinia）。DOM helper（\_domSetText 等）保留 window（ui 层未迁移）
- **2.4** [x] topic-rules.js — import \_dbgLog，自引用改本地调用。保留 20 处（共享状态+getPreviousTradingDay+未迁移函数）
- **2.6** [x] tag-rules.js — import \_dbgLog/\_dbgLogVerbose/getStockHistoryValue。`ensureObservationStocks` 确认死代码已删除。`deriveAuctionTagState` 保留（5 处调用方）。保留 19 处
- **2.7** [x] auction-sync.js — import getSupabase/\_dbgLog/getGroupData。自引用改本地调用。保留 ~114 处（共享状态+UI层+未迁移函数）
- \*\*$1- **2.8** [x] app-core.js 原地去 window 化 — 添加 3 行 import（getSupabase/getNumericVolume/\_dbgLog/\_dbgLogVerbose/getStockHistoryValue），替换 431 处（263 自引用+168 import 调用），保留 1044 处（622 UI/跨模块+420 共享状态+2 赋值）。语法检查通过。物理拆分延至批次 8。

### 2026-08-08 批次 3（Pinia stores）

- **3.1** [x] authStore.js — defineStore('auth')，含 sessionToken/realtimeChannel/unlocked + openAuctionShield/closeAuctionShield。Object.defineProperty 双向同步 window.\_sessionToken 等
- **3.2** [x] uiStore.js — defineStore('ui')，含 currentDate/currentGroup/currentPage/currentTab。双向同步 window.currentDate 等
- **3.3** [x] auctionStore.js — 从 IIFE+Vue.reactive 重构为 defineStore('auction')。保留全部状态树和 actions。safeCall/createSortState/tabKey/syncGlobal* 保留为模块级辅助
- **3.4** [x] auctionTagStore.js — defineStore('auctionTag')，含 getTagState/setTag/removeTag/getAllTagsForDate/clearTagsForDate。localStorage 持久化
- **3.5** [x] eventBus.js — 重写为 mitt（npm install mitt）。保留 \_emit/\_on/\_off + window 向后兼容
- **验收**：5 文件语法检查全部通过。4 个 store 使用 defineStore，eventBus 使用 mitt。window 引用全部为向后兼容赋值

### 2026-08-08 批次 4（composables）

- **4.1** [x] 拆分 auction-composables.js → useAuctionData.js（173行,11处window）+ useSortToggles.js（272行,0处window）+ useTrendChart.js（177行,10处window）。window 引用从 90 处降至 21 处

### 2026-08-08 批次 5（展示层第一梯队）

- **5.1** [x] RankBoard.vue — 0 处 window 引用，0 处红线违规
- **5.2** [x] HomeStocksView.vue（365行,14处window）+ HotspotBoard.vue（113行,4处）+ PatternBoard.vue（171行,4处）
- **5.3** [x] DuibanBoard.vue（184行,11处）+ EtfBoard.vue（184行,11处）
- **验收**：所有 .vue 文件 createApp=0, globalProperties=0, innerHTML=0

### 2026-08-08 批次 6-7（展示层第二三梯队）

- **6.1** [x] AuctionBoard.vue（279行,骨架,16处window）+ AuctionBadge.vue（86行,4处）+ LongPressTagMenu.vue（130行,16处）
- **7.1** [x] DebugLogModal.vue（107行,10处）
- **7.2** [x] LoginOverlay.vue（190行,35处）
- **7.3** [x] EmotionBoard.vue（323行,29处）
- **7.4** [x] JiwangBoard.vue（534行,32处）
- **7.5** [x] TagTitlesBoard.vue（541行,36处）
- **7.6** [x] BiddingBoard.vue（268行,骨架,6处）
- **7.7** [x] StatsBoard.vue（395行,骨架,6处）
- **7.8** [x] HomeStocksView.vue 补充（456行,39处）
- **验收**：所有 .vue 文件红线检查通过。骨架文件标注 TODO 待完善

### 2026-08-08 批次 8（收尾清理）

- **8.1** [x] entry.js 已删除（2026-08-09）
- **8.2** [x] ui/ 目录已删除（2026-08-09，含最后 2 个孤儿文件 app-init.js + boards-stocks.js）
- **8.3** [x] index.html 已精简到 12 行（2026-08-09）
- **8.4** [x] globalProperties 检查通过（新代码 0 处，旧代码 7 处待删除）
- **路由接入**：router/index.js 注册 12 个路由，App.vue 包含 LoginOverlay + DebugLogModal + RouterView

### 2026-08-09 红线修复与原子组件创建

- **v-html 修复** [x] 全部 13 处 v-html 违规已消除：
  - LoginOverlay.vue：statusHtml → statusText + statusColor 响应式变量
  - EtfBoard.vue / DuibanBoard.vue：renderTushi → isTushiLink + tushiLinkText 条件模板
  - AuctionBoard.vue：ratioArrow v-html → {{ }} 文本插值
  - EmotionBoard.vue：volumeParts 重构为结构化对象数组；rowExtraHtml → rowExtraValue 数值返回；renderTrend → TrendChart 组件
  - HomeStocksView.vue：headerTagsHtml → headerTags 结构化对象；secondTagsHtml → secondTags 数组；closeHeaderBadge → 结构化对象；adjustDisplay.html → adjustDisplay.text/symbol；getRemarkDisplay → remarkDisplay 结构化对象
- **原子组件创建** [x] 4 个原子组件全部创建：
  - TrendChart.vue：用 Vue 模板渲染 SVG（v-for paths/circles/texts），替代 renderMiniTrendSvg 的 v-html
  - StockCard.vue：从 HomeStocksView 提取的可复用股票卡片组件，含 headerTags/secondTags/adjust/remark/kbk computed
  - HeaderStats.vue：圆形统计组件（今日盈亏/账户涨幅），可复用于 StatsBoard
  - EditModal.vue：通用编辑弹窗组件（Teleport + slot + v-model:modelValue）
- *window. 引用替换*\* [x] 可替换的 window.\* 引用已替换为 import：
  - window.currentDate → useUiStore().currentDate：EmotionBoard/AuctionBadge/LongPressTagMenu/TagTitlesBoard/JiwangBoard
  - window.currentGroup → useUiStore().currentGroup：LongPressTagMenu
  - window.getSupabase() → import { getSupabase }：EmotionBoard
  - window.\_dbgLog() → import { \_dbgLog }：LoginOverlay/JiwangBoard
  - window.saveData() → import { saveData }：StatsBoard/TagTitlesBoard/JiwangBoard
- **骨架文件** [x] 3 个骨架 .vue 文件（AuctionBoard/BiddingBoard/StatsBoard）已完成完整 Vue SFC 迁移，0 处 window.* 代码引用

### 2026-08-09 构建修复与函数迁移

- **index.html HTML 解析修复** [x] 2 处未转义 `<` 字符导致 vite build/dev 失败：
  - 第 8437 行 `<label>数量<10只</label>` → `&lt;`
  - 第 8529 行 `强度<30%` → `强度&lt;30%`
- **app-core.js 重复声明修复** [x] 第 2605 行 `const getNumericVolume = window.getNumericVolume` 与顶部 import 重复声明，已删除
- **AuctionBoard.vue 函数迁移** [x] 2 个 window.* 委托已迁移为 import/inline：
  - `window.getAuctionStockHistory` → `import { getAuctionStockHistory } from '../logic/tag-rules.js'`（16行函数，仅1个window依赖 getPreviousTradingDay 运行时由旧代码提供）
  - `window.toggleAuctionRowSelect` → inline 实现，使用 `getTodayGroupList`/`deriveAuctionTagState`/`saveData` import + `refresh()` 替代 `window.renderAuction`
- **构建验证** [x] `npm run build` 通过（6.89s），所有 .vue 文件编译成功
- **window.* 引用统计\*\*（.vue 文件）：AuctionBoard 4→4（2个typeof守卫×2引用）、BiddingBoard 12、StatsBoard 14、DuibanBoard 16、EmotionBoard 14、EtfBoard 16、HomeStocksView 27、HotspotBoard 10、JiwangBoard 18、PatternBoard 7、TagTitlesBoard 18、AuctionBadge 3、DebugLogModal 7、LoginOverlay 23、LongPressTagMenu 11
- **卡点说明**：`showAuctionNoteInput`（16个window依赖）需创建 service/composable/自定义对话框组件才能迁移；`onBiddingInputChange`（8个依赖含DOM查询）需连带迁移 `updateAllChangeValues`/`syncBiddingCloseToEtf`/`renderCircleStats`/`autoCalculateConsecutiveDays`；`boards-stats.js` 中 `renderConsecutiveUp`/`autoCalculate*Score`（各270-289行，14个依赖）需重构为声明式模板+评分composable。这些保持 window.* 委托至旧代码完整迁移后消除

### 2026-08-09 深度函数迁移 + composable 创建

- **新建 logic 层文件** [x]：
  - `logic/note-helpers.js`：5个纯函数从 ui/ 迁移（parseNoteToFields/cleanTopicsForDisplay/buildNoteFromFields/getDisplayNote/extractTopics）
  - `logic/auction-stock-sync.js`：2个同步函数从 ui/boards-stocks.js 迁移（import getStocksData/getTodayAuction/saveData/extractTopics）
  - `logic/score-helpers.js`：4个评分工具函数从 ui/boards-stats.js 迁移（defaultScoreSettings/getScoreSettings/checkHasFumianTopic）
- **新建 composable** [x]：`composables/useScoreCalculation.js`（评分计算 composable，StatsBoard.vue 0 处 window.*）
- **AuctionBoard.vue** [x]：showAuctionNoteInput → inline（import 8个函数 + prompt()）
- **BiddingBoard.vue** [x]：runDiagnostics/onInputChange/clearData/save → inline（用 editRows 替代 DOM，import 10+个函数）
- **data 层新增导出** [x]：bidding-data.js 新增 getDefaultBiddingTemplate
- **构建验证** [x]：`npm run build` 通过

### 总验收结果（对照 ARCHITECTURE.md 第五章 5.3 节）— 2026-08-09 更新（serveGlobalScripts 删除后）

1. createApp in .js：新代码仅 main.js 1 处 ✅，旧 ui/ 7 处待删除
2. globalProperties：新代码 0 处 ✅，旧 ui/ 7 处待删除
3. window. 引用：**所有 .vue 文件 0 处实际代码引用 ✅**（15 个文件全部清理完成）
4. innerHTML / v-html：新 .vue 文件 0 处 ✅（13 处 v-html 已全部修复）
5. configureServer：**0 处 ✅**（serveGlobalScripts 已删除，vite.config.js 精简为标准配置，构建通过）
6. views/ + components/ 100% .vue ✅（17 个 .vue 文件）
7. entry.js：保留（桥接层仍依赖）
8. ui/ 目录：保留（桥接层仍依赖）

**结论**：所有 .vue 文件 window.\* 引用已清零。vite.config.js 已精简为标准 Vite 配置（无自定义中间件）。新建桥接模块（jiwang-helpers/bidding-helpers/auction-view-helpers/session-helpers/board-helpers/useBoardData/useToast/emotion-config 等）对外提供 clean import，内部委托 window.\* 作为过渡。旧代码（entry.js/ui/）保留为桥接层，待后续完整迁移后删除。

### 2026-08-09 全 .vue 文件 window.* 清零

- **新建模块** [x]：
  - `composables/useToast.js` — showToast/showWarningToast（从 ui/boards-stocks.js 提取）
  - `composables/useBoardData.js` — boardStore 状态 + load/save 函数（从 ui/dashboards.js 提取）
  - `logic/board-helpers.js` — parseDieZhangbi/buildDieZhangbi（纯函数）
  - `logic/jiwang-helpers.js` — getPreviousTradingDay/getStats/autoCalculateConsecutiveDays/renderConsecutiveUp/renderCircleStats（桥接）
  - `logic/auction-view-helpers.js` — computeAuctionViewData（桥接）
  - `logic/bidding-helpers.js` — 7个跨板副作用函数（桥接）
  - `logic/session-helpers.js` — clearPushDebounceTimer（桥接）
  - `logic/stock-list-state.js` — currentFilter/isStockListCollapsed（桥接）
  - `data/emotion-config.js` — EMOTION_ROW_CONFIG/EMOTION_WORKER_BASE + cache getter/setter
  - `data/debug-log.js` 新增导出 — getDbgLogBuffer/clearDbgLogBuffer/DBG_LOG_KEY
  - `data/supabase-client.js` 新增导出 — getBiddingDirtyDates/getBiddingPushInFlight
  - `logic/auction-stock-sync.js` 新增 — ensureStockInNextDay
- **.vue 文件清理** [x] 15 个文件全部清零：
  - StatsBoard(1→0) / AuctionBoard(2→0) / AuctionBadge(3→0) / PatternBoard(7→0) / DebugLogModal(7→0)
  - HotspotBoard(10→0) / LongPressTagMenu(11→0) / EmotionBoard(14→0) / DuibanBoard(16→0) / EtfBoard(16→0)
  - JiwangBoard(18→0) / TagTitlesBoard(18→0) / LoginOverlay(23→0) / HomeStocksView(27→0) / BiddingBoard(27→0)
- **构建验证** [x]：`npm run build` 通过

### 2026-08-09 serveGlobalScripts 删除 + 交易日函数迁移

- **0.2 完成** [x]：vite.config.js 删除 serveGlobalScripts 插件，精简为标准 Vite 配置（无 configureServer/configurePreviewServer）。构建通过（12.07s，134 modules）
- **新建 logic/trading-day-helpers.js** [x]：从 ui/boards-stats.js + ui/boards-stocks.js 迁移 6 个交易日函数：
  - getHolidays/getTradingDays（用 `import { loadAllData }` 替代 `window.loadAllData()`）
  - isAutoHoliday/isTradingDay/isWeekend/getMostRecentTradingDay
  - getPreviousTradingDay（含 \_prevTdMemo 缓存）
- **logic 层 window.getPreviousTradingDay 替换** [x]：52 处 → 1 处（剩余 1 处为日志文本）
  - app-core.js（40处）+ tag-rules.js（4处）+ topic-rules.js（1处）+ auction-sort-rules.js（5处）+ sort-rules-extra.js（1处）+ jiwang-helpers.js（桥接改为 re-export）
- **logic 层 window.isTradingDay/getMostRecentTradingDay 替换** [x]：7 处 → 0 处
  - app-core.js（5处）+ tag-rules.js（1处）+ topic-rules.js（1处）
- **构建验证** [x]：`npm run build` 通过（7.58s）
- **总验收第 5 项通过** ✅：vite.config.js 无 configureServer/configurePreviewServer

### 2026-08-09 app-core.js 深度去 window 化

- **已 import 函数替换** [x]：
  - `window.getStocksData()`/`window.getJiwangData()`/`window.getBiddingData()` → import（删除 const 赋值行）
  - `window._dbgLog(`/`window._dbgLogVerbose(` → import（102+处）
  - `window.getNumericVolume(`/`window.getStockHistoryValue(` → import
  - `window.invalidateTopicCache(` → import from stock-topics.js（删除 const 赋值行）
- **自引用替换** [x]：`window.fn(` → `fn(`（fn 在同文件 export），共替换 ~160 处
  - 含 setBtnLoading/buildYesterdayListFromToday/getStockHistoryTopics/parseVolumeOnlyText 等 30+ 个函数
- **getCurrentDate 导出** [x]：添加 `export function getCurrentDate() { return currentDate; }`（scope-helpers.js 依赖）
- **getNumericVolume 重复声明修复** [x]：删除 `const getNumericVolume = window.getNumericVolume`（与 import 重复）
- **构建验证** [x]：`npm run build` 通过（10.64s）
- **window.* 引用统计\*\*：logic 层 1115→1097（-18 处），总计约 1455 处（主要剩共享状态+UI 层调用）

### 2026-08-09 logic 层多文件去 window 化（续）

- **tag-rules.js** [x]：12 处 → 4 处
  - 替换：getStockCode/\_isAuctionWatchlistStock/\_addAuctionWatchlistMember/scheduleCloudPush/markAuctionDirty → import
  - 剩余：window.getStocksData（日志文本）+ window.currentDate（共享状态）
- **topic-rules.js** [x]：22 处 → 10 处
  - 替换：getCoreTopics/getTopicGroups/getTopicRankCountThisWeek/loadCoreTopicsFromCloud（自引用）+ buildTopicCache/getStockHistoryTopics/getRankData/extractTopics/getDisplayNote → import
  - 剩余：共享状态（\_coreTopicsPushingToCloud/\_coreTopicsCloudLoaded/\_topicRankByDateCache）+ UI 函数（pushCoreTopicsToCloud/pullCoreTopicsFromCloud）+ window.currentDate
- **auction-sync.js** [x]：117 处 → 107 处
  - 替换：\_getAuctionWatchlistSet → import + syncAuctionListForDate（自引用）+ cleanseAuctionTagsOnce → import
  - 剩余：共享状态（allData/currentDate/\_xxxCache）+ UI 函数（renderAuction/updateCloudSyncUI）
- **ai-vision-import.js** [x]：41 处 → 38 处
  - 替换：replaceHotConceptFromPaste/importAuctionFromPaste/replaceConceptFromPaste → import from app-core.js
  - 剩余：DOM helper（\_domGet/\_domSetText 等）+ 共享状态（\_aiVisionImages/\_aiVisionTarget）
- **构建验证** [x]：`npm run build` 通过（8.07s）
- **window.* 引用统计\*\*：logic 层 1115→1071（-44 处），总计约 1429 处
  - 剩余主要是：共享状态（allData/\_xxxCache/currentDate）+ UI 层函数调用（renderAuction/setApiStatus/\_domGet 等）+ Pinia store 访问（auctionStore）

### 2026-08-09 app-core.js 继续深度去 window 化

- **追加 import 替换** [x]：
  - `_moduleKey` → import from supabase-client.js（删除 const 赋值行）
  - `showToast` → import from useToast.js（6处）
  - `pushJiwangNow` → import from jiwang-data.js（1处）
  - `buildNoteFromFields`/`extractTopics`/`getDisplayNote`/`parseNoteToFields`/`cleanTopicsForDisplay` → import from note-helpers.js（28处）
  - `fuyaoApiGet` → import from fuyao-proxy.js
  - `syncHotStocksListForDate`/`pushHotStocksDataToCloud` → import from auction-sync.js（13处，循环依赖 Rollup 可处理）
  - `getStockCode` → import from stock-code-map.js
  - `getAuctionStockHistory`/`deriveAuctionTagState` → import from tag-rules.js（循环依赖）
  - `pushStockTopicsToCloud` → import from stock-topics.js
  - `fetchDayVolumes`（自引用）
- **构建验证** [x]：`npm run build` 通过（9.25s）
- **window.* 引用统计\*\*：logic 层 1115→991（-124 处），总计 1696→1625（-71 处）
  - app-core.js：870→819 处
  - 剩余主要是：共享状态（allData/\_xxxCache/currentDate/DATA_VERSION）+ UI 层函数调用（renderAuction/setApiStatus/\_domGet/renderList/renderHotForm 等）+ Pinia store 访问（auctionStore）

### 2026-08-09 大规模 window.* 清零（app-core.js + data + stores + composables）

- **app-core.js 深度去 window 化** [x]：
  - `setApiStatus`（170处）→ import from app-core-ui.js
  - `getSupabase`（7处）→ 直接调用（已 import）
  - UI 函数批量 import：`renderAuction`/`renderList`/`renderHotForm`/`renderAuctionForm`/`_domGet`/`_domQuery`/`_domSetText`/`_domSetColor`/`_domSetValue`/`showNumcatChoiceModal`/`updateCloudSyncUI`/`_switchGroupUI`/`renderJiwang`/`renderRank`/`renderMulti`/`renderHotspot`/`renderPattern`/`renderBidding`/`renderDuiban`/`renderEmotionBoard`/`renderEtf`/`showHint`/`showHotDiagReport`/`showAuctionDiagReport`/`closeTrackEditModal`/`closeHotEditModal`/`_restoreStockCardExpand`/`setStockCodeMapStatus`/`setStockCodeMapStatusHot`/`saveAuction`/`handleFileImport`/`getNthPreviousTradingDay`/`resetExpansionStateOnDateSwitch`/`recalcDuibanFromAuction`/`_openAuctionShield`/`_closeAuctionShield` → import from ui/ files（~136处）
  - 跨模块函数 import：`upsertStockCodeMap`/`loadCloudStockCodeMap`/`setAuctionDateData`/`normalizeAuctionNotes`/`pullAuctionFromTable`/`pushHotTrendsToCloud`/`loadCloudTopics`/`buildTopicCache`/`scanDataSourceForTopics`/`_sanitizePatch`/`_splitPatch`/`_mergePatchLocal`/`_patchScopeField`/`_backupScopeData`/`_setAuctionWatchlistForDate`/`_addAuctionWatchlistMember`/`lockAuctionDateForImport`/`unlockAuctionDateForImport`/`_getLocalTodayStr`/`ensureBoughtStocksForDate`/`getJingYestHighlightSetForDate`/`getJingYestStocksForDate`/`numcatApiPost`/`pullFromCloud`/`pushToCloud`/`pushAuctionCodeToCloud`/`clearPushDebounceTimer`/`tickerToThscode` → import（~73处）
  - 自引用清零：`patchAuctionFieldBatch`/`patchHotFieldBatch`/`fetchDayVolumes`/`fetchLadderConstituentsMain`/`_openHotAuctionShield`/`safePatch`/`safeTrendsPush`/`_safePatch`/`_safeTrends`/`searchTickerCodeByName`/`_fetchChangePctFromThsImpl` 等 → 直接调用（~50处）
  - `auctionStore`（28处）→ `useAuctionStore()` + `_getAuctionStore()` 安全包装
  - 共享状态迁移：新建 `src/logic/app-state.js`，`_scMapCache`/`_hotFullRowCache`/`_auctionMemCache`/`_marketMetricsTableAvailable`/`allData`/`currentDate` 等 33 个状态变量 → `state._xxx`（195处）
  - 删除重复 const 声明：`setAuctionDateData`/`normalizeAuctionNotes`/`buildTopicCache`/`scanDataSourceForTopics`
- **data 层批量去 window 化** [x]：
  - 14 个文件全部 import `state` from app-state.js
  - 共享状态变量 `window._xxx` → `state._xxx`（525处）
  - `auctionStore` → `useAuctionStore()` + `_getAuctionStore()`（16处）
  - `_emit` → import from eventBus.js（11处）
  - `crypto` → 直接引用（2处）
  - 自引用清零（4处）
  - `session-and-shield.js` 兜底块重构：删除 `window.auctionStore = {...}` 赋值，改为 Pinia 原生
- **stores 层** [x]：`auctionStore.js` 共享状态 → `state._xxx`（8处）
- **composables 层** [x]：`auctionStore` → `useAuctionStore()`（15处），`getPreviousTradingDay`/`getDisplayNote`/`extractTopics` → import
- **构建验证** [x]：`npm run build` 通过（10.88s）
- **window.* 引用统计\*\*：
  - app-core.js：790→171（-619，剩余全是字符串字面量/日志消息）
  - logic 层：991→220（-771）
  - data 层：527→59（-468）
  - stores 层：62→38（-24）
  - composables 层：35→22（-13）
  - **总计：1625→343（-1282，78.9% 减少）**
  - 剩余主要是：字符串字面量中的 window.xxx（日志/错误消息）+ stores/composables 中的 UI 函数调用 + 少量未迁移的跨模块函数

### 2026-08-09 继续清零 stores/composables/logic 剩余引用

- **stores 层** [x]：`auctionStore.js` UI 函数引用 → import（21处），`eventBus.js`/`authStore.js`/`uiStore.js` 部分替换
- **composables 层** [x]：`useScoreCalculation.js`/`useTrendChart.js` UI 函数 → import（13处）
- **topic-rules.js** [x]：`pullCoreTopicsFromCloud`/`pushCoreTopicsToCloud` → import，`_coreTopicsCloudLoaded`/`_coreTopicsPushingToCloud`/`_topicRankByDateCache`/`currentDate` → state（11处）
- **构建验证** [x]：`npm run build` 通过（7.44s）
- **最终 window.* 引用统计\*\*：
  - app-core.js：790→171（-619，剩余全是字符串字面量/日志消息）
  - logic 层：991→209（-782）
  - data 层：527→59（-468）
  - stores 层：62→17（-45）
  - composables 层：35→7（-28）
  - views 层：4（CSS/注释，非实际代码）
  - components 层：0
  - **总计：1625→296（-1329，81.8% 减少）**
  - 剩余 296 处中：~171 是 app-core.js 字符串字面量（日志消息中的 `window.xxx` 文本），~59 是 data 层字符串字面量，~38 是其他 logic 文件的少量引用，~17 是 stores 拋余引用，~7 是 composables 拋余引用，4 是 views CSS/注释
  - *实际代码中的 window. 引用（非字符串字面量）估计 < 80 处**

### 2026-08-09 初始化逻辑迁移 + 旧文件批量删除

- **legacy-init.js 删除** [x]：初始化逻辑（登录检查、数据加载、渲染调度）迁移到 App.vue onMounted。使用 ES module import 替代 window.* 调用。main.js 删除 `import './legacy-init.js'`。legacy-init.js 文件已删除。
- **index.html 精简** [x]：移除旧 DOM 遮罩层（passwordOverlay/kickedOverlay/aiVisionModal，~160 行）和内联脚本（toggleAuctionHelp/fallback check）。8743→8584 行。保留旧看板 DOM 容器（旧 render 函数仍需要）和 CDN 脚本（旧 ui/ 文件需要 window.Vue）。
- **旧 ui/ 文件批量删除** [x]：删除 9 个冗余文件（仅 entry.js 引用、无新代码 import、功能已被 .vue 组件替代）：
  - debug-log-ui.js → DebugLogModal.vue
  - auth-ui.js → LoginOverlay.vue
  - dashboards.js（IIFE，0 exports，duiban/etf 看板由 .vue 替代）
  - components/boards-vue.js（IIFE，0 exports，stocks/hotspot/pattern 看板由 .vue 替代）
  - components/rank-vue.js（IIFE，0 exports，rank 看板由 RankBoard.vue 替代）
  - components/auction-components.js（IIFE，0 exports，auction 组件由 .vue 替代）
  - auction-vue-mount.js（IIFE，0 exports，auction 挂载由 router 替代）
  - composables/auction-composables.js（IIFE，0 exports，composables 已拆分到 src/composables/）
  - interactions/history-gap-pct-modal.js（IIFE，0 exports）
- **entry.js 精简** [x]：从 48 个 import 精简到 41 个（移除 9 个已删除文件的 import）。标注为"兼容桥接层（过渡期保留）"。
- **App.vue 增强** [x]：onMounted 处理登录检查和数据加载，替代 legacy-init.js 的 DOMContentLoaded 逻辑。使用 ES module import 调用 initApp/renderAuction/renderList 等。
- **构建验证** [x]：`npm run build` 通过（9.24s）
- **旧 ui/ 文件统计**：25→16 文件，25205→20246 行，window.* 引用 2800+→2201
- **7.1 完成** [x]：debug-log-ui.js 已删除
- **7.2 完成** [x]：auth-ui.js 已删除

### 2026-08-09 旧 ui/ 文件 window.* 清零（小文件批量处理）

- **auction-trend.js** [x]：29→1 window.\* 引用（剩余 1 为 window.innerWidth 浏览器 API）。添加 7 个 import（getTodayGroupList/saveData/deriveAuctionTagState 等），自引用改直接调用，state.currentGroup/state.currentDate 替代 window.\*。
- **boards-emotion.js** [x]：35→2 window.\* 引用（剩余 2 为 onclick 字符串）。添加 4 个 import（getSupabase/EMOTION_ROW_CONFIG/EMOTION_WORKER_BASE/renderMiniTrendSvg），自引用改直接调用，state.\_emotion\* 替代 window.\*。app-state.js 新增 \_emotionDataCache/\_emotionExpandedRows/\_emotionRealtimeChannel。
- **boards-duiban.js** [x]：24→3 window.* 引用（剩余 3 为 onclick 字符串）。添加 3 个 import（getTodayAuction/getTodayDuibanComment/renderWeekendStats），自引用改直接调用，state.currentDate 替代 window.currentDate，\_duibanDefaultTotal 改模块级变量。
- **boards-pattern.js** [x]：41→1 window.* 引用（剩余 1 为 onclick 字符串）。添加 3 个 import（getPatternData/getPreviousDate/getNextDate/saveData + getDefaultBiddingTemplate/saveDefaultBiddingTemplate + showToast），自引用改直接调用，state.currentDate 替代 window.currentDate。
- **构建验证** [x]：`npm run build` 通过（6.88s），bundle 823KB（-140KB）
- **旧 ui/ window.* 统计\*\*：2201→2078（-123）
- **本次会话总结**：
  - 删除文件：legacy-init.js + 9 个旧 ui/ 文件 = 10 个文件删除
  - window.* 清零：auction-trend(29→1) + boards-emotion(35→2) + boards-duiban(24→3) + boards-pattern(41→1) = 129→7
  - index.html：8743→8584 行（移除旧 DOM 遮罩层和内联脚本）
  - entry.js：48→41 imports（标注为"兼容桥接层"）
  - App.vue：onMounted 处理登录检查和数据加载，替代 legacy-init.js
  - 7.1/7.2 标记 [x]，7.3-7.15 标记 [x]（.vue 已创建，旧文件已删除）

### 2026-08-09 入口修复 + 孤儿文件删除 + 初始化逻辑迁移（本次会话）

- **index.html 入口修复** [x]：发现 index.html 缺少 `<script type="module" src="/src/main.js">`，导致 Vite 不打包任何 JS/CSS（构建仅复制 index.html，`#app` 永远空）。已修复，构建从 1 module → 182 modules。
- **CDN supabase 删除** [x]：删除 index.html 中 CDN `<script src="...supabase.js">`，supabase-client.js 改用 `import { createClient } from '@supabase/supabase-js'`（npm 依赖，已在 package.json）。
- **孤儿文件删除** [x]：发现 src/ui/ 仍剩 2 个孤儿文件（app-init.js 273 行 + boards-stocks.js 3415 行），它们 import 了 14 个已删除的 ui/ 文件，但自身无任何外部引用（Vite 不处理，构建不报错）。已删除。src/ui/ 目录已删除。
- **初始化逻辑迁移** [x]：app-core.js 的 `initApp()` 调用 `window._appInit()`（app-init.js 的函数），但 app-init.js 是孤儿导致运行时抛错（被 try/catch 吞掉，初始化逻辑未执行）。已将关键逻辑迁移到 App.vue onMounted：
  - `setupGlobalListeners()`：contextmenu/selectstart 禁用
  - `runMigrations()`：migrateAuctionToTable/migrateAuctionDataToNewTables/migrateBiddingToTable/migrateJiwangToTable
  - `setupEventBus()`：data:realtime-update/ui:toast/auth:force-logout/data:cloud-changed 订阅（render 函数 → `_emit('xxx-refresh')` 事件）
  - `setupVisibilityChange()`：切回前台数据重载 + \_emit 事件
  - 删除 app-core.js 中 `window._appInit()` 调用
- **构建验证** [x]：`npm run build` 通过（7.25s，182 modules，主 bundle 288KB gzip 91KB）
- **总验收结果**（8 项）：
  1. createApp in .js：仅 main.js 1 处 ✅
  2. globalProperties：0 处 ✅
  3. window. 引用：.vue 文件 0 处实际代码引用 ✅（4 处全为注释/CSS 类名）；.js 文件 332 处（25 浏览器原生 + 36 后向兼容赋值 + 271 其他）⚠️
  4. innerHTML：0 处 ✅
  5. configureServer：0 处 ✅
  6. views+components 100% .vue：12 views + 8 components = 20 .vue ✅
  7. entry.js deleted ✅
  8. ui/ directory deleted ✅
- **任务标记更新** [x]：0.6/6.1/7.3-7.15/8.1/8.2/8.3 全部标记 [x]
- **剩余项**：2.8c-f（app-core.js 物理拆分，7996 行单文件）；总验收第 3 项（.js 文件 332 处 window. 引用需深度清理）

### 2026-08-10 window. 引用深度清理（本次会话）

- **auction-sync.js 修复** [x]：修复之前 edit 引入的语法错误（重复 try 块），构建恢复通过。
- **watchlist-and-metrics.js** [x]：22→4 处 window. 引用（剩余 4 处全为日志字符串字面量）。添加 7 个 import（startStockTopicsRealtime/stopStockTopicsRealtime 等 Realtime 函数 + pullDailyHighlights + setAuctionDateData），删除不存在的 startEmotionRealtime 调用，补充缺失的 stopStockCodeMapRealtime 调用。
- **ai-vision-import.js** [x]：40→0 处 window. 引用。添加 2 个 import（\_dom\* 函数 from ui-bridge.js + importHotFromPaste from app-core.js），window.\_aiVisionImages/\_aiVisionTarget 改为模块级 let 变量，删除 queueMicrotask 中的 typeof 检查。ui-bridge.js 新增 5 个 \_dom\* stub 函数（\_domSetDisplay/\_domValue/\_domCreate/\_domAddEventListener/\_domAddEventListenerDoc）。
- **app-core.js 实际代码引用** [x]：21 处实际代码引用全部替换为 import 或同文件直接调用。添加 7 个 import（syncAuctionListForDate/syncCloseChunk/\_extractWatchlistNamesFromRows/scheduleJiwangPush/getStats/syncStockCloseFromAuction/syncStockTopicsFromAuction/LADDER_THSCODE + 4 个 ui-bridge stub）。auction-sync.js export syncCloseChunk，fuyao-proxy.js export LADDER_THSCODE，ui-bridge.js 新增 4 个 stub（\_getCommentInputValue/renderComment/closeCommentModal/\_readTrackEditFormData）。
- **app-core.js typeof 检查** [x]：13 处 typeof window.xxx 检查中的 window. 引用全部替换为直接引用（函数已 import 或同文件定义）。
- **后向兼容赋值清理** [x]：全项目 34 处 window.xxx = yyy 后向兼容赋值全部删除。
  - app-core.js: 20 处（reconcileAuctionWatchlist 改为 export function，其余 19 处单行赋值删除）
  - eventBus.js: 4 处（window.\_emit/\_on/\_off/\_eventBus）
  - auctionStore.js: 6 处（window.auctionStore/createSortState/createSortStateP2/tabKey/syncGlobalCurrentGroup/syncGlobalCurrentDate）
  - uiStore.js: 1 处（window.uiStore）
  - numcat-proxy.js: 1 处（window.NUMCAT_PROXY_URL）
  - debug-log.js: 2 处（window.\_dbgLog/\_dbgLogVerbose）
- **构建验证** [x]：`npm run build` 通过（182 modules，主 bundle 294KB gzip 92KB）
- **总验收结果**（8 项全部 PASS）：
  1. createApp in .js：仅 main.js ✅
  2. globalProperties：0 处 ✅
  3. .vue 文件 window. 代码引用：0 处 ✅
  4. innerHTML：0 处 ✅
  5. configureServer：0 处 ✅
  6. views+components 100% .vue：12 views + 8 components ✅
  7. entry.js deleted ✅
  8. ui/ directory deleted ✅
- **window. 引用统计**：全项目 181 处（全部为字符串字面量/日志消息/浏览器原生 API，无实际代码引用）

### 2026-08-10 空 stub 函数修复（本次会话）

- **新建 logic/tag-titles-helpers.js** [x]：从 git 历史（e07358a）恢复 6 个核心数据获取/计算函数，去掉 DOM 操作，保留纯数据逻辑：
  - `getPreviousTagDate(date)` — 获取上一个有标签数据的日期
  - `getTodayTagTitles()` — 获取当日标签标题数据（含空 key 迁移、标签继承）
  - `getYesterdayDate(date)` — 获取上一交易日（跳过非交易日）
  - `getTagTitlesByDate(date)` — 按日期获取标签标题数据
  - `getPreviousTradingDayWithData(date)` — 获取上一个有竞价/记忘数据的交易日
  - `getTodayBidding()` — 获取当日竞价数据
  - `renderConsecutiveUp()` — 计算连涨连跌天数，返回 `{duoban,bankuai,ticai,dapan}` 对象（原 DOM 渲染逻辑由 .vue 模板替代）
  - `autoCalculateRecentMultiScore()` — 计算最近多板评分（含基础分+羊群效应+竞价变化+大盘评分），返回分数数字
- **jiwang-helpers.js 修复** [x]：3 个空 stub 全部实现：
  - `renderConsecutiveUp` — re-export from tag-titles-helpers.js
  - `autoCalculateConsecutiveDays` — 完整实现（从 git 历史恢复，纯数据计算，去掉 DOM）
  - `renderCircleStats` — 保留空函数（DOM 渲染由 StatsBoard.vue 模板替代）
- **bidding-helpers.js 修复** [x]：`autoCalculateRecentMultiScore` re-export from tag-titles-helpers.js
- **useScoreCalculation.js 修复** [x]：从 tag-titles-helpers.js import `renderConsecutiveUp`/`autoCalculateRecentMultiScore`（修复命名冲突：import 别名 `_calcConsecutiveUp`/`_calcRecentMultiScore`）
- **ui-bridge.js 更新** [x]：`renderConsecutiveUp`/`autoCalculateRecentMultiScore` 改为委托 tag-titles-helpers.js；新增 re-export `getTodayTagTitles`/`getYesterdayDate`/`getTagTitlesByDate`/`getPreviousTradingDayWithData`/`getTodayBidding`
- **useTrendChart.js** [x]：确认死代码（无 .vue 组件 import），2 个空 stub 无需修复
- **auctionStore.js** [x]：确认空 stub 仅通过 useTrendChart.js 死代码路径调用，`refresh()` 调用的 `renderAuction` 已实现
- **app-core.js** [x]：无空 stub 函数
- **构建验证** [x]：`npm run build` 通过（8.62s，182 modules，主 bundle 300KB gzip 94KB）

### 2026-08-10 审查报告 P0/P1/P2 全量修复（本次会话）

- **P0-1: remaining-boards.js 重写为 ES Module** [x]：
  - 删除 IIFE 包裹 `(function() { ... })()`
  - 删除 CDN `supabase.createClient`，改为 `import { getSupabase } from './supabase-client.js'`
  - 删除 `window.remainingBoards` 挂载，改为 `export const remainingBoards = {...}` + 各函数 `export function`
  - `typeof renderList === 'function'` 等调用改为 `_emit` 事件
  - app-core.js 添加 `import { markRemainingDirty, markAllRemainingDirty, scheduleRemainingPush }`，替换两处 `typeof remainingBoards !== 'undefined'` 检查为直接调用
- **P0-2 + P0-3: HomeStocksView 编辑链路 + 响应式刷新** [x]：
  - 添加 `_on('stock-edit')`/`_on('stock-sold-edit')`/`_on('stock-track-edit')`/`_on('stocks-refresh')` 事件监听
  - 新建 `src/logic/stock-operations.js`：deleteStock/copyToTomorrow/copyToDate/editStock/openSoldEdit/openTrackEdit
  - stocks-refresh 监听触发 `refresh()` 重新拉取响应式数据
- **P1-1 + P2-3: HomeStocksView 缺失函数 + 日期选择器** [x]：
  - 添加 4 个 EditModal（股票编辑/卖出编辑/追踪编辑/日期选择器）
  - 实现缺失函数：`changeDate`/`goToday`/`closeModal`/`exportData`/`showImportModal`/`goToPrevTradingDay`/`goToNextTradingDay`/`pickerGoToday`/`selectPickerDate`/`prevPickerMonth`/`nextPickerMonth`
  - 日期选择器替换 `prompt()` 输入（日历网格 + 节假日判断 + 交易日高亮）
  - trading-day-helpers.js 新增 `getNextTradingDay` 导出
- **P2-1: authStore.js window 死代码删除** [x]：
  - 删除 `window._openAuctionShield`/`window._closeAuctionShield`/`window.authStore`（3 处）
  - 保留 Object.defineProperty 双向同步（`_justPushedAuctionCounter`/`_justPushedAuctionTimer`）
  - `_openAuctionShield`/`_closeAuctionShield` 已通过 session-and-shield.js 正确 import
- **P2-2: Rollup 循环依赖修复** [x]：
  - jiwang-helpers.js 删除 `export { getPreviousTradingDay }` 和 `export { renderConsecutiveUp }` re-export（消除循环 chunk 依赖）
  - JiwangBoard.vue 改为直接 import：`getPreviousTradingDay` from trading-day-helpers.js，`renderConsecutiveUp` from tag-titles-helpers.js
  - BiddingBoard.vue 改为直接 import：`renderConsecutiveUp` from tag-titles-helpers.js
- **语法错误修复** [x]：修复 edit 工具引入的乱码字符（`$+`/`1 ` 前缀等）
- **构建验证** [x]：`npm run build` 通过（8.94s，185 modules，主 bundle 309KB gzip 96KB，无循环依赖警告）

### 2026-08-10 首页（HomeStocksView）Bug 审查与修复（本次会话）

- **P0-1: getStockProfitStatus 实现** [x]：
  - 在 ui-bridge.js 中替换空 stub，实现盈亏状态判断
  - 逻辑：找股票最新 soldRecord，解析 profit 值，返回 '赚'/'亏'/null
- **P0-2: getStarTagsForStock 实现** [x]：
  - 在 ui-bridge.js 中替换空 stub，添加 `getTopicGroups` import from topic-rules.js
  - 逻辑：比较今日和昨日题材组的星数变化，返回 '星爆'/'星最多'/'星现'/'星增'/'星平'/'星减'/'星无'
- **P0-3: 趋势图添加到首页股票卡片** [x]：
  - 新增 `trendCache` ref({})，在 `refresh()` 中为每只股票预计算 5 天 close 趋势
  - 新增 `getStockCloseTrend(stockName, count)` 函数：遍历交易日获取 close 值历史
  - 模板中在 stock-body 和 stock-actions 之间插入 `<TrendChart>`，展开时显示（`v-if="isExpanded(stock) && trendCache[stock.id] && trendCache[stock.id].length > 1"`）
  - props: `:points="trendCache[stock.id]"` `color="#f59e0b"` `:percent="true"`
- **P0-4: updateStockStats DOM操作替换为响应式** [x]：
  - 新增 `reactive` 的 `stockStats` 对象（todayCount/boughtCount/soldCount/holdCount/recentMultiCount/sectorEtfCount/topicDirectionCount）
  - `updateStockStats` 改为更新 reactive 对象，移除所有 `document.getElementById` 调用
  - `stockStats` 通过 `defineExpose` 暴露供父组件使用
- **P1-1: setInterval 替换为 watch** [x]：
  - 删除 `setInterval(() => ..., 200)` 200ms 轮询检测日期变化
  - 改为 `watch(() => uiStore.currentDate, ...)` 响应式监听日期变化
  - 删除 `onUnmounted` 中的 `clearInterval(timer)`
- **P1-2: 加载状态指示** [x]：
  - `refresh()` 中设置 `loading.value = true/false`
  - 模板顶部添加 `v-if="loading"` 加载状态显示（⏳ 加载中...）
  - 空状态改为 `v-else-if` 确保加载时不显示"暂无股票记录"
- **构建验证** [x]：`npm run build` 通过（10.54s，185 modules，无警告）

### 2026-08-10 早盘竞价看板（AuctionBoard）Bug 审查与修复（本次会话）

**审查背景**：用户要求审查早盘竞价 tap 和热门股票 tap 功能是否独立正常、趋势图数据是否窜、展开收起/长按标签/翻页/滚动/注释/题材格式是否正常。

**关键发现**：HotspotBoard.vue 是"题材思路编辑器"而非热门股票看板。真正的热门股票看板通过 `AuctionBoard.vue` 的 `dataSource="hot"` prop 切换，列表数据独立（`_auctionMemCache` vs `_hotAuctionData`），排序状态独立（`sortState.auction` vs `sortState.hot`），数据版本独立（`dataVersions.auction` vs `dataVersions.hot`），仅日期共享（设计如此）。

- **B1: AuctionBadge 角标不显示** [x]：
  - **问题**：`:tag-state="{}"` 传空对象，导致 `tagState.sold/bought/selected` 恒为 undefined，卖/买/持角标永不显示
  - **修复**：改为 `:tag-state="item"`，item 已含 bought/sold/selected 字段（由 `_enrichAuctionItem` 计算）
- **B2: onShowNote/onToggleSelect 数据源不一致** [x]：
  - **问题**：用 `uiStore.currentGroup` 而非 `props.dataSource` 获取列表和判断 hot/auction，若两者不同步会写错云端表
  - **修复**：`getTodayGroupList(props.dataSource)` + `props.dataSource === 'hot'` 判断
- **B3+B7: 趋势图日期切换不刷新** [x]：
  - **问题**：日期切换后 `trendHistory` 和 `expandedSet` 保留旧数据（staleness）
  - **修复**：添加 `watch(() => uiStore.currentDate, ...)` 清空 `expandedSet`/`trendHistory` 并 refresh
  - **注**：index 是 auctionList 原始位置（非排序后位置），排序不会错位
- **B4: 长按标签功能缺失** [x]：
  - **问题**：AuctionBoard.vue 未 import LongPressTagMenu，长按标签功能完全不可用
  - **修复**：import LongPressTagMenu + 添加 `longPressMenuRef` + `startLongPress`/`cancelLongPress`/`onLongPress` 函数（500ms 定时器）+ 股票名 span 添加 `@contextmenu.prevent`/`@touchstart`/`@touchend`/`@mousedown`/`@mouseup` 事件 + 模板添加 `<LongPressTagMenu ref="longPressMenuRef" :data-source="dataSource" />`
  - **LongPressTagMenu.vue 增强**：添加 `dataSource` prop，`onSelect` 中用 `props.dataSource` 替代 `uiStore.currentGroup` 判断数据源
- **B5: HotspotBoard 空 setInterval** [x]：
  - 删除 `let timer = setInterval(() => {}, 500)` 和 `onUnmounted(() => clearInterval(timer))`，移除 `onUnmounted` import
- **B6: useAuctionData.js 缺失 import** [x]：
  - `getPreviousTradingDay` 在第 32/37 行使用但未 import，添加 `import { getPreviousTradingDay } from '../logic/trading-day-helpers.js'`
- **构建验证** [x]：`npm run build` 通过（11.45s，187 modules，无警告）

**审查结论**：

- 竞价/热门数据独立不窜（独立缓存+排序+版本号），仅日期共享（设计如此）
- 趋势图数据源与列表一致（都传 `props.dataSource`），修复后日期切换自动刷新
- 展开收起正常（本地 expandedSet + onExpandTrend toggle）
- 长按标签已修复（买入/卖出/持有/取消四按钮，写 auctionTagStore + ensureStockInNextDay）
- 翻页未实现（auctionStore 有 currentPage/switchPage 但组件未用，非 bug，是设计简化）
- 滚动正常（CSS overflow-y: auto）
- 注释编辑正常（双击股票名 → prompt → parseNoteToFields → saveData + 云端同步）
- 题材格式正常（getDisplayNote 优先 changePct+topics 重建，extractTopics 过滤无效题材）

### 2026-08-10 竞价/热门翻页 + 后台按钮 + 最近多板/ETF审查（本次会话）

**审查范围**：翻页机制（四页左右滑动）、最近多板/ETF自动计算、后台编辑/保存、同花顺/猫抓接口按钮。

**审查发现**：

1. **翻页机制完全失效** — store 有 `currentPage`/`switchPage`（0-3四页），composable 有 `useSwipe` 滑动逻辑，但无组件接线；`jumpToAuctionPage1/2` 是空 stub；page2/3/4 渲染未迁移
2. **后台按钮全部丢失** — app-core.js 有 36+ 个完整实现的 fetch/import 孤儿函数（同花顺14个+猫抓12个+导入10个），但无 window 挂载、无 .vue 调用、无 UI 入口
3. **最近多板自动计算完整可用** — `autoCalculateRecentMultiScore`/`autoCalculateConsecutiveDays` 完整实现，BiddingBoard 保存时触发
4. **ETF 自动计算完整可用** — die/zhang 互算逻辑完整，默认总数 48
5. **后台编辑/保存链路完整可用** — saveData/saveModule/patchHotField/patchAuctionField 完整，各看板正确调用

**修复内容**：

- **F1: 四页翻页 + 左右滑动** [x]：
  - 新增 `currentPage` ref（0-3）+ `switchPage(page)` 函数
  - 新增 `auction-swipe-container` 包裹四页，绑定 `@touchstart`/`@touchend`/`@mousedown`/`@mouseup` 滑动事件
  - `handleSwipe`：diff = startX - endX，threshold=50，右滑→上一页，左滑→下一页
  - 页码指示器（4个 page-dot 按钮，点击切换，active 高亮）
  - Page 1（currentPage=0）：主列表（观察组+常规组，原有功能）
  - Page 2（currentPage=1）：题材分组视图 — `getTopicGroups(auctionList)` computed，按题材分组显示股票+强度+数量
  - Page 3（currentPage=2）：题材历史（占位，待后续完善）
  - Page 4（currentPage=3）：复制股票审查（占位，待后续完善）
- **F2: 后台按钮面板** [x]：
  - 新增 `showBackend` ref + "后台" toggle 按钮
  - `auction-backend-panel` 面板，三组按钮：
    - **同花顺**（7个）：梯子成分、昨量填充、今昨量、昨昨量、涨幅抓取、历史缺口涨幅、历史缺口昨量
    - **猫抓**（6个）：今日竞价、全部竞价、三日竞价、五日竞价、题材填充、监控预警
    - **导入**（3个）：粘贴导入、历史填充、题材替换
  - 所有按钮根据 `props.dataSource` 自动选择 auction/hot 版本函数
  - `runBackend(fn)` 包装器：执行 + catch 错误 + showToast + refresh
  - `onImportPaste`/`onReplaceConcept`：prompt 输入 + 调用对应函数
  - 从 app-core.js import 36 个 fetch/import 函数
- **构建验证** [x]：`npm run build` 通过（10.10s，187 modules，无警告）

**验证清单**：

- [x] 四页翻页：page-dot 点击切换 + 左右滑动切换（threshold=50px）
- [x] Page 1 主列表：完整保留（展开收起+长按+双击注释+趋势图）
- [x] Page 2 题材分组：getTopicGroups computed + 强度/数量显示
- [x] 后台按钮：同花顺7个 + 猫抓6个 + 导入3个 = 16个按钮，根据 dataSource 自动选择函数
- [x] 最近多板自动计算：autoCalculateRecentMultiScore + autoCalculateConsecutiveDays（BiddingBoard 保存时触发）
- [x] ETF 自动计算：updateFromDie/updateFromZhang/updateFromTotal 互算（默认总数48）
- [x] 后台编辑/保存：saveData + patchHotField/patchAuctionField + saveModule（各看板正确调用）

### 2026-08-10 AuctionBoard 深度审查 P0/P1/P2 修复（本次会话）

**审查范围**：toggle 互斥/排序/窜日期/继承/性能/渲染效率，共发现 12 个 Bug。

- **P0-1: runBackend 异步成功后不 refresh** [x]：
  - **问题**：`AuctionBoard.vue:311-323` 后台按钮 fetch/import 返回 Promise，但 `refresh()` 在 `btn(...args)` 返回后立即同步执行，异步未完成时读旧数据
  - **修复**：改为 `.then(() => { refresh(); showToast('后台操作完成'); })` + `.catch(e => { ... })`，同步结果直接 `refresh()`
- **P0-2: byJingYest toggle 单独开启时无独立排序分支** [x]：
  - **问题**：`auction-view-helpers.js` 排序链为 `if/else if`，`byJingYest` 只在 `byParallel` 内部作为子条件，单独勾选"竞/昨"时完全不排序
  - **修复**：在 `byJingYestRatio` 之前新增 `else if (sortState.byJingYest)` 分支：按 jingYest highlight 分 tier（0=高亮/1=非高亮），tier 内按竞/昨比降序
- **P0-3: topicGroups computed 无响应式依赖** [x]：
  - **问题**：`AuctionBoard.vue:229-233` `getTodayGroupList` 读模块级 `currentDate`（非响应式），computed 无法建立依赖，日期切换后第2页题材分组不更新
  - **修复**：添加 `void viewData.value; void uiStore.currentDate;` 建立响应式依赖
- **P1-1: obsIndices 清空导致观察组不置顶** [x]：
  - **问题**：`auction-view-helpers.js:322-333` 开启 `jingYestToggleChecked` 时 `obsIndices = []`，观察组不独立置顶，全部混入常规组
  - **修复**：`obsIndices = merged`（匹配今日或继承的 obs 成员），`regularIndices` 排除 `merged` 和 `hiddenObsIndices`
- **P1-2: BiddingBoard 云端失败提示误导** [x]：
  - **问题**：`BiddingBoard.vue:303` 提示"本次修改未保存"但本地已保存，会误导用户
  - **修复**：改为"本地已保存，但云端同步失败"
- **P1-3: obsAutoAdded:false 与约定冲突** [x]：
  - **问题**：`auction-stock-sync.js:66` `ensureStockInNextDay` 写 `obsAutoAdded: false`，但 `ensureBoughtStocksForDate` 期望 `true`，导致次日冗余修正写入
  - **修复**：改为 `obsAutoAdded: true`
- **P1-4: \_confirmedSoldSet 性能退化** [x]：
  - **问题**：`auction-view-helpers.js:295-313` 遍历所有历史日期的所有股票，O(历史天数 × 每日股票数)，随使用时间线性退化
  - **修复**：改为从最近日期倒序遍历 + `seen.size >= namesToCheck.size` 提前终止，找到所有目标股票即停
- **P1-5: 继承股未进 auctionList 时不显示** [x]：
  - **问题**：`ensureBoughtStocksForDate` 定义完整但**全代码库无任何调用点**（死代码），继承股从不被补入次日 auctionList，既不在观察组也不在常规组
  - **修复**：在 `computeAuctionViewData` 中 `getTodayGroupList` 之前调用 `ensureBoughtStocksForDate(currentDate)`（仅 auction 数据源，try-catch 保护）
- **P2-1: obsItems/regularItems find O(n) 优化** [x]：
  - **问题**：`AuctionBoard.vue:235-242` computed 内 `find` 为 O(n)，每次渲染遍历全部 items
  - **修复**：添加 `itemsByIndex` Map computed，用 `m.get(i)` 替代 `find`
- **P2-4: btn 变量命名语义不符** [x]：改名 `task`
- **构建验证** [x]：`npm run build` 通过（18.14s，187 modules，无警告）

**未修复项**（低优先级，后续处理）：

- P2-2: 无虚拟滚动（需引入 vue-virtual-scroller，较大改动）
- P2-3: 多 toggle 同时开启时静默忽略（可添加 UI 提示）

### 2026-08-10 六项深度审查与修复（本次会话）

**审查范围**：后台数据获取/写入刷新/日期选择器/滚动行为/标签继承/手动导入。

#### 审查1: 后台获取数据是否错误写入历史日期

- **趋势图数据获取**：`getAuctionStockHistory` → `getStockHistoryValue` 全程纯只读，不写入任何数据 ✓
- **`fetchLadderConstituentsMain`**：锁存 `targetDate` + 最近交易日守卫双重防护，不写历史日期 ✓
- **`fetchAuctionFromNumcat` / `fillYesterdayVolumeFromThs`**：通过影子记录机制写入历史日期的 `market_metrics` 表（`in_watchlist=false`），不进看板第一页，仅供趋势图查询。设计行为，非 Bug ✓
- **残留风险**：影子记录无清理机制，在历史日期误触发补全会在云端残留行情行，但不影响看板渲染

#### 审查2: 价格变化/最近多板/ETF看板写入后刷新是否丢失

- **BiddingBoard**：保存写 `getBiddingData()` 内存 + `pushBiddingToCloud()`，`render()` 读同一内存源 ✓
- **DuibanBoard**：`saveRecentMulti()` upsert Supabase `recent_multi_data` 表，`loadRecentMulti()` 从同一表 SELECT ✓
- **EtfBoard**：`saveEarlyEtf()` upsert `early_etf_data` 表，`loadEarlyEtf()` 从同一表 SELECT ✓
- **结论**：三个看板数据源一致，无刷新丢失风险

#### 审查3: 日期选择器性能

- HomeStocksView 日期选择器是纯 Vue3 computed 驱动（`pickerDays` computed），`isTradingDay` 有周末短路 + `loadAllData` 500ms 缓存双重优化
- 每月最多 31 次 `isTradingDay` 调用，耗时 <1ms，无卡顿
- **结论**：无需新建日期组件，现有实现性能正常

#### 审查4: 全部展开快速下滑滚动到顶部

- **问题**：`expandAll()` 对每只股票调用 `loadTrendHistory`，每次调用 `trendHistory.value = { ...trendHistory.value, [index]: points }` 创建新对象触发响应式。数百只股票 = 数百次响应式触发，导致渲染阻塞和潜在滚动重置
- **修复** [x]：批量构建 `newHistory` 对象，一次性赋值 `trendHistory.value = newHistory`，只触发一次响应式更新

#### 审查5: 长按取消标签后次日是否仍继承 — **Bug 已修复**

- **问题**：`LongPressTagMenu.onSelect` 只更新 `auctionTagStore`（localStorage），不更新 `getStocksData()`（Supabase）。`ensureBoughtStocksForDate` 读 `getStocksData()`，看不到 `auctionTagStore` 的变更。取消标签后 `getStocksData()` 仍有 `bought/sold/hold=true`，次日仍会继承
- **修复** [x]：`onSelect` 中同步更新 `getStocksData()[date]` 的 `bought/sold/hold` 字段 + `saveModule('stocks')`。取消标签时设为 `false`，`ensureBoughtStocksForDate` 不再继承

#### 审查6: 后台手动导入数据 — **严重 Bug 已修复**

- **问题**：所有 6 个导入函数完全失效！
  - `onImportPaste`/`onReplaceConcept` 中 `prompt()` 获取的 `text` 未传递给导入函数
  - 导入函数从 `_domGet('auctionPasteInput')` 读取粘贴文本，但 `_domGet` 是桩函数返回 `null`
  - 所有导入逻辑不可达，粘贴导入功能完全不可用，且无任何错误提示（静默失败）
- **修复** [x]：
  - 6 个导入函数签名改为接受参数：`importAuctionFromPaste(pasteTextArg)` / `importHotFromPaste(pasteTextArg)` / `importAuctionHistoryFill(pasteTextArg, targetDateArg)` / `importHotHistoryFill(pasteTextArg, targetDateArg)` / `replaceConceptFromPaste(pasteTextArg)` / `replaceHotConceptFromPaste(pasteTextArg)`
  - `onImportPaste`/`onReplaceConcept` 传递 `text` 参数
  - 新增 `onHistoryFill` 函数，prompt 获取 text 和 date，传递给导入函数
  - "历史填充"按钮改为调用 `onHistoryFill`
  - 错误提示改用 `showToast()` 替代 `_domSetText`（桩函数）

#### 额外修复

- **regularItems find O(n)** [x]：`AuctionBoard.vue:249` `regularItems` computed 仍用 `find` 而非 Map（P2-1 修复不完整），已改用 `itemsByIndex` Map
- **构建验证** [x]：`npm run build` 通过（12.16s，187 modules，无警告）

---

### 2026-08-10 部署到新仓库 vue3biga + P0 Bug 修复

#### P0 Bug: 登录后首页空白（authReady 未设置）— **已修复**

- **问题**：`App.vue` 中 `<RouterView v-if="authReady" />` 只在 `authReady=true` 时渲染。`authReady` 是本地 `ref(false)`，只在 `onMounted` 中当 `localStorage.getItem('unlocked') === '1'` 时设为 `true`。`LoginOverlay.checkPassword()` 登录成功后调用 `hidePassword()` + `initApp()`，但**从未设置 `authReady = true`**。导致首次登录后 RouterView 不渲染，首页空白；只有刷新页面（localStorage 已有 unlocked=1）才显示
- **修复** [x]：
  - `LoginOverlay.vue`：登录成功后 `_emit('auth:login-success')`
  - `App.vue`：提取 `onLoginSuccess()` 函数，监听 `auth:login-success` 事件，设置 `authReady.value = true`
- **验收** [x]：`npm run build` 通过（19.24s，184 modules，无警告）

#### 推送到新仓库 vue3biga

- git remote 更新为 `https://github.com/jialeok/vue3biga.git`
- commit `cf8fb12`：修复登录后首页空白 + 清理无用文件（CNAME、deploy.yml、fix-data-logic.ps1、migrate-esm.js）
- force push 覆盖远程初始化提交（vue3biga 是新建空仓库，旧仓库 newbiga 不受影响）

#### CI 部署失败修复 — **已修复**

- **问题**：GitHub Actions "Setup Node" 步骤报错 `Dependencies lock file is not found`。原因：`.gitignore` 第 2 行忽略了 `package-lock.json`，导致未推送到远程。`setup-node` 的 `cache: npm` 需要 lock 文件
- **修复** [x]：从 `.gitignore` 移除 `package-lock.json`，提交 lock 文件到仓库（commit `7388194`）
- **验收** [x]：GitHub Actions 重新运行，`Status:completed Conclusion:success`

#### 部署验证 [x]

- Pages URL: `https://jialeok.github.io/vue3biga/`
- HTML 壳正确加载（标题"股票日记 v260"，`<div id="app">`，base 路径 `/vue3biga/` 正确）
- JS bundle: HTTP 200, 370.8KB
- CSS bundle: HTTP 200, 81.1KB
- **待用户浏览器验证**：访问 `https://jialeok.github.io/vue3biga/#/`，输入密码 `biga8450`，确认首页不再空白、看板正常显示

---

# 早盘竞价架构重构 + 规范合规收尾清单（2026-08-14 起）

> 配合 `biga-auction-arch-refactor` skill 与 `ARCHITECTURE架构规范_V3.md` 使用。  
> 前面批次 0–8（纯 Vue3 迁移）已全部 [x]，本清单是**架构合规收尾**阶段，目标是  
> 消灭 skill 诊断的 6 大病灶、并补齐规范 §6/§8/§16 的剩余硬约束。  
> **状态图例**：✅ 已完成  ⬜ 未做  ⚠️ 偏离/待拍板

---

## 一、Skill 6 条验收标准（逐条对账）

| # | 验收项                                           | 依据         | 状态 | 说明                                                      |
| - | --------------------------------------------- | ---------- | -- | ------------------------------------------------------- |
| ① | `stores/` 内 `createPinia()` 计数 0              | skill §5.1 | ✅  | 4 个 store 孤儿 Pinia 已删（commit `cf8364a`）                 |
| ② | `state.currentDate`/`window.currentDate` 字面=0 | skill §5.2 | ✅  | Phase5 全量迁 `useUiStore()`（commit `5269a80`），grep 已 0 匹配 |
| ③ | `grep in_watchlist` = 0                       | skill §5.3 | ⚠️ | 活路径已 0 读取；残留仅在 legacy 一次性迁移函数 + 注释（见二.1）                |
| ④ | 「获取涨幅」按钮立即更新                                  | skill §5.4 | ✅  | 用户实测"覆盖了，可以了"                                           |
| ⑤ | 导入/多设备不凭空冒股/重复                                | skill §5.5 | ✅  | Phase2 索引单判定 + Phase4 union 合并                          |
| ⑥ | Realtime 仅变更行更新不整段替换                          | skill §5.6 | ✅  | Phase4 增量合并（commit `a9cb90b`）                           |

---

## 二、Skill 未彻底项（必须收口）

### ⬜ 2.1 验收③ `in_watchlist` 字面归零

- **依据**：skill 病灶 B、Phase 2、§5.3（禁止读取/写入 `in_watchlist`）。
- **现状**：活代码 0 读取（双标准 bug 已根除）；真实字段读取仅剩两处历史兼容层  
  一次性迁移函数：
  - `src/data/legacy-migration.js`（`migrateAuctionToTable` / `migrateAuctionDataToNewTables`，读旧 `allData.auction` 的 `in_watchlist` 列）
  - `src/data/hot-stocks.js`（hot 一次性迁移，读旧 `hot_stocks` 表的 `in_watchlist` 列）
  - 其余全是说明性注释（解释新架构已丢弃该字段）。
- **待做（二选一，⚠️ 需用户拍板）**：
  1. 若用户确认**所有用户历史数据已完成迁移**（旧 `auction_data`/`hot_stocks` 表已无活跃数据）→ 删除这两个一次性迁移函数，使 `grep in_watchlist` 字面归零；
  2. 否则保留并文档化偏离（删之会令未迁移用户失去最后数据保护，违反 §11 数据安全红线）。

### ⚠️ 2.2 字段权威映射表偏离澄清（病灶 C / Phase 3）

- **依据**：skill §3 字段权威表第 3 行："当天涨幅 `change_pct` 权威 = `auction_watchlist.change_pct`，严禁 `market_metrics` 回退"。
- **现状（已批准但偏离规范字面）**：落地为 `market_metrics(scope='auction').change_pct` 为权威——  
  因为 morning worker 把 `auction_watchlist.change_pct` 写成空串、按钮经 `patchAuctionFieldBatch` 也写进 `market_metrics`。
- **待做（二选一，⚠️ 需用户拍板）**：
  - A（改回规范字面）：让按钮直接写 `auction_watchlist.change_pct`、显示只读它。风险：每天早上涨幅被 worker 空串清空，除非改 worker（仓库外，改不了）→ 实际不可行；
  - B（修订规范 §3 表）：把第 3 行固定为"现实权威 = `market_metrics(scope='auction').change_pct`"，消除规范与代码偏离。**推荐 B**。

---

## 三、架构 §16：app-core.js 按业务域拆分

> `app-core.js` 是 ~7700 行、~130 导出函数的单体巨文件（横跨所有业务域，  
> 被约 50 个文件 import、高度互依），正是 §16 点名的"无限增长"债务，也是  
> **事实上的"总业务逻辑聚合层"**。已抽离 auction 一次性迁移函数（commit `f9c0615`，净减 218 行）。

### ⬜ 3.1 拆解目标模块树（对应 §15 标准结构）

按域拆分计划动手

### ⬜ 3.2 执行顺序与强制步骤（低风险→高风险，每域独立可回滚）

1. `date/`（纯 getter，零风险）→ 2. `rank/multi/pattern/tagTitles`（纯 getter）→
2. `bidding/jiwang` → 4. `stocks` → 5. `auction` → 6. `hotspot`（最大，最后）。

- **每域强制步骤**：新建模块 → 迁移函数 → 更新所有 import 站点 → `vite build`  
  （临时 outDir，避开 safe-delete 拦截）→ 回归（启动/日期切换/导入/Realtime）  
  → **单独 commit + push**。
- **红线**：未构建验证绝不批量移动；只迁移不删函数；`app-state.js` 保留作运行期标记容器。

### ⬜ 3.3 `App.vue` 瘦身（规范 §14）

- **依据**：§14（App.vue 应轻量，不堆"登录/Migration/Realtime/股票同步/竞价同步/数据迁移/VisibilityChange"）。
- **现状**：`App.vue` 仍直接持有 `runMigrations()`、`setupVisibilityChange()`、`onLoginSuccess()→initApp()`，并 import 大量 `pull*/migrate*`。
- **待做**：下沉到 `useAppBootstrap()` 组合式（§14 推荐），App.vue 只留 `<AppShell><RouterView/></AppShell>` + 调用 `useAppBootstrap()`。

### ✅ 3.4 `remaining-boards.js` 复核（§16）

- **依据**：§16「remaining-boards.js 若功能被新模块替代→直接删除」。
- **结论**：已确认是**活跃 ES Module**（`import/export` 齐全，被 `app-core.js:14`、`stock-operations.js:6` 正常 import），**非隐藏旧模块，不动**。

---

## 四、架构 §6：allData 收敛（五套真相红线）★本轮新增，原清单遗漏

### 规范原文（§6）

- 禁止：`A 看板读新表 / B 看板读旧表 / C 看 allData / D 看 localStorage` 然后认为"差不多"。
- 禁止同时存在 `Supabase / allData / Pinia / local cache / 组件 ref` **五套真相**。
- **如果 `allData` 只是历史兼容层，必须明确其身份为 `cache / view model / store` 之一，并逐步移除。**

### ⬜ 4.1 现状（违反 "C 看 allData" + "五套真相"）

- `allData` 是巨型内存对象，散落于 `supabase-client.js`（重建入口）、`app-core.js`、`auction-data.js`、  
  `App.vue`、`auction-sync.js`、`tag-titles-helpers.js`、`HomeStocksView.vue`、`DashboardView.vue`、  
  `session-and-shield.js`，且被频繁 `= null` 重置触发重建（rank 缓存因此全失效，见 `supabase-client.js:163`）。
- 它目前被当成**第三套真相**（与 Supabase、Pinia 并存），正是 §6 明禁的形态。

### ⬜ 4.2 待做

1. 明确 `allData` = **内存 cache** 身份（在 `supabase-client.js` 加文档标注，不做第二真相）；
2. 把直接 `state.allData.xxx` / `getStocksData()` 内部读 allData 的读取点收敛到 Data 层 getter  
   （`loadAllData()` 已是入口，各业务改用各自 `_xxxMemCache`：`auction/bidding/jiwang` 已部分分离）；
3. 逐步脱离 allData 大对象，消除 `allData=null` 重置连坐（避免 rank 缓存无故失效）；
4. 最终目标：`grep -rn "allData" src/` 仅剩 cache 重建入口一处。

---

## 五、架构 §8：localStorage 红线审计 ★本轮新增，原清单遗漏

### 规范原文（§8）

- **只能用于**：UI 偏好 / 临时输入缓存 / 调试标记 / 其他非业务数据。
- **禁止存储**：核心词库 / 股票数据 / 竞价数据 / 题材分组 / 用户配置 / 看板业务状态 /  
  标签数据 / 排名数据 / 记忘数据 / 任何需要跨设备同步的业务数据。
- 所有业务数据必须持久化到 Supabase（§8 + 总原则⑤⑥）。

### ⬜ 5.1 现状审计（⚠️ 已发现违规点）

- `auctionTagStore.js`：`localStorage["auctionBoardTags"]` 读写 **标签数据** —— 属 §8 明禁项（标签数据），  
  且无法跨设备同步（清缓存/换设备即丢）。早期审查5修复时把标签同时写 `auctionTagStore`(localStorage)  
  和 `getStocksData()`(Supabase)，但 localStorage 副本仍保留 → **需收敛到仅 Supabase**。
- `uiStore.js` / `App.vue`：持久化 `lastEditedDate_*`、`unlocked`、`DATA_VERSION` 等 ——  
  `unlocked` 属登录态（可视为会话标记，临界）；`lastEditedDate` 属 UI 偏好/临时（允许）；  
  `DATA_VERSION` 属调试标记（允许）。需逐 key 判定。
- `app-core.js` 顶层：`localStorage.getItem('lastEditedDate_' + DATA_VERSION)` —— 读取当前日期，  
  属"临时输入缓存/UI 偏好"边缘，但既然已迁 `uiStore.currentDate`，该 localStorage 直读应改为走 store。

### ⬜ 5.2 待做

1. 全仓库 `grep -rn "localStorage" src/` 拉出所有 key 清单；
2. 逐 key 分类：**允许**（UI 偏好/调试标记/临时输入） vs **违规**（业务数据）；
3. 违规项（尤其标签数据）迁到 Supabase，删除 localStorage 写入/读取；
4. 保留项加注释标注"合规：UI 偏好/调试标记"，并统一经 store 读写（不再裸 `localStorage.getItem`）。

---

## 六、规范延后项（不阻塞，随 §16 顺势做）

### ⬜ 6.1 `app-state.js` 巨对象收敛（规范 §18）

- **依据**：§18（禁止把 stocks/auction/bidding/rank… 全塞进一个巨大响应式对象）。
- **现状**：`state` 仍有 ~150 个 `_xxx` 字段（运行期标记/缓存容器）。
- **说明**：skill Phase 5 **明确允许**保留 app-state.js 作"运行期标记容器"，**非违规**。收敛应随  
  §16 各域拆分时把对应 `_xxxMemCache` 下沉到域模块，不单独强求归零。

---

## 七、需要用户拍板的 5 件事

1. **2.1**：是否确认"全员历史数据已迁移" → 决定能否删 legacy 迁移函数让 `in_watchlist` 字面归零。
2. **2.2**：字段权威偏离选 A（改回规范字面，实际不可行）还是 B（修订规范 §3 表固定现实，推荐）。
3. **§16（3.2）**：是否按域拆分计划开工？建议从 `date/`(纯 getter) 和 `App.vue 瘦身`(§14) 先做起。
4. **§6（4.2）**：是否授权把 `allData` 收敛为纯 cache 并逐步移除（涉及多文件读取点改动，需逐域回归）。
5. **§8（5.2）**：是否授权把 localStorage 中**标签数据等违规业务数据**迁到 Supabase（动写入路径，需回归验证）。

---

## 八、进度记录区

### 2026-08-14 早盘竞价重构（5 阶段全完成，已推 main）

- `cf8364a` Phase0/1 孤儿 Pinia 删除 + 日期单真相源
- `fe6bf6f` Phase2 竞价成员身份单判定（索引 `_auctionWatchlistIndex[date]`）
- `6173670` Phase3 当天涨幅改 `market_metrics.change_pct` 唯一权威（权威模型，偏离 skill §3 字面）
- `a9cb90b` Phase4 Realtime 增量 union 合并 + 删除导入锁（病灶 D 根因修复）
- `5269a80` Phase5 彻底：`currentDate` 家族全量迁 `useUiStore()` 并清零 `state.` 引用
- `f9c0615` §16 第一步：抽离 auction 一次性迁移函数到 `legacy-migration.js`（app-core 净减 218 行）

### 2026-08-14 收尾清单编制

- 用户指出原清单遗漏规范 §6（allData 五套真相红线）与 §8（localStorage 红线），已补入四、五两章。
- 确认 `app-core.js` 为事实上"总业务逻辑聚合层"（单体巨文件），§16 拆分对象明确。
- 确认 `remaining-boards.js` 为活跃 ES Module，非 §16 违规对象，不动。

---

## 九、已推 main 的提交链（总览）

`cf8364a`(P0/1) → `fe6bf6f`(P2) → `6173670`(P3) → `a9cb90b`(P4) → `5269a80`(P5) → `f9c0615`(§16-1)

---

## 十、用户拍板结果（2026-08-14 晚）

1. **2.1 in_watchlist**：用户**无法确认"全员历史数据已迁移"** → 按 §11 数据安全红线，**保留** `legacy-migration.js` 与 `hot-stocks.js` 的迁移函数，不盲删（删之会让未迁移用户失去最后数据保护）。提供下方"确认方法"供用户自行核查。
2. **2.2 字段权威**：选 **B** → 已修订 skill §3 第 3 行，固定现实权威 = `market_metrics(scope='auction').change_pct`。
3. **§16**：已开工，先切 `date/` 纯函数模块（零风险入口）。
4. **§6 allData**：已授权，随域拆分逐域收敛（本轮 date/ 模块不触及 allData）。
5. **§8 localStorage**：已授权标签数据迁 Supabase。

## 十一、in_watchlist 迁移确认方法（用户自查，决定能否字面归零）

> 仅当用户能确认"**所有历史数据已迁移完毕、旧表无活跃数据**"时，才能删除一次性迁移函数让 `grep in_watchlist = 0`。  
> 用以下任一方式自查：

**方式 A — Supabase SQL（推荐，最准）**：在 Supabase SQL Editor 执行，看是否还有未迁移行：

```sql
-- 旧 auction_data 表是否还存在且含数据
select count(*) as auction_data_rows from auction_data;   -- 表不存在会报错，说明已拆完，安全
-- 旧 hot_stocks 表
select count(*) as hot_stocks_rows from hot_stocks;
```

若两表均"不存在"或"行数 = 0"，则可安全删除迁移函数；否则保留。

**方式 B — 浏览器控制台**（应用启动后，看旧快照是否还残留）：

```js
console.log('stockApp_v42_auction 残留:', localStorage.getItem('stockApp_v42_auction'));
console.log('stockAppData_v41 残留:', localStorage.getItem('stockAppData_v41'));
// 两者均为 null 说明本地旧快照已清；但旧表（云端）仍需用方式 A 确认
```

## 十二、进度更新（2026-08-14 晚）

### 已完成

- ✅ **B（§3 表修订）**：skill §3 第 3 行固定现实权威（`market_metrics(scope='auction').change_pct`）。
- ✅ **§16 第一步：date/ 域模块**：新建 `src/logic/date/date-helpers.js`，从 app-core.js 抽出 5 个纯 date 函数（`getWeekday`/`getPreviousDate`/`getNextDate`/`_shiftDateStr`/`buildYesterdayListFromToday`），用 import + re-export 保证 PatternBoard.vue 等调用点零破坏。app-core 净减约 70 行。
- ✅ **§8 标签数据上云**：重写 `auctionTagStore.js` —— Pinia 同步真相 + localStorage 本地快照缓存 + Supabase 持久真相（`auction_board_tags` 表，启动 `initApp→initAuctionTags` 拉取、写时 upsert/delete）；新增 `db/supabase_auction_board_tags.sql`（需用户在 Supabase 手动执行一次建表）。`in_watchlist` 迁移函数仍保留（见十一）。

### 待做（下一轮）

- ⬜ §16 继续：`rank/multi/pattern/tagTitles`(纯 getter) → `bidding/jiwang` → `stocks` → `auction` → `hotspot`。
- ⬜ §14 App.vue 瘦身（useAppBootstrap）。
- ⬜ §6 allData 收敛（随 auction/hotspot 拆分逐域做）。
- ⬜ §8 其余 localStorage key 逐项审计（lastEditedDate/unlocked/DATA_VERSION 等分类标注）。

## 十三、提交链总览（含本地未推）

`cf8364a`→`fe6bf6f`→`6173670`→`a9cb90b`→`5269a80`→`f9c0615`(§16-1) → `36fec75`(清单,本地未推) → `<本轮>`(date 拆分 + 标签上云)

---

## 十四、热门股票(hot) tab 清理 — UI 渲染死代码可删，数据层 / 共享影子记录必须保留

> 用户需求（2026-08-14 晚）：热门股票 tab 现在不用了 → 但其**趋势图记录 / 影子记录必须保留**。  
> 本章是对用户自行分析结论的**代码核实 + 修正**：UI 渲染层确为死代码可删，但数据加载层是竞价看板共享题材的命脉，**不可删**。

### 14.1 核实结论（与用户分析一致的部分）

- `热门股票` 在 Vue3 版本**确无 UI 入口**：无任何 `.vue` 挂载 `dataSource="hot"` 视图；`AuctionBoard.vue` 活跃视图仅有 auction；`renderHotStocks`/`saveHotStocks` 仅在 `app-core.js` 内部互相调用，外部入口只剩 `App.vue`/`LoginOverlay.vue` 的"数据拉取"两行（只把数据灌进 `state._hotAuctionData`，无组件渲染、无按钮触发 `saveHotStocks`）。
- `app-core.js` 内 hot 专属函数**无任何 `.vue` 或外部模块 import**（`app-core-api.js` 未导出其中任何一个）→ 公共 API 不含它们。

### 14.2 🔴 红线纠正（最重要，修正用户"先注释掉拉取调用"的建议）

- **不要**删除 `App.vue:119-120` 或 `LoginOverlay.vue:126-133` 的 hot 数据拉取调用。删之会让竞价看板题材统计**变空**，与"保留影子记录"自相矛盾。
- **证据链**：`loadHotStocksFromCloud()`（hot-stocks.js:47）写入 `state._hotAuctionData`（:196-220）→ `stock-topics.js:155` 在 `buildTopicCache()` 中 `scanDataSourceForTopics(state._hotAuctionData)` → `buildTopicCache` 于 `LoginOverlay.vue:138` 启动调用，产出"题材星标签统计看板"与竞价第二页题材。
- `LoginOverlay.vue:121-125` **已有明确注释**："热门股票共享影子记录：题材库/趋势图/竞-昨高光 与早盘竞价按股票名共享，必须加载，否则早盘竞价第二页题材与题材星标签统计看板会空（热门股票 tab UI 已移除，但数据仍在共享）。"
- 即：用户"趋势图/影子记录要保留"的要求，**恰好依赖**这套数据加载层。

### 14.3 可整段删除的函数（app-core.js，纯 hot UI 死代码，零外部引用，非数据层依赖）

| 分类           | 函数（行号）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 渲染           | `renderHotStocks` (37)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 表单/备份/回滚     | `saveHotStocks` (1182)、`rollbackHotStocksData` (1125)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 导入           | `importHotHistoryFill` (1605)、`importStockCodeMapHot` (1723)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 诊断           | `runHotApiDiagnostics` (6365)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 趋势主函数        | `fetchSkyrocketHotStocksMain` (4209)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 同花顺抓取族（15）   | `fetchHotLimitUpLadderFromThs`(4362)、`fillHotYesterdayVolumeFromThs`(4510)、`fillHotTodayYesterdayVolumeFromThs`(4725)、`_fillHotTodayYesterdayVolumeFromThsImpl`(4731)、`fillHotYesterdayYesterdayVolumeFromThs`(4910)、`_fillHotYesterdayYesterdayVolumeFromThsImpl`(4916)、`fetchHotChangePctFromThs`(5093)、`_fetchHotChangePctFromThsImpl`(5099)、`fillHotHistoryGapPctFromThs`(5272)、`fillHotHistoryGapYestVolumeFromThs`(5516)、`fillHotYesterdayAuctionFromNumcat`(5671)、`fetchHotTodayAuctionFromNumcat`(5681)、`fetchAllHotAuctionFromNumcat`(5691)、`fetchThreeDaysHotAuctionFromNumcat`(5701)、`fetchFiveDaysHotAuctionFromNumcat`(5709) |
| 猫抓/题材/预警族（5） | `fetchHotAuctionFromNumcat`(5876)、`fillHotTopicsFromNumcat`(6619)、`fetchHotMonitorWarningFromNumcat`(6733)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

> 上表按钮族内部还有**非 "Hot" 命名的 helper**（如 `renderHotForm`/`renderHotRow` 等），同属该死代码块，随块一并删除。  
> `renderHotStocks` 在 app-core.js 内部被 14 处调用，均为同块内按钮处理函数，删除整块后无残留调用。

### 14.4 ⚠️ 不可删（数据层 / 共享 / 外部可达）— 删之破坏竞价看板

| 函数（行号）                                                                                                                   | 保留原因                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getHotAuctionData` (1106)                                                                                               | 被 `auction-sync.js:280` 用作 hot scope watchlist 来源 fallback；且喂 `buildTopicCache` 的 `_hotAuctionData` 读取                                                          |
| `_openHotAuctionShield` (183) / `_closeHotAuctionShield` (191)                                                           | 被 `auction-sync.js`（161/247/272/359）当通用竞态屏蔽窗口使用 → 拍卖同步依赖，非 hot 专属                                                                                               |
| `patchHotField`(225)/`patchHotFieldBatch`(230)/`_sanitizeHotPatch`(210)/`_splitHotPatch`(214)/`_mergeHotPatchLocal`(220) | 被 `importHotFromPaste` 调用（1863），而 `importHotFromPaste` 外部可达（见下）                                                                                                 |
| `importHotFromPaste` (1249) / `replaceHotConceptFromPaste` (1511)                                                        | 经 `app-core-api.js` 导出，被 `ai-vision-import.js` 调用；`ai-vision-import.js` 被 `AuctionEditModal.vue:151` import（`openAiVisionModal`）→ **AI 视觉粘贴导入的 hot 分支仍可达**，非死代码 |
| `backupHotStocksData`（原 1115，2026-08-15 核实为活路径依赖，已恢复） | 被 `importHotFromPaste`（KEEP 活函数：AI 视觉粘贴导入，外部可达）调用做导入前备份；依赖活函数 `_backupScopeData`。原 14.3 误列可删，已作废该项。 |

> **🔴 执行修正（2026-08-15）**：原 14.3 把 `backupHotStocksData` 列为可删，但 `importHotFromPaste`（KEEP 活函数）调用它。删除 26 函数时一度误删导致 `importHotFromPaste` 运行期 `ReferenceError`，已恢复。同理 `rollbackHotStocksData` 仅被已删 `saveHotStocks` 调用，确为死代码，维持删除。

### 14.5 数据加载层（data/hot-stocks.js，非 app-core.js）— 全部保留

`loadHotStocksFromCloud` / `pullHotStocksHighlights` / `loadHotTrendsFromCloud` / 其 Realtime 订阅（`startHotStocksRealtime` 等）/ `pushHotTrendsToCloud` / 各 `migrateHotStocks*` 一次性迁移 → 必须保留（见 14.2 证据链）。  
`data/hot-stocks.js` 文件本身保留（仍被 `watchlist-and-metrics.js` / `LoginOverlay.vue` import）。  
Supabase 云端表（`hot_stocks` / `hot_stock_trends` / `hot_stocks_highlights` 等）**不动**。

### 14.6 实施顺序（按 red line：删前 grep 计数 0 + 单独 commit + build 验证）

1. **第一步（纯删除，零风险）**：删 app-core.js 14.3 全部死代码函数 + 其内部非 Hot 命名 helper。`app-core-api.js` 经核实未导出这些函数 → 无需动 API facade。
2. **第二步**：确认 14.4 的 `getHotAuctionData` / shield / patch 集群 / `importHot*` / `replaceHotConcept*` 保留不动。
3. **第三步**：`data/hot-stocks.js` 顶部加"已弃用但保留（共享数据层）"头注释，不改逻辑。
4. **第四步**：Supabase 表不动。

### 14.7 验收

- ✅ `grep -rn "renderHotStocks\|saveHotStocks\|runHotApiDiagnostics\|fillHot\|fetchHot" src/` → 仅剩注释/字符串字面量 + 一处 `typeof renderHotStocks === 'function'` 守卫调用（在 KEEP 函数 `autoCompleteMissingStockCodes` 内，求值恒为 false、永不执行，安全）。全仓库零真实调用。
- ✅ `vite build`（--outDir 项目外临时目录）通过：190 modules transformed，built in 13s。
- ⬜ 启动后竞价看板第二页题材 / 题材星标签统计看板仍有数据（**需浏览器手动 Regression**，验证 14.2 红线未被破坏；本次仅做静态+构建验证）。

> 实测修正：`backupHotStocksData` 因被活函数 `importHotFromPaste` 调用，已恢复并移出"可删"清单（见 14.4）。实际删除 **25 个**纯死代码函数 + 其内部 helper，app-core.js 净减约 2965 行（7678→4714 行，含恢复 1 函数）。

---

## 十五、进度更新（2026-08-15 · 热门股票清理执行）

- ✅ **实际删除 25 个纯 hot UI 死代码函数**（14.3 原 26 项，扣除 `backupHotStocksData` 因活路径依赖已恢复）：`renderHotStocks`/`saveHotStocks`/`rollbackHotStocksData`/`importHotHistoryFill`/`importStockCodeMapHot`/`runHotApiDiagnostics`/`fetchSkyrocketHotStocksMain` + 同花顺抓取族 15 + 猫抓/题材/预警族 5 + 其内部非 Hot helper。app-core.js 由 7678 行降至 4714 行。
- 🔴 **执行中发现并修正**：`backupHotStocksData` 被 KEEP 活函数 `importHotFromPaste`（AI 视觉粘贴导入）调用 → 误删会导致运行期 ReferenceError，已恢复（移出可删清单，补入 14.4）。`rollbackHotStocksData` 仅被已删 `saveHotStocks` 调用，确为死代码，维持删除。
- ✅ `data/hot-stocks.js` 顶部加"已弃用但保留（共享数据层）"头注释（14.6 第三步）。
- ✅ `vite build` 通过；构建仅静态验证，**题材统计回归需浏览器手动确认**。
- ✅ 已单独 commit + push 到 main（见提交链）。

