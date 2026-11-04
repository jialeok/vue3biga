/**
 * [TVRB-DATA-GATE 2026-11-04] 买点侧「数据缺失 ⇒ 禁止选股」的判据单测。
 *
 * 锁的是四类红线（都属于「静默买错票」）：
 *   ① 竞价量比整表缺失（事故日 0%）⇒ 必须拦，且必须点名「竞价量比」（用户要的提示行）；
 *   ② 十日涨幅整表缺失 ⇒ 必须拦；但**个别票缺值（65% 覆盖）⛔ 不能拦**（否则看板天天空仓）；
 *   ③ 20 日涨幅前五榜为空且已有结论 / 上游已放弃 ⇒ 必须拦；还没结论 ⇒ 交给 buy-settle 去等，不在这里拦；
 *   ④ 一切正常 ⇒ 放行，并且返回**同一个冻结引用**（§19 不白触发下游重算）。
 */
import { describe, it, expect } from 'vitest';
import {
  resolveBuyDataGate,
  TVRB_DATA_GATE_NONE,
  TVRB_DATA_GATE_MIN_RATIO_COVER,
  TVRB_DATA_GATE_MIN_RANGE10_COVER
} from './buy-data-gate.js';
import { buildTopicVolRatioPlan } from './topic-vol-ratio-rules.js';

const D = '2026-11-04';

/** 造 n 只票，前 k 只有量比 / 十日涨幅 */
function rows(n, kRatio, kPct) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      name: 'S' + i,
      aucVolRatio: i < kRatio ? String(2 + i) : null,
      pct: i < kPct ? String(10 + i) : null
    });
  }
  return out;
}

/** 全部正常：72 只票、量比与十日涨幅 100%、20 日涨幅前五到齐 */
function full(over) {
  return Object.assign({
    date: D,
    rows: rows(72, 72, 72),
    range20Ready: true,
    range20Count: 5,
    range20GaveUp: false
  }, over || {});
}

