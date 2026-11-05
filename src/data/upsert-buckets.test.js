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
import { bucketByKeySet, planUpsertBatches, upsertBucketed } from './upsert-buckets.js';

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

// ─────────────────────────────────────────────────────────────────────────────
// upsertBucketed：把「分桶」真正落到 supabase-js 调用上
//
// 事故（2026-11-05 收盘，worker 侧同型）：
//   [extras] numcat 返回 1314 行、库内缺 27 行
//   [extras] ❌ 第 1 批写入失败: HTTP 400 {"code":"PGRST102","message":"All object keys must match"}
//   [extras] ✅ 补写 0/27 行
//   ⇒ 键集不一致不是「抹值」，是**整批 400、一行都不写**。
// ─────────────────────────────────────────────────────────────────────────────

/** 造一个假的 supabase client，记录每次真正的 upsert 调用 */
function makeFakeSb(replies) {
  const calls = [];
  const queue = (replies || []).slice();
  return {
    calls: calls,
    from(table) {
      return {
        upsert(rows, cfg) {
          calls.push({ table: table, rows: rows, cfg: cfg });
          const r = queue.shift();
          return Promise.resolve(r || { error: null });
        }
      };
    }
  };
}

describe('upsertBucketed — 逐桶提交，任何一批都不许键集不一致', () => {
  it('① 动态字段的行 ⇒ 拆成多次提交，每次键集都一致（本次修复的核心）', async () => {
    const sb = makeFakeSb();
    const rows = [
      { date: 'd', stock: '上海洗霸', volume: '16' },
      { date: 'd', stock: '大洋电机', volume: '155' },
      { date: 'd', stock: '襄阳轴承', auc_turnover: '0.70' },   // ⚠️ 没有 volume
      { date: 'd', stock: '上海九百', auc_turnover: '0.09' },
    ];
    const res = await upsertBucketed(sb, 'market_metrics', rows, { onConflict: 'date,stock,scope' });

    expect(sb.calls.length).toBe(2);
    sb.calls.forEach((c) => expect(allSameKeySet(c.rows)).toBe(true));
    expect(res.count).toBe(4);          // 一行都不许丢
    expect(res.batches).toBe(2);
  });

  it('② onConflict / ignoreDuplicates 原样透传，不传时也不报错', async () => {
    const sb1 = makeFakeSb();
    await upsertBucketed(sb1, 't', [{ a: 1 }], { onConflict: 'date,stock', ignoreDuplicates: true });
    expect(sb1.calls[0].cfg).toEqual({ onConflict: 'date,stock', ignoreDuplicates: true });

    const sb2 = makeFakeSb();
    await upsertBucketed(sb2, 't', [{ a: 1 }]);
    expect(sb2.calls[0].cfg).toBeUndefined();
  });

  it('③ 某一批失败 ⇒ 抛出，message 里必须带「第 N/M 批 + 行数 + 键集」', async () => {
    // 第 2 批失败
    const sb = makeFakeSb([{ error: null }, { error: new Error('boom') }]);
    const rows = [{ a: 1, x: 1 }, { a: 1, y: 2 }];
    let thrown = null;
    try {
      await upsertBucketed(sb, 'market_metrics', rows, { onConflict: 'a' });
    } catch (e) { thrown = e; }
    expect(thrown).toBeTruthy();
    // 照 2026-11-05 的教训：⛔ 不能再让调用方只看到一句笼统的 400 而误判成"上游没数据"
    expect(thrown.message).toContain('market_metrics');
    expect(thrown.message).toContain('2/2');
    expect(thrown.message).toContain('键集');
    expect(thrown.message).toContain('boom');       // 原始 message 必须保留
    expect(thrown.message).toContain('a,y');        // 失败那批的键集
  });

  it('④ 保留原 error 对象与关键子串 —— hotspot 靠 message 里有没有 "relation" 判表是否存在', async () => {
    const raw = new Error('relation "public.market_metrics" does not exist');
    raw.code = '42P01';
    const sb = makeFakeSb([{ error: raw }]);
    let thrown = null;
    try {
      await upsertBucketed(sb, 'market_metrics', [{ a: 1 }]);
    } catch (e) { thrown = e; }
    expect(thrown).toBe(raw);                                    // 同一个对象，不是包装
    expect(thrown.code).toBe('42P01');                           // 其它字段不许丢
    expect(thrown.message.indexOf('relation') >= 0).toBe(true);  // 子串仍可被找到
  });

  it('⑤ 空输入 ⇒ 一次请求都不发', async () => {
    const sb = makeFakeSb();
    const res = await upsertBucketed(sb, 't', [], { onConflict: 'a' });
    expect(sb.calls.length).toBe(0);
    expect(res).toEqual({ count: 0, batches: 0 });
  });

  it('⑥ size 生效：同字段 250 行按 100 切成 3 批，且每批键集一致', async () => {
    const sb = makeFakeSb();
    const rows = [];
    for (let i = 0; i < 250; i++) rows.push({ date: 'd', stock: 'S' + i });
    const res = await upsertBucketed(sb, 't', rows, { onConflict: 'a', size: 100 });
    expect(sb.calls.length).toBe(3);
    expect(sb.calls.map((c) => c.rows.length)).toEqual([100, 100, 50]);
    sb.calls.forEach((c) => expect(allSameKeySet(c.rows)).toBe(true));
    expect(res.count).toBe(250);
  });
});
