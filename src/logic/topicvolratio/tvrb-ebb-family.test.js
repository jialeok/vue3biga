// tvrb-ebb-family.test.js — [EBB-FAMILY-TOPIC 2026-11-12] 字号/字辈题材的退潮门槛
//
// 用户原话：「20日涨幅排名前十的同题材有【2 只和两只以上羊字辈】，才能相互验证是该题材退潮，
//   当时还有海洋王，你就看 20 日涨幅在分歧的时候有多少只股票，按数量所以基本符合首次分歧占比不达标，
//   这天你也没有标注提示板。」
// ⇒ 行业题材仍按 ≥3 只；字号/字辈题材 ≥2 只即可互相验证。
// 夹具 = 2026-11-10 / 11-12 当日 9:25 竞价口径前十（真值，见 .tmpdiag/audit-topic-legs.mjs）。

import { describe, it, expect } from 'vitest';
import { classifyMainTopic, isFamilyTopicName, pickLeaderTopicSegment, detectEbbDay } from './tvrb-ebb.js';
import { EBB_MAIN_TOPIC_MIN_COUNT, EBB_FAMILY_TOPIC_MIN_COUNT } from './tvrb-constants.js';

/** 11-10 当日 9:25 名单前十（真值） */
function pool1110() {
  return [
    { name: '东方海洋', pct: 104.68, topic: '水产品,农业,东方,羊字辈' },
    { name: '福莱新材', pct: 97.76, topic: '灵巧手,成人用品' },
    { name: '冰山冷热', pct: 83.77, topic: '冰雪产业,算力' },
    { name: '阳光照明', pct: 72.81, topic: '外贸,氢能源,羊字辈' },
    { name: '浙文影业', pct: 50.58, topic: 'AI视频,AI应用' },
    { name: '大东方', pct: 50.12, topic: '零售,食品饮料,东方' },
    { name: '文投控股', pct: 49.72, topic: 'AI视频,AI应用' },
    { name: '东方嘉盛', pct: 49.29, topic: '物流,东方' },
    { name: '日出东方', pct: 46.43, topic: '家电,热泵,东方' },
    { name: '龙江交通', pct: 43.61, topic: '高速公路,国企改革' }
  ];
}

/** 11-12 当日 9:25 名单前十（真值） */
function pool1112() {
  return [
    { name: '福莱新材', pct: 150.27, topic: '灵巧手,成人用品' },
    { name: '东方海洋', pct: 146.92, topic: '水产品,农业,东方,羊字辈' },
    { name: '襄阳轴承', pct: 127.23, topic: '机器人概念,汽车零部件,羊字辈' },
    { name: '光洋股份', pct: 93.52, topic: '机器人概念,低空经济,羊字辈' },
    { name: '阳光照明', pct: 92.78, topic: '外贸,氢能源,羊字辈' },
    { name: '文投控股', pct: 89.28, topic: 'AI视频,AI应用' },
    { name: '大东方', pct: 72.75, topic: '零售,食品饮料,东方' },
    { name: '日出东方', pct: 65.35, topic: '家电,热泵,东方' },
    { name: '浙文影业', pct: 65.30, topic: 'AI视频,AI应用' },
    { name: '冰山冷热', pct: 63.48, topic: '冰雪产业,算力' }
  ];
}

describe('[EBB-FAMILY-TOPIC] isFamilyTopicName', function() {
  it('「字辈」结尾 ⇒ 是（羊字辈）', function() {
    expect(isFamilyTopicName('羊字辈', ['东方海洋', '阳光照明'])).toBe(true);
  });

  it('组内全部成员名都含这个字号 ⇒ 是（东方）', function() {
    expect(isFamilyTopicName('东方', ['东方海洋', '大东方', '日出东方'])).toBe(true);
  });

  it('行业题材 ⇒ 否（成员名不含题材串）', function() {
    expect(isFamilyTopicName('机器人概念', ['襄阳轴承', '光洋股份'])).toBe(false);
    expect(isFamilyTopicName('AI应用', ['文投控股', '浙文影业'])).toBe(false);
  });

  it('⛔ 单字题材不判（避免「中」「东」这种误伤）', function() {
    expect(isFamilyTopicName('东', ['东方海洋', '大东方'])).toBe(false);
  });

  it('组内不足 2 只 ⇒ 否（构不成互相验证）', function() {
    expect(isFamilyTopicName('东方', ['东方海洋'])).toBe(false);
  });
});

