// tvrb-big-top20.test.js — ★★ [AUTO-PICK-TOP20 2026-11-14 用户口径] ★★
//
// 「数量 > 8 只」的题材不再按龙位顺延，改成：
//   只选【同题材 20日涨幅〔9:25 竞价口径〕前十】里排名最靠前的两只；
//   竞价涨停的票【照常选进 + 打标签】（⛔ 不再顺延下一龙位）；
//   前十只有 1 只 ⇒ 从同题材其余票里按龙位靠前的补 1 只；一只都没有 ⇒ 退回常规龙位口径。
//
// 验收基准 = 用户逐字给的 10-30 大消费 17 只那天：
//   「青岛食品也应该选入，买侧点应该是青岛食品和九阳股份……青岛食品排第七」
//   ⇒ 旧口径 = 上海九百（龙一）+ 东贝集团（龙三），青岛食品被「一字顺延」跳过；
//   ⇒ 新口径 = 九阳股份（20日涨幅第 1 名）+ 青岛食品（第 7 名，竞价一字，等下杀买），
//     第 8 名 上海九百 按「出现 3 只只取前 2 只」不选。
//
// 数据全部是【库内真实值】（2026-10-30 定稿快照 + stock_range20_pct + stock_topics），
// 不是编的：17 个成员、十日涨幅、20日涨幅名次都与线上一致。
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  _buildBlock, pickBigTopicTop20, resolveTvrbTier
} from './tvrb-blocks.js';
import { makeCoreTopicResolver } from '../topic/core-category.js';
import { AUCTION_YIZI_WAIT_TAG } from './auction-yizi-tag.js';

/** [SW-CACHE] sw.js 的 CACHE 版本号。断言写成「≥ 基线」：
 *  既能抓住「改了文案却忘记 bump」（版本还停在旧号，一定小于基线），
 *  又不用每轮发布都回来改数字（旧的精确断言每轮都要改 4 处，改漏就是假红）。 */
function _swCacheNo(text) {
  const m = /var CACHE = 'biga-static-v(\d+)'/.exec(String(text || ''));
  return m ? Number(m[1]) : 0;
}

// ── 真实核心词表（只留本用例需要的几个大类；匹配语义与云端 24 个逐字一致）──────────────
const CORE = [
  { name: '大消费', synonyms: ['食品', '饮料', '服装', '家电', '旅游', '零售', '商业百货', '白酒'] },
  { name: 'AI应用', synonyms: ['文化传媒', '传媒', '游戏'] },
  { name: '工业4.0', synonyms: ['机器人概念', '智能制造'] },
  { name: '新能源汽车', synonyms: ['汽车零部件'] },
  { name: '农业', synonyms: ['水产品', '养殖'] }
];
const coreRes = makeCoreTopicResolver(CORE);

function m(name, opts) {
  return Object.assign({
    name: name, isYizi: false, pct: 20, aucPct: 5, aucVolRatio: 5, aucShare: null,
    volRatioDir: '', code: '000001', countable: true, inheritSold: false
  }, opts || {});
}
function mkBlock(topic, rank, members) {
  return {
    topic: topic, rank: rank, count: members.length,
    yiziCount: members.filter(function(x) { return x.isYizi; }).length,
    members: members
  };
}
function dragonMap(entries) {
  const map = new Map();
  entries.forEach(function(e) { map.set(e[0], { rank: e[1], topic: '', groupSize: 0, pct: 20 }); });
  return map;
}
/** 20日涨幅前十富化条目（形状 = decision-collect#_enrich） */
function pool20(name, rank20, topic, pct, over) {
  return Object.assign({
    name: name, code: '600000', pct: pct, days: 20, topic: topic,
    rank: null, mainBoard: true, isYizi: false, suspended: false,
    rank20: rank20, streak: null, streakLabel: ''
  }, over || {});
}

