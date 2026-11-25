// abnormal-topic-ban.test.js — 第三十四条【延伸 ABN-TB】「异动后的第三天 ⇒ 同题材禁入」的回归锁
//
// 用户口径（2026-11-17 逐字）：
//   「记住总龙一第一次监管异动，之后两天，次日本来现在的规则不能买，不变，在第三天都不能买
//     它题材的股票，比如东方海洋，细分题材有(水产品,农业,东方,羊字辈)，第三天，不能选入其它
//     同题材的股票进入买点侧，临时题材包括在内。
//     比如日出东方不该选入11月16日的买点侧，日出东方(家电,热泵,东方)，含有题材窜东方就不行……
//     也就是重点监控第三天，第四天按照正常流程走。」
//
// 本文件锁四件事（⛔ 任何一条被改掉都要先问用户）：
//   ① `parseNoteTopics` 能从那天的 note 里取出**四个**题材段（含 `东方 / 羊字辈` 这种
//      题材库里没有、只存在于临时核心词/当日 note 的段）；
//   ② 认亲是【整段相等】—— 「东方」命中「家电,热泵,东方」，但不会把「东方海洋」当题材；
//   ③ 只有 `dayOffset === 2`（第三天）才生效；次日（1）/ 第四天（3）一律返回同一个 NONE 引用；
//   ④ 命中后：改标签 + 灰化那一个块 + 从 buyNames 剔除；⛔ 不接管 cashAlert、⛔ 不动其它题材、
//      ⛔ 当天已有全场空仓结论时让位。

import { describe, it, expect } from 'vitest';
import {
  parseNoteTopics, abnormalTopicBanHit, buildAbnormalTopicBan, buildAbnormalTopicBanNotice
} from './abnormal-topic-ban.js';
import { _applyAbnormalTopicBan } from './tvrb-blocks.js';
import {
  ABNORMAL_TOPIC_BAN_TAG, TVRB_ABNORMAL_TOPIC_BAN_NONE
} from './tvrb-constants.js';

// ── 真实数据夹具（2026-11-12 / 11-16 云端原值，⛔ 不是编的）────────────────────────────
const NOTE_DFHY = '10.02%(水产品,农业,东方,羊字辈)';   // 东方海洋（11-12 异动日，竞价口径 +100.78%）
const NOTE_RCDF = '5.26%(家电,热泵,东方)';             // 日出东方（11-12）
const LIB_DFHY = ['水产品', '农业'];                    // stock_topics 里东方海洋只有这两个
const LIB_RCDF = ['家电', '热泵', '东方'];              // 日出东方的库内题材
const LIB_DFCY = ['物流', '外贸'];                      // 东方创业（不该被禁）
const LIB_DDF = ['零售', '食品饮料', '东方'];           // 大东方（含东方 ⇒ 该被禁）

/**
 * ★★ [DEV-RULE 2026-11-25] 偏离事实夹具：本条判据已换成【官方偏离值】，不再是十日涨幅。
 *   11-11 东方海洋的真实偏离值 = **+100.01%**（旧口径那天的十日涨幅只有 95.71% ⇒ 判不出来）。
 */
function SEVERE(d10) {
  return { ok: true, dev10: d10 === undefined ? 100.01 : d10, dev30: 150.2, stage: 'severe' };
}
function NEAR(d10) {
  return { ok: true, dev10: d10 === undefined ? 95.5 : d10, dev30: 150.2, stage: 'near' };
}

/** 组装一份「第三天」的 ban（dayOffset=2，触发源东方海洋） */
function banOf(extra) {
  return buildAbnormalTopicBan(Object.assign({
    dayOffset: 2,
    triggerDate: '2026-11-12',
    todayDate: '2026-11-16',
    leaderName: '东方海洋',
    // ★ [DEV-RULE 2026-11-25] 尺子换成官方偏离值：11-11 东方海洋偏离值 +100.01%（结算口径）
    leaderDev: SEVERE(),
    leaderPct: 100.78,
    noteTopics: parseNoteTopics(NOTE_DFHY),
    libTopics: LIB_DFHY
  }, extra || {}));
}

