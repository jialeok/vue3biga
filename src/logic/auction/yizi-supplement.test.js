// yizi-supplement.test.js — 「早盘竞价 · 补竞价一字（按题材融入）」纯函数层单测
//
// 只测纯变换：一字题材分块 → 融进早盘竞价题材序列。⛔ 不碰网络 / state / DB / 早盘竞价数据。
//
// 重点锁死五条（写错会让用户拿到错误的「哪个题材一字多」结论，或让补入行跑错题材组）：
//   ① 融入 = 追加到【已有题材组的组内末尾】，⛔ 绝不新增一个「竞价一字补充」整块（2026-09-20 修正的正是这条）；
//   ② 一字股任一题材命中组名即进该组；命中多个组 → 多组都进（如华软科技「芯片,化工」）；
//   ③ 重复的不融（股票名已在早盘竞价列表里）；
//   ④ 组序 / 原有行顺序一个字都不动；
//   ⑤ 只搬运既有字段（序号 / 龙头 / 十日涨幅 / 连板 / 封单额），⛔ 不重算任何口径。
import { describe, it, expect } from 'vitest';
import { mergeYiziIntoAuctionRows, formatMergeSummary } from './yizi-supplement.js';

// 可分组核心词（真实运行来自 topic/rules.js#getGroupableCoreTopics；测试里给出最小等价集）
const CORES = [
  { name: '化工' }, { name: '芯片' }, { name: '通信' },
  { name: '算力' }, { name: '机器人' }
];

/** 早盘竞价题材模式下的一行（Logic 层 view-helpers 已给每行标上 groupTopic） */
function arow(stock, groupTopic, index) {
  return { stock: stock, groupTopic: groupTopic, index: index || 0 };
}

/** 一字看板块内的一行 */
function yrow(stock, topicsDisplay, extra) {
  return Object.assign({ stock: stock, seq: 1, topicsDisplay: topicsDisplay }, extra || {});
}

/** 一字看板的一个题材块 */
function blk(topic, rows) {
  return { topic: topic, count: (rows || []).length, stocks: rows || [] };
}

function merge(auctionRows, blocks, opts) {
  return mergeYiziIntoAuctionRows(auctionRows, blocks, Object.assign({ coreTopics: CORES }, opts || {}));
}

const AUCTION = [
  arow('西陇科学', '化工', 0),
  arow('中晶电子', '芯片', 1),
  arow('浪潮信息', '算力', 2)
];

describe('mergeYiziIntoAuctionRows · 按题材融入（不是整块追加）', () => {
  it('一字股落进对应题材组，⛔ 不新增分组（组数不变，组序不变）', () => {
    const out = merge(AUCTION, [blk('化工', [yrow('中材科技', '通信,化工')])]);

    expect(out.segments.map(s => s.topic)).toEqual(['化工', '芯片', '算力']);
    expect(out.segments[0].sups.map(s => s.stock)).toEqual(['中材科技']);
    expect(out.segments[1].sups).toEqual([]);
    expect(out.segments[2].sups).toEqual([]);
    // 每个分组都还是「早盘竞价原有行 + 补入行」，且没有 isOrphan 尾段
    expect(out.segments.every(s => s.isOrphan === false)).toBe(true);
  });

  it('补入行带 mergedTopic（模板据此渲染「补」标），值 = 被并入的组名', () => {
    const out = merge(AUCTION, [blk('化工', [yrow('中材科技', '通信,化工')])]);
    expect(out.segments[0].sups[0].mergedTopic).toBe('化工');
  });

  it('一字的任一题材命中组名即融入；命中多个组 → 多个组都能看到它', () => {
    const out = merge(AUCTION, [blk('芯片', [yrow('华软科技', '芯片,化工')])]);
    const inChip = out.segments.find(s => s.topic === '芯片');
    const inChem = out.segments.find(s => s.topic === '化工');
    expect(inChip.sups.map(s => s.stock)).toEqual(['华软科技']);
    expect(inChem.sups.map(s => s.stock)).toEqual(['华软科技']);
    expect(inChip.sups[0].mergedTopic).toBe('芯片');
    expect(inChem.sups[0].mergedTopic).toBe('化工');
    // 只数按「只」算，行数按「行」算 —— 多题材会同时出现在两组里
    expect(out.stats.mergedStocks).toBe(1);
    expect(out.stats.mergedRows).toBe(2);
  });

  it('补入行排在【该组原有股票之后】，原有行的顺序与内容一个字节都不动', () => {
    const out = merge(AUCTION, [blk('化工', [yrow('甲', '化工'), yrow('乙', '化工')])]);
    const seg = out.segments[0];
    expect(seg.rows).toHaveLength(1);
    expect(seg.rows[0]).toBe(AUCTION[0]);          // 同引用：原行对象没有被复制/改写
    expect(seg.sups.map(s => s.stock)).toEqual(['甲', '乙']);
  });

  it('已有列表中：整只跳过，不重复融（并如实计入 inListCount）', () => {
    const out = merge(AUCTION, [
      blk('化工', [yrow('西陇科学', '化工'), yrow('中材科技', '化工')])
    ], { excludeNames: ['西陇科学'] });

    expect(out.segments[0].sups.map(s => s.stock)).toEqual(['中材科技']);
    expect(out.stats.inListCount).toBe(1);
    expect(out.stats.mergedStocks).toBe(1);
  });

  it('excludeNames 接受数组 / Set / 空值，且对空名与前后空格做归一', () => {
    const blocks = [blk('化工', [yrow('甲', '化工'), yrow('乙', '化工')])];
    const namesOf = (o) => merge(AUCTION, blocks, o).segments[0].sups.map(s => s.stock);
    expect(namesOf({ excludeNames: [' 甲 '] })).toEqual(['乙']);
    expect(namesOf({ excludeNames: new Set(['甲']) })).toEqual(['乙']);
    expect(namesOf({ excludeNames: [] })).toEqual(['甲', '乙']);
    expect(namesOf({})).toEqual(['甲', '乙']);
  });
});

