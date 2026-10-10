// tick-minute.test.js — 「分笔买卖」纯逻辑的单测（§15 独立业务模块，§6 单一口径）
//
// 覆盖三块（全部是纯函数，不依赖浏览器 / 网络 / Pinia）：
//   ① 时间口径：北京时刻、9:31 闸门（历史日随时可抓 / 今天必须等到 9:31 / 未来日不可抓）；
//   ② 快照 → 一笔一笔：用户 10/9 襄阳轴承那组数的口径复现（7 涨 / 12 跌 / 1 平 ⇒ 7 红 13 绿）、
//      无成交快照被略去、第一笔比当日开盘价、开盘价缺失 ⇒ 方向未知而不是平盘；
//   ③ 决策行 → 看板行：只带用户点名的那几列；库里没数据时显示「未抓取 / 无数据」而不是「0红0绿」。

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TICK_START_TIME, TICK_END_TIME, TICK_WINDOW_READY,
  PEN_UP, PEN_DOWN, PEN_FLAT,
  TICK_NOT_FETCHED, TICK_NO_DATA,
  hmsToSec, beijingHms, beijingToday, tickWindowState,
  formatPenHands, formatPenPrice, penDirectionOf, penArrowOf, penToneOf,
  buildTickPens, tickStatText, tickStrengthOf, tickPanelTitle, tickPanelNote, tickPanelHint,
  buildTickBoard, tickTargetsOf
} from './tick-minute.js';

// ── 时间口径 ─────────────────────────────────────────────────────────────
describe('tick-minute · 时间口径', () => {
  it('窗口常量就是用户口径的 9:30~9:31（左闭右开）', () => {
    expect(TICK_START_TIME).toBe('09:30:00');
    expect(TICK_END_TIME).toBe('09:31:00');
    expect(TICK_WINDOW_READY).toBe('09:31:00');
  });

  it('hmsToSec 解析 HH:MM[:SS]，非法 → NaN', () => {
    expect(hmsToSec('09:30:00')).toBe(9 * 3600 + 30 * 60);
    expect(hmsToSec('09:31')).toBe(9 * 3600 + 31 * 60);
    expect(Number.isNaN(hmsToSec(''))).toBe(true);
    expect(Number.isNaN(hmsToSec('abc'))).toBe(true);
  });

  it('beijingHms / beijingToday 按 UTC+8 算（注入时间，不受本机时区影响）', () => {
    // 2026-10-09T00:31:05Z → 北京 2026-10-09 08:31:05
    const t = Date.UTC(2026, 9, 9, 0, 31, 5);
    expect(beijingHms(t)).toBe('08:31:05');
    expect(beijingToday(t)).toBe('2026-10-09');
    // 2026-10-08T16:05:00Z → 北京 2026-10-09 00:05:00（跨日）
    expect(beijingToday(Date.UTC(2026, 9, 8, 16, 5, 0))).toBe('2026-10-09');
  });

  it('tickWindowState：历史日随时可抓；今天 9:31 前不可抓、之后可抓；未来日不可抓', () => {
    const now = Date.UTC(2026, 9, 9, 1, 30, 0); // 北京 2026-10-09 09:30:00
    expect(tickWindowState('2026-10-08', now).can).toBe(true);

    const before = tickWindowState('2026-10-09', now);
    expect(before.can).toBe(false);
    expect(before.retryAtHms).toBe(TICK_WINDOW_READY);
    expect(before.reason).toContain('09:31:00');

    const after = tickWindowState('2026-10-09', Date.UTC(2026, 9, 9, 1, 31, 5)); // 北京 09:31:05
    expect(after.can).toBe(true);

    expect(tickWindowState('2026-10-10', now).can).toBe(false);
    expect(tickWindowState('', now).can).toBe(false);
    expect(tickWindowState('2026/10/09', now).can).toBe(false);
  });
});

