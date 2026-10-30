#!/usr/bin/env node
// backfill-daily-pct.mjs — 把「逐日收盘涨幅腿」灌满 stock_daily_pct（可反复重跑，幂等）
//
// ══════════════════════════════════════════════════════════════════════════════════════
// 为什么需要它（2026-10-30 用户报障）
//   20 日涨幅以前每天都要把全部票重拉一遍同花顺 K 线 —— 因为 `stock_range20_pct` 存的是
//   【窗口涨幅】（date = 窗口末日 T），每天都是新日期、每天都不命中；窗口涨幅又【不可拆解】
//   （复利不能相减），所以表再大也复不了。而上游当日实测 50% 概率挂死 15 秒。
//   用户原话：「历史数据先存好，次日在算次日……看表里有没有数据，有的话看哪天没有补哪天，
//     没有的话，就全补，这样局部补数据，而不是每次整体获取，这样很慢，影响体验。」
//
//   ⇒ 本脚本把「逐日腿」一次性灌进 stock_daily_pct（一只票只需 1 次 K 线请求）。
//     之后前端稳态下【0 个 K 线请求】：19 根历史腿读表 + 今天那根用当天竞价涨幅当场复合。
//
// 幂等性
//   · 只写「表里还没有的 (date, stock)」，已有的行一律不动 ⇒ 重跑零漂移。
//   · 停牌 / 当天没有 bar ⇒ 不写（§10 缺数据 ≠ 0%）。
//   · ⛔ 不写「今天」——盘中那根 K 线是现价，写进原料表会被当成收盘腿，明天算窗口直接算错。
//
// 用法
//   node db/scripts/backfill-daily-pct.mjs                 # 干跑（只报还缺多少，不打上游）
//   node db/scripts/backfill-daily-pct.mjs --run           # 真跑：先 market_metrics 批量补，再 K 线补差
//   node db/scripts/backfill-daily-pct.mjs --run --days=60 # 回溯多少个自然日（默认 60）
//   node db/scripts/backfill-daily-pct.mjs --run --concurrency=2
//   node db/scripts/backfill-daily-pct.mjs --run --recent  # 只补最近一个榜日那批票（每日 08:00 cron 用）
//   node db/scripts/backfill-daily-pct.mjs --run --no-metrics  # 跳过批量源（调试用，会很慢）
// ══════════════════════════════════════════════════════════════════════════════════════

const SB = process.env.SUPABASE_URL || 'https://tonqfgeyxnnwicjopshn.supabase.co';
const ANON = process.env.SUPABASE_ANON_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRvbnFmZ2V5eG5ud2ljam9wc2huIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2NjY3NzEsImV4cCI6MjA5NDI0Mjc3MX0.el-W10JIjr9iQXEKNxV7nLNdhZfOQp6waTY7ZSH27Jg';

const FUYAO = SB + '/functions/v1/fuyao-proxy';
const KLINE_PATH = '/api/a-share/prices/historical';
// ★★ [R20-DIRECT 2026-10-30] 直连通道（可选，强烈建议）：设了 FUYAO_API_KEY 就不走 Supabase 代理。
//   实测（.tmpdiag/probe-kline-upstream.cjs）：走 fuyao-proxy 时 10 只里 9 只「12 秒既不返回也不断开」，
//   45 秒超时也一样；而本机到 fuyao.aicubes.cn 的 TCP/TLS 只要 871ms（无 key 时秒回 code=2003）。
//   ⇒ 卡的是代理那一层，不是同花顺本尊。直连后同样一只票 2.6 秒就回 52 根 K 线。
//   用法：FUYAO_API_KEY=xxxx node db/scripts/backfill-daily-pct.mjs --run
//   （key 与 Supabase Secrets 里的 FUYAO_API_KEY 是同一个；⛔ 不要写进仓库/提交）
const FUYAO_KEY = process.env.FUYAO_API_KEY || '';
const FUYAO_BASE = (process.env.FUYAO_BASE_URL || 'https://fuyao.aicubes.cn').replace(/\/$/, '');
const PAGE = 1000;
const UPSERT_CHUNK = 500;
const H = { apikey: ANON, Authorization: 'Bearer ' + ANON };

