// topic-sort.js — 题材 toggle 专用排序/展示纯函数（§15 独立业务模块）
//
// 题材 toggle 是「联动辅助 toggle」：配合竞昨/竞昨占比/三天竞跌等主排序 toggle 使用，
// 在主排序完成后按「题材数量」做稳定叠加排序（题材多的排前，同数量内保持主排序顺序）。
// 本模块只含纯函数，无副作用、不依赖响应式状态，供 view-helpers.js 排序分支与 _enrichAuctionItem 调用。

import { extractTopics, getDisplayNote, isValidTopic } from '../note/helpers.js';
import { getStockHistoryTopics } from '../stocks/stocks.js';

/**
 * 取单只股票的题材数组。
 * 优先从 note 括号提取（extractTopics），其次从 item.topics（字符串或数组）解析，
 * 最后回退共享题材库 getStockHistoryTopics。
 * @param {object} item - auctionList 行对象（含 stock/note/topics 等字段）
 * @returns {string[]} 题材数组（已去重过滤，可能为空）
 */
export function getStockTopicArr(item) {
    if (!item) return [];
    const note = getDisplayNote(item);
    let arr = extractTopics(note);
    if (arr.length === 0 && item.topics) {
        const topicsStr = Array.isArray(item.topics) ? item.topics.join(',') : String(item.topics);
        arr = topicsStr.split(/[，、,;；]/).map(t => t.trim()).filter(isValidTopic);
    }
    if (arr.length === 0 && item.stock) {
        const hist = getStockHistoryTopics(item.stock.trim());
        if (hist) {
            arr = hist.replace(/[()（）]/g, '').split(/[，、,;；]/).map(t => t.trim()).filter(isValidTopic);
        }
    }
    // 去重（与 extractTopics 一致，避免展示重复题材名）
    const seen = new Set();
    const deduped = [];
    arr.forEach(t => {
        const key = t.replace(/\s+/g, '').toLowerCase();
        if (!seen.has(key)) { seen.add(key); deduped.push(t); }
    });
    return deduped;
}

/**
 * 单只股票的题材数量（供排序使用）。
 * @param {object} item
 * @returns {number}
 */
export function getStockTopicCount(item) {
    return getStockTopicArr(item).length;
}

/**
 * 题材展示文本（逗号分隔，无题材返回 '-'）。
 * @param {object} item
 * @returns {string}
 */
export function getStockTopicsDisplay(item) {
    const arr = getStockTopicArr(item);
    return arr.length > 0 ? arr.join(',') : '-';
}

// === 题材 toggle 分组排序：复用「第二页题材分类」(getTopicGroups) 的同一套核心词匹配口径 ===
// 旧实现的坑：sortByTopicCountStable / sortByTopicWithinTiers 按「单只股票拥有的题材【数量】」排序
// （一只股有 3 个题材就排前面），与用户要的「题材【分组】」完全不是一回事。
// 新实现按「题材分组」排序：属于同一题材的股票聚到一起，哪个题材股票多哪个排前面，
// "其它"(无题材 / 未匹配核心词 / 组<2只) 一律置底；主排序档位(tier)顺序不变——高光/达标档(tier0)整体在最上。

import { getTopicGroups, getGroupableCoreTopics, matchTopicToCore } from '../topic/rules.js';

/** 「其它」组名（无题材 / 未命中核心词 / 组不足 2 只的兜底组） */
export const OTHER_TOPIC = '其它';

/**
 * 「站队到数量多的那一边」——多题材股票的【唯一】归属判定规则（§6 单一真相）。
 *
 * 背景（用户 2026-09-24 原话）：一只股票当天同时命中两个大类题材时，旧实现按「分组数组里第一次出现」
 * 站队 ⇒ 它经常被分到股票更少的那一边（例：七匹狼=服装家纺/海峡两岸 被塞进大消费；
 * 新华都=AI营销/AI应用/海峡两岸 被塞进 AI应用）。用户口径是：站在【当天股票数更多】的那一边
 * （海峡两岸 11 只 > AI应用 6 只 → 两只都归海峡两岸）；只属于 AI应用 的那几只仍留在 AI应用。
 *
 * 判定顺序（全部为稳定比较，绝不随机）：
 *   ① 真实题材 优先于「其它」——「其它」是兜底兜出来的大杂烩，数量天然最大，
 *      若让它参与「比大小」会把所有股票都吸进去（⛔ 曾经的坑）；
 *   ② 同级别内按【当日该题材的股票数】降序（数量多的那一边赢）；
 *   ③ 数量相同 → 按题材在 getTopicGroups 结果里的【原顺序】（星星数多的靠前）；
 *   ④ 仍相同 → 题材名字典序，保证每次渲染结果完全一致。
 *
 * @param {string[]} topics - 该股票的候选题材（core name，可能含 '其它'）
 * @param {Map<string,number>|Object} sizeOf - 题材 → 当日股票数（组内成员数）
 * @param {Map<string,number>|Object} [orderOf] - 题材 → 分组原顺序（越小越靠前），可选
 * @returns {string} 主题材；候选为空 → OTHER_TOPIC
 */
