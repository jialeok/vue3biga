// nextday-buy.test.js — 第二十八条【次日买 / 次日承接】的判据与接线（规则手册八修）
//
// 用户口径（2026-11-27 逐字）：
//   「第二十八条选票是对的，但是买点不对，应该是在次日买……次日要继承下第二十八条次日买的票……
//     重要的是注意下灰色行的股票不要继承，这个非常重要，不然会误买，因为灰色行的票的现在是错误的，
//     没有买入的硬逻辑。只继承一天啊，不要无限继承，不要乱继承。」
//
// 本文件锁三件事（§6 单一真相 / §10 不许静默降级）：
//   ① 灰行不继承（`finalizeNextDayBuy` 的名单过滤）；
//   ② 只继承一天（承接块自己不再产出 `nextDayBuy`）；
//   ③ 三个契约同时存在：Logic 旗子 → 视图删除符 → CSS 渲染 + 承接组件挂载。

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  NEXT_DAY_BUY_NOTE,
  markNextDayBuy,
  finalizeNextDayBuy,
  buildNextDayCarryBlock,
  collectNextDayBuy
} from './nextday-buy.js';
import { NEXT_DAY_BUY_TAG, NEXT_DAY_CARRY_TAG } from './tvrb-constants.js';

describe('第二十八条 · 次日买（nextday-buy）', () => {
  // ── ① 灰行不继承 ───────────────────────────────────────────────────────────
  it('finalizeNextDayBuy：灰行（禁买 / 退潮牵连 / 逼近红线）一只都不进名单', () => {
    const out = {
      notes: [],
      newDragon: {
        picks: [
          { name: '华东重机', buyActionTag: NEXT_DAY_BUY_TAG, buyNextDay: true },
          // 退潮牵连（第二十六条）：标签换成【题材退潮不选】+ 行灰 ⇒ 明天也不买
          { name: '华胜天成', buyActionTag: '题材退潮不选', noBuyRowGray: true, buyNextDay: true },
          // 逼近红线（第三十六条）：只挂灰行旗子
          { name: '北纬科技', buyActionTag: NEXT_DAY_BUY_TAG, noBuyRowGray: true, buyNextDay: true }
        ]
      }
    };
    const nb = finalizeNextDayBuy(out, '2026-11-19');
    expect(nb).not.toBeNull();
    expect(nb.names).toEqual(['华东重机']);
    expect(nb.date).toBe('2026-11-19');
    expect(nb.note).toBe(NEXT_DAY_BUY_NOTE);
  });

  it('finalizeNextDayBuy：全被灰掉 ⇒ nextDayBuy = null，并如实写一条说明（⛔ 不静默）', () => {
    const out = {
      notes: [],
      newDragon: { picks: [{ name: '光洋股份', buyActionTag: '题材退潮不选', noBuyRowGray: true }] }
    };
    expect(finalizeNextDayBuy(out, '2026-11-18')).toBeNull();
    expect(out.newDragon.nextDayBuy).toBeNull();
    expect(out.notes.join('\n')).toContain('光洋股份');
    expect(out.notes.join('\n')).toContain('绝不继承');
  });

  it('markNextDayBuy：只改标签 / 旗子 / 文案，⛔ 一个票都不增删', () => {
    const block = {
      picks: [{ name: '冰山冷热', buyActionTag: '新龙买', actionNote: '（原文）' }],
      notes: []
    };
    const ret = markNextDayBuy(block, { date: '2026-10-22' });
    expect(ret).toBe(block);
    expect(block.picks).toHaveLength(1);                       // ⛔ 不增删
    const p = block.picks[0];
    expect(p.buyActionTag).toBe(NEXT_DAY_BUY_TAG);
    expect(p.buyNextDay).toBe(true);
    expect(p.nameDel).toBe(true);
    expect(p.actionNote).toContain('（原文）');                 // 原说明保留
    expect(p.actionNote).toContain('次日买');
    expect(block.notes.join('\n')).toContain('第二天才买');
  });

  // ── ② 只继承一天 ───────────────────────────────────────────────────────────
  it('buildNextDayCarryBlock：承接块自己【没有】nextDayBuy 字段（结构上不可能链式继承）', () => {
    const blk = buildNextDayCarryBlock({ date: '2026-11-18', names: ['光洋股份'] }, []);
    expect(blk).not.toBeNull();
    expect(blk.isNextDayCarry).toBe(true);
    expect(blk.nextDayBuy).toBeUndefined();
    expect(blk.picks[0].buyNextDay).toBeUndefined();           // ⛔ 不会二次传递
    expect(blk.picks[0].buyActionTag).toBe(NEXT_DAY_CARRY_TAG); // ★ 九修：【继承买】= 昨天选、今天买
    expect(String(blk.reason) + blk.notes.join('\n')).toContain('第三天');
  });

  it('buildNextDayCarryBlock：空名单 ⇒ null（⛔ 不渲染空壳）', () => {
    expect(buildNextDayCarryBlock({ date: '2026-11-18', names: [] }, [])).toBeNull();
    expect(buildNextDayCarryBlock(null, [])).toBeNull();
  });

  it('collectNextDayBuy：只认 newDragon.nextDayBuy（⛔ 不从 picks 里凑一份）', () => {
    expect(collectNextDayBuy({ newDragon: { picks: [{ name: 'A' }] } })).toBeNull();
    const got = collectNextDayBuy({ newDragon: { nextDayBuy: { date: '2026-11-19', names: ['A', 'B'], note: 'x' } } });
    expect(got).toEqual({ date: '2026-11-19', names: ['A', 'B'], note: 'x' });
  });

  // ── ③ 接线（Logic 旗子 → 视图 → CSS / 组件挂载）────────────────────────────
  it('契约闭环：Logic 调用 → 视图删除符 → CSS 渲染 → 承接组件挂载', () => {
    const plan = readFileSync('src/logic/topicvolratio/tvrb-plan.js', 'utf8');
    expect(plan).toContain('markNextDayBuy(out.newDragon');
    expect(plan).toContain('finalizeNextDayBuy(out');
    // ⛔ 新龙不再进 buyNames（今天不买），进的是承接块
    expect(plan).not.toContain("out.newDragon.picks || []).forEach(function(p) { if (p && p.name) out.buyNames.add(p.name); });");

    const buy = readFileSync('src/components/topicvolratio/TvrbBuyBlock.vue', 'utf8');
    expect(buy).toContain("'tvrb-name-del': p.nameDel");

    const css = readFileSync('src/assets/css/topic-vol-ratio-board.css', 'utf8');
    expect(css).toContain('.tvrb-name.tvrb-name-del');
    expect(css).toContain('line-through');

    const vue = readFileSync('src/views/TopicVolRatioBoard.vue', 'utf8');
    expect(vue).toContain('<TvrbNextDayCarryBlock');
    expect(vue).toContain('  nextDayCarry,\n');

    const carry = readFileSync('src/components/topicvolratio/TvrbNextDayCarryBlock.vue', 'utf8');
    expect(carry).toContain('block.block.topic');

    // 承接块必须进「买点块清单」⇒ 装饰器 / 卖点继承 / 存档遍历都能看到它
    const ov = readFileSync('src/logic/topicvolratio/plan-live-overlay.js', 'utf8');
    expect(ov).toContain("'nextDayCarry'");
    // ⛔ 次日买的票不算「今天买过」⇒ 不许进次日卖点侧
    expect(ov).toContain('if (p.buyNextDay === true) return;');
  });
});
