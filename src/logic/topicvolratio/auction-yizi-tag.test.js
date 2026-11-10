// auction-yizi-tag.test.js — [TVRB-AUC-YIZI 2026-11-10 用户口径] 回归锁
//
// 用户原话：「竞价涨停也可以选进，但是要标注竞价一字涨停，等开板后进，这样更清晰，
//            提醒样式稍微区分下，我一下子就看明白。」
//
// 本测试锁住三件事：
//   ① 判定只走 limit-up.js 的唯一实现（板块 / ST 幅度），缺数据不猜；
//   ② 所有买点通道都被统一标注（槽位清单与 _clearBuySideForDataGate 一致）；
//   ③ ⛔ 零行为变化 —— 不改选股结果、不改任何既有标签 / 说明文字。

import { describe, it, expect } from 'vitest';
import {
  AUCTION_YIZI_TAG,
  TVRB_BUY_BLOCK_KEYS,
  isAuctionYiziPick,
  collectBuyBlocks,
  annotateAuctionYizi
} from './auction-yizi-tag.js';
import { _clearBuySideForDataGate } from './tvrb-plan.js';

function pick(name, extra) {
  return Object.assign({
    seq: 1,
    name: name,
    code: '600000',
    aucPct: 2.1,
    aucLimitUp: false,
    buyActionTag: '竞价买',
    actionNote: '原文说明',
    position: ''
  }, extra || {});
}

function blk(picks) {
  return { block: { topic: '测试题材' }, picks: picks, notes: [] };
}

describe('[TVRB-AUC-YIZI] 判定：只认 limit-up.js 的唯一口径', () => {
  it('11-10 现场：主板 +10.03% 竞价涨停 ⇒ 标（冰山冷热实测值）', () => {
    expect(isAuctionYiziPick(pick('冰山冷热', { aucPct: 10.03, aucLimitUp: true }))).toBe(true);
  });

  it('主板 +9.5% / -10% / 缺数据 ⇒ 不标（§10 不猜）', () => {
    // ⚠️ limit-up.js 的 EPS=0.15 容差：涨停价四舍五入到分 ⇒ 9.9% 按项目既有口径【算】一字，
    //    9.5% 不算（源码注释逐字写明）。这里锁的是「不另写第二套阈值」，不是拍一个新容差。
    expect(isAuctionYiziPick(pick('甲', { aucPct: 9.5, aucLimitUp: undefined }))).toBe(false);
    expect(isAuctionYiziPick(pick('乙', { aucPct: -10, aucLimitUp: undefined }))).toBe(false);
    expect(isAuctionYiziPick(pick('丙', { aucPct: null, aucLimitUp: undefined }))).toBe(false);
    expect(isAuctionYiziPick(pick('丁', { aucLimitUp: false }))).toBe(false);
    expect(isAuctionYiziPick(null)).toBe(false);
  });

  it('容差同源：主板 +9.9% 按 limit-up.js 口径算一字（⛔ 不另写阈值）', () => {
    expect(isAuctionYiziPick(pick('甲', { aucPct: 9.9, aucLimitUp: undefined }))).toBe(true);
  });

  it('按板块分幅度：创业板 +10% 不算、+20% 才算；北交所 +30% 算', () => {
    expect(isAuctionYiziPick(pick('创', { code: '300001', aucPct: 10, aucLimitUp: undefined }))).toBe(false);
    expect(isAuctionYiziPick(pick('创', { code: '300001', aucPct: 20, aucLimitUp: undefined }))).toBe(true);
    expect(isAuctionYiziPick(pick('京', { code: '830001', aucPct: 20, aucLimitUp: undefined }))).toBe(false);
    expect(isAuctionYiziPick(pick('京', { code: '830001', aucPct: 30, aucLimitUp: undefined }))).toBe(true);
  });

  it('finishBuyBlock 已落的客观字段优先，⛔ 不重算（§6）', () => {
    expect(isAuctionYiziPick(pick('甲', { aucPct: 1, aucLimitUp: true }))).toBe(true);
    expect(isAuctionYiziPick(pick('乙', { aucPct: 10.03, aucLimitUp: false }))).toBe(false);
  });
});

