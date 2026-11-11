-- ============================================================================
-- 「题材量比」看板 · 【选股结论快照表】tvrb_plan_snapshot
-- 应用层：src/data/tvrb-plan-snapshot.js（唯一读写入口）
--         src/logic/topicvolratio/plan-snapshot-codec.js（序列化 / 校验）
--         src/composables/useTopicVolRatioBoard.js（定稿写入 / 切日期读取）
--
-- ── 为什么必须有这张表（2026-11-11 用户口径 · 原话）──────────────────────────
--   「昨天11月10日，题材量比的选票结果冰山火热又不见了……是不是系统自动切换到今天，
--     昨天的记录就消失了，我有时要看历史日期复盘的，为什么老是搞失踪……
--     这不是一只票问题，是整个类的问题，你只修了局部吧？」
--
--   事故链（2026-11-11 只读取证）：
--     ① 选股结论只存在内存 ref `_buyPublished`，组件卸载即清空，全仓库无对应表；
--        项目只把【退潮判定】落了 tvrb_ebb_days，选票结论漏了。
--     ② 切到历史日期 ⇒ watch(currentDate) 解冻 ⇒ 用【当前库内数据】重算一遍。
--        而 11-10 的 stock_range20_pct 81 行全是 close 腿（16:30 被覆盖）、0 行 auc 腿，
--        market_metrics 的 11-10 行甚至在 11-11 09:25 又被 worker 重写过 ⇒ 输入本身会漂移。
--     ③ resolveBuySettle 第⑬项门控写了「只对今天生效：历史日口径本来就恒 close、结果稳定」
--        ⇒ 历史日在异步竞价口径榜算完前就放行定稿，一份早期结论被冻结，之后再算对也不改屏幕。
--   ⇒ 这不是某一只票，是【所有历史日期 / 所有票】共用的坏链路。
--
-- ✅ 根治：把【定稿那一刻屏幕上那份 plan】按日期存下来；历史日期优先读快照、永不重算。
--   兜底：没有快照的旧日期（含 11-10）仍走恒竞价口径链路重算，并在说明区如实标注。
--
-- ── 红线 ───────────────────────────────────────────────────────────────────
--   · 一天一行（pk = date）；**只写一次**：写入用 ignoreDuplicates，先写的不被后写的覆盖
--     ⇒ 符合用户硬口径「题材量比选股都用竞价口径，每天收盘后都不要改变」。
--   · 只允许写【今天】；历史日重算出的结论 ⛔ 绝不写库（避免把降级结论固化成假存档）。
--   · leg 恒为 'auc'：这张表只存 9:25/9:26 竞价口径的选股结论，收盘口径不进这张表。
--   · §10：表不存在 / 读取失败 / 快照损坏，是三种不同状态，⛔ 不许一律当「没有快照」。
--
-- 执行方式：Supabase Dashboard -> SQL Editor -> 新建 Query -> Run（幂等，可重复执行）
-- 表不存在时：前端自动降级为「按恒竞价口径重算」，说明区显示「未存档」警示，不影响看板。
-- ============================================================================

create table if not exists tvrb_plan_snapshot (
  date          text        not null,       -- 选股结论所属交易日 YYYY-MM-DD（主键：一天一行）
  plan          jsonb       not null,       -- displayPlan 定稿快照（安全序列化后的纯 JSON 对象）
  leg           text        not null default 'auc',  -- 口径标记，恒为 auc（9:25 竞价口径）
  source        text        not null default 'tvrb-board',
  settled_at    timestamptz not null default now(),  -- 定稿时刻（北京 9:25/9:26 附近）
  created_at    timestamptz not null default now(),
  primary key (date)
);

comment on table tvrb_plan_snapshot is
  '题材量比看板 · 选股结论快照：每天 9:25 竞价口径定稿那一刻的 plan，一天一行、只写一次、盘后不覆盖；历史日期复盘直接读它，不再用会漂移的行情数据重算';

comment on column tvrb_plan_snapshot.plan is
  'displayPlan 定稿快照（JSON）；由 plan-snapshot-codec.js 编码/解码，读回后必须通过结构校验才允许当结论使用';

-- 行级安全：与 tvrb_ebb_days / auction_watchlist / market_metrics 一致（anon 全开放读写）
alter table tvrb_plan_snapshot enable row level security;

drop policy if exists "allow_all_tvrb_plan_snapshot" on tvrb_plan_snapshot;
create policy "allow_all_tvrb_plan_snapshot"
  on tvrb_plan_snapshot for all to anon using (true) with check (true);

-- 复核：某日有没有存档、什么时候定稿的
-- select date, leg, source, settled_at, jsonb_typeof(plan) as plan_type
--   from tvrb_plan_snapshot order by date desc limit 20;
