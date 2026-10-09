-- ============================================================================
-- 手动「竞价图形判断」表 decision_chart_judge
-- 应用层：src/data/decision-chart-judge.js            （读写 + Realtime，Data 层唯一入口）
--         src/logic/decision/decision-chart-judge.js   （三档映射 / 文案，纯函数，可单测）
--         src/logic/decision/decision-chart-judge-store.js（响应式状态 + 加载 / 保存 / 订阅）
--         src/components/decision/ChartJudgeSelect.vue （三档小选择器）
--         「决策」看板 买点 / 卖点 的【每一行】行尾
--
-- 【产品口径】（用户原话）
--   「选票是没问题，但是里面买点和卖点，还是把握有些不准确，所以只能靠手动观察竞价图形变化，
--     我想自己看竞价图形进行买和卖……这两个选项，会直接影响到竞价买，竞价卖，尾盘买和尾盘卖，
--     这四个选项。也就是以我看到当天股票的竞价图形然后做判断为准。」
--   「颜色显著些，可能这是我作为买卖点的最终判断。原来规则作为辅助。原来规则不变。」
--   「而且这些能存起来，保存起来，刷新也不会变。你可以按日期建一个表给这个功能。」
--
-- ⇒ 表里存的【不是规则推导的结果】，而是【用户自己的判断】：一行 = 某一天、某一只票、一个判断。
--
-- 【为什么按 (date, stock) 而不是 (date, side, stock)】
--   用户判断的是【这一只票当天的竞价图形】，图形只有一张 ⇒ 一只票一天只有【一个】判断。
--   买点与卖点两侧渲染的是【同一个判断】（同一只票同时出现在买卖点时，两处的选择器必然同步）：
--     · 买点：符合 → 竞价买（敢买）；不符 → 尾盘买（保守）
--     · 卖点：符合 → 尾盘卖（敢留）；不符 → 竞价卖（果断出）
--   两个方向都由【同一个判断】推出 ⇒ side 不入主键（入主键就等于允许「同一张图两个结论」，那是自相矛盾）。
--
-- 【取值域】judge ∈ 'ok'（竞价图符合）| 'bad'（竞价图不符合）
--   ⚠️ 【默认】不落库：用户选回「默认」= 删掉这一行（表里没有行 = 没有手动判断）。
--      这样「默认」与「从没点过」在数据上【完全等价】，不会出现两条看起来一样的路径（§6）。
--   ⚠️ 具体取值字面量由 Logic 层定义（logic/decision/decision-chart-judge.js#JUDGE_*）——
--      本表只负责【存字符串】，不定义语义（§6 语义只有一处）。
--
-- 【为什么落库而不是 localStorage】
--   §8 红线：这是【跨设备共享的业务数据】（用户原话「刷新也不会变」，且换手机要还在），
--   必须进 Supabase；localStorage 只能放 UI 偏好，⛔ 不许用来兜这个功能。
--
-- 【写入口径（§11 删除安全）】
--   · upsert 单行（onConflict = date,stock）—— 幂等，反复改只覆盖同一行；
--   · 选回「默认」→ 只删【精确匹配 (date, stock) 的那一行】，并带 .select() 回读受影响行；
--   · ⛔ 绝不做「按 date 整日清空」这类批量删除（那会把用户当天其它票的判断一起抹掉）。
--
-- 执行方式：Supabase Dashboard -> SQL Editor -> 新建 Query -> Run（幂等，可重复执行）
-- ============================================================================

create table if not exists decision_chart_judge (
  date        text        not null,   -- 交易日 YYYY-MM-DD（与决策看板顶栏选中的日期同一口径）
  stock       text        not null,   -- 股票简称（与 auction_watchlist.stock / limit_pool.stock 同键）
  judge       text        not null,   -- 'ok' 竞价图符合（预判当天走势好）｜'bad' 竞价图不符合（预判当天走势不好）
  updated_at  timestamptz default now(),
  primary key (date, stock)
);

comment on table decision_chart_judge is
  '决策看板手动「竞价图形判断」：一行 = 某交易日 + 某只股票 + 用户看竞价图形自己下的判断（ok=符合 / bad=不符合；无行=默认＝按原规则显示）';
comment on column decision_chart_judge.judge is
  'ok=竞价图符合（预判当天走势好）；bad=竞价图不符合（预判当天走势不好）。⛔ 语义定义在 logic/decision/decision-chart-judge.js#JUDGE_*，本表只存字符串';
comment on column decision_chart_judge.stock is
  '股票简称，与 auction_watchlist.stock 同键；主键 (date, stock) ⇒ 一只票一天只有一个判断（买点 / 卖点共用）';

-- 行级安全：与 auction_watchlist / market_metrics / limit_pool / dragon_leaders 保持一致（anon 全开放）
alter table decision_chart_judge enable row level security;

drop policy if exists "allow_all_decision_chart_judge" on decision_chart_judge;
create policy "allow_all_decision_chart_judge"
  on decision_chart_judge for all to anon using (true) with check (true);

-- 看板主查询：按日期取当日全部判断（一次读回一张 map）
create index if not exists idx_decision_chart_judge_date on decision_chart_judge(date);

-- Realtime：另一台设备 / 另一个标签页改了判断后，本端看板自动跟着变（§31 需配套订阅，见 data/decision-chart-judge.js）
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'decision_chart_judge'
    ) then
      alter publication supabase_realtime add table decision_chart_judge;
    end if;
  end if;
end $$;

-- 让 PostgREST 立刻刷新 schema cache。
-- 症状对照：若前端看板出现红字
--   `decision_chart_judge 表不存在：请在 Supabase Dashboard → SQL Editor 执行
--     db/create_decision_chart_judge.sql 建表`
-- （PGRST205 / 42P01），99% 是【本文件还没执行过】—— 那不是一个「调用方式」问题，就是这张表不存在。
-- 若确实执行过本文件却仍报这句，再跑下面这行刷新缓存。
notify pgrst, 'reload schema';

-- 自检（执行完后跑一遍，新表为空是正常的）：
-- select date, stock, judge from decision_chart_judge order by date desc, stock limit 20;
