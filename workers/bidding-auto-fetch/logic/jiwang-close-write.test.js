// [JIWANG-SHOUGU-CLOUD 2026-11-08] 昨收盘结果云端落库：同源三字段 / 只填空 / 窗口回补
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseEmoindicRows,
  alignWindowTargets,
  buildJiwangShouguWriteRows,
  runJiwangCloseWrite
} from './jiwang-close-write.js';

vi.mock('./holiday-check.js', () => ({
  isTradingDay: vi.fn(async (_env, d) => {
    // 周末不交易；用于「窗口最后一天 2026-11-06(周五) → 2026-11-09(周一)」
    const day = new Date(d + 'T00:00:00Z').getUTCDay();
    return day >= 1 && day <= 5;
  })
}));

afterEach(() => { vi.restoreAllMocks(); });

const FIELDS = ['tradedate', 's2', 's6', 'am'];
function payload(items) {
  return { code: 200, data: { fields: FIELDS, items } };
}
const WINDOW = [
  ['2026-11-04', 2108, 3309, 1],
  ['2026-11-05', 4665, 782, 2],
  ['2026-11-06', 758, 4741, 3]
];

describe('parseEmoindicRows', () => {
  it('按 tradedate 升序解析 s2(涨)/s6(跌)', () => {
    const rows = parseEmoindicRows(payload(WINDOW));
    expect(rows).toEqual([
      { date: '2026-11-04', up: 2108, down: 3309 },
      { date: '2026-11-05', up: 4665, down: 782 },
      { date: '2026-11-06', up: 758, down: 4741 }
    ]);
  });

  it('★ 字段缺失 / 无数据 / 0 家数一律不造值', () => {
    expect(parseEmoindicRows(null)).toEqual([]);
    expect(parseEmoindicRows({ data: { fields: ['tradedate'], items: [['2026-11-05']] } })).toEqual([]);
    expect(parseEmoindicRows(payload([['2026-11-05', 0, 100, 1]]))).toEqual([]);
    expect(parseEmoindicRows(payload([['2026-11-05', null, 100, 1]]))).toEqual([]);
    expect(parseEmoindicRows(payload([['2026-11-05', 100, 'abc', 1]]))).toEqual([]);
  });

  it('兼容 YYYYMMDD / 带横杠日期', () => {
    const rows = parseEmoindicRows(payload([['20261105', 10, 20, 1], ['2026-11-06', 30, 40, 2]]));
    expect(rows.map(r => r.date)).toEqual(['2026-11-05', '2026-11-06']);
  });
});

describe('alignWindowTargets · 真实交易日映射（0 请求，天然含节假日）', () => {
  it('★ 11-05 的下一交易日就是窗口里的 11-06 ⇒ 本次事故那一行能自动补回', () => {
    const rows = parseEmoindicRows(payload(WINDOW));
    const targets = alignWindowTargets(rows, '2026-11-09');
    expect(targets).toEqual([
      { from: '2026-11-04', date: '2026-11-05', value: '3309:2108' },
      { from: '2026-11-05', date: '2026-11-06', value: '782:4665' },
      { from: '2026-11-06', date: '2026-11-09', value: '4741:758' }
    ]);
  });

  it('lastNext 为空 ⇒ 最后一天不写，其余照常', () => {
    const targets = alignWindowTargets(parseEmoindicRows(payload(WINDOW)), '');
    expect(targets).toHaveLength(2);
    expect(targets[1].date).toBe('2026-11-06');
  });
});

