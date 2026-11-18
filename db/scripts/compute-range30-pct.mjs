#!/usr/bin/env node
// compute-range30-pct.mjs — 云端计算「30日涨幅」并落库 stock_range30_pct（leg='close'），可反复重跑
//
// ══════════════════════════════════════════════════════════════════════════════════════
// 为什么必须搬到云端算（2026-11-18 用户原话）
//   「你是不是只在本地运行了，我一直要求在云端运行的，关了电脑也能够在手机正常看到线上应用正常运行」
//
// 病根（实测）：
//   原来 30 日涨幅**只由手机浏览器**现打腾讯日线现算。而腾讯这个接口对「短时间内一批并发请求」
//   会直接回 WAF 拦截页（HTTP 501 + HTML，不是 JSON）——`db/scripts/backfill-range20-pct.mjs`
//   里早就记了同一条教训（830 个请求十几秒打完 ⇒ 整批 414 只全废）。
//   于是：用户点开 toggle ⇒ 32 只并发打过去 ⇒ 被拦 ⇒ 全部判不出 ⇒ 行上空白、也不排序；
//        而且关掉电脑/换设备都救不回来，因为库表里一条记录都没有。
//
// 修法：把「取价 + 算比值 + 落库」搬到云端定时任务（GitHub Actions，见
//   `.github/workflows/range30-cloud.yml`），前端只读 `stock_range30_pct`。
//   ⇒ 手机不再需要连腾讯；与 20 日涨幅（stock_range20_pct）同一条「读表」路径。
//
// 口径（⛔ 与前端 range30.js 公用同一份纯函数，别在这里复制公式）：
//   · 窗口 = 含 T 在内往前 30 个交易日；baseDate = 窗口首日的前一个交易日；
//   · 30 日涨幅 = 期末收盘 / 期初前收盘 − 1（一次性比值，等价于逐日连乘但少一层舍入）；
//   · 停牌等价：取「≤ 目标日的最后一根 bar」；次新股 / 腿数 < 10 一律判不出（§10 不补 0）。
//   数学部分 import `src/logic/auction/range30-math.js`（前端/云端唯一一份）。
//
// 候选池（2026-11-18 第二次报障后修正，⛔ 别改回「只算当天名单」）：
//   30日涨幅 toggle 下看板渲染的不只是当天正式名单，还有「30天」补位 / 「20天」补位 / 龙头组
//   这三类**注入行**——它们不在当天的 auction_watchlist 里。只算当天 32 只 ⇒ 这些行查不到值 ⇒
//   用户看到「带 20天/30天 标签的行、灰色行 股票名后面一片空白」(原话)。
//   ⇒ 候选池 = 当天名单 ∪ 近 40 个交易日名单（实测去重 318 只，约 2 分钟跑完）。
//   40 > 30（30天补位窗口）+ 龙头名册回看余量；即使通道中途被限流，当天名单也排在最前面先算完。
//
// 交易日历：用【上证指数 sh000001 的日线日期】当真实交易日序列。
//   为什么不用 weekday 近似：长假/调休会错位，而指数永不停止交易，它的 bar 日期就是真值。
//
// 用法
//   node db/scripts/compute-range30-pct.mjs                     # 干跑：只报能算出几只（不写库）
//   node db/scripts/compute-range30-pct.mjs --run               # 真跑：算今天（北京）并落库
//   node db/scripts/compute-range30-pct.mjs --run --date=2026-11-18
//   node db/scripts/compute-range30-pct.mjs --run --date=2026-11-18 --overwrite   # 覆盖已有行
//   node db/scripts/compute-range30-pct.mjs --run --days=10     # 回填最近 10 个交易日
// ══════════════════════════════════════════════════════════════════════════════════════

import { windowFromTradingDays, range30InWindow, RANGE30_WINDOW_DAYS, RANGE30_MIN_LEGS } from '../../src/logic/auction/range30-math.js';

const SB = process.env.SUPABASE_URL || 'https://tonqfgeyxnnwicjopshn.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRvbnFmZ2V5eG5ud2ljam9wc2huIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2NjY3NzEsImV4cCI6MjA5NDI0Mjc3MX0.el-W10JIjr9iQXEKNxV7nLNdhZfOQp6waTY7ZSH27Jg';