// ── 单位与方向的基础件 ───────────────────────────────────────────────────
describe('tick-minute · 单位与方向', () => {
  it('formatPenHands：原值【就是手】，⛔ 绝不再 ÷100（2026-10-10 实测更正）；null → —', () => {
    // 用户对照东财发现：东财 1129 ↔ 本看板 11.29，差正好 100 倍 ⇒ 我们多除了一次 100。
    // 线上 76 个差值里「是 100 的整数倍」占 0%（A 股一笔成交必是 100 股的整数倍）⇒ 上游单位是【手】。
    expect(formatPenHands(1129)).toBe('1129');
    expect(formatPenHands(31319)).toBe('31319');
    expect(formatPenHands(0)).toBe('0');
    expect(formatPenHands(12.5)).toBe('12.50');   // 上游万一给小数才保留 2 位（整手一律整数）
    expect(formatPenHands(null)).toBe('—');
    expect(formatPenHands(undefined)).toBe('—');
    expect(formatPenHands('')).toBe('—');
  });

  it('formatPenPrice：两位小数；null → —', () => {
    expect(formatPenPrice(10.3)).toBe('10.30');
    expect(formatPenPrice(0)).toBe('0.00');
    expect(formatPenPrice(null)).toBe('—');
  });

  it('penDirectionOf：> 上一笔 up / < down / = flat；任一为 null → 空串（未知）', () => {
    expect(penDirectionOf(10.1, 10)).toBe(PEN_UP);
    expect(penDirectionOf(9.9, 10)).toBe(PEN_DOWN);
    expect(penDirectionOf(10, 10)).toBe(PEN_FLAT);
    expect(penDirectionOf(null, 10)).toBe('');
    expect(penDirectionOf(10, null)).toBe('');
  });

  it('平盘：无箭头，但配色档与下跌同为 down（东财口径「下跌和平的用绿色」）', () => {
    expect(penArrowOf(PEN_UP)).toBe('↑');
    expect(penArrowOf(PEN_DOWN)).toBe('↓');
    expect(penArrowOf(PEN_FLAT)).toBe('');
    expect(penArrowOf('')).toBe('');
    expect(penToneOf(PEN_UP)).toBe('up');
    expect(penToneOf(PEN_DOWN)).toBe('down');
    expect(penToneOf(PEN_FLAT)).toBe('down');
    expect(penToneOf('')).toBe('');
  });
});

