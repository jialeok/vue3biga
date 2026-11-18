// market-dragon-top5-label.test.js — 「市龙一…市龙五」名次标签
//
// 用户 2026-11-18 原话：
//   「单独打开30天涨幅，按30天涨幅排名前五股票后面分别标上，市龙一，市龙二……市龙五，只标这五只，
//     就是全市场的龙一（我自认为的），在行情非常差时，市龙一是比20日总龙一要强的，你先要明白这个概念。
//     现在要先打上标签。」
//
// 锁住四类语义（改这里之前先想清楚会影响到谁）：
//   ① 文案固定 市龙一…市龙五，越界不出「市龙6」；
//   ② 缺 30 日涨幅 / 非主板 ⇒ 跳过**且不占名次**（§10 宁缺勿错，名次顺延给下一只有资格的主板票）；
//   ③ 没选中的行必须**显式**清成 0/''（items 会经增量视图缓存复用，残留会把「市龙三」串到别的视图）；
//   ④ 只在「30日涨幅」toggle 下赋值（其它 toggle 一律不标），且顺序必须早于视图冻结。

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  MARKET_DRAGON_TOP_N,
  MARKET_DRAGON_LABELS,
  marketDragonLabel,
  assignMarketDragonRanks
} from './market-dragon-top5-label.js';

const ROOT = process.cwd();
const VIEW = fs.readFileSync(path.join(ROOT, 'src/logic/auction/view-helpers.js'), 'utf8');
const ROW = fs.readFileSync(path.join(ROOT, 'src/components/AuctionEntityRow.vue'), 'utf8');
const TABLE = fs.readFileSync(path.join(ROOT, 'src/components/AuctionBoardTable.vue'), 'utf8');
const norm = (s) => s.replace(/\s+/g, ' ');

describe('[MARKET-DRAGON] 文案与越界', () => {
  it('前五文案逐字等于用户说法', () => {
    expect(MARKET_DRAGON_TOP_N).toBe(5);
    expect(MARKET_DRAGON_LABELS).toEqual(['市龙一', '市龙二', '市龙三', '市龙四', '市龙五']);
  });

  it('marketDragonLabel：1..5 正常，0 / 6 / NaN / null ⇒ 空串（⛔ 不出「市龙6」）', () => {
    expect(marketDragonLabel(1)).toBe('市龙一');
    expect(marketDragonLabel(5)).toBe('市龙五');
    expect(marketDragonLabel(0)).toBe('');
    expect(marketDragonLabel(6)).toBe('');
    expect(marketDragonLabel(NaN)).toBe('');
    expect(marketDragonLabel(null)).toBe('');
    expect(marketDragonLabel(undefined)).toBe('');
  });
});

describe('[MARKET-DRAGON] 打名次：按当前顺序，缺值与非主板不占名额', () => {
  const row = (stock, pct, code) => ({ stock, code, rangePct30: pct });

  it('按顺序给前五只打标，第 6 只不标', () => {
    const items = [
      row('A', 140.9, '600001'), row('B', 126.9, '000002'), row('C', 84.7, '600003'),
      row('D', 83.7, '000004'), row('E', 76.3, '600005'), row('F', 70.0, '600006')
    ];
    expect(assignMarketDragonRanks(items, 5)).toBe(5);
    expect(items.map((x) => x.marketDragonLabel)).toEqual(['市龙一', '市龙二', '市龙三', '市龙四', '市龙五', '']);
    expect(items.map((x) => x.marketDragonRank)).toEqual([1, 2, 3, 4, 5, 0]);
  });

  it('★ 中间一只判不出（null）⇒ 跳过且【不占名额】，后面那只能拿到市龙二', () => {
    const items = [row('A', 100, '600001'), row('B', null, '600002'), row('C', 90, '600003')];
    assignMarketDragonRanks(items, 5);
    expect(items.map((x) => x.marketDragonLabel)).toEqual(['市龙一', '', '市龙二']);
  });

  it('★ 创业板 / 科创板 / 北交所不占名额，名次顺延给下一只主板', () => {
    const items = [
      row('创业', 200, '300001'),
      row('科创', 190, '688001'),
      row('北交', 180, '830001'),
      row('主板甲', 170, '600001'),
      row('主板乙', 160, '000002')
    ];
    assignMarketDragonRanks(items, 5);
    expect(items.map((x) => x.marketDragonLabel)).toEqual(['', '', '', '市龙一', '市龙二']);
  });

  it('代码缺失 = 未知板块 ⇒ 有资格（§10 判不出 ≠ 判出非主板）', () => {
    const items = [row('无码', 100, ''), row('无码2', 90, undefined)];
    assignMarketDragonRanks(items, 5);
    expect(items.map((x) => x.marketDragonLabel)).toEqual(['市龙一', '市龙二']);
  });

  it('★ 没选中的行必须显式清零（防止增量视图缓存复用把旧名次串到别的视图）', () => {
    const items = [row('A', null, '600001'), row('B', 50, '600002')];
    items[0].marketDragonRank = 3;
    items[0].marketDragonLabel = '市龙三';       // 模拟上一次视图残留
    assignMarketDragonRanks(items, 5);
    expect(items[0].marketDragonRank).toBe(0);
    expect(items[0].marketDragonLabel).toBe('');
    expect(items[1].marketDragonLabel).toBe('市龙一');
  });

  it('非法 topN ⇒ 回落默认 5（⛔ 不能变成「全部打标」）', () => {
    const items = Array.from({ length: 7 }, (_, i) => row('S' + i, 100 - i, '60000' + i));
    expect(assignMarketDragonRanks(items, 0)).toBe(5);
    expect(items[5].marketDragonLabel).toBe('');
    expect(assignMarketDragonRanks(items, NaN)).toBe(5);
  });

  it('空数组 / null 不炸', () => {
    expect(assignMarketDragonRanks([], 5)).toBe(0);
    expect(assignMarketDragonRanks(null, 5)).toBe(0);
  });
});

describe('[MARKET-DRAGON] 接线锁：只在 30日涨幅 toggle 下赋值 + 模板/指纹都要带上', () => {
  it('view-helpers：byRangePct30 打开且非题材单独模式才打标', () => {
    expect(norm(VIEW)).toContain(
      'if (sortState.byRangePct30 && !topicOnlyMode) { assignMarketDragonRanks(items, MARKET_DRAGON_TOP_N); }'
    );
  });

  it('view-helpers：行对象必须有默认值 0/空串（否则残留名次会串视图）', () => {
    expect(norm(VIEW)).toContain("marketDragonRank: 0, marketDragonLabel: '',");
  });

  it('AuctionEntityRow：模板按 marketDragonRank > 0 渲染，且文案取自 marketDragonLabel', () => {
    expect(norm(ROW)).toContain('v-if="item.marketDragonRank > 0"');
    expect(norm(ROW)).toContain('class="auction-marketdragon-tag"');
    expect(norm(ROW)).toContain('{{ item.marketDragonLabel }}');
  });

  it('★ AuctionBoardTable：名次必须进 v-memo 指纹（名次是异步到货的，漏了就永远不出现）', () => {
    expect(norm(TABLE)).toContain('item.marketDragonRank,');
  });
});