// ── 腾讯通道（两个 host 都试；`web.` 子域 2026-11-18 起整站 501）────────────────────
const QT_HOSTS = ['https://ifzq.gtimg.cn', 'https://web.ifzq.gtimg.cn'];
const QT_PATH = '/appstock/app/fqkline/get';
const QT_GAP_MS = 300;          // 单请求最小间隔：打太快必被 WAF 拦（见文件头）
const CIRCUIT_LIMIT = 5;        // 连续这么多只拿不到 ⇒ 判通道不可用，本轮停止再打上游
const QT_PROBE_DAYS = 60;       // 自然日跨度（30 交易日 ≈ 42 自然日 + 长假余量）

const ARGS = process.argv.slice(2);
const RUN = ARGS.includes('--run');
const OVERWRITE = ARGS.includes('--overwrite');
const argOf = (name) => {
  const hit = ARGS.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.split('=').slice(1).join('=') : '';
};

const pad = (n) => String(n).padStart(2, '0');
function beijingToday() {
  // +8h 后用 UTC 字段读数，避免本机时区影响（与 worker 的 beijingToday 同口径）
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
}
function shiftYmd(ymd, n) {
  const t = Date.parse(String(ymd).slice(0, 10) + 'T00:00:00Z');
  return new Date(t + n * 86400000).toISOString().slice(0, 10);
}
const symOf = (code) => {
  const c = String(code || '').replace(/\D/g, '');
  if (c.length !== 6) return '';
  return (/^(6|9)/.test(c) ? 'sh' : (/^(4|8|92)/.test(c) ? 'bj' : 'sz')) + c;
};

// ── Supabase REST ────────────────────────────────────────────────────────────────
const sbHeaders = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };
async function sbGet(path) {
  const r = await fetch(SB + '/rest/v1/' + path, { headers: sbHeaders });
  if (!r.ok) throw new Error('GET ' + path + ' → HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return r.json();
}
async function sbUpsert(table, onConflict, rows) {
  if (!rows.length) return 0;
  const r = await fetch(SB + '/rest/v1/' + table + '?on_conflict=' + onConflict, {
    method: 'POST',
    headers: Object.assign({}, sbHeaders, { Prefer: 'resolution=merge-duplicates, return=minimal' }),
    body: JSON.stringify(rows)
  });
  if (!r.ok) throw new Error('upsert ' + table + ' → HTTP ' + r.status + ' ' + (await r.text()).slice(0, 300));
  return rows.length;
}

// ── 腾讯日线（host 失败切换 + 请求间隔 + 连续失败熔断）───────────────────────────
let _hostIdx = 0;
let _nextAt = 0;
let _consecFail = 0;

async function qtJson(qs, timeoutMs) {
  let lastErr = null;
  for (let k = 0; k < QT_HOSTS.length; k++) {
    const idx = (_hostIdx + k) % QT_HOSTS.length;
    const url = QT_HOSTS[idx] + QT_PATH + '?' + qs;
    // 节流：与上一次请求至少间隔 QT_GAP_MS
    const wait = _nextAt - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    _nextAt = Date.now() + QT_GAP_MS;
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://gu.qq.com/' },
        signal: AbortSignal.timeout(timeoutMs || 9000)
      });
      if (!resp.ok) { lastErr = new Error('HTTP ' + resp.status); continue; }
      const text = await resp.text();
      // WAF 拦截页：HTML / 非 `{` 开头 ⇒ 换 host（⛔ 不能只看 resp.ok，软拦截也可能是 200）
      if (text.charAt(0) !== '{' || text.indexOf('waf.tencent.com') >= 0) {
        lastErr = new Error('非 JSON 响应（疑似 WAF 拦截页，host=' + QT_HOSTS[idx] + '）');
        continue;
      }
      _hostIdx = idx;
      return JSON.parse(text);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('腾讯日线不可用');
}

/** 拉一只票的前复权日线 → [{ymd, close}]（失败抛错，由调用方记「取不到」） */
async function qtBars(code, fromYmd, toYmd) {
  const sym = symOf(code);
  if (!sym) throw new Error('代码非法: ' + code);
  return qtBarsBySym(sym, fromYmd, toYmd);
}

/** 按【已带前缀的 symbol】拉日线（指数用：'sh000001'；⚠️ 别拿 000001 走 symOf，那是平安银行） */
async function qtBarsBySym(sym, fromYmd, toYmd) {
  const j = await qtJson('param=' + sym + ',day,' + fromYmd + ',' + toYmd + ',320,qfq');
  const d = (j && j.data && j.data[sym]) || {};
  const rows = d.qfqday || d.day || [];
  const bars = [];
  for (const b of rows) {
    if (!Array.isArray(b) || !b[0]) continue;
    const close = Number(b[2]);
    if (!isFinite(close) || close <= 0) continue;
    bars.push({ ymd: String(b[0]).slice(0, 10), close: close });
  }
  return bars;
}

