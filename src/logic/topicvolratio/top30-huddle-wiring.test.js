// top30-huddle-wiring.test.js — 第三十五条【30日涨幅抱团】的接线锁（静态断言，防「改了一处、漏了一处」）
//
// ══════════════════════════════════════════════════════════════════════════════════════
// 用户 2026-11-18 原话（逐字）
//   「现在新增了30日涨幅，需要在约束下，需要再新添新规……如果有同题材的股票在30日涨幅中排前三，
//     那么就优先选，记住是竞价口径，上面的那个补涨题材选票要让路（也就是三十一条让路，不选，
//     不用这条）……假如30日涨幅当天排前三没有同题材的股票排名前三，再考虑原有的补涨票。」
//   三处口径用户当场拍板：①三十/三十一/三十二全部让路 ②只选最强的 1 只 ③同题材 = 核心词大类归一。
// ══════════════════════════════════════════════════════════════════════════════════════
// 为什么需要这一层静态锁：这条规则跨了 5 个文件（纯函数 / 榜单 / 块组装 / 计划层 / 采集层 / 组合式），
//   而「让路」是个**否决式**语义 —— 少写一处守卫，当天就会两条通道各选一只，
//   屏幕上看起来「都挺有道理」，⛔ 但那是两条规则打架，用户会照着两组票重复下单。
//
// 锁死的六件事：
//   ① 第三十五条的判定段必须排在第三十条【之前】（否则三十先出票，让路就成了摆设）；
//   ② 三十 / 三十一 的入口必须以 `out.top30Huddle` 为前提（提前分支，不是各处补 if）；
//   ③ 三十二（`out.leaderLimitDown`）的入口同样必须让路；
//   ④ 判不出（`top30` 为空）⇒ 必须**不接管**并写说明（§10，⛔ 不许静默退化成补涨票）；
//   ⑤ 两处「清空买点侧」都必须把 `top30Huddle` 一起清掉（漏一处 ⇒ 数据缺失日仍会显示买点票）；
//   ⑥ 数据链路三环齐全：`range30Top` 入参 → `ebbCtx.top30` → 组合式注入。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const PLAN = read('src/logic/topicvolratio/tvrb-plan.js');
const BLOCKS = read('src/logic/topicvolratio/tvrb-blocks.js');
const COLLECT = read('src/logic/decision/decision-collect.js');
const COMPOSABLE = read('src/composables/useTopicVolRatioBoard.js');
const BOARD30 = read('src/logic/topicvolratio/tvrb-auction-board30.js');
const CONSTS = read('src/logic/topicvolratio/tvrb-constants.js');

describe('第三十五条 · 常量只有一处定义', () => {
  it('编号 / 标签 / 门槛都在 tvrb-constants.js', () => {
    expect(CONSTS).toContain("export const TOP30_HUDDLE_RULE_NO = '三十五';");
    expect(CONSTS).toContain("export const TOP30_HUDDLE_TAG = '30日涨幅抱团';");
    expect(CONSTS).toContain('export const TOP30_HUDDLE_TOP_N = 3;');
    expect(CONSTS).toContain('export const TOP30_HUDDLE_PICK_COUNT = 1;');
  });

  it('顶部标签复用第三十条那档配色（⛔ 不新造颜色）', () => {
    expect(CONSTS).toMatch(/TOP30_HUDDLE_TONE = 'weakhuddle'/);
  });
});

describe('第三十五条 · 让路顺序（①③：必须先于三十，且三条都被挡住）', () => {
  it('判定段出现在 `out.cashAlert.show` 分支内', () => {
    const iBranch = PLAN.indexOf('} else if (out.cashAlert.show) {');
    // ⚠️ 用【接管段的独有标识】定位，⛔ 不用「第三十五条」字样 ——
    //   槽位默认值那里的注释也含这四个字，`indexOf` 会先撞到它（首版就踩了这个坑）。
    const iRule = PLAN.indexOf('const t30Pool = (o.ebbCtx');
    const iWeak = PLAN.indexOf('out.weakHuddle = _buildWeakHuddleBlock(');
    expect(iBranch).toBeGreaterThan(-1);
    expect(iRule).toBeGreaterThan(iBranch);
    // ① 必须排在第三十条之前
    expect(iRule).toBeLessThan(iWeak);
  });

  it('三十 / 三十一 的入口是 `if (out.top30Huddle) {` 提前分支（不是各处补 if）', () => {
    // 结构：`if (out.top30Huddle) { ...让路说明... } else if (!whPool || whPool.length === 0) {`
    expect(PLAN).toContain('if (out.top30Huddle) {');
    expect(PLAN).toContain('} else if (!whPool || whPool.length === 0) {');
    // 三十二 也必须让路
    expect(PLAN).toContain('} else if (out.leaderLimitDown) {');
    expect(PLAN).toContain('if (out.leaderLimitDown && out.top30Huddle) {');
  });

  it('让路说明写进 notes（用户要能看见「为什么另一条没出票」）', () => {
    expect(PLAN).toContain('【第三十 / 三十一条 · 今日让路】');
    expect(PLAN).toContain('条 · 今日让路】本日题材龙一确实竞价跌停');
  });
});

