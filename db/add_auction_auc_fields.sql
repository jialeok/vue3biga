-- ============================================================
-- 早盘竞价看板：market_metrics 新增「竞价涨幅趋势 + 4 个当日字段」
-- 目标表：market_metrics（竞价/热门共用，按 scope 区分；本改动只影响 scope='auction'）
-- 新增 5 个列（均为 text，与现有 volume/yest_volume/change_pct 一致）：
--   auc_pct_chg    竞价涨幅（%）  格式 "+X.XX%"，按日期存，用于「五日竞价涨幅」趋势图
--   um_vol         未匹配量（万手）numcat um_vol(手) ÷100 转万手，展示用 "251w"
--   open_bid_pct   抢筹幅度（%）  数字字符串，展示 "0.57%"
--   auc_vol_ratio  竞价量比        数字字符串，展示 "2.18"
--   auc_turnover   真换手率（%）  数字字符串，展示 "0.18%"
-- 幂等：已存在则跳过。可重复执行。
-- ============================================================

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'market_metrics' and column_name = 'auc_pct_chg'
  ) then
    alter table market_metrics add column auc_pct_chg text;
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'market_metrics' and column_name = 'um_vol'
  ) then
    alter table market_metrics add column um_vol text;
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'market_metrics' and column_name = 'open_bid_pct'
  ) then
    alter table market_metrics add column open_bid_pct text;
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'market_metrics' and column_name = 'auc_vol_ratio'
  ) then
    alter table market_metrics add column auc_vol_ratio text;
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'market_metrics' and column_name = 'auc_turnover'
  ) then
    alter table market_metrics add column auc_turnover text;
  end if;
end $$;

-- 校验：应返回 0 行
select column_name from information_schema.columns
where table_schema = 'public' and table_name = 'market_metrics'
  and column_name in ('auc_pct_chg', 'um_vol', 'open_bid_pct', 'auc_vol_ratio', 'auc_turnover');
