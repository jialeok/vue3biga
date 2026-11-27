// [RULE-35-SRC 2026-11-19] 锁死「30 日榜选数据源」这条红线。
//
// 事故（用户原话）：「还是一样啊，你改的点就是不对，是不是显示层出了问题，我都刷新好几次了，
//   题材量比选股买点侧那里还是显示一样？」
// 现场：存档 rules_sig 已升到 v23（新代码确实在跑），但 buy.top30Huddle 仍是 null，
//   说明写「30日涨幅榜还没就绪 ⇒ 判不出」。而数据层 node 实测是好的（371 行、九阳股份 148.76%）。
// 根因：`_fetch` 里 `getRange30Pct(date) || await readRange30Rows(date)` 顺序反了 ——
//   浏览器现算的发布值可能是个**空 Map**，而空 Map 在 `||` 里也是真值 ⇒ 永远挡住结果表。
import { describe, it, expect } from 'vitest';
import { pickCloseRange30Source } from './range30-auction-leg.js';

/** 造一份 n 条的结果表行（带 leg，与 readRange30Rows 同形状） */
function rows(n) {
  const m = new Map();
  for (let i = 0; i < n; i++) m.set('票' + i, { pct: 10 + i, days: 30, leg: 'close' });
  return m;
}

describe('第三十五条 · 30 日涨幅的收盘口径数据源选择', () => {
  it('结果表齐 ⇒ 用结果表（云端真值，与 20 日版同源）', () => {
    const r = rows(371);
    const p = rows(5);
    expect(pickCloseRange30Source(r, p)).toBe(r);
  });

  it('🔴 现算发布值是【空 Map】时，⛔ 不许挡住结果表（这就是本次事故）', () => {
    const r = rows(371);
    const emptyPub = new Map();          // ← 浏览器 ensureRange30 发布了空 Map
    expect(pickCloseRange30Source(r, emptyPub)).toBe(r);
    // 反证：旧实现 `emptyPub || r` 会返回空 Map ⇒ 后续 0 只入榜 ⇒ ready=false
    expect(emptyPub || r).toBe(emptyPub);
  });

  it('结果表读出 null（表不可用 / 上午 9:40 前还没写）⇒ 用现算兜底', () => {
    const p = rows(286);
    expect(pickCloseRange30Source(null, p)).toBe(p);
  });

  it('现算值比结果表更全 ⇒ 用现算（早上云端还没落库时的正常路径）', () => {
    const r = rows(3);
    const p = rows(286);
    expect(pickCloseRange30Source(r, p)).toBe(p);
  });

  it('§10：两份都空 ⇒ null（判不出），⛔ 绝不返回空 Map 冒充「这天没有 30 日龙头」', () => {
    expect(pickCloseRange30Source(null, null)).toBe(null);
    expect(pickCloseRange30Source(new Map(), null)).toBe(null);
    expect(pickCloseRange30Source(null, new Map())).toBe(null);
    expect(pickCloseRange30Source(new Map(), new Map())).toBe(null);
  });

  it('非 Map 入参（异常形状）⇒ 按 0 条处理，不抛错', () => {
    expect(pickCloseRange30Source(undefined, rows(9))).toBeInstanceOf(Map);
    expect(() => pickCloseRange30Source([], {})).not.toThrow();
    expect(pickCloseRange30Source([], {})).toBe(null);
  });
});
