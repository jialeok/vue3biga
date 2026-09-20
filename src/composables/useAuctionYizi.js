// useAuctionYizi.js — 「竞价一字」看板的 UI 组合式（§14 UI 瘦身：view 只留模板与调用）
//
// 本 composable 是「竞价一字」看板唯一的 UI 侧入口：
//   · 读 logic/yizi/yizi-board.js 的响应式状态（yiziBoardState）；
//   · 把「日期切换 / 看板刷新事件 / Realtime 通知」统一收敛为一次 loadYiziBoard；
//   · 手动粘贴导入题材 → 调 logic 的 importYiziTopicsFromPaste（写共享题材库，三看板互通）。
//
// ⛔ 本文件不含任何业务判定（不判交易日、不选龙头、不解析题材优先级、不算封单额口径、不拼 SortKey）——
//    所有规则都在 logic 层；UI 只负责「展示 + 触发」。
// ✅ 唯一属于 UI 的判断：「9点25」toggle 决定【封单额列显示哪个时点的值 + 是否显示变化量】——
//    两个时点与两者之差的文本逻辑层都已算好，这里只做取值选择，不改任何数据、不触发任何重算/请求。
//    默认关 = 9:20 口径（度量列 `封单额(9:20) · 十日涨幅`）；
//    打开   = 9:25 口径（度量列 `变化(较9:20) · 封单额(9:25)`，并隐藏十日涨幅）。
// ⛔ 不做任何数据兜底：状态为空就渲染空，读失败就渲染失败（§10 读失败 ≠ 空）。

import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useUiStore } from '../stores/uiStore.js';
import { _on, _off } from '../stores/eventBus.js';
import { _dbgLog } from '../data/debug-log.js';
import { showToast, showWarningToast } from './useToast.js';
import {
    yiziBoardState,
    loadYiziBoard,
    isYiziFetchTimeReached,
    importYiziTopicsFromPaste
} from '../logic/yizi/yizi-board.js';
import { filterYiziNoTopicBlocks, isBoardDateAligned } from '../logic/yizi/model.js';
// ★ 趋势面板（2026-09-18 新增）：与「早盘竞价看板」同形的展开趋势图（竞价量/昨日成交量/竞价涨幅/涨幅）。
//   ⚠️ 取数通道【完全独立】：走 Edge Function auction-yizi-fetch 的 /trend 路由 + 竞价一字小号，
//      ⛔ 与早盘竞价看板的 numcat-proxy（主账号）毫无关系，绝不混用（见 logic/yizi/yizi-trend.js 头注）。
//   · loadYiziTrend      = Logic 编排（窗口/会话缓存/单飞/缺口补拉/失败可见）
//       🔴 窗口是【两个数】，且都由 Logic 内部拿捏（本层与 UI ⛔ 不要自己算）：
//          显示 = 近 5 日（YIZI_TREND_WINDOW，与早盘竞价同观感）/ 存储 = 近 10 日（YIZI_TREND_STORE_WINDOW，喂十日涨幅）。
//          所以 state.windowDates / state.rows 恒为 **5 个交易日** 那一段。
//   · yiziTrendState     = 该模块的响应式真相（rows/windowDates/loading/error/note）
//   · buildYiziTrendSeries / trendMetricItems = 纯函数（行 → 四条曲线 / 面板汇总），可单测见 trend-model.test.js
import { loadYiziTrend, yiziTrendState } from '../logic/yizi/yizi-trend.js';
import { buildYiziTrendSeries, trendMetricItems } from '../logic/yizi/trend-model.js';
// ★ 需求 1（§6 单一真相）：题材自动回填只数从 topic-sync 的响应式计数直接读，
//    ⛔ 不再经看板 state 转抄一份（副本会在「本板回填中止、另一板随后补上」时陈旧）。
import { getAutoFilledForDate } from '../logic/topics/topic-sync.js';

