// new-dragon-family.test.js — 第二十八条【新题材 = 字号/字辈题材】单测
//
// 夹具全部来自 2026-11-12 / 10-22 的【真实数据】（云端 stock_range20_pct auc 腿 +
// market_metrics(scope=auction) 白名单 + stock_topics 题材库），见 .tmpdiag/audit-topic-legs.mjs。

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  pickFamilyNewDragon, buildFamilyGroups, splitTopicSegs
} from './new-dragon-family.js';
import { NEW_DRAGON_FAMILY_MIN_COUNT } from './tvrb-constants.js';

/** 11-12 前十里【进过前五】的老面孔（云上 range20 历史榜口径的机会集合） */
const EVER_1112 = new Set([
  '福莱新材', '东方海洋', '襄阳轴承', '光洋股份', '阳光照明',
  '文投控股', '浙文影业', '冰山冷热'
]);

/** 11-12 当日 9:25 竞价口径 20日涨幅前十（真值，见 cloud 取证） */
function pool1112(over) {
  const o = over || {};
  const rows = [
    { name: '福莱新材', rank20: 1, pct: 150.27, topic: '灵巧手,成人用品', isYizi: false },
    { name: '东方海洋', rank20: 2, pct: 146.92, topic: '水产品,农业,东方,羊字辈', isYizi: true },
    { name: '襄阳轴承', rank20: 3, pct: 127.23, topic: '机器人概念,汽车零部件,羊字辈' },
    { name: '光洋股份', rank20: 4, pct: 93.52, topic: '机器人概念,低空经济,羊字辈' },
    { name: '阳光照明', rank20: 5, pct: 92.78, topic: '外贸,氢能源,羊字辈' },
    { name: '文投控股', rank20: 6, pct: 89.28, topic: 'AI视频,AI应用' },
    { name: '大东方', rank20: 7, pct: 72.75, topic: '零售,食品饮料,东方' },
    { name: '日出东方', rank20: 8, pct: 65.35, topic: '家电,热泵,东方' },
    { name: '浙文影业', rank20: 9, pct: 65.30, topic: 'AI视频,AI应用' },
    { name: '冰山冷热', rank20: 10, pct: 63.48, topic: '冰雪产业,算力' }
  ];
  return rows.map(function(r) {
    return Object.assign({ code: '6000' + r.rank20, mainBoard: true, suspended: false }, r, o[r.name] || {});
  });
}

describe('[NEW-DRAGON-FAMILY] splitTopicSegs', function() {
  it('按统一分隔符切段，去空去重，纯数字视作脏值丢掉', function() {
    expect(splitTopicSegs('水产品,农业,东方,羊字辈')).toEqual(['水产品', '农业', '东方', '羊字辈']);
    expect(splitTopicSegs('AI应用+算力/数据中心')).toEqual(['AI应用', '算力', '数据中心']);
    expect(splitTopicSegs('16950')).toEqual([]);
    expect(splitTopicSegs('')).toEqual([]);
    expect(splitTopicSegs(null)).toEqual([]);
  });
});

describe('[NEW-DRAGON-FAMILY] buildFamilyGroups', function() {
  it('一个题材串可以归属多个组；成员按名次升序；freshCount = 没进过前五的只数', function() {
    const gs = buildFamilyGroups(pool1112(), EVER_1112);
    const byTopic = new Map(gs.map(function(g) { return [g.topic, g]; }));
    const df = byTopic.get('东方');
    expect(df.count).toBe(3);
    expect(df.members.map(function(m) { return m.name; })).toEqual(['东方海洋', '大东方', '日出东方']);
    expect(df.freshCount).toBe(2);
    const yang = byTopic.get('羊字辈');
    expect(yang.count).toBe(4);
    expect(yang.freshCount).toBe(0);
    expect(yang.oldestEver).toBe(true);
    // 确定性排序：最靠前名次升序
    expect(gs[0].bestRank).toBeLessThanOrEqual(gs[gs.length - 1].bestRank);
  });
});

describe('[NEW-DRAGON-FAMILY] 11-12 真值：东方海洋（竞价一字）+ 大东方', function() {
  const r = pickFamilyNewDragon(pool1112(), { everInTop5: EVER_1112 });

  it('新题材 = 东方（3 只，≥2 只门槛）', function() {
    expect(NEW_DRAGON_FAMILY_MIN_COUNT).toBe(2);
    expect(r).not.toBeNull();
    expect(r.topic).toBe('东方');
    expect(r.count).toBe(3);
  });

  it('老周期（羊字辈 4 只全是老面孔）不算新题材 —— 这是「不选襄阳轴承/光洋股份」的原因', function() {
    const topics = r.groups.map(function(g) { return g.topic; });
    expect(topics).toContain('羊字辈');
    // 羊字辈组本身存在，但它没有被选为「新题材」
    expect(r.topic).not.toBe('羊字辈');
    expect(r.topic).not.toBe('机器人概念');
  });

  it('主选 = 东方海洋（第 2，老龙换题材 ⇒ 双重属性）；但它竞价一字 ⇒ 只作题材认证', function() {
    expect(r.primary.name).toBe('东方海洋');
    expect(r.primary.rank20).toBe(2);
    expect(r.primary.everBefore).toBe(true);      // 老面孔 = 老龙换题材
    expect(r.certifier).not.toBeNull();
    expect(r.certifier.name).toBe('东方海洋');
    expect(r.certifier.reason).toBe('yizi');
    // 买点落在大东方；日出东方（第 8）不买 —— 用户原话「应该选东方海洋和大东方」
    expect(r.pick.name).toBe('大东方');
    expect(r.extras).toEqual([]);
  });
});

