// diverge-freeze.test.js — [DIVERGE-FREEZE 2026-11-20] 「占位帧被冻成当天存档」的事故锁
//
// ══════════════════════════════════════════════════════════════════════════════════════
// 事故（用户原话）
//    「题材量比那里没有出结果，一直停留在这样提示中，总龙分歧判定计算中……但是那个计数
//      标题头却显示 3 只，要修复下。」
// ══════════════════════════════════════════════════════════════════════════════════════
// 库内实证（2026-11-20）：`tvrb_plan_snapshot` 当天那一行的 `plan` 里
//   `divergePending: true` + `pickCount: 3` —— **买点侧「判定计算中」的那一帧被当成定稿存了下来**。
//   ⇒ 之后每次打开 / 刷新 / 切日期都读回这份存档 ⇒ 占位永远解除不了（实时链路的 20s 看门狗
//     再正常也没用：`displayPlan` 读的是快照）。
//
// 为什么用「静态锁」：
//   三处修复都在组合式/模板的接线层，单测里跑不起来（要 Supabase + K 线 + 完整会话）。
//   而这三处一旦被删，症状是**静默**的（不报错，只是占位永久挂着、标题写个错数字）。
//   ⇒ 把「线必须存在」钉死，改动这段代码的人会立刻看到红灯。
//
// 锁住四根线：
//   ① 写侧：`divergePending` 未解除 ⇒ 不定稿（与 buyPending 同一位置、同一硬兜底穿透）；
//   ② 读侧：存档自带 `divergePending` ⇒ 判 corrupt（不删行，靠一次干净定稿覆盖修订）；
//   ③ 头部：`summaryText` 有分歧占位分支，⛔ 不许在占位期间写「选股 N 只」；
//   ④ 保险丝：`_armDivergeWatchdog` 同一天**只上第一次**（⛔ 不许被后续调用重置）。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { isSnapshotPlaceholderFrame, shouldPersistPlanSnapshot } from './plan-snapshot-rules.js';

const SRC = readFileSync('src/composables/useTopicVolRatioBoard.js', 'utf8');

describe('[DIVERGE-FREEZE] 判据本体（真跑纯函数）', () => {
  it('带 divergePending 的 plan = 占位帧（11-20 那行的真实形状）', () => {
    expect(isSnapshotPlaceholderFrame({ divergePending: true, pickCount: 3 })).toBe(true);
  });

  it('带 buyPending 的 plan = 占位帧（语义同源）', () => {
    expect(isSnapshotPlaceholderFrame({ buyPending: true, pickCount: 0 })).toBe(true);
  });

  it('数据闸门拦下的 plan = 不存档', () => {
    expect(isSnapshotPlaceholderFrame({ buyDataGate: { blocked: true } })).toBe(true);
  });

  it('⛔ 反例：空仓 / 空仓提醒 / 分歧板 / 正常票 都必须当结论存档', () => {
    expect(isSnapshotPlaceholderFrame({ pickCount: 0 })).toBe(false);
    expect(isSnapshotPlaceholderFrame({ pickCount: 3, cashAlert: { show: true } })).toBe(false);
    expect(isSnapshotPlaceholderFrame({ pickCount: 2, divergeBuy: { picks: [] } })).toBe(false);
    expect(isSnapshotPlaceholderFrame({ pickCount: 1, blocks: [] })).toBe(false);
    expect(isSnapshotPlaceholderFrame(null)).toBe(false);
    expect(isSnapshotPlaceholderFrame(undefined)).toBe(false);
  });

  it('判 corrupt 之后放行覆盖写（自愈闭环：corrupt ⇒ repair-corrupt ⇒ write）', () => {
    const d = shouldPersistPlanSnapshot({ status: 'corrupt', selectionSig: 'x', nextSelectionSig: 'x' });
    expect(d.write).toBe(true);
    expect(d.reason).toBe('repair-corrupt');
  });
});

