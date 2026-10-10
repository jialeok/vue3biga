// ============================================================================
// tick-minute-fetch — Supabase Edge Function (Deno)
// 「分笔买卖」看板数据源：抓【9:30:00 ~ 9:31:00】这一分钟的分笔明细 → tick_minute_open 表。
//
// ── ⚠️ 本函数是一个【独立函数】──────────────────────────────────────────────
//   ① 独立文件名 / 独立 URL：/functions/v1/tick-minute-fetch
//   ② 独立密钥变量：NUMCAT_TICK_API_KEY（优先）→ 回退 NUMCAT_API_KEY
//      （用户 2026-10-10 已确认：同一把猫抓 key 可以用来调猫头鹰的数据）
//   ③ 独立令牌：TICK_FETCH_TOKEN（未配置才回退复用 FETCH_TOKEN；浏览器端路由不校验令牌）
//   ④ 独立表：tick_minute_open   ⑤ 独立日志 job='tick-minute-fetch'
//   ⑥ 独立上游端点配置：NUMCAT_TICK_ENDPOINTS / NUMCAT_TICK_BASE_URL
//   改动本文件不会影响 bidding-a / limit-pool-fetch / numcat-proxy / auction-yizi-fetch。
//
// ── 与猫爪 numcat-proxy 的关系 ─────────────────────────────────────────────
//   numcat-proxy 是给【早盘竞价看板】用的代理，走 numcat.net（core 版，123 个接口）。
//   本函数走的是【猫头鹰数据 t.meoz.cn（market 版，68 个接口）】—— 两套接口目录，
//   但用同一把账号 key。⛔ 本函数不复用 numcat-proxy、不改它、也不往它里面加路由。
//
// ── 上游契约（★ 猫头鹰官方文档 stock/tick-history，勿凭记忆改）──────────────
//   文档：https://t.meoz.cn/docs/query/stock/tick-history
//   日内专线  POST https://sz.meoz.cn:6688/api     （深圳）
//             POST https://sh.meoz.cn:6688/api     （上海）
//   请求体（与猫爪同款信封，只有 apiname 不同）：
//     {
//       apikey: '<key>',
//       apiname: 'tick_history',
//       fields: 'tradedate,symbol,time,open,close,vol,transaction_num',
//       params: {
//         asset: 'stock',
//         symbols: '000678,600000',      // ≤200 个；与 symbol 同传时以 symbols 为准
//         tradedate: '20261009',          // YYYYMMDD
//         start_time: '09:30:00',         // 含该边界
//         end_time: '09:31:00',           // 【不含】该边界 ⇒ 正好是 09:30:00.000~09:30:59.999
//         order_dir: 'asc'
//       }
//     }
//   响应：{ code:200, message:'success', data:{ fields:[...], items:[[...]] } }
//
//   ★★ 字段语义（★ 全部是【累计值】，务必读）────────────────────────────────
//     time            快照时间 'YYYY-MM-DD HH:mm:ss.SSS'
//     open            当日开盘价（= 9:25 集合竞价的成交价）—— 本分钟【第一笔】的涨跌基准
//     close           该快照的最新成交价  ← 看板拿它比涨跌
//     vol             当日截至该快照的【累计】成交量（单位：股）  ← 必须做差分才是「这一笔的量」
//     transaction_num 累计成交笔数（非本快照笔数）
//     ⛔ 上游【没有】「本笔成交量」这个字段，只有累计量 ⇒ 差分是本函数唯一的正确读法。
//     ⛔ 第一行没有上一行 ⇒ 本函数把它的 v 记为 null（⛔ 绝不拿累计值冒充单笔量，§10）。
//
//   ⚠️ 快照节奏（几秒一条）由上游决定，本函数【不做任何补齐 / 插值 / 截断到 20 条】。
//      用户预期「像东财那样 20 笔」—— 上游给几条就存几条，实际条数在响应里如实回显
//      （snapshots），另给 tradeCount 做对照（快照数 ≠ 成交笔数）。
//
// ── 为什么按 (date,name) 落库、为什么只 upsert 不删除 ─────────────────────
//   · 请求本身就是【按票点名】的（决策看板选中哪几只就抓哪几只）⇒ 天然不会产生「整日快照」
//     语义，因此【没有任何 stale 清理】：⛔ 本函数全文没有 delete 语句（§11 删除安全）。
//   · 主键 (date,name) upsert ⇒ 重跑同一日同一票结果相同，不产生无意义变更。
//
// ── 9:31 闸门（★ 只对【今天】生效）────────────────────────────────────────
//   今天且北京时刻 < 09:31:00 ⇒ 【不抓、不写】，返回 ok:false + skipped:'too-early'。
//   原因：09:30:30 去抓只能拿到半分钟数据，落库就会被当成「完整的一分钟」用（§10 未就绪 ≠ 没有）。
//   ⛔ 历史日【不受此限】：tradedate 已经把日期钉死，上游那一天的这一分钟是终值，
//      补抓不会取到错值（同 auction-yizi-fetch 的「迟到容错」口径）。
//
// ── 部署（二选一）──────────────────────────────────────────────────────────
//   A. Dashboard：Functions → 新建 tick-minute-fetch → 粘贴本文件全部内容 → Deploy。
//   B. CLI：supabase functions deploy tick-minute-fetch
//   部署后必须做的三件事：
//     ⚠️ 0) 【先建表】在 SQL Editor 执行 db/create_tick_minute_open.sql。
//          漏这一步的报错长相是：
//          `Could not find the table 'public.tick_minute_open' in the schema cache`（PGRST205）
//          —— 这不是「调用方法不对」，就是那张表还不存在。
//     1) Secrets：NUMCAT_TICK_API_KEY = 你的猫头鹰 key
//        （没配时自动回退 NUMCAT_API_KEY —— 即已配好的早盘竞价那把；响应 keySource 会标出用的是哪把）
//     2) Verify JWT：建议【关掉】（浏览器要直接打开 /health 排查）。
//        · CLI 部署：仓库根 supabase/config.toml 已声明本函数 verify_jwt=false
//        · Dashboard 部署：【不读】config.toml，需在 Details 里手动关一次
//        · 复测：不带任何认证头 GET /functions/v1/tick-minute-fetch/health
//          200 = 已关闭；401 UNAUTHORIZED_NO_AUTH_HEADER = 仍开着
//
// ── 手动触发（排查 / 补某日）──────────────────────────────────────────────
//   GET /functions/v1/tick-minute-fetch/health
//   GET /functions/v1/tick-minute-fetch/minute?date=2026-10-09&stocks=襄阳轴承:000678,宝鼎科技
//        （stocks 支持 `名字:代码` 或纯名字；纯名字会去 stockcodemap 查代码；用 | 或 , 分隔）
//   POST /functions/v1/tick-minute-fetch/minute   body: {date, items:[{name,code}]}
//   （带 &token=… 时校验 TICK_FETCH_TOKEN，不带也放行 —— 与 auction-yizi-fetch 的 /trend 同一口径，
//     因为它只是「把已选定股票的公开分笔写进自己的表」，不产生跨表副作用）
// ============================================================================

