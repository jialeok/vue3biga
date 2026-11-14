// index-daily-pct.test.js — 指数腿数据层的纯函数回归锁
//
// 锁三件事：
//   ① `barsToPctLegs` / `mergeLegs` 的换算与「云端优先、不覆盖」语义；
//   ② `indexLegsOf` 的升序 + asOf 截断（⛔ 不许把未来的腿算进历史窗口）；
//   ③ `indexLegsGapText` 的 §10 语义：缺数据必须能被看见（⛔ 不说成「没有异动」）。
import { describe, it, expect, beforeEach } from 'vitest';
import {
  barsToPctLegs, mergeLegs, indexLegsOf, indexLegsGapText, shiftYmd, clearIndexDailyPctCache
} from './index-daily-pct.js';

beforeEach(function () { clearIndexDailyPctCache(); });

describe('[ABN-DEV-DATA] barsToPctLegs', () => {
  it('第一根不出腿，之后按前收换算', () => {
    const legs = barsToPctLegs([
      { date: '2026-11-10', close: 2000 },
      { date: '2026-11-11', close: 2020 },
      { date: '2026-11-12', close: 1980 }
    ]);
    expect(legs.length).toBe(2);
    expect(legs[0].date).toBe('2026-11-11');
    expect(legs[0].pct).toBeCloseTo(1, 6);
    expect(legs[1].pct).toBeCloseTo(-1.9802, 3);
  });

  it('收盘价 0 / 负数 / 缺失 ⇒ 跳过那一段（⛔ 不补 0）', () => {
    expect(barsToPctLegs([{ date: 'a', close: 100 }, { date: 'b', close: 0 }])).toEqual([]);
    expect(barsToPctLegs([{ date: 'a', close: 0 }, { date: 'b', close: 100 }])).toEqual([]);
    expect(barsToPctLegs([])).toEqual([]);
    expect(barsToPctLegs(null)).toEqual([]);
  });
});

describe('[ABN-DEV-DATA] mergeLegs · 云端优先，不覆盖', () => {
  it('已有日期一律不覆盖（云端值是权威）', () => {
    const m = new Map([['2026-11-11', 1.0]]);
    const n = mergeLegs(m, [
      { date: '2026-11-11', pct: 9.9 },     // ⛔ 不许覆盖
      { date: '2026-11-12', pct: 2.2 }
    ]);
    expect(n).toBe(1);
    expect(m.get('2026-11-11')).toBe(1.0);
    expect(m.get('2026-11-12')).toBe(2.2);
  });

  it('非法的 pct 不进 Map（§10 不补 0）', () => {
    const m = new Map();
    expect(mergeLegs(m, [{ date: '2026-11-11', pct: '' }, { date: '2026-11-12', pct: 'abc' }])).toBe(0);
    expect(m.size).toBe(0);
  });

  it('兼容 DB 文本形态（"+0.55%"）', () => {
    const m = new Map();
    mergeLegs(m, [{ date: '2026-11-11', pct: '+0.55%' }]);
    expect(m.get('2026-11-11')).toBeCloseTo(0.55, 6);
  });
});

describe('[ABN-DEV-DATA] indexLegsOf · 升序 + asOf 截断', () => {
  const map = new Map([
    ['sz399107', new Map([['2026-11-12', 1.0], ['2026-11-10', -0.5], ['2026-11-11', 0.2]])]
  ]);

  it('按日期升序返回（cumulativeDeviation 依赖顺序取「末 n 根」）', () => {
    const legs = indexLegsOf(map, 'sz399107');
    expect(legs.map(function (l) { return l.date; }))
      .toEqual(['2026-11-10', '2026-11-11', '2026-11-12']);
  });

  it('asOf 截断：⛔ 不许把「未来」的腿算进历史窗口', () => {
    const legs = indexLegsOf(map, 'sz399107', '2026-11-11');
    expect(legs.length).toBe(2);
    expect(legs[legs.length - 1].date).toBe('2026-11-11');
  });

  it('没有这个指数 / 传 null ⇒ 空数组（⛔ 不抛、⛔ 不造数据）', () => {
    expect(indexLegsOf(map, 'sh000002')).toEqual([]);
    expect(indexLegsOf(null, 'sz399107')).toEqual([]);
  });
});

describe('[ABN-DEV-DATA] indexLegsGapText · §10 缺数据必须可见', () => {
  it('全部缺 ⇒ 明说「没读到」且强调「不是没有异动」', () => {
    const t = indexLegsGapText({ ready: false, missing: ['sh000002'], error: 'boom' });
    expect(t).toContain('没读到');
    expect(t).toContain('不是「没有异动」');
    expect(t).toContain('boom');
  });

  it('部分缺 ⇒ 点名是哪几个指数', () => {
    const t = indexLegsGapText({ ready: true, missing: ['sh000688'] });
    expect(t).toContain('科创50');
    expect(t).toContain('sh000688');
  });

  it('一个不缺 ⇒ 空串（视图据此不渲染告警）', () => {
    expect(indexLegsGapText({ ready: true, missing: [] })).toBe('');
  });
});

describe('[ABN-DEV-DATA] shiftYmd · 时区无关的日期加减', () => {
  it('跨月 / 跨年都正确', () => {
    expect(shiftYmd('2026-11-01', -1)).toBe('2026-10-31');
    expect(shiftYmd('2026-01-01', -1)).toBe('2025-12-31');
    expect(shiftYmd('2026-11-13', -75)).toBe('2026-08-30');
  });

  it('非法输入原样返回（⛔ 不抛）', () => {
    expect(shiftYmd('', -3)).toBe('');
    expect(shiftYmd('abc', -3)).toBe('abc');
  });
});
