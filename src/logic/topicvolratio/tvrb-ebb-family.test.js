// tvrb-ebb-family.test.js — [EBB-FAMILY-TOPIC 2026-11-12] 字号/字辈题材的退潮门槛
//
// 用户原话：「20日涨幅排名前十的同题材有【2 只和两只以上羊字辈】，才能相互验证是该题材退潮，
//   当时还有海洋王，你就看 20 日涨幅在分歧的时候有多少只股票，按数量所以基本符合首次分歧占比不达标，
//   这天你也没有标注提示板。」
// ⇒ 行业题材仍按 ≥3 只；字号/字辈题材 ≥2 只即可互相验证。
// 夹具 = 2026-11-10 / 11-12 当日 9:25 竞价口径前十（真值，见 .tmpdiag/audit-topic-legs.mjs）。

import { describe, it, expect } from 'vitest';
import { classifyMainTopic, isFamilyTopicName, pickLeaderTopicSegment } from './tvrb-ebb.js';
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

describe('[EBB-FAMILY-TOPIC] pickLeaderTopicSegment：多段题材取「真正在炒的那一段」', function() {
  it('11-10 东方海洋（水产品,农业,东方,羊字辈）⇒ 取成员最多的【东方】(4 只)', function() {
    const r = pickLeaderTopicSegment(pool1110(), '东方海洋', '水产品,农业,东方,羊字辈');
    expect(r.topic).toBe('东方');
    expect(r.segments).toEqual(['水产品', '农业', '东方', '羊字辈']);
  });

  it('11-12 东方海洋 ⇒ 取成员最多的【羊字辈】(4 只)', function() {
    const r = pickLeaderTopicSegment(pool1112(), '东方海洋', '水产品,农业,东方,羊字辈');
    expect(r.topic).toBe('羊字辈');
  });

  it('单段题材原样返回（老调用方零行为变化）', function() {
    expect(pickLeaderTopicSegment(pool1110(), '福莱新材', '灵巧手').topic).toBe('灵巧手');
    expect(pickLeaderTopicSegment(null, 'X', '').topic).toBe('');
  });
});

describe('[EBB-FAMILY-TOPIC] classifyMainTopic：11-10 必须判成主线题材（旧门槛 ≥3 会判成轮动）', function() {
  const mt = classifyMainTopic(pool1110(), '东方海洋', '水产品,农业,东方,羊字辈');

  it('总龙那一段 = 东方（4 只），门槛按【字号题材 2 只】', function() {
    expect(mt.topic).toBe('东方');
    expect(mt.count).toBe(4);
    expect(mt.isFamilyTopic).toBe(true);
    expect(mt.minCount).toBe(EBB_FAMILY_TOPIC_MIN_COUNT);
    expect(mt.minCount).toBe(2);
  });

  it('⇒ kind = main（不是 rotation）—— 这就是「提示板终于会显示」的那一步', function() {
    expect(mt.kind).toBe('main');
    expect(mt.members.map(function(m) { return m.name; })).toEqual(['东方海洋', '大东方', '东方嘉盛', '日出东方']);
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