export function useAuctionYizi() {
    const uiStore = useUiStore();
    const state = yiziBoardState;

    const expanded = ref(true);
    const importOpen = ref(false);
    const importText = ref('');
    const importSaving = ref(false);
    const importResult = ref('');

    // ===== 「无题材」过滤开关（§34 UI 状态分离：纯展示态，默认关、无记忆）=====
    // 只改「看到哪些行」，不改任何数据、不发请求、不写库。
    // ⛔ 不落 localStorage（§8：localStorage 禁存业务/UI 配置）、不进全局 store（§6 单一真相）；
    //    随日期切换自动归位 false（见文件末尾 watch(currentDate)）→ 天然满足「翻页/切日即重置」。
    const showNoTopic = ref(false);
    // 题材库就绪才可信：未就绪时所有股票都会显示 '-'，此时把「读不到题材」当成「没有题材」
    // 会引导用户去给【已有题材】的股票重复补题材（§10 未就绪 ≠ 空）→ 未就绪时开关不可用。
    const noTopicAvailable = computed(() => state.topicLibraryReady === true);
    const noTopicView = computed(() => showNoTopic.value && noTopicAvailable.value);
    function toggleNoTopic() {
        showNoTopic.value = !showNoTopic.value;
    }

    // ===== 「9点25」封单额时点开关（§34 UI 状态分离：纯展示态，默认关、无记忆）=====
    // ★ 2026-09-18 需求变更（用户原话）：
    //   「把上面那个9点20分的 toggle 改成9点25分的，当我没打开时是9点20分一字板的股票数据，
    //     打开后是9点25分一字板的数据」
    //   语义（与上一版【相反】）：
    //     · 默认【关】→ **9:20 口径**：度量列 = `封单额(9:20) · 十日涨幅`（与原先形态一致）
    //     · 打开     → **9:25 口径**：度量列 = `变化量 · 封单额(9:25)`，
    //                  且**隐藏十日涨幅**（用户指定），行内时点标随之显示 9:25
    //   两个时点的值 + 两者之差在 Logic 层都已算好（row.seal920Text / seal925Text / sealDeltaText），
    //   因此切 toggle 只换显示值：⛔ 不重算分块、不重选龙头、不发请求、不写库。
    //   ⚠️ 判据与股票池不变（仍是同一批一字股）——「变化量」正是建立在同一批票的两个时点上。
    const show925 = ref(false);
    /**
     * 当前生效的封单额时点（供表头与行内「时点标」显示）。
     * ★ 用户明确要求行内那个位置显示的是【当前时点】而不是首封时刻：
     *   「9:25分对应的竞价时间点（现在打开只显示9:15分，没打开9点25toggle时应该显示的是9:20）」
     */
    const sealPointLabel = computed(() => (show925.value ? '9:25' : '9:20'));
    /** 行内时点标（股票名后面那一格）—— 与表头同源，保证两处永远一致 */
    const pointTagText = computed(() => (show925.value ? '9:25' : '9:20'));
    /**
     * 度量列表头：未打开 = `封单额(9:20) · 十日涨幅`；打开 = `变化(较9:20) · 封单额(9:25)`。
     * ⛔ 时点只在「表头 + 行内标」两处呈现，开关旁不再重复写时点（.yizi-point-hint 已删）。
     */
    const metricHeadText = computed(() => (show925.value
        ? '变化(较9:20) · 封单额(9:25)'
        : '封单额(9:20) · 十日涨幅'));
    function toggle925() {
        show925.value = !show925.value;
    }

    const currentDate = computed(() => uiStore.currentDate);
    const toggleArrow = computed(() => (expanded.value ? '▲' : '▼'));

    // ===== §26 日期切换：状态必须「属于当前选中日」才可渲染 =====
    // 切换日期后新日期的云端读取需要时间。在这个窗口里 state.blocks/count 仍是上一天的内容
    // （编排层只在加载成功后才整体改写），而页头日期已经变了 —— 此时按 count>0 渲染，
    // 就会把【上一天的一字池】当成【这一天的一字池】展示（实测出现「页头 09-14、正文 09-17 的 129 只」）。
    // 因此：日期不对齐 ⇒ 一律按「还没准备好」处理（显示加载中），⛔ 绝不显示另一天的行。
    // 注意这不是 §10 的「读取失败当空」：读失败仍走 state.error 分支并原样抛错。
    const stateDateAligned = computed(() => isBoardDateAligned(state.date, currentDate.value));
    const hasAnyData = computed(() => state.count > 0 && stateDateAligned.value);

    const summaryText = computed(() => {
        if (state.error && !hasAnyData.value) return '加载失败';
        // 日期未对齐 = 这一天的数据还没到（与「这一天没有」是两回事，不能写成暂无数据）
        if (!hasAnyData.value) return (state.loading || !stateDateAligned.value) ? '加载中…' : '暂无数据';
        return '一字 ' + state.count + ' 只';
    });

    // 当日尚未到 9:25 抓取时刻 → 明确告知用户「等待自动抓取」，而不是让人误以为没数据
    const fetchTimeHint = computed(() => {
        const d = currentDate.value;
        if (!d || hasAnyData.value || state.error) return '';
        // 日期还没对齐 = 这一天的数据尚在加载，不适用「等 9:25」提示
        if (!stateDateAligned.value) return '';
        return isYiziFetchTimeReached(d) ? '' : '当日一字数据将在 9:25 自动抓取';
    });

    // 加载中的文案：把「在等什么」说清楚 —— 首次打开要用同花顺 K 线补算几十只票的十日涨幅，
    // 没有阶段反馈时用户会以为看板卡死（这是「打不到数据」与「在加载」被混淆的常见成因）。
    const loadingHint = computed(() => {
        if (state.phase === 'range') return '加载中…（正在补算十日涨幅，首次稍慢）';
        if (state.phase === 'group') return '加载中…（正在按题材分组）';
        return '加载中…';
    });

    // 空态文案（唯一的空态出口）：区分「正在加载这一天」/「等到 9:25」/「这一天确实没有」
    const emptyText = computed(() => {
        if (state.loading || !stateDateAligned.value) return loadingHint.value;
        return fetchTimeHint.value || '暂无竞价一字数据';
    });

    // 题材来源提示（可解释性）：只在「有票靠库兜底」或「完全没题材」时才提示 —— 这两种情况
    // 正是用户需要动手补题材的信号；接口自带题材正常时不打扰。
    const themeHints = computed(() => {
        if (!hasAnyData.value) return [];
        const out = [];
        if (state.themeNone > 0) out.push('有 ' + state.themeNone + ' 只暂无题材（开「无题材」可筛出来，截图后手动导入）');
        if (state.themeFromLib > 0) out.push('其中 ' + state.themeFromLib + ' 只题材取自共享题材库（接口未返回题材）');
        return out;
    });

    // ★ 2026-09-18 需求 1：题材自动回填提示。
    // 本看板的接口自带题材（开盘啦/选股宝），加载时会「只补空缺」地把它们写进共享题材库，
    // 于是「涨跌停」「早盘竞价」两个看板不需要再手动粘贴导入。
    // 只在真的补了才提示（=0 时静默）—— 这是「可解释性」，不是状态。
    // ⚠️ 只数取 state.date（= 当前**已发布**的那一天，与屏上行数据同一天），从 topic-sync
    //    读（响应式单一真相）→ 另一个看板先补上时本板也会立刻显示，与「谁先加载」无关。
    const topicAutoFillHint = computed(() => {
        if (!hasAnyData.value) return '';
        const n = getAutoFilledForDate(state.date) || 0;
        if (n <= 0) return '';
        return '已自动为 ' + n + ' 只股票补全题材（取自一字接口 → 写入共享题材库，三个看板共享；只补空缺、不覆盖已有题材）';
    });

    // 十日涨幅覆盖提示：覆盖不全时，块内排序/龙头判据会受影响 → 必须如实告知（⛔ 不假装完整）
    const rangeHint = computed(() => {
        if (!hasAnyData.value) return '';
        if (!state.rangeReady) return '';
        if (state.rangeCovered < state.count) {
            return '十日涨幅覆盖 ' + state.rangeCovered + '/' + state.count + ' 只（缺失的票不参与龙头评选）';
        }
        return '';
    });

    // ST 剔除提示：剔除是「看板口径」，但用户必须知道剔了几只，
    // 否则会把「今天一字很少」误读成行情弱（实际上是自己要求不看 ST）。
    const stHint = computed(() => {
        if (!state.stRemoved) return '';
        return '已按设置剔除 ' + state.stRemoved + ' 只 ST 股票';
    });

    // 一字口径剔除提示（★ 2026-09-15 新增）。
    // 「竞价一字」的判据 = 9:25 竞价涨幅 ≈ 涨停幅度（= 用户说的「一字就是涨停」）。
    // 表里若有旧判据留下的非一字行（9:20 前挂过涨停价买单又撤掉），这里会被剔除 —— 
    // ⛔ 必须把只数说出来：否则用户只会看到「今天只有 8 只」，却无从知道另外 113 行为什么不见了。
    const yiziFilterHint = computed(() => {
        if (!state.yiziRemoved) return '';
        const noPct = state.yiziRemovedNoPct || 0;
        const notLimit = state.yiziRemoved - noPct;
        return '已按「一字 = 竞价涨幅达涨停幅度」口径剔除 ' + state.yiziRemoved + ' 只非一字' +
            (notLimit > 0 ? '（其中 ' + notLimit + ' 只竞价涨幅未达涨停幅度）' : '') +
            (noPct > 0 ? '（其中 ' + noPct + ' 只缺竞价涨幅、无法判定）' : '');
    });

    // 分屏结构：一字池只有一块 —— 用与涨跌停看板同形的 sections 数组承载，
    // 使两个看板的模板结构一致（后续要给一字池再分档时不必改模板）。
    // 「无题材」开关打开时，仅对分块行做一次过滤（filterYiziNoTopicBlocks 为纯函数，不改 state）：
    // 总数（count）保持「当日真实一字只数」不变 —— 那是关于这一天的事实，不随视图变。
    // 过滤后一行都不剩时，用 emptyText 如实说明「一字池股票都有题材」（而不是伪装成「当日无一字」）。
    const sections = computed(() => {
        const filtering = noTopicView.value;
        const shown = filtering ? filterYiziNoTopicBlocks(state.blocks) : state.blocks;
        return [{
            key: 'yizi',
            title: '一字板',
            count: state.count,
            blocks: shown,
            emptyText: filtering && shown.length === 0 ? '一字池股票均有题材' : ''
        }];
    });

    function toggleExpand() {
        expanded.value = !expanded.value;
        if (expanded.value) refresh();
    }

    function refresh() {
        const d = currentDate.value;
        if (!d) return;
        loadYiziBoard(d, { force: true }).catch(function(e) {
            showWarningToast('竞价一字加载失败：' + (e && e.message || e));
        });
    }

    function openImport() {
        importResult.value = '';
        importOpen.value = true;
    }

    async function doImport() {
        const text = importText.value;
        if (!text || !text.trim()) {
            showWarningToast('请先粘贴「股票 + 题材」数据');
            return;
        }
        importSaving.value = true;
        importResult.value = '';
        try {
            const res = await importYiziTopicsFromPaste(text);
            importResult.value = res.message;
            if (res.ok) {
                showToast('✅ ' + res.message);
                importText.value = '';
            } else {
                showWarningToast('❌ ' + res.message);
            }
        } catch (e) {
            const msg = '导入失败：' + (e && e.message || e);
            importResult.value = msg;
            showWarningToast('❌ ' + msg);
        } finally {
            importSaving.value = false;
        }
    }

    // ===== 展示辅助（全部转发 logic 纯函数 / 读 logic 已算好的字段，UI 不自造口径）=====
    /** 封单额展示文本：按「9点20」toggle 在当前时点的值；无值显示 '-' 而不是空白，便于对齐阅读 */
    function sealText(row) {
        if (!row) return '-';
        const t = show925.value ? row.seal925Text : row.seal920Text;
        return t || '-';
    }
    /** 封单额强弱分档的样式类（同样按时点切换） */
    function sealClass(row) {
        if (!row) return 'yizi-seal-flat';
        const tone = show925.value ? row.seal925Tone : row.seal920Tone;
        return 'yizi-seal-' + (tone || 'flat');
    }
    /**
     * 封单额【变化量】文本（9:25 − 9:20）。★ 只在「打开 9点25」态展示。
     * 两档缺一 → Logic 层给空串 → 这里出 '-'（§10：算不出来就不编，绝不补 0）。
     */
    function sealDeltaText(row) {
        if (!row) return '-';
        return row.sealDeltaText || '-';
    }
    /** 变化量色调（★ 中国习惯：增加红 / 减少绿 / 0 与无值灰） */
    function sealDeltaClass(row) {
        return 'yizi-delta-' + ((row && row.sealDeltaTone) || 'flat');
    }
    /** 封单额列的 tooltip：把口径讲清楚（哪个时点、证据强度、首封时刻） */
    function sealTitle(row) {
        if (!row) return '';
        const point = show925.value ? '9:25' : '9:20';
        const cnt = row.faCount ? ('；竞价期间封在涨停价的时点共 ' + row.faCount + ' 个') : '';
        const first = row.faFirst ? ('；首次封上涨停价 ' + row.faFirst) : '';
        return point + ' 口径封单额（= 该时点的 ' + (show925.value ? 'fa_0925l 末笔' : 'fa_0920f 首笔') +
            '；无该字段时回退到该时点前最后一笔）' + cnt + first;
    }
    /** 变化量列的 tooltip：把方向含义讲清楚（加单 = 抢筹，撤单 = 心虚） */
    function sealDeltaTitle(row) {
        if (!row) return '';
        const d = row.sealDelta;
        if (d === null || d === undefined || !isFinite(d)) return '9:20 与 9:25 有一档缺值，无法计算变化量';
        if (d > 0) return '9:20 → 9:25 封单额【增加】（这 5 分钟不可撤单，加单 = 抢筹坚决）';
        if (d < 0) return '9:20 → 9:25 封单额【减少】（这 5 分钟不可撤单，撤单 = 次日易开板）';
        return '9:20 与 9:25 封单额一致';
    }
    function rangeText(row) {
        return (row && row.rangeText) || '-';
    }
    function rangeClass(row) {
        return 'yizi-range-' + ((row && row.rangeTone) || 'flat');
    }
    // 连板（首板/二板/三板…）行内小标文案：无值返回空串（模板据空串决定不渲染该标，绝不显示 '-' 占位）
    function continueText(row) {
        return (row && row.continueText) || '';
    }
    // 首封时刻（09:15）：⚠️ 2026-09-18 起【不再占行内位置】—— 用户要求那一格显示「当前时点」，
    // 首封时刻降级为悬停提示（已由 sealTitle 拼进 title）。无值返回空串 → 提示里自然不出现。
    function firstTimeText(row) {
        return (row && row.firstTimeText) || '';
    }

    // ===== 个股趋势面板（★ 2026-09-18 新增：与「早盘竞价看板」同形的展开趋势图）=====
    // 需求原话：「我想添加趋势图和早盘竞价看板一样，点击可以展开，有竞价量，昨日成交量，
    //          竞价涨幅，涨幅，还有十日涨幅。注意这是独立的，用的是竞价一字看板那个小号的猫抓数据接口。」
    //
    // 交互：点行首序号（.yizi-seq）展开/收起该股的 4 张趋势图；「十日涨幅」不走趋势通道，
    //      直接在面板顶部显示该行的当前值（rangeText，与行内度量列同源）。
    //
    // §34 UI 状态分离：展开态是本组件内的 ref（Set<股票名>），
    //   ⛔ 不落 localStorage（§8）、不进全局 store（§6）、不进 Logic 的响应式状态；
    //   随日期切换自动归位（见文件末尾 watch(currentDate)）→ 天然满足「切日即重置」。
    // §22 懒加载：只在**第一次展开**时才去取（额度只有 10 次/天，绝不能看板一打开就无条件补拉）。
    const trendExpanded = ref(new Set());
    const trendExpandedCount = computed(() => trendExpanded.value.size);
    // §26 日期对齐：趋势行也必须属于「当前选中的那一天」才可渲染 ——
    //   否则切日期后新数据还没回来时，会把上一天的曲线画在这一天的面板上。
    const trendDateAligned = computed(() => isBoardDateAligned(yiziTrendState.date, currentDate.value));
    /**
     * 股票名 → 四条曲线（纯函数 buildYiziTrendSeries 的结果）。
     * ⚠️ 池内**每只**股票都会有一个条目（哪怕一条数据都没有 = 全 null），
     *    这样模板里 trendMap[name] 恒存在，面板不必到处判空。
     */
    const trendMap = computed(() => {
        const out = {};
        const names = {};
        (yiziTrendState.rows || []).forEach(function(r) { if (r && r.stock) names[r.stock] = true; });
        (state.blocks || []).forEach(function(b) {
            (b.stocks || []).forEach(function(s) { if (s && s.stock) names[s.stock] = true; });
        });
        if (!trendDateAligned.value) return out;
        Object.keys(names).forEach(function(n) {
            out[n] = buildYiziTrendSeries(yiziTrendState.rows, yiziTrendState.windowDates, n);
        });
        return out;
    });
    /** 面板顶部汇总（与曲线同源；无数据时为空数组 → 模板不渲染该行） */
    function trendMetrics(stockName) {
        const s = trendMap.value[String(stockName || '').trim()];
        return s ? trendMetricItems(s) : [];
    }
    /** 该腿是否有任一点 → 决定是否渲染那张图（全是 -- 的图是纯噪声） */
    function trendHasLeg(stockName, leg) {
        const s = trendMap.value[String(stockName || '').trim()];
        if (!s || !s[leg]) return false;
        return s[leg].some(function(p) { return p.value !== null; });
    }
    /** 这只股票近 5 日（显示窗口）一条数据都没有（面板里改为显示一句说明，而不是 4 张空图） */
    function trendEmpty(stockName) {
        return !trendHasLeg(stockName, 'volume') && !trendHasLeg(stockName, 'yestVolume') &&
            !trendHasLeg(stockName, 'aucPctChg') && !trendHasLeg(stockName, 'changePct');
    }
    const trendLoading = computed(() => yiziTrendState.loading);
    /**
     * 板级提示（唯一出口）：接口失败 → 红字警告；有说明（缓存已齐/保护窗口/某腿失败）→ 灰底说明。
     * ⛔ 不在每行面板里重复打印（同一句话在 8 个面板里出现 8 次 = 噪声）。
     */
    const trendErrorText = computed(() => {
        if (!yiziTrendState.error) return '';
        return '趋势：' + yiziTrendState.error;
    });
    const trendNoteText = computed(() => {
        if (yiziTrendState.error) return '';
        if (trendExpandedCount.value === 0) return '';
        return yiziTrendState.note ? ('趋势：' + yiziTrendState.note) : '';
    });

    /**
     * 展开 / 收起某只股票的趋势面板（点序号触发）。
     * 展开时按需懒加载这一天的趋势（Logic 内部有会话缓存 + 单飞，重复展开不会重复打接口）。
     */
    function toggleYiziTrend(stockName) {
        const name = String(stockName || '').trim();
        if (!name) return;
        const set = new Set(trendExpanded.value);
        if (set.has(name)) {
            set.delete(name);
            trendExpanded.value = set;
            return;
        }
        set.add(name);
        trendExpanded.value = set;
        const d = currentDate.value;
        if (!d) return;
        // 已经为这一天拿过（且没出错）→ 不必再打接口：
        //   Logic 的 loadYiziTrend 自己也会命中会话缓存，这里只是省掉一次无谓的 await。
        if (yiziTrendState.date === d && !yiziTrendState.error) return;
        // 🔴 2026-09-20：把手上的【本日看板池】一并交给 Logic。
        //    用途 = 缺口判据 (b)：池里有股票在**整个存储窗口**一行都没有 ⇒ 它从来没被补过
        //    （历史日期的池子就是这么空心的）⇒ 这时才去调 /trend 用**本看板小号**补历史。
        //    ⚠️ 只传名字，不发请求；真正打上游的仍是 Edge（五道额度闸门在那里）。
        //    ⛔ 不要改成「每次展开都调接口」——那些停牌 / 上游无数据的日子补不出来，
        //       白烧额度（小号只有 10 次/天，9:25 自动抓取优先）。
        const poolNames = [];
        (state.blocks || []).forEach(function(b) {
            (b.stocks || []).forEach(function(s) {
                if (s && s.stock) poolNames.push(String(s.stock).trim());
            });
        });
        loadYiziTrend(d, { stocks: poolNames }).catch(function(e) {
            // Logic 内部已把失败写进 yiziTrendState.error（§10 可见）；这里只兜未预期的异常。
            _dbgLog('[AUCTION-YIZI] 趋势加载异常: ' + (e && e.message || e));
        });
    }

    function onRealtimeUpdate(payload) {
        if (!payload || !payload.boards || payload.boards === 'all' || payload.boards === 'yizi') refresh();
    }

    onMounted(() => {
        refresh();
        _on('yizi-refresh', refresh);
        _on('data:realtime-update', onRealtimeUpdate);
    });
    onUnmounted(() => {
        _off('yizi-refresh', refresh);
        _off('data:realtime-update', onRealtimeUpdate);
    });

    // §6 单源：日期切换一律由 uiStore.currentDate 驱动（不额外维护本地日期副本）
    // 两个 toggle 都随日期切换归位（无记忆）—— 新的一天是全新的一池股票，旧筛选/时点态会误导。
    // ★ 趋势展开态同理归位：切日期后池子整体换人，上一池展开的那几只在这里已不存在，
    //   留着只会让「下一池刚好同名」的票莫名展开（§34 纯展示态，随日期重置，无记忆）。
    watch(currentDate, function() {
        showNoTopic.value = false;
        show925.value = false;
        trendExpanded.value = new Set();
        refresh();
    });

    return {
        state,
        expanded,
        toggleArrow,
        hasAnyData,
        summaryText,
        fetchTimeHint,
        emptyText,
        themeHints,
        topicAutoFillHint,
        rangeHint,
        stHint,
        yiziFilterHint,
        sections,
        noTopicAvailable,
        noTopicView,
        toggleNoTopic,
        show925,
        sealPointLabel,
        pointTagText,
        metricHeadText,
        toggle925,
        importOpen,
        importText,
        importSaving,
        importResult,
        toggleExpand,
        refresh,
        openImport,
        doImport,
        sealText,
        sealClass,
        sealTitle,
        sealDeltaText,
        sealDeltaClass,
        sealDeltaTitle,
        rangeText,
        rangeClass,
        continueText,
        firstTimeText,
        // ===== 趋势面板（★ 2026-09-18 新增）=====
        trendExpanded,
        trendMap,
        trendLoading,
        trendErrorText,
        trendNoteText,
        trendMetrics,
        trendHasLeg,
        trendEmpty,
        toggleYiziTrend
    };
}
