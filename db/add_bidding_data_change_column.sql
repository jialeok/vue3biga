-- ============================================================
-- 竞价变化看板 9:25 列空的精准修复
-- 根因：worker 的 t0925/t0926 写入分支会往 bidding_data 写 `change` 列，
--       但该表从未建过 `change` 列（无建表 SQL、前端自行计算涨跌不依赖它），
--       导致整批 upsert 被 Supabase 400 拒绝、被 catch 静默吞掉 → time925 整列空。
--       此 bug 与 time930→time925 改名无关，改名前就存在；改名后新 worker 仍写 change，故仍需修。
-- ============================================================

-- 第 1 步（只读诊断）：确认 change 列缺失。
-- 预期：列表里没有 change（time925* 系列是改名后的正常列）。
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'bidding_data'
order by ordinal_position;

-- 第 2 步（修复）：补 change 列。幂等，可重复执行。
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='bidding_data' and column_name='change'
  ) then
    alter table bidding_data add column "change" text;
  end if;
end $$;

-- 第 3 步（校验）：应能看到 change 列。
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'bidding_data' and column_name = 'change';