// ----------------------------- 配置 -----------------------------
const CONFIG = {
  SUPABASE_URL: (Deno.env.get('SUPABASE_URL') || 'https://tonqfgeyxnnwicjopshn.supabase.co').replace(/\/$/, ''),

  // 上游 apiname（猫头鹰文档固定值）
  APINAME: 'tick_history',
  // 请求字段：顺序即上游 items 的位置顺序
  //   open  → 当日开盘价（第一笔的涨跌基准）
  //   close → 该快照最新成交价（比涨跌用）
  //   vol   → 累计成交量（差分后才是每快照成交量）
  //   transaction_num → 累计成交笔数（差分后是本分钟成交笔数，只做对照）
  FIELDS: ['tradedate', 'symbol', 'time', 'open', 'close', 'vol', 'transaction_num'],

  // 固定窗口（用户 2026-10-10 口径：只看 9:30~9:31 这一分钟）
  // ⚠️ end_time 上游语义 = 【不含】，所以 '09:31:00' 正好切在 09:30:59.999 之后。
  START_TIME: (Deno.env.get('TICK_START_TIME') || '09:30:00').trim(),
  END_TIME: (Deno.env.get('TICK_END_TIME') || '09:31:00').trim(),
  // 9:31 闸门用的时刻（= END_TIME 的秒数）
  WINDOW_READY: (Deno.env.get('TICK_WINDOW_READY') || '09:31:00').trim(),

  REQUEST_TIMEOUT_MS: Number(Deno.env.get('NUMCAT_TICK_TIMEOUT_MS') || 20000),
  WRITE_CHUNK: 200,
  // 单次上游请求最多带几个 symbol（上游上限 200，这里留足余量）
  MAX_SYMBOLS_PER_CALL: Number(Deno.env.get('NUMCAT_TICK_MAX_SYMBOLS') || 60),
};

// --------------------------- 上游端点候选 ---------------------------
// 文档里两个专线并列（深圳 / 上海）。⛔ 不猜「哪个市场归哪个端点」——
// 按序尝试 + 用「这批 symbol 是不是都拿到了数据」来收口（见 fetchMinute）。
const EP_SZ = 'https://sz.meoz.cn:6688/api';
const EP_SH = 'https://sh.meoz.cn:6688/api';

function buildEndpoints(): string[] {
  const raw = (Deno.env.get('NUMCAT_TICK_ENDPOINTS') || '').trim();
  if (raw) {
    const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
    if (list.length) return list;
  }
  const base = (Deno.env.get('NUMCAT_TICK_BASE_URL') || '').trim().replace(/\/$/, '');
  if (base) return [base];
  return [EP_SZ, EP_SH];
}

// --------------------------- 密钥 ---------------------------
// ⚠️ 一律在【请求时】读取 Deno.env 并 .trim()：Secret 从输入框粘贴常带尾随空格/换行，
//    那会让请求体带脏字符，上游表现成「不响应 / 超时」，极难肉眼发现。
const KEY_PRIMARY = 'NUMCAT_TICK_API_KEY';
const KEY_FALLBACK = 'NUMCAT_API_KEY';

type KeyRef = { name: string; key: string };

