/**
 * [BUY-SETTLE 2026-10-31] 买点侧「选股输入是否齐了」的判据单测。
 *
 * 锁的是四类会「静默买错票」的红线：
 *   ① 七项输入全部落地 ⇒ 放行；
 *   ② 缺任何一项 ⇒ 不放行，且 missing 要**点名**（用户要看到「还差什么」）；
 *   ③ 切日期那一帧（所有带日期的 ref 还是旧日期）⇒ 必须继续挂占位（§10 不拿 A 日顶 B 日）；
 *   ④ 没有上一交易日（空日历 / 极端配置）⇒ 跳过昨日两项，⛔ 不能因此永久挂起。
 */
import { describe, it, expect } from 'vitest';
import { resolveBuySettle, isRange20CoverageReady, TVRB_R20_COVER_MIN } from './buy-settle.js';

const D = '2026-10-30';
const PD = '2026-10-29';
const OLD = '2026-10-28';

/** 全部落地的基准 ctx（改某几项来造用例） */
function full(over) {
  return Object.assign({
    date: D,
    prevDate: PD,
    coreTopicsLoaded: true,
    buyRangeDate: D,
    curRangeDate: D,
    prevRangeTriedDate: PD,
    prevEbbDayDate: PD,
    ebbHistoryDate: D,
    range10PresenceDate: D,
    switchDay: false,
    top5HistDate: D
  }, over || {});
}

