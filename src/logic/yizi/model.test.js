// model.test.js — 「竞价一字」看板纯函数模型层的回归测试
// 覆盖：一字口径闸门（竞价涨幅 ≈ 涨停幅度）、题材文本切分与「接口→题材库」三级优先、
//       题材分块（组序 / 组内序 / 龙头 / 其它置底 / 不改入参 / 无十日涨幅不选龙头）、
//       封单额双时点口径（9:20 / 9:25）、ST 判据与剔除、「无题材」视图过滤、
//       展示分档（封单额 / 十日涨幅）。
//
// ⚠️ 封单额时点用例的样本【取自 2026-09-18 线上库的真实行】：
//    · 真一字（经纬股份 / 中材科技）= 13 个 fa_* 时点全有，9:20 与 9:25 取到不同值；
//    · 非一字（丽尚国潮，竞价 -0.24%）= 只有 fa_0915 一笔 —— 它是【旧判据的误收样本】，
//      现已被口径闸门剔除（见「一字口径闸门」用例组）。
//    这样锁死的是真实形态，而不是想象的形态。
import { describe, it, expect } from 'vitest';
import {
    splitThemeText,
    resolveYiziTopics,
    themeSourceLabel,
    buildYiziBlocks,
    filterYiziNoTopicBlocks,
    formatSealMoney,
    sealMoneyAt,
    sealTone,
    isStStock,
    dropStRows,
    isYiziRow,
    filterYiziRows,
    limitGapText,
    yiziSignature,
    isBoardDateAligned,
    SEAL_920,
    SEAL_925,
    OTHER_TOPIC
} from './model.js';
import { formatRangePct, rangeTone } from '../auction/range-display.js';

/** 造一行「库行」：默认只给必要字段，个别用例再覆盖 */
function row(stock, topicsText, rangePct, extra) {
    return Object.assign({
        stock: stock,
        code: '000000',
        topicsText: topicsText,
        rangePct: rangePct === undefined ? null : rangePct,
        rangeDays: (rangePct === undefined || rangePct === null) ? 0 : 10,
        fa: {},
        faCount: 0,
        faFirst: '',
        continueText: '',
        themeSource: '',
        isSt: false
    }, extra || {});
}

/** 造分类映射：stock → 主题材（模拟 getPrimaryTopicMap 的输出） */
function mapOf(pairs) {
    return new Map(pairs);
}

const FALLBACK_OTHER = function() { return OTHER_TOPIC; };

// ============================================================================
// 一字口径闸门（★ 2026-09-15 修正）
// 判据 = 9:25 竞价涨幅 ≈ 涨停幅度（复用 logic/auction/limit-up.js#isAuctionYiZi）
// 事故背景：旧判据「9:15~9:25 存在任一非空 fa_*」把 09-18 的 121 行全当一字
//          （剔除 8 只 ST 后看板显示 113 只），而其中只有 8 行竞价涨幅达涨停幅度；
//          同日 limit_pool 涨停仅 77 只 ⇒ 一字 ⊆ 涨停 ⇒ 113 根本不可能。
// ============================================================================
describe('isYiziRow 一字判据（竞价涨幅 ≈ 涨停幅度）', () => {
    it('主板竞价涨停 → 一字', () => {
        expect(isYiziRow({ stock: '百通能源', code: '001376', aucPct: '+9.99' })).toBe(true);
        expect(isYiziRow({ stock: '中晶科技', code: '003026', aucPct: '+10.00' })).toBe(true);
    });
    it('容差内也算（涨停价四舍五入到分）：9.94% / 10.10% 都算', () => {
        expect(isYiziRow({ stock: '华纺股份', code: '600448', aucPct: '+9.94' })).toBe(true);
        expect(isYiziRow({ stock: '华软科技', code: '002453', aucPct: '+10.10' })).toBe(true);
    });
    it('创业板 / 科创板按 20% 判定', () => {
        expect(isYiziRow({ stock: '经纬股份', code: '301390', aucPct: '+20.00' })).toBe(true);
        expect(isYiziRow({ stock: '某创业板票', code: '300001', aucPct: '+10.00' })).toBe(false);
    });
    it('北交所按 30% 判定', () => {
        expect(isYiziRow({ stock: '某北交所票', code: '830001', aucPct: '+30.00' })).toBe(true);
        expect(isYiziRow({ stock: '某北交所票', code: '830001', aucPct: '+20.00' })).toBe(false);
    });
    it('⛔ 旧判据的误收样本必须被剔除（9:15 挂过涨停价买单又撤单）', () => {
        expect(isYiziRow({ stock: '丽尚国潮', code: '600738', aucPct: '-0.24' })).toBe(false);
        expect(isYiziRow({ stock: '凯旺科技', code: '301182', aucPct: '0.00' })).toBe(false);
        // 上海物贸 +9.28%：离涨停差 0.72pp —— 是「被剔掉的行里最接近涨停的」，仍然不算一字
        expect(isYiziRow({ stock: '上海物贸', code: '600822', aucPct: '+9.28' })).toBe(false);
    });
    it('§10 竞价涨幅缺失 / 无股票名 → 不是一字（不猜）', () => {
        expect(isYiziRow({ stock: '缺涨幅', code: '600000', aucPct: '' })).toBe(false);
        expect(isYiziRow({ stock: '缺涨幅', code: '600000' })).toBe(false);
        expect(isYiziRow(null)).toBe(false);
        expect(isYiziRow({ code: '600000', aucPct: '+10' })).toBe(false);
    });
});

