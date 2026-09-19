// model.js — 「竞价一字」看板的纯函数模型层（Logic 纯函数叶子，§15 独立业务模块）
//
// 只做「数据 → 展示结构」的纯变换：不读 state、不发请求、不碰 DOM、不写库。
// 由 logic/yizi/yizi-board.js（编排层）把数据准备好后调用，单测见 model.test.js。
//
// 【本文件与「涨跌停」看板的关系】
//   「按题材分块 / 组序 / 块内排序 / 选龙头 / 序号 / 题材展示与『无题材』判据 / 粘贴解析 / 封单额格式化」
//   这套规则两个看板【完全一样】，已抽到共享核心 logic/topics/topic-block.js（§6 单一真相）。
//   本文件只保留【竞价一字看板特有】的东西：
//     · 一字口径闸门（「竞价涨幅 ≈ 涨停幅度」，见下方第三节。★ 2026-09-15 修正）
//     · 封单额的【时点口径】（9:20 / 9:25 两档，见下方第二节）
//     · 题材来源优先级解析（接口自带 开盘啦 → 选股宝 → 共享题材库 → 无）
//     · ST 剔除判据
//   块内排序度量与「涨跌停」看板一致 = 十日涨幅（rangePct），由编排层把值挂到行上后透传。
//   ⛔ 不要在这里重新实现分块逻辑。
//
// 复用自既有的单一真相（⛔ 不许在这里另造一套）：
//   · 组序     = topic-sort.js#sortByTopicGroups（与早盘竞价第一页「题材 toggle」同一套组序规则）
//   · 题材判据 = topic-sort.js#getStockTopicArr / getStockTopicsDisplay（与竞价看板题材单元格同口径）
//   · 题材合法 = note/helpers.js#isValidTopic（剔掉「题材33」/纯数字/单字）
//   · 十日涨幅 = auction/range-display.js#formatRangePct / rangeTone（与涨跌停看板同口径）

import {
    OTHER_TOPIC,
    buildTopicBlocks as buildTopicBlocksCore,
    filterNoTopicBlocks as filterNoTopicBlocksCore,
    parseTopicPaste,
    formatSealMoney
} from '../topics/topic-block.js';
import { formatRangePct, rangeTone } from '../auction/range-display.js';
// 🔴 窗口长度必须来自单一真相（range-window.js），⛔ 绝不在这里写死 10：
//    它是「排名资格（rankMinDays）」与「满窗判定（NO-PARTIAL-WRITE）」共用的同一个数。
import { RANGE_WINDOW_DAYS } from '../auction/range-window.js';
import { isValidTopic } from '../note/helpers.js';
// ★ 一字判据的【唯一真相】：与「早盘竞价看板」的竞价一字红线标记同一份实现
//   （logic/auction/limit-up.js#isAuctionYiZi + getLimitUpPct + parseAucPct）
//   ⛔ 绝不在这里另造一份「竞价涨幅 ≈ 涨停幅度」的判定或另抄一张限幅表。
import { isAuctionYiZi, getLimitUpPct, parseAucPct } from '../auction/limit-up.js';

// 共享核心的直通导出（签名与语义都在共享模块里定义）
export { OTHER_TOPIC, parseTopicPaste, formatSealMoney };

// ============================================================================
// 一、题材来源优先级（竞价一字特有）
// ============================================================================

/**
 * 把一段上游题材文本切成「合法题材数组」。
 *
 * 上游猫抓 daily_auc_fd 的两个题材字段都是【一段文本】（形如 `机器人、人工智能`），
 * 不是数组 → 这里按项目既有的分隔符口径切开，并逐条过 isValidTopic。
 * ⚠️ 分隔符集合与 note/helpers.js#cleanTopicsForDisplay / topic-sort.js 保持一致（多一个 `|` 兜底），
 *    避免同一个题材串在不同路径被切出不同结果。
 *
 * @param {string} raw
 * @returns {string[]}
 */
export function splitThemeText(raw) {
    if (!raw) return [];
    return String(raw)
        .split(/[，、,;；|]/)
        .map(function(t) { return t.trim(); })
        .filter(isValidTopic);
}

