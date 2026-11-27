// range30-board-auc.test.js — 「30日涨幅 toggle + 竞价口径 toggle 同时打开 ⇒ 必须按【竞价口径】排序」
//
// ══════════════════════════════════════════════════════════════════════════════════════
// 用户 2026-11-18 原话
//   「你再检查下我同时打开竞价口径toggle和30日涨幅toggle，排序有没有按照竞价口径toggle排序，
//     我希望按照竞价口径toggle涨幅由高到低排序」
// ══════════════════════════════════════════════════════════════════════════════════════
// 这个链路有【三个必须同时成立的环节】，缺任何一个都会表现成「打开了却没按竞价口径排」：
//   ① `view-helpers.js#_range30MapFor()`：byAuctionLeg 开着时必须返回 `getAuctionLegRange30`，
//      而不是 `getRange30Pct`（收盘口径）—— 这是【唯一分支点】；
//   ② `view-helpers` 必须把同一个函数交给 `buildRenderOrder({ rangeMapOf30 })`（排序键）；
//   ③ `buildRenderOrder` 的 `byRangePct30` 分支必须真的用 `rangeMapOf30()` 的返回值排序。
// ①② 是接线（会被日后重构悄悄改坏），本文件用**源码静态锁**钉住；
// ③ 用**2026-11-18 真实库数据**跑纯函数，证明两套口径给出的顺序确实不同（不是「看起来差不多」）。
//
// ⚠️ 真实数据（下面是同一天、同一批票的两个口径值，取自 stock_range30_pct + market_metrics 实算）：
//   收盘口径：文投控股 84.76 / 龙江交通 76.39 / 北纬科技 44.34 / 华东重机 42.55 /
//             日出东方 39.34 / 凯撒文化 35.60 / 广百股份 32.30 / 大东方 21.39
//   竞价口径：文投控股 84.76 / 龙江交通 66.68 / 凯撒文化 46.60 / 华东重机 42.55 /
//             日出东方 39.34 / 北纬科技 39.16 / 广百股份 32.30 / 大东方 23.96
//   ⇒ 凯撒文化 6→3、北纬科技 3→6、大东方 21.39→23.96。前两名不变是巧合（两只都强势），
//     所以只看榜首会误判成「没按竞价口径排」——必须看中段第 3~6 名。

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { buildRenderOrder } from './view-sort-order.js';
import { buildAuctionLegPctMap } from './auction-leg-pct.js';

const ROOT = process.cwd();
const VIEW_HELPERS = fs.readFileSync(path.join(ROOT, 'src/logic/auction/view-helpers.js'), 'utf8');
const VIEW_SORT = fs.readFileSync(path.join(ROOT, 'src/logic/auction/view-sort-order.js'), 'utf8');
const R30_AUCLEG = fs.readFileSync(path.join(ROOT, 'src/logic/auction/range30-auction-leg.js'), 'utf8');

const norm = (s) => s.replace(/\s+/g, ' ');

// ── 11-18 真实数据（当天正式名单里的前八名，两种口径逐字抄录）──
const CLOSE = [
  ['文投控股', 84.76], ['龙江交通', 76.39], ['北纬科技', 44.34], ['华东重机', 42.55],
  ['日出东方', 39.34], ['凯撒文化', 35.60], ['广百股份', 32.30], ['大东方', 21.39]
];
const AUC = [
  ['文投控股', 84.76], ['龙江交通', 66.68], ['凯撒文化', 46.60], ['华东重机', 42.55],
  ['日出东方', 39.34], ['北纬科技', 39.16], ['广百股份', 32.30], ['大东方', 23.96]
];

function mkMap(arr) {
  const m = new Map();
  arr.forEach((r) => m.set(r[0], { pct: r[1], days: 30 }));
  return m;
}
function mkRows(arr) {
  return arr.map((r) => ({ stock: r[0] }));
}
const ROWS = mkRows(CLOSE);
const IDX = ROWS.map((_, i) => i);

function sortWith(map) {
  const out = buildRenderOrder({
    renderOrder: IDX,
    renderList: ROWS,
    sortState: { byJingYest: false, byRangePct: false, byRangePct20: false, byRangePct30: true, byAuctionLeg: true, byTopic: false },
    jingYestHighlightSet: new Set(),
    parallelStocksToday: new Set(),
    rangeMapOf10: function() { throw new Error('不该读十日'); },
    rangeMapOf20: function() { throw new Error('不该读 20 日'); },
    rangeMapOf30: function() { return map; },
    auctionPctOf: function() { return null; }
  });
  return out.map((i) => ROWS[i].stock);
}

