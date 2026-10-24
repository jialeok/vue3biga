-- ============================================================================
-- auction_presence.sql — 「涨幅前十 · 在列次数」预计算（建表 + 纯 SQL 计算函数 + pg_cron）
-- 应用层：src/data/auction-presence.js（只读） / src/logic/auction/presence-label.js（判定与文案）
--
-- ★ 需求（用户 2026-10-23 逐字）：
--   「你在早盘竞价看板，10日涨幅 toggle 单独打开后，把排名前十的股票，在这 10 个交易日中
--     出现过几次标记起来，状态也存起来……打上小标签比如"5次在列"，"首次在列"，单独打开
--     20 日涨幅 toggle 时也要，20 个交易日的也要存起来，也存在表里（排名前十的）。
--     这样响应才快，我会用这个出现次数做分析。」
--   AskUserQuestion 三答：「只给前十名标」/「Supabase 定时算好落表（推荐）」/「含今天（推荐）」。
--
-- ★ 本表存什么、不存什么（重要）：
--   · 存：某日 T 在某窗口（10 / 20 个交易日）下，**每只票在名单里出现过几天**。
--     一行 = (date=T, window_days=10|20, stock)，cnt = 窗口内（含 T）在 auction_watchlist 里的天数。
--   · 不存：排名。为什么？「排名前十」是【看板当前排序下的前十】，排序键是区间涨幅
--     （10 日读 stock_range_pct、20 日读 range20.js 现算结果），且不同时刻（09:25 竞价腿 /
--     15:05 收盘腿）数值不同、补位票还会插进来 —— 数据库里算一遍必然与屏幕上的顺序对不上。
--     ⇒ 名次由前端按它自己的排序取前十（presence-label.js#assignPresenceLabels），
--       本表只提供「次数」这个昂贵且与排序无关的部分。用户要的「响应快」正是这部分。
--   · 不存 cnt = 0 的票：窗口内一次都没进过名单 ⇒ 没有行。前端据此显示「未在列」
--     （前提：covered_days > 0，即窗口内确实有名单数据；否则一律不标，§10 不许把"不知道"显示成"零"）。
--
-- ★ 数据来源只有一张表：auction_watchlist（当天早盘竞价看板名单，唯一真相，§6）。
--   ⚠️ 补位的「20天」票是前端注入的展示行，从不入库 ⇒ 它们在窗口里没进过名单就是 cnt=0，
--      这不是缺数据，正是要告诉用户的信息（"新龙头之前没上过榜"）。
--   ⛔ 零上游请求、零猫抓额度：纯库内计算，不碰同花顺 / 猫抓（不会 429）。
--
-- 执行方式：Supabase Dashboard → SQL Editor → 新建 Query → 整段粘贴 → Run
--   幂等：表用 if not exists；函数用 create or replace；cron 先 unschedule 再 schedule；
--         计算函数本身是「先删后插」⇒ 重跑零漂移。
-- ============================================================================

-- ============ ① 建表 ============
create table if not exists auction_presence (
  date         text not null,             -- 统计基准日 T（= 看板当前日期，YYYY-MM-DD）
  window_days  int  not null,             -- 统计窗口（交易日数）：10 = 「10日涨幅」toggle / 20 = 「20日涨幅」toggle
  stock        text not null,             -- 股票名称（与 auction_watchlist.stock 同键）
  cnt          int  not null default 0,   -- 窗口内（含 T）该票在名单里出现的天数（>= 1 才会建行）
  covered_days int  not null default 0,   -- 窗口内【实际有名单数据】的天数（§10：能否 vs 有没有，必须分开报）
  listed_dates text,                      -- 命中的日期，逗号分隔（如 "2026-10-13,2026-10-16"，供核对/分析）
  updated_at   timestamptz default now(),
  primary key (date, window_days, stock)
);

comment on table auction_presence is
  '「涨幅前十 · 在列次数」预计算：某日 T 的最近 N 个交易日里，每只票在早盘竞价看板名单(auction_watchlist)中出现过几天。只读表，由 recompute_auction_presence() 写入。';
comment on column auction_presence.window_days is
  '统计窗口（交易日数）：10 = 「10日涨幅」toggle 口径；20 = 「20日涨幅」toggle 口径';
comment on column auction_presence.cnt is
  '窗口内（含当天）在 auction_watchlist 里出现的天数；窗口内一次没进过名单的票【不建行】（前端按 0 次处理）';
