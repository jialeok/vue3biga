-- 清理（已废弃/孤儿表）：auction_etf
-- -----------------------------------------------------------------------------
-- 状态：已废弃（DEPRECTED / ORPHAN）
-- 依据：PURE_VUE3_AUDIT_REPORT.md §六“废弃表”条目
--        > auction_etf / auction_etf_comment 已废弃（0 行，SQL 头注释引用的
--        > etf-sync.js / etf-comment-sync.js 文件不存在）
--
-- 验证（本仓库可核实）：
--   - src/data/etf-sync.js、src/data/etf-comment-sync.js 均不存在（已确认）。
--   - src/data/etf-board-data.js:3 明确：板块ETF 权威源 = early_etf_data
--     （实测 40 行）；auction_etf / auction_etf_comment 均 0 行已废弃。
--   - src/logic/bidding/helpers.js:32 收敛：板块ETF 唯一真相源 = early_etf_data，
--     不再写 auction_etf。
--
-- 为什么还留在数据库：
--   历史建表脚本（db/supabase_auction_etf.sql）随 §8 合规迁移建立，但其对应的
--   同步层（etf-sync.js）从未落地，故该表自创建起即为空孤儿表，仅占用 schema。
--
-- 清理动作（幂等、安全）：
--   1) 先从 Realtime 发布中移除（DROP TABLE 会自动解除，这里显式清理更稳妥）；
--   2) DROP TABLE IF EXISTS —— 不影响任何线上业务（0 行、无读取方）。
-- 注意：本脚本需在 Supabase 项目手动执行一次；因表为空且无人读取，删除无数据损失。
-- 不要误删 early_etf_data（那是 live 真相源）。
-- -----------------------------------------------------------------------------

-- 1) 解除 Realtime 发布（可选，DROP 会自动级联，保留以防万一）
do $$
begin
  if exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'auction_etf'
  ) then
    alter publication supabase_realtime drop table auction_etf;
  end if;
end $$;

-- 2) 安全删除孤儿表
drop table if exists auction_etf;