/**
 * 已配置的 key（按优先级）。
 * ⚠️ 与 auction-yizi-fetch 的「小号绝不用主号」相反 —— 本功能【就是要】回退主号：
 *    用户 2026-10-10 明确说「用猫抓数据的 key 就可以抓取猫头鹰数据的那些数据了」，
 *    所以这里允许回退；要禁掉可设 Secret NUMCAT_TICK_KEY_FALLBACK=0。
 */
function configuredKeys(): KeyRef[] {
  const list: KeyRef[] = [];
  const primary = (Deno.env.get(KEY_PRIMARY) || '').trim();
  const fallback = (Deno.env.get(KEY_FALLBACK) || '').trim();
  if (primary) list.push({ name: KEY_PRIMARY, key: primary });
  const allowFallback = (Deno.env.get('NUMCAT_TICK_KEY_FALLBACK') || '1').trim() !== '0';
  if (allowFallback && fallback && fallback !== primary) {
    list.push({ name: KEY_FALLBACK + '(回退)', key: fallback });
  }
  return list;
}

function primaryKey(): KeyRef | null {
  const list = configuredKeys();
  return list.length > 0 ? list[0] : null;
}

/** 掩码回显（排查用）：abcd***wxyz —— 只用于确认「是不是同一把 key」，绝不回显全量 */
function maskKey(k: string): string {
  if (!k) return '';
  return k.length <= 8 ? '***' : k.slice(0, 4) + '***' + k.slice(-4);
}

