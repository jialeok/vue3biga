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
// ── ★ 事故与不变式：后端等的必须【短于】前端等的（2026-10-10 修）────────────
//   现场：前端红字「分笔抓取接口不可达：请求 /minute 失败（signal is aborted without reason）；
//   functions/v1/tick-minute-fetch」，并附带「① 跨域被拦 ② 未部署 ③ 网络不通」三条猜测。
//   ⛔ 三条【全错】。实测：OPTIONS 预检回 204 + Access-Control-Allow-Origin:*；/minute 回 200、
//      980ms 拿到 20 条快照；不存在的函数名 404、缺认证头 401，都是 1~2s 内返回。
//   真因：`signal is aborted without reason` 是【前端 AbortController 的超时】原文。旧参数
//      REQUEST_TIMEOUT_MS=20000 × 2 个端点 = 后端最坏 40s，而前端只等 25s ⇒ 上游专线一抽风，
//      前端必然先 abort，并把「我超时了」错报成「接口不可达」，把排查方向整个带偏。
//   ✅ 不变式（改本文件或改 src/data/tick-minute.js 前必须守住）：
//        后端上游最坏耗时 = TOTAL_BUDGET_MS（默认 15s）
//        <  前端 timeoutMs（默认 60s）
//      ⇒ 前端永远等得到后端的【有内容的说法】（attempts 里带真实错误原文），
//        而不是一句没有信息的 abort。
//
// ── 排查三件套（前端报错时按顺序来）──────────────────────────────────────────
//   1) GET /probe   —— 从 Edge 机房这一侧实测上游专线：每个端点的往返耗时 / 上游原文。
//                      通了 ⇒ 问题在「浏览器→Supabase」这一段；不通 ⇒ 看 error 原文。
//   2) GET /health  —— 端点、key 来源（掩码）、窗口、预算、今天/现在。
//                      若这里 401 ⇒ Verify JWT 还开着（Dashboard 粘贴部署不读 config.toml）。
//   3) GET /minute?date=…&stocks=… —— 真正抓一次，看 attempts / upstreamMs / pending。
//   ⛔ 别再靠「浏览器报错文案」猜原因：跨域/未部署/超时/DNS 在 fetch 抛错里长得一模一样。
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
//        ★ 2026-10-10 起【回退真的会生效】：第一把 key 若回 `403 今日调用额度已用完` /
//          `invalid api key`，会自动拿第二把再走一轮（回执 keyPasses 里能看到每把的结果）；
//          超时/网络类失败【不换】（换 key 也救不了，白花额度）。要禁掉回退设 NUMCAT_TICK_KEY_FALLBACK=0。
//        ⚠️ 实测这两把 key 常是【同一个账号】（/health 的 numcatKeysMasked 一眼可比），
//          同账号 ⇒ 共享同一个「免费档 10 次/日」，换 key 也救不了额度，只能等次日 0 点。
//     2) Verify JWT：建议【关掉】（浏览器要直接打开 /health 排查）。
//        · CLI 部署：仓库根 supabase/config.toml 已声明本函数 verify_jwt=false
//        · Dashboard 部署：【不读】config.toml，需在 Details 里手动关一次
//        · 复测：不带任何认证头 GET /functions/v1/tick-minute-fetch/health
//          200 = 已关闭；401 UNAUTHORIZED_NO_AUTH_HEADER = 仍开着
//
// ── 手动触发（排查 / 补某日）──────────────────────────────────────────────
//   GET /functions/v1/tick-minute-fetch/health
//   GET /functions/v1/tick-minute-fetch/probe          ← 排障先看这个（上游通不通、多快）
//   GET /functions/v1/tick-minute-fetch/probe?keys=all ← 每把 key 各探一遍（分辨「是不是额度用完了」）
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

  // ── 上游时间预算（2026-10-10 修）────────────────────────────────────────
  // 【事故】前端曾报「分笔抓取接口不可达：请求 /minute 失败（signal is aborted without reason）」。
  //   真因不是跨域、也不是没部署，而是【后端最坏比前端等得久】：
  //   旧值 REQUEST_TIMEOUT_MS=20000，fetchMinute 会依次试 2 个专线端点 ⇒ 最坏 20s×2=40s，
  //   而前端自己的超时只有 25s ⇒ 只要上游专线抽风一次（6688 端口对海外机房时常限流），
  //   前端必然先 abort，并把「我超时了」误报成「接口不可达 / 跨域被拦」，排查方向被彻底带偏。
  // 【红线】后端所有上游尝试的【总和】必须明显小于前端的 timeoutMs（见 src/data/tick-minute.js）。
  REQUEST_TIMEOUT_MS: Number(Deno.env.get('NUMCAT_TICK_TIMEOUT_MS') || 8000),
  // 所有端点尝试加起来的总预算（超过就不再开新的上游请求）
  TOTAL_BUDGET_MS: Number(Deno.env.get('NUMCAT_TICK_BUDGET_MS') || 15000),
  // 剩余预算低于这个值就【不】再开新的端点尝试（开了也会被总预算切掉，白烧一次上游额度）
  MIN_SLICE_MS: Number(Deno.env.get('NUMCAT_TICK_MIN_SLICE_MS') || 2500),
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
// ⚠️ [2026-10-10 已删「只取第一把 key」的旧辅助函数 primaryKey] 它原先被 runFetch / /probe
//    当成「唯一那把 key」用，而真正该走的是 configuredKeys() 的整套回退（见下方 isKeyLevelFailure）。留着它只会让
//    后人又写出「只认第一把 key」的代码，所以整段删掉、⛔ 不要再加回来。
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
async function numcatTickRaw(endpoint: string, key: string, symbols: string[], dateYmd: string, timeoutMs?: number): Promise<UpstreamSnapshot> {
  if (!key) {
    throw new Error('猫头鹰 key 未配置（请设置 Secrets: ' + KEY_PRIMARY + ' 或 ' + KEY_FALLBACK + '）');
  }
  // 本次允许等多久：默认取 REQUEST_TIMEOUT_MS；fetchMinute 在总预算快用完时会【收紧】它，
  // 避免最后一个端点把总预算整个吃穿（那会让前端先超时，症状同上方的【事故】注释）。
  const waitMs = (typeof timeoutMs === 'number' && timeoutMs > 0) ? timeoutMs : CONFIG.REQUEST_TIMEOUT_MS;
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
      signal: timeoutSignal(waitMs),
    });
  } catch (e) {
    const msg = (e as Error)?.message || String(e);
    throw new Error('上游请求未拿到响应（' + waitMs + 'ms 超时 / DNS / 端口不通）: ' + msg + '  [ep=' + endpoint + ']');
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
  /** 是否因为总预算用完而【主动放弃】了还没抓到的 symbol（前端据此区分「超时」与「真没有」） */
  budgetExhausted: boolean;
  /** 上游阶段总耗时（所有端点尝试之和） */
  elapsedMs: number;
};