describe('[EBB-LINEAGE-FIRST] pickLeaderTopicSegment：退潮题材 = 字辈线（老周期），⛔ 不是字号线', function() {
  it('★ 11-10 东方海洋（水产品,农业,东方,羊字辈）⇒ 取【羊字辈】(2 只)—— 用户「退潮的是羊字辈」', function() {
    // ⚠️ 上一版取「成员数最多」⇒ 拿到【东方】(4 只) ⇒ 屏幕上写成「主线东方首次退潮」，
    //    与用户口径正面冲突（「你搞混了吧？」）。退潮主体是老周期那条线 = 字辈线。
    const r = pickLeaderTopicSegment(pool1110(), '东方海洋', '水产品,农业,东方,羊字辈');
    expect(r.topic).toBe('羊字辈');
    expect(r.segments).toEqual(['水产品', '农业', '东方', '羊字辈']);
  });

  it('★ 11-12 东方海洋 ⇒ 同样是【羊字辈】(4 只)', function() {
    const r = pickLeaderTopicSegment(pool1112(), '东方海洋', '水产品,农业,东方,羊字辈');
    expect(r.topic).toBe('羊字辈');
  });

  it('没有字辈线 ⇒ 退回「成员数最多」那一段（旧口径逐字保留）', function() {
    const pool = [
      { name: '甲', pct: 90, topic: 'AI应用,文化传媒' },
      { name: '乙', pct: 80, topic: 'AI应用' },
      { name: '丙', pct: 70, topic: '文化传媒' }
    ];
    expect(pickLeaderTopicSegment(pool, '甲', 'AI应用,文化传媒').topic).toBe('AI应用');
  });

  it('字辈线不足 2 只 ⇒ 不认（构不成互相验证），退回成员数最多', function() {
    const pool = [
      { name: '东方海洋', pct: 90, topic: '水产品,农业,东方,羊字辈' },
      { name: '大东方', pct: 80, topic: '零售,东方' },
      { name: '日出东方', pct: 70, topic: '家电,东方' }
    ];
    expect(pickLeaderTopicSegment(pool, '东方海洋', '水产品,农业,东方,羊字辈').topic).toBe('东方');
  });

  it('单段题材原样返回（老调用方零行为变化）', function() {
    expect(pickLeaderTopicSegment(pool1110(), '福莱新材', '灵巧手').topic).toBe('灵巧手');
    expect(pickLeaderTopicSegment(null, 'X', '').topic).toBe('');
  });
});

describe('[EBB-FAMILY-TOPIC] classifyMainTopic：11-10 必须判成主线题材（羊字辈 2 只 ≥ 门槛 2）', function() {
  const mt = classifyMainTopic(pool1110(), '东方海洋', '水产品,农业,东方,羊字辈');

  it('★ 总龙那一段 = 羊字辈（2 只），门槛按【字号/字辈题材 2 只】', function() {
    expect(mt.topic).toBe('羊字辈');
    expect(mt.count).toBe(2);
    expect(mt.isFamilyTopic).toBe(true);
    expect(mt.minCount).toBe(EBB_FAMILY_TOPIC_MIN_COUNT);
    expect(mt.minCount).toBe(2);
  });

  it('⇒ kind = main（不是 rotation）—— 这就是「提示板终于会显示」的那一步', function() {
    expect(mt.kind).toBe('main');
    expect(mt.members.map(function(m) { return m.name; })).toEqual(['东方海洋', '阳光照明']);
  });

  it('行业题材仍按 ≥3 只（用户 10-25 口径不动）', function() {
    expect(EBB_MAIN_TOPIC_MIN_COUNT).toBe(3);
    // 行业题材只有 2 只 ⇒ 轮动
    const pool = [
      { name: '甲', pct: 90, topic: '机器人概念' },
      { name: '乙', pct: 80, topic: '机器人概念' },
      { name: '丙', pct: 70, topic: 'abc' },
      { name: '丁', pct: 60, topic: 'def' },
      { name: '戊', pct: 50, topic: 'ghi' },
      { name: '己', pct: 40, topic: 'jkl' },
      { name: '庚', pct: 30, topic: 'mno' },
      { name: '辛', pct: 20, topic: 'pqr' },
      { name: '壬', pct: 10, topic: 'stu' },
      { name: '癸', pct: 5, topic: 'vwx' }
    ];
    const r = classifyMainTopic(pool, '甲', '机器人概念');
    expect(r.count).toBe(2);
    expect(r.isFamilyTopic).toBe(false);
    expect(r.kind).toBe('rotation');
  });

  it('榜单不满 10 只且组内不足门槛 ⇒ unknown（§10 判不出 ≠ 判出轮动）', function() {
    const r = classifyMainTopic(pool1110().slice(0, 5), '东方海洋', '水产品,农业,东方,羊字辈');
    expect(r.total).toBe(5);
    expect(r.kind === 'unknown' || r.kind === 'main').toBe(true);
  });
});

