// note-edit-target.test.js —— 【竞价量双击 → 备注编辑空白 回归】
//
// 2026-11-18 用户报障（逐字）：
//   「今天11月18日早盘竞价看板灰色行：锋龙股份（龙头组），20日强势补位三只也是灰色行，
//     东方海洋，阳光照明，光洋股份，这四只，在对应竞价量列双击打开note编辑时，
//     没有题材和涨幅显示，里面的编辑框是空白，但是对应点击昨日成交量列却显示涨幅和题材toast」
//
// 实证根因：这四只在 11-18 **只有 market_metrics(scope='auction')、没有 auction_watchlist 行**
//   ⇒ 被龙头组 / 20日补位以**壳行**注入视图；壳行上的 `item.index` 是 renderList 下标
//     （`renderList = 正式列表.concat(注入行)`），必然 ≥ 正式列表长度
//   ⇒ 旧实现 `getTodayGroupList('auction')[index]` 只含正式成员，取到 undefined
//   ⇒ `getDisplayNote(undefined)` 恒为 ''（编辑框空白），且保存路径 `if (!item) return` 静默空转。
//
// 本用例把不变量固化：**只要股票名在，就必须解析出一行可显示的载体**（⛔ 不因下标越界返回 null）。
import { describe, it, expect } from 'vitest';
import { resolveNoteEditTarget } from './note-edit-target.js';

// ── 11-18 真实数据的形状缩样 ────────────────────────────────────────────────
// 正式成员（auction_watchlist 有行）—— 这里只放 3 只，模拟「正式列表很短」
const FORMAL = [
  { stock: '甲股票', changePct: '1.20', note: '1.20%(机器人)' },
  { stock: '乙股票', changePct: '-0.50', note: '-0.50%(半导体)' },
  { stock: '丙股票', changePct: '3.00', note: '3.00%(AI应用)' }
];

// 内存行（getGroupData 合并后的：正式成员 + 影子行）
const DAY_ROWS = FORMAL.concat([
  // ★ 四只影子行：只有 market_metrics ⇒ 没有 note，只有 changePct
  { stock: '锋龙股份', changePct: '-2.00', note: '' },
  { stock: '东方海洋', changePct: '-6.04', note: '' },
  { stock: '阳光照明', changePct: '-9.82', note: '' },
  { stock: '光洋股份', changePct: '2.29', note: '' }
]);

// 视图行（renderList = 正式列表 + 注入壳行）—— 注入行的 index 从 3 开始越界
const VIEW_DRAGON = { stock: '锋龙股份', changePct: '--', index: 3, group: 'dragon' };
const VIEW_R20_A = { stock: '东方海洋', changePct: '--', index: 4, group: 'range20' };
const VIEW_R20_B = { stock: '阳光照明', changePct: '--', index: 5, group: 'range20' };
const VIEW_R20_C = { stock: '光洋股份', changePct: '--', index: 6, group: 'range20' };

describe('resolveNoteEditTarget —— 影子行 / 注入行的备注编辑', () => {
  it('【核心回归】注入行下标越界，仍能按名字取到带涨幅的内存行', () => {
    // 旧路径对照：按下标取必然 undefined（这就是「编辑框空白」的来源）
    expect(FORMAL[VIEW_DRAGON.index]).toBeUndefined();

    const t = resolveNoteEditTarget({ target: VIEW_DRAGON, formalList: FORMAL, dayRows: DAY_ROWS });
    expect(t.reason).toBe('ok');
    expect(t.name).toBe('锋龙股份');
    expect(t.display).toBeTruthy();
    // 必须拿到内存行（有真实涨幅），而不是视图壳行（changePct='--'）
    expect(t.display.changePct).toBe('-2.00');
    expect(t.mem).toBe(t.display);
    expect(t.isFormal).toBe(false); // 不在 auction_watchlist ⇒ note 没有「家」
  });

  it('20日强势补位三只（东方海洋 / 阳光照明 / 光洋股份）都能解析出涨幅', () => {
    const cases = [
      [VIEW_R20_A, '-6.04'],
      [VIEW_R20_B, '-9.82'],
      [VIEW_R20_C, '2.29']
    ];
    cases.forEach(function (pair) {
      const t = resolveNoteEditTarget({ target: pair[0], formalList: FORMAL, dayRows: DAY_ROWS });
      expect(t.reason).toBe('ok');
      expect(t.display.stock).toBe(pair[0].stock);
      expect(t.display.changePct).toBe(pair[1]);
      expect(t.isFormal).toBe(false);
    });
  });

  it('正式成员：内存行优先，isFormal=true（note 正常落 auction_watchlist）', () => {
    const view = { stock: '乙股票', changePct: '-0.50', index: 1 };
    const t = resolveNoteEditTarget({ target: view, formalList: FORMAL, dayRows: DAY_ROWS });
    expect(t.reason).toBe('ok');
    expect(t.mem).toBe(DAY_ROWS[1]); // 与视图行不是同一个对象
    expect(t.display).toBe(t.mem);
    expect(t.isFormal).toBe(true);
  });

  it('纯壳注入行（内存里也没有）：退化成视图行，仍不返回 null', () => {
    const view = { stock: '新注入票', changePct: '--', index: 9 };
    const t = resolveNoteEditTarget({ target: view, formalList: FORMAL, dayRows: DAY_ROWS });
    expect(t.reason).toBe('ok');
    expect(t.mem).toBeNull();
    expect(t.display).toBe(view);
    expect(t.isFormal).toBe(false);
  });

  it('旧契约（传数字下标）：正式成员照旧可用', () => {
    const t = resolveNoteEditTarget({ target: 2, formalList: FORMAL, dayRows: DAY_ROWS });
    expect(t.name).toBe('丙股票');
    expect(t.display.changePct).toBe('3.00');
    expect(t.isFormal).toBe(true);
  });

  it('旧契约传数字且下标越界：reason=no-stock（调用方据此提示，⛔ 不静默）', () => {
    const t = resolveNoteEditTarget({ target: 5, formalList: FORMAL, dayRows: DAY_ROWS });
    expect(t.reason).toBe('no-stock');
    expect(t.display).toBeNull();
  });

  it('行上没有股票名：reason=no-stock', () => {
    expect(resolveNoteEditTarget({ target: { index: 0 }, formalList: FORMAL, dayRows: DAY_ROWS }).reason)
      .toBe('no-stock');
    expect(resolveNoteEditTarget({ target: { stock: '   ' }, formalList: FORMAL, dayRows: DAY_ROWS }).reason)
      .toBe('no-stock');
    expect(resolveNoteEditTarget({}).reason).toBe('no-stock');
    expect(resolveNoteEditTarget().reason).toBe('no-stock');
  });

  it('股票名首尾空格不影响匹配（按去空格后的名字定位）', () => {
    const t = resolveNoteEditTarget({ target: { stock: ' 东方海洋 ', index: 4 }, formalList: FORMAL, dayRows: DAY_ROWS });
    expect(t.name).toBe('东方海洋');
    expect(t.display.changePct).toBe('-6.04');
  });

  it('入参缺省/类型异常不抛错（formalList、dayRows 非数组）', () => {
    const t = resolveNoteEditTarget({ target: VIEW_DRAGON, formalList: null, dayRows: 'x' });
    expect(t.reason).toBe('ok');
    expect(t.display).toBe(VIEW_DRAGON);
    expect(t.isFormal).toBe(false);
  });
});
