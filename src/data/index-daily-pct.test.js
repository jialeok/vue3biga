// index-daily-pct.test.js — 指数腿数据层的纯函数回归锁
//
// 锁三件事：
//   ① `barsToPctLegs` / `mergeLegs` 的换算与「云端优先、不覆盖」语义；
//   ② `indexLegsOf` 的升序 + asOf 截断（⛔ 不许把未来的腿算进历史窗口）；
//   ③ `indexLegsGapText` 的 §10 语义：缺数据必须能被看见（⛔ 不说成「没有异动」）。
import { describe, it, expect, beforeEach } from 'vitest';
import {
  barsToPctLegs, mergeLegs, indexLegsOf, indexLegsGapText, shiftYmd, clearIndexDailyPctCache,
  indicesNeedingQt, qtCooldownLeftMs
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

// ════════════════════════════════════════════════════════════════════════════════
// ★ [IDX-QT-BREAKER 2026-11-24 用户报障「题材量比的响应速度有些变慢了」]
//   真实链路实测（node 直连真库）：冷启动 11 个请求里 **8 个是腾讯指数日线，全部 HTTP 501**，
//   冷启动 4.7s。根因不是「腾讯慢」，是**判据错了** —— `m.size < list.length` 拿条数比日期数，
//   而云端指数腿只从 09-08 开始有行、个股腿能回溯到 08-12 ⇒ 19 天的「前缀缺口」恒定存在
//   ⇒ 每次都判「需要兜底」⇒ 每次都白打 8 个必败请求。
// ════════════════════════════════════════════════════════════════════════════════
describe('[IDX-QT-BREAKER] 哪些指数才真的需要去腾讯补（⛔ 前缀缺口不算）', () => {
  it('云端起点之前那段（前缀）不是缺口 ⇒ 一根都不打', () => {
    // 真实形态：horizon 59 天（08-12 起），云端只覆盖最后 40 天（09-08 起）
    const horizon = [];
    for (let i = 1; i <= 59; i++) horizon.push('D' + String(i).padStart(2, '0'));
    const m = new Map();
    horizon.slice(19).forEach(function (d) { m.set(d, 0.5); });   // 少了前 19 天
    const map = new Map([['sz399107', m]]);
    expect(indicesNeedingQt(['sz399107'], map, horizon)).toEqual([]);
  });

  it('覆盖区间内部的空洞 ⇒ 要补（那是真漏了）', () => {
    const horizon = ['D01', 'D02', 'D03', 'D04', 'D05'];
    const m = new Map([['D01', 1], ['D02', 1], ['D04', 1], ['D05', 1]]);   // 缺 D03
    const map = new Map([['sz399107', m]]);
    expect(indicesNeedingQt(['sz399107'], map, horizon)).toEqual(['sz399107']);
  });

  it('云端一根都没有 ⇒ 要补（根本算不出）', () => {
    const map = new Map([['sh000688', new Map()]]);
    expect(indicesNeedingQt(['sh000688'], map, ['D01', 'D02'])).toEqual(['sh000688']);
    // 连 key 都没有（调用方只关心这一只，云端没返回行）
    expect(indicesNeedingQt(['sh000688'], new Map(), ['D01'])).toEqual(['sh000688']);
  });

  it('没有窗口信息 / 空代码表 ⇒ 一律不打（⛔ 不凭空请求上游）', () => {
    const map = new Map([['sz399107', new Map([['D01', 1]])]]);
    expect(indicesNeedingQt(['sz399107'], map, [])).toEqual([]);
    expect(indicesNeedingQt([], map, ['D01'])).toEqual([]);
    expect(indicesNeedingQt(['sz399107'], null, ['D01'])).toEqual(['sz399107']);
  });

  it('只判调用方给的那几只（codes 收窄 = 腾讯 fan-out 减半）', () => {
    const horizon = ['D01', 'D02'];
    const map = new Map([
      ['sz399107', new Map([['D01', 1], ['D02', 1]])],   // 够用
      ['sh000688', new Map()]                            // 空
    ]);
    // 只要深主板那只 ⇒ 不该因为「科创 50 空着」就去打腾讯
    expect(indicesNeedingQt(['sz399107'], map, horizon)).toEqual([]);
    expect(indicesNeedingQt(['sz399107', 'sh000688'], map, horizon)).toEqual(['sh000688']);
  });
});

describe('[IDX-QT-BREAKER] 熔断器状态', () => {
  it('初始 = 不在熔断（0ms）', () => {
    expect(qtCooldownLeftMs()).toBe(0);
  });
});