/**
 * 取【一批 symbol】在这一分钟内的原始快照。
 *
 * 端点策略：按候选列表顺序尝试；每个端点只请求【还没拿到数据的 symbol】；
 * 某端点报错 ⇒ 记下错误、继续下一个端点（不中断整批）。
 *
 * 时间策略（2026-10-10 加，修「前端先超时」事故）：
 *   · 每次上游请求的等待 = min(REQUEST_TIMEOUT_MS, 剩余总预算)；
 *   · 剩余预算 < MIN_SLICE_MS ⇒ 不再开新端点尝试，置 budgetExhausted；
 *   · 于是本函数的【最坏耗时 ≤ TOTAL_BUDGET_MS】（默认 15s），
 *     小于前端 timeoutMs（60s）⇒ 前端永远能拿到后端的说法，而不是一句无信息的 abort。
 * ⛔ 不会无限重试（保护上游 3 次/秒的限流）。
 */
/**
 * 这次失败是不是「换一把 key 就能好」的那一类（额度用尽 / key 无效 / 没开通该接口）。
 *
 * ★ 为什么必须区分（2026-10-10 发现）：`configuredKeys()` 早就支持「主号回退」，
 *   但 `runFetch` 里只取了第一把 key —— 回退那把**从来没被用过**（注释在、代码不在）。
 *   现在按「失败是不是 key 级」决定要不要换下一把：
 *     · key 级（403 额度 / invalid api key）→ 换下一把有意义，且这类失败【很快返回】，
 *       多花的一次调用换来「不白白失败」，划算；
 *     · 超时 / 网络 / 参数被忽略 → 换 key 救不了（上游根本没回我们），⛔ 不换，省一次额度。
 */
