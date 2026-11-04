-- create_range20_cron.sql — 「20日涨幅 双腿预计算」定时触发（pg_cron + pg_net）
-- ============================================================
-- 配套 Edge Function：range20-precompute（见 db/edge/range20-precompute/index.ts）
-- 函数按【运行时刻】自动选腿，两条 cron 共用同一个函数 URL：
--   · UTC 01:25 = 北京 09:25 → 写 leg='auc'（竞价口径）⇒ 竞价期间打开秒开
--   · UTC 07:05 = 北京 15:05 → 写 leg='close'（收盘口径）⇒ 收盘后第一次打开秒开
--     （收盘价 15:00 定格，15:05 当天 K 线 bar 已是最终收盘价）
-- 均为周一~五；节假日靠函数内「名单等待超时」自然空转，无副作用。
-- 即便某条 cron 早/晚触发串了腿也无害：写错腿的行按 (date,stock) 主键会被
-- 正确腿的行 / 前端收盘重算覆盖，且前端按 leg 过滤不会读错。
--
-- ★★ [R20-DAILY 2026-10-30] 现在这两条 cron 依赖一张新表 `stock_daily_pct`（逐日收盘涨幅腿）：
--     · 09:25 那轮【历史腿全部从这张表读】⇒ K 线请求数 83 → 0（实测改造前 142s 只写成功 1 行）；
--     · 15:05 那轮把【今天这根腿】写回这张表（K 线今日 bar，收盘后才是终值）。
--     ⚠️ 这张表必须保持「最近 19 个交易日全齐」，否则函数会退回逐只拉 K 线（慢）。
--     ✅ 2026-11-01 起，补齐**全部在云端**完成，不再需要任何本机脚本：
--        见 db/create_range20_legs_cron.sql（两条 heal 任务：北京 16:30 / 08:50），
--        走 market_metrics 的收盘轮证据（updated_by 含 'close' + updated_at >= 15:00）自愈。
--        （旧做法 `node db/scripts/backfill-daily-pct.mjs --run --recent` 已降级为应急手段。）
--     ⚠️ 首次启用顺序不能反：① 执行 db/create_stock_daily_pct.sql
--                              ② 全量回填一次 node db/scripts/backfill-daily-pct.mjs --run
--                              ③ 再让 cron 跑（否则 09:25 那轮等于没改，仍然是逐只 K 线）
--
-- ★★ [R20-METRICS 2026-10-23] 同一个函数现在还顺带写 market_metrics（补位票的当日行情）：
--     · 09:25 那轮写：volume(竞价量，万股) / yest_volume(昨日成交量，万股) /
--                     auc_pct_chg(竞价涨幅) / auc_vol_ratio(竞价量比) / change_pct(=竞价涨幅)
--     · 15:05 那轮覆盖：change_pct 改成【收盘涨幅】（用户口径「收盘后再覆盖涨幅」）
--     目的：前端展开「补位票」趋势图时【0 上游请求】，直接读表就有当天数据。
--     为什么必须落库而不能让前端现补：前端现补要现场打同花顺，而 15:05 这轮 cron 刚把
--     上游配额烧完 ⇒ 实测前端补缺直接吃 `429 Global request rate limit exceeded`
--     ⇒ 补位票当天五条线全空。落库后前端只读，彻底与配额脱钩。
--     自检：select source, count(*) from market_metrics
--            where date = (now() at time zone 'Asia/Shanghai')::date and source = 'range20' group by 1;
--
--
-- ★★★ [R10-CLOUD 2026-11-04] 同一个函数现在还负责写【10 日区间涨幅】`stock_range_pct`。
--   用户原话：「20日区间涨幅是存在 supabase 上面啊，也是用里面的 ts 文件和表，你改 cloudflare
--   worker 和我说这个有矛盾吗，一定要改 worker 吗？supabase 跑不了？」
--   ⇒ 完全正确，所以 9:25 这一轮在写完 20 日之后，顺手把 10 日也算了：
--     · 历史 9 根腿 = `stock_daily_pct`（已有 48 个交易日，最早 2026-08-20）；
--     · 当天 T 腿 = `market_metrics.auc_pct_chg`（9:25 竞价涨幅）；
--     ⇒ **0 上游请求、0 猫抓额度**，全程在 Supabase 跑，不依赖用户开电脑。
--   实测验证（2026-11-04）：按腿表算出的值与腾讯前复权日线【逐位一致】；
--   而库里那 47 行（浏览器 09:46 补算的）里有 8 只偏差极大
--   （东方海洋 29.57 vs 49.80、文投控股 -6.05 vs 27.81、三峡新材 -24.53 vs -15.58 …）
--   ⇒ 竞价轮（leg='auc'）会**覆盖**当天已有行，把这些错值修正掉。
--   手动重算（部署后立刻修当天，不必等明天 9:25）：
--     curl -X POST '<URL>/functions/v1/range20-precompute?token=range20-cron-2026&range10=1'
--
--
-- ★★★ [AUC-VOL-LIST 2026-11-04] 同一个函数还负责把第一页【竞价量 / 昨成交量】两列补成真值。
--   用户原话：「UI上还是显示0或者-，但是五日趋势图当天是有竞价量和昨日成交量的，明白吗？
--   也就是显示层没有那个竞价量和昨日成交量列没有显示出来。」
--
--   实测取证（2026-11-04 当天，market_metrics scope='auction'）：
--     · 56 行全是 source='worker'，其中 32 行 volume 为空/0、32 行 yest_volume 为 null；
--     · 这 32 行里 31 行的 auc_vol_ratio 却有值（5.43 / 15.29 / 144.88 …）
--       ⇒ 量比 = 竞价量 ÷ 基准量，分子为 0 时量比不可能是 5.43 ⇒ **假 0，是写入时丢了**；
--     · 更要命的是另有一批票（九阳股份 / 海洋王 / 新华传媒 / 凯众股份 / 上海洗霸 … 共 16 只）
--       在 market_metrics 里【整行都不存在】—— 它们是 20 日补位票 / 龙头组壳行，
--       只有视图层注入的行，云端从来没给它们写过当日行情 ⇒ 无论怎么「补空值」都补不到。
--
--   现在的做法（9:25 这一轮，range20 与 range10 都写完以后执行）：
--     ① 名单 = auction_watchlist ∪ stock_range20_pct(当日) ∪ dragon_leaders(前一交易日) ∪ 当日已有行
--        （= 第一页四个注入源，缺哪一类那一类就必然 '-'）；
--     ② 有行但两列空/0 ⇒ 只写 volume / yest_volume（⛔ 不碰 worker 写的涨幅与量比）；
--     ③ 整行缺失 ⇒ 用「同花顺快照(竞价量) + 日线(昨日成交量)」整行新建（source='range20'，
--        只对【当天】开放；历史日只补已有行的空值，⛔ 不改写归档）；
--     ④ 日线优先腾讯、失败 3 只即整体降级为同花顺腿（2026-11-04 实测腾讯会按 IP 打 WAF 返 501）；
--     ⑤ 落库按「键集签名」分桶 POST —— PostgREST 对键集不齐的批量直接 400 PGRST102，
--        上一版就是死在这里（一行都没写进去，而日志只看到 400）。
--   结果（2026-11-04 实测）：假 0 31→0，竞价量空/0 32→1（亚玛顿上游快照本身没给竞价量，
--     §10 留空不猜），昨日成交量空 32→0，整行缺失 16→0。
--   手动补写当天（部署后立刻生效，不必等明天）：
--     curl -X POST '<URL>/functions/v1/range20-precompute?token=range20-cron-2026&volume=1'
--   自检：select stock,volume,yest_volume,source from market_metrics
--          where date=(now() at time zone 'Asia/Shanghai')::date and scope='auction'
--            and (volume is null or volume='' or volume='0' or yest_volume is null);
--
--
-- ★★★ [AUC-VOL-NUMCAT 2026-11-04] 同一函数的 `?healOnly=1` 入口（北京 16:30 / 08:50 那条 cron，
--   见 db/create_range20_legs_cron.sql）现在还会用【猫抓 daily_auc】回补四类行窗口内的
--   竞价量 / 竞价量比 / 竞价涨幅。⛔ 不需要新建 cron，重贴 Edge Function 即生效。
--
--   用户原话：「今天的竞价量比是同花顺还是猫抓数据接口获取的，我之前要求是一定要猫抓数据接口，
--   不要用同花顺，因为同花顺的不准」「九阳股份五日趋势图前几天没有竞价量比和竞价量」
--   「新华传媒也是前几天缺失数据……怎么彻底解决这个问题，就是龙头组，观察组，20日补上去的，
--   同花顺最近多板源，一起可以正常获取数据，并存起来。」
--
--   为什么前几天必然全空（两件事叠加）：
--     ① 竞价量/量比是 9:25 那一刻的【瞬时值】：日 K 线里没有，过了当天连同花顺快照也不再给
--        ⇒ 历史上只有猫抓 daily_auc 存了它（`startdate`/`enddate` 可连抓多天，一次调用覆盖整个窗口）；
--     ② worker 的四要素补漏只补「库内【已有行】」，而 20 日补位票 / 龙头组壳行
--        （九阳股份、新华传媒…）不在「同花顺最近多板 883410」成分股里 ⇒ worker 9:25 的抓取名单
--        从来没有它们 ⇒ 那几天**一行都没有** ⇒ 补空值的逻辑永远碰不到它们。
--     ⇒ 根因不是 worker 或 Supabase 单方面，是「**抓取名单 ≠ 展示名单**」这个结构性缺口。
--
--   现在怎么补（每天恰好 1 次猫抓额度，窗口 10 个交易日）：
--     ⚠️ 为什么是 10 天不是「趋势图那 5 天」：窗口一旦等于展示窗口，某天补失败（额度用尽 /
--        上游抽风）第二天它就【滑出窗口】，再也没机会补 —— 用户看到的「前几天永远空着」
--        就是这个滑动窗口效应。10 天给一次失败留 5 天补救余量，而猫抓请求数【不变】
--        （startdate~enddate 一次覆盖整窗口，与只拉一天同样 1 次额度），纯赚。
--     ① 交易日 = auction_watchlist 的 distinct date（与名单同源，不引入第二套日历）；
--     ② 逐日算四类行并集（正式成员+观察组 / 20日补位 / 龙头名册 / 已有行）；
--     ③ 只挑「三列有缺」或「source ≠ 'numcat'」的槽 —— 后者是关键：9:25 猫抓不给四要素时
--        worker 会用同花顺快照把量比填上，值非空但来源不对，正是用户说的「不准」那批；
--     ④ 一次 daily_auc 拿 [窗口首, 窗口末] × 全部代码 ⇒ volume←auc_vol/100(万股)、
--        auc_vol_ratio←auc_vol_ratio、auc_pct_chg←auc_pct_chg，`source='numcat'` 留痕；
--     ⑤ 三列都与猫抓一致但来源不是猫抓的行，只写一次 `source='numcat'` 作「已核对」标记
--        ⇒ 下一轮零请求（幂等）。
--   额度：用完（403「今日调用额度已用完」）⇒ 记一行日志优雅跳过，⛔ 不重试、不挡其它补算。
--   手动跑（消耗 1 次猫抓额度）：
--     curl -X POST '<URL>/functions/v1/range20-precompute?token=range20-cron-2026&display=1'
--     自定义窗口：&days=10（上限 10；默认就是 10）
--   自检：select date,source,count(*) from market_metrics
--          where date >= (now() at time zone 'Asia/Shanghai')::date - 7 and scope='auction'
--          group by 1,2 order by 1 desc;
--
--   ★★★ [AUC-RATIO-NUMCAT-ONLY 2026-11-04 用户第 6 次口径] 全系统「竞价量比」唯一来源 = 猫抓 daily_auc
--
--   用户原话：「我都说竞价期间不用同花顺量比，收盘也不要用，我只要猫抓数据接口的竞价量比数据，
--   这是最权威的…为什么把同花顺的竞价量比填上去呢？这会造成数据错误明白吗？
--   永远不要用同花顺获取数据的竞价量比数据。」
--
--   现已删除的**所有**同花顺写入口（谁再看到类似代码，一律按违规处理）：
--     ① workers/bidding-auto-fetch/logic/extras-workflow.js#runTodaySnapshotPatch
--        —— 曾把快照 auction_volume_ratio 写进 auc_vol_ratio（9:25 与 16:00 各一次）；
--        已删除，且 SNAPSHOT_FIELDS 里也去掉了该列（否则「只缺量比」的行会每轮白跑一次快照）。
--     ② db/edge/range20-precompute/index.ts#dayMetricsOf
--        —— 曾把快照 auction_volume_ratio 写进新建行（source='range20'）；已删除，
--        量比列干脆不出现在建行语句里（宁可空着，也不写不同源的数）。
--     ③ src/logic/auction/trend-patch.js（浏览器）
--        —— 曾用快照顺带给趋势图补 `day.aucVolRatio`；已删除，量比只读库里的猫抓值。
--     ④ 前端 src/logic/auction/ths-today-patch.js 早在 2026-10-26 就是合规的（从不补量比），
--        只有后端两条腿漏了 ⇒ 用户看到「说了不要，还是同花顺的数」。现已全链路一致。
--
--   为什么「竞价期间量比必然是空的」（这是口径的代价，不是 bug）：
--     猫抓 daily_auc 对【当天】不返回 auc_vol_ratio（要等结算）。实测证据（2026-11-04）：
--     11-03 / 10-30 / 11-02 各日量比的 updated_at 全部落在**次日 09:25** ⇒ 结算后才由猫抓写入。
--     ⇒ 9:25~收盘这段时间，量比没有合规来源 ⇒ 各视图显示 '-' / 断点（§10 宁缺勿错），
--       收盘后 16:30 那一轮用猫抓回填；最迟次日 09:25 worker 的窗口重刷也会补上。
--   ⚠️ 因此依赖竞价量比的「题材量比买点规则」在当天盘中拿不到该输入，会自然跳过；
--      要看当天量比请等收盘后的猫抓回填（这是用户明确选择的口径：准确 > 有数）。
--
--   一次性数据清理（2026-11-04 已执行）：把当天由同花顺写入的 72 行 auc_vol_ratio 置 null。
--   判据：猫抓当天不给量比 ⇒ 当天所有非空量比必然来自同花顺；历史日是次日猫抓写入，不动。
--   复核：select date, updated_by, count(*) from market_metrics
--          where scope='auction' and auc_vol_ratio is not null group by 1,2 order by 1 desc;
--
-- ⚠️ 执行前把下面两处 <ANON_KEY> 替换成你项目的 anon public key：
--    Dashboard → Project Settings → API → Project API Keys → anon public
--    （anon key 本来就是公开的前端钥匙，写进 cron 无泄密风险）

