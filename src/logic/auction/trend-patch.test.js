// trend-patch.test.js — 趋势图「缺数据日」同花顺兜底补缺 · 纯函数换算语义单测
//
// 复刻 2026-10-21 用户报障实例（时代万恒 600241，10-20 补位票趋势图当天空白）的换算语义：
//   库内真相（market_metrics 10-19 行，实测值）：
//     change_pct=-9.96% / auc_pct_chg=-9.89% / yest_volume=8176(万股,=10-16 全天量)
//   K 线真相（同花顺 historical，实测值）：
//     10-16: vol=81806100 股, close=14.15
//     10-19: vol=80381300 股, open=12.75, close=12.74
//     10-20: vol=96742200 股, open=11.96, close=13.62
import { describe, it, expect } from 'vitest';
import { computeKlineDayPatch } from './trend-patch.js';

describe('trend-patch · computeKlineDayPatch（K线腿换算，复刻时代万恒 10-20 实例）', () => {
  // 与探针逐字节一致的 K 线 series（键 = YYYYMMDD，量 = 股）
  const volKeep = new Map([
    ['20261016', 81806100],
    ['20261019', 80381300],
    ['20261020', 96742200]
  ]);
  const keep = new Map([
    ['20261019', (12.74 / 14.15 - 1) * 100],
    ['20261020', (13.62 / 12.74 - 1) * 100]
  ]);
  const openKeep = new Map([
    ['20261019', (12.75 / 14.15 - 1) * 100],
    ['20261020', (11.96 / 12.74 - 1) * 100]
  ]);

  it('10-19（窗口内缺日）：换算值与库内 market_metrics 逐位对齐', () => {
    const r = computeKlineDayPatch('20261019', keep, openKeep, volKeep);
    expect(r.changePct).toBeCloseTo(-9.96, 1);          // 库内 change_pct = "-9.96%"
    expect(r.aucPctChg).toBeCloseTo(-9.89, 1);          // 库内 auc_pct_chg = "-9.89%"
    expect(r.yestVolume).toBeCloseTo(8180.61, 0);       // 10-16 量 81806100 股 → 8180.61 万股（库内 8176，同口径）
  });

  it('10-20（用户报障的那一天）：竞价涨幅 -6.12% / 涨幅 +6.91% / 昨日成交量 = 10-19 的量', () => {
    const r = computeKlineDayPatch('20261020', keep, openKeep, volKeep);
    expect(r.aucPctChg).toBeCloseTo(-6.12, 1);          // 11.96/12.74-1（10-21 凌晨快照实测同一值）
    expect(r.changePct).toBeCloseTo(6.91, 1);           // 13.62/12.74-1（10-20 涨停）
    expect(r.yestVolume).toBeCloseTo(8038.13, 0);       // 10-19 量 80381300 股 → 万股
    expect(r.volume).toBeUndefined();                    // K 线没有竞价量（由快照腿补，本函数不产出）
  });

  it('窗口首日的「昨日」在窗口外：只要 series 覆盖到就能取到（K线起点已前移 20 自然日）', () => {
    // 缺日 = 10-13（窗口首日），series 只含 10-12 一根更早的 K 线
    const v = new Map([['20261012', 94190000], ['20261013', 99890000]]);
    const k = new Map([['20261013', -0.62]]);
    const r = computeKlineDayPatch('20261013', k, null, v);
    expect(r.yestVolume).toBeCloseTo(9419, 0);
    expect(r.changePct).toBeCloseTo(-0.62, 5);
    expect(r.aucPctChg).toBeNull();                      // openOut 缺 ⇒ null（§10 不猜）
  });

  it('上一根 K 线是停牌缺 bar：跳过它取更早的那根（严格早于的最近一天）', () => {
    const v = new Map([['20261009', 58600000], ['20261013', 99890000], ['20261014', 107090000]]);
    // 10-10~10-12 中 10-10/11 是周末、若 10-12 停牌缺 bar ⇒ 10-14 的「昨日」= 10-13（不是不存在的 10-13+1）
    const r = computeKlineDayPatch('20261014', null, null, v);
    expect(r.yestVolume).toBeCloseTo(9989, 0);
  });

  it('所有腿都取不到 ⇒ 三字段全 null（趋势图该点画 --，§10 绝不补 0）', () => {
    const r = computeKlineDayPatch('20261020', null, null, null);
    expect(r.changePct).toBeNull();
    expect(r.aucPctChg).toBeNull();
    expect(r.yestVolume).toBeNull();
  });

  it('成交量 ≤ 0 / 非数字：yestVolume = null（不用 0 冒充「昨天没成交量」）', () => {
    const v = new Map([['20261019', 0], ['20261020', 96742200]]);
    const r = computeKlineDayPatch('20261020', null, null, v);
    expect(r.yestVolume).toBeNull();
    const v2 = new Map([['20261019', NaN], ['20261020', 96742200]]);
    const r2 = computeKlineDayPatch('20261020', null, null, v2);
    expect(r2.yestVolume).toBeNull();
  });

  it('没有更早 K 线（上市首日/窗口起点即 K 线首日）：yestVolume = null', () => {
    const v = new Map([['20261020', 96742200]]);
    const r = computeKlineDayPatch('20261020', null, null, v);
    expect(r.yestVolume).toBeNull();
  });
});
