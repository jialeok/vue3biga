// core-category.test.js — 「题材 → 核心词大类」归一的单元测试
//
// 用户口径（2026-10-22）：「AI应用是大类，我在核心管理里把文化传媒放到那个大类了，
//   那个大类就是我说的题材。因为每天的股票太少，只能用大类分。不细分。」
//
// ⛔ 这些用例不做「业务判定」，只钉住纯函数的三个承诺：
//   ① 大类命中（含同义词 / 子串 / 长词优先）；
//   ② 匹配不到 ⇒ 原样返回（⛔ 不能因为「不认识」就丢掉题材）；
//   ③ 核心词表为空 ⇒ 恒等（§11 零行为变化）。

import { describe, it, expect } from 'vitest';
import {
  splitTopicSegments,
  buildCoreTokenIndex,
  coreTopicOf,
  makeCoreTopicResolver
} from './core-category.js';

const CORES = [
  // 与线上 core_topics 实测同一形态：AI应用 的 synonyms 里含「文化传媒」
  { name: 'AI应用', synonyms: ['文化传媒', '影视院线', '短剧', 'AI', '人工智能'] },
  { name: '机器人', synonyms: ['人形机器人', '减速器'] },
  { name: '电力', synonyms: ['风电', '光伏'] }
];

describe('core-category · splitTopicSegments', function() {
  it('按 , ， 、 ; ； / + | 切段，去空白去空串', function() {
    expect(splitTopicSegments('AI应用,文化传媒')).toEqual(['AI应用', '文化传媒']);
    expect(splitTopicSegments('AI应用、文化传媒；短剧/影视')).toEqual(['AI应用', '文化传媒', '短剧', '影视']);
    expect(splitTopicSegments('AI应用+算力|数据中心')).toEqual(['AI应用', '算力', '数据中心']);
  });

  it('空 / null / undefined ⇒ 空数组', function() {
    expect(splitTopicSegments('')).toEqual([]);
    expect(splitTopicSegments(null)).toEqual([]);
    expect(splitTopicSegments(undefined)).toEqual([]);
    expect(splitTopicSegments('   ')).toEqual([]);
  });

  it('重复段去重（保持原顺序）', function() {
    expect(splitTopicSegments('AI应用,AI应用,文化传媒')).toEqual(['AI应用', '文化传媒']);
  });
});

describe('core-category · buildCoreTokenIndex / coreTopicOf', function() {
  it('索引含「名字 + 同义词」两类 token，按长度降序（长词优先）', function() {
    const idx = buildCoreTokenIndex(CORES);
    expect(idx.length).toBeGreaterThan(0);
    for (let i = 1; i < idx.length; i++) {
      expect(idx[i - 1].lower.length).toBeGreaterThanOrEqual(idx[i].lower.length);
    }
  });

  it('★ 长词优先：文化传媒（4 字）应命中 AI应用，而不是被更短的词抢走', function() {
    const idx = buildCoreTokenIndex(CORES);
    expect(coreTopicOf('文化传媒', idx)).toBe('AI应用');
  });

  it('子串匹配（与 matchTopicToCore 同一套语义）', function() {
    const idx = buildCoreTokenIndex(CORES);
    expect(coreTopicOf('AI应用+算力', idx)).toBe('AI应用');
    expect(coreTopicOf('短剧游戏', idx)).toBe('AI应用');
    expect(coreTopicOf('人形机器人', idx)).toBe('机器人');
  });

  it('匹配不到 ⇒ 空串', function() {
    const idx = buildCoreTokenIndex(CORES);
    expect(coreTopicOf('稀土永磁', idx)).toBe('');
    expect(coreTopicOf('', idx)).toBe('');
  });

  it('脏核心词表（缺 name / name 非字符串）⇒ 跳过，不抛错', function() {
    const idx = buildCoreTokenIndex([null, {}, { name: '' }, { name: '  ' }, { name: '电力' }, undefined]);
    expect(idx).toHaveLength(1);
    expect(idx[0].name).toBe('电力');
  });
});

describe('core-category · makeCoreTopicResolver', function() {
  const res = makeCoreTopicResolver(CORES);

  it('★ 文化传媒 ⇒ AI应用（10-22 报障的关键一步）', function() {
    expect(res('文化传媒')).toBe('AI应用');
  });

  it('已经是核心词名 ⇒ 原样返回', function() {
    expect(res('AI应用')).toBe('AI应用');
    expect(res('机器人')).toBe('机器人');
  });

  it('多段各自归一 + 去重（同一大类的多段合成一个）', function() {
    expect(res('文化传媒,影视院线,短剧')).toBe('AI应用');
    expect(res('文化传媒,机器人')).toBe('AI应用,机器人');
  });

  it('★ 匹配不到 ⇒ 原样返回该段（⛔ 不能因为不认识就丢掉）', function() {
    expect(res('稀土永磁')).toBe('稀土永磁');
    expect(res('稀土永磁,文化传媒')).toBe('稀土永磁,AI应用');
  });

  it('空输入 ⇒ 空串（§10 不造值）', function() {
    expect(res('')).toBe('');
    expect(res(null)).toBe('');
    expect(res(undefined)).toBe('');
    expect(res('   ')).toBe('');
  });

  it('核心词表为空 / 非数组 ⇒ 恒等函数（§11 零行为变化）', function() {
    const id = makeCoreTopicResolver([]);
    expect(id('文化传媒')).toBe('文化传媒');
    expect(makeCoreTopicResolver(null)('AI应用,数据中心')).toBe('AI应用,数据中心');
  });

  it('结果稳定可复现（同输入多次调用 ⇒ 同一个值）', function() {
    const a = res('文化传媒');
    for (let i = 0; i < 5; i++) expect(res('文化传媒')).toBe(a);
  });

  it('大小写归一：英文同义词 AI 能命中 ai 开头的串', function() {
    expect(res('AIGC')).toBe('AI应用');
  });
});