/**
 * 解析一只股票最终采用的题材文本（★ 用户指定口径）。
 *
 * 优先级（上一级有题材就不再往下取）：
 *   ① `theme_names_kpl` 开盘啦题材 —— 接口自带，主来源
 *   ② `theme_names_xgb` 选股宝题材 —— 接口自带，次来源
 *   ③ 共享题材库 `stock_topics` —— 手动导入的题材（与涨跌停看板 / 早盘竞价看板同一个库）
 *   ④ 都没有 → `''`（UI 会显示 '-'，并可用「无题材」开关过滤出来统一补）
 *
 * 返回 source 是为了「可解释」：界面上能看出这条题材到底是接口给的还是库里来的，
 * 排查「为什么这只票题材不对」时不必再猜。
 *
 * @param {object} row 库行（含 themeKpl / themeXgb）
 * @param {string} libraryTopics 共享题材库里该股票的题材文本（调用方预取，避免本模块碰数据层）
 * @returns {{text:string, source:'kpl'|'xgb'|'lib'|''}}
 */
export function resolveYiziTopics(row, libraryTopics) {
    const kpl = splitThemeText(row && row.themeKpl);
    if (kpl.length > 0) return { text: kpl.join(','), source: 'kpl' };
    const xgb = splitThemeText(row && row.themeXgb);
    if (xgb.length > 0) return { text: xgb.join(','), source: 'xgb' };
    const lib = splitThemeText(libraryTopics);
    if (lib.length > 0) return { text: lib.join(','), source: 'lib' };
    return { text: '', source: '' };
}

/** 题材来源的展示标签（用于行内小字提示「这条题材哪来的」） */
export function themeSourceLabel(source) {
    if (source === 'kpl') return '开盘啦';
    if (source === 'xgb') return '选股宝';
    if (source === 'lib') return '题材库';
    return '';
}

// ============================================================================
// 二、封单额的两个时点口径（★ 用户指定：只看 9:20 与 9:25，不要 9:15）
// ============================================================================
//
// ★★★ 2026-09-15 重要更正（先读，上一版注释是错的）★★★
//   上一版注释写着「实测 09-18 的 121 只一字票里 fa_0925l 非空仅 8 只、fa_0920f 非空 15 只，
//   绝大多数一字板的封单在 9:15 就定住了」—— **那是基于污染池得出的错误结论**。
//   那 121 行里绝大多数根本不是一字板（见下方第三节：真一字只有 8 只），它们只在 9:15
//   挂过一笔涨停价买单（9:20 前可撤单）后被撤掉，所以只有 fa_0915 有值。
//
//   修正判据后重新核过 09-18 的 **8 只真一字**：
//     · 13 个 fa_* 列 **全部非空**（fa_0915…fa_0925l 逐笔齐备）；
//     · **8/8 只的 9:20 口径 ≠ 9:25 口径** —— 切 toggle 有可见变化。
//   也就是说：**判据一修，用户原本要的 `fa_0920f`（9:20 后首笔）与 `fa_0925l`（9:25 后末笔）
//   就都是字面取到了**，不需要任何替代口径。
//
//   本模块仍然保留「截至该时点的最后一笔非空」这个取值规则，理由有两条：
//     ① 当 fa_0920f / fa_0925l 有值时，它取到的**就是** fa_0920f / fa_0925l（见下方 TAIL_RANK
//        的优先级：同刻 `无后缀` < `f` < `l`，因此 9:20 位最后落在 f、9:25 位最后落在 l）；
//     ② 万一上游某天没生成这两个后缀列（或该股在该时点无匹配成交），它会**优雅回退**到最近一笔，
//        而不是把整列渲染成 '-'。⛔ 绝不用 0 顶替「没有这个数据」。
//
//   顺带满足用户「9:15 的那个数据不要」：fa_0915 不再作为独立展示时点，
//   只在「截至 9:20」的序列里当最后兜底（9:20 之前没再成交的票，其 9:20 值才是 9:15 那笔）。

/** 9:20 时点（含 fa_0920f = 9:20 后首笔）—— ★ 2026-09-18 起 = toggle【未打开】时的默认口径 */
export const SEAL_920 = '09:20';
/** 9:25 时点（含 fa_0925l = 9:25 后末笔）—— ★ 2026-09-18 起 = toggle【打开】时的口径 */
export const SEAL_925 = '09:25';

