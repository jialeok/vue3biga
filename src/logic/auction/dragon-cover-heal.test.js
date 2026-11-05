// dragon-cover-heal.test.js — 「十日涨幅覆盖收敛」的唯一判据（纯函数）
//
// 事故背景（2026-11-05 用户第 9 次报障）：
//   「十日涨幅从第 45 只，上海百九那里开始就没有，全部空白」
//   逐环取证：
//     · 09:25:10 worker 写 auction_watchlist 46 行；
//     · 10:13:32 自愈写 stock_range_pct 46 行（那一刻名单正好 46 只，全覆盖）；
//     · 10:16:08 名单扩到 76 行（+30 只 20 日补位 / 观察组壳行）；
//     · 那 30 只里 28 只在 stock_daily_pct 有 8/10 腿（数据是齐的！）
//   ⇒ 根因：自愈判据是「云端一行都没有」（map.size === 0），已经有 46 行之后就不会再跑。
//     补齐被写成了「一次性事件」，而名单是**分批到达**的。
//
// 本用例锁死修正后的判据：**看缺口集合有没有变化**，而不是看缺口数量。
//   ⛔ 尤其锁住那个反直觉的点：名单扩容时缺口是【变大】的（0 → 30），
//      任何「缺口变小才补」的实现都会把新进来的那批永久漏掉。

import { describe, it, expect } from 'vitest';
import { shouldHealForCoverage } from './dragon-rank.js';

const GAP_MIN = 12000; // 与实现里的 COVER_HEAL_MIN_GAP_MS 对齐（本用例按行为断言，不导出常量）

describe('shouldHealForCoverage — 覆盖收敛判据', () => {
  it('云端一行都没有 ⇒ 无条件自愈（原行为不变）', () => {
    expect(shouldHealForCoverage({ mapSize: 0, gapKey: 'a,b', state: null, now: 1000 })).toBe(true);
    expect(shouldHealForCoverage({ mapSize: 0, gapKey: 'a,b', state: { key: 'a,b', attempts: 3, at: 999 }, now: 100000 })).toBe(true);
  });

  it('首次发现缺口（无历史状态）⇒ 自愈', () => {
    expect(shouldHealForCoverage({ mapSize: 46, gapKey: '甲,乙', state: null, now: 5000 })).toBe(true);
  });

  it('★ 名单扩容：缺口从 0 变 30（数量变大）也必须自愈', () => {
    // 09:25 那次自愈后：名单 46 只全盖满、缺口集合为空
    const state = { key: '', attempts: 1, at: 1000 };
    // 10:16 名单扩到 76 只 ⇒ 缺口集合变成 30 个名字
    const gapKey = Array.from({ length: 30 }, (_, i) => '票' + i).join(',');
    expect(shouldHealForCoverage({ mapSize: 46, gapKey: gapKey, state: state, now: 1000 + GAP_MIN + 1 })).toBe(true);
  });

  it('缺口集合一字不变 ⇒ 不自愈（云端也补不出，⛔ 不空转 §32）', () => {
    const state = { key: '甲,乙', attempts: 1, at: 1000 };
    expect(shouldHealForCoverage({ mapSize: 46, gapKey: '甲,乙', state: state, now: 1000 + GAP_MIN + 1 })).toBe(false);
  });

  it('缺口集合变了（哪怕只是换了人）⇒ 自愈', () => {
    const state = { key: '甲,乙', attempts: 1, at: 1000 };
    expect(shouldHealForCoverage({ mapSize: 46, gapKey: '甲,丙', state: state, now: 1000 + GAP_MIN + 1 })).toBe(true);
  });

  it('§32 最小间隔内（12s）⇒ 不自愈，防同一帧多消费者重复打', () => {
    const state = { key: '甲', attempts: 1, at: 1000 };
    expect(shouldHealForCoverage({ mapSize: 46, gapKey: '甲,乙', state: state, now: 1000 + GAP_MIN - 1 })).toBe(false);
  });

  it('§32 次数上限（3 次）用尽 ⇒ 再变也不自愈', () => {
    const state = { key: '甲', attempts: 3, at: 1000 };
    expect(shouldHealForCoverage({ mapSize: 46, gapKey: '甲,乙,丙', state: state, now: 1000 + GAP_MIN + 1 })).toBe(false);
  });

  it('名单拿不到（gapKey = "*"）时按「未知缺口」处理：首次仍自愈，之后不重复', () => {
    expect(shouldHealForCoverage({ mapSize: 46, gapKey: '*', state: null, now: 1000 })).toBe(true);
    expect(shouldHealForCoverage({ mapSize: 46, gapKey: '*', state: { key: '*', attempts: 1, at: 1000 }, now: 1000 + GAP_MIN + 1 })).toBe(false);
  });
});
