// model.test.js — 「竞价一字」看板纯函数模型层的回归测试
// 覆盖：题材文本切分与「接口→题材库」三级优先、题材分块（组序 / 组内序 / 龙头 / 其它置底 /
//       不改入参 / 无封单额不选龙头）、「无题材」视图过滤、封单额与竞价涨幅的展示分档。
import { describe, it, expect } from 'vitest';
import {
    splitThemeText,
    resolveYiziTopics,
    themeSourceLabel,
    buildYiziBlocks,
    filterYiziNoTopicBlocks,
    formatSealMoney,
    formatAucPct,
    sealTone,
    aucTone,
    yiziSignature,
    OTHER_TOPIC
} from './model.js';

/** 造一行「库行」：默认只给必要字段，个别用例再覆盖 */
function row(stock, topicsText, sealMoney, extra) {
    return Object.assign({
        stock: stock,
        code: '000000',
        topicsText: topicsText,
        sealMoney: sealMoney === undefined ? null : sealMoney,
        aucPct: '',
        aucTurnover: null,
        faCount: 0,
        faFirst: '',
        themeSource: '',
        isSt: false
    }, extra || {});
}

/** 造分类映射：stock → 主题材（模拟 getPrimaryTopicMap 的输出） */
function mapOf(pairs) {
    return new Map(pairs);
}

const FALLBACK_OTHER = function() { return OTHER_TOPIC; };

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

