-- ============================================================================
-- 竞价一字池表 auction_yizi
-- 应用层：src/data/auction-yizi.js（读写） / src/logic/yizi/*（分组+派生）
--         src/views/AuctionYiziBoard.vue（「竞价一字」看板，独立组件）
-- 上游：猫爪数据 numcat —— daily_auc_fd（竞价一字）
--   专线（默认）深圳 http://sz.numcat.net:8866/api
--               上海 http://sh.numcat.net:8866/api
--   公网备用      https://numcat.net/api
--   抓取执行者：Supabase Edge Function auction-yizi-fetch
--               （独立函数 / 独立猫爪小号 key / 独立 cron，由 pg_cron 触发
--                → db/supabase_auction_yizi_cron.sql）
--
-- 【⚠️ 与既有看板彻底解耦（本表是「小号」专用）】
--   · 独立 Edge Function：supabase/functions/auction-yizi-fetch/index.ts
--   · 独立 Secret：NUMCAT_API_KEY_YIZI（优先） / NUMCAT_API_KEY_YIZI_AUCTION（备选）
--                  AUCTION_YIZI_FETCH_TOKEN（函数自身鉴权）
--   · 独立表：auction_yizi（不复用、不写入 auction_watchlist / market_metrics / limit_pool）
--   · ⛔ 绝不与「早盘竞价看板」的 numcat-proxy / NUMCAT_API_KEY 混用，两者额度独立计量。
--
-- 【产品口径】
--   · 按交易日 T 存【当日 9:15~9:25 集合竞价阶段的一字涨停封单】。
--   · 主键 = (date, stock)：同一天同一只股票只有一行。
--     stock = 股票简称，与题材库 stock_topics.stock 同一键 → 题材手动导入后可与
--     涨跌停看板 / 早盘竞价看板共享同一份题材（这是用户要求的「共享题材」）。
--   · 「一字」判据 = 9:15~9:25 之间存在「匹配价 = 涨停价」的竞价成交证据，
--     即下游 fa_* 字段（封单额）任一非空。全空 = 该票 9:25 前从未封上涨停价
--     （⚠️ 上游 symbols 不传时默认返回【全市场】标的，绝大多数 fa_* 为 null）
--     → 写入端只保留有证据的行，并在响应里回显 dropped_no_fa 计数便于核对。
--
-- 【fa_* 字段语义（以猫爪官方文档为准，勿自行推测）】
--   fa_0915          9:15 后第一笔（隔夜封单额），匹配价 = 涨停价的竞价金额
--   fa_0916..fa_0925 该分钟前最后一笔，匹配价 = 涨停价的竞价金额
--   fa_0920f         9:20 后第一笔封单额（9:20 起不可撤单，参考价值高）
--   fa_0925l         9:25 后最后一笔封单额
--   单位：元。空值 = 该时点没有「匹配价 = 涨停价」的成交。
--
-- 【题材优先级（用户口径）】
--   ① theme_kpl  开盘啦题材（接口自带，主）  → 落到本表 theme_kpl
--   ② theme_xgb  选股宝题材（接口自带，次）  → 落到本表 theme_xgb
--      ⚠️ 本表只存【上游原样文本】；「取哪个做展示题材」「上游无题材时回退共享题材库
--         stock_topics」「仍无 → '-' 且可手动导入」这三步一律在 Logic/UI 层完成，
--         保证 §6 单一真相：本表=快照，题材的最终呈现口径不写死在数据库里。
--   ③ 共享题材库 stock_topics（手动导入的题材）
--   ④ 无 → 展示 '-'，并可用「无题材」开关过滤（与涨跌停看板同范式）
--
-- 【为什么落库而不是每次现拉】
--   ① §6 单一真相：一份数据、一次抓取，跨设备/多次打开共用；
--   ② §8：跨设备共享的业务数据必须上云，换设备/清缓存不能丢；
--   ③ 9:15~9:25 封单额是【当日瞬时快照】语义，盘后不可复现 → 必须当天落库存档；
--   ④ 9:25 之后上游会切到下一状态，晚抓只能拿到残缺/错值。
--
-- 【⚠️ 整日对齐（§11 删除安全）】
--   一字池是「某日全量快照」，重跑时必须让该日结果 = 本次抓取结果（否则旧行残留，
--   出现「某票今天已不是一字却仍显示」的假象）。故写入走 Data 层
--   replaceAuctionYiziForDate()：先 upsert 本次结果，再删掉该日「本次已不在池中」的旧行；
--   且【本轮抓取不完整（超时/上游报错）绝不写库】，宁可保持旧快照，也不写半张表。
--
-- 执行方式：Supabase Dashboard -> SQL Editor -> 新建 Query -> Run（幂等，可重复执行）
-- ============================================================================

create table if not exists auction_yizi (
  date             text        not null,   -- 交易日 YYYY-MM-DD（由上游 tradedate 的 YYYYMMDD 归一）
  stock            text        not null,   -- 股票简称（与 stock_topics.stock 同键，题材互通靠它）
  code             text,                   -- 规整后的 6 位纯代码
  symbol           text,                   -- 上游原始代码原样保留（便于排查命名/后缀差异）
  name             text,                   -- 上游原始名称原样保留（改名时能看出差异）

  -- 竞价量价
  auc_pct_chg      text,                   -- 竞价涨幅文本，形如 "+10.02"（与库内其它表同口径：text）
  auc_amt          numeric,                -- 竞价金额（元）
  auc_turnover     numeric,                -- 真实竞价换手率（%）

  -- 封单额证据链（单位：元；null = 该时点没有「匹配价=涨停价」的成交）
  fa_0915          numeric,                -- 9:15 后第一笔（隔夜封单额）
  fa_0916          numeric,
  fa_0917          numeric,
  fa_0918          numeric,
  fa_0919          numeric,
  fa_0920          numeric,
  fa_0921          numeric,
  fa_0922          numeric,
  fa_0923          numeric,
  fa_0924          numeric,
  fa_0925          numeric,                -- 9:25 前最后一笔
  fa_0920f         numeric,                -- 9:20 后第一笔（不可撤单段起点）
  fa_0925l         numeric,                -- 9:25 后最后一笔

  -- 由 fa_* 派生（下游写入端统一计算，避免各端各算一套）
  seal_money       numeric,                -- 9:25 口径封单额 = fa_0925l ?? fa_0925 ?? 其它非空末笔
                                           -- （「竞价一字」看板的块内排序 + 龙头判据）
  fa_count         int,                    -- 有封单证据的时点数（0~13），= 证据强度
  fa_first         text,                   -- 首次封上涨停价的时刻 "HH:MM"（无证据为 null）

  -- 题材（上游原样文本，最终呈现口径在 Logic 层）
  theme_kpl        text,                   -- 开盘啦题材（主）"机器人、人工智能"
  theme_xgb        text,                   -- 选股宝题材（次）

  is_st            boolean,                -- 是否 ST（ST 涨停为 5%，仍属一字，标记后由 UI 体现）
  updated_at       timestamptz default now(),
  primary key (date, stock)
);

comment on table auction_yizi is
  '竞价一字：每交易日 9:25 抓猫爪数据 daily_auc_fd 的「一字涨停封单」快照，供「竞价一字」看板按题材分组展示 + 按封单额选龙头。（独立小号接口，与早盘竞价看板解耦）';

comment on column auction_yizi.stock is '股票简称，与 stock_topics.stock 同键 → 手动导入题材后可被本看板复用（共享题材）';
comment on column auction_yizi.fa_0915 is '9:15 后第一笔封单额（元），匹配价=涨停价的竞价金额；null=该时点未封上涨停价';
comment on column auction_yizi.fa_0920f is '9:20 后第一笔封单额（元）；9:20 起不可撤单，参考价值高';
comment on column auction_yizi.fa_0925l is '9:25 后最后一笔封单额（元）';
comment on column auction_yizi.seal_money is '9:25 口径封单额（元）= fa_0925l ?? fa_0925 ?? 其它非空末笔；块内排序与龙头判据';
comment on column auction_yizi.fa_count is '有封单证据的时点数 0~13，= 封单证据强度';
comment on column auction_yizi.theme_kpl is '开盘啦题材（接口自带，优先级 ①，原样文本，未拆分）';
comment on column auction_yizi.theme_xgb is '选股宝题材（接口自带，优先级 ②，原样文本，未拆分）';

-- 行级安全：与 auction_watchlist / market_metrics / limit_pool / dragon_leaders 保持一致（anon 全开放）
alter table auction_yizi enable row level security;

drop policy if exists "allow_all_auction_yizi" on auction_yizi;
create policy "allow_all_auction_yizi"
  on auction_yizi for all to anon using (true) with check (true);

-- 按日期查询某天全池（看板主查询：date）
create index if not exists idx_auction_yizi_date on auction_yizi(date);

-- Realtime：9:25 写完（auction-yizi-fetch）后，已打开看板的其它设备自动刷新
-- （§31 需配套订阅，见 src/data/auction-yizi.js）
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'auction_yizi'
    ) then
      alter publication supabase_realtime add table auction_yizi;
    end if;
  end if;
end $$;

-- 让 PostgREST 立刻刷新 schema cache。
-- 症状对照：若前端/函数红字 `Could not find the table 'public.auction_yizi' in the schema cache`
-- （PGRST205），99% 是【本文件还没执行过】——不是「调用/读数方式」问题，就是这张表不存在。
-- 若确实执行过本文件却仍报这句，再跑下面这行刷新缓存。
notify pgrst, 'reload schema';

-- 自检（执行完后跑一遍）：
-- select count(*) as rows, count(distinct date) as days from auction_yizi;
-- select date, stock, code, auc_pct_chg, seal_money, fa_count, theme_kpl, theme_xgb
--   from auction_yizi order by date desc, seal_money desc nulls last limit 20;