// ── 快照 → 一笔一笔 ──────────────────────────────────────────────────────
describe('tick-minute · 快照 → 一笔一笔 + 红绿统计', () => {
  it('用户 10/9 襄阳轴承那组数：7 涨 / 12 跌 / 1 平 ⇒ 7 红 13 绿（平盘计入绿）', () => {
    // 20 个快照：第 1 笔（比开盘价）为平，随后 12 笔下跌、7 笔上涨，顺序按用户给的20条排列的特征
    // 构造：开盘价 10.00；前 1 笔平，接着 12 笔逐级下杀，最后 7 笔逐级上抬
    const pens = [{ t: '09:30:03.000', p: 10.00, v: null }];   // 第1笔：与开盘价 10.00 相比 = 平
    let p = 10.00;
    for (let i = 0; i < 12; i++) { p = Number((p - 0.01).toFixed(2)); pens.push({ t: '09:30:0' + (i + 3), p: p, v: 1000 }); }
    for (let i = 0; i < 7; i++) { p = Number((p + 0.01).toFixed(2)); pens.push({ t: '09:30:2' + i, p: p, v: 2000 }); }

    const s = buildTickPens({ openPrice: 10.00, pens: pens, tradeCount: 20 });
    expect(s.rawCount).toBe(20);
    expect(s.up).toBe(7);
    expect(s.down).toBe(12);
    expect(s.flat).toBe(1);
    expect(s.unknown).toBe(0);
    expect(s.red).toBe(7);
    expect(s.green).toBe(13);   // 12 跌 + 1 平
    expect(s.total).toBe(20);
    expect(s.pens.length).toBe(20);
    expect(s.pens[0].dir).toBe(PEN_FLAT);
    expect(s.pens[0].arrow).toBe('');
    expect(s.pens[0].volText).toBe('—');   // 第一笔没有上一行 ⇒ 量未知，绝不拿累计值冒充
    expect(s.pens[1].arrow).toBe('↓');
  });

  it('买卖结论：强/弱/均衡，且【买点侧与卖点侧的动作名不同】（2026-10-10 用户口径）', () => {
    // 构造：第 1 笔 = 与开盘价相平（所以它自己会进「绿」那一边），随后 upN 笔涨、downN 笔跌
    const mk = (upN, downN) => {
      const pens = [{ t: '09:30:03', p: 10, v: null }];
      let p = 10;
      for (let i = 0; i < upN; i++) { p = Number((p + 0.01).toFixed(2)); pens.push({ t: 'x' + i, p: p, v: 100 }); }
      for (let i = 0; i < downN; i++) { p = Number((p - 0.01).toFixed(2)); pens.push({ t: 'y' + i, p: p, v: 100 }); }
      return buildTickPens({ openPrice: 10, pens: pens });
    };
    // mk(5,1) → 红 5 / 绿 1 + 首笔平 1 = 2 ⇒ 强（红）
    expect(tickStrengthOf(mk(5, 1), 'buy').tone).toBe('strong');
    expect(tickStrengthOf(mk(5, 1), 'buy').text).toBe('立刻买');
    expect(tickStrengthOf(mk(5, 1), 'sell').tone).toBe('strong');
    expect(tickStrengthOf(mk(5, 1), 'sell').text).toBe('冲高卖');
    // mk(1,5) → 红 1 / 绿 6 ⇒ 弱（绿）
    expect(tickStrengthOf(mk(1, 5), 'buy').tone).toBe('weak');
    expect(tickStrengthOf(mk(1, 5), 'buy').text).toBe('下杀买');
    expect(tickStrengthOf(mk(1, 5), 'sell').tone).toBe('weak');
    expect(tickStrengthOf(mk(1, 5), 'sell').text).toBe('立刻卖');
    // ★ [2026-10-10 二次改·用户口径]「因为这个分笔，就是盘中，盘中多余去掉」
    //   ⇒ 四个动作名里都不允许再出现冗余的「盘中」（回归护栏，防后人又加回去）
    ['buy', 'sell'].forEach((side) => {
      [mk(5, 1), mk(1, 5), mk(3, 2)].forEach((s) => {
        expect(tickStrengthOf(s, side).text).not.toContain('盘中');
      });
    });
    // mk(3,2) → 红 3 / 绿 2 + 首笔平 1 = 3 ⇒ 均衡（买卖两侧同名，不站边）
    expect(tickStrengthOf(mk(3, 2), 'buy').tone).toBe('even');
    expect(tickStrengthOf(mk(3, 2), 'buy').text).toBe('均衡');
    expect(tickStrengthOf(mk(3, 2), 'sell').text).toBe('均衡');
    // §10：一笔都判不出来 ⇒ 不给结论（⛔ 不硬判「均衡」）
    expect(tickStrengthOf(buildTickPens({ openPrice: null, pens: [] })).text).toBe('');
    // 缺省 side ⇒ 按买点侧处理（⛔ 不会凭空给出一个卖点动作名）
    expect(tickStrengthOf(mk(5, 1)).text).toBe('立刻买');
  });

  it('★ 结论胶囊的文案里【必须带上「手」这个单位】—— 用户看到的手数单位就是手', () => {
    const s = buildTickPens({
      openPrice: 10,
      pens: [{ t: 'a', p: 10, v: null }, { t: 'b', p: 9.9, v: 100 }, { t: 'c', p: 9.8, v: 100 }]
    });
    // 「下杀买」的说明文字要让用户知道手数的单位，否则「一位数/两位数」无从对照
    expect(tickStrengthOf(s, 'buy').title).toContain('手');
    // ⛔ 这张看板的手数是【手】不是【万手】—— 说明文字里不能出现「万手」（免得用户按 100 倍去找）
    expect(tickStrengthOf(s, 'buy').title).not.toContain('万手');
  });

  it('★ 展开面板最下方：分析过程 + 买卖点逻辑（两行，买/卖侧不同）', () => {
    const mk = (upN, downN) => {
      const pens = [{ t: '09:30:03', p: 10, v: null }];
      let p = 10;
      for (let i = 0; i < upN; i++) { p = Number((p + 0.01).toFixed(2)); pens.push({ t: 'x' + i, p: p, v: 100 }); }
      for (let i = 0; i < downN; i++) { p = Number((p - 0.01).toFixed(2)); pens.push({ t: 'y' + i, p: p, v: 100 }); }
      return buildTickPens({ openPrice: 10, pens: pens });
    };
    // 第 1 行永远是【分析】（红绿 → 强弱），买卖两侧相同
    const weakBuy = tickPanelHint(mk(1, 5), 'buy');
    const weakSell = tickPanelHint(mk(1, 5), 'sell');
    expect(weakBuy.length).toBe(2);
    expect(weakBuy[0]).toContain('【分析】');
    expect(weakBuy[0]).toContain('红 1 笔');
    expect(weakBuy[0]).toContain('开盘弱');
    expect(weakSell[0]).toBe(weakBuy[0]);
    // 第 2 行是【买点/卖点】动作名 + 怎么做 —— 两侧必须不同
    expect(weakBuy[1]).toContain('【买点】下杀买');
    expect(weakSell[1]).toContain('【卖点】立刻卖');
    expect(weakBuy[1]).not.toBe(weakSell[1]);
    // 走强那一侧同样成立，并且「冲高卖」要交代「第一笔绿色手数」这个观察点
    expect(tickPanelHint(mk(5, 1), 'buy')[1]).toContain('【买点】立刻买');
    expect(tickPanelHint(mk(5, 1), 'sell')[1]).toContain('【卖点】冲高卖');
    expect(tickPanelHint(mk(5, 1), 'sell')[1]).toContain('绿色');
    // 均衡：第 1 行说明相等，第 2 行不下结论（§10 不站边）
    const even = tickPanelHint(mk(3, 2), 'buy');
    expect(even[0]).toContain('均衡');
    expect(even[1]).toContain('不下结论');
    // §10：一笔都判不出来 ⇒ 整块不渲染（空数组）
    expect(tickPanelHint(buildTickPens({ openPrice: null, pens: [] }), 'buy')).toEqual([]);
  });

  it('无成交快照（累计量没变，v=0）被略去，且不计入平盘', () => {
    const s = buildTickPens({
      openPrice: 10,
      pens: [
        { t: 'a', p: 10, v: null },      // 第一笔：与开盘价比 = 平（保留）
        { t: 'b', p: 10, v: 0 },         // 没有任何成交 → 略去
        { t: 'c', p: 10, v: 0 },         // 同上
        { t: 'd', p: 10.05, v: 500 }     // 涨
      ]
    });
    expect(s.idle).toBe(2);
    expect(s.pens.length).toBe(2);
    expect(s.flat).toBe(1);
    expect(s.up).toBe(1);
    expect(s.green).toBe(1);   // 只有那 1 笔平盘，两个空快照没被算进去
    expect(s.rawCount).toBe(4);
  });

  it('缺价格的快照被略去（droppedNoPrice），不影响方向链', () => {
    const s = buildTickPens({
      openPrice: 10,
      pens: [
        { t: 'a', p: null, v: null },    // 缺价格 → 略去（且没把 prevPrice 冲掉）
        { t: 'b', p: 10.1, v: 100 },     // 与开盘价 10 比 = 涨
        { t: 'c', p: null, v: 100 },     // 缺价格 → 略去
        { t: 'd', p: 10.2, v: 100 }      // 与上一笔有价格者 10.1 比 = 涨
      ]
    });
    expect(s.droppedNoPrice).toBe(2);
    expect(s.up).toBe(2);
    expect(s.unknown).toBe(0);
  });

  it('§10：拿不到当日开盘价 ⇒ 第一笔方向未知，⛔ 不算平盘、⛔ 不进绿', () => {
    const s = buildTickPens({
      openPrice: null,
      pens: [{ t: 'a', p: 10, v: null }, { t: 'b', p: 10.05, v: 100 }]
    });
    expect(s.unknown).toBe(1);
    expect(s.flat).toBe(0);
    expect(s.up).toBe(1);
    expect(s.red).toBe(1);
    expect(s.green).toBe(0);
    expect(s.pens[0].dir).toBe('');
    expect(s.pens[0].tone).toBe('');
  });

  it('全部聚合成「17红4绿」两段文案；没有可统计的笔 ⇒ 空串（⛔ 不显示 0红0绿）', () => {
    // 开盘价 9.90 ⇒ 第 1 笔（10.00）即为「上涨」，随后 16 笔涨、4 笔跌 ⇒ 红 17 / 绿 4
    const pens = [{ t: 'a', p: 10, v: null }];
    let p = 10;
    for (let i = 0; i < 16; i++) { p = Number((p + 0.01).toFixed(2)); pens.push({ t: 'u' + i, p: p, v: 100 }); }
    for (let i = 0; i < 4; i++) { p = Number((p - 0.01).toFixed(2)); pens.push({ t: 'd' + i, p: p, v: 100 }); }
    const s = buildTickPens({ openPrice: 9.9, pens: pens });
    const t = tickStatText(s);
    expect(t.redText).toBe('17红');
    expect(t.greenText).toBe('4绿');
    expect(t.title).toContain('上涨（红）17 笔');
    expect(tickStatText(buildTickPens({ openPrice: 10, pens: [] }))).toEqual({ redText: '', greenText: '', title: '' });
  });

  it('面板标题 / 注释把「快照数 ≠ 成交笔数」讲出来', () => {
    const s = buildTickPens({
      openPrice: 10,
      pens: [{ t: 'a', p: 10, v: null }, { t: 'b', p: 10, v: 0 }, { t: 'c', p: 10.1, v: 100 }],
      tradeCount: 37
    });
    const title = tickPanelTitle(s, '襄阳轴承');
    expect(title).toContain('襄阳轴承');
    expect(title).toContain('09:30~09:31');
    expect(title).toContain('上游成交笔数 37');
    expect(tickPanelNote(s)).toContain('原始快照 3 个');
    expect(tickPanelNote(s)).toContain('没有任何成交');
  });
});