// ★ 2026-09-18 需求变更（用户原话）：
//   「把上面那个9点20分的 toggle 改成9点25分的，当我没打开时是9点20分一字板的股票数据，
//     打开后是9点25分一字板的数据」
//   ⇒ 与上一版【相反】：上一版默认关 = 9:25；现在 **默认关 = 9:20**、**打开 = 9:25**。
//
//   ⚠️ 只翻「默认态」与「显示格式」，【判据与股票池完全不变】：
//     一字判据仍是「9:25 竞价涨幅达涨停幅度」（第三节），池子仍是同一批票。
//     两个时点看的是**同一批一字股**在两个时刻的封单额 —— 只有这样，
//     「9:25 对比 9:20 的变化量」才有意义（不同股票集合之间谈不上「变化」）。

/**
 * 解析一个 fa_* 列名 → 时刻 + 后缀。
 *   `fa_0920`  → { time:'09:20', tail:'' }   该时点【前】最后一笔
 *   `fa_0920f` → { time:'09:20', tail:'f' }  该时点【后】第一笔
 *   `fa_0925l` → { time:'09:25', tail:'l' }  该时点【后】最后一笔
 * 解析失败 → null（列名不认识就跳过，⛔ 不猜）。
 * @param {string} col
 * @returns {{time:string, tail:string}|null}
 */
function _parseFaCol(col) {
    const m = /^fa_(\d{2})(\d{2})([a-z]*)$/.exec(String(col || ''));
    if (!m) return null;
    return { time: m[1] + ':' + m[2], tail: m[3] || '' };
}

// 同一时刻多列时的先后：无后缀（该时刻前最后一笔）→ f（该时刻后第一笔）→ l（该时刻后最后一笔）
const TAIL_RANK = { '': 0, 'f': 1, 'l': 2 };

/**
 * 取「截至 hhmm 时刻的最后一笔封单额」（单位：元）。
 *
 * 实现刻意【不依赖列名数组顺序】，只用列名里的时刻 + 后缀判定 ——
 * 这样即使将来上游增删 fa_* 字段，本函数也不会因为「数组顺序变了」而静默算错。
 *
 * @param {object} row 库行（需含 `fa` = { fa_0915: number|null, … }）
 * @param {string} hhmm '09:20' | '09:25'
 * @returns {number|null} 无任何非空证据 → null（⛔ 不伪造 0）
 */
export function sealMoneyAt(row, hhmm) {
    const fa = row && row.fa;
    if (!fa || !hhmm) return null;
    let bestTime = '';
    let bestRank = -1;
    let bestVal = null;
    Object.keys(fa).forEach(function(col) {
        const p = _parseFaCol(col);
        if (!p || p.time > hhmm) return;
        const v = fa[col];
        if (v === null || v === undefined || !isFinite(v)) return;
        const rank = TAIL_RANK[p.tail] === undefined ? 0 : TAIL_RANK[p.tail];
        if (p.time > bestTime || (p.time === bestTime && rank >= bestRank)) {
            bestTime = p.time;
            bestRank = rank;
            bestVal = Number(v);
        }
    });
    return bestVal;
}

/**
 * 封单额强弱分档（纯表现，供 UI 选样式类）。
 *   · 无值 / 0 → 'flat'（⛔ 不把「没有这个数据」渲染成「封单弱」）
 *   · ≥ 1 亿   → 'strong'
 *   · 其余     → 'normal'
 * @param {number|null} money 元
 * @returns {'strong'|'normal'|'flat'}
 */
export function sealTone(money) {
    if (money === null || money === undefined || !isFinite(money) || money === 0) return 'flat';
    return Math.abs(money) >= 1e8 ? 'strong' : 'normal';
}

// ============================================================================
// 二·补、封单额【变化量】（★ 2026-09-18 用户新增：9:25 对比 9:20）
// ============================================================================
//
// 用户原话：「20亿是9:25分对比9点20分的封单额变化数量（**增加用红色，减少用绿色**）」，
// 并给了行尾格式「股票名称 9:25 +20亿 60亿」。
// ⇒ 变化量在「打开 9点25」态显示，与 9:25 绝对额并排。
//
// 业务含义：竞价 9:20~9:25 是**不可撤单**阶段，这 5 分钟里封单是**加**还是**撤**，
// 是判断一字板硬度最直接的信号 —— 加单 = 抢筹坚决，撤单 = 心虚（次日容易开板）。
// 所以「变化量」不是装饰数字，是本看板打开 toggle 后的**主角**。

