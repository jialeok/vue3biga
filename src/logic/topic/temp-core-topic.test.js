import { describe, it, expect } from 'vitest';
import {
  TEMP_CORE_TRADING_DAYS,
  endDateOf,
  isTempCoreActiveOn,
  effectiveCoreTopicsFor
} from './temp-core-topic.js';

// 交易日链：11-12(四) → 11-13(五) → 11-16(一)；11-17 是第 4 个交易日。
const DAYS = ['2026-11-12', '2026-11-13', '2026-11-16', '2026-11-17'];
function nextTradingDay(d) {
  const i = DAYS.indexOf(d);
  return i >= 0 && i + 1 < DAYS.length ? DAYS[i + 1] : null;
}

const BASE = [
  { name: '农业,水产品', synonyms: ['东方海洋', '水产品'] },
  { name: '大消费', synonyms: ['消费'] }
];
const TEMP = {
  id: 1,
  name: '东方',
  synonyms: ['东方海洋', '东方环宇', '日出东方'],
  startDate: '2026-11-12',
  disabledFrom: null
};

describe('临时核心词 · 按日期生效（规则 〇·a）', () => {
  it('交易日数 = 设置日 + 后 2 天，共 3 天（用户拍板）', () => {
    expect(TEMP_CORE_TRADING_DAYS).toBe(3);
    expect(endDateOf('2026-11-12', 3, nextTradingDay)).toBe('2026-11-16');
  });

  it('endDateOf 跳过周末（未注入假期日历时）', () => {
    // 2026-11-13 周五 ⇒ 后 2 个交易日 = 11-16 周一、11-17 周二
    expect(endDateOf('2026-11-13', 3)).toBe('2026-11-17');
  });

  it('设置日非法 ⇒ 末日为空，⛔ 不猜日期', () => {
    expect(endDateOf('', 3, nextTradingDay)).toBe('');
    expect(endDateOf('20261112', 3, nextTradingDay)).toBe('');
  });

  it('【§11 零行为变化】临时表为空 ⇒ 返回 base 原引用', () => {
    expect(effectiveCoreTopicsFor('2026-11-13', BASE, [], nextTradingDay)).toBe(BASE);
  });

  it('【历史不受影响】设置日之前 ⇒ 返回 base 原引用', () => {
    expect(effectiveCoreTopicsFor('2026-11-11', BASE, [TEMP], nextTradingDay)).toBe(BASE);
  });

  it('【未来不受影响】第 4 个交易日起 ⇒ 返回 base 原引用', () => {
    expect(effectiveCoreTopicsFor('2026-11-17', BASE, [TEMP], nextTradingDay)).toBe(BASE);
    expect(effectiveCoreTopicsFor('2026-12-01', BASE, [TEMP], nextTradingDay)).toBe(BASE);
  });

  it('【生效区间】设置日 / D+1 / D+2 三天都按临时题材归类', () => {
    ['2026-11-12', '2026-11-13', '2026-11-16'].forEach(function(d) {
      const eff = effectiveCoreTopicsFor(d, BASE, [TEMP], nextTradingDay);
      expect(eff).not.toBe(BASE);
      expect(eff.some(function(c) { return c.name === '东方'; })).toBe(true);
      expect(BASE.some(function(c) { return c.name === '东方'; })).toBe(false); // ⛔ 不改原数组
    });
  });

  it('【关停】关停当日（含）之后全部失效；关停前的日期仍生效', () => {
    const stopped = Object.assign({}, TEMP, { disabledFrom: '2026-11-13' });
    expect(isTempCoreActiveOn(stopped, '2026-11-12', nextTradingDay)).toBe(true);
    expect(effectiveCoreTopicsFor('2026-11-13', BASE, [stopped], nextTradingDay)).toBe(BASE);
    expect(effectiveCoreTopicsFor('2026-11-16', BASE, [stopped], nextTradingDay)).toBe(BASE);
  });

  it('【恢复】清空关停日 ⇒ 区间内重新生效', () => {
    const resumed = Object.assign({}, TEMP, { disabledFrom: null });
    expect(effectiveCoreTopicsFor('2026-11-16', BASE, [resumed], nextTradingDay)).not.toBe(BASE);
  });

  it('关停日早于设置日 ⇒ 整段失效', () => {
    const stopped = Object.assign({}, TEMP, { disabledFrom: '2026-11-10' });
    expect(effectiveCoreTopicsFor('2026-11-12', BASE, [stopped], nextTradingDay)).toBe(BASE);
  });

  it('同名临时词整条覆盖主流词（生效期换同义词，过期自动换回）', () => {
    const base = BASE.concat([{ name: '东方', synonyms: ['旧词'] }]);
    const eff = effectiveCoreTopicsFor('2026-11-13', base, [TEMP], nextTradingDay);
    const hit = eff.filter(function(c) { return c.name === '东方'; });
    expect(hit).toHaveLength(1);
    expect(hit[0].synonyms).toEqual(TEMP.synonyms);
    expect(effectiveCoreTopicsFor('2026-11-17', base, [TEMP], nextTradingDay)).toBe(base);
  });

  it('多条临时词按 id 稳定追加（§6 不随加载顺序漂移）', () => {
    const b = { id: 2, name: '贝', synonyms: ['贝因美'], startDate: '2026-11-12', disabledFrom: null };
    const a = Object.assign({}, b, { id: 1, name: '阿', synonyms: ['阿城'] });
    const eff1 = effectiveCoreTopicsFor('2026-11-13', BASE, [b, a], nextTradingDay);
    const eff2 = effectiveCoreTopicsFor('2026-11-13', BASE, [a, b], nextTradingDay);
    expect(eff1.map(function(c) { return c.name; })).toEqual(eff2.map(function(c) { return c.name; }));
  });

  it('日期读不到 ⇒ 判不出 ⇒ 不生效（§10）', () => {
    expect(isTempCoreActiveOn(TEMP, '', nextTradingDay)).toBe(false);
    expect(effectiveCoreTopicsFor('', BASE, [TEMP], nextTradingDay)).toBe(BASE);
    expect(effectiveCoreTopicsFor('2026-11-13', BASE, [Object.assign({}, TEMP, { startDate: 'x' })], nextTradingDay)).toBe(BASE);
  });
});