describe('buildYiziBlocks 题材分块', () => {
    it('组序：同题材聚块 → 组大者前 → 「其它」置底', () => {
        const rows = [
            row('A', '存储芯片', 1e8),
            row('B', '白酒', 2e8),
            row('C', '存储芯片', 3e8),
            row('D', '', 9e8)               // 无题材 → 其它
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

    it('块内按封单额降序 → 序号连续 → 龙头 = 块内封单额最大者（非首行原顺序）', () => {
        const rows = [
            row('A', '存储芯片', 1e8),
            row('B', '存储芯片', 5e8),
            row('C', '存储芯片', 3e8)
        ];
        const primaryMap = mapOf([['A', '存储芯片'], ['B', '存储芯片'], ['C', '存储芯片']]);
        const blocks = buildYiziBlocks(rows, primaryMap, FALLBACK_OTHER);
        expect(blocks.length).toBe(1);
        const b = blocks[0];
        expect(b.stocks.map(s => s.stock)).toEqual(['B', 'C', 'A']);
        expect(b.stocks.map(s => s.seq)).toEqual([1, 2, 3]);
        expect(b.stocks.map(s => s.sealMoney)).toEqual([5e8, 3e8, 1e8]);
        expect(b.hasLeader).toBe(true);
        expect(b.leaderStock).toBe('B');
        expect(b.leaderMetric).toBe(5e8);
        expect(b.leaderSeal).toBe(5e8);
        expect(b.stocks[0].isLeader).toBe(true);
        expect(b.stocks[1].isLeader).toBe(false);
    });

    it('无封单额的行置底并保持相对顺序，且不被选为龙头', () => {
        const rows = [
            row('A', '存储芯片', null),
            row('B', '存储芯片', 2e8),
            row('C', '存储芯片', null)
        ];
        const primaryMap = mapOf([['A', '存储芯片'], ['B', '存储芯片'], ['C', '存储芯片']]);
        const b = buildYiziBlocks(rows, primaryMap, FALLBACK_OTHER)[0];
        expect(b.stocks.map(s => s.stock)).toEqual(['B', 'A', 'C']);
        expect(b.leaderStock).toBe('B');
        expect(b.stocks[0].sealMoney).toBe(2e8);
        expect(b.stocks[1].sealMoney).toBe(null);
    });

    it('整块都没有封单额 → 不选龙头（⛔ 绝不硬点一个）', () => {
        const rows = [row('A', '存储芯片', null), row('B', '存储芯片', null)];
        const primaryMap = mapOf([['A', '存储芯片'], ['B', '存储芯片']]);
        const b = buildYiziBlocks(rows, primaryMap, FALLBACK_OTHER)[0];
        expect(b.hasLeader).toBe(false);
        expect(b.leaderStock).toBe('');
        expect(b.leaderSeal).toBe(null);
        expect(b.stocks.every(s => !s.isLeader)).toBe(true);
    });

    it('派生展示字段随行透出（sealText / aucTone / themeSourceLabel / faCount / isSt）', () => {
        const rows = [row('A', '存储芯片', 3.2e8, {
            aucPct: '+10.02', faCount: 5, faFirst: '09:15', themeSource: 'kpl', isSt: true
        })];
        const primaryMap = mapOf([['A', '存储芯片']]);
        const s = buildYiziBlocks(rows, primaryMap, FALLBACK_OTHER)[0].stocks[0];
        expect(s.sealText).toBe('3.20亿');
        expect(s.sealTone).toBe('strong');
        expect(s.aucPct).toBe('+10.02');
        expect(s.aucTone).toBe('up');
        expect(s.themeSource).toBe('kpl');
        expect(s.themeSourceLabel).toBe('开盘啦');
        expect(s.faCount).toBe(5);
        expect(s.faFirst).toBe('09:15');
        expect(s.isSt).toBe(true);
        // 名称里没有 ST 字样 → 需要挂 ST 小标
        expect(s.stTag).toBe(true);
    });

    it('ST 小标去冗余：简称自带 ST/*ST 时不再重复挂标（isSt 仍为 true）', () => {
        const pm = mapOf([['ST巨轮', '机器人']]);
        const s = buildYiziBlocks([row('ST巨轮', '机器人', 1e8, { isSt: true })], pm, FALLBACK_OTHER)[0].stocks[0];
        expect(s.isSt).toBe(true);
        expect(s.stTag).toBe(false);
        const s2 = buildYiziBlocks([row('*ST新材', '机器人', 1e8, { isSt: true })], pm, FALLBACK_OTHER)[0].stocks[0];
        expect(s2.stTag).toBe(false);
        // 非 ST 股：两个都是 false
        const s3 = buildYiziBlocks([row('兆易创新', '机器人', 1e8, { isSt: false })], pm, FALLBACK_OTHER)[0].stocks[0];
        expect(s3.isSt).toBe(false);
        expect(s3.stTag).toBe(false);
    });

    it('题材展示用英文逗号且与「有无题材」同源：无题材 → "-" 且 hasTopic=false', () => {
        const rows = [row('A', '存储芯片,AI应用', 1e8), row('B', '', 2e8)];
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
        const rows = [row('A', '存储芯片', 1e8), row('B', '白酒', 2e8)];
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
            row('A', '存储芯片', 5e8),
            row('B', '', 3e8),
            row('C', '', 1e8),
            row('D', '白酒', 2e8)
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
        expect(out[0].leaderSeal).toBe(null);
        expect(out[0].stocks.every(s => !s.isLeader)).toBe(true);
    });

    it('没有无题材股票 → 返回空数组', () => {
        const rows = [row('A', '存储芯片', 1e8)];
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

    it('formatAucPct：空 → "-"，否则原样（库内已是 "+10.02" 文本口径）', () => {
        expect(formatAucPct('+10.02')).toBe('+10.02');
        expect(formatAucPct('')).toBe('-');
        expect(formatAucPct(null)).toBe('-');
    });

    it('aucTone 涨红跌绿（+10.02 → up / -3.10 → down / 空 → flat）', () => {
        expect(aucTone('+10.02')).toBe('up');
        expect(aucTone('-3.10')).toBe('down');
        expect(aucTone('+0.00')).toBe('flat');
        expect(aucTone('')).toBe('flat');
        expect(aucTone(null)).toBe('flat');
    });

    it('sealTone：≥1亿 → strong；>0 且 <1亿 → normal；无值/0 → flat', () => {
        expect(sealTone(1e8)).toBe('strong');
        expect(sealTone(9.9e7)).toBe('normal');
        expect(sealTone(0)).toBe('flat');
        expect(sealTone(null)).toBe('flat');
    });
});

describe('yiziSignature 内容指纹', () => {
    it('同内容同指纹；封单额/题材变化 → 指纹变化（保证「变了才发布」）', () => {
        const pm = mapOf([['A', '存储芯片']]);
        const s1 = yiziSignature(buildYiziBlocks([row('A', '存储芯片', 1e8)], pm, FALLBACK_OTHER), '2026-09-18');
        const s2 = yiziSignature(buildYiziBlocks([row('A', '存储芯片', 1e8)], pm, FALLBACK_OTHER), '2026-09-18');
        const s3 = yiziSignature(buildYiziBlocks([row('A', '存储芯片', 2e8)], pm, FALLBACK_OTHER), '2026-09-18');
        const s4 = yiziSignature(buildYiziBlocks([row('A', '存储芯片', 1e8)], pm, FALLBACK_OTHER), '2026-09-17');
        expect(s1).toBe(s2);
        expect(s1).not.toBe(s3);
        expect(s1).not.toBe(s4);
    });
});
