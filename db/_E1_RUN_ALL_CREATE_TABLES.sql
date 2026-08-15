-- ============================================================
-- E1 批量建表脚本（由 commit 127eeee 的 9 个 create_*.sql 合并）
-- 用途：在 Supabase SQL Editor 一次性执行，补全 Edge Function / fail-soft 降级所需表
-- 注意：列定义由 E1 从 src/workers grep 反推，标注 -- TODO 处请按真实代码核对后再跑
-- ============================================================


-- ========== create_bidding_data.sql ==========
-- 竞价变化看板独立表（§8 合规：竞价数据上云持久化，跨设备不丢）
-- 应用层：src/data/bidding-data.js（读写经 Supabase upsert + 内存缓存；读经 pullBiddingFromTable）
-- 写入字段对齐代码：
--   - 前端 src/data/bidding-data.js：upsert { date, name, time915, time920, time925, change, close, updated_at }
--   - Edge Function bidding-a/index.ts：upsert { date, name, time915, time920, time925, close, updated_at, change }，
--     on_conflict=date,name，SELECT 仅取 name,time915,time920,time925,close,change
-- 注意：本 SQL 需在 Supabase 项目里手动执行一次（沙箱无法直连远端）。
-- 表不存在时 bidding-data 的云端读写被 try/catch 兜底，内存缓存仍正常。
create table if not exists bidding_data (
  date       text        not null,
  name       text        not null,
  time915    text,
  time920    text,
  time925    text,
  "change"   text,                       -- 引号转义：change 是 SQL 保留字；代码用 "change" 引用
  close      text,
  updated_at timestamptz default now(),
  primary key (date, name)
);

comment on table bidding_data is '竞价变化看板固定行时序数据：9:15/9:20/9:25 竞价% + 收盘% + 环比(change)（业务数据，上云持久化）';

create index if not exists idx_bidding_data_date on bidding_data (date);

alter table bidding_data enable row level security;

drop policy if exists "allow_all_bidding_data" on bidding_data;
create policy "allow_all_bidding_data" on bidding_data for all to anon using (true) with check (true);

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='bidding_data') then
    alter publication supabase_realtime add table bidding_data;
  end if;
end $$;

-- ========== create_core_topics.sql ==========
-- 核心题材词库表（§8 合规：core_topics 为核心题材词唯一真相源）
-- 应用层：src/logic/ui-bridge.js（pullCoreTopicsFromCloud / pushCoreTopicsToCloud）
--          src/logic/topic/rules.js（初始化推送默认核心词）
-- 写入字段对齐代码 src/logic/ui-bridge.js：
--   SELECT：name,synonyms,updated_at
--   pushCoreTopicsToCloud：先 delete().neq('name','___never___') 清空，再 insert({ name, synonyms, updated_at })
--   说明：synonyms 由代码 JSON.stringify(数组) 写入、JSON.parse 读出 → 以 text 存 JSON 字符串
-- 注意：本 SQL 需在 Supabase 项目里手动执行一次。
-- ⚠ TODO: 代码从不订阅 core_topics 的 Realtime（审计 §31 标注"写无订阅"），
--   因此下方 Realtime 发布块默认保留但不强制；如需多端同步核心词可启用。
create table if not exists core_topics (
  name       text        not null primary key,
  synonyms   text,                          -- 存储 JSON.stringify 后的字符串数组，如 '["同花顺","东方财富"]'
  updated_at timestamptz default now()
);

comment on table core_topics is '核心题材词库：name + 同义词 synonyms（JSON 字符串），前端匹配题材用';

alter table core_topics enable row level security;

drop policy if exists "allow_all_core_topics" on core_topics;
create policy "allow_all_core_topics" on core_topics for all to anon using (true) with check (true);

-- 审计 §31：core_topics 当前代码无 Realtime 订阅，故此处不自动加入 supabase_realtime 发布。
-- 若后续需要多端同步核心词，取消下方注释即可：
-- do $$
-- begin
--   if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='core_topics') then
--     alter publication supabase_realtime add table core_topics;
--   end if;
-- end $$;

