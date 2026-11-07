// [BIDDING-CLOSE-CLOUD 2026-11-07] 收盘列云端落库：幂等 / 只填当天 / 不造 0
import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildBiddingCloseWriteRows, runBiddingCloseWrite } from './bidding-close-write.js';

afterEach(() => { vi.restoreAllMocks(); });

const VALUES = {
  '最近多板%': '2.37', '大盘（%）': '0.10', '大盘ETF': '1.20',
  '昨日资金前十': '4', '板块ETF': '37'
};
const ROWS_1104 = [
  { name: '最近多板%', close: '' },
  { name: '最近多板%time26', close: '' },
  { name: '大盘（%）', close: '' },
  { name: '大盘ETF', close: '' },
  { name: '封单家数', close: '' },
  { name: '昨日资金前十', close: '' },
  { name: '板块ETF(48)', close: '' }
];

describe('buildBiddingCloseWriteRows', () => {
  it('11-04 真实形状：7 行全空 close ⇒ 只写有取值的 5 行', () => {
    const rows = buildBiddingCloseWriteRows(ROWS_1104, VALUES, '2026-11-04', '2026-11-04T08:00:00.000Z');
    expect(rows).toHaveLength(5);
    expect(rows.find(r => r.name === '最近多板%').close).toBe('2.37');
    expect(rows.find(r => r.name === '板块ETF(48)').close).toBe('37');
    expect(rows.some(r => r.name === '封单家数')).toBe(false);
    expect(rows.some(r => r.name === '最近多板%time26')).toBe(false);
  });

  it('★ 键集完全一致（PGRST102：键集不同会整批 400 一行不写）', () => {
    const rows = buildBiddingCloseWriteRows(ROWS_1104, VALUES, '2026-11-04', 'T');
    const sigs = new Set(rows.map(r => Object.keys(r).sort().join(',')));
    expect(sigs.size).toBe(1);
    expect([...sigs][0]).toBe('close,date,name,updated_at');
  });

  it('★ 已有非空 close 的行不出现在写集里（不覆盖人工修正）', () => {
    const rows = ROWS_1104.map(r => ({ ...r, close: r.name === '最近多板%' ? '-1.87' : '' }));
    const out = buildBiddingCloseWriteRows(rows, VALUES, '2026-11-04', 'T');
    expect(out.some(r => r.name === '最近多板%')).toBe(false);
    expect(out).toHaveLength(4);
  });

  it('全部已填 ⇒ 空写集（幂等重跑）', () => {
    const rows = ROWS_1104.map(r => ({ ...r, close: '1' }));
    expect(buildBiddingCloseWriteRows(rows, VALUES, '2026-11-04', 'T')).toEqual([]);
  });

  it('缺「最近多板%」行但当天有其它行 ⇒ 允许补建该行（K 线唯一原料）', () => {
    const rows = [{ name: '大盘（%）', close: '' }];
    const out = buildBiddingCloseWriteRows(rows, { '最近多板%': '2.37', '大盘（%）': '0.10' }, 'D', 'T');
    expect(out.map(r => r.name)).toEqual(['大盘（%）', '最近多板%']);
  });

  it('★ 整表无任何行 ⇒ 一行不造（非交易日/竞价链路未跑的保护）', () => {
    expect(buildBiddingCloseWriteRows([], VALUES, 'D', 'T')).toEqual([]);
  });

  it('date / updated_at 由调用方注入，不读本地时间', () => {
    const rows = buildBiddingCloseWriteRows(ROWS_1104, VALUES, '2026-11-07', 'FIXED-ISO');
    rows.forEach(r => {
      expect(r.date).toBe('2026-11-07');
      expect(r.updated_at).toBe('FIXED-ISO');
    });
  });
});

describe('runBiddingCloseWrite · 硬时间闸', () => {
  it('★ 历史日期直接跳过且【一个网络请求都不发】：快照是滚动窗口，禁止回写过去', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('历史日期绝不该发请求');
    });
    const r = await runBiddingCloseWrite({}, { date: '2020-01-01' });
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(true);
    expect(r.written).toBe(0);
    expect(spy).not.toHaveBeenCalled();
    expect(r.logs.join('\n')).toContain('禁止回写历史');
  });

  it('★ 当天但 bidding_data 无行 ⇒ 跳过，不造行', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('[]', { status: 200 }));
    // 用真实的今天（模块内部 beijingToday）⇒ 不传 date
    const r = await runBiddingCloseWrite({ SUPABASE_ANON_KEY: 'k' }, {});
    expect(r.skipped).toBe(true);
    expect(r.written).toBe(0);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(r.logs.join('\n')).toContain('不造行');
  });

  it('★ 读 bidding_data 失败 ⇒ 本次不写任何值（读取失败 ≠ 空数据）', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 500 }));
    const r = await runBiddingCloseWrite({ SUPABASE_ANON_KEY: 'k' }, {});
    expect(r.ok).toBe(false);
    expect(r.written).toBe(0);
    expect(r.logs.join('\n')).toContain('读取 bidding_data 失败');
  });
});