/**
 * 封单额【变化量】的展示文本（9:25 − 9:20，★ 用户指定格式 `+20亿`）。
 *
 * 与 formatSealMoney 的差别只有两点，都是「变化量」语义才需要、绝对值不需要的：
 *   · **必须带符号** —— `+`（增加）/ `-`（减少）就是这条信息的主体，丢了就没意义；
 *   · **0 要显示** —— 绝对值 0 表示「没有封单」，而变化量 0 表示「两档一致」这个**有效结论**，
 *     ⛔ 不能像 formatSealMoney 那样返回空串。
 * 任一档缺失（无法相减）→ 返回空串，由 UI 显示 `-`（§10：算不出来就不编，绝不伪造 0）。
 *
 * @param {number|null} delta 9:25 封单额 − 9:20 封单额（元）
 * @returns {string} 形如 '+3.20亿' / '-8500万' / '+4321元'（小额档）/ '0'；无法计算 → ''
 */
export function formatSealMoneyDelta(delta) {
    if (delta === null || delta === undefined || !isFinite(delta)) return '';
    // ★ 变化量 = 0 是【有效结论】（两档封单完全一致），必须显式渲染成 '0'。
    //   ⛔ 不能沿用 formatSealMoney 的「0 → 空串」——那会让「没有变化」显示成「没有数据」。
    if (delta === 0) return '0';
    const abs = Math.abs(delta);
    const sign = delta > 0 ? '+' : '-';
    // 分档与 formatSealMoney 一致（亿 / 万），保证「同一笔金额的单值与变化量看着是同一量级」
    if (abs >= 1e8) return sign + (abs / 1e8).toFixed(2) + '亿';
    if (abs >= 1e4) return sign + (abs / 1e4).toFixed(0) + '万';
    // ⚠️ abs < 1万 的兜底档（2026-09-18 补）：
    //    若沿用「万」档，`(4321/1e4).toFixed(0)` = '0' → 页面会出现 **红色的「+0万」**，
    //    「有变化」被显示成「0」，自相矛盾且看不出方向。这一档直接给「元」，
    //    宁可字面长一点，也不能让数值与颜色互相打脸。
    return sign + abs.toFixed(0) + '元';
}

/**
 * 封单额变化量的色调（★ 中国股市习惯：增加 = 红、减少 = 绿）。
 * 无值 / 0 → 'flat'（灰）——⛔ 不把「算不出来」渲染成「没变化」，两者含义完全不同。
 * @param {number|null} delta
 * @returns {'up'|'down'|'flat'}
 */
export function sealDeltaTone(delta) {
    if (delta === null || delta === undefined || !isFinite(delta) || delta === 0) return 'flat';
    return delta > 0 ? 'up' : 'down';
}