// ── 主流程 ──────────────────────────────────────────────────────────────────────

/**
 * 候选池深度（交易日）。为什么不是「只算当天名单的 32 只」：
 *   早盘竞价看板在 30日涨幅 toggle 下渲染的不只是当天正式名单，还有三类【注入行】——
 *     · 「30天」补位（近 30 个交易日名单里 30 日涨幅前五、但今天不在名单）；
 *     · 「20天」补位（近 20 个交易日名单里 20 日涨幅前五）；
 *     · 龙头组（来自前一交易日的龙头名册，名册又来自更早的名单）。
 *   这三类票【不在当天的 auction_watchlist 里】，只算 32 只的话它们查不到值 ⇒
 *   用户看到的就是「带 20天/30天 标签的行、灰色行 股票名后面一片空白」（2026-11-18 报障）。
 *   ⇒ 候选池改为「今天 ∪ 近 N 个交易日名单」，超集覆盖上述三类，一次算完全月复用。
 *   40 > 30（30天补位窗口）+ 龙头名册回看余量。
 */
const UNIVERSE_TRADING_DAYS = 40;

/**
 * 取「今天名单 ∪ 近 N 个交易日名单」作为候选池。
 * 行内 code 是真值（auction_watchlist.code 实测 32/32 有值）；同名多行时优先保留有 code 的那行。
 * 失败 ⇒ 退化为「只要今天名单」（保持旧行为，不因为候选池查询失败就整天不出值）。
 */
async function buildUniverse(d, cal, logs) {
  const names = new Map();          // stock -> code（'' = 还没有）
  const pushRows = (rows) => {
    for (const r of rows || []) {
      const n = String(r.stock || '').trim();
      if (!n) continue;
      const c = String(r.code || '').replace(/\D/g, '');
      const old = names.get(n);
      if (old === undefined) names.set(n, c.length === 6 ? c : '');
      else if (old.length !== 6 && c.length === 6) names.set(n, c);
    }
  };

  try {
    pushRows(await sbGet('auction_watchlist?date=eq.' + encodeURIComponent(d) + '&select=stock,code'));
  } catch (e) {
    logs.push('当天名单读取失败: ' + e.message);
  }

  const uniStart = cal.length > UNIVERSE_TRADING_DAYS
    ? cal[cal.length - UNIVERSE_TRADING_DAYS]
    : (cal[0] || d);
  try {
    // PostgREST 单页上限 1000 行 ⇒ 翻页取全（40 个交易日 × ~40 只 ≈ 1600 行）
    for (let off = 0; off < 20000; off += 1000) {
      const page = await sbGet('auction_watchlist?date=gte.' + encodeURIComponent(uniStart)
        + '&date=lte.' + encodeURIComponent(d) + '&select=stock,code'
        + '&limit=1000&offset=' + off);
      pushRows(page);
      if (!page || page.length < 1000) break;
    }
    logs.push('候选池 ' + uniStart + '~' + d + '（近 ' + UNIVERSE_TRADING_DAYS + ' 个交易日名单）');
  } catch (e) {
    logs.push('候选池读取失败（退化为只要今天名单）: ' + e.message);
  }

  return Array.from(names.entries()).map(([stock, code]) => ({ stock, code }));
}

