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
--     当天 81 行全部变成 leg='close'，两腿并存 0 只，竞价快照**不可再生地丢失**
--        ↓
--     15:00 后前端 resolveT20LegMode 切 close → getRange20Leaders 换榜 →
--     题材量比 ebbCtx.top5 换成员 ⇒ 早上选出的「冰山冷热 · 弱势切抱团(第三十条)」下午消失。
--   用户铁口径：「题材量比看板那里，都是按照竞价口径的，收盘改变不了的」。
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
-- 【DDL 执行后，代码需要同步改的调用点清单】（本轮⛔ 未改，等确认后一次性上线）
-- ----------------------------------------------------------------------------
-- 1. db/edge/range20-precompute/index.ts
--    · :1814  backfillRange20FromLegs 的 upsert
--    · :2458  R20-DAILY 快路径落库
--    · :2502  flush() 批量落库
--    · :2614  单票补写
--    以上 `?on_conflict=date,stock` → `?on_conflict=date,stock,leg`
--    · :1754  本轮已把当天 haveSet 改成「任意口径都算已有」；两腿并存后恢复
--             `&leg=eq.close`（close 轮只补 close 腿，不碰 auc 行）。
--
-- 2. src/data/stock-range20-cache.js#upsertRange20Rows
--    `?on_conflict=date,stock` → `?on_conflict=date,stock,leg`
--
-- 3. src/data/stock-range20-cache.js#readRange20Rows
--    现在是 Map<stock, 一行>，两腿并存会丢一腿 ⇒ 必须改成按 leg 分组
--    （或让 pickUsableRows 拿到带 leg 的全量行后再按口径过滤）。
--
-- 4. 题材量比看板 useTopicVolRatioBoard.js:1223/1226/1229
--    range20Top / range20Wide / range20Top10 恒读 auc 腿（竞价口径），
--    ⛔ 不再随 15:00 的 resolveT20LegMode 切换；主看板「20日涨幅」列不受影响。
--
-- 5. workers/bidding-auto-fetch/data/supabase-write.js#readRange20TopForDate
--    同股双行现在可能跨口径，按 leg 明确取用（竞价期取 auc）。
-- ============================================================================