describe('filterYiziRows 口径闸门（剔除只数必须可解释）', () => {
    const rows = [
        { stock: '百通能源', code: '001376', aucPct: '+9.99' },   // 一字
        { stock: '经纬股份', code: '301390', aucPct: '+20.00' },  // 一字（创业板 20%）
        { stock: '上海物贸', code: '600822', aucPct: '+9.28' },   // 未达幅度
        { stock: '丽尚国潮', code: '600738', aucPct: '-0.24' },   // 未达幅度
        { stock: '缺涨幅', code: '600000', aucPct: '' }            // 无法判定
    ];
    it('只留真一字，并按「未达幅度 / 缺涨幅」分类计数', () => {
        const r = filterYiziRows(rows);
        expect(r.kept).toBe(2);
        expect(r.rows.map(function(x) { return x.stock; })).toEqual(['百通能源', '经纬股份']);
        expect(r.droppedNotLimit).toBe(2);
        expect(r.droppedNoPct).toBe(1);
        expect(r.removed).toBe(3);
    });
    it('不改入参（纯函数）', () => {
        const before = rows.length;
        filterYiziRows(rows);
        expect(rows.length).toBe(before);
    });
    it('空 / 非数组输入 → 全 0，不抛错', () => {
        const r = filterYiziRows(null);
        expect(r.kept).toBe(0);
        expect(r.removed).toBe(0);
        expect(r.rows).toEqual([]);
    });
    it('★ 09-18 形态回归：121 行形态 → 闸门后只剩 8 只（不是 113 只）', () => {
        const eight = [
            { stock: '经纬股份', code: '301390', aucPct: '+20.00' },
            { stock: '福龙马', code: '603686', aucPct: '+10.03' },
            { stock: '中晶科技', code: '003026', aucPct: '+10.00' },
            { stock: '中材科技', code: '002080', aucPct: '+10.00' },
            { stock: '内蒙新华', code: '603230', aucPct: '+10.04' },
            { stock: '百通能源', code: '001376', aucPct: '+9.99' },
            { stock: '华软科技', code: '002453', aucPct: '+10.10' },
            { stock: '华纺股份', code: '600448', aucPct: '+9.94' }
        ];
        const noise = [];
        for (let i = 0; i < 87; i++) noise.push({ stock: '小涨' + i, code: '60000' + (i % 10), aucPct: '+' + ((i % 30) / 10) });
        for (let i = 0; i < 23; i++) noise.push({ stock: '平跌' + i, code: '00000' + (i % 10), aucPct: '-0.24' });
        const r = filterYiziRows(eight.concat(noise));
        expect(r.kept).toBe(8);
        expect(r.removed).toBe(110);
        expect(r.droppedNoPct).toBe(0);
    });
});

