# db/ SQL 脚本索引（建表 / 迁移 / 清理）

> 本文件由 `biga` 项目维护脚本自动补全，覆盖 `db/` 下全部 30 个 `.sql`。
> 原 `MIGRATION_TASKLIST.md` 仅登记了其中 9 个；本索引补全其余 21 个，并标注每张表的**真实存活状态**（live / 孤儿 / 只写不读 / 迁移），供评估团队与运维核对。
>
> 执行顺序建议：`_E1_RUN_ALL_CREATE_TABLES.sql` 汇总了所有建表，按依赖顺序一次性执行即可建出全部 live 表。清理类脚本（`cleanup_*.sql`）为幂等、安全，但**删除动作需在 Supabase 控制台手动执行**（不在本仓库自动跑）。

## 一、总入口（执行顺序）

| 文件 | 作用 |
| --- | --- |
| `_E1_RUN_ALL_CREATE_TABLES.sql` | 汇总全部建表 DDL，按依赖顺序一次性建出所有 live 表。新建库首选。 |

## 二、建表脚本（按业务域）

### 竞价 / 早盘竞价
| 文件 | 表 | 状态 |
| --- | --- | --- |
| `create_bidding_data.sql` | `bidding_data` | ✅ live（竞价变化看板独立表，§8 上云） |
| `create_bidding_fetch_log.sql` | `bidding_fetch_log` | ✅ live（抓取日志） |
| `supabase_auction_board_tags.sql` | 竞价看板标签表 | ✅ live（§8 标签上云） |
| `supabase_auction_metrics.sql` | 竞价行情指标表 | ✅ live |
| `supabase_bidding_t0925_cron.sql` | 9:25 竞价 cron 相关 | ✅ live（定时任务） |
| `supabase_bidding_template.sql` | `auction_bidding_template` | ⚠️ **只写不读（半孤儿）**：`saveBiddingTemplate()` 仍在 upsert，但 `loadBiddingTemplate()` 全 src 0 调用方，读取走 localStorage。删除前必须先改代码（见 `cleanup_auction_bidding_template.sql`）。 |
| `supabase_dashboards.sql` | 看板聚合相关 | ✅ live |
| `supabase_emotion_data.sql` | 情绪数据表 | ✅ live |
| `supabase_duiban.sql` | `recent_multi_data` / `auction_duiban` | ⚠️ `recent_multi_data` 为 live 对标表；`auction_duiban` 为**孤儿表**（写从不读，§6 双真相遗留），可清理。 |
| `supabase_remaining_boards.sql` | 其余看板表 | ✅ live |

### 热门股票 / 题材
| 文件 | 表 | 状态 |
| --- | --- | --- |
| `create_hot_stock_trends.sql` | `hot_stock_trends` | ✅ live（趋势快照） |
| `create_hot_stocks_highlights.sql` | `hot_stocks_highlights` | ✅ live（竞/昨高光，加速加载） |
| `create_stock_topics.sql` | `stock_topics` | ✅ live（题材词库，§8 上云） |
| `create_core_topics.sql` | `core_topics` | ✅ live（核心题材词唯一真相源，ui-bridge 活跃读写） |
| `supabase_topic_fumian.sql` | `topic_fumian` | ❌ **孤儿表**：src 零引用，仅建表 SQL 存在，无读写方。可清理。 |

### ETF / 板块
| 文件 | 表 | 状态 |
| --- | --- | --- |
| `create_daily_highlights.sql` | `daily_highlights` | ✅ live（每日高光，加速加载） |
| `supabase_auction_etf.sql` | `auction_etf` | ❌ **废弃孤儿表**：权威源已迁 `early_etf_data`，对应同步层 `etf-sync.js` 不存在，0 行。可清理（见 `cleanup_auction_etf.sql`）。 |
| `supabase_etf_comment.sql` | `auction_etf_comment` | ❌ **废弃孤儿表**：同 `auction_etf`，0 行。可清理（见 `cleanup_auction_etf_comment.sql`）。 |

### 记往 / 用户 / 映射
| 文件 | 表 | 状态 |
| --- | --- | --- |
| `create_jiwang_data.sql` | `jiwang_data` | ✅ live（记往看板，§8 上云） |
| `create_user_data.sql` | `user_data` | ✅ live（用户全量数据 / 会话 token，§8 上云） |
| `create_stockcodemap.sql` | `stockcodemap` | ✅ live（股票名↔代码映射，§8 上云） |

## 三、迁移 / 字段变更脚本

| 文件 | 作用 | 状态 |
| --- | --- | --- |
| `add_auction_auc_fields.sql` | 竞价表追加 auc 字段 | ✅ 历史迁移（已执行） |
| `add_bidding_data_change_column.sql` | `bidding_data` 追加 change 列 | ✅ 历史迁移（已执行） |
| `rename_time930_to_time925.sql` | 时间字段 9:30→9:25 重命名 | ✅ 历史迁移（已执行） |
| `rename_time930_to_time925_fix.sql` | 上述重命名的修复补丁 | ✅ 历史迁移（已执行） |
| `revert_market_metrics_time925_to_time930.sql` | 回滚 market_metrics 时间字段 | ⚠️ 反向迁移（按需，通常不需跑） |

## 四、清理脚本（DROP，幂等安全 — 需运维在 Supabase 手动执行）

| 文件 | 目标表 | 状态 | 删除前须知 |
| --- | --- | --- | --- |
| `cleanup_auction_etf.sql` | `auction_etf` | ❌ 废弃孤儿（0 行） | 直接 `DROP TABLE IF EXISTS`，无数据损失 |
| `cleanup_auction_etf_comment.sql` | `auction_etf_comment` | ❌ 废弃孤儿（0 行） | 直接 `DROP TABLE IF EXISTS`，勿误删 `early_etf_data` |
| `cleanup_auction_bidding_template.sql` | `auction_bidding_template` | ⚠️ 只写不读（半孤儿） | **删除前必须先改代码**：移除 `saveBiddingTemplate()` 的双写或接通读取，否则写入 fail-soft 报错 |

> 注意：`auction_bidding_template` **不是**废弃死表（仍在被写入），归类为"只写不读/半孤儿"，清理风险高于前两者，须先改代码再 DROP。

## 五、已知编码问题
部分建表脚本（如 `create_daily_highlights.sql` / `create_jiwang_data.sql` / `create_stock_topics.sql` / `create_stockcodemap.sql` / `create_user_data.sql`）头部中文注释存在**乱码（文件编码非 UTF-8）**。功能不受影响（DDL 主体正常），但建议在下次维护时统一转 UTF-8 并重写注释，避免混淆。