describe('resolveBuyDataGate · 数据缺失禁止选股', function() {
  it('④ 一切正常 ⇒ 放行，且覆盖率统计如实带出（⛔ 不是硬编码的 0）', function() {
    const r = resolveBuyDataGate(full());
    expect(r.blocked).toBe(false);
    expect(r.items).toEqual([]);
    expect(r.shortText).toBe('');
    expect(r.stats).toEqual({ rows: 72, ratio: { n: 72, k: 72, ratio: 1 }, range10: { n: 72, k: 72, ratio: 1 } });
  });

  it('④-2 TVRB_DATA_GATE_NONE 仍是一个冻结单例（供「还没有 plan」的调用方兜底）', function() {
    expect(Object.isFrozen(TVRB_DATA_GATE_NONE)).toBe(true);
    expect(TVRB_DATA_GATE_NONE.blocked).toBe(false);
    expect(TVRB_DATA_GATE_NONE.items.length).toBe(0);
  });

  it('① 竞价量比 0% 覆盖（11-04 真实事故现场）⇒ 拦，并点名「竞价量比」+ 给出只数', function() {
    const r = resolveBuyDataGate(full({ rows: rows(72, 0, 72), range20Count: 5 }));
    expect(r.blocked).toBe(true);
    const keys = r.items.map((i) => i.key);
    expect(keys).toEqual(['auc_vol_ratio']);
    const it0 = r.items[0];
    expect(it0.label).toBe('竞价量比');
    // 用户要的「提示行」：必须写清「几只里有几只」，不能只说「缺失」
    expect(it0.stat).toBe('0 / 72 只（0%）');
    // 必须说清怎么修（盘中必然为空 / 收盘后回填 / 历史日补数）
    expect(it0.fix).toContain('猫抓');
    expect(it0.fix).toContain('16:30');
    // 结论必须明确到「今天不能选股」
    expect(r.headline).toContain('不能选股');
    // 标题栏极短文案
    expect(r.shortText).toBe('竞价量比缺失');
  });

  it('①-2 量比覆盖率刚好到阈值 ⇒ 放行（阈值本身不拦）', function() {
    const n = 100;
    const k = Math.ceil(n * TVRB_DATA_GATE_MIN_RATIO_COVER);
    const r = resolveBuyDataGate(full({ rows: rows(n, k, n) }));
    expect(r.blocked).toBe(false);
  });

  it('①-3 量比覆盖率差一只到阈值 ⇒ 拦（边界不错位）', function() {
    const n = 100;
    const k = Math.ceil(n * TVRB_DATA_GATE_MIN_RATIO_COVER) - 1;
    const r = resolveBuyDataGate(full({ rows: rows(n, k, n) }));
    expect(r.blocked).toBe(true);
    expect(r.items[0].key).toBe('auc_vol_ratio');
  });

  it('② 十日涨幅整表缺失 ⇒ 拦，并点名「十日涨幅」', function() {
    const r = resolveBuyDataGate(full({ rows: rows(72, 72, 0) }));
    expect(r.blocked).toBe(true);
    expect(r.items.map((i) => i.key)).toEqual(['range10']);
    expect(r.items[0].label).toBe('十日涨幅');
  });

  it('②-2 【关键边界】十日涨幅只有 65% 覆盖（11-04 真实值）⇒ ⛔ 绝不能拦', function() {
    // 十日涨幅天然允许个别票没有（新股 / 停牌 / 补位票）；拦它 = 看板天天空仓
    const n = 72;
    const k = Math.round(n * 0.65);
    const r = resolveBuyDataGate(full({ rows: rows(n, n, k) }));
    expect(r.blocked).toBe(false);
    expect(k / n).toBeGreaterThan(TVRB_DATA_GATE_MIN_RANGE10_COVER);
  });

  it('③ 20 日涨幅前五为空 + 已有结论 ⇒ 拦，并点名「20 日涨幅前五」', function() {
    const r = resolveBuyDataGate(full({ range20Ready: true, range20Count: 0 }));
    expect(r.blocked).toBe(true);
    expect(r.items.map((i) => i.key)).toEqual(['range20']);
    expect(r.items[0].stat).toBe('前五 0 只');
  });

  it('③-2 20 日涨幅还没结论（range20Ready=false 且未放弃）⇒ 本闸门不拦（交给 buy-settle 去等）', function() {
    const r = resolveBuyDataGate(full({ range20Ready: false, range20Count: 0, range20GaveUp: false }));
    expect(r.blocked).toBe(false);
  });

  it('③-3 上游已放弃（硬兜底放行）且仍没结论 ⇒ 按缺失处理（⛔ 不拿空榜当「今天没有龙头」）', function() {
    const r = resolveBuyDataGate(full({ range20Ready: false, range20Count: 0, range20GaveUp: true }));
    expect(r.blocked).toBe(true);
    expect(r.items.map((i) => i.key)).toEqual(['range20']);
  });

  it('多因并列时会逐条列出（⛔ 不只报第一个）', function() {
    const r = resolveBuyDataGate(full({ rows: rows(72, 0, 0), range20Ready: true, range20Count: 0 }));
    expect(r.blocked).toBe(true);
    expect(r.items.map((i) => i.key)).toEqual(['auc_vol_ratio', 'range10', 'range20']);
    expect(r.shortText).toBe('竞价量比、十日涨幅、20 日涨幅前五缺失');
  });

  it('① 名单一行都没有 ⇒ 单独报「题材名单」，⛔ 不重复报量比 / 十日涨幅', function() {
    const r = resolveBuyDataGate(full({ rows: [], range20Ready: true, range20Count: 5 }));
    expect(r.blocked).toBe(true);
    expect(r.items.map((i) => i.key)).toEqual(['pool']);
    expect(r.items[0].stat).toBe('0 只');
  });

  it('§10：空串 / 非数字一律按缺值算（⛔ 绝不折成 0 后当成「有值」）', function() {
    const r = resolveBuyDataGate(full({
      rows: [
        { name: 'A', aucVolRatio: '', pct: '  ' },
        { name: 'B', aucVolRatio: 'abc', pct: null },
        { name: 'C', aucVolRatio: null, pct: undefined }
      ]
    }));
    expect(r.blocked).toBe(true);
    expect(r.stats.ratio).toEqual({ n: 3, k: 0, ratio: 0 });
    expect(r.stats.range10).toEqual({ n: 3, k: 0, ratio: 0 });
  });

  it('数字字符串按值算（云端存的是 "2.18" 这种字符串）', function() {
    const r = resolveBuyDataGate(full({
      rows: [
        { name: 'A', aucVolRatio: '2.18', pct: '11.5' },
        { name: 'B', aucVolRatio: '0', pct: '0' }
      ]
    }));
    // 真·0 是「有值」（§10：只有缺失才是 null，0 是合法值）
    expect(r.stats.ratio).toEqual({ n: 2, k: 2, ratio: 1 });
    expect(r.blocked).toBe(false);
  });

  it('缺省 ctx（无参）⇒ 不抛异常，按「名单为空」处理', function() {
    const r = resolveBuyDataGate();
    expect(r.blocked).toBe(true);
    expect(r.items[0].key).toBe('pool');
  });
});

