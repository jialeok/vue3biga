-- 对标/对板块数据表（§8 合规：duibanData 业务数据从 localStorage 双写到 Supabase，跨设备不丢）
-- 应用层：src/data/duiban-sync.js（写经 Supabase upsert + localStorage 兜底；读经 loadDuibanData）
-- 注意：本 SQL 需在 Supabase 项目里手动执行一次（沙箱无法直连远端）。
-- 表不存在时 duiban-sync 的云端读写被 try/catch 兜底，localStorage 仍正常。
create table if not exists auction_duiban (
  date       text        not null primary key,
  data       jsonb       not null,
  updated_at timestamptz default now()
);

comment on table auction_duiban is '对标/对板块每日数据：{date: [...]}（业务数据，上云持久化）';

create index if not exists idx_auction_duiban_date on auction_duiban (date);

alter table auction_duiban enable row level security;

drop policy if exists "allow_all_auction_duiban" on auction_duiban;
create policy "allow_all_auction_duiban" on auction_duiban for all to anon using (true) with check (true);

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='auction_duiban') then
    alter publication supabase_realtime add table auction_duiban;
  end if;
end $$;
