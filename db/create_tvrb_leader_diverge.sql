-- ============================================================================
-- 「题材量比」看板 · 【总龙分歧判定表（近 20 日窗口）】tvrb_leader_diverge
-- 应用层（读）：src/data/leader-diverge-days.js（唯一读取入口）
--               src/composables/useTopicVolRatioBoard.js#ensureLeaderDivergeDays → ebbCtx.leaderDiverge
-- 云端（写）：workers/bidding-auto-fetch/logic/leader-diverge-days.js
--             （9:27 snapshot 末 + 16:00 close 末各跑一次；也可 workflow_dispatch 手动补）
--
-- ── 为什么必须【云端】预计算并落库（2026-11-13 用户口径 · 原话）──────────────
--   「你帮我完成啊，不要留着，记住都是在云端运行，关电脑也能用，不要电脑本地的，
--     我之前强调好几次了，把没完成的完成」
--
--   第二十五条（总龙首次分歧 / 二次分歧 ⇒ 等同首次退潮）的输入不是一个数，而是一整段历史：
--     ① 这只票近 20 个交易日【每一天】的竞价涨幅（market_metrics scope=auction）
--     ② 每一天的收盘涨幅（stock_daily_pct —— 判涨停 / 判「高开低走收绿」）
--     ③ 每一天的竞价量 ÷ 昨量（auction_watchlist.volume / yest_volume —— 判占比塌陷）
--     ④ 每一天它是不是【20日涨幅·9:25 竞价口径】榜的第 1 名（判「霸榜总龙一 ≥3 天」）
--   ⇒ ④ 要为 20 个交易日各反解一次全市场榜。放浏览器就是「换台电脑 / 没开页面就没判定」，
--     正是用户反复否掉的形态。⇒ 全部在 Cloudflare Worker 里算完，前端只读一行。
--
-- ── 与 tvrb_diverge_days 的分工（⛔ 两张表别混）──────────────────────────────
--   · tvrb_diverge_days  —— 【首次分歧】结论（today_first / 首板日 / 首次分歧日），前端 K 线链路算；
--   · tvrb_leader_diverge —— 【首次 / 二次分歧】整段判定（kind / 霸榜天数 / 事件计数 / 逐日留痕），
--                            云端算。第二十五条的「二次分歧 ⇒ 等同退潮」只认这张表。
--
-- 执行方式：Supabase Dashboard -> SQL Editor -> 新建 Query -> Run（幂等，可重复执行）
-- 表不存在时：前端自动退化为「不做第二十五条判定」（= 加这张表之前的行为，§11 零风险），
--             控制台留痕；Worker 写入失败只记日志、⛔ 不影响 9:27 / 16:00 的其它步骤。
-- ============================================================================

create table if not exists tvrb_leader_diverge (
  date              text        not null,   -- 【展示日】YYYY-MM-DD（判定窗口的右端）
  stock             text        not null,   -- 那天的【市场总龙一】（9:25 竞价口径 20 日涨幅第 1 名）
  kind              text,                   -- none | first | second | unknown（二=f 二次分歧⇒等同退潮）
  qualified         boolean     default false,  -- 总龙资格：窗口内霸榜总龙一 >=3 天
  reason            text,                   -- 判据出口（second-diverge / second-no-streak / not-total-dragon …）
  dragon_days       integer,                -- 窗口内当总龙一的天数
  event_count       integer,                -- 分歧事件次数（连续日合并成一次）
  start_date        text,                   -- 起点 = 窗口内第一次涨停那天（首板）
  first_date        text,                   -- 【首次分歧】起始日
  first_end_date    text,                   -- 首次分歧最后一天（连续多日时）
  second_date       text,                   -- 【二次分歧】起始日（kind='second' 才有值）
  second_end_date   text,                   -- 二次分歧最后一天
  boards_after_first integer,               -- 首次分歧后 5 个交易日内的涨停数（二次分歧附加条件）
  window_days       integer,                -- 判定窗口交易日数（恒 20）
  leg_phase         text,                   -- intraday（9:27，今日无收盘腿）/ close（16:00，收盘腿齐全）
  rows              jsonb,                  -- 逐日留痕：date/aucPct/closePct/share/limitUp/isDragonOne
  updated_at        timestamptz default now(),
  primary key (date, stock)
);

comment on table tvrb_leader_diverge is
  '题材量比看板 · 第二十五条总龙分歧判定（近20交易日窗口）：kind=second ⇒ 按用户口径等同首次退潮；由 Cloudflare Worker 在 9:27 / 16:00 云端预计算后 upsert，前端只读（关电脑也不影响判定）';

-- 行级安全：与 tvrb_ebb_days / tvrb_diverge_days 一致（anon 全开放读写）
alter table tvrb_leader_diverge enable row level security;

drop policy if exists "allow_all_tvrb_leader_diverge" on tvrb_leader_diverge;
create policy "allow_all_tvrb_leader_diverge"
  on tvrb_leader_diverge for all to anon using (true) with check (true);

-- 按日期倒序取（前端只查展示日那一行；留痕/复核常要连续几天）
create index if not exists idx_tvrb_leader_diverge_date on tvrb_leader_diverge(date desc);
