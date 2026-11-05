// upsert-buckets.js — PostgREST 批量 upsert 的「字段集分桶」工具（Data 层公共件，§5）
//
// 【要解决的问题：一批里字段不一致，会把没给的列写成 NULL】
//
// PostgREST 的批量 upsert 最终是**一条** `INSERT ... ON CONFLICT DO UPDATE`：
//   列清单 = 这一批所有行字段的**并集**，
//   `ON CONFLICT DO UPDATE SET col = EXCLUDED.col` 里 `EXCLUDED.col` 取的是本行在 VALUES 里的值；
//   某一行**没写**这个字段 ⇒ 它在 VALUES 里是 NULL ⇒ 原来库里正确的值被覆盖成 NULL。
//
// 🔴 真实事故（2026-11-05，用户看到第一页竞价量从有值变回 '-'）：
//   补数层一次提交 20 行：2 行是新建（带 volume），18 行只补换手率（不带 volume）。
//   结果那 18 行的 `volume` 全被写成 NULL：
//     襄阳轴承 321 → NULL、上海九百 159 → NULL（库里可查，事发前后对比）
//   而代码注释当时写的是「未提供的列保持原值（Supabase upsert 语义）」——**这句是错的**。
//
// 【对策】
//   按「字段集签名」分桶，同桶内所有行字段完全一致 ⇒ 列清单就是该桶的字段集，
//   不存在「某行缺列 ⇒ NULL 填空」。每桶单独发请求。
//
// ⚠️ 注意语义边界：本工具只保证「**不同批次之间**不会互相污染」。
//   如果调用方**显式**把某列写成空值（`''` / `null`），那仍然是「明确要清空」，
//   不会被本工具救回来 —— 想保留原值就**不要写这个键**。

/**
 * 按字段集把行分桶。
 *
 * @param {Array<object>} rows
 * @returns {Array<Array<object>>} 每桶一个数组（桶内字段集完全一致；桶顺序 = 首次出现顺序）
 */
export function bucketByKeySet(rows) {
  const buckets = new Map();
  (Array.isArray(rows) ? rows : []).forEach(function(r) {
    if (!r || typeof r !== 'object') return;
    const sig = Object.keys(r).sort().join('|');
    if (!buckets.has(sig)) buckets.set(sig, []);
    buckets.get(sig).push(r);
  });
  return Array.from(buckets.values());
}

/**
 * 把行切成「按字段集分桶 + 桶内再按大小切片」的最终提交批次。
 *
 * @param {Array<object>} rows
 * @param {number} size 单批最大行数
 * @returns {Array<Array<object>>} 每批一个数组
 */
export function planUpsertBatches(rows, size) {
  const n = Math.floor(Number(size));
  // 非法/非正数 ⇒ 回退到默认 100（**不是** 1：回退到 1 会让几千行的批量变成几千个请求）
  const max = (Number.isFinite(n) && n >= 1) ? n : 100;
  const out = [];
  bucketByKeySet(rows).forEach(function(bucket) {
    for (let i = 0; i < bucket.length; i += max) out.push(bucket.slice(i, i + max));
  });
  return out;
}