// ══ 10-30 大消费 17 只：库内真实成员（含十日涨幅 / 竞价涨幅 / 量比 / 占比）══════════════
const NAMES17 = [
  '七匹狼', '上海九百', '东贝集团', '合百集团', '国芳集团', '地素时尚', '大连友谊', '巴比食品',
  '广百股份', '新华百货', '桂发祥', '泉阳泉', '皇台酒业', '祥源文旅', '茂业商业', '阳光乳业', '青岛食品'
];
const MEMBERS17 = [
  m('七匹狼', { pct: -7.27, aucPct: 2.33, aucVolRatio: 2.92, aucShare: 1.2, code: '002029' }),
  m('上海九百', { pct: 50, aucPct: -4.77, aucVolRatio: 12.7, aucShare: 2.8, code: '600838' }),
  m('东贝集团', { pct: 18.93, aucPct: -10, aucVolRatio: 92.34, aucShare: 51, code: '601956' }),
  m('合百集团', { pct: 6.54, aucPct: 4.63, aucVolRatio: 22.11, aucShare: 10.5, code: '000417' }),
  m('国芳集团', { pct: 0.82, aucPct: -5.66, aucVolRatio: 3.48, aucShare: 1.2, code: '601086' }),
  m('地素时尚', { pct: 4.54, aucPct: 2.56, aucVolRatio: 13.42, aucShare: 5, code: '603587' }),
  m('大连友谊', { pct: -7.57, aucPct: -0.86, aucVolRatio: 1, aucShare: 0.7, code: '000679' }),
  m('巴比食品', { pct: 10.48, aucPct: 0.58, aucVolRatio: 23.5, aucShare: 5.4, code: '605338' }),
  m('广百股份', { pct: -1.86, aucPct: -3.13, aucVolRatio: 4.09, aucShare: 1.2, code: '002187' }),
  m('新华百货', { pct: 2.35, aucPct: -4.69, aucVolRatio: 2.08, aucShare: 1.1, code: '600785' }),
  m('桂发祥', { pct: -5.91, aucPct: -3.43, aucVolRatio: 3.79, aucShare: 1.3, code: '002820' }),
  m('泉阳泉', { pct: 7.94, aucPct: -0.99, aucVolRatio: 1.69, aucShare: 0.8, code: '600189' }),
  m('皇台酒业', { pct: -0.7, aucPct: -0.39, aucVolRatio: 3.17, aucShare: 1.6, code: '000995' }),
  m('祥源文旅', { pct: 5.36, aucPct: -3.16, aucVolRatio: 18.21, aucShare: 2.6, code: '600576' }),
  m('茂业商业', { pct: 4.13, aucPct: -6.56, aucVolRatio: 13.74, aucShare: 2.7, code: '600828' }),
  m('阳光乳业', { pct: -5.51, aucPct: -3.97, aucVolRatio: 2.78, aucShare: 1.1, code: '001318' }),
  // ★ 青岛食品：竞价一字（9:25 涨幅 +9.98% = 主板涨停），十日涨幅 56.63%，20日涨幅 56.76% = 第 7 名
  m('青岛食品', { pct: 56.63, aucPct: 9.98, aucVolRatio: 40, aucShare: 8, isYizi: true, code: '001219' })
];
/** 10-30 真实 20日涨幅【主板】前十（竞价口径反解；非主板已剔除） */
const POOL30 = [
  pool20('九阳股份', 1, '家电,电子商务', 135.78, { code: '002242' }),
  pool20('新华传媒', 2, '文化传媒', 128.77, { code: '600825' }),
  pool20('海洋王', 3, 'LED,军工', 86.81, { code: '002724' }),
  pool20('襄阳轴承', 4, '机器人概念,汽车零部件', 86.77, { code: '000678' }),
  pool20('大业股份', 5, '机器人概念,工业4.0', 84.82, { code: '603278' }),
  pool20('百洋股份', 6, '水产品,农业', 67.23, { code: '002696' }),
  pool20('青岛食品', 7, '食品饮料,业绩增长', 56.76, { code: '001219' }),
  pool20('上海九百', 8, '零售,物业服务', 56.17, { code: '600838' }),
  pool20('冰山冷热', 9, '冰雪产业,算力', 52.31, { code: '000530' }),
  pool20('宁波东力', 10, '机器人概念,减速器', 45.73, { code: '002164' })
];
/** 10-30 买点侧龙位（9:26 口径）：上海九百 1 / 青岛食品 2 / 东贝集团 3 */
const DM30 = dragonMap([
  ['上海九百', 1], ['青岛食品', 2], ['东贝集团', 3], ['合百集团', 4], ['地素时尚', 5],
  ['巴比食品', 6], ['祥源文旅', 7], ['茂业商业', 8], ['七匹狼', 9], ['国芳集团', 10],
  ['广百股份', 11], ['新华百货', 12], ['桂发祥', 13], ['泉阳泉', 14], ['皇台酒业', 15],
  ['阳光乳业', 16], ['大连友谊', 17]
]);
const PCT30 = new Map(MEMBERS17.map(function(x) { return [x.name, { pct: x.pct, days: 10 }]; }));
const bigTier = resolveTvrbTier(17);

function names(blk) {
  return (blk.picks || []).map(function(p) { return p.name; });
}

