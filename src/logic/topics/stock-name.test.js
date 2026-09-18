// stock-name.test.js — 股票名归一化的回归测试
//
// ⚠️ 用例样本【取自 2026-09-18 线上真实数据】：涨停池 77 只与共享题材库 1131 行对撞后，
//    这 3 只在库里有题材却被判成「无题材」—— 它们就是本模块存在的理由，锁死这几个真实形态。
import { describe, it, expect } from 'vitest';
import { normalizeStockName, isSameStockName } from './stock-name.js';

describe('normalizeStockName 股票名归一化', () => {
    it('剔掉名称中间的半角空格（七 匹 狼 → 七匹狼）', () => {
        expect(normalizeStockName('七 匹 狼')).toBe('七匹狼');
        expect(normalizeStockName('远 望 谷')).toBe('远望谷');
    });

    it('剔掉名称中间的全角空格 U+3000（万　科Ａ → 万科A）', () => {
        expect(normalizeStockName('万\u3000科Ａ')).toBe('万科A');
        expect(normalizeStockName('万\u00a0科Ａ')).toBe('万科A'); // 不换行空格 U+00A0
    });

    it('全角字母/数字 → 半角（万科Ａ → 万科A、深华发Ａ → 深华发A）', () => {
        expect(normalizeStockName('万科Ａ')).toBe('万科A');
        expect(normalizeStockName('深华发Ａ')).toBe('深华发A');
        expect(normalizeStockName('ＳＴ中安')).toBe('ST中安');
        expect(normalizeStockName('万１')).toBe('万1');
    });

    it('统一大写（万科a → 万科A）', () => {
        expect(normalizeStockName('万科a')).toBe('万科A');
        expect(normalizeStockName('st中安')).toBe('ST中安');
    });

    it('幂等：归一化两次结果相同（索引重建/多次比较不会漂移）', () => {
        const samples = ['七 匹 狼', '万\u3000科Ａ', '深华发Ａ', '远 望 谷', '贵州茅台', 'ＳＴ中安'];
        samples.forEach(function(s) {
            const once = normalizeStockName(s);
            expect(normalizeStockName(once)).toBe(once);
        });
    });

    it('空值/非字符串入参 → 空串（不抛错）', () => {
        expect(normalizeStockName(null)).toBe('');
        expect(normalizeStockName(undefined)).toBe('');
        expect(normalizeStockName('')).toBe('');
        expect(normalizeStockName('   ')).toBe('');
        expect(normalizeStockName('\u3000\u3000')).toBe('');
        expect(normalizeStockName(600371)).toBe('600371');
    });

    it('⛔ 不做模糊匹配：不同的股票名归一化后仍不同（误配比漏配严重）', () => {
        expect(normalizeStockName('招商银行')).not.toBe(normalizeStockName('招商证券'));
        expect(normalizeStockName('中国平安')).not.toBe(normalizeStockName('平安银行'));
    });

    it('中文不被改动（只处理空白 + 全角 ASCII 区）', () => {
        expect(normalizeStockName('贵州茅台')).toBe('贵州茅台');
        expect(normalizeStockName('经纬股份')).toBe('经纬股份');
    });
});

describe('isSameStockName 同票判定', () => {
    it('三个真实事故样本（名单名 ↔ 库名）判为同一只', () => {
        expect(isSameStockName('七 匹 狼', '七匹狼')).toBe(true);
        expect(isSameStockName('万  科Ａ', '万科A')).toBe(true);
        expect(isSameStockName('远 望 谷', '远望谷')).toBe(true);
        expect(isSameStockName('深华发Ａ', '深华发A')).toBe(true);
    });

    it('不同股票名判为不同（不误合）', () => {
        expect(isSameStockName('招商银行', '招商证券')).toBe(false);
    });

    it('任一侧为空 → false（空名不参与匹配，避免全部命中空键）', () => {
        expect(isSameStockName('', '万科A')).toBe(false);
        expect(isSameStockName('万科A', null)).toBe(false);
        expect(isSameStockName(null, null)).toBe(false);
    });
});
