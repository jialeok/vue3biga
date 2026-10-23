// trend-patch-merge.test.js — 趋势补缺合并语义单测（§22 核心逻辑保护）
//
// 覆盖的报障：2026-10-23 新华传媒(600825) 带「20天」标，趋势面板展示日当天五条线全空。
//   根因是补缺结果只塞给一次 paint，之后封单量腿又用【原始 history】paint 一次把它整片擦掉。
//   这三条纯函数就是修法的语义载体，必须锁死。
import { describe, it, expect } from 'vitest';
import {
  hasTrendValue,
  trendNeedsPatch,
  mergeTrendPatch,
  putTrendPatch,
  beijingTodayYmd
} from './trend-patch-merge.js';

/** 造一行趋势 history */
function H(date, o) {
  const base = { date, volume: null, yestVolume: null, changePct: null, aucPctChg: null, aucVolRatio: null };
  return Object.assign(base, o || {});
}

/** 造一份补缺值（五条腿全给） */
function P(o) {
  return Object.assign(
    { volume: 941.21, yestVolume: 16617.78, changePct: 4.05, aucPctChg: -3.78, aucVolRatio: 2.59 },
    o || {}
  );
}

describe('hasTrendValue —— 「有值」的统一判据', () => {
  it('null / undefined / 空白串 = 缺', () => {
    expect(hasTrendValue(null)).toBe(false);
    expect(hasTrendValue(undefined)).toBe(false);
    expect(hasTrendValue('')).toBe(false);
    expect(hasTrendValue('   ')).toBe(false);
  });

  it('★ 0 与 "0" 算【有值】—— 绝不把「真的是 0」当成缺（§10 宁缺勿错的反向：也不许把有值当缺）', () => {
    expect(hasTrendValue(0)).toBe(true);
    expect(hasTrendValue('0')).toBe(true);
  });

  it('正常数值 / 字符串数值 = 有值', () => {
    expect(hasTrendValue(941.21)).toBe(true);
    expect(hasTrendValue('2.59')).toBe(true);
  });
});

describe('trendNeedsPatch —— 四腿任一缺即补', () => {
  it('全空 ⇒ 要补', () => {
    expect(trendNeedsPatch(H('2026-10-23'))).toBe(true);
  });

  it('齐全 ⇒ 不补（5 条线都有值）', () => {
    expect(trendNeedsPatch(H('2026-10-23', P()))).toBe(false);
  });

  it('★★ 只有 changePct、其余全空 ⇒ 仍然要补（旧口径「量与涨幅都缺」会漏掉这种半残行）', () => {
    expect(trendNeedsPatch(H('2026-10-23', { changePct: 4.05 }))).toBe(true);
  });

  it('★ 有 volume + changePct、但缺 aucPctChg ⇒ 要补（竞价涨幅那条线会断）', () => {
    expect(trendNeedsPatch(H('2026-10-23', { volume: 941, changePct: 4.05, yestVolume: 16617 }))).toBe(true);
  });

  it('★ 缺 yestVolume ⇒ 要补（昨日成交量那条线会断）', () => {
    expect(trendNeedsPatch(H('2026-10-23', { volume: 941, changePct: 4.05, aucPctChg: -3.78 }))).toBe(true);
  });

  it('空行入参不炸（防御性）', () => {
    expect(trendNeedsPatch(null)).toBe(false);
    expect(trendNeedsPatch(undefined)).toBe(false);
  });
});