describe('ABN-TB · parseNoteTopics（从当日 note 取细分题材）', function() {
  it('取出 11-12 东方海洋的四个题材段（含题材库里没有的「东方 / 羊字辈」）', function() {
    expect(parseNoteTopics(NOTE_DFHY)).toEqual(['水产品', '农业', '东方', '羊字辈']);
  });

  it('日出东方那一份同样四段里的三段能取出来', function() {
    expect(parseNoteTopics(NOTE_RCDF)).toEqual(['家电', '热泵', '东方']);
  });

  it('§10：没有括号 / 空串 / null 一律空数组（⛔ 不猜）', function() {
    expect(parseNoteTopics('')).toEqual([]);
    expect(parseNoteTopics(null)).toEqual([]);
    expect(parseNoteTopics(undefined)).toEqual([]);
    expect(parseNoteTopics('+1.63% 通信,AI应用')).toEqual([]);   // 没有括号 ⇒ 不当题材
    expect(parseNoteTopics('5.26%()')).toEqual([]);
  });

  it('多个括号 ⇒ 只认最后一个（note 里的括号是「题材串」的那一格）', function() {
    expect(parseNoteTopics('备注(x)5.26%(家电,热泵,东方)')).toEqual(['家电', '热泵', '东方']);
  });
});

describe('ABN-TB · abnormalTopicBanHit（整段相等认亲）', function() {
  const ban = banOf();

  it('日出东方(家电,热泵,东方) 命中「东方」', function() {
    expect(abnormalTopicBanHit(LIB_RCDF, ban)).toBe(true);
  });

  it('大东方(零售,食品饮料,东方) 命中「东方」', function() {
    expect(abnormalTopicBanHit(LIB_DDF, ban)).toBe(true);
  });

  it('东方创业(物流,外贸) 不命中 —— ⛔ 不能因为名字里带「东方」就禁它', function() {
    expect(abnormalTopicBanHit(LIB_DFCY, ban)).toBe(false);
  });

  it('含「农业 / 水产品 / 羊字辈」同样命中（用户点名的那三条）', function() {
    expect(abnormalTopicBanHit(['农业'], ban)).toBe(true);
    expect(abnormalTopicBanHit(['水产品'], ban)).toBe(true);
    expect(abnormalTopicBanHit(['羊字辈'], ban)).toBe(true);
  });

  it('⛔ 不做子串模糊：「东方海洋」这一整段不算题材「东方」', function() {
    expect(abnormalTopicBanHit(['东方海洋'], ban)).toBe(false);
    expect(abnormalTopicBanHit(['AI'], banOf({ noteTopics: ['AI应用'], libTopics: [] }))).toBe(false);
  });

  it('ban 不生效 / 空段 ⇒ 一律 false（§11 零副作用）', function() {
    expect(abnormalTopicBanHit(LIB_RCDF, TVRB_ABNORMAL_TOPIC_BAN_NONE)).toBe(false);
    expect(abnormalTopicBanHit(LIB_RCDF, null)).toBe(false);
    expect(abnormalTopicBanHit([], ban)).toBe(false);
  });
});

