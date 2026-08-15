# Realtime 单向缺口清单（单方向表，缺 Realtime 订阅/读取）

> 来源：`PURE_VUE3_AUDIT_REPORT.md` §六“4 张单向表无 Realtime（§31 缺口）”
> 范围：本仓库 `src/` 可核实的写入/读取/订阅三方状态。
> 影响：被写入的数据在另一设备/会话无法被实时通知（§31 跨设备一致性缺口）。

判定口径：
- **only-write**：有写入、无读取、无订阅（孤儿写入表）。
- **write-no-read**：有写入、无读取（读取路径为死代码或未接通），可能有/无订阅。
- **write-no-subscribe**：有写入、有读取，但**无 Realtime 订阅** → 一处改了，另一处要等到手动刷新/重启才看到。

---

## 1. `auction_duiban` —— only-write（只写不读 + 无订阅）

| 维度 | 现状 | 核实位置 |
|---|---|---|
| 写入 | `saveDuibanData()` upsert 到 `auction_duiban` | `src/data/duiban-sync.js:13` (`TABLE='auction_duiban'`) |
| 读取 | **无**。DuibanBoard 实际数据源是 `recent_multi_data` | `src/views/DuibanBoard.vue:203` 注释“当前走 recent_multi_data（未上云 auction_duiban）” |
| 订阅 | **无**。Realtime 订阅挂在 `recent_multi_data`（`recent_multi_data_rt`） | `src/data/duiban-sync.js:107` channel `'recent_multi_data_rt'` |

结论：`auction_duiban` 是迁移遗留的**双真相**孤儿写入表（audit §六 `auction_duiban 双真相`）。
写入落库但永远不被读、也不被订阅推送。建议：
- 收敛为单一真相：确认 live 数据源为 `recent_multi_data` 后，停止向 `auction_duiban` 写入；
- 或在统一走 `auction_duiban` 后，把订阅目标迁到 `auction_duiban`（duiban-sync.js:93-94 已预留说明）。

---

## 2. `auction_bidding_template` —— write-no-read（只写不读）

| 维度 | 现状 | 核实位置 |
|---|---|---|
| 写入 | `saveBiddingTemplate()` 被调用，双写竞价默认模板 | `src/logic/workflows/auction-sync.js:558` |
| 读取 | **无**。`loadBiddingTemplate()` 已定义但全 src **0 调用方**（死函数） | `src/data/bidding-template-sync.js:43`（定义，未引用） |
| 订阅 | 建表 SQL 将其加入了 `supabase_realtime` 发布，但应用层无任何订阅逻辑 | `db/supabase_bidding_template.sql:17-22` |

结论：live 模板真相实际是 localStorage 的 `biddingDefaultTemplate_v41`
（`auction-sync.js:782` 直接读 localStorage）。该 Supabase 表持续接收写入、却从不被读回。
与 `cleanup_auction_bidding_template.sql` 配套处理（删表前需先移除 `:558` 调用方）。

---

## 3. `topic_fumian` —— write-no-subscribe（写入但无订阅 → 多端负面题材不同步）

| 维度 | 现状 | 核实位置 |
|---|---|---|
| 写入 | `saveFumianTopics(map)` upsert 到 `topic_fumian` | `src/data/fumian-sync.js:14,31` (`TABLE='topic_fumian'`) |
| 读取 | 启动期 `loadFumianTopics` 等读取路径（fail-soft 回退 localStorage） | `src/data/fumian-sync.js` |
| 订阅 | **无**。全 src 对 `topic_fumian` 无 `channel`/`subscribe`（`grep` 0 命中） | 见仓库搜索 |

结论：设备在 A 端标记/取消负面题材后写入云端，B 端**不会收到 Realtime 推送**，
需手动刷新或重启才能同步 → 多设备负面题材状态不一致。
修复方向：为 `topic_fumian` 增加与 `recent_multi_data_rt` 同模式的模块级订阅
（`src/data/duiban-sync.js:91-127` 的引用计数订阅是可直接复刻的样板）。

---

## 4. `core_topics` —— write-no-subscribe（写入/读取但无订阅）

| 维度 | 现状 | 核实位置 |
|---|---|---|
| 写入 | `ui-bridge.js` 对 `core_topics` 做 `delete().neq(...)` + `insert(rows)` 全量覆盖写 | `src/logic/ui-bridge.js:64,76,80` |
| 读取 | 启动期 `loadCoreTopicsFromCloud()` 从云端读核心词；`rules.js` 在云端为空时推送默认词 | `src/composables/useAppBootstrap.js:142`、`src/logic/topic/rules.js:21-56` |
| 订阅 | **无**。全 src 对 `core_topics` 无 `channel`/`subscribe`（`grep` 0 命中） | 见仓库搜索 |

结论：核心词在某一设备被编辑（增删/同义词变更）后写入云端，其它已打开的会话
**不会实时收到**，要等下次启动 `loadCoreTopicsFromCloud` 才更新 → 多设备核心词短暂不一致。
修复方向：为 `core_topics` 增加 Realtime 订阅，在 `post` 变更时触发
`loadCoreTopicsFromCloud()`（或增量合并）并 `_emit('auction-refresh')`。

---

## 汇总

| 表 | 缺口类型 | 多设备后果 | 关联清理/修复 |
|---|---|---|---|
| `auction_duiban` | only-write | 写入即废、无推送 | 收敛为 `recent_multi_data` 单真相；见 audit 双真相项 |
| `auction_bidding_template` | write-no-read | 写入即废、无推送 | `db/cleanup_auction_bidding_template.sql` |
| `topic_fumian` | write-no-subscribe | 负面题材不同步 | 增加 `topic_fumian` Realtime 订阅 |
| `core_topics` | write-no-subscribe | 核心词不同步 | 增加 `core_topics` Realtime 订阅 |

> 备注：`auction_etf` / `auction_etf_comment` 亦为孤儿表（0 行、同步层文件不存在），
> 但它们是“完全死表”而非“单向 Realtime 缺口”，清理见 `db/cleanup_auction_etf.sql`、
> `db/cleanup_auction_etf_comment.sql`。
