-- ============================================================
-- 启用竞价 worker 的静默失败日志表
-- 背景：workers/*/data/supabase-write.js 的 writeLog() 会把每次抓取的
--       成功/失败（含 upsert 真实报错 writeError）写入 bidding_fetch_log，
--       但仓库从未建过这张表，且 writeLog 用 try/catch 静默吞错 →
--       9:25 整批 upsert 失败后，错误无处可查。建表后下次运行自动记录。
-- 写入字段对齐代码：run_date/time_point/source/job/worker/ok/detail(jsonb)
-- ============================================================

create table if not exists bidding_fetch_log (
  id          bigint generated always as identity primary key,
  run_date    text,
  time_point  text,
  source      text,
  job         text,
  worker      text,
  ok          boolean,
  detail      jsonb,
  created_at  timestamptz default now()
);

-- 启用后，查某天 9:25 的真实报错：
-- select run_date, time_point, worker, ok, detail->>'writeError' as write_error, detail
-- from bidding_fetch_log
-- where run_date = 'YYYY-MM-DD' and time_point in ('t0925','t0926-seal')
-- order by created_at desc;

-- ============================================================
-- 附加：定位「整批 upsert 静默失败」的另一常见原因
-- 若 bidding_data 存在 (date,name) 重复行，Supabase on_conflict 合并会整批报错。
-- 你此前查询返回 7 行（每个 name 一行）已初步排除，但改名/历史写入可能留下重复，
-- 用下面这条确认：
-- select date, name, count(*) as cnt
-- from bidding_data
-- group by date, name
-- having count(*) > 1;
-- ============================================================