export function selectPrimaryTopic(topics, sizeOf, orderOf) {
    const list = Array.isArray(topics) ? topics.filter(function(t) { return !!t; }) : [];
    if (list.length === 0) return OTHER_TOPIC;
    const _size = function(tp) {
        if (!sizeOf) return 0;
        const v = (sizeOf instanceof Map) ? sizeOf.get(tp) : sizeOf[tp];
        return typeof v === 'number' ? v : 0;
    };
    const _order = function(tp) {
        if (!orderOf) return Infinity;
        const v = (orderOf instanceof Map) ? orderOf.get(tp) : orderOf[tp];
        return typeof v === 'number' ? v : Infinity;
    };
    let best = list[0];
    for (let i = 1; i < list.length; i++) {
        const tp = list[i];
        const aIsOther = (tp === OTHER_TOPIC) ? 1 : 0;
        const bIsOther = (best === OTHER_TOPIC) ? 1 : 0;
        if (aIsOther !== bIsOther) {
            if (aIsOther < bIsOther) best = tp;          // 真实题材压过「其它」
            continue;
        }
        const ds = _size(tp) - _size(best);
        if (ds > 0) { best = tp; continue; }
        if (ds < 0) continue;
        const dox = _order(tp) - _order(best);
        if (dox < 0) { best = tp; continue; }
        if (dox > 0) continue;
        if (tp < best) best = tp;                        // 字典序兜底，保证稳定
    }
    return best;
}

/**
 * 由「股票名 → 主题材」映射反推「题材 → 当日股票数」。
 * 供 classifyStockPrimaryTopic 兜底路径复用（让兜底也遵守「站队到数量多的一边」，§6）。
 * @param {Map<string,string>} primaryMap
 * @returns {Map<string,number>}
 */
export function buildTopicSizeMap(primaryMap) {
    const sizes = new Map();
    if (primaryMap) {
        for (const entry of primaryMap.entries()) {
            sizes.set(entry[1], (sizes.get(entry[1]) || 0) + 1);
        }
    }
    return sizes;
}

/**
 * 取「股票名 → 主题材」映射，复用第二页 getTopicGroups 的分类结果。
 *
 * 一只股票可能同时命中多个核心题材（被分入多个组），⛔ 它【只能落在一个题材里】；
 * 落哪个由 selectPrimaryTopic 统一裁决 = 【站队到当天股票数更多的那一边】。
 *
 * @param {object[]} auctionList - 当日完整列表（getTodayGroupList 返回，与第二页一致）
 * @returns {Map<string,string>} stockName(trim) → 主题材(core name 或 '其它')
 */
export function getPrimaryTopicMap(auctionList) {
    const map = new Map();
    if (!auctionList || auctionList.length === 0) return map;
    const groups = getTopicGroups(auctionList);

    // ① 题材规模（= 当日该题材的股票数）与原顺序 —— 供「站队」比较用
    const sizeOf = new Map();
    const orderOf = new Map();
    groups.forEach(function(g, i) {
        sizeOf.set(g.topic, g.stocks ? g.stocks.length : 0);
        if (!orderOf.has(g.topic)) orderOf.set(g.topic, i);
    });

    // ② 收集「股票名 → 命中的所有题材」（去重，保持分组顺序）
    const candidates = new Map();
    groups.forEach(function(g) {
        if (!g.stocks) return;
        g.stocks.forEach(function(s) {
            const nm = s && s.stock ? String(s.stock).trim() : '';
            if (!nm) return;
            if (!candidates.has(nm)) candidates.set(nm, []);
            const arr = candidates.get(nm);
            if (arr.indexOf(g.topic) < 0) arr.push(g.topic);
        });
    });

    // ③ 每只股票只站一次队：站在数量多的那一边
    for (const entry of candidates.entries()) {
        map.set(entry[0], selectPrimaryTopic(entry[1], sizeOf, orderOf));
    }
    return map;
}

/**
 * 单只股票的主题材（兜底分类）：用于不在 auctionList 内的注入行（如观察组壳行）。
 * 按核心词匹配出全部命中的核心题材后，交给 selectPrimaryTopic 裁决（同样「站队数量多的一边」）；
 * 无题材/未命中 → '其它'。与第一页 getTopicGroups 的多组归并口径一致（都走 matchTopicToCore）。
 *
 * @param {object} item
 * @param {Map<string,number>|Object} [sizeHint] - 可选：题材 → 当日股票数（来自 buildTopicSizeMap）。
 *        传了才启用「数量多的一边」裁决；不传退化为「取第一个命中的核心词」（既有行为，一行不变）。
 * @returns {string}
 */