// --------------------------- 日期 / 时间 ---------------------------
/** 北京的「现在」（用 UTC 字段读出来就是北京时间） */
function beijingNow(): Date {
  return new Date(Date.now() + 8 * 3600 * 1000);
}
/** 'YYYY-MM-DD'（北京今天） */
function beijingToday(): string {
  const d = beijingNow();
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}
/** 'HH:MM:SS'（北京当前时刻） */
function beijingHMS(): string {
  const d = beijingNow();
  return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0') + ':' + String(d.getUTCSeconds()).padStart(2, '0');
}
/** 'HH:MM[:SS]' → 当日秒数；非法 → NaN */
function hmsToSec(s: string): number {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(s || '').trim());
  if (!m) return NaN;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] || '0');
}
/** 'YYYY-MM-DD' → 'YYYYMMDD'（上游 tradedate 口径）；非法 → '' */
function isoToYmd(iso: string): string {
  const s = String(iso || '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? m[1] + m[2] + m[3] : '';
}
/** 'YYYYMMDD' → 'YYYY-MM-DD'；非法 → null */
function ymdToIso(ymd: unknown): string | null {
  const s = String(ymd === null || ymd === undefined ? '' : ymd).trim();
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  const m2 = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m2 ? s : null;
}
/** 'YYYY-MM-DD HH:mm:ss.SSS' → 'HH:mm:ss.SSS'（非法原样返回） */
function hmsOf(s: unknown): string {
  const t = String(s === null || s === undefined ? '' : s).trim();
  const m = /(\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)\s*$/.exec(t);
  return m ? m[1] : t;
}

/** RFC4180 安全取值（本函数只取我们点名的字段，不做模糊匹配） */
function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

function timeoutSignal(ms: number): AbortSignal | undefined {
  try {
    return AbortSignal.timeout(ms);
  } catch (_e) {
    return undefined;
  }
}

// --------------------------- 上游请求 ---------------------------
type RawTick = { symbol: string; tradedate: string; time: string; open: number | null; close: number | null; vol: number | null; tn: number | null };

type UpstreamSnapshot = { fields: string[]; items: unknown[]; endpoint: string; elapsedMs: number };

/**
 * 打一次上游（单个端点 + 单把 key + 一批 symbol）。
 *
 * ⚠️ 与 auction-yizi-fetch 的差别只有两处：apiname 换成 tick_history、params 带窗口与 symbols。
 *    信封格式（POST + JSON + {apikey,apiname,fields,params}）完全一致。
 */
async function numcatTickRaw(endpoint: string, key: string, symbols: string[], dateYmd: string): Promise<UpstreamSnapshot> {
  if (!key) {
    throw new Error('猫头鹰 key 未配置（请设置 Secrets: ' + KEY_PRIMARY + ' 或 ' + KEY_FALLBACK + '）');
  }
  const body = {
    apiname: CONFIG.APINAME,
    apikey: key,
    fields: CONFIG.FIELDS.join(','),
    params: {
      asset: 'stock',
      symbols: symbols.join(','),
      tradedate: dateYmd,
      start_time: CONFIG.START_TIME,
      end_time: CONFIG.END_TIME,
      order_dir: 'asc',
    },
  };
  const t0 = Date.now();
  let resp: Response;
  try {
    resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: timeoutSignal(CONFIG.REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    const msg = (e as Error)?.message || String(e);
    throw new Error('上游请求未拿到响应（' + CONFIG.REQUEST_TIMEOUT_MS + 'ms 超时 / DNS / 端口不通）: ' + msg + '  [ep=' + endpoint + ']');
  }
  const elapsedMs = Date.now() - t0;
  const text = await resp.text();
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch (_e) {
    throw new Error('上游返回非 JSON: HTTP ' + resp.status + ' ' + text.slice(0, 200) + '  [ep=' + endpoint + ']');
  }
  if (!resp.ok) {
    throw new Error('上游 HTTP ' + resp.status + ': ' + String(json.message || text.slice(0, 200)) + '  [ep=' + endpoint + ']');
  }
  const code = typeof json.code === 'number' ? json.code : 200;
  if (code !== 200) {
    // 上游业务错误：最常见是 key 无效 / 未授权该接口（猫头鹰需单独开通）/ 超配额 → 原样透出 message
    throw new Error('上游业务码 code=' + code + ' ' + String(json.message || '') + '  [ep=' + endpoint + ']');
  }

  // 兼容三种包裹形态（与 auction-yizi-fetch 同一套，猫头鹰也是同一套信封）
  let payload: Record<string, unknown> = (json.data && typeof json.data === 'object' && !Array.isArray(json.data))
    ? json.data as Record<string, unknown>
    : json;
  if (!Array.isArray(payload.items) && Array.isArray(payload.results)) {
    const list = payload.results as Array<Record<string, unknown>>;
    const hit = list.find((r) => r && r.code === 200 && r.data) || list[0];
    if (hit && hit.data && typeof hit.data === 'object') payload = hit.data as Record<string, unknown>;
  }
  const fields = Array.isArray(payload.fields) ? (payload.fields as unknown[]).map((f) => String(f)) : [];
  const items = Array.isArray(payload.items) ? payload.items as unknown[] : [];
  return { fields, items, endpoint, elapsedMs };
}

/**
 * 把上游 items 映射成 RawTick[]（只保留我们点名的 symbol，且 tradedate 必须与请求日期一致）。
 *
 * ⛔ 为什么必须过滤 symbol：上游在【边界快照模式】下不传 symbols 会返回全市场；
 *    万一参数被忽略，绝不能让别的股票的数据混进这批结果（那会写出一行张冠李戴的记录）。
 * ⛔ 为什么必须校验 tradedate：节假日 / 上游兜底可能返回上一交易日，错标成今天会造出假日期行。
 */
function mapItems(snap: UpstreamSnapshot, wanted: string[], dateYmd: string): { rows: RawTick[]; droppedDateMismatch: number; droppedForeign: number } {
  const fields = snap.fields;
  const idx: Record<string, number> = {};
  fields.forEach((f, i) => { idx[f] = i; });
  const want = new Set(wanted);
  const rows: RawTick[] = [];
  let droppedDateMismatch = 0;
  let droppedForeign = 0;

  const pick = (row: unknown, name: string): unknown => {
    const i = idx[name];
    if (i === undefined) return undefined;
    if (Array.isArray(row)) return row[i];
    if (row && typeof row === 'object') {
      const o = row as Record<string, unknown>;
      return o[name] !== undefined ? o[name] : undefined;
    }
    return undefined;
  };

  for (let i = 0; i < snap.items.length; i++) {
    const row = snap.items[i];
    const symbol = String(pick(row, 'symbol') === undefined ? '' : pick(row, 'symbol')).trim();
    if (!symbol) continue;
    if (!want.has(symbol)) { droppedForeign++; continue; }
    const dIso = ymdToIso(pick(row, 'tradedate'));
    if (dIso !== null && isoToYmd(dIso) !== dateYmd) { droppedDateMismatch++; continue; }
    if (dIso === null) { droppedDateMismatch++; continue; }
    rows.push({
      symbol: symbol,
      tradedate: dateYmd,
      time: String(pick(row, 'time') === undefined ? '' : pick(row, 'time')).trim(),
      open: numOrNull(pick(row, 'open')),
      close: numOrNull(pick(row, 'close')),
      vol: numOrNull(pick(row, 'vol')),
      tn: numOrNull(pick(row, 'transaction_num')),
    });
  }
  return { rows, droppedDateMismatch, droppedForeign };
}

type FetchResult = {
  bySymbol: Map<string, RawTick[]>;
  pending: string[];
  attempts: Array<Record<string, unknown>>;
  requests: number;
};

/**
 * 取【一批 symbol】在这一分钟内的原始快照。
 *
 * 端点策略：按候选列表顺序尝试；每个端点只请求【还没拿到数据的 symbol】；
 * 某端点报错 ⇒ 记下错误、继续下一个端点（不中断整批）。
 * ⛔ 最多走完候选列表（默认 2 个专线），不会无限重试（保护上游 3 次/秒的限流）。
 */
async function fetchMinute(symbols: string[], dateYmd: string, keyRef: KeyRef): Promise<FetchResult> {
  const endpoints = buildEndpoints();
  const bySymbol = new Map<string, RawTick[]>();
  let pending = symbols.slice(0);
  const attempts: Array<Record<string, unknown>> = [];
  let requests = 0;

  for (const ep of endpoints) {
    if (pending.length === 0) break;
    const batch = pending.slice(0, CONFIG.MAX_SYMBOLS_PER_CALL);
    try {
      requests++;
      const snap = await numcatTickRaw(ep, keyRef.key, batch, dateYmd);
      const m = mapItems(snap, batch, dateYmd);
      const got = new Set<string>();
      m.rows.forEach((r) => {
        if (!bySymbol.has(r.symbol)) bySymbol.set(r.symbol, []);
        (bySymbol.get(r.symbol) as RawTick[]).push(r);
        got.add(r.symbol);
      });
      attempts.push({
        endpoint: ep, ok: true, symbols: batch.length, rows: m.rows.length,
        covered: got.size, elapsedMs: snap.elapsedMs,
        droppedForeign: m.droppedForeign, droppedDateMismatch: m.droppedDateMismatch,
      });
      // 上游若忽略 symbols 返回了全市场，我们已按 wanted 过滤掉 → 未命中的照旧算「没拿到」，
      // 于是会去试下一个端点 ⇒ 这既是兜底也能让「参数被忽略」这件事在 attempts 里露出来。
      pending = pending.filter((s) => !got.has(s));
    } catch (e) {
      attempts.push({ endpoint: ep, ok: false, symbols: batch.length, error: (e as Error)?.message || String(e) });
    }
  }
  return { bySymbol, pending, attempts, requests };
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

/**
 * 把 PostgREST 的「找不到表」原文翻译成「该干什么」。
 * 典型现场：红字 `Could not find the table 'public.tick_minute_open' in the schema cache`
 * —— 它不是「调用方法不对」，就是【表还没建】（PGRST205 / 42P01）。
 */
function sbErrHint(msg: string, raw: string): string {
  const t = (raw || '').toLowerCase();
  if (t.includes('could not find the table') || t.includes('in the schema cache') ||
    t.includes('does not exist') || t.includes('42p01') || t.includes('pgrst205')) {
    return msg + '  → 【tick_minute_open 表不存在】请在 Supabase Dashboard → SQL Editor 执行 db/create_tick_minute_open.sql 建表（本仓库 db/ 目录）。';
  }
  return msg;
}

/** 读 stockcodemap（股票名 → 代码）；失败只留痕，返回空表（调用方会把它当成「没查到」）。 */
async function readStockCodeMap(): Promise<{ map: Map<string, string>; error: string }> {
  const out = new Map<string, string>();
  const url = CONFIG.SUPABASE_URL + '/rest/v1/stockcodemap?select=stock,code&limit=10000';
  try {
    const resp = await fetch(url, { headers: sbHeaders({ 'Prefer': 'return=minimal' }), signal: timeoutSignal(20000) });
    const text = await resp.text();
    if (!resp.ok) return { map: out, error: 'stockcodemap 读取失败 HTTP ' + resp.status + ': ' + text.slice(0, 200) };
    const rows = JSON.parse(text) as Array<Record<string, unknown>>;
    (rows || []).forEach((r) => {
      const n = String((r && r.stock) || '').trim();
      const c = String((r && r.code) || '').trim();
      if (n && c && !out.has(n)) out.set(n, c);
    });
    return { map: out, error: '' };
  } catch (e) {
    return { map: out, error: 'stockcodemap 读取异常: ' + ((e as Error)?.message || String(e)) };
  }
}

/** upsert 一批 tick_minute_open 行（主键 date+name → 幂等覆盖） */
async function upsertTickRows(rows: Array<Record<string, unknown>>): Promise<number> {
  const payload = (rows || []).filter((r) => r && r.date && r.name);
  if (payload.length === 0) return 0;
  const url = CONFIG.SUPABASE_URL + '/rest/v1/tick_minute_open?on_conflict=date%2Cname';
  let written = 0;
  for (let i = 0; i < payload.length; i += CONFIG.WRITE_CHUNK) {
    const resp = await fetch(url, {
      method: 'POST',
      headers: sbHeaders({ 'Prefer': 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify(payload.slice(i, i + CONFIG.WRITE_CHUNK)),
      signal: timeoutSignal(20000),
    });
    const text = await resp.text();
    if (!resp.ok) throw new Error(sbErrHint('写 tick_minute_open 失败: HTTP ' + resp.status + ': ' + text.slice(0, 300), text));
    written += Math.min(CONFIG.WRITE_CHUNK, payload.length - i);
  }
  return written;
}

/** 运行日志写入 bidding_fetch_log（与 bidding-a / limit-pool-fetch 同一张表，便于统一排查） */
async function writeLog(entry: Record<string, unknown>): Promise<void> {
  try {
    const resp = await fetch(CONFIG.SUPABASE_URL + '/rest/v1/bidding_fetch_log', {
      method: 'POST',
      headers: sbHeaders({ 'Prefer': 'return=minimal' }),
      body: JSON.stringify(Object.assign({ job: 'tick-minute-fetch' }, entry)),
      signal: timeoutSignal(15000),
    });
    if (!resp.ok) {
      const text = await resp.text();
      console.error('写 bidding_fetch_log 失败（HTTP ' + resp.status + '，已忽略）:', text.slice(0, 300));
    }
  } catch (e) {
    console.error('写 bidding_fetch_log 失败（已忽略）:', (e as Error)?.message);
  }
}

// --------------------------- 业务：一次抓取 ---------------------------

type ItemReq = { name: string; code: string };

/**
 * 把请求里的 items 归一成 [{name, code}]（代码缺失时去 stockcodemap 补）。
 * @returns { items, missing } missing = 名字/代码都没法确定的（§10 如实报，不静默丢）
 */
async function normalizeItems(raw: unknown): Promise<{ items: ItemReq[]; missing: Array<{ name: string; reason: string }>; codeMapError: string }> {
  const list: ItemReq[] = [];
  const seen = new Set<string>();
  const arr = Array.isArray(raw) ? raw : [];
  arr.forEach((it) => {
    const o: Record<string, unknown> = (it && typeof it === 'object') ? it as Record<string, unknown> : { name: it };
    const name = String((o.name === undefined || o.name === null) ? '' : o.name).trim();
    const code = String((o.code === undefined || o.code === null) ? '' : o.code).trim();
    if (!name) return;
    if (seen.has(name)) return;
    seen.add(name);
    list.push({ name, code });
  });

  // 只在这批里【确实有缺代码】时才去读 stockcodemap（省一次只读查询）
  let codeMapError = '';
  if (list.some((x) => !x.code)) {
    const r = await readStockCodeMap();
    codeMapError = r.error;
    list.forEach((x) => { if (!x.code) x.code = r.map.get(x.name) || ''; });
  }

  const missing: Array<{ name: string; reason: string }> = [];
  const ok: ItemReq[] = [];
  list.forEach((x) => {
    if (!/^\d{6}$/.test(x.code)) {
      missing.push({ name: x.name, reason: x.code ? ('代码不是 6 位纯数字：' + x.code) : '查不到代码（stockcodemap 里没有这只股票）' });
      return;
    }
    ok.push(x);
  });
  return { items: ok, missing, codeMapError };
}

/** '名字:代码' / '名字' 串 → items（GET 手动触发用） */
function parseStocksParam(raw: string): ItemReq[] {
  const s = String(raw || '').trim();
  if (!s) return [];
  return s.split(/[|,]/).map((seg) => seg.trim()).filter(Boolean).map((seg) => {
    const i = seg.lastIndexOf(':');
    if (i > 0) return { name: seg.slice(0, i).trim(), code: seg.slice(i + 1).trim() };
    return { name: seg, code: '' };
  }).filter((x) => x.name);
}

/**
 * 主流程：把 items 在这一分钟的分笔抓回来落库。
 * ⛔ 任何一步失败都【不写库】（宁可没有，也不写半张表），错误原样返回给调用方（§10）。
 */
async function runFetch(dateIso: string, items: ItemReq[], missing: Array<{ name: string; reason: string }>, diag: Record<string, unknown>, logBase: Record<string, unknown>) {
  const dateYmd = isoToYmd(dateIso);
  if (!dateYmd) return { status: 400, body: { ok: false, error: '日期格式必须是 YYYY-MM-DD，收到：' + dateIso } };
  if (items.length === 0) {
    return { status: 200, body: { ok: false, skipped: 'no-targets', date: dateIso, missing, hint: '没有可抓的目标（决策看板当前没有买点/卖点，或全部查不到代码）' } };
  }

  // ── 9:31 闸门（只对今天；历史日不受限，见文件头）──────────────────────────
  const today = beijingToday();
  const nowHms = beijingHMS();
  if (dateIso === today && hmsToSec(nowHms) < hmsToSec(CONFIG.WINDOW_READY)) {
    return {
      status: 200,
      body: {
        ok: false, skipped: 'too-early', date: dateIso, now: nowHms,
        needAfter: CONFIG.WINDOW_READY, missing,
        hint: '今天是 ' + nowHms + '，还没到 ' + CONFIG.WINDOW_READY + ' —— 这一分钟的成交还没走完，抓了只是半截数据（§10 未就绪 ≠ 没有）。到点自动重试。',
      },
    };
  }

  const keys = configuredKeys();
  const keyRef = primaryKey();
  if (!keyRef) {
    return { status: 200, body: { ok: false, error: '未配置猫头鹰 key：请在 Secrets 里设置 ' + KEY_PRIMARY + '（或 ' + KEY_FALLBACK + '）', date: dateIso } };
  }

  const codes = Array.from(new Set(items.map((x) => x.code)));
  const fr = await fetchMinute(codes, dateYmd, keyRef);

  // 上游一条都没返回（两个端点都没拿到）⇒ 不写库（§10：未就绪 ≠ 没有）
  if (fr.bySymbol.size === 0) {
    await writeLog(Object.assign({}, logBase, {
      ok: false, detail: { skipped: 'upstream-empty', attempts: fr.attempts, pending: fr.pending, requests: fr.requests },
    }));
    return {
      status: 200,
      body: {
        ok: false, skipped: 'upstream-empty', date: dateIso, dateYmd,
        keySource: keyRef.name, keyMasked: maskKey(keyRef.key),
        symbols: codes.length, missing, pending: fr.pending, attempts: fr.attempts,
        hint: '上游这一分钟没有返回任何数据。可能：① 猫头鹰的 tick_history 未开通 / key 无该接口权限；' +
          '② 专线端口 6688 在本网段不通（endpoints 见 /health）；③ 该日确实没有分笔数据（停牌 / 非交易日）。' +
          '请先开 /health 看端点与 key 来源，再核对 attempts 里的真实错误原文。',
      },
    };
  }

  // ── 组装入库行 ─────────────────────────────────────────────────────────
  const rows: Array<Record<string, unknown>> = [];
  const results: Array<Record<string, unknown>> = [];
  let noDataCount = 0;

  items.forEach((it) => {
    const raw = fr.bySymbol.get(it.code);
    if (!raw || raw.length === 0) {
      noDataCount++;
      results.push({ name: it.name, code: it.code, snapshots: 0, hasData: false, reason: '上游该分钟没有这只票的快照' });
      // ⚠️ 这里【不写行】：不存在的快照不能伪造一行 pen_count=0（那会被读成「确认无成交」）。
      //    前端按「库里没这一行 + 已尝试过」显示为「无数据」（§10）。
      return;
    }
    // 按时间升序（上游 order_dir=asc 已保证，这里再排一次防上游忽略该参数）
    raw.sort((a, b) => (a.time < b.time ? -1 : (a.time > b.time ? 1 : 0)));

    // 累计量 → 每快照增量；第一行没有上一行 ⇒ v=null（⛔ 绝不拿累计值冒充单笔量）
    const pens: Array<Record<string, unknown>> = [];
    let prevVol: number | null = null;
    raw.forEach((r) => {
      const v = (prevVol === null || r.vol === null) ? null : Math.max(0, r.vol - prevVol);
      pens.push({ t: hmsOf(r.time), p: r.close, v: v });
      if (r.vol !== null) prevVol = r.vol;
    });

    // 本分钟成交笔数 = 累计成交笔数的窗口内差分（不含首行自身，见 SQL 注释）
    const tnFirst = raw[0].tn;
    const tnLast = raw[raw.length - 1].tn;
    const tradeCount = (tnFirst === null || tnLast === null) ? null : Math.max(0, tnLast - tnFirst);

    rows.push({
      date: dateIso,
      name: it.name,
      code: it.code,
      open_price: raw[0].open,
      pens: pens,
      trade_count: tradeCount,
      start_time: CONFIG.START_TIME,
      end_time: CONFIG.END_TIME,
      source: CONFIG.APINAME,
      updated_at: new Date().toISOString(),
    });
    results.push({
      name: it.name, code: it.code, snapshots: pens.length,
      tradeCount: tradeCount, hasData: true,
    });
  });

  if (rows.length === 0) {
    await writeLog(Object.assign({}, logBase, {
      ok: false, detail: { skipped: 'no-rows', attempts: fr.attempts, noData: noDataCount, requests: fr.requests },
    }));
    return {
      status: 200,
      body: {
        ok: false, skipped: 'no-rows', date: dateIso,
        keySource: keyRef.name, symbols: codes.length, missing, pending: fr.pending,
        attempts: fr.attempts, results,
        hint: '上游有响应，但点名的这些股票在这一分钟里一条快照都没有（停牌 / 非交易日 / 上游无该批次）。未写库。',
      },
    };
  }

  const written = await upsertTickRows(rows);

  // ── 回读校验（§11：写入必须带回读证据）────────────────────────────────
  let readBack = -1;
  try {
    const url = CONFIG.SUPABASE_URL + '/rest/v1/tick_minute_open?select=date,name'
      + '&date=eq.' + encodeURIComponent(dateIso)
      + '&name=in.(' + rows.map((r) => '"' + String(r.name).replace(/"/g, '') + '"').join(',') + ')';
    const resp = await fetch(url, { headers: sbHeaders({ 'Prefer': 'return=minimal' }), signal: timeoutSignal(20000) });
    const text = await resp.text();
    if (resp.ok) readBack = (JSON.parse(text) as unknown[]).length;
  } catch (_e) { /* 回读失败只影响证据，不影响已写入的事实 */ }

  await writeLog(Object.assign({}, logBase, {
    ok: true,
    detail: {
      written, readBack, requests: fr.requests, attempts: fr.attempts,
      noData: noDataCount, pending: fr.pending, missing: missing.length,
      window: CONFIG.START_TIME + '~' + CONFIG.END_TIME,
    },
  }));

  return {
    status: 200,
    body: {
      ok: true, date: dateIso, dateYmd,
      written, readBack,
      keySource: keyRef.name,
      table: 'tick_minute_open',
      window: CONFIG.START_TIME + '~' + CONFIG.END_TIME,
      symbols: codes.length,
      upstreamRequests: fr.requests,
      results, missing,
      pending: fr.pending,
      attempts: fr.attempts,
      codeMapError: diag.codeMapError || '',
      note: '上游 snapshots = 该分钟的快照条数（节奏由上游决定，本函数不做补齐/截断）；'
        + 'tradeCount = 上游累计成交笔数在本窗口内的差分（不含首个快照自身）。两者天然不同。',
    },
  };
}

// ----------------------------- 入口路由 -----------------------------
function expectedToken(): string {
  return Deno.env.get('TICK_FETCH_TOKEN') || Deno.env.get('FETCH_TOKEN') || '';
}
function tokenSource(): string {
  if (Deno.env.get('TICK_FETCH_TOKEN')) return 'TICK_FETCH_TOKEN';
  return expectedToken() ? 'FETCH_TOKEN(回退)' : '未配置';
}

// CORS：本函数有【浏览器端】入口（前端直接调 /minute 抓取、/health 体检），
// 且带 apikey / Authorization 头 ⇒ 浏览器一定先发 OPTIONS 预检。
// ⛔ 缺这段的后果（auction-yizi-fetch 2026-09-19 实测事故）：预检拿不到
//    Access-Control-Allow-Origin，浏览器把真实请求整个拦掉，前端 fetch 抛 TypeError，
//    被误报成「Edge Function 未部署」—— 排查方向被彻底带偏。⇒ CORS 是必备件，不是可选项。
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-client-info, x-supabase-api-version',
  'Access-Control-Max-Age': '86400',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: Object.assign({ 'Content-Type': 'application/json' }, CORS_HEADERS),
  });
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const p = url.pathname;

  // CORS 预检：必须在【任何业务分支之前】直接回 204（无 body）
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // Supabase Edge Function 的 pathname 带前缀 /functions/v1/tick-minute-fetch，用 endsWith 兼容
  if (p.endsWith('/health')) {
    const keys = configuredKeys();
    return json({
      ok: true,
      service: 'tick-minute-fetch',
      board: '分笔买卖（独立看板，挂在决策看板下面）',
      apiname: CONFIG.APINAME,
      upstream: '猫头鹰数据（market 版）· 分笔历史 tick_history',
      endpoints: buildEndpoints(),
      endpointsSource: Deno.env.get('NUMCAT_TICK_ENDPOINTS') ? 'NUMCAT_TICK_ENDPOINTS'
        : (Deno.env.get('NUMCAT_TICK_BASE_URL') ? 'NUMCAT_TICK_BASE_URL' : '内置默认候选（深圳 → 上海）'),
      numcatKeySource: keys.length ? keys[0].name : '未配置',
      numcatKeyMasked: keys.length ? maskKey(keys[0].key) : '',
      numcatKeysConfigured: keys.map((k) => k.name),
      keyFallbackEnabled: (Deno.env.get('NUMCAT_TICK_KEY_FALLBACK') || '1').trim() !== '0',
      window: { start: CONFIG.START_TIME, end: CONFIG.END_TIME, readyAfterBeijing: CONFIG.WINDOW_READY },
      requestTimeoutMs: CONFIG.REQUEST_TIMEOUT_MS,
      maxSymbolsPerCall: CONFIG.MAX_SYMBOLS_PER_CALL,
      tokenSource: tokenSource(),
      table: 'tick_minute_open（先执行 db/create_tick_minute_open.sql 建表）',
      today: beijingToday(),
      nowBeijing: beijingHMS(),
      windowOpenNow: hmsToSec(beijingHMS()) >= hmsToSec(CONFIG.WINDOW_READY),
      fields: CONFIG.FIELDS,
      routes: {
        health: 'GET /health —— 只看配置（不回显密钥）',
        minute: 'GET /minute?date=YYYY-MM-DD&stocks=名字:代码,名字 | POST /minute {date, items:[{name,code}]}',
      },
      nextStep: '第一次跑请先执行 db/create_tick_minute_open.sql，再配 NUMCAT_TICK_API_KEY（或复用 NUMCAT_API_KEY），最后关掉 Verify JWT。',
    });
  }

  const isMinute = p.endsWith('/minute') || p === '/' || p === '' ||
    p.endsWith('/tick-minute-fetch') || p.endsWith('/tick-minute-fetch/');
  if (!isMinute) return new Response('tick-minute-fetch', { status: 200 });

  // token：只有【显式带了 token 参数】时才校验（与 auction-yizi-fetch 的 /trend 同一口径）
  const given = (url.searchParams.get('token') || '').trim();
  if (given) {
    const exp = expectedToken();
    if (!exp) return json({ ok: false, error: '本函数未配置 TICK_FETCH_TOKEN / FETCH_TOKEN，无法校验 token' }, 503);
    if (given !== exp) return json({ ok: false, error: 'token 不正确' }, 401);
  }

  // 解析参数：GET（query）与 POST（JSON body）都支持
  let dateIso = (url.searchParams.get('date') || '').trim();
  let rawItems: unknown = parseStocksParam(url.searchParams.get('stocks') || '');
  if (req.method === 'POST') {
    let body: Record<string, unknown> = {};
    try {
      const text = await req.text();
      if (text) body = JSON.parse(text) as Record<string, unknown>;
    } catch (e) {
      return json({ ok: false, error: '请求体不是合法 JSON: ' + ((e as Error)?.message || String(e)) }, 400);
    }
    if (body.date) dateIso = String(body.date).trim();
    if (body.items) rawItems = body.items;
    else if (body.stocks) rawItems = parseStocksParam(String(body.stocks));
    else if (body.symbols) rawItems = parseStocksParam(String(body.symbols));
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateIso)) {
    return json({ ok: false, error: '缺少或非法参数 date（必须是 YYYY-MM-DD）：' + dateIso }, 400);
  }

  const logBase = { ok: false, detail: {} };
  try {
    const norm = await normalizeItems(rawItems);
    if (norm.items.length === 0 && norm.missing.length === 0) {
      return json({ ok: false, skipped: 'no-targets', date: dateIso, hint: '请求里没有 items / stocks' }, 200);
    }
    const r = await runFetch(dateIso, norm.items, norm.missing, { codeMapError: norm.codeMapError }, logBase);
    return json(r.body, r.status);
  } catch (e) {
    const msg = (e as Error)?.message || String(e);
    await writeLog(Object.assign({}, logBase, { ok: false, detail: { error: msg } }));
    return json({ ok: false, error: msg }, 500);
  }
});
