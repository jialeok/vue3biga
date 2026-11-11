/**
 * [TVRB-PLAN-SNAPSHOT 2026-11-11] 选股结论快照编解码器的契约单测。
 *
 * 背景（用户原话）：「昨天11月10日，题材量比的选票结果冰山火热又不见了……
 *   我有时要看历史日期复盘的，为什么老是搞失踪……这不是一只票问题，是整个类的问题」
 *
 * 本测试锁的是「落库结论必须无损」这条整类红线：
 *   ① plan 里的 Set / Map / Date 必须能往返（直接 JSON.stringify 会把 Set 变 {} ⇒ 静默丢票）；
 *   ② 循环引用 / 函数 / NaN / Infinity / 超深对象不许把定稿流程打爆；
 *   ③ 读回来的残缺对象必须判「损坏」，⛔ 绝不能当成一份能上屏的结论（§10）。
 */
import { describe, it, expect } from 'vitest';
import {
  encodePlanSnapshot,
  decodePlanSnapshot,
  isUsablePlanSnapshot,
  PLAN_SNAPSHOT_MAX_BYTES
} from './plan-snapshot-codec.js';

function plan(over) {
  return Object.assign({
    blocks: [{ name: '冰山冷热', tag: '竞价一字涨停 · 等开板后进' }],
    buy: { list: [{ stock: '冰山冷热' }], buyNames: new Set(['冰山冷热']) },
    notes: ['题材已退潮（整段灰化、今天不开新仓）'],
    pickCount: 1,
    rankMap: new Map([['冰山冷热', 2]]),
    settledAt: new Date('2026-11-10T01:25:40.000Z')
  }, over || {});
}

