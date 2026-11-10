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
//                           change_pct / auc_pct_chg，scope='auction'、source='range20'。
//                           ⛔ [AUC-RATIO-NUMCAT-ONLY 2026-11-04] 不含 auc_vol_ratio：竞价量比只认猫抓。
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
const RANGE10_DAYS = 10;                // 10 日涨幅窗口（对齐前端 range-window.js#RANGE_WINDOW_DAYS）
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

/**
 * ★★★ [R10-RANGE-FROM-LEGS 2026-11-01] 用【逐日腿表】补算 `stock_range_pct`（10 日涨幅）。
 *
 * 为什么必须有它（用户 2026-11-01 报障「10 日涨幅也是…历史日期很多也没有」）：
 *   `stock_range_pct` 的唯一写入方是 worker 的 9:25 / 16:00 两轮，**只写当天名单**，
 *   且上游一断就只写几十行。实测 2026-10-08~10-23：每天名单 78~92 只，表里 87~133 行，
 *   **每天都有一批名单票完全没有行**（9 天共 219 条空洞，10-16 一天缺 21 只）。
 *   前端拿不到行 ⇒ 这一列不渲染 ⇒ 用户看到的「只有…三个点」。
 *   而腿表那天是齐的（每天 410 行）⇒ **0 个上游请求**就能算出来。
 *
 * ⚠️ 口径与 20 日**刻意不同**，⛔ 别照抄 `backfillRange20FromLegs`：
 *   · 10 日 = **全局统一窗口** [T-9, T] 共 10 个真实交易日（对齐 `range-window.js#buildRangeRows`），
 *     ⛔ 不是「每票自己最近 10 个有腿日」——那是 20 日的口径，混用会让停牌票算出一个别人无法比较的数；
 *   · 某票窗口内缺某天 ⇒ 那一天不进复利（停牌语义），`days` 如实 < 10（§10：⛔ 不补 0）；
 *   · 历史日期 T 腿 = 当日【收盘涨幅】（腿表 T 那根），⛔ 不拿竞价涨幅冒充。
 *
 * 安全闸（与 20 日同款，一条都不放宽）：
 *   ① 只补【当天名单里缺的票】，已有行一律不覆盖 ⇒ 纯加法、幂等、可反复重跑；
 *   ② 一根腿都没有 ⇒ 不写空行（`compoundPct([]) = null`）；
 *   ③ 腿表里没有该日 ⇒ 假期 / 未开盘 ⇒ 直接返回，⛔ 不伪造整天；
 *   ④ 名单外的一律不写 —— `stock_range_pct` 还喂着龙位 / 决策看板 / 卖点段，⛔ 不扩大爆炸半径。
 */
async function backfillRange10FromLegs(
  targetDate: string,
  opts?: { todayTLeg?: Map<string, number>; overwrite?: boolean },
): Promise<Record<string, unknown>> {
  // ★★★ [R10-CLOUD 2026-11-04] todayTLeg = 「当天这根腿」由调用方直接给（9:25 竞价涨幅）。
  //   为什么需要它：9:25 时 `stock_daily_pct` 里【没有今天这根腿】（那根腿要等收盘后 15:05/16:30
  //   才写），而下面的 ④ 段靠腿表反推真实交易日序列 ⇒ 今天不在序列里 ⇒ 直接 skipped。
  //   代价就是：10 日涨幅在 9:25 永远算不出来，只能等浏览器补算（= 用户「关机就不出票」）。
  //   给了 todayTLeg 之后，今天这根腿从 market_metrics.auc_pct_chg 取，其余 9 根仍走腿表。
  //
  // ★★★ [R10-OVERWRITE 2026-11-04] overwrite = 覆盖当天已有行（仅 9:25 竞价轮用）。
  //   为什么必须能覆盖（实测证据）：11-04 库里那 47 行是浏览器 09:46 写的，
  //   用[腿表 + 竞价 T 腿]重算后与腾讯前复权日线【逐位一致】，而这 47 行里有 8 只偏差极大：
  //     东方海洋 库=29.57 vs 权威=49.80 ｜ 文投控股 库=-6.05 vs 27.81
  //     三峡新材 库=-24.53 vs -15.58 ｜ 青岛食品 库=67.75 vs 75.86
  //   ⇒ 浏览器那次是走兜底腿算的（错值），若还"只补缺"，这 8 只永远修不过来。
  //   安全性：同一天同一口径覆盖，算对的那 39 只写回去还是同一个数（值比较相同不产生漂移）；
  //   而 15:00 之后换收盘腿由 close-pct-cover / 前端负责，本函数不掺和。
  const todayTLeg = (opts && opts.todayTLeg) || null;
  const overwrite = !!(opts && opts.overwrite);
  // ① 该日名单（只补名单内的票，见安全闸④）
  const watch = await sbRest('GET', '/rest/v1/auction_watchlist?select=stock&date=eq.' + targetDate);
  const wanted = new Set<string>();
  for (const r of (Array.isArray(watch) ? watch : []) as Array<Record<string, unknown>>) {
    const s = String(r.stock ?? '').trim();
    if (s) wanted.add(s);
  }
  if (wanted.size === 0) {
    return { date: targetDate, skipped: '当天没有名单（非交易日 / 名单未生成）', written: 0 };
  }

  // ② 该日已有结果（只补缺的）
  const haveSet = new Set<string>();
  for (let from = 0; ; from += LEG_PAGE) {
    const page = await sbRest(
      'GET',
      '/rest/v1/stock_range_pct?select=stock&date=eq.' + targetDate,
      undefined,
      [from, from + LEG_PAGE - 1],
    );
    if (!Array.isArray(page) || page.length === 0) break;
    for (const r of page as Array<Record<string, unknown>>) haveSet.add(String(r.stock ?? '').trim());
    if (page.length < LEG_PAGE) break;
  }

  // ③ 读腿：目标日往前 45 个自然日（足够凑 10 个交易日，国庆这种长假也够）
  const fromYmd = shiftYmd(targetDate, -45);
  const byStock = new Map<string, Map<string, number>>();
  const dateSet = new Set<string>();
  let legRows = 0;
  for (let from = 0; ; from += LEG_PAGE) {
    const page = await sbRest(
      'GET',
      '/rest/v1/stock_daily_pct?select=stock,date,pct&date=gte.' + fromYmd + '&date=lte.' + targetDate
        + '&order=date.asc',
      undefined,
      [from, from + LEG_PAGE - 1],
    );
    if (!Array.isArray(page) || page.length === 0) break;
    legRows += page.length;
    for (const r of page as Array<Record<string, unknown>>) {
      const s = String(r.stock ?? '').trim();
      const d = String(r.date ?? '').slice(0, 10);
      const p = parsePct(r.pct);
      if (!s || !d || p === null) continue;
      dateSet.add(d);
      let m = byStock.get(s);
      if (!m) { m = new Map(); byStock.set(s, m); }
      m.set(d, p);
    }
    if (page.length < LEG_PAGE) break;
  }

  // ④ 真实交易日序列：某天【有任何一只票有腿】⇒ 那天有成交 ⇒ 真交易日
  //   （与前端 `pickRealWindowDates` 同一判据 —— App 日历的 holidays 为空，假期会被当成交易日）
  const dates = Array.from(dateSet).sort();
  // ★ [R10-CLOUD] 9:25 当天腿还没进腿表 ⇒ 序列里没有今天 ⇒ 用调用方给的 T 腿把今天补进序列。
  //   ⚠️ 只在「确实有当天 T 腿」时才补，否则不能凭空造一个交易日（§10）。
  if (dates.indexOf(targetDate) < 0 && todayTLeg && todayTLeg.size > 0) {
    dates.push(targetDate);
    dates.sort();
  }
  const tIdx = dates.indexOf(targetDate);
  if (tIdx < 0) {
    return { date: targetDate, skipped: '腿表里没有这一天（非真实交易日）', written: 0, legRows };
  }
  const win = dates.slice(Math.max(0, tIdx - (RANGE10_DAYS - 1)), tIdx + 1);

  // ⑤ 逐票：窗口内【有腿的日子】进复利；days = 实际腿数（⛔ 缺的那天不补 0）
  const rows: Array<Record<string, unknown>> = [];
  const nowIso = new Date().toISOString();
  let noLeg = 0;
  let noTLeg = 0;
  let overwrote = 0;
  for (const s of wanted) {
    const isExisting = haveSet.has(s);
    if (isExisting && !overwrite) continue;
    const m = byStock.get(s);
    let tLeg: number | null = null;
    if (todayTLeg) {
      const v = todayTLeg.get(s);
      if (v !== undefined) tLeg = v;
    }
    // ★ [R10-CLOUD] 竞价口径下「没有当天竞价涨幅」的票【不写行】——
    //   少了 T 腿的残缺行会让十日涨幅系统性偏低，而十日涨幅直接决定题材量比排序与龙位徽章
    //   （与 worker buildRangePctRows 的 RANGE-FULL-LEG 同口径）。
    //   历史腿缺失只如实记 days（停牌/次新属正常），不因此拒写。
    if (todayTLeg && tLeg === null) { noTLeg++; continue; }
    if (!m && tLeg === null) { noLeg++; continue; }
    const legs: number[] = [];
    for (const d of win) {
      if (todayTLeg && d === targetDate) {
        if (tLeg !== null) legs.push(tLeg);
        continue;
      }
      const v = m ? m.get(d) : undefined;
      if (v === undefined) continue;
      legs.push(v);
    }
    if (legs.length === 0) { noLeg++; continue; }   // §10：一根腿都没有 ⇒ 不写（⛔ 不写 0%）
    let acc = 1;
    for (const p of legs) acc *= (1 + p / 100);
    if (isExisting) overwrote++;
    rows.push({
      date: targetDate,
      stock: s,
      range_pct: ((acc - 1) * 100).toFixed(2),
      days: legs.length,
      updated_at: nowIso,
    });
  }

  let written = 0;
  for (let k = 0; k < rows.length; k += 500) {
    await sbRest('POST', '/rest/v1/stock_range_pct?on_conflict=date,stock', rows.slice(k, k + 500));
    written += Math.min(500, rows.length - k);
  }
  if (written > 0) {
    console.log('[range20-precompute][R10-RANGE-FROM-LEGS] ' + targetDate + ' 名单 ' + wanted.size
      + ' 只 / 已有 ' + haveSet.size + ' 行 → 用腿表写 ' + written + ' 行（窗口 '
      + win[0] + '~' + targetDate + '，无腿 ' + noLeg + ' 只，无T腿 ' + noTLeg + ' 只，'
      + (overwrite ? '覆盖已有 ' + overwrote + ' 行，' : '') + '读腿 ' + legRows + ' 行）');
  }
  return {
    date: targetDate,
    watch: wanted.size,
    hadRows: haveSet.size,
    legRows,
    window: win[0] + '~' + targetDate,
    written,
    overwrote,
    noLeg,
    noTLeg,
    todayTLeg: todayTLeg ? todayTLeg.size : 0,
    note: '10 日涨幅补算（buildRangeRows 同口径，0 上游请求）；无腿/无T腿不写'
      + (overwrite ? '；竞价轮覆盖已有行（修正浏览器兜底腿算出的错值）' : ''),
  };
}

/**
 * ★★ [R20-LEGS 2026-11-01] 腾讯前复权日线 —— 「补腿」专用通道（与同花顺解耦）。
 *
 * 为什么必须加（用户 2026-11-01 00:38 原话：「不要在电脑本地补，要在云端运行，放在 supabase 上定时任务，
 *   因为我都是用手机盯盘操作的」）：
 *   15:05 收盘轮写「今天这根腿」**唯一依赖同花顺**（见 ④ 段 `legBuffer`），上游一断
 *   ⇒ `legsWritten=0` ⇒ 那天在 stock_daily_pct 里一行都没有 ⇒ 次日 20 日窗口**静默跳过一天**
 *   （compound20 把「没写」当成「停牌」，不报错、不显示，最难查）。10-30 实测只剩 42 行（正常 411 行）。
 *
 * 口径可信度（已验证，不是「应该一样」）：见 db/scripts/backfill-daily-pct.mjs 文件头 ——
 *   12 只 × 44 天 = 524 条与库里同花顺 src='kline' 真值逐条比对，±0.02 内 **100% 一致**。
 *   ⛔ 落库必须标 `src='qt'`，不许冒充 `'kline'`（保留可追溯来源）。
 *
 * ⛔ 与 `fetchKlineBars` 的区别：这条通道**不经 fuyao-proxy**，直连腾讯，因此不受
 *   「同花顺通道停用（FUYAO-OFF）」和 Edge Function 代理层挂死的影响。
 */
