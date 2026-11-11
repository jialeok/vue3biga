-- ============================================================================
-- 「题材量比」看板 · 【选股结论快照表】tvrb_plan_snapshot
-- 应用层：src/data/tvrb-plan-snapshot.js（唯一读写入口）
--         src/logic/topicvolratio/plan-snapshot-codec.js（序列化 / 校验）
--         src/logic/topicvolratio/plan-snapshot-rules.js（规则指纹 / 新鲜度 / 写入准入）
--         src/composables/useTopicVolRatioBoard.js（定稿写入 / 切日期读取 / 规则变更重算）
--
-- ── 第一版为什么建这张表（2026-11-11 用户口径）────────────────────────────────
--   「昨天11月10日，题材量比的选票结果冰山火热又不见了……我有时要看历史日期复盘的，
--     为什么老是搞失踪……这不是一只票问题，是整个类的问题」
--   取证：结论只存在内存 `_buyPublished`；切日期解冻 ⇒ 用会漂移的库内行情重算 ⇒
--   历史日门控跳过竞价口径榜 ⇒ 早期残缺结论被定稿冻结 ⇒ 票消失且改不回来。
--
-- ── 🔴 第二版修订（同日，用户纠正了第一版的设计）──────────────────────────────
--   用户原话：「既然历史日期能计算出来，能计算出来就要存起来啊，为什么一定要最新日期
--     到来呢？……题材更变，核心词的同义词更变，可能对表的历史结果有影响（也就是选票
--     结果有更换），这是很合理的……这是我本身纠错行为，不影响整体逻辑……所以建表时
--     要注意，结果不是一成不变的。我希望历史日期既然能计算出来也要存起来。」
--   ⇒ 第一版的「只写今天 + ignoreDuplicates 一天锁死 + 历史日绝不入库」是**设计错误**：
--       ① 历史日期算得出来就存得下来，没有技术理由拒写；
--       ② 用户在核心词管理里增删改同义词会改变题材分组，选票结论本来就该跟着变，
--          「永不覆盖」把用户主动纠错挡在门外。
--
-- ✅ 新语义：**一天一行，但可修订（不是一成不变）**
--   · 任何日期（今天 / 历史日）只要算出一份【干净定稿】就 upsert 存起来；
--   · `rules_sig` = 规则输入指纹（当前纳入核心词表 `{name, synonyms[]}` 的内容 hash）。
--     用户在核心词管理增删改同义词 ⇒ 指纹变 ⇒ 历史日期自动按新规则重算并**覆盖**存档；
--   · `selection_sig` = 选股结论指纹，用于幂等：结论没变不重复写；
--   · `revision` / `settled_at` 留痕：能看到这份结论被修订过几次、最后一次什么时候。
--
-- ── 🔴 第三版修订（同日 21:xx，又一次线上实证）────────────────────────────────
--   事故：11-11 21:22 存进去一份 `pickCount=1` 的结论，`rules_sig` 命中 ⇒ 永久 hit。
--     但当天 `stock_range20_pct` 的 **auc 腿是 0 行**（9:26/9:27 云端预填撞 42P10 全灭），
--     前端判「竞价口径还没有」⇒ 20 日补位池空 ⇒ 结论是在**输入残缺**时算出来的。
--     数据后来补全了，屏幕却永远显示那份残缺结论（用户体感：越改越乱）。
--   ⇒ 存档必须同时记住「这份结论是在什么完整度的输入上算出来的」：
--     `inputs_sig` = 竞价榜就绪 / 量比达标 / 补位池非空 三位布尔指纹。
--     数据从残缺变完整 ⇒ 判 stale ⇒ 用完整输入重算并覆盖（结果不是一成不变的延续）。
--
-- ── 红线（⛔ 别改回去）──────────────────────────────────────────────────────
--   · 仍然恒 `leg='auc'`：只存 9:25/9:26 竞价口径结论，收盘口径不进这张表。
--   · ⛔ 不允许把【降级结论】写进来：网络硬兜底 / 输入未齐 / 数据闸门拦截的定稿不写，
--     否则一份不完整的空仓会被固化成永久存档（比没有存档更糟）。
--   · §10 / §11：**读档失败不覆盖**（不知道库里那天有没有行）；表不存在不写；
--     核心词没从云端加载完不判「规则变了」（首屏默认词表会造成误判）。
--   · 表不存在 / 读取失败 / 快照损坏，是三种不同状态，⛔ 不许一律当「没有存档」。
--
-- 执行方式：Supabase Dashboard -> SQL Editor -> 新建 Query -> Run（幂等，可重复执行）
-- ⚠️ 已经执行过【第一版】的用户：**直接重跑本文件即可升级**，
--    下面三条 `add column if not exists` 会补出新列，已有数据一行不丢、不删表。
--    升级前旧行的 `rules_sig=''` ⇒ 前端判「规则指纹待补齐」⇒ 重算一次并自愈。
-- ============================================================================

