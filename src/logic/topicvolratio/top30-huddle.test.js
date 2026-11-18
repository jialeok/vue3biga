// top30-huddle.test.js — 第三十五条【30日涨幅抱团】判定纯函数（§15 可独立单测）
//
// 锁的四件事（用户 2026-11-18 逐条拍板，🚨 改任何一条都等于改选股结论）：
//   ① 只在【前三】里找（用户「30日涨幅中排前三」）；
//   ② 命中【只选最强的 1 只】（用户「只选最强的 1 只」，⛔ 不是全部命中都选）；
//   ③ 同题材 = 【核心词大类归一】（11-17 家电 → 大消费，按细分串比就认不上）；
//   ④ 判不出必须能和「真的没有」区分开（§10：no-pool ≠ no-match）。
import { describe, it, expect } from 'vitest';
import { pickTop30Huddle, TOP30_HUDDLE_RULE_NO, TOP30_HUDDLE_TAG, TOP30_HUDDLE_TOP_N, TOP30_HUDDLE_PICK_COUNT } from './top30-huddle.js';
import { makeCoreTopicResolver } from '../topic/core-category.js';

// 核心词表（与云端 core_topics 同一形状；只取测试用到的几组）
const CORE = [
  { name: '大消费', synonyms: ['家电', '食品饮料', '零售', '免税'] },
  { name: 'AI应用', synonyms: ['文化传媒', 'AI', '影视'] },
  { name: '新能源汽车', synonyms: ['汽车零部件', '机器人概念'] }
];
const coreRes = makeCoreTopicResolver(CORE);

/** 造一行榜（与 tvrb-auction-board30.js 的 rank 元素同形状 + rank30） */
function row(name, pct, topic, rank30) {
  return { stock: name, name: name, code: '600000', pct: pct, days: 30, topic: topic, rank30: rank30 };
}

describe('第三十五条 · 常量（编号 / 标签 / 门槛只允许一处定义）', () => {
  it('编号 = 三十五，标签 = 30日涨幅抱团', () => {
    expect(TOP30_HUDDLE_RULE_NO).toBe('三十五');
    expect(TOP30_HUDDLE_TAG).toBe('30日涨幅抱团');
  });

  it('只在【前三】里找，命中【只选 1 只】', () => {
    // 🚨 用户口径：TOP_N=3（「30日涨幅中排前三」）；PICK_COUNT=1（「只选最强的 1 只」）
    expect(TOP30_HUDDLE_TOP_N).toBe(3);
    expect(TOP30_HUDDLE_PICK_COUNT).toBe(1);
  });
});

describe('第三十五条 · 命中（前三里有同大类的龙 ⇒ 抱团它，让补涨让路）', () => {
  it('11-17 真实形态：家电归一成大消费 ⇒ 命中九阳股份', () => {
    // 真实数据（9:26 竞价口径 · 只主板）：九阳股份 148.76% / 冰山冷热 105.56% / 文投控股 104.24%
    // 灰色题材块 = 大消费；九阳股份行上写的是「家电,电子商务」⇒ 必须经大类归一才认得上
    const pool = [
      row('九阳股份', 148.76, '家电,电子商务', 1),
      row('冰山冷热', 105.56, '冰雪产业,算力', 2),
      row('文投控股', 104.24, 'AI视频,AI应用', 3)
    ];
    const r = pickTop30Huddle(pool, '大消费', coreRes);
    expect(r.reason).toBe('');
    expect(r.pick).not.toBeNull();
    expect(r.pick.name).toBe('九阳股份');
    expect(r.pick.rank30).toBe(1);
    expect(r.pick.pct).toBe(148.76);
    expect(r.pick.topicCore).toContain('大消费');
  });

  it('名次第 2 才同题材也能命中（不是只看第一名）', () => {
    const pool = [
      row('新华传媒', 192.09, '文化传媒', 1),
      row('九阳股份', 157.91, '家电,电子商务', 2),
      row('澳弘电子', 96.43, 'PCB,通信', 3)
    ];
    const r = pickTop30Huddle(pool, '大消费', coreRes);
    expect(r.pick.name).toBe('九阳股份');
    expect(r.pick.rank30).toBe(2);
  });

  it('★ 只选最强 1 只：前三里两只同题材 ⇒ 只返回名次靠前的', () => {
    const pool = [
      row('九阳股份', 159.99, '家电', 1),
      row('青岛食品', 130.00, '食品饮料', 2),
      row('冰山冷热', 123.69, '冰雪产业', 3)
    ];
    const r = pickTop30Huddle(pool, '大消费', coreRes);
    // 九阳股份(第1) 与 青岛食品(第2) 都归一到「大消费」⇒ 只能返回九阳股份
    expect(r.pick.name).toBe('九阳股份');
    expect(r.pick.rank30).toBe(1);
  });

  it('灰色块名本身是细分串也能命中（反向：块名=家电、票=大消费类细分）', () => {
    const pool = [row('九阳股份', 148.76, '家电,电子商务', 1)];
    const r = pickTop30Huddle(pool, '家电', coreRes);
    expect(r.pick.name).toBe('九阳股份');
  });
});

