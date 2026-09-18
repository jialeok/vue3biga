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

// [REGRESSION 2026-09-18] 「涨幅传成数字」曾把整个看板打崩
//   事故：竞价一字看板把数值 rangePct(number) 塞进 changePct →
//   getDisplayNote 组装 note 时（该股无题材，`note += …` 不执行）note 保持为 number →
//   extractTopics 里 `note.match(…)` 抛 `t.match is not a function` →
//   被上层 catch 成「看板加载失败」，一行都不渲染。
//   这批用例钉住：这些函数对【数字入参】必须按文本处理，绝不抛错、绝不把数字当返回值。
describe('note/helpers：数字入参必须按文本处理（防 t.match is not a function）', () => {
  it('buildNoteFromFields 的 changePct 是数字且无题材时，仍返回字符串', () => {
    const out = buildNoteFromFields(12.34, '');
    expect(typeof out).toBe('string');
    expect(out).toBe('12.34');
  });

  it('buildNoteFromFields 的 changePct 是数字且有题材时，正常拼前缀', () => {
    expect(buildNoteFromFields(12.34, 'AI')).toBe('12.34(AI)');
  });

  it('getDisplayNote 遇数字 changePct 无题材时返回字符串，不返回数字', () => {
    const out = getDisplayNote({ changePct: 12.34, topics: '' });
    expect(typeof out).toBe('string');
    expect(out).toBe('12.34');
  });

  it('extractTopics 遇数字不抛错，且能提出括号里的题材', () => {
    expect(() => extractTopics(12.34)).not.toThrow();
    expect(extractTopics(12.34)).toEqual([]);
  });

  it('parseNoteToFields 遇数字不抛错', () => {
    expect(() => parseNoteToFields(12.34)).not.toThrow();
    expect(parseNoteToFields(12.34)).toEqual({ changePct: '', topics: '' });
  });

  it('cleanTopicsForDisplay 遇数字不抛错', () => {
    expect(() => cleanTopicsForDisplay(12.34)).not.toThrow();
    expect(cleanTopicsForDisplay(12.34)).toBe('12.34');
  });

  it('端到端：数字 changePct → getDisplayNote → extractTopics 全链路不崩', () => {
    const note = getDisplayNote({ changePct: 20, topics: '机器人' });
    expect(typeof note).toBe('string');
    expect(extractTopics(note)).toEqual(['机器人']);
  });
});
