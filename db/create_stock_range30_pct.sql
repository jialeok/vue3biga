-- ============================================================================
-- 「30日涨幅」结果缓存表（跨设备共享 · 免每次打开都重算 K 线）
-- 应用层：src/data/stock-range30-cache.js（读写） / src/logic/auction/range30.js（编排）
--
-- 为什么要有它：
--   30 日涨幅 = 期末收盘价 / 期初前收盘价 − 1（一次性比值，⛔ 不是逐日连乘，见 range30.js 头部）。
--   原始价从腾讯前复权日线批量取（fetchQtDailyBars，10 只/批），算完不落库的话，
--   每次打开应用 / 切日期 / 刷新都要再拉一遍同样的 K 线。本表把结果按 (date, stock, leg) 缓存
--   ⇒ 第二次打开、切回某天、换设备，都只花 1 次查询。
--
-- ⚠️ 本表是【加速层】，不是真相源（与 stock_range20_pct 完全同款语义）：
--   读取失败 / 表不存在 ⇒ 应用侧降级为「纯内存现算」，⛔ 绝不当成「这天没有数据」。
--   ⇒ 没跑本 SQL 也能用，只是每次打开慢一点；跑完立即生效（无需刷新，30 秒冷却后自动重试）。
--
-- 与 stock_range20_pct / stock_range_pct 的关系：**必须是独立的表，⛔ 不要复用**。
--   · stock_range_pct   主键 (date,stock)，days 只有 10/8/9/7/6（十日口径）；
--   · stock_range20_pct 主键 (date,stock,leg)，days=20 且读取方会把非 'auc' 的 leg 一律
--     归一化成 'close' ⇒ 30 日行写进去会被【二十日读取方】当成自己的行复用（污染榜单）。
--   ⇒ 30 日结果单独一张表，days 语义明确为 30，互不覆盖（§6 单一真相）。
--
-- 口径列 leg（与 range20 同名同义，便于复用同一套反解）：
--   'close' = 收盘口径（30 个交易日全部用收盘价）—— 唯一落库的口径；
--   'auc'   = 竞价口径【不落库】，读取时由 range30-auction-leg.js 用 market_metrics 的
--             auc_pct_chg / change_pct 把「今天那一根腿」反解回 9:25 竞价（与十日/二十日同一把尺子）。
--   ⇒ 这样竞价口径永远跟着当天的竞价涨幅实时变，不会留下一份「早上写死的假收盘腿」。
--
-- 执行方式：Supabase Dashboard -> SQL Editor -> 新建 Query -> Run（幂等，可重复执行）
-- ============================================================================

create table if not exists stock_range30_pct (
  date       text        not null,   -- 窗口结束日 T（= 看板当前日期）
  stock      text        not null,   -- 股票名称
  pct        text,                   -- 30 日区间涨幅(%)，形如 "+178.91"；算不出为 null（⛔ 不写 0）
  days       int         default 0,  -- 窗口内实际有成交的 K 线根数（停牌会 < 30）
  leg        text        not null default 'close',  -- 口径：'close'（唯一落库口径）/ 'auc'（保留位）
  updated_at timestamptz default now(),
  primary key (date, stock, leg)
);

comment on table stock_range30_pct is
  '「30日涨幅」结果缓存：含今天在内 30 个交易日的区间涨幅（期末收盘/期初前收盘 − 1，算完落库避免重复拉 K 线）';
comment on column stock_range30_pct.days is
  '窗口内实际有成交的 K 线根数（停牌/次新股会 < 30）；低于可信门槛的票不写行';
comment on column stock_range30_pct.leg is
  'close = 收盘口径（唯一落库）；竞价口径不落库，读取时按当天 auc_pct_chg 实时反解';

-- 行级安全：与 stock_range20_pct / stock_range_pct / auction_watchlist 保持一致（anon 全开放）
alter table stock_range30_pct enable row level security;

drop policy if exists "allow_all_stock_range30_pct" on stock_range30_pct;
create policy "allow_all_stock_range30_pct"
  on stock_range30_pct for all to anon using (true) with check (true);

-- 常用查询：某日全量（看板一次读一天）
create index if not exists idx_stock_range30_pct_date on stock_range30_pct (date);