describe('mergeYiziIntoAuctionRows · 未并入尾段（§10 绝不静默丢弃）', () => {
  it('题材在当日列表里一个组都没命中 → 进「未并入」尾段（排在最后，合并主行为空）', () => {
    const out = merge(AUCTION, [blk('固态电池', [yrow('甲', '固态电池')])]);

    const last = out.segments[out.segments.length - 1];
    expect(out.segments).toHaveLength(4);            // 3 个原有组 + 尾段
    expect(last.isOrphan).toBe(true);
    expect(last.rows).toEqual([]);
    expect(last.sups.map(s => s.stock)).toEqual(['甲']);
    expect(last.sups[0].mergedTopic).toBe('');       // 无处可融 → 不谎报组名
    expect(out.stats.orphanCount).toBe(1);
    expect(out.stats.mergedStocks).toBe(0);
  });

  it('全部都能融入时不产生尾段（不会多出一段空的）', () => {
    const out = merge(AUCTION, [blk('化工', [yrow('甲', '化工')])]);
    expect(out.segments.some(s => s.isOrphan)).toBe(false);
    expect(out.stats.orphanCount).toBe(0);
  });

  it('无题材的一字股与列表的「其它」组同义 → 融进「其它」，⛔ 不因无题材就当未并入', () => {
    const rows = AUCTION.concat([arow('某某', '其它', 3)]);
    const out = merge(rows, [blk('其它', [yrow('甲', '-')])]);
    const other = out.segments.find(s => s.topic === '其它');
    expect(other.sups.map(s => s.stock)).toEqual(['甲']);
    expect(out.stats.orphanCount).toBe(0);
  });

  it('有真题材、只是当日列表没有这个组 → 进尾段，⛔ 不冒充「其它」', () => {
    const rows = AUCTION.concat([arow('某某', '其它', 3)]);
    const out = merge(rows, [blk('固态电池', [yrow('甲', '固态电池')])]);
    const other = out.segments.find(s => s.topic === '其它');
    expect(other.sups).toEqual([]);
    expect(out.stats.orphanCount).toBe(1);
  });
});

describe('mergeYiziIntoAuctionRows · 边界与健壮性', () => {
  it('入参不是数组 → 空结果（不抛）', () => {
    const empty = { segments: [], stats: { yiziTotal: 0, mergedStocks: 0, mergedRows: 0, inListCount: 0, orphanCount: 0 } };
    expect(mergeYiziIntoAuctionRows(null, null)).toEqual(empty);
    expect(mergeYiziIntoAuctionRows(undefined, undefined)).toEqual(empty);
    expect(mergeYiziIntoAuctionRows({}, {})).toEqual(empty);
  });

  it('早盘竞价没有行 → 所有一字都进尾段（无处可融时不谎报融入）', () => {
    const out = merge([], [blk('化工', [yrow('甲', '化工')])]);
    expect(out.segments).toHaveLength(1);
    expect(out.segments[0].isOrphan).toBe(true);
    expect(out.stats.orphanCount).toBe(1);
  });

  it('一字池为空 → 不产生任何尾段（原列表原样输出）', () => {
    const out = merge(AUCTION, []);
    expect(out.segments.map(s => s.topic)).toEqual(['化工', '芯片', '算力']);
    expect(out.segments.every(s => s.sups.length === 0)).toBe(true);
    expect(formatMergeSummary(out.stats)).toBe('');
  });

  it('脏行（stock 为空 / null 行）被剔除，不产出空行', () => {
    const out = merge(AUCTION, [blk('化工', [yrow('  ', '化工'), null, yrow('甲', '化工')])]);
    expect(out.segments[0].sups.map(s => s.stock)).toEqual(['甲']);
    expect(out.stats.yiziTotal).toBe(1);
  });

  it('块内同名跨块出现：题材取并集，仍只渲染一行', () => {
    const out = merge(AUCTION, [
      blk('化工', [yrow('甲', '化工')]),
      blk('芯片', [yrow('甲', '化工,芯片')])
    ]);
    expect(out.stats.yiziTotal).toBe(1);
    // 并集 = {化工, 芯片} → 两组各一行（组内仍只一行，不因同名重复堆叠）
    expect(out.segments.find(s => s.topic === '化工').sups).toHaveLength(1);
    expect(out.segments.find(s => s.topic === '芯片').sups).toHaveLength(1);
  });

  it('coreTopics 缺失时仍能按「块名（一字看板的主题材）」落位（同源加固，不因缺参漏融）', () => {
    const out = mergeYiziIntoAuctionRows(AUCTION, [blk('算力', [yrow('甲', '算力')])], {});
    expect(out.segments.find(s => s.topic === '算力').sups.map(s => s.stock)).toEqual(['甲']);
  });

  it('空块（stocks 为空）不产生任何候选', () => {
    const out = merge(AUCTION, [blk('化工', [])]);
    expect(out.stats.yiziTotal).toBe(0);
    expect(out.segments.every(s => s.sups.length === 0)).toBe(true);
  });
});

