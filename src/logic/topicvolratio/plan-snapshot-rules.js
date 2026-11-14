// plan-snapshot-rules.js — 选股结论存档的【规则指纹 / 新鲜度】判据（Logic 层，纯函数，§15 可单测）
//
// ★★ [TVRB-PLAN-SNAPSHOT-REVISABLE 2026-11-11] 用户纠正（原话）：
//   「既然历史日期能计算出来，能计算出来就要存起来啊，为什么一定要最新日期到来呢？
//     还有一个影响问题，就是题材更变，核心词的同义词更变，可能对表的历史结果有影响
//     （也就是选票结果有更换），这是很合理的……这是我本身纠错行为，不影响整体逻辑
//     ……所以建表时要注意，结果不是一成不变的。」
//
// ⇒ 上一版把「一天一行 + ignoreDuplicates 只写一次 + 只写今天」当成保护，是**设计错误**：
//   ① 历史日期算得出来就存得下来，⛔ 没有技术理由拒写；
//   ② 用户手动增删改核心词同义词会改变题材分组 ⇒ 选票结果本来就应该跟着变，
//      锁死「永不覆盖」反而把「纠错」挡在门外。
//   ⇒ 新语义：**一天一行，但可修订**；任何日期算出来都存，规则指纹变了就重算并覆盖。
//
// ── 为什么指纹必须基于【内容】而不是 `getCoreTopicsVersion()` ──────────────────
//   `getCoreTopicsVersion()` 是内存计数器，页面一刷新就归零重新计数。拿它当存档版本
//   ⇒ 每次打开页面都会误判「规则变了」⇒ 历史日期天天重算、天天覆盖，稳定性全毁。
//   ⇒ 用核心词表内容的确定性 hash：内容没变 ⇒ 跨设备 / 跨会话 / 刷新后指纹恒相同。
//
// §6 单一真相：本模块是「规则输入有没有变」的唯一判据，⛔ 别在 composable 里另写比较。
// §10：指纹算不出来 / 核心词没加载完 ⇒ 一律判「存档有效」，⛔ 绝不拿中间态当「规则变了」。