describe('第三十五条 · 不命中（回到原有第三十一条补涨票）', () => {
  it('★ 同题材票排第 4 ⇒ 不算（用户口径「排前三」）', () => {
    const pool = [
      row('新华传媒', 192.09, '文化传媒', 1),
      row('澳弘电子', 159.78, 'PCB,通信', 2),
      row('新华文轩', 140.00, '体育产业', 3),
      row('九阳股份', 130.00, '家电', 4)   // ← 第 4 名，同题材也不算
    ];
    const r = pickTop30Huddle(pool, '大消费', coreRes);
    expect(r.pick).toBeNull();
    expect(r.reason).toBe('no-match');
  });

  it('前三全是别的题材 ⇒ no-match，且名单串里带得出每只的大类（判据可追溯）', () => {
    const pool = [
      row('九阳股份', 150.17, '家电', 1),
      row('襄阳轴承', 124.81, '汽车零部件', 2),
      row('青岛食品', 76.28, '食品饮料', 3)
    ];
    // 灰色块 = AI应用 ⇒ 一只都不沾
    const r = pickTop30Huddle(pool, 'AI应用', coreRes);
    expect(r.pick).toBeNull();
    expect(r.reason).toBe('no-match');
    expect(r.topNames).toContain('九阳股份');
    expect(r.topNames).toContain('大消费');
  });
});

describe('第三十五条 · §10 判不出 ≠ 没有（两种 reason 必须分开）', () => {
  it('池子为空 ⇒ no-pool（⛔ 不是 no-match）', () => {
    expect(pickTop30Huddle([], '大消费', coreRes).reason).toBe('no-pool');
    expect(pickTop30Huddle(null, '大消费', coreRes).reason).toBe('no-pool');
  });

  it('灰色题材名取不到 ⇒ no-topic（⛔ 不写噪音说明，也不当成 no-match）', () => {
    const pool = [row('九阳股份', 148.76, '家电', 1)];
    expect(pickTop30Huddle(pool, '', coreRes).reason).toBe('no-topic');
    expect(pickTop30Huddle(pool, '   ', coreRes).reason).toBe('no-topic');
  });

  it('不传 coreRes 时退化成严格串比较（认得上、但认不出大类）', () => {
    const pool = [row('九阳股份', 148.76, '家电', 1)];
    // 无核心词表 ⇒ 「家电」≠「大消费」⇒ 不命中（这正是必须传 coreRes 的理由）
    expect(pickTop30Huddle(pool, '大消费').reason).toBe('no-match');
    // 同串则命中
    expect(pickTop30Huddle(pool, '家电').pick.name).toBe('九阳股份');
  });
});

describe('第三十五条 · 纯函数契约（§15：不改入参、可重复调用）', () => {
  it('不修改传入的池子，多次调用结果一致', () => {
    const pool = [
      row('九阳股份', 148.76, '家电', 1),
      row('冰山冷热', 105.56, '冰雪产业', 2),
      row('文投控股', 104.24, 'AI视频', 3)
    ];
    const snapshot = JSON.stringify(pool);
    const a = pickTop30Huddle(pool, '大消费', coreRes);
    const b = pickTop30Huddle(pool, '大消费', coreRes);
    expect(JSON.stringify(pool)).toBe(snapshot);
    expect(a.pick.name).toBe(b.pick.name);
    expect(a.pick.rank30).toBe(b.pick.rank30);
  });

  it('rank30 缺失时按下标兜底（数据层没填也不会写出假名次）', () => {
    const pool = [{ stock: '九阳股份', pct: 148.76, topic: '家电', code: '002242' }];
    const r = pickTop30Huddle(pool, '大消费', coreRes);
    expect(r.pick.rank30).toBe(1);
  });

  it('topN 可覆盖（默认 3，传 5 时第 4 名也能命中）', () => {
    const pool = [
      row('新华传媒', 192.09, '文化传媒', 1),
      row('澳弘电子', 159.78, 'PCB,通信', 2),
      row('新华文轩', 140.00, '体育产业', 3),
      row('九阳股份', 130.00, '家电', 4)
    ];
    expect(pickTop30Huddle(pool, '大消费', coreRes).pick).toBeNull();
    expect(pickTop30Huddle(pool, '大消费', coreRes, 5).pick.name).toBe('九阳股份');
  });
});
