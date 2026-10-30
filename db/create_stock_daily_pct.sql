-- ============================================================================
-- 「逐日收盘涨幅腿」持久表（20日 / 10日 / 任意窗口涨幅的唯一原料）
-- 应用层：src/data/stock-daily-pct.js（读写） / src/logic/auction/range20.js（编排）
--
-- 为什么必须建（用户 2026-10-30 原话）：
--   「为什么每次打开都要实时计算，非常耗时间，比如那些历史数据先存好，次日在算次日，
--     这样不更快吗？为什么每次都要同花顺实时重新拉取，拉取当天的就可以，再加上历史日期，
--     有些票不在当天正式列表的，看表里有没有数据，有的话看哪天没有补哪天，没有的话，就全补，
--     这样局部补数据，而不是每次整体获取，这样很慢，影响体验。」
--
--   事实（2026-10-30 实测）：`stock_range20_pct` 存的是【窗口涨幅】（date = 窗口结束日 T），
--   按 (date, stock) 主键 ⇒ 每天都是新日期 ⇒ 每天都不命中 ⇒ 前端/预计算【每天把 54 只票
--   全部重拉一遍】。而上游同花顺当日实测「6 只里 3 只挂死 15 秒」（50% 无响应），
--   预计算 142 秒只写成功 1 行。窗口涨幅不可拆解，所以表再大也复不了。
--
--   ⇒ 本表存【逐日腿】(date = 那个交易日)：
--     今天 T 的 20 日窗口 = [T-19, T]，明天 T+1 的窗口 = [T-18, T+1]，共享 18 根腿。
--     存逐日腿 ⇒ 第二天只缺 1 根（而那一根就是 T+1 的竞价涨幅，`auction_watchlist` 里本来就有）
--     ⇒ 稳态下【每天 0 个 K 线请求】。
--
-- 与其它表的关系（⛔ 别合并）：
--   · `stock_range20_pct` = 算完的【结果】（窗口涨幅，按 T 存）—— 保留，作为首屏快路径；
--   · `stock_range_pct`   = 十日口径结果（Worker/收盘评选龙头时写）—— 不动；
--   · 本表 = 可复用的【原料】（逐日收盘涨幅）—— 新增。
--   三张表是「原料 / 20日结果 / 10日结果」，语义不同 ⇒ §6 单一真相要求分开存。
--
-- 为什么不用 `auction_watchlist.change_pct` 当原料（血泪，2026-10-19 实测）：
--   那张表早盘写入的是【竞价涨幅】，收盘后才被收盘涨幅覆盖；未被覆盖的历史行永久留竞价值，
--   而且只收录「当天正式名单」的票 ⇒ 大量历史日缺行。实测澳弘电子 20 日窗口按它复算 59.30%，
--   按同花顺 K 线复算 117.38%（用户炒股软件 = 117.4%）⇒ 库内值错了近一倍。
--   ⇒ 本表只接受【同花顺日线前复权】换算出来的日涨幅（src='kline'）。
--
-- 执行方式：Supabase Dashboard → SQL Editor → 新建 Query → Run（幂等，可重复执行）
-- ============================================================================

create table if not exists stock_daily_pct (
  date       text        not null,   -- 交易日 YYYY-MM-DD
  stock      text        not null,   -- 股票名称
  pct        text,                   -- 当日收盘涨幅(%)，形如 "+3.21" / "-1.05"；停牌或取不到 ⇒ 不写行
  src        text        not null default 'kline',  -- 来源：kline = 同花顺日线前复权（唯一可信源）
  updated_at timestamptz default now(),
  primary key (date, stock)
);

comment on table stock_daily_pct is
  '逐日收盘涨幅腿：20日/任意窗口涨幅的原料。存逐日腿才能跨日期复用（窗口涨幅无法拆解，所以旧表每天都要全量重拉）';
comment on column stock_daily_pct.pct is
  '该交易日收盘涨幅(%)，前复权口径（日间比值 = 真实涨跌幅）。取不到/停牌 ⇒ 不写行（§10 缺数据 ≠ 0%）';

-- 行级安全：与本项目其它行情表一致（anon 全开放，前端直读）
alter table stock_daily_pct enable row level security;

drop policy if exists "allow_all_stock_daily_pct" on stock_daily_pct;
create policy "allow_all_stock_daily_pct"
  on stock_daily_pct for all to anon using (true) with check (true);

-- 主查询形态：按日期区间取一窗口（date >= from and date <= to）⇒ 复合索引最省
create index if not exists idx_stock_daily_pct_date on stock_daily_pct(date);
create index if not exists idx_stock_daily_pct_stock on stock_daily_pct(stock);

-- ============================================================================
-- 建完后自检（逐条跑）
-- ============================================================================
-- ① 表能读（应返回 0 行，不是报错）：
--   select count(*) from stock_daily_pct;
--
-- ② 回填进度（每天有多少只票的腿）：
--   select date, count(*) from stock_daily_pct
--    where date >= to_char(now() - interval '60 days', 'YYYY-MM-DD')
--    group by date order by date;
--
-- ③ 某只票的腿是否连续（看有没有断日）：
--   select date, pct from stock_daily_pct where stock = '新华传媒' order by date desc limit 20;
--
-- ④ 90 天前的腿可以清（表只服务当前窗口 + 近期复盘；清完不影响 20 日口径）：
--   delete from stock_daily_pct where date < to_char(now() - interval '120 days', 'YYYY-MM-DD');
-- ============================================================================