describe('resolveBuySettle · 买点侧选股输入门控', function() {
  it('① 七项全齐 ⇒ 放行（settled=true，无 missing）', function() {
    const r = resolveBuySettle(full());
    expect(r.settled).toBe(true);
    expect(r.missing).toEqual([]);
    expect(r.text).toBe('');
  });

  it('② 缺任何一项都不放行，且 missing 点名（用户要看「还差什么」）', function() {
    const cases = [
      ['coreTopicsLoaded', false, '核心题材大类'],
      ['buyRangeDate', '', '9:26 竞价口径'],
      ['curRangeDate', '', '当日十日涨幅'],
      ['prevRangeTriedDate', '', '昨日十日涨幅'],
      ['prevEbbDayDate', '', '昨日退潮判定'],
      ['ebbHistoryDate', '', '近 20 日退潮历史'],
      ['range10PresenceDate', '', '十日涨幅在列次数']
    ];
    cases.forEach(function(c) {
      const over = {}; over[c[0]] = c[1];
      const r = resolveBuySettle(full(over));
      expect(r.settled).toBe(false);
      expect(r.missing).toContain(c[2]);
      expect(r.text).toContain(c[2]);
    });
  });

  it('③ 切日期那一帧：所有 ref 还是旧日期 ⇒ 必须继续挂占位（§10 红线）', function() {
    const r = resolveBuySettle(full({
      date: D, prevDate: PD,
      buyRangeDate: OLD, curRangeDate: OLD,
      prevRangeTriedDate: OLD, prevEbbDayDate: OLD,
      ebbHistoryDate: OLD, range10PresenceDate: OLD
    }));
    expect(r.settled).toBe(false);
    // 七项里除 coreTopics 全是旧日期 ⇒ 六项都要点名
    expect(r.missing.length).toBe(6);
    expect(r.text.startsWith('还差：')).toBe(true);
  });

  it('④ 没有上一交易日 ⇒ 跳过昨日两项，其余齐了就放行（⛔ 不能永久挂起）', function() {
    const r = resolveBuySettle(full({ prevDate: '', prevRangeTriedDate: '', prevEbbDayDate: '' }));
    expect(r.settled).toBe(true);
  });

  it('⑤ 切换日才要求「20 日涨幅历史榜」；非切换日不要求（否则普通日子白等一次请求）', function() {
    expect(resolveBuySettle(full({ switchDay: false, top5HistDate: '' })).settled).toBe(true);
    const r = resolveBuySettle(full({ switchDay: true, top5HistDate: '' }));
    expect(r.settled).toBe(false);
    expect(r.missing).toContain('20 日涨幅历史榜');
    expect(resolveBuySettle(full({ switchDay: true, top5HistDate: D })).settled).toBe(true);
  });

  it('⑥ 没给展示日 ⇒ 不归本门控管（空态由「未就绪」那一路负责）', function() {
    expect(resolveBuySettle({}).settled).toBe(true);
    expect(resolveBuySettle(null).settled).toBe(true);
    expect(resolveBuySettle({ date: '' }).settled).toBe(true);
  });

  it('⑦ 日期带空格也能认亲（读回来的字符串常带空白）', function() {
    const r = resolveBuySettle(full({ date: ' ' + D + ' ' }));
    expect(r.settled).toBe(true);
    expect(resolveBuySettle(full({ buyRangeDate: D + ' ' })).settled).toBe(true);
  });

  // ★★ [BUY-SETTLE-2 2026-10-31] 第 ⑨ 项：20 日涨幅前五的结论。
  //   它最慢（K 线精算）且能整段换板（常规选股 ↔ 退潮替补）—— 用户第三次报障的
  //   「变成一只 → 又跳转两只 → 又变成一只」就可能是它在迟到。
  it('⑧ 20 日涨幅结论未到 ⇒ 不放行；到了（或宽限放行）⇒ 放行', function() {
    const r = resolveBuySettle(full({ range20Settled: false }));
    expect(r.settled).toBe(false);
    expect(r.missing).toContain('20 日涨幅结论');
    expect(resolveBuySettle(full({ range20Settled: true })).settled).toBe(true);
  });

  it('⑨ 调用方没提供 range20Settled（老调用 / 单测缺省）⇒ 不因此挂起（向后兼容）', function() {
    expect(resolveBuySettle(full({ range20Settled: undefined })).settled).toBe(true);
  });

  // ★★ [TVRB-R20-COVER 2026-11-10 · 第十二项] 20 日涨幅榜【覆盖度】
  //   11-10 事故：9:26 云端补位被 limit=1000 截断 ⇒ 表只有 19/75 行，但「前五结论」照样发布，
  //   买点侧据此定稿空仓；10:00 表格补齐后第三十条才选出冰山冷热，却又被定稿冻结挡住。
  describe('[TVRB-R20-COVER] 残缺 20 日涨幅榜不允许定稿', function() {
    it('★ 覆盖不足 ⇒ 不放行，且明确点名「云端补位中」', function() {
      const r = resolveBuySettle(full({ range20CoverageReady: false }));
      expect(r.settled).toBe(false);
      expect(r.missing).toContain('20 日涨幅榜（云端补位中）');
    });

    it('★ 覆盖达标 ⇒ 放行（与其余十一项互不干扰）', function() {
      expect(resolveBuySettle(full({ range20CoverageReady: true })).settled).toBe(true);
    });

    it('★ 缺省 undefined ⇒ 就绪（老调用方 / 既有单测零行为变化，§11）', function() {
      expect(resolveBuySettle(full({})).settled).toBe(true);
    });

    it('★ 11-10 现场数据：19/75 挡住、71/75 放行，阈值 0.8 两态都不贴边', function() {
      expect(TVRB_R20_COVER_MIN).toBe(0.8);
      expect(isRange20CoverageReady({ isToday: true, rowCount: 19, listed: 75 })).toBe(false);
      expect(isRange20CoverageReady({ isToday: true, rowCount: 71, listed: 75 })).toBe(true);
    });

    it('★ rowCount=null（还没读过表）≠ 0 行 ⇒ 继续等（§10）', function() {
      expect(isRange20CoverageReady({ isToday: true, rowCount: null, listed: 75 })).toBe(false);
      expect(isRange20CoverageReady({ isToday: true, rowCount: undefined, listed: 75 })).toBe(false);
    });

    it('★ 历史日恒 true（表本来就可能稀疏，⛔ 不拿今天的标尺卡历史）', function() {
      expect(isRange20CoverageReady({ isToday: false, rowCount: 3, listed: 75 })).toBe(true);
    });
  });
});
