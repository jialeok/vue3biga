// ============================================================================
// limit-pool-fetch — Supabase Edge Function (Deno)
// 「涨跌停」看板数据源：每个交易日【北京 15:40】抓同花顺「涨停池 + 跌停池」→ limit_pool 表。
//
// ── 为什么是独立函数（而不是塞进 bidding-a / Cloudflare worker）─────────────
//   ① 独立命名 = 独立接口面：不碰 bidding-a（竞价看板）的任何路由与 Secrets，
//      两者的失败域、配额域、部署节奏彻底解耦（改这个不会把竞价看板搞挂）。
//   ② 用【另一个同花顺小号】：本函数只读 FUYAO_API_KEY_LIMITPOOL，不消耗主账号配额。
//   ③ 定时由【本项目的 pg_cron】触发（见 db/supabase_limit_pool_cron.sql），不依赖 Cloudflare。
//
// ── 职责（单一）────────────────────────────────────────────────────────────
//   抓 涨停池 + 跌停池 → 整日对齐写入 limit_pool。
//   不做题材分组、不选龙头、不算十日涨幅 —— 那些是【派生视图】，
//   由前端 src/logic/limitpool/ 在渲染时用「池 + 共享题材库 + stock_range_pct」计算。
//   落库只会多出第二个真相源（题材库稍后变更即让结论陈旧冻结）。
//
// ── 幂等与安全 ─────────────────────────────────────────────────────────────
//   · 主键 (date, board, stock) upsert 覆盖；重跑同一日结果相同 → 不产生无意义变更。
//   · §11 删除安全：只有某板抓取被判定【完整】时才清理该板「本次已不在池中」的旧行；
//     抓取不完整（条目数 < 上游 pagination.total）时【只 upsert、不删除】—— 宁可多留旧行，
//     也绝不把「没抓到」当成「已退池」而误删真数据。
//   · §10 未就绪 ≠ 没有：两池皆空 → 判定上游尚未结算，不写库、不删除，返回 ok:false。
//
// ── 部署（二选一）──────────────────────────────────────────────────────────
//   A. Dashboard：Functions → 新建 limit-pool-fetch → 粘贴本文件全部内容 → Deploy。
//   B. CLI：supabase functions deploy limit-pool-fetch
//          （本文件位置即 supabase/functions/limit-pool-fetch/index.ts）
//   部署后必须做的三件事：
//     1) 函数设置里【关闭 Verify JWT】（本函数用 ?token= 自校验，见下）；
//     2) Secrets 里设置【另一个同花顺小号】的 key：FUYAO_API_KEY_LIMITPOOL
//        （未设置时会回退主账号 FUYAO_API_KEY，响应里 keySource 会明确标出是否回退）；
//     3) Secrets 里设置 LIMIT_POOL_FETCH_TOKEN（未设置时回退复用 FETCH_TOKEN）。
//        SUPABASE_URL / SUPABASE_ANON_KEY 由平台自动注入，无需手工设置。
//   最后执行 db/supabase_limit_pool_cron.sql 建立 pg_cron 定时（北京 15:40）。
//
// ── 手动触发（排查 / 补历史某日）────────────────────────────────────────────
//   GET /functions/v1/limit-pool-fetch/fetch?token=<TOKEN>&point=limitpool
//   GET ...&date=2026-09-14        ← 补抓指定交易日（上游支持 date_ms）
//   GET /functions/v1/limit-pool-fetch/health
// ============================================================================

// ----------------------------- 配置 -----------------------------
const CONFIG = {
  SUPABASE_URL: (Deno.env.get('SUPABASE_URL') || 'https://tonqfgeyxnnwicjopshn.supabase.co').replace(/\/$/, ''),
  FUYAO_BASE_URL: (Deno.env.get('FUYAO_BASE_URL') || 'https://fuyao.aicubes.cn').replace(/\/$/, ''),

  LIMIT_UP_PATH: '/api/a-share/special-data/limit-up-pool',
  LIMIT_DOWN_PATH: '/api/a-share/special-data/limit-down-pool',
  // 上游文档：size ∈ 1..200
  PAGE_SIZE: 200,
  // 分页安全上限（单日池子真实规模数十~数百只；仅用于防上游 pagination 异常导致死循环）
  MAX_PAGES: 10,
  // 单页抓取重试（上游限流是突发性的）
  RETRY_TIMES: 3,
  // 落库分批（PostgREST 单次不宜过大；涨跌停合计可达数百行）
  WRITE_CHUNK: 500,
};

