// ths-snapshot.test.js — 「竞价一字 · 同花顺 9:25 快照补数」的回归护栏
//
// 事故背景（2026-10-26）：猫抓 daily_auc_fd 连续连接级超时（10-23 / 10-26 均 25000ms×2 全超时），
// auction_yizi 自 2026-10-22 起 0 行，一字看板整片空。用户拍板：「用同花顺的补 9 点 25 分快照就可以」，
// 且猫爪额度要留给早盘竞价看板。
//
// 这组用例锁住五条红线：
//   ① 判据 = 首封时间 09:25 且收盘封单额 > 0（实测能排除「首封 09:30、竞价未匹配为负」的伪一字）
//   ② 只写有证据的三列（竞价涨幅 / 竞价成交额 / 竞价换手率）；
//      ⛔ seal_money 与 fa_* 一律不写（同花顺只有 9:25 终态，没有分时封单额序列 —— 写了就是伪造证据链）
//   ③ ⛔ 涨停池必须分页拉全（实测 59 只 / 每页 50，只取第一页会漏 9 只）
//   ④ ⛔ 快照双闸门：data_status 非 final 或服务端日不符 ⇒ 一行都不写
//   ⑤ ⛔ 只补今天；库里已有猫抓数据 ⇒ 直接拒绝覆盖；读库失败必须如实返回 ok:false

import { describe, it, expect, vi, beforeEach } from 'vitest';

const TODAY = '2026-10-26';

vi.mock('../../data/api/fuyao-proxy.js', () => ({
  fuyaoApiGet: vi.fn(),
  tickerToThscode: function (c) { return /^\d{6}$/.test(c) ? c + '.SH' : c; },
}));
vi.mock('../../data/auction-yizi.js', () => ({
  readAuctionYiziForDate: vi.fn(),
  replaceAuctionYiziForDate: vi.fn(),
}));
vi.mock('../../data/debug-log.js', () => ({ _dbgLog: () => {} }));
vi.mock('./yizi-board.js', () => ({ beijingTodayStr: () => '2026-10-26' }));

import { patchTodayYiziFromThs } from './ths-snapshot.js';
import { fuyaoApiGet } from '../../data/api/fuyao-proxy.js';
import { readAuctionYiziForDate, replaceAuctionYiziForDate } from '../../data/auction-yizi.js';

const TS_TODAY = Date.parse('2026-10-26T09:25:00+08:00');
const TS_PREV = Date.parse('2026-10-23T09:25:00+08:00');

/** 一条涨停池行（默认形态：真一字 —— 首封 09:25 且收盘有封单） */
function poolRow(over) {
  return Object.assign({
    thscode: '600838.SH',
    ticker: '600838',
    name: '上海九百',
    is_st: false,
    last_price: 12.1,
    price_change_ratio_pct: 10,
    limit_up_time: '09:25',
    limit_up_reason: '商业百货+国改',
    continue_day_text: '4连板',
    seal_money: 136126210,
  }, over || {});
}

/** 一条竞价快照行 */
function snapRow(over) {
  return Object.assign({
    thscode: '600838.SH',
    ticker: '600838',
    name: '上海九百',
    auction_price: 12.1,
    auction_pct: 10,
    auction_volume: 14601.34,
    auction_amount: 176677740,
    auction_unmatched: 8796.34,
    auction_turnover_pct: 1.9574,
    pre_close_price: 11,
  }, over || {});
}

/** 让 fuyaoApiGet 按 path 返回：涨停池 1 页 / 快照 1 批
 *  ⚠️ `fuyaoApiGet` 返回的**已经是内层 data**（它内部 `return data.data`），
 *     所以夹具直接给 `{ item, pagination }` / `{ data_status, timestamp, item }`，⛔ 不要套 `{code,data}`。 */
function setUpstream(pool, snap, opts) {
  const o = opts || {};
  fuyaoApiGet.mockImplementation(async function (path, params) {
    if (path.indexOf('limit-up-pool') >= 0) {
      const page = Number((params && params.page) || 1);
      if (o.poolPages) return { item: o.poolPages[page - 1] || [], pagination: { total: 59, pages: o.poolPages.length, size: 200, page: page } };
      return { item: pool, pagination: { total: pool.length, pages: 1, size: 200, page: 1 } };
    }
    if (path.indexOf('auction/snapshot') >= 0) {
      return {
        data_status: o.status === undefined ? 'final' : o.status,
        timestamp: o.ts === undefined ? TS_TODAY : o.ts,
        item: snap,
      };
    }
    throw new Error('未预期的上游路径: ' + path);
  });
}

beforeEach(function () {
  vi.clearAllMocks();
  readAuctionYiziForDate.mockResolvedValue([]);
  replaceAuctionYiziForDate.mockResolvedValue({ written: 1, deleted: 0 });
});