comment on column auction_presence.covered_days is
  '窗口内实际有名单数据的天数（历史缺口 / 停市会小于 window_days；前端据此如实提示覆盖度）';
comment on column auction_presence.listed_dates is
  '命中的具体日期（逗号分隔，升序），用于核对与人工分析';

-- 行级安全：与 auction_watchlist / stock_range_pct / market_metrics 保持一致（anon 全开放）
alter table auction_presence enable row level security;

drop policy if exists "allow_all_auction_presence" on auction_presence;
create policy "allow_all_auction_presence"
  on auction_presence for all to anon using (true) with check (true);

-- 主键 (date, window_days, stock) 已覆盖「按日期+窗口查全部票」的唯一主要读法，无需额外索引。
-- 下面这个只服务「某只票在历史上出现几次」这类人工分析查询。
create index if not exists idx_auction_presence_stock on auction_presence(stock, window_days);


-- ============ ② 计算函数（纯 SQL，幂等） ============
-- 口径（与前端 isTradingDay 完全一致）：
--   交易日 = 周一~周五 且 trading_day_overrides 未标 is_holiday = true 的日期。
--   ⚠️ 2026-10-01 ~ 10-07 是国庆休市（云端已标 is_holiday = true）——
--      这几天 auction_watchlist 里还有 11 行残留数据，⛔ 千万别用「watchlist 有行的日期」当交易日历，
--      否则会把这 5 天算进窗口、同时把真正的前 5 个交易日挤出去。
create or replace function recompute_auction_presence(
  p_date    date,
  p_windows int[] default array[10, 20]
) returns integer
language plpgsql
as $fn$
declare
  v_w       int;
  v_dates   text[];
  v_covered int;
  v_rows    int;
  v_total   int := 0;
  v_key     text := to_char(p_date, 'YYYY-MM-DD');
begin
  if p_date is null then
    raise exception 'recompute_auction_presence: p_date 不能为空';
  end if;

  foreach v_w in array p_windows loop
    -- ① 窗口 = 以 p_date 结尾的最近 v_w 个交易日（升序）。多取一些自然日以覆盖长假。
    select array_agg(x.dt order by x.dt)
      into v_dates
      from (
        select to_char(g, 'YYYY-MM-DD') as dt
          from generate_series(
                 (p_date - (v_w * 2 + 15))::timestamp,
                 p_date::timestamp,
                 interval '1 day') g
         where extract(isodow from g) < 6
           and not exists (
                 select 1
                   from trading_day_overrides t
                  where t.date = to_char(g, 'YYYY-MM-DD')
                    and t.is_holiday = true
               )
         order by g desc
         limit v_w
      ) x;

    if v_dates is null then
      continue;   -- 防御：窗口内一个交易日都没有（理论上不会发生）
    end if;

    -- ② 覆盖度 = 窗口内真正有名单数据的天数（§10：能不能 vs 有没有，分开报）
    select count(distinct w.date)::int
      into v_covered
      from auction_watchlist w
     where w.date = any(v_dates);

    -- ③ 覆盖写（幂等）：先删该 (日期, 窗口) 的旧结论，再按当天数据重算插入
    delete from auction_presence
     where date = v_key
       and window_days = v_w;

    insert into auction_presence(date, window_days, stock, cnt, covered_days, listed_dates, updated_at)
    select v_key,
           v_w,
           s.stock,
           s.cnt,
           coalesce(v_covered, 0),
           array_to_string(s.dates, ','),
           now()
      from (
        select btrim(w.stock)                    as stock,
               count(distinct w.date)::int       as cnt,
               array_agg(distinct w.date order by w.date) as dates
          from auction_watchlist w
         where w.date = any(v_dates)
           and coalesce(btrim(w.stock), '') <> ''
         group by btrim(w.stock)
      ) s;

    get diagnostics v_rows = row_count;
    v_total := v_total + v_rows;
  end loop;

  return v_total;
end
$fn$;

comment on function recompute_auction_presence(date, int[]) is
  '重算某日 T 的「在列次数」（窗口默认 10 与 20 天）：读 auction_watchlist 纯库内计算，幂等（先删后插），零上游请求。';