const BOARD_UP = 'up';
const BOARD_DOWN = 'down';

// --------------------------- 日期 / 节假日 ---------------------------
// ⚠️ 与 supabase/functions/bidding-a/index.ts 的 KNOWN_HOLIDAYS 保持同步。
//    本函数【不】调同花顺交易日历接口（省小号配额）：只用本地日历判断，
//    若遇调休/临时休市，手动 ?date= 补抓即可（补抓不受交易日闸门限制）。
function beijingNow(): Date {
  return new Date(Date.now() + 8 * 3600 * 1000);
}
function beijingToday(): string {
  const d = beijingNow();
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}
function isWeekend(dateStr: string): boolean {
  const day = new Date(dateStr + 'T00:00:00').getDay();
  return day === 0 || day === 6;
}
const KNOWN_HOLIDAYS = new Set([
  '2025-01-01', '2025-01-28', '2025-01-29', '2025-01-30', '2025-01-31',
  '2025-02-01', '2025-02-02', '2025-02-03', '2025-04-04', '2025-04-05',
  '2025-04-06', '2025-05-01', '2025-05-02', '2025-05-03', '2025-05-04',
  '2025-05-05', '2025-06-02', '2025-10-01', '2025-10-02', '2025-10-03',
  '2025-10-06', '2025-10-07', '2025-10-08',
  '2026-01-01', '2026-01-02', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23', '2026-04-05',
  '2026-04-06', '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04',
  '2026-05-05', '2026-06-19', '2026-10-01', '2026-10-02', '2026-10-03',
  '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08',
]);
function localIsTradingDay(dateStr: string): boolean {
  if (isWeekend(dateStr)) return false;
  return !KNOWN_HOLIDAYS.has(dateStr);
}

/** 日期字符串 → 当日 00:00（北京）的 epoch ms（上游 date_ms 口径） */
function dateStrToMs(dateStr: string): number {
  return Date.parse(dateStr + 'T00:00:00+08:00');
}

/** 带超时的 signal（AbortSignal.timeout 不可用时返回 undefined，退化为无超时） */
function timeoutSignal(ms: number): AbortSignal | undefined {
  try {
    const t = (AbortSignal as unknown as { timeout?: (m: number) => AbortSignal }).timeout;
    return typeof t === 'function' ? t.call(AbortSignal, ms) : undefined;
  } catch (_e) {
    return undefined;
  }
}

// ----------------------------- 同花顺(fuyao)接口 -----------------------------
// ⚠️ 全部在【请求时】读取 Deno.env，而不是模块加载时固化：
//    避免冷启动期 env 尚未就绪时把 key 固化成空串（这类问题表现为「健康检查说没配、其实配了」）。
// 优先级：FUYAO_API_KEY_LIMITPOOL（另一个小号）→ FUYAO_API_KEY（主账号，回退）。
function fuyaoKey(): string {
  return Deno.env.get('FUYAO_API_KEY_LIMITPOOL') || Deno.env.get('FUYAO_API_KEY') || '';
}
/** 只回「用了哪个变量名」，绝不回显密钥本身 */
function fuyaoKeySource(): string {
  if (Deno.env.get('FUYAO_API_KEY_LIMITPOOL')) return 'FUYAO_API_KEY_LIMITPOOL';
  if (Deno.env.get('FUYAO_API_KEY')) return 'FUYAO_API_KEY(回退:未配置小号)';
  return '未配置';
}
/** 掩码回显（排查用）：abcd***wxyz */
function keyRedacted(): string {
  const k = fuyaoKey();
  if (!k) return '';
  return k.length <= 8 ? '***' : k.slice(0, 4) + '***' + k.slice(-4);
}

async function fuyaoGet(path: string, params: Record<string, string | number>): Promise<unknown> {
  const key = fuyaoKey();
  if (!key) throw new Error('同花顺 key 未配置（请设置 Secrets: FUYAO_API_KEY_LIMITPOOL）');
  const url = new URL(CONFIG.FUYAO_BASE_URL + path);
  Object.keys(params).forEach((k) => {
    const v = params[k];
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  });
  const resp = await fetch(url.toString(), {
    headers: { 'X-api-key': key },
    signal: timeoutSignal(20000),
  });
  const data = await resp.json() as { code?: number; message?: string; data?: unknown };
  if (data.code !== 0) {
    throw new Error('fuyao ' + path + ' 错误: code=' + data.code + ' ' + (data.message || ''));
  }
  return data.data;
}