function isKeyLevelFailure(fr: FetchResult): boolean {
  if (fr.bySymbol.size > 0) return false;
  const blob = fr.attempts.map((a) => String(a.error || '')).join(' | ').toLowerCase();
  return blob.indexOf('额度') >= 0 || blob.indexOf('403') >= 0
    || blob.indexOf('invalid api key') >= 0 || blob.indexOf('unauthorized') >= 0
    || blob.indexOf('未开通') >= 0 || blob.indexOf('权限') >= 0;
}

async function fetchMinute(symbols: string[], dateYmd: string, keyRef: KeyRef): Promise<FetchResult> {
  const endpoints = buildEndpoints();
  const bySymbol = new Map<string, RawTick[]>();
  let pending = symbols.slice(0);
  const attempts: Array<Record<string, unknown>> = [];
  let requests = 0;
  let budgetExhausted = false;
  const t0 = Date.now();

  const leftMs = () => CONFIG.TOTAL_BUDGET_MS - (Date.now() - t0);

  for (const ep of endpoints) {
    // 同一端点内可能有多批（pending > MAX_SYMBOLS_PER_CALL）；
    // ⚠️ 旧版只用 slice(0, MAX) 取一批就换端点 ⇒ 超过 60 只时后面的票会被【静默丢掉】。
    for (;;) {
      if (pending.length === 0) break;
      const left = leftMs();
      if (left < CONFIG.MIN_SLICE_MS) {
        budgetExhausted = true;
        break;
      }
      const batch = pending.slice(0, CONFIG.MAX_SYMBOLS_PER_CALL);
      const waitMs = Math.max(1000, Math.min(CONFIG.REQUEST_TIMEOUT_MS, left));
      try {
        requests++;
        const snap = await numcatTickRaw(ep, keyRef.key, batch, dateYmd, waitMs);
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
        // 这个端点对这批一个都没命中 ⇒ 再拿它切下一块也没意义，直接换端点（省一次上游调用）
        if (got.size === 0) break;
      } catch (e) {
        attempts.push({ endpoint: ep, ok: false, symbols: batch.length, elapsedMs: Date.now() - t0, error: (e as Error)?.message || String(e) });
        break;
      }
    }
    if (pending.length === 0 || budgetExhausted) break;
  }
  return { bySymbol, pending, attempts, requests, budgetExhausted, elapsedMs: Date.now() - t0 };
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

  const codes = Array.from(new Set(items.map((x) => x.code)));
  const keys = configuredKeys();
  if (keys.length === 0) {
    return { status: 200, body: { ok: false, error: '未配置猫头鹰 key：请在 Secrets 里设置 ' + KEY_PRIMARY + '（或 ' + KEY_FALLBACK + '）', date: dateIso } };
  }

  // ── 依次用「已配置的 key」（第一把不行且是 key 级失败 → 换下一把）──────────────
  // ⚠️ 与 auction-yizi-fetch 的「小号绝不碰主号」相反：本功能默认允许回退主号
  //    （用户 2026-10-10：「用猫抓数据的 key 就可以抓取猫头鹰数据的那些数据了」），
  //    要禁掉回退设 Secret NUMCAT_TICK_KEY_FALLBACK=0（见 configuredKeys）。
  const keyPasses: Array<Record<string, unknown>> = [];
  let keyRef: KeyRef = keys[0];
  let fr: FetchResult | null = null;
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    keyRef = k;
    const r = await fetchMinute(codes, dateYmd, k);
    keyPasses.push({
      key: k.name, keyMasked: maskKey(k.key),
      covered: r.bySymbol.size, requests: r.requests,
      elapsedMs: r.elapsedMs, budgetExhausted: r.budgetExhausted,
      keyLevelFailure: isKeyLevelFailure(r), attempts: r.attempts,
    });
    const isLast = i === keys.length - 1;
    // 拿到数据 / 已是最后一把 / 失败与 key 无关（换也是白换，省额度）⇒ 收手
    if (r.bySymbol.size > 0 || isLast || !isKeyLevelFailure(r)) { fr = r; break; }
  }
  if (!fr) fr = await fetchMinute(codes, dateYmd, keyRef);   // 理论上不可达（循环必赋值）

  // 上游一条都没返回（两个端点都没拿到）⇒ 不写库（§10：未就绪 ≠ 没有）
  if (fr.bySymbol.size === 0) {
    const errs = fr.attempts.filter((a) => !a.ok).map((a) => String(a.error || ''));
    const upstreamSlow = fr.budgetExhausted || errs.some((s) => s.indexOf('超时') >= 0 || s.indexOf('timeout') >= 0);
    // 额度用尽 / key 级失败：必须【单独说清楚】—— 它和「上游没数据」「超时」是完全不同的三件事，
    // 而且它是唯一一种「换 key 或等 0 点就能解决」的失败。
    const qBlob = JSON.stringify(keyPasses);
    const quotaOut = qBlob.indexOf('403') >= 0 || qBlob.indexOf('额度') >= 0;
    const keyLine = keyPasses.length > 1
      ? '【已依次试 ' + keyPasses.length + ' 把 key】' + keyPasses.map((p) => p.key + '(覆盖 ' + p.covered + ' 只)').join('；') + '。'
      : '';
    const quotaLine = quotaOut
      ? '上游原文含 `403 今日调用额度已用完` ⇒ 这是【额度用尽】，不是配置问题、也与跨域/部署无关：'
        + '上游免费档每日 10 次（猫爪+猫头鹰两站共享·按日 0 点重置）。处理：等次日 0 点，'
        + '或把有额度的 key 配到 ' + KEY_PRIMARY + ' 上。'
      : '';
    await writeLog(Object.assign({}, logBase, {
      ok: false, detail: { skipped: 'upstream-empty', attempts: fr.attempts, pending: fr.pending, requests: fr.requests, upstreamMs: fr.elapsedMs, budgetExhausted: fr.budgetExhausted, keyPasses: keyPasses.map((p) => ({ key: p.key, covered: p.covered, requests: p.requests, elapsedMs: p.elapsedMs })) },
    }));
    return {
      status: 200,
      body: {
        ok: false, skipped: 'upstream-empty', date: dateIso, dateYmd,
        keySource: keyRef.name, keyMasked: maskKey(keyRef.key),
        keyPasses,
        quotaExhausted: quotaOut,
        symbols: codes.length, missing, pending: fr.pending, attempts: fr.attempts,
        upstreamMs: fr.elapsedMs, budgetExhausted: fr.budgetExhausted, upstreamSlow,
        hint: keyLine + quotaLine + (upstreamSlow
          ? '【上游超时/被限流】' + fr.elapsedMs + 'ms 内没从专线拿到数据（预算 ' + CONFIG.TOTAL_BUDGET_MS + 'ms/把 key）。' +
            '这通常是 sz/sh.meoz.cn:6688 对海外机房（本项目 Edge 在 us-west-1）临时限流 —— 与 CORS、与函数是否部署【无关】。' +
            '隔 1~2 分钟重试即可；连续多次都这样再看下面。'
          : '上游这一分钟没有返回任何数据。') +
          '可能：① 猫头鹰的 tick_history 未开通 / key 无该接口权限（本 key: ' + keyRef.name + '）；' +
          '② 专线端口 6688 在本网段不通；③ 该日确实没有分笔数据（停牌 / 非交易日）。' +
          '自查顺序：先开 GET /probe 看每个端点的真实往返与上游原文，再看 /health 的端点与 key 来源。',
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
        keyPasses, attempts: fr.attempts, results,
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
      upstreamMs: fr.elapsedMs, budgetExhausted: fr.budgetExhausted,
      keyPasses: keyPasses.map((p) => ({ key: p.key, covered: p.covered, requests: p.requests, elapsedMs: p.elapsedMs })),
    },
  }));

  // ⚠️ §10：因【总预算用完】而没取到的票，必须单独回执 —— 它们既不是「无数据」也不是「抓到了」，
  //    前端据此【不】把它们标记成「已抓过」（否则会躺成「无数据」= 谎报，见 _handleResult）。
  const pendingSet = new Set(fr.pending);
  const uncovered = items.filter((it) => pendingSet.has(it.code)).map((it) => it.name);

  return {
    status: 200,
    body: {
      ok: true, date: dateIso, dateYmd,
      written, readBack,
      keySource: keyRef.name,
      keyPasses,
      table: 'tick_minute_open',
      window: CONFIG.START_TIME + '~' + CONFIG.END_TIME,
      symbols: codes.length,
      upstreamRequests: fr.requests,
      upstreamMs: fr.elapsedMs,
      budgetExhausted: fr.budgetExhausted,
      uncovered,
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
      numcatKeysMasked: keys.map((k) => k.name + '=' + maskKey(k.key)),
      keyFallbackEnabled: (Deno.env.get('NUMCAT_TICK_KEY_FALLBACK') || '1').trim() !== '0',
      keyFallbackRule: '第一把 key 若是【key 级失败】（403 额度 / invalid api key）→ 自动换下一把；超时/网络失败不换（省额度）。',
      window: { start: CONFIG.START_TIME, end: CONFIG.END_TIME, readyAfterBeijing: CONFIG.WINDOW_READY },
      requestTimeoutMs: CONFIG.REQUEST_TIMEOUT_MS,
      totalBudgetMs: CONFIG.TOTAL_BUDGET_MS,
      minSliceMs: CONFIG.MIN_SLICE_MS,
      upstreamWorstCaseMs: '≤ ' + (CONFIG.TOTAL_BUDGET_MS * Math.max(1, keys.length))
        + 'ms（' + Math.max(1, keys.length) + ' 把 key × 每把最多 ' + CONFIG.TOTAL_BUDGET_MS + 'ms）',
      maxSymbolsPerCall: CONFIG.MAX_SYMBOLS_PER_CALL,
      tokenSource: tokenSource(),
      table: 'tick_minute_open（先执行 db/create_tick_minute_open.sql 建表）',
      today: beijingToday(),
      nowBeijing: beijingHMS(),
      windowOpenNow: hmsToSec(beijingHMS()) >= hmsToSec(CONFIG.WINDOW_READY),
      fields: CONFIG.FIELDS,
      routes: {
        health: 'GET /health —— 只看配置（不回显密钥）',
        probe: 'GET /probe —— 【从 Edge 机房实测上游专线】连通性与往返耗时（只读、不写库；排障第一步；加 ?keys=all 可逐把 key 探）',
        minute: 'GET /minute?date=YYYY-MM-DD&stocks=名字:代码,名字 | POST /minute {date, items:[{name,code}]}',
      },
      nextStep: '第一次跑请先执行 db/create_tick_minute_open.sql，再配 NUMCAT_TICK_API_KEY（或复用 NUMCAT_API_KEY），最后关掉 Verify JWT（关了本页才不需要 apikey 就能直接打开）。',
      diagnosing: '前端报「不可达 / signal is aborted without reason」时：① 先 GET /probe 看上游通不通；'
        + '② 再 GET /health（若这里 401，说明 Verify JWT 还开着——本函数的 config.toml 声明是 false，'
        + '但【Dashboard 粘贴部署不读 config.toml】，必须手动关）；③ 两者都正常 ⇒ 是浏览器→Supabase 这一段。',
    });
  }

  // ── GET /probe —— 上游连通性自检（排障第一步）──────────────────────────────
  // 为什么必须有它：前端「超时 / 不可达 / 跨域」在浏览器里长得【一模一样】（fetch 抛错不带原因），
  //   只有从 Edge 机房这一侧实测，才能把「上游专线不通」和「浏览器→Supabase 这一段不通」分开。
  //   ⛔ 只读：不写 tick_minute_open、不占 9:31 闸门；成本 = 每端点 1 次上游调用（≤2 次）。
  if (p.endsWith('/probe')) {
    const dateRaw = (url.searchParams.get('date') || '').trim();
    const todayIso = beijingToday();
    const dateYmd = (dateRaw ? isoToYmd(dateRaw) : isoToYmd(todayIso)) || isoToYmd(todayIso) || '';
    if (!dateYmd) return json({ ok: false, error: 'date 必须是 YYYY-MM-DD 或 YYYYMMDD，收到：' + dateRaw }, 400);
    const probeSymbol = ((url.searchParams.get('symbol') || '000001').trim()) || '000001';
    // ?keys=all ⇒ 每把 key 各探一遍（用来回答「是不是这把 key 的额度用完了」）。
    //   默认只探第一把（成本 ≤2 次），加了 all 才是 把数 × 端点数 次。
    const allKeys = (url.searchParams.get('keys') || '').trim().toLowerCase() === 'all';
    const keys = configuredKeys();
    const probeKeys = allKeys ? keys : keys.slice(0, 1);
    if (probeKeys.length === 0) {
      return json({ ok: false, error: '未配置猫头鹰 key：请设置 Secrets ' + KEY_PRIMARY + '（或 ' + KEY_FALLBACK + '）', keySource: '未配置' }, 200);
    }
    const eps = buildEndpoints();
    const probes: Array<Record<string, unknown>> = [];
    for (const k of probeKeys) {
      for (const ep of eps) {
        const t0 = Date.now();
        try {
          // 与 /minute 走【完全同一条】上游路径（同 apiname / 同窗口 / 同字段），
          // 否则「/probe 通了但 /minute 不通」会变成新的假线索。
          const snap = await numcatTickRaw(ep, k.key, [probeSymbol], dateYmd, CONFIG.REQUEST_TIMEOUT_MS);
          probes.push({ key: k.name, keyMasked: maskKey(k.key), endpoint: ep, ok: true, roundTripMs: Date.now() - t0, upstreamElapsedMs: snap.elapsedMs, items: snap.items.length });
        } catch (e) {
          probes.push({ key: k.name, keyMasked: maskKey(k.key), endpoint: ep, ok: false, roundTripMs: Date.now() - t0, error: (e as Error)?.message || String(e) });
        }
      }
    }
    const anyOk = probes.some((x) => x.ok === true);
    const blob = JSON.stringify(probes);
    const quotaOut = blob.indexOf('403') >= 0 || blob.indexOf('额度') >= 0;
    return json({
      ok: anyOk,
      service: 'tick-minute-fetch',
      route: 'GET /probe —— 从 Edge 机房这一侧实测上游专线',
      probe: { symbol: probeSymbol, date: dateYmd, window: CONFIG.START_TIME + '~' + CONFIG.END_TIME, keysProbed: probeKeys.map((k) => k.name) },
      keySource: probeKeys[0].name,
      keyMasked: maskKey(probeKeys[0].key),
      keyCandidates: keys.map((k) => k.name + '=' + maskKey(k.key)),
      perRequestTimeoutMs: CONFIG.REQUEST_TIMEOUT_MS,
      upstreamRegion: Deno.env.get('SB_REGION') || Deno.env.get('DENO_REGION') || '(未暴露)',
      results: probes,
      quotaExhausted: quotaOut,
      verdict: anyOk
        ? '上游专线【通】。若前端仍报不可达/超时，问题就在「浏览器 → Supabase」这一段：跨域（看 /health 的 CORS）、本机代理、函数未部署、或 Verify JWT 未关 —— 与上游无关。'
        : (quotaOut
          ? '上游【专线通，但额度已用完】：原文含 `403 今日调用额度已用完`。这不是配置/部署/跨域问题 —— 上游免费档每日 10 次（猫爪+猫头鹰两站共享·按日 0 点重置）。加 `?keys=all` 可看每一把 key 的额度状态；换一把有额度的 key 配到 ' + KEY_PRIMARY + ' 即可立刻恢复。'
          : '上游专线【不通】。逐条看 results.error 原文：含「超时」= 被限流/端口被墙（等 1~2 分钟再试）；含「invalid api key」= key 无效或无 tick_history 权限；都不是 ⇒ 该日可能就是没有分笔数据（停牌/非交易日）。'),
      note: '本路由只读、不写库；成本 = 探的 key 数 × 端点数（默认 1 把 key ⇒ ≤2 次；加 &keys=all 则翻倍）。与 /minute 共享同一个每日额度。',
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