// ── 决策行 → 看板行 ─────────────────────────────────────────────────────
function _decided() {
  return {
    ready: true,
    reason: '',
    buy: {
      heavy: {
        block: {
          topic: 'AI应用', rank: 1, count: 6, yiziCount: 1,
          members: [
            { name: '襄阳轴承', code: '000678' },
            { name: '龙版传媒', code: '605577' }
          ]
        },
        pickRank: 1,
        prevBoughtTag: '昨有买入',
        streakTag: '二次入选',
        picks: [
          { seq: 1, name: '襄阳轴承', dragonLabel: '龙一', dragonRank: 1, pct: 23.4, dragonDeltaText: '+2', dragonDeltaTone: 'up', dragonDeltaTitle: 't' },
          { seq: 2, name: '龙版传媒', dragonLabel: '龙二', dragonRank: 2, pct: -5.1 }
        ]
      },
      light: null, candidates: [], noYizi: null, smallTopic: null, bigTopic: null
    },
    sell: [{
      topic: 'AI应用', groupKey: 'AI应用|1', topicRank: 1, count: 6, yiziCount: 1,
      items: [{ seq: 1, name: '襄阳轴承', code: '000678', topic: 'AI应用', dragonLabel: '龙一', dragonRank: 1, pct: 23.4 }]
    }]
  };
}

