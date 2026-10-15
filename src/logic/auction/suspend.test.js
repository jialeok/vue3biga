import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  toThscode,
  pickSuspendedFromAuctionItems,
  pickSuspendedFromPriceItems,
  decorateSuspendField,
  isSuspended,
  canJudgeSuspended,
  hasSuspendVerdict,
  suspendState,
  libSuspendState,
  ensureSuspendSet,
  mergeSuspendNames,
  getSuspendFingerprintToken,
  clearSuspendSet,
  SUSPEND_TAG_TEXT
} from './suspend.js';

// ===== 真实样本（2026-10-13 盘中 11:15 逐字取自 fuyao 原始返回）=====
// 竞价快照：正常票 15 字段；停牌票只剩 6 字段（缺 auction_price / auction_pct / auction_volume…）
const AUC_NORMAL = {
  thscode: '600519.SH', ticker: '600519', name: '贵州茅台',
  auction_price: 1287, auction_pct: -0.0776, auction_volume: 201,
  auction_amount: 25868700, auction_unmatched: -16.25, auction_turnover_pct: 0.0016,
  auction_yesterday_ratio_pct: 0.637, auction_volume_ratio: 1.1824,
  pre_close_price: 1288, open_price: 1287, last_price: 1277.48,
  float_market_cap: 1596354204477
};
const AUC_SUSPENDED = {
  thscode: '600825.SH', ticker: '600825', name: '新华传媒',
  auction_volume_ratio: 1.621, pre_close_price: 13.78, float_market_cap: 14398554573
};
// 行情快照：正常票有成交；停牌票 volume/turnover 全 0、价格全 null，但 prev_price 有值
const PX_NORMAL = {
  thscode: '600519.SH', ticker: '600519', volume: 1140710, turnover: 1461357700,
  last_price: 1277, price_change: -11, price_change_ratio_pct: -0.854037,
  open_price: 1287, high_price: 1288.48, low_price: 1273.18, prev_price: 1288
};
const PX_SUSPENDED = {
  thscode: '600825.SH', ticker: '600825', volume: 0, turnover: 0,
  last_price: null, price_change: null, price_change_ratio_pct: null,
  open_price: null, high_price: null, low_price: null, prev_price: 13.78
};

describe('suspend · toThscode（绝不把股票名当代码）', () => {
  it('6 位代码补交易所后缀', () => {
    expect(toThscode({ code: '600825' })).toBe('600825.SH');
    expect(toThscode({ code: '000001' })).toBe('000001.SZ');
    expect(toThscode({ code: '300750' })).toBe('300750.SZ');
    expect(toThscode({ code: '920895' })).toBe('920895.BJ');
  });
  it('已带后缀原样返回', () => {
    expect(toThscode({ code: '600825.SH' })).toBe('600825.SH');
    expect(toThscode({ code: '430001.BJ' })).toBe('430001.BJ');
  });
  it('中文股票名 / 空值 → 空串（不参与判定）', () => {
    expect(toThscode({ stock: '新华传媒' })).toBe('');
    expect(toThscode({ stock: '新华传媒', code: '' })).toBe('');
    expect(toThscode({ code: '6008250' })).toBe('');
    expect(toThscode(null)).toBe('');
    expect(toThscode('600825')).toBe('600825.SH');
    expect(toThscode('新华传媒')).toBe('');
  });
});

