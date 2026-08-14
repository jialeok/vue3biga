-- 负面题材标记表（§8 合规：hasFumianTopic_* 派生业务标记从 localStorage 双写到 Supabase）
-- 应用层：src/data/fumian-sync.js（写经 Supabase upsert + localStorage 兜底）
-- 注意：本 SQL 需在 Supabase 项目里手动执行一次。表不存在时 fumian-sync 云端读写被 try/catch 兜底，localStorage 仍正常。
create table if not exists topic_fumian (
  date       text        not null primary key,
  has_fumian boolean     not null default false,
  updated_at timestamptz default now()
);

comment on table topic_fumian is '每日负面题材布尔标记（派生业务数据，上云持久化）';

create index if not exists idx_topic_fumian_date on topic_fumian (date);

alter table topic_fumian enable row level security;

drop policy if exists "allow_all_topic_fumian" on topic_fumian;
create policy "allow_all_topic_fumian"
  on topic_fumian
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
      and tablename = 'topic_fumian'
  ) then
    alter publication supabase_realtime add table topic_fumian;
  end if;
end $$;
