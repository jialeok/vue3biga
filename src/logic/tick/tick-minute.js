// tick-minute.js — 「分笔买卖」看板的纯逻辑（Logic 层，§15 独立业务模块）
//
// 职责边界（§4）：
//   · 本文件【只做两件事】——① 把库里存的「原始快照序列」推成「一笔一笔 + 红/绿笔数」；
//     ② 把决策看板的买点 / 卖点行抽成「分笔买卖看板要显示的那几列」并挂上统计。
//   · ⛔ 不发请求、不写库、不读 state、不消费任何额度（全是纯函数，可单测）。
//
// 数据来源（§6 单一真相，绝不另起一套）：
//   · 买点 / 卖点行  → 与决策看板【同一个】collectDecisionData（同一函数、同一份内存真相）
//                      ⇒ 本看板出现的股票 / 题材 / 排名 / 数量 / 竞价一字 / 龙几 / 十日涨幅
//                        与决策看板逐字一致，不会出现「两个看板数字不一样」。
//   · 分笔明细       → tick_minute_open（由 tick-minute-fetch 抓取落库）经 Data 层读回。
//
// ★★ 红 / 绿 / 平的口径（用户 2026-10-10 原话，⛔ 别改）★★
//   「箭头向上表示价格上涨（对比上一笔交易），箭头向下表示价格下跌，没有箭头，价格相平的。
//     东财是这么标注颜色的，下跌和平的用绿色，上涨用红色。」
//   ⇒ 一笔的涨跌 = 与【上一笔】的价格相比：
//        > 上一笔 → up（红 ↑）
//        < 上一笔 → down（绿 ↓）
//        = 上一笔 → flat（平，无箭头，但配色仍用绿）
//     统计口径：「17红4绿」里的绿 = down + flat（用户明确把平盘算进向下箭头那一边）。
//   第一笔的「上一笔」= 9:25 集合竞价的成交价 = 当日开盘价（上游 open 字段）——
//   那确实是本分钟第一笔之前发生的那一笔交易。⚠️ 拿不到开盘价 ⇒ 第一笔方向【未知】，
//   计入 unknown 而不是硬算成平盘（§10 不猜）。
//
// ★★ 单位口径（2026-10-10 实测更正，⛔ 别再改回 ÷100）★★
//   上游 vol 是【累计成交量，单位：手】—— 本模块用「本行 − 上一行」得到本快照的成交量，
//   它【本身就是手】，直接展示即可（与东财「手数」同一口径）。
//
//   ⚠️ 曾经写错：早期按「一手 = 100 股」把差值又 ÷100，导致看板显示 11.29 而东财显示 1129
//      （用户 2026-10-10 对照东财后发现，比值正好 100）。三条独立证据都指向「上游就是手」：
//        ① 用户实测：东财 1129 ↔ 本看板 11.29，差正好 100 倍；
//        ② 线上 30 只 / 76 个差值里，是 100 的整数倍的占 **0%** —— A 股一笔成交必是 100 股的
//           整数倍（1 手起），若上游单位是「股」，差值几乎必然都是 100 的倍数；0% ⇒ 不是股；
//        ③ 量级：若按「股」解释，一只涨停股开盘一分钟只有几百手（几万元），明显不可能。
//      ⇒ 差值原值 = 手。库里存的也是这个原值，**所以这次只改展示，不需要动历史数据**。
//
//   第一行没有上一行 ⇒ 量为 null，展示为「—」（⛔ 绝不拿累计值冒充单笔量）。
//
// ★★ 快照 ≠ 逐笔成交（务必知道）★★
//   上游按固定间隔给【快照】（每行 = 那一瞬间的最新价与累计量），东财的「20 笔」是【逐笔成交】。
//   本模块把「快照序列」当成一笔一笔来看（每个快照 = 一个新的价位点），
//   ⛔ 不补齐、不插值、不截断到 20 条；上游给几条就是几条，条数如实展示。
//   库里另存了 trade_count（上游累计成交笔数在窗口内的差分）作为【对照】，
//   面板里一并显示 —— 让「快照数 ≠ 成交笔数」这件事被看见，而不是被含糊过去。
//
// §10 红线：任何一项取不到都不许补 0 / 不许编 —— 一律给 null / 空串，由模板 v-if 决定不渲染。