export function classifyStockPrimaryTopic(item, sizeHint) {
    const topics = getStockTopicArr(item);
    if (topics.length === 0) return OTHER_TOPIC;
    // [ARCH-V3 §6] 与 getTopicGroups 共用同一份「可分组核心词」，伪题材不作为主题材
    const cores = getGroupableCoreTopics();
    const matched = [];
    for (const topic of topics) {
        const arr = matchTopicToCore(topic, cores);
        if (!arr || arr.length === 0) continue;
        arr.forEach(function(c) { if (matched.indexOf(c) < 0) matched.push(c); });
    }
    if (matched.length === 0) return OTHER_TOPIC;
    if (!sizeHint) return matched[0];
    return selectPrimaryTopic(matched, sizeHint, null);
}

/**
 * 题材分组叠加排序（核心修复逻辑）。
 * 在各主排序档位(tier)内部，按「题材分组」重排：
 *   - 取出本档位内每只股票的主题材(primaryTopicOf)；
 *   - 统计本档位内各题材组的股票数与【竞价一字】股票数；
 *   - 题材组排序：先按【一字数量降序】（9:25 一字涨停越多的题材越强，排最前），
 *     一字数量相同再按【组大小降序】（题材内股票多的排前），仍相同按题材名稳定排序；
 *   - "其它"组永远排在本档位最末；
 *   - 同一题材组内部，默认保持主排序的相对顺序(pos 兜底，稳定)；
 *     传入 rankFn 时改为【按 rankFn 升序】（龙头场景：龙一→龙二→龙三…），无排名的排在最后。
 * 档位(tier)顺序本身不变：tier0(高光/达标)整体在最上，tier1/tier2 依次在后。
 *
 * @param {number[]} renderOrder - 主排序后的索引数组（已分好档位）
 * @param {object[]} renderList - 完整行列表
 * @param {(idx:number)=>number} tierFn - 给定 renderList 索引，返回主排序档位(0=最高档)
 * @param {(idx:number)=>string} primaryTopicOf - 给定 renderList 索引，返回主题材(与第二页分类一致)
 * @param {(idx:number)=>number|null} [rankFn] - 可选：组内排序依据（升序，越小越靠前；null/无效值视为"无排名"排最后）
 * @param {(idx:number)=>boolean} [yiZiOf] - 可选：该行是否「竞价一字」（用于题材组间排序，缺省退化为纯组大小排序）
 * @param {(idx:number)=>boolean} [countableOf] - 可选：**计入统计**的行判定（true 才计入「组大小 / 一字数」）。
 *       [NOT-FORMAL 2026-09-23] 题材名次与统计只认【当天 9:25 抓取的正式成员】：观察组继承壳、
 *       补竞价一字补入行都不算（用户口径）。⛔ 它们**仍然按题材落进对应组并照常渲染**（只是不计数），
 *       否则"视觉顺序 / 统计条数字 / 趋势图名次"三套口径就会各说各话（用户反馈的错位）。
 *       不传 = 全部计入（既有行为，一行不变）。
 * @returns {number[]} 重排后的索引数组
 */
