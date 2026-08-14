-- 板块ETF数据表（§8 合规：板块ETF业务数据从 localStorage 双写到 Supabase，跨设备不丢）
-- 应用层：src/data/etf-sync.js（写经 Supabase upsert + localStorage 兜底）
-- 注意：本 SQL 需在 Supabase 项目里手动执行一次（沙箱无法直连远端）。
-- 执行前表不存在时，etf-sync 的云端读写会被 try/catch 兜底，localStorage 仍正常。

create table if not exists auction_etf (
  date       text        not null primary key,
  data       jsonb       not null,
  updated_at timestamptz default now()
);

comment on table auction_etf is '板块ETF每日数据：{date: [{shuliang, dieZhangbi, jingtu, tushi}]}（业务数据，上云持久化）';

create index if not exists idx_auction_etf_date on auction_etf (date);

alter table auction_etf enable row level security;

drop policy if exists "allow_all_auction_etf" on auction_etf;
create policy "allow_all_auction_etf"
  on auction_etf
  for all
  to anon
  using (true)
  with check (true);

-- 加入 Realtime 发布，支持多设备板块ETF同步
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'auction_etf'
  ) then
    alter publication supabase_realtime add table auction_etf;
  end if;
end $$;
