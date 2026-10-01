import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { state } from '../app-state.js';
import { getAuctionStockHistory } from './rules.js';

// ===== 「竞价量比 近5日」趋势序列 回归测试（2026-10-01 新功能）=====
//
// 背景：早盘竞价看板展开面板新增「竞价量比 近5日」曲线（用户口径：放在昨日成交量与竞价涨幅之间）。
// 数据来自 market_metrics.auc_vol_ratio，云端存的是【字符串】（实测如 "2.18" / "13.01"）。
//
// 本测试锁定 4 件事，任何一条被打回都会让趋势图出错：
//   ① 窗口 = 5 个交易日，且按【交易日】回退（休市日不占位）、返回【正序 早→晚】；
//   ② aucVolRatio 必须是【数字】—— TrendChart 要对它做 toFixed(2)，字符串会直接抛 TypeError；
//   ③ 缺值 / 空串 / 非数字 一律 null，⛔ 绝不用 0 冒充「量比很小」（§10）；
//   ④ '0' 是【有效值】，必须保留为数字 0，不能因为 falsy 被吞成 null。
//
// 桩数据取自云端实测形态（9/23~9/30 六个自然日里，9/25 为中秋休市）。

const _saved = {};

beforeEach(() => {
  _saved.cache = state._auctionMemCache;
  _saved.hotFull = state._hotFullRowCache;
  _saved.hotTrends = state._hotTrendsCache;
  _saved.allData = state.allData;
  _saved.rebuildAt = state._allDataLastRebuildAt;
  state._hotFullRowCache = {};
  state._hotTrendsCache = {};
  // 【交易日闸门】getAuctionStockHistory → getPreviousTradingDay → getHolidays → loadAllData；
  // 而 vitest 跑在 node 环境（没有 localStorage），loadAllData 在 allData 为空时会读 localStorage
  // ⇒ 会抛 ReferenceError。这里【预置 allData + 500ms 时间戳】让 loadAllData 走短路分支直接返回，
  // 完全不触碰 localStorage，也绕开与本测试无关的 _migrateFromV41 迁移路径。
  // holidays 显式声明 2026-09-25（中秋休市）⇒ 窗口按【真实交易日】回退（9/23、9/24、9/28、9/29、9/30）。
  state.allData = { holidays: ['2026-09-25'] };
  state._allDataLastRebuildAt = Date.now();
});

afterEach(() => {
  state._auctionMemCache = _saved.cache;
  state._hotFullRowCache = _saved.hotFull;
  state._hotTrendsCache = _saved.hotTrends;
  state.allData = _saved.allData;
  state._allDataLastRebuildAt = _saved.rebuildAt;
});

/** 铺一份「5 个交易日」的缓存：含休市日 9/25（应为空，不得占位） */
function stubCache(ratioByDate) {
  const base = {
    volume: 100,
    yest_volume: 90,
    change_pct: '+3.25%',
    auc_pct_chg: '+3.25%'
  };
  const cache = {};
  ['2026-09-23', '2026-09-24', '2026-09-25', '2026-09-28', '2026-09-29', '2026-09-30'].forEach(d => {
    const row = { stock: '上工申贝', ...base };
    if (Object.prototype.hasOwnProperty.call(ratioByDate, d)) {
      const v = ratioByDate[d];
      if (v !== '__MISSING__') row.auc_vol_ratio = v;
    }
    cache[d] = [row];
  });
  // 9/25 休市：即使误留行，也不该出现在 5 日窗口里（窗口按交易日回退，天然跳过）
  state._auctionMemCache = cache;
}

describe('getAuctionStockHistory —— 竞价量比序列', () => {
  it('① 窗口 = 5 个【交易日】、跳过休市日、正序 早→晚', () => {
    stubCache({
      '2026-09-23': '0.61',
      '2026-09-24': '1.02',
      '2026-09-25': '9.99', // 休市日的脏值：绝不能被算进窗口
      '2026-09-28': '2.87',
      '2026-09-29': '1.94',
      '2026-09-30': '2.18'
    });
    const days = getAuctionStockHistory('上工申贝', '2026-09-30', 5, 'auction');
    expect(days.length).toBe(5);
    expect(days.map(d => d.date)).toEqual([
      '2026-09-23', '2026-09-24', '2026-09-28', '2026-09-29', '2026-09-30'
    ]);
    expect(days.some(d => d.date === '2026-09-25')).toBe(false);
  });

  it('② aucVolRatio 是【数字】而不是字符串（TrendChart 要 toFixed(2)）', () => {
    stubCache({
      '2026-09-23': '0.61', '2026-09-24': '1.02', '2026-09-28': '2.87',
      '2026-09-29': '1.94', '2026-09-30': '2.18'
    });
    const days = getAuctionStockHistory('上工申贝', '2026-09-30', 5, 'auction');
    days.forEach(d => {
      expect(typeof d.aucVolRatio).toBe('number');
      expect(Number.isNaN(d.aucVolRatio)).toBe(false);
    });
    expect(days[4].aucVolRatio).toBe(2.18);
    // 证明它真的能参与趋势图渲染（字符串在这里会 TypeError）
    expect(days[4].aucVolRatio.toFixed(2)).toBe('2.18');
  });

  it('③ 缺值 / 空串 / 非数字 ⇒ null（绝不用 0 冒充「量比很小」）', () => {
    stubCache({
      '2026-09-23': '__MISSING__', // 字段不存在
      '2026-09-24': '',            // 空串
      '2026-09-28': '  ',          // 纯空白
      '2026-09-29': '--',          // 占位符
      '2026-09-30': 'N/A'          // 非数字
    });
    const days = getAuctionStockHistory('上工申贝', '2026-09-30', 5, 'auction');
    expect(days.map(d => d.aucVolRatio)).toEqual([null, null, null, null, null]);
  });

  it("④ '0' 是有效值 ⇒ 保留为数字 0（不得因为 falsy 被吞）", () => {
    stubCache({
      '2026-09-23': '0', '2026-09-24': '0.00', '2026-09-28': null,
      '2026-09-29': 0, '2026-09-30': '2.18'
    });
    const days = getAuctionStockHistory('上工申贝', '2026-09-30', 5, 'auction');
    expect(days[0].aucVolRatio).toBe(0);
    expect(days[1].aucVolRatio).toBe(0);
    expect(days[2].aucVolRatio).toBe(null);
    expect(days[3].aucVolRatio).toBe(0);
  });

  it('⑤ 不破坏既有四列（volume / yestVolume / changePct / aucPctChg 仍在且仍是数字）', () => {
    stubCache({ '2026-09-30': '2.18' });
    const days = getAuctionStockHistory('上工申贝', '2026-09-30', 5, 'auction');
    const last = days[days.length - 1];
    expect(last.volume).toBe(100);
    expect(last.yestVolume).toBe(90);
    expect(last.changePct).toBe(3.25);
    expect(last.aucPctChg).toBe(3.25);
    expect(Object.prototype.hasOwnProperty.call(last, 'aucVolRatio')).toBe(true);
  });

  it('⑥ 该股在任何一天都不存在 ⇒ 5 天全 null，且不抛错', () => {
    stubCache({ '2026-09-30': '2.18' });
    const days = getAuctionStockHistory('不存在的股票', '2026-09-30', 5, 'auction');
    expect(days.length).toBe(5);
    expect(days.every(d => d.aucVolRatio === null)).toBe(true);
  });
});