// ============================================================================
// 三、一字口径闸门（★ 2026-09-15 修正：判据必须用「竞价涨幅 ≈ 涨停幅度」）
// ============================================================================
//
// ── 事故现场（2026-09-18，用户投诉）────────────────────────────────────────
//   用户：「今天9月18日，竟然有113只一字板，有那么多吗？」
//   当天 auction_yizi 表里躺着 121 行，剔除 8 只 ST 后看板显示 113 只 —— 与投诉完全吻合。
//   而同日 limit_pool 的涨停只有 77 只。**一字板 ⊆ 涨停板 ⇒ 113 只根本不可能。**
//
// ── 根因：入库判据错了（不是展示错了）─────────────────────────────────────
//   上一版 Edge Function 的判据是「9:15~9:25 之间存在任一非空 fa_*」。
//   但 `fa_*` 的语义只是「该时点上，匹配价 = 涨停价的竞价金额」——
//   **9:15~9:20 期间挂的涨停价买单是可以随时撤单的**，9:20 之后才不可撤。
//   于是「9:15 挂过一笔涨停价买单、随后撤掉」的票（当天 87 只只小涨 0~3%、23 只平盘或下跌、
//   如 丽尚国潮 -0.24% / *ST景谷 0.00%）全部被当成一字收了进来。
//
// ── 正确判据（= 用户说的「一字就是涨停」）──────────────────────────────────
//   **9:25 集合竞价结束时的竞价涨幅（auc_pct_chg）达到该股涨停幅度。**
//   语义上等价于「开盘价 = 涨停价」——竞价报价就打在涨停价上，这才是「竞价一字」。
//   该判据**已经存在**于项目里（早盘竞价看板用它给一字股标红线下划线）：
//     logic/auction/limit-up.js#isAuctionYiZi（涨停幅度按板块：主板 10% / 创业科创 20% /
//     北交所 30% / 主板 ST 5%，容差 EPS=0.15pp 吸收「涨停价四舍五入到分」的误差）
//   ⛔ 本模块只调用它，绝不另抄一张限幅表（§6 单一真相）。
//
// ── 修正后实测（09-18）─────────────────────────────────────────────────────
//   121 行 → 真一字 **8 只**：经纬股份(+20.00%)、福龙马(+10.03%)、中晶科技(+10.00%)、
//   中材科技(+10.00%)、内蒙新华(+10.04%)、百通能源(+9.99%)、华软科技(+10.10%)、华纺股份(+9.94%)。
//   被剔掉的行里「最接近涨停幅度」的是上海物贸 +9.28%（差 0.72pp）—— 明显不是涨停，**无误杀**。
//   全部 6 个已有交易日的修正结果：09-18 8 只 / 09-17 5 只 / 09-16 5 只 /
//   09-15 8 只 / 09-14 7 只 / 09-10 8 只（这些量级才符合「一天几只一字板」的常识）。
//
// ── 为什么前端还要再闸一次（不是重复劳动）──────────────────────────────────
//   Edge Function 只对【未来】的抓取生效；表里【已经落库的脏行】不会被它清掉。
//   前端在读取后、分块前再闸一次，是让「看板口径永远正确」这件事**不依赖后端是否已重新部署**
//   —— 判据来源仍然是同一个 isAuctionYiZi，不存在第二套口径。
//   ⛔ 但绝不静默剔除：被剔的只数必须如实呈现（见 filterYiziRows 的返回值），
//      否则用户会把「口径剔除」误读成「当天一字很少」。

/**
 * 单行是否属于「竞价一字」（★ 判据唯一实现 = logic/auction/limit-up.js#isAuctionYiZi）。
 *
 * 适配说明：库行的字段名是 `aucPct`（auc_pct_chg 原样文本，形如 '+10.03'），
 * 而 isAuctionYiZi 的入参形状是 { stock, auc_pct_chg, code } —— 这里做一次字段名适配，
 * ⛔ 不复制判定逻辑本身。
 *
 * @param {object} row 库行（含 stock / aucPct / code）
 * @returns {boolean}
 */
export function isYiziRow(row) {
    if (!row || !row.stock) return false;
    return isAuctionYiZi({ stock: row.stock, auc_pct_chg: row.aucPct, code: row.code }, row.code);
}

/**
 * 按「竞价涨幅 ≈ 涨停幅度」口径过滤行（纯函数，返回新数组，不改入参）。
 *
 * 分类计数（都是为了「可解释」—— 剔除了多少、为什么剔的，都要能说清）：
 *   · `kept`            = 入选只数
 *   · `droppedNoPct`    = 竞价涨幅缺失/无法解析 → **无法判定**（§10：不猜，计数后剔除）
 *   · `droppedNotLimit` = 有竞价涨幅但未达涨停幅度 → 明确不是一字
 *   · `removed`         = 两者之和
 *
 * 放置位置的理由：与 dropStRows 同理 —— `auction_yizi` 表是【抓取快照真相】，
 * 脏行该由后端判据修正 + 数据清理解决；「看板只呈现真一字」是【口径】，
 * 在这里闸一次可保证后端未重部署时看板也是对的。
 *
 * @param {object[]} rows
 * @returns {{rows:object[], kept:number, droppedNoPct:number, droppedNotLimit:number, removed:number}}
 */