describe('[DIVERGE-FREEZE] 写侧：占位帧不许定稿', () => {
  it('定稿 watch 里挡了 divergePending（且保留硬兜底穿透）', () => {
    expect(SRC).toContain('if (plan && plan.divergePending && !netHardStalled.value) return;');
  });

  it('它与 buyPending 那条并列（同一位置、同一语义）', () => {
    const i = SRC.indexOf('if (plan && plan.buyPending && !netHardStalled.value) return;');
    const j = SRC.indexOf('if (plan && plan.divergePending && !netHardStalled.value) return;');
    expect(i).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(i);          // 顺序：先 buyPending 后 divergePending
    expect(j - i).toBeLessThan(2500);      // 必须在同一段准入区（别飞到大老远）
  });
});

describe('[DIVERGE-FREEZE] 读侧：坏存档判 corrupt 并自动修复', () => {
  it('读档处接上纯函数 isSnapshotPlaceholderFrame（⛔ 别再退回行内 if）', () => {
    expect(SRC).toContain('if (isSnapshotPlaceholderFrame(dec.plan))');
    expect(SRC).toContain("reason: 'frozen-placeholder-frame'");
  });

  it('⛔ 不许用删除来修：只判 corrupt，交给 repair-corrupt 覆盖', () => {
    // 守卫段落里不该出现删除调用（§11 删除安全）
    const at = SRC.indexOf('if (isSnapshotPlaceholderFrame(dec.plan))');
    const seg = SRC.slice(at, at + 500);
    expect(seg).not.toMatch(/deletePlanSnapshot|\.delete\(/);
    expect(seg).toContain('corrupt');
  });
});

describe('[DIVERGE-FREEZE] 头部摘要：占位期间不写「选股 N 只」', () => {
  it('summaryText 有 divergePending 分支，且排在 buyPending 之前', () => {
    const at = SRC.indexOf('const summaryText = computed');
    expect(at).toBeGreaterThan(-1);
    const seg = SRC.slice(at, at + 2200);
    const iDiverge = seg.indexOf('if (divergePending.value)');
    const iBuy = seg.indexOf('if (buyPending.value)');
    expect(iDiverge).toBeGreaterThan(-1);
    expect(iBuy).toBeGreaterThan(-1);
    expect(iDiverge).toBeLessThan(iBuy);   // 与模板顺序一致：闸门 > 分歧占位 > 结果确认中
    // 该分支内不许出现「选股 N 只」
    const branch = seg.slice(iDiverge, iBuy);
    expect(branch).not.toMatch(/选股 ' \+|选股\s*' \+ pickCount/);
    expect(branch).toContain('卖点');
  });

  it('「选股 N 只」只剩最后那条兜底分支', () => {
    const at = SRC.indexOf('const summaryText = computed');
    const seg = SRC.slice(at, at + 2200);
    const hits = seg.match(/选股 ' \+ pickCount/g) || [];
    expect(hits.length).toBe(1);
  });
});

describe('[DIVERGE-FREEZE] 保险丝：同日只上第一次（⛔ 不许反复重置）', () => {
  it('_armDivergeWatchdog 开头是「已有就返回」，且不再 clearTimeout 重设', () => {
    const at = SRC.indexOf('function _armDivergeWatchdog(d)');
    expect(at).toBeGreaterThan(-1);
    const seg = SRC.slice(at, at + 900);
    expect(seg).toContain('if (_divergeWatchdog.has(d)) return;');
    // 旧的「先清再设」必须消失（否则截止时间会被一路往后推）
    const beforeSetTimeout = seg.slice(0, seg.indexOf('setTimeout'));
    expect(beforeSetTimeout).not.toContain('_clearDivergeWatchdog(d)');
  });

  it('触发时先删记录再判日期 ⇒ 日期不符不会永久挂死', () => {
    const at = SRC.indexOf('function _armDivergeWatchdog(d)');
    const seg = SRC.slice(at, at + 1400);
    const iDel = seg.indexOf('_divergeWatchdog.delete(d)');
    const iCur = seg.indexOf('if (currentDate.value !== d) return;', iDel);
    expect(iDel).toBeGreaterThan(-1);
    expect(iCur).toBeGreaterThan(iDel);
  });
});
