#!/usr/bin/env node
// backfill-range20.mjs — 把 `stock_range20_pct` 的「近 20 个交易日」补齐（可反复重跑，幂等）
//
// ══════════════════════════════════════════════════════════════════════════════════════
// 为什么需要这个脚本（2026-10-22 实测背景）
//   第二十八条「切换日新龙」要判「20 个交易日内有没有上过 20日涨幅前五」，
//   这个判定只能拿【历史每天的榜】来比 ⇒ 依赖 `stock_range20_pct` 有没有 20 天的行。
//   但该表 2026-10-12 才上线，10-22 查的时候只有 9 天有行 ⇒ `readTop5History` 的 days=8，
//   文案只能如实写「实际覆盖 8/20 天」（⛔ 绝不假装查过 20 天）。
//
// 与 Edge Function `range20-precompute` 的关系
//   · Edge Function = 「定时触发」+「一天一轮」；`?date=` 回补 20 天要跑 20 轮。
//   · 本脚本 = 同一套 compound20 算法，但**一只票只请求一次 K 线**，从同一根序列算出它
//     在窗口内每一天的 20 日涨幅 ⇒ 246 只票 20 天，请求数 ~250（Edge 要 ~5000）。
//   两条路都用同花顺 K 线（经 fuyao-proxy）⇒ **零猫抓额度**。
//
// 口径纪律（§10 读取失败 ≠ 空数据）
//   · 目标日当天没有 K 线（停牌）⇒ **不写**，⛔ 绝不补 0、绝不用前一日顶替。
//   · 只写「缺失的 (date, stock)」，已存在的行一律不动 ⇒ 重跑零漂移、可以随时再跑。
//   · 历史日一律 leg='close'（收盘口径）；竞价腿只在当天 9:25 那一刻有意义。
//
// 用法
//   node db/scripts/backfill-range20.mjs            # 干跑（只报缺几天、多少票，不打上游）
//   node db/scripts/backfill-range20.mjs --run      # 真跑
//   node db/scripts/backfill-range20.mjs --run --date=2026-10-22   # 指定展示日
//   node db/scripts/backfill-range20.mjs --run --concurrency=3     # 上游限流就调小
// ══════════════════════════════════════════════════════════════════════════════════════

const SB = process.env.SUPABASE_URL || 'https://tonqfgeyxnnwicjopshn.supabase.co';
const ANON = process.env.SUPABASE_ANON_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRvbnFmZ2V5eG5ud2ljam9wc2huIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2NjY3NzEsImV4cCI6MjA5NDI0Mjc3MX0.el-W10JIjr9iQXEKNxV7nLNdhZfOQp6waTY7ZSH27Jg';

const FUYAO = SB + '/functions/v1/fuyao-proxy';
const KLINE_PATH = '/api/a-share/prices/historical';

/** 判定窗口（与 topic-vol-ratio-rules.js#NEW_DRAGON_LOOKBACK_DAYS 同值） */
const LOOKBACK = 20;

const args = process.argv.slice(2);
const RUN = args.includes('--run');
const argOf = function (k, d) {
  const hit = args.find(function (a) { return a.indexOf('--' + k + '=') === 0; });
  return hit ? hit.slice(k.length + 3) : d;
};
const CONCURRENCY = Math.max(1, Number(argOf('concurrency', 3)) || 3);
const PAGE = 1000;
const UPSERT_CHUNK = 300;
const H = { apikey: ANON, Authorization: 'Bearer ' + ANON };
const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

/** YYYY-MM-DD（北京时区，⛔ 不用 toISOString 直接切——那是 UTC，会差一天） */
function ymd(ms) { return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10); }
function todayYmd() { return ymd(Date.now()); }