describe('limitGapText 可解释文本（只用于提示 / 排查）', () => {
    it('返回「竞价涨幅 / 涨停幅度」', () => {
        expect(limitGapText({ stock: '上海物贸', code: '600822', aucPct: '+9.28' })).toBe('+9.28% / 限10%');
        expect(limitGapText({ stock: '经纬股份', code: '301390', aucPct: '+20.00' })).toBe('+20.00% / 限20%');
    });
    it('无涨幅 → 空串（不伪造 0%）', () => {
        expect(limitGapText({ stock: 'x', code: '600000', aucPct: '' })).toBe('');
    });
});

describe('buildYiziBlocks 行内派生字段（模板直接读，缺一个就静默不渲染 —— 必须有回归）', () => {
    it('首封时刻 firstTimeText 必须透出（P3 回归：该字段缺失 = 股票名后面的时间标凭空消失）', () => {
        const rows = [row('福龙马', '汽车', 12.76, { faFirst: '09:15' })];
        const blocks = buildYiziBlocks(rows, mapOf([['福龙马', '汽车']]), FALLBACK_OTHER);
        expect(blocks[0].stocks[0].firstTimeText).toBe('09:15');
    });
    it('无 faFirst → 空串（模板据空串不渲染，⛔ 不显示 0 / 占位）', () => {
        const rows = [row('某票', '汽车', null, { faFirst: '' })];
        const blocks = buildYiziBlocks(rows, mapOf([['某票', '汽车']]), FALLBACK_OTHER);
        expect(blocks[0].stocks[0].firstTimeText).toBe('');
    });
    it('两个时点封单额都算好（切 toggle 只换显示值，⛔ 不重算分块）', () => {
        const fa = { fa_0915: 1000, fa_0920f: 2000000, fa_0925l: 300000000 };
        const rows = [row('某票', '汽车', 5, { fa: fa, faCount: 3, faFirst: '09:15' })];
        const blocks = buildYiziBlocks(rows, mapOf([['某票', '汽车']]), FALLBACK_OTHER);
        const s = blocks[0].stocks[0];
        expect(s.seal920).toBe(2000000);
        expect(s.seal925).toBe(300000000);
        expect(s.seal920Text).toBe('200万');
        expect(s.seal925Text).toBe('3.00亿');
    });
});

describe('splitThemeText 题材文本切分', () => {
    it('按中英文顿号/逗号/分号/竖线切开并 trim', () => {
        expect(splitThemeText('机器人、人工智能')).toEqual(['机器人', '人工智能']);
        expect(splitThemeText('AI应用,存储芯片；白酒|军工')).toEqual(['AI应用', '存储芯片', '白酒', '军工']);
    });

    it('过滤无效题材（题材33 / 纯数字 / 单字 / 其它）', () => {
        expect(splitThemeText('题材33、1234、人、其它、机器人')).toEqual(['机器人']);
    });

    it('空格不是题材分隔符（与 cleanTopicsForDisplay 同口径，避免把一整句当题材）', () => {
        // 上游题材字段用「、」分隔；这里刻意不把空格当分隔符，保持与既有清洗口径一致
        expect(splitThemeText('机器人 人工智能')).toEqual(['机器人 人工智能']);
    });

    it('空值/非字符串 → 空数组', () => {
        expect(splitThemeText('')).toEqual([]);
        expect(splitThemeText(null)).toEqual([]);
        expect(splitThemeText(undefined)).toEqual([]);
    });
});

describe('resolveYiziTopics 题材来源三级优先（接口 kpl → 接口 xgb → 共享题材库）', () => {
    it('① 开盘啦题材有值 → 用 kpl，且不再看 xgb / 库', () => {
        const r = resolveYiziTopics({ themeKpl: '机器人、人工智能', themeXgb: '算力' }, '白酒');
        expect(r.source).toBe('kpl');
        expect(r.text).toBe('机器人,人工智能');
    });

    it('② kpl 无（或全是无效题材）→ 回退 xgb', () => {
        expect(resolveYiziTopics({ themeKpl: '', themeXgb: '算力、液冷' }, '白酒'))
            .toEqual({ text: '算力,液冷', source: 'xgb' });
        // 「题材33」是占位符，等价于没有题材 → 继续往下取
        expect(resolveYiziTopics({ themeKpl: '题材33', themeXgb: '算力' }, ''))
            .toEqual({ text: '算力', source: 'xgb' });
    });

    it('③ 两个接口字段都没 → 回退共享题材库', () => {
        expect(resolveYiziTopics({ themeKpl: null, themeXgb: null }, '存储芯片、AI应用'))
            .toEqual({ text: '存储芯片,AI应用', source: 'lib' });
    });

    it('④ 全都没有 → 空文本、来源空（UI 显示 "-"，可被「无题材」开关筛出）', () => {
        expect(resolveYiziTopics({ themeKpl: '', themeXgb: '' }, '')).toEqual({ text: '', source: '' });
        expect(resolveYiziTopics(null, null)).toEqual({ text: '', source: '' });
    });

    it('themeSourceLabel 给出可读来源标签', () => {
        expect(themeSourceLabel('kpl')).toBe('开盘啦');
        expect(themeSourceLabel('xgb')).toBe('选股宝');
        expect(themeSourceLabel('lib')).toBe('题材库');
        expect(themeSourceLabel('')).toBe('');
    });
});

