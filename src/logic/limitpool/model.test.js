// model.test.js — 「涨跌停」看板纯函数模型层的回归测试
// 覆盖：粘贴解析、十日涨幅展示口径、题材分块（组序 / 组内序 / 龙头 / 其它置底 / 不改入参）。
import { describe, it, expect } from 'vitest';
import {
    parseTopicPaste,
    buildTopicBlocks,
    formatRangePct,
    rangeTone,
    formatSealMoney,
    OTHER_TOPIC
} from './model.js';

describe('parseTopicPaste 粘贴解析', () => {
    it('「股票名 题材,题材」标准格式', () => {
        const r = parseTopicPaste('兆易创新 存储芯片,AI应用');
        expect(r.rows).toEqual([{ stock: '兆易创新', code: '', topics: ['存储芯片', 'AI应用'] }]);
        expect(r.skipped).toBe(0);
    });

    it('代码可出现在任意位置（含带后缀写法），会被摘出来且不进题材', () => {
        const r = parseTopicPaste('600000 平安银行 银行\n平安银行 600000.SH 银行');
        expect(r.rows.length).toBe(1);
        expect(r.rows[0].code).toBe('600000');
        expect(r.rows[0].topics).toEqual(['银行']);
    });

    it('去掉行首序号；多分隔符（空格/逗号/顿号/冒号/竖线）都能切', () => {
        const r = parseTopicPaste('1. 兆易创新：存储芯片、AI应用\n2) 贵州茅台|白酒');
        expect(r.rows.map(x => x.stock)).toEqual(['兆易创新', '贵州茅台']);
        expect(r.rows[0].topics).toEqual(['存储芯片', 'AI应用']);
        expect(r.rows[1].topics).toEqual(['白酒']);
    });

    it('同股票多行 → 题材合并去重（不覆盖）', () => {
        const r = parseTopicPaste('兆易创新 存储芯片\n兆易创新 AI应用,存储芯片');
        expect(r.rows.length).toBe(1);
        expect(r.rows[0].topics).toEqual(['存储芯片', 'AI应用']);
    });

    it('无效题材被过滤（题材33 / 纯数字 / 单字 / 其它）；只剩股票名的行计入 skipped', () => {
        const r = parseTopicPaste('兆易创新 题材33 1234 人 其它\n只有名字');
        expect(r.rows.length).toBe(0);
        expect(r.skipped).toBe(2);
        expect(r.totalLines).toBe(2);
    });

    it('空文本 / 非字符串 → 空结果（不抛错）', () => {
        expect(parseTopicPaste('').rows).toEqual([]);
        expect(parseTopicPaste(null).rows).toEqual([]);
        expect(parseTopicPaste(undefined).totalLines).toBe(0);
    });
});

describe('formatRangePct 十日涨幅展示口径', () => {
    it('无值 → "-"（绝不补 0）', () => {
        expect(formatRangePct(null, 0)).toBe('-');
        expect(formatRangePct(undefined, 3)).toBe('-');
        expect(formatRangePct(NaN, 3)).toBe('-');
    });
    it('满窗 → 带符号两位小数', () => {
        expect(formatRangePct(12.345, 10)).toBe('+12.35%');
        expect(formatRangePct(-3.2, 10)).toBe('-3.20%');
        expect(formatRangePct(0, 10)).toBe('+0.00%');
    });
    it('缺腿 → 明示 N/10日（与早盘竞价看板同一约定）', () => {
        expect(formatRangePct(5.5, 7)).toBe('+5.50%(7/10日)');
    });
});

describe('rangeTone / formatSealMoney', () => {
    it('涨红跌绿：tone 只给方向', () => {
        expect(rangeTone(1)).toBe('up');
        expect(rangeTone(-1)).toBe('down');
        expect(rangeTone(0)).toBe('flat');
        expect(rangeTone(null)).toBe('flat');
    });
    it('封单额：亿 / 万，0 或无效 → 空串', () => {
        expect(formatSealMoney(123456789)).toBe('1.23亿');
        expect(formatSealMoney(5800000)).toBe('580万');
        expect(formatSealMoney(0)).toBe('');
        expect(formatSealMoney(null)).toBe('');
    });
});

