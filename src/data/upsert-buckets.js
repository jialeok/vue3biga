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
//
// 【同一件事还有更狠的一半：键集不一致 ⇒ 整批 400、一行都不写】
//
// 🔴 真实事故（2026-11-05 收盘，worker 侧）：
//     [extras] 库内缺「四要素/竞价涨幅」的行 27 行
//     [extras] numcat 返回 1314 行
//     [extras] ❌ 第 1 批写入失败: HTTP 400 {"code":"PGRST102","message":"All object keys must match"}
//     [extras] ✅ 补写 0/27 行
//   1314 行数据全部拿到，一行都没落库 ⇒ 当日 `auc_vol_ratio` 58/78，缺 20 只。
//
// 所以「键集必须一致」不只是为了不抹值，它是**请求能不能成功**的前提：
//   · 键集一致 ⇒ 一条 INSERT 正常执行；
//   · 键集不一致 ⇒ PGRST102 直接 400 ⇒ 整批丢弃（不是逐行丢弃，是全部）。
// 两个后果都靠同一个动作解决：**按键集分桶**。
//
// ⛔ 别用 `Prefer: missing=default` 或 `?columns=` 去"修"这件事：
//   前者语义是「缺的列取 DEFAULT（通常 NULL）」= 抹值，且 PGRST102 在请求体解析阶段就 400，
//   这条偏好根本来不及生效；后者同罪，缺列照样被写成 NULL。

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

/**
 * 用「分桶后的批次」执行一次批量 upsert（supabase-js 版公共入口）。
 *
 * 调用方只需把原来的
 *     sb.from('t').upsert(rows, { onConflict: 'a,b' })
 * 换成
 *     upsertBucketed(sb, 't', rows, { onConflict: 'a,b' })
 * 语义完全一致，但不会因为行间键集不同而整批 400 / 抹值。
 *
 * @param {object} sb        supabase client
 * @param {string} table     表名
 * @param {Array<object>} rows
 * @param {object} [opts]    { onConflict, ignoreDuplicates, size }
 * @returns {Promise<{count:number, batches:number}>}
 * @throws 任一批失败即抛出（message 里带「第 N/M 批 + 行数 + 键集」，照 2026-11-05 事故的教训，
 *         ⛔ 不要再让调用方只看到一句笼统的 400 而误判成"上游没数据"）
 */
export async function upsertBucketed(sb, table, rows, opts) {
  const o = opts || {};
  const batches = planUpsertBatches(rows, o.size);
  if (batches.length === 0) return { count: 0, batches: 0 };

  const cfg = {};
  if (o.onConflict) cfg.onConflict = o.onConflict;
  if (o.ignoreDuplicates) cfg.ignoreDuplicates = true;
  const hasCfg = Object.keys(cfg).length > 0;

  let count = 0;
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const { error } = await sb.from(table).upsert(batch, hasCfg ? cfg : undefined);
    if (error) {
      const keys = Object.keys(batch[0] || {}).sort().join(',');
      const prefix = 'upsert ' + table + ' 第 ' + (i + 1) + '/' + batches.length
        + ' 批失败（' + batch.length + ' 行，键集 [' + keys + ']）: ';
      // ★ 保留原 error 对象（上层有用 message.indexOf('relation') 判表不存在的逻辑），
      //   只把上下文拼到 message 前面。
      if (error && typeof error === 'object') error.message = prefix + (error.message || '');
      throw error;
    }
    count += batch.length;
  }
  return { count: count, batches: batches.length };
}
