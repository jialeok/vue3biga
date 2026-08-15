-- 题材库独立表（§8 合规：stock_topics 为题材库唯一真相源）
-- 应用层：src/data/stock-topics.js（读经 pullStockTopicsFromCloud，写经 pushStockTopicsToCloud）
-- 写入字段对齐代码 src/data/stock-topics.js：
--   SELECT：stock,topics,code
--   upsert：{ stock, topics, code, updated_at }，onConflict:'stock'
-- 说明：topics 以逗号分隔字符串存储（代码 split(',') 还原为 Set），code 为可选股票代码快照
-- 注意：本 SQL 需在 Supabase 项目里手动执行一次。
create table if not exists stock_topics (
  stock      text        not null primary key,
  topics     text,
  code       text,
  updated_at timestamptz default now()
);

comment on table stock_topics is '题材库：每只股票归属的题材集合（逗号分隔字符串）+ 代码快照（跨日期共享唯一真相源）';

create index if not exists idx_stock_topics_code on stock_topics (code);

alter table stock_topics enable row level security;

drop policy if exists "allow_all_stock_topics" on stock_topics;
create policy "allow_all_stock_topics" on stock_topics for all to anon using (true) with check (true);

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='stock_topics') then
    alter publication supabase_realtime add table stock_topics;
  end if;
end $$;