-- ========== create_daily_highlights.sql ==========
-- 预计算竞/昨高光表（加速加载，daily_highlights 为只读缓存表）
-- 应用层：src/data/daily-highlights.js（读经 pullDailyHighlights，Realtime 经 startHighlightsRealtime）
-- 读取字段对齐代码 src/data/daily-highlights.js：
--   SELECT：date,stock,jing_yest_highlight  +  .eq('jing_yest_highlight', true)
-- 写入方：抓取程序 / Worker（仓库内未见前端写入 daily_highlights 的代码，pushDailyHighlights 仅出现在注释中，
--   实际写入由抓取链路完成），故下表结构按「前端可读路径 + 与 hot_stocks_highlights 对称」重建。
-- 注意：本 SQL 需在 Supabase 项目里手动执行一次。
-- ⚠ TODO: 仓库内仅能确认 read 路径（date, stock, jing_yest_highlight）；
--   updated_at 由对称推断（hot_stocks_highlights 同结构）。抓取 Worker 可能写入额外高光列
--   （例如独立的 竞价高光 / 昨日高光 列），若上线后发现列缺失，请按 Worker 实际写入补列。
create table if not exists daily_highlights (
  date               text        not null,
  stock              text        not null,
  jing_yest_highlight boolean     not null default false,  -- 竞/昨高光命中标记（代码读取字段，已确认）
  updated_at         timestamptz default now(),            -- TODO: verify column/type（按 hot_stocks_highlights 对称推断）
  primary key (date, stock)
);

comment on table daily_highlights is '预计算竞/昨高光缓存：命中股票集合（加速看板加载，由抓取链路写入）';

create index if not exists idx_daily_highlights_date on daily_highlights (date);

alter table daily_highlights enable row level security;

drop policy if exists "allow_all_daily_highlights" on daily_highlights;
create policy "allow_all_daily_highlights" on daily_highlights for all to anon using (true) with check (true);

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='daily_highlights') then
    alter publication supabase_realtime add table daily_highlights;
  end if;
end $$;

-- ========== create_hot_stock_trends.sql ==========
-- 热门股票趋势图数据表（hot_stock_trends，历史趋势快照；主数据源已迁 market_metrics scope=hot）
-- 应用层：src/data/hot-stocks.js（读经 loadHotTrendsFromCloud，写经 pushHotTrendsToCloud）
-- 写入字段对齐代码 src/data/hot-stocks.js：
--   SELECT：date,stock,code,volume,yest_volume,change_pct
--   upsert 行：{ date, stock, code, volume, yest_volume, change_pct, updated_at, updated_by }
--     onConflict：'date,stock'
--   delete：.eq('date', date).eq('stock', stock)
-- 说明：volume / yest_volume / change_pct 在代码中均以字符串读写（|| ''），故用 text；
--   updated_by 标记写入方（代码固定为 'main'）。该表为兼容回退旧表，RLS 拒绝前端写入时不影响主流程。
-- 注意：本 SQL 需在 Supabase 项目里手动执行一次。
create table if not exists hot_stock_trends (
  date        text        not null,
  stock       text        not null,
  code        text,
  volume      text,
  yest_volume text,
  change_pct  text,
  updated_at  timestamptz default now(),
  updated_by  text,
  primary key (date, stock)
);

comment on table hot_stock_trends is '热门股票趋势图快照：成交量/昨成交量/涨幅（旧表，主数据源为 market_metrics scope=hot）';

create index if not exists idx_hot_stock_trends_date on hot_stock_trends (date);

alter table hot_stock_trends enable row level security;

drop policy if exists "allow_all_hot_stock_trends" on hot_stock_trends;
create policy "allow_all_hot_stock_trends" on hot_stock_trends for all to anon using (true) with check (true);

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='hot_stock_trends') then
    alter publication supabase_realtime add table hot_stock_trends;
  end if;
end $$;