/** 重试包装：上游限流是突发性的，3 次内基本都能过 */
async function retryFuyao<T>(fn: () => Promise<T>, times: number, label: string): Promise<T> {
  let lastErr: unknown = null;
  for (let i = 1; i <= times; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < times) await new Promise((r) => setTimeout(r, 800 * i));
    }
  }
  throw new Error(label + ' 重试 ' + times + ' 次仍失败: ' + ((lastErr as Error)?.message || String(lastErr)));
}

// --------------------------- 字段归一（与前端同口径） ---------------------------
/** 涨幅数值 → 库内统一文本口径；无法解析 → null（绝不用 0 顶替，0 是真实涨幅） */
function limPctText(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!isFinite(n)) return null;
  return (n >= 0 ? '+' : '') + n.toFixed(2);
}
/** 数值字段归一：非有限值 → null */
function limNum(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return isFinite(n) ? n : null;
}
/** 文本字段归一：空串/空白 → null */
function limText(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  return s ? s : null;
}

type PoolItem = Record<string, unknown>;

/**
 * 上游 item → limit_pool 入库行（字段映射与 src/data/limit-pool.js#_toRow 逐字段一致，
 * 保证「Edge Function 写的」与「前端自愈写的」在库里行结构完全相同 —— §6 单一真相）。
 */
function limitPoolRow(it: PoolItem, board: string, date: string, nowIso: string): Record<string, unknown> | null {
  const isUp = board === BOARD_UP;
  const code = String(it.ticker || it.thscode || '').trim().replace(/\..*$/, '');
  const name = String(it.name || '').trim();
  if (!name) return null;
  return {
    date: date,
    board: board,
    stock: name,
    code: /^\d{6}$/.test(code) ? code : null,
    thscode: limText(it.thscode),
    price: limNum(it.last_price),
    change_pct: limPctText(it.price_change_ratio_pct),
    // 涨停池：涨停时间；跌停池：首次跌停时间
    limit_time: isUp ? limText(it.limit_up_time) : limText(it.first_limit_time),
    last_limit_time: isUp ? null : limText(it.last_limit_time),
    reason: isUp ? limText(it.limit_up_reason) : null,
    continue_text: isUp ? limText(it.continue_day_text) : null,
    continue_cnt: isUp ? limNum(it.continue_day_cnt) : null,
    seal_money: isUp ? limNum(it.seal_money) : null,
    max_seal_money: isUp ? limNum(it.max_seal_money) : null,
    turnover_ratio: isUp ? null : limNum(it.turnover_ratio_pct),
    updated_at: nowIso,
  };
}

/**
 * 分页拉一个池的全部条目。
 * @returns complete=false 表示「返回条目数 < 上游声明的 total」→ 调用方【不得】据此删除旧行。
 */
async function fetchLimitPoolBoardPages(path: string, dateMs: number): Promise<{ items: PoolItem[]; total: number; complete: boolean }> {
  const items: PoolItem[] = [];
  let total = -1;
  let complete = false;
  for (let page = 1; page <= CONFIG.MAX_PAGES; page++) {
    const data = await retryFuyao(
      () => fuyaoGet(path, { date_ms: dateMs, page: page, size: CONFIG.PAGE_SIZE }),
      CONFIG.RETRY_TIMES,
      path + ' page' + page,
    ) as { item?: PoolItem[]; pagination?: { total?: number; pages?: number } };
    const arr = (data && data.item) || [];
    arr.forEach((it) => { if (it && it.name) items.push(it); });
    const pg = (data && data.pagination) || null;
    total = pg && typeof pg.total === 'number' ? pg.total : items.length;
    if (arr.length === 0) { complete = true; break; }
    if (items.length >= total) { complete = true; break; }
    if (pg && typeof pg.pages === 'number' && page >= pg.pages) { complete = items.length >= total; break; }
  }
  return { items: items, total: total < 0 ? items.length : total, complete: complete };
}

/**
 * 抓取某交易日的涨停池 + 跌停池。
 *
 * ⚠️ 两个池【都要成功】才返回：任一失败直接 throw，调用方据此放弃写入
 *    （宁可保持旧快照，也不写出「只有涨停、没有跌停」的半张表）。
 */