describe('[TVRB-AUC-YIZI] 统一后处理：全通道覆盖 + 零行为变化', () => {
  it('7 个买点槽位全部被标注，文案完全一致', () => {
    const out = { buy: {} };
    TVRB_BUY_BLOCK_KEYS.forEach(function(k) {
      const b = blk([pick(k + '票', { aucLimitUp: true })]);
      out[k] = (k === 'blocks') ? [b] : b;
    });
    annotateAuctionYizi(out);
    const all = collectBuyBlocks(out);
    expect(all.length).toBe(TVRB_BUY_BLOCK_KEYS.length);
    all.forEach(function(b) {
      expect(b.picks[0].auctionYiziTag).toBe(AUCTION_YIZI_TAG);
    });
    expect(AUCTION_YIZI_TAG).toContain('等开板后进');
  });

  it('out.buy.* 与 out.* 是同一批对象的两份引用 ⇒ 按引用去重、只标一次', () => {
    const b = blk([pick('甲', { aucLimitUp: true })]);
    const out = { blocks: [b], buy: { heavy: b, light: null, candidates: [b] } };
    expect(collectBuyBlocks(out).length).toBe(1);
    annotateAuctionYizi(out);
    expect(b.picks[0].auctionYiziTag).toBe(AUCTION_YIZI_TAG);
  });

  it('⛔ 零行为变化：picks 数量 / 顺序 / 名称 / 动作标签 / 说明文字一字不动', () => {
    const before = [pick('甲', { aucLimitUp: true }), pick('乙')];
    const out = { blocks: [blk(before)], buy: {} };
    const snapshot = JSON.stringify(before.map(function(p) {
      return [p.seq, p.name, p.code, p.aucPct, p.buyActionTag, p.actionNote, p.position];
    }));
    annotateAuctionYizi(out);
    expect(before.length).toBe(2);
    expect(before[0].name).toBe('甲');
    expect(before[1].name).toBe('乙');
    expect(JSON.stringify(before.map(function(p) {
      return [p.seq, p.name, p.code, p.aucPct, p.buyActionTag, p.actionNote, p.position];
    }))).toBe(snapshot);
    expect(before[0].auctionYiziTag).toBe(AUCTION_YIZI_TAG);
    expect(before[1].auctionYiziTag).toBe('');
  });

  it('非一字行显式清空，⛔ 不留上一帧的脏标记', () => {
    const p = pick('甲', { aucLimitUp: true });
    const out = { blocks: [blk([p])], buy: {} };
    annotateAuctionYizi(out);
    expect(p.auctionYiziTag).toBe(AUCTION_YIZI_TAG);
    p.aucLimitUp = false;
    annotateAuctionYizi(out);
    expect(p.auctionYiziTag).toBe('');
  });

  it('数据缺失日 fail-closed：闸门清空后无块可标、不漏票', () => {
    const out = {
      blocks: [blk([pick('甲', { aucLimitUp: true })])],
      weakHuddle: blk([pick('乙', { aucLimitUp: true })]),
      buy: { heavy: null }
    };
    _clearBuySideForDataGate(out);
    annotateAuctionYizi(out);
    expect(collectBuyBlocks(out).length).toBe(0);
    expect(out.pickCount).toBe(0);
  });
});

describe('[TVRB-AUC-YIZI] 槽位清单契约', () => {
  it('每个 KEY 都必须被 _clearBuySideForDataGate 清空（新增通道漏同步会红）', () => {
    const out = { buy: {} };
    TVRB_BUY_BLOCK_KEYS.forEach(function(k) {
      const b = blk([pick(k + '票', { aucLimitUp: true })]);
      out[k] = (k === 'blocks') ? [b] : b;
    });
    _clearBuySideForDataGate(out);
    TVRB_BUY_BLOCK_KEYS.forEach(function(k) {
      if (k === 'blocks') expect(out[k]).toEqual([]);
      else expect(out[k]).toBe(null);
    });
  });
});
