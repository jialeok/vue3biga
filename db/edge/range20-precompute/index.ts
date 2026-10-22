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

/** Supabase REST（anon key；RLS 与前端同权限） */
async function sbRest(method: string, path: string, body?: unknown): Promise<unknown> {
  const headers: Record<string, string> = {
    apikey: ANON_KEY,
    Authorization: 'Bearer ' + ANON_KEY,
    'Content-Type': 'application/json',
  };
  if (method === 'POST') headers['Prefer'] = 'resolution=merge-duplicates';
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

interface Bar { ymd: string; close: number; open: number | null; }

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
    out.push({ ymd, close, open });
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
        todoList: todo.slice(0, 200).map((t) => t.stock + (t.code ? '(' + t.code + ')' : '(无码)') + '[' + t.from + ']'),
      });
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

    const flush = async () => {
      if (buffer.length === 0) return;
      const batch = buffer.splice(0, buffer.length);
      try {
        await sbRest('POST', '/rest/v1/stock_range20_pct?on_conflict=date,stock', batch);
        written += batch.length;
        console.log('[range20-precompute] 已落库 ' + written + ' / ' + todo.length);
      } catch (e) {
        failed += batch.length;
        console.error('[range20-precompute] flush 失败 ' + batch.length + ' 行: ' + (e instanceof Error ? e.message : String(e)));
      }
    };

    let cursor = 0;
    const worker = async () => {
      while (!circuitBreak) {
        const i = cursor++;
        if (i >= todo.length) return;
        if (Date.now() - t0 > TOTAL_BUDGET_MS) return; // 总预算闸门：超时保全已算部分
        const t = todo[i];
        if (!t.code) {
          failed++;
          failures.push(t.stock + '(no code)');
          continue;
        }
        try {
          const item = await fetchKlineBars(thscode(t.code), startMs, endMs);
          const row = computeRange20(barsToSeries(item), today, leg, t.aucPct);
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
        const row = computeRange20(barsToSeries(item), today, leg, t.aucPct);
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
      written,
      failed,
      // ★ [R20-RATE] 限流与补跑：rateLimited = 第一轮被限流挡下的只数；retried/retryFailed = 串行补跑结果
      rateLimited,
      retried,
      retryFailed,
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