describe('sealMoneyAt 封单额的双时点口径（9:20 / 9:25，⛔ 不看 9:15）', () => {
    it('无任何封单证据 → null（⛔ 不伪造 0）', () => {
        expect(sealMoneyAt({ fa: {} }, SEAL_920)).toBe(null);
        expect(sealMoneyAt({ fa: {} }, SEAL_925)).toBe(null);
        expect(sealMoneyAt(null, SEAL_925)).toBe(null);
        expect(sealMoneyAt({ fa: null }, SEAL_925)).toBe(null);
    });

    it('真实形态①：只有 9:15 一笔（丽尚国潮 682812）→ 两个时点都取到它', () => {
        // 线上事实：121 只一字票里 fa_0915 有值 92 只，而 fa_0925l 只有 8 只。
        // 「9:25 口径」在语义上是「9:25 那一刻挂在涨停价上的封单」——没有再成交就沿用最近一笔。
        const r = { fa: { fa_0915: 682812, fa_0916: null, fa_0920f: null, fa_0925l: null } };
        expect(sealMoneyAt(r, SEAL_920)).toBe(682812);
        expect(sealMoneyAt(r, SEAL_925)).toBe(682812);
    });

    it('真实形态②：13 个时点全有（中材科技）→ 9:20 取 fa_0920f、9:25 取 fa_0925l', () => {
        const r = {
            fa: {
                fa_0915: 403119096, fa_0916: 403119096, fa_0917: 403119096, fa_0918: 403119096,
                fa_0919: 403119096, fa_0920: 403119096, fa_0920f: 403119096,
                fa_0921: 403119096, fa_0922: 403119096, fa_0923: 403119096, fa_0924: 403119096,
                fa_0925: 2251723680, fa_0925l: 2251723680
            }
        };
        expect(sealMoneyAt(r, SEAL_920)).toBe(403119096);
        expect(sealMoneyAt(r, SEAL_925)).toBe(2251723680);
    });

    it('9:20 之后才封上 → 9:20 口径为 null，9:25 口径取得到（⛔ 不把后来的值倒灌进早时点）', () => {
        const r = { fa: { fa_0921: 1e8, fa_0925l: 2e8 } };
        expect(sealMoneyAt(r, SEAL_920)).toBe(null);
        expect(sealMoneyAt(r, SEAL_925)).toBe(2e8);
    });

    it('9:25 口径 = 库里 seal_money 的口径（时间上最后一笔非空）', () => {
        // 华瓷股份：9:24 之后就没了 → 9:25 口径应回退到 fa_0924
        const r = { fa: { fa_0915: 1e7, fa_0920f: 20242872, fa_0921: 20242872, fa_0922: 20242872, fa_0923: 20242872, fa_0924: 35293806 } };
        expect(sealMoneyAt(r, SEAL_925)).toBe(35293806);
        expect(sealMoneyAt(r, SEAL_920)).toBe(20242872);
    });

    it('同一时刻多列：后缀 l 晚于无后缀，f 也晚于无后缀（fa_0925l > fa_0925）', () => {
        expect(sealMoneyAt({ fa: { fa_0925: 1e8, fa_0925l: 2e8 } }, SEAL_925)).toBe(2e8);
        expect(sealMoneyAt({ fa: { fa_0925l: 2e8, fa_0925: 1e8 } }, SEAL_925)).toBe(2e8);
        expect(sealMoneyAt({ fa: { fa_0920: 1e8, fa_0920f: 2e8 } }, SEAL_920)).toBe(2e8);
    });

    it('取值不依赖对象的 key 顺序（只用列名里的时刻 + 后缀判定）', () => {
        const a = { fa: { fa_0925l: 2e8, fa_0915: 1e7, fa_0920f: 5e7 } };
        const b = { fa: { fa_0915: 1e7, fa_0920f: 5e7, fa_0925l: 2e8 } };
        expect(sealMoneyAt(a, SEAL_925)).toBe(2e8);
        expect(sealMoneyAt(b, SEAL_925)).toBe(2e8);
        expect(sealMoneyAt(a, SEAL_920)).toBe(5e7);
        expect(sealMoneyAt(b, SEAL_920)).toBe(5e7);
    });

    it('不认识的列名被忽略（⛔ 不猜）；非有限值当作无证据', () => {
        const r = { fa: { fa_nope: 1e9, fa_0915: NaN, fa_0918: Infinity, fa_0920f: 3e7 } };
        expect(sealMoneyAt(r, SEAL_920)).toBe(3e7);
    });
});

