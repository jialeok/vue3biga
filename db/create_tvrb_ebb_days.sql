-- ============================================================================
-- 「题材量比」看板 · 【退潮判定表】tvrb_ebb_days
-- 应用层：src/data/ebb-days.js（唯一读写入口）
--         src/logic/topicvolratio/topic-vol-ratio-rules.js#detectEbbDay（消费它判「首日」）
--
-- ── 为什么必须落库（2026-10-14 用户口径 · 原话）──────────────────────────────
--   「你应该把数据存起来啊，做一个表也行，不然很难判断出来，因为现在的逻辑是通过判断
--     没有竞价量等判断出来的，是缓存吧？你要完善这点」
--
--   背景：退潮规则【只在市场总龙首日出现停牌 / 占比不达标的那一天】生效，第二天（总龙连续
--   停牌）就【不算】了。要判「今天是不是首日」，就必须知道【昨天那只总龙到底算不算退潮】。
--   而这件事：① suspend.js 只判当天（上游快照无 date 参数）⇒ 历史恒 false，答不了；
--             ② 靠昨日行情行（竞价量 / 占比）反推 ⇒ 是「推断」不是「判定」，不可靠。
--   ⇒ 把【每天亲眼算出来的退潮判定】存下来，第二天直接读那一行。
--
-- 执行方式：Supabase Dashboard -> SQL Editor -> 新建 Query -> Run（幂等，可重复执行）
-- 表不存在时：前端会自动退化为「按昨日行情行推断」，并在控制台留痕（不会报错、不影响看板）。
-- ============================================================================

create table if not exists tvrb_ebb_days (
  date            text        not null,   -- 判定日 YYYY-MM-DD（主键：一天一行）
  leader_stock    text,                   -- 那天算出的【市场总龙】= 昨日十日涨幅第一、有龙位
  leader_topic    text,                   -- 总龙所属题材
  leader_pct      numeric,                -- 总龙【昨日】十日涨幅（判定所用的那个口径）
  leader_rank     numeric,                -- 总龙【当日】龙位名次（1 = 龙一）
  suspended       boolean     default false,  -- 总龙【当日】是否停牌（suspend.js 的判定）
  share           numeric,                -- 总龙【当日】竞价占比（%）；null = 缺数据
  share_fail      boolean     default false,  -- 占比是否不达标（门槛：龙头 3.5% / 其余 2%）
  ebb             boolean     default false,  -- 那天算不算【退潮】= suspended or share_fail
  buy_second      text,                   -- 那天买点侧唯一那只（当日十日涨幅第二）；留痕供复核
  buy_second_pct  numeric,                -- 它的当日十日涨幅
  source          text,                   -- 判定来源标记（默认 'tvrb-board'）
  updated_at      timestamptz default now(),
  primary key (date)
);

comment on table tvrb_ebb_days is
  '题材量比看板 · 退潮判定落库：每天算出的退潮事实（总龙 / 停牌 / 占比 / 是否退潮 / 唯一买点），供次日判「是不是首日」；由前端在看板算出结论后 upsert';

-- 行级安全：与 auction_watchlist / market_metrics / stock_range_pct 一致（anon 全开放读写）
alter table tvrb_ebb_days enable row level security;

drop policy if exists "allow_all_tvrb_ebb_days" on tvrb_ebb_days;
create policy "allow_all_tvrb_ebb_days"
  on tvrb_ebb_days for all to anon using (true) with check (true);

-- 按日期倒序取最近若干天（判首日只需昨天那一行，但留痕/复核常要连续几天）
create index if not exists idx_tvrb_ebb_days_date on tvrb_ebb_days(date desc);