const args = process.argv.slice(2);
const RUN = args.includes('--run');
const argOf = function (k, d) {
  const hit = args.find(function (a) { return a.indexOf('--' + k + '=') === 0; });
  return hit ? hit.slice(k.length + 3) : d;
};
const CONCURRENCY = Math.max(1, Number(argOf('concurrency', 2)) || 2);
const DAYS = Math.max(30, Number(argOf('days', 60)) || 60);
// ★★ [R20-DAILY 2026-10-30] `--recent`：只补【最近一个榜日】上的那批票（当天名单 + 补位池 top）。
//   为什么要有这个模式：逐日腿表必须每天补掉「昨天那根」，否则第二天早上的窗口会静默跳过一天
//   （compound20 把"没写"当成"停牌"）。全量 405 只每天跑 = 405 个 K 线请求，没必要；
//   看板真正用到的只有最新一天那 ~80~100 只 ⇒ 每天只补这批，请求量降到 ~1/4。
//   ⚠️ 首次建表仍需全量跑一次（不带 --recent），否则历史 19 根腿凑不齐。
const RECENT = args.includes('--recent');
// ★★ [R20-METRICS 2026-10-30] 允许关掉「先用 market_metrics 批量补」这一步（仅调试用）。
const NO_METRICS = args.includes('--no-metrics');
// ★ [R20-DIRECT] 有 key 就直连（见文件头说明）；--proxy 强制走 Supabase 代理
const DIRECT = !!FUYAO_KEY && !args.includes('--proxy');

const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
/** YYYY-MM-DD（北京时区；⛔ 不能用 toISOString 直接切 —— 那是 UTC，会差一天） */
function ymd(ms) { return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10); }
function todayYmd() { return ymd(Date.now()); }

/**
 * REST GET（Range 分页）。
 * ★★ [R20-DAILY 2026-10-30] 必须自带重试 —— 实测本机到 Supabase 会偶发 `TypeError: fetch failed`
 *   （几分钟内出现两次），不重试就是「脚本跑了一半整个崩掉」，而用户看到的结果是
 *   「SQL 执行了、表还是空的」。任何一次瞬时抖动都不该让 400 只票的补齐作废。
 */
async function sbGet(path) {
  const out = [];
  let from = 0;
  for (;;) {
    let arr = null;
    let lastErr = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await sleep(800 * attempt);
      try {
        const r = await fetch(SB + '/rest/v1/' + path, {
          headers: Object.assign({}, H, { Range: from + '-' + (from + PAGE - 1), 'Range-Unit': 'items' }),
        });
        if (!r.ok) {
          const body = (await r.text()).slice(0, 200);
          // 4xx（表不存在 / 语法错）不重试，直接抛；5xx / 429 重试
          if (r.status < 500 && r.status !== 429) {
            throw new Error('REST GET ' + path.slice(0, 80) + ' -> ' + r.status + ' ' + body);
          }
          throw new Error('REST GET ' + r.status + ' ' + body);
        }
        arr = await r.json();
        break;
      } catch (e) {
        lastErr = e;
        if (/-> 4\d\d /.test(String(e && e.message))) throw e;
      }
    }
    if (arr === null) throw lastErr || new Error('REST GET 失败（已重试 4 次）: ' + path.slice(0, 80));
    out.push.apply(out, arr);
    if (arr.length < PAGE) break;
    from += PAGE;
    if (from > 100000) break;
  }
  return out;
}