/**
 * 规则代码版本。改了题材分组 / 选股规则的人必须手动 +1 ⇒ 存档判过期、按新规则重算一次。
 *
 * 版本史：
 *   v1 = 初版（核心词表内容 hash）。
 *   v2 = ★★ [NEW-DRAGON-CERTIFY 2026-11-12 用户口径] 第二十八条新增【同题材择优】：
 *        同题材在前五有两只及以上时，只买竞价口径最靠前的那只（认证龙），
 *        首次进前五的那只只作判断条件。**选股结论会变**（11-12：光洋股份 → 襄阳轴承）
 *        ⇒ 必须 bump，否则那一份按 v1 规则定稿的存档会永久 hit，屏幕上一直是错的那只。
 *   v3 = ★★ [NEW-DRAGON-FAMILY 2026-11-12 用户口径] 第二十八条改成【新题材 = 字号/字辈题材】：
 *        当日 20日涨幅（竞价口径）前十按题材段分组，同题材 ≥2 只且有新面孔 ⇒ 新题材成立；
 *        老龙换题材（双重属性）可入选，并再补一只该题材的新面孔（最多 2 只）。
 *        **选股结论会变**（11-12：福莱新材 → 东方海洋/大东方）⇒ 必须 bump。
 *        上一版 v2 的「同题材择优 · 前五（认证龙）」降级为兜底路径。
 *   v4 = ★★ [NEW-DRAGON-FAMILY-OLD + EBB-LINEAGE-FIRST + EBB-PHASE-KEY 2026-11-12 用户口径]
 *        用户当场纠正「退潮的是羊字辈，新题材的是东方，你搞混了吧？」：
 *        ① 新题材候选【排除正在退潮的老题材】，且平局排序改成「新面孔多的优先 → 字辈线靠后」
 *           （上一版按成员数排 ⇒ 东方海洋同属两段时，羊字辈 4 只压过东方 3 只 ⇒ 选出光洋股份/阳光照明）；
 *        ② 退潮题材改锚【字辈线】（羊字辈），⛔ 不再是「成员数最多」的东方；
 *        ③ 退潮事件计数改按【同一只总龙 或 同题材线】认周期（题材改名不再把计数清零）。
 *        **选股结论会变**（11-12：光洋股份/阳光照明 → 东方海洋 + 大东方）⇒ 必须 bump。
 *   v5 = ★★ [LEADER-FIRST-TOPIC 2026-11-12 用户口径] 第二十八条的「老题材」改成
 *        【老龙一第一次霸榜总龙一那天、它所在组里成员最多的那一段】：
 *        用户原话「你说农业（老龙一 东方海洋）……确定是羊字辈的题材……这个就是作为老题材，
 *        也就是羊字辈，而不是你说的农业」。
 *        ① 老题材 = 首霸日那天的题材大类（东方海洋 ⇒ 11-04 ⇒ 羊字辈 5 只），
 *           ⛔ 不再直接用退潮行落库的那一段（那是「水产品 ⇒ 农业」归一出来的细分）；
 *        ② 「正在退潮的老题材」排除清单同步改成这一段 ⇒ **新题材候选会变**；
 *        ③ 所有题材表述按【核心词（大类）】印。
 *        ⇒ 必须 bump（否则按 v4 定稿的存档会永久 hit，屏幕上一直是「农业」）。
 *   ⚠️ 历史日不因 bump 重算 —— 【已作废，见 v14】。
 *   ★ 但【题材库内容变了】是例外：那一段指纹一变，历史日也重算（用户 11-12 口径）。
 *
 *   ── v6（2026-11-13）· [LD-CLOUD] 第二十五条「总龙首次/二次分歧」改由【云端】预计算 ──
 *       用户原话：「你帮我完成啊，不要留着，记住都是在云端运行，关电脑也能用，不要电脑本地的」。
 *       ① 判定不再由浏览器现算，而是 Worker 在 9:27 / 16:00 算完落 tvrb_leader_diverge，
 *          前端只读一行注入 ebbCtx.leaderDiverge；
 *       ② 二次分歧 ⇒ 按用户口径【等同首次退潮】⇒ 退潮结论（ebb / 提示板标题 /
 *          「退潮不买」的范围）会因此变化；云端那一行没算出来 ⇒ 静默退回旧口径。
 *       ⇒ 必须 bump（否则按 v5 定稿的存档会永久 hit，屏幕上永远没有「二次分歧 · 等同退潮」）。
 *   ⚠️ 同上：历史日不因 bump 重算（见 resolvePlanSnapshotFreshness）。
 *
 *   ── v7（2026-11-13）· [ABNORMAL-10D + BUMP-GUARD] 第三十四条【监管异动 · 十日涨幅硬上限】 ──
 *       用户原话（11-13 早间，晚间已把 95 上调为 97 ⇒ 见 [CAP-97] v9）：「新增总约束，十日涨幅竞价口径不能超过95%……十日达到100%异动，提示空仓，
 *       选出的票整块变灰色（不用去掉）……总龙一异动次日……要提示空仓，不再买进任何股票」。
 *       ① 龙位跳过 / 顺延、③ 异动日空仓标语接管、④ 全部买点通道下线 ⇒ 【选股结论会变】；
 *       ② 但落地时 `TVRB_RULES_VERSION` 忘了 bump ⇒ 11-13 那份 v6 定稿存档的 `rules_sig`
 *          与当前指纹一致 ⇒ `resolvePlanSnapshotFreshness` 判 `hit` ⇒ 直接读旧结论，
 *          用户刷新多少次都看不到「监管异动」（这就是「现在刷新并没有生效」的真因，
 *          ⛔ 不是 JS 没上线，也不是缓存，是【存档没过期】）。
 *       ⇒ 必须 bump 到 7：今天判 stale 重算并按新规则修订存档；历史日保持定稿。
 *         ⚠️ 「历史日保持定稿」这条在 v14（[RULES-BUMP-ALL]）被用户推翻 —— 现在历史日也重算。
 *   ⚠️ 以后【凡是改了选股结论却没 bump 本常量】，等于改了个不生效的规则 —— 测试里有 guard。
 *
 *   ── v8（2026-11-13）· [ABNORMAL-ALL] 第三十四条升级为【显示层总约束】 ──
 *       用户原话：「昨天异动，11月12日买点侧也应该是灰色整片啊，也要提醒空仓啊，
 *       因为昨天买入的话，就是个坑，也没有买点，现在还显示着东方海洋和大东方，
 *       这不合理的，要买点侧全部灰色」。
 *       ① 异动判据补「全市场 9:26 竞价口径十日涨幅最高票」接管（旧版只盯 20日涨幅总龙一
 *          top5[0]，11-12 那一位是福莱新材，漏掉十日涨幅 100.78% 的总龙二东方海洋）；
 *       ② `abnormal-overlay#applyAbnormalOverlay` 在 displayPlan 出口统一叠加空仓标语 +
 *          逐行【异动不买】+ 全灰标记，⛔ 不改写历史定稿存档；
 *       ③ 六个渲染在灰化容器之外的独立买点容器（含 11-12 的 newDragon: 东方海洋/大东方）
 *          由 abnormalGray 一起灰化。
 *       ⇒ ②③ 不依赖存档重算（历史日照样生效）；① 会改变今日选股结论 ⇒ 必须 bump 让今天重算。
 *
 *   ── v9（2026-11-13）· [CAP-97] 自定义禁选上限 95% → 97% ──
 *       用户原话：「你把它调到97%吧……11月11日这样能正常运行」。
 *       11-11 东方海洋真实竞价口径 95.711445% 由「危险」回到【正常】⇒ 选股结论会变 ⇒ bump。
 *       commit `8de62f6b`；sw.js v43 → v44。
 *
 *   ── v10（2026-11-13）· [FULL-MARKET] ＞97% 升格为【全场级监管异动】 ──
 *       用户当场纠正（逐字）：「是整个题材的，你没听懂吗？也就是全场整片灰，整个市场也是灰色，
 *       没有票可以买，我都说了总龙一影响范围很大的。这个波及到所有的票。」
 *       ① 撤销「near = 票级禁选预警 / 跳过该龙位顺延下一只」：`skippedAbnormalNames` 恒空；
 *       ② `isOverRange10Cap`（near || abnormal）成为【唯一全场禁买判据】，
 *          `resolveAbnormalFact` 三种 kind 统一走它 ⇒ 97~100 与 ≥100 后果完全相同；
 *       ③ 规则层 `_applyAbnormalSweep` 收口 + 显示层 `applyAbnormalOverlay` 整片灰，
 *          历史日仍不重算存档（护栏不变）。
 *       ⇒ **选股结论会变**（97~100 从「还能买次强的」变成「一张票都不买」）⇒ 必须 bump；
 *         ⛔ 不 bump 的话今天那份 v9 定稿会永久 hit，刷新多少次都是旧结论。
 *       sw.js 同步 v44 → v45（⛔ 不换名手机端继续吃 v44 旧 JS）。
 *
 *   ── v11（2026-11-13 深夜）· [ABN-SAME-SOURCE] 异动点名的「名字 / 涨幅」必须同源 ──
 *       用户报错（逐字）：「11月13日提示那个就有错误，上面说市场总龙一闵发铝业十日涨幅100.78%，
 *       根本不是，不知道这些数据从哪里来，相差太大了，是不是逻辑错误你要审查下这个题材量比
 *       选票异动情况的逻辑，还有计算问题，看是否计算正确」。
 *       库内取证（stock_range_pct + market_metrics 反解）：
 *         · 11-12 东方海洋 100.78%（闽发铝业 87.04%）
 *         · 11-13 闽发铝业 84.88%（东方海洋 73.15%）；二十日总龙一 = 东方海洋 135.61
 *       ⇒ 旧实现「名字取今日最高票 + 数值取昨日最高票」拼出「闽发铝业 100.78%」（差 13.74 点）。
 *       ① 新增纯函数 `pickAbnormalSource`：候选 = {name,pct,basis,isTop1} 四件套整体择一；
 *       ② `tvrb-plan` 与 `abnormal-overlay#buildAbnormalFactFromMaps` 都改走它，
 *          定了触发源后两个数值【按名字重取】；
 *       ③ 新增 `leaderIsTop1`：不是二十日总龙一就写「市场十日涨幅最高票」，⛔ 不许冒称总龙一。
 *       ⇒ **选股结论不变**（11-11 照常、11-12/11-13 仍空仓），但**上屏文案变了**；
 *         仍是必须 bump —— 否则今天那份 v10 定稿 hit 后继续显示旧错配文案。
 *       sw.js 同步 v45 → v46。
 *
 *   ── v12（2026-11-14）· [ABN-MAINBOARD] 第三十四条只认主板 ──
 *       用户原话（逐字）：「我要求的是主板的异动的有提醒，非主板就不要考虑在里面，
 *       像历史日期的10月28日，为什么把非主板的也考虑在里面呢，这个不作为考虑，
 *       只考虑列表里的主板的，其它非主板不做考虑。这个不做判断标准，只有主板的才有这个条件。」
 *       而上屏注释里用户的原始措辞本来就是「所有大a主板10日涨幅不能超过100%」
 *       ⇒ 这不是新规则，是**实现漂移成了「全池扫描」**，本轮改回原意。
 *       ① 新增工厂 `makeAbnMainBoardFilter`：名字 → 代码（`stock-code-map#getStockCode`）→ 资格，
 *          资格判据复用 `auction/limit-up.js#isMainBoardRankEligible`（创业板 30 / 科创板 68 /
 *          北交所 4·8·92 = 无资格；代码缺失 ⇒ 保留，§10 方向性：判不出 ≠ 判出不是主板）；
 *       ② `maxRangePctOf(map, isEligible)` 加可选过滤参，`tvrb-plan` 三处候选池与
 *          `abnormal-overlay#buildAbnormalFactFromMaps` 三份 Map 全部带主板过滤；
 *       ③ 候选池本身【一行未改】：仍是 883410 + 观察组 + 龙头组 + 20 日补位
 *          （用户上一轮明确否决过收窄提议：「不要乱改啊……不要画蛇添足」）。
 *       ⇒ **选股结论会变**：09-08 ~ 11-13 全历史扫描 —— 旧口径触发 17 天 / 新口径 10 天 /
 *         只因为非主板超线而误触发 **7 天**（09-08、09-10、10-26、10-27、10-28 等，
 *         触发者全是凡拓数创 301313 / 花溪科技 920895 这类非主板票），**旧口径漏触发 0 天**。
 *         取证脚本 `.tmpdiag/_abn-history-scan.mjs`。
 *       ⇒ 必须 bump，否则这些天的定稿存档继续显示「全场空仓」旧结论。
 *       sw.js 同步 v46 → v47。
 *
 *   ── v13（2026-11-14）· [AUTO-PICK-TOP20] 「数量 > 8 只」改按同题材 20日涨幅前十取两只 ──
 *       用户原话（逐字，10-30 大消费 17 只那天为验收基准）：
 *       「当题材大于8数量时，选两只，只选同题材20日涨幅排名前十的最靠前两只……比如出现3只，
 *       就选排名靠前那两只，第三只不选，如果刚好两只，那就选那两只。如果有竞价涨停的，
 *       你就标注下股票标签。之前的那个顺位，就是一字涨停买不进，看下一个龙位，这个有些不准，
 *       因为核心股票基本是那些20日涨幅前排的，在题材中下一个龙位有可能是后排。所以现在竞价涨停的
 *       票也放进去，打上标签就可以……如果只有一只出现在排名前十的，你在同题材的再找一只补上，
 *       同题材靠前的。如果没有排名前十的，你再考虑常规的。」
 *       ① 新增纯函数 `pickBigTopicTop20`（池子 = `ebbCtx.topicPool` 前十，同题材判定走核心词大类归一）；
 *       ② `_buildBlock` 的 big 档候选改「前十（按 20日涨幅名次）→ 同题材其余（按龙位）」两截，
 *          竞价一字【照选 + 挂「等下杀买」标签】，⛔ 不再顺延下一龙位（mid 档不变）；
 *       ③ 行上新增 `range20Label`（20日涨幅主板第 N 名 + 值），视图多一枚靛蓝小徽标。
 *       ⇒ **选股结论会变**：10-30 大消费 17 只 —— 旧「上海九百 + 东贝集团」
 *         ⇒ 新「青岛食品（竞价一字，第 7 名） + 九阳股份（第 1 名）」，
 *         第 8 名 上海九百 按「第 3 只不选」口径不再入选。
 *       ⇒ 必须 bump，否则历史存档继续 hit 在旧结论上（新口径永远不生效）。
 *       sw.js 同步 v50 → v51。
 *
 *   ── v14（2026-11-14）· [RULES-BUMP-ALL] 规则升级后【历史日也要重算】（拆掉 [RULES-BUMP-GUARD]）──
 *       用户原话（逐字）：「这不是很合理吧，我之前那次因为切换日期它总是换结果，我想它一次给结果，
 *       切换日期也不用结果总是换来换去会误导判断，他们才冻住，这不是我想要的，
 *       **这个和规则没有关吧**？你重算一遍」
 *       ① `resolvePlanSnapshotFreshness` 删掉「allowRulesInvalidation === false ⇒ hit」（历史日保持定稿）
 *          那一句 ⇒ 规则 bump / 核心词变 ⇒ **任何日期都 stale**（过去只有今天 stale）；
 *       ② composable 两处 `allowRulesInvalidation: <date> === _bjTodayKey()` 同步移除；
 *       ③ 「切换日期结果飘移」仍由 内容 hash 指纹 + revision 幂等 + 「结论没变不重复写」保证；
 *       ④ 同轮 [MID-TOP20]：mid 档（4~8 只，取 1 只）也按 20日涨幅前十取名次最靠前的 1 只
 *          （10-21 商业航天 7 只：旧「龙三长春一东」⇒ 新「龙一海洋王〔第 9 名〕·竞价一字·等下杀买」）。
 *       ⇒ **选股结论会变**（历史日会按 v14 重算一遍）⇒ 必须 bump。
 *       sw.js 同步 v51 → v52。
 *
 *   ── v15（2026-11-14）· [ABN-DEV] 对接交易所官方「收盘价格涨跌幅偏离值」──
 *       用户原话（逐字）：「现在我自己计算的 20 日涨幅 100% 股票成异动不是很准确，
 *       它要计算和大盘指数的偏值，才可以算出官方异动」「对，你分析得很对，把这个对接上，
 *       设计方面你先改……这些在买点侧，也说明下，很重要，特别是竞价时，或者收盘后，
 *       我看一遍股票或者市场前十，就知道怎么参考了」。
 *       ① 新增 `logic/auction/abnormal-deviation.js`：官方公式
 *          （区间累计涨跌幅之差，复利）＋官方对应指数（sh000002 / sz399107 / sz399102 / sh000688）
 *          ＋阈值阶梯（3日±20/30%、10日+100%/−50%、30日+200%/−70%），7 条交易所真实名单复核 +1 交易日全中；
 *       ② 新增显示层叠加 `deviation-overlay.js`：买点行多一枚「10日偏离 +72.7% · 还需 +16%」徽标，
 *          买点侧上方多一张「官方偏离值」面板（市场前十 + 买点票，逐行 10日/30日偏离 + 距红线）；
 *       ③ 新增云端 `workers/.../logic/index-legs.js`：closepost(16:03) 把四个官方指数的逐日腿
 *          写进 `market_metrics(scope='index')` ⇒ 关电脑也能算（⛔ 不依赖浏览器现拉腾讯）。
 *       ⇒ **选股结论一个字都不变**（v15 只加显示层事实、⛔ 不改候选池 / ⛔ 不改买点标签）。
 *          之所以仍要 bump：`sw.js` 换名是唯一能强制手机端 cache-miss 的手段，
 *          而按本项目既定口径（v13 那条注释）「发版必须同时换 sw.js + bump 规则指纹」。
 *          代价只是历史日按同一批规则重算一遍，结论不变 ⇒ 指纹相同 ⇒ 不重写存档。
 *       sw.js 同步 v52 → v53。
 */
