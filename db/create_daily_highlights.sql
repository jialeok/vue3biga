-- 预计算竞/昨高光表（加速加载，daily_highlights 为只读缓存表）
-- 应用层：src/data/daily-highlights.js（读经 pullDailyHighlights，Realtime 经 startHighlightsRealtime）
-- 读取字段对齐代码 src/data/daily-highlights.js：
--   SELECT：date,stock,jing_yest_highlight  +  .eq('jing_yest_highlight', true)
-- 写入方：抓取程序 / Worker（仓库内未见前端写入 daily_highlights 的代码，pushDailyHighlights 仅出现在注释中，
--   实际写入由抓取链路完成），故下表结构按「前端可读路径 + 与 hot_stocks_highlights 对称」重建。
-- 注意：本 SQL 需在 Supabase 项目里手动执行一次。
-- ⚠ TODO: 仓库内仅能确认 read 路径（date, stock, jing_yest_highlight）；
--   updated_at 由对称推断（hot_stocks_highlights 同结构）。抓取 Worker 可能写入额外高光列
--   （例如独立的 竞价高光 / 昨日高光 列），若上线后发现列缺失，请按 Worker 实际写入补列。
create table if not exists daily_highlights (
  date               text        not null,
  stock              text        not null,
  jing_yest_highlight boolean     not null default false,  -- 竞/昨高光命中标记（代码读取字段，已确认）
  updated_at         timestamptz default now(),            -- TODO: verify column/type（按 hot_stocks_highlights 对称推断）
  primary key (date, stock)
);

comment on table daily_highlights is '预计算竞/昨高光缓存：命中股票集合（加速看板加载，由抓取链路写入）';

create index if not exists idx_daily_highlights_date on daily_highlights (date);

alter table daily_highlights enable row level security;

drop policy if exists "allow_all_daily_highlights" on daily_highlights;
create policy "allow_all_daily_highlights" on daily_highlights for all to anon using (true) with check (true);

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='daily_highlights') then
    alter publication supabase_realtime add table daily_highlights;
  end if;
end $$;
