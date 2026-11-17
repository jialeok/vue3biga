-- 临时核心词（规则登记表 〇·a · 输入层，不改任何选股条文）
--
-- 用户口径（2026-11-17 原话）：
--   「我新建核心词的时候，点击临时题材，它只会影响到当天日期和未来两天日期的题材，
--     不会影响到历史日期和未来更多日期，未来更多日期还是沿用原有题材（就是没有勾选的）」
--   「我在第三个日期关停，题材又恢复主流题材，相当临时题材生效时间于少一天」
--
-- 生效区间 = [start_date, start_date 之后第 2 个交易日]（设置日 + 后两天，共 3 个交易日），
--   交易日推进由前端 src/logic/topic/temp-core-topic.js#endDateOf 计算（⛔ 不用自然日 +2）。
-- disabled_from = 关停日（含当日及之后到区间末全部失效）；NULL = 未关停。
-- 关停后清空该字段即为「恢复」。
--
-- ⛔ 本表与 core_topics 完全独立：core_topics 是主流题材词的唯一真相源，
--   其核心管理弹窗的 saveCoreTopics 是【按 name 差集删除 + 全量 upsert】，
--   把临时词塞进那张表会被当成普通词参与覆盖、被误删/误改。
--   因此临时词必须单独存；改动只在输入侧按日期换一张词表，规则层一行不动。
--
-- 本 SQL 需在 Supabase SQL Editor 手动执行一次（幂等，可重复跑）。
create table if not exists core_topic_temp (
  id             bigserial primary key,
  name           text        not null,             -- 临时大类名，如「东方」
  synonyms       text,                             -- 与 core_topics 同格式：JSON.stringify 后的字符串数组
  start_date     date        not null,             -- 设置日（允许填过去的日期 ⇒ 历史补录）
  disabled_from  date,                             -- 关停日（含）；NULL = 未关停
  created_at     timestamptz default now(),
  updated_at     timestamptz default now()
);

comment on table core_topic_temp is '临时核心词：设置日起 3 个交易日内参与题材归类，历史日/第4天起/关停后沿用主流题材';

create index if not exists idx_core_topic_temp_dates
  on core_topic_temp (start_date, disabled_from);

alter table core_topic_temp enable row level security;

drop policy if exists "allow_all_core_topic_temp" on core_topic_temp;
create policy "allow_all_core_topic_temp" on core_topic_temp
  for all to anon using (true) with check (true);

-- 多端同步：在一端关停/恢复后，其它端的第二页题材分类要实时跟着变。
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'core_topic_temp'
  ) then
    alter publication supabase_realtime add table core_topic_temp;
  end if;
end $$;