describe('竞价一字 · 同花顺 9:25 快照补数', function () {
  it('真一字：首封 09:25 + 收盘有封单 ⇒ 写入，且只写有证据的三列', async function () {
    setUpstream([poolRow()], [snapRow()]);

    const r = await patchTodayYiziFromThs(TODAY);
    expect(r.ok).toBe(true);
    expect(r.count).toBe(1);

    const rows = replaceAuctionYiziForDate.mock.calls[0][1];
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.date).toBe(TODAY);
    expect(row.stock).toBe('上海九百');
    expect(row.code).toBe('600838');
    expect(row.symbol).toBe('600838.SH');
    // ① 三列有证据的字段
    expect(row.auc_pct_chg).toBe('+10.00');       // 带符号文本，与库内既有口径一致
    expect(row.auc_amt).toBe(176677740);
    expect(row.auc_turnover).toBeCloseTo(1.9574, 4);
    // ② ⛔ 绝不伪造封单额 / 分时序列
    expect(row.seal_money).toBeUndefined();
    expect(row.fa_0915).toBeUndefined();
    expect(row.fa_0925).toBeUndefined();
    expect(row.fa_0925l).toBeUndefined();
    expect(row.fa_count).toBeUndefined();
    // ③ ⛔ 不把口语题材串写进共享题材库
    expect(row.theme_kpl).toBeUndefined();
    expect(row.theme_xgb).toBeUndefined();
  });

  it('首封 09:30 的票不算一字（实测伪阳性：杰克科技 |误差| 仅 0.025）', async function () {
    setUpstream([poolRow({ name: '杰克科技', ticker: '603337', thscode: '603337.SH', limit_up_time: '09:30' })], []);
    const r = await patchTodayYiziFromThs(TODAY);
    expect(r.ok).toBe(false);
    expect(replaceAuctionYiziForDate).not.toHaveBeenCalled();
  });

  it('首封 09:25 但收盘已无封单（开板过）⇒ 不算一字', async function () {
    setUpstream([poolRow({ seal_money: 0 })], [snapRow()]);
    const r = await patchTodayYiziFromThs(TODAY);
    expect(r.ok).toBe(false);
    expect(replaceAuctionYiziForDate).not.toHaveBeenCalled();
  });

  it('涨停池必须分页拉全（第一页 50 只里没有一字，第二页才有）', async function () {
    const page1 = Array.from({ length: 50 }, function (_, i) {
      return poolRow({ name: '普通票' + i, ticker: '00000' + (i % 10), thscode: '00000' + (i % 10) + '.SZ', limit_up_time: '13:00' });
    });
    const page2 = [poolRow()];
    setUpstream([], [snapRow()], { poolPages: [page1, page2] });

    const r = await patchTodayYiziFromThs(TODAY);
    expect(r.ok).toBe(true);
    expect(r.count).toBe(1);
    // 两次涨停池请求（page 1 / page 2）
    const poolCalls = fuyaoApiGet.mock.calls.filter(function (c) { return String(c[0]).indexOf('limit-up-pool') >= 0; });
    expect(poolCalls.length).toBe(2);
  });

  it('快照 data_status 非 final ⇒ 一行都不写（§10 绝不跨日写错）', async function () {
    setUpstream([poolRow()], [snapRow()], { status: 'preliminary' });
    const r = await patchTodayYiziFromThs(TODAY);
    expect(r.ok).toBe(false);
    expect(replaceAuctionYiziForDate).not.toHaveBeenCalled();
  });

  it('快照服务端日期是上一交易日 ⇒ 一行都不写', async function () {
    setUpstream([poolRow()], [snapRow()], { ts: TS_PREV });
    const r = await patchTodayYiziFromThs(TODAY);
    expect(r.ok).toBe(false);
    expect(replaceAuctionYiziForDate).not.toHaveBeenCalled();
  });

  it('库里已有猫抓数据 ⇒ 拒绝覆盖', async function () {
    readAuctionYiziForDate.mockResolvedValue([{ stock: '上海九百', fa_0915: 1 }]);
    setUpstream([poolRow()], [snapRow()]);
    const r = await patchTodayYiziFromThs(TODAY);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('不覆盖');
    expect(fuyaoApiGet).not.toHaveBeenCalled();
  });

  it('读库失败 ⇒ 如实 ok:false，不顺势写成"今天没有"', async function () {
    readAuctionYiziForDate.mockRejectedValue(new Error('network down'));
    const r = await patchTodayYiziFromThs(TODAY);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('读取 auction_yizi 失败');
    expect(replaceAuctionYiziForDate).not.toHaveBeenCalled();
  });

  it('只允许补今天（快照接口只有当日数据）', async function () {
    const r = await patchTodayYiziFromThs('2026-10-23');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('只允许补今天');
    expect(fuyaoApiGet).not.toHaveBeenCalled();
  });

  it('命中票在快照里一只都没有 ⇒ 不写入', async function () {
    setUpstream([poolRow()], []);
    const r = await patchTodayYiziFromThs(TODAY);
    expect(r.ok).toBe(false);
    expect(replaceAuctionYiziForDate).not.toHaveBeenCalled();
  });
});