-- ========== create_hot_stocks_highlights.sql ==========
-- 热门股票竞/昨高光表（hot_stocks_highlights，加速加载，与 daily_highlights 同构）
-- 应用层：src/data/hot-stocks.js（读经 pullHotStocksHighlights，写经 pushHotStocksHighlights）
-- 写入字段对齐代码 src/data/hot-stocks.js：
--   SELECT：date,stock,jing_yest_highlight  +  .eq('jing_yest_highlight', true)
--   update：{ jing_yest_highlight: false, updated_at }  再 upsert { date, stock, jing_yest_highlight: true, updated_at }
--   onConflict：'date,stock'
-- 注意：本 SQL 需在 Supabase 项目里手动执行一次。
create table if not exists hot_stocks_highlights (
  date               text        not null,
  stock              text        not null,
  jing_yest_highlight boolean     not null default false,
  updated_at         timestamptz default now(),
  primary key (date, stock)
);

comment on hot_stocks_highlights is '热门股票预计算竞/昨高光缓存：命中股票集合（加速看板加载）';

create index if not exists idx_hot_stocks_highlights_date on hot_stocks_highlights (date);

alter table hot_stocks_highlights enable row level security;

drop policy if exists "allow_all_hot_stocks_highlights" on hot_stocks_highlights;
create policy "allow_all_hot_stocks_highlights" on hot_stocks_highlights for all to anon using (true) with check (true);

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='hot_stocks_highlights') then
    alter publication supabase_realtime add table hot_stocks_highlights;
  end if;
end $$;

-- ========== create_jiwang_data.sql ==========
-- 记忘看板 / 昨日复盘独立表（§8 合规：jiwang 数据上云持久化，跨设备不丢）
-- 应用层：src/data/jiwang-data.js（读写经 Supabase upsert + 内存缓存；读经 pullJiwangFromTable）
-- 写入字段对齐代码 src/data/jiwang-data.js：
--   SELECT：date,diezhang,qingxu,jujiao,"whoIncrease","kxianPrefix",kxian,guancha,
--           "guochengJieguo","shouguJieguo",jielun,chushou,stats,updated_at
--   upsert：{ date, diezhang, qingxu, jujiao, whoIncrease, kxianPrefix, kxian, guancha,
--             guochengJieguo, shouguJieguo, jielun, chushou, stats, updated_at }
--   注释明确：stats 为弹性 jsonb（行情阶段/仓位/勾选项等，字段持续增加，不逐个拆列）
-- 注意：本 SQL 需在 Supabase 项目里手动执行一次。
-- 代码对 date 列要求唯一约束（onConflict:'date'），呼应 pullJiwangFromTable 的重复行告警。
create table if not exists jiwang_data (
  date              text        not null primary key,
  diezhang          text,
  qingxu            text,
  jujiao            text,
  "whoIncrease"     text,
  "kxianPrefix"     text,
  kxian             text,
  guancha           text,
  "guochengJieguo"  text,
  "shouguJieguo"    text,
  jielun            text,
  chushou           text,
  stats             jsonb,
  updated_at        timestamptz default now()
);

comment on table jiwang_data is '记忘看板/昨日复盘文本字段 + 弹性 stats jsonb（按日期唯一，业务数据上云持久化）';

create index if not exists idx_jiwang_data_date on jiwang_data (date);

alter table jiwang_data enable row level security;

drop policy if exists "allow_all_jiwang_data" on jiwang_data;
create policy "allow_all_jiwang_data" on jiwang_data for all to anon using (true) with check (true);

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='jiwang_data') then
    alter publication supabase_realtime add table jiwang_data;
  end if;
end $$;

