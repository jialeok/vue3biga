// Supabase Edge Function: range20-precompute
// ============================================
// 「20日涨幅」双腿预计算 ⇒ 前端 toggle 早晚都秒开：
//   · 北京 09:25（cron 自动）→ 写当天 leg='auc'（竞价口径）行 ⇒ 竞价期间打开秒开；
//   · 北京 15:05（cron 自动）→ 写当天 leg='close'（收盘口径）行 ⇒ 收盘后第一次打开秒开
//     （收盘价 15:00 定格，15:05 时当天 K 线 bar 已是最终收盘价）。
//   · 函数按【运行时刻】自动选腿，无需两个函数：
//       15:00 前 → leg='auc'，T 腿 = 竞价涨幅（open/昨收-1，缺则名单 change_pct 兜底——
//                  9:25 早盘它就是竞价涨幅，见前端 merge20Legs 函数头实证）；
//       15:00 后 → leg='close'，T 腿 = 今天 bar 收盘价/昨收-1（与前端 closeLegOf 同口径；
//                  今天 bar 缺 ⇒ 该票不写，留前端算，⛔ 绝不拿竞价腿冒充收盘腿）。
//   · 前端 15:00 换腿后按 leg 过滤读表（pickUsableRows：leg 不匹配 ≡ 还没有），
//     我们写的行与前端自己重算写的行同一主键 (date,stock) ⇒ 前端照旧覆盖，零冲突。
//
// 部署：Dashboard → Edge Functions → Create a new function → 命名 range20-precompute
//       → 把本文件全文粘贴进 index.ts → Deploy。无需配置任何 secrets
//       （SUPABASE_URL / SUPABASE_ANON_KEY 由 Edge runtime 自动注入）。
//
// 定时：见 db/create_range20_cron.sql（两条 cron：UTC 01:25 与 UTC 07:05，周一~五）。
//       也可手动触发（?leg=auc / ?leg=close 可强制指定口径，缺省按时钟）：
//         curl -X POST '<本项目URL>/functions/v1/range20-precompute?token=range20-cron-2026'
//
// 口径（与前端 src/logic/auction/range20.js 逐字一致，⛔ 别"顺手优化"）：
//   ① 窗口 = 含今天在内、每只票【自己的】最近 20 个有成交交易日（compound20 语义：
//      停牌缺 bar 天然跳过 = 0% 等价；days 如实标注实际腿数）。
//   ② 复利累乘 ∏(1+p/100)，结果 (acc-1)*100，写入格式 Number(pct).toFixed(2) 字符串。
//   ③ 算不出的票【不写行】（§10 宁缺勿错，绝不写 0 冒充），留给前端补算。
//
// 数据源（只读既有表 + 只写既有结果表，⛔ 不新增/不修改其它任何数据源）：
//   读  auction_watchlist  （date=目标日 的正式名单：stock / code / change_pct）
//   读  stock_range20_pct  （★★[R20-POOL20 2026-10-22] 补位票池 = **近 20 个榜日**并集，每票取它
//                           【最近一次】的 pct，按 pct 降序取前 POOL_TOP_N 名。用户原话：
//                           「翻开之前的20个交易日记录监测，看有没有漏掉的，如果发现排名前五的就补上去」。
//                           ⚠️ 旧实现只翻「最近 1 个榜日的前 40 名」⇒ 一只票一旦那天掉出前 40，
//                           之后就再也不会被 cron 算到（实测断点：宁波东力仅 2 天 / 冰山冷热 6 天 /
//                           慈文传媒 8 天），「补进去的票每天都要有数据」无法保证。
//                           翻 20 天仍只取 40 只 ⇒ 上游请求量与旧实现完全相同，不会触发限流。）
//   读  stockcodemap       （★[R20-POOL] 补位票 code 缺失时的一次性批查；name→code 唯一真相源）
//   读  stock_range20_pct  （目标日已有同 leg 行 ⇒ 跳过，幂等重跑不重复烧上游）
//   写  stock_range20_pct  （on_conflict=date,stock，列与前端 upsertRange20Rows 完全一致）
//   写  market_metrics     （★★[R20-METRICS 2026-10-23] 补位票的当日行情：volume / yest_volume /
//                           change_pct / auc_pct_chg / auc_vol_ratio，scope='auction'、source='range20'。
//                           on_conflict=date,stock,scope。目的：前端展开趋势图时【0 上游请求】，
//                           直接读这张表就有当天数据。详见下方 R20-METRICS 段头注释。）
//   上游 同花顺 K 线（经既有 fuyao-proxy Edge Function 代理，零新增密钥）
//
// ★★ [R20-BACKFILL 2026-10-22] 历史回补：`?date=YYYY-MM-DD` 指定目标日 T（缺省今天）。
//   用途：把 stock_range20_pct 从「只有近 9 个交易日」补齐到「20 个交易日全覆盖」。
//   实测 10-22：表最早一行 2026-10-12 ⇒ 20 交易日窗口（09-18 ~ 10-22）缺 11 天。
//   规则：
//     · 目标日 < 今天 ⇒ leg 缺省强制 'close'（历史日的「竞价腿」没有实时意义，竞价价 = 当日 open，
//       只有显式 ?leg=auc 才按开盘价算）；
//     · 历史日名单早已落库 ⇒ 不进入 45s 轮询等待；
//     · 补位池取 `date < T` 的榜日 ⇒ **回补必须由旧到新逐日跑**，否则前序无数据、池为空。
//   回补命令（每天一条，从旧到新）：
//     curl -X POST '<URL>/functions/v1/range20-precompute?token=range20-cron-2026&date=2026-09-18'
//   干跑（只列目标、不打上游）：追加 &dry=1
//
// 响应时间优化：
//   · 名单就绪即开抓（不等 runMorning 全链路跑完）；
//   · 并发 3（上游实测约束：并发 5 会截断/熔断）+ 每完成一批立即 upsert
//     ⇒ 即使函数超时被打断，已算部分也已在库里、前端照常命中；
//   · ★[R20-RATE 2026-10-22] 上游限流（`Rate limit exceeded ... Retry after Ns`）单独处理：
//     ⛔ 不计入熔断计数（原来一次限流就把整轮砍掉），先攒进 retryLater，主循环结束后
//     单线程 + 700ms 间隔串行补跑；补跑仍吃总预算，超时就停（幂等，下一轮/前端接着补）。
//   · 总预算闸门（190s）：超时停止抓取、flush 已有、返回 partial 统计。

const TOKEN = 'range20-cron-2026'; // 防匿名滥用触发烧上游；与 create_range20_cron.sql 里保持一致

const SB_URL = Deno.env.get('SUPABASE_URL') ?? '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const FUYAO_PROXY = SB_URL.replace(/\/$/, '') + '/functions/v1/fuyao-proxy';

const KLINE_PATH = '/api/a-share/prices/historical';
const WINDOW_DAYS = 20;          // 与前端 RANGE20_WINDOW_DAYS 一致
const CONCURRENCY = 3;           // 与前端实测一致：3 稳、5 截断
const REQ_TIMEOUT_MS = 15000;    // 与前端 requestTimeoutMs 一致（上游偶发挂住）
const ATTEMPTS = 3;              // 与前端一致：最多重试 3 次
const CIRCUIT_LIMIT = 6;         // 与前端 CIRCUIT_LIMIT 一致（连续失败 ⇒ 上游整体不可用）
const WATCHLIST_WAIT_MS = 45000; // 等 9:25 名单落库（runMorning P0 同在 09:25 触发，有先后竞态）
const WATCHLIST_POLL_MS = 5000;
const TOTAL_BUDGET_MS = 190000;  // 总预算：超时保全已算部分（免费档 wall clock 上限内）
// ★★ [R20-POOL20 2026-10-22] 补位池 = 近 POOL_LOOKBACK_DAYS 个榜日的并集。
//   为什么不再只翻 1 天：用户「翻开之前的20个交易日记录监测，看有没有漏掉的，如果发现排名前五的就
//   补上去」。旧口径（只翻最近 1 个榜日的前 40 名）会让「中途掉出前 40」的票彻底断供 ——
//   实测 10-22 断点：宁波东力只有 10-21/10-22 两天、冰山冷热只有 6 天、慈文传媒 8 天。
const POOL_LOOKBACK_DAYS = 20;
// 并集去重后仍只取最强 POOL_TOP_N 只 ⇒ 上游请求量与旧实现完全相同（当天名单 ~43 + 补位 ~40）。
//   ⚠️ 别调大：10-22 实测 158 只 todo 时上游 43 秒内就 `Rate limit exceeded`，熔断后只写完 29 只。
const POOL_TOP_N = 40;
// ★ [R20-RATE] 被限流那批的串行补跑间隔（把峰值速率压到上游阈值以下）
const RATE_RETRY_GAP_MS = 700;

// ★★ [R20-DAILY 2026-10-30] 逐日腿原料表快路径（详见下方 R20-DAILY 段头）。
const LEG_DAYS = WINDOW_DAYS - 1;        // 需要的历史腿根数（19），T 腿单独一根合计 20
const LEG_LOOKBACK_DAYS = 100;           // 与 K 线窗口一致（停牌票要往前回溯才凑得满 19 根）
const LEG_PAGE = 1000;                   // PostgREST 单次响应上限

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 北京时间（UTC+8）的 Date；中国无夏令时，恒 +8 */
function beijingNow(): Date {
  return new Date(Date.now() + 8 * 3600 * 1000);
}
/** 本地今天 YYYY-MM-DD（与前端 _getLocalTodayStr 同口径） */
function todayYmd(): string {
  return beijingNow().toISOString().slice(0, 10);
}
/** 北京 HH:MM（选腿用） */
function beijingHhmm(): string {
  return beijingNow().toISOString().slice(11, 16);
}

