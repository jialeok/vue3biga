-- 遗留全量数据 / 会话 token 表（§8 合规：user_data 为旧版整库 blob 兼容表 + 登录态 token 行）
-- 应用层：
--   - src/logic/workflows/auction-sync.js：pullFromCloud 读 .from('user_data').select('data').eq('id','owner').single()
--     （owner 行存整个应用数据 blob，type: jsonb）
--   - src/data/watchlist-and-metrics.js：writeSessionToken / readSessionToken
--     用 upsert({ id:'session', data:{ _session_token }, updated_at }) 读写登录态，Realtime 监听 user_data_changes(UPDATE)
-- 写入字段对齐代码：
--   SELECT：data（.single() 读）
--   upsert：{ id, data, updated_at }；id 取值 'owner'（整库 blob）或 'session'（登录 token）
-- 注意：本 SQL 需在 Supabase 项目里手动执行一次。
-- ⚠ TODO: user_data 为历史兼容大表，owner 行 data 为任意结构 jsonb（不可推断内部 schema），
--   仅确认外表列 id / data / updated_at。新功能不应再向此表写入业务数据。
create table if not exists user_data (
  id         text        not null primary key,  -- 'owner'（整库 blob）| 'session'（登录 token）
  data       jsonb,
  updated_at timestamptz default now()
);

comment on table user_data is '遗留兼容表：owner 行存整库 blob、session 行存登录 token（历史兼容，新功能勿用）';

alter table user_data enable row level security;

drop policy if exists "allow_all_user_data" on user_data;
create policy "allow_all_user_data" on user_data for all to anon using (true) with check (true);

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='user_data') then
    alter publication supabase_realtime add table user_data;
  end if;
end $$;