import { buyBlocksOf } from '../decision/decision-collect.js';
import { formatRangePct } from '../decision/decision-rules.js';
import { getStockCode } from '../../data/stock-code-map.js';

// ══════════════════════════════════════════════════════════════════════════════
// 常量（⛔ 全项目只此一份：抓取端 tick-minute-fetch 用的是同一对时间，
//   改窗口必须同时改 supabase/functions/tick-minute-fetch/index.ts 的 CONFIG）
// ══════════════════════════════════════════════════════════════════════════════

/** 窗口起点（含） */
export const TICK_START_TIME = '09:30:00';
/** 窗口终点（上游语义：不含该边界 ⇒ 等价于 09:30:00.000~09:30:59.999） */
export const TICK_END_TIME = '09:31:00';
/** 窗口「可用」时刻：北京 09:31:00 之后这一分钟才算走完（之前抓只能拿到半截，§10 未就绪 ≠ 没有） */
export const TICK_WINDOW_READY = '09:31:00';

/** 一笔的方向（字符串常量，⛔ 别在模板里写字面量） */
export const PEN_UP = 'up';
export const PEN_DOWN = 'down';
export const PEN_FLAT = 'flat';

/** 一行「还没抓到」的两种可见文案（§10：未抓取 ≠ 没有数据） */
export const TICK_NOT_FETCHED = '未抓取';
export const TICK_NO_DATA = '无数据';

// ══════════════════════════════════════════════════════════════════════════════
// 时间工具（纯函数，便于单测；一律按【北京】算）
// ══════════════════════════════════════════════════════════════════════════════

/** 'HH:MM[:SS]' → 当日秒数；非法 → NaN */
export function hmsToSec(s) {
    const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(s === null || s === undefined ? '' : s).trim());
    if (!m) return NaN;
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] || '0');
}

/** 北京「现在」的 HH:MM:SS（nowMs 可注入，便于单测） */
export function beijingHms(nowMs) {
    const t = (typeof nowMs === 'number' && isFinite(nowMs)) ? nowMs : Date.now();
    const d = new Date(t + 8 * 3600 * 1000);
    return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0') + ':' + String(d.getUTCSeconds()).padStart(2, '0');
}

/** 北京「今天」的 YYYY-MM-DD（nowMs 可注入，便于单测） */
export function beijingToday(nowMs) {
    const t = (typeof nowMs === 'number' && isFinite(nowMs)) ? nowMs : Date.now();
    const d = new Date(t + 8 * 3600 * 1000);
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}

/**
 * 这一分钟的数据现在能不能抓（唯一实现，§6）。
 *
 * · 历史日（date < 北京今天）→ 随时可抓：tradedate 已把日期钉死，上游那一天的这一分钟是终值。
 * · 今天 → 必须等到北京 09:31:00 之后（之前抓只是半截数据，落库会被当成完整分钟用）。
 * · 未来日 → 永远不可抓。
 *
 * @param {string} date YYYY-MM-DD
 * @param {number} [nowMs] 注入时间（单测用）
 * @returns {{can:boolean, reason:string, retryAtHms:string}}
 */
