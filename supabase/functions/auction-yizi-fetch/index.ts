// ============================================================================
// auction-yizi-fetch — Supabase Edge Function (Deno)
// 「竞价一字」看板数据源：每个交易日【北京 09:25~09:26】抓猫爪数据（numcat）
// 的 daily_auc_fd（竞价一字）接口 → auction_yizi 表。
//
// ── ⚠️ 本函数是一个【独立的小号专用函数】──────────────────────────────────
//   用户明确要求：这是另一只猫抓小号，必须独立、绝不与既有函数搞混。
//   因此本函数：
//     ① 独立文件名 / 独立 URL：/functions/v1/auction-yizi-fetch
//     ② 独立密钥变量：NUMCAT_API_KEY_YIZI（优先）→ NUMCAT_API_KEY_YIZI_AUCTION（备选）
//        ⛔ 默认【不】回退主账号 NUMCAT_API_KEY，即不消耗早盘竞价看板的额度
//           （真要让它在小号失败时借用主号，显式设 Secret NUMCAT_YIZI_KEY_FALLBACK=1）
//     ③ 独立令牌：AUCTION_YIZI_FETCH_TOKEN（未配置才回退复用 FETCH_TOKEN）
//     ④ 独立表：auction_yizi  ⑤ 独立日志 job='auction-yizi-fetch'
//     ⑥ 独立上游端点配置：NUMCAT_YIZI_ENDPOINTS / NUMCAT_YIZI_BASE_URL
//   改动本文件不会影响 bidding-a / limit-pool-fetch / numcat-proxy。
//
// ── 与 numcat-proxy 的关系 ────────────────────────────────────────────────
//   numcat-proxy 是给【前端】用的代理（读 NUMCAT_API_KEY）。
//   本函数【不走】numcat-proxy：自己直连上游，用自己那把 key。
//   两者唯一共享的是上游接口契约：POST {apiname, apikey, fields, params}
//   → { code:200, message, fields:[...], items:[[...]] }（items 是按 fields 顺序的
//   位置数组；本函数同时兼容「对象数组」形态，两种都解析，见 mapRows）。
//
// ── 上游端点（猫爪官方文档：daily_auc_fd）────────────────────────────────
//   公网备用   POST https://numcat.net/api/reference-proxy/stock/daily_auc_fd
//   生产专线   POST http://sz.numcat.net:8866/api    （深圳，按 apiname 分发）
//              POST http://sh.numcat.net:8866/api    （上海）
//   三种形态的请求体完全一致（apiname 都在 body 里），故本函数把端点做成
//   【候选列表，按序尝试，第一个返回成功的即被采用】，并在 /probe 回显哪个通。
//   ⚠️ 专线是 http 明文 + 非标准端口，Supabase/Deno 侧可能不放行 → 失败就自动
//      落到下一个候选，不需要你手工改代码。
//
// ── 职责（两个路由，写入两张【完全不同】的表，⛔ 绝不混用）──────────────────
//   ① 9:25 腿（/fetch，要 token）：抓 daily_auc_fd → 只保留「真一字」的行 →
//      整日对齐写入 **auction_yizi**（看板的池子真相）。不做题材分组、不选龙头、
//      不解析题材文本 —— 那些是【派生视图】，由前端 src/logic/yizi/ 在渲染时用
//      「快照 + 共享题材库 stock_topics」计算。落库只会多出第二个真相源。
//   ② 趋势腿（/trend，不校验 token）：抓 daily_auc + daily（另两个 apiname）→
//      四条腿写 **yizi_trend**（趋势面板的缓存，只补缺口、从不删除）。
//      详见文件下方「趋势（trend）」章节。⛔ 这条腿绝不碰 auction_yizi。
//
// ── 「一字」判据（★ 2026-09-15 已修正，务必读）──────────────────────────────
//   上游 params 不传 symbols ⇒ 默认返回【全市场】标的。
//
//   ❌ 旧判据（错的，已废弃）：「9:15~9:25 之间存在任一非空 fa_*」。
//      错在 fa_* 的语义只是「该时点上，匹配价 = 涨停价的竞价金额」——
//      **9:15~9:20 期间挂的涨停价买单是可以随时撤单的**（9:20 之后才不可撤）。
//      于是「9:15 挂过一笔涨停价买单、随后撤掉」的票全被当成一字收了进来。
//      现场：2026-09-18 全市场返回的 121 行里，按竞价涨幅看只有 8 行达涨停幅度，
//      另外 87 行只小涨 0~3%、23 行平盘或下跌（如 丽尚国潮 -0.24% / *ST景谷 0.00%）——
//      而同日 limit_pool 的涨停只有 77 只，**一字板 ⊆ 涨停板 ⇒ 121 只根本不可能**。
//
//   ✅ 新判据（正确）：「9:25 集合竞价结束时的竞价涨幅（auc_pct_chg）达到该股涨停幅度」。
//      语义上等价于「开盘价 = 涨停价」——竞价报价就打在涨停价上，这才是「竞价一字」。
//      涨停幅度按板块（A 股现行规则）：主板 10% / 主板 ST 5% / 创业板与科创板 20% / 北交所 30%；
//      容差 EPS=0.15pp 吸收「涨停价由前收×(1+幅度) 四舍五入到分」造成的 9.98% / 10.02% 误差。
//      竞价涨幅缺失/无法解析 → **丢弃并单独计数**（§10：无法判定 ≠ 不是一字，所以要能被看见）。
//
//   ⚠️ 判据的【唯一真相】在前端 src/logic/auction/limit-up.js（getLimitUpPct / isAuctionYiZi），
//      早盘竞价看板的「竞价一字红线」也在用同一份。
//      Supabase Edge Function 只能 bundle 函数目录内的文件，**无法 import 仓库 src/**，
//      因此这里保留一份等价实现（见下方 LIMIT_PCT_* + getLimitUpPct + isAuctionYiZi）。
//      ⛔ 改任何一边都必须同步另一边 —— 两处不一致会让「表里存什么」与「看板显示什么」分叉。
//      前端在读取后还会再闸一次（见 src/logic/yizi/model.js#filterYiziRows），
//      所以即使本函数未重新部署，看板口径仍然是正确的。
//
// ── 9:25~09:26 窗口（⛔ 绝不越过 09:26）──────────────────────────────────
//   pg_cron 在北京 09:25:00 触发（UTC 01:25，见 db/supabase_auction_yizi_cron.sql）。
//   函数内部：
//     · 早于 09:25:00 被触发（时钟偏差/冷启动外的早触发）→ 先等到 09:25:00；
//     · 从 09:25:00 起，每 ~8 秒打一次上游，拿到「非空结果」立刻写库并返回；
//     · 硬截止 = 09:25:55（留 5 秒给写库与回读校验），到点仍无数据 → 判定
//       「上游未就绪」→ 【不写库、不删除】（§10 未就绪 ≠ 没有），返回 ok:false。
//     ⛔ 全文没有任何「睡到 09:26 之后再试」的逻辑：最晚动作发生在 09:25:55。
//   · 迟到容错：若函数在 09:25:55 之后才被调用（cron 漏跑、冷启动卡顿、人工点开），
//     仍然【尝试一次】并在响应 lateBySec 标出 —— 因为 tradedate 已把日期钉死，
//     上游那一天的 9:25 快照是稳定的（fa_0925l 等字段是当日终值），补抓不会取到错值。
//   · 手动补抓（带 ?date=）：跳过交易日闸门与窗口，只尝试一轮（不轮询）。
//
// ── 幂等与安全 ─────────────────────────────────────────────────────────────
//   · 主键 (date, stock) upsert 覆盖；重跑同一日结果相同 → 不产生无意义变更。
//   · §11 删除安全：只有本轮被判定【就绪】(ready=true) 时才清理该日「本次已不在
//     一字池中」的旧行；未就绪（超时/上游报错/返回了别的日期）时【只 upsert 不删除】
//     —— 宁可多留旧行，也绝不把「没抓到」当成「已不是一字」而误删真数据。
//   · 行内 tradedate 与请求日期不一致的行会被丢弃（防止节假日/上游兜底返回上一交易日，
//     被错标成今天 → 造出假的日期行）。不一致过多时直接判未就绪，不写库。
//
// ── 部署（二选一）──────────────────────────────────────────────────────────
//   A. Dashboard：Functions → 新建 auction-yizi-fetch → 粘贴本文件全部内容 → Deploy。
//   B. CLI：supabase functions deploy auction-yizi-fetch
//          （本文件位置即 supabase/functions/auction-yizi-fetch/index.ts）
//   部署后必须做的四件事：
//     ⚠️ 0) 【先建表】在 SQL Editor 执行 db/create_auction_yizi.sql。
//          漏这一步的报错长相是：
//          `Could not find the table 'public.auction_yizi' in the schema cache`（PGRST205）
//          —— 这不是「调用方法不对」，就是那张表还不存在。
//     1) Secrets 里设置【另一只猫抓小号】的 key：NUMCAT_API_KEY_YIZI
//        （没有独立 key 时会回退 NUMCAT_API_KEY_YIZI_AUCTION，响应 keySource 会标出；
//         两把都没配 → 直接报错，绝不会偷偷用主账号的 NUMCAT_API_KEY）；
//     2) Secrets 里设置 AUCTION_YIZI_FETCH_TOKEN（未设置时回退复用 FETCH_TOKEN）；
//     3) Verify JWT：开或关都能跑 pg_cron（cron 里的 net.http_post 会带 anon 的
//        apikey + Authorization，平台鉴权直接通过）。只有想【用浏览器直接打开
//        /health、/probe】时才需要关掉它。
//   最后执行 db/supabase_auction_yizi_cron.sql 建立 pg_cron 定时（北京 09:25）。
//
// ── 手动触发（排查 / 补某日）──────────────────────────────────────────────
//   GET /functions/v1/auction-yizi-fetch/health           ← 只看配置（不回显密钥）
//   GET /functions/v1/auction-yizi-fetch/probe?token=…    ← 【出问题先开这个】
//        对每个「端点 × key」组合各打一次真实上游请求，回显 HTTP 状态 / 耗时 /
//        上游业务码 / 字段名单 / 命中「一字」行数 / 首行样例 + 顺带探 auction_yizi
//        表在不在 → 一眼分清是 key 坏了、端点不对、还是表没建。
//   GET /functions/v1/auction-yizi-fetch/fetch?token=<TOKEN>
//   GET ...&date=2026-09-18    ← 补抓指定交易日（YYYY-MM-DD，跳过窗口与交易日闸门）
//   GET ...&once=1             ← 只打一轮上游（不轮询到 09:25:55），排查用
// ============================================================================

// ----------------------------- 配置 -----------------------------
const CONFIG = {
  SUPABASE_URL: (Deno.env.get('SUPABASE_URL') || 'https://tonqfgeyxnnwicjopshn.supabase.co').replace(/\/$/, ''),

  // 上游 apiname（猫爪文档固定值）+ 请求字段（顺序即上游 items 的位置顺序）
  APINAME: 'daily_auc_fd',
  FIELDS: [
    'tradedate', 'symbol', 'name', 'auc_pct_chg', 'theme_names_kpl', 'theme_names_xgb',
    'auc_amt', 'auc_turnover',
    'fa_0915', 'fa_0916', 'fa_0917', 'fa_0918', 'fa_0919', 'fa_0920', 'fa_0921',
    'fa_0922', 'fa_0923', 'fa_0924', 'fa_0925', 'fa_0920f', 'fa_0925l',
    'is_st',
  ],

  // 单次上游请求超时（全市场请求体量较大，给足 25 秒）
  REQUEST_TIMEOUT_MS: Number(Deno.env.get('NUMCAT_YIZI_TIMEOUT_MS') || 25000),
  // 单次上游请求重试次数（上游对重接口限流约 3 次/秒，突发失败重试即可过）
  RETRY_TIMES: 2,
  // 落库分批
  WRITE_CHUNK: 500,

  // ── 9:25 窗口（北京，HH:MM:SS）──
  WINDOW_START: (Deno.env.get('AUCTION_YIZI_WINDOW_START') || '09:25:00').trim(),
  // ⛔ 硬截止：全文最晚动作时间，绝不越过 09:26
  WINDOW_DEADLINE: (Deno.env.get('AUCTION_YIZI_WINDOW_DEADLINE') || '09:25:55').trim(),
  // 窗口内轮询间隔
  POLL_MS: Number(Deno.env.get('AUCTION_YIZI_POLL_MS') || 8000),
  // 早到时的最长等待（防止把函数挂死；cron 准点触发时这个分支基本不走到）
  MAX_EARLY_WAIT_MS: Number(Deno.env.get('AUCTION_YIZI_MAX_EARLY_WAIT_MS') || 90000),
};

