-- 清理（只写不读 / 半孤儿表）：auction_bidding_template
-- -----------------------------------------------------------------------------
-- 状态：只写不读（WRITE-ONLY / 半孤儿）—— 与 auction_etf 等“0 行死表”不同，本表仍被写入。
-- 依据：PURE_VUE3_AUDIT_REPORT.md §六“废弃表” + §六“4 张单向表无 Realtime（§31 缺口）”
--        > auction_bidding_template 只写不读
--
-- 验证（本仓库可核实）：
--   - src/data/bidding-template-sync.js 同时存在 saveBiddingTemplate（:21，导出）
--     与 loadBiddingTemplate（:43，导出）。
--   - saveBiddingTemplate 被调用：src/logic/workflows/auction-sync.js:558
--     （pullFromCloud 时把 biddingDefaultTemplate_v41 双写到 Supabase）。
--   - loadBiddingTemplate 全 src 0 个调用方（定义即死代码）—— 应用从未从本表读回模板。
--     实际读取走 auction-sync.js:782 的 localStorage（biddingDefaultTemplate_v41）。
--
-- 为什么它“只写不读”：
--   迁移期设计是把竞价默认模板上云（saveBiddingTemplate），但读取路径未接通，
--   loadBiddingTemplate 成了死函数；live 模板真相仍是 localStorage 的
--   biddingDefaultTemplate_v41。因此本表持续接收写入，却从未被读取。
--
-- ⚠️ 删除前必须先改代码（否则写入会 fail-soft 报错但不丢业务）：
--   在删除本表前，应移除 auction-sync.js:558 对 saveBiddingTemplate 的调用
--   （或改为 no-op），否则每次 pullFromCloud 都会对本表产生一次被 catch 的写入失败。
--
-- 清理动作（幂等、安全）—— 仅在完成上述代码改动后执行：
--   1) 解除 Realtime 发布（DROP 会自动级联）；
--   2) DROP TABLE IF EXISTS。
-- 注意：本脚本需在 Supabase 项目手动执行一次。执行前务必确认调用方已移除。
-- -----------------------------------------------------------------------------

-- 0) 前置条件提醒（不会自动执行，仅作人工核对）
--    grep -rn "saveBiddingTemplate" src/  应只剩 bidding-template-sync.js 内部定义，
--    不再有 auction-sync.js 的调用；否则请勿执行下方 DROP。

do $$
begin
  if exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'auction_bidding_template'
  ) then
    alter publication supabase_realtime drop table auction_bidding_template;
  end if;
end $$;

drop table if exists auction_bidding_template;