-- ============ ③ 历史回补（★ 幂等，可随时重跑） ============
-- 默认回补最近 90 个自然日（≈60 个交易日）内所有有名单的日期：
--   select backfill_auction_presence();                       -- 近 90 天
--   select backfill_auction_presence('2026-09-01');           -- 指定起点
--   select backfill_auction_presence('2025-01-01');           -- 全历史（12215 行名单 ≈ 270 天，几秒到几十秒）
create or replace function backfill_auction_presence(
  p_from    date default null,
  p_windows int[] default array[10, 20]
) returns integer
language plpgsql
as $fn$
declare
  v_day  text;
  v_n    int := 0;
  v_from date := coalesce(p_from, current_date - 90);
begin
  for v_day in
    select distinct w.date
      from auction_watchlist w
     where w.date >= to_char(v_from, 'YYYY-MM-DD')
     order by w.date
  loop
    perform recompute_auction_presence(to_date(v_day, 'YYYY-MM-DD'), p_windows);
    v_n := v_n + 1;
  end loop;
  return v_n;
end
$fn$;

comment on function backfill_auction_presence(date, int[]) is
  '按日期逐日回补「在列次数」（默认近 90 天）。幂等：重跑不会漂移。';


-- ============ ④ pg_cron：每天两轮（09:30 名单到齐后 / 15:05 收盘后） ============
-- 为什么是 09:30 而不是 09:25：当天名单是 09:25 前后由 worker 写入（实测 created_at ≈ 09:25:22），
--   留 5 分钟余量，避免算出「当天还没进名单」的残缺结果。
-- 为什么还要 15:05 一轮：盘中可能手动增删名单行（updated_by = 'main'），收盘后再收一次尾。
-- 只在周一~五触发；节假日 compute 出来是空集（窗口里没数据就 cnt 全 0 ⇒ 不插行），无副作用。
create extension if not exists pg_cron;

do $$
begin
  perform cron.unschedule('auction-presence-open');
exception when others then null;
end $$;
do $$
begin
  perform cron.unschedule('auction-presence-close');
exception when others then null;
end $$;

select cron.schedule(
  'auction-presence-open',
  '30 1 * * 1-5',   -- UTC 01:30 周一~周五 = 北京 09:30
  $job$
  select recompute_auction_presence((now() at time zone 'Asia/Shanghai')::date);
  $job$
);

select cron.schedule(
  'auction-presence-close',
  '5 7 * * 1-5',    -- UTC 07:05 周一~周五 = 北京 15:05
  $job$
  select recompute_auction_presence((now() at time zone 'Asia/Shanghai')::date);
  $job$
);


-- ============================================================================
-- ============ ⑤ 首次部署后跑一次回补（在 SQL Editor 里单独执行）============
--   select backfill_auction_presence();          -- 近 90 天，够覆盖 20 个交易日窗口
-- ============ ⑥ 部署后自检（逐条跑）============
-- 两条任务是否已登记：
--   select jobname, schedule, active from cron.job where jobname like 'auction-presence%';
-- 今天两个窗口各写了多少行（10 天窗口 ≈ 窗口内名单并集；20 天窗口更大）：
--   select window_days, count(*), min(covered_days), max(covered_days)
--     from auction_presence
--    where date = to_char((now() at time zone 'Asia/Shanghai')::date, 'YYYY-MM-DD')
--    group by window_days order by window_days;
-- 抽查某只票的次数与命中日期（cnt 应等于 listed_dates 的逗号个数 + 1）：
--   select date, window_days, stock, cnt, covered_days, listed_dates
--     from auction_presence
--    where stock = '新华传媒' order by date desc, window_days limit 10;
-- 与名单原始数据对账（10 天窗口，今天）：
--   with cal as (
--     select to_char(g,'YYYY-MM-DD') as dt
--       from generate_series(
--              ((now() at time zone 'Asia/Shanghai')::date - 33)::timestamp,
--              (now() at time zone 'Asia/Shanghai')::date::timestamp,
--              interval '1 day') g
--      where extract(isodow from g) < 6
--        and not exists (select 1 from trading_day_overrides t
--                         where t.date = to_char(g,'YYYY-MM-DD') and t.is_holiday = true)
--      order by g desc limit 10
--   )
--   select w.stock, count(distinct w.date) as cnt_should_be
--     from auction_watchlist w
--    where w.date in (select dt from cal)
--    group by w.stock order by cnt_should_be desc limit 10;
-- ============================================================================
