// tvrb-auc-note.test.js — 说明区「20日涨幅通道」文案口径锁（§6 / §10）
//
// 11-10 起题材量比的 20 日涨幅候选池恒 9:25 竞价口径，`ebbCtx.top5[].rank20`
// 与 `range20Auc` 名次表已是同一份榜。若文案还并列一个「〔收盘口径〕」，
// 就是把同一组数字标成两个口径 ⇒ 说假话，也会让用户以为结论收盘后又会变。

import { describe, it, expect } from 'vitest';
import { _appendRange20AucNote } from './tvrb-plan.js';

function outOf() {
  return { notes: [], ebbBuy: { picks: [{ name: '主板A' }] }, newDragon: null };
}
const aucMap = new Map([['主板A', { pct: 90, days: 20, rank: 1 }]]);

describe('_appendRange20AucNote — 竞价口径统一后的文案', () => {
  it('① 两组数值/名次同源 ⇒ 只报竞价口径一段，⛔ 不出现「收盘口径」', () => {
    const out = outOf();
    const ebbCtx = {
      top5: [{ name: '主板A', pct: 90, rank20: 1 }],
      newDragonPool: []
    };
    _appendRange20AucNote(out, aucMap, ebbCtx);
    expect(out.notes).toHaveLength(1);
    expect(out.notes[0]).toContain('9:25 竞价口径 · 本板唯一口径，收盘后不变');
    expect(out.notes[0]).toContain('主板A +90.00% 第 1 名');
    expect(out.notes[0]).not.toContain('〔收盘口径〕');
  });

  it('② 回落路径（两组确实不同）⇒ 保留历史的两口径并列对照（§11 零行为变化）', () => {
    const out = outOf();
    const ebbCtx = {
      top5: [{ name: '主板A', pct: 110, rank20: 1 }],
      newDragonPool: []
    };
    _appendRange20AucNote(out, aucMap, ebbCtx);
    expect(out.notes).toHaveLength(1);
    expect(out.notes[0]).toContain('〔9:26 竞价口径〕');
    expect(out.notes[0]).toContain('〔收盘口径〕');
  });

  it('③ §10 名次表没有这只票 ⇒ 一个字都不写（⛔ 不猜名次）', () => {
    const out = outOf();
    _appendRange20AucNote(out, new Map(), { top5: [], newDragonPool: [] });
    expect(out.notes).toHaveLength(0);
  });
});