export function filterYiziRows(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const kept = [];
    let droppedNoPct = 0;
    let droppedNotLimit = 0;
    list.forEach(function(r) {
        if (isYiziRow(r)) { kept.push(r); return; }
        if (parseAucPct(r && r.aucPct) === null) droppedNoPct++;
        else droppedNotLimit++;
    });
    return {
        rows: kept,
        kept: kept.length,
        droppedNoPct: droppedNoPct,
        droppedNotLimit: droppedNotLimit,
        removed: droppedNoPct + droppedNotLimit
    };
}

/**
 * 逐行生成「离涨停幅度还差多少」的可解释文本（仅用于排查/提示，不参与任何判定与排序）。
 * @param {object} row
 * @returns {string} 形如 '+9.28% / 限10%'；无涨幅 → ''
 */
export function limitGapText(row) {
    const pct = parseAucPct(row && row.aucPct);
    if (pct === null) return '';
    const lim = getLimitUpPct(row && row.code, row && row.stock);
    return (pct >= 0 ? '+' : '') + pct.toFixed(2) + '% / 限' + lim + '%';
}

// ============================================================================
// 四、ST 剔除（★ 用户指定：竞价一字看板不出现 ST 股票）
// ============================================================================

/** 股票简称里带 ST / *ST 的（A 股绝大多数 ST 股简称自带，作为 is_st 缺失时的兜底） */
const ST_NAME_RE = /^\*?ST/i;

/**
 * 该行是否属于「应剔除的 ST 股票」。
 *
 * 判据 = ① 库内 is_st === true（上游标注，权威）；或 ② 简称自带 ST / *ST。
 * ⚠️ §10：`is_st` 为 null / undefined（上游没给这个字段）**不等于**「不是 ST」，
 *    但也**不等于**「是 ST」→ 这时只认简称判据，绝不无依据地把行剔掉。
 *
 * @param {object} row
 * @returns {boolean}
 */
export function isStStock(row) {
    if (!row) return false;
    if (row.isSt === true) return true;
    const nm = String(row.stock || '').trim();
    return ST_NAME_RE.test(nm);
}

/**
 * 从池行里剔除 ST（纯函数，返回新数组，不改入参）。
 *
 * 放置位置的理由：本表 `auction_yizi` 是【当日快照真相】，ST 行照旧落库、照旧可被其它消费端使用；
 * 「看板不出现 ST」是【展示口径】→ 在 Logic 分块前过滤，而不是在 Data 读取时丢弃（§6 单一真相）。
 *
 * 若过滤后一行不剩，调用方必须把 `stRemoved` 一并呈现（否则用户会以为「当天没有一字」）。
 *
 * @param {object[]} rows
 * @returns {{rows:object[], removed:number}}
 */
export function dropStRows(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const kept = list.filter(function(r) { return !isStStock(r); });
    return { rows: kept, removed: list.length - kept.length };
}

// ============================================================================
// 五、分块（共享核心 + 竞价一字的度量绑定）
// ============================================================================

/**
 * 把一批一字行切成「看板分块」结构。
 *
 * 实现 = 共享核心 buildTopicBlocks，度量字段名绑定为 `rangePct`（十日涨幅，%）——
 * **与「涨跌停」看板完全同一口径**（用户：「我需要的是十日涨幅计算龙头，和涨跌停的逻辑基本一样」）：
 *   选龙头 = 题材块内十日涨幅最高者；块内序号 = 十日涨幅排名。
 * （⛔ 无十日涨幅数据的行不参与龙头评选 —— 共享核心已保证：无有效 metric 就不选龙头。）
 *
 * ⚠️ 封单额【不参与排序/选龙头】，只作为行内展示列（按「9点20」toggle 切时点）。
 *    这样切 toggle 纯粹换一个显示值，不需要重算分块（§34 展示态与业务数据分离）。
 *
 * @param {object[]} rows 库行（含 stock/code/fa/rangePct/rangeDays/continueText/... ，
 *                          题材原始文本在 topicsText；rangePct/rangeDays 由编排层挂上）
 * @param {Map<string,string>} primaryMap 整表分类结果（getPrimaryTopicMap）
 * @param {(row:object)=>string} fallbackFn 单票兜底分类（classifyStockPrimaryTopic）
 * @returns {Array<{topic:string, count:number, hasLeader:boolean, leaderStock:string,
 *   leaderRangePct:number|null, rangePct:number|null, rangeDays:number, stocks:Array<object>}>}
 */