-- ① 启用扩展（Supabase 默认都支持）
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ② 删旧任务（本脚本可重复执行）
do $$
begin
  perform cron.unschedule('range20-auc-precompute');
exception when others then null;
end $$;
do $$
begin
  perform cron.unschedule('range20-close-precompute');
exception when others then null;
end $$;

-- ③ 建任务一：竞价腿（北京 09:25）
select cron.schedule(
  'range20-auc-precompute',
  '25 1 * * 1-5',  -- UTC 01:25 周一~周五 = 北京 09:25
  $job$
  select net.http_post(
    url := 'https://tonqfgeyxnnwicjopshn.supabase.co/functions/v1/range20-precompute?token=range20-cron-2026',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer <ANON_KEY>'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 5000
  );
  $job$
);

-- ④ 建任务二：收盘腿（北京 15:05）
select cron.schedule(
  'range20-close-precompute',
  '5 7 * * 1-5',  -- UTC 07:05 周一~周五 = 北京 15:05
  $job$
  select net.http_post(
    url := 'https://tonqfgeyxnnwicjopshn.supabase.co/functions/v1/range20-precompute?token=range20-cron-2026',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer <ANON_KEY>'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 5000
  );
  $job$
);

-- ============ 部署后自检（在 SQL Editor 里逐条跑）============
-- 两条任务是否已登记（应看到 range20-auc-precompute 与 range20-close-precompute）：
--   select jobname, schedule, active from cron.job;
-- 最近触发记录（status 应为 succeeded）：
--   select runid, job_pid, status, start_time from cron.job_run_details order by start_time desc limit 5;
-- 函数的 HTTP 响应（ok=true / leg=auc|close / written=N）：
--   select created, response from net._http_response order by created desc limit 5;
-- 当天两腿结果行数（auc 与 close 各 ≈ 名单只数）：
--   select leg, count(*), min(days), max(days) from stock_range20_pct
--    where date = (now() at time zone 'Asia/Shanghai')::date group by leg;