async function sbUpsertDaily(rows) {
  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await sleep(800 * attempt);
    try {
      const r = await fetch(SB + '/rest/v1/stock_daily_pct?on_conflict=date,stock', {
        method: 'POST',
        headers: Object.assign({}, H, { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify(rows),
      });
      if (r.ok) return;
      const body = (await r.text()).slice(0, 300);
      if (/relation .* does not exist|42P01/i.test(body)) {
        throw new Error('stock_daily_pct 表不存在 —— 先在 Supabase SQL Editor 执行 db/create_stock_daily_pct.sql');
      }
      // 主键冲突 / 权限问题重试也没用，直接抛
      if (r.status >= 400 && r.status < 500 && r.status !== 429) {
        throw new Error('REST POST -> ' + r.status + ' ' + body);
      }
      lastErr = new Error('REST POST -> ' + r.status + ' ' + body);
    } catch (e) {
      if (/表不存在|REST POST -> 4\d\d /.test(String(e && e.message))) throw e;
      lastErr = e;
    }
  }
  throw lastErr || new Error('REST POST 失败（已重试 4 次）');
}

/** 百分比字段 → 数值（'‑3.84%' / '+1.20' / -3.84 都吃；缺失 ⇒ null，⛔ 不返回 0） */
function numPct(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace('%', '').replace('+', '').trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * ★★ [R20-METRICS 2026-10-30] 用 `market_metrics` 批量补逐日腿（3~4 个请求覆盖全部票 × 60 天）。
 *
 * 为什么必须有这一步（实测，别再"应该没问题"地推理）：
 *   同花顺日线接口当日实测 **10 只里 9 只 12 秒既不返回也不断开**（探针 .tmpdiag/probe-kline-upstream.cjs），
 *   而每只票要 1 次请求 ⇒ 400 只票的全量回填跑一小时只成功 51 只（今日名单 42 只里仅 17 只凑够腿）。
 *   同一份「昨天的收盘涨幅」其实**已经在库里**（market_metrics，收盘覆盖流程写进去的），
 *   一个 Range 分页就能全读回来 ⇒ 请求数从 ~400 降到 ~4。
 *
 * 🔴 门控（§10 的命根子，⛔ 不要放宽）：
 *   只有当 `change_pct !== auc_pct_chg` 时才认这条腿 —— 那才说明 change_pct 是**收盘覆盖**写进去的。
 *   两者相等 ⇒ 还停在早盘竞价值（从没被收盘覆盖过），拿它当收盘腿会让整条 20 日复利静默算错
 *   （这正是记忆里「⛔ 不能拿 auction_watchlist.change_pct 当原料」的同一个坑）。
 *   实测（.tmpdiag/verify-mm-gate.cjs，与 K 线真值逐条比对 426 条）：
 *     门控通过 383 条 → 382 条与 K 线完全一致（99.7%），唯一不符的是 2.63 vs 2.61（两位小数舍入）；
 *     门控拒绝 43 条 → 只有 62.8% 碰巧正确（剩下的是竞价值）⇒ 拒掉是对的。
 *   ⚠️ 代价：收盘价恰好等于竞价值的票会被误拒（假阴性）—— 宁可少补一根，⛔ 不接受错值。
 *
 * @returns {Promise<{rows:Array, scanned:number, gated:number, rejected:number}>}
 */
async function metricsLegs(fromYmd, todayYmdStr) {
  const scanned = await sbGet('market_metrics?select=stock,date,change_pct,auc_pct_chg&date=gte.' + fromYmd
    + '&date=lt.' + todayYmdStr + '&limit=100000');
  const rows = [];
  let rejected = 0;
  scanned.forEach(function (r) {
    const n = String(r.stock || '').trim();
    if (!n) return;
    const c = numPct(r.change_pct);
    if (c === null) return;
    const a = numPct(r.auc_pct_chg);
    if (a !== null && Math.abs(c - a) < 0.011) { rejected++; return; }   // 竞价值未覆盖 ⇒ ⛔ 不收
    const d = String(r.date || '');
    if (!d || d >= todayYmdStr) return;                                   // 只写今天之前
    rows.push({ date: d, stock: n, pct: (c < 0 ? '' : '+') + c.toFixed(2), src: 'metrics' });
  });
  return { rows: rows, scanned: scanned.length, gated: rows.length, rejected: rejected };
}

/** 6 位代码 → 同花顺 thscode */function thscode(t) {
  const s = String(t || '').trim();
  if (!s || s.indexOf('.') >= 0) return s;
  if (s.length !== 6) return s;
  if (s[0] === '6') return s + '.SH';
  if (s[0] === '0' || s[0] === '3') return s + '.SZ';
  if (s[0] === '8' || s[0] === '4') return s + '.BJ';
  if (s.slice(0, 2) === '92') return s + '.BJ';
  if (s[0] === '9') return s + '.SH';
  return s + '.SZ';
}

/**
 * 取一只票的日线（前复权），返回 [{ymd, close}] 升序。
 * 上游实测 50% 概率「既不返回也不断开」⇒ 必须超时 + 重试（⛔ 不能靠 Promise.all 硬等）。
 */
async function fetchBars(code, startMs, endMs) {
  const u = DIRECT ? new URL(FUYAO_BASE + KLINE_PATH) : new URL(FUYAO);
  if (!DIRECT) u.searchParams.set('path', KLINE_PATH);
  u.searchParams.set('thscode', thscode(code));
  u.searchParams.set('interval', '1d');
  u.searchParams.set('start', String(startMs));
  u.searchParams.set('end', String(endMs));
  u.searchParams.set('adjust', 'forward');
  // 直连带 X-api-key；走代理只带 anon Bearer（代理自己注入 key）
  const headers = DIRECT ? { 'X-api-key': FUYAO_KEY } : { Authorization: 'Bearer ' + ANON };
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) await sleep(1200 * attempt);
    const ctrl = new AbortController();
    const timer = setTimeout(function () { ctrl.abort(); }, 12000);
    try {
      const r = await fetch(u.toString(), { headers: headers, signal: ctrl.signal });
      if (!r.ok) throw new Error('proxy HTTP ' + r.status);
      const j = await r.json();
      if (!j || j.code !== 0) throw new Error('fuyao code=' + (j && j.code) + ' ' + (j && j.message));
      const out = [];
      ((j.data && j.data.item) || []).forEach(function (x) {
        if (x.date_ms == null || x.close_price == null) return;
        const c = Number(x.close_price);
        if (!Number.isFinite(c) || c <= 0) return;
        out.push({ ymd: ymd(Number(x.date_ms)), close: c });
      });
      out.sort(function (a, b) { return a.ymd < b.ymd ? -1 : (a.ymd > b.ymd ? 1 : 0); });
      if (out.length === 0) throw new Error('空序列');
      return out;
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      if (/rate limit/i.test(msg)) { await sleep(3000 * (attempt + 1)); continue; }
      if (attempt === 4) throw e;
    } finally { clearTimeout(timer); }
  }
  return [];
}

