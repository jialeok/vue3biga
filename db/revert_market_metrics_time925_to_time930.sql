-- ============================================================================
-- 回退：market_metrics 表的 time925 改回 time930
--
-- 背景：上一版 rename 脚本误把 market_metrics（早盘竞价 / 热门股票共用、按 scope 区分的
-- 抓取数据表）的 time930 列也改成了 time925。该表是抓取数据用的共享表，时间点命名原本
-- 正确，不在「竞价变化看板改名」范围内，因此回退。竞价变化独立表 bidding_data 不受影响。
--
-- 执行方式：Supabase Dashboard -> SQL Editor 新建 Query -> Run
-- 本脚本幂等：仅当列名为 time925 时才改回 time930；若本就是 time930（或已回退）则跳过。
-- ============================================================================

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'market_metrics' and column_name = 'time925'
  ) then
    alter table market_metrics rename column time925 to time930;
  end if;
end $$;

-- 校验：应返回 1 行（time930），确认共享表已恢复原列名
select column_name
from information_schema.columns
where table_schema = 'public' and table_name = 'market_metrics' and column_name like 'time9%';
