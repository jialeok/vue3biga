import { describe, it, expect } from 'vitest';
import {
  parseNoteToFields,
  cleanTopicsForDisplay,
  buildNoteFromFields,
  getDisplayNote,
  extractTopics,
} from './helpers.js';

describe('note/helpers：parseNoteToFields 解析 note', () => {
  it('空字符串返回空字段', () => {
    expect(parseNoteToFields('')).toEqual({ changePct: '', topics: '' });
  });

  it('百分比 "+5.2%"', () => {
    expect(parseNoteToFields('+5.2%')).toEqual({ changePct: '+5.2%', topics: '' });
  });

  it('中文涨跌停关键字', () => {
    expect(parseNoteToFields('涨停')).toEqual({ changePct: '涨停', topics: '' });
    expect(parseNoteToFields('跌停')).toEqual({ changePct: '跌停', topics: '' });
  });

  it('括号提取题材并归一分隔符 ", " -> ","', () => {
    expect(parseNoteToFields('+3%(AI，芯片)')).toEqual({
      changePct: '+3%',
      topics: 'AI,芯片',
    });
  });
});

describe('note/helpers：cleanTopicsForDisplay 清洗展示', () => {
  it('空值返回空串', () => {
    expect(cleanTopicsForDisplay('')).toBe('');
  });

  it('多题材用中文逗号拼接', () => {
    expect(cleanTopicsForDisplay('AI,芯片')).toBe('AI，芯片');
  });

  it('过滤 "题材1" 与纯数字', () => {
    expect(cleanTopicsForDisplay('题材1,3')).toBe('');
  });
});

describe('note/helpers：buildNoteFromFields / getDisplayNote', () => {
  it('拼接 changePct 与 topics', () => {
    expect(buildNoteFromFields('+3%', 'AI,芯片')).toBe('+3%(AI，芯片)');
  });

  it('仅 topics（changePct 空）包括号', () => {
    expect(buildNoteFromFields('', 'AI')).toBe('(AI)');
  });

  it('getDisplayNote 有 changePct/topics 时优先拼', () => {
    expect(getDisplayNote({ changePct: '+3%', topics: 'AI' })).toBe('+3%(AI)');
  });

  it('getDisplayNote 无 changePct/topics 时回退 note', () => {
    expect(getDisplayNote({ note: '原note' })).toBe('原note');
  });

  it('getDisplayNote(null) 返回空串', () => {
    expect(getDisplayNote(null)).toBe('');
  });
});

describe('note/helpers：extractTopics 提取去重题材', () => {
  it('多括号提取为数组', () => {
    expect(extractTopics('(AI)(芯片)')).toEqual(['AI', '芯片']);
  });

  it('过滤题材编号与纯数字，保留真实题材', () => {
    expect(extractTopics('(题材1)(3)(市场)')).toEqual(['市场']);
  });

  it('空字符串返回空数组', () => {
    expect(extractTopics('')).toEqual([]);
  });
});