export const TVRB_RULES_VERSION = 15;

/**
 * 输入完整性指纹版本。新增 / 删除「完整性判据」时 +1 ⇒ 所有存档按新判据重算一次。
 */
export const TVRB_INPUTS_VERSION = 1;

/** FNV-1a 32bit（纯函数、无依赖、跨设备一致；只用于「变没变」，不用于安全场景） */
function _fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ('00000000' + (h >>> 0).toString(16)).slice(-8);
}

/**
 * 规则输入指纹。当前纳入：核心词表 `{name, synonyms[]}` 的**内容与顺序**。
 *
 * ⚠️ 刻意不排序：`matchTopicToCore` 是子串匹配，同义词顺序理论上不影响结果，但
 *    「用户调了顺序」也算一次编辑 ⇒ 指纹变 ⇒ 重算一次；结论没变时 selection_sig 相同，
 *    Data 层幂等跳过写库 ⇒ 不会污染存档。保守但零风险。
 * ⚠️ 将来若新增别的规则输入（题材库内容 / 规则参数），扩展入参即可；
 *    或者直接 bump `TVRB_RULES_VERSION` 强制全量重算。
 *
 * @param {Array<{name:string, synonyms?:string[]}>|null} coreTopics
 * @returns {string} 形如 'v1:1a2b3c4d'
 */