describe('[R30-AUCLEG] 接线静态锁 —— 竞价口径开着时排序键必须是竞价那份 Map', () => {
  it('① `_range30MapFor` 必须按 byAuctionLeg 分支（⛔ 不许写死收盘口径）', () => {
    expect(norm(VIEW_HELPERS)).toContain(
      'const _range30MapFor = function() { return sortState.byAuctionLeg ? getAuctionLegRange30(currentDate) : getRange30Pct(currentDate); };'
    );
    // 与十日 / 20日 必须是【同一个分支形状】（三处口径不能各写一套）
    expect(norm(VIEW_HELPERS)).toContain(
      'const _range20MapFor = function() { return sortState.byAuctionLeg ? getAuctionLegRange20(currentDate) : getRange20Pct(currentDate); };'
    );
  });

  it('② 排序必须吃 `rangeMapOf30: _range30MapFor`（同一个函数，⛔ 不许另给一份 Map）', () => {
    expect(norm(VIEW_HELPERS)).toContain('rangeMapOf30: _range30MapFor');
    // 行上数值也必须取同一份（§6：排序键与显示值一旦分叉就会出现「排序和数字对不上」）
    expect(norm(VIEW_HELPERS)).toContain('rangePct30Map: sortState.byRangePct30 ? _range30MapFor() : null');
  });

  it('③ `byRangePct30` 分支必须真的用 rangeMapOf30() 排序', () => {
    expect(norm(VIEW_SORT)).toContain('renderOrder = _byRangePct(renderOrder, renderList, o.rangeMapOf30());');
  });

  it('④ 竞价口径的 30 日 Map 必须由 close 口径反解而来（⛔ 不许另写第二套换算）', () => {
    expect(R30_AUCLEG).toContain('buildAuctionLegPctMap(closeMap, metricRows)');
    // ★★ [RULE-35-SRC 2026-11-19] 数据源选择已抽成纯函数 `pickCloseRange30Source`（可单测）。
    //   ⚠️ 旧断言锁的是 `const closeMap = published || await readRange30Rows(date);` ——
    //   那一行本身就是 11-17/11-18「永远判不出」的根因：`getRange30Pct` 返回的**空 Map 也是真值**
    //   ⇒ 永远挡住结果表 ⇒ 0 只入榜 ⇒ ready=false。⛔ 别把这个形状锁回来。
    expect(R30_AUCLEG).toContain('const closeMap = pickCloseRange30Source(rows, published);');
    // §10：两份都没有 ⇒ 必须判不出（⛔ 不许拿空 Map 冒充「这天没有 30 日龙头」）
    expect(R30_AUCLEG).toContain('if (!closeMap) return null;');
  });
});

describe('[R30-AUCLEG] 11-18 真实数据：两套口径的排序确实不同（用户能看见的那一步）', () => {
  it('收盘口径顺序 = 用户未开竞价口径时看到的那个次序', () => {
    expect(sortWith(mkMap(CLOSE))).toEqual(
      ['文投控股', '龙江交通', '北纬科技', '华东重机', '日出东方', '凯撒文化', '广百股份', '大东方']
    );
  });

  it('★ 竞价口径顺序：凯撒文化 6→3、北纬科技 3→6（前两名不变，必须看中段）', () => {
    const got = sortWith(mkMap(AUC));
    expect(got).toEqual(
      ['文投控股', '龙江交通', '凯撒文化', '华东重机', '日出东方', '北纬科技', '广百股份', '大东方']
    );
    // 反证：两套口径绝不能给出同一个顺序（否则说明 Map 没换，用户在屏幕上就「看不到变化」）
    expect(got).not.toEqual(sortWith(mkMap(CLOSE)));
  });

  it('缺数据置底（§10）：竞价那份缺了某只 ⇒ 它排最后，⛔ 不当 0 参与', () => {
    const partial = mkMap(AUC.slice(0, 6));   // 少了 广百股份 / 大东方
    expect(sortWith(partial)).toEqual(
      ['文投控股', '龙江交通', '凯撒文化', '华东重机', '日出东方', '北纬科技', '广百股份', '大东方']
    );
  });
});

describe('[R30-AUCLEG] 反解算式（同花顺/库内两条腿 → 竞价口径）', () => {
  it('新华传媒 600825：收盘 30日 +6.28% 反解成竞价口径 +0.48%', () => {
    // 真实数据：close(09-30)=10.35 / close(11-18)=11.00 / auc_pct_chg=-2.07% / change_pct=+3.58%
    // 手工核对：11.00/10.35−1 = +6.28%；把今天那根腿换回竞价价 10.40 ⇒ 10.40/10.35−1 = +0.483%
    const out = buildAuctionLegPctMap(
      new Map([['新华传媒', { pct: 6.28, days: 27 }]]),
      [{ stock: '新华传媒', auc_pct_chg: '-2.07%', change_pct: '+3.58%' }]
    );
    expect(out.get('新华传媒').pct).toBeCloseTo(0.483, 2);
    // 腿数原样带过来（悬停里要显示 n/30）
    expect(out.get('新华传媒').days).toBe(27);
  });

  it('§10：指标行缺失 ⇒ 原样返回收盘口径（既有行为，⛔ 不补 0、不抛错）', () => {
    const out = buildAuctionLegPctMap(
      new Map([['某票', { pct: 12.3, days: 30 }]]),
      []
    );
    expect(out.get('某票').pct).toBe(12.3);
  });

  it('§10：收盘口径行整份不可用 ⇒ null（⛔ 不返回空 Map 冒充「这天没有数据」）', () => {
    expect(buildAuctionLegPctMap(null, [])).toBe(null);
  });
});