describe('[NEW-DRAGON-FAMILY] 同样的数据但东方海洋不是一字 ⇒ 买两只', function() {
  it('老龙换题材（双重属性）⇒ 主选东方海洋 + 补一只新面孔大东方', function() {
    const r = pickFamilyNewDragon(pool1112({ 东方海洋: { isYizi: false } }), { everInTop5: EVER_1112 });
    expect(r.pick.name).toBe('东方海洋');
    expect(r.extras.map(function(m) { return m.name; })).toEqual(['大东方']);
    expect(r.certifier).toBeNull();
  });
});

describe('[NEW-DRAGON-FAMILY] 用户口径：东方海洋不带「东方」题材 ⇒ 只选一只（大东方）', function() {
  it('东方组只剩大东方(7)+日出东方(8) ⇒ 主选=大东方(新面孔) ⇒ 不补第二只', function() {
    const r = pickFamilyNewDragon(pool1112({ 东方海洋: { topic: '水产品,农业,羊字辈' } }), { everInTop5: EVER_1112 });
    expect(r).not.toBeNull();
    expect(r.topic).toBe('东方');
    expect(r.pick.name).toBe('大东方');
    expect(r.extras).toEqual([]);
    expect(r.certifier).toBeNull();
  });
});

describe('[NEW-DRAGON-FAMILY] 判不出 ⇒ null（调用方退回旧路径，10-22 冰山冷热那次）', function() {
  it('每个题材都只有 1 只进前十 ⇒ 没有「≥2 只」的新题材', function() {
    const pool = [
      { name: '冰山冷热', rank20: 5, pct: 60, topic: '冰雪产业,算力', code: '000530', mainBoard: true },
      { name: '新华传媒', rank20: 1, pct: 188, topic: 'AI应用', code: '600825', mainBoard: true },
      { name: '慈文传媒', rank20: 2, pct: 99, topic: 'AI应用', code: '002343', mainBoard: true }
    ];
    // AI应用 有 2 只，但两只都进过前五 ⇒ 全是老面孔 ⇒ 不算新题材
    const r = pickFamilyNewDragon(pool, { everInTop5: new Set(['新华传媒', '慈文传媒']) });
    expect(r).toBeNull();
  });

  it('数据不足 / 空池 ⇒ null（§10 判不出 ≠ 判出「没有」）', function() {
    expect(pickFamilyNewDragon([], {})).toBeNull();
    expect(pickFamilyNewDragon(null, {})).toBeNull();
  });
});

describe('[NEW-DRAGON-FAMILY] 可买闸门', function() {
  it('主选非主板 ⇒ 降级为认证，买点顺延到组内下一只能买的', function() {
    const r = pickFamilyNewDragon(pool1112({ 东方海洋: { isYizi: false, mainBoard: false } }), { everInTop5: EVER_1112 });
    expect(r.certifier.name).toBe('东方海洋');
    expect(r.certifier.reason).toBe('non-main-board');
    // 补选大东方本来就成立（主选是老面孔）⇒ 买点 = 大东方
    expect(r.pick.name).toBe('大东方');
  });

  it('主选停牌 ⇒ reason=suspended，同样只作认证', function() {
    const r = pickFamilyNewDragon(pool1112({ 东方海洋: { isYizi: false, suspended: true } }), { everInTop5: EVER_1112 });
    expect(r.certifier.name).toBe('东方海洋');
    expect(r.certifier.reason).toBe('suspended');
    expect(r.pick.name).toBe('大东方');
  });

  it('整组都买不进 ⇒ 返回 null（⛔ 不硬凑一只）', function() {
    const pool = pool1112({
      东方海洋: { isYizi: true },
      大东方: { suspended: true },
      日出东方: { mainBoard: false }
    });
    const r = pickFamilyNewDragon(pool, { everInTop5: EVER_1112 });
    // 东方组整组买不进 ⇒ 退到下一个成立的新题材（AI视频组? 老面孔 ⇒ 不成立）⇒ 判不出
    expect(r).toBeNull();
  });
});

describe('[NEW-DRAGON-FAMILY] 确定性与静态锁', function() {
  it('同一份输入跑两次完全一致（说明文案可复核）', function() {
    const a = pickFamilyNewDragon(pool1112(), { everInTop5: EVER_1112 });
    const b = pickFamilyNewDragon(pool1112(), { everInTop5: EVER_1112 });
    expect(a.pick.name).toBe(b.pick.name);
    expect(JSON.stringify(a.groups)).toBe(JSON.stringify(b.groups));
  });

  it('⛔ 不许按「名字里有这个字」硬猜 —— 只认题材库里的题材段', function() {
    const src = readFileSync('src/logic/topicvolratio/new-dragon-family.js', 'utf8');
    // 没有任何「名字包含题材名」的判定（那会把 东方财富 也算进东方系）
    expect(src).not.toContain('name.indexOf(topic)');
    expect(src).not.toContain('indexOf(seg)');
    // 必须走「前十」这一个池，⛔ 不许自己再去读别的榜
    expect(src).toContain('buildFamilyGroups');
  });
});
