// range20-fetch.test.js — 「20日涨幅补位票并入 9:25 抓取名单」的取数口径回归测试
//
// 【为什么必须有这个测试 / 2026-11-05 用户口径】
//   用户在竞价期间（9:25）就操作，20日补位票如果不在 9:25 的抓取名单里，它们当天就
//   **没有竞价量、没有竞价量比** ⇒ 第一页整列 '-'、题材平均量比分母缺失。
//   实测 2026-11-05：market_metrics 86 行里 28 只没量比，而 9:25 写的那 58 只 **58/58 全带量比**
//   ⇒ 缺的根因 100% 是「票不在名单」，不是猫抓不给。
//
//   猫抓 daily_auc 一次请求一批 symbols，**额度按请求次数算、不按股票数算**
//   ⇒ 名单里多这 20 只 = 0 额外额度。所以「先算排名、再一起取」完全成立。
//
// 这里钉死四条不变量，任何一条被破坏都应该立刻红灯：
//   ① `pct` 是【文本列】，必须按数值降序 —— 字典序会把 8.94 排在 78.46 前面（真实踩过的坑）；
//   ② ' 8.94 % ' 这类脏写法要能解析（剥 % / 剥逗号 / trim）；
//   ③ 非数值 / 空 pct 的行必须剔除，⛔ 绝不当 0 参与排名（§10）；
//   ④ 读失败 → 返回 []（非致命），⛔ 不许抛错把整轮早盘流程打断（否则 9:25 一张表都不写）。
import { describe, it, expect, afterEach } from 'vitest';
import { readRange20TopForDate } from '../data/supabase-write.js';

const ENV = { SUPABASE_URL: 'https://sb.test', SUPABASE_ANON_KEY: 'anon-test' };
const realFetch = globalThis.fetch;

afterEach(() => { globalThis.fetch = realFetch; });

/** 用一个假 fetch 固定返回给定的行；并记录被请求的 URL */
function stubRows(rows, opt) {
  const o = opt || {};
  const calls = [];
  globalThis.fetch = async function (url) {
    calls.push(String(url));
    if (o.status && o.status !== 200) {
      return { ok: false, status: o.status, text: async () => 'boom' };
    }
    return { ok: true, status: 200, json: async () => rows };
  };
  return calls;
}

describe('readRange20TopForDate —— 20日涨幅榜取数口径', () => {
  it('① 按【数值】降序：字典序会把 8.94 排在 78.46 前面，这里必须反过来', async () => {
    stubRows([
      { stock: '弱票A', pct: '8.94', days: 20, leg: 'close' },
      { stock: '强票B', pct: '78.46', days: 20, leg: 'close' },
      { stock: '中票C', pct: '9.18', days: 20, leg: 'auc' }
    ]);
    const out = await readRange20TopForDate(ENV, '2026-11-04', 5);
    expect(out.map(r => r.name)).toEqual(['强票B', '中票C', '弱票A']);
    expect(out[0].pct).toBe(78.46);
  });

  it('② 脏写法可解析：带 % / 空格 / 千分位逗号', async () => {
    stubRows([
      { stock: 'A', pct: ' 8.94 % ', days: 20, leg: 'close' },
      { stock: 'B', pct: '1,234.50', days: 20, leg: 'close' }
    ]);
    const out = await readRange20TopForDate(ENV, '2026-11-04', 5);
    expect(out.map(r => r.name)).toEqual(['B', 'A']);
    expect(out[0].pct).toBe(1234.5);
    expect(out[1].pct).toBeCloseTo(8.94, 6);
  });

  it('③ 空/非数值 pct 必须剔除 —— ⛔ 绝不当 0 参与排名', async () => {
    stubRows([
      { stock: '空值票', pct: null, days: 20, leg: 'close' },
      { stock: '空串票', pct: '', days: 20, leg: 'close' },
      { stock: '乱码票', pct: '--', days: 20, leg: 'close' },
      { stock: '正常票', pct: '-3.20', days: 20, leg: 'close' }
    ]);
    const out = await readRange20TopForDate(ENV, '2026-11-04', 5);
    expect(out.map(r => r.name)).toEqual(['正常票']);
  });

  it('④ 表里没有行 → []（当天榜 9:25 必然为空：实测全部 16:38 才写入）', async () => {
    stubRows([]);
    expect(await readRange20TopForDate(ENV, '2026-11-05', 20)).toEqual([]);
  });

  it('④b 读失败 → [] 且不抛错（非致命，不许打断早盘流程）', async () => {
    stubRows(null, { status: 500 });
    await expect(readRange20TopForDate(ENV, '2026-11-04', 20)).resolves.toEqual([]);
  });

  it('取前 N 只：limit 生效，默认为 20', async () => {
    const rows = [];
    for (let i = 1; i <= 40; i++) rows.push({ stock: 'S' + i, pct: String(i), days: 20, leg: 'close' });
    stubRows(rows);
    const out = await readRange20TopForDate(ENV, '2026-11-04', 5);
    expect(out.length).toBe(5);
    expect(out.map(r => r.name)).toEqual(['S40', 'S39', 'S38', 'S37', 'S36']);
  });

  it('查询参数：按日期过滤，且必须在 JS 里排序（不能靠 order=pct.desc）', async () => {
    const calls = stubRows([]);
    await readRange20TopForDate(ENV, '2026-11-04', 20);
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain('date=eq.2026-11-04');
    expect(calls[0]).toContain('stock_range20_pct');
    expect(calls[0]).not.toContain('order=pct.desc');
  });

  // ── 口径：用户铁律「早上用竞价口径，收盘用收盘口径，⛔ 不要搞混」 ──
  //    上一交易日是【已收盘】的 ⇒ leg='close' 才是该日 20 日复利的权威值（auc 只是当天 9:26 中间态）。
  //    同股双行必须【只取一行】且优先 close，否则一只票占两个名额、还把两种口径混在一张榜里比较。
  it('⑤ 同股双行：只取一行，且优先收盘口径(close=权威值)', async () => {
    stubRows([
      { stock: '双行票', pct: '10.00', days: 20, leg: 'close' },
      { stock: '双行票', pct: '9.00', days: 20, leg: 'auc' },
      { stock: '单行票', pct: '11.00', days: 20, leg: 'auc' }
    ]);
    const out = await readRange20TopForDate(ENV, '2026-11-04', 10);
    expect(out.length).toBe(2);                                   // 不是 3
    const dup = out.find(r => r.name === '双行票');
    expect(dup.leg).toBe('close');                                // 优先收盘口径
    expect(dup.pct).toBe(10);                                     // 用的是 close 那一行的值
    // 排序仍按数值：11 > 10
    expect(out.map(r => r.name)).toEqual(['单行票', '双行票']);
  });

  it('⑤b 只有 auc 行时照样收（挑抓取候选以覆盖度为先，⛔ 不像名次对比那样判不出）', async () => {
    stubRows([{ stock: '仅竞价腿', pct: '7.50', days: 20, leg: 'auc' }]);
    const out = await readRange20TopForDate(ENV, '2026-11-04', 10);
    expect(out).toHaveLength(1);
    expect(out[0].leg).toBe('auc');
  });

  it('⑤c leg 为空按 close 对待（旧行缺省就是收盘口径，与前端 pickCloseLegRows 一致）', async () => {
    stubRows([{ stock: '空腿票', pct: '6.00', days: 20, leg: '' }]);
    const out = await readRange20TopForDate(ENV, '2026-11-04', 10);
    expect(out[0].leg).toBe('close');
  });
});