describe('suspend · 主判据：竞价字段缺席 ⇒ 停牌', () => {
  it('停牌票被挑出，正常票不被挑出', () => {
    const items = [AUC_SUSPENDED, AUC_NORMAL];
    const r = pickSuspendedFromAuctionItems(items, new Set(['600825.SH', '600519.SH']));
    expect(r.ok).toBe(true);
    expect([...r.suspended]).toEqual(['600825.SH']);
  });

  it('auction_pct = null 同样算缺席', () => {
    const r = pickSuspendedFromAuctionItems(
      [{ thscode: '600825.SH', auction_pct: null }, AUC_NORMAL],
      new Set(['600825.SH', '600519.SH'])
    );
    expect(r.ok).toBe(true);
    expect(r.suspended.has('600825.SH')).toBe(true);
  });

  it('全部缺席 ⇒ ok=false（竞价尚未产生，不得据此判停牌）', () => {
    const all = [AUC_SUSPENDED, { thscode: '000016.SZ', name: '*ST康佳A' }];
    const r = pickSuspendedFromAuctionItems(all, new Set(['600825.SH', '000016.SZ']));
    expect(r.ok).toBe(false);
  });

  it('空数组 ⇒ ok=false', () => {
    expect(pickSuspendedFromAuctionItems([], new Set(['600825.SH'])).ok).toBe(false);
    expect(pickSuspendedFromAuctionItems(null, null).ok).toBe(false);
  });

  it('wantSet 过滤：不在关心名单里的票不进结果', () => {
    const r = pickSuspendedFromAuctionItems(
      [AUC_SUSPENDED, AUC_NORMAL],
      new Set(['600519.SH'])       // 只关心茅台
    );
    expect(r.ok).toBe(true);
    expect(r.suspended.size).toBe(0);
  });
});

describe('suspend · 降级判据：当日零成交 ⇒ 停牌', () => {
  it('零成交量 + 无成交价 ⇒ 停牌；同批有票成交 ⇒ 本腿可用', () => {
    const r = pickSuspendedFromPriceItems([PX_SUSPENDED, PX_NORMAL], new Set(['600825.SH', '600519.SH']));
    expect(r.ok).toBe(true);
    expect([...r.suspended]).toEqual(['600825.SH']);
  });

  it('★ 闸门：整批都没有成交价（尚未开盘）⇒ ok=false，绝不全员误判为停牌', () => {
    const preOpen = [
      { thscode: '600825.SH', volume: 0, turnover: 0, last_price: null },
      { thscode: '600519.SH', volume: 0, turnover: 0, last_price: null }
    ];
    const r = pickSuspendedFromPriceItems(preOpen, new Set(['600825.SH', '600519.SH']));
    expect(r.ok).toBe(false);
    expect(r.suspended.size).toBe(0);
  });

  it('有成交价但成交量为 0 ⇒ 不算停牌（只认「零成交 + 无价」二者同时成立）', () => {
    const r = pickSuspendedFromPriceItems(
      [{ thscode: '600825.SH', volume: 0, turnover: 0, last_price: 13.78 }, PX_NORMAL],
      new Set(['600825.SH', '600519.SH'])
    );
    expect(r.ok).toBe(true);
    expect(r.suspended.size).toBe(0);
  });

  it('成交量非 0 但有成交价 ⇒ 正常票', () => {
    const r = pickSuspendedFromPriceItems([PX_NORMAL], new Set(['600519.SH']));
    expect(r.ok).toBe(true);
    expect(r.suspended.size).toBe(0);
  });
});

describe('suspend · 两腿交叉（§10 宁缺勿错）', () => {
  it('2026-10-13 实测：两腿对同一批票结论一致（13 停牌 / 5 正常）', () => {
    const codes = ['600825.SH', '600519.SH', '000001.SZ'];
    const auc = pickSuspendedFromAuctionItems(
      [AUC_SUSPENDED, AUC_NORMAL, { thscode: '000001.SZ', auction_pct: 0 }],
      new Set(codes)
    );
    const px = pickSuspendedFromPriceItems(
      [PX_SUSPENDED, PX_NORMAL, { thscode: '000001.SZ', volume: 3480, turnover: 4082040, last_price: 11.67 }],
      new Set(codes)
    );
    // 取交集 = 两腿都认可才标停牌
    const both = new Set();
    auc.suspended.forEach((t) => { if (px.suspended.has(t)) both.add(t); });
    expect([...both]).toEqual(['600825.SH']);
  });
});