describe('tvrb · ★★ [AUTO-PICK-TOP20] 数量 > 8 只 ⇒ 只选同题材 20日涨幅前十最靠前两只', function() {
  it('10-30 真实 17 只：不注入池子 ⇒ 退回【常规龙位】：上海九百 + 青岛食品（⛔ 一字不再被跳过）', function() {
    // 不注入 topicPool ⇒ 退回常规龙位口径（判据一行未改）。
    // ★★ [YIZI-NO-SHIFT 2026-11-20 用户口径] 旧口径这里给的是「上海九百 + 东贝集团」——
    //   龙二 青岛食品 竞价一字 ⇒ 被跳过 ⇒ 顺延龙三 东贝集团。该口径已废除：
    //   一字【照选 + 占一档 + 挂「等下杀买」】，所以退回常规龙位时取到的就是龙二 青岛食品。
    const old = _buildBlock(mkBlock('大消费', 2, MEMBERS17), DM30, bigTier, PCT30, null, null);
    expect(names(old)).toEqual(['上海九百', '青岛食品']);
    expect(old.skippedNames).toEqual([]);   // ⛔ 一字不再进 skippedNames
    expect(old.top20Judge).toBe('');
    expect((old.notes || []).join('\n')).not.toContain('大题材口径');
  });

  it('★ 10-30 真实 17 只：新口径 = 九阳股份（第1名）+ 青岛食品（第7名，竞价一字），第 8 名 上海九百 不选', function() {
    const blk = _buildBlock(mkBlock('大消费', 2, MEMBERS17), DM30, bigTier, PCT30, null,
      { topicPool: POOL30, coreRes: coreRes, top20Text: '9:25 竞价口径' });
    expect(names(blk)).toEqual(['九阳股份', '青岛食品']);
    // ★ 用户口径「出现 3 只就选排名靠前那两只，第三只不选」
    expect(names(blk)).not.toContain('上海九百');
    expect(blk.top20Judge).toBe('hit');
    expect(blk.top20Hits.map(function(h) { return h.rank20 + '.' + h.name; }))
      .toEqual(['1.九阳股份', '7.青岛食品', '8.上海九百']);
    // ⛔ 不再有「一字顺延」这件事
    expect(blk.skippedNames).toEqual([]);
    // ★ 青岛食品带「竞价一字涨停 · 等下杀买」标签；九阳股份不是一字 ⇒ 不带
    const qf = blk.picks.filter(function(p) { return p.name === '青岛食品'; })[0];
    const jy = blk.picks.filter(function(p) { return p.name === '九阳股份'; })[0];
    expect(qf.waitBuyTag).toBe(AUCTION_YIZI_WAIT_TAG);
    expect(AUCTION_YIZI_WAIT_TAG).toBe('竞价一字涨停 · 等下杀买');
    expect(jy.waitBuyTag).toBeUndefined();
    // ★ 行上要有 20日涨幅名次徽标（用户要「更加清晰些」）
    expect(qf.range20Label).toBe('20日涨幅第 7 名 +57%');
    expect(jy.range20Label).toBe('20日涨幅第 1 名 +136%');
    // 十日涨幅仍是【十日口径】：青岛食品 = 成员的 56.63 ⇒ +57%（⛔ 不许拿 20日涨幅冒充）
    expect(qf.pctText).toBe('+57%');
    expect(qf.dragonLabel).toBe('龙二');
    // 九阳股份不在早盘竞价名单 ⇒ 十日涨幅 / 龙位【留空】（§10 不猜、不补 0）
    expect(jy.pctText).toBe('');
    expect(jy.dragonLabel).toBe('');
  });

  it('★ 说明区必须能逐只核对：命中 3 只 / 取了哪两只 / 第 3 只为什么没选 / 一字标签 / 名单外的票为什么没数据', function() {
    const blk = _buildBlock(mkBlock('大消费', 2, MEMBERS17), DM30, bigTier, PCT30, null,
      { topicPool: POOL30, coreRes: coreRes, top20Text: '9:25 竞价口径' });
    const txt = (blk.notes || []).join('\n');
    expect(txt).toContain('前十里有本题材的票 3 只');
    expect(txt).toContain('第 1 名 九阳股份 +136%');
    expect(txt).toContain('第 7 名 青岛食品 +57%');
    expect(txt).toContain('第 8 名 上海九百 +56%');
    expect(txt).toContain('按名次取最靠前的 2 只：九阳股份、青岛食品');
    expect(txt).toContain('上海九百 不再选');
    expect(txt).toContain(AUCTION_YIZI_WAIT_TAG);
    expect(txt).toContain('不在早盘竞价名单');
    // ⛔ 不许再出现「顺延到下一个龙位」当结论（一字已不再顺延）
    expect(txt).not.toContain('已顺延到下一个龙位');
  });

  it('前十只有 1 只 ⇒ 从同题材其余票里按【龙位靠前】补 1 只（用户口径原话）', function() {
    // ⚠️ [MID-TOP20 实证修正] 「同题材」以【块成员名单】为准（优先于题材串），
    //   所以「把 青岛食品/上海九百 的 topic 改成别的大类」已经【无效】—— 它们本来就是大消费的成员。
    //   要造「前十只有 1 只命中」，只能让前十【不含】它们（下面是 10-30 前十的另一种构成）。
    const pool = [
      pool20('九阳股份', 1, '家电,电子商务', 135.78, { code: '002242' }),
      pool20('新华传媒', 2, '文化传媒', 128.77, { code: '600825' }),
      pool20('海洋王', 3, 'LED,军工', 86.81, { code: '002724' }),
      pool20('襄阳轴承', 4, '机器人概念,汽车零部件', 86.77, { code: '000678' }),
      pool20('大业股份', 5, '机器人概念,工业4.0', 84.82, { code: '603278' }),
      pool20('百洋股份', 6, '水产品,农业', 67.23, { code: '002696' }),
      pool20('冰山冷热', 7, '冰雪产业,算力', 52.31, { code: '000530' }),
      pool20('宁波东力', 8, '机器人概念,减速器', 45.73, { code: '002164' }),
      pool20('澳弘电子', 9, 'PCB,通信', 44.5, { code: '605058' }),
      pool20('吉大正元', 10, 'AI应用', 43.1, { code: '003029' })
    ];
    const blk = _buildBlock(mkBlock('大消费', 2, MEMBERS17), DM30, bigTier, PCT30, null,
      { topicPool: pool, coreRes: coreRes, top20Text: '9:25 竞价口径' });
    expect(names(blk)).toEqual(['九阳股份', '上海九百']);   // 补位 = 组内龙一（上海九百）
    const txt = (blk.notes || []).join('\n');
    expect(txt).toContain('前十只有 1 只本题材的票');
    expect(txt).toContain('同题材其余票里按龙位靠前的');
  });

  it('前十一只都没有 ⇒ 退回常规龙位口径（⛔ 不弃题材），并如实写「未命中」', function() {
    // ⚠️ [MID-TOP20 实证修正] 「同题材」= 名字在块成员里（优先）或题材串核心词归一命中。
    //   所以要造「前十没有本题材的票」，块成员必须与池子完全不相交、题材串也不归一命中
    //   （★ 只把池子的 topic 改成 'LED,军工' 是不够的：上海九百/青岛食品 本来就是成员）。
    const other = [m('甲', { pct: 40 }), m('乙', { pct: 30 }), m('丙', { pct: 20 }),
      m('丁', { pct: 10 }), m('戊', { pct: 5 }), m('己', { pct: 3 }), m('庚', { pct: 1 }),
      m('辛', { pct: 0.5 }), m('壬', { pct: 0.2 })];
    const dm = dragonMap(['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬']
      .map(function(n, i) { return [n, i + 1]; }));
    const blk = _buildBlock(mkBlock('商业航天', 2, other), dm, bigTier, null, null,
      { topicPool: POOL30, coreRes: coreRes, top20Text: '9:25 竞价口径' });
    expect(names(blk)).toEqual(['甲', '乙']);                // 常规龙位
    expect(blk.top20Judge).toBe('');
    expect((blk.notes || []).join('\n')).toContain('大题材口径 · 未命中');
  });

  it('§10：池子给了但是【空数组】⇒ 判不出 ⇒ 写「未校验」并退回常规口径', function() {
    const blk = _buildBlock(mkBlock('大消费', 2, MEMBERS17), DM30, bigTier, PCT30, null,
      { topicPool: [], coreRes: coreRes, top20Text: '9:25 竞价口径' });
    // 退回常规龙位 ⇒ 龙一 上海九百 + 龙二 青岛食品（★ [YIZI-NO-SHIFT 2026-11-20] 一字不再被跳过）
    expect(names(blk)).toEqual(['上海九百', '青岛食品']);
    expect((blk.notes || []).join('\n')).toContain('大题材口径 · 未校验');
  });

  it('§10：非主板的票不进前十名次（rank20 是主板名次，非主板本来就不在池子里）', function() {
    // 池子里混进一只 rank20 = 11 的票（第 11 名不是「前十」）⇒ 不参与
    const pool = POOL30.concat([pool20('青岛食品二', 11, '食品饮料', 40)]);
    const r = pickBigTopicTop20(mkBlock('大消费', 2, MEMBERS17), pool, coreRes, 2);
    expect(r.judge).toBe('hit');
    expect(r.hits.map(function(h) { return h.name; })).toEqual(['九阳股份', '青岛食品', '上海九百']);
    expect(r.hits.some(function(h) { return h.name === '青岛食品二'; })).toBe(false);
  });

  it('★ 同题材判定走【核心词大类归一】：冰箱企业「家电」必须认成【大消费】', function() {
    // 严格字符串相等会漏掉 九阳股份（行上是「家电」）⇒ 用户要的那两只永远出不来
    const r = pickBigTopicTop20(mkBlock('大消费', 2, MEMBERS17), POOL30, coreRes, 2);
    expect(r.hits.map(function(h) { return h.name; })).toContain('九阳股份');
    // ⛔ 不归一（不传 coreRes）⇒ 「家电」≠「大消费」⇒ 九阳股份不在命中里（反例锁）
    const raw = pickBigTopicTop20(mkBlock('大消费', 2, MEMBERS17), POOL30, null, 2);
    expect(raw.hits.map(function(h) { return h.name; })).not.toContain('九阳股份');
  });

  it('纯函数：三态返回（hit / none / no-pool）+ 名次升序 + 只读前十', function() {
    const blk = { topic: '大消费', rank: 1, count: 17, members: MEMBERS17 };
    expect(pickBigTopicTop20(blk, POOL30, coreRes, 2).judge).toBe('hit');
    expect(pickBigTopicTop20(blk, [pool20('新华传媒', 1, '文化传媒', 128)], coreRes, 2).judge).toBe('none');
    expect(pickBigTopicTop20(blk, [], coreRes, 2).judge).toBe('no-pool');
    expect(pickBigTopicTop20(blk, undefined, coreRes, 2).judge).toBe('no-pool');
    // 池子顺序被打乱 ⇒ 仍按 rank20 升序
    const shuffle = [POOL30[7], POOL30[0], POOL30[6]];
    expect(pickBigTopicTop20(blk, shuffle, coreRes, 2).hits.map(function(h) { return h.name; }))
      .toEqual(['九阳股份', '青岛食品', '上海九百']);
  });
});