describe('ABN-TB · buildAbnormalTopicBan（只有第三天生效）', function() {
  it('dayOffset=2 ⇒ active，禁令集合 = note ∪ 题材库（去重、保序）', function() {
    const b = banOf();
    expect(b.active).toBe(true);
    expect(b.unknown).toBe(false);
    expect(b.segments).toEqual(['水产品', '农业', '东方', '羊字辈']);
    expect(b.leaderName).toBe('东方海洋');
    // ★ 换官方口径：文案里的数 = **10日偏离**（+100.01%），⛔ 不再是十日涨幅 100.78%
    expect(b.leaderDevText).toBe('+100.01%');
    expect(b.leaderPctText).toBe('+100.01%');   // 兼容字段同值（= 偏离值文本）
  });

  it('★ 触发线自检（官方偏离值）：没越红线 ⇒ 一律不生效（⛔ 反向错误比漏禁更坏）', function() {
    // 逼近（红线 ×0.9）不算异动日 ⇒ 今天不该禁同题材
    expect(banOf({ leaderDev: NEAR() })).toBe(TVRB_ABNORMAL_TOPIC_BAN_NONE);
    // 判不出（ok:false）同样不算异动日
    expect(banOf({ leaderDev: { ok: false, dev10: null, dev30: null, stage: 'unknown' } }))
      .toBe(TVRB_ABNORMAL_TOPIC_BAN_NONE);
    // 刚好越线就算（11-11 东方海洋 +100.01%）
    expect(banOf({ leaderDev: SEVERE(100.01) }).active).toBe(true);
    // 老调用方只传十日涨幅：只做「明显没到线」的粗筛（< 100% ⇒ 不生效）
    expect(banOf({ leaderDev: null, leaderPct: 84.88 })).toBe(TVRB_ABNORMAL_TOPIC_BAN_NONE);
  });

  it('dayOffset=1（次日）与 dayOffset=3（第四天）⇒ 返回同一个 NONE 引用（§19 不触发重算）', function() {
    const next = buildAbnormalTopicBan({
      dayOffset: 1, triggerDate: '2026-11-12', todayDate: '2026-11-13',
      leaderName: '东方海洋', leaderPct: 100.78, noteTopics: parseNoteTopics(NOTE_DFHY)
    });
    const day4 = buildAbnormalTopicBan({
      dayOffset: 3, triggerDate: '2026-11-12', todayDate: '2026-11-17',
      leaderName: '东方海洋', leaderPct: 100.78, noteTopics: parseNoteTopics(NOTE_DFHY)
    });
    expect(next).toBe(TVRB_ABNORMAL_TOPIC_BAN_NONE);
    expect(day4).toBe(TVRB_ABNORMAL_TOPIC_BAN_NONE);
  });

  it('§10：是第三天但判不出触发源 ⇒ unknown（⛔ 不静默放行）', function() {
    const b = banOf({ leaderName: '' });
    expect(b.active).toBe(false);
    expect(b.unknown).toBe(true);
    expect(b.detail).toContain('判不出');
  });

  it('§10：是第三天、有触发源，但两份题材都读不到 ⇒ unknown（⛔ 不当成「没有同题材」）', function() {
    const b = banOf({ noteTopics: [], libTopics: [] });
    expect(b.active).toBe(false);
    expect(b.unknown).toBe(true);
    expect(b.detail).toContain('东方海洋');
  });

  it('只要题材库有一份就能生效（note 读不到时退路仍在）', function() {
    const b = banOf({ noteTopics: [] });
    expect(b.active).toBe(true);
    expect(b.segments).toEqual(['水产品', '农业']);
  });
});

describe('ABN-TB · buildAbnormalTopicBanNotice（提示板文案）', function() {
  it('生效时写明「第三天」+ 禁令题材 + 本次剔除名单', function() {
    const n = buildAbnormalTopicBanNotice(banOf(), ['日出东方', '大东方']);
    expect(n.headline).toContain('第三天');
    expect(n.headline).toContain('同题材不买');
    expect(n.detail).toContain('水产品、农业、东方、羊字辈');
    expect(n.detail).toContain('日出东方、大东方');
    expect(n.detail).toContain('第四天');
  });

  it('一条都没命中 ⇒ 如实写「本次没有命中同题材的票」', function() {
    const n = buildAbnormalTopicBanNotice(banOf(), []);
    expect(n.headline).toBeTruthy();
    expect(n.detail).toContain('本次没有命中同题材的票');
  });

  it('判不出 ⇒ 用自己的标题（用户必须看得见「判不出」）', function() {
    const n = buildAbnormalTopicBanNotice(banOf({ leaderName: '' }), []);
    expect(n.headline).toContain('判不出');
  });

  it('不生效 ⇒ 空文案对（模板据此不渲染）', function() {
    expect(buildAbnormalTopicBanNotice(TVRB_ABNORMAL_TOPIC_BAN_NONE, [])).toEqual({ headline: '', detail: '' });
    expect(buildAbnormalTopicBanNotice(null, [])).toEqual({ headline: '', detail: '' });
  });
});

