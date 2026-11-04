// src/data/metrics-normalize.js
// [AUC-VOL-GUARD 2026-11-04] market_metrics.volume（竞价量）的归一口径 —— 唯一实现。
//
// 【为什么需要这个函数】
// 2026-11-04 用户报障：「早盘竞价看板的五日趋势图的竞价量全部显示 0，这是不可能的」。
// 实测当天 47 只名单里有 25 只（53%）volume='0'，而同一行的 auc_vol_ratio（竞价量比）
// 却是 5.43 / 15.29 / 144.88 —— **量比 = 竞价量 ÷ 基准量，竞价量为 0 则量比必为 0**，
// 两者同时出现是物理上不可能的，⇒ 这个 0 不是真值，而是上游 numcat 当日 auc_vol
// 尚未结算时返回的占位 0，被 worker 原样写进了库。
//
// 【§10 红线】读失败 / 未就绪 / 缺失 ≠ 0。
//   显示 0 会让用户以为「今天没有竞价量」，进而误判竞价强度（真要开仓的决策）。
//   所以这里把这种「自相矛盾的 0」归一成缺失（返回 null），由各视图按既有规则显示 '-' / 断点。
//   ⛔ 不是把 0 一律抹掉：真·0（量比也是 0、占比也是 0）保持 0，那是事实。
//
// 【为什么放在 Data 层】
//   这是「DB 行 → 内存行」的归一化，属于数据边界（§6 单一真相），不是业务规则；
//   Logic / UI 只消费归一后的值，⛔ 不要各自再判一次（两把尺子）。

/** 把各种形态的数值（字符串/数字/null）解析成有限数字；无法解析 ⇒ null（⛔ 不用 0 兜底） */
function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

/**
 * 竞价量归一：识别「0 但量比/占比 > 0」这种物理矛盾的假 0。
 *
 * @param {string|number|null} volume market_metrics.volume（单位：万手，字符串）
 * @param {string|number|null} [aucVolRatio] market_metrics.auc_vol_ratio（竞价量比，倍数）
 * @param {string|number|null} [aucToPreVolPct] numcat 的 auc_to_pre_vol_pct（竞价量占昨量 %，可选）
 * @returns {string|number|null} 原值原样返回；判定为假 0 时返回 null
 */
export function normalizeAucVolume(volume, aucVolRatio, aucToPreVolPct) {
  const vol = toNum(volume);
  if (vol === null) return volume;      // 空值原样返回（字符串 '' / null 由调用方决定怎么存）
  if (vol !== 0) return volume;         // 非 0：不动
  const ratio = toNum(aucVolRatio);
  const prePct = toNum(aucToPreVolPct);
  const hasRatio = ratio !== null && ratio > 0;
  const hasPrePct = prePct !== null && prePct > 0;
  if (!hasRatio && !hasPrePct) return volume;   // 真·0（量比/占比也没有）⇒ 保留 0
  return null;                                   // 自相矛盾 ⇒ 缺失
}

/** 是否是「假 0」（供诊断/日志用，避免各处再写一遍判断） */
export function isFakeZeroVolume(volume, aucVolRatio, aucToPreVolPct) {
  return normalizeAucVolume(volume, aucVolRatio, aucToPreVolPct) === null
    && toNum(volume) === 0;
}
