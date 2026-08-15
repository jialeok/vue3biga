-- 热门股票竞/昨高光表（hot_stocks_highlights，加速加载，与 daily_highlights 同构）
-- 应用层：src/data/hot-stocks.js（读经 pullHotStocksHighlights，写经 pushHotStocksHighlights）
-- 写入字段对齐代码 src/data/hot-stocks.js：
--   SELECT：date,stock,jing_yest_highlight  +  .eq('jing_yest_highlight', true)
--   update：{ jing_yest_highlight: false, updated_at }  再 upsert { date, stock, jing_yest_highlight: true, updated_at }
--   onConflict：'date,stock'
-- 注意：本 SQL 需在 Supabase 项目里手动执行一次。
create table if not exists hot_stocks_highlights (
  date               text        not null,
  stock              text        not null,
  jing_yest_highlight boolean     not null default false,
  updated_at         timestamptz default now(),
  primary key (date, stock)
);

comment on table hot_stocks_highlights is '热门股票预计算竞/昨高光缓存：命中股票集合（加速看板加载）';

create index if not exists idx_hot_stocks_highlights_date on hot_stocks_highlights (date);

alter table hot_stocks_highlights enable row level security;

drop policy if exists "allow_all_hot_stocks_highlights" on hot_stocks_highlights;
create policy "allow_all_hot_stocks_highlights" on hot_stocks_highlights for all to anon using (true) with check (true);

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='hot_stocks_highlights') then
    alter publication supabase_realtime add table hot_stocks_highlights;
  end if;
end $$;
