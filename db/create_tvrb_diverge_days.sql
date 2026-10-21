-- ============================================================================
-- 「题材量比」看板 · 【总龙分歧判定表】tvrb_diverge_days
-- 应用层：src/data/diverge-days.js（唯一读写入口）
--         src/composables/useTopicVolRatioBoard.js#ensureLeaderDivergence（写 + 读回种子）
--
-- ── 为什么必须落库（2026-10-21 用户口径）────────────────────────────────────
--   用户报障：切到历史日期（如 10-19）时，买点侧先按旧规则渲染出常规选票，停顿几秒后
--   才换成「总龙首次分歧」提示板 —— 因为分歧判定要等总龙的 K 线（同花顺免费通道，~11s）。
--   用户原话：「逻辑没有错，但是显示上有问题，就不能直接显示正确的吗？」
--
--   背景：分歧判定的全部输入 = 总龙的 K 线历史（收盘涨幅判涨停 / open 判低开）+ 该日竞价涨幅
--   —— 对历史日是【确定性】的（K 线历史不可变、竞价涨幅 9:25 后不变）⇒ 算过一次就可以落库，
--   下次切回该日【读回即用、一次到位】，连 K 线都不用等。
--
-- 执行方式：Supabase Dashboard -> SQL Editor -> 新建 Query -> Run（幂等，可重复执行）
-- 表不存在时：前端自动退化为「每次都走 K 线链路 + 判定未就绪时买点侧挂『判定计算中』占位」，
--             并在控制台留痕（不会报错、不影响看板正确性，只是历史日首次访问要多等十几秒）。
-- ============================================================================

create table if not exists tvrb_diverge_days (
  date                 text        not null,   -- 判定日 YYYY-MM-DD（主键：一天一行）
  leader_stock         text,                   -- 那天算出的【市场总龙一】（20日涨幅全市场第一）
  leader_topic         text,                   -- 总龙所属题材（写入时可能取不到 ⇒ null）
  can_judge            boolean     default false,  -- 判据链走通了没有（应用层恒写 true；false 恒不落库）
  today_first          boolean     default false,  -- 该日是不是总龙的【首次分歧日】（true ⇒ 该日买点侧 = 分歧板）
  first_board_ymd      text,                   -- 首板日（20日窗口内第一个收盘涨停日）YYYY-MM-DD；留痕复核
  first_divergence_ymd text,                   -- 首次分歧日（首板后第一个竞价涨幅 < 0 的日子）YYYY-MM-DD
  today_auc_pct        numeric,                -- 该日总龙采用的竞价涨幅（%，行情行优先 / K线 open 退路）
  updated_at           timestamptz default now(),
  primary key (date)
);

comment on table tvrb_diverge_days is
  '题材量比看板 · 总龙首次分歧判定落库：每天算出的分歧结论（是否首次分歧 / 首板日 / 首次分歧日），供切换日期时读回即用（一次到位渲染分歧板，不用再等 K 线）；由前端在判定链算出 canJudge=true 的结论后 upsert';

-- 行级安全：与 tvrb_ebb_days / auction_watchlist 一致（anon 全开放读写）
alter table tvrb_diverge_days enable row level security;

drop policy if exists "allow_all_tvrb_diverge_days" on tvrb_diverge_days;
create policy "allow_all_tvrb_diverge_days"
  on tvrb_diverge_days for all to anon using (true) with check (true);

-- 按日期倒序取最近若干天（切日期读回只需展示日那一行，留痕/复核常要连续几天）
create index if not exists idx_tvrb_diverge_days_date on tvrb_diverge_days(date desc);
