-- 核心题材词库表（§8 合规：core_topics 为核心题材词唯一真相源）
-- 应用层：src/logic/ui-bridge.js（pullCoreTopicsFromCloud / pushCoreTopicsToCloud）
--          src/logic/topic/rules.js（初始化推送默认核心词）
-- 写入字段对齐代码 src/logic/ui-bridge.js：
--   SELECT：name,synonyms,updated_at
--   pushCoreTopicsToCloud：先 delete().neq('name','___never___') 清空，再 insert({ name, synonyms, updated_at })
--   说明：synonyms 由代码 JSON.stringify(数组) 写入、JSON.parse 读出 → 以 text 存 JSON 字符串
-- 注意：本 SQL 需在 Supabase 项目里手动执行一次。
-- ⚠ TODO: 代码从不订阅 core_topics 的 Realtime（审计 §31 标注"写无订阅"），
--   因此下方 Realtime 发布块默认保留但不强制；如需多端同步核心词可启用。
create table if not exists core_topics (
  name       text        not null primary key,
  synonyms   text,                          -- 存储 JSON.stringify 后的字符串数组，如 '["同花顺","东方财富"]'
  updated_at timestamptz default now()
);

comment on table core_topics is '核心题材词库：name + 同义词 synonyms（JSON 字符串），前端匹配题材用';

alter table core_topics enable row level security;

drop policy if exists "allow_all_core_topics" on core_topics;
create policy "allow_all_core_topics" on core_topics for all to anon using (true) with check (true);

-- 审计 §31：core_topics 当前代码无 Realtime 订阅，故此处不自动加入 supabase_realtime 发布。
-- 若后续需要多端同步核心词，取消下方注释即可：
-- do $$
-- begin
--   if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='core_topics') then
--     alter publication supabase_realtime add table core_topics;
--   end if;
-- end $$;