export function buildYiziBlocks(rows, primaryMap, fallbackFn) {
    const blocks = buildTopicBlocksCore(rows, {
        primaryMap: primaryMap,
        fallbackFn: fallbackFn,
        metricOf: function(row) {
            const v = row && row.rangePct;
            if (v === null || v === undefined || !isFinite(v)) return null;
            return { pct: Number(v), days: isFinite(row.rangeDays) ? Number(row.rangeDays) : 0 };
        },
        metricKey: 'rangePct',
        metricDaysKey: 'rangeDays',
        // 🔴 排名资格（2026-09-20 新增）：窗口不足 10 个交易日的【残缺值】不参与块内排序与选龙头，
        //    但行内照旧显示它自己的十日涨幅文本（如 "50.29%(5/10日)"）——
        //    用户要的是「不参与排名」，不是「看不到值」。
        //    依据：区间涨幅是复利累乘，窗口天数不同的两个值【不可比】；让 5/10 日的残缺值
        //    与满窗值同尺排序，会凭空抢走题材龙头，把「这个题材今天谁是龙头」整体带偏。
        //    实测触发场景（2026-09-18）：经纬股份因筹划控制权变更停牌 5 个交易日 → 5/10 日。
        rankMinDays: RANGE_WINDOW_DAYS,
        extraOf: function(row) {
            const s920 = sealMoneyAt(row, SEAL_920);
            const s925 = sealMoneyAt(row, SEAL_925);
            // 变化量只在【两档都有值】时才成立：缺一档就无法相减 → null（§10 不伪造 0）
            const sealDelta = (s920 !== null && s925 !== null) ? (s925 - s920) : null;
            const pct = row && row.rangePct;
            const days = (row && row.rangeDays) || 0;
            return {
                // ---- 封单额：两个时点都算好（文本 + 色调），UI 按 toggle 选一个渲染（§21 模板不做业务计算）
                seal920: s920,
                seal920Text: formatSealMoney(s920),
                seal920Tone: sealTone(s920),
                seal925: s925,
                seal925Text: formatSealMoney(s925),
                seal925Tone: sealTone(s925),
                // ---- 封单额变化量（★ 用户新增：9:25 − 9:20；增加红 / 减少绿）
                //      业务含义：9:20~9:25 不可撤单，这 5 分钟是【加单】还是【撤单】，
                //      是一字板硬度最直接的信号（加单=抢筹坚决，撤单=次日易开板）。
                //      ⛔ 两档缺一 → null → UI 显示 '-'，绝不拿单档当「没变化」。
                sealDelta: sealDelta,
                sealDeltaText: formatSealMoneyDelta(sealDelta),
                sealDeltaTone: sealDeltaTone(sealDelta),
                // ---- 十日涨幅展示（块内排序/龙头判据已由共享核心写入 base.rangePct / base.rangeDays）
                rangeText: formatRangePct(pct, days),
                rangeTone: rangeTone(pct),
                // ---- 连板小标（首板/二板/三板…）：由编排层读涨跌停池 +1 得到；无依据时为空串（模板不渲染）
                continueText: (row && row.continueText) || '',
                // ---- 首封时刻（库列 fa_first）—— ⚠️ 2026-09-18 起【不再占行内位置】：
                //      用户明确「股票名后面应该显示当前时点（9:20 / 9:25），不是 9:15」，
                //      于是行内那个位置让给「时点标」（纯 UI 态，见 useAuctionYizi#pointTagText），
                //      首封时刻降级为【悬停提示】（faFirst / firstTimeText 两处都保留，信息不丢）。
                firstTimeText: (row && row.faFirst) || '',
                // ---- 封单证据强度（仅用于 title 提示，不占列宽）
                faCount: (row && row.faCount) ? Number(row.faCount) : 0,
                faFirst: (row && row.faFirst) || '',
                // ---- 题材来源（可解释性）
                themeSource: (row && row.themeSource) || '',
                themeSourceLabel: themeSourceLabel(row && row.themeSource)
            };
        }
    });
    // 兼容性字段名：leaderRangePct = 龙头股的十日涨幅（与涨跌停看板的 leaderPct 同位置）
    blocks.forEach(function(b) { b.leaderRangePct = b.leaderMetric; });
    return blocks;
}