describe('ABN-TB · _applyAbnormalTopicBan（规则层改写）', function() {
  const topicsOf = function(name) {
    if (name === '日出东方') return LIB_RCDF.join(',');
    if (name === '大东方') return LIB_DDF.join(',');
    if (name === '东方创业') return LIB_DFCY.join(',');
    return '';
  };

  function makeOut() {
    return {
      blocks: [
        // ① 块标题本身就是禁令题材 ⇒ 整块灰
        { topic: '东方', picks: [{ name: '日出东方' }, { name: '东方通信' }], notes: [] },
        // ② 块标题不是禁令题材，但票自己带了「东方」⇒ 只改那一只
        { topic: '家电', picks: [{ name: '大东方' }, { name: '格力电器' }], notes: [] },
        // ③ 完全不相干 ⇒ 一行不动
        { topic: '物流', picks: [{ name: '东方创业' }], notes: [] }
      ],
      buyNames: new Set(['日出东方', '东方通信', '大东方', '格力电器', '东方创业']),
      notes: []
    };
  }

  it('11-16 真实场景：东方块整块剔除，家电块只剔大东方，物流块不动', function() {
    const out = makeOut();
    const res = _applyAbnormalTopicBan(out, banOf(), topicsOf);

    expect(res.names.sort()).toEqual(['东方通信', '大东方', '日出东方'].sort());
    expect(res.grayBlocks).toBe(1);

    // ① 块级命中 ⇒ 整块灰 + 每只票改标签
    expect(out.blocks[0].abnormalTopicGray).toBe(true);
    out.blocks[0].picks.forEach(function(p) {
      expect(p.buyActionTag).toBe(ABNORMAL_TOPIC_BAN_TAG);
      expect(p.abnormalTopicBlocked).toBe(true);
      expect(p.position).toBe('');
      expect(p.holdTag).toBe('');
    });
    // ② 票级命中 ⇒ 只改那一只，块不灰
    expect(out.blocks[1].abnormalTopicGray).toBeFalsy();
    expect(out.blocks[1].picks[0].buyActionTag).toBe(ABNORMAL_TOPIC_BAN_TAG);
    expect(out.blocks[1].picks[1].buyActionTag).toBeUndefined();
    // ③ 不相干题材一行不动
    expect(out.blocks[2].picks[0].buyActionTag).toBeUndefined();
    expect(out.blocks[2].abnormalTopicGray).toBeFalsy();

    // buyNames 只留今天真能买的 —— 否则卖点侧会标成【持有】（与「今天不给买点」矛盾）
    expect(Array.from(out.buyNames).sort()).toEqual(['东方创业', '格力电器'].sort());
  });

  it('块内票全命中且块标题没命中 ⇒ 也把整块灰掉（否则「都说不能买、块却没灰」）', function() {
    const out = {
      blocks: [{ topic: '家电', picks: [{ name: '日出东方' }, { name: '大东方' }], notes: [] }],
      buyNames: new Set(['日出东方', '大东方']),
      notes: []
    };
    const res = _applyAbnormalTopicBan(out, banOf(), topicsOf);
    expect(res.grayBlocks).toBe(1);
    expect(out.blocks[0].abnormalTopicGray).toBe(true);
    expect(out.buyNames.size).toBe(0);
  });

  it('⛔ 当天已有全场空仓结论（次日异动）⇒ 本条让位，一行不动', function() {
    const out = makeOut();
    out.abnormal = { show: true, kind: 'nextDay' };
    const res = _applyAbnormalTopicBan(out, banOf(), topicsOf);
    expect(res.count).toBe(0);
    expect(res.names).toEqual([]);
    expect(out.blocks[0].abnormalTopicGray).toBeFalsy();
    expect(out.buyNames.size).toBe(5);
  });

  it('ban 不生效 ⇒ 零副作用（§11）', function() {
    const out = makeOut();
    const res = _applyAbnormalTopicBan(out, TVRB_ABNORMAL_TOPIC_BAN_NONE, topicsOf);
    expect(res.count).toBe(0);
    expect(out.blocks[0].abnormalTopicGray).toBeFalsy();
    expect(out.buyNames.size).toBe(5);
  });

  it('块注释里必须写明原因 + 「第四天恢复」（用户要能在界面上看到为什么）', function() {
    const out = makeOut();
    _applyAbnormalTopicBan(out, banOf(), topicsOf);
    expect(out.blocks[0].notes.join('')).toContain('异动第三天');
    expect(out.blocks[0].notes.join('')).toContain('第四天');
    expect(out.blocks[0].picks[0].actionNote).toContain('第四天');
    // ⛔ 不接管空仓标语（那个 show 会整段灰化 = 空仓语义）
    expect(out.cashAlert).toBeUndefined();
  });
});
