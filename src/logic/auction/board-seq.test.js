// board-seq.test.js — 屏幕「序号」的主板口径（用户 2026-10-25 口径）
//
// 锁死四件事：
//   ① 非主板【位置不变、不占序号】⇒ 主板名次 1,2,3… 与规则文案的「第 N 名」一致；
//   ② 只在区间涨幅模式（十日 / 20日）生效，其它模式一律不接管（§11 零行为变化）；
//   ③ 判据是行上的 isHighLimitBoard（= isMainBoardRankEligible 的补集，§6）；
//   ④ 判不出（字段缺失）⇒ 当主板占号（§40 不猜成非主板）。

import { describe, it, expect } from 'vitest';
import { buildMainBoardSeq, isRangeRankMode } from './board-seq.js';

/** 造一行：main=true 主板 / false 非主板（mock isHighLimitBoard = 非主板） */
function row(name, main) {
    return { stock: name, isHighLimitBoard: main === false };
}

const RANGE10 = { byRangePct: true };
const RANGE20 = { byRangePct20: true };

describe('board-seq · 区间涨幅模式：主板名次', function() {
    it('★ 用户 10-15 的原场景：前 10 行里有 2 只非主板 ⇒ 冰山冷热 = 9（不再显示 11）', function() {
        // 顺序照抄屏幕：第 1~10 行里第 5、第 7 行是非主板
        const items = [
            row('甲', true), row('乙', true), row('丙', true), row('丁', true),
            row('创业A', false),            // 第 5 行：非主板 → 不占号
            row('戊', true),
            row('科创B', false),            // 第 7 行：非主板 → 不占号
            row('己', true), row('庚', true),
            row('辛', true),                // 主板第 9 名
            row('冰山冷热', true)           // 屏幕第 11 行 ⇒ 主板第 10 名？
        ];
        const seq = buildMainBoardSeq(items, RANGE10);
        // 两只非主板空号
        expect(seq[4]).toEqual({ seqNo: 0, seqBlank: true });
        expect(seq[6]).toEqual({ seqNo: 0, seqBlank: true });
        // 主板自己 1..9：辛（屏幕第 10 行）= 8，冰山冷热（屏幕第 11 行）= 9
        expect(seq[9].seqNo).toBe(8);
        expect(seq[10].seqNo).toBe(9);
        // 位置不变：行数与顺序都没被动过
        expect(items.length).toBe(11);
        expect(items[10].stock).toBe('冰山冷热');
    });

    it('★ 两只非主板正好都排在它前面 ⇒ 屏幕第 11 行 = 主板第 9 名（与文案一致）', function() {
        const items = [
            row('甲', true), row('乙', true), row('创业A', false), row('丙', true),
            row('丁', true), row('戊', true), row('科创B', false), row('己', true),
            row('庚', true), row('辛', true), row('冰山冷热', true)
        ];
        const seq = buildMainBoardSeq(items, RANGE10);
        expect(seq.filter(s => s.seqBlank).length).toBe(2);
        // 冰山冷热 = 屏幕第 11 行、主板第 9 名 —— 这正是用户要的「序号 9」
        expect(seq[10].seqNo).toBe(9);
    });

    it('全都是主板 ⇒ 序号就是 1..N（与改动前逐字相同）', function() {
        const items = [row('甲', true), row('乙', true), row('丙', true)];
        expect(buildMainBoardSeq(items, RANGE10)).toEqual([
            { seqNo: 1, seqBlank: false },
            { seqNo: 2, seqBlank: false },
            { seqNo: 3, seqBlank: false }
        ]);
    });

    it('★ 非主板排在第一位 ⇒ 它空着，第二行是 1（不是 2）', function() {
        const items = [row('创业A', false), row('甲', true), row('乙', true)];
        const seq = buildMainBoardSeq(items, RANGE10);
        expect(seq[0]).toEqual({ seqNo: 0, seqBlank: true });
        expect(seq[1].seqNo).toBe(1);
        expect(seq[2].seqNo).toBe(2);
    });

    it('全是非主板 ⇒ 全部空号（⛔ 不出现 1,2,3 这种假名次）', function() {
        const items = [row('创业A', false), row('科创B', false)];
        expect(buildMainBoardSeq(items, RANGE10).every(s => s.seqBlank === true && s.seqNo === 0)).toBe(true);
    });

    it('20日涨幅模式同款（两个区间涨幅模式共用一套口径）', function() {
        const items = [row('甲', true), row('创业A', false), row('乙', true)];
        const seq = buildMainBoardSeq(items, RANGE20);
        expect(seq[0].seqNo).toBe(1);
        expect(seq[1].seqBlank).toBe(true);
        expect(seq[2].seqNo).toBe(2);
    });
});

describe('board-seq · 其它模式不接管（§11）', function() {
    it('★ 非区间涨幅模式 ⇒ 一律 seqNo=0 / seqBlank=false（模板回退原来的行号）', function() {
        const items = [row('甲', true), row('创业A', false), row('乙', true)];
        [
            undefined, null, {},
            { byTopic: true }, { byJingYest: true }, { byJingYestRatio: true },
            { byAuctionLeg: true }        // 「竞价口径」是修饰开关，单独打开不算排名模式
        ].forEach(function(st) {
            const seq = buildMainBoardSeq(items, st);
            expect(seq).toEqual([
                { seqNo: 0, seqBlank: false },
                { seqNo: 0, seqBlank: false },
                { seqNo: 0, seqBlank: false }
            ]);
        });
    });

    it('isRangeRankMode：只要有一个区间涨幅开关就是 true', function() {
        expect(isRangeRankMode(RANGE10)).toBe(true);
        expect(isRangeRankMode(RANGE20)).toBe(true);
        expect(isRangeRankMode({ byRangePct: true, byAuctionLeg: true })).toBe(true);
        expect(isRangeRankMode({ byTopic: true })).toBe(false);
        expect(isRangeRankMode(null)).toBe(false);
    });
});

describe('board-seq · §40 判不出不猜', function() {
    it('★ isHighLimitBoard 缺失 ⇒ 当主板占号（不让主板票无故丢号）', function() {
        const items = [{ stock: '甲' }, { stock: '乙', isHighLimitBoard: undefined }];
        const seq = buildMainBoardSeq(items, RANGE10);
        expect(seq[0]).toEqual({ seqNo: 1, seqBlank: false });
        expect(seq[1]).toEqual({ seqNo: 2, seqBlank: false });
    });

    it('isHighLimitBoard 必须是严格的 true 才空号（null / 0 / 字符串不空号）', function() {
        const items = [
            { stock: '甲', isHighLimitBoard: null },
            { stock: '乙', isHighLimitBoard: 0 },
            { stock: '丙', isHighLimitBoard: 'true' }
        ];
        buildMainBoardSeq(items, RANGE10).forEach(function(s) {
            expect(s.seqBlank).toBe(false);
        });
    });

    it('空数组 / null 入参 ⇒ 空结果，不抛错', function() {
        expect(buildMainBoardSeq(null, RANGE10)).toEqual([]);
        expect(buildMainBoardSeq([], RANGE10)).toEqual([]);
        expect(buildMainBoardSeq([null, row('甲', true)], RANGE10)[0].seqBlank).toBe(false);
    });
});