// [BOARD-SUSPEND 2026-10-13 用户口径]「三个选股看板（决策 / 题材量比 / 分笔买卖）都要标停牌」——
// 收口函数 decorateSuspendField 的行为必须钉死：命中给文案、未命中给空串（§10 不显示「未知」占位）。
describe('suspend · decorateSuspendField（三个选股看板的唯一展示收口）', () => {
  const D = '2026-10-13';
  const saved = suspendState.value;
  afterEach(() => { suspendState.value = saved; });

  function arm(date, names) {
    suspendState.value = { date, set: new Set(names), version: 1, loadedAt: Date.now() };
  }

  it('命中 ⇒ 写入「停牌」文案', () => {
    arm(D, ['新华传媒']);
    const row = { name: '新华传媒', code: '600825' };
    expect(decorateSuspendField(row, D)).toBe(row);   // 原地写、返回同一对象
    expect(row.suspendTag).toBe(SUSPEND_TAG_TEXT);
  });

  it('未命中 ⇒ 空串（§10 不渲染占位）', () => {
    arm(D, ['新华传媒']);
    const row = { name: '东方明珠' };
    decorateSuspendField(row, D);
    expect(row.suspendTag).toBe('');
  });

  it('日期不匹配（历史日 / 切日期瞬间）⇒ 空串', () => {
    arm(D, ['新华传媒']);
    const row = { name: '新华传媒' };
    decorateSuspendField(row, '2026-10-12');
    expect(row.suspendTag).toBe('');
  });

  it('集合为空（尚未加载 / 判不出来）⇒ 空串 —— ⛔ 绝不把「判不出来」当「没停牌」也不当「停牌」', () => {
    arm(D, []);
    const row = { name: '新华传媒' };
    decorateSuspendField(row, D);
    expect(row.suspendTag).toBe('');
  });

  it('空行 / 无名字 ⇒ 不抛错、不打标', () => {
    arm(D, ['新华传媒']);
    expect(decorateSuspendField(null, D)).toBe(null);
    const row = {};
    decorateSuspendField(row, D);
    expect(row.suspendTag).toBe('');
  });

  it('名字前后空格按 trim 命中（与 isSuspended 同一口径）', () => {
    arm(D, ['新华传媒']);
    expect(isSuspended(D, ' 新华传媒 ')).toBe(true);
    const row = { name: ' 新华传媒 ' };
    decorateSuspendField(row, D);
    expect(row.suspendTag).toBe(SUSPEND_TAG_TEXT);
  });
});

describe('suspend · canJudgeSuspended（上游快照能否为这一天作证 —— 历史日回退腿的判据）', () => {
  // [EBB-R8b 2026-10-14] 上游两个快照接口（auction/snapshot、prices/snapshot）都【只有当日数据】
  //   ⇒ isSuspended 在历史日恒 false。但「判不出来」和「没停牌」是两件事（§10），
  //   调用方必须能问出「上游到底能不能为这一天作证」，才能决定是否回退到库内竞价行。
  //   实测事故：2026-10-14 回看 10-13，总龙新华传媒停牌被判成 false ⇒ 退潮首日整套静默失效。
  const NOT_TODAY = '2020-01-01';   // 固定过去日（⛔ 不用 2026-10-13 之类，免得哪天正好是今天）
  const TODAY = (function() {
    const n = new Date();
    return n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0') + '-' + String(n.getDate()).padStart(2, '0');
  })();

  it('★ 只有【今天】返回 true（= 上游快照确实覆盖这一天）', () => {
    expect(canJudgeSuspended(TODAY)).toBe(true);
    expect(canJudgeSuspended(NOT_TODAY)).toBe(false);
  });

  it('§11：判据只看「是不是今天」，与 suspendState 里挂着什么无关（未加载也算「今天能判」）', () => {
    const saved = suspendState.value;
    try {
      // 挂一份别的日期的集合，结论不受影响；今天仍然「能判」（只是暂时还没结果）
      suspendState.value = { date: NOT_TODAY, set: new Set(['某票']), version: 1, loadedAt: Date.now() };
      expect(canJudgeSuspended(TODAY)).toBe(true);
      expect(canJudgeSuspended(NOT_TODAY)).toBe(false);
    } finally {
      suspendState.value = saved;
    }
  });

  it('§10：空 / 未定义 ⇒ false（⛔ 不猜）', () => {
    [null, undefined, ''].forEach(function(d) {
      expect(canJudgeSuspended(d)).toBe(false);
    });
  });
});

