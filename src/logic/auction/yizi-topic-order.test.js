// yizi-topic-order.test.js — 「补竞价一字」打开后的题材组重排单测（纯函数层）
//
// 锁死的是用户最在意的那句「一字多的题材排最前，而且补进来的竞价一字也要算进去」：
//   ① 补入行计入该题材的一字权重 → 补得多的题材排到前面（核心诉求）；
//   ② 一字权重相同 → 组规模降序（既有次级口径，与 topic-sort.js 同构）；
//   ③ 「其它」永远排在真实题材组之后（⛔ 不许因为补进几只未分类一字就蹿到前面）；
//   ④ 「未并入」尾段永远最末；
//   ⑤ 段【内】顺序一个不动（那是 yizi-supplement 的合并排名，本模块越权就是 bug）；
//   ⑥ 不改动入参（返回新数组，段对象引用透出）。
import { describe, it, expect } from 'vitest';
import { sortSegmentsByYiziWeight, segmentWeight } from './yizi-topic-order.js';

/** 一个分段：rows = 原有行（isYiZi 可指定），sups = 补入行数 */
function seg(topic, rows, sups, isOrphan) {
  const entries = [];
  (rows || []).forEach(function(r) {
    entries.push({ kind: 'row', item: { stock: r.name, isYiZi: !!r.isYiZi } });
  });
  for (let i = 0; i < (sups || 0); i++) {
    entries.push({ kind: 'sup', sup: { stock: 'S' + topic + i } });
  }
  return { key: 'seg:' + topic, topic: topic, isOrphan: !!isOrphan, entries: entries };
}

function topicsOf(list) {
  return list.map(function(s) { return s.isOrphan ? '@orphan' : s.topic; });
}

describe('sortSegmentsByYiziWeight — 补竞价一字后的题材组重排', () => {
  it('补入的竞价一字计入一字权重：补得多的题材排最前', () => {
    const a = seg('化工', [{ name: '甲' }, { name: '乙' }], 0);
    const b = seg('芯片', [{ name: '丙' }], 3);
    const c = seg('通信', [{ name: '丁', isYiZi: true }, { name: '戊' }], 0);
    // 芯片：0 原有 + 3 补入 = 3；通信：1 原有 + 0 补入 = 1；化工：0
    expect(topicsOf(sortSegmentsByYiziWeight([a, b, c]))).toEqual(['芯片', '通信', '化工']);
  });

  it('一字权重相同 → 组规模降序（含补入行）', () => {
    const small = seg('化工', [{ name: '甲' }], 1);      // 一字 1 / 规模 2
    const big = seg('芯片', [{ name: '乙' }, { name: '丙' }, { name: '丁' }], 1); // 一字 1 / 规模 4
    expect(topicsOf(sortSegmentsByYiziWeight([small, big]))).toEqual(['芯片', '化工']);
  });

  it('权重完全相同 → 按题材名稳定升序（与 topic-sort.js 同为字符串序）', () => {
    const z = seg('算力', [{ name: '甲' }], 0);   // '算'(U+7B97) < '芯'(U+82AF)
    const a = seg('芯片', [{ name: '乙' }], 0);
    expect(topicsOf(sortSegmentsByYiziWeight([a, z]))).toEqual(['算力', '芯片']);
    expect(topicsOf(sortSegmentsByYiziWeight([z, a]))).toEqual(['算力', '芯片']);
  });

  it('「其它」永远在真实题材组之后，「未并入」尾段永远最末', () => {
    const other = seg('其它', [{ name: '甲' }, { name: '乙' }], 9); // 一字 9，但仍是「其它」
    const real = seg('化工', [{ name: '丙' }], 1);                  // 一字 1
    const orphan = seg('', [], 2, true);
    expect(topicsOf(sortSegmentsByYiziWeight([orphan, other, real]))).toEqual(['化工', '其它', '@orphan']);
  });

  it('不改动段内顺序，也不改动入参数组', () => {
    const a = seg('化工', [{ name: '甲' }, { name: '乙' }], 1);
    const b = seg('芯片', [{ name: '丙' }], 3);
    const input = [a, b];
    const out = sortSegmentsByYiziWeight(input);
    expect(out).not.toBe(input);
    expect(out[0]).toBe(b);                       // 段对象引用透出（v-memo / key 稳定）
    expect(input[0]).toBe(a);                     // 入参数组顺序未被动过
    expect(out[0].entries.map(function(e) { return e.item ? e.item.stock : 'S'; })).toEqual(['丙', 'S', 'S', 'S']);
  });

  it('空 / 单段原样返回', () => {
    expect(sortSegmentsByYiziWeight([])).toEqual([]);
    const only = seg('化工', [{ name: '甲' }], 0);
    expect(sortSegmentsByYiziWeight([only])[0]).toBe(only);
  });
});

describe('segmentWeight — 计数口径', () => {
  it('一字权重 = 原有行一字数 + 补入行数；规模 = 段内总行数', () => {
    const w = segmentWeight(seg('芯片', [{ name: '甲', isYiZi: true }, { name: '乙' }], 2));
    expect(w).toEqual({ yizi: 3, size: 4, rows: 2, rowYiZi: 1, sups: 2 });
  });

  it('异常形状不计入 NaN', () => {
    const w = segmentWeight({ topic: 'x', entries: [null, { kind: 'unknown' }, { kind: 'sup', sup: {} }] });
    expect(w).toEqual({ yizi: 1, size: 1, rows: 0, rowYiZi: 0, sups: 1 });
  });
});