// ── Data 层：分页读（PostgREST 单次响应上限 ~1000 行，不分页会静默截断） ──────────────
async function sbGet(path) {
  const out = [];
  let from = 0;
  for (;;) {
    const r = await fetch(SB + '/rest/v1/' + path, {
      headers: Object.assign({}, H, { Range: from + '-' + (from + PAGE - 1), 'Range-Unit': 'items' }),
    });
    if (!r.ok) throw new Error('REST GET ' + path.slice(0, 60) + ' -> ' + r.status + ' ' + (await r.text()).slice(0, 200));
    const arr = await r.json();
    out.push.apply(out, arr);
    if (arr.length < PAGE) break;
    from += PAGE;
    if (from > 50000) break;   // 防御性上限
  }
  return out;
}
async function sbUpsert(rows) {
  const r = await fetch(SB + '/rest/v1/stock_range20_pct?on_conflict=date,stock', {
    method: 'POST',
    headers: Object.assign({}, H, { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error('REST POST -> ' + r.status + ' ' + (await r.text()).slice(0, 300));
}

/** 6 位代码 → 同花顺 thscode（带市场后缀） */
function thscode(t) {
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
 * 交易日历：与前端 logic/date/trading-day-helpers.js#isTradingDay 同口径
 *   weekday 且不在 trading_day_overrides(is_holiday=true) 里 ⇒ 交易日。
 *   ⚠️ 必须查云端表：localStorage 那份 worker / 脚本都看不见（9-25、10-08 两次翻车就是这么来的）。
 */
async function loadHolidaySet() {
  const rows = await sbGet('trading_day_overrides?select=date,is_holiday&is_holiday=eq.true&limit=5000');
  return new Set(rows.map(function (r) { return String(r.date); }));
}
function prevTradingDay(d, holidays) {
  const t = Date.parse(d + 'T00:00:00+08:00');
  for (let i = 1; i <= 60; i++) {
    const s = ymd(t - i * 86400000);
    // ⚠️ 必须用 Z 解析再 getUTCDay：'YYYY-MM-DDT00:00:00+08:00' 在 UTC 里是【前一天 16:00】，
    //    直接 getUTCDay() 会整体错一天（周六被当成周五）。这里把日期串当纯日历日算。
    const dow = new Date(s + 'T00:00:00Z').getUTCDay();
    if (dow !== 0 && dow !== 6 && !holidays.has(s)) return s;
  }
  return null;
}

/** 窗口 = 展示日往前推 20 个交易日（**不含展示日本身**，与 ensureTop5History 一致） */
function buildWindow(day, holidays) {
  const dates = [];
  let cur = day;
  for (let i = 0; i < LOOKBACK; i++) {
    cur = prevTradingDay(cur, holidays);
    if (!cur) break;
    dates.push(cur);
  }
  return dates.sort();
}

async function fetchBars(code, startMs, endMs) {
  const u = new URL(FUYAO);
  u.searchParams.set('path', KLINE_PATH);
  u.searchParams.set('thscode', thscode(code));
  u.searchParams.set('interval', '1d');
  u.searchParams.set('start', String(startMs));
  u.searchParams.set('end', String(endMs));
  u.searchParams.set('adjust', 'forward');
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await sleep(1500 * attempt);
    const ctrl = new AbortController();
    const timer = setTimeout(function () { ctrl.abort(); }, 20000);
    try {
      const r = await fetch(u.toString(), { headers: { Authorization: 'Bearer ' + ANON }, signal: ctrl.signal });
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
      return out;
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      if (/rate limit/i.test(msg)) { await sleep(3000 * (attempt + 1)); continue; }
      if (attempt === 3) throw e;
    } finally { clearTimeout(timer); }
  }
  return [];
}

/**
 * 与 range20.js#compound20 / Edge Function computeRange20 逐字一致的语义。
 * ⚠️ 调用前必须把序列截到 <= T：回补时序列里含 T 之后的 bar，不截会把后面的涨幅算进来。
 */
function computeAt(series, T) {
  const s = series.filter(function (b) { return b.ymd <= T; });
  if (s.length < 2) return null;
  const tIdx = s.length - 1;
  if (s[tIdx].ymd !== T) return null;              // 当天停牌/无 bar ⇒ 不写（§10 宁缺勿错）
  const prev = s[tIdx - 1].close;
  if (!(prev > 0)) return null;
  const legs = [];
  for (let i = 1; i < tIdx; i++) legs.push((s[i].close / s[i - 1].close - 1) * 100);
  const win = legs.slice(-(LOOKBACK - 1));
  win.push((s[tIdx].close / prev - 1) * 100);
  let acc = 1;
  for (const p of win) acc *= (1 + p / 100);
  return { pct: ((acc - 1) * 100).toFixed(2), days: win.length };
}

async function main() {
  const day = String(argOf('date', todayYmd()));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('--date 必须是 YYYY-MM-DD');

  const holidays = await loadHolidaySet();
  const histWin = buildWindow(day, holidays);
  // 目标日 = 历史窗口 + 展示日本身（当天的榜也要和别人同一口径，否则 everInTop5Set 基准不一致）
  const targets = histWin.concat([day]);
  console.log('展示日 =', day);
  console.log('窗口   =', targets.length, '天：' + targets[0] + ' ~ ' + targets[targets.length - 1]);

  // ① 股票全集 = 窗口内名单并集 ∪ 表里已出现过的票（保证补位票一天不漏）
  const inList = '(' + encodeURIComponent(targets.map(function (d) { return '"' + d + '"'; }).join(',')) + ')';
  const rowsWl = await sbGet('auction_watchlist?select=stock,code&date=in.' + inList + '&limit=20000');
  const rowsR20 = await sbGet('stock_range20_pct?select=date,stock&date=in.' + inList + '&limit=20000');

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

  const have = new Set(rowsR20.map(function (r) { return String(r.date) + '|' + String(r.stock).trim(); }));
  const pool = Array.from(codeOf.entries())
    .filter(function (e) { return !!e[1]; })
    .map(function (e) { return { stock: e[0], code: e[1] }; });

  // 覆盖度快照：每天缺多少
  const cnt = new Map();
  rowsR20.forEach(function (r) { cnt.set(String(r.date), (cnt.get(String(r.date)) || 0) + 1); });
  console.log('\n日期        已有行  目标票数  待补');
  let totalMissing = 0;
  targets.forEach(function (d) {
    const c = cnt.get(d) || 0;
    const miss = pool.filter(function (t) { return !have.has(d + '|' + t.stock); }).length;
    totalMissing += miss;
    console.log(d + '  ' + String(c).padStart(6) + '  ' + String(pool.length).padStart(8) + '  ' + String(miss).padStart(6));
  });
  console.log('股票全集 =', pool.length, '只；待补总行数 =', totalMissing,
    '（⛔ 含当天停牌的票——真跑时 computeAt 会返回 null 自动跳过，实际写入会少于这个数）');
  if (pool.length === 0) { console.log('没有可补的票（窗口内名单为空？）'); return; }
  if (!RUN) { console.log('\n干跑结束。加 --run 真跑。'); return; }

  // ② 并发抓 K 线（一只票一次），逐只把窗口内每天的涨幅算出来
  //    K 线起点 = 窗口首日往前 100 个自然日（够凑 19 条腿）；终点 = 展示日次日 0 点
  const startMs = Date.parse(targets[0] + 'T00:00:00+08:00') - 100 * 86400000;
  const endMs = Date.parse(day + 'T00:00:00+08:00') + 86400000;
  const buffer = [];
  let cursor = 0, done = 0, ok = 0, fail = 0, written = 0;
  const failures = [];
  let flushChain = Promise.resolve();
  const flush = function () {
    if (buffer.length === 0) return flushChain;
    const batch = buffer.splice(0, Math.min(UPSERT_CHUNK, buffer.length));
    flushChain = flushChain.then(async function () {
      await sbUpsert(batch);
      written += batch.length;
      process.stdout.write('  ↳ 已写 ' + written + ' 行\n');
    });
    return flushChain;
  };

  const worker = async function () {
    while (cursor < pool.length) {
      const t = pool[cursor++];
      try {
        const bars = await fetchBars(t.code, startMs, endMs);
        if (bars.length < 2) { fail++; failures.push(t.stock + '(无K线)'); done++; continue; }
        let n = 0;
        for (const d of targets) {
          if (have.has(d + '|' + t.stock)) continue;   // 已有 ⇒ 跳过（零漂移）
          const r = computeAt(bars, d);
          if (!r) continue;                            // 停牌/null ⇒ 不写（§10）
          buffer.push({ date: d, stock: t.stock, pct: r.pct, days: r.days, leg: 'close', updated_at: new Date().toISOString() });
          n++;
        }
        if (n > 0) ok++;
      } catch (e) {
        fail++;
        failures.push(t.stock + '(' + (e && e.message ? e.message : e) + ')');
      }
      done++;
      if (done % 20 === 0) console.log('进度 ' + done + '/' + pool.length + ' 成功' + ok + ' 失败' + fail + ' 行' + (written + buffer.length));
      if (buffer.length >= UPSERT_CHUNK) await flush();
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  await flush();
  await flushChain;

  console.log('\n=== 完成 ===');
  console.log('股票', done, '成功', ok, '失败', fail, '写入行数', written);
  if (failures.length) console.log('失败样本(前 20):', failures.slice(0, 20).join(' , '));
}

main().catch(function (e) { console.error('FATAL', (e && e.stack) || e); process.exit(1); });