describe('suspend · hasSuspendVerdict（这一天【结论到了没有】—— 与 canJudgeSuspended 是两个问题）', () => {
  // ★★ [SUSPEND-PENDING 2026-10-14 用户实测修] 用户原话：「为什么我从 10 月 13 日切到 10 月 14 日时，
  //   还是有新华传媒（停牌）进入买点？刷新后才显示正常（没有显示新华传媒），只显示龙二，龙三」。
  //   竞态 = 「今天**能**判」被误读成「今天**没**停牌」：判定还在路上的那一小段时间，
  //   `isSuspended` 返 false、`canJudgeSuspended` 返 true ⇒ 消费方拿到一个「权威的否定」，
  //   把连续停牌的票当普通票选进买点；判定回来才自愈（用户看到「时有时无、刷新一下又变了」）。
  //   ⇒ 本函数把「**结果没到**」这件事单独暴露出来（§10：没有结论 ≠ 否定结论）。
  const NOT_TODAY = '2020-01-01';
  const TODAY = (function() {
    const n = new Date();
    return n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0') + '-' + String(n.getDate()).padStart(2, '0');
  })();
  let saved = null;
  afterEach(function() { if (saved !== null) { suspendState.value = saved; saved = null; } });

  it('★★ 未加载（loadedAt = 0）⇒ false —— 这就是「还没判出来」，⛔ 不能当成「今天没停牌」', () => {
    saved = suspendState.value;
    suspendState.value = { date: '', set: new Set(), version: 0, loadedAt: 0 };
    expect(canJudgeSuspended(TODAY)).toBe(true);    // 上游能为今天作证（能力）
    expect(hasSuspendVerdict(TODAY)).toBe(false);   // 但结论还没到（结果）
  });

  it('★ 已加载且日期对得上 ⇒ true（结论到了）；集合为空也算「到了」（= 没停牌的可靠结论）', () => {
    saved = suspendState.value;
    suspendState.value = { date: TODAY, set: new Set(), version: 1, loadedAt: Date.now() };
    expect(hasSuspendVerdict(TODAY)).toBe(true);
  });

  it('★ 状态属于【别的日期】⇒ false（不能拿昨天那份判定冒充今天的）', () => {
    saved = suspendState.value;
    suspendState.value = { date: NOT_TODAY, set: new Set(['某票']), version: 1, loadedAt: Date.now() };
    expect(hasSuspendVerdict(TODAY)).toBe(false);
    expect(hasSuspendVerdict(NOT_TODAY)).toBe(true);
  });

  it('★ 历史日：上游永远答不了 ⇒ 哪怕状态挂在别的日期上也不会返 true（§10 不猜）', () => {
    saved = suspendState.value;
    suspendState.value = { date: TODAY, set: new Set(['某票']), version: 1, loadedAt: Date.now() };
    expect(hasSuspendVerdict(NOT_TODAY)).toBe(false);
  });

  it('§10：空 / 未定义 ⇒ false（⛔ 不猜）', () => {
    [null, undefined, ''].forEach(function(d) {
      expect(hasSuspendVerdict(d)).toBe(false);
    });
  });

  it('名字前后空格按 trim 命中（与 isSuspended / canJudgeSuspended 同一口径）', () => {
    saved = suspendState.value;
    suspendState.value = { date: TODAY, set: new Set(), version: 1, loadedAt: Date.now() };
    expect(hasSuspendVerdict('  ' + TODAY + '  ')).toBe(true);
  });
});

