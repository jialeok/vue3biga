-- 热门股票趋势图数据表（hot_stock_trends，历史趋势快照；主数据源已迁 market_metrics scope=hot）
-- 应用层：src/data/hot-stocks.js（读经 loadHotTrendsFromCloud，写经 pushHotTrendsToCloud）
-- 写入字段对齐代码 src/data/hot-stocks.js：
--   SELECT：date,stock,code,volume,yest_volume,change_pct
--   upsert 行：{ date, stock, code, volume, yest_volume, change_pct, updated_at, updated_by }
--     onConflict：'date,stock'
--   delete：.eq('date', date).eq('stock', stock)
-- 说明：volume / yest_volume / change_pct 在代码中均以字符串读写（|| ''），故用 text；
--   updated_by 标记写入方（代码固定为 'main'）。该表为兼容回退旧表，RLS 拒绝前端写入时不影响主流程。
-- 注意：本 SQL 需在 Supabase 项目里手动执行一次。
create table if not exists hot_stock_trends (
  date        text        not null,
  stock       text        not null,
  code        text,
  volume      text,
  yest_volume text,
  change_pct  text,
  updated_at  timestamptz default now(),
  updated_by  text,
  primary key (date, stock)
);

comment on table hot_stock_trends is '热门股票趋势图快照：成交量/昨成交量/涨幅（旧表，主数据源为 market_metrics scope=hot）';

create index if not exists idx_hot_stock_trends_date on hot_stock_trends (date);

alter table hot_stock_trends enable row level security;

drop policy if exists "allow_all_hot_stock_trends" on hot_stock_trends;
create policy "allow_all_hot_stock_trends" on hot_stock_trends for all to anon using (true) with check (true);

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='hot_stock_trends') then
    alter publication supabase_realtime add table hot_stock_trends;
  end if;
end $$;