describe('buildTopicBlocks 题材分块', () => {
    const rows = [
        { stock: '甲', code: '000001', continueText: '首板' },
        { stock: '乙', code: '000002', continueText: '2连板' },
        { stock: '丙', code: '000003', continueText: '3连板' },
        { stock: '丁', code: '000004', continueText: '' }
    ];
    const primaryMap = new Map([['甲', 'A题材'], ['乙', 'B题材'], ['丙', 'B题材']]);
    // 丁 不在整表分类里 → 走单票兜底
    const fallback = (row) => (row.stock === '丁' ? 'C题材' : OTHER_TOPIC);
    const rangeMap = { 甲: 8, 乙: 5, 丙: 20 };

    it('组序 = 组大小降序 → 题材名稳定；「其它」置底（与早盘竞价题材 toggle 同源）', () => {
        const blocks = buildTopicBlocks(rows, primaryMap, fallback, (r) => ({ pct: rangeMap[r.stock] ?? null, days: 10 }));
        expect(blocks.map(b => b.topic)).toEqual(['B题材', 'A题材', 'C题材']);
        expect(blocks[0].count).toBe(2);
    });

    it('组内按十日涨幅降序 → 序号即排名；第一名是龙头', () => {
        const blocks = buildTopicBlocks(rows, primaryMap, fallback, (r) => ({ pct: rangeMap[r.stock] ?? null, days: 10 }));
        const b = blocks[0];
        expect(b.stocks.map(s => s.stock)).toEqual(['丙', '乙']);
        expect(b.stocks.map(s => s.seq)).toEqual([1, 2]);
        expect(b.stocks[0].isLeader).toBe(true);
        expect(b.stocks[1].isLeader).toBe(false);
        expect(b.leaderStock).toBe('丙');
        expect(b.leaderPct).toBe(20);
        expect(b.hasLeader).toBe(true);
    });

    it('无有效十日涨幅的股票置底，且不产生龙头（不猜）', () => {
        const blocks = buildTopicBlocks(rows, primaryMap, fallback, () => ({ pct: null, days: 0 }));
        const b = blocks[0];
        expect(b.hasLeader).toBe(false);
        expect(b.leaderStock).toBe('');
        expect(b.stocks.map(s => s.stock)).toEqual(['乙', '丙']); // 保持原相对顺序
        expect(b.stocks[0].isLeader).toBe(false);
    });

    it('部分有值：有值的排在前面，龙头 = 有值中的最高者', () => {
        const blocks = buildTopicBlocks(rows, primaryMap, fallback, (r) => (r.stock === '丙' ? { pct: 20, days: 10 } : { pct: null, days: 0 }));
        const b = blocks[0];
        expect(b.stocks.map(s => s.stock)).toEqual(['丙', '乙']);
        expect(b.hasLeader).toBe(true);
        expect(b.leaderStock).toBe('丙');
    });

    it('空输入 → 空数组；不改动入参', () => {
        expect(buildTopicBlocks([], primaryMap, fallback, () => null)).toEqual([]);
        const snapshot = JSON.stringify(rows);
        buildTopicBlocks(rows, primaryMap, fallback, (r) => ({ pct: rangeMap[r.stock] ?? null, days: 10 }));
        expect(JSON.stringify(rows)).toBe(snapshot);
    });

    it('透传 topicsText（编排层预置的全题材文本），供行内展示；缺省为空串', () => {
        const withTopics = rows.map(r => ({ ...r, topicsText: '题材' + r.stock }));
        const blocks = buildTopicBlocks(withTopics, primaryMap, fallback, () => ({ pct: 1, days: 10 }));
        expect(blocks[0].stocks.every(s => s.topicsText.indexOf('题材') === 0)).toBe(true);
        const noTopics = buildTopicBlocks(rows, primaryMap, fallback, () => ({ pct: 1, days: 10 }));
        expect(noTopics[0].stocks.every(s => s.topicsText === '')).toBe(true);
    });
});