describe('tick-minute · 决策行 → 分笔买卖看板行', () => {
  it('未就绪时如实上报原因（§10 不显示成空看板）', () => {
    const b = buildTickBoard({ ready: false, reason: '十日涨幅尚未加载完成' }, new Map());
    expect(b.ready).toBe(false);
    expect(b.reason).toBe('十日涨幅尚未加载完成');
    expect(b.buyBlocks).toEqual([]);
    expect(b.sellGroups).toEqual([]);
  });

  it('只带用户点名的列；代码从 members 取（买点 pick 上没有 code）', () => {
    const b = buildTickBoard(_decided(), new Map());
    expect(b.ready).toBe(true);
    expect(b.buyBlocks.length).toBe(1);
    const blk = b.buyBlocks[0];
    expect(blk.topic).toBe('AI应用');
    expect(blk.rank).toBe(1);
    expect(blk.count).toBe(6);
    expect(blk.yiziCount).toBe(1);
    expect(blk.prevBoughtTag).toBe('昨有买入');
    expect(blk.streakTag).toBe('二次入选');
    // ⛔ 用户要求「其它不要放」：这些决策看板的字段一个都不该出现在分笔行上
    expect(blk.picks[0]).not.toHaveProperty('buyActionTag');
    expect(blk.picks[0]).not.toHaveProperty('aucPctText');
    expect(blk.picks[0]).not.toHaveProperty('volRatioText');
    expect(blk.picks[0]).not.toHaveProperty('aucShareText');
    expect(blk.picks[0]).not.toHaveProperty('position');
    expect(blk.picks[0]).not.toHaveProperty('actionNote');
    // 该有的在
    expect(blk.picks[0].name).toBe('襄阳轴承');
    expect(blk.picks[0].code).toBe('000678');
    expect(blk.picks[0].dragonLabel).toBe('龙一');
    expect(blk.picks[0].dragonDeltaText).toBe('+2');
    expect(blk.picks[0].pctText).toBe('+23%');
    expect(blk.picks[1].code).toBe('605577');
    expect(blk.picks[1].pctText).toBe('-5%');
  });

  it('库里没有这一行 ⇒ 「未抓取」；本次会话抓过仍没有 ⇒ 「无数据」（⛔ 不显示 0红0绿）', () => {
    const fresh = buildTickBoard(_decided(), new Map(), { attempted: new Set() });
    expect(fresh.buyBlocks[0].picks[0].hasTick).toBe(false);
    expect(fresh.buyBlocks[0].picks[0].emptyText).toBe(TICK_NOT_FETCHED);
    expect(fresh.buyBlocks[0].picks[0].redText).toBe('');

    const tried = buildTickBoard(_decided(), new Map(), { attempted: new Set(['襄阳轴承']) });
    expect(tried.buyBlocks[0].picks[0].emptyText).toBe(TICK_NO_DATA);
    expect(tried.buyBlocks[0].picks[1].emptyText).toBe(TICK_NOT_FETCHED); // 没抓过的那只照旧
  });

  it('抓不到代码的那只 ⇒ 显示具体原因（缺代码），不是「无数据」', () => {
    const skipMap = new Map([['龙版传媒', '缺代码']]);
    const b = buildTickBoard(_decided(), new Map(), { skipMap: skipMap });
    expect(b.buyBlocks[0].picks[1].emptyText).toBe('缺代码');
    expect(b.buyBlocks[0].picks[1].emptyTitle).toContain('缺代码');
  });

  it('库里有行 ⇒ 挂上 17红4绿 + 强弱 + 明细，且明细带序号/时间/价格/手数/箭头', () => {
    const tickMap = new Map();
    tickMap.set('襄阳轴承', {
      date: '2026-10-09', name: '襄阳轴承', code: '000678', openPrice: 10,
      pens: [
        { t: '09:30:03.000', p: 10, v: null },
        { t: '09:30:06.000', p: 10.10, v: 1200 },
        { t: '09:30:09.000', p: 10.20, v: 300 }
      ],
      tradeCount: 20, startTime: '09:30:00', endTime: '09:31:00', source: 'tick_history', updatedAt: ''
    });
    const b = buildTickBoard(_decided(), tickMap, { attempted: new Set(['襄阳轴承']) });
    const p0 = b.buyBlocks[0].picks[0];
    expect(p0.hasTick).toBe(true);
    expect(p0.redText).toBe('2红');     // 10→10.10→10.20 两笔上涨
    expect(p0.greenText).toBe('1绿');   // 第一笔与开盘价 10 相平
    expect(p0.strengthTone).toBe('strong');
    expect(p0.strengthText).toBe('立刻买');   // 买点侧：走强 ⇒ 立刻买
    expect(p0.pens.length).toBe(3);
    expect(p0.pens[0].volText).toBe('—');
    expect(p0.pens[1].volText).toBe('1200');   // ★ 原值就是手：v=1200 ⇒ 显示 1200（⛔ 不再是 12）
    expect(p0.pens[2].arrow).toBe('↑');
    expect(p0.panelTitle).toContain('襄阳轴承');
    // 卖点侧同一只票应是同一份统计（§6 一个口径），但【动作名不同】——买点说买、卖点说卖
    expect(b.sellGroups[0].items[0].redText).toBe('2红');
    expect(b.sellGroups[0].items[0].greenText).toBe('1绿');
    expect(b.sellGroups[0].items[0].strengthTone).toBe('strong');       // 同一份强弱色
    expect(b.sellGroups[0].items[0].strengthText).toBe('冲高卖');       // ★ 但名字必须是卖点侧的动作
    // ★ 展开面板最下方的「分析过程 + 买卖点逻辑」同样要跟着侧别走
    expect(p0.panelHint.length).toBe(2);
    expect(p0.panelHint[1]).toContain('【买点】立刻买');
    expect(b.sellGroups[0].items[0].panelHint[1]).toContain('【卖点】冲高卖');
    // ⛔ 没有行 / 抓不到时整块不渲染（§10）
    expect(b.buyBlocks[0].picks[1].panelHint).toEqual([]);
  });

  it('有行但一笔都判不出来（全缺价格）⇒ 回落「无数据」，⛔ 不留空胶囊', () => {
    const tickMap = new Map();
    tickMap.set('襄阳轴承', {
      date: '2026-10-09', name: '襄阳轴承', code: '000678', openPrice: null,
      pens: [{ t: 'a', p: null, v: null }, { t: 'b', p: null, v: 100 }],
      tradeCount: null
    });
    const b = buildTickBoard(_decided(), tickMap, {});
    const p0 = b.buyBlocks[0].picks[0];
    expect(p0.hasTick).toBe(true);
    expect(p0.emptyText).toBe(TICK_NO_DATA);
    expect(p0.redText).toBe('');
    expect(p0.greenText).toBe('');
    expect(p0.strengthText).toBe('');
  });

  it('没有股票的买点块整块不渲染（本看板没有「不出票原因」行，留个空题材名反而像坏了）', () => {
    const d = _decided();
    d.buy.heavy.picks = [];
    const b = buildTickBoard(d, new Map());
    expect(b.buyBlocks.length).toBe(0);
  });

  it('被降级成候选题材的第 2 名【不会重复出现】（与决策看板 buyCandidates 同一引用口径）', () => {
    const d = _decided();
    // 第 2 名题材：独立的一块（不是 heavy 的别名），同时出现在 light 与 candidates 里
    const light = {
      block: { topic: '机器人', rank: 2, count: 5, yiziCount: 0, members: [{ name: '龙版传媒', code: '605577' }] },
      pickRank: 2,
      prevBoughtTag: '',
      streakTag: '',
      picks: [{ seq: 1, name: '龙版传媒', dragonLabel: '龙一', dragonRank: 1, pct: -5.1 }]
    };
    d.buy.light = light;
    d.buy.candidates = [light];                // ⚠️ 同一个对象引用（真实数据就是这样）

    const b = buildTickBoard(d, new Map());
    expect(b.buyBlocks.length).toBe(2);        // 1: AI应用（heavy） 2: 机器人（light） —— 不是 3
    const topics = b.buyBlocks.map(function(x) { return x.topic; });
    expect(topics).toEqual(['AI应用', '机器人']);
  });

  it('tickTargetsOf：买点 + 卖点去重后的抓取目标（同一只票只出现一次）', () => {
    const b = buildTickBoard(_decided(), new Map());
    const targets = tickTargetsOf(b);
    expect(targets.map(function(t) { return t.name; })).toEqual(['襄阳轴承', '龙版传媒']);
    expect(targets[0].code).toBe('000678');
  });
});

