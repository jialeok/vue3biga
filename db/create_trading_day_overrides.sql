-- ============================================================================
-- 交易日覆盖表（用户在【前端顶栏日期栏】手动设置假期 / 取消假期）
--
-- 应用层：
--   前端  src/data/trading-day-overrides.js（读写） / src/logic/date/trading-day-helpers.js（编排）
--   Worker workers/_shared-source/trading-day.js（三源合并判定时读取）
--
-- 【为什么必须落库（§8 localStorage 红线）】
--   原来 holiday 只存 localStorage，导致两个致命问题：
--     ① 换设备 / 清缓存后用户标的假期全部丢失；
--     ② Worker 跑在 Cloudflare，**读不到任何 localStorage** —— 它在
--        workers/_shared-source/holidays.js 里另有一张硬编码假期表，
--        于是「用户在顶栏标红」对自动抓取完全无效（2026-09-25 中秋就是这样
--        被 Worker 当成交易日跑了整轮；反过来 2026-10-08 又被硬编码表误判为假期）。
--   本表 = 用户意志的唯一云端真相源，前端与 Worker 共用。
--
-- 【为什么是 (date, is_holiday) 而不是一张「假期列表」】
--   只存「哪些天是假期」无法表达【取消假期】：
--   用户把 10/01 从假期改回交易日时，从列表里删掉该行后，
--   三源判定会回退到硬编码表 —— 而硬编码表里 10/01 正是假期 ⇒ 取消操作失效。
--   因此必须显式存布尔值：
--     is_holiday = true   → 用户标为假期
--     is_holiday = false  → 用户显式取消假期（恢复交易日），会【压过】硬编码表
--   注意：永远不删行，只翻转布尔值。
--
-- 【三源优先级（Worker 侧，见 workers/_shared-source/trading-day.js）】
--   ① 本表（用户意志，能提前表达「未来的假期」——这是 fuyao 日历做不到的）
--   ② 周末
--   ③ fuyao 交易日历（命中即确认为交易日；不命中不下结论，见该文件注释）
--   ④ workers/_shared-source/holidays.js 硬编码表兜底
--
-- 执行方式：Supabase Dashboard -> SQL Editor -> 新建 Query -> Run（幂等，可重复执行）
-- ============================================================================

create table if not exists trading_day_overrides (
  date       text        not null,                 -- 日期 YYYY-MM-DD（与项目其它表保持 text 口径一致）
  is_holiday boolean     not null,                 -- true=假期；false=显式取消假期（恢复交易日）
  updated_at timestamptz default now(),
  updated_by text,                                 -- 预留：多端来源标记（当前前端写 'frontend'）
  primary key (date)
);

comment on table trading_day_overrides is
  '交易日覆盖：用户在前端顶栏手动设置的假期 / 取消假期。前端与 Cloudflare Worker 共用的交易日真相源。';
comment on column trading_day_overrides.is_holiday is
  'true=设为假期；false=显式取消假期（会压过硬编码假期表，所以不能被"删行"替代）';

-- 行级安全：与 auction_watchlist / market_metrics / stock_range_pct 保持一致（anon 全开放）
alter table trading_day_overrides enable row level security;

drop policy if exists "allow_all_trading_day_overrides" on trading_day_overrides;
create policy "allow_all_trading_day_overrides"
  on trading_day_overrides for all to anon using (true) with check (true);

-- 按日期区间查询（Worker 每轮只判 1~2 天，全表通常几十行，这里只为将来范围查询留索引）
create index if not exists idx_trading_day_overrides_date on trading_day_overrides(date);