describe('isStStock / dropStRows ST 判据与剔除', () => {
    it('isSt === true → 是 ST（上游标注，权威）', () => {
        expect(isStStock({ stock: '某某股份', isSt: true })).toBe(true);
    });

    it('简称自带 ST / *ST → 是 ST（is_st 缺失时的兜底）', () => {
        expect(isStStock({ stock: 'ST巨轮', isSt: null })).toBe(true);
        expect(isStStock({ stock: '*ST新材', isSt: null })).toBe(true);
        expect(isStStock({ stock: 'st某某', isSt: undefined })).toBe(true);
    });

    it('§10：is_st 为 null 且简称不带 ST → 不算 ST（⛔ 不无依据地剔行）', () => {
        expect(isStStock({ stock: '兆易创新', isSt: null })).toBe(false);
        expect(isStStock({ stock: '兆易创新', isSt: undefined })).toBe(false);
        expect(isStStock({ stock: '兆易创新', isSt: false })).toBe(false);
    });

    it('dropStRows：剔除 ST 并如实返回只数，不改动入参', () => {
        const rows = [
            { stock: '兆易创新', isSt: false },
            { stock: '*ST英飞', isSt: true },
            { stock: '通力科技', isSt: false },
            { stock: 'ST巨轮', isSt: null }
        ];
        const snapshot = JSON.stringify(rows);
        const out = dropStRows(rows);
        expect(out.rows.map(r => r.stock)).toEqual(['兆易创新', '通力科技']);
        expect(out.removed).toBe(2);
        expect(JSON.stringify(rows)).toBe(snapshot);
    });

    it('dropStRows：空输入 / 非数组 → 空结果、0 剔除', () => {
        expect(dropStRows([])).toEqual({ rows: [], removed: 0 });
        expect(dropStRows(null)).toEqual({ rows: [], removed: 0 });
    });
});