// ── 跨文件红线：后端等的必须短于前端等的（2026-10-10 事故的回归护栏）──────
// 为什么用「读源码」而不是「import 常量」：
//   · 这两个常量活在两个不同的运行环境里（前端 bundle / Deno Edge Function），
//     没有任何一个模块能同时 import 到它们；
//   · 而它们的【大小关系】是硬约束 —— 一旦后端预算 ≥ 前端超时，
//     上游一抽风前端就先 abort，并把「我超时了」误报成「接口不可达」（正是本次事故）。
//   ⇒ 只能用文本断言把这条不变式钉住。改任一侧的数字，这条测试都会红。
describe('tick-minute · 红线：前端超时 > 后端上游总预算', () => {
  const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
  const textOf = function(rel) { return readFileSync(join(ROOT, rel), 'utf8'); };
  const numOf = function(text, re, label) {
    const m = re.exec(text);
    expect(m, '没匹配到 ' + label + ' —— 常量被改名/挪走了？请同步更新本测试').toBeTruthy();
    return Number(m[1]);
  };

  const EDGE_SRC = 'supabase/functions/tick-minute-fetch/index.ts';
  const FE_SRC = 'src/data/tick-minute.js';

  it('后端的 TOTAL_BUDGET_MS 明显小于前端的 EDGE_TIMEOUT_MS', () => {
    const edge = textOf(EDGE_SRC);
    const fe = textOf(FE_SRC);
    const perRequest = numOf(edge, /REQUEST_TIMEOUT_MS:\s*Number\(Deno\.env\.get\('NUMCAT_TICK_TIMEOUT_MS'\)\s*\|\|\s*(\d+)\)/, 'REQUEST_TIMEOUT_MS');
    const budget = numOf(edge, /TOTAL_BUDGET_MS:\s*Number\(Deno\.env\.get\('NUMCAT_TICK_BUDGET_MS'\)\s*\|\|\s*(\d+)\)/, 'TOTAL_BUDGET_MS');
    const feTimeout = numOf(fe, /const EDGE_TIMEOUT_MS\s*=\s*(\d+)/, 'EDGE_TIMEOUT_MS');

    // 单次上游请求不能比总预算还长（否则一次就能把预算吃穿）
    expect(perRequest).toBeLessThanOrEqual(budget);
    // 前端必须等得比后端久，且留出冷启动 + 写库 + 回读 + 公网往返的余量（≥ 1.3 倍）
    expect(feTimeout).toBeGreaterThan(budget);
    expect(feTimeout).toBeGreaterThanOrEqual(Math.round(budget * 1.3));
  });

  it('★ 预算要按【最多几把 key】算：前端超时 > key 把数 × 每把预算', () => {
    // 2026-10-10 新增回退后，一次 /minute 最坏会跑 2 轮上游（小号 403 → 主号再来一轮），
    // 所以前端的等待上限必须按【轮数】放宽。这条断言把「轮数」钉在 2 —— 以后谁再加一把 key，
    // 这条会先红，逼他同时改前端超时（否则又会退化成「前端先掐断 = 误报不可达」）。
    const edge = textOf(EDGE_SRC);
    const fe = textOf(FE_SRC);
    const budget = numOf(edge, /TOTAL_BUDGET_MS:\s*Number\(Deno\.env\.get\('NUMCAT_TICK_BUDGET_MS'\)\s*\|\|\s*(\d+)\)/, 'TOTAL_BUDGET_MS');
    const feTimeout = numOf(fe, /const EDGE_TIMEOUT_MS\s*=\s*(\d+)/, 'EDGE_TIMEOUT_MS');
    const keyConsts = edge.match(/^const KEY_[A-Z_]+ = '/gm) || [];
    expect(keyConsts.length).toBeGreaterThan(0);
    expect(keyConsts.length).toBeLessThanOrEqual(2);
    expect(feTimeout).toBeGreaterThanOrEqual(Math.round(budget * keyConsts.length * 1.3));
  });

  it('★ 密钥回退必须真的接在取数路径上（不能只写在注释里）', () => {
    // 2026-10-10 发现的历史 bug：configuredKeys() 早就会返回两把 key，
    // 但 runFetch / /probe 只取了 primaryKey()（第一把）⇒ 回退那把【从来没被用过】。
    // 这条测试用「源码结构」把它钉住：入口必须遍历 configuredKeys()，且不得再有 primaryKey()。
    const edge = textOf(EDGE_SRC);
    expect(edge).toContain('configuredKeys()');
    expect(edge).toContain('isKeyLevelFailure(');
    expect(edge).not.toContain('primaryKey(');
    // 只有「key 级失败」才换下一把（超时/网络失败换 key 也救不了，白花额度）
    expect(edge).toContain('!isKeyLevelFailure(');
  });

  it('Edge Function 全文没有 delete（§11：本表是点名抓取的产物，不该有清理语义）', () => {
    const edge = textOf(EDGE_SRC).toLowerCase();
    expect(edge.indexOf("method: 'delete'")).toBe(-1);
    expect(edge.indexOf('.delete(')).toBe(-1);
  });
});
