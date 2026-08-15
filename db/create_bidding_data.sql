-- 竞价变化看板独立表（§8 合规：竞价数据上云持久化，跨设备不丢）
-- 应用层：src/data/bidding-data.js（读写经 Supabase upsert + 内存缓存；读经 pullBiddingFromTable）
-- 写入字段对齐代码：
--   - 前端 src/data/bidding-data.js：upsert { date, name, time915, time920, time925, change, close, updated_at }
--   - Edge Function bidding-a/index.ts：upsert { date, name, time915, time920, time925, close, updated_at, change }，
--     on_conflict=date,name，SELECT 仅取 name,time915,time920,time925,close,change
-- 注意：本 SQL 需在 Supabase 项目里手动执行一次（沙箱无法直连远端）。
-- 表不存在时 bidding-data 的云端读写被 try/catch 兜底，内存缓存仍正常。
create table if not exists bidding_data (
  date       text        not null,
  name       text        not null,
  time915    text,
  time920    text,
  time925    text,
  "change"   text,                       -- 引号转义：change 是 SQL 保留字；代码用 "change" 引用
  close      text,
  updated_at timestamptz default now(),
  primary key (date, name)
);

comment on table bidding_data is '竞价变化看板固定行时序数据：9:15/9:20/9:25 竞价% + 收盘% + 环比(change)（业务数据，上云持久化）';

create index if not exists idx_bidding_data_date on bidding_data (date);

alter table bidding_data enable row level security;

drop policy if exists "allow_all_bidding_data" on bidding_data;
create policy "allow_all_bidding_data" on bidding_data for all to anon using (true) with check (true);

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='bidding_data') then
    alter publication supabase_realtime add table bidding_data;
  end if;
end $$;
