-- ============================================================================
-- 补改名：bidding_data 表里原脚本漏掉的 2 个列
--   "time930_initial_modifiedAt"  -> "time925_initial_modifiedAt"
--   "time930_modifiedAt"          -> "time925_modifiedAt"
--
-- 重要：这两个列当初建表时是「带双引号、大小写敏感」创建的，列名实际带大写 A。
--   因此旧名和新名都必须用双引号包裹，否则 PostgreSQL 会把标识符折成小写而找不到。
--   新列名保持混合大小写，与前/后端 JS 代码读取的 time925_initial_modifiedAt /
--   time925_modifiedAt 完全一致。
--
-- 本脚本幂等，可重复执行。
-- 执行方式：Supabase Dashboard -> SQL Editor 新建 Query -> Run
-- ============================================================================

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'bidding_data' and column_name = 'time930_initial_modifiedAt'
  ) then
    alter table bidding_data rename column "time930_initial_modifiedAt" to "time925_initial_modifiedAt";
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'bidding_data' and column_name = 'time930_modifiedAt'
  ) then
    alter table bidding_data rename column "time930_modifiedAt" to "time925_modifiedAt";
  end if;
end $$;

-- 校验：应返回 0 行（确认 bidding_data 中已无 time930* 列）
select column_name
from information_schema.columns
where table_schema = 'public' and table_name = 'bidding_data' and column_name like 'time930%';