// ── 规则层「清空买点侧」的锁（⛔ 别删：这是 fail-closed 真正的执行点）─────────────────────
/** 与 topic-vol-ratio-rules.test.js 同一套夹具（形状必须一致，否则测的不是同一件事） */
function _member(name, opts) {
  return Object.assign({
    name: name, isYizi: false, pct: 20, aucPct: 5, aucVolRatio: 5, aucShare: null,
    volRatioDir: '', code: '000001', countable: true, inheritSold: false
  }, opts || {});
}
function _block(topic, rank, members) {
  return {
    topic: topic, rank: rank, count: members.length,
    yiziCount: members.filter(function(x) { return x.isYizi; }).length,
    members: members
  };
}
function _dragonMap(names) {
  const map = new Map();
  names.forEach(function(n, i) { map.set(n, { rank: i + 1, topic: '', groupSize: names.length, pct: 20 }); });
  return map;
}

describe('buildTopicVolRatioPlan · dataGateBlocked=true 时买点侧必须清空', function() {
  const names = ['甲', '乙', '丙', '丁', '戊'];
  const topics = [_block('AI应用', 1, names.map(function(n) { return _member(n); }))];
  const dm = _dragonMap(names);
  const off = buildTopicVolRatioPlan(topics, dm, { date: D });
  const on = buildTopicVolRatioPlan(topics, dm, { date: D, dataGateBlocked: true });

  it('夹具本身是「能选出票」的（否则下面的断言等于没测）', function() {
    expect(off.blocks.length).toBe(1);
    expect(off.blocks[0].picks.length).toBeGreaterThan(0);
    expect(off.pickCount).toBeGreaterThan(0);
  });

  it('命中缺失 ⇒ blocks / pickCount / buy 槽位 / 空仓提醒 全部清空', function() {
    expect(on.blocks).toEqual([]);
    expect(on.pickCount).toBe(0);
    expect(on.buy.heavy).toBeNull();
    expect(on.buy.light).toBeNull();
    expect(on.buy.candidates).toEqual([]);
    expect(on.buy.ebbSecond).toBeNull();
    expect(on.buyNames.size).toBe(0);
    // ⛔ 不能留一条「平均量比 < 25」的标语：没有数值时那就是编出来的结论
    expect(on.cashAlert.show).toBe(false);
  });

  it('六个「灰化容器之外」的买点槽位必须全为 null（漏一个就会漏票）', function() {
    ['ebbBuy', 'divergeBuy', 'newDragon', 'range10Backup', 'weakHuddle', 'catchUp']
      .forEach(function(k) {
        expect(on[k]).toBeNull();
      });
  });

  it('⛔ 不清「事实 / 卖点侧」：notes 与 sell 必须保留（排障线索 + 卖出不受影响）', function() {
    // notes 是「为什么某个题材没入选」的唯一线索 —— 数据缺失日更需要它
    expect(Array.isArray(on.notes)).toBe(true);
    expect(Array.isArray(on.sell)).toBe(true);
  });
});