// --------------------------- 上游端点候选 ---------------------------
const EP_PUBLIC = 'https://numcat.net/api/reference-proxy/stock/daily_auc_fd';
const EP_SZ = 'http://sz.numcat.net:8866/api';
const EP_SH = 'http://sh.numcat.net:8866/api';

/**
 * 端点候选列表（按序尝试，第一个「请求成功」的即被采用）。
 *
 * 配置优先级：
 *   1) NUMCAT_YIZI_ENDPOINTS（逗号分隔）—— 最强，直接覆盖，想排什么顺序都行；
 *   2) NUMCAT_YIZI_BASE_URL —— 单端点：
 *        · 已含 daily_auc_fd        → 原样当作完整端点；
 *        · 以 /reference-proxy 结尾 → 追加 /stock/daily_auc_fd；
 *        · 其它（如专线 .../api）   → 原样当作「按 apiname 分发」的端点；
 *   3) 都没配 → 公网 → 深圳专线 → 上海专线。
 */
function buildEndpoints(): string[] {
  const raw = (Deno.env.get('NUMCAT_YIZI_ENDPOINTS') || '').trim();
  if (raw) {
    const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
    if (list.length) return list;
  }
  const base = (Deno.env.get('NUMCAT_YIZI_BASE_URL') || '').trim().replace(/\/$/, '');
  if (base) {
    if (base.indexOf('daily_auc_fd') >= 0) return [base];
    if (base.endsWith('/reference-proxy')) return [base + '/stock/daily_auc_fd'];
    return [base];
  }
  return [EP_PUBLIC, EP_SZ, EP_SH];
}

// --------------------------- 密钥（小号专用） ---------------------------
// ⚠️ 一律在【请求时】读取 Deno.env 并 .trim()：
//    · 不在模块加载期固化 —— 避免冷启动期 env 未就绪把 key 固化成空串
//      （症状是「健康检查说没配、其实配了」）；
//    · 必 trim —— Secret 从输入框粘贴常带尾随空格/换行，那会让请求体带脏字符，
//      上游表现成「不响应/超时」，极难肉眼发现。
type KeyRef = { name: string; key: string };

const KEY_PRIMARY = 'NUMCAT_API_KEY_YIZI';
const KEY_ALT = 'NUMCAT_API_KEY_YIZI_AUCTION';
const KEY_LEGACY = 'NUMCAT_API_KEY';

/** 已配置的 key（按优先级）。⛔ 默认不含主账号 —— 本函数是独立小号，不共用额度。 */
function configuredKeys(): KeyRef[] {
  const list: KeyRef[] = [];
  const primary = (Deno.env.get(KEY_PRIMARY) || '').trim();
  const alt = (Deno.env.get(KEY_ALT) || '').trim();
  if (primary) list.push({ name: KEY_PRIMARY, key: primary });
  if (alt && alt !== primary) list.push({ name: KEY_ALT, key: alt });

  // 兜底默认【关闭】：用户要求小号独立，失败宁可失败也不悄悄烧主账号额度。
  if ((Deno.env.get('NUMCAT_YIZI_KEY_FALLBACK') || '0').trim() === '1') {
    const legacy = (Deno.env.get(KEY_LEGACY) || '').trim();
    if (legacy && !list.some((x) => x.key === legacy)) {
      list.push({ name: KEY_LEGACY + '(兜底)', key: legacy });
    }
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
/** 'YYYY-MM-DD' → 'YYYYMMDD'（上游 tradedate 口径） */
function isoToYmd(iso: string): string {
  return String(iso || '').replace(/-/g, '');
}
/** 'YYYYMMDD' → 'YYYY-MM-DD'；非法 → null */
function ymdToIso(ymd: unknown): string | null {
  const s = String(ymd === null || ymd === undefined ? '' : ymd).trim();
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  // 兼容上游直接返回 'YYYY-MM-DD'
  const m2 = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m2 ? s : null;
}
function isWeekend(dateStr: string): boolean {
  const day = new Date(dateStr + 'T00:00:00').getDay();
  return day === 0 || day === 6;
}
// ⚠️ 与 supabase/functions/limit-pool-fetch/index.ts 的 KNOWN_HOLIDAYS 保持同步。
//    本函数【不】调上游交易日历接口（省小号配额）：只用本地日历判断，
//    若遇调休/临时休市，手动 ?date= 补抓即可（补抓不受闸门限制）。
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

/** 带超时的 signal（AbortSignal.timeout 不可用时返回 undefined，退化为无超时） */
function timeoutSignal(ms: number): AbortSignal | undefined {
  try {
    const t = (AbortSignal as unknown as { timeout?: (m: number) => AbortSignal }).timeout;
    return typeof t === 'function' ? t.call(AbortSignal, ms) : undefined;
  } catch (_e) {
    return undefined;
  }
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}

// --------------------------- 字段归一 ---------------------------
/** 涨幅数值 → 库内统一文本口径；无法解析 → null（绝不用 0 顶替，0 是真实涨幅） */
function numPctText(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!isFinite(n)) return null;
  return (n >= 0 ? '+' : '') + n.toFixed(2);
}
/** 数值字段归一：非有限值 → null */
function numOrNull(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return isFinite(n) ? n : null;
}
/** 文本字段归一：空串/空白 → null */
function textOrNull(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  return s ? s : null;
}
/** 布尔字段归一：兼容 true/false、'TRUE'/'FALSE'、1/0、是/否；无法判断 → null */
function boolOrNull(raw: unknown): boolean | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'boolean') return raw;
  const s = String(raw).trim().toLowerCase();
  if (s === 'true' || s === '1' || s === '是' || s === 'y' || s === 'yes') return true;
  if (s === 'false' || s === '0' || s === '否' || s === 'n' || s === 'no') return false;
  return null;
}

/**
 * 解析竞价涨幅 → number|null。
 * 兼容上游可能返回的三种形态：number（10.03）/ 数字字符串（'+10.03'、'-0.24'、'10.03%'）。
 * ⛔ 解析不出来返回 null（绝不退化成 0 —— 0 是真实涨幅，会把「没数据」混成「平盘」）。
 */
function parsePctNum(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const s = String(raw).replace(/[%\s]/g, '').replace(/^\+/, '').replace(/[−—]/g, '-');
  if (!s) return null;
  const n = Number(s);
  return isFinite(n) ? n : null;
}

// ── 涨停幅度（按板块）：与 src/logic/auction/limit-up.js 的常量保持同值 ──
const LIMIT_MAIN = 10;    // 主板（60 / 00 / 01 开头）
const LIMIT_ST = 5;       // 主板 ST / *ST
const LIMIT_GROWTH = 20;  // 创业板（30x）/ 科创板（68x）；ST 同样 20
const LIMIT_BJ = 30;      // 北交所（43 / 83 / 87 / 88 / 92 开头）
// 容差：涨停价 = round(前收 × (1+幅度), 2)，实际涨幅常见 9.98% / 10.02% → 不能严格 >=
const EPS = 0.15;

/** 股票名是否 ST（与前端 isStStockName 同口径） */
function isStStockName(name: string): boolean {
  if (!name) return false;
  return /\*?\s*ST/i.test(String(name));
}

/**
 * 取涨停幅度（%）——只依赖代码与股票名，不做任何请求。
 * ⚠️ 必须与 src/logic/auction/limit-up.js#getLimitUpPct 完全一致（改了要同步）。
 * 代码缺失 → 按主板 10% 兜底（绝大多数标的所在板块），⛔ 不因缺代码就判成 0。
 */
function getLimitUpPct(code: string, name: string): number {
  const c = String(code || '').replace(/\D/g, '');
  if (!c) return isStStockName(name) ? LIMIT_ST : LIMIT_MAIN;
  if (/^(43|83|87|88|92)/.test(c)) return LIMIT_BJ;
  if (/^(30|68)/.test(c)) return LIMIT_GROWTH;
  if (/^(60|00|01)/.test(c)) return isStStockName(name) ? LIMIT_ST : LIMIT_MAIN;
  return isStStockName(name) ? LIMIT_ST : LIMIT_MAIN;
}

/**
 * 「竞价一字」判定（★ 本函数的唯一入库判据）。
 *   竞价涨幅 + EPS >= 涨停幅度 ⇒ 9:25 竞价报价就打在涨停价上 ⇒ 一字。
 * ⚠️ 必须与 src/logic/auction/limit-up.js#isAuctionYiZi 完全一致（改了要同步）。
 */
function isAuctionYiZiPct(pct: number | null, code: string, name: string): boolean {
  if (pct === null) return false;
  return pct + EPS >= getLimitUpPct(code, name);
}

/**
 * 封单额字段的【时间顺序】（用于算「首次封上时刻」与「9:25 口径封单额」）。
 * 顺序依据猫爪文档语义：
 *   fa_0915          9:15 后第一笔（隔夜封单额）
 *   fa_0916..fa_0925 该分钟前最后一笔
 *   fa_0920f         9:20 后第一笔   → 排在 fa_0920 之后、fa_0921 之前
 *   fa_0925l         9:25 后最后一笔 → 排在 fa_0925 之后
 */
const FA_SEQ: Array<[string, string]> = [
  ['fa_0915', '09:15'],
  ['fa_0916', '09:16'],
  ['fa_0917', '09:17'],
  ['fa_0918', '09:18'],
  ['fa_0919', '09:19'],
  ['fa_0920', '09:20'],
  ['fa_0920f', '09:20'],
  ['fa_0921', '09:21'],
  ['fa_0922', '09:22'],
  ['fa_0923', '09:23'],
  ['fa_0924', '09:24'],
  ['fa_0925', '09:25'],
  ['fa_0925l', '09:25'],
];

// --------------------------- 上游请求 ---------------------------
type NumcatError = Error & { httpStatus?: number; elapsedMs?: number; code?: number; endpoint?: string };
function numcatErr(msg: string, httpStatus?: number, elapsedMs?: number, code?: number, endpoint?: string): NumcatError {
  const e = new Error(msg) as NumcatError;
  e.httpStatus = httpStatus;
  e.elapsedMs = elapsedMs;
  e.code = code;
  e.endpoint = endpoint;
  return e;
}

type RawSnapshot = { fields: string[]; items: unknown[]; endpoint: string; elapsedMs: number };

/**
 * 打一次上游（单个端点 + 单把 key）。
 *
 * 请求体对三种端点形态都成立：apiname 放在 body 里
 *   { apiname:'daily_auc_fd', apikey, fields:'a,b,c', params:{ tradedate:'YYYYMMDD' } }
 * （公网 reference-proxy 路径靠 URL 选接口；专线 /api 靠 body 里的 apiname 分发）
 *
 * ⚠️ 不传 params.symbols ⇒ 上游默认返回全市场；这正是我们要的（由 fa_* 判一字）。
 */
