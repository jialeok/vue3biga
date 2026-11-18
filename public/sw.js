/* sw.js — 首屏静态资源本地缓存（BOOT-SW 2026-10-31）
 * ============================================================================
 * 这个文件解决的是【一个具体的、可复现的问题】：「刷新两次才能打开页面」。
 *
 * 实测（2026-10-31，直连线上 URL）：
 *   · GitHub Pages 给 index.html 的是 `cache-control: max-age=600`（10 分钟）；
 *   · 给 /assets/*.js|css 的是 `max-age=14400`（4 小时）；
 *   · 从本机网络取 5 个首屏资源，最坏一次 CSS +19972ms、入口 JS +55689ms 才到货。
 *   ⇒ 只要隔了 4 小时以上（早上开盘正是这种情况）再打开，assets 缓存已过期 ⇒ 又是一轮
 *     20~56 秒的冷启动 ⇒ 看门狗误报红屏；紧接着再刷新一次命中磁盘缓存，就正常了。
 *   ⇒ 所以这不是「偶发」，是【每早必现两次】。
 *
 * Service Worker 的 Cache API **不受 max-age 约束**（只有浏览器配额/用户清缓存能清掉）：
 *   · 首次访问仍要走网络（这一趟快不了，除非换托管）；
 *   · 但从此以后每次打开 —— 包括隔夜、隔周 —— 都直接命中本地缓存，秒开。
 *
 * 策略（刻意做得保守，避免「缓存导致白屏」这个经典事故）：
 *   ① /assets/*（文件名带内容哈希 ⇒ 内容永不变）→ cache-first，命中即返回；
 *   ② 页面导航（index.html）→ network-first，1.5 秒超时才回退缓存；
 *      ⇒ 网络正常且够快时永远拿最新 HTML；
 *      ⇒ 网络慢/断时用缓存兜底（不白屏），但**网络那条响应照样写回缓存**，
 *        且一旦发现线上 HTML 变了就通知页面弹「发现新版本」（SW-STALE-FIX 2026-11-01）；
 *   ③ 其它请求（Supabase 接口等）→ 完全不拦截，走原生网络（⛔ 绝不缓存业务数据）。
 * ============================================================================
 */