/** Supabase REST（anon key；RLS 与前端同权限）
 *  ★ [R20-DAILY 2026-10-30] `range` 用于分页：PostgREST 单次响应**最多 1000 行**
 *    （实测 `?limit=3000` 只回 1000，静默截断不报错）⇒ 读逐日腿必须 Range 分页。 */
async function sbRest(
  method: string,
  path: string,
  body?: unknown,
  range?: [number, number],
): Promise<unknown> {
  const headers: Record<string, string> = {
    apikey: ANON_KEY,
    Authorization: 'Bearer ' + ANON_KEY,
    'Content-Type': 'application/json',
  };
  if (method === 'POST') headers['Prefer'] = 'resolution=merge-duplicates';
  if (range) {
    headers['Range'] = range[0] + '-' + range[1];
    headers['Range-Unit'] = 'items';
  }
  const resp = await fetch(SB_URL.replace(/\/$/, '') + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error('REST ' + method + ' ' + path + ' -> HTTP ' + resp.status + ' ' + t.slice(0, 200));
  }
  if (method === 'GET') {
    try { return await resp.json(); } catch { return []; }
  }
  return null;
}

/** 6 位代码转 thscode（与前端 fuyao-proxy.js#tickerToThscode 逐字一致） */
function thscode(ticker: string): string {
  const t = String(ticker ?? '').trim();
  if (!t || t.indexOf('.') >= 0) return t;
  if (t.length !== 6) return t;
  if (t.charAt(0) === '6') return t + '.SH';
  if (t.charAt(0) === '0' || t.charAt(0) === '3') return t + '.SZ';
  if (t.charAt(0) === '8' || t.charAt(0) === '4') return t + '.BJ'; // 北交所 43/83/87/88 段
  if (t.slice(0, 2) === '92') return t + '.BJ';                     // 北交所 920 号段
  if (t.charAt(0) === '9') return t + '.SH';                        // 沪市 B 股
  return t + '.SZ';
}

/** 解析 "+3.20" / "3.20%" / 3.2 ⇒ 3.2（与前端 parsePct 同口径）；非法 ⇒ null（⛔ 不返回 0） */
function parsePct(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(String(raw).replace('%', '').replace('+', ''));
  return Number.isFinite(n) ? n : null;
}

