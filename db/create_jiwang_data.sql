-- 记忘看板 / 昨日复盘独立表（§8 合规：jiwang 数据上云持久化，跨设备不丢）
-- 应用层：src/data/jiwang-data.js（读写经 Supabase upsert + 内存缓存；读经 pullJiwangFromTable）
-- 写入字段对齐代码 src/data/jiwang-data.js：
--   SELECT：date,diezhang,qingxu,jujiao,"whoIncrease","kxianPrefix",kxian,guancha,
--           "guochengJieguo","shouguJieguo",jielun,chushou,stats,updated_at
--   upsert：{ date, diezhang, qingxu, jujiao, whoIncrease, kxianPrefix, kxian, guancha,
--             guochengJieguo, shouguJieguo, jielun, chushou, stats, updated_at }
--   注释明确：stats 为弹性 jsonb（行情阶段/仓位/勾选项等，字段持续增加，不逐个拆列）
-- 注意：本 SQL 需在 Supabase 项目里手动执行一次。
-- 代码对 date 列要求唯一约束（onConflict:'date'），呼应 pullJiwangFromTable 的重复行告警。
create table if not exists jiwang_data (
  date              text        not null primary key,
  diezhang          text,
  qingxu            text,
  jujiao            text,
  "whoIncrease"     text,
  "kxianPrefix"     text,
  kxian             text,
  guancha           text,
  "guochengJieguo"  text,
  "shouguJieguo"    text,
  jielun            text,
  chushou           text,
  stats             jsonb,
  updated_at        timestamptz default now()
);

comment on table jiwang_data is '记忘看板/昨日复盘文本字段 + 弹性 stats jsonb（按日期唯一，业务数据上云持久化）';

create index if not exists idx_jiwang_data_date on jiwang_data (date);

alter table jiwang_data enable row level security;

drop policy if exists "allow_all_jiwang_data" on jiwang_data;
create policy "allow_all_jiwang_data" on jiwang_data for all to anon using (true) with check (true);

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='jiwang_data') then
    alter publication supabase_realtime add table jiwang_data;
  end if;
end $$;