export function tickWindowState(date, nowMs) {
    const d = String(date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return { can: false, reason: '日期非法', retryAtHms: '' };
    const today = beijingToday(nowMs);
    if (d > today) return { can: false, reason: '还没到那一天', retryAtHms: '' };
    if (d < today) return { can: true, reason: '', retryAtHms: '' };
    const now = beijingHms(nowMs);
    if (hmsToSec(now) < hmsToSec(TICK_WINDOW_READY)) {
        return { can: false, reason: '等 ' + TICK_WINDOW_READY + ' 之后自动抓取（现在是 ' + now.slice(0, 5) + '）', retryAtHms: TICK_WINDOW_READY };
    }
    return { can: true, reason: '', retryAtHms: '' };
}

// ══════════════════════════════════════════════════════════════════════════════
// ① 原始快照 → 一笔一笔 + 红绿统计
// ══════════════════════════════════════════════════════════════════════════════

/** 数值归一：非有限值 → null（0 是真实值，保留） */
function _num(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return isFinite(n) ? n : null;
}

/**
 * 【成交量：手】展示文案（唯一实现，§6）。
 * ⚠️ 上游 vol 的差值【本身就是手】，所以这里【不做任何换算】（2026-10-10 实测更正：
 *    以前误按「一手 = 100 股」又 ÷100，导致显示 11.29 而东财显示 1129，差正好 100 倍）。
 * 整手 → 整数；万一手数出现小数（上游异常）→ 保留 2 位，⛔ 不四舍五入成 0。
 * null → '—'（§10：⛔ 不显示 0）
 * @param {number|null} lots 上游 vol 的差分值，单位【手】
 */
export function formatPenHands(lots) {
    const n = _num(lots);
    if (n === null) return '—';
    if (Math.abs(n - Math.round(n)) < 1e-9) return String(Math.round(n));
    return n.toFixed(2);
}

/** 价格展示：两位小数；null → '—' */
export function formatPenPrice(p) {
    const n = _num(p);
    return n === null ? '—' : n.toFixed(2);
}

/**
 * 一笔的方向（唯一实现，§6）。
 * @param {number|null} price 本笔价格
 * @param {number|null} prevPrice 上一笔价格（第一笔 = 当日开盘价）
 * @returns {'up'|'down'|'flat'|''} '' = 无法判定（§10 不猜）
 */
export function penDirectionOf(price, prevPrice) {
    const a = _num(price);
    const b = _num(prevPrice);
    if (a === null || b === null) return '';
    if (a > b) return PEN_UP;
    if (a < b) return PEN_DOWN;
    return PEN_FLAT;
}

/** 方向 → 箭头（平与未知都没有箭头，与东财一致） */
export function penArrowOf(dir) {
    if (dir === PEN_UP) return '↑';
    if (dir === PEN_DOWN) return '↓';
    return '';
}

/**
 * 方向 → 配色档。
 * ★ 用户口径：「下跌和平的用绿色」⇒ flat 与 down 同色（都是 'down'）；
 *   未知（''）不给档 ⇒ 模板不加类名（灰色默认），⛔ 不冒充平盘。
 */
export function penToneOf(dir) {
    if (dir === PEN_UP) return 'up';
    if (dir === PEN_DOWN || dir === PEN_FLAT) return 'down';
    return '';
}

/**
 * 把库里的原始快照序列推成「一笔一笔」+ 红绿统计。
 *
 * 处理规则（全部有据可依，⛔ 不含任何猜测）：
 *   ① 丢掉【没有价格】的快照（上游 close 为 null）→ 计入 droppedNoPrice；
 *   ② 丢掉【本快照没有任何成交】的快照（v === 0，即累计量没变）→ 计入 idle。
 *      它不是一个「笔」，把它算成平盘会把「停顿」读成「走平」（§10）。
 *      ⚠️ 第一条快照的 v 恒为 null（没有上一行可比），无法判断是否停顿时段 ⇒ 保留。
 *   ③ 方向 = 与【上一个有价格的原始快照】相比；第一条比【当日开盘价】。
 *      开盘价缺失 ⇒ 方向未知（''），计入 unknown，⛔ 不当平盘。
 *   ④ 平盘计入 green（用户口径），但 flat 单独计数保留，便于核对。
 *
 * @param {{openPrice:number|null, pens:Array<{t:string,p:number|null,v:number|null}>, tradeCount?:number|null}} row
 *        row 来自 Data 层 readTickMinuteForDate（字段已 camelCase）
 * @returns {{pens:Array<object>, up:number, down:number, flat:number, unknown:number,
 *            idle:number, droppedNoPrice:number, red:number, green:number, total:number,
 *            rawCount:number, tradeCount:number|null}}
 */
export function buildTickPens(row) {
    const out = {
        pens: [], up: 0, down: 0, flat: 0, unknown: 0,
        idle: 0, droppedNoPrice: 0, red: 0, green: 0, total: 0,
        rawCount: 0, tradeCount: null
    };
    if (!row || !Array.isArray(row.pens)) return out;
    out.rawCount = row.pens.length;
    out.tradeCount = _num(row.tradeCount);

    // 第一笔的基准 = 当日开盘价（拿不到 → prevPrice 为 null ⇒ 第一笔方向未知）
    let prevPrice = _num(row.openPrice);
    let seq = 0;

    for (let i = 0; i < row.pens.length; i++) {
        const raw = row.pens[i] || {};
        const p = _num(raw.p);
        const v = _num(raw.v);

        if (p === null) { out.droppedNoPrice++; continue; }
        // ② 累计量没变 = 这一瞬间没有任何成交 ⇒ 不是一笔
        //   ⚠️ i === 0 时 v 恒为 null（库里就没存首条的差分），不会被这条误伤
        if (i > 0 && v !== null && v === 0) { out.idle++; prevPrice = p; continue; }

        const dir = penDirectionOf(p, prevPrice);
        seq++;
        out.pens.push({
            seq: seq,
            time: String(raw.t === null || raw.t === undefined ? '' : raw.t),
            price: p,
            priceText: formatPenPrice(p),
            volShares: v,
            volText: formatPenHands(v),
            dir: dir,
            arrow: penArrowOf(dir),
            tone: penToneOf(dir),
            title: (dir === PEN_UP ? '价格上涨（对比上一笔）'
                : dir === PEN_DOWN ? '价格下跌（对比上一笔）'
                    : dir === PEN_FLAT ? '价格相平（对比上一笔）→ 按用户口径计入绿色一边'
                        : '无法判定方向（缺上一笔价格或当日开盘价）')
        });
        if (dir === PEN_UP) out.up++;
        else if (dir === PEN_DOWN) out.down++;
        else if (dir === PEN_FLAT) out.flat++;
        else out.unknown++;
        prevPrice = p;
    }

    out.red = out.up;                 // 红 = 上涨
    out.green = out.down + out.flat;  // 绿 = 下跌 + 平盘（用户口径）
    out.total = out.up + out.down + out.flat;
    return out;
}

/**
 * 「17红4绿」两段文案（唯一实现，§6）。
 * ⛔ 分成两段是为了让模板零计算地把红字/绿字分别染上色（§21）。
 * 没有可统计的笔 ⇒ 两段都是空串（模板 v-if 不渲染，§10 ⛔ 不显示「0红0绿」）。
 *
 * @param {{red:number, green:number, total:number}} s buildTickPens 的返回
 * @returns {{redText:string, greenText:string, title:string}}
 */
export function tickStatText(s) {
    if (!s || !s.total) return { redText: '', greenText: '', title: '' };
    const parts = [];
    parts.push('上涨（红）' + s.red + ' 笔');
    parts.push('下跌（绿）' + s.down + ' 笔');
    if (s.flat) parts.push('其中平盘 ' + s.flat + ' 笔（按口径计入绿色一边）');
    if (s.unknown) parts.push('无法判定方向 ' + s.unknown + ' 笔（缺上一笔价格 / 开盘价）');
    if (s.idle) parts.push('略去无成交快照 ' + s.idle + ' 个');
    if (s.droppedNoPrice) parts.push('略去缺价格快照 ' + s.droppedNoPrice + ' 个');
    return {
        redText: s.red + '红',
        greenText: s.green + '绿',
        title: '9:30~9:31 这一分钟：' + parts.join('；') + '｜原子上游快照 ' + s.rawCount + ' 个'
    };
}

/**
 * 买卖结论标签（由红绿笔数直接得出）。
 *
 * ★ [ACTION-LABEL 2026-10-10 用户口径] 「分笔买卖就是买入和卖出信号，所以标注清晰些。
 *    早上就靠这个来判断」⇒ 把原来那个中性的「开盘强 / 开盘弱」换成【动作名】，
 *    并且【买点侧和卖点侧给不同的名字】—— 同一个强弱结论，两边的动作正好相反：
 *
 *      买点（side='buy'） 强 ⇒ 「立刻买」      红      （= 竞价买同路，只是要等开盘后才知道）
 *                        弱 ⇒ 「盘中下杀买」  绿      （开盘不能追，等盘中下杀完再买）
 *      卖点（side='sell'）强 ⇒ 「盘中冲高卖」  红      （别急，等冲高后第一笔绿色手数再卖）
 *                        弱 ⇒ 「立刻卖」      绿      （弱了就是止损，别等反抽）
 *      两侧相等           ⇒ 「均衡」          灰蓝    （不站边，§10 不硬判）
 *
 * ⛔ 只是把同一份统计翻译成一句「现在该怎么做」，**不改任何选票 / 买卖结论**
 *    （决策看板一行都不动；§6：红绿统计仍然只有 buildTickPens 一个口径）。
 * ⛔ tone 只保留 strong / weak / even 三档 —— CSS 的 .tbb-verdict-* 就这三档，
 *    且红=strong / 绿=weak 与用户要的红绿**完全一致**，所以样式一个字都不用改（§21）。
 *
 * @param {{red:number, green:number, total:number}} s buildTickPens 的返回
 * @param {'buy'|'sell'} [side] 买点侧 / 卖点侧（缺省按买点侧处理）
 * @returns {{text:string, tone:string, title:string}}
 */
export function tickStrengthOf(s, side) {
    if (!s || !s.total) return { text: '', tone: '', title: '' };
    const isSell = side === 'sell';
    const cmp = (s.red > s.green) ? ' > ' : ((s.red < s.green) ? ' < ' : ' = ');
    const cnt = '上涨 ' + s.red + ' 笔' + cmp + '下跌（含平盘）' + s.green + ' 笔';
    if (s.red > s.green) {
        return isSell
            ? {
                text: '盘中冲高卖', tone: 'strong',
                title: cnt + ' ⇒ 开盘走强、还在往上冲：【别急着卖】，等【盘中冲高】。'
                    + '盯同花顺的分笔订单：红色手数代表价格还在上涨，'
                    + '【第一次出现绿色（下跌）手数】时就是卖点。'
            }
            : {
                text: '立刻买', tone: 'strong',
                title: cnt + ' ⇒ 开盘走强、买盘主动：直接【立刻买】。'
                    + '与「竞价买」同一路思路，区别只是这个要等开盘后（9:30~9:31）才能确认。'
            };
    }
    if (s.red < s.green) {
        return isSell
            ? {
                text: '立刻卖', tone: 'weak',
                title: cnt + ' ⇒ 开盘就走弱：直接【立刻卖】止损，别等反抽。'
            }
            : {
                text: '盘中下杀买', tone: 'weak',
                title: cnt + ' ⇒ 开盘走弱、【不能追高】：等【盘中下杀】走完再买。'
                    + '盯分笔手数：缩到一位数或两位数（单位＝手）时，说明卖盘也弱了、成交冷淡、'
                    + '抛压枯竭、即将反转 —— 那时再买入。'
            };
    }
    return {
        text: '均衡', tone: 'even',
        title: cnt + ' ⇒ 多空均衡，不硬判强弱（按原规则看别的指标）。'
    };
}

/**
 * 展开面板的标题行文案（§21：模板零计算，整段由 Logic 给）。
 */
export function tickPanelTitle(s, name) {
    const span = TICK_START_TIME.slice(0, 5) + '~' + TICK_END_TIME.slice(0, 5);
    if (!s || !s.total) return name + '　' + span + '　无成交明细';
    const bits = [name, span, '共 ' + s.total + ' 笔'];
    bits.push('↑' + s.up);
    bits.push('↓' + s.down);
    if (s.flat) bits.push('平' + s.flat);
    if (s.unknown) bits.push('未知' + s.unknown);
    if (s.tradeCount !== null && s.tradeCount !== undefined) bits.push('上游成交笔数 ' + s.tradeCount);
    return bits.join('　');
}

/** 面板下方的口径注释（把「快照数 ≠ 成交笔数」讲清楚，§10 不糊弄） */
export function tickPanelNote(s) {
    if (!s) return '';
    const bits = [];
    bits.push('原始快照 ' + s.rawCount + ' 个');
    if (s.idle) bits.push('其中 ' + s.idle + ' 个快照没有任何成交（已略去）');
    if (s.droppedNoPrice) bits.push('其中 ' + s.droppedNoPrice + ' 个缺价格（已略去）');
    bits.push('第一笔的涨跌基准 = 当日开盘价（9:25 集合竞价的成交价）');
    bits.push('「绿」= 下跌 + 平盘（按东财口径）');
    bits.push('「手数」= 该快照的成交量，单位【手】（与东财/同花顺同口径，⛔ 不是股）');
    return bits.join('｜');
}

/**
 * 展开面板【最下方】的「分析过程 + 买卖点逻辑」提示（用户 2026-10-10 要求：
 * 「把说明买卖点文字写到股票展开分笔订单最下那里说明下…相当于一个分析过程，
 *   和买卖点逻辑，简洁。不用太长」）。
 *
 * ⇒ 固定两行，回答两件事：
 *     第 1 行【分析】这一分钟怎么读出来的（红绿笔数 → 强/弱/均衡）
 *     第 2 行【买点/卖点】这只票此刻该怎么做（= 结论胶囊那个动作名的展开）
 * ⛔ 全部是纯文案推导，不产生任何新的业务结论（§6：动作名仍由 tickStrengthOf 一处给出）。
 *
 * @param {{red:number, green:number, flat:number, total:number}} s buildTickPens 的返回
 * @param {'buy'|'sell'} [side]
 * @returns {string[]} 逐行文案（空数组 = 不渲染那一块，§10）
 */
export function tickPanelHint(s, side) {
    if (!s || !s.total) return [];
    const isSell = side === 'sell';
    const act = tickStrengthOf(s, side);
    // ── 第 1 行：分析过程（红绿 → 强弱）──────────────────────────────────
    const verdict = (s.red > s.green) ? '上涨占优 = 开盘强'
        : ((s.red < s.green) ? '下跌占优 = 开盘弱' : '多空相等 = 均衡');
    let l1 = '【分析】红 ' + s.red + ' 笔 / 绿 ' + s.green + ' 笔（绿 = 下跌 + 平盘';
    if (s.flat) l1 += '，其中平盘 ' + s.flat + ' 笔';
    l1 += '）⇒ ' + verdict;
    // ── 第 2 行：这一步该怎么做（动作名 + 一句操作要点）──────────────────
    let how;
    if (s.red === s.green) {
        how = '多空均衡，本看板不下结论 —— 按原规则看别的指标。';
    } else if (isSell) {
        how = (s.red > s.green)
            ? '别急着卖，等【盘中冲高】；盯分笔，红色手数 = 还在上涨，'
                + '【第一次出现绿色（下跌）手数】时就是卖点。'
            : '弱了就是止损，【别等反抽】。';
    } else {
        how = (s.red > s.green)
            ? '走强直接买（与「竞价买」同路，只是要等开盘后才知道）。'
            : '不追高，等【盘中下杀】；手数缩到一位数 / 两位数（手）时说明卖盘也弱、'
                + '抛压枯竭、即将反转，那时再买。';
    }
    return [l1, '【' + (isSell ? '卖点' : '买点') + '】' + act.text + ' —— ' + how];
}

// ══════════════════════════════════════════════════════════════════════════════
// ② 决策看板的行 → 分笔买卖看板的行
// ══════════════════════════════════════════════════════════════════════════════

/**
 * 从买点块的 members 里取 name → code（买点 pick 上【没有】code，只有 members 有）。
 * ⛔ 不自己拼代码、不按名字猜板块（§10）。
 */
function _codeMapOfMembers(block) {
    const m = new Map();
    ((block && block.members) || []).forEach(function(x) {
        if (!x || !x.name) return;
        const c = String(x.code || '').trim();
        if (c) m.set(String(x.name).trim(), c);
    });
    return m;
}

/** 代码取数：优先行上的 code，其次买点 members 映射，最后查名册（与决策看板同一份 stockcodemap，§6） */
function _resolveCode(name, directCode, memberMap) {
    const direct = String(directCode || '').trim();
    if (direct) return direct;
    const m = memberMap ? memberMap.get(name) : '';
    if (m) return String(m).trim();
    return String(getStockCode(name) || '').trim();
}

/**
 * 一行（买点 pick / 卖点 item）挂上分笔统计。
 * §10：库里没有这一行 ⇒ 按「未抓取 / 无数据」给出可见文案，⛔ 绝不显示「0红0绿」。
 *
 * @param {object} row 决策行（含 name / seq / dragonLabel / dragonDeltaText / pct）
 * @param {Map} tickMap name → tick_minute_open 行（Data 层读回并归一后的对象）
 * @param {Set<string>} attempted 本次会话里【已经抓过】的股票名
 * @param {Map<string,string>} skipMap name → 「为什么没抓」（如缺代码），命中时优先展示
 * @param {Map<string,string>} memberMap name → code（买点侧专用）
 * @param {'buy'|'sell'} side 这一行属于买点还是卖点 —— 决定结论胶囊显示哪个【动作名】
 *        （买点「立刻买 / 盘中下杀买」 vs 卖点「盘中冲高卖 / 立刻卖」，见 tickStrengthOf）
 */
function _decorateTickRow(row, tickMap, attempted, skipMap, memberMap, side) {
    const name = String(row.name || '').trim();
    const out = {
        seq: row.seq,
        name: name,
        code: _resolveCode(name, row.code, memberMap),
        dragonLabel: row.dragonLabel || '',
        dragonRank: (row.dragonRank === undefined ? null : row.dragonRank),
        dragonDeltaText: row.dragonDeltaText || '',
        dragonDeltaTone: row.dragonDeltaTone || '',
        dragonDeltaTitle: row.dragonDeltaTitle || '',
        pctText: formatRangePct(row.pct),
        // 分笔部分
        hasTick: false,
        redText: '', greenText: '', statTitle: '',
        strengthText: '', strengthTone: '', strengthTitle: '',
        emptyText: '',
        emptyTitle: '',
        pens: [], panelTitle: '', panelNote: '', panelHint: []
    };

    const dbRow = tickMap ? tickMap.get(name) : null;
    const skipText = skipMap ? skipMap.get(name) : '';
    if (skipText) {
        out.emptyText = skipText;
        out.emptyTitle = '这一只没能抓取：' + skipText;
        return out;
    }
    if (!dbRow) {
        out.emptyText = (attempted && attempted.has(name)) ? TICK_NO_DATA : TICK_NOT_FETCHED;
        out.emptyTitle = (attempted && attempted.has(name))
            ? '已经抓过了，但上游这一分钟没有这只票的快照（停牌 / 无成交 / 上游无该批次）'
            : '还没抓取：' + TICK_WINDOW_READY + ' 之后会自动抓这一分钟的分笔（历史日随时可抓）';
        return out;
    }

    const s = buildTickPens(dbRow);
    out.hasTick = true;
    const st = tickStatText(s);
    out.redText = st.redText;
    out.greenText = st.greenText;
    out.statTitle = st.title;
    const str = tickStrengthOf(s, side);
    out.strengthText = str.text;
    out.strengthTone = str.tone;
    out.strengthTitle = str.title;
    out.pens = s.pens;
    out.panelTitle = tickPanelTitle(s, name);
    out.panelNote = tickPanelNote(s);
    out.panelHint = tickPanelHint(s, side);
    // ⚠️ 有行但一笔都判不出来（全缺价格）⇒ 走「无数据」文案而不是空胶囊（§10）
    if (s.total === 0) {
        out.emptyText = TICK_NO_DATA;
        out.emptyTitle = '上游这一分钟的快照全部缺成交价，无法判断红绿：' + s.rawCount + ' 个快照';
        out.redText = '';
        out.greenText = '';
        out.statTitle = '';
        out.strengthText = '';
        out.strengthTone = '';
        out.strengthTitle = '';
    }
    return out;
}

/**
 * 组装「分笔买卖」看板要显示的买点块 / 卖点组。
 *
 * 只放用户点名的这几列（用户原话「其它不要放」）：
 *   买点块   ：昨有买入 / 四次入选 / 题材名称 / 排名 / 数量 / 竞价一字
 *   股票行   ：序号 / 股票名称 / 龙几（±n）/ 十日涨幅 / 20 笔统计（如 17红4绿）
 *   ⛔ 不放：选择理由、卖出理由、竞价涨幅、竞价量比、竞价占比、仓位、买卖动作标签、
 *      逐行说明文字、规则提示、竞价图形判断选择器 —— 那些都是决策看板的东西。
 *
 * @param {object} decided collectDecisionData 的返回
 * @param {Map} tickMap name → tick 行
 * @param {{attempted?:Set<string>, skipMap?:Map<string,string>}} [opts]
 * @returns {{ready:boolean, reason:string, buyBlocks:Array, sellGroups:Array,
 *            targets:Array<{name:string,code:string}>}}
 */
export function buildTickBoard(decided, tickMap, opts) {
    const attempted = (opts && opts.attempted) || new Set();
    const skipMap = (opts && opts.skipMap) || new Map();
    const map = tickMap || new Map();
    const out = { ready: false, reason: '', buyBlocks: [], sellGroups: [], targets: [] };
    if (!decided || !decided.ready) {
        out.reason = (decided && decided.reason) || '决策数据未就绪';
        return out;
    }

    const targets = new Map(); // name → code（去重，按出现顺序）

    // ---- 买点块 ----
    // ⛔ 同一个块对象只渲染一次：候选题材数组里可能【就是】light 那一块
    //    （第 2 名题材已够 3 只时被降级成候选题材）—— 决策看板用「引用相等」过滤掉它
    //    （见 useDecisionBoard#buyCandidates），这里必须同一口径，否则第 2 名会重复出现一遍。
    const rawBlocks = buyBlocksOf(decided.buy);
    rawBlocks.forEach(function(b, bi) {
        if (!b || !b.block) return;
        if (rawBlocks.indexOf(b) !== bi) return;
        const memberMap = _codeMapOfMembers(b.block);
        const picks = (b.picks || []).map(function(p) {
            return _decorateTickRow(p, map, attempted, skipMap, memberMap, 'buy');
        });
        // 没有股票的块【不渲染】：本看板没有「选择理由 / 不出票原因」那些行，
        // 留一个光秃秃的题材名反而让人以为是坏了（§10 宁可整块不出现）。
        if (picks.length === 0) return;
        picks.forEach(function(p) { if (!targets.has(p.name)) targets.set(p.name, p.code); });
        out.buyBlocks.push({
            topic: String(b.block.topic || ''),
            // 与 DecisionBuyBlock 同一口径：圆点显示 pickRank（决策看板内的名次），回落 block.rank
            rank: (Number(b.pickRank) > 0 ? Number(b.pickRank) : null) || b.block.rank || null,
            count: (b.block.count === undefined ? null : b.block.count),
            yiziCount: (b.block.yiziCount === undefined ? null : b.block.yiziCount),
            // ⚠️ 用户点名的两个题材标记；⛔ 不传 candidateTag（用户「其它不要放」）
            prevBoughtTag: b.prevBoughtTag || '',
            streakTag: b.streakTag || '',
            picks: picks
        });
    });

    // ---- 卖点组 ----
    (decided.sell || []).forEach(function(g) {
        if (!g) return;
        const items = (g.items || []).map(function(it) {
            return _decorateTickRow(it, map, attempted, skipMap, null, 'sell');
        });
        if (items.length === 0) return;
        items.forEach(function(it) { if (!targets.has(it.name)) targets.set(it.name, it.code); });
        out.sellGroups.push({
            topic: String(g.topic || ''),
            groupKey: g.groupKey,
            topicRank: (g.topicRank === undefined ? null : g.topicRank),
            count: (g.count === undefined ? null : g.count),
            yiziCount: (g.yiziCount === undefined ? null : g.yiziCount),
            items: items
        });
    });

    out.targets = Array.from(targets.entries()).map(function(e) { return { name: e[0], code: e[1] }; });
    out.ready = true;
    return out;
}

/**
 * 抓取目标（= 买点 + 卖点里出现过、且拿得到代码的股票）—— 唯一出口，§6。
 * ⛔ 用户口径：只抓决策看板选中的那几只，不抓全市场。
 */
export function tickTargetsOf(board) {
    if (!board || !board.targets) return [];
    return board.targets.filter(function(t) { return t && t.name; });
}
