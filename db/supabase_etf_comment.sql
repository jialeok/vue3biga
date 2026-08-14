-- 板块ETF点评表（§8 合规：stockEtfComment 业务数据从 localStorage 双写到 Supabase）
-- 应用层：src/data/etf-comment-sync.js（写经 Supabase upsert + localStorage 兜底）
-- 注意：本 SQL 需在 Supabase 项目里手动执行一次。表不存在时云端读写被 try/catch 兜底，localStorage 仍正常。

create table if not exists auction_etf_comment (
  date       text        not null primary key,
  comment    jsonb       not null,
  updated_at timestamptz default now()
);

comment on table auction_etf_comment is '板块ETF每日点评：{date: comment}（业务数据，上云持久化）';

create index if not exists idx_auction_etf_comment_date on auction_etf_comment (date);

alter table auction_etf_comment enable row level security;

drop policy if exists "allow_all_auction_etf_comment" on auction_etf_comment;
create policy "allow_all_auction_etf_comment"
  on auction_etf_comment
  for all
  to anon
  using (true)
  with check (true);

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'auction_etf_comment'
  ) then
    alter publication supabase_realtime add table auction_etf_comment;
  end if;
end $$;
