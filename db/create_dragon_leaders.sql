-- ============================================================================
-- 龙头组名册表 dragon_leaders
-- 应用层：src/data/dragon-leaders.js（读写） / src/logic/auction/dragon-group.js（评选+编排）
--
-- 【产品口径】
--   · 按【题材】选龙头：当日该题材成员 >= 3 只时，选出唯一一只龙头，
--     依据 = 该股「近 10 个交易日区间涨幅」（权威值来自 stock_range_pct）。
--   · 龙头【落库】，键 = 评选日 date（= 该龙头被选出的那一天 T）。
--   · 看板看某日 D 时，龙头组 = 名册中 date = prevTradingDay(D) 的行（即「每天的龙头放到次日」）。
--   · 与 auction_watchlist / market_metrics 一样，是跨设备共享的云端业务数据（§6/§8）。
--
-- 【为什么落库而不是每次现算】
--   ① §6 单一真相：龙头名单只算一次、只存一份，前端展示与 worker 抓取名单共用同一份，
--      避免「前端算一套、worker 算一套」的两个真相源（规则一改必漏改）。
--   ② 需求：9:25 自动抓取必须【完整获取】龙头组数据 —— worker 9:25 按本表
--      （date = 前一交易日）把龙头并入抓取名单，因此本表是 worker 的输入。
--
-- 执行方式：Supabase Dashboard -> SQL Editor -> 新建 Query -> Run（幂等，可重复执行）
-- ============================================================================

-- 【主键 = (date, topic)】而不是 (date, topic, stock)：
--   一个题材在一个评选日【只有一只】龙头。若主键含 stock，则盘后由竞价口径重算成收盘口径、
--   龙头换人时会在同一天同一题材留下【两行】（旧龙头 + 新龙头），读出来就是「一个题材两只龙头」。
--   锁定 (date, topic) 后，同题材换人只做 upsert 覆盖，天然幂等。
--
-- 【⚠️ 但 upsert 只增不删，必须配「整表对齐」】——2026-09-15 实操事故：
--   9/15 那次评选因【共享题材库尚未就绪】把 33/39 只股票误分到「其它」，只写出 1 行
--   （AI应用→桂林旅游）；而「名册非空 ⇒ 视为已评选」让补评选再也不会触发
--   → 这行残缺被永久冻结，9/16 整天只显示 1 只龙头。
--   ⇒ 权威评选之后必须把「本次已不成立（成员数 < 3）」的题材行清掉，
--     由 Data 层 deleteDragonLeadersForDate() 执行（小范围、按题材名精确匹配、带回读校验，§11）。
create table if not exists dragon_leaders (
  date       text        not null,   -- 评选日 T（龙头由 T 的题材 + T 日十日涨幅选出，供 T+1 展示）
  topic      text        not null,   -- 题材（核心词，与题材分组同一口径）
  stock      text        not null,   -- 龙头股票名
  code       text,                   -- 股票代码（worker 抓取按 code 查询）
  range_pct  text,                   -- 评选时的近10日区间涨幅(%)，形如 "+12.34"
  group_size int         default 0,  -- 评选时该题材的成员数（>= 3 才评选）
  updated_at timestamptz default now(),
  primary key (date, topic)
);

comment on table dragon_leaders is
  '龙头组名册：每日按题材(成员>=3)选出「近10日区间涨幅最高」的龙头，供次日第一页龙头组展示 + worker 9:25 并入抓取名单';

-- 行级安全：与 auction_watchlist / market_metrics / stock_range_pct 保持一致（anon 全开放）
alter table dragon_leaders enable row level security;

drop policy if exists "allow_all_dragon_leaders" on dragon_leaders;
create policy "allow_all_dragon_leaders"
  on dragon_leaders for all to anon using (true) with check (true);

-- 按日期快速查询某天（= 某评选日）的全部龙头
create index if not exists idx_dragon_leaders_date on dragon_leaders(date);
