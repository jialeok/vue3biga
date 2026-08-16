import { describe, it, expect } from 'vitest';
import { parseDieZhangbi, buildDieZhangbi } from './helpers.js';

describe('board/helpers：parseDieZhangbi 解析涨跌比', () => {
  it('正常 "3:2"', () => {
    expect(parseDieZhangbi('3:2')).toEqual({ die: 3, zhang: 2 });
  });

  it('多位数 "10:5"', () => {
    expect(parseDieZhangbi('10:5')).toEqual({ die: 10, zhang: 5 });
  });

  it('空字符串返回 null/null', () => {
    expect(parseDieZhangbi('')).toEqual({ die: null, zhang: null });
  });

  it('无冒号非法值返回 null/null', () => {
    expect(parseDieZhangbi('abc')).toEqual({ die: null, zhang: null });
  });
});

describe('board/helpers：buildDieZhangbi 拼接涨跌比', () => {
  it('正常数字拼为 "3:2"', () => {
    expect(buildDieZhangbi(3, 2)).toBe('3:2');
  });

  it('左值为空串返回空串', () => {
    expect(buildDieZhangbi('', 2)).toBe('');
  });

  it('右值为 null 返回空串', () => {
    expect(buildDieZhangbi(3, null)).toBe('');
  });

  it('0:0 是合法值（非缺失）', () => {
    expect(buildDieZhangbi(0, 0)).toBe('0:0');
  });
});