/**
 * 日线序列 → 逐日涨幅腿（只取「今天之前」的日子）。
 * ⚠️ 必须排除 todayYmd()：今天那根盘中是现价，写进原料表会被当成收盘腿（静默算错，最难查）。
 */
function legsFromBars(bars, today) {
  const out = [];
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1].close;
    const cur = bars[i].close;
    if (!(prev > 0) || !(cur > 0)) continue;
    const d = bars[i].ymd;
    if (d >= today) continue;                 // 🔴 只写今天之前
    const p = (cur / prev - 1) * 100;
    if (!Number.isFinite(p)) continue;
    out.push({ date: d, pct: p });
  }
  return out;
}

async function main() {
  const today = todayYmd();
  const from = ymd(Date.now() - DAYS * 86400000);
  console.log('今天 =', today, '｜回溯区间 =', from, '~ 昨天（⛔ 不写今天）');
  console.log('K 线通道 =', DIRECT ? ('直连 ' + FUYAO_BASE + '（快）') : 'Supabase 代理 fuyao-proxy（实测 85% 超时）');

  // ① 股票全集 = 近期名单并集 ∪ 20日结果表里出现过的票（补位票一天都不能漏）
  const rowsWl = await sbGet('auction_watchlist?select=stock,code&date=gte.' + from + '&date=lt.' + today + '&limit=50000');
  const rowsR20 = await sbGet('stock_range20_pct?select=stock&date=gte.' + from + '&limit=50000');
  const codeOf = new Map();
  rowsWl.forEach(function (r) {
    const n = String(r.stock || '').trim();
    if (!n) return;
    const c = String(r.code || '').trim();
    if (c && !codeOf.has(n)) codeOf.set(n, c);
  });
  rowsR20.forEach(function (r) {
    const n = String(r.stock || '').trim();
    if (n && !codeOf.has(n)) codeOf.set(n, '');
  });

  // 缺码的走 stockcodemap 补
  const noCode = Array.from(codeOf.keys()).filter(function (n) { return !codeOf.get(n); });
  for (let i = 0; i < noCode.length; i += 100) {
    const chunk = noCode.slice(i, i + 100);
    const list = '(' + chunk.map(function (n) { return '"' + n.replace(/"/g, '').replace(/[()]/g, '') + '"'; }).join(',') + ')';
    const cm = await sbGet('stockcodemap?select=stock,code&stock=in.' + encodeURIComponent(list));
    cm.forEach(function (r) {
      const n = String(r.stock || '').trim();
      const c = String(r.code || '').trim();
      if (n && c) codeOf.set(n, c);
    });
  }

  const poolAll = Array.from(codeOf.entries())
    .filter(function (e) { return !!e[1]; })
    .map(function (e) { return { stock: e[0], code: e[1] }; });
  // ★ 今日名单的票排在最前：回填是逐只增量写库的，先补今天的 40 来只，
  //   看板立刻就能 0 请求出数（剩下的 300 多只是给「20日涨幅前五 / 前十」补位池用的，晚一点无所谓）。
  try {
    const rowsToday = await sbGet('auction_watchlist?select=stock&date=eq.' + today + '&limit=5000');
    const todaySet = new Set(rowsToday.map(function (r) { return String(r.stock).trim(); }));
    poolAll.sort(function(a, b) {
      const ia = todaySet.has(a.stock) ? 0 : 1;
      const ib = todaySet.has(b.stock) ? 0 : 1;
      return ia - ib;
    });
    console.log('今日名单优先 =', Array.from(todaySet).length, '只');
  } catch (e) { /* 读不到今日名单就按原顺序 */ }
  console.log('股票全集 =', poolAll.length, '只（另有 ' + (codeOf.size - poolAll.length) + ' 只缺代码，跳过）');

  // ★★ [R20-DAILY] --recent：只保留「最近一个榜日」上的票（当天名单 ∪ 补位池 = 看板真正用到的那批）
  let pool = poolAll;
  if (RECENT) {
    const keep = new Set();
    const takeLatest = async function (table, limit) {
      // ⚠️ 必须 lte.today：表里可能已经有人预置了「下一个交易日」的名单（如 10-30 就录了 11-02），
      //   不加这个闸门会把那天的票当成「最近一个榜日」⇒ 当天该补的一只都没补。
      const rows = await sbGet(table + '?select=stock,date&date=lte.' + today + '&order=date.desc&limit=' + limit);
      let maxD = '';
      rows.forEach(function (r) {
        const d = String(r.date || '');
        if (d > maxD) maxD = d;
      });
      rows.forEach(function (r) {
        if (String(r.date || '') === maxD) {
          const n = String(r.stock || '').trim();
          if (n) keep.add(n);
        }
      });
      return maxD;
    };
    const d1 = await takeLatest('auction_watchlist', 300);
    const d2 = await takeLatest('stock_range20_pct', 600);
    pool = poolAll.filter(function (e) { return keep.has(e.stock); });
    console.log('--recent：榜日 ' + d1 + ' / 结果表 ' + d2 + ' ⇒ 目标 ' + pool.length + ' 只'
      + '（全量 ' + poolAll.length + ' 只）');
  }
  if (pool.length === 0) { console.log('没有可补的票'); return; }

  // ② 已有腿快照（只用于统计缺口 + 决定哪些票完全不用请求）
  let have = new Set();
  try {
    const rowsHave = await sbGet('stock_daily_pct?select=date,stock&date=gte.' + from + '&limit=100000');
    have = new Set(rowsHave.map(function (r) { return String(r.date) + '|' + String(r.stock).trim(); }));
  } catch (e) {
    console.log('⚠️ 读 stock_daily_pct 失败（表还没建？）：' + (e && e.message || e));
    console.log('   → 先执行 db/create_stock_daily_pct.sql，再重跑本脚本。');
    if (!RUN) return;
    throw e;
  }
  console.log('表里已有 =', have.size, '行');
  if (!RUN) {
    console.log('\n干跑结束（未打上游）。加 --run 真跑。');
    return;
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // ②.5 ★★ [R20-METRICS 2026-10-30] 先用 market_metrics 批量补（几秒 · 3~4 个请求）
  //   把「昨天的收盘腿」从库里直接搬过来，K 线只用来补它真的没有的那几只。
  //   实测动机：上游 85% 超时，全量走 K 线一小时只补 51 只（见 metricsLegs 文档）。
  // ═══════════════════════════════════════════════════════════════════════════════
  if (!NO_METRICS) {
    try {
      const m = await metricsLegs(from, today);
      const todo = m.rows.filter(function (r) { return !have.has(r.date + '|' + r.stock); });
      console.log('②.5 market_metrics 扫描 ' + m.scanned + ' 行 ⇒ 过门控 ' + m.gated
        + ' 条（拒掉未覆盖的竞价值 ' + m.rejected + ' 条）｜其中缺的 ' + todo.length + ' 条');
      let mWritten = 0;
      for (let i = 0; i < todo.length; i += UPSERT_CHUNK) {
        const chunk = todo.slice(i, i + UPSERT_CHUNK).map(function (r) {
          return { date: r.date, stock: r.stock, pct: r.pct, src: r.src, updated_at: new Date().toISOString() };
        });
        await sbUpsertDaily(chunk);
        mWritten += chunk.length;
        chunk.forEach(function (r) { have.add(r.date + '|' + r.stock); });
      }
      if (mWritten > 0) console.log('   ↳ 批量写入 ' + mWritten + ' 行（这批票一个 K 线请求都不用发了）');
    } catch (e) {
      // 读不到就退回纯 K 线（§11：这一步是加速层，⛔ 不能因为它失败就整脚本退出）
      console.log('⚠️ market_metrics 批量补失败（退回纯 K 线）：' + (e && e.message || e));
    }
  }

  // ★ 逐票「最近 N 个交易日窗口是否已齐」——齐了就直接跳过，⛔ 不再为它打一次 K 线。
  //   （改造前：每只票都请求一次，再靠 added===0 判定「本来就齐」，纯属白烧上游额度。）
  const allDates = Array.from(new Set(Array.from(have).map(function (k) { return k.split('|')[0]; }))).sort();
  const windowDates = allDates.slice(-19);
  const stockDates = new Map();
  have.forEach(function (k) {
    const i = k.indexOf('|');
    const d = k.slice(0, i), s = k.slice(i + 1);
    if (!s) return;
    if (!stockDates.has(s)) stockDates.set(s, new Set());
    stockDates.get(s).add(d);
  });
  const windowFull = function (stock) {
    const s = stockDates.get(stock);
    if (!s || windowDates.length === 0) return false;
    let hit = 0;
    for (let i = 0; i < windowDates.length; i++) if (s.has(windowDates[i])) hit++;
    return hit >= windowDates.length;
  };
  const beforeSkip = pool.length;
  pool = pool.filter(function (e) { return !windowFull(e.stock); });
  console.log('窗口(' + (windowDates[0] || '—') + '~' + (windowDates[windowDates.length - 1] || '—') + '，'
    + windowDates.length + ' 天)已齐 ⇒ 跳过 ' + (beforeSkip - pool.length) + ' 只，还要补 ' + pool.length + ' 只');
  if (pool.length === 0) { console.log('全部齐了，不打上游。'); return; }

  // ③ 并发抓 K 线 → 逐日腿 → 批量 upsert
  const startMs = Date.parse(from + 'T00:00:00+08:00') - 20 * 86400000;  // 首日要一根基准 bar
  const endMs = Date.parse(today + 'T00:00:00+08:00') + 86400000;
  const buffer = [];
  let cursor = 0, ok = 0, fail = 0, written = 0, skipped = 0;
  // ★★ [R20-CIRCUIT 2026-10-30] 上游熔断：连续 8 只都拿不到 K 线 ⇒ 判定接口当前不可用，立刻收工。
  //   实测（.tmpdiag/probe-kline-upstream.cjs）：10 只里 9 只「12 秒既不返回也不断开」，
  //   45 秒超时也一样；不熔断的话 357 只 × 5 次重试 × 12 秒 ≈ 数小时空转，
  //   期间还会持续占用同一个 API key 的配额（反而拖慢用户正在用的看板）。
  //   ⚠️ 熔断只是「这一次不补」，⛔ 不写任何错误数据；下一天的 cron 会重试。
  let consecutiveFail = 0;
  let circuitOpen = false;
  const CIRCUIT_LIMIT = 8;
  const failures = [];
  let flushChain = Promise.resolve();
  const flush = function () {
    if (buffer.length === 0) return flushChain;
    const batch = buffer.splice(0, Math.min(UPSERT_CHUNK, buffer.length));
    flushChain = flushChain.then(async function () {
      await sbUpsertDaily(batch);
      written += batch.length;
      process.stdout.write('  ↳ 累计写入 ' + written + ' 行\n');
    });
    return flushChain;
  };

  const worker = async function () {
    for (;;) {
      if (circuitOpen) return;
      const i = cursor++;
      if (i >= pool.length) return;
      const t = pool[i];
      try {
        const bars = await fetchBars(t.code, startMs, endMs);
        const legs = legsFromBars(bars, today);
        let added = 0;
        legs.forEach(function (l) {
          if (have.has(l.date + '|' + t.stock)) return;
          buffer.push({
            date: l.date,
            stock: t.stock,
            pct: (l.pct < 0 ? '' : '+') + l.pct.toFixed(2),
            src: 'kline',
            updated_at: new Date().toISOString(),
          });
          added++;
        });
        ok++;
        consecutiveFail = 0;
        if (added === 0) skipped++;
        if (buffer.length >= UPSERT_CHUNK) await flush();
        if ((ok + fail) % 10 === 0) console.log('  进度 ' + (ok + fail) + '/' + pool.length + '（成功 ' + ok + ' 失败 ' + fail + '）');
      } catch (e) {
        fail++;
        consecutiveFail++;
        failures.push(t.stock + '(' + t.code + '): ' + (e && e.message || e));
        if (consecutiveFail >= CIRCUIT_LIMIT && !circuitOpen) {
          circuitOpen = true;
          console.log('\n🔴 熔断：连续 ' + CIRCUIT_LIMIT + ' 只都拿不到 K 线 ⇒ 上游当前不可用，本轮停止打上游。');
          console.log('   已写入的腿不受影响；剩余 ' + (pool.length - i - 1) + ' 只留给下次（每天 08:00 的 cron 会自动重试）。');
          return;
        }
      }
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  await flush();
  await flushChain;

  console.log('\n=== 完成 ===');
  console.log('成功 ' + ok + ' 只（其中 ' + skipped + ' 只本来就齐，0 新增）、失败 ' + fail + ' 只、写入 ' + written + ' 行'
    + (circuitOpen ? '｜⚠️ 已熔断（上游不可用），本轮未跑完' : ''));
  if (failures.length > 0) {
    console.log('失败的票（重跑本脚本会自动重试；上游挂住时多跑几次即可）：');
    failures.slice(0, 30).forEach(function (s) { console.log('  ✘ ' + s); });
  }
  console.log('\n自检：');
  console.log('  select date, count(*) from stock_daily_pct');
  console.log('   where date >= \'' + from + '\' group by date order by date;');
}

main().catch(function (e) {
  console.error('❌ ' + (e && e.stack || e));
  process.exit(1);
});