/**
 * 「无题材」视图过滤（纯函数）：只留没有题材的股票（供人工统一补题材时截图）。
 *
 * 规则见共享核心 topics/topic-block.js#filterBlocksBy（裁行 / 序号重排 / 视图下不选龙头 / count 同步）。
 * 这里额外把 leaderRangePct 一并归零，保持与 buildYiziBlocks 的输出字段名一致。
 *
 * @param {Array<object>} blocks buildYiziBlocks 的输出
 * @returns {Array<object>} 新的分块数组（可能为空数组）
 */
export function filterYiziNoTopicBlocks(blocks) {
    const out = filterNoTopicBlocksCore(blocks);
    out.forEach(function(b) { b.leaderRangePct = null; });
    return out;
}

// ============================================================================
// 六、内容指纹（§17：变了才发布）
// ============================================================================

/**
 * 分块内容指纹：只有内容真正变化时才让编排层重放状态，避免无意义重渲染。
 * 选取的字段都是「会影响界面/结论」的字段：题材块序、块大小、龙头、每行的十日涨幅/连板/题材。
 * ⚠️ 两个时点的封单额 **+ 两者之差** 都要进指纹：任一变化都必须重放（否则切 toggle 会看到陈旧值）。
 * @param {Array<object>} blocks
 * @param {string} date
 * @returns {string}
 */
export function yiziSignature(blocks, date) {
    const one = function(list) {
        return (list || []).map(function(b) {
            return b.topic + '#' + b.count + '#' + (b.leaderStock || '') + '#' +
                (b.leaderRangePct === null || b.leaderRangePct === undefined ? '' : b.leaderRangePct) +
                '[' + (b.stocks || []).map(function(s) {
                    return s.stock + ':' + (s.rangePct === null || s.rangePct === undefined ? '' : s.rangePct) +
                        ':' + (s.continueText || '') +
                        ':' + (s.firstTimeText || '') +
                        ':' + (s.seal920 === null || s.seal920 === undefined ? '' : s.seal920) +
                        ':' + (s.seal925 === null || s.seal925 === undefined ? '' : s.seal925) +
                        ':' + (s.sealDelta === null || s.sealDelta === undefined ? '' : s.sealDelta) +
                        ':' + s.topicsDisplay;
                }).join(',') + ']';
        }).join('||');
    };
    return String(date || '') + '||YIZI||' + one(blocks);
}

// ============================================================================
// 七、看板状态与日期的对齐判据（§26 日期切换 / §23 数据集切换）
// ============================================================================

/**
 * 看板状态里的快照日期，是否与 UI 当前选中的日期一致。
 *
 * 为什么需要这个判据（真实事故形态，2026-09-18 浏览器实测）：
 *   切换日期后，新日期的加载需要一次云端读取。在这个「还没回来」的窗口里，
 *   `yiziBoardState.blocks / count` **仍然是上一天的内容**，而页头日期已经是新的一天。
 *   若直接按 `count > 0` 渲染，就会把【上一天的一字池】当成【这一天的一字池】显示出来
 *   —— 实测出现「页头 09-14、正文却是 09-17 的 129 只」。这比显示「加载中」严重得多：
 *   用户会据此得出「这一页的数据不对」的结论，且看不出是没加载完。
 *
 * 因此：**只有日期对齐时，快照才可被当作这一天的真相**；
 * 日期不对齐一律视为「还没准备好」→ UI 显示加载中，⛔ 绝不显示另一天的行。
 *
 * ⚠️ 与 §10 不冲突：这**不是**把「读取失败」当成「空」——读取失败走 error 分支（保持 throw）；
 *    这里处理的是「数据还没到」这个独立的中间态。
 *
 * @param {string} stateDate   yiziBoardState.date（快照所属日期）
 * @param {string} currentDate uiStore.currentDate（UI 当前选中日期）
 * @returns {boolean} true = 状态属于当前选中日，可渲染
 */
export function isBoardDateAligned(stateDate, currentDate) {
    return !!stateDate && !!currentDate && String(stateDate) === String(currentDate);
}
