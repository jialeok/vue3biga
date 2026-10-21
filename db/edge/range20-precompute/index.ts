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
//   读  auction_watchlist  （date=今天 的正式名单：stock / code / change_pct）
//   读  stock_range20_pct  （当天已有同 leg 行 ⇒ 跳过，幂等重跑不重复烧上游）
//   写  stock_range20_pct  （on_conflict=date,stock，列与前端 upsertRange20Rows 完全一致）
//   上游 同花顺 K 线（经既有 fuyao-proxy Edge Function 代理，零新增密钥）
//
// 响应时间优化：
//   · 名单就绪即开抓（不等 runMorning 全链路跑完）；
//   · 并发 3（上游实测约束：并发 5 会截断/熔断）+ 每完成一批立即 upsert
//     ⇒ 即使函数超时被打断，已算部分也已在库里、前端照常命中；
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
    const today = todayYmd();

    // 选腿：15:00 前 = 竞价口径（auc），15:00 后 = 收盘口径（close）——与前端 resolveT20LegMode 一致。
    // ?leg= 可强制指定（手动测试用）；强制值与时钟口径不同时也不出错（幂等按 leg 跳过）。
    let leg = beijingHhmm() < '15:00' ? 'auc' : 'close';
    const forced = String(url.searchParams.get('leg') ?? '').trim();
    if (forced === 'auc' || forced === 'close') leg = forced;

    // ① 等待 9:25 名单落库（runMorning P0 与本函数同在 09:25 触发 → 轮询等它写完；
    //    15:05 收盘那轮名单必然早已在库，此循环首轮即过）
    let watchRows: Array<Record<string, unknown>> = [];
    while (Date.now() - t0 < WATCHLIST_WAIT_MS) {
      const got = await sbRest('GET', '/rest/v1/auction_watchlist?select=stock,code,change_pct&date=eq.' + today);
      watchRows = Array.isArray(got) ? got as Array<Record<string, unknown>> : [];
      if (watchRows.length > 0) break;
      await sleep(WATCHLIST_POLL_MS);
    }
    if (watchRows.length === 0) {
      return json({
        ok: false,
        reason: '等待名单超时（今日 auction_watchlist 无行：非交易日 / 名单抓取失败）',
        date: today,
        leg,
        elapsedMs: Date.now() - t0,
      });
    }
    console.log('[range20-precompute] ' + today + ' leg=' + leg + ' 名单就绪 ' + watchRows.length + ' 行，开始预计算');

    // 目标 = 当天正式名单（去重，先到先得；aucPct = change_pct 兜底竞价 T 腿，close 腿不用它）
    const targets: Array<{ stock: string; code: string; aucPct: number | null }> = [];
    const seen = new Set<string>();
    for (const r of watchRows) {
      const name = String((r && r.stock) ?? '').trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      targets.push({
        stock: name,
        code: String((r && r.code) ?? '').trim(),
        aucPct: parsePct(r && r.change_pct),
      });
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

    // K 线窗口：往前 100 个自然日（≈65 个真实交易日，足够停牌票回溯凑满 20 腿；多要不增加成本）
    const todayMidnightMs = Date.parse(today + 'T00:00:00+08:00');
    const startMs = todayMidnightMs - 100 * 86400000;
    const endMs = todayMidnightMs + 2 * 86400000;

    let written = 0;
    let failed = 0;
    let circuitBreak = false;
    let consecutiveFail = 0;
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
          failed++;
          consecutiveFail++;
          failures.push(t.stock + '(' + (e instanceof Error ? e.message : String(e)) + ')');
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

    const stat = {
      ok: true,
      date: today,
      leg,
      watchlist: targets.length,
      todo: todo.length,
      written,
      failed,
      circuitBreak,
      elapsedMs: Date.now() - t0,
      failures: failures.slice(0, 30),
      note: 'leg=' + leg + ' 已落库，前端 20日涨幅 toggle 阶段⓪命中即秒开（auc=竞价腿 / close=收盘腿）',
    };
    console.log('[range20-precompute] done ' + JSON.stringify(stat));
    return json(stat);
  } catch (e) {
    console.error('[range20-precompute][fatal] ' + (e instanceof Error ? (e.stack ?? e.message) : String(e)));
    return json({ ok: false, reason: e instanceof Error ? e.message : String(e) }, 500);
  }
});
