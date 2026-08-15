-- 股票名↔代码映射表（§8 合规：stockcodemap 为代码映射唯一真相源，取代旧 localStorage.stockCodeMap）
-- 应用层：src/data/stock-code-map.js（读经 pullStockCodeMapFromCloud，写经 upsertStockCodeMap）
-- 写入字段对齐代码 src/data/stock-code-map.js：
--   SELECT：stock,code
--   upsert：{ stock, code, updated_at }，onConflict:'stock'
--   worker 读取：bidding-auto-fetch/data/supabase-write.js 用 /rest/v1/stockcodemap?select=stock,code
-- 注意：本 SQL 需在 Supabase 项目里手动执行一次。
create table if not exists stockcodemap (
  stock      text        not null primary key,
  code       text,
  updated_at timestamptz default now()
);

comment on table stockcodemap is '股票名称 → 代码映射（跨设备唯一真相源，取代本地 stockCodeMap）';

create index if not exists idx_stockcodemap_code on stockcodemap (code);

alter table stockcodemap enable row level security;

drop policy if exists "allow_all_stockcodemap" on stockcodemap;
create policy "allow_all_stockcodemap" on stockcodemap for all to anon using (true) with check (true);

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='stockcodemap') then
    alter publication supabase_realtime add table stockcodemap;
  end if;
end $$;
