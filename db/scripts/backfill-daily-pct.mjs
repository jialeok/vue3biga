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
//   node db/scripts/backfill-daily-pct.mjs --run           # 真跑
//   node db/scripts/backfill-daily-pct.mjs --run --days=60 # 回溯多少个自然日（默认 60）
//   node db/scripts/backfill-daily-pct.mjs --run --concurrency=2
// ══════════════════════════════════════════════════════════════════════════════════════

const SB = process.env.SUPABASE_URL || 'https://tonqfgeyxnnwicjopshn.supabase.co';
const ANON = process.env.SUPABASE_ANON_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRvbnFmZ2V5eG5ud2ljam9wc2huIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2NjY3NzEsImV4cCI6MjA5NDI0Mjc3MX0.el-W10JIjr9iQXEKNxV7nLNdhZfOQp6waTY7ZSH27Jg';

const FUYAO = SB + '/functions/v1/fuyao-proxy';
const KLINE_PATH = '/api/a-share/prices/historical';
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

const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
/** YYYY-MM-DD（北京时区；⛔ 不能用 toISOString 直接切 —— 那是 UTC，会差一天） */
function ymd(ms) { return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10); }
function todayYmd() { return ymd(Date.now()); }

async function sbGet(path) {
  const out = [];
  let from = 0;
  for (;;) {
    const r = await fetch(SB + '/rest/v1/' + path, {
      headers: Object.assign({}, H, { Range: from + '-' + (from + PAGE - 1), 'Range-Unit': 'items' }),
    });
    if (!r.ok) throw new Error('REST GET ' + path.slice(0, 80) + ' -> ' + r.status + ' ' + (await r.text()).slice(0, 200));
    const arr = await r.json();
    out.push.apply(out, arr);
    if (arr.length < PAGE) break;
    from += PAGE;
    if (from > 100000) break;
  }
  return out;
}

async function sbUpsertDaily(rows) {
  const r = await fetch(SB + '/rest/v1/stock_daily_pct?on_conflict=date,stock', {
    method: 'POST',
    headers: Object.assign({}, H, { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify(rows),
  });
  if (!r.ok) {
    const body = (await r.text()).slice(0, 300);
    if (/relation .* does not exist|42P01/i.test(body)) {
      throw new Error('stock_daily_pct 表不存在 —— 先在 Supabase SQL Editor 执行 db/create_stock_daily_pct.sql');
    }
    throw new Error('REST POST -> ' + r.status + ' ' + body);
  }
}

/** 6 位代码 → 同花顺 thscode */
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
 * 取一只票的日线（前复权），返回 [{ymd, close}] 升序。
 * 上游实测 50% 概率「既不返回也不断开」⇒ 必须超时 + 重试（⛔ 不能靠 Promise.all 硬等）。
 */
async function fetchBars(code, startMs, endMs) {
  const u = new URL(FUYAO);
  u.searchParams.set('path', KLINE_PATH);
  u.searchParams.set('thscode', thscode(code));
  u.searchParams.set('interval', '1d');
  u.searchParams.set('start', String(startMs));
  u.searchParams.set('end', String(endMs));
  u.searchParams.set('adjust', 'forward');
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) await sleep(1200 * attempt);
    const ctrl = new AbortController();
    const timer = setTimeout(function () { ctrl.abort(); }, 12000);
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

  const pool = Array.from(codeOf.entries())
    .filter(function (e) { return !!e[1]; })
    .map(function (e) { return { stock: e[0], code: e[1] }; });
  // ★ 今日名单的票排在最前：回填是逐只增量写库的，先补今天的 40 来只，
  //   看板立刻就能 0 请求出数（剩下的 300 多只是给「20日涨幅前五 / 前十」补位池用的，晚一点无所谓）。
  try {
    const rowsToday = await sbGet('auction_watchlist?select=stock&date=eq.' + today + '&limit=5000');
    const todaySet = new Set(rowsToday.map(function (r) { return String(r.stock).trim(); }));
    pool.sort(function(a, b) {
      const ia = todaySet.has(a.stock) ? 0 : 1;
      const ib = todaySet.has(b.stock) ? 0 : 1;
      return ia - ib;
    });
    console.log('今日名单优先 =', Array.from(todaySet).length, '只');
  } catch (e) { /* 读不到今日名单就按原顺序 */ }
  console.log('股票全集 =', pool.length, '只（另有 ' + (codeOf.size - pool.length) + ' 只缺代码，跳过）');
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

  // ③ 并发抓 K 线 → 逐日腿 → 批量 upsert
  const startMs = Date.parse(from + 'T00:00:00+08:00') - 20 * 86400000;  // 首日要一根基准 bar
  const endMs = Date.parse(today + 'T00:00:00+08:00') + 86400000;
  const buffer = [];
  let cursor = 0, ok = 0, fail = 0, written = 0, skipped = 0;
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
        if (added === 0) skipped++;
        if (buffer.length >= UPSERT_CHUNK) await flush();
        if ((ok + fail) % 10 === 0) console.log('  进度 ' + (ok + fail) + '/' + pool.length + '（成功 ' + ok + ' 失败 ' + fail + '）');
      } catch (e) {
        fail++;
        failures.push(t.stock + '(' + t.code + '): ' + (e && e.message || e));
      }
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  await flush();
  await flushChain;

  console.log('\n=== 完成 ===');
  console.log('成功 ' + ok + ' 只（其中 ' + skipped + ' 只本来就齐，0 新增）、失败 ' + fail + ' 只、写入 ' + written + ' 行');
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