// ★★ [SW-STALE-FIX 2026-11-01] v1 → v2。
//   为什么必须换名字（不是习惯性递增）：v1 的导航分支有个真 bug（见下方 ② 的注释）——
//   超时回退时**网络响应被丢弃**，缓存里的旧 HTML 永远不会被更新。在「每个请求停顿 12~64 秒」
//   的网络下，等于把用户永久钉在发版前的那一版上（用户报障：「改了根本没生效」）。
//   换 cache 名 ⇒ activate 时把 biga-static-v1 整个删掉 ⇒ 下一次导航必然 cache-miss
//   ⇒ 直接走网络拿新 HTML ⇒ 一次刷新就脱离旧版本（代价：首屏资源要重下一次，值得）。
// ★★ [SW-STALE-FIX 2026-11-03] v2 → v3。
//   用户报障「第一页看不到同花顺最近多板那个数量」，而线上 bundle 里明明已有这段代码
//   （grep index-BmLs7Isv.js 命中「同花顺最近多板」）。根因就是本文件的网络特征：
//   导航 1.5s 超时 ⇒ 回退【v2 缓存里的旧 index.html】⇒ 旧 HTML 引用的是发版前的 JS 文件名
//   ⇒ 页面里根本没有那个标签。v2 的 bg 更新只解决了"下次会好"，解决不了"这次要看"。
//   再换一次缓存名 ⇒ 下一次导航 cache-miss ⇒ 必走网络拿当前 HTML ⇒ 立刻脱离旧版本。
//   ⚠️ 以后再出现「线上已换版但用户看不到」，先换这个版本号，别先去改业务逻辑。
var CACHE = 'biga-static-v81'; // [RANGE30-FY 2026-11-18] v80 → v81：云端数据源从腾讯换成【同花顺批量历史K线】—— 用户口径「同花顺接口不是更稳定吗？因为一直都在用」。腾讯前复权日线 16:20 还没有当天那根（落库后 `days=29`，算的是「截至昨收」），同花顺 16:40 就有当天收盘价，而且是原生批量（10 只/次，364 只 = 37 个请求 vs 腾讯 364 个），与十日/20日/涨停同一个上游同一个前复权口径。交易日历也改用同花顺 000001.SH。腾讯降级为**兜底**（同花顺整批失败时逐只回退）。⛔ 算式一行未动（range30-math.js 仍是唯一实现）⇒ TVRB_RULES_VERSION 仍 21。 // [RANGE30-CLOUD 2026-11-18] v79 → v80：30日涨幅改【云端算、前端读表】—— 根因取证：腾讯日线对「短时间一批并发请求」直接回 WAF 拦截页（HTTP 501 + HTML，`waf.tencent.com/501page.html`），手机点开 toggle 就并发打 32 只 ⇒ 全被拦 ⇒ 全部判不出 ⇒ 行上空白且不排序，`stock_range30_pct` 一条记录都没有（实测 /*0 行*/）。现在：① 算式抽成零依赖纯函数 `src/logic/auction/range30-math.js`（前端与云端唯一一份）；② 新增 `db/scripts/compute-range30-pct.mjs` + `.github/workflows/range30-cloud.yml`，工作日 09:40/16:20（北京）在 GitHub Actions 里取价、算比值、落库，**不再依赖手机能不能连腾讯**；③ 前端 `range30.js` 读到结果表后【先发布一次】再去补 K 线，库里已有值就立刻显示（不再等几十秒）。⛔ 不动算法、不动选股规则 ⇒ TVRB_RULES_VERSION 仍 21。 // [QT-WAF 2026-11-18] v78 → v79：腾讯日线通道换 host + 失败切换 —— **就在 v78 上线后，`web.ifzq.gtimg.cn` 整站开始返回 HTTP 501 + WAF 的 JS 挑战页（HTML，326 字节）**，任何请求头组合都一样 ⇒ `fetchQtDailyBars` 32 只全空 ⇒ 「30日涨幅」打开后行上一直空白、也不按涨幅排序（排序键就是这列数值，全部 null 自然保持原序）。实测同路径 `ifzq.gtimg.cn`（去掉 `web.`）仍是 200 + JSON 且带 `access-control-allow-origin: *`，32 只批量 0.7 秒 32/32。⇒ `src/data/api/qt-kline.js` 改成【多 host 失败切换 + 锁定可用 host】，并且按 content-type/首字符判 JSON（WAF 软拦截可能是 200 + HTML，光看 `resp.ok` 挡不住）。该修复对 30日涨幅 / 趋势图补点 / 逐日腿补缺 三条链同时生效（共用本模块）。⛔ 不改算法、不改选股规则 ⇒ TVRB_RULES_VERSION 仍 21。 // [RANGE30-CODE 2026-11-18] v77 → v78：修「打开 30日涨幅 toggle 后行上数值大面积空白」——`ensureRange30` 原来只靠 `getStockCode(名称)` 解析代码，而它读的 `stockcodemap` 表实测只有 1184 行（全市场 5000+），11-18 正式名单 32 行里 16 行在这张表根本不存在 ⇒ 被静默跳过；改【行内 code（auction_watchlist 的 code 列，实测 32/32 有值）优先，stockcodemap 仅兜底】，实测同日名单 32/32 都能算出值（文投控股 +104.24% / 龙江交通 601188 +65.16% / 亚玛顿 002623 +15.60% …）。同步新增「请求 N 只 → 算出 M 只」诊断日志（§10 失败可分辨）。⛔ 只改代码解析，不动算法与选股规则 ⇒ TVRB_RULES_VERSION 仍 21。 // [RANGE30 2026-11-18 用户口径] v76 → v77：早盘竞价看板新增「30日涨幅」独立功能（不影响任何既有开关的默认行为）—— ①原「竞/昨占比」toggle 的 UI 与功能整体移除（用户「现在用不到了，不要残留」），开关位换成独立的 30日涨幅 toggle（新组件 AuctionBoardRange30Toggle.vue）；②算法走用户拍板的【期末收盘价 / 期初前收盘价 − 1】一次性比值（数学上等价于逐日复利连乘，实测新华传媒 10-28 两法都得 +178.91%，且少一层逐日两位小数舍入），数据源腾讯前复权日线（免费、0 猫抓额度），结果落新表 stock_range30_pct（只 close 口径）；③有竞价/收盘两种口径（与十日/二十日同一把尺子：把今天那根腿用 recoverAuctionLeg 反解回 9:25）；④「最近多板」近 30 个交易日出现过的股票取 30 日涨幅前五做补位，行上打「30天」标签（新组件 AuctionRange30Leaders.vue，第五组，与「20天」补位并列独立）。⛔ 不动任何选股规则 ⇒ TVRB_RULES_VERSION 仍 21。 // [NOTE-EDIT-SHADOW 2026-11-18] v75 → v76：竞价量列「双击打开备注编辑」在【灰色注入行】上弹出空白框——龙头组 / 20日强势补位 / 观察组这些行的 `item.index` 是 renderList 下标（`renderList = 正式列表.concat(注入行)`），旧实现拿它去 `getTodayGroupList('auction')[index]`（**只含正式成员**）必然取到 undefined ⇒ 编辑框无涨幅无题材；同一个 undefined 还让保存路径 `if (!item) return` 【静默空转】（用户以为存了，一字未写）。改为按【股票名】解析目标行（新纯函数 `logic/auction/note-edit-target.js`：内存行优先，纯壳注入行退化成视图行），影子行保存时如实告知「涨幅写 market_metrics、题材写 stock_topics、note 不落 auction_watchlist」。只改读写目标的定位方式，⛔ 不动选股规则 ⇒ TVRB_RULES_VERSION 仍 21。 // [CORE-PURGE-STRING 2026-11-17] v74 → v75：删除核心词（正式核心词 / 临时题材都算）时，除 `stock_topics` 之外【同步清理 `auction_watchlist` 的 note / topics 两列】——早盘竞价看板「双击竞价量」弹出的备注、「单击昨日成交量」的黑色 toast 读的就是它们，只删题材库会留下用户报的「核心词删了、弹出来还是四个题材」。口径与题材库一致：只删【整段完全相等】的题材段（名 + 全部同义词，忽略大小写），其余题材一个不动、顺序不变；跨该票出现过的【全部交易日】；⛔ 不碰 change_pct（历史日是当日真实竞价涨幅）；⛔ 整行只剩这个词时进 blocked 跳过（§11 不清空）；写完回读校验 + 同步内存行 + 作废 note 缓存。只改数据、不改选股规则 ⇒ TVRB_RULES_VERSION 仍 21。 // [ABN-TB 2026-11-17] v73 → v74：第三十四条【延伸】—— 总龙一首次监管异动后的【第三天】不能再买它细分题材的股票（临时题材也算），第四天恢复正常。判据：D-2（前两个交易日）9:26 竞价口径里主板十日涨幅最高票 ＞ 97% ⇒ D-2 是异动日；禁令集合 = 它在 D-2 当天竞价名单 note 括号内的题材 + 题材库题材（真实案例：11-12 东方海洋 `水产品,农业,东方,羊字辈` ⇒ 11-16 的日出东方(家电,热泵,东方) 必须剔除）。只禁同题材、⛔ 不接管空仓标语（其它题材照常买），新增独立提示板 TvrbAbnormalTopicBan。**选股结论变了** ⇒ TVRB_RULES_VERSION 20 → 21（历史日重算）。⛔ 换名是唯一能强制 cache-miss 的手段。 // [TEMP-CORE-WINDOW 2026-11-17] v72 → v73：临时题材「窗口内标签延续」—— 修「11-12 设的临时核心词东方（区间 12~16），只有 12 号生效」：日期判定本来三天都对，缺的是标签供给（13/16 的 note 为空 ⇒ 回退共享库没有该词 ⇒ 组内 1 只 ⇒ <2 只不建组）；现在把「窗口内某天命中过该词的票」补回当天分组（只读 ≤ 当日的窗口数据，不读未来），⛔ 不写 note / stock_topics / core_topics，关停后照旧自动消失。⛔ 仍不 bump TVRB_RULES_VERSION（只归类，不改选股结论）。 // [TEMP-CORE-HIDE 2026-11-17] v71 → v72：临时题材关停后，股票名后那枚标签与第二页题材分组一起消失（显示/分组层精确过滤 name+同义词段，⛔ 不改 auction_watchlist.note / stock_topics 原始数据，恢复后标签自动回来）；隐藏严格限定「关停日（含）~ 区间末」，历史日与过期后不受影响。⛔ 仍不 bump TVRB_RULES_VERSION。 // [TEMP-CORE 2026-11-17] v70 → v71：核心词管理新增【临时题材】（规则 〇·a）—— 勾选后写独立表 core_topic_temp，生效 = 设置日起 3 个交易日，历史日/第4天起/关停当日之后自动换回主流题材；关停当日及之后失效、可恢复；只在输入侧按当日换词表，选股条文与买点侧禁选逻辑一行未动（用户拍板「只归类，不强制禁选」）。⛔ TVRB_RULES_VERSION 刻意【不 bump】：bump 会让所有历史日重算，正好违反本功能的「历史不受影响」；规则指纹已按当日有效词表计算，天然只让区间内日期重算。 // [TOPIC-INNER-SELECT 2026-11-17] v69 → v70：第二十九条【第二题材量比不达标】从「整块作废 + 从全市场挑 1 只」改成【在该题材内按十日涨幅前十 + 首次/二次在列、按档位名额选票】；名额不足只选现有不补位；十日前十没有该题材的票（或都不是首次/二次在列）⇒ 【灰块】（块保留 + 整块灰化 + 不开新仓），旧的全局十日涨幅候补块在灰块时保留并存。**选股结论变了** ⇒ TVRB_RULES_VERSION 19 → 20（历史日重算）。⛔ 改名是唯一能强制 cache-miss 的手段。 // [R10-YIZI-REPEAL 2026-11-16] v68 → v69：第二十九条「候补一字 ⇒ 空仓不替补」旧分支废除，改【照选 + 挂「竞价一字涨停 · 等下杀买」】；两枚一字标签（等开板后进 / 等下杀买）合并为一枚；三/二十九 的「或」改成显式路由变量。**选股结论变了** ⇒ TVRB_RULES_VERSION 18 → 19（历史日重算，11-16 那份只有日出东方的存档会被重出成两只）。⛔ 换名是唯一能强制 cache-miss 的手段。上一版 v68 注释见下。 v55 → v56：「距红线」改成【点差 + 股价涨幅】双单位，并保证屏幕上「显示偏离 + 点差 === 阈值」（用户原话：185.5% + 5.2% = 190.7%，还没到 200%）。买点行改印点差短版，长句进 title/面板。纯文案，选股结论零变化（TVRB_RULES_VERSION 仍 15）。v56 → v57：面板「读法」里的换算例改成真实值（新华传媒 10-28 三十日 +178.9% ⇒ 汇率 2.79）。v57 → v58：面板改成【一只票两行】（距红线独占一行 + 自核算式），表头上方加「计算公式」三行 + 真实算例。v58 → v59：[IDX-MOVE] 承认「股价再涨」是同期指数不动下的条件估算，加 β 敏感度与 ±1%/±2% 具体影响、第二行重排（点差挪到自核后并置灰）、接近警示的数值标红。v59 → v60：[ABN-CHECK] 统一由 _windowDisplay 出数，五处逐字相加都对得上。v60 → v61：[IDX-LABEL] 面板顶部加「对应指数是什么」四行板块映射说明，票名后加该行自己的对应指数小标签，悬停说明补指数代码。v61 → v62：[DEV-LAYOUT] 用户手机端「右边文字超出了看板边界」——表格改 table-layout:fixed + 三列定宽、票名列/横排长文案允许折行、两枚 chip 整体换行，纯 CSS 版式修复（⛔ 不用裁切），文案与选股结论零变化。v62 → v63：[DIVERGE-TOPIC] 10-19 新华文轩误选修复 —— sameTopicText 改双向分段交集 + 分歧跟随块补传大类归一 coreRes，同题材（AI应用）票改为排除；【选股结论变了】⇒ TVRB_RULES_VERSION 15 → 16，历史日按新尺子重算。v63 → v64：[TOPIC-OWNER] 10-13 新华文轩被误挂到【大消费】块 —— big/mid 档「同题材 20日涨幅前十」的候选集以前走大类【交集】认亲（新华文轩的「平台经济」⇒大消费，沾边就被抢），改成【按早盘竞价题材 toggle 的唯一归属】闸门（计划层用 rec.topics 摊平 topicOwner 注入 _buildBlock → pickBigTopicTop20，查不到归属才退回旧口径）；【选股结论变了】⇒ TVRB_RULES_VERSION 16 → 17。v64 → v65：[ABN-TRIGGER] 官方偏离值面板给「已达交易所严重异常波动标准」的票打上「首次触发 / 二次触发 / 三次触发」序号标签（逐日复算 10/30 日偏离、连续触发日合并为一次；首次=琥珀、二次以上=实心红），零新增请求、纯显示层 ⇒ 选股结论零变化（TVRB_RULES_VERSION 仍 17）。v65 → v66：[ABN-TRIGGER-2] 用户当场纠正「10-08 首次、10-09 也是首次」—— 「第几次」= 连续第几个触发日（逐日递增，某天明确判出未触发才归零；判不出保持不断链），⛔ 不再按连续区间合并成一次；「累计几次独立触发」移进 title。纯显示层 ⇒ 选股结论零变化（TVRB_RULES_VERSION 仍 17）。
// v66 → v67：[TDAY-FREEZE + T5-TODAY-AUC 2026-11-16 用户报障「今天11月16日……每到收盘又变了，早上还是北纬科技，文投控股，日出东方，现在收盘又变成了我只有日出东方了，之前修过好几次，我都说了按照竞价口径来，收盘后也不能变」] ① 前五榜【今天】改取 9:25 竞价腿（历史日仍取收盘腿）：收盘后今天那一天的 pct 被换成收盘口径 ⇒ 首次上榜 / 切换日 / 新龙判定翻转 ⇒ topicLimit 从 2 掉到 1 ⇒ 买点侧少两个题材；② 当天已定稿 ⇒ 个股题材串（手动导入 / 别的看板同步）再变也不再改今天的票，但规则版本 / 核心词变了仍然立即重算；③ 粘贴导入丢弃表头行（库里实见 stock='股票名称'）；【选股结论变了】⇒ TVRB_RULES_VERSION 17 → 18。⛔ 不换名手机端继续吃 v66 旧 JS。
// v67 → v68：[DEV-WRAP + TDAY-CLOSE-FREEZE 2026-11-16 第二轮] ① 买点行「官方偏离值」徽标在手机端顶出右边框（用户截图「文字都超出右边了」）—— 该徽标原来 nowrap，改成允许内部折行 + max-width:100% + 任意位置可断；同时把「已触发（10日偏离 +178.6%、30日偏离 +223.4%）」缩成「已触发（10日 +178.6% · 30日 +223.4%）」（徽标本身已写「10日偏离」，不再重复）。② 今天已定稿的存档不再因「股票池 / 量比晚到」而重算（唯一例外：当时竞价榜就没就绪 ⇒ 仍自愈）。纯显示层 + 护栏 ⇒ 选股结论零变化（TVRB_RULES_VERSION 仍 18）。
// 上一版 v54：[ABN-DEV-FIX 2026-11-14] v53 → v54：同一批发布的补丁——① 指数腿回看 20 → 70 自然日（20 天只够 14 根腿，官方 30 日偏离要 30 根 ⇒ 面板一个都出不来，11-14 亲测覆盖 0/5）；② 票名→代码的取值顺序加两条退路（买点行自带 p.code / 20日涨幅前十行的 code），`getStockCode` 名册常缺票。不换名手机端继续吃 v53 旧 JS。
// 上一版 v53：[ABN-DEV 2026-11-14] v52 → v53：买点侧对接【交易所官方偏离值】（10日+100% / 30日+200%，已扣对应指数）——买点行多一枚「10日偏离 +72.7% · 还需 +16%」徽标、买点侧上方多一张「官方偏离值」面板（市场前十 + 买点票）。选股结论零变化，但不换名手机端会继续吃 v52 旧 JS，看不到新徽标。
// 上一版 v52：[MID-TOP20 + RULES-BUMP-ALL 2026-11-14] v51 → v52：① mid 档（4~8 只）取票口径改成「同题材 20日涨幅前十最靠前的 1 只 + 竞价一字照选打标签」（10-21 商业航天 7 只：旧「龙三长春一东」变「龙一海洋王·第 9 名·等下杀买」）；② 规则升级后【历史日也重算】（不再冻结历史定稿）。两者都改变屏幕上的结论 ⇒ 必须换名。⛔ 不换名手机端继续吃 v51 旧 JS。
// 上一版 v42：[ABNORMAL-10D + LD-CLOUD 2026-11-13] v41 → v42：v41 上线后又有两批改动进了线上 bundle（第二十五条 NUM-TEXT 文本型数字修复、第三十四条【监管异动 · 十日涨幅 95%/100% 硬上限】），但 CACHE 名一直没换 ⇒ 线上入口早已换成 index-BSmsgxOQ.js，手机端却仍从 v41 缓存里拿【旧 index.html】，旧 HTML 指向旧 JS hash ⇒ 「刷新并没有生效」。⚠️ 换名是唯一一次能强制 cache-miss 的手段（导航 network-first 只有 1.5s，本机每请求停 12~64s 必然回退缓存）。⛔ 以后每次发版都必须同时换这里 + bump TVRB_RULES_VERSION（存档指纹），单换一边用户照样看不到新东西
// 上一版 v39：[NEW-DRAGON-FAMILY-OLD + EBB-LINEAGE-FIRST + LEADER-DIVERGE 2026-11-12] v38 → v39：① 新题材候选【排除正在退潮的老题材】，且平局改成「新面孔多的优先 → 字辈线靠后」——上一版平局按成员数排，东方海洋同属【东方】和【羊字辈】两段时羊字辈(4只)压过东方(3只)，11-12 因此选出光洋股份/阳光照明；现在选【东方】，买点 = 东方海洋（竞价一字 → 挂「竞价一字涨停 · 等下杀买」）+ 大东方；② 退潮题材改锚【字辈线】（羊字辈 2 只），提示板写「羊字辈二次确认退潮」，⛔ 不再是「主线东方」；③ 退潮事件计数改按【同一只总龙 或 同题材线】认周期，题材改名不再把计数清零；④ 第二十五条新增首次/二次分歧口径（高开低走收绿、霸榜总龙一≥3天、二次分歧5日内≥2连板、二次分歧=首次退潮）。
// 上一版 v38：[NEW-DRAGON-FAMILY + TOPIC-LIB-FIRST] 第二十八条改成「新题材 = 字号/字辈题材」+ 题材库优先 + 改题材连历史一起重算 // [NEW-DRAGON-FAMILY + TOPIC-LIB-FIRST 2026-11-12] v37 → v38：① 第二十八条改成【新题材 = 字号/字辈题材】：当日 20日涨幅（9:25 竞价口径）前十按题材段分组，同题材 ≥2 只且含「新面孔」即为新题材；老龙换题材（双重属性）可入选并再补一只该题材的新面孔（11-12 = 东方海洋作认证 + 买大东方）；② 题材认亲改成【题材库优先】（用户手动改的题材说了算，历史 note 只作兜底）；③ 退潮「主线题材」支持字号/字辈题材 ≥2 只互相验证（11-10 羊字辈/东方系），行业题材仍 ≥3；④ 选股存档指纹新增「题材库内容指纹」——用户改题材后【连历史日期一起重算】。旧 v37 bundle 会按「工业4.0」选出福莱新材，并用当日 note 覆盖你手动整理的题材。⛔ 不升版本手机端会一直吃 v37 旧 JS
// 上一版 v37：卖点侧空态三态 + 认证龙（同题材择优 · 前五）
// 上一版 v36 [SELL-AUTO 2026-11-12]：卖点侧成员从「只认昨日『买入』标签」扩为「昨日买点侧自动继承 ∪ 手动买入 ∪ 手动持有，昨日『卖出』否决」——用户早上按买点侧买进去，次日不用再逐只补打标签。旧 v35 bundle 仍要求手动打标签，卖点侧会缺票。
// 上一版 v35 [SELL-LIVE 2026-11-12]：定稿冻结从「整份 plan」收窄为「只冻结买点选股结论」——卖点段（成员 = 用户昨天打的「买」标签，随时可补打）与分笔装饰（异步抓取）改为恒取实时。旧 v34 bundle 会把 09:28 定稿存档原样上屏 ⇒ 之后在历史日补打的买入标签永远进不了卖点列表、分笔永远显示「未抓取」。
// 上一版 v34 [BOARD-AUC-MEMBERS-2 2026-11-11]：v33 只在「首次进入就按 close 口径算」时生效——本模块开头有一条会话缓存早退 `if (_cache.has(date)) return`，而竞价口径成员榜是在精算段**末尾**才算的 ⇒ 只要这一天先前算过一次（切 20日 toggle / 切日期回来），就永远走不到那段 ⇒ 盘后仍回落收盘口径、青岛食品仍不显示（「有时显示有时不显示」比不修更难查）。本版新增 `_boardTried` 集合 + 早退判据 `_needBoard`，保证盘后最多多跑一次（§32）。⛔ 不升版本手机端会一直吃 v33 旧 JS
// 上一版 v30 [TVRB-PLAN-SNAPSHOT]：题材量比【选股结论按日落库】。旧 v29 bundle 的结论只在内存 _buyPublished ⇒ 切日期解冻重算，且历史日门控跳过竞价口径榜 ⇒ 早盘那份结论被中间态冻结覆盖（「历史日期复盘冰山冷热又搞失踪」）。
// 上一版 v29 [DDL-LEG]：stock_range20_pct 主键升级 (date,stock,leg) 后改为「byLeg 两腿并存 + 按口径取行 + upsert 冲突键带 leg」；旧 v28 bundle 写两列 on_conflict ⇒ 400/42P10 ⇒ 当天结果表 0 行、前端退回浏览器现算 40+ 次 K 线（出结果慢）。
// ★★ [BOOT-SW-NAVFAST 2026-10-31] 从 4000 收到 1500。
//   原因（实测）：这台机器的网络特征是「每个请求固定停顿 12~64 秒」（3.7KB 的 sw.js 要 64s），
//   装好 SW 之后每次打开仍然要等「导航请求」这一次停顿 ⇒ 就是这 4 秒在拖。
//   改成 1.5s：网络正常时照样拿最新 HTML（通常 <0.3s），网络卡时 1.5s 就回退本地缓存。
//   ⚠️ 超时后那条网络请求【不会取消】，它的响应会被写回缓存并触发「发现新版本」提示
//      —— 这一点在 v1 里是**坏的**（响应被丢弃，缓存永不更新），2026-11-01 已修，
//      见下方 fetch 处理器 ② 段的注释。⛔ 别再把「后台请求」的 .then 挂到 Promise.race 上。
var NAV_TIMEOUT_MS = 1500;

