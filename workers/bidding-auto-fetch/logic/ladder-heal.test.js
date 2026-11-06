// ladder-heal.test.js — [P0 2026-11-06] 883410 名单源降级补救的纯函数回归锁
//
// 锁住三件「常识级」事实：
//   ① 真正的 883410 名单必须写 source='worker' / obs_auto_added=false / code 合法、去重；
//   ② 兜底名单绝不把观察组壳行、20日补位票、手动行、无 code 行当正式成员；
//   ③ 9:25 名单锁定窗口边界与 morning-workflow 一致。
import { describe, it, expect } from 'vitest';
import {
  MIN_LADDER_ROWS, MIN_FALLBACK_ROWS,
  isMorningWindow, buildLadderWatchlistRows, pickFallbackWatchlistRows
} from './ladder-heal.js';

const TODAY = '2026-11-06';
const NOW = '2026-11-06T01:25:10.000Z';

// beijingNow() 返回的 Date 用 getUTCHours() 直接读出北京小时（见 morning-workflow 同款写法），
// 所以这里构造的 Date 的 UTC 小时就应当是「北京小时」，不要再减 8。
function bj(h, m) {
  return new Date(Date.UTC(2026, 10, 6, h, m, 0));
}

describe('MIN 常量（上游残缺闸门）', () => {
  it('真实名单门槛不低于 30 只，兜底门槛不低于 20 只', () => {
    expect(MIN_LADDER_ROWS).toBeGreaterThanOrEqual(30);
    expect(MIN_FALLBACK_ROWS).toBeGreaterThanOrEqual(20);
  });
});

describe('isMorningWindow（9:25 名单锁定）', () => {
  it('09:24 不算、09:25 与 09:40 算、09:41 不算', () => {
    expect(isMorningWindow(bj(9, 24))).toBe(false);
    expect(isMorningWindow(bj(9, 25))).toBe(true);
    expect(isMorningWindow(bj(9, 40))).toBe(true);
    expect(isMorningWindow(bj(9, 41))).toBe(false);
    expect(isMorningWindow(bj(16, 0))).toBe(false);
  });
});

describe('buildLadderWatchlistRows（真实名单）', () => {
  it('过滤无名 / 非法 code，按 name 去重，行形状与 9:25 worker 落库一致', () => {
    const rows = buildLadderWatchlistRows([
      { name: '大连友谊', code: '000679' },
      { name: '大连友谊', code: '000679' },
      { name: '缺码票', code: '' },
      { name: '坏码票', code: 'ABC' },
      { name: '', code: '600000' },
      null,
      { name: '大千生态', code: '603955' }
    ], TODAY, NOW, 'worker');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      date: TODAY, stock: '大连友谊', code: '000679',
      source: 'worker', obs_auto_added: false,
      updated_at: NOW, updated_by: 'auto-fetch-worker'
    });
    expect(rows[1].stock).toBe('大千生态');
  });

  it('空输入 ⇒ 空数组（绝不凭空造行）', () => {
    expect(buildLadderWatchlistRows([], TODAY, NOW, 'worker')).toEqual([]);
    expect(buildLadderWatchlistRows(null, TODAY, NOW, 'worker')).toEqual([]);
  });
});

describe('pickFallbackWatchlistRows（降级兜底）', () => {
  const formal = n => ({ name: '票' + n, code: String(600000 + n), obs_auto_added: false, source: 'worker' });

  it('排除观察组壳行 / range20 补位票 / manual 手动行 / 无 code 行', () => {
    const prev = [
      formal(1),
      { name: '观察壳', code: '600001', obs_auto_added: true, source: 'manual' },
      { name: '补位票', code: '600002', obs_auto_added: false, source: 'range20' },
      { name: '手动票', code: '600003', obs_auto_added: false, source: 'manual' },
      { name: '影子票', code: '600004', obs_auto_added: false, source: 'shadow' },
      { name: '无码票', code: '', obs_auto_added: false, source: 'worker' },
      formal(2)
    ];
    const rows = pickFallbackWatchlistRows(prev, TODAY, NOW, 2);
    expect(rows.map(r => r.stock)).toEqual(['票1', '票2']);
    rows.forEach(r => {
      expect(r.source).toBe('worker-fallback');
      expect(r.obs_auto_added).toBe(false);
      expect(r.date).toBe(TODAY);
      expect(r.updated_by).toBe('auto-fetch-worker');
    });
  });

  it('正式成员不足门槛 ⇒ 返回 []（宁可不写，也不写残缺名单）', () => {
    expect(pickFallbackWatchlistRows([formal(1), formal(2)], TODAY, NOW, 20)).toEqual([]);
  });

  it('前一日名单为空 / 读取结果为空 ⇒ 返回 []（§10 读失败≠空数据，不伪造）', () => {
    expect(pickFallbackWatchlistRows([], TODAY, NOW, 1)).toEqual([]);
    expect(pickFallbackWatchlistRows(null, TODAY, NOW, 1)).toEqual([]);
  });

  it('按 name 去重，且不会把上一轮兜底行（worker-fallback）排除掉', () => {
    const prev = [
      { name: '票1', code: '600001', obs_auto_added: false, source: 'worker-fallback' },
      { name: '票1', code: '600001', obs_auto_added: false, source: 'worker' }
    ];
    expect(pickFallbackWatchlistRows(prev, TODAY, NOW, 1)).toHaveLength(1);
  });
});
