// yizi-supplement.test.js — 「早盘竞价 · 补竞价一字（按题材融入 + 十日涨幅合并排名）」纯函数层单测
//
// 只测纯变换：一字题材分块 → 融进早盘竞价题材序列。⛔ 不碰网络 / state / DB / 早盘竞价数据。
//
// 重点锁死（写错会让用户拿到错误的「哪个题材一字多」结论，或让补入行跑错题材组 / 站错位）：
//   ① 融入 = 落进【已有题材组的组内】，⛔ 绝不新增一个「竞价一字补充」整块；
//   ② 一字股任一题材命中组名即进该组；命中多个组 → 多组都进（如华软科技「芯片,化工」）；
//   ③ 重复的不融（股票名已在早盘竞价列表里）；
//   ④ 组序 / 原有行顺序一个字都不动；
//   ⑤ ★v3 序号 = 补入行在【本题材组内的十日涨幅名次】（插到自己的排名位、整段序号 1..N），
//      ⛔ 不再沿用竞价一字看板自己的块内序号；
//   ⑥ ★v3 只插补入行、**不重排原有行**（原有行彼此相对顺序永远不动）；
//   ⑦ ★v3 补入行的显示对象只带 序号/名称/标签/题材 四列要用的字段 + 面板用的十日涨幅文本，
//      ⛔ 封单额 / 首封时刻 / 9:20 时点标一个都不许进来。
import { describe, it, expect } from 'vitest';
import { mergeYiziIntoAuctionRows, formatMergeSummary } from './yizi-supplement.js';

// 可分组核心词（真实运行来自 topic/rules.js#getGroupableCoreTopics；测试里给出最小等价集）
const CORES = [
  { name: '化工' }, { name: '芯片' }, { name: '通信' },
  { name: '算力' }, { name: '机器人' }
];