export function buildRulesFingerprint(coreTopics, topicDigest) {
  const arr = Array.isArray(coreTopics) ? coreTopics : [];
  const parts = arr.map(function (t) {
    if (!t || typeof t !== 'object') return '';
    const name = String(t.name == null ? '' : t.name).trim();
    const raw = Array.isArray(t.synonyms) ? t.synonyms : [];
    const syn = raw.map(function (s) { return String(s == null ? '' : s).trim(); }).join(',');
    return name + '=' + syn;
  });
  const base = 'v' + TVRB_RULES_VERSION + ':' + _fnv1a(parts.join('|'));
  // ★★ [TOPIC-LIB-SIG 2026-11-12 用户口径] 第三段 = 【个股题材库】内容指纹
  //   用户原话：「比如我在今天改了题材，我希望历史日期题材量比选股也会根据这个题材改变做改变
  //     ……之前那些选票也要根据我手动改的题材变化」。
  //   ⚠️ 刻意**独立成一段**：与规则版本 / 核心词的处置相反 ——
  //     规则升级只重算【今天】（历史保持定稿），而【题材库变了，历史也要重算】（用户明确要求）。
  //     两段拆开才能在 `resolvePlanSnapshotFreshness` 里分别放行。
  const td = String(topicDigest || '').trim();
  return td ? (base + ':' + td) : base;
}

