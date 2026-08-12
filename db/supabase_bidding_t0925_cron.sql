-- ============================================================================
-- bidding-a 时间表（pg_cron）— 在 Supabase Dashboard → SQL Editor 执行
-- 前提：先在 Dashboard → Extensions 启用 pg_cron 与 pg_net（免费版通常可启用）
-- ============================================================================
--
-- 时区说明：Supabase 数据库默认时区为 UTC。
--   北京时间 9:25 = UTC 1:25，故 cron 表达式写为 '25 1'。
--   先 `show timezone;` 确认你库时区；若改成了 Asia/Shanghai，则把下面所有
--   '15 1' / '20 1' / '25 1' / '26 1' / '0 8' 改成 '15 9' / '20 9' / '25 9' / '26 9' / '0 16'。
--
-- 占位符替换：
--   <PROJECT_REF>  = 你的项目 ref（xxxxx.supabase.co 中的 xxxxx）
--   <TOKEN>        = 与 Edge Function 里 FETCH_TOKEN 一致的令牌
--
-- ============================================================================

-- 1) 启用扩展（仅需一次）
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 1.1) 供 Edge Function 调用：数据填满后停止 5 秒轮询 job（security definer 以库所有者权限执行 cron.unschedule）
--      grant 给 anon，使函数用 SUPABASE_ANON_KEY 即可通过 /rest/v1/rpc/stop_bidding_t0925_fill 调用。
create or replace function public.stop_bidding_t0925_fill()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform cron.unschedule('bidding-t0925-fill');
end;
$$;
grant execute on function public.stop_bidding_t0925_fill() to anon;

-- 2.1 单次抓取点（t0915 / t0920 / t0926 / close）：周一至周五
select cron.schedule('bidding-t0915', '15 1 * * 1-5', $$
  select net.http_post(
    url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/bidding-a/fetch?point=t0915&token=<TOKEN>',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body    := '{}'::jsonb,
    timeout_milliseconds := 10000
  );
$$);

select cron.schedule('bidding-t0920', '20 1 * * 1-5', $$
  select net.http_post(
    url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/bidding-a/fetch?point=t0920&token=<TOKEN>',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body    := '{}'::jsonb,
    timeout_milliseconds := 10000
  );
$$);

select cron.schedule('bidding-t0926', '26 1 * * 1-5', $$
  select net.http_post(
    url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/bidding-a/fetch?point=t0926&token=<TOKEN>',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body    := '{}'::jsonb,
    timeout_milliseconds := 10000
  );
$$);

select cron.schedule('bidding-close', '0 8 * * 1-5', $$
  select net.http_post(
    url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/bidding-a/fetch?point=close&token=<TOKEN>',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body    := '{}'::jsonb,
    timeout_milliseconds := 10000
  );
$$);

-- 2.2 t0925 持续补全窗口：9:25 创建「每5秒」job，9:30 删除（窗口内约 60 次调用）
-- 注意：外层用 $outer$ 、内层用 $inner$ 避免美元引号嵌套冲突
select cron.schedule('bidding-t0925-start', '25 1 * * 1-5', $outer$
  select cron.schedule('bidding-t0925-fill', '5 seconds', $inner$
    select net.http_post(
      url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/bidding-a/fetch?point=t0925&token=<TOKEN>',
      headers := '{"Content-Type":"application/json"}'::jsonb,
      body    := '{}'::jsonb,
      timeout_milliseconds := 10000
    );
  $inner$);
$outer$);

select cron.schedule('bidding-t0925-stop', '30 1 * * 1-5', $$
  select cron.unschedule('bidding-t0925-fill');
$$);

-- 3) 查看 / 清理（按需执行）
-- select jobid, jobname, schedule, active from cron.job;
-- select cron.unschedule('bidding-t0915');
-- select cron.unschedule('bidding-t0920');
-- select cron.unschedule('bidding-t0926');
-- select cron.unschedule('bidding-close');
-- select cron.unschedule('bidding-t0925-start');
-- select cron.unschedule('bidding-t0925-stop');
-- select cron.unschedule('bidding-t0925-fill');