describe('tvrb · [AUTO-PICK-TOP20] 边界与回归锁', function() {
  it('★ [MID-TOP20] mid 档（4~8 只，取 1 只）也走 20日涨幅前十：只取第 1 名，一字照选打标签', function() {
    const members = [
      m('甲', { isYizi: true, pct: 30 }), m('乙', { pct: 20 }), m('丙', { pct: 10 }),
      m('丁', { pct: 5, isYizi: false })
    ];
    const dm = dragonMap([['甲', 1], ['乙', 2], ['丙', 3], ['丁', 4]]);
    const tier = resolveTvrbTier(5);
    expect(tier.tier).toBe('mid');
    // 退回常规龙位口径 ⇒ 龙一 甲（一字）【照选 + 占一档】。
    // ★ [YIZI-NO-SHIFT 2026-11-20] 旧口径这里是「顺延到乙」，已废除。
    const old = _buildBlock(mkBlock('大消费', 1, members), dm, tier, null, null, null);
    expect(names(old)).toEqual(['甲']);
    expect(old.skippedNames).toEqual([]);
    // 新口径：命中前十 ⇒ 只取第 1 名（九阳股份），⛔ 不再顺延
    const blk = _buildBlock(mkBlock('大消费', 1, members), dm, tier, null, null,
      { topicPool: POOL30, coreRes: coreRes, top20Text: '9:25 竞价口径' });
    expect(names(blk)).toEqual(['九阳股份']);
    expect(blk.skippedNames).toEqual([]);
    expect(blk.top20Judge).toBe('hit');
    const txt = (blk.notes || []).join('\n');
    expect(txt).toContain('中档 20日涨幅口径');
    expect(txt).not.toContain('大题材口径');   // ⛔ 7 只不许说成「大题材」，用户会当成错
    // 「第 2 只起不选」在 reason 里（notes 里对应的是「第 2 名起的 X、Y 不再选」）
    expect(blk.reason).toContain('第 2 只起不选');
    expect(txt).toContain('第 2 名起的');
  });

  it('big 档：来自榜单、当日【停牌】的票买不进 ⇒ 占档不补位（§10 判不出时不占）', function() {
    const pool = POOL30.map(function(t) {
      return t.name === '九阳股份' ? Object.assign({}, t, { suspended: true }) : t;
    });
    const blk = _buildBlock(mkBlock('大消费', 2, MEMBERS17), DM30, bigTier, PCT30, null,
      { topicPool: pool, coreRes: coreRes, top20Text: '9:25 竞价口径' });
    // 九阳股份停牌占掉 1 档 ⇒ 只剩 1 个名额 ⇒ 青岛食品
    expect(names(blk)).toEqual(['青岛食品']);
  });

  it('★ [DEV-RULE 2026-11-25] 十日涨幅再高也【不再拦选股】：_buildBlock 只管选，异动由规则层收口', function() {
    // 🔴 口径整体替换后，_buildBlock 里「候选票十日涨幅 > 97% ⇒ 本块只展示这一只、停止选股」
    //   那一段**已整段删除**（连同 abnormalPick 的写值）：尺子换成官方偏离值，而偏离值要逐日腿
    //   + 对应指数，块级函数拿不到、也不该拿（§4 规则层不取数）。
    //   ⇒ 现在：块照常选出两只；「异动票 ⇒ 全场空仓」由 buildTopicVolRatioPlan 的
    //     _applyAbnormalSweep（第三十四条）统一收口，由 abnormal-10d.test.js 锁住。
    //   ⚠️ 这条用例的价值从「锁独占行为」变成「锁【不许复活】」：若哪天有人把块级拦选加回来，
    //      它会把第二只票吞掉 ⇒ 这里立刻红。
    const pct2 = new Map(PCT30);
    pct2.set('九阳股份', { pct: 120, days: 10 });   // 十日涨幅 120%（旧口径下会独占整块）
    const blk = _buildBlock(mkBlock('大消费', 2, MEMBERS17), DM30, bigTier, pct2, null,
      { topicPool: POOL30, coreRes: coreRes, top20Text: '9:25 竞价口径' });
    expect(names(blk)).toEqual(['九阳股份', '青岛食品']);   // ⛔ 不再因为「涨幅高」而吞掉第二只
    expect(blk.abnormalPick).toBe(null);                   // 字段保留为留痕位，但恒 null
    expect((blk.notes || []).join('\n')).not.toContain('监管异动');
  });

  it('三件套：规则指纹 ≥ v18 + SW ≥ v67 + 模板/样式都接上了 range20Label', function() {
    const rules = readFileSync('src/logic/topicvolratio/plan-snapshot-rules.js', 'utf8');
    const _rv = Number((/TVRB_RULES_VERSION = (\d+)/.exec(rules) || [])[1]);
    expect(_rv).toBeGreaterThanOrEqual(17);   // [RULE-BUMP] 只锁「不得倒退」，bump 时不用改测试
    expect(rules).toContain('[AUTO-PICK-TOP20]');
    expect(rules).toContain('[MID-TOP20]');
    const sw = readFileSync('public/sw.js', 'utf8');
    expect(_swCacheNo(sw)).toBeGreaterThanOrEqual(67);   // [SW-CACHE] ≥ 本轮基线即可，⛔ 不用每轮改数字
    const vue = readFileSync('src/components/topicvolratio/TvrbBuyBlock.vue', 'utf8');
    expect(vue).toContain('p.range20Label');
    const css = readFileSync('src/assets/css/topic-vol-ratio-board.css', 'utf8');
    expect(css).toContain('.tvrb-r20-label');
  });

  it('调用链锁：计划层把 topicPool/coreRes 传进 _buildBlock，且池子没注入时不构造 opt', function() {
    const plan = readFileSync('src/logic/topicvolratio/tvrb-plan.js', 'utf8');
    expect(plan).toContain('const bigPool = (o.ebbCtx && Array.isArray(o.ebbCtx.topicPool))');
    // ★★ [TOPIC-INNER-SELECT 2026-11-17] 调用形态变了（第二题材走题材内选票时它的 opt 优先），
    //   但契约不变：`smallOpt || bigOpt` 仍是「没走特殊通道时的默认」，⛔ 不许只剩一个 opt。
    expect(plan).toContain('_buildBlock(b, buyDragonMap, tier, buyPctMap, buySkipNames,');
    expect(plan).toContain('(out.blocks.length === 1 && secondTopicInnerOpt) ? secondTopicInnerOpt : (smallOpt || bigOpt)');
    expect(plan).toContain('top20Text: r20BaseText');
    // ★ [MID-TOP20] big/mid 两档共用同一个 opt（只差 pickCount）
    expect(plan).toContain("(tier.tier === 'big' || tier.tier === 'mid')");
    // 口径文案：竞价榜没就绪时必须如实写成收盘口径（§10 不许默认冒充）
    expect(plan).toContain("o.range20AucReady === false");
  });

  it('⛔ 回归锁：不允许出现「按量比 / 按涨幅」等第二种排序口径（名次只认池子的 rank20）', function() {
    const src = readFileSync('src/logic/topicvolratio/tvrb-blocks.js', 'utf8');
    // 只取 pickBigTopicTop20 的函数体（⛔ 别把下一个函数的文档注释一起切进来，那里面本来就提到量比）
    const seg = src.slice(src.indexOf('export function pickBigTopicTop20'),
      src.indexOf('return { judge: hits.length > 0'));
    expect(seg).toContain('PRESENCE_TOP_N');
    // 排序只能按 rank20（⛔ 不许 aucVolRatio / pct 排序 —— 那等于把「20日涨幅名次」换成另一套尺子）
    expect(seg).toContain('a.rank20 - b.rank20');
    expect(seg).not.toContain('aucVolRatio');
    expect(seg).not.toContain('b.pct - a.pct');
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// ★★ [MID-TOP20 2026-11-14 用户口径] mid 档（4~8 只，取 1 只）也要「20日涨幅前十优先」
//
// 用户原话（逐字，10-21 商业航天 7 只那天为验收基准）：
//   「10月21日，长春一东不该选，理由，题材总数量7按理来说选一只最强的，那就是海洋王，
//    海洋王20日涨幅竞价口径刚好排名第十，前十有它的出现，这个才是核心，但是竞价涨停，没办法，
//    你打上那个涨停标签，下杀买。」
//
// 库内取证（2026-10-21 定稿快照 + stock_range20_pct + market_metrics 反解）：
//   商业航天 7 只 —— 【当时的】旧口径 = 龙三长春一东（龙一海洋王 / 龙二东安动力 竞价一字被顺延跳过）；
//   ⚠️ [YIZI-NO-SHIFT 2026-11-20] 这条「顺延」口径已废除：一字照选 ⇒ 同一天现在取到的是龙一 海洋王。
//   20日涨幅（9:25 竞价口径·只主板）前十：海洋王 = 第 9 名 54.16%，长春一东不在前十。
//   ⚠️ 海洋王的题材串是「LED,军工」（不是「商业航天」）⇒ 只按题材串比永远判不出同题材，
//     所以「同题材」必须以【块成员名单】为准（本组用例锁死这一条）。
// ══════════════════════════════════════════════════════════════════════════════════════════

/** 10-21 商业航天 7 只（库内真实十日涨幅 / 竞价涨幅 / 量比） */
const MEMBERS21 = [
  m('万丰奥威', { pct: 20.06, aucPct: -1.21, aucVolRatio: 9.91, code: '002085' }),
  m('东安动力', { pct: 38.02, aucPct: 9.99, aucVolRatio: 294.71, isYizi: true, code: '600178' }),
  m('保隆科技', { pct: 2.75, aucPct: -3.09, aucVolRatio: 30.56, code: '603197' }),
  m('文灿股份', { pct: 8.42, aucPct: -1.33, aucVolRatio: 17.95, code: '603348' }),
  m('海洋王', { pct: 45.99, aucPct: 10.04, aucVolRatio: 10.87, isYizi: true, code: '002724' }),
  m('航发科技', { pct: 5.39, aucPct: 0.47, aucVolRatio: 1.39, code: '600391' }),
  m('长春一东', { pct: 13.48, aucPct: -3.3, aucVolRatio: 45.45, code: '600148' })
];
/** 10-21 买点侧龙位（9:26 口径）：海洋王 1 / 东安动力 2 / 长春一东 3 */
const DM21 = dragonMap([
  ['海洋王', 1], ['东安动力', 2], ['长春一东', 3], ['万丰奥威', 4],
  ['文灿股份', 5], ['保隆科技', 6], ['航发科技', 7]
]);
const PCT21 = new Map(MEMBERS21.map(function(x) { return [x.name, { pct: x.pct, days: 10 }]; }));
/** 10-21 真实 20日涨幅【主板】前十（9:25 竞价口径反解） */
const POOL21 = [
  pool20('新华传媒', 1, '文化传媒', 210.29, { code: '600825' }),
  pool20('九阳股份', 2, '家电,电子商务', 121.83, { code: '002242' }),
  pool20('新华文轩', 3, '文化传媒,人工智能', 101.11, { code: '601811' }),
  pool20('慈文传媒', 4, 'AI视频,AI应用', 87.97, { code: '002343' }),
  pool20('澳弘电子', 5, 'PCB,通信', 78.52, { code: '605058' }),
  pool20('宁波东力', 6, '机器人概念,减速器', 58.43, { code: '002164' }),
  pool20('吉大正元', 7, 'AI应用', 57.05, { code: '003029' }),
  pool20('三峡新材', 8, '玻璃,国有企业', 55.74, { code: '600293' }),
  // ★ 海洋王：题材串是「LED,军工」，但它是【商业航天】块的成员 ⇒ 必须算同题材
  pool20('海洋王', 9, 'LED,军工', 54.16, { code: '002724' }),
  pool20('百洋股份', 10, '水产品,农业', 53.39, { code: '002696' })
];
const mid21 = resolveTvrbTier(7);

describe('tvrb · ★★ [MID-TOP20] 4~8 只的题材也按 20日涨幅前十取（只取 1 只）', function() {
  it('10-21 商业航天 7 只：退回常规龙位 ⇒ 龙一 海洋王（一字照选），⛔ 不再顺延到龙三 长春一东', function() {
    expect(mid21.tier).toBe('mid');
    const old = _buildBlock(mkBlock('商业航天', 1, MEMBERS21), DM21, mid21, PCT21, null, null);
    // ★★ [YIZI-NO-SHIFT 2026-11-20] 旧口径这里是「龙一海洋王 / 龙二东安动力 竞价一字被顺延跳过
    //   ⇒ 取龙三 长春一东」—— 用户当时就明确否决过（原话见本组标题上方注释：
    //   「长春一东不该选……就是海洋王……你打上那个涨停标签，下杀买」）。
    //   一字照选之后，退回常规龙位口径取到的正是龙一 海洋王。
    expect(names(old)).toEqual(['海洋王']);
    expect(old.skippedNames).toEqual([]);
    expect(old.top20Judge).toBe('');
  });

  it('★ 新口径 = 海洋王（20日涨幅第 9 名 + 竞价一字 ⇒ 打「等下杀买」标签）', function() {
    const blk = _buildBlock(mkBlock('商业航天', 1, MEMBERS21), DM21, mid21, PCT21, null,
      { topicPool: POOL21, coreRes: coreRes, top20Text: '9:25 竞价口径' });
    expect(names(blk)).toEqual(['海洋王']);
    // ⛔ 不再「顺延到龙三」
    expect(blk.skippedNames).toEqual([]);
    expect(blk.top20Judge).toBe('hit');
    expect(blk.top20Hits.map(function(h) { return h.rank20 + '.' + h.name; })).toEqual(['9.海洋王']);
    const hy = blk.picks[0];
    expect(hy.dragonLabel).toBe('龙一');
    expect(hy.range20Label).toContain('第 9 名');
    expect(hy.waitBuyTag).toBe(AUCTION_YIZI_WAIT_TAG);   // 「竞价一字涨停 · 等下杀买」
    const txt = (blk.notes || []).join('\n');
    expect(txt).toContain('中档 20日涨幅口径');
    expect(txt).toContain('照常选入');
  });

  it('★ 同题材判定以【块成员】为准：海洋王题材串是「LED,军工」也照样命中', function() {
    const blk = mkBlock('商业航天', 1, MEMBERS21);
    const r = pickBigTopicTop20(blk, POOL21, coreRes, 1);
    expect(r.judge).toBe('hit');
    expect(r.hits.map(function(h) { return h.name; })).toEqual(['海洋王']);
    expect(r.hits[0].inMembers).toBe(true);
    // 反证：把海洋王从成员里摘掉 ⇒ 只剩题材串「LED,军工」，与大类不同 ⇒ 判 none
    const noHy = MEMBERS21.filter(function(x) { return x.name !== '海洋王'; });
    const r2 = pickBigTopicTop20(mkBlock('商业航天', 1, noHy), POOL21, coreRes, 1);
    expect(r2.judge).toBe('none');
  });

  it('榜单里一只都没有本题材 ⇒ mid 档退回常规龙位口径（⛔ 不弃题材）', function() {
    const other = ['甲', '乙', '丙', '丁', '戊'].map(function(n) { return m(n, { pct: 5 }); });
    const dm = dragonMap([['甲', 1], ['乙', 2], ['丙', 3], ['丁', 4], ['戊', 5]]);
    const blk = _buildBlock(mkBlock('商业航天', 1, other), dm, resolveTvrbTier(5), null, null,
      { topicPool: POOL21, coreRes: coreRes, top20Text: '9:25 竞价口径' });
    expect(names(blk)).toEqual(['甲']);
    expect((blk.notes || []).join('\n')).toContain('中档 20日涨幅口径 · 未命中');
  });

  it('SMALL-TOPIC 的十日涨幅口径优先（`opt.order` 有值时本口径整段不跑）', function() {
    // 排名第一 + 4~6 只 ⇒ 走十日涨幅收紧档（[SMALL-TOPIC]），⛔ 不被 20日涨幅口径顶掉
    const members = [
      m('甲', { pct: 30 }), m('乙', { pct: 20 }), m('丙', { pct: 10 }), m('丁', { pct: 5 })
    ];
    const dm = dragonMap([['甲', 1], ['乙', 2], ['丙', 3], ['丁', 4]]);
    const order = [members[1], members[0]];    // SMALL-TOPIC 给的候选序列（乙 → 甲）
    const blk = _buildBlock(mkBlock('大消费', 1, members), dm, resolveTvrbTier(4), null, null,
      { order: order, smallTopic: true, baseText: '9:26 竞价口径',
        topicPool: POOL30, coreRes: coreRes, top20Text: '9:25 竞价口径' });
    expect(names(blk)).toEqual(['乙']);
    expect(blk.top20Judge).toBe('');
    expect((blk.notes || []).join('\n')).not.toContain('20日涨幅口径');
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// ★★ [TOPIC-OWNER 2026-11-15 用户报障 · 10-13 新华文轩] ★★
//
// 用户原话（逐字）：「10月13日，新华文轩又进入了大消费题材，怎么回事……你要按照早盘竞价看板
//   题材 toggle 的题材来啊，为什么都解决不了呢？灰色块虽然不买但也不能出现样错误信息啊」
//
// 库内取证（2026-10-13 真实库 + auction-leg-pct 反解成 9:25 竞价口径）：
//   · 大消费块成员【6 只】：东百集团、丽人丽妆、九阳股份、均瑶健康、皇台酒业、阳光乳业
//     （平均竞价量比 49.00 —— 与用户截图的「数量 6 / 量比 49.00」逐字一致）
//   · 20日涨幅榜：第 1 名 新华传媒 182.38%、【第 2 名 新华文轩 95.09%】、第 3 名 澳弘电子、
//     第 4 名 九阳股份 84.16%
//   · 新华文轩的题材串 = 「人工智能,体育产业,平台经济,文化传媒」
//     平台经济 ∈ 大消费、文化传媒/人工智能 ∈ AI应用 ⇒ coreRes 归一成【两个大类】，
//     于是「大类集合有交集」的认亲尺子把它判成大消费同题材 ⇒ mid 档选中它挂在大消费块下面。
//   而早盘竞价题材 toggle 的归属是【唯一】的：AI应用 19 只 > 大消费 6 只 ⇒ 新华文轩归 AI应用。
//   🔴 归块（唯一）≠ 认亲（交集）—— 两件事不能共用一把尺子。
describe('[TOPIC-OWNER] 一只票只属于一个题材块（按早盘竞价题材 toggle 的归属，⛔ 不许大类沾边就抢）', function () {
  // 真实核心词（云端 core_topics 的同类条目；关键 = 平台经济 ∈ 大消费）
  const CORE2 = [
    { name: 'AI应用', synonyms: ['人工智能', 'AI', '大模型', '文化传媒', '传媒', '游戏'] },
    { name: '大消费', synonyms: ['食品', '饮料', '服装', '家电', '零售', '商业百货', '白酒', '平台经济'] },
    { name: '电子/通信/算力', synonyms: ['PCB', '通信'] }
  ];
  const coreRes2 = makeCoreTopicResolver(CORE2);

  // 大消费块 6 只（与库里逐字一致）
  const DXFMEM = ['东百集团', '丽人丽妆', '九阳股份', '均瑶健康', '皇台酒业', '阳光乳业']
    .map(function (n) { return m(n, { pct: 10 }); });
  // 20日涨幅前十（9:25 竞价口径 · 只主板）—— 名次与真实值一致
  const POOL1013 = [
    pool20('新华传媒', 1, '文化传媒', 182.38),
    pool20('新华文轩', 2, '人工智能,体育产业,平台经济,文化传媒', 95.09),
    pool20('澳弘电子', 3, 'PCB,通信', 93.69),
    pool20('九阳股份', 4, '家电,电子商务', 84.16),
    pool20('时代万恒', 5, '电源', 72.77),
    pool20('龙版传媒', 6, 'AI应用,AI视频', 52.53),
    pool20('内蒙新华', 7, '文化传媒,版权', 40.80),
    pool20('深物业A', 8, '地产链,房地产', 40.45),
    pool20('中新赛克', 9, 'AI应用', 40.29),
    pool20('华北制药', 10, '医药,霍乱概念', 39.26)
  ];
  // topicOwner = 早盘竞价题材 toggle 的分组结果（新华文轩 → AI应用，九阳股份 → 大消费）
  const OWNER = new Map([
    ['新华传媒', 'AI应用'], ['新华文轩', 'AI应用'], ['龙版传媒', 'AI应用'],
    ['内蒙新华', 'AI应用'], ['中新赛克', 'AI应用'],
    ['东百集团', '大消费'], ['丽人丽妆', '大消费'], ['九阳股份', '大消费'],
    ['均瑶健康', '大消费'], ['皇台酒业', '大消费'], ['阳光乳业', '大消费']
  ]);

  it('反例锁：不传 topicOwner（旧口径）⇒ 新华文轩被大消费块抢走（用户截图就是这一行）', function () {
    const r = pickBigTopicTop20(mkBlock('大消费', 1, DXFMEM), POOL1013, coreRes2, 1);
    expect(r.judge).toBe('hit');
    // 旧口径的错：第 2 名 新华文轩 被当成「大消费同题材」排在最前
    expect(r.hits.map(function (h) { return h.name; })).toEqual(['新华文轩', '九阳股份']);
    expect(r.hits[0].rank20).toBe(2);
  });

  it('★ 修后：大消费块只认自己的成员 ⇒ mid 档选 九阳股份（第 4 名）', function () {
    const r = pickBigTopicTop20(mkBlock('大消费', 1, DXFMEM), POOL1013, coreRes2, 1, OWNER);
    expect(r.judge).toBe('hit');
    expect(r.hits.map(function (h) { return h.name; })).toEqual(['九阳股份']);
    expect(r.hits[0].rank20).toBe(4);
  });

  it('反向不误伤：AI应用块照样认得出新华文轩（它本来就归 AI应用）', function () {
    const aiMembers = ['新华传媒', '内蒙新华', '龙版传媒', '中新赛克', '慈文传媒']
      .map(function (n) { return m(n, { pct: 10 }); });
    const r = pickBigTopicTop20(mkBlock('AI应用', 1, aiMembers), POOL1013, coreRes2, 1, OWNER);
    // 榜内属于 AI应用 的 5 只全在（含第 2 名 新华文轩）—— 闸门只挡「归别的块」的票
    expect(r.hits.map(function (h) { return h.name; }))
      .toEqual(['新华传媒', '新华文轩', '龙版传媒', '内蒙新华', '中新赛克']);
    expect(r.hits.map(function (h) { return h.rank20; })).toEqual([1, 2, 6, 7, 9]);
  });

  it('无归属的票（不在当日任何块里）⇒ 退回题材串大类归一，照旧认得出', function () {
    // 10-30 九阳股份就是这一类：在 20日涨幅榜内，但不在当日 9:25 板块成员里 ⇒ 查不到归属
    const noOwner = new Map([['青岛食品', '大消费']]);
    const r = pickBigTopicTop20(mkBlock('大消费', 1, [m('青岛食品', { pct: 10 })]),
      [pool20('九阳股份', 1, '家电,电子商务', 91.89)], coreRes2, 1, noOwner);
    expect(r.judge).toBe('hit');
    expect(r.hits.map(function (h) { return h.name; })).toEqual(['九阳股份']);
  });

  it('_buildBlock 全链：大消费块 mid 档出 九阳股份，说明区不再出现 新华文轩', function () {
    const dm = dragonMap([['东百集团', 1], ['丽人丽妆', 2], ['九阳股份', 3],
      ['均瑶健康', 4], ['皇台酒业', 5], ['阳光乳业', 6]]);
    const blk = _buildBlock(mkBlock('大消费', 1, DXFMEM), dm, resolveTvrbTier(6), null, null,
      { topicPool: POOL1013, coreRes: coreRes2, top20Text: '9:25 竞价口径', topicOwner: OWNER });
    expect(names(blk)).toEqual(['九阳股份']);
    const txt = [blk.reason || ''].concat(blk.notes || []).join('\n');
    expect(txt).toContain('九阳股份');
    expect(txt).not.toContain('新华文轩');
  });

  it('调用链锁：计划层构造 topicOwner 并注入 bigOpt，块层透传给 pickBigTopicTop20', function () {
    const plan = readFileSync('src/logic/topicvolratio/tvrb-plan.js', 'utf8');
    expect(plan).toContain('const topicOwner = new Map();');
    expect(plan).toContain('topicOwner: topicOwner');
    // 来源必须是「本函数第 1 参 list（= rankDecisionTopics 的块）」⇒ 与早盘竞价 toggle 同源
    expect(plan).toContain('list.forEach(function(bk) {');
    const blkSrc = readFileSync('src/logic/topicvolratio/tvrb-blocks.js', 'utf8');
    expect(blkSrc).toContain('pickBigTopicTop20(block, o.topicPool, o.coreRes, tier.pickCount, o.topicOwner)');
    // ⛔ topicOwner 缺省时必须逐字退回旧口径（§11）
    expect(blkSrc).toContain("const ownerMap = (topicOwner instanceof Map && topicOwner.size > 0) ? topicOwner : null;");
  });
});