/**
 * ★★ [SNAPSHOT-INPUTS 2026-11-11 · 整类修复] 选股结论的【输入完整性指纹】。
 *
 * 为什么必须有（11-11 P0 实证）：
 *   21:22 把一份 `pickCount=1` 的结论按 `rules_sig` 命中写进了存档。当晚库里
 *   `stock_range20_pct` 当天的 **auc 腿是 0 行**（9:26/9:27 云端预填撞 42P10 全灭），
 *   前端拿「只有 close 腿」的表判「竞价口径还没有」⇒ 20 日补位池空。
 *   ⇒ 结论是在**输入残缺**时算出来的。存档只记了 rules_sig（核心词没变），
 *     于是它**永久 hit**：数据后来补全了，屏幕也永远显示那份残缺结论。
 *     用户体感就是「昨天修好了，今天又不见」「越改越乱」。
 *
 * ⇒ 判据：把「这份结论是在什么完整度的输入上算出来的」也存进存档。
 *   数据从「残缺」变「完整」时，存档必须判 stale ⇒ 重算并覆盖（用户口径：结果不是一成不变的）。
 *
 * 三位（顺序固定，⛔ 别改顺序 —— 改了等于换了语义，必须 bump TVRB_INPUTS_VERSION）：
 *   ① 竞价口径 20 日涨幅榜是否就绪（`tvrb-auction-board` ready 且前五非空）
 *   ② 量比闸门是否通过（`resolveBuyDataGate` 未 blocked ⇒ 整表量比覆盖达标）
 *   ③ 20 日补位池是否非空（竞价榜 wide 或收盘口径发布榜任一有票）
 *
 * ⚠️ 刻意只记【布尔完整度】不记条数：行数在 9:25→16:00 之间本来就会正常增长，
 *   若记条数，下午打开历史日会天天误判 stale ⇒ 天天重算覆盖（正是要避免的抖动）。
 *
 * @param {{aucBoardReady?:boolean, volRatioOk?:boolean, poolOk?:boolean}} o
 * @returns {string} 形如 'v1:111'（空入参 ⇒ 'v1:000'）
 */
