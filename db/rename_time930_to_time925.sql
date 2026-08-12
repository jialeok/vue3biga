-- ============================================================================
-- 把 time930 系列列改名为 time925
-- 涉及两张表：
--   1) bidding_data        （竞价变化看板独立表）
--        time930 / time930_initial / time930_initial_modifiedAt / time930_modifiedAt
--   2) market_metrics      （早盘竞价 / 热门股票共用，按 scope 区分）
--        time930   （另有 seal_count 等列保持不变）
--
-- 执行方式：Supabase Dashboard -> SQL Editor 新建 Query -> Run
-- 本脚本幂等：已改名的列不会重复改名，可反复执行。
--
-- ⚠️ 重要：列改名后，前端数据层与 Cloudflare worker 必须同步改为读写 time925，
--   并重新部署前端构建与 worker，否则会出现「列不存在」读写失败 / 数据写不进库。
--   请按以下顺序操作：① 先部署好新代码 / 新 worker（读写 time925）；
--   ② 再执行本 SQL；或反过来「先执行 SQL、立刻部署」亦可，但二者之间会出现短暂读写报错窗口。
-- ============================================================================

-- 1) bidding_data 表（竞价变化看板独立表）
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'bidding_data' and column_name = 'time930'
  ) then
    alter table bidding_data rename column time930 to time925;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'bidding_data' and column_name = 'time930_initial'
  ) then
    alter table bidding_data rename column time930_initial to time925_initial;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'bidding_data' and column_name = 'time930_initial_modifiedAt'
  ) then
    alter table bidding_data rename column time930_initial_modifiedAt to time925_initial_modifiedAt;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'bidding_data' and column_name = 'time930_modifiedAt'
  ) then
    alter table bidding_data rename column time930_modifiedAt to time925_modifiedAt;
  end if;
end $$;

-- 2) market_metrics 表（早盘竞价 / 热门股票共用，scope 区分）
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'market_metrics' and column_name = 'time930'
  ) then
    alter table market_metrics rename column time930 to time925;
  end if;
end $$;

-- 校验：下面两条查询都应返回 0 行（确认旧列已不存在）
-- bidding_data 中应已无 time930* 列
select column_name
from information_schema.columns
where table_schema = 'public' and table_name = 'bidding_data' and column_name like 'time930%';

-- market_metrics 中应已无 time930 列
select column_name
from information_schema.columns
where table_schema = 'public' and table_name = 'market_metrics' and column_name = 'time930';