async function fetchLimitPoolSnapshot(date: string): Promise<{
  date: string;
  up: Record<string, unknown>[];
  down: Record<string, unknown>[];
  upTotal: number;
  downTotal: number;
  upComplete: boolean;
  downComplete: boolean;
}> {
  if (!date) throw new Error('limit-pool: 缺少日期');
  const dateMs = dateStrToMs(date);
  if (!isFinite(dateMs)) throw new Error('limit-pool: 日期非法 ' + date);
  const nowIso = new Date().toISOString();

  const upRes = await fetchLimitPoolBoardPages(CONFIG.LIMIT_UP_PATH, dateMs);
  const downRes = await fetchLimitPoolBoardPages(CONFIG.LIMIT_DOWN_PATH, dateMs);

  const up = upRes.items.map((it) => limitPoolRow(it, BOARD_UP, date, nowIso)).filter(Boolean) as Record<string, unknown>[];
  const down = downRes.items.map((it) => limitPoolRow(it, BOARD_DOWN, date, nowIso)).filter(Boolean) as Record<string, unknown>[];

  return {
    date: date,
    up: up,
    down: down,
    upTotal: upRes.total,
    downTotal: downRes.total,
    upComplete: upRes.complete,
    downComplete: downRes.complete,
  };
}

// ----------------------------- Supabase 读写 -----------------------------
function readKey(): string {
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_ANON_KEY') || '';
}
function sbHeaders(extra?: Record<string, string>): Record<string, string> {
  const key = readKey();
  return Object.assign({
    'apikey': key,
    'Authorization': 'Bearer ' + key,
    'Content-Type': 'application/json',
  }, extra || {});
}