// ── ★★ [SUSPEND-STALE / SUSPEND-MERGE 2026-10-14 用户实测修] ─────────────────────────────
//   用户原话：「为什么我从 10 月 13 日切到 10 月 14 日时，还是有新华传媒（停牌）进入买点？
//   你没修复彻底吧？刷新后才显示正常（没有显示新华传媒），只显示龙二，龙三」。
//   根因两条，都在本模块（§6 一处收口，四个看板同时受益）：
//     ① 切历史日会把「今天」那份真实判定整个清掉 ⇒ 消费方把它读成「今天没停牌」的权威否定；
//     ② 同一日期的结果原来是【整体替换】+ 只问当次名单 ⇒ 被跳过的停牌票下轮重取时掉出集合
//        ⇒ 跳过名单变空 ⇒ 它又被选回来（实测：TTL 3min + 一次刷新事件后开始来回翻）。
describe('suspend · ensureSuspendSet（★ 切历史日不得清空「今天」的判定）', () => {
  const NOT_TODAY = '2020-01-01';   // 固定过去日（⛔ 别用 2026-10-13，免得哪天正好是今天）
  const TODAY = (function() {
    const n = new Date();
    return n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0') + '-' + String(n.getDate()).padStart(2, '0');
  })();
  const saved = suspendState.value;
  afterEach(() => { suspendState.value = saved; });

  it('★★ [SUSPEND-STALE] 传历史日 ⇒ 今天那份判定【原样保留】（旧实现清成空集 ⇒ 停牌票又进买点）', async () => {
    suspendState.value = { date: TODAY, set: new Set(['新华传媒']), version: 7, loadedAt: Date.now() };
    const r = await ensureSuspendSet(NOT_TODAY, [{ stock: '新华传媒', code: '600825' }]);
    expect(r.date).toBe(TODAY);                      // ★ 没被改写成历史日
    expect([...r.set]).toEqual(['新华传媒']);         // ★ 判定还在
    expect(r.version).toBe(7);                       // ★ 没升版本（不制造无意义的重渲染）
    expect(isSuspended(TODAY, '新华传媒')).toBe(true);
    expect(isSuspended(NOT_TODAY, '新华传媒')).toBe(false);   // §11 历史日照旧不标
  });

  it('§11 传历史日【连「查过这一天」都不记录】：未加载时状态一动不动（也不排重试）', async () => {
    suspendState.value = { date: TODAY, set: new Set(), version: 3, loadedAt: 0 };
    // ⚠️ 不能拿对象身份比对：`suspendState` 是 Vue ref ⇒ `.value` 读出来的是响应式代理，身份必然不同
    await ensureSuspendSet(NOT_TODAY, [{ stock: 'X', code: '600000' }]);
    expect(suspendState.value.date).toBe(TODAY);
    expect(suspendState.value.loadedAt).toBe(0);
    expect(suspendState.value.version).toBe(3);
    expect([...suspendState.value.set]).toEqual([]);
  });

  it('§11 今天 + 名单还没到（首屏空）⇒ 不发请求、状态不变', async () => {
    suspendState.value = { date: TODAY, set: new Set(), version: 5, loadedAt: 0 };
    await ensureSuspendSet(TODAY, []);
    expect(suspendState.value.date).toBe(TODAY);
    expect(suspendState.value.loadedAt).toBe(0);
    expect([...suspendState.value.set]).toEqual([]);
  });

  it('§10 空日期 ⇒ 直接返回当前状态（不抛错）', async () => {
    suspendState.value = { date: TODAY, set: new Set(['A']), version: 1, loadedAt: 0 };
    await ensureSuspendSet('', [{ stock: 'X', code: '600000' }]);
    await ensureSuspendSet(null, []);
    expect(suspendState.value.date).toBe(TODAY);
    expect([...suspendState.value.set]).toEqual(['A']);
  });
});

describe('suspend · mergeSuspendNames（同一日按名字合并，⛔ 不整体替换）', () => {
  const D = '2026-10-14';
  const prev = '2026-10-14';

  it('★ 本轮【没问到】的名字 ⇒ 保留旧判定（被跳过的停牌票不会掉出集合）', () => {
    const p = new Set(['新华传媒', '东方明珠']);
    const queried = new Set(['东方明珠']);       // 本轮只问了东方明珠（新华传媒已被跳过、不在名单里）
    expect([...mergeSuspendNames(prev, p, D, queried, new Set())]).toEqual(['新华传媒']);
  });

  it('★ 本轮【问到过】的名字 ⇒ 一律用新判定覆盖（复牌能正确落回「不停牌」）', () => {
    const p = new Set(['新华传媒']);
    const queried = new Set(['新华传媒']);
    expect([...mergeSuspendNames(prev, p, D, queried, new Set())]).toEqual([]);              // 复牌 ⇒ 掉出
    expect([...mergeSuspendNames(prev, p, D, queried, new Set(['新华传媒']))]).toEqual(['新华传媒']); // 仍停 ⇒ 留着
  });

  it('§10 跨日期绝不沿用（新的一天从零开始，⛔ 不让昨天的结论钉死今天）', () => {
    const p = new Set(['新华传媒']);
    expect([...mergeSuspendNames('2026-10-13', p, D, new Set(), new Set())]).toEqual([]);
  });

  it('空 / 缺值输入不抛错', () => {
    expect([...mergeSuspendNames(D, null, D, null, null)]).toEqual([]);
    expect([...mergeSuspendNames('', new Set(['A']), D, new Set(), new Set(['B']))]).toEqual(['B']);
  });
});