async function numcatFetchRaw(endpoint: string, key: string, dateYmd: string): Promise<RawSnapshot> {
  if (!key) throw numcatErr('猫抓小号 key 未配置（请设置 Secrets: ' + KEY_PRIMARY + '）', undefined, undefined, undefined, endpoint);
  const body = {
    apiname: CONFIG.APINAME,
    apikey: key,
    fields: CONFIG.FIELDS.join(','),
    params: { tradedate: dateYmd },
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
    throw numcatErr('上游请求未拿到响应（' + CONFIG.REQUEST_TIMEOUT_MS + 'ms 超时 / DNS / 端口不通）: ' + msg,
      undefined, Date.now() - t0, undefined, endpoint);
  }
  const elapsedMs = Date.now() - t0;
  const text = await resp.text();
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch (_e) {
    throw numcatErr('上游返回非 JSON: HTTP ' + resp.status + ' ' + text.slice(0, 200), resp.status, elapsedMs, undefined, endpoint);
  }

  const code = typeof json.code === 'number' ? json.code : (resp.ok ? 200 : resp.status);
  if (!resp.ok) {
    throw numcatErr('上游 HTTP ' + resp.status + ': ' + String(json.message || text.slice(0, 200)), resp.status, elapsedMs, code, endpoint);
  }
  if (code !== 200) {
    // 上游业务错误：最常见是 key 无效 / 未授权该接口 / 超配额 → 原样透出 message
    throw numcatErr('上游业务码 code=' + code + ' ' + String(json.message || ''), resp.status, elapsedMs, code, endpoint);
  }

  // 兼容三种包裹形态：
  //   { code:200, fields, items }                       （最常见）
  //   { code:200, data: { fields, items } }             （外层再包一层）
  //   { code:200, results: [{ code, data:{fields,items} }] }（批量形态）
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

/** 重试包装：上游限流是突发性的；logs 传入时逐次记录失败明细（超时类问题靠这行定位） */
async function retryNumcat<T>(fn: () => Promise<T>, times: number, label: string, logs?: string[]): Promise<T> {
  let lastErr: unknown = null;
  for (let i = 1; i <= times; i++) {
    const t0 = Date.now();
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (logs) {
        const ne = e as NumcatError;
        logs.push(label + ' 第' + i + '/' + times + '次失败（' + (Date.now() - t0) + 'ms' +
          (ne?.httpStatus !== undefined ? ' HTTP ' + ne.httpStatus : '') +
          (ne?.code !== undefined ? ' code=' + ne.code : '') + '）: ' + ((e as Error)?.message || String(e)));
      }
      if (i < times) await sleep(700 * i);
    }
  }
  const le = lastErr as NumcatError;
  throw numcatErr(label + ' 重试 ' + times + ' 次仍失败: ' + ((lastErr as Error)?.message || String(lastErr)),
    le?.httpStatus, le?.elapsedMs, le?.code, le?.endpoint);
}

// --------------------------- 行映射 ---------------------------
type YiziRow = Record<string, unknown>;
type MapResult = {
  rows: YiziRow[];
  total: number;
  /** 竞价涨幅未达涨停幅度 → 不是一字（★ 新判据的主丢弃项） */
  droppedNotLimit: number;
  /** 其中「竞价涨幅缺失/无法解析 → 无法判定」的只数（§10：不猜，但必须能被看见） */
  droppedNoPct: number;
  droppedNoName: number;
  droppedDateMismatch: number;
  dateSeen: string[];
};

/**
 * 取值器：兼容 items 的两种形态。
 *   ① 位置数组（上游实际返回）：items = [['000001','平安银行',...], ...]，按 fields 顺序取值；
 *   ② 对象数组（防御性兼容）：items = [{ symbol:'000001', ... }]。
 * 两种都支持之后，上游哪天换了形态也不用改本函数。
 */
function makeGetter(fields: string[], row: unknown): (name: string) => unknown {
  if (Array.isArray(row)) {
    const idx: Record<string, number> = {};
    for (let i = 0; i < fields.length; i++) idx[fields[i]] = i;
    return (name: string) => (idx[name] === undefined ? null : (row as unknown[])[idx[name]]);
  }
  const obj = (row && typeof row === 'object') ? row as Record<string, unknown> : {};
  return (name: string) => (name in obj ? obj[name] : null);
}

/**
 * 上游行 → auction_yizi 入库行。
 * @param reqDate 请求的交易日 'YYYY-MM-DD'（用于丢弃「上游返回了别的日期」的行）
 * @returns null = 该行不可用（无名称 / 不是一字 / 日期不符），由调用方按类别计数
 */
function yiziRow(fields: string[], rawRow: unknown, reqDate: string, nowIso: string, counters: {
  notLimit: number; noPct: number; noName: number; dateMismatch: number; dateSeen: string[];
}): YiziRow | null {
  const get = makeGetter(fields, rawRow);
  const name = textOrNull(get('name'));
  if (!name) { counters.noName++; return null; }

  const rowDate = ymdToIso(get('tradedate'));
  if (rowDate) {
    if (counters.dateSeen.indexOf(rowDate) < 0) counters.dateSeen.push(rowDate);
    if (rowDate !== reqDate) { counters.dateMismatch++; return null; }
  }

  const symbol = textOrNull(get('symbol'));
  const codeRaw = String(symbol || '').replace(/\..*$/, '').trim();
  const code = /^\d{6}$/.test(codeRaw) ? codeRaw : null;

  // ⭐⭐「一字」判据（★ 2026-09-15 修正）：9:25 竞价涨幅达到该股涨停幅度。
  //    ⛔ 不再是「存在任一非空 fa_*」—— 9:20 前的涨停价买单可撤单，那个判据会收进大量非一字票。
  const aucPctNum = parsePctNum(get('auc_pct_chg'));
  if (!isAuctionYiZiPct(aucPctNum, code || '', name)) {
    counters.notLimit++;
    if (aucPctNum === null) counters.noPct++;   // 无法判定：单独计数，便于排查上游字段缺失
    return null;
  }

  // 封单额证据链（单位：元），null = 该时点没有「匹配价 = 涨停价」的成交。
  // ⚠️ 这是【展示数据】，不参与上面的一字判据。
  const fa: Record<string, number | null> = {};
  let faCount = 0;
  let firstLabel: string | null = null;
  let sealMoney: number | null = null;
  for (let i = 0; i < FA_SEQ.length; i++) {
    const col = FA_SEQ[i][0];
    const v = numOrNull(get(col));
    fa[col] = v;
    if (v !== null) {
      faCount++;
      if (firstLabel === null) firstLabel = FA_SEQ[i][1];   // FA_SEQ 已按时间升序 → 首个非空即「首次封上」
      sealMoney = v;                                        // 持续覆盖 → 循环结束即「时间上最后一笔非空」
    }
  }

  const out: YiziRow = {
    date: reqDate,
    stock: name,
    code: code,
    symbol: symbol,
    name: name,
    auc_pct_chg: numPctText(get('auc_pct_chg')),
    auc_amt: numOrNull(get('auc_amt')),
    auc_turnover: numOrNull(get('auc_turnover')),
    seal_money: sealMoney,
    fa_count: faCount,
    fa_first: firstLabel,
    theme_kpl: textOrNull(get('theme_names_kpl')),
    theme_xgb: textOrNull(get('theme_names_xgb')),
    is_st: boolOrNull(get('is_st')),
    updated_at: nowIso,
  };
  // 13 个 fa_* 列名与上游字段名完全一致 → 直接铺开，避免手写 13 行出错
  const cols = Object.keys(fa);
  for (let i = 0; i < cols.length; i++) out[cols[i]] = fa[cols[i]];
  return out;
}