/** 经既有 fuyao-proxy Edge Function 抓同花顺日 K（超时 + 3 次重试 + 退避，与前端一致） */
async function fetchKlineBars(ths: string, startMs: number, endMs: number): Promise<unknown[]> {
  const url = FUYAO_PROXY + '?path=' + encodeURIComponent(KLINE_PATH) +
    '&thscode=' + encodeURIComponent(ths) +
    '&interval=1d&start=' + String(startMs) + '&end=' + String(endMs) +
    '&adjust=forward'; // 前复权：日间比值 = 真实涨幅（与前端同一口径）
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(300 * attempt);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
    try {
      const resp = await fetch(url, { headers: { Authorization: 'Bearer ' + ANON_KEY }, signal: ctrl.signal });
      if (!resp.ok) throw new Error('fuyao-proxy HTTP ' + resp.status);
      const json = await resp.json();
      if (!json || json.code !== 0) {
        throw new Error('fuyao code=' + String(json && json.code) + ' ' + String((json && json.message) || ''));
      }
      const item = json.data && json.data.item;
      return Array.isArray(item) ? item : [];
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

interface Bar { ymd: string; close: number; open: number | null; vol: number | null; }

/** 上游 bar → 有序序列（date_ms 是北京午夜 ⇒ +8h 取 UTC 日期；close ≤0 / 缺失丢弃） */
function barsToSeries(item: unknown[]): Bar[] {
  const out: Bar[] = [];
  for (const r of item) {
    const row = r as Record<string, unknown> | null;
    if (!row || row.date_ms == null || row.close_price == null) continue;
    const close = Number(row.close_price);
    if (!Number.isFinite(close) || close <= 0) continue;
    const ymd = new Date(Number(row.date_ms) + 8 * 3600 * 1000).toISOString().slice(0, 10);
    const openRaw = row.open_price == null ? null : Number(row.open_price);
    const open = openRaw != null && Number.isFinite(openRaw) && openRaw > 0 ? openRaw : null;
    // ★★ [R20-METRICS 2026-10-23] 成交量（股）顺带保留：落 market_metrics 的 yest_volume 要用
    //   前一交易日的全天成交量 ÷ 1e4（万股）。同一次 K 线请求里就有，⛔ 不额外发请求。
    const volRaw = row.volume == null ? null : Number(row.volume);
    const vol = volRaw != null && Number.isFinite(volRaw) ? volRaw : null;
    out.push({ ymd, close, open, vol });
  }
  out.sort((a, b) => (a.ymd < b.ymd ? -1 : a.ymd > b.ymd ? 1 : 0));
  return out;
}

/**
 * 复刻前端 compound20 语义：每只票自己的最近 20 个有腿日（19 根历史收盘腿 + T 腿）。
 *
 * T 腿按 leg 取值：
 *   'auc'（15:00 前，竞价口径）：
 *     ① K 线今天 bar 存在且 open > 0 ⇒ open / 前一根 close - 1（与前端 openKeep 同一根 K 线同语义）；
 *     ② 否则用名单 change_pct（9:25 早盘它就是竞价涨幅，见前端 merge20Legs 函数头实证）；
 *   'close'（15:00 后，收盘口径）：
 *     ① K 线今天 bar 存在 ⇒ close / 前一根 close - 1（与前端 closeLegOf 同口径）；
 *     ② 今天 bar 缺 ⇒ 返回 null（⛔ 绝不拿竞价腿/昨日收盘冒充今天的收盘腿）。
 *
 * 两个口径都拿不到 T 腿 ⇒ 返回 null（⛔ 该票不写行，宁缺勿错，留给前端补算）。
 * 停牌票：hist 中间缺 bar 天然跳过（×(1+0%) 恒等），days 如实 < 20。
 */
function computeRange20(series: Bar[], today: string, leg: string, aucPct: number | null): { pct: string; days: number } | null {
  if (series.length < 2) return null;
  const tIdx = series.findIndex((b) => b.ymd === today);
  const hist = series.filter((b) => b.ymd !== today);
  let tLeg: number | null = null;
  const hasTodayBar = tIdx > 0;
  if (leg === 'close') {
    if (hasTodayBar) {
      const prev = series[tIdx - 1].close;
      if (prev > 0) tLeg = (series[tIdx].close / prev - 1) * 100;
    }
  } else { // 'auc'
    if (hasTodayBar && series[tIdx].open != null) {
      const prev = series[tIdx - 1].close;
      if (prev > 0) tLeg = ((series[tIdx].open as number) / prev - 1) * 100;
    }
    if (tLeg === null) tLeg = aucPct;
  }
  if (tLeg === null || !Number.isFinite(tLeg)) return null;
  const legs: number[] = [];
  for (let i = 1; i < hist.length; i++) {
    legs.push((hist[i].close / hist[i - 1].close - 1) * 100);
  }
  const win = legs.slice(-(WINDOW_DAYS - 1)); // 最近 19 根历史腿（窗口首腿的 prev 已在窗口外，天然可用）
  win.push(tLeg);
  let acc = 1;
  for (const p of win) acc *= (1 + p / 100);   // 与前端 compoundPct 逐字一致
  return { pct: ((acc - 1) * 100).toFixed(2), days: win.length };
}

// ════════════════════════════════════════════════════════════════════════════════
// ★★ [R20-DAILY 2026-10-30] 逐日腿原料表 stock_daily_pct —— 本函数的「0 个 K 线请求」路径
//
// 用户原话（2026-10-30，逐字保留）：
//   「为什么每次打开都要实时计算，非常耗时间，比如那些历史数据先存好，次日在算次日，这样不更快吗？
//     为什么每次都要同花顺实时重新拉取，拉取当天的就可以，再加上历史日期……这样局部补数据，
//     而不是每次整体获取，这样很慢，影响体验。」
//
// 为什么必须改这里（2026-10-30 实测）：
//   `stock_range20_pct` 存的是【窗口涨幅】(date = 窗口末日 T) ⇒ 每天都是新日期 ⇒ 每天全都不命中
//   ⇒ 本函数每天把 83 只票的 K 线**全量重拉**一遍。上游实测 50% 概率「既不返回也不断开」
//   ⇒ 真跑一次：HTTP 200 / 142.2s / written:1 / failed:7 ⇒ 9:25 那一轮根本跑不完，
//     9:36 打开还是空的（用户报障的原点）。
//
// 改法（与前端 src/logic/auction/range20.js 的 R20-DAILY 同一口径，§6 单一真相）：
//   19 根历史腿从 stock_daily_pct 取 → 只补 T 腿一根。而 T 腿在竞价口径下**本来就不用 K 线**：
//     · from='today'（当天正式名单）⇒ 名单行的 change_pct（9:25 那一刻它就是竞价涨幅，
//       与 computeRange20 的 aucPct 兜底同一口径）；
//     · from='pool'（补位票，不在今日名单）⇒ 竞价终态快照的 auction_pct
//       （**一次批量请求**覆盖 ≤40 只，零新增 K 线）。
//   ⇒ 9:25 那一轮 K 线请求数 83 → 0。
//
// ⚠️ 零回归（§11）：表不存在 / 读失败 / 该票腿不足 19 根 / 快照闸门拒绝 ⇒ **该票照旧走 K 线**，
//    行为与改造前完全一致，只是不变快。
// ⚠️ 收盘口径（leg='close'）只有在 worker 覆盖 change_pct 之后（>= 16:05）才走快路径 ——
//    ⛔ 绝不拿竞价腿冒充收盘腿（那条纪律写死在 computeRange20 函数头）。
// ⚠️ 历史回补（?date=）一律不走快路径：历史日的 change_pct 是竞价还是收盘无从判定。
// ════════════════════════════════════════════════════════════════════════════════

interface DailyLegs { legs: Map<string, number[]>; rows: number; error: string; }

/**
 * 读一批票在 [fromYmd, toYmd) 的逐日收盘涨幅腿（每票一个升序数组）。
 *
 * ⚠️ 必须 Range 分页（PAGE=1000）：PostgREST 单次最多回 1000 行且**静默截断**，
 *    不分页会表现为「一部分票有腿、一部分永远缺腿 ⇒ 永远补不完」，而且完全不报错。
 * ⚠️ `order=stock.asc,date.asc` 保证分页确定性（⛔ 去掉排序会让翻页漏行/重行）。
 */
async function readLegsFor(stocks: string[], fromYmd: string, toYmd: string): Promise<DailyLegs> {
  const legs = new Map<string, number[]>();
  if (stocks.length === 0) return { legs, rows: 0, error: '' };
  // 名单太长会被网关按 URL 长度挡掉（中文名 encodeURIComponent 后每个 ~9 字节）⇒ 只取前 200
  const names = stocks.slice(0, 200).map((s) => '"' + s.replace(/"/g, '') + '"').join(',');
  const base = '/rest/v1/stock_daily_pct?select=stock,date,pct'
    + '&stock=in.' + encodeURIComponent('(' + names + ')')
    + '&date=gte.' + fromYmd + '&date=lt.' + toYmd
    + '&order=stock.asc,date.asc';
  let rows = 0;
  let from = 0;
  try {
    for (;;) {
      const got = await sbRest('GET', base, undefined, [from, from + LEG_PAGE - 1]);
      const arr = Array.isArray(got) ? (got as Array<Record<string, unknown>>) : [];
      rows += arr.length;
      for (const r of arr) {
        const n = String((r && r.stock) ?? '').trim();
        const p = parsePct(r && r.pct);
        if (!n || p === null) continue;           // §10：缺值/非法一律跳过，⛔ 不当 0%
        const list = legs.get(n);
        if (list) list.push(p);
        else legs.set(n, [p]);
      }
      if (arr.length < LEG_PAGE) break;
      from += LEG_PAGE;
      if (from > 40000) break;                    // 防御性上限（200 只 × 100 日远达不到）
    }
  } catch (e) {
    // §10：读失败 ⇒ 返回空腿表 + 错误串（调用方据此让所有票走 K 线），⛔ 不静默当成「没有腿」
    return { legs: new Map(), rows, error: e instanceof Error ? e.message : String(e) };
  }
  return { legs, rows, error: '' };
}

/**
 * 用逐日腿 + T 腿算出区间涨幅（与 computeRange20 的复利口径逐字一致）。
 * @param legs 升序逐日涨幅（不含 T）
 * @param tLeg T 腿（竞价涨幅 / 收盘涨幅）
 */
function rangeFromLegs(legs: number[] | undefined, tLeg: number): { pct: string; days: number } | null {
  if (!legs || legs.length < LEG_DAYS) return null;   // 腿不够 ⇒ 交给 K 线，⛔ 不拿半截算
  if (!Number.isFinite(tLeg)) return null;
  const win = legs.slice(-LEG_DAYS);
  let acc = 1;
  for (const p of win) acc *= (1 + p / 100);
  acc *= (1 + tLeg / 100);
  return { pct: ((acc - 1) * 100).toFixed(2), days: win.length + 1 };
}

/** null 安全的数值解析（快照里的 auction_pct 可能是字符串 / null） */
function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 从 K 线序列取「今天那根腿」（close / 前一根 close - 1）。
 *
 * ★★ [R20-DAILY 2026-10-30] 用途：收盘那一轮把【今天这根腿】补进 stock_daily_pct，
 *   让明天早上的快路径「历史腿全齐 ⇒ 0 个 K 线请求」真正成立。
 *   为什么必须有人补：`stock_daily_pct` 的其它写入方（前端 dailyRowsFromKline / 回填脚本）
 *   **一律只写今天之前**（盘中那根是现价，落库会被当成收盘腿 ⇒ 明天算窗口直接错）。
 *   ⇒ 唯一能写「今天收盘腿」的时刻就是收盘之后，而且必须是 K 线的今日 bar（⛔ 不能用
 *     auction_watchlist.change_pct，那张表的历史行被证实会永久停在竞价涨幅）。
 *   今天 bar 不存在 ⇒ 返回 null（不写，§10 宁可明天慢一天，也不写一个假收盘）。
 */
function todayLegOf(series: Bar[], today: string): number | null {
  const i = series.findIndex((b) => b.ymd === today);
  if (i <= 0) return null;
  const prev = series[i - 1].close;
  if (!(prev > 0)) return null;
  const p = (series[i].close / prev - 1) * 100;
  return Number.isFinite(p) ? p : null;
}

/** 逐日腿的文本格式（与前端 upsertDailyPctRows / 回填脚本逐字一致：'+3.21' / '-1.05'） */
function fmtLeg(v: number): string {
  const s = v.toFixed(2);
  return s.charAt(0) === '-' ? s : ('+' + s);
}

// ════════════════════════════════════════════════════════════════════════════════
// ★★ [R20-METRICS 2026-10-23] 补位票当日行情落 market_metrics
//
// 用户原话：「补位的（有20天标签）……要自动获取啊，不是我说了就补，我要每天打开看，都要看到
//   当天数据昨日成交量、竞价涨幅，等，收盘后再覆盖涨幅。就和列表股票的趋势图显示一样，
//   没有断点，数据也全。」
// 「补位的票怎么算出来的，让它进去supabase表里，后面再整理出来就行。」
// 「如果进去 cloudflare worker，补位的票计算会延迟正常的票显示时间，得不偿失。不要用。」
//
// 【为什么必须在这里写，而不是让前端展开趋势图时补】
//   前端补缺要现场打同花顺 fuyao-proxy（K 线 + 快照）。实测 2026-10-23 15:40：
//     前端补缺 → `code=429 Global request rate limit exceeded`（K 线腿与快照腿双双失败）
//     因为 15:05 的 range20-close-precompute 刚把上游配额烧完。
//   ⇒ 前端补缺本质上是「每次打开都跟 cron 抢上游配额」，抢不到就当天全空，
//     这解释了「有时有、有时没有 / 一直空」的全部现象。
//   本函数本来就在 09:25 / 15:05 抓这些票的 K 线 ⇒ 顺手把当日行情写进 market_metrics，
//     ⛔ 零额外 K 线请求（同一批 bars 里就有 open/close/volume）；
//     只多 1 次快照请求（40 只代码一次批量），用于竞价量 / 竞价量比。
//   ⇒ 前端 `getAuctionStockHistory` 直接从云端读，展开趋势图时**一个上游请求都不打**。
//
// 【口径 —— 与 worker / 前端逐字一致，⛔ 别"顺手优化"】
//   · volume       = 快照 auction_volume ÷ 100（手 → 万股），整数串（与库内 "711" 同格式）
//                    ⚠️ 只有「当天」快照有竞价量；⛔ 绝不拿全天成交量冒充竞价量。
//   · yest_volume  = 前一交易日 K 线 volume ÷ 1e4（股 → 万股），整数串
//   · change_pct   = 15:00 后（leg='close'）→ 收盘涨幅；15:00 前 → 竞价涨幅
//                    （与 worker 9:25 写竞价涨幅、16:00 覆盖成收盘涨幅完全同口径）
//   · auc_pct_chg  = 快照 auction_pct 优先，缺则 K 线 open/昨收-1（缺则 null，§10 不猜）
//   · auc_vol_ratio= 快照 auction_volume_ratio（缺则 null）
//   · scope='auction'（前端按 scope 读）、source='range20'（可审计、与 worker/manual 区分）
//
// 【写哪些票】只写【补位票】（targets 里 from='pool' 的那批 = 不在今日正式名单的票）。
//   ⛔ 不碰当天正式名单的票：它们由 worker 写，重复写会拿不同来源的数覆盖 worker 的口径。
//   写全部补位池（≤40 只）而不是只写前五 —— 用户要的是「和列表股票一样没有断点」，
//   而"前五"依赖前端跳空/龙头组去重等视图层判据，前端一旦和这里判得不完全一致就会漏。
//   写满池子是安全的多写：market_metrics 表注释明确「不进入任何主列表」，多行不影响任何统计。
// ════════════════════════════════════════════════════════════════════════════════

/** 4 位小数以内、去掉多余的 0；用于 volume / yest_volume 这类「数值字符串」列 */
function fmtNum(v: number | null): string | null {
  if (v === null || !Number.isFinite(v)) return null;
  return String(Math.round(v));
}
/** 百分比串："+6.45%" / "-1.86%"（与库内既有格式逐字一致）；缺值 null（§10 不猜 0） */
function fmtPct(v: number | null): string | null {
  if (v === null || !Number.isFinite(v)) return null;
  return (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
}

/** 一日行情：从已抓到的 K 线序列 + 当日快照推出来（纯函数，不发请求） */
export function dayMetricsOf(
  series: Bar[],
  today: string,
  leg: string,
  snap: Record<string, unknown> | null,
): Record<string, string | null> {
  const ti = series.findIndex((b) => b.ymd === today);
  const tb = ti >= 0 ? series[ti] : null;
  // 🔴 [R20-METRICS] 「前一交易日」这一步有个必须绕开的坑：
  //   09:25 那一轮【今天还没有 K 线 bar】（A 股 9:30 才开盘，日 bar 收盘后才成型）⇒ ti === -1。
  //   若照抄 `ti > 0 ? series[ti-1] : null`，此时 pb 会是 null ⇒ yest_volume / 竞价涨幅全部算不出来，
  //   而 9:25 恰恰是「昨日成交量、竞价涨幅」最该有值的时刻（用户口径点名要这两个）。
  //   ⇒ today 不在序列里时，pb 取序列最后一根（= 上一交易日）。
  const pb = ti >= 0
    ? (ti > 0 ? series[ti - 1] : null)
    : (series.length > 0 ? series[series.length - 1] : null);
  const closePct = (tb && pb && pb.close > 0) ? (tb.close / pb.close - 1) * 100 : null;
  const openPct = (tb && tb.open != null && pb && pb.close > 0)
    ? ((tb.open as number) / pb.close - 1) * 100 : null;

  const numOf = (v: unknown): number | null => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const snapAucPct = numOf(snap && snap.auction_pct);
  const snapVolHand = numOf(snap && snap.auction_volume);
  const snapRatio = numOf(snap && snap.auction_volume_ratio);

  const aucPct = snapAucPct !== null ? snapAucPct : openPct;
  // 涨幅：收盘腿用收盘涨幅；竞价腿用竞价涨幅（9:25 那一刻 change_pct 就是竞价涨幅，
  // 与 worker 同口径），都拿不到才退回收盘涨幅
  const changePct = (leg === 'close') ? closePct : (aucPct !== null ? aucPct : closePct);
  const yestVolume = (pb && pb.vol !== null) ? (pb.vol as number) / 1e4 : null;
  // 竞价量：只有【当天终态快照】才有（手 → 万股）。⛔ 不回退到 tb.vol（那是全天成交量）
  const volume = snapVolHand !== null ? snapVolHand / 100 : null;

  return {
    volume: fmtNum(volume),
    yest_volume: fmtNum(yestVolume),
    change_pct: fmtPct(changePct),
    auc_pct_chg: fmtPct(aucPct),
    auc_vol_ratio: snapRatio !== null ? String(Number(snapRatio.toFixed(2))) : null,
  };
}

/** 批量取当日竞价终态快照（一次 ≤40 个代码；⛔ thscode 必须带交易所后缀，裸码上游返回 1002） */
async function fetchSnapshots(thscodes: string[]): Promise<{
  byCode: Map<string, Record<string, unknown>>;
  dataStatus: string;
  serverYmd: string;
  error: string;
}> {
  const byCode = new Map<string, Record<string, unknown>>();
  if (thscodes.length === 0) return { byCode, dataStatus: '', serverYmd: '', error: '' };
  try {
    const url = FUYAO_PROXY + '?path=' + encodeURIComponent('/api/a-share/auction/snapshot') +
      '&thscodes=' + encodeURIComponent(thscodes.slice(0, 40).join(',')) + '&stage=final';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
    let json: Record<string, unknown> | null = null;
    try {
      const resp = await fetch(url, { headers: { Authorization: 'Bearer ' + ANON_KEY }, signal: ctrl.signal });
      if (!resp.ok) throw new Error('fuyao-proxy HTTP ' + resp.status);
      json = await resp.json();
    } finally {
      clearTimeout(timer);
    }
    if (!json || json.code !== 0) throw new Error('fuyao code=' + String(json && json.code));
    // 响应结构：{code,message,data:{timestamp, data_status, item:[...]}} —— ⛔ item 不在顶层
    const data = (json.data ?? {}) as Record<string, unknown>;
    const dataStatus = String(data.data_status ?? '');
    const ts = Number(data.timestamp) || 0;
    const serverYmd = ts > 0 ? new Date(ts + 8 * 3600 * 1000).toISOString().slice(0, 10) : '';
    const items = Array.isArray(data.item) ? (data.item as Array<Record<string, unknown>>) : [];
    for (const it of items) {
      // item.thscode 带后缀（"600825.SH"）⇒ 裸码键 + 带后缀键都登记，防静默匹配失败
      const raw = String((it && it.thscode) ?? '');
      const bare = raw.split('.')[0];
      if (bare) byCode.set(bare, it);
      if (raw) byCode.set(raw, it);
    }
    return { byCode, dataStatus, serverYmd, error: '' };
  } catch (e) {
    return { byCode, dataStatus: '', serverYmd: '', error: e instanceof Error ? e.message : String(e) };
  }
}

// ════════════════════════════════════════════════════════════════════════════════
// ★★ [R20-HEAL 2026-10-31] 逐日腿【自愈】：拿 market_metrics 的收盘涨幅兜底补 stock_daily_pct
//
// 为什么必须有（2026-10-30 实测事故，⛔ 别删）：
//   「今天这根腿」只有一个写入点 —— 下方 ④ 段 `legBuffer`，即收盘那一轮（leg='close' 且 >=15:05）
//   用【同花顺 K 线】算出来再落库。上游一旦整体挂掉（实测：16 只全部 `The signal has been aborted`，
//   143 秒 0 写入并触发熔断），`legsWritten = 0` ⇒ 那一天在 stock_daily_pct 里**一行都没有**。
//   后果不是「慢」，是【次日整体失效】：
//     · 前端 `isLegTableStale` 判据 = 目标票最新腿日 vs App 日历前一交易日；
//     · 缺一天 ⇒ 「表整体落后于日历」⇒ `forceAll` ⇒ 阶段① 一条都不发布（`if (forceAll) return false`）
//       且全部票被推去走 K 线 ⇒ 同花顺被关时 20 日涨幅【整列 `—`】，题材量比直接选不出票。
//   而「今天这根腿」在**没人补**的情况下会永久缺 —— 因为它的下一个写入者本来就依赖 K 线。
//
// 为什么可以拿 market_metrics 当来源（有实测背书，不是「贪方便」）：
//   该表 `change_pct` 会在 worker 16:00 那轮被【收盘涨幅】覆盖（见 workers/bidding-auto-fetch）。
//   2026-10-31 交叉验证（与 stock_daily_pct 同花顺真值逐只比对）：
//     · 2026-10-28 → 73/73 完全一致（差值 < 0.005pp）
//     · 2026-10-29 → 57/58 一致（仅「出版传媒」差 1.14pp，疑似除权）
//   ⇒ 数值可信。但仍**诚实标注来源** `src='metrics_close'`（⛔ 不冒充 'kline'）；
//     同花顺恢复后，前端与收盘轮会用 src='kline' 覆盖同一主键 (date,stock) ⇒ 自动升级成真值。
//
// 三条安全闸（§10 宁缺勿错 / §11 不越界）：
//   ① 只补 `date < 今天`：当天的 change_pct 还是竞价涨幅，⛔ 落地成收盘腿会静默算错；
//   ② 只【新增】缺的票：已有 (date,stock) 的（尤其是 kline 真值）一律不碰 ⇒ 纯加法，绝不覆盖；
//   ③ `change_pct` 与 `auc_pct_chg` 相同 ⇒ 无法排除「16:00 未覆盖」⇒ 跳过不写。
// ════════════════════════════════════════════════════════════════════════════════
const HEAL_LOOKBACK_DAYS = 8;   // 只回看最近 8 个自然日（覆盖周末 + 小长假，够用且请求量恒定）
const HEAL_MIN_RATIO = 0.6;     // 已有腿数 >= 该日 metrics 行数 × 0.6 ⇒ 视为不缺，跳过（省请求）

/** YYYY-MM-DD 平移（UTC 毫秒运算，避免时区/DST 干扰；中国无夏令时） */
function shiftYmd(ymd: string, deltaDays: number): string {
  const ms = Date.parse(ymd + 'T00:00:00Z') + deltaDays * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * 用 market_metrics 的历史收盘涨幅，把 stock_daily_pct 缺的腿补上（幂等、纯新增、零上游请求）。
 * @param today 目标日（回补时是历史日；只处理 date < today）
 * @returns 每天的处理结果（写进响应体的 legHeal 字段，便于排查「到底补了哪几天」）
 */
async function healDailyLegsFromMetrics(today: string): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  const nowIso = new Date().toISOString();
  for (let i = 1; i <= HEAL_LOOKBACK_DAYS; i++) {
    const d = shiftYmd(today, -i);
    try {
      const metrics = await sbRest(
        'GET',
        '/rest/v1/market_metrics?select=stock,change_pct,auc_pct_chg&date=eq.' + d
          + '&scope=eq.auction&limit=1000',
      ) as Array<Record<string, unknown>>;
      if (!Array.isArray(metrics) || metrics.length === 0) continue;   // 非交易日 / 该日未落库 ⇒ 无事可做
      const have = await sbRest(
        'GET',
        '/rest/v1/stock_daily_pct?select=stock&date=eq.' + d + '&limit=1000',
      ) as Array<Record<string, unknown>>;
      const haveList = Array.isArray(have) ? have : [];
      const haveSet = new Set<string>();
      for (const r of haveList) {
        const s = String((r && r.stock) ?? '').trim();
        if (s) haveSet.add(s);
      }
      if (haveSet.size >= metrics.length * HEAL_MIN_RATIO) {
        out.push({ date: d, metrics: metrics.length, legs: haveSet.size, action: 'ok' });
        continue;
      }
      const rows: Array<Record<string, unknown>> = [];
      for (const r of metrics) {
        const s = String((r && r.stock) ?? '').trim();
        if (!s || haveSet.has(s)) continue;                 // 闸②：已有的一律不碰（纯新增）
        const c = parsePct(r.change_pct);
        if (c === null) continue;                           // §10：缺值不写（⛔ 不当 0%）
        const a = parsePct(r.auc_pct_chg);
        if (a !== null && Math.abs(c - a) < 0.005) continue; // 闸③：可能是未覆盖的竞价涨幅 ⇒ 跳过
        const v = c.toFixed(2);
        rows.push({
          date: d,
          stock: s,
          pct: (v.charAt(0) === '-' ? v : '+' + v),
          src: 'metrics_close',
          updated_at: nowIso,
        });
      }
      if (rows.length === 0) {
        out.push({ date: d, metrics: metrics.length, legs: haveSet.size, action: 'skip(无可写行)' });
        continue;
      }
      for (let k = 0; k < rows.length; k += 500) {
        await sbRest('POST', '/rest/v1/stock_daily_pct?on_conflict=date,stock', rows.slice(k, k + 500));
      }
      out.push({ date: d, metrics: metrics.length, legs: haveSet.size, written: rows.length, action: 'healed' });
      console.log('[range20-precompute][R20-HEAL] ' + d + ' 逐日腿 ' + haveSet.size + ' 行 → 补 ' + rows.length
        + ' 行（来源 market_metrics 收盘涨幅，src=metrics_close）');
    } catch (e) {
      // §10：自愈失败必须可见，但⛔ 不连坐 —— 主流程照常跑，只是这天继续缺
      const m = e instanceof Error ? e.message : String(e);
      out.push({ date: d, action: 'error', error: m });
      console.error('[range20-precompute][R20-HEAL] ' + d + ' 自愈失败（不影响本轮预计算）: ' + m);
    }
  }
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const json = (obj: unknown, status = 200) =>
    new Response(JSON.stringify(obj), {
      status,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });

  try {
    const url = new URL(req.url);
    if (url.searchParams.get('token') !== TOKEN) {
      return json({ ok: false, reason: 'token mismatch' }, 403);
    }
    if (!SB_URL || !ANON_KEY) {
      return json({ ok: false, reason: '缺少 SUPABASE_URL / SUPABASE_ANON_KEY（Edge runtime 应自动注入）' }, 500);
    }

    const t0 = Date.now();
    const params = url.searchParams;
    // ★★ [R20-BACKFILL] 目标日 T：?date=YYYY-MM-DD 可指定历史日做回补，缺省今天。
    //   ⚠️ 后面所有地方（名单查询 / 已有行幂等判据 / K 线窗口 / computeRange20 的 T 腿）都必须用
    //     这个 `today`，⛔ 不能有哪一处仍用 todayYmd()，否则回补会写错日期。
    const rawDate = String(params.get('date') ?? '').trim();
    const isBackfill = /^\d{4}-\d{2}-\d{2}$/.test(rawDate);
    const today = isBackfill ? rawDate : todayYmd();

    // 选腿：15:00 前 = 竞价口径（auc），15:00 后 = 收盘口径（close）——与前端 resolveT20LegMode 一致。
    // ?leg= 可强制指定（手动测试用）；强制值与时钟口径不同时也不出错（幂等按 leg 跳过）。
    let leg = beijingHhmm() < '15:00' ? 'auc' : 'close';
    const forced = String(params.get('leg') ?? '').trim();
    if (forced === 'auc' || forced === 'close') leg = forced;
    // ★ [R20-BACKFILL] 回补历史日的缺省口径必须是 close：历史日的「竞价腿」是当日 09:25 那一刻的
    //   实时语义，事后无从复原当年那个时钟；按开盘价算出来的是「开盘涨幅」，不是用户当年看到的数。
    //   ⇒ 只有显式 ?leg=auc 才跑竞价腿，缺省一律归档收盘口径（与同花顺一致，复盘用）。
    if (isBackfill && !forced) leg = 'close';

    // ① 读 9:25 名单（历史回补：名单早已落库，读一次即可，⛔ 不要白等 45 秒）
    const readWatch = async (): Promise<Array<Record<string, unknown>>> => {
      const got = await sbRest('GET', '/rest/v1/auction_watchlist?select=stock,code,change_pct&date=eq.' + today);
      return Array.isArray(got) ? got as Array<Record<string, unknown>> : [];
    };
    let watchRows = await readWatch();
    if (!isBackfill && watchRows.length === 0) {
      // runMorning P0 与本函数同在 09:25 触发 → 轮询等它写完（历史日不适用：名单早已在库）
      while (Date.now() - t0 < WATCHLIST_WAIT_MS) {
        await sleep(WATCHLIST_POLL_MS);
        watchRows = await readWatch();
        if (watchRows.length > 0) break;
      }
    }
    if (watchRows.length === 0) {
      return json({
        ok: false,
        reason: isBackfill
          ? '目标日 auction_watchlist 无行（该日非交易日 / 名单从未落库）⇒ 无法回补'
          : '等待名单超时（今日 auction_watchlist 无行：非交易日 / 名单抓取失败）',
        date: today,
        backfill: isBackfill,
        leg,
        elapsedMs: Date.now() - t0,
      });
    }
    console.log('[range20-precompute] ' + today + ' leg=' + leg + (isBackfill ? ' [回补]' : '')
      + ' 名单就绪 ' + watchRows.length + ' 行，开始预计算');

    // ★★ [R20-HEAL 2026-10-31] 先自愈「历史缺腿」，再算今天 —— 顺序不能反：
    //   前端的 stale 守卫看的正是【历史腿齐不齐】，历史缺一天，今天算得再准也会被整列判成「不可信」。
    //   全部是本库内读写（market_metrics → stock_daily_pct），⛔ 零上游请求、不烧同花顺额度。
    //   ?skipHeal=1 可跳过（手动调试 / 只想跑当天时用）。
    let legHeal: Array<Record<string, unknown>> = [];
    if (String(params.get('skipHeal') ?? '') !== '1') {
      legHeal = await healDailyLegsFromMetrics(today);
      const healedDays = legHeal.filter((x) => x.action === 'healed');
      if (healedDays.length > 0) {
        console.log('[range20-precompute][R20-HEAL] 本轮自愈 ' + healedDays.length + ' 天：'
          + healedDays.map((x) => String(x.date) + '(+' + String(x.written) + ')').join(', '));
      }
    }

    // 目标 = 当天正式名单（去重，先到先得；aucPct = change_pct 兜底竞价 T 腿，close 腿不用它）
    const targets: Array<{ stock: string; code: string; aucPct: number | null; from: string }> = [];
    const seen = new Set<string>();
    for (const r of watchRows) {
      const name = String((r && r.stock) ?? '').trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      targets.push({
        stock: name,
        code: String((r && r.code) ?? '').trim(),
        aucPct: parsePct(r && r.change_pct),
        from: 'today',
      });
    }

    // ══════════════════════════════════════════════════════════════════════════════════
    // ★★ [R20-POOL 2026-10-22] 名单补齐【补位票】—— 用户原话：
    //   「含'20天'标签的补充股票，当天有没有把这个数据写进 supabase 表？如果没有，你需要完善下。」
    //
    //   背景：「20日涨幅」前五里常常有票【不在当天的早盘名单】—— 停牌补位、或已被移出名单的旧龙头
    //   （10-22 实测：总龙一 新华传媒 188.12% 就不在当天 43 行名单里）。这些票原先只有【前端真正
    //   打开看板时】才补算并落库 ⇒ 9:25 / 15:05 两条 cron 一天都没覆盖过它们，
    //   于是「收盘腿覆盖竞价腿」对它们根本不会发生（表里要么缺行、要么停在前一天）。
    //
    //   ★★ [R20-POOL20 2026-10-22 第二轮] 池子从「最近 1 个榜日 × 前 40」扩到
    //      「近 20 个榜日并集 ⇒ 每票取最近一次的 pct ⇒ 按 pct 降序仍取前 40」。
    //   用户原话：「翻开之前的20个交易日记录监测，看有没有漏掉的，如果发现排名前五的就补上去。」
    //   为什么要扩：只翻 1 天时，一只票哪天掉出「前 40」就再也不被 cron 算到 ⇒ 数据断点。
    //   实测 10-22 断点：宁波东力只有 10-21/10-22 两天、冰山冷热 6 天、慈文传媒 8 天
    //   （而新华传媒 9/9 天齐全 —— 因为它一直霸榜前 40，正好反证了旧池的问题）。
    //   为什么仍只取 40 只：请求量 = 当天名单 ~43 + 补位 ~40 ≈ 83，与旧实现**完全相同**。
    //   10-22 实测教训：把名单涨到 158 只，上游 43 秒内就 `Rate limit exceeded`，熔断后只写完 29 只。
    //
    //   ⚠️ 补位池读失败【不中断本函数】：名单补全是增强项，主流程（当天名单）照旧要跑完；
    //      但必须把失败写进日志与响应（§10：失败可见，⛔ 不静默）。
    // ══════════════════════════════════════════════════════════════════════════════════
    let poolError = '';
    let poolDays: string[] = [];
    let poolCandidates = 0;
    try {
      // ① 取「目标日之前」的榜日，最多 POOL_LOOKBACK_DAYS 个（⛔ 不含目标日自己：当天的行还没算）
      //    ⚠️ 回补时必须由【旧到新】逐日跑，否则目标日之前没有榜日 ⇒ 池为空 ⇒ 只能算当天名单。
      const dateGot = await sbRest(
        'GET',
        '/rest/v1/stock_range20_pct?select=date&date=lt.' + today + '&order=date.desc&limit=6000',
      );
      const dateRows = Array.isArray(dateGot) ? (dateGot as Array<Record<string, unknown>>) : [];
      const uniqDates: string[] = [];
      const seenDate = new Set<string>();
      for (const r of dateRows) {
        const d = String((r && r.date) ?? '').trim();
        if (!d || seenDate.has(d)) continue;
        seenDate.add(d);
        uniqDates.push(d);
        if (uniqDates.length >= POOL_LOOKBACK_DAYS) break;
      }
      poolDays = uniqDates;
      if (uniqDates.length > 0) {
        // ② 一次把这 20 天的 (date,stock,pct) 全拉回来（2 次 REST，⛔ 不逐日查 20 次）
        //    ⚠️ pct 是【字符串列】（'87.18'），⛔ 绝不能靠 order=pct.desc 排序（字典序：'9' > '87'），
        //       必须在内存里 parsePct 后排序 —— 这一条是本函数最容易踩的坑（SQL 排序结果会是
        //       9.48 > 9.06 > 87.18 这种荒谬顺序）。
        const inList = uniqDates.map((d) => '"' + d.replace(/"/g, '') + '"').join(',');
        const got = await sbRest(
          'GET',
          '/rest/v1/stock_range20_pct?select=date,stock,pct&date=in.' + encodeURIComponent('(' + inList + ')') + '&limit=8000',
        );
        const poolRows = Array.isArray(got) ? (got as Array<Record<string, unknown>>) : [];
        // ③ 每票只保留【它最近一次】的 pct：断供多日的票也能凭它最后一条已知值回到候选池，
        //    正好把「断点票」捞回来重算（这是本需求的关键——用户怕漏掉的就是这类票）。
        const latest = new Map<string, { pct: number; date: string }>();
        for (const r of poolRows) {
          const n = String((r && r.stock) ?? '').trim();
          if (!n) continue;
          const p = parsePct(r && r.pct);
          if (p === null) continue;
          const d = String((r && r.date) ?? '');
          const prev = latest.get(n);
          if (!prev || d > prev.date) latest.set(n, { pct: p, date: d });
        }
        poolCandidates = latest.size;
        const scored = Array.from(latest.entries())
          .map(([stock, v]) => ({ stock, pct: v.pct, date: v.date }))
          .sort((a, b) => b.pct - a.pct)
          .slice(0, POOL_TOP_N);
        let added = 0;
        for (const r of scored) {
          if (seen.has(r.stock)) continue;
          seen.add(r.stock);
          targets.push({
            stock: r.stock,
            code: '',       // 结果表没有 code 列 ⇒ 下面一次性批查 stockcodemap
            aucPct: null,   // ⛔ 历史日的涨幅绝不能拿来当今天的竞价腿
            from: 'pool',
          });
          added++;
        }
        console.log('[range20-precompute] 补位池 翻 ' + uniqDates.length + ' 个榜日（'
          + uniqDates[uniqDates.length - 1] + ' ~ ' + uniqDates[0] + '）候选 ' + poolCandidates
          + ' 只 ⇒ 取最强 ' + POOL_TOP_N + '，命中 ' + added
          + ' 只（名单合计 ' + targets.length + '）');
      } else {
        console.log('[range20-precompute] 补位池：目标日之前还没有任何榜 ⇒ 本次只算当天名单');
      }
      // 池里 code 为空的票：一次性批查 stockcodemap（name→code 的唯一真相源）补上
      const noCode = targets.filter((t) => t.from === 'pool' && !t.code);
      if (noCode.length > 0) {
        const names = noCode.slice(0, 200).map((t) => '"' + t.stock.replace(/"/g, '') + '"');
        const cm = await sbRest(
          'GET',
          '/rest/v1/stockcodemap?select=stock,code&stock=in.' + encodeURIComponent('(' + names.join(',') + ')'),
        );
        const cmRows = Array.isArray(cm) ? (cm as Array<Record<string, unknown>>) : [];
        const codeOf = new Map<string, string>();
        cmRows.forEach((r) => {
          const n = String((r && r.stock) ?? '').trim();
          const c = String((r && r.code) ?? '').trim();
          if (n && c) codeOf.set(n, c);
        });
        let filled = 0;
        noCode.forEach((t) => { const c = codeOf.get(t.stock); if (c) { t.code = c; filled++; } });
        console.log('[range20-precompute] 补位票 code 补齐 ' + filled + ' / ' + noCode.length);
      }
    } catch (e) {
      poolError = e instanceof Error ? e.message : String(e);
      console.error('[range20-precompute] ⚠️ 补位池读取失败（本次只算当天名单）: ' + poolError);
    }

    // ② 跳过表里已有的当日【同 leg】行（幂等：手动重跑 / cron 重复触发不重复烧上游）
    const existed = await sbRest('GET', '/rest/v1/stock_range20_pct?select=stock&date=eq.' + today + '&leg=eq.' + leg);
    const doneSet = new Set<string>(
      (Array.isArray(existed) ? existed as Array<Record<string, unknown>> : [])
        .map((r) => String((r && r.stock) ?? '').trim())
        .filter(Boolean),
    );
    const todo = targets.filter((t) => !doneSet.has(t.stock));
    console.log('[range20-precompute] leg=' + leg + ' todo=' + todo.length + '（名单 ' + targets.length + '，库里已有 ' + doneSet.size + '）');

    // ══════════════════════════════════════════════════════════════════════════════
    // ②.5 [R20-DAILY 2026-10-30] 逐日腿快路径：历史腿读表 + T 腿不用 K 线 ⇒ 0 个 K 线请求
    //   详见上方 R20-DAILY 段头。腿不够 / 表不可用 / 快照闸门拒绝 ⇒ 该票原样留在 klineTodo。
    // ══════════════════════════════════════════════════════════════════════════════
    const tMidnight = Date.parse(today + 'T00:00:00+08:00');
    const legsFromYmd = new Date(tMidnight - LEG_LOOKBACK_DAYS * 86400000 + 8 * 3600 * 1000)
      .toISOString().slice(0, 10);
    let fastRows: Array<Record<string, unknown>> = [];
    let fastTargets: typeof todo = [];
    let klineTodo: typeof todo = todo;
    let legsRows = 0;
    let legsError = '';
    let fastUsed = 0;
    let fastNoLegs = 0;
    let fastNoT = 0;
    // 只对【竞价口径】开快路径。
    // 🔴 收盘口径（leg='close'）**故意不开**：T 腿只能是今天的收盘价，而唯一"便宜"的来源是
    //   `auction_watchlist.change_pct` —— 那张表的历史行被证实会永久停在竞价涨幅
    //   （2026-10-19 实测：粗筛按它算出新华传媒 207.91%，K 线真值 210.98%，差 1 根假腿）。
    //   ⇒ 收盘腿继续走 K 线（今天 bar 存在才算数，⛔ 绝不拿竞价腿冒充收盘腿）。
    //   历史回补（?date=）同理不走快路径（历史日的 change_pct 是竞价还是收盘无从判定）。
    const canFast = !isBackfill && leg === 'auc';
    if (canFast && todo.length > 0) {
      const daily = await readLegsFor(todo.map((t) => t.stock), legsFromYmd, today);
      legsRows = daily.rows;
      legsError = daily.error;
      // T 腿：当天名单的票用 change_pct；补位票没有当天行 ⇒ 用竞价终态快照（一次批量，≤40 只）
      const tLegOf = new Map<string, number>();
      for (const t of todo) {
        if (t.aucPct !== null && Number.isFinite(t.aucPct)) tLegOf.set(t.stock, t.aucPct as number);
      }
      const needSnap = todo.filter((t) => !tLegOf.has(t.stock) && !!t.code);
      if (needSnap.length > 0 && leg === 'auc' && !daily.error) {
        // 双重闸门（与下方 R20-METRICS 同一条安全约束，⛔ 不许放宽）：
        //   ① data_status==='final'（否则会把上一交易日的竞价写到今天头上）
        //   ② 服务端 timestamp 的北京日期 === 目标日（防上游给「滚动最近交易日」）
        const codes = needSnap.map((t) => thscode(t.code));
        let snap = await fetchSnapshots(codes);
        if (!snap.error && (snap.dataStatus !== 'final' || snap.serverYmd !== today)) {
          // 9:25:0x 那一刻竞价可能还没落终态 ⇒ 只再试一次（⛔ 不循环等待，别拖总预算）
          await sleep(2500);
          snap = await fetchSnapshots(codes);
        }
        if (!snap.error && snap.dataStatus === 'final' && snap.serverYmd === today) {
          for (const t of needSnap) {
            const v = numOrNull((snap.byCode.get(t.code) ?? {})['auction_pct']);
            if (v !== null) tLegOf.set(t.stock, v);
          }
        }
      }
      const rest: typeof todo = [];
      for (const t of todo) {
        const tl = tLegOf.get(t.stock);
        if (tl === undefined) { fastNoT++; rest.push(t); continue; }
        const row = rangeFromLegs(daily.legs.get(t.stock), tl);
        if (!row) { fastNoLegs++; rest.push(t); continue; }
        fastRows.push({
          date: today,
          stock: t.stock,
          pct: row.pct,            // 与 computeRange20 同格式：Number(x).toFixed(2) 字符串
          days: row.days,
          leg: leg,
          updated_at: new Date().toISOString(),
        });
        fastTargets.push(t);
        fastUsed++;
      }
      klineTodo = rest;
      console.log('[range20-precompute][R20-DAILY] legs=' + daily.legs.size + '/' + todo.length
        + '（读 ' + legsRows + ' 行' + (daily.error ? '，读失败: ' + daily.error : '') + '）'
        + ' ⇒ 快路径 ' + fastUsed + ' 只 / 走 K 线 ' + klineTodo.length + ' 只'
        + '（缺T腿 ' + fastNoT + '、腿不足 ' + fastNoLegs + '）');
    }

    // ★ [R20-BACKFILL] 干跑：只报「会算哪些票」，⛔ 一次上游请求都不打（回补前先确认名单对不对）
    if (params.get('dry') === '1') {
      return json({
        ok: true,
        dry: true,
        date: today,
        backfill: isBackfill,
        leg,
        watchlist: targets.filter((t) => t.from === 'today').length,
        poolAdded: targets.filter((t) => t.from === 'pool').length,
        poolDays: poolDays.length,
        poolDaysRange: poolDays.length > 0 ? (poolDays[poolDays.length - 1] + ' ~ ' + poolDays[0]) : '',
        poolCandidates,
        alreadyDone: doneSet.size,
        todo: todo.length,
        todoNoCode: todo.filter((t) => !t.code).length,
        // ★★ [R20-DAILY 2026-10-30] 干跑就能看出「这一轮要不要打上游」：
        //   fastPath>0 且 klinePath=0 ⇒ 完全不烧 K 线额度（改造后的目标形态）。
        fastPath: fastUsed,
        klinePath: klineTodo.length,
        fastNoT,
        fastNoLegs,
        legsRows,
        legsError,
        legsFrom: legsFromYmd,
        todoList: todo.slice(0, 200).map((t) => t.stock + (t.code ? '(' + t.code + ')' : '(无码)') + '[' + t.from + ']'),
      });
    }

    // ★★ [R20-DAILY 2026-10-30] 快路径结果先落库（0 个 K 线请求 ⇒ 9:25 那一轮秒完）。
    //   🔴 落库失败**必须把它们并回 klineTodo**：⛔ 不能静默丢掉一整批票
    //      （那会让前端以为「今天这些票没有值」，从而退回逐只 K 线，就是我们想根治的病）。
    let fastWritten = 0;
    if (fastRows.length > 0) {
      try {
        // 分批 500 行：一次 POST 上千行请求体过大 / 触发网关限制（前端 upsertRange20Rows 同款）
        for (let i = 0; i < fastRows.length; i += 500) {
          await sbRest('POST', '/rest/v1/stock_range20_pct?on_conflict=date,stock', fastRows.slice(i, i + 500));
        }
        fastWritten = fastRows.length;
        console.log('[range20-precompute][R20-DAILY] 快路径已落库 ' + fastWritten + ' 行（0 个 K 线请求）');
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('[range20-precompute][R20-DAILY] ⚠️ 快路径落库失败 ⇒ ' + fastTargets.length
          + ' 只改走 K 线: ' + msg);
        klineTodo = klineTodo.concat(fastTargets);
        fastUsed = 0;
        fastRows = [];
      }
    }

    // K 线窗口：往前 100 个自然日（≈65 个真实交易日，足够停牌票回溯凑满 20 腿；多要不增加成本）
    //   ★ [R20-BACKFILL] 终点必须挂在【目标日】上，⛔ 不能是「今天」—— 回补 9 月某天时若按今天取窗口，
    //     那根「T 腿」会落到窗口外，computeRange20 拿不到 T 腿 ⇒ 整轮 0 行（静默空转）。
    const targetMidnightMs = Date.parse(today + 'T00:00:00+08:00');
    const startMs = targetMidnightMs - 100 * 86400000;
    const endMs = targetMidnightMs + 2 * 86400000;

    let written = 0;
    let failed = 0;
    let circuitBreak = false;
    let consecutiveFail = 0;
    // ★ [R20-RATE 2026-10-22] 被上游限流挡下的票（不计熔断，主循环结束后串行补跑）
    let rateLimited = 0;
    const retryLater: Array<{ stock: string; code: string; aucPct: number | null; from: string }> = [];
    const failures: string[] = [];
    const buffer: Array<Record<string, unknown>> = [];
    // ★★ [R20-DAILY 2026-10-30] 收盘那一轮顺手把「今天这根腿」写进 stock_daily_pct，
    //   让明天早上的快路径「历史腿全齐 ⇒ 0 个 K 线请求」真正成立（详见 todayLegOf 注释）。
    //   ⛔ 盘中不写：今天那根是现价，落库明天会被当成收盘腿（静默算错，最难查）。
    const legBuffer: Array<Record<string, unknown>> = [];
    const legFinal = (leg === 'close' && beijingHhmm() >= '15:05');
    // ★★ [R20-METRICS 2026-10-23] 补位票的 K 线序列（落 market_metrics 用）。
    //   只在 from='pool' 时收集：当天正式名单的票由 worker 写 market_metrics，
    //   这里重复写会拿不同来源的数覆盖 worker 的口径（⛔ 不越界）。
    const poolSeries: Array<{ stock: string; code: string; series: Bar[] }> = [];

    const flush = async () => {
      if (buffer.length === 0) return;
      const batch = buffer.splice(0, buffer.length);
      try {
        await sbRest('POST', '/rest/v1/stock_range20_pct?on_conflict=date,stock', batch);
        written += batch.length;
        console.log('[range20-precompute] 已落库 ' + (written + fastWritten) + ' / ' + todo.length);
      } catch (e) {
        failed += batch.length;
        console.error('[range20-precompute] flush 失败 ' + batch.length + ' 行: ' + (e instanceof Error ? e.message : String(e)));
      }
    };

    let cursor = 0;
    const worker = async () => {
      while (!circuitBreak) {
        const i = cursor++;
        // ★ [R20-DAILY 2026-10-30] 只跑「快路径没解决」的那批（klineTodo），⛔ 不是全部 todo
        if (i >= klineTodo.length) return;
        if (Date.now() - t0 > TOTAL_BUDGET_MS) return; // 总预算闸门：超时保全已算部分
        const t = klineTodo[i];
        if (!t.code) {
          failed++;
          failures.push(t.stock + '(no code)');
          continue;
        }
        try {
          const item = await fetchKlineBars(thscode(t.code), startMs, endMs);
          const series = barsToSeries(item);
          const row = computeRange20(series, today, leg, t.aucPct);
          // [R20-METRICS] 补位票：序列留一份，后面算 market_metrics 用（⛔ 不额外发请求）
          if (t.from === 'pool') poolSeries.push({ stock: t.stock, code: t.code, series });
          // [R20-DAILY] 收盘后：今天这根腿补进原料表（免费，同一份 series 里就有）
          if (legFinal) {
            const tl = todayLegOf(series, today);
            if (tl !== null) {
              legBuffer.push({
                date: today, stock: t.stock, pct: fmtLeg(tl), src: 'kline',
                updated_at: new Date().toISOString(),
              });
            }
          }
          if (row) {
            buffer.push({
              date: today,
              stock: t.stock,
              pct: row.pct,          // Number(x).toFixed(2) 字符串（与前端 upsertRange20Rows 同格式）
              days: row.days,
              leg: leg,
              updated_at: new Date().toISOString(),
            });
            consecutiveFail = 0;
          } else {
            failed++;
            failures.push(t.stock + '(no legs)'); // T 腿/历史腿拿不到 ⇒ 不写（宁缺勿错）
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          // ★★ [R20-RATE 2026-10-22] 上游限流 ≠ 上游坏了 —— 必须分开处理：
          //   10-22 实测：83 只 todo，前 29 只正常，之后连续 9 条
          //   `Rate limit exceeded for trace ... Retry after 38s`，被当成「连续失败」触发熔断，
          //   整轮直接砍掉（只写 29 只）。但下一轮手动重跑立刻又能写 ⇒ 说明只是**速率**问题。
          //   ⇒ 限流【不计入熔断计数】（否则一次限流就废掉整轮），先攒起来，主循环结束后
          //     用单线程 + 间隔把它们补跑掉（见下方 retryLater 段）。
          if (/rate limit/i.test(msg)) {
            rateLimited++;
            retryLater.push(t);
            continue;
          }
          failed++;
          consecutiveFail++;
          failures.push(t.stock + '(' + msg + ')');
          if (consecutiveFail >= CIRCUIT_LIMIT) {
            circuitBreak = true;
            console.error('[range20-precompute] 连续 ' + consecutiveFail + ' 只失败 ⇒ 熔断，停止剩余请求');
          }
        }
        if (buffer.length >= CONCURRENCY) await flush(); // 每完成一批立即落库（分批可见）
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
    await flush();

    // ★★ [R20-RATE 2026-10-22] 限流那批的【串行补跑】：单线程 + 每次间隔 RATE_RETRY_GAP_MS，
    //   把峰值速率压到上游限流阈值以下。仍然吃总预算 —— 超时就停，已写的照常保留（幂等）。
    let retried = 0;
    let retryFailed = 0;
    if (retryLater.length > 0) {
      console.log('[range20-precompute] ⚠️ 限流 ' + retryLater.length + ' 只 ⇒ 串行补跑（间隔 ' +
        RATE_RETRY_GAP_MS + 'ms）');
    }
    for (let i = 0; i < retryLater.length; i++) {
      if (Date.now() - t0 > TOTAL_BUDGET_MS) {
        retryFailed += retryLater.length - i;
        console.warn('[range20-precompute] 补跑到总预算上限，剩余 ' + (retryLater.length - i) + ' 只留给下一轮/前端');
        break;
      }
      const t = retryLater[i];
      await sleep(RATE_RETRY_GAP_MS);
      try {
        const item = await fetchKlineBars(thscode(t.code), startMs, endMs);
        const series = barsToSeries(item);
        const row = computeRange20(series, today, leg, t.aucPct);
        // [R20-METRICS] 补跑成功的补位票同样收进 poolSeries（否则限流那批的趋势图仍然空）
        if (t.from === 'pool') poolSeries.push({ stock: t.stock, code: t.code, series });
        // [R20-DAILY] 补跑成功同样补今天的腿
        if (legFinal) {
          const tl = todayLegOf(series, today);
          if (tl !== null) {
            legBuffer.push({
              date: today, stock: t.stock, pct: fmtLeg(tl), src: 'kline',
              updated_at: new Date().toISOString(),
            });
          }
        }
        if (row) {
          await sbRest('POST', '/rest/v1/stock_range20_pct?on_conflict=date,stock', [{
            date: today,
            stock: t.stock,
            pct: row.pct,
            days: row.days,
            leg: leg,
            updated_at: new Date().toISOString(),
          }]);
          written++;
          retried++;
        } else {
          retryFailed++;
          failures.push(t.stock + '(no legs)');
        }
      } catch (e) {
        retryFailed++;
        const m = e instanceof Error ? e.message : String(e);
        failures.push(t.stock + '(补跑仍失败: ' + m + ')');
      }
    }
    if (retryLater.length > 0) {
      console.log('[range20-precompute] 限流补跑完成：成功 ' + retried + '，仍失败 ' + retryFailed);
    }

    // ★★ [R20-DAILY 2026-10-30] 今日收盘腿 → stock_daily_pct（明天早上的 0 请求就靠这一步）
    let legsWritten = 0;
    let legsWriteError = '';
    if (legBuffer.length > 0) {
      try {
        for (let i = 0; i < legBuffer.length; i += 500) {
          await sbRest('POST', '/rest/v1/stock_daily_pct?on_conflict=date,stock', legBuffer.slice(i, i + 500));
        }
        legsWritten = legBuffer.length;
        console.log('[range20-precompute][R20-DAILY] 今日收盘腿已补进 stock_daily_pct ' + legsWritten + ' 行');
      } catch (e) {
        // §10：失败可见，但⛔ 不连坐 —— 结果表已经写好了，只是明天早上这些票会走一次 K 线
        legsWriteError = e instanceof Error ? e.message : String(e);
        console.error('[range20-precompute][R20-DAILY] ⚠️ 今日腿落库失败（不影响正确性，明天这些票走 K 线）: '
          + legsWriteError);
      }
    }

    // ══════════════════════════════════════════════════════════════════════════════
    // ⑤ [R20-METRICS 2026-10-23] 补位票当日行情 → market_metrics（前端趋势图只读，0 上游请求）
    //    ⛔ 历史回补不写：那天的 market_metrics 早已由 worker 写过，重写会覆盖既有口径。
    // ══════════════════════════════════════════════════════════════════════════════
    let metricsWritten = 0;
    let metricsError = '';
    let snapStatus = '';
    let snapRejected = '';
    if (!isBackfill && poolSeries.length > 0) {
      try {
        // 快照：一次批量（≤40 只）。双重闸门与 worker / 前端同一条安全约束：
        //   ① data_status==='final'（竞价终态才算数，否则会把上一交易日的竞价写到今天头上）
        //   ② 服务端 timestamp 的北京日期 === 目标日（防上游给「滚动最近交易日」）
        const snap = await fetchSnapshots(poolSeries.map((p) => thscode(p.code)));
        snapStatus = snap.dataStatus;
        let snapOk = false;
        if (snap.error) {
          snapRejected = '快照请求失败: ' + snap.error;
        } else if (snap.dataStatus !== 'final' || snap.serverYmd !== today) {
          snapRejected = '快照闸门拒绝（status=' + snap.dataStatus + ' 服务端日=' + snap.serverYmd +
            ' 目标日=' + today + '）⇒ 本次不写竞价量/量比，只写 K 线可得的字段';
        } else {
          snapOk = true;
        }
        const rows = poolSeries.map((p) => {
          const s = snapOk ? (snap.byCode.get(p.code) ?? null) : null;
          const m = dayMetricsOf(p.series, today, leg, s);
          return {
            date: today,
            stock: p.stock,
            code: p.code,
            scope: 'auction',
            source: 'range20',
            volume: m.volume,
            yest_volume: m.yest_volume,
            change_pct: m.change_pct,
            auc_pct_chg: m.auc_pct_chg,
            auc_vol_ratio: m.auc_vol_ratio,
            updated_at: new Date().toISOString(),
          };
        });
        // 主键 (date, stock, scope) —— 与前端 upsertMarketMetrics / worker 写库同一冲突键
        await sbRest('POST', '/rest/v1/market_metrics?on_conflict=date,stock,scope', rows);
        metricsWritten = rows.length;
        console.log('[range20-precompute] market_metrics 补位票已落库 ' + metricsWritten + ' 行'
          + (snapRejected ? '（' + snapRejected + '）' : ''));
      } catch (e) {
        metricsError = e instanceof Error ? e.message : String(e);
        // §10：失败必须可见，⛔ 不静默；但也⛔ 不连坐主流程 —— range20 结果已经落库了
        console.error('[range20-precompute] ⚠️ market_metrics 落库失败（补位票趋势图当天仍会空）: ' + metricsError);
      }
    }

    const stat = {
      ok: true,
      date: today,
      // ★ [R20-BACKFILL] 历史回补标记（true = 目标日不是今天，由 ?date= 指定）
      backfill: isBackfill,
      leg,
      watchlist: targets.length,
      // ★ [R20-POOL 2026-10-22] 名单里有多少只是【补位票】（不在当天名单、靠近 20 个榜日并集补进来的）
      poolAdded: targets.filter((t) => t.from === 'pool').length,
      // ★ [R20-POOL20] 这次翻了多少个榜日、并集里有多少候选（诊断「补位池够不够厚」）
      poolDays: poolDays.length,
      poolDaysRange: poolDays.length > 0 ? (poolDays[poolDays.length - 1] + ' ~ ' + poolDays[0]) : '',
      poolCandidates,
      poolError,
      todo: todo.length,
      // ★★ [R20-DAILY 2026-10-30] 快路径 vs K 线路径的拆分（K线=0 ⇒ 完全不烧上游额度）
      fastPath: fastUsed,
      fastWritten,
      klinePath: klineTodo.length,
      fastNoT,
      fastNoLegs,
      legsRows,
      legsError,
      // ★★ [R20-DAILY] 收盘那一轮把「今天这根腿」补进原料表的行数（明天早上 0 请求的前提）
      legsWritten,
      legsWriteError,
      // ★★ [R20-HEAL 2026-10-31] 历史缺腿自愈结果（每天一条：ok / healed(+N) / skip / error）
      legHeal,
      written: written + fastWritten,
      failed,
      // ★ [R20-RATE] 限流与补跑：rateLimited = 第一轮被限流挡下的只数；retried/retryFailed = 串行补跑结果
      rateLimited,
      retried,
      retryFailed,
      // ★★ [R20-METRICS 2026-10-23] 补位票当日行情落 market_metrics 的结果（前端趋势图只读）
      metricsWritten,
      metricsError,
      snapStatus,
      snapRejected,
      circuitBreak,
      elapsedMs: Date.now() - t0,
      failures: failures.slice(0, 30),
      note: 'leg=' + leg + (isBackfill ? ' [回补 ' + today + ']' : '')
        + ' 已落库，前端 20日涨幅 toggle 阶段⓪命中即秒开（auc=竞价腿 / close=收盘腿）；'
        + '名单含补位票（近 ' + poolDays.length + ' 个榜日并集取最强 ' + POOL_TOP_N + ' 名）；限流那批已串行补跑',
    };
    console.log('[range20-precompute] done ' + JSON.stringify(stat));
    return json(stat);
  } catch (e) {
    console.error('[range20-precompute][fatal] ' + (e instanceof Error ? (e.stack ?? e.message) : String(e)));
    return json({ ok: false, reason: e instanceof Error ? e.message : String(e) }, 500);
  }
});
