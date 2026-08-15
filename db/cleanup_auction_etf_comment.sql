-- 清理（已废弃/孤儿表）：auction_etf_comment
-- -----------------------------------------------------------------------------
-- 状态：已废弃（DEPRECTED / ORPHAN）
-- 依据：PURE_VUE3_AUDIT_REPORT.md §六“废弃表”条目
--        > auction_etf / auction_etf_comment 已废弃（0 行，SQL 头注释引用的
--        > etf-sync.js / etf-comment-sync.js 文件不存在）
--
-- 验证（本仓库可核实）：
--   - src/data/etf-comment-sync.js 不存在（已确认）。
--   - 全 src 仅 src/data/etf-board-data.js:3 提及 auction_etf_comment，并称其
--     为“0 行已废弃”；板块ETF点评无独立 live 表，由 early_etf_data 口径承载。
--
-- 为什么还留在数据库：
--   与 auction_etf 同源，对应同步层（etf-comment-sync.js）从未落地，自创建起为空
--   孤儿表，仅占用 schema。
--
-- 清理动作（幂等、安全）：
--   1) 解除 Realtime 发布（DROP 会自动级联）；
--   2) DROP TABLE IF EXISTS —— 0 行、无读取方，删除无数据损失。
-- 不要误删 early_etf_data（live 真相源）。
-- -----------------------------------------------------------------------------

do $$
begin
  if exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'auction_etf_comment'
  ) then
    alter publication supabase_realtime drop table auction_etf_comment;
  end if;
end $$;

drop table if exists auction_etf_comment;