describe('buildYiziBlocks 题材分块（块内度量 = 十日涨幅，与涨跌停看板同口径）', () => {
    it('组序：同题材聚块 → 组大者前 → 「其它」置底', () => {
        const rows = [
            row('A', '存储芯片', 5),
            row('B', '白酒', 8),
            row('C', '存储芯片', 12),
            row('D', '', 30)                // 无题材 → 其它
        ];
        const primaryMap = mapOf([['A', '存储芯片'], ['B', '白酒'], ['C', '存储芯片']]);
        const blocks = buildYiziBlocks(rows, primaryMap, FALLBACK_OTHER);
        // 存储芯片 2 只（组最大 → 最前）；「其它」永远置底，即使与白酒同为 1 只
        expect(blocks.map(b => b.topic)).toEqual(['存储芯片', '白酒', OTHER_TOPIC]);
        expect(blocks[0].count).toBe(2);
        expect(blocks[1].topic).toBe('白酒');
        expect(blocks[2].topic).toBe(OTHER_TOPIC);
        expect(blocks[2].count).toBe(1);
    });

    it('块内按十日涨幅降序 → 序号连续 → 龙头 = 块内涨幅最高者（非首行原顺序）', () => {
        const rows = [
            row('A', '存储芯片', 3.1),
            row('B', '存储芯片', 22.5),
            row('C', '存储芯片', 11.0)
        ];
        const primaryMap = mapOf([['A', '存储芯片'], ['B', '存储芯片'], ['C', '存储芯片']]);
        const blocks = buildYiziBlocks(rows, primaryMap, FALLBACK_OTHER);
        expect(blocks.length).toBe(1);
        const b = blocks[0];
        expect(b.stocks.map(s => s.stock)).toEqual(['B', 'C', 'A']);
        expect(b.stocks.map(s => s.seq)).toEqual([1, 2, 3]);
        expect(b.stocks.map(s => s.rangePct)).toEqual([22.5, 11.0, 3.1]);
        expect(b.hasLeader).toBe(true);
        expect(b.leaderStock).toBe('B');
        expect(b.leaderMetric).toBe(22.5);
        expect(b.leaderRangePct).toBe(22.5);
        expect(b.stocks[0].isLeader).toBe(true);
        expect(b.stocks[1].isLeader).toBe(false);
    });

    it('封单额【不参与】排序/选龙头（切「9点20」不会改龙头）', () => {
        const rows = [
            row('A', '存储芯片', 3.1, { fa: { fa_0915: 9e8 } }),
            row('B', '存储芯片', 22.5, { fa: { fa_0915: 1e7 } })
        ];
        const pm = mapOf([['A', '存储芯片'], ['B', '存储芯片']]);
        const b = buildYiziBlocks(rows, pm, FALLBACK_OTHER)[0];
        // 封单额 A 远大于 B，但龙头仍按十日涨幅取 B
        expect(b.leaderStock).toBe('B');
        expect(b.stocks.map(s => s.stock)).toEqual(['B', 'A']);
    });

    it('无十日涨幅的行置底并保持相对顺序，且不被选为龙头', () => {
        const rows = [
            row('A', '存储芯片', null),
            row('B', '存储芯片', 12),
            row('C', '存储芯片', null)
        ];
        const primaryMap = mapOf([['A', '存储芯片'], ['B', '存储芯片'], ['C', '存储芯片']]);
        const b = buildYiziBlocks(rows, primaryMap, FALLBACK_OTHER)[0];
        expect(b.stocks.map(s => s.stock)).toEqual(['B', 'A', 'C']);
        expect(b.leaderStock).toBe('B');
        expect(b.stocks[0].rangePct).toBe(12);
        expect(b.stocks[1].rangePct).toBe(null);
    });

    it('整块都没有十日涨幅 → 不选龙头（⛔ 绝不硬点一个）', () => {
        const rows = [row('A', '存储芯片', null), row('B', '存储芯片', null)];
        const primaryMap = mapOf([['A', '存储芯片'], ['B', '存储芯片']]);
        const b = buildYiziBlocks(rows, primaryMap, FALLBACK_OTHER)[0];
        expect(b.hasLeader).toBe(false);
        expect(b.leaderStock).toBe('');
        expect(b.leaderRangePct).toBe(null);
        expect(b.stocks.every(s => !s.isLeader)).toBe(true);
    });

    it('派生展示字段随行透出（双时点封单额 / 十日涨幅文本 / 连板 / 题材来源）', () => {
        const rows = [row('中材科技', '存储芯片', 22.5, {
            fa: { fa_0915: 403119096, fa_0920f: 403119096, fa_0925l: 2251723680 },
            faCount: 13, faFirst: '09:15', continueText: '二板', themeSource: 'kpl'
        })];
        const primaryMap = mapOf([['中材科技', '存储芯片']]);
        const s = buildYiziBlocks(rows, primaryMap, FALLBACK_OTHER)[0].stocks[0];
        expect(s.seal920).toBe(403119096);
        expect(s.seal920Text).toBe('4.03亿');
        expect(s.seal920Tone).toBe('strong');
        expect(s.seal925).toBe(2251723680);
        expect(s.seal925Text).toBe('22.52亿');
        expect(s.seal925Tone).toBe('strong');
        expect(s.rangePct).toBe(22.5);
        expect(s.rangeDays).toBe(10);
        expect(s.rangeText).toBe('+22.50%');
        expect(s.rangeTone).toBe('up');
        expect(s.continueText).toBe('二板');
        expect(s.themeSource).toBe('kpl');
        expect(s.themeSourceLabel).toBe('开盘啦');
        expect(s.faCount).toBe(13);
        expect(s.faFirst).toBe('09:15');
    });

    it('只给 9:15 一笔时：两个时点文本相同，且不渲染成「无封单」', () => {
        const rows = [row('丽尚国潮', '白酒', -3.2, { fa: { fa_0915: 682812 } })];
        const pm = mapOf([['丽尚国潮', '白酒']]);
        const s = buildYiziBlocks(rows, pm, FALLBACK_OTHER)[0].stocks[0];
        expect(s.seal920Text).toBe('68万');
        expect(s.seal925Text).toBe('68万');
        expect(s.rangeText).toBe('-3.20%');
        expect(s.rangeTone).toBe('down');
    });

    it('题材展示用英文逗号且与「有无题材」同源：无题材 → "-" 且 hasTopic=false', () => {
        const rows = [row('A', '存储芯片,AI应用', 5), row('B', '', 8)];
        const primaryMap = mapOf([['A', '存储芯片']]);
        const blocks = buildYiziBlocks(rows, primaryMap, FALLBACK_OTHER);
        const a = blocks[0].stocks.find(s => s.stock === 'A');
        const otherBlock = blocks.find(b => b.topic === OTHER_TOPIC);
        const b = otherBlock.stocks.find(s => s.stock === 'B');
        expect(a.topicsDisplay).toBe('存储芯片,AI应用');
        expect(a.hasTopic).toBe(true);
        expect(b.topicsDisplay).toBe('-');
        expect(b.hasTopic).toBe(false);
    });

    it('不改动入参（纯函数）', () => {
        const rows = [row('A', '存储芯片', 5), row('B', '白酒', 8)];
        const snapshot = JSON.stringify(rows);
        const pm = mapOf([['A', '存储芯片'], ['B', '白酒']]);
        buildYiziBlocks(rows, pm, FALLBACK_OTHER);
        expect(JSON.stringify(rows)).toBe(snapshot);
    });

    it('空输入 → 空数组', () => {
        expect(buildYiziBlocks([], new Map(), FALLBACK_OTHER)).toEqual([]);
        expect(buildYiziBlocks(null, new Map(), FALLBACK_OTHER)).toEqual([]);
    });
});