-- ============================================================================
-- ⑤ 历史回补：把「20 个交易日」补齐（★ 幂等，可随时重跑）
--
-- 背景（2026-10-22 实测）：stock_range20_pct 最早一行是 2026-10-12 ⇒ 表里只有 9 个交易日，
--   而「20日涨幅前五 / 总龙一~五」的补位池、第二十八条「20 个交易日内是否首次上榜」都要翻 20 天
--   ⇒ 前 11 天是空的，断点直接体现为「宁波东力只有 2 天 / 三峡新材只有 1 天 / 冰山冷热 6 天」，
--   规则文案也只能如实写「实际覆盖 8/20 天」。
--   ⚠️ 必须区分两件事（用户问过「为什么数字对得上同花顺，你却说只有几天」）：
--     · 「20日涨幅的【数值】」来自同花顺 K 线（一次拉 100 个自然日）⇒ 一直是准的，与表里有几天无关；
--     · 「表里的【记录】」是缓存 + 补位池 ⇒ 当时只有 9 天。
--   所以「数字准」和「表里只有 9 天」并不矛盾，缺的是【历史深度】，不是【算法】。
--
-- ★ 正确窗口（⛔ 别再手抄日期）：前端 ensureTop5History 是「展示日往前推 20 个交易日」，
--   用 isTradingDay 跳过周末 + trading_day_overrides 里 is_holiday=true 的假期。
--   ⇒ 对 2026-10-22：09-16 ~ 10-21（20 天），再单独加 10-22 当天。
--   ⚠️ 2026-09-25 是中秋休市（云端 trading_day_overrides 已标 is_holiday=true），不在这 20 天里；
--      ⛔ 不要手工把它塞进窗口，否则前端永远只能覆盖 19/20 天。
--
-- ★ 首选做法：跑本地脚本（一只票只请求一次 K 线，20 天一起算，请求数 ~250 而不是 ~5000）
--   node db/scripts/backfill-range20.mjs                      # 干跑：报每天已有行数 / 待补
--   node db/scripts/backfill-range20.mjs --run                # 真跑
--   node db/scripts/backfill-range20.mjs --run --date=2026-10-22
--   特点：只写「缺失的 (date, stock)」⇒ 幂等、重跑零漂移；当天停牌 ⇒ 不写（§10 宁缺勿错）；
--        数据源是同花顺 K 线经 fuyao-proxy ⇒ **零猫抓额度**。
--
-- ○ 备选做法：用 Edge Function 的 ?date= 逐日补（必须【由旧到新】，⛔ 不要并发，上游会限流熔断）
--   先干跑看目标对不对（&dry=1 不打上游）：
--     curl -X POST '<URL>/functions/v1/range20-precompute?token=range20-cron-2026&date=2026-09-16&dry=1'
--   再逐日真跑（<URL> = https://tonqfgeyxnnwicjopshn.supabase.co）：
--     09-16 09-17 09-18 09-21 09-22 09-23 09-24 09-28 09-29 09-30
--     10-08 10-09 10-12 10-13 10-14 10-15 10-16 10-19 10-20 10-21 10-22
--   （09-25 中秋休市，跳过）
--
-- 回补完成后自查（应看到 21 行，每天 close 行数 236~250，且 auc 只在当天有值）：
--   select date, count(*) filter (where leg='close') as close_rows,
--          count(*) filter (where leg='auc')   as auc_rows
--     from stock_range20_pct
--    where date >= '2026-09-16'
--    group by date order by date;
--
-- 补位票「每天都有数据」自查（应连续 20 行；停牌日会缺，属正常）：
--   select date, leg, pct, days from stock_range20_pct
--    where stock = '冰山冷热' and date >= '2026-09-16' order by date;
--
-- 哪几天还缺（返回的行就是要补的日期；09-25 是假期所以要排除）：
--   with d as (select distinct date from stock_range20_pct where date >= '2026-09-16'),
--        hol as (select date from trading_day_overrides where is_holiday = true)
--   select g::date as missing
--     from generate_series('2026-09-16'::date, '2026-10-21'::date, '1 day') g
--    where extract(isodow from g) < 6
--      and g::date::text not in (select date from d)
--      and g::date::text not in (select date from hol);
-- ============================================================================