/** 把一次上游返回的 items 全量映射为入库行（含丢弃分类计数） */
function mapRows(fields: string[], items: unknown[], reqDate: string): MapResult {
  const nowIso = new Date().toISOString();
  const counters = { notLimit: 0, noPct: 0, noName: 0, dateMismatch: 0, dateSeen: [] as string[] };
  const rows: YiziRow[] = [];
  for (let i = 0; i < items.length; i++) {
    const r = yiziRow(fields, items[i], reqDate, nowIso, counters);
    if (r) rows.push(r);
  }
  return {
    rows: rows,
    total: items.length,
    droppedNotLimit: counters.notLimit,
    droppedNoPct: counters.noPct,
    droppedNoName: counters.noName,
    droppedDateMismatch: counters.dateMismatch,
    dateSeen: counters.dateSeen,
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

/**
 * 把 PostgREST 的「找不到表」原文翻译成「该干什么」。
 * 典型现场：红字 `Could not find the table 'public.auction_yizi' in the schema cache`
 * —— 它不是「调用方法不对」，就是【表还没建】（PGRST205 / 42P01）。
 *
 * 🔴 本函数服务【两张表】（auction_yizi 与趋势缓存 yizi_trend），所以建表提示必须跟着表名走。
 *    2026-09-19 实测事故：趋势表没建时，提示却指向 `create_auction_yizi.sql`
 *    （因为原来把 auction_yizi 的提示写死了）⇒ 用户照做也建不出 yizi_trend，
 *    「部署了但还是不行」的排查被再带偏一次。这里改为【从 PostgREST 原文里认表名】，
 *    调用方无需改动（原文里一定带 `public.<表名>`）。
 */
function sbErrHint(msg: string, raw: string): string {
  const t = (raw || '').toLowerCase();
  if (t.includes('could not find the table') || t.includes('in the schema cache') ||
    t.includes('does not exist') || t.includes('42p01') || t.includes('pgrst205')) {
    const isTrend = t.includes(TREND.TABLE.toLowerCase());
    const table = isTrend ? TREND.TABLE : 'auction_yizi';
    const sql = isTrend ? 'db/create_yizi_trend.sql' : 'db/create_auction_yizi.sql';
    return msg + '  → 【' + table + ' 表不存在】请在 Supabase Dashboard → SQL Editor 执行 ' + sql + ' 建表（本仓库 db/ 目录）。';
  }
  return msg;
}

/** 写入 auction_yizi（主键 date+stock → 幂等覆盖） */
async function upsertAuctionYiziRows(rows: YiziRow[]): Promise<number> {
  const payload = (rows || []).filter((r) => r && r.date && r.stock);
  if (payload.length === 0) return 0;
  const url = CONFIG.SUPABASE_URL + '/rest/v1/auction_yizi?on_conflict=date%2Cstock';
  for (let i = 0; i < payload.length; i += CONFIG.WRITE_CHUNK) {
    const resp = await fetch(url, {
      method: 'POST',
      headers: sbHeaders({ 'Prefer': 'resolution=merge-duplicates, return=minimal' }),
      body: JSON.stringify(payload.slice(i, i + CONFIG.WRITE_CHUNK)),
      signal: timeoutSignal(30000),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(sbErrHint('upsert auction_yizi 失败: HTTP ' + resp.status + ': ' + text.slice(0, 300), text));
    }
  }
  return payload.length;
}

/**
 * 删除某日「已不在本次快照中」的旧行（§11 删除安全）。
 *
 * 安全约束（调用方必须保证）：
 *   · keepStocks 来自【本次权威抓取结果】，且该次抓取被判定为【就绪】(ready=true)；
 *   · 只按 date 限定范围，绝不触碰其它日期；
 *   · ⚠️ 一字池「当日 0 只」几乎不可能出现（那就说明上游没就绪，调用方根本不会走到这里），
 *     所以 keepStocks 为空时【不删】—— 避免把「一次空返回」放大成「清空整天」。
 *
 * ⚠️ PostgREST 的 DELETE 必须带 `Prefer: return=representation` 才会回读被删行；
 *    否则返回空数组，无法校验实际删除条数。
 */
async function deleteStaleAuctionYizi(date: string, keepStocks: string[]): Promise<number> {
  if (!date) return 0;
  const keep = (keepStocks || []).map((s) => String(s).trim()).filter(Boolean);
  if (keep.length === 0) return 0;
  // 用 split/join 而非正则去引号：转义更直观、也不依赖正则字面量
  const url = CONFIG.SUPABASE_URL + '/rest/v1/auction_yizi?date=eq.' + encodeURIComponent(date) +
    '&stock=not.in.(' + keep.map((s) => '"' + s.split('"').join('') + '"').join(',') + ')';
  const resp = await fetch(url, {
    method: 'DELETE',
    headers: sbHeaders({ 'Prefer': 'return=representation' }),
    signal: timeoutSignal(30000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(sbErrHint('delete auction_yizi 失败: HTTP ' + resp.status + ': ' + text.slice(0, 300), text));
  }
  const data = await resp.json().catch(() => []);
  return ((data as unknown[]) || []).length;
}

/** 运行日志写入 bidding_fetch_log（与 bidding-a / limit-pool-fetch 同一张表，便于统一排查）。失败忽略。 */
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
type FetchOpts = { date?: string; source?: string; once?: boolean };

/**
 * 抓竞价一字 → 整日对齐写入 auction_yizi。
 *
 * @param opts.date   'YYYY-MM-DD' 指定交易日（默认北京今天）。指定日期 = 人工补抓，
 *                    跳过交易日闸门与 9:25 窗口，只尝试一轮。
 * @param opts.once   true = 只打一轮上游（不轮询到 09:25:55），排查用。
 */
async function runAuctionYizi(opts?: FetchOpts): Promise<Record<string, unknown>> {
  const logs: string[] = [];
  const manualDate = !!(opts && opts.date);
  const today = (opts && opts.date) || beijingToday();
  const dateCandidates = buildEndpoints();
  const keys = configuredKeys();

  logs.push('date=' + today + (manualDate ? '（手动指定日期，跳过窗口/闸门）' : '') +
    ' 北京时刻=' + beijingHMS() + ' 上游候选端点=' + dateCandidates.join(' , '));

  const logBase = {
    run_date: today,
    time_point: 'yizi-0925',
    source: (opts && opts.source) || 'cron',
    job: 'auction-yizi-fetch',
    worker: 'edge-auction-yizi',
  };

  // 1) 交易日闸门（手动指定日期 → 视为补抓，不受闸门限制）
  if (!manualDate && !localIsTradingDay(today)) {
    logs.push('非交易日，跳过');
    await writeLog(Object.assign({}, logBase, { ok: false, detail: { skipped: '非交易日' } }));
    return { ok: true, today: today, skipped: true, reason: '非交易日', logs: logs };
  }
  if (manualDate && !localIsTradingDay(today)) logs.push('⚠️ 该日按本地日历非交易日，仍按手动补抓执行');

  // 2) key 闸门
  if (keys.length === 0) {
    const msg = '未配置猫抓小号 key（请设 Secrets: ' + KEY_PRIMARY + ' 或 ' + KEY_ALT + '）';
    logs.push(msg);
    await writeLog(Object.assign({}, logBase, { ok: false, detail: { error: msg } }));
    return { ok: false, today: today, error: msg, logs: logs };
  }
  logs.push('候选 key：' + keys.map((c) => c.name + '/' + maskKey(c.key)).join(' → ') +
    ((Deno.env.get('NUMCAT_YIZI_KEY_FALLBACK') || '0').trim() === '1'
      ? '（⚠️ 已启用主账号兜底 NUMCAT_YIZI_KEY_FALLBACK=1）'
      : '（主账号兜底已关闭：本小号失败即失败，不烧主账号额度）'));

  // 3) 9:25 窗口时间轴（北京秒数）
  const startSec = hmsToSec(CONFIG.WINDOW_START);
  const deadlineSec = hmsToSec(CONFIG.WINDOW_DEADLINE);
  if (!isFinite(startSec) || !isFinite(deadlineSec) || deadlineSec <= startSec) {
    const msg = '窗口配置非法: WINDOW_START=' + CONFIG.WINDOW_START + ' WINDOW_DEADLINE=' + CONFIG.WINDOW_DEADLINE;
    logs.push(msg);
    await writeLog(Object.assign({}, logBase, { ok: false, detail: { error: msg } }));
    return { ok: false, today: today, error: msg, logs: logs };
  }

  const singleShot = manualDate || !!(opts && opts.once);
  let lateBySec = 0;
  let windowWaitMs = 0;

  if (!singleShot) {
    const nowSec = hmsToSec(beijingHMS());
    if (nowSec < startSec) {
      // 早到（cron 时钟偏差 / 人工提前触发）→ 等到 09:25:00 再开始，且不超过安全上限
      const waitMs = Math.min((startSec - nowSec) * 1000, CONFIG.MAX_EARLY_WAIT_MS);
      windowWaitMs = waitMs;
      logs.push('早于窗口起点 ' + CONFIG.WINDOW_START + '（当前 ' + beijingHMS() + '）→ 等待 ' +
        Math.round(waitMs / 1000) + ' 秒后开始（上限 ' + Math.round(CONFIG.MAX_EARLY_WAIT_MS / 1000) + ' 秒）');
      await sleep(waitMs);
    } else if (nowSec > deadlineSec) {
      // 迟到（cron 漏跑 / 冷启动卡顿 / 人工点开）→ 仍尝试一轮，并明确标出迟到秒数。
      // 依据：params.tradedate 已把日期钉死，上游那一天 9:25 的快照是稳定的（fa_0925l 等为当日终值），
      // 补抓不会取到错值；不写库反而会让看板整天空白。
      lateBySec = nowSec - deadlineSec;
      logs.push('⚠️ 已过窗口硬截止 ' + CONFIG.WINDOW_DEADLINE + '（当前 ' + beijingHMS() + '，迟到 ' + lateBySec +
        ' 秒）→ 仍尝试一轮（日期已用 tradedate 钉死，取到的仍是该日 9:25 快照）');
    }
  } else {
    logs.push('单轮模式（' + (manualDate ? '手动补抓' : 'once=1') + '）→ 不轮询');
  }

  // 4) 计算真实硬截止（迟到情形下给一轮的时间；否则 = 窗口截止时刻）
  const startedAt = Date.now();
  let hardDeadlineMs: number;
  if (singleShot || lateBySec > 0) {
    hardDeadlineMs = startedAt + Math.min(CONFIG.REQUEST_TIMEOUT_MS * 2, 60000);
  } else {
    const alreadyInWindowSec = Math.max(0, hmsToSec(beijingHMS()) - startSec);
    hardDeadlineMs = startedAt + Math.max(5000, (deadlineSec - startSec - alreadyInWindowSec) * 1000);
  }

  // 5) 轮询上游：候选端点 × 候选 key，第一个「请求成功」的组合即被采用；
  //    请求成功但结果为空 ⇒ 上游还没出数据 ⇒ 等下一轮（§10 未就绪 ≠ 没有）。
  type Candidate = { endpoint: string; keyRef: KeyRef };
  const candidates: Candidate[] = [];
  dateCandidates.forEach((ep) => keys.forEach((k) => candidates.push({ endpoint: ep, keyRef: k })));

  const dateYmd = isoToYmd(today);
  logs.push('步骤1：抓取上游 ' + CONFIG.APINAME + '（tradedate=' + dateYmd + '，不传 symbols ⇒ 全市场）...');

  let attempts = 0;
  let notReadySeen = false;
  let lastErrMsg = '';
  let used: Candidate | null = null;
  let snapshot: MapResult | null = null;
  let rawInfo: { itemCount: number; fieldNames: string[]; elapsedMs: number } | null = null;

  while (true) {
    attempts++;
    let gotResponseThisRound = false;
    let roundEmpty = false;

    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      try {
        const raw = await retryNumcat(
          () => numcatFetchRaw(c.endpoint, c.keyRef.key, dateYmd),
          CONFIG.RETRY_TIMES,
          CONFIG.APINAME + '[ep=' + c.endpoint + ',key=' + c.keyRef.name + ']',
          logs,
        );
        used = c;
        rawInfo = { itemCount: raw.items.length, fieldNames: raw.fields, elapsedMs: raw.elapsedMs };
        snapshot = mapRows(raw.fields, raw.items, today);
        gotResponseThisRound = true;
        logs.push('✅ 端点 ' + c.endpoint + ' + key ' + c.keyRef.name + '/' + maskKey(c.keyRef.key) +
          ' 返回 ' + raw.items.length + ' 行（' + raw.elapsedMs + 'ms，字段 ' + raw.fields.join(',') + '）');
        break;
      } catch (e) {
        lastErrMsg = (e as Error)?.message || String(e);
        logs.push('端点 ' + c.endpoint + ' + key ' + c.keyRef.name + ' 失败: ' + lastErrMsg);
        if (i + 1 < candidates.length) {
          logs.push('→ 换下一个候选（' + candidates[i + 1].endpoint + ' / ' + candidates[i + 1].keyRef.name + '）继续试');
        }
      }
    }

    if (gotResponseThisRound && snapshot) {
      if (snapshot.rows.length > 0) break;   // 拿到「一字」数据 → 就绪
      // 请求成功但没有一字行：可能上游还没生成当日数据（也可能今天真没有一字）
      notReadySeen = true;
      roundEmpty = true;
      logs.push('第 ' + attempts + ' 轮：上游返回 ' + snapshot.total + ' 行，但无一字（未达涨停幅度 ' +
        snapshot.droppedNotLimit + '，其中缺竞价涨幅 ' + snapshot.droppedNoPct +
        (snapshot.dateSeen.length ? '；返回日期=' + snapshot.dateSeen.join('/') : '') +
        '）→ 判定未就绪，等待下一轮');
    }

    if (singleShot) break;
    const remain = hardDeadlineMs - Date.now();
    if (remain <= 0) {
      if (!roundEmpty && !gotResponseThisRound) logs.push('已到时间上限且最后一轮也无有效响应，停止轮询');
      else if (roundEmpty) logs.push('已到时间上限（' + CONFIG.WINDOW_DEADLINE + ' 口径），上游仍无一字数据，停止轮询');
      break;
    }
    await sleep(Math.min(CONFIG.POLL_MS, remain));
  }

  const elapsedMs = Date.now() - startedAt;

  // 6) 未就绪 → 不写库、不删除（§10 未就绪 ≠ 没有）
  if (!snapshot || !used || snapshot.rows.length === 0) {
    const errMsg = snapshot
      ? '上游未返回一字数据（回合数=' + attempts + '，最后返回 ' + snapshot.total + ' 行 / 未达涨停幅度 ' +
        snapshot.droppedNotLimit + '（其中缺竞价涨幅 ' + snapshot.droppedNoPct + '）' +
        '）→ 判定未就绪，本次不写库'
      : '抓取失败: ' + (lastErrMsg || '未知错误');
    logs.push('❌ ' + errMsg);
    if (!snapshot && lastErrMsg) {
      logs.push('提示：若报错含「未拿到响应/超时」或 code≠200 → 先开 /probe 逐端点逐 key 体检' +
        '（很可能是小号 key 本身无效、未授权 daily_auc_fd，或专线端口在本平台不通）');
    }
    await writeLog(Object.assign({}, logBase, { ok: false, detail: {
      error: errMsg, attempts: attempts, elapsedMs: elapsedMs,
      notReadySeen: notReadySeen, lateBySec: lateBySec,
      keySource: used ? used.keyRef.name : null, endpoint: used ? used.endpoint : null,
      lastError: lastErrMsg || null,
    } }));
    return { ok: false, today: today, error: errMsg, attempts: attempts, logs: logs };
  }

  const ready = true;
  const completeness = '上游 ' + snapshot.total + ' 行 → 一字 ' + snapshot.rows.length +
    ' 行（判据=竞价涨幅达涨停幅度；丢弃未达幅度 ' + snapshot.droppedNotLimit +
    '（其中缺竞价涨幅 ' + snapshot.droppedNoPct + '）/ 无名称 ' + snapshot.droppedNoName +
    ' / 日期不符 ' + snapshot.droppedDateMismatch + '）';
  logs.push('步骤2：就绪判定通过（第 ' + attempts + ' 轮拿到数据，共耗时 ' + elapsedMs + 'ms）—— ' + completeness);

  // 7) 整日对齐写入：先 upsert（本次结果全部就位）→ 再删旧行（本次已不在池中的）
  let written = 0;
  try {
    written = await upsertAuctionYiziRows(snapshot.rows);
  } catch (e) {
    const msg = (e as Error)?.message || String(e);
    logs.push('写入失败: ' + msg);
    await writeLog(Object.assign({}, logBase, { ok: false, detail: { error: msg, attempts: attempts } }));
    return { ok: false, today: today, error: '写入 auction_yizi 失败: ' + msg, logs: logs };
  }

  let deleted = 0;
  if (ready) {
    logs.push('步骤3：清理该日已不在一字池中的旧行...');
    try {
      deleted = await deleteStaleAuctionYizi(today, snapshot.rows.map((r) => String(r.stock)));
    } catch (e) {
      logs.push('清理旧行失败（非致命）: ' + ((e as Error)?.message || String(e)));
    }
  }

  const summary = '✅ 竞价一字写入 ' + written + ' 行，清理旧行 ' + deleted + ' 行；' + completeness;
  logs.push('数据完整性汇总: ' + summary);
  await writeLog(Object.assign({}, logBase, { ok: true, detail: {
    written: written, deleted: deleted,
    upstreamRows: snapshot.total, yiziRows: snapshot.rows.length,
    droppedNotLimit: snapshot.droppedNotLimit, droppedNoPct: snapshot.droppedNoPct,
    droppedNoName: snapshot.droppedNoName,
    droppedDateMismatch: snapshot.droppedDateMismatch,
    datesSeen: snapshot.dateSeen,
    attempts: attempts, elapsedMs: elapsedMs, lateBySec: lateBySec,
    keySource: used.keyRef.name, endpoint: used.endpoint,
  } }));
  return {
    ok: true,
    today: today,
    written: written,
    deleted: deleted,
    upstreamRows: snapshot.total,
    yiziRows: snapshot.rows.length,
    droppedNotLimit: snapshot.droppedNotLimit,
    droppedNoPct: snapshot.droppedNoPct,
    droppedNoName: snapshot.droppedNoName,
    droppedDateMismatch: snapshot.droppedDateMismatch,
    datesSeen: snapshot.dateSeen,
    attempts: attempts,
    elapsedMs: elapsedMs,
    lateBySec: lateBySec,
    keySource: used.keyRef.name,
    endpoint: used.endpoint,
    upstreamElapsedMs: rawInfo ? rawInfo.elapsedMs : null,
    upstreamFields: rawInfo ? rawInfo.fieldNames : null,
    sample: snapshot.rows.slice(0, 3).map((r) => ({
      code: r.code, stock: r.stock, aucPct: r.auc_pct_chg, sealMoney: r.seal_money,
      faCount: r.fa_count, faFirst: r.fa_first, themeKpl: r.theme_kpl, themeXgb: r.theme_xgb, isSt: r.is_st,
    })),
    summary: summary,
    logs: logs,
  };
}

// ============================================================================
// 趋势（trend）—— 「近 N 个交易日」的四条腿 → yizi_trend 缓存表
// ============================================================================
//
// 【这个路由是干什么的】
//   「竞价一字」看板的每行可以点开一个趋势面板，和「早盘竞价」看板一样显示 4 条曲线：
//     竞价量 / 昨日成交量 / 竞价涨幅 / 涨幅（「十日涨幅」由前端从 stock_range_pct 直接读，
//     不走本路由，所以这里只有 4 条腿）。
//
// ── ⚠️ 与 9:25 那条腿【完全分开】，⛔ 绝不混用 ─────────────────────────────
//   9:25 自动抓取用的是 `daily_auc_fd`（判「竞价一字」的口径），本路由用的是**另外两个 apiname**：
//     · `daily_auc` —— 竞价腿：按 (symbols × 日期区间) 一次拿回
//                      auc_vol(手) / auc_pct_chg / auc_to_pre_vol_pct
//     · `daily`     —— K 线腿：同形态一次拿回 pct_chg（当日涨幅）
//   两支都走【竞价一字小号】的 key（NUMCAT_API_KEY_YIZI）；主账号兜底默认关闭，
//   与 9:25 腿同一策略 —— 小号失败宁可失败，也不悄悄烧早盘竞价看板的额度。
//   ⛔ 本路由【不碰】auction_yizi（不写、不删），只写 yizi_trend 这一张缓存表。
//
// ── 单位口径（必须与既有实现一致，⛔ 不要另立一套）─────────────────────────
//   auc_vol(手) → 展示「竞价量(万)」= /100     （同 workers/bidding-auto-fetch/logic/morning-workflow.js#551）
//   yest_volume(万) = auc_vol(手) / auc_to_pre_vol_pct   （同该文件 #567 的「反推」口径）
//   auc_pct_chg        = 竞价涨幅（daily_auc）
//   change_pct         = 当日涨幅（daily 的 pct_chg）
//   ⛔ 任一腿解析不出来 → 该格写 null / 不写行（§10 不拿 0 顶替「没数据」）。
//
// ── 额度保护（★ 小号每天只有 10 次；9:25 自动抓取优先，五道闸门）────────────
//   ① 缺口驱动：只有「窗口里确实缺某一天的数据」才发请求；已齐 → 0 请求直接回缓存；
//   ② 时间闸门：北京 09:20~09:30【一律不补拉】—— 结构性保护 9:25 自动抓取，
//      ⛔ 不靠「相信调用方守规矩」，而是这段时间内物理上不发上游请求；
//   ③ 冷却：距上一次趋势抓取 < 90 秒 → 本轮跳过（防展开连点把额度打光）；
//   ④ 预算：本日趋势请求数 ≥ AUCTION_YIZI_TREND_MAX_REQ（默认 6）→ 跳过并如实提示；
//   ⑤ 请求形态：整窗口 1 次请求（symbols × startdate~enddate），⛔ 不是「每天一次」。
//   ⛔ 任一闸门触发都【不写库、不删除】，只回既有缓存 + 明确 note（skipped 字段）。
//
// ── §11 删除安全 ────────────────────────────────────────────────────────────
//   本路由【从不删除】yizi_trend 的任何行，只 upsert 缺口（merge-duplicates）。
//   因此「上游没返回」只会让某些格子保持缺失（前端显示 '-'），绝不会把已有历史抹掉。
//
// ── 为什么落库（而不是每次展开现拉）─────────────────────────────────────────
//   前端展开一次就现拉 = 每天 N 次 × 每窗口 2 次请求 ⇒ 必然把 9:25 抓取饿死。
//   落库后：每个交易日只多 1 个日期，且跨设备 / 跨会话 0 消耗。
//
// ── 手动调用（排查 / 补某日）───────────────────────────────────────────────
//   GET /functions/v1/auction-yizi-fetch/trend?date=2026-09-18&window=5
//       ↑ 不传 symbols 时，服务端直接用 auction_yizi(date) 的池子当目标
//   GET ...&symbols=600000,000001&stocks=浦发银行,平安银行   ← 显式指定（与 symbols 按下标对齐）
//   GET ...&force=1    ← 忽略「缓存已齐」短路（仍受 ②③④ 三道闸门约束）
//   ⚠️ 本路由与 /health 同级【不校验 token】：它是浏览器端只读缓存入口，
//      额度由上面 5 道闸门保护，且从不删除任何数据（numcat-proxy / fuyao-proxy 亦然）。

const TREND = {
  /** 趋势窗口（近 N 个交易日，含 T 日） */
  WINDOW: Number(Deno.env.get('AUCTION_YIZI_TREND_WINDOW') || 5),
  /** 单次请求最多带多少只（上游 symbols 长度的保守上限） */
  MAX_SYMBOLS: Number(Deno.env.get('AUCTION_YIZI_TREND_MAX_SYMBOLS') || 300),
  /** 本日趋势上游请求数预算（小号每天 10 次，9:25 自动抓取优先） */
  MAX_REQUESTS_PER_DAY: Number(Deno.env.get('AUCTION_YIZI_TREND_MAX_REQ') || 6),
  /** 两次趋势抓取之间的最小间隔（毫秒），防连点 */
  COOLDOWN_MS: Number(Deno.env.get('AUCTION_YIZI_TREND_COOLDOWN_MS') || 90000),
  /** ★ 9:25 抓取保护窗口（北京 HH:MM:SS）：其间【一律不发上游请求】 */
  PROTECT_START: (Deno.env.get('AUCTION_YIZI_TREND_PROTECT_START') || '09:20:00').trim(),
  PROTECT_END: (Deno.env.get('AUCTION_YIZI_TREND_PROTECT_END') || '09:30:00').trim(),
  /** 竞价腿请求字段（顺序即上游 items 的位置顺序） */
  AUC_FIELDS: ['symbol', 'name', 'tradedate', 'auc_vol', 'auc_pct_chg', 'auc_to_pre_vol_pct'],
  /** K 线腿请求字段 */
  DAILY_FIELDS: ['symbol', 'tradedate', 'pct_chg'],
  TABLE: 'yizi_trend',
  LOG_JOB: 'auction-yizi-trend',
};

/** 目标股票（股票名 / 6 位代码） */
type Pair = { stock: string; code: string };

/**
 * 'a,b,c' → ['a','b','c']（去空项）。
 * ⛔ 刻意不用正则切分（也不在本文档里写正则字面量，免得里面的结束符提前闭合注释）：
 *    本文件的体检脚本对正则字面量不友好，见 REFERENCE §N 末。
 */
function splitList(raw: string): string[] {
  return String(raw || '').split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * 近 N 个交易日（含 endDate，升序返回 = 旧 → 新）。
 * ⚠️ 只用本地日历（与 9:25 腿同一份 KNOWN_HOLIDAYS，⛔ 不额外交请求换交易日历）。
 * 若 endDate 本身不是交易日（周末/节假日），窗口自然向前滚到最近 N 个交易日。
 */
function recentTradingDays(endDate: string, n: number): string[] {
  const out: string[] = [];
  const d = new Date(endDate + 'T00:00:00Z');
  let guard = 0;
  while (out.length < n && guard < 400) {
    guard++;
    const iso = d.toISOString().slice(0, 10);
    if (localIsTradingDay(iso)) out.push(iso);
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return out.reverse();
}

/**
 * 上游端点变形：把 `daily_auc_fd` 那段路径换成别的 apiname。
 *   · 公网 reference-proxy 是【按 URL 路径】分发（.../stock/daily_auc_fd）→ 必须换路径；
 *   · 专线 .../api 是【按 body 里的 apiname】分发 → 端点原样不动。
 * ⛔ 用 split/join 而不是正则字面量：本文件的体检脚本对正则字面量不友好（见 REFERENCE §N 末）。
 */
function endpointForApiname(ep: string, apiname: string): string {
  return ep.indexOf('daily_auc_fd') >= 0 ? ep.split('daily_auc_fd').join(apiname) : ep;
}

/**
 * 通用上游请求（apiname / fields / params 全部由调用方给）。
 *
 * ⚠️ 刻意与 numcatFetchRaw 分开：
 *   那个函数是 9:25 自动抓取的咽喉（params 固定 tradedate、apiname 固定 daily_auc_fd），
 *   本函数服务趋势腿。两者共用的是**上游契约**（POST {apiname,apikey,fields,params}），
 *   ⛔ 但绝不共用代码 —— 免得改趋势把每天 9:25 的落库搞挂。
 *   解析口径（包裹形态、错误码）与 numcatFetchRaw 逐字一致。
 */
async function numcatPostRaw(
  endpoint: string, key: string, apiname: string, fields: string[], params: Record<string, unknown>,
): Promise<RawSnapshot> {
  if (!key) throw numcatErr('猫抓小号 key 未配置（请设置 Secrets: ' + KEY_PRIMARY + '）', undefined, undefined, undefined, endpoint);
  const body = { apiname: apiname, apikey: key, fields: fields.join(','), params: params };
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
    throw numcatErr('上游请求未拿到响应（' + CONFIG.REQUEST_TIMEOUT_MS + 'ms 超时 / DNS / 端口不通）: ' + msg,
      undefined, Date.now() - t0, undefined, endpoint);
  }
  const elapsedMs = Date.now() - t0;
  const text = await resp.text();
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch (_e) {
    throw numcatErr('上游返回非 JSON: HTTP ' + resp.status + ' ' + text.slice(0, 200), resp.status, elapsedMs, undefined, endpoint);
  }
  const code = typeof json.code === 'number' ? json.code : (resp.ok ? 200 : resp.status);
  if (!resp.ok) {
    throw numcatErr('上游 HTTP ' + resp.status + ': ' + String(json.message || text.slice(0, 200)), resp.status, elapsedMs, code, endpoint);
  }
  if (code !== 200) {
    throw numcatErr('上游业务码 code=' + code + ' ' + String(json.message || ''), resp.status, elapsedMs, code, endpoint);
  }
  let payload: Record<string, unknown> = (json.data && typeof json.data === 'object' && !Array.isArray(json.data))
    ? json.data as Record<string, unknown>
    : json;
  if (!Array.isArray(payload.items) && Array.isArray(payload.results)) {
    const list = payload.results as Array<Record<string, unknown>>;
    const hit = list.find((r) => r && r.code === 200 && r.data) || list[0];
    if (hit && hit.data && typeof hit.data === 'object') payload = hit.data as Record<string, unknown>;
  }
  const f = Array.isArray(payload.fields) ? (payload.fields as unknown[]).map((x) => String(x)) : [];
  const items = Array.isArray(payload.items) ? payload.items as unknown[] : [];
  return { fields: f, items: items, endpoint: endpoint, elapsedMs: elapsedMs };
}

/** 归一「股票名 / 代码」两串（按下标对齐；只认 6 位纯数字代码，⛔ 不猜） */
function normPairs(stocks: string[], symbols: string[]): Pair[] {
  const out: Pair[] = [];
  const seen: Record<string, boolean> = {};
  const n = Math.max(stocks.length, symbols.length);
  for (let i = 0; i < n; i++) {
    const code = String(symbols[i] || '').replace(/\D/g, '');
    const stock = String(stocks[i] || '').trim();
    const k = code || stock;
    if (!k || seen[k]) continue;
    seen[k] = true;
    out.push({ stock: stock, code: /^\d{6}$/.test(code) ? code : '' });
  }
  return out;
}

/**
 * 取某日 auction_yizi 的池子（股票名 + 代码）当趋势目标。
 * 好处：浏览器端不必把池子传上来 —— 服务端读的就是「这一天真正的一字池」，
 * ⛔ 单一真相（同一张 auction_yizi），不会出现「前端传的名单与库不一致」。
 */
async function readYiziPool(date: string): Promise<Pair[]> {
  const url = CONFIG.SUPABASE_URL + '/rest/v1/auction_yizi?date=eq.' + encodeURIComponent(date) + '&select=stock,code&limit=2000';
  const resp = await fetch(url, { headers: sbHeaders({ 'Prefer': 'return=minimal' }), signal: timeoutSignal(15000) });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(sbErrHint('读 auction_yizi 取池失败: HTTP ' + resp.status + ': ' + text.slice(0, 200), text));
  }
  let data: unknown;
  try { data = JSON.parse(text); } catch (_e) { throw new Error('读 auction_yizi 返回非 JSON: ' + text.slice(0, 200)); }
  const list = Array.isArray(data) ? data as Array<Record<string, unknown>> : [];
  const out: Pair[] = [];
  const seen: Record<string, boolean> = {};
  list.forEach((r) => {
    const stock = String((r && r.stock) || '').trim();
    if (!stock || seen[stock]) return;
    seen[stock] = true;
    const code = String((r && r.code) || '').replace(/\D/g, '');
    out.push({ stock: stock, code: /^\d{6}$/.test(code) ? code : '' });
  });
  return out;
}

/** 读某几个交易日的趋势缓存行（表很小：只存被请求过的池子股票） */
async function readTrendRows(dates: string[]): Promise<Record<string, unknown>[]> {
  if (!dates || dates.length === 0) return [];
  const list = dates.map((d) => '"' + String(d).split('"').join('') + '"').join(',');
  const url = CONFIG.SUPABASE_URL + '/rest/v1/' + TREND.TABLE +
    '?date=in.(' + list + ')' +
    '&select=date,stock,code,auc_vol,auc_pct_chg,yest_volume,change_pct,source,updated_at&limit=20000';
  const resp = await fetch(url, { headers: sbHeaders({ 'Prefer': 'return=minimal' }), signal: timeoutSignal(20000) });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(sbErrHint('读 ' + TREND.TABLE + ' 失败: HTTP ' + resp.status + ': ' + text.slice(0, 300), text));
  }
  let data: unknown;
  try { data = JSON.parse(text); } catch (_e) { throw new Error('读 ' + TREND.TABLE + ' 返回非 JSON: ' + text.slice(0, 200)); }
  return Array.isArray(data) ? data as Array<Record<string, unknown>> : [];
}

/**
 * 写 yizi_trend（主键 date+stock → 幂等覆盖）。
 * ⚠️ 只提交本次拿到的列：PostgREST 的 merge-duplicates 只更新 payload 里出现的列，
 *    因此「K 线腿后写」不会把竞价腿已经写好的 auc_vol / yest_volume 抹成 null。
 */
async function upsertTrendRows(rows: Record<string, unknown>[]): Promise<number> {
  const payload = (rows || []).filter((r) => r && r.date && r.stock);
  if (payload.length === 0) return 0;
  const url = CONFIG.SUPABASE_URL + '/rest/v1/' + TREND.TABLE + '?on_conflict=date%2Cstock';
  for (let i = 0; i < payload.length; i += CONFIG.WRITE_CHUNK) {
    const resp = await fetch(url, {
      method: 'POST',
      headers: sbHeaders({ 'Prefer': 'resolution=merge-duplicates, return=minimal' }),
      body: JSON.stringify(payload.slice(i, i + CONFIG.WRITE_CHUNK)),
      signal: timeoutSignal(30000),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(sbErrHint('upsert ' + TREND.TABLE + ' 失败: HTTP ' + resp.status + ': ' + text.slice(0, 300), text));
    }
  }
  return payload.length;
}

/**
 * 上游行 → yizi_trend 入库行（按腿裁剪列）。
 *   · 日期不在窗口内 → 丢（⛔ 绝不给别的日期写行，否则会造出不存在的交易日）
 *   · 竞价腿：auc_vol 为 null → 不写（§10 不补 0）；yest_volume 由 auc_to_pre_vol_pct 反推
 *   · K 线腿：pct_chg 解析不出 → 不写
 *   · 股票名优先用【调用方给的 nameByCode】（与 auction_yizi 同名 → 前端按名 join 一定命中），
 *     取不到才用上游 name
 */
function mapTrendLegRows(
  apiname: string, cols: string[], items: unknown[], windowDates: string[], nameByCode: Record<string, string>,
): Record<string, unknown>[] {
  const want: Record<string, boolean> = {};
  for (let i = 0; i < windowDates.length; i++) want[windowDates[i]] = true;
  const nowIso = new Date().toISOString();
  const out: Record<string, unknown>[] = [];
  const seen: Record<string, boolean> = {};
  for (let i = 0; i < items.length; i++) {
    const get = makeGetter(cols, items[i]);
    const rowIso = ymdToIso(get('tradedate'));
    if (!rowIso || !want[rowIso]) continue;
    const codeRaw = String(textOrNull(get('symbol')) || '').replace(/\..*$/, '').trim();
    const code = /^\d{6}$/.test(codeRaw) ? codeRaw : '';
    const stock = (code && nameByCode[code]) ? nameByCode[code] : (textOrNull(get('name')) || '');
    if (!stock) continue;
    const key = rowIso + '|' + stock;
    if (seen[key]) continue;
    const base: Record<string, unknown> = {
      date: rowIso, stock: stock, code: code || null, source: 'numcat', updated_at: nowIso,
    };
    if (apiname === 'daily_auc') {
      const aucVol = numOrNull(get('auc_vol'));
      if (aucVol === null) continue;
      const ratio = numOrNull(get('auc_to_pre_vol_pct'));
      base.auc_vol = aucVol;
      base.auc_pct_chg = numPctText(get('auc_pct_chg'));
      // yest_volume(万) = auc_vol(手) / auc_to_pre_vol_pct（比值 ≤ 0 或缺失 → null，⛔ 不编）
      base.yest_volume = (ratio !== null && ratio > 0) ? Math.round(aucVol / ratio) : null;
    } else {
      const pct = numPctText(get('pct_chg'));
      if (pct === null) continue;
      base.change_pct = pct;
    }
    seen[key] = true;
    out.push(base);
  }
  return out;
}

/**
 * 打一条腿（竞价腿 / K 线腿）：候选端点 × 候选 key，第一个成功的即被采用。
 * ⚠️ 每腿**整窗口一次请求**（symbols + startdate~enddate），⛔ 不是「每天一次」——
 *    这是额度的关键：5 天窗口 = 1 次请求，而不是 5 次。
 * ⚠️ 只打一轮（retryNumcat times=1）：趋势是补缺口，失败下一轮再来；重试会翻倍烧额度。
 * ⚠️ 写入失败【不再试下一个端点】（表不存在时那是白烧额度），直接返回 ok:false。
 */
async function fetchTrendLeg(
  apiname: string, fields: string[], params: Record<string, unknown>,
  windowDates: string[], nameByCode: Record<string, string>, logs: string[],
): Promise<Record<string, unknown>> {
  const endpoints = buildEndpoints();
  const keys = configuredKeys();
  let requests = 0;
  let lastErr = '';
  for (let e = 0; e < endpoints.length; e++) {
    const ep = endpointForApiname(endpoints[e], apiname);
    for (let k = 0; k < keys.length; k++) {
      const keyRef = keys[k];
      const label = apiname + '[ep=' + ep + ',key=' + keyRef.name + ']';
      requests++;
      const t0 = Date.now();
      let raw: RawSnapshot;
      try {
        raw = await retryNumcat(() => numcatPostRaw(ep, keyRef.key, apiname, fields, params), 1, label, logs);
      } catch (err) {
        lastErr = (err as Error)?.message || String(err);
        logs.push('❌ ' + label + ' 失败（' + (Date.now() - t0) + 'ms）: ' + lastErr);
        if (k + 1 < keys.length) logs.push('→ 换下一把 key（' + keys[k + 1].name + '）继续试');
        continue;
      }
      // 上游偶尔不回 fields ⇒ 退化为「按请求顺序」取值（items 本就是按请求 fields 排的）
      const cols = raw.fields.length > 0 ? raw.fields : fields;
      const rows = mapTrendLegRows(apiname, cols, raw.items, windowDates, nameByCode);
      logs.push('✅ ' + label + ' 返回 ' + raw.items.length + ' 行（' + raw.elapsedMs + 'ms）→ 组装 ' + rows.length + ' 行');
      try {
        const written = await upsertTrendRows(rows);
        logs.push('写入 ' + TREND.TABLE + ' ' + written + ' 行（merge-duplicates，幂等）');
        return { ok: true, requests: requests, written: written, upstreamRows: raw.items.length, endpoint: ep, keySource: keyRef.name, elapsedMs: raw.elapsedMs };
      } catch (werr) {
        const msg = (werr as Error)?.message || String(werr);
        logs.push('写入 ' + TREND.TABLE + ' 失败: ' + msg);
        return { ok: false, requests: requests, written: 0, upstreamRows: raw.items.length, endpoint: ep, keySource: keyRef.name, error: msg };
      }
    }
  }
  return { ok: false, requests: requests, written: 0, error: lastErr || '所有端点 × key 组合均失败' };
}

/**
 * 读「本日趋势抓取」的日志统计，用作预算 / 冷却依据。
 * ⚠️ 读失败【不阻断】（返回 0 → 相当于闸门放行）：宁可多花一次额度，
 *    也不能因为日志表读不到就把趋势图永久锁死。§10 的「读失败 ≠ 空」在这里体现为
 *    「读失败 → 不下『已超额』的错误结论」。
 */
async function readTrendLogStats(runDate: string): Promise<{ entries: number; requests: number; lastAt: string }> {
  const out = { entries: 0, requests: 0, lastAt: '' };
  try {
    const url = CONFIG.SUPABASE_URL + '/rest/v1/bidding_fetch_log?select=created_at,detail' +
      '&job=eq.' + encodeURIComponent(TREND.LOG_JOB) +
      '&run_date=eq.' + encodeURIComponent(runDate) +
      '&order=created_at.desc&limit=60';
    const resp = await fetch(url, { headers: sbHeaders({ 'Prefer': 'return=minimal' }), signal: timeoutSignal(12000) });
    if (!resp.ok) return out;
    const data = await resp.json().catch(() => []);
    const list = Array.isArray(data) ? data as Array<Record<string, unknown>> : [];
    out.entries = list.length;
    if (list.length > 0) out.lastAt = String(list[0].created_at || '');
    for (let i = 0; i < list.length; i++) {
      const d = list[i] && list[i].detail;
      if (d && typeof d === 'object') {
        const n = (d as Record<string, unknown>).requests;
        if (typeof n === 'number' && isFinite(n)) out.requests += n;
      }
    }
  } catch (_e) { /* 见函数头注释：读不到日志不放行也不阻断 */ }
  return out;
}

/**
 * 趋势主流程：读缓存 → 判缺口 → 过五道闸门 → （必要时）打两条腿 → 回读 → 返回。
 * 返回结构永远包含 rows（库里真实存的行），⛔ 即使上游全挂，前端也能画出已有部分。
 */
async function runTrend(opts?: { date?: string; window?: number; stocks?: string[]; symbols?: string[]; force?: boolean }): Promise<Record<string, unknown>> {
  const logs: string[] = [];
  const date = ((opts && opts.date) || beijingToday()).trim();
  const windowN = Math.max(1, Math.min(15, Math.floor((opts && opts.window) || TREND.WINDOW) || TREND.WINDOW));
  const windowDates = recentTradingDays(date, windowN);
  const force = !!(opts && opts.force);

  logs.push('趋势：T=' + date + ' window=' + windowN + ' → 窗口 ' + windowDates.join(' , ') +
    '（北京 ' + beijingHMS() + '）');

  // 1) 目标股票：调用方给了就用它的（浏览器按名 join 更稳），没给就取 auction_yizi 的池子
  let pairs = normPairs((opts && opts.stocks) || [], (opts && opts.symbols) || []);
  let poolSource = 'query';
  if (pairs.length === 0) {
    poolSource = 'auction_yizi';
    try {
      pairs = await readYiziPool(date);
      logs.push('未指定 stocks/symbols → 取 auction_yizi(' + date + ') 池子：' + pairs.length + ' 只');
    } catch (e) {
      logs.push('读 auction_yizi 取池失败: ' + ((e as Error)?.message || String(e)));
    }
  }
  const nameByCode: Record<string, string> = {};
  pairs.forEach((p) => { if (p.code && p.stock) nameByCode[p.code] = p.stock; });
  const codes = pairs.map((p) => p.code).filter(Boolean);

  // 2) 读缓存（§10：读失败如实回传 tableError，⛔ 不伪装成「没有数据」）
  let cacheRows: Record<string, unknown>[] = [];
  let tableError = '';
  try {
    cacheRows = await readTrendRows(windowDates);
  } catch (e) {
    tableError = (e as Error)?.message || String(e);
    logs.push('读 ' + TREND.TABLE + ' 失败：' + tableError);
  }

  // 3) 缺口判定（有名字按名字，只有代码就按代码）
  const hasCol = function(pair: Pair, d: string, col: string): boolean {
    for (let i = 0; i < cacheRows.length; i++) {
      const r = cacheRows[i];
      if (String(r.date) !== d) continue;
      if (r[col] === null || r[col] === undefined) continue;
      if (pair.stock) {
        if (String(r.stock).trim() === pair.stock) return true;
      } else if (pair.code && String(r.code || '') === pair.code) {
        return true;
      }
    }
    return false;
  };
  const gapAuc = pairs.filter((p) => windowDates.some((d) => !hasCol(p, d, 'auc_vol')));
  const gapDaily = pairs.filter((p) => windowDates.some((d) => !hasCol(p, d, 'change_pct')));
  const needFetch = (gapAuc.length > 0 || gapDaily.length > 0);
  // force=1（排查用）：把「缓存已齐」也当成缺 → 强制整窗重取。
  // ⛔ 但它【不豁免】下面的保护窗口 / 预算 / 冷却三道闸门 —— 否则「排查」会把额度打光。
  const missingAuc = force ? pairs : gapAuc;
  const missingDaily = force ? pairs : gapDaily;

  // 4) 五道闸门
  let skipped = '';
  if (pairs.length === 0) skipped = 'no-pool';
  else if (codes.length === 0) skipped = 'no-code';
  else if (!force && !needFetch) skipped = 'cache-complete';
  // 只有「真可能发请求」时才去读日志当预算/冷却依据（否则白读一次库）
  const stats = skipped ? { entries: 0, requests: 0, lastAt: '' } : await readTrendLogStats(date);
  if (!skipped) {
    const nowSec = hmsToSec(beijingHMS());
    const gs = hmsToSec(TREND.PROTECT_START);
    const ge = hmsToSec(TREND.PROTECT_END);
    if (isFinite(gs) && isFinite(ge) && nowSec >= gs && nowSec < ge) {
      skipped = 'protect-window';
      logs.push('⏸ 北京 ' + beijingHMS() + ' 落在 9:25 抓取保护窗口 ' + TREND.PROTECT_START + '~' + TREND.PROTECT_END +
        ' → 本轮不补拉（结构性保护小号额度，绝不与 9:25 自动抓取抢）');
    } else if (stats.requests >= TREND.MAX_REQUESTS_PER_DAY) {
      skipped = 'budget';
      logs.push('⏸ 本日趋势请求已达上限（' + stats.requests + '/' + TREND.MAX_REQUESTS_PER_DAY + '）→ 只回缓存');
    } else if (stats.lastAt && (Date.now() - Date.parse(stats.lastAt)) < TREND.COOLDOWN_MS) {
      skipped = 'cooldown';
      logs.push('⏸ 距上次趋势抓取不足 ' + Math.round(TREND.COOLDOWN_MS / 1000) + ' 秒 → 只回缓存（防展开连点把额度打光）');
    }
  }

  // 5) 抓取（只有确实缺、且没被闸门拦下）
  let requests = 0;
  const fetched: Record<string, unknown> = { auc: null, daily: null, written: 0 };
  if (skipped) {
    logs.push('本轮跳过抓取：' + skipped);
  } else {
    const startYmd = isoToYmd(windowDates[0]);
    const endYmd = isoToYmd(windowDates[windowDates.length - 1]);
    const sym = pairs.filter((p) => p.code).slice(0, TREND.MAX_SYMBOLS).map((p) => p.code).join(',');
    logs.push('目标 ' + pairs.length + ' 只（带代码 ' + codes.length + ' 只），窗口 ' + startYmd + '~' + endYmd +
      '，缺口：竞价腿 ' + missingAuc.length + ' 只 / K线腿 ' + missingDaily.length + ' 只');
    if (missingAuc.length > 0) {
      const leg = await fetchTrendLeg('daily_auc', TREND.AUC_FIELDS,
        { symbols: sym, startdate: startYmd, enddate: endYmd }, windowDates, nameByCode, logs);
      requests += Number(leg.requests) || 0;
      fetched.auc = leg;
      fetched.written = (Number(fetched.written) || 0) + (Number(leg.written) || 0);
    }
    if (missingDaily.length > 0) {
      const leg = await fetchTrendLeg('daily', TREND.DAILY_FIELDS,
        { symbols: sym, startdate: startYmd, enddate: endYmd }, windowDates, nameByCode, logs);
      requests += Number(leg.requests) || 0;
      fetched.daily = leg;
      fetched.written = (Number(fetched.written) || 0) + (Number(leg.written) || 0);
    }
    if (requests === 0) logs.push('⚠️ 有缺口但一个请求都没发出去（key 未配置？）');
  }

  // 6) 回读：返回「库里真实存了什么」，而不是「我以为我写了什么」
  let rows: Record<string, unknown>[] = cacheRows;
  if (requests > 0) {
    try { rows = await readTrendRows(windowDates); }
    catch (e) { logs.push('回读 ' + TREND.TABLE + ' 失败（返回本轮写入前的缓存）: ' + ((e as Error)?.message || String(e))); }
  }
  const poolNames: Record<string, boolean> = {};
  const poolCodes: Record<string, boolean> = {};
  pairs.forEach((p) => { if (p.stock) poolNames[p.stock] = true; if (p.code) poolCodes[p.code] = true; });
  const outRows = rows.filter((r) => {
    const nm = String((r && r.stock) || '').trim();
    const cd = String((r && r.code) || '');
    return (nm && poolNames[nm]) || (cd && poolCodes[cd]);
  });

  const ok = !tableError;
  // 7) 写日志（下一轮拿它当预算 / 冷却依据）
  await writeLog({
    run_date: date,
    time_point: 'yizi-trend',
    source: 'trend',
    job: TREND.LOG_JOB,
    worker: 'edge-auction-yizi',
    ok: ok,
    detail: {
      requests: requests,
      written: Number(fetched.written) || 0,
      skipped: skipped,
      pool: pairs.length,
      missingAuc: missingAuc.length,
      missingDaily: missingDaily.length,
      window: windowDates,
      tableError: tableError || null,
    },
  });

  return {
    ok: ok,
    date: date,
    window: windowDates,
    windowDays: windowDates.length,
    tableError: tableError || null,
    table: TREND.TABLE,
    poolSource: poolSource,
    poolSize: pairs.length,
    rows: outRows,
    fetched: fetched,
    requests: requests,
    skipped: skipped,
    budget: { usedRequests: stats.requests + requests, cap: TREND.MAX_REQUESTS_PER_DAY },
    guards: {
      protectStart: TREND.PROTECT_START,
      protectEnd: TREND.PROTECT_END,
      cooldownMs: TREND.COOLDOWN_MS,
      nowBeijing: beijingHMS(),
    },
    legs: {
      auc: 'daily_auc（竞价量 auc_vol / 竞价涨幅 auc_pct_chg / 昨日成交量 = auc_vol ÷ auc_to_pre_vol_pct）',
      daily: 'daily（涨幅 pct_chg）',
    },
    hint: '四腿中「十日涨幅」由前端从 stock_range_pct 直接读，不走本路由。' +
      '本路由从不删除任何行，只补缺口；北京 ' + TREND.PROTECT_START + '~' + TREND.PROTECT_END +
      ' 保护窗口内一律不补拉（不与 9:25 自动抓取抢小号额度）。',
    logs: logs,
  };
}

// ----------------------------- 上游体检（probe） -----------------------------
/**
 * 【出问题先开这个】对「每个端点 × 每把 key」各打一次【真实】上游请求，
 * 回显 HTTP 状态 / 耗时 / 上游业务码 / 字段名单 / 一字命中数 / 首行样例。
 *
 * 用它一眼分清五种完全不同的病因：
 *   ① 上游超时（key 无效时网关可能直接不响应；专线端口也可能被平台拦）
 *   ② 上游 HTTP 401/403/限流（key 本身的问题，看 message）
 *   ③ 上游 HTTP 200 且 code=200，但字段名单缺 fa_* → 请求的 fields 没被接受
 *   ④ 上游 code=200 但「一字」行数 = 0 → key 没问题，是数据/日期问题
 *   ⑤ auction_yizi 表不存在 → 写库这条腿没通（去执行 db/create_auction_yizi.sql）
 *
 * @param symbolsOverride 传入时只探这几只（如 '000001,600000'）→ 请求更轻、更快
 */
async function runProbe(symbolsOverride?: string): Promise<Record<string, unknown>> {
  const keys = configuredKeys();
  const endpoints = buildEndpoints();
  const today = beijingToday();
  const dateYmd = isoToYmd(today);
  const results: Record<string, unknown>[] = [];

  for (let e = 0; e < endpoints.length; e++) {
    const endpoint = endpoints[e];
    for (let k = 0; k < keys.length; k++) {
      const keyRef = keys[k];
      const item: Record<string, unknown> = { endpoint: endpoint, keyName: keyRef.name, keyMasked: maskKey(keyRef.key) };
      const t0 = Date.now();
      try {
        let raw: RawSnapshot;
        if (symbolsOverride) {
          // 轻量探法：手动指定 symbols（验证 key / 端点 / 字段是否被接受）
          const body = {
            apiname: CONFIG.APINAME,
            apikey: keyRef.key,
            fields: CONFIG.FIELDS.join(','),
            params: { tradedate: dateYmd, symbols: symbolsOverride },
          };
          const resp = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: timeoutSignal(CONFIG.REQUEST_TIMEOUT_MS),
          });
          const text = await resp.text();
          let json: Record<string, unknown>;
          try { json = JSON.parse(text) as Record<string, unknown>; }
          catch (_e) { throw numcatErr('上游返回非 JSON: HTTP ' + resp.status + ' ' + text.slice(0, 200), resp.status, Date.now() - t0); }
          const code = typeof json.code === 'number' ? json.code : (resp.ok ? 200 : resp.status);
          if (code !== 200) throw numcatErr('上游业务码 code=' + code + ' ' + String(json.message || ''), resp.status, Date.now() - t0, code);
          let payload: Record<string, unknown> = (json.data && typeof json.data === 'object' && !Array.isArray(json.data))
            ? json.data as Record<string, unknown> : json;
          if (!Array.isArray(payload.items) && Array.isArray(payload.results)) {
            const list = payload.results as Array<Record<string, unknown>>;
            const hit = list.find((r) => r && r.code === 200 && r.data) || list[0];
            if (hit && hit.data && typeof hit.data === 'object') payload = hit.data as Record<string, unknown>;
          }
          raw = {
            fields: Array.isArray(payload.fields) ? (payload.fields as unknown[]).map((f) => String(f)) : [],
            items: Array.isArray(payload.items) ? payload.items as unknown[] : [],
            endpoint: endpoint,
            elapsedMs: Date.now() - t0,
          };
        } else {
          raw = await numcatFetchRaw(endpoint, keyRef.key, dateYmd);
        }

        const mapped = mapRows(raw.fields, raw.items, today);
        const first = mapped.rows[0] || null;
        item.ok = true;
        item.elapsedMs = raw.elapsedMs;
        item.itemCount = raw.items.length;
        item.fields = raw.fields;
        item.fieldsMissing = CONFIG.FIELDS.filter((f) => raw.fields.indexOf(f) < 0);
        item.yiziRows = mapped.rows.length;
        item.droppedNotLimit = mapped.droppedNotLimit;
        item.droppedNoPct = mapped.droppedNoPct;
        item.datesSeen = mapped.dateSeen;
        item.sampleRaw = raw.items[0] || null;
        item.sampleMapped = first ? {
          code: first.code, stock: first.stock, aucPct: first.auc_pct_chg,
          sealMoney: first.seal_money, faCount: first.fa_count, faFirst: first.fa_first,
          themeKpl: first.theme_kpl, themeXgb: first.theme_xgb, isSt: first.is_st,
        } : null;
      } catch (e) {
        const ne = e as NumcatError;
        item.ok = false;
        item.elapsedMs = ne.elapsedMs ?? (Date.now() - t0);
        item.httpStatus = ne.httpStatus;
        item.code = ne.code;
        item.error = ne.message;
      }
      results.push(item);
    }
  }

  // 顺带探一下「写库这条腿」通不通（表在不在）
  const tableCheck: Record<string, unknown> = {};
  try {
    const resp = await fetch(CONFIG.SUPABASE_URL + '/rest/v1/auction_yizi?select=date&limit=1', {
      headers: sbHeaders({ 'Prefer': 'return=minimal' }),
      signal: timeoutSignal(15000),
    });
    const text = await resp.text();
    tableCheck.ok = resp.ok;
    tableCheck.httpStatus = resp.status;
    if (!resp.ok) tableCheck.error = sbErrHint('读 auction_yizi 失败', text);
  } catch (e) {
    tableCheck.ok = false;
    tableCheck.error = (e as Error)?.message || String(e);
  }

  return {
    ok: true,
    apiname: CONFIG.APINAME,
    beijingNow: beijingHMS(),
    tradedateUsed: dateYmd,
    endpoints: endpoints,
    keysConfigured: keys.map((k) => k.name),
    keyFallbackEnabled: (Deno.env.get('NUMCAT_YIZI_KEY_FALLBACK') || '0').trim() === '1',
    symbolsOverride: symbolsOverride || null,
    probes: results,
    auctionYiziTable: tableCheck,
    window: { start: CONFIG.WINDOW_START, deadline: CONFIG.WINDOW_DEADLINE, pollMs: CONFIG.POLL_MS },
    hint: '逐条看 probes：ok=false 且报「未拿到响应」→ 该端点在本平台不通（专线是 http:8866，可能被拦）或该 key 上游不认；' +
      'code≠200 → key 无效/未授权 daily_auc_fd/超配额，看 error 里的 message；' +
      'ok=true 但 yiziRows=0 → key 与端点都没问题，是「该日确实没有一字数据」或上游还没生成；' +
      'ok=true 但 fieldsMissing 非空 → 上游没接受你请求的部分字段；' +
      'auctionYiziTable.ok=false → 表还没建（执行 db/create_auction_yizi.sql）。',
  };
}

// ----------------------------- 入口路由 -----------------------------
// 鉴权令牌：优先 AUCTION_YIZI_FETCH_TOKEN（本函数专用），未配置时回退复用 FETCH_TOKEN，
// 保证「多配一个 Secret 就能更干净，少配一个也能跑起来」，且绝不与其它函数的路由互相影响。
// 同样在请求时读取（见上方 env 说明）。
function expectedToken(): string {
  return Deno.env.get('AUCTION_YIZI_FETCH_TOKEN') || Deno.env.get('FETCH_TOKEN') || '';
}
function tokenSource(): string {
  if (Deno.env.get('AUCTION_YIZI_FETCH_TOKEN')) return 'AUCTION_YIZI_FETCH_TOKEN';
  return expectedToken() ? 'FETCH_TOKEN(回退)' : '未配置';
}

// ---------------------------------------------------------------------------
// CORS
//
// 本函数有【浏览器端】入口（`/trend` 只读趋势缓存、`/health` 体检），且浏览器调用时必须带
// `apikey` / `Authorization` 头（非 CORS 简单请求）⇒ 浏览器一定先发 **OPTIONS 预检**。
//
// ⛔ 缺这段的后果（2026-09-19 实测事故）：预检拿不到 `Access-Control-Allow-Origin`，
//    浏览器把真实请求整个拦掉，前端 `fetch` 抛 TypeError（浏览器出于安全【不会】告诉脚本原因），
//    于是被前端误报成「auction-yizi-fetch Edge Function 未部署」——
//    用户明明已经部署成功（/health 的 trend 块都在），排查方向被彻底带偏。
// 🔴 反面参照：本函数此前【没有】CORS；而同项目的 numcat-proxy / fuyao-proxy（同为浏览器端入口）
//    线上是带 CORS 的（OPTIONS → 204 + `Access-Control-Allow-Origin: *`）。
//    ⇒ 以后新增「给浏览器调的 Edge Function 路由」，CORS 是**必备件**，不是可选项。
// ⚠️ 与 Web 的「简单请求」无关：只要带了 apikey 这类自定义头，就必须过预检。
const CORS_HEADERS: Record<string, string> = {
  // 不带 cookie 凭证（鉴权走请求头里的 anon key / token），所以用 * 即可
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  // 浏览器实际会带 apikey / authorization / content-type ⇒ 必须逐个列出（不能用 *，* 对头名无效）
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

  // CORS 预检：必须在【任何业务分支之前】直接回 204（无 body）。
  // ⚠️ 不能让它落到下面的路由里 —— OPTIONS 不带 date 参数，会被当成业务请求回 400/200，
  //    那样响应里同样缺 CORS 头，预检依旧失败（这正是本次事故的现场）。
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // Supabase Edge Function 的 pathname 带前缀 /functions/v1/auction-yizi-fetch，用 endsWith 兼容
  if (p.endsWith('/health')) {
    const keys = configuredKeys();
    const eps = buildEndpoints();
    return json({
      ok: true,
      service: 'auction-yizi-fetch',
      apiname: CONFIG.APINAME,
      board: '竞价一字（独立看板，与早盘竞价看板解耦）',
      // 只回显「配没配 / 用了哪个变量名 / 掩码」，绝不回显密钥本身
      numcatKeySource: keys.length ? keys[0].name : '未配置',
      numcatKeyMasked: keys.length ? maskKey(keys[0].key) : '',
      numcatKeysConfigured: keys.map((k) => k.name),
      // ⛔ 默认关闭：本函数是独立小号，不该悄悄消耗早盘竞价看板的额度
      numcatKeyFallbackToMain: (Deno.env.get('NUMCAT_YIZI_KEY_FALLBACK') || '0').trim() === '1',
      endpoints: eps,
      endpointsSource: (Deno.env.get('NUMCAT_YIZI_ENDPOINTS') ? 'NUMCAT_YIZI_ENDPOINTS'
        : (Deno.env.get('NUMCAT_YIZI_BASE_URL') ? 'NUMCAT_YIZI_BASE_URL' : '内置默认候选（公网→深圳专线→上海专线）')),
      requestTimeoutMs: CONFIG.REQUEST_TIMEOUT_MS,
      window: { start: CONFIG.WINDOW_START, deadline: CONFIG.WINDOW_DEADLINE, pollMs: CONFIG.POLL_MS },
      tokenSource: tokenSource(),
      schedule: '每个交易日北京 09:25（pg_cron，见 db/supabase_auction_yizi_cron.sql；函数内部轮询到 09:25:55，绝不越过 09:26）',
      table: 'auction_yizi（先执行 db/create_auction_yizi.sql 建表）',
      trend: {
        route: '/trend?date=YYYY-MM-DD&window=5（★ 浏览器端只读缓存入口，不校验 token）',
        table: 'yizi_trend（先执行 db/create_yizi_trend.sql 建表）',
        legs: {
          auc: 'daily_auc（竞价量 auc_vol / 竞价涨幅 auc_pct_chg / 昨日成交量 = auc_vol ÷ auc_to_pre_vol_pct）',
          daily: 'daily（涨幅 pct_chg）',
        },
        quotaGuard: {
          protectWindowBeijing: TREND.PROTECT_START + '~' + TREND.PROTECT_END + '（其间一律不补拉，保护 9:25 自动抓取）',
          cooldownMs: TREND.COOLDOWN_MS,
          maxRequestsPerDay: TREND.MAX_REQUESTS_PER_DAY,
          window: TREND.WINDOW,
        },
        note: '从不删除任何行，只补缺口；⛔ 不碰 auction_yizi；key 仍是本函数的小号（NUMCAT_API_KEY_YIZI）',
      },
      nextStep: '排查上游/端点/key/表 请开 /probe?token=…（可加 &symbols=000001,600000 做轻量探测）',
    });
  }

  const isFetch = p === '/' || p === '' || p.endsWith('/fetch') ||
    p.endsWith('/probe') || p.endsWith('/trend') || p.endsWith('/auction-yizi-fetch') || p.endsWith('/auction-yizi-fetch/');
  if (!isFetch) return new Response('auction-yizi-fetch', { status: 200 });

  // ---- 趋势端点（★ 在 token 闸门【之前】）----------------------------------
  // 为什么放在 token 之前：它是【浏览器端的只读缓存入口】——前端展开趋势面板时会调用它。
  // 与 /health 同级不校验 token（理由见文件上方「趋势」章节末尾：额度由 5 道闸门保护 + 从不删除数据）。
  // ⛔ 它绝不碰 auction_yizi，也绝不影响 9:25 那条腿；9:25 的 /fetch 与 /probe 仍然要 token。
  if (p.endsWith('/trend') || url.searchParams.get('point') === 'trend') {
    const rawDate = (url.searchParams.get('date') || '').trim();
    if (rawDate && !/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
      return json({ ok: false, error: 'date 必须形如 YYYY-MM-DD' }, 400);
    }
    const winRaw = Number(url.searchParams.get('window') || 0);
    try {
      return json(await runTrend({
        date: rawDate,
        window: (winRaw > 0 && isFinite(winRaw)) ? winRaw : undefined,
        stocks: splitList(url.searchParams.get('stocks') || ''),
        symbols: splitList(url.searchParams.get('symbols') || ''),
        force: url.searchParams.get('force') === '1',
      }));
    } catch (e) {
      return json({ ok: false, error: (e as Error)?.message || String(e), stack: (e as Error)?.stack }, 500);
    }
  }

  const token = url.searchParams.get('token') || '';
  const et = expectedToken();
  if (!et || token !== et) {
    return json({ ok: false, error: 'token 无效（请设置 Secrets: AUCTION_YIZI_FETCH_TOKEN）' }, 403);
  }

  // 上游体检：不需要 key 已配置（就是用来查 key 的）
  if (p.endsWith('/probe') || url.searchParams.get('point') === 'probe') {
    try {
      return json(await runProbe(url.searchParams.get('symbols') || undefined));
    } catch (e) {
      return json({ ok: false, error: (e as Error)?.message || String(e), stack: (e as Error)?.stack }, 500);
    }
  }

  if (configuredKeys().length === 0) {
    return json({ ok: false, error: '猫抓小号 key 未配置（请设置 Secrets: ' + KEY_PRIMARY + ' 或 ' + KEY_ALT + '）' }, 500);
  }

  const date = url.searchParams.get('date') || '';
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return json({ ok: false, error: 'date 必须形如 YYYY-MM-DD' }, 400);
  }
  const once = url.searchParams.get('once') === '1';

  try {
    const result = await runAuctionYizi({
      date: date,
      source: date ? 'http-backfill' : (once ? 'http-once' : 'http'),
      once: once,
    });
    return json(result, result.ok ? 200 : 500);
  } catch (e) {
    return json({ ok: false, error: (e as Error)?.message || String(e), stack: (e as Error)?.stack }, 500);
  }
});