self.addEventListener('install', function () {
  // 新版立即待命，不等旧页面全部关闭（否则用户要开两次才生效）
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (k) { return k.indexOf('biga-') === 0 && k !== CACHE; })
            .map(function (k) { return caches.delete(k); })
      );
    }).then(function () { return self.clients.claim(); }).then(function () {
      return prefetchShell();
    })
  );
});

/* ★★ [SW-STALE-FIX 2026-11-01] 激活即把【当前线上 HTML】写进新缓存。
 * 为什么必须做（这是「一次就能到新版」的关键）：
 *   换 cache 名之后新缓存是空的，而页面导航是「network-first + 1.5 秒超时回退缓存」。
 *   在「每个请求停顿 12~64 秒」的网络下，超时必然发生 ⇒ 回退时缓存是空的 ⇒ 只能再等一次网络。
 *   激活时先把 HTML 抓好放进缓存，则**下一次打开就直接命中新 HTML** ⇒ 用户不必开两三次。
 * ⛔ 只抓外壳 HTML（同源、无业务数据）；失败一律吞掉（不影响任何功能）。 */
function prefetchShell() {
  try {
    var u = new URL(self.registration.scope);
    var key = new Request(u.origin + u.pathname);
    return caches.open(CACHE).then(function (cache) {
      return fetch(new Request(key, { cache: 'no-cache' })).then(function (res) {
        if (res && res.ok) return cache.put(key, res.clone());
        return null;
      });
    }).catch(function () { return null; });
  } catch (e) { return Promise.resolve(null); }
}