// ===== ★★ [SUSPEND-LIB 2026-10-15 用户口径] 历史日的库内兜底判据 =====
// 用户原话：「在当天自动获取程序没有抓到竞价量，竞价涨幅，昨日成交量，情况下，
//   这种情况都应该视为停牌股票」，并要求【全部看板统一】。
// 上游快照只有当日 ⇒ 历史日（10-15 回看 10-14）本模块原本什么都没得说 ⇒ 一个「停牌」标都没有。
// 实测 2026-10-14：全表 60 行里【只有】新华传媒满足「三项全缺」。
/**
 * 库内字段的可控假数据源（key = date|name|field）。
 * ⚠️ 必须用 vi.hoisted —— vi.mock 的工厂会被提升到 import 之前执行，
 *   直接引用普通 const 会踩 TDZ。
 */
const _histStore = vi.hoisted(() => ({ v: {} }));
vi.mock('../../data/watchlist-helpers.js', () => ({
  getStockHistoryValue: (date, name, field) => {
    const k = date + '|' + name + '|' + field;
    return Object.prototype.hasOwnProperty.call(_histStore.v, k) ? _histStore.v[k] : null;
  }
}));

describe('suspend · ★ 库内兜底判据（历史日：三项全缺 ⇒ 停牌）', () => {
  const D = '2020-03-05';                     // 固定过去日 ⇒ canJudgeSuspended 恒 false
  const TODAY = (function() {
    const n = new Date();
    return n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0') + '-' + String(n.getDate()).padStart(2, '0');
  })();
  const savedS = suspendState.value;
  const savedL = libSuspendState.value;

  function setLib(rows) {
    // rows: [[name, vol, yestVol, aucPct], ...]
    _histStore.v = {};
    rows.forEach(function(r) {
      _histStore.v[D + '|' + r[0] + '|volume'] = r[1];
      _histStore.v[D + '|' + r[0] + '|yestVolume'] = r[2];
      _histStore.v[D + '|' + r[0] + '|aucPctChg'] = r[3];
    });
  }
  function entries(names) { return names.map(function(n) { return { stock: n }; }); }

  afterEach(() => {
    _histStore.v = {};
    suspendState.value = savedS;
    libSuspendState.value = savedL;
  });

  it('★★ 10-14 新华传媒 逐字复现：vol=0 / 昨量取不到 / 竞价涨幅=0 ⇒ 判为停牌', async () => {
    setLib([
      ['新华传媒', 0, null, 0],      // ← 三项全缺（实测值）
      ['慈文传媒', 3450000, 2130000, 9.65],
      ['新经典', 1520000, 1470000, 4.91]
    ]);
    await ensureSuspendSet(D, entries(['新华传媒', '慈文传媒', '新经典']));
    expect(isSuspended(D, '新华传媒')).toBe(true);
    expect(isSuspended(D, '慈文传媒')).toBe(false);
    expect(isSuspended(D, '新经典')).toBe(false);
    const row = { name: '新华传媒' };
    decorateSuspendField(row, D);
    expect(row.suspendTag).toBe(SUSPEND_TAG_TEXT);
  });

  it('★ 三项只要有一项成立 ⇒ 不是停牌（用户口径只认「三项全缺」）', async () => {
    setLib([
      ['有竞价量', 100, null, 0],
      ['有昨量', 0, 500, 0],
      ['有涨幅', 0, null, 3.2]
    ]);
    await ensureSuspendSet(D, entries(['有竞价量', '有昨量', '有涨幅', '样本']));
    expect(isSuspended(D, '有竞价量')).toBe(false);
    expect(isSuspended(D, '有昨量')).toBe(false);
    expect(isSuspended(D, '有涨幅')).toBe(false);
  });

  it('★★ 继承空壳行（该日云端根本没有它的行 ⇒ 三项全取不到）⇒ ⛔ 绝不误标停牌', async () => {
    _histStore.v = {};
    // 只给两只正常票的数据 ⇒ traded > 0（正面证据成立）
    _histStore.v[D + '|正常甲|volume'] = 120;
    _histStore.v[D + '|正常乙|volume'] = 88;
    // 「空壳」= 三项全取不到（不是 0，是根本没行）
    await ensureSuspendSet(D, entries(['正常甲', '正常乙', '空壳丙', '空壳丁']));
    expect(isSuspended(D, '空壳丙')).toBe(false);
    expect(isSuspended(D, '空壳丁')).toBe(false);
    expect([...libSuspendState.value.set]).toEqual([]);
  });

  it('★ 正面证据闸门：整份名单一只成交的都没有 ⇒ 谁都不标（判不出来 ≠ 停牌，§10）', async () => {
    setLib([
      ['甲', 0, null, 0],
      ['乙', null, null, null]
    ]);
    await ensureSuspendSet(D, entries(['甲', '乙']));
    expect(isSuspended(D, '甲')).toBe(false);
    expect(isSuspended(D, '乙')).toBe(false);
  });

  it('§10 名单为空 / 未传 ⇒ 不算、不发布（等行数变化再触发）', async () => {
    setLib([['甲', 0, null, 0]]);
    await ensureSuspendSet(D, []);
    expect(libSuspendState.value.date).toBe('');
    await ensureSuspendSet(D, undefined);
    expect(libSuspendState.value.date).toBe('');
  });

  it('★★ §11：今日路径逐字不变 —— 上游能作证时，库内判据【一律不参与】', async () => {
    // 让库内判据在「今天」也成立
    setLib([['甲', 0, null, 0], ['乙', 100, null, 0]]);
    _histStore.v[TODAY + '|甲|volume'] = 0;
    _histStore.v[TODAY + '|甲|yestVolume'] = null;
    _histStore.v[TODAY + '|甲|aucPctChg'] = 0;
    _histStore.v[TODAY + '|乙|volume'] = 100;
    suspendState.value = { date: '', set: new Set(), version: 0, loadedAt: 0 };
    // canJudgeSuspended(今天) = true ⇒ isSuspended 直接返回 false（⛔ 不拿库内判据改写上游）
    expect(canJudgeSuspended(TODAY)).toBe(true);
    expect(isSuspended(TODAY, '甲')).toBe(false);
  });

  it('★ [SUSPEND-STALE] 库内兜底写在【独立的一份】状态里 ⇒ 绝不改写 suspendState', async () => {
    setLib([['甲', 0, null, 0], ['乙', 100, null, 0]]);
    suspendState.value = { date: TODAY, set: new Set(['某停牌票']), version: 4, loadedAt: 1 };
    await ensureSuspendSet(D, entries(['甲', '乙']));
    expect(suspendState.value.date).toBe(TODAY);
    expect([...suspendState.value.set]).toEqual(['某停牌票']);
    expect(suspendState.value.version).toBe(4);
  });

  it('★ 指纹令牌把库内那份算进去（判定到货 ⇒ 令牌变 ⇒ 行缓存失效，小标不会「刷新才有」）', async () => {
    setLib([['甲', 0, null, 0], ['乙', 100, null, 0]]);
    const before = getSuspendFingerprintToken();
    await ensureSuspendSet(D, entries(['甲', '乙']));
    expect(getSuspendFingerprintToken()).not.toBe(before);
  });

  it('★ 幂等：同样的名单再算一次 ⇒ 版本不升（不制造无意义的重渲染）', async () => {
    setLib([['甲', 0, null, 0], ['乙', 100, null, 0]]);
    await ensureSuspendSet(D, entries(['甲', '乙']));
    const v = libSuspendState.value.version;
    await ensureSuspendSet(D, entries(['甲', '乙']));
    expect(libSuspendState.value.version).toBe(v);
  });

  it('clearSuspendSet 把库内那份也清空（切数据源 / 卸载）', async () => {
    setLib([['甲', 0, null, 0], ['乙', 100, null, 0]]);
    await ensureSuspendSet(D, entries(['甲', '乙']));
    expect(libSuspendState.value.set.size).toBe(1);
    clearSuspendSet();
    expect(libSuspendState.value.date).toBe('');
    expect(libSuspendState.value.set.size).toBe(0);
    expect(isSuspended(D, '甲')).toBe(false);
  });
});
