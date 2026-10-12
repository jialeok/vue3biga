// auc-sane-gate.test.js — worker「竞价涨幅物理越界闸门」回归测试
//
// 【为什么必须有这个测试 / 2026-10-12 事故】
//   numcat daily_auc 偶尔把「昨收」取错一个交易日 ⇒ 竞价涨幅被整体放大（时代万恒 真值 +6.12%
//   被写成 +16.74%，主板涨停 10%）。旧 worker 对 auc_pct_chg **一个字都不校验**，
//   直接 `aucPctChgStr = changePctStr` 写库 ⇒ 前端按「≥ 涨停幅度即一字」判成
//   【竞价一字·买不进】⇒ 真龙一被跳过、龙二顶替（用户实际损失）。
//
//   这类事故【失败得非常安静】：写入成功、没有任何报错，只是某几只票的某个字段是错的，
//   要到第二天用户看图才发现。⇒ 用测试把两条不变量钉死：
//     ① 越界值绝不写进 auc_pct_chg（留空，交给同花顺快照补真值）；
//     ② 合法值一个都不能被误伤（尤其 10.03% / 10.04% 这类「四舍五入的合法一字」）。
//
//   如果哪天有人把闸门删掉、或把上界改窄（误伤真实一字），下面用例会立刻失败。
import { describe, it, expect } from 'vitest';
import { parseNumcatToMetrics } from './morning-workflow.js';

const TODAY = '2026-10-12';
// numcat daily_auc 的返回形状（fields + items 二维数组）——与 numcat-api.js 的 fields 顺序一致
const FIELDS = ['symbol', 'name', 'tradedate', 'auc_vol', 'auc_pct_chg', 'auc_to_pre_vol_pct', 'um_vol', 'open_bid_pct', 'auc_vol_ratio', 'auc_turnover'];
const CONSTITUENTS = [
  { name: '时代万恒', code: '600241' },
  { name: '紫竹高科', code: '002058' },
  { name: '三柏硕', code: '001300' },
  { name: '九阳股份', code: '002242' },
  { name: '领湃科技', code: '300530' }
];
// [code, name, date, auc_vol, auc_pct_chg, to_pre_vol, um, obp, avr, atr]
const ITEMS = [
  ['600241', '时代万恒', '20261012', 100000, 16.74, 1.2, null, null, null, null], // ★ 越界坏值（真值 +6.12）
  ['002058', '紫竹高科', '20261012', 90000, -3.85, 1.1, null, null, null, null],  // 正常值，不能被误伤
  ['001300', '三柏硕', '20261012', 22100, 10.03, 1.0, null, null, null, null],    // 真实一字（四舍五入），必须保留
  ['002242', '九阳股份', '20261012', 50000, 10.04, 1.0, null, null, null, null],  // 真实一字，必须保留
  ['300530', '领湃科技', '20261012', 30000, 17.91, 1.0, null, null, null, null]   // 创业板 20% 板内，不算越界
];

function parse() {
  const logs = [];
  const out = parseNumcatToMetrics(ITEMS, FIELDS, CONSTITUENTS, logs, TODAY);
  return { out, logs };
}

describe('parseNumcatToMetrics × 竞价涨幅越界闸门', () => {
  it('越界值被丢弃：auc_pct_chg 留空，且登记进 outOfRange（§10 不静默丢）', () => {
    const { out, logs } = parse();
    const rows = out.metricsByDate[TODAY];
    const byName = new Map(rows.map(r => [r.stock, r]));
    expect(byName.get('时代万恒').auc_pct_chg).toBe('');       // ★ 核心：坏值不落库
    expect(out.outOfRange.map(x => x.name)).toEqual(['时代万恒']);
    expect(out.outOfRange[0].limit).toBe(10);                  // 主板涨停幅度，日志要能一眼看出「错多少」
    expect(logs.some(l => l.indexOf('[AUC-SANE]') >= 0 && l.indexOf('时代万恒') >= 0)).toBe(true);
  });

  it('⛔ 合法值一个都不能误伤（含 10.03% / 10.04% 的真实一字）', () => {
    const { out } = parse();
    const rows = out.metricsByDate[TODAY];
    const byName = new Map(rows.map(r => [r.stock, r]));
    expect(byName.get('紫竹高科').auc_pct_chg).toBe('-3.85%');
    expect(byName.get('三柏硕').auc_pct_chg).toBe('+10.03%');
    expect(byName.get('九阳股份').auc_pct_chg).toBe('+10.04%');
    expect(byName.get('领湃科技').auc_pct_chg).toBe('+17.91%');
    expect(out.outOfRange.length).toBe(1);
  });

  it('change_pct 不受闸门影响（今日 = 竞价副本，16:00 由 close-workflow 覆盖）', () => {
    const { out } = parse();
    const rows = out.metricsByDate[TODAY];
    expect(rows.find(r => r.stock === '时代万恒').change_pct).toBe('+16.74%');
  });

  it('上游数据干净时零越界（常态：闸门不发生任何作用）', () => {
    const clean = ITEMS.map(it => it.slice());
    clean[0][4] = 6.12;   // 时代万恒 → 真值
    const out = parseNumcatToMetrics(clean, FIELDS, CONSTITUENTS, [], TODAY);
    expect(out.outOfRange.length).toBe(0);
    expect(out.metricsByDate[TODAY].find(r => r.stock === '时代万恒').auc_pct_chg).toBe('+6.12%');
  });
});