describe('第三十五条 · §10 判不出必须与「真的没有」分开', () => {
  it('判不出表（no-pool）写的是「判不出 + 不接管」，⛔ 不是「今天没有」', () => {
    expect(PLAN).toContain("out.notes.push('⚠️【第' + TOP30_HUDDLE_RULE_NO + '条 · 30日涨幅抱团】30日涨幅榜（9:26 竞价口径 · 只主板）' +");
    expect(PLAN).toContain('本条不接管');
    expect(PLAN).toContain('判不出 ≠ 今天没有');
  });

  it('不命中（no-match）写的是「回到第三十一条」，两者文案不同', () => {
    expect(PLAN).toContain("t30.reason === 'no-match'");
    expect(PLAN).toContain('按原有第三十一条（补涨票）继续');
  });

  it('取不到成员行（no-member）如实说，⛔ 不硬造一行没数据的买点', () => {
    expect(PLAN).toContain("t30.reason === 'no-member'");
    expect(PLAN).toContain('本条不接管；第三十条/第三十一条/第三十二条照常生效');
  });
});

describe('第三十五条 · 两处「清空买点侧」都必须清掉它', () => {
  it('`out.top30Huddle = null;` 出现 2 次（数据缺失闸门 + 第三十四条异动收口）', () => {
    // 槽位初始化写的是 `top30Huddle: null,`（对象字面量），不在这条统计里 —— 这里只数「清空」。
    const hits = PLAN.split('out.top30Huddle = null;').length - 1;
    expect(hits).toBe(2);
    // 买点对象里的第二份引用也要清（四个装饰器遍历的是 buy.*）
    expect(PLAN.split('out.buy.top30Huddle = null;').length - 1).toBe(2);
    // 槽位初始化（对象字面量）两处：`out.buy.*` 与 `out.*`（⛔ 少一处 `_buyBlocksOf` 就会漏掉这条通道）。
    // ⚠️ 两处的尾逗号不同（一处是最后一个属性），所以只匹配到 `null` 为止。
    expect(PLAN.split('top30Huddle: null').length - 1).toBe(2);
  });
});

describe('第三十五条 · 数据链路三环齐全（⑥）', () => {
  it('采集层：_ebbCtxOf 收第 11 参 range30Top，并产出 top30（名次是 rank30）', () => {
    expect(COLLECT).toContain('range20Top10, range30Top) {');
    expect(COLLECT).toContain('top30: top30,');
    expect(COLLECT).toContain('e.rank30 = i + 1;');
    // ⛔ 不许把 30 日下标塞进 rank20（那颗雷将来会被误读成「20日涨幅第 1 名」）
    expect(COLLECT).toContain('e.rank20 = null;');
    // 20 日榜没就绪时 35 仍要能算（两条尺子互不拖累）
    expect(COLLECT).toContain('return Object.assign({}, none, { top30: top30 });');
  });

  it('采集层：缺省 none 里必须有 top30: []（否则规则层读到 undefined 会抛）', () => {
    expect(COLLECT).toContain('top30: [],');
  });

  it('组合式：注入 range30Top + 建立响应式依赖（漏掉 Token ⇒ 永远停在「还没就绪」）', () => {
    expect(COMPOSABLE).toContain('range30Top: _r30Top,');
    expect(COMPOSABLE).toContain('void getTvrbAuctionBoard30Token();');
    expect(COMPOSABLE).toContain('ensureTvrbAuctionBoard30(d)');
  });

  it('30 日榜恒用竞价口径（用户「记住是竞价口径」）', () => {
    expect(BOARD30).toContain('readAuctionLegRange30Pct');
    expect(BOARD30).toContain('RANGE30_MIN_LEGS');
    // 排序/门槛复用生产唯一实现，⛔ 不另写一份
    expect(BOARD30).toContain('buildAuctionLegBoard');
    expect(BOARD30).not.toContain('sort(function');
  });
});

describe('第三十五条 · 块组装（只选 1 只 + 口径写清楚）', () => {
  it('_buildTop30HuddleBlock 存在且只造一个 pick', () => {
    expect(BLOCKS).toContain('export function _buildTop30HuddleBlock(');
    // 只 push 一只：picks 数组里只有一个对象字面量（seq: 1）
    expect(BLOCKS).toContain('seq: 1,');
  });

  it('行上不用「市龙N」标签（屏幕那套是收盘口径，两边口径不同会打架）', () => {
    expect(BLOCKS).toContain("dragonLabel: '30日第' + p0.rank30 + '名',");
    // ⛔ 本条块里不许出现市龙标签函数
    const seg = BLOCKS.slice(BLOCKS.indexOf('_buildTop30HuddleBlock'), BLOCKS.indexOf('_buildLeaderLimitDownHuddleBlock'));
    expect(seg).not.toContain('marketDragonLabel');
    expect(seg).not.toContain('totalDragonLabel');
  });

  it('买点名单要收它（否则卖点侧会把今天要买的票标成「竞价清仓」）', () => {
    expect(PLAN).toContain('if (out.top30Huddle) {');
    expect(PLAN).toContain('(out.top30Huddle.picks || []).forEach(function(p) { if (p && p.name) out.buyNames.add(p.name); });');
    // 「选出 N 只」也要数它
    expect(PLAN).toContain('if (out.top30Huddle) _countUnique(out.top30Huddle.picks);');
  });
});