create table if not exists tvrb_plan_snapshot (
  date           text        not null,       -- 交易日 YYYY-MM-DD（主键：一天一行）
  plan           jsonb       not null,       -- 定稿快照（安全序列化后的纯 JSON 对象）
  leg            text        not null default 'auc',      -- 口径标记，恒 auc
  source         text        not null default 'tvrb-board',
  rules_sig      text        not null default '',          -- 规则输入指纹（核心词同义词等）
  selection_sig  text        not null default '',          -- 选股结论指纹（幂等用）
  inputs_sig     text        not null default '',          -- 输入完整度指纹（竞价榜/量比/补位池 三位）
  revision       integer     not null default 1,           -- 第几版（用户纠错后 +1）
  settled_at     timestamptz not null default now(),       -- 最后一次定稿 / 修订时刻
  created_at     timestamptz not null default now(),       -- 首次落库时刻
  primary key (date)
);

-- 第一版表已在生产库存在 ⇒ 幂等补列（Migration §13：执行一次 = 执行十次结果相同）
alter table tvrb_plan_snapshot add column if not exists rules_sig     text    not null default '';
alter table tvrb_plan_snapshot add column if not exists selection_sig text    not null default '';
alter table tvrb_plan_snapshot add column if not exists inputs_sig    text    not null default '';
alter table tvrb_plan_snapshot add column if not exists revision      integer not null default 1;

comment on table tvrb_plan_snapshot is
  '题材量比看板 · 选股结论快照：一天一行、恒 9:25 竞价口径、可修订。任何日期算出干净定稿就入库；核心词同义词变更导致 rules_sig 变化时，历史日期按新规则重算并覆盖；读档失败绝不覆盖';

comment on column tvrb_plan_snapshot.rules_sig is
  '规则输入指纹（plan-snapshot-rules.js#buildRulesFingerprint）。与存档时不同 ⇒ 判 stale ⇒ 该日按当前核心词重算一次并覆盖本行';
comment on column tvrb_plan_snapshot.selection_sig is
  '选股结论指纹（buy-quiesce.js#buildBuySelectionSig）。结论没变则不重复写库；规则指纹变了即使结论相同也要写一次以更新 rules_sig';
comment on column tvrb_plan_snapshot.revision is
  '该日结论的修订次数：首次=1，每次因规则/结论变化覆盖时 +1（用户核心词纠错留痕）';
comment on column tvrb_plan_snapshot.inputs_sig is
  '输入完整度指纹（plan-snapshot-rules.js#buildInputsFingerprint：竞价榜就绪|量比达标|补位池非空）。不等于当前值 ⇒ 判 stale ⇒ 用完整输入重算并覆盖，避免把「输入残缺时算出的结论」永久冻结';

-- 行级安全：与 tvrb_ebb_days / auction_watchlist / market_metrics 一致（anon 全开放读写）
alter table tvrb_plan_snapshot enable row level security;

drop policy if exists "allow_all_tvrb_plan_snapshot" on tvrb_plan_snapshot;
create policy "allow_all_tvrb_plan_snapshot"
  on tvrb_plan_snapshot for all to anon using (true) with check (true);

-- 复核：某日有没有存档、第几版、什么时候定稿 / 修订
-- select date, leg, rules_sig, revision, settled_at, created_at,
--        jsonb_typeof(plan) as plan_type
--   from tvrb_plan_snapshot order by date desc limit 20;
