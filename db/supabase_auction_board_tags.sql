-- 竞价看板标签表（§8 合规：标签业务数据从 localStorage 迁到 Supabase，跨设备不丢）
-- 应用层：src/stores/auctionTagStore.js（Pinia 同步真相 + 本地快照缓存 + 云端持久真相）
-- 注意：本 SQL 需在 Supabase 项目里手动执行一次（沙箱无法直连远端）。
-- 执行前表不存在时，auctionTagStore 的云端读写会被 try/catch 兜底，localStorage 仍正常工作。

create table if not exists auction_board_tags (
  date       text        not null,
  stock      text        not null,
  tag        text,
  updated_at timestamptz default now(),
  primary key (date, stock)
);

comment on table auction_board_tags is '竞价看板标签：每日每只股票的买/卖/持标记（业务数据，上云持久化）';

create index if not exists idx_auction_board_tags_date on auction_board_tags (date);

alter table auction_board_tags enable row level security;

drop policy if exists "allow_all_auction_board_tags" on auction_board_tags;
create policy "allow_all_auction_board_tags"
  on auction_board_tags
  for all
  to anon
  using (true)
  with check (true);

-- 加入 Realtime 发布，支持多设备标签同步
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'auction_board_tags'
  ) then
    alter publication supabase_realtime add table auction_board_tags;
  end if;
end $$;