export function buildInputsFingerprint(o) {
  const x = o || {};
  const bits = [
    x.aucBoardReady === true ? '1' : '0',
    x.volRatioOk === true ? '1' : '0',
    x.poolOk === true ? '1' : '0'
  ].join('');
  return 'v' + TVRB_INPUTS_VERSION + ':' + bits;
}

/** 指纹是否表示「三元判据全部达标」（='v1:111'）。算不出来 / 非字符串 ⇒ false（⛔ 不当成完整）。 */
export function isInputsFingerprintComplete(sig) {
  const s = String(sig || '').trim();
  if (!s) return false;
  const m = /^v\d+:([01]{3})$/.exec(s);
  return !!m && m[1] === '111';
}

/**
 * 判断一份已读到的存档是「仍有效」还是「规则变了，需要重算覆盖」。
 *
 * 三条保护红线（⛔ 别「优化」掉）：
 *   ① 核心词还没从云端加载完 ⇒ 判 hit。首屏 `getCoreTopics()` 是默认词表，
 *      此刻比较必然不等 ⇒ 会在数据没齐时触发重算并覆盖一份好存档（§10/§11）。
 *   ② 当前指纹为空 ⇒ 判 hit（算不出来不等于变了）。
 *   ③ 旧存档没记 rules_sig（升级前的行）⇒ 判 stale，重算一次补齐元数据；
 *      这是**有意的自愈**，不是误判。
 *
 * ★★ [SNAPSHOT-INPUTS 2026-11-11] 规则没变之后再比【输入完整性】：
 *   ④ 存档没记 inputs_sig（升级前的行 / 上一版写的历史行）⇒ 判 stale，自愈一次。
 *      这就是「11-11 21:22 那份 pickCount=1 的残缺存档」被自动重算覆盖的入口。
 *   ⑤ 当前输入算不出来（''）或仍不完整（含 0）⇒ 判 hit：
 *      数据还没齐时不反复重算（避免抖动 / 反复覆盖），等齐了自然走 ⑥。
 *   ⑥ 存档的完整度和当前不一样 ⇒ 判 stale。
 *      典型：存档时 `v1:110`（auc 腿缺失导致补位池空），现在 `v1:111`
 *      ⇒ 必须用完整输入重算并覆盖，⛔ 不许把残缺结论冻结到今天以后。
 *
 * @param {object} snap { status, rulesSig, inputsSig }
 * @param {object} opts { rulesSig, coreTopicsLoaded, inputsSig }
 * @returns {'hit'|'stale'|'unknown'} unknown = 不是有效存档状态，本判据不管
 */
