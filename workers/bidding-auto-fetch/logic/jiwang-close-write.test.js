// [JIWANG-SHOUGU-CLOUD 2026-11-08] 昨收盘结果云端落库：同源三字段 / 只填空 / 窗口回补
// [JIWANG-MON-2026-11-23] 「每到周一三个字段全空」的两个缺陷回归锁（见本文件末两节）
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseEmoindicRows,
  alignWindowTargets,
  buildJiwangShouguWriteRows,
  pickWindowRows,
  JW_CLOSE_HHMM,
  beijingHHMM,
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

// ★★ [JIWANG-MON-2026-11-23 缺陷二] 盘中快照绝不能被当成收盘值写进下一交易日。
//
// 真实事故（2026-11-23 11:29 手动触发 point=jiwang）：
//   猫抓窗口 11-10~11-23，其中 11-23 是**盘中实时**家数 3763:1713，
//   alignWindowTargets 把它当成「11-23 的收盘结果」写进了 jiwang_data[2026-11-24]，
//   而本模块「只填空不覆盖」⇒ 这个错值会被永久固化，次日 16:00 也改不回来。
describe('pickWindowRows · 未收盘的「今天」整行剔除（缺陷二）', () => {
  const TODAY = '2026-11-06';
  const rows = [
    { date: '2026-11-04', up: 2108, down: 3309 },
    { date: '2026-11-05', up: 4665, down: 782 },
    { date: '2026-11-06', up: 1717, down: 3763 }   // ← 盘中快照
  ];

  it('盘中（09:27）⇒ 今天那行被剔除，只剩已收盘交易日', () => {
    const out = pickWindowRows(rows, TODAY, '09:27');
    expect(out.map(r => r.date)).toEqual(['2026-11-04', '2026-11-05']);
  });

  it('盘中（11:29）同样剔除 —— 一天里任何 < 15:05 的时刻都不算收盘', () => {
    expect(pickWindowRows(rows, TODAY, '11:29').map(r => r.date)).toEqual(['2026-11-04', '2026-11-05']);
    expect(pickWindowRows(rows, TODAY, '15:04').map(r => r.date)).toEqual(['2026-11-04', '2026-11-05']);
  });

  it('收盘后（>= 15:05）⇒ 今天保留，此时它是真收盘值', () => {
    expect(pickWindowRows(rows, TODAY, JW_CLOSE_HHMM).map(r => r.date))
      .toEqual(['2026-11-04', '2026-11-05', '2026-11-06']);
    expect(pickWindowRows(rows, TODAY, '16:00')).toHaveLength(3);
  });

  it('窗口里没有今天（早上猫抓还没给今天）⇒ 原样返回', () => {
    expect(pickWindowRows(rows, '2026-11-09', '09:27')).toHaveLength(3);
  });

  it('入参不是数组 / 空 ⇒ 空数组，不抛', () => {
    expect(pickWindowRows(null, TODAY, '09:27')).toEqual([]);
    expect(pickWindowRows([], TODAY, '09:27')).toEqual([]);
  });

  it('★ 端到端：盘中跑 ⇒ 只写「今天」那行(值=昨天收盘)，⛔ 不写「明天」那行', async () => {
    // 冻结在 2026-11-06 09:27 北京（= 01:27Z）
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-06T01:27:00Z'));
    expect(beijingHHMM()).toBe('09:27');
    try {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, opts) => {
        const u = String(url);
        if (u.includes('emoindic-daily')) {
          // 窗口最后一天就是「今天」且是盘中值 —— 正是事故场景
          return new Response(JSON.stringify(payload([
            ['2026-11-04', 2108, 3309, 1],
            ['2026-11-05', 4665, 782, 2],
            ['2026-11-06', 1717, 3763, 3]
          ])), { status: 200 });
        }
        if (u.includes('/rest/v1/jiwang_data') && (!opts || !opts.method || opts.method === 'GET')) {
          return new Response('[]', { status: 200 });
        }
        if (u.includes('/rest/v1/jiwang_data')) return new Response('{}', { status: 201 });
        return new Response('[]', { status: 200 });
      });
      const r = await runJiwangCloseWrite({ NUMCAT_API_KEY: 'k', SUPABASE_ANON_KEY: 'k' });
      expect(r.ok).toBe(true);
      // 最后一天被剔除 ⇒ 最后一个是 11-05 ⇒ next = 11-06(今天)，值是 11-05 的收盘
      expect(r.rows.map(x => x.date)).toEqual(['2026-11-05', '2026-11-06']);
      expect(r.rows.find(x => x.date === '2026-11-06').shouguJieguo).toBe('782:4665');
      // ⛔ 2026-11-09（下一个交易日）一行都不许写 —— 那正是「盘中值冒充收盘值」
      expect(r.rows.some(x => x.date === '2026-11-09')).toBe(false);
      expect(r.logs.join('\n')).toContain('剔除今天');
    } finally {
      vi.useRealTimers();
    }
  });

  it('★ 端到端：收盘后（16:00）跑 ⇒ 今天保留，写「明天」那行', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-06T08:00:00Z'));   // 北京 16:00
    try {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, opts) => {
        const u = String(url);
        if (u.includes('emoindic-daily')) {
          return new Response(JSON.stringify(payload([
            ['2026-11-05', 4665, 782, 2],
            ['2026-11-06', 758, 4741, 3]
          ])), { status: 200 });
        }
        if (u.includes('/rest/v1/jiwang_data') && (!opts || !opts.method || opts.method === 'GET')) {
          return new Response(JSON.stringify([
            { date: '2026-11-05', shouguJieguo: '3309:2108' },
            { date: '2026-11-06', shouguJieguo: '782:4665' }
          ]), { status: 200 });
        }
        if (u.includes('/rest/v1/jiwang_data')) return new Response('{}', { status: 201 });
        return new Response('[]', { status: 200 });
      });
      const r = await runJiwangCloseWrite({ NUMCAT_API_KEY: 'k', SUPABASE_ANON_KEY: 'k' });
      expect(r.rows).toEqual([
        { date: '2026-11-09', shouguJieguo: '4741:758', updated_at: expect.any(String) }
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ★★ [JIWANG-MON-2026-11-23 缺陷一] 主 key 额度用尽必须自动退小号。
//
// 取证：bidding_fetch_log 里 time_point=jiwang 在 11-16~11-20 连续五天全 ok=false，
//   原因逐字都是「今日调用额度已用完」。本模块原来自己拼 POST、只读一把 key，
//   主账号一耗尽就整轮放弃 —— 而其它模块早就走 postNumcat 的候选链了。
describe('猫抓 key 候选链 · 主账号额度用尽 ⇒ 退小号（缺陷一）', () => {
  it('★ 主 key 返回额度类错误 ⇒ 换小号并成功写入', async () => {
    const calls = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, opts) => {
      const u = String(url);
      if (u.includes('emoindic-daily')) {
        const body = JSON.parse(opts.body);
        calls.push(body.apikey);
        if (body.apikey === 'main-key') {
          return new Response(JSON.stringify({ code: 403, message: '今日调用额度已用完' }), { status: 200 });
        }
        return new Response(JSON.stringify(payload(WINDOW)), { status: 200 });
      }
      if (u.includes('/rest/v1/jiwang_data') && (!opts || !opts.method || opts.method === 'GET')) {
        return new Response('[]', { status: 200 });
      }
      if (u.includes('/rest/v1/jiwang_data')) return new Response('{}', { status: 201 });
      return new Response('[]', { status: 200 });
    });
    const r = await runJiwangCloseWrite({
      NUMCAT_API_KEY: 'main-key', NUMCAT_API_KEY_YIZI: 'small-key', SUPABASE_ANON_KEY: 'k'
    });
    expect(r.ok).toBe(true);
    expect(calls).toEqual(['main-key', 'small-key']);        // 先主后小，且只各试一次
    expect(r.logs.join('\n')).toContain('小号');
  });

  it('★ 两把 key 都额度用尽 ⇒ 一行不写、ok=false、日志点名', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('emoindic-daily')) {
        return new Response(JSON.stringify({ code: 403, message: '今日调用额度已用完' }), { status: 200 });
      }
      return new Response('[]', { status: 200 });
    });
    const r = await runJiwangCloseWrite({
      NUMCAT_API_KEY: 'main-key', NUMCAT_API_KEY_YIZI: 'small-key', SUPABASE_ANON_KEY: 'k'
    });
    expect(r.ok).toBe(false);
    expect(r.written).toBe(0);
    expect(r.logs.join('\n')).toContain('一行不写');
  });

  it('parseEmoindicRows 必须认 postNumcat 剥壳后的 {fields,items}（契约型故障防线）', () => {
    const shelled = { fields: FIELDS, items: WINDOW };   // 没有 data 外壳
    expect(parseEmoindicRows(shelled).map(r => r.date)).toEqual(['2026-11-04', '2026-11-05', '2026-11-06']);
  });
});

