// src/logic/auction/ladder-source.test.js
// [LADDER-SRC 2026-11-03 用户口径] 「同花顺最近多板」源数据条数的解析与状态机单测。
//
// 守的是什么（回归红线）：
//   ① 条数必须能取到，且**结构化字段优先、老日志兜底**（历史落库记录没有字段，也要能显示；
//      但字段一旦存在就不能被日志字符串盖掉）；
//   ② 降级运行（名单源不可用）时**绝不显示 0 只** —— 那是「没抓到」而不是「同花顺只有 0 只」
//      （§10 读失败 ≠ 空数据；这条是用户拿去对炒股软件的数字，错一个就是错结论）；
//   ③ 三种"没有数字"的状态必须分开：没跑（empty）/ 读失败（error）/ 日志里没这项（none）；
//   ④ 日期不匹配时返回 idle（⛔ 不能把 A 日的条数当成 B 日的显示）。
import { describe, it, expect } from 'vitest';
import {
  extractLadderCount,
  buildLadderSourceInfo,
  getLadderSourceInfo,
  _resetLadderSourceForTest
} from './ladder-source.js';

describe('ladder-source · 同花顺最近多板源数据条数', () => {
  it('结构化字段优先于老日志字符串', () => {
    // 新 worker 写 ladderCount；同一行日志里还留着旧文案 ⇒ 必须用字段（字段是契约，日志是给人看的）
    const got = extractLadderCount({
      ladderCount: 95,
      logs: ['成分股数量: 91（这条日志与字段不一致时必须信字段）']
    });
    expect(got.count).toBe(95);
    expect(got.via).toBe('field');
    expect(got.degraded).toBe(false);
  });

  it('老日志兜底：从「成分股数量: N」里取（历史落库记录没有 ladderCount 字段）', () => {
    const got = extractLadderCount({
      logs: ['步骤1：并行获取 成分股 / 代码表 / 交易日历...', '成分股数量: 56']
    });
    expect(got.count).toBe(56);
    expect(got.via).toBe('log');
  });

  it('中文冒号 / 前后空格都能认（worker 日志是人手改过的文案，别只认全角半角之一）', () => {
    expect(extractLadderCount({ logs: ['成分股数量：77'] }).count).toBe(77);
    expect(extractLadderCount({ logs: ['  成分股数量:  82 '] }).count).toBe(82);
  });

  it('降级运行 ⇒ 条数无意义（count=null / degraded=true），⛔ 绝不显示「0 只」', () => {
    const got = extractLadderCount({
      ladderDegraded: true,
      ladderCount: 0,
      logs: ['成分股数量: 0（⬇️ 降级模式：名单源不可用）']
    });
    expect(got.count).toBe(null);
    expect(got.degraded).toBe(true);

    const info = buildLadderSourceInfo([{ detail: { ladderDegraded: true, ladderCount: 0 } }], '2026-11-03');
    expect(info.status).toBe('degraded');
    expect(info.count).toBe(null);
  });

  it('日志里没有这一项 ⇒ status=none（不是 0，也不是"没跑"）', () => {
    const info = buildLadderSourceInfo([{ detail: { logs: ['步骤1：xxx'] } }], '2026-11-03');
    expect(info.status).toBe('none');
    expect(info.count).toBe(null);
  });

  it('当天没有任何 morning 记录 ⇒ status=empty（抓取没跑，与"读失败"不同）', () => {
    const info = buildLadderSourceInfo([], '2026-11-03');
    expect(info.status).toBe('empty');
    expect(info.count).toBe(null);
    expect(info.date).toBe('2026-11-03');
  });

  it('拿到条数 ⇒ status=ready，并带上来源（field / log）与日期', () => {
    const info = buildLadderSourceInfo([{
      created_at: '2026-11-03T01:25:12Z',
      detail: { logs: ['成分股数量: 56'] }
    }], '2026-11-03');
    expect(info.status).toBe('ready');
    expect(info.count).toBe(56);
    expect(info.via).toBe('log');
    expect(info.date).toBe('2026-11-03');
    expect(info.at).toBe('2026-11-03T01:25:12Z');
  });

  it('脏输入不炸：detail 为 null / logs 不是数组 / 字段是字符串数字', () => {
    expect(extractLadderCount(null).count).toBe(null);
    expect(extractLadderCount({ logs: 'not-an-array' }).count).toBe(null);
    expect(extractLadderCount({ ladderCount: '42' }).count).toBe(42);   // 手工修正过的 JSONB
    expect(extractLadderCount({ ladderCount: 'abc' }).count).toBe(null);
    expect(extractLadderCount({ ladderCount: -1 }).count).toBe(null);   // 负条数不存在
  });

  it('日期不匹配 ⇒ idle（没加载过就不假装有数）', () => {
    _resetLadderSourceForTest();
    const idle = getLadderSourceInfo('2026-11-03');
    expect(idle.status).toBe('idle');
    expect(idle.count).toBe(null);
    // 空日期
    expect(getLadderSourceInfo('').count).toBe(null);
  });
});