export function resolvePlanSnapshotFreshness(snap, opts) {
  const s = snap || {};
  const o = opts || {};
  if (s.status !== 'hit' && s.status !== 'stale') return 'unknown';
  if (o.coreTopicsLoaded !== true) return 'hit';
  const cur = String(o.rulesSig || '').trim();
  if (!cur) return 'hit';
  const old = String(s.rulesSig || '').trim();
  if (!old) return 'stale';
  if (old !== cur) {
    // ★★ [TOPIC-LIB-SIG 2026-11-12] 按【哪一段变了】分流 —— 两段的处置相反：
    //   · 第 3 段（个股题材库）变了 ⇒ **历史日也重算**（用户口径：他改了题材，历史选票要跟着改）；
    //   · 第 1~2 段（规则版本 / 核心词）变了 ⇒ **任何日期都重算**（v14 [RULES-BUMP-ALL] 起；
    //     过去只有今天重算、历史日保持定稿，那条护栏已被用户明确推翻）。
    // ⚠️ 顺序由 [CORE-PURGE-SYNC 2026-11-14] 定为「**题材库段先判**」：两段同时变时必须走题材库那条
    //    （否则规则一 bump，历史日的题材更新就被永久挡住 —— 11-05 就是这么坏的）。
    const os = old.split(':');
    const cs = cur.split(':');
    const oldBase = os.slice(0, 2).join(':');
    const curBase = cs.slice(0, 2).join(':');
    const oldTop = os.slice(2).join(':');     // ⚠️ 题材库指纹自带冒号（'tl1:xxxx'）⇒ 必须把余下各段拼回去
    const curTop = cs.slice(2).join(':');

    // ★★ [CORE-PURGE-SYNC 2026-11-14 用户报障后修] 题材库那一段必须【先判、且与 base 段是否相同无关】。
    //
    //   事故现场（用户原话）：「题材量比提示板原版那里也要啊，非简洁版的，有很多文字那版，
    //   比如11月5日，还显示羊字辈题材选择理由，我都删除了，为什么还显示呢？」
    //   库内取证：11-05 存档 rules_sig = `v11:d83ebd81:tl1:7404491d`，而当时规则版本已 bump 到 12
    //   ⇒ 旧实现先比 base 段：v11≠v12 ⇒ 直接落到下面的「规则升级」分支
    //   ⇒ 旧版的 `allowRulesInvalidation:false`（历史日）再返回 hit ⇒ **永远走不到「题材库变了」那一支**
    //     （该选项已在 v14 / [RULES-BUMP-ALL] 删除，此处只留事故记录）。
    //   也就是说：只要规则版本也动过，历史日的题材更新就永久失效 —— 这是旧实现的整类缺陷，
    //   不只 11-05 一天（实测 11-02/11-03/11-04/11-05/11-12/11-13 六天全部卡住）。
    //
    //   ⇒ 现在的优先级：**题材库变了 = 最高优先**（用户口径「题材要更新，不管简洁版还是原版都要同步」），
    //     规则升级只在「题材库没变」时才按 [RULES-BUMP-GUARD] 只重算今天。
    //   §10：当前算不出题材库指纹（curTop 为空）⇒ 不拿它做决定，继续按 base 段判。
    if (curTop && oldTop !== curTop) return 'stale';   // ★ 含历史日一律重算
    if (oldBase === curBase) return 'hit';             // 题材库没变、规则也没变
    // ★★ [RULES-BUMP-ALL 2026-11-14 用户口径 · 推翻 [RULES-BUMP-GUARD]] 规则升级（bump
    //   `TVRB_RULES_VERSION` / 改核心词）⇒ **任何日期都重算**，历史日也一样。
    //
    //   用户原话（逐字）：「这不是很合理吧，我之前那次因为切换日期它总是换结果，我想它一次给结果，
    //   切换日期也不用结果总是换来换去会误导判断，他们才冻住，这不是我想要的，**这个和规则没有关吧**？
    //   你重算一遍」
    //   ⇒ 当初冻住历史日的**真实目的只有一个**：同一天反复重算导致结果飘移、切日期就换结论；
    //     跟「规则升级要不要回算历史」是两件事，用户认为不该搭在一起。
    //   ⇒ 旧实现在这里还有一句「allowRulesInvalidation === false ⇒ 返回 hit」（历史日保持定稿），
    //     本轮按其明确要求【删除】，对应入参也从两处调用点移除。
    //
    //   ⚠️ 「稳定性」由别处保证，⛔ 不需要靠冻结历史日来实现：
    //     ① 指纹是**内容 hash**（`buildRulesFingerprint`），刷新 / 换设备都恒相同 ⇒ 不会自己抖；
    //     ② 落库走 revision 幂等（同一份规则只修订一次）；
    //     ③ `shouldPersistPlanSnapshot` ④「结论没变不重复写」⇒ 重算后结论一样就不写库。
    return 'stale';
  }
  // ── 规则没变 ⇒ 再核对「输入完整度」（④⑤⑥）
  //  ⚠️ 库里还没有 inputs_sig 列（降级模式）⇒ 这一位不支持，⛔ 不许把「没有该字段」当过期，
  //     否则每次打开页面都会判 stale 重算一遍（而降级模式下永远补不上这一列）。
  if (o.inputsSigSupported === false) return 'hit';
  const oldInputs = String(s.inputsSig || '').trim();
  if (!oldInputs) return 'stale';                 // ④ 元数据缺失 ⇒ 自愈一次
  const curInputs = String(o.inputsSig || '').trim();
  if (!curInputs) return 'hit';                   // ⑤ 当前算不出来 ⇒ 不动存档
  if (!isInputsFingerprintComplete(curInputs)) return 'hit';  // ⑤ 数据还没齐 ⇒ 不抖动
  if (oldInputs !== curInputs) return 'stale';    // ⑥ 从残缺变完整 ⇒ 用完整输入重算覆盖
  return 'hit';
}

