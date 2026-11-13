// num-text.test.js — [NUM-TEXT 2026-11-13] DB 文本型数字解析
//
// 事故背景（线上实证）：`market_metrics.auc_pct_chg` 存的是 '+2.30%' 这种**字符串**，
// 直接 `Number()` = NaN ⇒ 静默变 null ⇒ 第二十五条的 D1/D2 两类判据永不触发，
// 而且完全不报错。夹具必须用**真实形态**（带 %），这是本文件存在的理由。
import { describe, it, expect } from 'vitest';
import { numOfText } from './num-text.js';

describe('numOfText —— 文本型数字 ⇒ number|null（§10 宁缺勿错，⛔ 不折 0）', () => {
  it('★ 真实形态：带百分号 + 正负号（库里 auc_pct_chg 的实际样子）', () => {
    expect(numOfText('+2.30%')).toBe(2.3);
    expect(numOfText('-0.84%')).toBe(-0.84);
    expect(numOfText('+10.02%')).toBe(10.02);
    expect(numOfText('-5.04%')).toBe(-5.04);
    expect(numOfText('0.00%')).toBe(0);
    expect(numOfText('9.97%')).toBe(9.97);
  });

  it('纯数字字符串 / 数字本身：原样通过', () => {
    expect(numOfText('10.14')).toBe(10.14);
    expect(numOfText(10.14)).toBe(10.14);
    expect(numOfText(0)).toBe(0);
    expect(numOfText('-1.5')).toBe(-1.5);
    expect(numOfText('+3')).toBe(3);
  });

  it('千分位 / 空白 / 全角（成交量常见 1,234 与全角空格）', () => {
    expect(numOfText('1,234')).toBe(1234);
    expect(numOfText('1，234')).toBe(1234);   // 全角逗号
    expect(numOfText(' 12.5 ')).toBe(12.5);
    expect(numOfText('\u300012.5')).toBe(12.5); // 全角空格
    expect(numOfText('＋2.5%')).toBe(2.5);    // 全角加号
  });

  it('⛔ 缺值 / 脏值 ⇒ null（不返回 0 冒充「没有」）', () => {
    expect(numOfText(null)).toBeNull();
    expect(numOfText(undefined)).toBeNull();
    expect(numOfText('')).toBeNull();
    expect(numOfText('   ')).toBeNull();
    expect(numOfText('--')).toBeNull();
    expect(numOfText('—')).toBeNull();
    expect(numOfText('N/A')).toBeNull();
    expect(numOfText('%')).toBeNull();
    expect(numOfText(NaN)).toBeNull();
    expect(numOfText(Infinity)).toBeNull();
  });

  it('§10 关键区别：0 与 null 是两件事', () => {
    expect(numOfText('0.00%')).toBe(0);      // 真的是 0（如竞价平开）
    expect(numOfText('0.00%')).not.toBeNull();
    expect(numOfText('')).not.toBe(0);
  });
});