describe('buildJiwangShouguWriteRows · 幂等填空', () => {
  const targets = alignWindowTargets(parseEmoindicRows(payload(WINDOW)), '2026-11-09');

  it('11-06 整行不存在 ⇒ 被补；其余按日期填空', () => {
    const rows = buildJiwangShouguWriteRows(targets, [], 'FIXED-ISO');
    expect(rows).toHaveLength(3);
    expect(rows.find(r => r.date === '2026-11-06').shouguJieguo).toBe('782:4665');
  });

  it('★ 已有非空 shouguJieguo 一律不覆盖（用户手工修正优先）', () => {
    const existing = [
      { date: '2026-11-05', shouguJieguo: '3309:2108' },
      { date: '2026-11-09', shouguJieguo: '4741:758' }
    ];
    const rows = buildJiwangShouguWriteRows(targets, existing, 'T');
    expect(rows).toEqual([{ date: '2026-11-06', shouguJieguo: '782:4665', updated_at: 'T' }]);
  });

  it('空字符串 close 视为空，允许云端补齐', () => {
    const rows = buildJiwangShouguWriteRows(targets, [{ date: '2026-11-06', shouguJieguo: '  ' }], 'T');
    expect(rows.some(r => r.date === '2026-11-06')).toBe(true);
  });

  it('★ 键集完全一致（PGRST102：键集不同整批 400）', () => {
    const rows = buildJiwangShouguWriteRows(targets, [], 'T');
    expect(new Set(rows.map(r => Object.keys(r).sort().join(','))).size).toBe(1);
  });

  it('同一目标日期只写一次', () => {
    const dup = targets.concat([{ date: '2026-11-06', value: '1:1' }]);
    expect(buildJiwangShouguWriteRows(dup, [], 'T').filter(r => r.date === '2026-11-06')).toHaveLength(1);
  });
});

describe('runJiwangCloseWrite · 端到端（mock 上游与 Supabase）', () => {
  function mockFetch(jwRows) {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, opts) => {
      const u = String(url);
      if (u.includes('emoindic-daily')) return new Response(JSON.stringify(payload(WINDOW)), { status: 200 });
      if (u.includes('/rest/v1/jiwang_data') && (!opts || !opts.method || opts.method === 'GET')) {
        return new Response(JSON.stringify(jwRows || []), { status: 200 });
      }
      if (u.includes('/rest/v1/jiwang_data')) return new Response('{}', { status: 201 });
      return new Response('[]', { status: 200 });
    });
  }

  it('★ 一次运行把 11-06 那行补回来（不覆盖 11-05 / 11-09 已有值）', async () => {
    const spy = mockFetch([
      { date: '2026-11-05', shouguJieguo: '3309:2108' },
      { date: '2026-11-09', shouguJieguo: '4741:758' }
    ]);
    const r = await runJiwangCloseWrite({ NUMCAT_API_KEY: 'k', SUPABASE_ANON_KEY: 'k' });
    expect(r.ok).toBe(true);
    expect(r.written).toBe(1);
    expect(r.rows[0]).toMatchObject({ date: '2026-11-06', shouguJieguo: '782:4665' });
    const post = spy.mock.calls.find(c => c[1] && c[1].method === 'POST' && String(c[0]).includes('jiwang_data?on_conflict'));
    expect(post).toBeTruthy();
    expect(JSON.parse(post[1].body)).toHaveLength(1);
  });

  it('★ 猫抓失败 ⇒ 一行不写，且日志点名失败（读取失败 ≠ 空数据）', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('猫抓超时'));
    const r = await runJiwangCloseWrite({ NUMCAT_API_KEY: 'k', SUPABASE_ANON_KEY: 'k' });
    expect(r.ok).toBe(false);
    expect(r.written).toBe(0);
    expect(r.logs.join('\n')).toContain('一行不写');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('★ 读 jiwang_data 失败 ⇒ 不写任何值', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('emoindic-daily')) return new Response(JSON.stringify(payload(WINDOW)), { status: 200 });
      if (u.includes('/rest/v1/jiwang_data')) return new Response('boom', { status: 500 });
      return new Response('[]', { status: 200 });
    });
    const r = await runJiwangCloseWrite({ NUMCAT_API_KEY: 'k', SUPABASE_ANON_KEY: 'k' });
    expect(r.ok).toBe(false);
    expect(r.written).toBe(0);
    expect(r.logs.join('\n')).toContain('读取 jiwang_data 失败');
  });
});
