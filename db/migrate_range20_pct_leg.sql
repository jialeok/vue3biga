-- ============================================================================
-- [TVRB-AUC-LEG-PRESERVE 2026-11-10] 让「竞价口径」与「收盘口径」在结果表里并存
--
-- ★★ 为什么必须做（用户 11-10 报障，取证见 .tmpdiag/tvrb-1110-leg-audit.cjs）★★
--   20 日涨幅结果表 stock_range20_pct 原主键 = (date, stock)，**不含 leg**，
--   同一天同一只票物理上只能存一行。实际发生：
--     09:25 云端写 leg='auc'（竞价口径，题材量比选股的唯一依据）
--        ↓
--     16:30 GitHub Actions supabase-heal.yml → range20-precompute?healOnly=1
--           → backfillRange20FromLegs 的 haveSet 只查 leg='close' ⇒ 判「一行都没有」
--           → 按收盘腿全量重算，on_conflict=date,stock 覆盖
--        ↓
--     当天 81 行全部变成 leg='close'，两腿并存 0 只，结果表里的竞价口径行被整表覆盖
--        ↓
--     15:00 后前端 resolveT20LegMode 切 close → getRange20Leaders 换榜 →
--     题材量比 ebbCtx.top5 换成员 ⇒ 早上选出的「冰山冷热 · 弱势切抱团(第三十条)」下午消失。
--   用户铁口径：「题材量比看板那里，都是按照竞价口径的，收盘改变不了的」。
--
-- ⚠️ 措辞更正（2026-11-11，用户亲自纠正）：⛔ 不要说「竞价快照不可再生 / 算不出来 / 没存」。
--   market_metrics(scope=auction) 的 auc_pct_chg + change_pct 与 stock_daily_pct 历史腿都在库里，
--   recoverAuctionLeg 可反解回 9:25 竞价腿（实测冰山冷热竞价口径主板第 2 名、收盘第 3 名，
--   两个口径都在第三十条前三）。真正病根是【规则输入源吃了会变的发布榜】，不是数据缺失。
--   本 DDL 解决的是「两个业务数据挤在同一行」这一存储层根因（§6 单一真相），
--   规则层整类修复已随 commit b70eb4e 上线（tvrb-auction-board.js 恒竞价口径榜）。
--
-- ⇒ 两个口径是【两个业务数据】，不该挤在同一行（ARCHITECTURE V3 §6 单一真相）。
--   本迁移把主键加上 leg，让 9:25 的 auc 行与盘后的 close 行各存各的、互不覆盖。
--
-- ⚠️ 幂等：可重复执行。现有数据每个 (date,stock) 只有一行，加 leg 不会产生冲突。
-- ⚠️ 执行方式：Supabase Dashboard → SQL Editor → 新建 Query → 粘贴 → Run。
-- ⚠️ 执行【之后】才可以把代码里的 on_conflict=date,stock 改成 date,stock,leg
--    （清单见本文件末尾）。⛔ 顺序反了会 400 PGRST，线上写入全挂。
-- ============================================================================

-- ① 去掉旧主键（名字以 Postgres 默认为准；幂等）
alter table public.stock_range20_pct
  drop constraint if exists stock_range20_pct_pkey;

-- ② leg 必须非空才能进主键（建表时已是 not null default 'close'，这里兜底旧库）
update public.stock_range20_pct set leg = 'close' where leg is null or leg = '';
alter table public.stock_range20_pct alter column leg set default 'close';
alter table public.stock_range20_pct alter column leg set not null;

-- ③ 新主键：同一天、同一只票、不同口径各一行
alter table public.stock_range20_pct
  add primary key (date, stock, leg);

-- ④ 复核（执行后这几行应能看出两腿是否并存）
-- select date, leg, count(*) from public.stock_range20_pct
--  where date >= to_char(now() - interval '10 days', 'YYYY-MM-DD')
--  group by date, leg order by date desc, leg;

comment on column public.stock_range20_pct.leg is
  'auc = 9:25 竞价口径（题材量比选股唯一依据，⛔ 盘后不许覆盖）；close = 收盘口径（复盘用）';

-- ============================================================================
-- 【状态：本 DDL 已于 2026-11-11 在 SQL Editor 执行完毕】（第二批已同步上线）
-- ----------------------------------------------------------------------------
-- 零写入探测实证：`?on_conflict=date,stock` → HTTP 400 / 42P10；
--                 `?on_conflict=date,stock,leg` → 201。
-- ⇒ 当前线上唯一约束已经是 (date,stock,leg)，⛔ 任何写这张表的代码都不许再用两列。
--
-- ✅ 已上线、不依赖本 DDL（commit b70eb4e / 3a7bd9c）：
--    题材量比【整类规则】恒 9:25 竞价口径，唯一来源
--    src/logic/topicvolratio/tvrb-auction-board.js
--    （反解 stock_range20_pct + market_metrics(scope=auction) 白名单），
--    ⛔ 不再直接注入 getRange20Leaders*，收盘后不改变。
--    ⇒ 本 DDL 不是「修冰山冷热」的前置条件，是【存储层两腿并存】的根治。
--
-- ✅ DDL 后第二批（本轮已改完，随前端 + Worker + Edge 一起发布）：
-- 1. db/edge/range20-precompute/index.ts
--    · 4 处 `?on_conflict=date,stock` → `?on_conflict=date,stock,leg`
--      （backfillRange20FromLegs / R20-DAILY 快路径 / flush() / 单票补写）
--    · haveSet 恢复 `&leg=eq.close`：两腿并存后 close 轮只补 close 腿、不碰 auc 行。
--      ⛔ DDL 未执行时「当天任意口径行即跳过」才是止血，顺序反了会重新引发覆盖事故。
-- 2. src/data/stock-range20-cache.js
--    · upsertRange20Rows → `onConflict: 'date,stock,leg'`
--    · readRange20Rows → byLeg 按口径各存一行（⛔ 旧 Map<stock,一行> 会随机丢一腿）
--    · pickUsableRows(map, leg) 优先取 byLeg[want] 该口径自己的行
-- 3. workers/bidding-auto-fetch/data/supabase-write.js
--    · upsertRange20Rows → `?on_conflict=date,stock,leg`
--    · readRange20TopForDate → sbGetPaged 分页 + order=stock.asc,leg.asc + close 优先去重
-- 4. db/scripts/backfill-range20.mjs / backfill-range20-pct.mjs 同步加 leg。
--
-- ⚠️ 事故复盘（为什么必须同步）：DDL 执行后旧代码仍写两列 ⇒ 11-11 9:26 / 9:27
--    两次 r20-prefill 全部 400/42P10 ⇒ 当天 stock_range20_pct 0 行 ⇒ 前端退回
--    浏览器现算 40+ 次 K 线（30~90s）⇒ 用户感知「题材量比出结果慢」。
--    ⛔ 这不是 CPU 计算慢，是数据没落地。
--
-- ⚠️ 重贴 Edge 后先跑一次 dry=1 / healOnly=1 观察日志，⛔ 别直接全量覆盖写。
-- ============================================================================
