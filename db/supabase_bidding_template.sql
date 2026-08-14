-- 竞价默认模板表（§8 合规：biddingDefaultTemplate_v41 配置数据从 localStorage 双写到 Supabase）
-- 应用层：src/data/bidding-template-sync.js（写经 Supabase upsert + localStorage 兜底）
-- 注意：本 SQL 需在 Supabase 项目里手动执行一次。表不存在时云端读写被 try/catch 兜底，localStorage 仍正常。
create table if not exists auction_bidding_template (
  id         text        not null primary key,
  templates  jsonb       not null,
  updated_at timestamptz default now()
);

comment on table auction_bidding_template is '竞价看板默认行名模板（配置数据，上云持久化）';

alter table auction_bidding_template enable row level security;

drop policy if exists "allow_all_auction_bidding_template" on auction_bidding_template;
create policy "allow_all_auction_bidding_template" on auction_bidding_template for all to anon using (true) with check (true);

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='auction_bidding_template') then
    alter publication supabase_realtime add table auction_bidding_template;
  end if;
end $$;
