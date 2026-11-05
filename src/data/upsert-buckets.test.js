// upsert-buckets.test.js — 锁住「批量 upsert 字段集必须一致」这条红线
//
// 事故（2026-11-05）：补数层一次提交 20 行 —— 2 行新建（带 volume）+ 18 行只补换手率（不带 volume）。
//   PostgREST 合成一条 INSERT，列清单取并集，没写 volume 的那 18 行在 VALUES 里是 NULL
//   ⇒ ON CONFLICT DO UPDATE SET volume = EXCLUDED.volume 把库里正确的竞价量抹成 NULL。
//   实测：襄阳轴承 321 → NULL、上海九百 159 → NULL（页面表现为「本来有的竞价量变回 '-'」）。
//
// 这组用例锁住：
//   ① 不同字段集的行**永远不会**出现在同一批（这是数据安全的充要条件）；
//   ② 字段顺序不同不影响分桶（签名要排序）；
//   ③ 桶顺序 = 首次出现顺序，桶内顺序保持（不改调用方语义）；
//   ④ 桶内再按 size 切片，且切片后字段集仍一致；
//   ⑤ 脏输入（null / 非对象 / 非数组）不许炸。

import { describe, it, expect } from 'vitest';
import { bucketByKeySet, planUpsertBatches } from './upsert-buckets.js';

/** 一批里「字段集」是否全都一样 —— 真正的安全判据 */
function allSameKeySet(batch) {
  const sig = batch.map((r) => Object.keys(r).sort().join('|'));
  return sig.every((s) => s === sig[0]);
}

describe('bucketByKeySet — 防「没写的列被写成 NULL」', () => {
  it('① 两组字段不同的行必须拆成两桶（真实事故形状）', () => {
    const rows = [
      { date: 'd', stock: '上海洗霸', code: '603200', scope: 'auction', volume: '16' },
      { date: 'd', stock: '大洋电机', code: '002249', scope: 'auction', volume: '155' },
      { date: 'd', stock: '襄阳轴承', scope: 'auction', auc_turnover: '0.70' },   // ⚠️ 没有 volume
      { date: 'd', stock: '上海九百', scope: 'auction', auc_turnover: '0.09' },
    ];
    const buckets = bucketByKeySet(rows);
    expect(buckets.length).toBe(2);
    buckets.forEach((b) => expect(allSameKeySet(b)).toBe(true));
    // 带 volume 的 2 只一桶、只补换手的 2 只一桶
    expect(buckets.map((b) => b.length).sort()).toEqual([2, 2]);
  });

  it('② 字段顺序不同 ⇒ 仍是同一桶（签名必须排序后比较）', () => {
    const buckets = bucketByKeySet([
      { date: 'd', stock: 'A', volume: '1' },
      { stock: 'B', date: 'd', volume: '2' },
      { volume: '3', date: 'd', stock: 'C' },
    ]);
    expect(buckets.length).toBe(1);
    expect(buckets[0].length).toBe(3);
  });

  it('③ 桶顺序 = 首次出现顺序，桶内顺序不变（不改调用方语义）', () => {
    const rows = [
      { a: 1, b: 1 },
      { a: 1 },
      { a: 1, b: 2 },
      { a: 2 },
    ];
    const buckets = bucketByKeySet(rows);
    expect(buckets.length).toBe(2);
    expect(buckets[0]).toEqual([{ a: 1, b: 1 }, { a: 1, b: 2 }]);
    expect(buckets[1]).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('⑤ 脏输入不许炸', () => {
    expect(bucketByKeySet(null)).toEqual([]);
    expect(bucketByKeySet(undefined)).toEqual([]);
    expect(bucketByKeySet('不是数组')).toEqual([]);
    expect(bucketByKeySet([null, 0, 'x', { a: 1 }])).toEqual([[{ a: 1 }]]);
  });
});

describe('planUpsertBatches — 分桶 + 切片，切片后字段集仍必须一致', () => {
  it('④ 200 行同字段 + 3 行另一字段 ⇒ 切成 [200,3] 或 [n...,3]，且每批字段一致', () => {
    const rows = [];
    for (let i = 0; i < 200; i++) rows.push({ date: 'd', stock: 'S' + i, volume: '1' });
    for (let i = 0; i < 3; i++) rows.push({ date: 'd', stock: 'T' + i, auc_turnover: '0.1' });
    const batches = planUpsertBatches(rows, 100);
    expect(batches.length).toBe(3);          // 200/100=2 批 + 3 行 1 批
    expect(batches.map((b) => b.length)).toEqual([100, 100, 3]);
    batches.forEach((b) => expect(allSameKeySet(b)).toBe(true));
    // 行数守恒：一行都不许丢（丢行 = 静默少写，比写错更难查）
    expect(batches.reduce((n, b) => n + b.length, 0)).toBe(203);
  });

  it('size 非法（0 / 负数 / 非数字）⇒ 回退默认 100，绝不退化成 1（否则几千行变几千个请求）', () => {
    const rows = [];
    for (let i = 0; i < 150; i++) rows.push({ date: 'd', stock: 'S' + i });
    [0, -5, NaN, 'abc', undefined].forEach(function(bad) {
      const batches = planUpsertBatches(rows, bad);
      expect(batches.length).toBe(2);                                   // 150 / 100
      expect(batches.reduce((n, b) => n + b.length, 0)).toBe(150);      // 不丢行、不死循环
    });
  });

  it('空输入 ⇒ 空批次（调用方直接跳过，不发请求）', () => {
    expect(planUpsertBatches([], 100)).toEqual([]);
    expect(planUpsertBatches(null, 100)).toEqual([]);
  });
});