async function fetchQtBars(code: string, startYmd: string, endYmd: string): Promise<Bar[]> {
  const c = String(code || '').trim();
  if (!/^\d{6}$/.test(c)) throw new Error('代码不合法: ' + code);
  const sym = (/^(6|9)/.test(c) ? 'sh' : (/^(4|8|92)/.test(c) ? 'bj' : 'sz')) + c;
  const url = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=' +
    sym + ',day,' + startYmd + ',' + endYmd + ',320,qfq';
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(400 * attempt);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://gu.qq.com/' },
        signal: ctrl.signal,
      });
      if (!resp.ok) throw new Error('qt HTTP ' + resp.status);
      const j = await resp.json();
      const d = (j && j.data && j.data[sym]) || {};
      const rows = d.qfqday || d.day || [];
      const out: Bar[] = [];
      for (const b of rows as unknown[]) {
        const arr = b as unknown[];
        const dt = String((arr && arr[0]) || '').slice(0, 10);
        const close = Number(arr && arr[2]);
        if (!dt || !Number.isFinite(close) || close <= 0) continue;
        // ★★ [R20-METRICS-QT 2026-11-01] 顺带保留 open / volume：
        //   bar 格式 [日期, open, close, high, low, volume(手)]。
        //   · open  → dayMetricsOf 的 openPct（竞价涨幅，open/昨收-1）；
        //   · volume(手) × 100 = 股（与 barsToSeries 的 vol 同单位、同「÷1e4 = 万股」约定）。
        //   量纲已核对：九阳股份 10-27 腾讯 1,286,639 手 = 12,866 万股 ≈ worker 库内 yest_volume 12,882。
        const openRaw = arr && arr[1] == null ? null : Number(arr[1]);
        const open = openRaw != null && Number.isFinite(openRaw) && openRaw > 0 ? openRaw : null;
        const volRaw = arr && arr[5] == null ? null : Number(arr[5]);
        const vol = volRaw != null && Number.isFinite(volRaw) && volRaw >= 0 ? volRaw * 100 : null;
        out.push({ ymd: dt, close, open, vol });
      }
      out.sort((a, b) => (a.ymd < b.ymd ? -1 : a.ymd > b.ymd ? 1 : 0));
      // 空序列 = 该票在这段区间没有 bar（停牌 / 北交所不支持）⇒ 交给上层判定，⛔ 不写 0%
      if (out.length === 0) throw new Error('qt 空序列');
      return out;
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
//   ⛔ auc_vol_ratio：**本函数不产出**。竞价量比只认猫抓 daily_auc（用户 2026-10-26 / 11-04 口径：
//      「永远不要用同花顺获取数据的竞价量比数据」）。同花顺 auction_volume_ratio 与猫爪不同源，
//      掺进来就是错数据，而下游拿它当选票依据 ⇒ 宁可留空（§10）。
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
  // ⛔ [AUC-RATIO-NUMCAT-ONLY 2026-11-04] 刻意**不读** snap.auction_volume_ratio：
  //   竞价量比唯一合法来源是猫抓 daily_auc（结算后由 backfillDisplayFromNumcat 回填）。见上方口径注记。

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
    // ⛔ 刻意不返回 auc_vol_ratio —— 见上方口径注记（同花顺量比永不入库）。
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
//   ① 回看 i=0..8 天（**含当天**）：当天那根能不能写，完全由闸③ 的「收盘轮证据」决定；
//   ② 只【新增】缺的票：已有 (date,stock) 的（尤其是 kline 真值）一律不碰 ⇒ 纯加法，绝不覆盖；
//   ③ 【必须有「收盘轮写过」的证据】才写：`updated_by` 含 'close' 且 `updated_at` 晚于当日北京 15:00。
//      ⚠️ 2026-11-01 修正：旧判据是「change_pct == auc_pct_chg ⇒ 跳过」，实测会误杀真一字板
//      （10-30 上海沪工/东贝集团/凯众股份/赛福天/青岛食品 竞价即封板，竞价涨幅就是收盘涨幅，
//        且 updated_by 全是 'auto-fetch-worker-close'）。⛔ 这不是放宽红线，是换成更精确的证据链。
// ════════════════════════════════════════════════════════════════════════════════
const HEAL_LOOKBACK_DAYS = 8;   // 只回看最近 8 个自然日（覆盖周末 + 小长假，够用且请求量恒定）

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
  // ★★ [R20-HEAL-FIX 2026-11-01] 从 i=0 开始 —— **含当天**。
  //   旧实现 i=1 起 ⇒ 当天的腿永远进不来，必须等第二天那次 heal 才补得上；
  //   结果「今天收盘后到明天 9:25 之前」这一段窗口里，腿表一直是缺当天的。
  //   ⛔ 放开当天安全吗？安全 —— 闸③ 要求 updated_by 含 'close' 且 updated_at >= 北京 15:00：
  //     · 15:05 收盘轮跑时 worker 16:00 还没更新 ⇒ updated_by 仍是竞价轮标记 ⇒ 全部拒绝（不会把竞价当收盘）
  //     · 16:30 / 次日 9:25 跑时 worker 已更新 ⇒ 才写得进去
  for (let i = 0; i <= HEAL_LOOKBACK_DAYS; i++) {
    const d = shiftYmd(today, -i);
    try {
      const metrics = await sbRest(
        'GET',
        '/rest/v1/market_metrics?select=stock,change_pct,auc_pct_chg,updated_by,updated_at&date=eq.' + d
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
      // ★★★ [R20-HEAL-FIX2 2026-11-01] 判据必须【逐只比】，⛔ 绝不能比总数。
      //   实测：`stock_daily_pct` 一天是 410~412 行（**全市场历史名单并集**），
      //   而 `market_metrics` 同一天只有 48~92 行（**当天名单**）⇒
      //   `haveSet.size >= metrics.length`（411 >= 48）**恒真** ⇒ 每天都被判「已齐」，
      //   整个自愈形同虚设。这是 10-30 缺口一直补不上的第四个原因（也是最后一个）。
      //   正确做法：只问「metrics 这批票，还有几只没有腿」，0 才算齐。
      let missingCnt = 0;
      for (const r of metrics) {
        const s = String((r && r.stock) ?? '').trim();
        if (s && !haveSet.has(s)) missingCnt++;
      }
      if (missingCnt === 0) {
        out.push({ date: d, metrics: metrics.length, legs: haveSet.size, action: 'ok' });
        continue;
      }
      const rows: Array<Record<string, unknown>> = [];
      for (const r of metrics) {
        const s = String((r && r.stock) ?? '').trim();
        if (!s || haveSet.has(s)) continue;                 // 闸②：已有的一律不碰（纯新增）
        const c = parsePct(r.change_pct);
        if (c === null) continue;                           // §10：缺值不写（⛔ 不当 0%）
        // ★★ 闸③ [R20-HEAL-FIX 2026-11-01] 旧判据「change_pct == auc_pct_chg ⇒ 跳过」会**误杀真一字板**：
        //   2026-10-30 实测上海沪工 +10.03% / 东贝集团 -10.00% / 凯众股份 -10.02% / 赛福天 -10.04% /
        //   青岛食品 +9.98% —— 竞价即封板、全天不动，竞价涨幅 == 收盘涨幅是【真值】，
        //   而它们的 updated_by 明确写着 'auto-fetch-worker-close'（全表 48/48 都带 close 标记）。
        //   ⇒ 改看 updated_by / updated_at：worker 16:00 收盘轮会写 '*-close' 并把 updated_at 推到 16:00。
        //   ⛔ 这不是放宽红线，是换成**更精确**的证据：拿不出收盘轮证据的，照样一条都不写。
        const by = String((r && r.updated_by) ?? '');
        if (by.indexOf('close') < 0) continue;              // 9:25 竞价轮写的行 ⇒ 不写
        const updMs = Date.parse(String((r && r.updated_at) ?? ''));
        // 必须晚于当日北京 15:00（收盘定格）才认 —— 与 legFinal 判据同源
        if (!Number.isFinite(updMs) || updMs < Date.parse(d + 'T15:00:00+08:00')) continue;
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

/**
 * ★★★ [R20-RANGE-FROM-LEGS 2026-11-01] 用【逐日腿表】补算 `stock_range20_pct`（收盘口径）。
 *
 * 为什么必须有它（用户 2026-11-01 00:5x 报障「20 日涨幅只剩三个点…，排名变化却有数值」）：
 *   15:05 收盘轮算 close 口径时 `canFast=false`（见 868 行注释）⇒ **一律走同花顺 K 线**。
 *   同花顺一断，那一轮只写得出几十行。实测 2026-10-30：`stock_range20_pct` close 只有 50 行，
 *   而 10-29 及之前每天都是 410~413 行 ⇒ 前端点开 20 日涨幅，绝大多数票没有云端数据、
 *   又要现场打 K 线（同样断）⇒ 只剩下两三个点。
 *
 *   而腿表其实已经够了：实测 10-30 的 411 只票里 **405 只**都有完整 19 根历史腿 + 当天那根，
 *   完全可以用 `rangeFromLegs` 的同一套复利口径算出来，**0 个上游请求**。
 *
 * 安全闸：
 *   ① 只补缺的 (date,stock)，已有行一律不覆盖（尤其 K 线算出来的真值）⇒ 纯加法、幂等；
 *   ② 腿数 < 19 ⇒ 不算（`rangeFromLegs` 内部就返回 null，⛔ 绝不拿半截算、绝不写 0）；
 *   ③ T 腿必须就是目标日那根（腿表里的真收盘涨幅），⛔ 不拿竞价涨幅冒充；
 *   ④ 写 leg='close'，与收盘轮同一主键 (date,stock,leg) 语义 —— 前端按 leg 过滤即可命中。
 */
/**
 * ★★★ [AUC-VOL-LIST 2026-11-04] 第一页「今天会被渲染出来」的股票并集（name → code；缺码给空串）。
 *
 * 【为什么必须按名单取，而不是按「库里已有的行」取】
 *   `market_metrics` 当天只有 worker 写的那批（实测 11-04 `source={"worker":56}`、`range20` 0 行）
 *   ⇒ 20 日补位票 / 龙头组壳行**整行不存在** ⇒ 无论怎么「补空值」都补不到它们 ⇒ 永远显示 '-'。
 *   ⇒ 唯一可靠的做法：把第一页的四个注入源并起来，再逐只检查「有没有行 / 值真不真」。
 *
 * 四个来源（与前端 view 层四个注入源一一对应，缺一类那一类就必然 '-'）：
 *   ① 正式成员 + 观察组（obs_auto_added 也在同一张表）→ auction_watchlist(date = 目标日)
 *   ② 20 日补位 / 龙头候选 → stock_range20_pct(date = 目标日)（= 本轮 targets 算出来的名单）
 *      前端 `getRange20Leaders` 读的就是这张表，所以它天然覆盖「20天」标签的那批票。
 *   ③ 龙头组：展示日 D 的龙头 = 名册里 date = **前一交易日** 的行（口径见 create_dragon_leaders.sql）
 *   ④ 已有 metrics 行的票：由调用方合并（本函数不重复读同一张表，§32）
 *
 * 安全：任一类读失败只降级那一类（§10 失败可见、⛔ 不扩大爆炸半径），⛔ 不让整轮补写失效。
 */
async function readTodayDisplayStocks(today: string, prevDateOverride?: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const put = (stock: unknown, code: unknown) => {
    const s = String(stock ?? '').trim();
    if (!s) return;
    const c = String(code ?? '').trim();
    const okCode = /^\d{6}$/.test(c);
    if (!out.has(s)) out.set(s, okCode ? c : '');
    else if (!out.get(s) && okCode) out.set(s, c);
  };
  const grab = async (path: string, label: string): Promise<void> => {
    try {
      const rows = await sbRest('GET', path);
      for (const r of (Array.isArray(rows) ? rows : []) as Array<Record<string, unknown>>) {
        put(r && r.stock, r && r.code);
      }
    } catch (e) {
      console.error('[range20-precompute][AUC-VOL-LIST] ' + label + ' 读取失败（该类降级为空）: '
        + (e instanceof Error ? e.message : String(e)));
    }
  };
  // ① 正式成员 + 观察组
  await grab('/rest/v1/auction_watchlist?select=stock,code&date=eq.' + today + '&limit=2000', '名单');
  // ② 20 日补位候选（结果表没有 code 列，靠后面的 stockcodemap 批查补）
  await grab('/rest/v1/stock_range20_pct?select=stock&date=eq.' + today + '&limit=2000', '20日结果表');
  // ③ 龙头组 = 前一交易日名册（历史窗口回补时由调用方直接给，省掉一次探测）
  let prevDate = String(prevDateOverride ?? '').trim();
  if (!prevDate) {
    try {
      const prev = await sbRest(
        'GET',
        '/rest/v1/auction_watchlist?select=date&date=lt.' + today + '&order=date.desc&limit=1',
      );
      const first = (Array.isArray(prev) ? prev[0] : null) as Record<string, unknown> | null;
      prevDate = first ? String(first.date ?? '').slice(0, 10) : '';
    } catch (e) {
      console.error('[range20-precompute][AUC-VOL-LIST] 前一交易日探测失败: '
        + (e instanceof Error ? e.message : String(e)));
    }
  }
  if (prevDate) {
    await grab('/rest/v1/dragon_leaders?select=stock,code&date=eq.' + prevDate + '&limit=200', '龙头名册');
  } else {
    console.warn('[range20-precompute][AUC-VOL-LIST] 找不到前一交易日 ⇒ 本轮不含龙头组（该组可能仍显示 -）');
  }
  return out;
}

/**
 * 名单里缺 code 的票，批量补 code（name→code 的唯一真相源 §6）。
 *
 * 两级来源（2026-11-04 实测：11-04 有 4 只票在 stockcodemap 里**根本没有记录**
 *   —— 上海洗霸 / 杰克科技 / 万向钱潮 / 大洋电机 ⇒ 只查一张表就永远补不上，这 4 只恒为 '-'）：
 *   ① `stockcodemap`（权威映射）；
 *   ② 兜底：`market_metrics` 里这些票**历史行的 code 列**（它们以前进过名单，一定有代码）。
 *      ⛔ 不猜、不按代码段硬编：仍只认「库里出现过的 6 位码」。
 * ⛔ 不用「全表分页读」：名单通常只有几只缺码，全表扫几百~几千行纯属浪费（§32）。
 */
async function fillCodesFromStockcodemap(map: Map<string, string>): Promise<number> {
  const missingOf = () => Array.from(map.entries())
    .filter(([, c]) => !/^\d{6}$/.test(c))
    .map(([s]) => s);
  let fixed = 0;
  const run = async (path: string, label: string) => {
    const todo = missingOf().slice(0, 200);
    if (todo.length === 0) return;
    for (let i = 0; i < todo.length; i += 60) {
      const names = todo.slice(i, i + 60).map((n) => '"' + n.replace(/"/g, '') + '"');
      try {
        const rows = await sbRest('GET', path + '&stock=in.' + encodeURIComponent('(' + names.join(',') + ')'));
        for (const r of (Array.isArray(rows) ? rows : []) as Array<Record<string, unknown>>) {
          const n = String((r && r.stock) ?? '').trim();
          const c = String((r && r.code) ?? '').trim();
          if (n && /^\d{6}$/.test(c) && map.has(n) && !map.get(n)) { map.set(n, c); fixed++; }
        }
      } catch (e) {
        console.error('[range20-precompute][AUC-VOL-LIST] ' + label + ' 批查失败: '
          + (e instanceof Error ? e.message : String(e)));
      }
    }
  };
  // ① 权威映射表
  await run('/rest/v1/stockcodemap?select=stock,code', 'stockcodemap');
  // ② 兜底：历史行情行里的 code（表里没登记的票只能靠它）
  await run('/rest/v1/market_metrics?select=stock,code&code=not.is.null&limit=400', 'market_metrics 历史行');
  if (fixed > 0) console.log('[range20-precompute][AUC-VOL-LIST] 补码 ' + fixed + ' 只');
  return fixed;
}

/**
 * ★★★ [AUC-VOL-HEAL 2026-11-04] 补当天「竞价量 volume / 昨日成交量 yest_volume」两个列。
 *
 * 【用户报障原话】「早盘竞价看板的第一页的昨日成交量和竞价量列很多股票显示横杠 -，
 *   趋势图有数据为什么没显示出来，你又没修复。我之前都说了」
 *
 * 【取证 2026-11-04，market_metrics 当天 auction 56 行】
 *   · 32 行 `volume='0'` 且 `yest_volume=null`；
 *   · 而这 32 行的 `auc_vol_ratio` 分别是 5.43 / 15.29 / 21.49 / 144.88 …
 *   ⇒ 量比 = 竞价量 ÷ 基准量，**分子真为 0 时量比不可能是 5.43** ⇒ 竞价量不是 0，是写入时丢了。
 *   ⇒ 趋势图能画，是因为它走「同花顺快照 + K 线」现算；列表列只读库 ⇒ 库里是 0 就只能显示 '-'。
 *
 * 【本函数做什么】把这两列在**云端**补成真值 —— 补一次，全天所有人打开都是对的，
 *   手机端零等待、不需要用户开电脑，也不依赖 worker 是否升级。
 *   · volume      ← 同花顺快照 auction_volume（手）÷100 = 万手（与 worker 同口径）
 *   · yest_volume ← 腾讯前复权日线「今天之前最后一根」的成交量 ÷1e4 = 万股
 *     （量纲已核对：九阳股份 1,286,639 手 = 12,866 万股 ≈ worker 库内 yest_volume 12,882）
 *   换算全部复用 `dayMetricsOf`（它已经处理好「9:25 时今天还没有 bar ⇒ 取最后一根」那个坑）。
 *
 * 【安全（一条都不放宽）】
 *   · 只写 volume / yest_volume 两列，upsert 用 merge-duplicates ⇒ 绝不抹 change_pct / auc_vol_ratio；
 *   · 只用真值（>0）覆盖 0/空，⛔ 绝不把 0 再写回去（那正是造出假 0 的来源）；
 *   · 快照必须过双重闸门（data_status==='final' 且服务端北京日期 === 目标日）；
 *   · 任一上游失败只记日志、继续其它票，⛔ 不连坐（§10：失败可见但不扩大爆炸半径）。
 */
// ⚠️ `export` 只为单测/离线预演（与 dayMetricsOf 同款用法）：Edge Function 里 export 不影响 Deno.serve。
export async function healTodayVolume(today: string, leg: string): Promise<Record<string, unknown>> {
  // 1) 读当天全部竞价行（分页取全，Supabase 单次上限 1000）
  const all: Array<Record<string, unknown>> = [];
  for (let from = 0; ; from += 1000) {
    const page = await sbRest(
      'GET',
      '/rest/v1/market_metrics?select=stock,code,volume,yest_volume'
        + '&date=eq.' + today + '&scope=eq.auction&order=stock.asc',
      undefined,
      [from, from + 999],
    );
    if (!Array.isArray(page) || page.length === 0) break;
    all.push(...(page as Array<Record<string, unknown>>));
    if (page.length < 1000) break;
  }

  const isEmpty = (v: unknown) => v === null || v === undefined || String(v).trim() === '';
  const rowOf = new Map<string, { code: string; vol: unknown; yest: unknown }>();
  for (const r of all) {
    const s = String(r.stock ?? '').trim();
    if (!s) continue;
    rowOf.set(s, {
      code: String(r.code ?? '').trim(),
      vol: r.volume,
      yest: r.yest_volume,
    });
  }

  // 2) ★ [AUC-VOL-LIST 2026-11-04] 第一页【真正会渲染的票】并集 —— 这是上一轮漏掉的半边天。
  //   上一轮只补「库里有行、但两列是空/0」的票（32 只），完全没管**整行都不存在**的票：
  //   实测 11-04 的 `source` 分布 = `{"worker": 56}`、`range20` **0 行** ⇒ 20 日补位票
  //   （九阳股份 +101.41% / 海洋王 +78.46% / 新华传媒 +74.36%）与龙头组壳行（凯众股份）
  //   在 market_metrics 里【一行都没有】⇒ 列表列永远 '-'
  //   （趋势图能画，是因为它走 snapshot+K线现算，压根不读这两列）。
  //   ⇒ 名单必须按四个注入源取全（见 readTodayDisplayStocks），缺哪一类，那一类就必然 '-'。
  const list = await readTodayDisplayStocks(today);
  // 库里有行、但名单里没有的票：并进来（保持既有行为 —— 这类历史遗留行照旧补值，只是不新建）
  for (const [s, v] of rowOf) {
    if (!list.has(s)) list.set(s, /^\d{6}$/.test(v.code) ? v.code : '');
    else if (!list.get(s) && /^\d{6}$/.test(v.code)) list.set(s, v.code);
  }
  const codeFixed = await fillCodesFromStockcodemap(list);
  if (list.size === 0) return { skipped: '当天没有名单（非交易日 / 名单未落库）', total: all.length, written: 0 };

  // 3) 需要补的票 = 「整行缺失」 ∪ 「有行但两列缺/假 0」
  // '0' 也算「缺」：竞价量为 0 万手在早盘等同没成交，且必然伴随量比为 0（§10 不写假 0）
  // ⚠️ [§11 不越界] 「整行新建」只对【当天】开放：历史日的 market_metrics 是当年归档，
  //    事后补建行 = 改写历史（且那些日期前端根本不显示竞价量列）⇒ 历史日只补已有行的空值。
  const canCreate = today === todayYmd();
  const need: Array<{ stock: string; code: string; hasRow: boolean; vol: unknown; yest: unknown }> = [];
  let noCode = 0;
  let histSkipped = 0;
  for (const [stock, code] of list) {
    const c = /^\d{6}$/.test(code) ? code : '';
    if (!c) { noCode++; continue; }   // 没代码 ⇒ 两条上游都调不了，如实计入 noCode（⛔ 不静默吞）
    const row = rowOf.get(stock);
    if (!row) {
      if (!canCreate) { histSkipped++; continue; }
      need.push({ stock, code: c, hasRow: false, vol: null, yest: null });
      continue;
    }
    const volMissing = isEmpty(row.vol) || Number(row.vol) === 0;
    const yestMissing = isEmpty(row.yest);
    if (!volMissing && !yestMissing) continue;
    need.push({ stock, code: c, hasRow: true, vol: row.vol, yest: row.yest });
  }
  const newCount = need.filter((t) => !t.hasRow).length;
  if (need.length === 0) {
    return {
      skipped: '第一页名单的竞价量与昨日成交量已齐', total: rowOf.size, list: list.size,
      missing: 0, written: 0, codeFixed, noCode, histSkipped,
    };
  }

  // 4) 日线（昨日成交量的唯一来源）：dayMetricsOf 只要「今天 + 上一交易日」，窗口 45 自然日够覆盖长假/停牌
  //
  //    🔴 [AUC-VOL-LEG 2026-11-04] **必须有两条腿，且腾讯优先、同花顺兜底** —— 实测教训：
  //      腾讯 `web.ifzq.gtimg.cn` 会按 IP 打 WAF（本机 2026-11-04 直接 501 跳到
  //      `waf.tencent.com/501page.html`，47 只票 0 成功），而同一条机器上经 Supabase
  //      `fuyao-proxy` 取同花顺日 K 是 200 / 522ms 正常。
  //      上一版只有腾讯一条腿 ⇒ 一旦腾讯拦了，`yest_volume` 全部补不出来（32 只空白照旧）。
  //      同花顺腿与 worker 的 `yest_volume` 同源同口径（股 ÷ 1e4 = 万股），适合做兜底。
  //    ⚠️ 腾讯连续失败 3 只就【整体降级】为同花顺，不再拿 45 个 501 白等（省时间、少噪声）。
  const fromYmd = shiftYmd(today, -45);
  const seriesByCode = new Map<string, Bar[]>();
  const kStartMs = Date.parse(fromYmd + 'T00:00:00+08:00');
  const kEndMs = Date.parse(today + 'T00:00:00+08:00') + 86400000 - 1;
  let qtFail = 0;
  let thsFail = 0;
  let qtStreak = 0;
  let qtDead = false;
  const QT_CONC = 6;
  for (let i = 0; i < need.length; i += QT_CONC) {
    const chunk = need.slice(i, i + QT_CONC);
    await Promise.all(chunk.map(async (t) => {
      // ① 腾讯前复权日线（快、无额度）
      if (!qtDead) {
        try {
          const s = await fetchQtBars(t.code, fromYmd, today);
          if (s.length > 0) { seriesByCode.set(t.code, s); qtStreak = 0; return; }
        } catch (e) {
          qtFail++;
          qtStreak++;
          // ⚠️ 并发 6 会让多只同时跨过阈值 ⇒ 只在【第一次】置位时打日志，别刷 6 条
          if (qtStreak >= 3 && !qtDead) {
            qtDead = true;
            console.warn('[range20-precompute][AUC-VOL-LEG] 腾讯连续 ' + qtStreak
              + ' 只失败 ⇒ 本轮整体降级为同花顺腿（' + (e instanceof Error ? e.message : String(e)) + '）');
          }
        }
      }
      // ② 同花顺日 K（经 fuyao-proxy；与 worker 同源）
      try {
        const series = barsToSeries(await fetchKlineBars(thscode(t.code), kStartMs, kEndMs));
        if (series.length > 0) seriesByCode.set(t.code, series);
      } catch (e) {
        thsFail++;
        console.error('[range20-precompute][AUC-VOL-LEG] ' + t.stock + '(' + t.code
          + ') 同花顺日线失败: ' + (e instanceof Error ? e.message : String(e)));
      }
    }));
  }

  // 5) 当日竞价快照。⚠️ `fetchSnapshots` 单次只取 `thscodes.slice(0, 40)` ⇒ 必须分批，
  //    否则名单超过 40 只时后面的票会【静默拿不到竞价量】（这批正好 32 只也要防以后扩容）。
  //    ⚠️ 闸门判定改成「按所有成功批次」：上一版只取 i===0 那一批的状态，
  //    第一批恰好失败就会把整轮快照判成不可用（名单越大越容易踩，§10 失败不该扩大半径）。
  let snapOk = false;
  let snapNote = '';
  const snapByCode = new Map<string, Record<string, unknown>>();
  try {
    let okChunks = 0;
    let failChunks = 0;
    let badStatus = '';
    let serverYmdSeen = '';
    let anyErr = '';
    for (let i = 0; i < need.length; i += 40) {
      const chunk = need.slice(i, i + 40);
      const s = await fetchSnapshots(chunk.map((t) => thscode(t.code)));
      if (s.error) { anyErr = s.error; failChunks++; continue; }
      okChunks++;
      if (!serverYmdSeen) serverYmdSeen = s.serverYmd;
      if (s.dataStatus !== 'final' || s.serverYmd !== today) badStatus = s.dataStatus;
      s.byCode.forEach((v, k) => snapByCode.set(k, v));
    }
    if (okChunks === 0) snapNote = '快照请求失败: ' + (anyErr || '全部批次失败');
    else if (badStatus || serverYmdSeen !== today) {
      snapNote = '快照闸门拒绝（status=' + (badStatus || '?') + ' 服务端日=' + serverYmdSeen
        + ' 目标日=' + today + '）⇒ 本次只补昨日成交量（K 线可得），竞价量留空';
    } else snapOk = true;
    if (snapOk && failChunks > 0) snapNote = '部分批次快照失败 ' + failChunks + ' 批（其余已补）';
  } catch (e) {
    snapNote = '快照异常: ' + (e instanceof Error ? e.message : String(e));
  }

  // 4) 组装
  //   · hasRow=true  → 只写 volume / yest_volume（⛔ 绝不碰 worker 写的 change_pct / auc_vol_ratio）
  //   · hasRow=false → 整行新建（四个字段一起给），这是「补位票 / 龙头组壳行永远 '-'」的唯一解法
  const nowIso = new Date().toISOString();
  const out: Array<Record<string, unknown>> = [];
  let volFixed = 0;
  let yestFixed = 0;
  let rowsNew = 0;
  let noSrc = 0;
  for (const t of need) {
    const series = seriesByCode.get(t.code) || null;
    const s = snapOk ? (snapByCode.get(t.code) ?? null) : null;
    if (!series && !s) { noSrc++; continue; }     // 两条腿都没有 ⇒ 这只没救，跳过
    // ⚠️ 故意传 `series || []`：没有 K 线时 dayMetricsOf 会返回 volume（来自快照）+
    //    yest_volume=null，正好是「能补多少补多少」，不整只放弃。
    const m = dayMetricsOf(series || [], today, leg, s);
    const patch: Record<string, unknown> = {
      date: today, stock: t.stock, code: t.code, scope: 'auction',
      source: 'range20', updated_at: nowIso,
    };
    let any = false;
    const volMissing = isEmpty(t.vol) || Number(t.vol) === 0;
    // ⚠️ volume 不走 dayMetricsOf 的 fmtNum（那是 Math.round 取整）：
    //   取整会把竞价量 <50 手的小票抹成 0 —— **那正是假 0 的来源之一**。
    //   这里保留 1 位小数，与新版 worker（Math.round((手/100)*10)/10）完全同口径，可逐位比对。
    const handN = s ? Number(s.auction_volume) : NaN;
    if (volMissing && Number.isFinite(handN) && handN > 0) {
      patch.volume = String(Math.round((handN / 100) * 10) / 10);
      any = true; volFixed++;
    }
    if (isEmpty(t.yest) && m.yest_volume != null && Number(m.yest_volume) > 0) {
      patch.yest_volume = m.yest_volume; any = true; yestFixed++;
    }
    if (!t.hasRow) {
      // 整行新建：补齐「涨幅 / 竞价涨幅 / 竞价量比」，否则建出来的行仍然只有两列，
      // 前端的趋势图与「占比」还是缺半边（§6 一次写全，别留半成品）。
      // ⚠️ 只有 volume 为空串（假 0）时才认 m.volume —— 它经过 fmtNum 取整，<0.5 万手会被抹成 0。
      if (patch.volume === undefined && m.volume != null && Number(m.volume) > 0) {
        patch.volume = m.volume; any = true; volFixed++;
      }
      if (patch.yest_volume === undefined && m.yest_volume != null && Number(m.yest_volume) > 0) {
        patch.yest_volume = m.yest_volume; any = true; yestFixed++;
      }
      if (m.change_pct != null) patch.change_pct = m.change_pct;
      if (m.auc_pct_chg != null) patch.auc_pct_chg = m.auc_pct_chg;
      // ⛔⛔ [AUC-RATIO-NUMCAT-ONLY 2026-11-04 用户第 6 次报障] 这里原本写过
      //    `patch.auc_vol_ratio = m.auc_vol_ratio`（同花顺快照的 auction_volume_ratio），**已删除**。
      //    用户原话：「我都说竞价期间不用同花顺量比，收盘也不要用，我只要猫爪数据接口的竞价量比
      //    数据，这是最权威的…为什么把同花顺的竞价量比填上去呢？这会造成数据错误明白吗？
      //    永远不要用同花顺获取数据的竞价量比数据。」
      //    ⇒ 建行时**不再带量比列**：宁可这一列空着（§10），也绝不写一个不同源的数字。
      //      量比由 16:30 的 `backfillDisplayFromNumcat`（猫抓 daily_auc，source='numcat'）回填。
      // 连一个真值都没有 ⇒ ⛔ 不建行（空行只会制造「有行但没数」的新假象）
      if (patch.volume === undefined && patch.yest_volume === undefined) {
        noSrc++;
        continue;
      }
      rowsNew++;
      out.push(patch);
      continue;
    }
    if (any) out.push(patch);
  }

  // 5) 落库
  //
  // 🔴 [AUC-VOL-UPSERT 2026-11-04] **同一批 POST 里每个对象的键集必须完全一致** ——
  //    PostgREST 对 `[{a,b},{a}]` 这种「键集不齐」的批量直接 400：
  //      {"code":"PGRST102","message":"All object keys must match"}
  //    ⚠️ 这是上一版真机上「一行都没写进去」的隐藏杀手：补值行有的只有 volume、
  //    有的只有 yest_volume、新建行还多三个字段 ⇒ 整批被拒，而 try/catch 之外只看到 400，
  //    很容易误判成「上游没数据」。⇒ 按「键集签名」分桶，每桶单独 POST（纯加法，语义不变）。
  const buckets = new Map<string, Array<Record<string, unknown>>>();
  for (const row of out) {
    const sig = Object.keys(row).sort().join(',');
    const arr = buckets.get(sig);
    if (arr) arr.push(row);
    else buckets.set(sig, [row]);
  }
  let written = 0;
  for (const rows of buckets.values()) {
    for (let k = 0; k < rows.length; k += 500) {
      await sbRest('POST', '/rest/v1/market_metrics?on_conflict=date,stock,scope', rows.slice(k, k + 500));
      written += Math.min(500, rows.length - k);
    }
  }
  if (written > 0) {
    console.log('[range20-precompute][AUC-VOL-HEAL] ' + today + ' 名单 ' + list.size + ' 只 / 待补 '
      + need.length + ' 只（整行缺失 ' + newCount + '）→ 写 ' + written + ' 行（新建 ' + rowsNew
      + '，竞价量 ' + volFixed + ' / 昨日成交量 ' + yestFixed + '，键集 ' + buckets.size + ' 桶'
      + (qtDead ? '，腾讯已降级' : '') + '，同花顺日线失败 ' + thsFail
      + '，快照 ' + (snapOk ? 'final' : '未用') + (snapNote ? '，' + snapNote : '') + '）');
  } else {
    console.log('[range20-precompute][AUC-VOL-HEAL] ⚠️ 待补 ' + need.length + ' 只但无一行可写'
      + '（无上游 ' + noSrc + ' 只，腾讯失败 ' + qtFail + ' / 同花顺失败 ' + thsFail + ' 只）'
      + (snapNote ? '，' + snapNote : ''));
  }
  return {
    total: rowOf.size, list: list.size, missing: need.length, newRows: newCount,
    written, rowsNew, volFixed, yestFixed, noSrc, noCode, codeFixed, histSkipped,
    qtFail, thsFail, qtDead, buckets: buckets.size,
    snapshot: snapOk ? 'final' : (snapNote || '未用'),
    note: '名单 = watchlist ∪ 20日结果表 ∪ 龙头名册 ∪ 已有行；有行只补 volume/yest_volume，无行整行新建',
  };
}

// ════════════════════════════════════════════════════════════════════════════
// ★★★ [AUC-VOL-NUMCAT 2026-11-04] 用【猫抓 daily_auc】把「四类行」近 N 个交易日的
//   竞价量 / 竞价量比 / 竞价涨幅 一次性回补进 `market_metrics`。
//
// 【用户口径（2026-11-04 原话）】
//   「今天的竞价量比是同花顺还是猫抓数据接口获取的，我之前要求是一定要猫抓数据接口，
//     不要用同花顺，因为同花顺的不准。」
//   「九阳股份五日趋势图前几天没有竞价量比和竞价量」「新华传媒也是前几天缺失数据」
//   「怎么彻底解决这个问题，就是龙头组，观察组，20日补上去的，同花顺最近多板源，
//     一起可以正常获取数据，并存起来」
//
// 【为什么「前几天」必然全空 —— 两个原因叠加，缺一不可】
//   ① 竞价量 / 竞价量比是 9:25 那一刻的**瞬时值**：日 K 线里没有（K 线只有全天量），
//      过了当天连同花顺快照也不再给 ⇒ 历史上只有猫抓 daily_auc 存了它（前端「补全竞价数据」
//      按钮就是靠 `daily_auc` 的 startdate/enddate **连抓多天**）。
//   ② worker 的四要素补漏（workers/.../logic/extras-workflow.js）只补「库内【已有行】」，
//      而 20 日补位票 / 龙头组壳行（九阳股份、新华传媒…）不在「同花顺最近多板 883410」
//      成分股里 ⇒ worker 9:25 的抓取名单从来没有它们 ⇒ 那几天**一行都没有**
//      ⇒ 「补空值」的逻辑永远碰不到它们 ⇒ 趋势图前几天必然断点（`--`）。
//
// 【本函数做什么（每天 1 次猫抓额度，覆盖整个窗口）】
//   ① 取最近 N 个交易日：`auction_watchlist` 的 distinct date（与名单同源，不需要交易日历）；
//   ② 逐日算「四类行名单」并集 —— 与 `readTodayDisplayStocks` 同一套来源：
//      正式成员 + 观察组 / 20 日补位候选 / 龙头名册（前一交易日）/ 当日已有行；
//   ③ 只挑「volume / auc_vol_ratio / auc_pct_chg 有缺」的 (日期, 股票)，已有真值不重复算；
//   ④ **一次** `daily_auc` 调用拿 [窗口首日, 窗口末日] × 全部代码
//      （猫抓请求数与「只拉一天」相同，这是本方案能每天跑的关键）；
//      ⚠️ 代码超过 150 只会自动分批发（见 NUMCAT_MAX_CODES_PER_REQ）——正常交易日名单 ~60 只
//      ⇒ 恒 1 批 = 1 次额度；只有首次「10 天追平」那天才会到 3 批。
//   ⑤ 猫抓给真值就写：volume ← auc_vol(手)/100 = 万股；auc_vol_ratio ← auc_vol_ratio；
//      auc_pct_chg ← auc_pct_chg。**三列都核对过**才打 `source='numcat'`（见 ⑤ 段死角说明）。
//
// 【口径与红线】
//   · 猫抓 = 用户指定的权威口径 ⇒ 对已有值也**覆盖**（同花顺快照的占位值不算准）；
//   · ⛔ 不动 change_pct / yest_volume / um_vol / open_bid_pct / auc_turnover（各有专责：
//     收盘涨幅由收盘轮写、昨日成交量由 K 线腿写，趋势图那两条线本来就正常）；
//   · ⛔ 0 / 空一律不写（§10：猫抓当日未结算会给占位 0，写下去就是新的假 0）；
//   · 额度用完（403「今日调用额度已用完」）⇒ 记日志优雅退出，⛔ 不重试、⛔ 不抛错挡住后续补算；
//   · 落库仍按「键集签名」分桶（PostgREST 同批对象键集必须一致，见 healTodayVolume 的 PGRST102 注释）。
// ════════════════════════════════════════════════════════════════════════════

interface NumcatAucCell { vol: number | null; ratio: number | null; aucPct: number | null }
interface NumcatAucResult {
  byCode: Map<string, Map<string, NumcatAucCell>>;
  rows: number;
  error: string;
  quota: boolean;
}

/**
 * 🔴 单批最大代码数 = 150。
 *   为什么必须分批（2026-11-04 实测）：10 天窗口的四类行并集实测 **353 只**，一次塞进 `symbols`
 *   既可能顶到上游长度上限（同仓库 `auction-yizi-fetch` 对 symbols 就设了 MAX_SYMBOLS=300 的保守上限），
 *   更糟的是**上游若静默截断，我们拿到的就是「部分真值」** —— 表现为那几只票永远补不齐、
 *   每轮都重试、永远补不上，且日志上完全看不出（最典型的静默失败）。
 *   150 是把风险压到最低的粒度：正常交易日（名单 ~60 只）恒为 1 批 = 1 次额度，
 *   只有首次 10 天追平那天会到 3 批。
 */
const NUMCAT_MAX_CODES_PER_REQ = 150;

/** 单批：调 numcat-proxy 的 daily_auc（一批内仍是「多只 × 多日」= 1 次额度） */
async function numcatAucOnce(codes: string[], startYmd: string, endYmd: string): Promise<NumcatAucResult> {
  const byCode = new Map<string, Map<string, NumcatAucCell>>();
  if (codes.length === 0) return { byCode, rows: 0, error: '', quota: false };
  const url = SB_URL.replace(/\/$/, '') + '/functions/v1/numcat-proxy';
  const fields = 'symbol,tradedate,auc_vol,auc_vol_ratio,auc_pct_chg';
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ANON_KEY },
        body: JSON.stringify({
          apiname: 'daily_auc', fields,
          params: { symbols: codes.join(','), startdate: startYmd, enddate: endYmd },
        }),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!resp.ok) return { byCode, rows: 0, error: 'numcat-proxy HTTP ' + resp.status, quota: false };
    const j = (await resp.json()) as Record<string, unknown>;
    const code = Number(j.code);
    if (code !== 200) {
      const msg = String(j.message ?? '');
      const quota = code === 403 || msg.indexOf('额度') >= 0;
      return { byCode, rows: 0, error: 'numcat code=' + code + ' ' + msg, quota };
    }
    const data = (j.data ?? {}) as Record<string, unknown>;
    const fl = Array.isArray(data.fields) ? (data.fields as string[]) : [];
    const items = Array.isArray(data.items) ? (data.items as unknown[][]) : [];
    const iSym = fl.indexOf('symbol');
    const iDate = fl.indexOf('tradedate');
    const iVol = fl.indexOf('auc_vol');
    const iRatio = fl.indexOf('auc_vol_ratio');
    const iPct = fl.indexOf('auc_pct_chg');
    if (iSym < 0 || iDate < 0 || iVol < 0) {
      return { byCode, rows: 0, error: 'daily_auc 返回缺少 symbol/tradedate/auc_vol 字段', quota: false };
    }
    const num = (v: unknown): number | null => {
      if (v === null || v === undefined || String(v).trim() === '') return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const toCell = (row: unknown[]): NumcatAucCell => {
      const v = num(row[iVol]);
      return {
        // ⚠️ 猫抓 auc_vol 单位是【手】；库内 volume 是【万股】⇒ ÷100。保留 1 位小数：
        //    旧前端按钮用 Math.round，会把 0.4 万手抹成 0（正是「显示 0」的来源之一）。
        vol: v !== null && v > 0 ? Math.round((v / 100) * 10) / 10 : null,
        ratio: iRatio >= 0 ? num(row[iRatio]) : null,
        aucPct: iPct >= 0 ? num(row[iPct]) : null,
      };
    };
    for (const row of items) {
      if (!Array.isArray(row)) continue;
      const sym = String(row[iSym] ?? '').trim().split('.')[0];
      const date = String(row[iDate] ?? '').trim().replace(/-/g, '').replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
      if (!sym || !date) continue;
      const cell = toCell(row);
      if (cell.vol === null && cell.ratio === null && cell.aucPct === null) continue;
      let m = byCode.get(sym);
      if (!m) { m = new Map(); byCode.set(sym, m); }
      m.set(date, cell);
    }
    return { byCode, rows: items.length, error: '', quota: false };
  } catch (e) {
    return { byCode, rows: 0, error: 'numcat 请求异常: ' + (e instanceof Error ? e.message : String(e)), quota: false };
  }
}

/**
 * 分批拉 daily_auc 并合并结果（调用方只需关心「拿到了什么」）。
 * 语义：
 *   · 任一批撞额度耗尽 ⇒ 立刻停（⛔ 不换端点、不重试），已拿到的批次**保留**；
 *   · 全部批次失败 ⇒ `error` 非空、byCode 为空（调用方据此「优雅跳过」）；
 *   · 部分批次失败 ⇒ `warn` 非空但 `error` 为空，已拿到的照样写（⛔ 不因为一批失败全盘丢弃）。
 */
async function numcatDailyAucBulk(codes: string[], startYmd: string, endYmd: string): Promise<NumcatAucResult & { warn: string; reqs: number }> {
  const byCode = new Map<string, Map<string, NumcatAucCell>>();
  const uniq = Array.from(new Set(codes.filter((c) => /^\d{6}$/.test(c))));
  if (uniq.length === 0) return { byCode, rows: 0, error: '', quota: false, warn: '', reqs: 0 };
  const chunks: string[][] = [];
  for (let i = 0; i < uniq.length; i += NUMCAT_MAX_CODES_PER_REQ) chunks.push(uniq.slice(i, i + NUMCAT_MAX_CODES_PER_REQ));
  let rows = 0;
  let error = '';
  let warn = '';
  let quota = false;
  let okCount = 0;
  for (let i = 0; i < chunks.length; i++) {
    const r = await numcatAucOnce(chunks[i], startYmd, endYmd);
    if (r.error) {
      if (!error) error = r.error;
      if (r.quota) { quota = true; break; }        // 额度耗尽：后面的批次必然也挂，⛔ 不白撞
      continue;
    }
    okCount++;
    rows += r.rows;
    for (const [sym, m] of r.byCode) {
      let t = byCode.get(sym);
      if (!t) { t = new Map(); byCode.set(sym, t); }
      for (const [d, c] of m) t.set(d, c);
    }
  }
  if (okCount === 0) return { byCode: new Map(), rows: 0, error, quota, warn: '', reqs: chunks.length };
  if (okCount < chunks.length) {
    warn = '部分批次失败(' + (chunks.length - okCount) + '/' + chunks.length + '): ' + error;
    error = '';
  }
  return { byCode, rows, error, quota, warn, reqs: chunks.length };
}

/**
 * 回补「四类行」窗口内的竞价量 / 竞价量比 / 竞价涨幅（猫抓口径）。
 * @param opts.days 窗口交易日数（默认 DISPLAY_BACKFILL_DAYS=10）
 * @param opts.includeToday 是否含当天（默认含：16:30 猫抓已结算）
 */
// ⚠️ 为什么窗口取 10 天而不是趋势图那 5 天（2026-11-04 定）：
//   窗口一旦等于展示窗口，某一天补失败（额度用尽/上游抽风）**第二天它就滑出窗口**，
//   再也没有机会补 —— 用户看到的「前几天永远空着」就是这个滑动窗口效应。
//   取 10 天 = 给一次失败留 5 天补救余量，而猫抓请求数【不变】（一次 startdate~enddate
//   覆盖整个窗口，与只拉一天同样消耗 1 次额度），纯赚。
const DISPLAY_BACKFILL_DAYS = 10;

// ⚠️ `export` 只为单测/离线预演（与 dayMetricsOf / healTodayVolume 同款用法）。
export async function backfillDisplayFromNumcat(opts?: { days?: number; includeToday?: boolean }): Promise<Record<string, unknown>> {
  const days = Math.max(1, Math.min(10, Number(opts?.days) || DISPLAY_BACKFILL_DAYS));
  const includeToday = opts?.includeToday !== false;

  // ① 交易日：auction_watchlist 的 distinct date（与名单同源，⛔ 不引入第二套节假日判定）
  const uniqDates: string[] = [];
  try {
    const got = await sbRest(
      'GET',
      '/rest/v1/auction_watchlist?select=date&date=lte.' + todayYmd() + '&order=date.desc&limit=6000',
    );
    const seen = new Set<string>();
    for (const r of (Array.isArray(got) ? got : []) as Array<Record<string, unknown>>) {
      const d = String(r.date ?? '').trim().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || seen.has(d)) continue;
      seen.add(d);
      uniqDates.push(d);
      if (uniqDates.length >= days + 1) break;   // 多取 1 个：给「龙头名册 = 前一交易日」用
    }
  } catch (e) {
    return { skipped: '读交易日失败: ' + (e instanceof Error ? e.message : String(e)) };
  }
  if (uniqDates.length === 0) return { skipped: 'auction_watchlist 里没有任何日期' };
  const window = (includeToday ? uniqDates.slice(0, days) : uniqDates.slice(1, days + 1)).reverse(); // 升序
  if (window.length === 0) return { skipped: '窗口为空' };

  // ② 逐日：名单并集 + 库内已有行
  type Slot = { date: string; stock: string; code: string; hasRow: boolean; vol: unknown; ratio: unknown; pct: unknown; src: string };
  const slots: Slot[] = [];
  const codeOf = new Map<string, string>();
  let listTotal = 0;
  let rowTotal = 0;
  for (const d of window) {
    const idx = uniqDates.indexOf(d);
    const prev = idx >= 0 && idx + 1 < uniqDates.length ? uniqDates[idx + 1] : '';
    const list = await readTodayDisplayStocks(d, prev);
    // 库内已有行（含 code 与三列现值）
    const rowMap = new Map<string, Record<string, unknown>>();
    try {
      for (let from = 0; ; from += 1000) {
        let page: unknown;
        try {
          page = await sbRest(
            'GET',
            '/rest/v1/market_metrics?select=stock,code,volume,auc_vol_ratio,auc_pct_chg,source'
              + '&date=eq.' + d + '&scope=eq.auction&order=stock.asc',
            undefined,
            [from, from + 999],
          );
        } catch (e) {
          // ① 首页就失败 ⇒ 这一天确实读不到，抛给日级 catch（§10：不许当成「全缺」）
          if (from === 0) throw e;
          // ② 翻到后面才失败（含 PostgREST 越界 416「Requested Range Not Satisfiable」）
          //    ⇒ 手里已有前面几页，⛔ 不为了一个越界把整天的行全丢掉，停止翻页即可
          console.error('[range20-precompute][AUC-VOL-NUMCAT] ' + d + ' 第 '
            + (Math.floor(from / 1000) + 1) + ' 页读取失败（停止翻页，保留已读 ' + rowMap.size + ' 行）: '
            + (e instanceof Error ? e.message : String(e)));
          break;
        }
        if (!Array.isArray(page) || page.length === 0) break;
        for (const r of page as Array<Record<string, unknown>>) {
          const s = String(r.stock ?? '').trim();
          if (s && !rowMap.has(s)) rowMap.set(s, r);
        }
        if (page.length < 1000) break;
      }
    } catch (e) {
      // §10：读失败必须可见，⛔ 但只跳过这一天（不把「读不到」当成「全缺」）
      console.error('[range20-precompute][AUC-VOL-NUMCAT] 读 ' + d + ' 失败（跳过该日）: '
        + (e instanceof Error ? e.message : String(e)));
      continue;
    }
    rowTotal += rowMap.size;
    // 名单里没有、但有行的票也纳入（保持与 healTodayVolume 同口径）
    for (const [s, r] of rowMap) {
      if (!list.has(s)) list.set(s, /^\d{6}$/.test(String(r.code ?? '')) ? String(r.code) : '');
    }
    listTotal += list.size;
    for (const [stock, code] of list) {
      // ⚠️ 即使 code 为空也必须登记进 codeOf —— 否则 `fillCodesFromStockcodemap` 根本看不到它，
      //    20 日补位票（结果表没有 code 列）就永远补不上码。2026-11-04 预演抓到的真 bug。
      if (!codeOf.has(stock)) codeOf.set(stock, /^\d{6}$/.test(code) ? code : '');
      else if (!codeOf.get(stock) && /^\d{6}$/.test(code)) codeOf.set(stock, code);
      const r = rowMap.get(stock);
      slots.push({
        date: d, stock, code,
        hasRow: !!r,
        vol: r ? r.volume : null,
        ratio: r ? r.auc_vol_ratio : null,
        pct: r ? r.auc_pct_chg : null,
        src: r ? String(r.source ?? '') : '',
      });
    }
  }
  if (slots.length === 0) return { skipped: '窗口内没有任何名单行', window: window.join('~') };
  const codeFixed = await fillCodesFromStockcodemap(codeOf);
  for (const s of slots) if (!s.code) s.code = codeOf.get(s.stock) || '';

  // ③ 只挑需要（重新）用猫抓核对的槽；⛔ 已有真值且已标 numcat 的不重复算，避免白烧额度
  //
  //   🔴 [口径] 判据必须包含「source ≠ 'numcat'」，只用「值为空」是错的：
  //     历史上 worker 曾用【同花顺快照】把 auc_vol_ratio 填上（2026-11-04 已彻底删除该写入）
  //     —— 那些库存值**非空但来源不是猫抓**，正是用户说「同花顺不准、一定要猫抓」的那批。
  //     只按空值判定 ⇒ 这些残留值永远轮不到猫抓核对 ⇒ 用户的口径永远落不了地（2026-11-04 预演抓到）。
  //     ⇒ 保留「来源」判据：库里那些历史同花顺量比，会在窗口内被猫抓逐格覆盖成权威值。
  const isBlank = (v: unknown) => v === null || v === undefined || String(v).trim() === '' || Number(v) === 0;
  // ⚠️ 排序：**今天排最前**。分批发请求时若中途撞额度，越靠前的越先拿到 ⇒
  //    最要紧的「今天」一定先补上，历史日随后（⛔ 不能按日期升序，那样先烧在旧日子上）。
  const needSlots = slots
    .filter((s) => isBlank(s.vol) || isBlank(s.ratio) || isBlank(s.pct) || s.src !== 'numcat')
    .sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1));
  if (needSlots.length === 0) {
    return {
      skipped: '窗口内竞价量/量比/竞价涨幅已齐且均为猫抓口径（零猫抓请求）',
      window: window.join('~'), slots: slots.length,
    };
  }
  // 代码顺序跟着槽位顺序（今天优先），分批时同理
  const codes: string[] = [];
  const seenCode = new Set<string>();
  for (const s of needSlots) {
    if (!/^\d{6}$/.test(s.code) || seenCode.has(s.code)) continue;
    seenCode.add(s.code);
    codes.push(s.code);
  }
  if (codes.length === 0) return { skipped: '待补票全都缺代码（无法调猫抓）', slots: slots.length };

  // ④ 一次调用覆盖 多只 × 多日（超过 150 只自动分批，见 NUMCAT_MAX_CODES_PER_REQ）
  const startYmd = window[0].replace(/-/g, '');
  const endYmd = window[window.length - 1].replace(/-/g, '');
  const nc = await numcatDailyAucBulk(codes, startYmd, endYmd);
  if (nc.error) {
    // 额度用完是「正常业务态」，不是故障：只记一行日志，⛔ 不重试不抛错
    console.log('[range20-precompute][AUC-VOL-NUMCAT] 跳过：' + nc.error
      + '（待补 ' + needSlots.length + ' 格 / ' + codes.length + ' 只；窗口 ' + startYmd + '~' + endYmd
      + '；批次 ' + nc.reqs + '）');
    return {
      ok: false, quota: nc.quota, error: nc.error, window: window.join('~'),
      slots: slots.length, need: needSlots.length, codes: codes.length, reqs: nc.reqs,
    };
  }
  if (nc.warn) {
    // §10：部分批次失败必须可见，但已拿到的照样写下去
    console.error('[range20-precompute][AUC-VOL-NUMCAT] ' + nc.warn
      + '（已拿到 ' + nc.byCode.size + ' 只 / ' + nc.rows + ' 条，继续写）');
  }

  // ⑤ 组行：猫抓有真值就写（volume 一定 >0 才写；⛔ 0/空不写）
  //
  //   🔴 `source='numcat'` 的语义必须是「**三列都已用猫抓核对过**」，⛔ 不是「我碰过这行」。
  //   否则会出现这个死角：猫抓这次只回了两列（量比缺失 / 为 0），我们写了量、顺手把
  //   `source` 也改成 numcat ⇒ 下一轮「来源已是 numcat」就不再把该行选进待核集合
  //   ⇒ 库里残留的同花顺量比**永远轮不到校正**，用户口径悄悄没落地（2026-11-04 复查发现）。
  //   ⇒ 三列全部对齐才标 numcat；只要有一列没核对过，就保留原 source（下轮继续核）。
  const nowIso = new Date().toISOString();
  const out: Array<Record<string, unknown>> = [];
  let volFixed = 0;
  let ratioFixed = 0;
  let pctFixed = 0;
  let marked = 0;
  let partial = 0;
  let noData = 0;
  for (const s of needSlots) {
    const cell = s.code ? nc.byCode.get(s.code)?.get(s.date) : null;
    if (!cell) { noData++; continue; }
    const patch: Record<string, unknown> = {
      date: s.date, stock: s.stock, code: s.code, scope: 'auction', updated_at: nowIso,
    };
    let any = false;
    // 竞价量：猫抓有 >0 值，且（库内空 或 与猫抓不同）才写。
    // ⚠️ 这里**允许覆盖非空值** —— 用户口径「猫抓为准」，同花顺拍的占位值就该被换掉。
    let volOk = false;
    if (cell.vol !== null && cell.vol > 0) {
      const cur = isBlank(s.vol) ? null : Number(s.vol);
      if (cur === null || Math.abs(cur - cell.vol) > 1e-9) {
        patch.volume = String(cell.vol); any = true; volFixed++;
      }
      volOk = true;
    }
    let ratioOk = false;
    if (cell.ratio !== null && cell.ratio > 0) {
      const cur = isBlank(s.ratio) ? null : Number(s.ratio);
      const next = Number(cell.ratio.toFixed(2));
      if (cur === null || Math.abs(cur - next) > 1e-9) {
        patch.auc_vol_ratio = String(next); any = true; ratioFixed++;
      }
      ratioOk = true;
    }
    let pctOk = false;
    if (cell.aucPct !== null) {
      const cur = parsePct(s.pct);
      if (cur === null || Math.abs(cur - cell.aucPct) > 0.005) {
        patch.auc_pct_chg = fmtPct(cell.aucPct); any = true; pctFixed++;
      }
      pctOk = true;
    }
    const allChecked = volOk && ratioOk && pctOk;   // 三列都被猫抓核对过 = 可以打 numcat 标
    if (allChecked) {
      // 三列都与猫抓一致（任何一列都没改动）、但来源还不是猫抓 ⇒ 只写一次 source 作「已核对」标记。
      //   为什么必须标记：否则下一轮又会被判成「非猫抓口径」⇒ 每天重复请求、永远幂等不了。
      if (!any && s.src !== 'numcat') { any = true; marked++; }
      patch.source = 'numcat';
    } else {
      // 只核对到部分列 ⇒ ⛔ 不敢打 numcat 标（见上方死角说明），保留原来源，下轮继续核。
      patch.source = s.src || 'numcat-part';
      if (any) partial++;
    }
    if (any) out.push(patch);
  }

  // ⑥ 按键集签名分桶落库（PostgREST：同批对象键集必须一致，否则 400 PGRST102）
  const buckets = new Map<string, Array<Record<string, unknown>>>();
  for (const row of out) {
    const sig = Object.keys(row).sort().join(',');
    const arr = buckets.get(sig);
    if (arr) arr.push(row);
    else buckets.set(sig, [row]);
  }
  let written = 0;
  for (const rows of buckets.values()) {
    for (let k = 0; k < rows.length; k += 500) {
      await sbRest('POST', '/rest/v1/market_metrics?on_conflict=date,stock,scope', rows.slice(k, k + 500));
      written += Math.min(500, rows.length - k);
    }
  }
  console.log('[range20-precompute][AUC-VOL-NUMCAT] 窗口 ' + startYmd + '~' + endYmd
    + '｜名单行 ' + listTotal + '（库内 ' + rowTotal + '）｜待核 ' + needSlots.length
    + '｜猫抓返回 ' + nc.rows + ' 条（' + nc.reqs + ' 批）⇒ 写 ' + written + ' 行（竞价量 ' + volFixed
    + ' / 量比 ' + ratioFixed + ' / 竞价涨幅 ' + pctFixed + '，仅标记 ' + marked
    + '，部分列 ' + partial + '，猫抓无数据 ' + noData + '）');
  return {
    ok: true, window: window.join('~'), listRows: listTotal, dbRows: rowTotal,
    slots: slots.length, need: needSlots.length, codes: codes.length, reqs: nc.reqs, warn: nc.warn,
    numcatRows: nc.rows, written, buckets: buckets.size,
    volFixed, ratioFixed, pctFixed, marked, partial, noData, codeFixed,
    note: '只写 volume / auc_vol_ratio / auc_pct_chg；三列全核对过才标 source=numcat；0 与空一律不写',
  };
}

async function backfillRange20FromLegs(targetDate: string): Promise<Record<string, unknown>> {
  // ① 该日已有结果（只补缺的）
  //
  // 🔴🔴 [TVRB-AUC-LEG-PRESERVE 2026-11-10] 事故：原来这里固定带 `&leg=eq.close`。
  //   `stock_range20_pct` 的主键是 **(date, stock)，不含 leg**（见 create_stock_range20_pct.sql:31），
  //   同一天同一只票物理上只能存一行。9:25 那轮写的是 `leg='auc'`（竞价口径）⇒ 16:30 这个
  //   `haveSet` 查 close 行必然为空 ⇒ 每一只票都被判成「还没有」⇒ 全部按收盘腿重算并
  //   `on_conflict=date,stock` 覆盖 ⇒ **9:25 的竞价口径快照整表丢失**。
  //   实测 2026-11-10：81 行全变成 leg='close'、updated_at=08:30 UTC(北京16:30)，两腿并存 0 只。
  //   后果：15:00 后前端 resolveT20LegMode 切 close ⇒ 题材量比 `ebbCtx.top5` 换榜 ⇒
  //   竞价期间选出的「冰山冷热 · 弱势切抱团(第三十条)」下午直接消失。用户铁口径：
  //   「题材量比看板都是按照竞价口径的，收盘改变不了的」。
  //
  //   ⇒ 当天：只要【任意口径】已有行就跳过，⛔ 绝不用收盘口径覆盖竞价口径（竞价数据不可再生）。
  //     真正缺行的票才补（它们本来就没有竞价口径值，补 close 属正常补缺）。
  //   ⇒ 历史日：仍只认 close 行（历史日复盘要收盘口径，行为逐字不变，§11）。
  const isTargetToday = targetDate === todayYmd();
  const haveUrl = '/rest/v1/stock_range20_pct?select=stock&date=eq.' + targetDate
    + (isTargetToday ? '' : '&leg=eq.close');
  const haveSet = new Set<string>();
  for (let from = 0; ; from += LEG_PAGE) {
    const page = await sbRest(
      'GET',
      haveUrl,
      undefined,
      [from, from + LEG_PAGE - 1],
    );
    if (!Array.isArray(page) || page.length === 0) break;
    for (const r of page as Array<Record<string, unknown>>) haveSet.add(String(r.stock ?? '').trim());
    if (page.length < LEG_PAGE) break;
  }

  // ② 读腿：目标日 + 往前 60 个自然日（足够凑 19 个交易日，长假也够）
  const fromYmd = shiftYmd(targetDate, -60);
  const byStock = new Map<string, Array<{ d: string; p: number }>>();
  let legRows = 0;
  for (let from = 0; ; from += LEG_PAGE) {
    const page = await sbRest(
      'GET',
      '/rest/v1/stock_daily_pct?select=stock,date,pct&date=gte.' + fromYmd + '&date=lte.' + targetDate
        + '&order=date.asc',
      undefined,
      [from, from + LEG_PAGE - 1],
    );
    if (!Array.isArray(page) || page.length === 0) break;
    legRows += page.length;
    for (const r of page as Array<Record<string, unknown>>) {
      const s = String(r.stock ?? '').trim();
      const d = String(r.date ?? '').slice(0, 10);
      const p = parsePct(r.pct);
      if (!s || !d || p === null) continue;
      const list = byStock.get(s);
      if (list) list.push({ d, p });
      else byStock.set(s, [{ d, p }]);
    }
    if (page.length < LEG_PAGE) break;
  }

  // ③ 逐票算（每票取它自己最近 20 个有腿的交易日：19 根历史 + 1 根 T）
  const rows: Array<Record<string, unknown>> = [];
  let noT = 0;
  let short = 0;
  const nowIso = new Date().toISOString();
  for (const [s, arr] of byStock) {
    if (haveSet.has(s)) continue;
    arr.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
    const tIdx = arr.findIndex((x) => x.d === targetDate);
    if (tIdx < 0) { noT++; continue; }                  // 目标日没有这根腿（停牌）⇒ 跳过
    const hist = arr.slice(0, tIdx).map((x) => x.p);    // T 之前的全部历史腿（升序）
    const r = rangeFromLegs(hist, arr[tIdx].p);
    if (!r) { short++; continue; }                      // 腿不足 19 根 ⇒ 不算（§10）
    rows.push({
      date: targetDate,
      stock: s,
      pct: r.pct,
      days: r.days,
      leg: 'close',
      updated_at: nowIso,
    });
  }

  let written = 0;
  for (let k = 0; k < rows.length; k += 500) {
    await sbRest('POST', '/rest/v1/stock_range20_pct?on_conflict=date,stock', rows.slice(k, k + 500));
    written += Math.min(500, rows.length - k);
  }
  if (written > 0) {
    console.log('[range20-precompute][R20-RANGE-FROM-LEGS] ' + targetDate + ' 已有 ' + haveSet.size
      + ' 行 → 用腿表补 ' + written + ' 行（腿不足 ' + short + ' 只 / 无T腿 ' + noT + ' 只，读腿 ' + legRows + ' 行）');
  }
  return {
    date: targetDate,
    hadRows: haveSet.size,
    legRows,
    written,
    shortLegs: short,
    noTLeg: noT,
    note: '收盘口径用逐日腿表补算（rangeFromLegs，0 上游请求）；腿不足 19 根不写',
  };
}

/**
 * ★★ [R20-LEGS 2026-11-01] 只补「逐日腿」—— 不算 20 日涨幅、不碰 stock_range20_pct。
 *
 * 触发：pg_cron 两条（见 db/create_range20_legs_cron.sql ⑤ 段，默认不挂，应急手动用）
 *   · 北京 15:20（UTC 07:20）→ 补「今天这根腿」（收盘后 20 分钟，腾讯日线已更新）
 *   · 北京 08:50（UTC 00:50）→ 补「上一个榜日那根」（早盘前的保险，防止 15:20 那次上游抖动）
 * 手动：`?token=...&legsOnly=1`（缺省自动判目标日）；`&date=YYYY-MM-DD` 指定回补某天。
 *
 * 设计原则（⛔ 一条都不能放宽，放宽任何一条都会静默算错 20 日涨幅）：
 *   ① **只补缺的** (date,stock)，已有行一律不碰（尤其 `src='kline'` 真值）⇒ 纯加法、幂等、可反复重跑；
 *   ② **今天这根腿只有北京 15:05 之后才认** —— 盘中 bar 是现价，写进原料表会被当成收盘腿；
 *   ③ **停牌 / 无 bar ⇒ 跳过**，⛔ 绝不写 0% 冒充（§10 缺数据 ≠ 0%）；
 *   ④ 落库标 `src='qt'`，⛔ 不冒充 `'kline'`。
 *
 * 为什么不用 market_metrics 兜底：那条路对「竞价涨幅 == 收盘涨幅」的票天然失效
 *   （分不清是真一字板还是 Worker 16:00 收盘轮没更新，见 healDailyLegsFromMetrics 闸①②③），
 *   而腾讯日线是**从行情源重新取一遍真值**，不存在这个问题 ⇒ 腾讯优先。
 */
async function backfillLegsOnly(opts: {
  targetDate: string;  // '' = 自动判定
  hhmm: string;        // 北京时刻 HH:MM
}): Promise<Record<string, unknown>> {
  const today = todayYmd();
  let cutoff = opts.targetDate;

  if (!cutoff) {
    if (opts.hhmm >= '15:05') {
      cutoff = today;
    } else {
      // 早于 15:05：补「上一个榜日」。名单只在交易日有行 ⇒ 它天然就是交易日历
      const prev = await sbRest(
        'GET',
        '/rest/v1/auction_watchlist?select=date&date=lt.' + today + '&order=date.desc&limit=1',
      );
      cutoff = Array.isArray(prev) && prev.length > 0 ? String((prev[0] as Record<string, unknown>).date) : '';
    }
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoff)) {
    return { ok: false, reason: '无法确定目标交易日（auction_watchlist 里找不到可用名单）', today };
  }
  // 闸②：今天这根腿必须等收盘定稿
  if (cutoff === today && opts.hhmm < '15:05') {
    return { ok: false, reason: '今天这根腿要等 15:05 收盘后才算终值（当前 ' + opts.hhmm + '）', date: cutoff };
  }

  // ① 名单
  const watch = await sbRest('GET', '/rest/v1/auction_watchlist?select=stock,code&date=eq.' + cutoff);
  const targets = (Array.isArray(watch) ? watch as Array<Record<string, unknown>> : [])
    .map((r) => ({ stock: String(r.stock ?? '').trim(), code: String(r.code ?? '').trim() }))
    .filter((t) => t.stock && /^\d{6}$/.test(t.code));
  if (targets.length === 0) {
    return { ok: false, reason: '目标日名单为空或全部缺 6 位代码', date: cutoff };
  }

  // ② 已有的腿（分页读，PostgREST 单次上限 1000）
  const haveSet = new Set<string>();
  for (let from = 0; ; from += LEG_PAGE) {
    const page = await sbRest(
      'GET',
      '/rest/v1/stock_daily_pct?select=stock&date=eq.' + cutoff,
      undefined,
      [from, from + LEG_PAGE - 1],
    );
    if (!Array.isArray(page) || page.length === 0) break;
    for (const r of page as Array<Record<string, unknown>>) haveSet.add(String(r.stock ?? '').trim());
    if (page.length < LEG_PAGE) break;
  }

  const todo = targets.filter((t) => !haveSet.has(t.stock));
  if (todo.length === 0) {
    return { ok: true, date: cutoff, watchlist: targets.length, legs: haveSet.size, written: 0, action: 'skip(已齐)' };
  }

  // ③ 腾讯日线：窗口留 45 个自然日（覆盖长假 + 停牌回溯），end 用 cutoff ⇒ 只回 ≤ cutoff 的 bar
  const cutoffMs = Date.parse(cutoff + 'T00:00:00+08:00');
  const startYmd = new Date(cutoffMs - 45 * 86400000 + 8 * 3600 * 1000).toISOString().slice(0, 10);

  const rows: Array<Record<string, unknown>> = [];
  const failed: string[] = [];
  const noBar: string[] = [];
  let idx = 0;
  const QCONC = 4;
  const worker = async () => {
    for (;;) {
      const i = idx++;
      if (i >= todo.length) return;
      const t = todo[i];
      try {
        const bars = await fetchQtBars(t.code, startYmd, cutoff);
        // 找 cutoff 那根 + 它前面最近的一根（前复权价之比 = 当日涨幅）
        const at = bars.findIndex((b) => b.ymd === cutoff);
        if (at <= 0) {
          noBar.push(t.stock + '(无' + cutoff + 'bar)'); // 停牌 ⇒ 跳过，⛔ 不写 0
          continue;
        }
        const cur = bars[at].close;
        const prev = bars[at - 1].close;
        if (!(cur > 0) || !(prev > 0)) {
          noBar.push(t.stock + '(价异常)');
          continue;
        }
        const pct = (cur / prev - 1) * 100;
        const v = pct.toFixed(2);
        rows.push({
          date: cutoff,
          stock: t.stock,
          pct: v.charAt(0) === '-' ? v : '+' + v,
          src: 'qt',
          updated_at: new Date().toISOString(),
        });
      } catch (e) {
        failed.push(t.stock + '(' + (e instanceof Error ? e.message : String(e)) + ')');
      }
    }
  };
  await Promise.all(Array.from({ length: QCONC }, () => worker()));

  // ④ 分批落库（500 一批，与前端 upsert 同款）
  let written = 0;
  if (rows.length > 0) {
    for (let k = 0; k < rows.length; k += 500) {
      await sbRest('POST', '/rest/v1/stock_daily_pct?on_conflict=date,stock', rows.slice(k, k + 500));
      written += Math.min(500, rows.length - k);
    }
    console.log('[range20-precompute][R20-LEGS] ' + cutoff + ' 逐日腿 ' + haveSet.size + ' → 补 ' + written
      + ' 行（腾讯前复权日线，src=qt）' + (noBar.length ? '｜停牌/无bar ' + noBar.length : '')
      + (failed.length ? '｜失败 ' + failed.length : ''));
  }

  return {
    ok: true,
    date: cutoff,
    watchlist: targets.length,
    legsBefore: haveSet.size,
    missing: todo.length,
    written,
    skippedNoBar: noBar.length,
    failed: failed.length,
    failures: failed.slice(0, 15),
    note: '只补逐日腿（src=qt），不算 20 日涨幅；停牌票按 §10 跳过不写 0%',
  };
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

    // ★★ [R20-LEGS 2026-11-01] 只补「逐日腿」专用入口 —— pg_cron 15:20 / 08:50 用。
    //   早 return：不读名单、不算 20 日涨幅、不碰 stock_range20_pct，只往 stock_daily_pct 补缺的行。
    //   ⛔ 必须放在下面的 leg 判定与名单轮询之前，否则会白等 45 秒。
    if (params.get('legsOnly') === '1') {
      const stat = await backfillLegsOnly({
        targetDate: isBackfill ? rawDate : '',
        hhmm: beijingHhmm(),
      });
      console.log('[range20-precompute][R20-LEGS] ' + JSON.stringify(stat));
      return json(stat);
    }

    // ★★★ [AUC-VOL-ONLY 2026-11-04] 只补「竞价量 / 昨日成交量」（手动入口）。
    //   用途：部署后立刻把当天那 32 行 '-' 补成真值，不必等到明天 9:25。
    //   用法：curl -X POST '<URL>/functions/v1/range20-precompute?token=range20-cron-2026&volume=1'
    //        历史日：再加 &date=YYYY-MM-DD
    if (params.get('volume') === '1') {
      const target = isBackfill ? rawDate : todayYmd();
      const legForVol = beijingHhmm() < '15:00' ? 'auc' : 'close';
      const statV = await healTodayVolume(target, legForVol);
      console.log('[range20-precompute][AUC-VOL-ONLY] ' + JSON.stringify(statV));
      return json({ ok: true, volumeOnly: true, today: target, leg: legForVol, volume: statV });
    }

    // ★★★ [AUC-VOL-NUMCAT-ONLY 2026-11-04] 只用【猫抓】回补近 N 个交易日的
    //  竞价量 / 竞价量比 / 竞价涨幅（四类行全名单）。手动入口，消耗 1 次猫抓额度。
    //   用法：curl -X POST '<URL>/functions/v1/range20-precompute?token=range20-cron-2026&display=1'
    //        自定义窗口：&days=5
    if (params.get('display') === '1') {
      const statD = await backfillDisplayFromNumcat({ days: Number(params.get('days')) || DISPLAY_BACKFILL_DAYS });
      console.log('[range20-precompute][AUC-VOL-NUMCAT-ONLY] ' + JSON.stringify(statD));
      return json({ ok: true, displayOnly: true, display: statD });
    }

    // ★★★ [R10-ONLY 2026-11-04] 只重算「10 日区间涨幅」（手动入口，零上游请求）。
    //   用途：① 部署后立刻修正当天那 47 行（实测 8 只错），不必等到明天 9:25；
    //        ② 排查「题材量比出不了票」时，确认到底是没数据还是数据错。
    //   用法：curl -X POST '<URL>/functions/v1/range20-precompute?token=range20-cron-2026&range10=1'
    //        历史日：再加 &date=YYYY-MM-DD（此时不加 overwrite 就只补缺）
    //        强覆盖：&overwrite=1
    if (params.get('range10') === '1') {
      const target = isBackfill ? rawDate : todayYmd();
      const tRows = await sbRest(
        'GET',
        '/rest/v1/market_metrics?select=stock,auc_pct_chg&date=eq.' + target + '&scope=eq.auction&limit=2000',
      );
      const tLeg = new Map<string, number>();
      for (const r of (Array.isArray(tRows) ? tRows : []) as Array<Record<string, unknown>>) {
        const s = String(r.stock ?? '').trim();
        const p = parsePct(r.auc_pct_chg);
        if (s && p !== null) tLeg.set(s, p);
      }
      // 当天默认覆盖（竞价口径权威）；历史日默认只补缺，避免把已换收盘腿的行改回竞价腿
      const wantOverwrite = params.get('overwrite') === '1'
        || (target === todayYmd() && params.get('overwrite') !== '0');
      const stat10 = tLeg.size === 0
        ? { skipped: '当天 market_metrics 没有 auc_pct_chg（竞价涨幅未落库）', written: 0 }
        : await backfillRange10FromLegs(target, { todayTLeg: tLeg, overwrite: wantOverwrite });
      console.log('[range20-precompute][R10-ONLY] ' + JSON.stringify(stat10));
      return json({ ok: true, range10Only: true, today: target, range10: stat10 });
    }

    // ★★★ [R20-HEAL-ONLY 2026-11-01] 只跑「缺腿自愈」，不算 20 日涨幅 —— pg_cron 16:30 专用。
    //   为什么需要独立入口：worker 16:00 收盘轮刚把 change_pct 覆盖成收盘涨幅（updated_by 带 '-close'），
    //   此时立刻自愈一次，就能在**当天**把腿补齐，而不是拖到次日 9:25 才补。
    //   纯本库读写（market_metrics → stock_daily_pct），⛔ 零上游请求、零同花顺/腾讯依赖。
    if (params.get('healOnly') === '1') {
      const hhmm = beijingHhmm();
      const todayY = isBackfill ? rawDate : todayYmd();
      const healed = await healDailyLegsFromMetrics(todayY);

      // ★★★ [R20-RANGE-FROM-LEGS 2026-11-01] 腿补完之后，再用腿表把【结果表】也补上。
      //   为什么必须连着做：15:05 收盘轮算 close 口径一律走同花顺（canFast 只对 auc 开），
      //   同花顺一断，那天的 stock_range20_pct 就只有几十行 ⇒ 前端满屏「…」。
      //   腿补齐后这里 0 上游请求就能把结果算出来（实测 10-30 的 411 只票里 405 只腿够）。
      let cutoff = isBackfill ? rawDate : '';
      if (!cutoff) {
        if (hhmm >= '15:05') {
          cutoff = todayYmd();
        } else {
          const prev = await sbRest(
            'GET',
            '/rest/v1/auction_watchlist?select=date&date=lt.' + todayYmd() + '&order=date.desc&limit=1',
          );
          cutoff = Array.isArray(prev) && prev.length > 0
            ? String((prev[0] as Record<string, unknown>).date)
            : '';
        }
      }
      let ranged: Record<string, unknown> | null = null;
      let ranged10: Record<string, unknown> | null = null;
      let displayFill: Record<string, unknown> | null = null;
      // 当天这根腿只有 15:05 之后才算定稿（与 legFinal 同源判断）
      if (/^\d{4}-\d{2}-\d{2}$/.test(cutoff) && (cutoff !== todayYmd() || hhmm >= '15:05')) {
        try {
          ranged = await backfillRange20FromLegs(cutoff);
        } catch (e) {
          // §10：结果表补算失败必须可见，但⛔ 不连坐 —— 腿已经补好了，主流程不受影响
          ranged = { error: e instanceof Error ? e.message : String(e) };
          console.error('[range20-precompute][R20-RANGE-FROM-LEGS] 失败: ' + JSON.stringify(ranged));
        }
        // ★★★ [R10-RANGE-FROM-LEGS 2026-11-01] 10 日涨幅同一轮一起补（同一天、同一份腿，只多一次读）。
        //   为什么放在这里：`stock_range_pct` 只由 worker 写，上游一断就只写几十行，
        //   实测 10-08~10-23 每天都有 9~26 只名单票完全没有 10 日涨幅 ⇒ 前端整列「…」。
        //   ⚠️ 与 20 日口径不同（全局窗口 [T-9,T]），实现见函数头，⛔ 别合并两个函数。
        try {
          ranged10 = await backfillRange10FromLegs(cutoff);
        } catch (e) {
          ranged10 = { error: e instanceof Error ? e.message : String(e) };
          console.error('[range20-precompute][R10-RANGE-FROM-LEGS] 失败: ' + JSON.stringify(ranged10));
        }
      }

      // ★★★ [AUC-VOL-NUMCAT 2026-11-04] 同一轮用【猫抓】回补四类行窗口内的竞价量/量比/竞价涨幅。
      //
      //   为什么挂在这里（而不是新建一条 cron）：本入口已经有 16:30 / 08:50 两个 pg_cron 触发点
      //   （见 db/create_range20_legs_cron.sql），用户重贴 Edge Function 即生效，⛔ 不必再建任务。
      //
      //   为什么只在 hhmm >= 15:05 跑：
      //     · 猫抓对【当天】的四要素要等结算才给，收盘前跑 = 白烧额度；
      //     · 08:50 那次是「早盘前补腿」，当天名单还没落库，跑它只会多烧 1 次额度（每天只该烧 1 次）。
      //
      //   为什么必须做：竞价量/量比是 9:25 的瞬时值，K 线里没有、过期同花顺也不再给，
      //   历史值只有猫抓有；而 20 日补位票 / 龙头组壳行不在「同花顺最近多板 883410」里
      //   ⇒ worker 从来没写过它们的行 ⇒ 趋势图前几天必然断点（用户 2026-11-04 第 5 次报障）。
      //   窗口用 DISPLAY_BACKFILL_DAYS(10) 而非趋势图的 5 天：见该常量的注释（防滑动窗口效应）。
      if (hhmm >= '15:05' && !isBackfill) {
        try {
          displayFill = await backfillDisplayFromNumcat({ days: DISPLAY_BACKFILL_DAYS });
        } catch (e) {
          // §10：失败可见，⛔ 不连坐 —— 腿与区间涨幅已经补好了
          displayFill = { error: e instanceof Error ? e.message : String(e) };
          console.error('[range20-precompute][AUC-VOL-NUMCAT] 失败: ' + JSON.stringify(displayFill));
        }
      }

      const sum = {
        ok: true,
        healOnly: true,
        today: todayY,
        days: healed.length,
        healed: healed.filter((x) => x.action === 'healed'),
        errors: healed.filter((x) => x.action === 'error'),
        range20: ranged,
        range10: ranged10,
        display: displayFill,
        detail: healed,
      };
      console.log('[range20-precompute][R20-HEAL-ONLY] healed=' + sum.healed.length
        + ' range20=' + JSON.stringify(ranged) + ' range10=' + JSON.stringify(ranged10)
        + ' display=' + JSON.stringify(displayFill));
      return json(sum);
    }

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
    // ④.5 ★★ [R20-METRICS-QT 2026-11-01] 补位票 K 线序列兜底补齐（腾讯直连，不经 fuyao）
    //
    // 【为什么必须加 —— 用户报障的类根因，不是单只票问题】
    //   poolSeries（第⑤步写 market_metrics 的唯一输入）只在 K 线主循环里收集
    //   （`if (t.from === 'pool') poolSeries.push(...)`）。而 2026-10-30 加入的逐日腿
    //   快路径（②.5 R20-DAILY）把「历史腿全齐」的补位票**全部从 klineTodo 拿走了**
    //   ⇒ 补位票恰恰是最容易腿全齐的那批（它们多在历史名单里出现过）⇒ poolSeries 恒空
    //   ⇒ 第⑤步恒跳过 ⇒ market_metrics 里 source='range20' 恒 0 行（2026-11-01 实测）
    //   ⇒ 前端趋势图对灰色行永远 hydrate 不到 ⇒ 「20天」标签票当天断点，修了几次都复发。
    //
    // 【数据源】腾讯 ifzq 前复权日线（fetchQtBars，⛔ 不经 fuyao-proxy）：
    //   与同花顺 K 线同源同口径（backfill-daily-pct.mjs 实测 524 条 ±0.02 内 100% 一致），
    //   上游稳定、CORS 无关（服务端请求）、单票一次请求 + 8s 超时，≤40 只 ≈ 6 轮 × 6 并发。
    //   已收集过（K 线循环里拿到 fuyao 序列）的票不重复拉（§32）。
    //
    // 【写什么】仍旧只喂第⑤步的 dayMetricsOf：09:25 竞价口径（竞价涨幅/昨日成交量/竞价量）
    //   / 15:05 收盘口径（收盘涨幅覆盖）。历史回补照旧不写（第⑤步自己的闸门）。
    // ══════════════════════════════════════════════════════════════════════════════
    if (!isBackfill) {
      const haveSeries = new Set(poolSeries.map((p) => p.stock));
      const needQt = targets.filter((t) => t.from === 'pool' && t.code && !haveSeries.has(t.stock));
      if (needQt.length > 0) {
        console.log('[range20-precompute][R20-METRICS-QT] 快路径 bypass 的补位票 ' + needQt.length
          + ' 只 ⇒ 腾讯日线补序列（不经 fuyao）');
        const QT_CONC = 6;
        let qtOk = 0;
        let qtFail = 0;
        for (let i = 0; i < needQt.length; i += QT_CONC) {
          const chunk = needQt.slice(i, i + QT_CONC);
          const got = await Promise.all(chunk.map(async (t) => {
            try {
              // 窗口 45 自然日（与 legsFromYmd 同宽）：dayMetricsOf 只需要「今天 + 上一交易日」，
              // 取宽一点以覆盖长假 / 停牌回溯，成本只是单请求里多几根 bar。
              const series = await fetchQtBars(t.code, legsFromYmd, today);
              return { stock: t.stock, code: t.code, series };
            } catch (e) {
              console.error('[range20-precompute][R20-METRICS-QT] ' + t.stock + '(' + t.code
                + ') 腾讯日线失败: ' + (e instanceof Error ? e.message : String(e)));
              return null;
            }
          }));
          for (const g of got) {
            if (g) { poolSeries.push(g); qtOk++; } else { qtFail++; }
          }
        }
        console.log('[range20-precompute][R20-METRICS-QT] 腾讯序列补齐 ok=' + qtOk + ' fail=' + qtFail
          + ' ⇒ poolSeries=' + poolSeries.length + ' 只');
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
            // ⛔ auc_vol_ratio 刻意不在此处（见 dayMetricsOf 的同名注记）：竞价量比只认猫抓，
            //    同花顺快照的 auction_volume_ratio 永不入库（用户 2026-10-26 / 11-04 两次口径）。
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

    // ★★★ [R10-CLOUD 2026-11-04] 9:25 这一轮把【当天】10 日区间涨幅写进 stock_range_pct。
    //
    // 【用户原话 2026-11-04】「20日区间涨幅是存在 supabase 上面啊，也是用里面的 ts 文件和表，
    //   你改 cloudflare worker 和我说这个有矛盾吗，一定要改 worker 吗？supabase 跑不了？」
    //   ⇒ 他说得对，而且这正是更好的做法：
    //     · 腿表 `stock_daily_pct` 已覆盖 48 个交易日（最早 2026-08-20）；
    //     · 实测 11-04 当天 56 只票里 48 只（85.7%）9 根历史腿全在库；
    //     ⇒ 10 日涨幅完全能【0 上游请求、0 猫抓额度】在云端算出来 —— 既不碰 worker，也不烧额度。
    //
    // 【为什么以前 9:25 从来没算过】`backfillRange10FromLegs` 早就写好了，但只挂在
    //   `healOnly=1`（16:30 那轮）分支里，主路径一次都没调 ⇒ 当天 `stock_range_pct` 只能由
    //   浏览器补算（实测 11-04 那 47 行 updated_at 全在 09:46:04~09:46:09）⇒ 用户不开电脑
    //   就没有十日涨幅 ⇒ 题材量比没有排序依据 ⇒ **出不了票**。这就是「关机就不出票」的根因。
    //
    // 【口径】T 腿 = market_metrics.auc_pct_chg（9:25 竞价涨幅，与十日涨幅的历史定义一致）；
    //   历史 9 根 = stock_daily_pct 的收盘涨幅腿。
    // 【边界】只在竞价轮（leg='auc' 且非 ?date= 回补）跑：收盘轮的 T 腿换腿由 close-pct-cover
    //   与前端负责，⛔ 不在这里掺和（否则会把竞价口径的十日涨幅改成收盘口径，两把尺子打架）。
    let range10: Record<string, unknown> | null = null;
    if (!isBackfill && leg === 'auc') {
      try {
        const tRows = await sbRest(
          'GET',
          '/rest/v1/market_metrics?select=stock,auc_pct_chg&date=eq.' + today + '&scope=eq.auction&limit=2000',
        );
        const tLeg = new Map<string, number>();
        for (const r of (Array.isArray(tRows) ? tRows : []) as Array<Record<string, unknown>>) {
          const s = String(r.stock ?? '').trim();
          const p = parsePct(r.auc_pct_chg);
          if (s && p !== null) tLeg.set(s, p);
        }
        if (tLeg.size === 0) {
          // §10：没有竞价涨幅就⛔不能写十日涨幅，如实报原因（前端会显示「数据不全」）
          range10 = { skipped: '当天 market_metrics 没有 auc_pct_chg（竞价涨幅未落库）', written: 0 };
        } else {
          // overwrite=true：竞价轮是当天【权威口径】，覆盖掉浏览器用兜底腿算出的错值
          // （实测 11-04 有 8/47 只错，见函数头 R10-OVERWRITE 的取证）。
          range10 = await backfillRange10FromLegs(today, { todayTLeg: tLeg, overwrite: true });
        }
      } catch (e) {
        // §10：失败必须可见，但⛔ 不连坐 —— range20 与 market_metrics 已经落库了
        range10 = { error: e instanceof Error ? e.message : String(e) };
        console.error('[range20-precompute][R10-CLOUD] 失败: ' + JSON.stringify(range10));
      }
      console.log('[range20-precompute][R10-CLOUD] ' + JSON.stringify(range10));
    }

    // ★★★ [AUC-VOL-HEAL 2026-11-04] 补「竞价量 / 昨日成交量」两列的真值。
    //   用户报障：「第一页的昨日成交量和竞价量列很多股票显示横杠 -，趋势图有数据为什么没显示出来」
    //   根因：猫抓当日 `auc_vol` 偶发返回占位 0（32/56 行），而量比却有值 ⇒ 物理矛盾，是写入丢了。
    //        趋势图走「快照 + K 线」现算所以有值；列表列只读库 ⇒ 只能显示 '-'。
    //   补一次落库 ⇒ 全天所有人打开都是真值，手机零等待，也不依赖 worker 是否升级。
    //
    // ⚠️ 顺序必须排在 range10 之后：区间涨幅决定「题材量比能不能出票」，是本系统的命门；
    //    竞价量只是展示列。这一趟要给 30+ 只票拉腾讯 K 线（并发 6，实测 6~12 秒），
    //    ⛔ 绝不能让它挡在出票逻辑前面。
    let volHeal: Record<string, unknown> | null = null;
    if (!isBackfill) {
      try {
        volHeal = await healTodayVolume(today, leg);
      } catch (e) {
        volHeal = { error: e instanceof Error ? e.message : String(e) };
        console.error('[range20-precompute][AUC-VOL-HEAL] 失败: ' + JSON.stringify(volHeal));
      }
      console.log('[range20-precompute][AUC-VOL-HEAL] ' + JSON.stringify(volHeal));
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
      // ★★★ [AUC-VOL-HEAL 2026-11-04] 竞价量/昨日成交量的补写结果 ——
      //   missing=当天缺了多少行、written=补回多少行。第一页那两列显示 '-' 时先看这里。
      volHeal,
      // ★★★ [R10-CLOUD 2026-11-04] 10 日区间涨幅（stock_range_pct）本轮写了多少行 ——
      //   竞价期间「题材量比能不能出票」全靠这一步；written=0 就说明当天只能等浏览器补算。
      range10,
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