describe('filterYiziNoTopicBlocks「无题材」视图过滤', () => {
    function sample() {
        const rows = [
            row('A', '存储芯片', 25),
            row('B', '', 13),
            row('C', '', 11),
            row('D', '白酒', 20)
        ];
        const primaryMap = mapOf([['A', '存储芯片'], ['D', '白酒']]);
        return buildYiziBlocks(rows, primaryMap, FALLBACK_OTHER);
    }

    it('只留无题材的行，序号从 1 重排，count 同步', () => {
        const out = filterYiziNoTopicBlocks(sample());
        expect(out.length).toBe(1);
        expect(out[0].topic).toBe(OTHER_TOPIC);
        expect(out[0].count).toBe(2);
        expect(out[0].stocks.map(s => s.stock)).toEqual(['B', 'C']);
        expect(out[0].stocks.map(s => s.seq)).toEqual([1, 2]);
    });

    it('过滤态下一律不选龙头（免得凭空造出错误的题材结论）', () => {
        const out = filterYiziNoTopicBlocks(sample());
        expect(out[0].hasLeader).toBe(false);
        expect(out[0].leaderStock).toBe('');
        expect(out[0].leaderRangePct).toBe(null);
        expect(out[0].stocks.every(s => !s.isLeader)).toBe(true);
    });

    it('没有无题材股票 → 返回空数组', () => {
        const rows = [row('A', '存储芯片', 5)];
        const blocks = buildYiziBlocks(rows, mapOf([['A', '存储芯片']]), FALLBACK_OTHER);
        expect(filterYiziNoTopicBlocks(blocks)).toEqual([]);
    });
});