describe('plan-snapshot-codec · 定稿结论无损存档', function() {
  it('① 【为什么需要 codec】原生 JSON.stringify 会把 Set 变成 {}（静默丢票）', function() {
    const raw = plan();
    expect(raw.buy.buyNames instanceof Set).toBe(true);
    expect(JSON.parse(JSON.stringify(raw)).buy.buyNames).toEqual({});
  });

  it('② Set / Map / Date / 嵌套结构全部可逆往返', function() {
    const enc = encodePlanSnapshot(plan());
    expect(enc.ok).toBe(true);
    expect(enc.bytes).toBeGreaterThan(0);

    // 存进 jsonb 前必然经过一次真正的 JSON 序列化
    const plain = JSON.parse(JSON.stringify(enc.plain));
    const dec = decodePlanSnapshot(plain);
    expect(dec.ok).toBe(true);
    expect(dec.plan.blocks[0].name).toBe('冰山冷热');
    expect(dec.plan.blocks[0].tag).toContain('等开板后进');
    expect(dec.plan.buy.buyNames instanceof Set).toBe(true);
    expect(dec.plan.buy.buyNames.has('冰山冷热')).toBe(true);
    expect(dec.plan.rankMap instanceof Map).toBe(true);
    expect(dec.plan.rankMap.get('冰山冷热')).toBe(2);
    expect(dec.plan.settledAt instanceof Date).toBe(true);
    expect(dec.plan.settledAt.toISOString()).toBe('2026-11-10T01:25:40.000Z');
    expect(dec.plan.notes[0]).toContain('题材已退潮');
    expect(dec.plan.pickCount).toBe(1);
  });

  it('③ decode 也接受 JSON 字符串（PostgREST 偶尔返回字符串化 jsonb）', function() {
    const enc = encodePlanSnapshot(plan());
    const dec = decodePlanSnapshot(JSON.stringify(enc.plain));
    expect(dec.ok).toBe(true);
    expect(dec.plan.buy.buyNames.has('冰山冷热')).toBe(true);
  });

  it('④ 循环引用只截断那一支，不抛、不丢其它字段', function() {
    const p = plan();
    p.self = p;
    const enc = encodePlanSnapshot(p);
    expect(enc.ok).toBe(true);
    const dec = decodePlanSnapshot(enc.plain);
    expect(dec.ok).toBe(true);
    expect(dec.plan.self).toBe(null);
    expect(dec.plan.blocks[0].name).toBe('冰山冷热');
  });

  it('⑤ 函数 / undefined / NaN / Infinity 安全落地（⛔ 不让 jsonb 写入炸掉）', function() {
    const p = plan({ fn: function() {}, nothing: undefined, nan: NaN, inf: Infinity });
    const enc = encodePlanSnapshot(p);
    expect(enc.ok).toBe(true);
    const dec = decodePlanSnapshot(enc.plain);
    expect(dec.ok).toBe(true);
    expect('fn' in dec.plan).toBe(false);
    expect('nothing' in dec.plan).toBe(false);
    expect(dec.plan.nan).toBe(null);
    expect(dec.plan.inf).toBe(null);
  });

  it('⑥ 数组里的怪值补 null 保持下标，不静默缩短数组', function() {
    const p = plan({ arr: ['a', undefined, 'c', function() {}] });
    const enc = encodePlanSnapshot(p);
    const dec = decodePlanSnapshot(enc.plain);
    expect(dec.ok).toBe(true);
    expect(dec.plan.arr).toHaveLength(4);
    expect(dec.plan.arr[0]).toBe('a');
    expect(dec.plan.arr[2]).toBe('c');
  });

  it('⑦ 超深对象被截断而不是爆栈', function() {
    let deep = { v: 1 };
    for (let i = 0; i < 80; i++) deep = { child: deep };
    const enc = encodePlanSnapshot(plan({ deep: deep }));
    expect(enc.ok).toBe(true);
    const dec = decodePlanSnapshot(enc.plain);
    expect(dec.ok).toBe(true);
  });

  describe('结构校验（§10 残缺快照不得当结论使用）', function() {
    it('⑧ encode 拒绝不像 plan 的输入', function() {
      expect(encodePlanSnapshot(null).ok).toBe(false);
      expect(encodePlanSnapshot([]).ok).toBe(false);
      expect(encodePlanSnapshot({ buy: {} }).ok).toBe(false);
      expect(encodePlanSnapshot({ blocks: [] }).ok).toBe(false);
      expect(encodePlanSnapshot({ blocks: 'x', buy: {} }).ok).toBe(false);
    });

    it('⑨ isUsablePlanSnapshot 四个必需字段一个都不能少', function() {
      expect(isUsablePlanSnapshot(plan())).toBe(true);
      expect(isUsablePlanSnapshot(null)).toBe(false);
      expect(isUsablePlanSnapshot([])).toBe(false);
      expect(isUsablePlanSnapshot({ buy: {}, notes: [], pickCount: 1 })).toBe(false);
      expect(isUsablePlanSnapshot({ blocks: [], buy: {}, pickCount: 1 })).toBe(false);
      expect(isUsablePlanSnapshot({ blocks: [], buy: {}, notes: [], pickCount: '1' })).toBe(false);
      expect(isUsablePlanSnapshot({ blocks: [], buy: {}, notes: [], pickCount: NaN })).toBe(false);
    });

    it('⑩ decode 拒绝坏 JSON / 空对象 / 字段残缺', function() {
      expect(decodePlanSnapshot('{not json').reason).toBe('bad-json');
      expect(decodePlanSnapshot(null).reason).toBe('not-object');
      expect(decodePlanSnapshot({}).reason).toBe('shape-invalid');
      expect(decodePlanSnapshot({ blocks: [], buy: {}, notes: [] }).reason).toBe('shape-invalid');
    });

    it('⑪ 体积上限是显式常量（写库前用它挡异常膨胀）', function() {
      expect(PLAN_SNAPSHOT_MAX_BYTES).toBeGreaterThan(100 * 1024);
      expect(encodePlanSnapshot(plan()).bytes).toBeLessThan(PLAN_SNAPSHOT_MAX_BYTES);
    });
  });
});