/* ★★ [BOOT-SW-WARM 2026-10-31] 首次访问的预热入口。
 * 为什么需要：SW 是在 `load` + 空闲时注册的，而首屏 5 个资源**那时已经下载完了** ⇒
 *   fetch 处理器一条都没看到 ⇒ 缓存是空的 ⇒ 「首访之后断网打不开 / 第二次打开也不快」。
 * 页面侧把「本次实际用到的资源 URL」发过来，这里补齐写入 ⇒ 首访当晚就完成预热。
 * ⛔ 全部走 cache.add（命中 HTTP 缓存时不再产生网络流量），失败逐条吞掉（单个资源失败不影响其它）。 */
self.addEventListener('message', function (event) {
  var data = event.data || {};
  if (data.type !== 'WARM' || !Array.isArray(data.urls) || data.urls.length === 0) return;
  var job = caches.open(CACHE).then(function (cache) {
    return Promise.all(data.urls.map(function (u) {
      return cache.add(u).catch(function () { return null; });
    }));
  });
  if (event.waitUntil) event.waitUntil(job);
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (e) { return; }
  // ⛔ 只处理本站静态资源：跨域（Supabase / 同花顺代理）一律不碰，避免缓存业务数据
  if (url.origin !== self.location.origin) return;

  // ① 构建产物（带内容哈希）→ cache-first
  if (url.pathname.indexOf('/assets/') >= 0) {
    event.respondWith(
      caches.open(CACHE).then(function (cache) {
        return cache.match(req).then(function (hit) {
          if (hit) return hit;
          return fetch(req).then(function (res) {
            if (res && res.ok) cache.put(req, res.clone());
            return res;
          });
        });
      })
    );
    return;
  }

  // ② 页面导航（HTML）→ network-first + 超时回退缓存
  if (req.mode === 'navigate') {
    // 缓存键归一化成「origin + pathname」：`autoReloadOnce` 的 `?r=<时间戳>` 每次都不一样，
    // 不归一化就会在缓存里堆出一串只有查询串不同的副本（越用越大，还都匹配不上）。
    var navKey = (function () { try { return new Request(url.origin + url.pathname); } catch (e) { return req; } })();
    event.respondWith(
      caches.open(CACHE).then(function (cache) {
        var timer = 0;
        // ★★★ [SW-STALE-FIX 2026-11-01 用户报障「改了根本没生效」—— 这是一个真 bug，不是网络问题]
        //
        // 旧写法（v1）：
        //   `Promise.race([fetch(req), timeout]).then(res => cache.put(...))`
        //   ⇒ 超时先赢的话，race 直接进 catch 分支，**另一个分支的 `.then` 再也不会执行**
        //   ⇒ 那条「还在路上的网络响应」被【丢弃】，缓存永远是旧 HTML。
        //   而本机网络特征恰恰是「每个请求固定停顿 12~64 秒」（见 NAV_TIMEOUT_MS 注释）
        //   ⇒ 导航**每次都超时 1.5s** ⇒ 每次都吃旧 HTML ⇒ **新版本永远进不来**。
        //   原注释写的「后台那次 fetch 到货后仍会更新缓存」是错的（从未生效），已改掉。
        //
        // 现在：
        //   ① `net` 自己挂 `.then` —— 无论 race 谁赢，响应都一定写进缓存；
        //   ② 写入时对比新旧 HTML：变了 ⇒ 说明线上发版了 ⇒ postMessage 通知页面弹「发现新版本」；
        //   ③ `event.waitUntil(bg)` 保证 SW 在后台这条链跑完之前不被回收。
        //   ⛔ 只写本站 HTML，不碰业务数据（与文件头 ③ 一致）。
        var net = fetch(req);
        var bg = net.then(function (res) {
          if (!res || !res.ok) return null;
          // 克隆必须在任何 await 之前、且赶在页面消费 body 之前 —— bg 在 race 之前注册 ⇒ 先跑
          var copy = null;
          try { copy = res.clone(); } catch (e) { return null; }
          return cache.match(navKey).then(function (old) {
            if (!old) return cache.put(navKey, copy).then(function () { return 'first'; });
            return Promise.all([old.text(), copy.clone().text()]).then(function (pair) {
              var changed = pair[0] !== pair[1];
              return cache.put(navKey, copy).then(function () { return changed ? 'changed' : 'same'; });
            });
          }).catch(function () { return null; });
        }).then(function (state) {
          if (state === 'changed') return notifyNewVersion();
          return null;
        }).catch(function () { return null; });
        if (event.waitUntil) event.waitUntil(bg);

        var timeout = new Promise(function (_, reject) {
          timer = setTimeout(function () { reject(new Error('nav-timeout')); }, NAV_TIMEOUT_MS);
        });
        return Promise.race([net, timeout]).then(function (res) {
          clearTimeout(timer);
          // 网络赢了 ⇒ 页面拿到的就是新 HTML，无需再通知（bg 仍会顺手把缓存更新掉）
          return res;
        }).catch(function () {
          clearTimeout(timer);
          return cache.match(navKey).then(function (hit) {
            // 有缓存就先用缓存（能立刻看见界面，比白屏强）；
            // 若线上已经换版，bg 会在几秒后弹「发现新版本」（见上）
            if (hit) return hit;
            // 没缓存 ⇒ 宁可再等一次网络，也不要白屏
            return fetch(req);
          });
        });
      })
    );
  }
});

/** 通知所有受控页面「线上已发版」（页面侧弹一条可点刷新的小横条，见 index.html） */
function notifyNewVersion() {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    list.forEach(function (c) {
      try { c.postMessage({ type: 'NEW_VERSION' }); } catch (e) {}
    });
  }).catch(function () { return null; });
}