-- ========== create_stock_topics.sql ==========
-- 题材库独立表（§8 合规：stock_topics 为题材库唯一真相源）
-- 应用层：src/data/stock-topics.js（读经 pullStockTopicsFromCloud，写经 pushStockTopicsToCloud）
-- 写入字段对齐代码 src/data/stock-topics.js：
--   SELECT：stock,topics,code
--   upsert：{ stock, topics, code, updated_at }，onConflict:'stock'
-- 说明：topics 以逗号分隔字符串存储（代码 split(',') 还原为 Set），code 为可选股票代码快照
-- 注意：本 SQL 需在 Supabase 项目里手动执行一次。
create table if not exists stock_topics (
  stock      text        not null primary key,
  topics     text,
  code       text,
  updated_at timestamptz default now()
);

comment on table stock_topics is '题材库：每只股票归属的题材集合（逗号分隔字符串）+ 代码快照（跨日期共享唯一真相源）';

create index if not exists idx_stock_topics_code on stock_topics (code);

alter table stock_topics enable row level security;

drop policy if exists "allow_all_stock_topics" on stock_topics;
create policy "allow_all_stock_topics" on stock_topics for all to anon using (true) with check (true);

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='stock_topics') then
    alter publication supabase_realtime add table stock_topics;
  end if;
end $$;

-- ========== create_stockcodemap.sql ==========
-- 股票名↔代码映射表（§8 合规：stockcodemap 为代码映射唯一真相源，取代旧 localStorage.stockCodeMap）
-- 应用层：src/data/stock-code-map.js（读经 pullStockCodeMapFromCloud，写经 upsertStockCodeMap）
-- 写入字段对齐代码 src/data/stock-code-map.js：
--   SELECT：stock,code
--   upsert：{ stock, code, updated_at }，onConflict:'stock'
--   worker 读取：bidding-auto-fetch/data/supabase-write.js 用 /rest/v1/stockcodemap?select=stock,code
-- 注意：本 SQL 需在 Supabase 项目里手动执行一次。
create table if not exists stockcodemap (
  stock      text        not null primary key,
  code       text,
  updated_at timestamptz default now()
);

comment on table stockcodemap is '股票名称 → 代码映射（跨设备唯一真相源，取代本地 stockCodeMap）';

create index if not exists idx_stockcodemap_code on stockcodemap (code);

alter table stockcodemap enable row level security;

drop policy if exists "allow_all_stockcodemap" on stockcodemap;
create policy "allow_all_stockcodemap" on stockcodemap for all to anon using (true) with check (true);

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='stockcodemap') then
    alter publication supabase_realtime add table stockcodemap;
  end if;
end $$;

-- ========== create_user_data.sql ==========
-- 遗留全量数据 / 会话 token 表（§8 合规：user_data 为旧版整库 blob 兼容表 + 登录态 token 行）
-- 应用层：
--   - src/logic/workflows/auction-sync.js：pullFromCloud 读 .from('user_data').select('data').eq('id','owner').single()
--     （owner 行存整个应用数据 blob，type: jsonb）
--   - src/data/watchlist-and-metrics.js：writeSessionToken / readSessionToken
--     用 upsert({ id:'session', data:{ _session_token }, updated_at }) 读写登录态，Realtime 监听 user_data_changes(UPDATE)
-- 写入字段对齐代码：
--   SELECT：data（.single() 读）
--   upsert：{ id, data, updated_at }；id 取值 'owner'（整库 blob）或 'session'（登录 token）
-- 注意：本 SQL 需在 Supabase 项目里手动执行一次。
-- ⚠ TODO: user_data 为历史兼容大表，owner 行 data 为任意结构 jsonb（不可推断内部 schema），
--   仅确认外表列 id / data / updated_at。新功能不应再向此表写入业务数据。
create table if not exists user_data (
  id         text        not null primary key,  -- 'owner'（整库 blob）| 'session'（登录 token）
  data       jsonb,
  updated_at timestamptz default now()
);

comment on table user_data is '遗留兼容表：owner 行存整库 blob、session 行存登录 token（历史兼容，新功能勿用）';

alter table user_data enable row level security;

drop policy if exists "allow_all_user_data" on user_data;
create policy "allow_all_user_data" on user_data for all to anon using (true) with check (true);

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='user_data') then
    alter publication supabase_realtime add table user_data;
  end if;
end $$;