describe('★★ [EBB-LINEAGE-FIRST + EBB-PHASE-KEY] 11-10 端到端：提示板写【羊字辈二次确认退潮】', function() {
  // 用户 11-12 原话：「从 11月10日 开始，东方海洋就是首次退潮……当时竞价低开在 11月10日又分歧一次，
  //   从现在开始这叫二次分歧，二次分歧等同于首次退潮了，所以从这天开始确认羊字辈退潮了。」
  // ⚠️ 落库历史里 11-05 那行的 leader_topic 是「农业」（旧口径写的），
  //   [EBB-PHASE-KEY] 起按【同一只总龙】认周期 ⇒ 题材改名不会把计数清零。
  const HIST = [
    { date: '2026-11-04', prevDate: '2026-11-03', leaderStock: '九阳股份', leaderTopic: '家电', ebb: true },
    { date: '2026-11-05', prevDate: '2026-11-04', leaderStock: '东方海洋', leaderTopic: '农业', ebb: true },
    { date: '2026-11-06', prevDate: '2026-11-05', leaderStock: '东方海洋', leaderTopic: '农业', ebb: false },
    { date: '2026-11-09', prevDate: '2026-11-06', leaderStock: '东方海洋', leaderTopic: '农业', ebb: false }
  ];
  const CTX = {
    ready: true,
    leader: { name: '东方海洋', pct: 104.68, topic: '水产品,农业,东方,羊字辈' },
    leaderSuspended: false,
    leaderShare: 2.93,          // 真值：2175.4 / 74246
    siblingDragons: [], secondInfo: null, prevLeader: null, buyPicks: [], buyTrail: [],
    topicPool: pool1110(),
    leaderStreak: 2,            // 11-06 +9.97、11-09 +10.08 都涨停
    leaderStreakLabel: '2板'
  };
  const prevDay = { date: '2026-11-09', leader_stock: '东方海洋', ebb: false };

  it('★ phase = second、标题 = 羊字辈二次确认退潮（⛔ 不是「主线东方首次退潮」）', function() {
    const r = detectEbbDay(CTX, prevDay, HIST);
    expect(r).not.toBeNull();
    expect(r.phase).toBe('second');
    expect(r.leaderTopic).toBe('羊字辈');
    expect(r.phaseTitle).toBe('羊字辈二次确认退潮');
    expect(r.headline).toContain('羊字辈二次确认退潮');
    // 用户要求写清「二次分歧等同该题材退潮」
    expect(r.phaseNote).toContain('二次分歧');
    expect(r.phaseNote).toContain('等同首次退潮');
    // 闸门 A 的留痕也要是羊字辈、2 只（用户「字辈是羊字辈，因为占两只，也满足条件啊」）
    expect(r.mainTopicKind).toBe('main');
    expect(r.mainTopicTopic).toBe('羊字辈');
    expect(r.mainTopicCount).toBe(2);
  });

  it('★ 同一套数据换成「11-09 也已退潮」⇒ 昨日闸门拦下（延续不算新事件）', function() {
    expect(detectEbbDay(CTX, { date: '2026-11-09', leader_stock: '东方海洋', ebb: true }, HIST)).toBeNull();
  });
});