/**
 * 这次定稿要不要真的写库（§32 幂等 + §11 覆盖保护）。
 *
 * ① 读档失败 ⇒ 绝不写：不知道库里那天有没有行，贸然 upsert 可能覆盖好存档（§10）。
 * ② 表不存在 ⇒ 写也没用，跳过。
 * ③ 规则指纹变了（stale）⇒ **必须写一次**，哪怕选票结论一模一样，
 *    否则 rules_sig 永远不更新，下次进页面又判 stale ⇒ 无限重算。
 * ④ 其余情况：选票指纹变了才写（结论没变不重复写，避免无意义请求）。
 * ⑤ hit（存档有效且屏幕冻结）⇒ 不会走到定稿，这里也挡一道。
 *
 * @param {object} o { status, selectionSig, nextSelectionSig }
 * @returns {{write:boolean, reason:string}}
 */
export function shouldPersistPlanSnapshot(o) {
  const x = o || {};
  const st = String(x.status || '').trim();
  if (st === 'error') return { write: false, reason: 'read-failed' };
  if (st === 'unavailable') return { write: false, reason: 'table-missing' };
  if (st === 'hit') return { write: false, reason: 'already-current' };
  if (st !== 'empty' && st !== 'stale' && st !== 'corrupt' && st !== 'loading') {
    return { write: false, reason: 'unknown-status' };
  }
  if (st === 'stale') return { write: true, reason: 'rules-changed' };
  if (st === 'corrupt') return { write: true, reason: 'repair-corrupt' };
  if (st === 'loading') return { write: false, reason: 'still-loading' };
  const prev = String(x.selectionSig || '').trim();
  const next = String(x.nextSelectionSig || '').trim();
  if (prev && prev === next) return { write: false, reason: 'selection-unchanged' };
  return { write: true, reason: 'first-or-changed' };
}