async function computeOneDay(date) {
  const d = date;
  const logs = [];

  // ① 交易日历（早于候选池：候选池要按「最近 N 个交易日」切；上证指数不会停牌，它的 bar 日期就是真值）
  const calFrom = shiftYmd(d, -180);
  const calBars = await qtBarsBySym('sh000001', calFrom, d).catch(() => []);
  const cal = calBars.map((b) => b.ymd).filter((x) => x <= d);
  const win = windowFromTradingDays(cal, d, RANGE30_WINDOW_DAYS);
  if (!win || !win.baseDate) return { ok: false, date: d, reason: '交易日历不足（指数日线拿不到）', logs };
  logs.push('窗口 ' + win.start + '~' + win.end + '，基准日 ' + win.baseDate);

  // ② 候选池（今天名单 ∪ 近 N 个交易日名单 —— 覆盖 30天/20天 补位与龙头组这三类注入行）
  const targets = await buildUniverse(d, cal, logs);
  if (targets.length === 0) return { ok: false, date: d, reason: '当天名单为空', logs };

  // ③ 代码补全（缺 code 的才回退 stockcodemap；分块，避免 in.(...) URL 过长）
  const missingCode = targets.filter((t) => t.code.length !== 6).map((t) => t.stock);
  if (missingCode.length) {
    for (let i = 0; i < missingCode.length; i += 100) {
      const chunk = missingCode.slice(i, i + 100);
      const inList = chunk.map((n) => '%22' + encodeURIComponent(n) + '%22').join(',');
      try {
        const rows = await sbGet('stockcodemap?select=stock,code&stock=in.(' + inList + ')');
        const map = new Map(rows.map((r) => [String(r.stock || '').trim(), String(r.code || '').replace(/\D/g, '')]));
        targets.forEach((t) => {
          if (t.code.length !== 6) {
            const c = map.get(t.stock) || '';
            if (c.length === 6) t.code = c;
          }
        });
      } catch (e) {
        logs.push('stockcodemap 读取失败（该批票按判不出处理）: ' + e.message);
      }
    }
  }

  // ④ 已有行（不覆盖；--overwrite 才重算）
  let existing = new Set();
  if (!OVERWRITE) {
    const rows = await sbGet('stock_range30_pct?date=eq.' + encodeURIComponent(d) + '&select=stock');
    existing = new Set(rows.map((r) => String(r.stock || '').trim()));
  }
  const todo = targets.filter((t) => !existing.has(t.stock));
  if (todo.length === 0) return { ok: true, date: d, targets: targets.length, computed: 0, written: 0, skipped: targets.length, logs };

  // ⑤ 逐只取价现算
  const from = shiftYmd(d, -QT_PROBE_DAYS);
  const writeRows = [];
  const failed = [];
  for (const t of todo) {
    if (_consecFail >= CIRCUIT_LIMIT) {
      logs.push('连续 ' + CIRCUIT_LIMIT + ' 只取不到日线 ⇒ 判定腾讯通道被限流/WAF，本轮提前停止（已写 ' + writeRows.length + ' 行）');
      break;
    }
    if (t.code.length !== 6) { failed.push(t.stock + '(无代码)'); continue; }
    let bars = [];
    try {
      bars = await qtBars(t.code, from, d);
      _consecFail = 0;
    } catch (e) {
      _consecFail++;
      failed.push(t.stock + '(' + (e.message || e) + ')');
      continue;
    }
    const got = range30InWindow(bars, win, {});
    if (!got) { failed.push(t.stock + '(判不出)'); continue; }
    writeRows.push({
      date: d,
      stock: t.stock,
      pct: got.pct.toFixed(2),
      days: got.days,
      leg: 'close',
      updated_at: new Date().toISOString()
    });
  }

  let written = 0;
  if (RUN && writeRows.length) written = await sbUpsert('stock_range30_pct', 'date,stock,leg', writeRows);
  return {
    ok: true,
    date: d,
    window: win.start + '~' + win.end,
    baseDate: win.baseDate,
    targets: targets.length,
    todo: todo.length,
    computed: writeRows.length,
    written: written,
    skipped: existing.size,
    failed: failed.length,
    // 判不出的票名只留前 25 个（候选池 400+ 时全打印会把日志撑爆）
    failedSample: failed.slice(0, 25),
    sample: writeRows.slice(0, 5).map((r) => r.stock + ' ' + r.pct + '%'),
    logs
  };
}

(async function main() {
  const today = beijingToday();
  const single = argOf('date');
  const days = Number(argOf('days') || 0) || 1;
  const dates = [];
  if (single) dates.push(single);
  else {
    // 未指定日期：默认今天；--days=N 时回填最近 N 个【日历日】里有名单的那些天
    for (let i = 0; i < days; i++) dates.push(shiftYmd(today, -i));
  }
  console.log((RUN ? '【真跑】' : '【干跑】') + ' 目标日: ' + dates.join(', ') +
    '（30 日窗口 / 腿数门槛 ' + RANGE30_MIN_LEGS + '）');
  for (const d of dates) {
    try {
      const r = await computeOneDay(d);
      console.log(JSON.stringify(r, null, 1));
      if (!r.ok && r.reason === '当天名单为空') continue;
    } catch (e) {
      console.error('❌ ' + d + ' 失败: ' + (e && e.message));
      process.exitCode = 1;
    }
  }
})();