/** 写入 limit_pool（主键 date+board+stock → 幂等覆盖） */
async function upsertLimitPoolRows(rows: Record<string, unknown>[]): Promise<number> {
  const payload = (rows || []).filter((r) => r && r.date && r.board && r.stock);
  if (payload.length === 0) return 0;
  const url = CONFIG.SUPABASE_URL + '/rest/v1/limit_pool?on_conflict=date%2Cboard%2Cstock';
  for (let i = 0; i < payload.length; i += CONFIG.WRITE_CHUNK) {
    const resp = await fetch(url, {
      method: 'POST',
      headers: sbHeaders({ 'Prefer': 'resolution=merge-duplicates, return=minimal' }),
      body: JSON.stringify(payload.slice(i, i + CONFIG.WRITE_CHUNK)),
      signal: timeoutSignal(30000),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error('upsert limit_pool 失败: HTTP ' + resp.status + ': ' + text.slice(0, 300));
    }
  }
  return payload.length;
}

/**
 * 删除某日某板「已不在本次快照中」的旧行（§11 删除安全）。
 *
 * 安全约束（调用方必须保证）：
 *   · keepStocks 来自【本次权威抓取结果】，且该次抓取必须被判定为【完整】；
 *   · keepStocks 为空 ⇒ 本次该板确实是 0 只（强势日可以一只跌停都没有）→ 清空该板该日是正确的；
 *   · 只按 (date, board) 限定范围，绝不触碰其它日期。
 *
 * ⚠️ PostgREST 的 DELETE 必须带 `Prefer: return=representation` 才会回读被删行；
 *    否则返回空数组，无法校验实际删除条数。
 */
async function deleteStaleLimitPool(date: string, board: string, keepStocks: string[]): Promise<number> {
  if (!date || !board) return 0;
  const keep = (keepStocks || []).map((s) => String(s).trim()).filter(Boolean);
  let url = CONFIG.SUPABASE_URL + '/rest/v1/limit_pool?date=eq.' + encodeURIComponent(date) +
    '&board=eq.' + encodeURIComponent(board);
  if (keep.length > 0) {
    // 用 split/join 而非正则去引号：转义更直观、也不依赖正则字面量
    url += '&stock=not.in.(' + keep.map((s) => '"' + s.split('"').join('') + '"').join(',') + ')';
  }
  const resp = await fetch(url, {
    method: 'DELETE',
    headers: sbHeaders({ 'Prefer': 'return=representation' }),
    signal: timeoutSignal(30000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error('delete limit_pool 失败: HTTP ' + resp.status + ': ' + text.slice(0, 300));
  }
  const data = await resp.json().catch(() => []);
  return ((data as unknown[]) || []).length;
}

/** 运行日志写入 bidding_fetch_log（与 bidding-a 同一张表，便于统一排查）。失败忽略。 */
async function writeLog(entry: Record<string, unknown>): Promise<void> {
  try {
    await fetch(CONFIG.SUPABASE_URL + '/rest/v1/bidding_fetch_log', {
      method: 'POST',
      headers: sbHeaders({ 'Prefer': 'return=minimal' }),
      body: JSON.stringify(entry),
      signal: timeoutSignal(10000),
    });
  } catch (e) {
    console.error('写 bidding_fetch_log 失败（已忽略）:', (e as Error)?.message);
  }
}

// ----------------------------- 主流程 -----------------------------
/**
 * 抓涨跌停池 → 整日对齐写入 limit_pool。
 * @param {{date?: string, source?: string, force?: boolean}} [opts]
 *   date  = 'YYYY-MM-DD' 指定要抓的交易日（默认北京今天）；指定日期视为人工补抓，跳过交易日闸门。
 * @returns 结构化结果（含 logs，便于从响应直接看发生了什么）
 */
async function runLimitPool(opts?: { date?: string; source?: string }): Promise<Record<string, unknown>> {
  const logs: string[] = [];
  const manualDate = !!(opts && opts.date);
  const today = (opts && opts.date) || beijingToday();
  logs.push('date=' + today + (manualDate ? '（手动指定日期）' : '') + ' keySource=' + fuyaoKeySource());
  const logBase = { run_date: today, time_point: 'limitpool', source: (opts && opts.source) || 'cron', job: 'limit-pool-fetch', worker: 'edge-limitpool' };

  // 1) 交易日闸门（手动指定日期 → 视为补抓，不受闸门限制）
  if (!manualDate && !localIsTradingDay(today)) {
    logs.push('非交易日，跳过');
    await writeLog(Object.assign({}, logBase, { ok: false, detail: { skipped: '非交易日' } }));
    return { ok: true, today: today, skipped: true, reason: '非交易日', logs: logs };
  }
  if (manualDate && !localIsTradingDay(today)) logs.push('⚠️ 该日按本地日历非交易日，仍按手动补抓执行');

  // 2) 抓取（两个池要么都成功，要么直接失败）
  logs.push('步骤1：抓取同花顺涨停池 / 跌停池...');
  let snap: Awaited<ReturnType<typeof fetchLimitPoolSnapshot>>;
  try {
    snap = await fetchLimitPoolSnapshot(today);
  } catch (e) {
    const msg = (e as Error)?.message || String(e);
    logs.push('抓取失败: ' + msg);
    await writeLog(Object.assign({}, logBase, { ok: false, detail: { error: msg } }));
    return { ok: false, today: today, error: '抓取失败: ' + msg, logs: logs };
  }
  logs.push('涨停 ' + snap.up.length + '/' + snap.upTotal + (snap.upComplete ? '（完整）' : '（不完整）') +
    ' 只，跌停 ' + snap.down.length + '/' + snap.downTotal + (snap.downComplete ? '（完整）' : '（不完整）') + ' 只');

  // 3) 两池皆空 → 上游未就绪（或极端行情），不写库、不删除（§10：未就绪 ≠ 没有）
  if (snap.up.length === 0 && snap.down.length === 0) {
    logs.push('❌ 两池皆空 → 判定上游未结算/未就绪，本次不写库（避免清空已有快照）');
    await writeLog(Object.assign({}, logBase, { ok: false, detail: { error: '两池皆空（可能上游未就绪）' } }));
    return { ok: false, today: today, error: '上游两池皆空（可能尚未结算）', logs: logs };
  }

  // 4) 整日对齐写入：先 upsert（本次结果全部就位）→ 再删旧行（本次已不在池中的）
  logs.push('步骤2：写入 limit_pool...');
  let written = 0;
  try {
    written = await upsertLimitPoolRows(snap.up.concat(snap.down));
  } catch (e) {
    const msg = (e as Error)?.message || String(e);
    logs.push('写入失败: ' + msg);
    await writeLog(Object.assign({}, logBase, { ok: false, detail: { error: msg } }));
    return { ok: false, today: today, error: '写入 limit_pool 失败: ' + msg, logs: logs };
  }

  logs.push('步骤3：清理该日已退池的旧行...');
  let deletedUp = 0;
  let deletedDown = 0;
  if (snap.upComplete) {
    try { deletedUp = await deleteStaleLimitPool(today, BOARD_UP, snap.up.map((r) => String(r.stock))); }
    catch (e) { logs.push('清理涨停旧行失败（非致命）: ' + ((e as Error)?.message || String(e))); }
  } else {
    logs.push('⚠️ 涨停池抓取不完整（' + snap.up.length + '/' + snap.upTotal + '）→ 跳过旧行清理（不误删）');
  }
  if (snap.downComplete) {
    try { deletedDown = await deleteStaleLimitPool(today, BOARD_DOWN, snap.down.map((r) => String(r.stock))); }
    catch (e) { logs.push('清理跌停旧行失败（非致命）: ' + ((e as Error)?.message || String(e))); }
  } else {
    logs.push('⚠️ 跌停池抓取不完整（' + snap.down.length + '/' + snap.downTotal + '）→ 跳过旧行清理（不误删）');
  }

  const completenessSummary = '✅ 涨跌停池写入 ' + written + ' 行（涨停 ' + snap.up.length +
    ' / 跌停 ' + snap.down.length + '），清理退池旧行 涨停 ' + deletedUp + ' / 跌停 ' + deletedDown;
  logs.push('数据完整性汇总: ' + completenessSummary);
  await writeLog(Object.assign({}, logBase, { ok: true, detail: {
    written: written, upCount: snap.up.length, downCount: snap.down.length,
    upComplete: snap.upComplete, downComplete: snap.downComplete,
    deletedUp: deletedUp, deletedDown: deletedDown, keySource: fuyaoKeySource(),
  } }));
  return {
    ok: true,
    today: today,
    upCount: snap.up.length,
    downCount: snap.down.length,
    upTotal: snap.upTotal,
    downTotal: snap.downTotal,
    upComplete: snap.upComplete,
    downComplete: snap.downComplete,
    written: written,
    deletedUp: deletedUp,
    deletedDown: deletedDown,
    keySource: fuyaoKeySource(),
    completenessSummary: completenessSummary,
    logs: logs,
  };
}

// ----------------------------- 入口路由 -----------------------------
// 鉴权令牌：优先 LIMIT_POOL_FETCH_TOKEN（本函数专用），未配置时回退复用 FETCH_TOKEN，
// 保证「多配一个 Secret 就能更干净，少配一个也能跑起来」，且绝不与 bidding-a 的路由互相影响。
// 同样在请求时读取（见上方说明）。
function expectedToken(): string {
  return Deno.env.get('LIMIT_POOL_FETCH_TOKEN') || Deno.env.get('FETCH_TOKEN') || '';
}
function tokenSource(): string {
  if (Deno.env.get('LIMIT_POOL_FETCH_TOKEN')) return 'LIMIT_POOL_FETCH_TOKEN';
  return expectedToken() ? 'FETCH_TOKEN(回退)' : '未配置';
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { 'Content-Type': 'application/json' } });
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const p = url.pathname;

  // Supabase Edge Function 的 pathname 带前缀 /functions/v1/limit-pool-fetch，用 endsWith 兼容
  if (p.endsWith('/health')) {
    return json({
      ok: true,
      service: 'limit-pool-fetch',
      point: 'limitpool',
      // 只回显「配没配 / 用了哪个变量名」，绝不回显密钥本身
      fuyaoKeySource: fuyaoKeySource(),
      fuyaoKeyMasked: keyRedacted(),
      tokenSource: tokenSource(),
      schedule: '每个交易日北京 15:40（pg_cron，见 db/supabase_limit_pool_cron.sql）',
    });
  }

  const isFetch = p === '/' || p === '' || p.endsWith('/fetch') ||
    p.endsWith('/limit-pool-fetch') || p.endsWith('/limit-pool-fetch/');
  if (!isFetch) return new Response('limit-pool-fetch', { status: 200 });

  const token = url.searchParams.get('token') || '';
  const et = expectedToken();
  if (!et || token !== et) {
    return json({ ok: false, error: 'token 无效（请设置 Secrets: LIMIT_POOL_FETCH_TOKEN）' }, 403);
  }
  if (!fuyaoKey()) {
    return json({ ok: false, error: '同花顺 key 未配置（请设置 Secrets: FUYAO_API_KEY_LIMITPOOL）' }, 500);
  }

  const point = url.searchParams.get('point') || 'limitpool';
  if (point !== 'limitpool' && point !== 'auto') {
    return json({ ok: false, error: 'point 必须是 limitpool | auto' }, 400);
  }

  const date = url.searchParams.get('date') || '';
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return json({ ok: false, error: 'date 必须形如 YYYY-MM-DD' }, 400);
  }

  try {
    const result = await runLimitPool({ date: date, source: date ? 'http-backfill' : 'http' });
    return json(result, result.ok ? 200 : 500);
  } catch (e) {
    return json({ ok: false, error: (e as Error)?.message || String(e), stack: (e as Error)?.stack }, 500);
  }
});