describe('mergeTrendPatch —— 只填 null 位（§6 不用同花顺冒充库内真相）', () => {
  it('★ 空行 + 补齐全部五条腿 ⇒ 全部填上（新华传媒当天这一格）', () => {
    const hist = [H('2026-10-22', { volume: 364, changePct: -10.02 }), H('2026-10-23')];
    const out = mergeTrendPatch(hist, { '2026-10-23': P() });
    const today = out[1];
    expect(today.volume).toBe(941.21);
    expect(today.yestVolume).toBe(16617.78);
    expect(today.changePct).toBe(4.05);
    expect(today.aucPctChg).toBe(-3.78);
    expect(today.aucVolRatio).toBe(2.59);
  });

  it('★★ 库里已有值的字段【绝不覆盖】—— 缺的才填', () => {
    const hist = [H('2026-10-23', { volume: 999, changePct: 1.11 })];
    const out = mergeTrendPatch(hist, { '2026-10-23': P() });
    expect(out[0].volume).toBe(999);        // 库内真相保留
    expect(out[0].changePct).toBe(1.11);    // 库内真相保留
    expect(out[0].yestVolume).toBe(16617.78); // 缺的补上
    expect(out[0].aucPctChg).toBe(-3.78);
  });

  it('★ 纯函数：不改入参、返回新数组', () => {
    const hist = [H('2026-10-23')];
    const out = mergeTrendPatch(hist, { '2026-10-23': P() });
    expect(out).not.toBe(hist);
    expect(hist[0].volume).toBeNull();      // 原对象未被污染
    expect(out[0].volume).toBe(941.21);
  });

  it('没有补缺值的日期原样返回（同一对象引用，不做无谓拷贝）', () => {
    const h = H('2026-10-20', P());
    const out = mergeTrendPatch([h], { '2026-10-23': P() });
    expect(out[0]).toBe(h);
  });

  it('无仓库 / 空仓库 ⇒ 原样返回入参（零拷贝快路径）', () => {
    const hist = [H('2026-10-23')];
    expect(mergeTrendPatch(hist, null)).toBe(hist);
    expect(mergeTrendPatch(hist, undefined)).toBe(hist);
    expect(mergeTrendPatch(hist, {})).toBe(hist);
  });

  it('补缺值某一腿为 null ⇒ 该腿仍是 null，⛔ 不补 0（§10）', () => {
    const hist = [H('2026-10-20')];
    const out = mergeTrendPatch(hist, {
      '2026-10-20': { volume: null, changePct: 3.3, yestVolume: null, aucPctChg: null, aucVolRatio: null }
    });
    expect(out[0].volume).toBeNull();
    expect(out[0].yestVolume).toBeNull();
    expect(out[0].changePct).toBe(3.3);
  });

  it('★★ 稳定性：连续合并 3 次结果不变（补缺腿反复重画不会漂移）', () => {
    const patch = { '2026-10-23': P() };
    const a = mergeTrendPatch([H('2026-10-23')], patch);
    const b = mergeTrendPatch(a, patch);
    const c = mergeTrendPatch(b, patch);
    expect(c).toEqual(a);
  });
});

describe('putTrendPatch —— 今天整天替换 / 历史日浅合并', () => {
  const TODAY = '2026-10-23';

  it('★ 今天：后到的收盘涨幅要能覆盖先前补的盘中涨幅（用户口径「收盘后再覆盖涨幅」）', () => {
    let cur = putTrendPatch(null, new Map([[TODAY, P({ changePct: 4.05 })]]), TODAY);
    expect(cur[TODAY].changePct).toBe(4.05);
    // 收盘后再补一次（涨幅变了、其它腿缺）
    cur = putTrendPatch(cur, new Map([[TODAY, { changePct: 10.02, volume: null, yestVolume: null, aucPctChg: null, aucVolRatio: null }]]), TODAY);
    expect(cur[TODAY].changePct).toBe(10.02);   // 覆盖成功
    // ⚠️ 整天替换的副作用：本次没带的腿会变成 null —— 这是刻意的（盘中值已过时，⛔ 不混用）
    expect(cur[TODAY].aucPctChg).toBeNull();
  });

  it('★ 历史日：浅合并 —— 后到的字段补上，已补到的不抹掉', () => {
    let cur = putTrendPatch(null, new Map([['2026-10-20', { changePct: 2.5, volume: null }]]), TODAY);
    cur = putTrendPatch(cur, new Map([['2026-10-20', { volume: 711, changePct: null }]]), TODAY);
    expect(cur['2026-10-20'].changePct).toBe(2.5);  // 没被 null 抹掉
    expect(cur['2026-10-20'].volume).toBe(711);     // 后到的补上
  });

  it('纯函数：不改入参仓库', () => {
    const before = { [TODAY]: { changePct: 1 } };
    const after = putTrendPatch(before, new Map([[TODAY, { changePct: 9 }]]), TODAY);
    expect(before[TODAY].changePct).toBe(1);
    expect(after[TODAY].changePct).toBe(9);
  });

  it('也接受普通对象入参（Map / Object 双兼容）', () => {
    const cur = putTrendPatch(null, { '2026-10-20': { changePct: 2.5 } }, TODAY);
    expect(cur['2026-10-20'].changePct).toBe(2.5);
  });

  it('空值 / 空日期被跳过，⛔ 不写脏键', () => {
    const cur = putTrendPatch(null, new Map([['', { changePct: 1 }], [TODAY, null]]), TODAY);
    expect(Object.keys(cur).length).toBe(0);
  });

  it('null 仓库入参不炸', () => {
    expect(putTrendPatch(null, null, TODAY)).toEqual({});
  });
});

describe('beijingTodayYmd —— 北京日期（UTC+8）', () => {
  it('UTC 16:00 应算作【次日】北京（跨日边界）', () => {
    // 2026-10-22T16:00:00Z = 北京 2026-10-23 00:00
    expect(beijingTodayYmd(Date.UTC(2026, 9, 22, 16, 0, 0))).toBe('2026-10-23');
  });

  it('UTC 15:59 仍是当日', () => {
    expect(beijingTodayYmd(Date.UTC(2026, 9, 22, 15, 59, 0))).toBe('2026-10-22');
  });

  it('格式固定为 YYYY-MM-DD', () => {
    expect(beijingTodayYmd(Date.UTC(2026, 9, 23, 6, 30, 0))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