// ★ [JIWANG-MON-SLOT 2026-11-23] 9:27 兜底轮每天都会跑 ⇒ 必须「今天已有值就 0 次猫抓」，
//   否则正常日白烧一次额度（§32），把额度留给真正需要补的时段。
describe('skipIfTodayFilled · 已有值就不碰猫抓（§32）', () => {
  function mock(jwRows) {
    const numcat = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, opts) => {
      const u = String(url);
      if (u.includes('emoindic-daily')) {
        numcat.push(u);
        return new Response(JSON.stringify(payload(WINDOW)), { status: 200 });
      }
      if (u.includes('/rest/v1/jiwang_data') && (!opts || opts.method === 'GET' || !opts.method)) {
        return new Response(JSON.stringify(jwRows), { status: 200 });
      }
      if (u.includes('/rest/v1/jiwang_data')) return new Response('{}', { status: 201 });
      return new Response('[]', { status: 200 });
    });
    return numcat;
  }

  it('★ 今天已有昨收盘结果 ⇒ 0 次猫抓请求', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-23T01:27:00Z'));   // 北京 11-23 09:27
    try {
      const numcat = mock([{ date: '2026-11-23', shouguJieguo: '4876:649' }]);
      const r = await runJiwangCloseWrite({ NUMCAT_API_KEY: 'k', SUPABASE_ANON_KEY: 'k' }, { skipIfTodayFilled: true });
      expect(r.ok).toBe(true);
      expect(r.written).toBe(0);
      expect(r.skipped).toBe('today-filled');
      expect(numcat).toHaveLength(0);                    // ★ 一次都不发
    } finally { vi.useRealTimers(); }
  });

  it('★ 今天没有值（周一典型场景）⇒ 照常取一次猫抓并补上今天这行', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-23T01:27:00Z'));
    try {
      const numcat = mock([{ date: '2026-11-23', shouguJieguo: '' }]);
      const r = await runJiwangCloseWrite({ NUMCAT_API_KEY: 'k', SUPABASE_ANON_KEY: 'k' }, { skipIfTodayFilled: true });
      expect(numcat).toHaveLength(1);
      // WINDOW 是 11-04~11-06，与 11-23 无关 ⇒ 只验证「没有提前跳」
      expect(r.logs.join('\n')).not.toContain('0 次猫抓请求');
    } finally { vi.useRealTimers(); }
  });

  it('前置查询失败 ⇒ 不当成「已有值」跳过（读失败 ≠ 无缺口）', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, opts) => {
      const u = String(url);
      if (u.includes('emoindic-daily')) return new Response(JSON.stringify(payload(WINDOW)), { status: 200 });
      if (u.includes('/rest/v1/jiwang_data') && (!opts || opts.method === 'GET' || !opts.method)) {
        return new Response('boom', { status: 500 });
      }
      if (u.includes('/rest/v1/jiwang_data')) return new Response('{}', { status: 201 });
      return new Response('[]', { status: 200 });
    });
    const r = await runJiwangCloseWrite({ NUMCAT_API_KEY: 'k', SUPABASE_ANON_KEY: 'k' }, { skipIfTodayFilled: true });
    // 读失败 ⇒ 继续往下 → 后面的 readExistingJiwang 也失败 ⇒ ok:false（一行不写），但绝没被误判成「已有值」
    expect(r.skipped).not.toBe('today-filled');
    expect(r.logs.join('\n')).toContain('前置查询失败');
  });
});