export function sortByTopicGroups(renderOrder, renderList, tierFn, primaryTopicOf, rankFn, yiZiOf, countableOf) {
  if (!renderOrder || renderOrder.length === 0) return renderOrder;
  if (typeof tierFn !== 'function' || typeof primaryTopicOf !== 'function') return renderOrder;
  const _rankNum = function(v) {
    return (v === null || v === undefined || !isFinite(v)) ? Number.MAX_SAFE_INTEGER : v;
  };
  // [NOT-FORMAL 2026-09-23] 默认全计入（向后兼容）；传了才按「正式成员」过滤
  const _countable = typeof countableOf === 'function'
    ? function(idx) { return !!countableOf(idx); }
    : function() { return true; };

    // 1) 按档位分组
    const tierGroups = new Map();
    renderOrder.forEach((idx, pos) => {
        const t = tierFn(idx);
        if (!tierGroups.has(t)) tierGroups.set(t, []);
        tierGroups.get(t).push({ idx, pos, topic: primaryTopicOf(idx) });
    });

    const out = [];
    // 2) 档位从小到大（tier0 在最上）
    [...tierGroups.keys()].sort((a, b) => a - b).forEach(t => {
        const arr = tierGroups.get(t);
        // 本档位内各题材组的股票数 / 竞价一字股票数
        const sizeMap = new Map();
        const yiZiMap = new Map();
        for (const x of arr) {
            // [NOT-FORMAL 2026-09-23] 不计入的行（观察组继承壳等）仍在 arr 里参与【分组与渲染】，
            // 只是不贡献组大小与一字数 —— 这样「排序依据 == 统计条数字 == 趋势图名次」三处同源。
            if (!_countable(x.idx)) continue;
            sizeMap.set(x.topic, (sizeMap.get(x.topic) || 0) + 1);
            if (yiZiOf && yiZiOf(x.idx)) yiZiMap.set(x.topic, (yiZiMap.get(x.topic) || 0) + 1);
        }
        // 题材组去重后排序：一字多的题材排最前 → 组大小降序 → 题材名稳定；"其它"永远最末
        const topics = [...new Set(arr.map(x => x.topic))];
        topics.sort((a, b) => {
            if (a === '其它') return 1;
            if (b === '其它') return -1;
            const dz = (yiZiMap.get(b) || 0) - (yiZiMap.get(a) || 0);
            if (dz !== 0) return dz;
            const d = (sizeMap.get(b) || 0) - (sizeMap.get(a) || 0);
            if (d !== 0) return d;
            return a < b ? -1 : (a > b ? 1 : 0);
        });
        // 3) 按题材组顺序输出
        for (const tp of topics) {
            const group = [];
            for (const x of arr) {
                if (x.topic === tp) group.push(x);
            }
            if (rankFn) {
                // 组内按龙头排名升序（龙一最先）；无排名者置底并保持相对顺序
                group.sort(function(a, b) {
                    const ra = _rankNum(rankFn(a.idx));
                    const rb = _rankNum(rankFn(b.idx));
                    if (ra !== rb) return ra - rb;
                    return a.pos - b.pos;
                });
            }
            for (const x of group) out.push(x.idx);
        }
    });
    return out;
}

// === 题材背景配色（纯表现层，仅题材 toggle 下使用）===
// 非常浅的同类色：不同题材分配不同浅色，让同一题材聚在一起时形成统一浅色带，视觉更清晰。
// 仅对「成员数 >= minCount」的真实题材上色；"其它"(无题材/未匹配核心词/组<2只) 与不足 minCount 的题材不上色。
const TOPIC_BG_PALETTE = [
    '#ffe3e3', // 浅红
    '#fff4d6', // 浅黄
    '#e3f5d6', // 浅绿
    '#d6ecff', // 浅蓝
    '#f3e1ff', // 浅紫
    '#ffe1ef', // 浅粉
    '#dffaf3', // 浅青
    '#f7e1d6', // 浅橙
    '#e6e1ff', // 薰衣草
    '#e1fff0', // 薄荷
    '#fff0e1', // 蜜桃
    '#d9f2ff', // 天蓝
    '#ffe9d6', // 杏色
    '#eef0d6'  // 橄榄
];

/**
 * 题材背景色映射：给定「股票名 → 主题材」映射，仅对成员数 >= minCount 的【真实题材】分配浅色背景。
 * "其它" 与 成员不足 minCount 的题材不上色（Map 中不存在该 key，UI 取到即空）。
 * 组越大的题材分配越靠前的调色板颜色（区分度更高）；同大小时按题材名稳定排序，保证每次渲染颜色一致。
 *
 * 该映射属于纯表现数据，由 Logic 层算好后随 item 透出给 UI（§15 独立业务模块，不污染业务数据）。
 *
 * @param {Map<string,string>} primaryTopicMap - stockName(trim) → 主题材（来自 getPrimaryTopicMap）
 * @param {number} minCount - 题材成员最小数（默认 2，即「两只以上才标记」）
 * @returns {Map<string,string>} 题材名(core) → 浅色背景（'其它'/不足 minCount 的不在 Map 中）
 *
 * [NOT-FORMAL 2026-09-23] ⚠️ 底色刻意**不按「正式成员」过滤**（曾试过，用户反馈「题材组内的底色不见了」）：
 *   底色是「这几只属于同一个题材」的视觉分组，观察组继承行确实渲染在该组里，不给它们上色会让组被腰斩。
 *   只有统计数字（统计条 / 趋势图 / 组间排序）才只数正式成员。别再给本函数加 countable 参数。
 */
export function buildTopicColorMap(primaryTopicMap, minCount = 2) {
    const counts = new Map();
    if (primaryTopicMap) {
        for (const entry of primaryTopicMap.entries()) {
            counts.set(entry[1], (counts.get(entry[1]) || 0) + 1);
        }
    }
    const eligible = [...counts.entries()]
        .filter(([topic, c]) => topic !== OTHER_TOPIC && c >= minCount)
        .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const map = new Map();
    eligible.forEach(([topic], i) => {
        map.set(topic, TOPIC_BG_PALETTE[i % TOPIC_BG_PALETTE.length]);
    });
    return map;
}