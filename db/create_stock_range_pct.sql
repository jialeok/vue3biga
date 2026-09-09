-- ============================================================================
-- 题材龙头判定：股票「近10个交易日区间涨幅」缓存表
-- 应用层：src/data/stock-range-pct.js（读写） / src/logic/auction/dragon-rank.js（编排）
-- 为什么必须缓存：猫抓 daily 接口每天只有 10 次额度，龙头排名每次打开题材 toggle 都要用，
--   绝不能每次渲染都打接口。窗口 = [T-9, T] 共 10 个交易日，一次批量请求算完并存本表，
--   当天 15:00 前用「竞价涨幅」占位、15:00 后由收盘涨幅覆盖后重算一次（每天最多 1~2 次请求）。
-- 执行方式：Supabase Dashboard -> SQL Editor -> 新建 Query -> Run（幂等，可重复执行）
-- ============================================================================

create table if not exists stock_range_pct (
  date      text        not null,   -- 区间结束日 T（与看板当前日期一致）
  stock     text        not null,   -- 股票名称
  range_pct text,                   -- 区间涨幅(%)，形如 "+12.34"；无数据为 null
  days      int         default 0,  -- 实际参与计算的天数（不足 10 天说明数据缺失）
  updated_at timestamptz default now(),
  primary key (date, stock)
);

comment on table stock_range_pct is
  '题材龙头判定缓存：股票近10个交易日区间涨幅（猫抓 daily 一次批量请求算出并缓存，避免重复消耗接口额度）';

-- 行级安全：与 auction_watchlist / market_metrics 保持一致（anon 全开放）
alter table stock_range_pct enable row level security;

drop policy if exists "allow_all_stock_range_pct" on stock_range_pct;
create policy "allow_all_stock_range_pct"
  on stock_range_pct for all to anon using (true) with check (true);

-- 按日期快速查询某天的全部区间涨幅
create index if not exists idx_stock_range_pct_date on stock_range_pct(date);