describe('mergeYiziIntoAuctionRows · 字段只搬运不重算', () => {
  const FULL = {
    seq: 3, isLeader: true, continueText: '三板',
    rangeText: '+50.29%(5/10日)', rangeTone: 'up', rangePct: 50.29,
    seal920Text: '3.20亿', seal920Tone: 'strong',
    sealDeltaText: '+0.50亿', sealDeltaTone: 'up',
    firstTimeText: '09:15:03'
  };

  it('序号 / 龙头 / 连板 / 十日涨幅 / 封单额 / 首封时刻原样透出', () => {
    const out = merge(AUCTION, [blk('化工', [yrow('甲', '化工', FULL)])]);
    expect(out.segments[0].sups[0]).toMatchObject({
      stock: '甲', seq: 3, mergedTopic: '化工', isLeader: true, continueText: '三板',
      rangeText: '+50.29%(5/10日)', rangeTone: 'up',
      seal920Text: '3.20亿', seal920Tone: 'strong',
      sealDeltaText: '+0.50亿', sealDeltaTone: 'up', firstTimeText: '09:15:03'
    });
  });

  it('缺十日涨幅 → 文本留空（模板不渲染），⛔ 绝不伪造 0 / "-"', () => {
    const out = merge(AUCTION, [blk('化工', [yrow('甲', '化工', { rangePct: null })])]);
    expect(out.segments[0].sups[0].rangeText).toBe('');
    expect(out.segments[0].sups[0].isLeader).toBe(false);
    expect(out.segments[0].sups[0].continueText).toBe('');
  });

  it('真值 0 由一字看板自己格式化成 "0.00%" → 原样透出，不做第二次判断', () => {
    const out = merge(AUCTION, [blk('化工', [yrow('甲', '化工', { rangeText: '0.00%', rangeTone: 'flat', rangePct: 0 })])]);
    expect(out.segments[0].sups[0].rangeText).toBe('0.00%');
  });

  it('缺 seq 时按该股在其题材块内的行序回退（1 起），绝不留空序号', () => {
    const out = merge(AUCTION, [blk('化工', [yrow('甲', '化工', { seq: 0 }), yrow('乙', '化工', { seq: undefined })])]);
    expect(out.segments[0].sups.map(s => s.seq)).toEqual([1, 2]);
  });

  it('不重排序号：被排除的票不重排后面行的号（跳号 = 真实排名，不是丢行）', () => {
    const out = merge(AUCTION, [
      blk('化工', [yrow('甲', '化工', { seq: 1 }), yrow('乙', '化工', { seq: 2 }), yrow('丙', '化工', { seq: 3 })])
    ], { excludeNames: ['甲', '乙'] });
    expect(out.segments[0].sups.map(s => s.seq)).toEqual([3]);
  });
});

describe('formatMergeSummary', () => {
  it('说清「一字总只数 / 已并入 / 已在列表中 / 未并入」', () => {
    expect(formatMergeSummary({ yiziTotal: 8, mergedStocks: 5, mergedRows: 7, inListCount: 2, orphanCount: 1 }))
      .toBe('一字 8 只 · 已并入 5 只 · 多题材合计 7 行 · 已在列表中 2 只 · 未并入 1 只');
  });

  it('单题材（行数 = 只数）时不提「多题材合计」', () => {
    expect(formatMergeSummary({ yiziTotal: 3, mergedStocks: 3, mergedRows: 3, inListCount: 0, orphanCount: 0 }))
      .toBe('一字 3 只 · 已并入 3 只');
  });

  it('一字池为空 → 空串（调用方据此不渲染该行）', () => {
    expect(formatMergeSummary({ yiziTotal: 0 })).toBe('');
    expect(formatMergeSummary(null)).toBe('');
    expect(formatMergeSummary(undefined)).toBe('');
  });
});
