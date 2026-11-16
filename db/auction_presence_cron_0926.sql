-- ============================================================================
-- auction_presence_cron_0926.sql — 把「在列次数」预计算从 09:30 提前到 09:26
--
-- ★ 为什么要改（2026-11-16 用户报障「每到收盘又变了」，真实取证）：
--   定稿时刻 = 北京 09:27（`bidding_fetch_log.time_point=snapshot`，created_at 01:27:30Z）
--   而 `auction-presence-open` 这条 pg_cron 写的是 `30 1 * * 1-5` = 北京 **09:30**
--   ⇒ 选股算第二十九条的时候，`auction_presence` 当天的行【还不存在】
--   ⇒ `tvrb-plan.js` 的 `r10DataReady` 要求 `range10Presence.counts && coveredDays > 0`
--   ⇒ 恒 false ⇒ 第二十九条「排名第二的题材量比太小 ⇒ 整块作废」**每天早上都不会生效**
--   ⇒ 页面按「放行」定稿；等 09:30 表生成后，只要页面因任何原因重算一次
--     （改题材 / 换规则版本 / 收盘流程），结论就会翻脸 —— 这就是「收盘后又变了」。
--
--   11-16 实例：09:27 定稿 3 只（大消费 1 + AI应用 2）；16:27 重算时 presence 已有
--   ⇒ AI应用 平均竞价量比 16.62 < 25 ⇒ 整块作废 ⇒ 候补北纬科技是竞价一字 ⇒ 只剩 1 只。
--   ⚠️ 量比本身是【竞价口径】没错（猫抓 09:25 返回 350 行含 auc_vol_ratio，
--      ladder26 日志「当日 9:25 名单竞价量比齐全」），缺的是**在列次数这张派生表**。
--
-- ★ 为什么 09:26 安全：
--   `auction_watchlist` 当天名单在 09:25:28 就落库（日志「⏱ 名单落库 +6263ms @09:25:28」），
--   而 recompute_auction_presence 只读 auction_watchlist + trading_day_overrides，纯库内计算，
--   零上游请求、零猫抓额度 ⇒ 09:26:00 跑，秒级完成，09:27 定稿前必然可读。
--
-- ⚠️ 只改「开盘那一轮」；收盘 15:05 那轮（`auction-presence-close`）保持不变。
-- 执行方式：Actions → Apply Supabase SQL → sql_file = db/auction_presence_cron_0926.sql, confirm = YES
--   （或 Supabase Dashboard → SQL Editor 整段粘贴执行）
-- 幂等：先 unschedule 再 schedule，可重复执行。
-- ============================================================================

do $$
begin
  perform cron.unschedule('auction-presence-open');
exception when others then null;
end $$;

select cron.schedule(
  'auction-presence-open',
  '26 1 * * 1-5',   -- UTC 01:26 周一~周五 = 北京 09:26（原 09:30，比 09:27 定稿晚 3 分钟）
  $job$
  select recompute_auction_presence((now() at time zone 'Asia/Shanghai')::date);
  $job$
);

-- 验证：应看到 auction-presence-open 的 schedule = '26 1 * * 1-5'
select jobname, schedule, active
from cron.job
where jobname in ('auction-presence-open', 'auction-presence-close')
order by jobname;

-- ★ 补算今天（如果今天 09:30 那轮没跑成 —— 11-16 实测 auction_presence.updated_at = 15:05，
--   说明开盘那轮当天没落库）。纯库内计算，可安全重跑。
select recompute_auction_presence((now() at time zone 'Asia/Shanghai')::date);