/** 早盘竞价题材模式下的一行（Logic 层 view-helpers 已给每行标上 groupTopic / seqNo） */
function arow(stock, groupTopic, index, seqNo) {
  return {
    stock: stock,
    groupTopic: groupTopic,
    index: index || 0,
    seqNo: (seqNo === undefined ? 1 : seqNo)
  };
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

/** 原有行的十日涨幅取值器（真实运行 = dragon-rank 的云端缓存；测试里给一张最小表） */
function pctOfOf(map) {
  return function(name) {
    const key = String(name === null || name === undefined ? '' : name).trim();
    return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;
  };
}

// ---- entries 结构的三个取值器（v3：段内是「原有行 + 补入行」交错的扁平序列）----
const supsOf = (seg) => seg.entries.filter(e => e.kind === 'sup').map(e => e.sup);
const rowsOf = (seg) => seg.entries.filter(e => e.kind === 'row').map(e => e.item);
/** 该段的显示顺序（股票名数组）—— 直接反映屏幕上的行序 */
const orderOf = (seg) => seg.entries.map(e => (e.kind === 'row' ? e.item.stock : e.sup.stock));
/** 该段的最终序号数组 */
const seqOf = (seg) => seg.entries.map(e => (e.kind === 'row' ? e.item.seqNo : e.sup.seq));
const segOf = (out, topic) => out.segments.find(s => s.topic === topic);

const AUCTION = [
  arow('西陇科学', '化工', 0),
  arow('中晶电子', '芯片', 1),
  arow('浪潮信息', '算力', 2)
];

describe('mergeYiziIntoAuctionRows · 按题材融入（不是整块追加）', () => {
  it('一字股落进对应题材组，⛔ 不新增分组（组数不变，组序不变）', () => {
    const out = merge(AUCTION, [blk('化工', [yrow('中材科技', '通信,化工')])]);

    expect(out.segments.map(s => s.topic)).toEqual(['化工', '芯片', '算力']);
    expect(supsOf(segOf(out, '化工')).map(s => s.stock)).toEqual(['中材科技']);
    expect(supsOf(segOf(out, '芯片'))).toEqual([]);
    expect(supsOf(segOf(out, '算力'))).toEqual([]);
    // 每个分组都还是「早盘竞价原有行 + 补入行」，且没有 isOrphan 尾段
    expect(out.segments.every(s => s.isOrphan === false)).toBe(true);
  });

  it('补入行带 mergedTopic（模板据此渲染「补」标），值 = 被并入的组名', () => {
    const out = merge(AUCTION, [blk('化工', [yrow('中材科技', '通信,化工')])]);
    expect(supsOf(segOf(out, '化工'))[0].mergedTopic).toBe('化工');
  });

  it('一字的任一题材命中组名即融入；命中多个组 → 多个组都能看到它', () => {
    const out = merge(AUCTION, [blk('芯片', [yrow('华软科技', '芯片,化工')])]);
    const inChip = segOf(out, '芯片');
    const inChem = segOf(out, '化工');
    expect(supsOf(inChip).map(s => s.stock)).toEqual(['华软科技']);
    expect(supsOf(inChem).map(s => s.stock)).toEqual(['华软科技']);
    expect(supsOf(inChip)[0].mergedTopic).toBe('芯片');
    expect(supsOf(inChem)[0].mergedTopic).toBe('化工');
    // 只数按「只」算，行数按「行」算 —— 多题材会同时出现在两组里
    expect(out.stats.mergedStocks).toBe(1);
    expect(out.stats.mergedRows).toBe(2);
  });

  it('★ 没有补入行的题材组：渲染序列与纯看板视图逐行一致（同引用、⛔ 序号一个字都不动）', () => {
    const out = merge(AUCTION, [blk('化工', [yrow('中材科技', '通信,化工')])]);

    const seg = segOf(out, '芯片');
    expect(seg.entries).toHaveLength(1);
    expect(seg.entries[0].kind).toBe('row');
    expect(seg.entries[0].item).toBe(AUCTION[1]);                 // 同一个对象：没被复制、没被改写
    expect(seg.entries[0].item.seqNo).toBe(AUCTION[1].seqNo);     // 序号也没被动过
  });

  it('同组原有行与补入行共用题材底色（视觉上是一整段）', () => {
    const rows = [Object.assign(arow('西陇科学', '化工', 0), { topicBg: '#fdf2f8' })];
    const out = merge(rows, [blk('化工', [yrow('中材科技', '化工')])]);
    expect(supsOf(segOf(out, '化工'))[0].topicBg).toBe('#fdf2f8');
  });

  it('已有列表中：整只跳过，不重复融（并如实计入 inListCount）', () => {
    const out = merge(AUCTION, [
      blk('化工', [yrow('西陇科学', '化工'), yrow('中材科技', '化工')])
    ], { excludeNames: ['西陇科学'] });

    expect(supsOf(segOf(out, '化工')).map(s => s.stock)).toEqual(['中材科技']);
    expect(out.stats.inListCount).toBe(1);
    expect(out.stats.mergedStocks).toBe(1);
  });

  it('excludeNames 接受数组 / Set / 空值，且对空名与前后空格做归一', () => {
    const blocks = [blk('化工', [yrow('甲', '化工'), yrow('乙', '化工')])];
    const namesOf = (o) => supsOf(segOf(merge(AUCTION, blocks, o), '化工')).map(s => s.stock);
    expect(namesOf({ excludeNames: [' 甲 '] })).toEqual(['乙']);
    expect(namesOf({ excludeNames: new Set(['甲']) })).toEqual(['乙']);
    expect(namesOf({ excludeNames: [] })).toEqual(['甲', '乙']);
    expect(namesOf({})).toEqual(['甲', '乙']);
  });
});

describe('mergeYiziIntoAuctionRows · ★v3 组内「十日涨幅合并排名」', () => {
  it('★ 补入行抢下龙一 → 原有行序号全体顺移（序号 1..N 连续，⛔ 入参不被改写）', () => {
    const rows = [arow('西陇科学', '化工', 0, 1), arow('东岳硅材', '化工', 1, 2)];
    const out = merge(rows, [blk('化工', [yrow('中材科技', '化工', { rangePct: 50, rangeText: '+50.00%(10/10日)' })])], {
      pctOf: pctOfOf({ '西陇科学': 30, '东岳硅材': 10 })
    });

    const seg = segOf(out, '化工');
    // 50 > 30 > 10 → 补入行坐龙一，原有两行各退一位
    expect(orderOf(seg)).toEqual(['中材科技', '西陇科学', '东岳硅材']);
    expect(seqOf(seg)).toEqual([1, 2, 3]);
    expect(seg.entries[0].kind).toBe('sup');
    expect(seg.entries[0].sup.seq).toBe(1);
    expect(rowsOf(seg).map(r => r.seqNo)).toEqual([2, 3]);
    // 序号变了 → 浅拷贝；⛔ 传入的原有行对象本身一个字段都不许被改写
    expect(rowsOf(seg)[0]).not.toBe(rows[0]);
    expect(rowsOf(seg)[1]).not.toBe(rows[1]);
    expect(rows[0].seqNo).toBe(1);
    expect(rows[1].seqNo).toBe(2);
  });

  it('★ 插在中间：补入行排在比它高的原有行之后、比它低的之前；位次没变的行原引用透出', () => {
    const rows = [arow('甲', '化工', 0, 1), arow('乙', '化工', 1, 2), arow('丙', '化工', 2, 3)];
    const out = merge(rows, [blk('化工', [yrow('丁', '化工', { rangePct: 30 })])], {
      pctOf: pctOfOf({ 甲: 60, 乙: 40, 丙: 20 })
    });

    const seg = segOf(out, '化工');
    expect(orderOf(seg)).toEqual(['甲', '乙', '丁', '丙']);
    expect(seqOf(seg)).toEqual([1, 2, 3, 4]);
    expect(seg.entries[0].item).toBe(rows[0]);   // 甲 序号没变 → 原引用（v-memo 指纹不被无意义打断）
    expect(seg.entries[1].item).toBe(rows[1]);   // 乙 序号没变 → 原引用
    expect(seg.entries[3].item).not.toBe(rows[2]);
    expect(seg.entries[3].item.seqNo).toBe(4);   // 丙 被挤到第 4
    expect(rows[2].seqNo).toBe(3);
  });

  it('★ 只插补入行、**不重排原有行**（组内本来就没按涨幅排过的段也不许洗牌）', () => {
    // 真实来源：「其它」组、或组内只有 1 只的题材（computeDragonRankMap 只给成员≥2 的着色题材发排名）
    const rows = [arow('甲', '其它', 0, 1), arow('乙', '其它', 1, 2)];
    const out = merge(rows, [blk('其它', [yrow('丙', '-', { rangePct: 30 })])], {
      pctOf: pctOfOf({ 甲: 10, 乙: 50 })
    });

    const seg = segOf(out, '其它');
    // 甲在前、乙在后 —— 与传入顺序一致，⛔ 即使乙的涨幅比甲高也不换位
    expect(rowsOf(seg).map(r => r.stock)).toEqual(['甲', '乙']);
    // 丙(30) 插到「第一个比自己低的原有行」（甲 10）之前
    expect(orderOf(seg)).toEqual(['丙', '甲', '乙']);
    expect(seg.entries[0].kind).toBe('sup');
    expect(rowsOf(seg)[0].stock).toBe('甲');
    // 序号被顺移 ≠ 顺序被重排：甲仍排第一，只是号从 1 变 2（⛔ 入参对象本身没动）
    expect(rowsOf(seg).map(r => r.seqNo)).toEqual([2, 3]);
    expect(rows[0].seqNo).toBe(1);
    expect(rows[1].seqNo).toBe(2);
  });

  it('同组多只补入行之间也按十日涨幅降序（「序号 = 涨幅名次」要在整段成立）', () => {
    const rows = [arow('西陇科学', '化工', 0, 1)];
    const out = merge(rows, [blk('化工', [
      yrow('甲', '化工', { rangePct: 10, seq: 1 }),
      yrow('乙', '化工', { rangePct: 70, seq: 2 })
    ])], { pctOf: pctOfOf({ '西陇科学': 40 }) });

    const seg = segOf(out, '化工');
    expect(orderOf(seg)).toEqual(['乙', '西陇科学', '甲']);
    expect(seqOf(seg)).toEqual([1, 2, 3]);
  });

  it('原有行取不到十日涨幅 → 视为「比任何有值行都低」，补入行插到它之前', () => {
    const rows = [arow('西陇科学', '化工', 0, 1)];
    const out = merge(rows, [blk('化工', [yrow('中材科技', '化工', { rangePct: 50 })])], {
      pctOf: pctOfOf({})
    });
    expect(orderOf(segOf(out, '化工'))).toEqual(['中材科技', '西陇科学']);
    expect(seqOf(segOf(out, '化工'))).toEqual([1, 2]);
  });

  it('补入行取不到十日涨幅 → 落组内最末（⛔ 不冒充 0 抢位，§10）', () => {
    const rows = [arow('西陇科学', '化工', 0, 1)];
    const out = merge(rows, [blk('化工', [yrow('中材科技', '化工')])], {
      pctOf: pctOfOf({ '西陇科学': -5 })
    });
    expect(orderOf(segOf(out, '化工'))).toEqual(['西陇科学', '中材科技']);
  });

  it('真值 0 是「排得上名的 0」：照常参与排名（⛔ 不当成没数据）', () => {
    const rows = [arow('西陇科学', '化工', 0, 1)];
    const out = merge(rows, [blk('化工', [yrow('中材科技', '化工', { rangePct: 0 })])], {
      pctOf: pctOfOf({ '西陇科学': -5 })
    });
    // 0 > -5 → 补入行仍排在原有行之前（若把 0 当「没数据」就会掉到最末）
    expect(orderOf(segOf(out, '化工'))).toEqual(['中材科技', '西陇科学']);
  });

  it('★ 云端十日涨幅缓存未到（pctOf 缺省）→ ⛔ 不假装排过：补入行接组内末尾、序号顺排', () => {
    const rows = [arow('西陇科学', '化工', 0, 1), arow('东岳硅材', '化工', 1, 2)];
    const out = merge(rows, [blk('化工', [yrow('中材科技', '化工', { rangePct: 50 })])]);

    const seg = segOf(out, '化工');
    expect(orderOf(seg)).toEqual(['西陇科学', '东岳硅材', '中材科技']);
    expect(seqOf(seg)).toEqual([1, 2, 3]);
    expect(seg.entries[0].item).toBe(rows[0]);
    expect(seg.entries[1].item).toBe(rows[1]);
  });

  it('合并排名只作用于「真有补入行」的段：另一段就连补入行的「序号竞态」都不会发生', () => {
    const rows = [arow('西陇科学', '化工', 0, 1), arow('中晶电子', '芯片', 1, 1)];
    const out = merge(rows, [blk('化工', [yrow('中材科技', '化工', { rangePct: 50 })])], {
      pctOf: pctOfOf({ '西陇科学': 10 })
    });
    expect(seqOf(segOf(out, '化工'))).toEqual([1, 2]);
    expect(rowsOf(segOf(out, '芯片'))[0].seqNo).toBe(1);   // 芯片组无人补入 → 原样
  });
});

describe('mergeYiziIntoAuctionRows · 未并入尾段（§10 绝不静默丢弃）', () => {
  it('题材在当日列表里一个组都没命中 → 进「未并入」尾段（排在最后，主行为空）', () => {
    const out = merge(AUCTION, [blk('固态电池', [yrow('甲', '固态电池')])]);

    const last = out.segments[out.segments.length - 1];
    expect(out.segments).toHaveLength(4);            // 3 个原有组 + 尾段
    expect(last.isOrphan).toBe(true);
    expect(rowsOf(last)).toEqual([]);
    expect(supsOf(last).map(s => s.stock)).toEqual(['甲']);
    expect(supsOf(last)[0].mergedTopic).toBe('');    // 无处可融 → 不谎报组名
    expect(out.stats.orphanCount).toBe(1);
    expect(out.stats.mergedStocks).toBe(0);
  });

  it('尾段不参与合并排名：序号沿用它在竞价一字看板自己题材块里的排名（跳号 = 真实排名）', () => {
    const out = merge(AUCTION, [blk('固态电池', [
      yrow('甲', '固态电池', { seq: 3 }), yrow('乙', '固态电池', { seq: 7 })
    ])]);
    // 尾段各股来自不同题材、没有可比的题材组 → ⛔ 不重排、不伪造 1..N 连续号
    expect(supsOf(out.segments[out.segments.length - 1]).map(s => s.seq)).toEqual([3, 7]);
  });

  it('全部都能融入时不产生尾段（不会多出一段空的）', () => {
    const out = merge(AUCTION, [blk('化工', [yrow('甲', '化工')])]);
    expect(out.segments.some(s => s.isOrphan)).toBe(false);
    expect(out.stats.orphanCount).toBe(0);
  });

  it('无题材的一字股与列表的「其它」组同义 → 融进「其它」，⛔ 不因无题材就当未并入', () => {
    const rows = AUCTION.concat([arow('某某', '其它', 3)]);
    const out = merge(rows, [blk('其它', [yrow('甲', '-')])]);
    expect(supsOf(segOf(out, '其它')).map(s => s.stock)).toEqual(['甲']);
    expect(out.stats.orphanCount).toBe(0);
  });

  it('有真题材、只是当日列表没有这个组 → 进尾段，⛔ 不冒充「其它」', () => {
    const rows = AUCTION.concat([arow('某某', '其它', 3)]);
    const out = merge(rows, [blk('固态电池', [yrow('甲', '固态电池')])]);
    expect(supsOf(segOf(out, '其它'))).toEqual([]);
    expect(out.stats.orphanCount).toBe(1);
  });
});

describe('mergeYiziIntoAuctionRows · ★v3 补入行的字段口径（四列 + 面板，⛔ 不多带）', () => {
  // 一字看板真实行带的全套字段（含封单额 / 首封时刻 / 时点标）——补入行只许留下面 10 个键
  const FULL = {
    seq: 3, isLeader: true, continueText: '三板',
    rangeText: '+50.29%(5/10日)', rangeTone: 'up', rangePct: 50.29,
    seal920Text: '3.20亿', seal920Tone: 'strong', seal925Text: '3.70亿', seal925Tone: 'strong',
    sealDeltaText: '+0.50亿', sealDeltaTone: 'up',
    firstTimeText: '09:15:03', faFirst: '09:15:03', pointTagText: '9:20'
  };

  it('★ 只带「序号/名称/标签/题材」四列 + 面板用十日涨幅文本，⛔ 封单额与首封时刻一个都不进', () => {
    const out = merge(AUCTION, [blk('化工', [yrow('甲', '化工', FULL)])]);
    const sup = supsOf(segOf(out, '化工'))[0];

    // 白名单：新增字段会让本用例红掉（刻意的，防止封单额/时点标又悄悄溜回来）
    expect(Object.keys(sup)).toEqual([
      // [HIGH-LIMIT-BOARD 2026-09-21] `code` 是本次唯一新增键，⛔ 它【不是展示列】：
      //   只作为「科创板/创业板/北交所 → 股票名浅灰删除线」的判定输入（与早盘竞价行同一判据，§6），
      //   模板不渲染它、不占列宽。封单额 / 时点标 / 首封时刻 依旧一个都不许进。
      'stock', 'code', 'seq', 'mergedTopic', 'topicsDisplay', 'continueText',
      'rankPct', 'rangeText', 'rangeTone', 'topicBg'
    ]);
    expect(sup.stock).toBe('甲');
    expect(sup.mergedTopic).toBe('化工');
    expect(sup.topicsDisplay).toBe('化工');
    expect(sup.continueText).toBe('三板');
    // 面板顶部要显示的十日涨幅文本 / 色调（与「竞价一字」看板面板同源）
    expect(sup.rangeText).toBe('+50.29%(5/10日)');
    expect(sup.rangeTone).toBe('up');
    // 被封单额 / 首封时刻 / 时点标 —— 一律不存在（用户要求「UI 这里不要显示」）
    ['seal920Text', 'seal920Tone', 'seal925Text', 'seal925Tone',
      'sealDeltaText', 'sealDeltaTone', 'firstTimeText', 'faFirst', 'pointTagText', 'isLeader']
      .forEach(function(k) { expect(sup[k]).toBeUndefined(); });
  });

  it('缺十日涨幅 → rankPct = null、rangeText 空串（⛔ 绝不伪造 0 / "0.00%"）', () => {
    const out = merge(AUCTION, [blk('化工', [yrow('甲', '化工')])]);
    const sup = supsOf(segOf(out, '化工'))[0];
    expect(sup.rankPct).toBeNull();
    expect(sup.rangeText).toBe('');
    expect(sup.rangeTone).toBe('');
    expect(sup.continueText).toBe('');
  });

  it('脏数据（rangePct 为 ""/NaN/非数）→ 一律当没数据（null），⛔ 不 Number() 成 0', () => {
    const out = merge(AUCTION, [
      blk('化工', [yrow('甲', '化工', { rangePct: '' })]),
      blk('算力', [yrow('乙', '算力', { rangePct: 'abc' })]),
      blk('芯片', [yrow('丙', '芯片', { rangePct: null })])
    ]);
    expect(supsOf(segOf(out, '化工'))[0].rankPct).toBeNull();
    expect(supsOf(segOf(out, '算力'))[0].rankPct).toBeNull();
    expect(supsOf(segOf(out, '芯片'))[0].rankPct).toBeNull();
  });

  it('跨块同名：题材取并集、十日涨幅取第一个非空，仍只渲染一行', () => {
    const out = merge(AUCTION, [
      blk('化工', [yrow('甲', '化工', { rangePct: null })]),
      blk('芯片', [yrow('甲', '化工,芯片', { rangePct: 12.5 })]),
      blk('算力', [yrow('甲', '化工,算力', { rangePct: 99 })])
    ]);
    expect(out.stats.yiziTotal).toBe(1);
    const a = supsOf(segOf(out, '化工'))[0];
    expect(a.rankPct).toBe(12.5);                       // 第一个非空 = 芯片块那次
    expect(supsOf(segOf(out, '芯片'))).toHaveLength(1);
    expect(supsOf(segOf(out, '算力'))).toHaveLength(1);
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

  it('一字池为空 → 不产生任何尾段、也不改原有行的任何东西', () => {
    const out = merge(AUCTION, []);
    expect(out.segments.map(s => s.topic)).toEqual(['化工', '芯片', '算力']);
    expect(out.segments.every(s => supsOf(s).length === 0)).toBe(true);
    expect(out.segments.every(s => s.entries.every(e => e.kind === 'row'))).toBe(true);
    expect(out.segments[0].entries[0].item).toBe(AUCTION[0]);
    expect(formatMergeSummary(out.stats)).toBe('');
  });

  it('脏行（stock 为空 / null 行）被剔除，不产出空行', () => {
    const out = merge(AUCTION, [blk('化工', [yrow('  ', '化工'), null, yrow('甲', '化工')])]);
    expect(supsOf(segOf(out, '化工')).map(s => s.stock)).toEqual(['甲']);
    expect(out.stats.yiziTotal).toBe(1);
  });

  it('coreTopics 缺失时仍能按「块名（一字看板的主题材）」落位（同源加固，不因缺参漏融）', () => {
    const out = mergeYiziIntoAuctionRows(AUCTION, [blk('算力', [yrow('甲', '算力')])], {});
    expect(supsOf(segOf(out, '算力')).map(s => s.stock)).toEqual(['甲']);
  });

  it('空块（stocks 为空）不产生任何候选', () => {
    const out = merge(AUCTION, [blk('化工', [])]);
    expect(out.stats.yiziTotal).toBe(0);
    expect(out.segments.every(s => supsOf(s).length === 0)).toBe(true);
  });

  it('缺 seq 时按该股在其题材块内的行序回退（1 起），绝不留空序号（用于未并入尾段）', () => {
    const out = merge(AUCTION, [blk('固态电池', [yrow('甲', '固态电池', { seq: 0 }), yrow('乙', '固态电池', { seq: undefined })])]);
    const last = out.segments[out.segments.length - 1];
    expect(supsOf(last).map(s => s.seq)).toEqual([1, 2]);
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
