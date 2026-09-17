-- ============================================================================
-- 涨跌停池表 limit_pool
-- 应用层：src/data/limit-pool.js（读写） / src/logic/limitpool/limit-pool.js（加载+自愈+派生）
--         src/views/LimitBoard.vue（「涨跌停」看板，独立组件）
-- 上游：同花顺 fuyao
--   · 涨停池 GET /api/a-share/special-data/limit-up-pool
--   · 跌停池 GET /api/a-share/special-data/limit-down-pool
--   抓取执行者：① Supabase Edge Function limit-pool-fetch 每个交易日【北京 15:40】自动抓（主）
--              （独立函数、独立同花顺小号，由 pg_cron 触发 → db/supabase_limit_pool_cron.sql）
--              ② 前端「涨跌停」看板打开时若当日缺数据且已过 15:40 → 自愈补抓（兜底）
--
-- 【产品口径】
--   · 按交易日 T 存【当日 T 15:00 收盘后】的涨停/跌停股票池（15:40 抓，避开收盘瞬间的上游未终态）。
--   · 主键 = (date, board, stock)：同一天同一板、同一只股票只有一行。
--     board ∈ 'up'（涨停板）| 'down'（跌停板）。
--   · 涨跌停【都要】：看板上面是跌停板、下面是涨停板，中间蚂蚁线分隔。
--
-- 【为什么落库而不是每次现拉】
--   ① §6 单一真相：一份数据、一次抓取，跨设备/多次打开共用，避免每次打开都打上游接口；
--   ② §8：跨设备共享的业务数据必须上云，换设备/清缓存不能丢；
--   ③ 上游「涨停原因 / 连板天数 / 封单额」是当日快照语义，过期不补 → 必须当天落库存档。
--
-- 【⚠️ 整日对齐（§11 删除安全）】
--   涨跌停池是「某日全量快照」，重跑时必须让该日结果 = 本次抓取结果（否则旧行会残留，
--   出现「某只票今天已不在涨停池却仍显示涨停」的假象）。
--   因此写入走 Data 层 replaceLimitPoolForDate()：先 upsert 本次结果，再删掉该日该板
--   「本次已不在池中」的旧行；【只有涨停池与跌停池都抓成功才允许写】，任一失败整体放弃
--   （宁可保持旧快照，也不写出半张表）。
--   ⚠️ 跌停池「0 只」是合法状态（强势日可以一只跌停都没有）→ 此时该板整日清空是正确的。
--
-- 执行方式：Supabase Dashboard -> SQL Editor -> 新建 Query -> Run（幂等，可重复执行）
-- ============================================================================

create table if not exists limit_pool (
  date             text        not null,   -- 交易日 YYYY-MM-DD
  board            text        not null,   -- 'up' 涨停板 | 'down' 跌停板
  stock            text        not null,   -- 股票简称（与题材库 stock_topics.stock 同一键，题材互通靠它）
  code             text,                   -- 6 位纯代码
  thscode          text,                   -- 带交易所后缀（603986.SH）
  price            numeric,                -- 最新价（元）
  change_pct       text,                   -- 涨跌幅文本，形如 "+10.00" / "-10.01"（与库内其它表同口径：text）
  limit_time       text,                   -- 涨停时间（HH:MM）；跌停池 = 首次跌停时间
  last_limit_time  text,                   -- 最后跌停时间（仅跌停池有）
  reason           text,                   -- 涨停原因（上游空串标准化为 null）
  continue_text    text,                   -- 连板文本："首板" / "2连板" / "5天4板"
  continue_cnt     int,                    -- 连板计数（首板 = 1）
  seal_money       numeric,                -- 当前封单额（元）
  max_seal_money   numeric,                -- 峰值封单额（元）
  turnover_ratio   numeric,                -- 换手率（%，仅跌停池有）
  updated_at       timestamptz default now(),
  primary key (date, board, stock)
);

comment on table limit_pool is
  '涨跌停池：每交易日 15:40 抓同花顺涨停/跌停股票池（board=up/down），供「涨跌停」看板按题材分组展示 + 按十日涨幅选龙头';

comment on column limit_pool.board is 'up=涨停板, down=跌停板';
comment on column limit_pool.stock is '股票简称，与 stock_topics.stock 同键 → 与早盘竞价看板题材互通';

-- 行级安全：与 auction_watchlist / market_metrics / stock_range_pct / dragon_leaders 保持一致（anon 全开放）
alter table limit_pool enable row level security;

drop policy if exists "allow_all_limit_pool" on limit_pool;
create policy "allow_all_limit_pool"
  on limit_pool for all to anon using (true) with check (true);

-- 按日期查询某天整池（看板主查询：date + board）
create index if not exists idx_limit_pool_date_board on limit_pool(date, board);

-- Realtime：15:40（limit-pool-fetch）写完后，已打开看板的其它设备自动刷新（§31 需配套订阅，见 data/limit-pool.js）
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'limit_pool'
    ) then
      alter publication supabase_realtime add table limit_pool;
    end if;
  end if;
end $$;

-- 让 PostgREST 立刻刷新 schema cache。
-- 症状对照：若前端红字 `Could not find the table 'public.limit_pool' in the schema cache`
-- （PGRST205），99% 是【本文件还没执行过】——那不是一个「调用/读数方式」问题，
-- 就是这张表不存在。若确实执行过本文件却仍报这句，再跑下面这行刷新缓存。
notify pgrst, 'reload schema';

-- 自检（执行完后跑一遍，应返回两行 up / down，或空表也算「已建好」）：
-- select board, count(*) from limit_pool group by board;
