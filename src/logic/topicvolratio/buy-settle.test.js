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

  // ★★ [CASE-1123-HAILI 2026-11-26 用户报障] 「在列次数」只读过不算就绪：
  //   11-23 09:27 定稿时 `auction_presence` 当天行还没产出（09:26 的 pg_cron 慢/未跑）⇒
  //   旧实现仍把 `range10PresenceDate = d` 传进来 ⇒ 本项恒通过 ⇒ 先定稿、数据到货后重算翻脸。
  it('⑦-b 在列次数【读过但当天还没算】⇒ 不放行，且点名「十日涨幅在列次数」', function() {
    const r = resolveBuySettle(full({ range10PresenceDate: '', range10PresenceGaveUp: false }));
    expect(r.settled).toBe(false);
    expect(r.missing).toContain('十日涨幅在列次数');
  });

  it('⑦-c 调用方明确「不再等」（历史日 / 今天已过 09:35）⇒ 放行并按判不出处理（⛔ 不永久锁死）', function() {
    const r = resolveBuySettle(full({ range10PresenceDate: '', range10PresenceGaveUp: true }));
    expect(r.settled).toBe(true);
    expect(r.missing).toEqual([]);
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

  // ★★ [TVRB-PLAN-SNAPSHOT 2026-11-11] 第 ⑬ 项改为【所有日期】一律要求。
  //   取证：切到历史日期会 watch(currentDate) 解冻 ⇒ 用会漂移的当前库内数据重算；
  //   11-10 的 stock_range20_pct 81 行全是 close 腿、market_metrics 的 11-10 行次日又被 worker 重写。
  //   旧代码「只对今天生效」⇒ 历史日在异步竞价口径榜算完前就定稿冻结 ⇒ 票消失且再也改不回来。
  //   ⚠️ 这是【所有历史日期 / 所有票】共用的坏链路，用户已明确指出「不是一只票问题，是整个类的问题」。
  describe('[TVRB-PLAN-SNAPSHOT] 第 ⑬⑭ 项 · 历史日期也必须等齐', function() {
    it('★ 回归锁：auctionBoardToday=false（历史日）+ 竞价榜没读过 ⇒ 仍不放行', function() {
      const r = resolveBuySettle(full({ auctionBoardToday: false, auctionBoardTried: false }));
      expect(r.settled).toBe(false);
      expect(r.missing).toContain('9:25 竞价口径 20 日涨幅榜');
    });

    it('★ 竞价榜读过（成功或失败都算）⇒ 放行；缺省 undefined 兼容老调用方', function() {
      expect(resolveBuySettle(full({ auctionBoardToday: false, auctionBoardTried: true })).settled).toBe(true);
      expect(resolveBuySettle(full({ auctionBoardTried: undefined })).settled).toBe(true);
    });

    it('★ 今天同样受第 ⑬ 项约束（⛔ 不能因为改造把今天漏掉）', function() {
      const r = resolveBuySettle(full({ auctionBoardToday: true, auctionBoardTried: false }));
      expect(r.settled).toBe(false);
      expect(r.missing).toContain('9:25 竞价口径 20 日涨幅榜');
    });

    it('★ 第 ⑭ 项：当日定稿存档还在读取中 ⇒ 不许定稿（否则存档命中后会被中间态覆盖）', function() {
      const r = resolveBuySettle(full({ planSnapshotReady: false }));
      expect(r.settled).toBe(false);
      expect(r.missing).toContain('当日定稿存档读取');
    });

    it('★ 第 ⑭ 项：hit / empty / unavailable / error 都算「读过」，⛔ 不永久挂死买点侧（§10）', function() {
      expect(resolveBuySettle(full({ planSnapshotReady: true })).settled).toBe(true);
      expect(resolveBuySettle(full({ planSnapshotReady: undefined })).settled).toBe(true);
    });

    it('★ 两项同时缺 ⇒ 占位要点名两条（用户要看到「还差什么」）', function() {
      const r = resolveBuySettle(full({ auctionBoardTried: false, planSnapshotReady: false }));
      expect(r.settled).toBe(false);
      expect(r.missing).toHaveLength(2);
      expect(r.text).toContain('9:25 竞价口径 20 日涨幅榜');
      expect(r.text).toContain('当日定稿存档读取');
    });

    // ★★ [ABN-TB 2026-11-17 用户口径] 第 ⑮ 项：第三十四条【延伸】「异动第三天 ⇒ 同题材禁入」
    //   的两份输入（D-2 竞价口径十日涨幅 + D-2 竞价名单题材串）。
    //   到货前定稿 ⇒ 到货后会有票被剔除 ⇒ 屏幕上的票「消失」（用户最反感的换票）。
    it('★ 第 ⑮ 项：异动第三天监控的两份输入没读到 ⇒ 不许定稿（会换票）', function() {
      const D2 = '2026-11-11';
      const r = resolveBuySettle(full({
        abnThirdTarget: D2, abnPrev2Date: PD, abnPrev2NoteDate: D2
      }));
      expect(r.settled).toBe(false);
      expect(r.missing).toContain('异动第三天监控');
    });

    // ★★ [RULE-35-SETTLE 2026-11-19 用户报障] 第 ⑯ 项：9:26 竞价口径【30 日涨幅榜】。
    //
    //   🔴 这是 11-17 / 11-18「第三十五条没生效」的真因（不是数据、不是部署、不是缓存）：
    //     ① `data` 首帧读 30 日榜 = null（实测要 2.2s 才回）；
    //     ② 本节 ①~⑮ 全齐 ⇒ 立刻 settled=true ⇒ `_buyPublished` 把那一帧定稿冻结；
    //     ③ 30 日榜到货后 data 重算出正确买点，但冻结不让它上屏、也不写存档
    //     ④ ⇒ 用户永远看到「判不出」+ 原来的票（11-17 广百股份 / 11-18 东方海洋）。
    //   ⇒ 门控必须等它，且**与第 ⑬ 项各管各的**：两条尺子不同（20 日 vs 30 日、腿数 20 vs 10），
    //     20 日榜落地不代表 30 日榜落地。
    it('★ 第 ⑯ 项：30 日榜没读过 ⇒ 不许定稿（否则第三十五条永远上不了屏）', function() {
      const r = resolveBuySettle(full({ top30BoardTried: false }));
      expect(r.settled).toBe(false);
      expect(r.missing).toContain('9:26 竞价口径 30 日涨幅榜');
      // 读过（成功或失败都算）⇒ 放行（§10：一次读失败不能把买点侧永久锁死）
      expect(resolveBuySettle(full({ top30BoardTried: true })).settled).toBe(true);
      // 缺省 undefined ⇒ 就绪（§11：老调用方 / 既有单测零行为变化）
      expect(resolveBuySettle(full({ top30BoardTried: undefined })).settled).toBe(true);
    });

    it('★ 第 ⑬ / ⑯ 项互不顶替：只落地 20 日榜不许放行，只落地 30 日榜也不许', function() {
      const only20 = resolveBuySettle(full({ auctionBoardTried: true, top30BoardTried: false }));
      expect(only20.settled).toBe(false);
      expect(only20.missing).toEqual(['9:26 竞价口径 30 日涨幅榜']);

      const only30 = resolveBuySettle(full({ auctionBoardTried: false, top30BoardTried: true }));
      expect(only30.settled).toBe(false);
      expect(only30.missing).toEqual(['9:25 竞价口径 20 日涨幅榜']);

      const both = resolveBuySettle(full({ auctionBoardTried: true, top30BoardTried: true }));
      expect(both.settled).toBe(true);
    });

    it('★ 第 ⑮ 项：两份都读到该日期 ⇒ 放行（⛔ 不永久挂死）', function() {
      const D2 = '2026-11-11';
      expect(resolveBuySettle(full({
        abnThirdTarget: D2, abnPrev2LeaderDate: D2, abnPrev2NoteDate: D2
      })).settled).toBe(true);
    });

    it('★ 第 ⑮ 项：没有「前两个交易日」（月初 / 空日历）⇒ 跳过，⛔ 不锁死', function() {
      expect(resolveBuySettle(full({ abnThirdTarget: '' })).settled).toBe(true);
      expect(resolveBuySettle(full({})).settled).toBe(true);
    });

    // ★★ [HOT-TOPIC-SYNC 2026-11-25 用户报障] 第 ⑱ 项：hot note 派生题材已并入缓存。
    //   原尚股份题材只在 hot_stocks.note（stock_topics 库 / 当日 watchlist 都没有），
    //   题材缓存早于 hot 幂等建成 ⇒ 题材显示 '-'。门控不等它 ⇒ 3 只定稿后又变 4 只（九阳股份进出）。
    it('★ 第 ⑱ 项：hot 派生题材未就绪 ⇒ 不许定稿（否则题材还没归类就冻结成 3 只）', function() {
      const r = resolveBuySettle(full({ hotDerivedTopicsReady: false }));
      expect(r.settled).toBe(false);
      expect(r.missing).toContain('热门股票题材归类');
      expect(r.text).toContain('热门股票题材归类');
      // 就绪（hot 到货并重建完成）⇒ 放行
      expect(resolveBuySettle(full({ hotDerivedTopicsReady: true })).settled).toBe(true);
      // 缺省 undefined ⇒ 就绪（§11：老调用方 / 既有单测零行为变化）
      expect(resolveBuySettle(full({ hotDerivedTopicsReady: undefined })).settled).toBe(true);
    });

    it('★ 第 ⑱ 项与第 ⑩ 项（题材库）互不顶替：stock_topics 库就绪 ≠ hot 派生题材就绪', function() {
      // 题材库 ready 但 hot 派生题材未就绪 ⇒ 仍不许定稿（这正是原尚股份事故的形状）
      const onlyTopicLib = resolveBuySettle(full({
        topicLibraryReady: true, hotDerivedTopicsReady: false
      }));
      expect(onlyTopicLib.settled).toBe(false);
      expect(onlyTopicLib.missing).toEqual(['热门股票题材归类']);
    });
  });
});