describe('展示口径', () => {
    it('formatSealMoney：≥1亿 → 亿；<1亿 → 万；无值/0 → 空串（不显示 "0亿"）', () => {
        expect(formatSealMoney(3.2e8)).toBe('3.20亿');
        expect(formatSealMoney(3200e4)).toBe('3200万');
        expect(formatSealMoney(0)).toBe('');
        expect(formatSealMoney(null)).toBe('');
        expect(formatSealMoney(undefined)).toBe('');
        expect(formatSealMoney(NaN)).toBe('');
    });

    it('sealTone：≥1亿 → strong；>0 且 <1亿 → normal；无值/0 → flat', () => {
        expect(sealTone(1e8)).toBe('strong');
        expect(sealTone(9.9e7)).toBe('normal');
        expect(sealTone(0)).toBe('flat');
        expect(sealTone(null)).toBe('flat');
    });

    it('formatRangePct：满窗 → "+12.34%"；缺腿 → 带 "(7/10日)"；无值 → "-"（⛔ 不补 0）', () => {
        expect(formatRangePct(12.34, 10)).toBe('+12.34%');
        expect(formatRangePct(-3.1, 10)).toBe('-3.10%');
        expect(formatRangePct(12.34, 7)).toBe('+12.34%(7/10日)');
        expect(formatRangePct(0, 10)).toBe('+0.00%');
        expect(formatRangePct(null, 0)).toBe('-');
        expect(formatRangePct(undefined, 10)).toBe('-');
        expect(formatRangePct(NaN, 10)).toBe('-');
    });

    it('rangeTone 涨红跌绿（>0 up / <0 down / 0 与无值 flat）', () => {
        expect(rangeTone(12.34)).toBe('up');
        expect(rangeTone(-3.1)).toBe('down');
        expect(rangeTone(0)).toBe('flat');
        expect(rangeTone(null)).toBe('flat');
    });
});

describe('yiziSignature 内容指纹', () => {
    const pm = mapOf([['A', '存储芯片']]);
    const sig = function(r, date) {
        return yiziSignature(buildYiziBlocks([r], pm, FALLBACK_OTHER), date || '2026-09-18');
    };

    it('同内容同指纹；日期变化 → 指纹变化', () => {
        const r = row('A', '存储芯片', 12, { fa: { fa_0915: 1e8 } });
        expect(sig(r)).toBe(sig(row('A', '存储芯片', 12, { fa: { fa_0915: 1e8 } })));
        expect(sig(r)).not.toBe(sig(r, '2026-09-17'));
    });

    it('十日涨幅变化 → 指纹变化（块内排序/龙头会随之改变）', () => {
        expect(sig(row('A', '存储芯片', 12))).not.toBe(sig(row('A', '存储芯片', 13)));
    });

    it('连板标变化 → 指纹变化', () => {
        const a = row('A', '存储芯片', 12, { continueText: '首板' });
        const b = row('A', '存储芯片', 12, { continueText: '二板' });
        expect(sig(a)).not.toBe(sig(b));
    });

    it('任一时点的封单额变化 → 指纹变化（保证切 toggle 不会看到陈旧值）', () => {
        const base = { fa_0915: 1e8, fa_0920f: 2e8, fa_0925l: 3e8 };
        const s0 = sig(row('A', '存储芯片', 12, { fa: Object.assign({}, base) }));
        const s1 = sig(row('A', '存储芯片', 12, { fa: Object.assign({}, base, { fa_0920f: 2.5e8 }) }));
        const s2 = sig(row('A', '存储芯片', 12, { fa: Object.assign({}, base, { fa_0925l: 3.5e8 }) }));
        expect(s0).not.toBe(s1);
        expect(s0).not.toBe(s2);
    });
});

describe('isBoardDateAligned 日期对齐判据（§26 切日，防空窗期显示上一天的行）', () => {
    it('同一日期 → true（这一天的快照可渲染）', () => {
        expect(isBoardDateAligned('2026-09-17', '2026-09-17')).toBe(true);
    });

    it('日期不一致 → false（调用方据此显示「加载中」，⛔ 不得渲染另一天的行）', () => {
        // 真实事故形态：页头已切到 09-14，状态里仍是 09-17 的 129 只
        expect(isBoardDateAligned('2026-09-17', '2026-09-14')).toBe(false);
    });

    it('任一侧为空 → false（初始态 / 状态未就绪都不算对齐，不冒险渲染）', () => {
        expect(isBoardDateAligned('', '2026-09-17')).toBe(false);
        expect(isBoardDateAligned('2026-09-17', '')).toBe(false);
        expect(isBoardDateAligned(null, '2026-09-17')).toBe(false);
        expect(isBoardDateAligned(undefined, undefined)).toBe(false);
    });
});
