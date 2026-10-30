#!/usr/bin/env node
// backfill-range20-pct.mjs — 回填「20日涨幅」结果表 stock_range20_pct（leg='close'），可反复重跑
//
// ══════════════════════════════════════════════════════════════════════════════════════
// 为什么需要它（2026-10-30 用户「还是卡 / 切日期也卡」的根治位）
//
//   前端 `range20.js` 的【阶段⓪.5】早就写好了：结果表已覆盖全部目标票 ⇒ 只花 1 个请求直接返回，
//   连逐日腿原料表都不读。但结果表里长期只有零星几十行（且一半是 auc 口径），
//   这个出口从来没被命中过 ⇒ 每次打开都要读「45 个交易日 × 400 只 ≈ 1.8 万行」
//   （实测 16 个分页请求 / 19.0 秒），切日期再重读一遍。
//   ⇒ 本脚本把结果表按日灌满，让 ⓪.5 真正生效（§35 P1：瓶颈是请求数与往返，不是计算）。
//
// 口径必须与前端【逐字一致】（回填错值比慢更糟）：
//   · 窗口 = App 日历（weekday 且不在 trading_day_overrides 假期里）最后 45 个槽位；
//   · 每只票在窗口内取【自己】最近 20 根腿（compound20 的 R20-PERSTOCK-WIN：停牌日不占窗口位）；
//   · 复利 compoundPct = ∏(1+p/100)-1 再 ×100，落库 toFixed(2)；
//   · 缺腿（真停牌 / 次新股上市前）⇒ 该天不参与，days 如实变小，⛔ 绝不补 0（§10）。
//
// ★★ 取数策略：默认【零上游请求】，只读两张表
//     · 历史腿 = stock_daily_pct（逐日腿原料表，已是同花顺/腾讯日线换算并验证过的真值）；
//     · T 腿    = market_metrics / auction_watchlist 当天的收盘涨幅（过收盘覆盖门控）。
//   只有在「某只票在原料表里腿明显不够」时才给它单独拉一次腾讯日线（正常只有几~几十只）。
//
//   🔴 为什么不能一把梭全量拉日线（2026-10-30 实测，别再犯）：414 只票 × 2 轮 = ~830 个请求，
//     十几秒内打完，腾讯直接回 WAF 拦截页（`waf.tencent.com/501page.html`，返回 HTML 不是 JSON）
//     ⇒ 整批 414 只全失败，而且**看不出是限流**（只会看到一堆「空序列」）。
//     ⇒ 本脚本加了：候选票筛选 + 单请求间隔 + 连续失败熔断（见 QT_GAP_MS / CIRCUIT_LIMIT）。
//
// 顺带把 stock_daily_pct 的缺口补上（只写「今天之前」的腿，已有行不覆盖，幂等）。
//   实测踩到的坑：`联明股份` 在原料表里只有 4 根腿，一度被误判成「长期停牌」，
//   而腾讯日线里它 09-28~10-30 一天不缺 ⇒ **是表有缺口，不是票停牌**。
//   缺口会让 compound20 的窗口前移（静默算错），必须补。
//
// 用法
//   node db/scripts/backfill-range20-pct.mjs                  # 干跑：只报每个目标日能算出几只
//   node db/scripts/backfill-range20-pct.mjs --run            # 真跑（近 20 个交易日 + 今天）
//   node db/scripts/backfill-range20-pct.mjs --run --days=30  # 回填最近 30 个交易日
//   node db/scripts/backfill-range20-pct.mjs --run --date=2026-10-30   # 只回填某一天
//   node db/scripts/backfill-range20-pct.mjs --check          # 只对拍：复算值 vs 库内已有 close 行
// ══════════════════════════════════════════════════════════════════════════════════════

const SB = process.env.SUPABASE_URL || 'https://tonqfgeyxnnwicjopshn.supabase.co';
const ANON = process.env.SUPABASE_ANON_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRvbnFmZ2V5eG5ud2ljam9wc2huIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2NjY3NzEsImV4cCI6MjA5NDI0Mjc3MX0.el-W10JIjr9iQXEKNxV7nLNdhZfOQp6waTY7ZSH27Jg';

const PAGE = 1000;
const UPSERT_CHUNK = 500;
const H = { apikey: ANON, Authorization: 'Bearer ' + ANON };

/** 每票窗口长度（与 range20.js#RANGE20_WINDOW_DAYS 同值） */
const WIN_DAYS = 20;
/** 探针槽位数（与 range20.js#RANGE20_PROBE_DAYS 同值）——必须先多要，停牌票才凑得满自己那 20 天 */
const PROBE_DAYS = 45;
/** 腾讯单请求最小间隔（ms）：见文件头「为什么不能一把梭」 */
const QT_GAP_MS = 350;
/** 连续失败多少只就判定上游不可用（WAF / 限流）并停止再打 */
const CIRCUIT_LIMIT = 5;

const args = process.argv.slice(2);
const RUN = args.includes('--run');
const CHECK = args.includes('--check');
const argOf = function (k, d) {
  const hit = args.find(function (a) { return a.indexOf('--' + k + '=') === 0; });
  return hit ? hit.slice(k.length + 3) : d;
};
const DAYS = Math.max(1, Number(argOf('days', WIN_DAYS)) || WIN_DAYS);
const ONLY_DATE = String(argOf('date', '')).trim();
if (ONLY_DATE && !/^\d{4}-\d{2}-\d{2}$/.test(ONLY_DATE)) {
  console.error('--date 必须是 YYYY-MM-DD');
  process.exit(2);
}

const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
/** YYYY-MM-DD（北京时区；⛔ 不能用 toISOString 直接切 —— 那是 UTC，会差一天） */
function ymd(ms) { return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10); }
function todayYmd() { return ymd(Date.now()); }
/** 北京时区当前分钟数（判断「今天收盘了没有」） */
function bjMinutes() {
  const n = new Date();
  return ((n.getUTCHours() + 8) % 24) * 60 + n.getUTCMinutes();
}

// ── REST ─────────────────────────────────────────────────────────────────────────────
/** 分页读（PostgREST 单次响应上限 1000 行，不分页会静默截断；4xx 不重试，5xx/429 重试） */
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
    if (from > 200000) break;
  }
  return out;
}

/** 批量 upsert（分块由调用方给） */
async function sbUpsert(table, onConflict, rows) {
  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await sleep(800 * attempt);
    try {
      const r = await fetch(SB + '/rest/v1/' + table + '?on_conflict=' + onConflict, {
        method: 'POST',
        headers: Object.assign({}, H, {
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=minimal',
        }),
        body: JSON.stringify(rows),
      });
      if (r.ok) return;
      const body = (await r.text()).slice(0, 300);
      if (/relation .* does not exist|42P01/i.test(body)) {
        throw new Error(table + ' 表不存在 —— 先执行 db/create_' + table + '.sql');
      }
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

/** 百分比字段 → 数值（'-3.84%' / '+1.20' / -3.84 都吃；缺失 ⇒ null，⛔ 不返回 0） */
function numPct(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace('%', '').replace(/\+/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

// ── 交易日历（App 日历口径）─────────────────────────────────────────────────────────
/**
 * 与 `logic/date/trading-day-helpers.js#isTradingDay` 同口径：weekday 且不在假期表里。
 *
 * ⚠️ 必须读云端 `trading_day_overrides`：App 的 holidays 就是启动时从这张表同步下来的
 *   （`data/trading-day-overrides.js`），本地/硬编码一律不准（9-25、10-08 两次翻车）。
 * ⚠️ 假期表【不完整】是已知现状，所以窗口要多要 25 个槽位（PROBE_DAYS=45），
 *   靠「每票自己取最近 20 根有腿日」把假交易日的影响吃掉（同前端 R20-PERSTOCK-WIN）。
 */
async function loadHolidaySet() {
  const rows = await sbGet('trading_day_overrides?select=date&is_holiday=eq.true&limit=5000');
  return new Set(rows.map(function (r) { return String(r.date); }));
}

/** 从 to 往前数 n 个 App 交易日，返回【升序】数组（最后一个 = to） */
function calendarBack(to, n, holidays) {
  const out = [];
  let cur = to;
  for (let guard = 0; guard < n * 4 + 60 && out.length < n; guard++) {
    const dow = new Date(cur + 'T00:00:00Z').getUTCDay();
    if (dow !== 0 && dow !== 6 && !holidays.has(cur)) out.push(cur);
    cur = ymd(Date.parse(cur + 'T00:00:00Z') - 86400000);
  }
  out.reverse();
  return out;
}

// ── 腾讯前复权日线（只给「腿不够」的票用）──────────────────────────────────────────
/**
 * 接口：https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=<sym>,day,<from>,<to>,320,qfq
 *   sym = sh/sz/bj + 6 位代码；返回 data[sym].qfqday = [[日期, 开, 收, 高, 低, 量, ...], ...]
 * ⚠️ 与同花顺同为【前复权】口径（已用库里 524 条 src='kline' 真值逐条验证，100% 一致）。
 * 🔴 请求过密会被 WAF 挡：返回的是 HTML 拦截页（不是 JSON）⇒ 必须显式识别，
 *   否则只会看到 `SyntaxError: Unexpected token '<'` 被当成「空序列」，误判成「停牌」。
 */
let _qtBlocked = false;
let _qtConsecFail = 0;

async function fetchBarsQt(code, startYmd, endYmd, gapRef) {
  const c = String(code || '').trim();
  if (!/^\d{6}$/.test(c)) throw new Error('代码不合法: ' + code);
  if (_qtBlocked) throw new Error('腾讯通道本轮已熔断（WAF/限流）');
  const sym = (/^(6|9)/.test(c) ? 'sh' : (/^(4|8|92)/.test(c) ? 'bj' : 'sz')) + c;
  const u = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param='
    + sym + ',day,' + startYmd + ',' + endYmd + ',320,qfq';
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(1200 * attempt);
    // 节流：所有请求串在同一个时间线上（gapRef.next 是全局下一次可发时刻）
    const wait = Math.max(0, (gapRef.next || 0) - Date.now());
    if (wait > 0) await sleep(wait);
    gapRef.next = Date.now() + QT_GAP_MS;
    const ctrl = new AbortController();
    const timer = setTimeout(function () { ctrl.abort(); }, 8000);
    try {
      const r = await fetch(u, {
        headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://gu.qq.com/' },
        signal: ctrl.signal,
      });
      const text = await r.text();
      if (text.charAt(0) === '<' || text.indexOf('waf.tencent.com') >= 0) {
        _qtBlocked = true;
        throw new Error('腾讯 WAF 拦截（请求过密，等一会儿再跑）');
      }
      if (!r.ok) throw new Error('qt HTTP ' + r.status);
      const j = JSON.parse(text);
      const d = (j && j.data && j.data[sym]) || {};
      const rows = d.qfqday || d.day || [];
      const out = [];
      rows.forEach(function (b) {
        const dt = String((b && b[0]) || '').slice(0, 10);
        const close = Number(b && b[2]);
        if (!dt || !Number.isFinite(close) || close <= 0) return;
        out.push({ ymd: dt, close: close });
      });
      out.sort(function (a, b2) { return a.ymd < b2.ymd ? -1 : (a.ymd > b2.ymd ? 1 : 0); });
      // 空序列 = 这段时间没有 bar（停牌 / 退市 / 北交所不支持）⇒ 上层判定，⛔ 不写 0%
      if (out.length === 0) throw new Error('qt 空序列');
      _qtConsecFail = 0;
      return out;
    } catch (e) {
      lastErr = e;
      if (/代码不合法|WAF/.test(String(e && e.message))) throw e;
    } finally { clearTimeout(timer); }
  }
  _qtConsecFail++;
  if (_qtConsecFail >= CIRCUIT_LIMIT) {
    _qtBlocked = true;
    console.log('🔴 连续 ' + CIRCUIT_LIMIT + ' 只拿不到日线 ⇒ 判定腾讯通道不可用（WAF/限流），本轮停止再打上游。');
  }
  throw lastErr || new Error('qt 取数失败（已重试 3 次）');
}

/**
 * 新浪日线（腾讯被 WAF 挡时的备用通道）。
 *
 *   接口：money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData
 *         ?symbol=sh603006&scale=240&ma=no&datalen=120
 *   实测（2026-10-30 晚）：200，返回 [{day,open,high,low,close,volume}]。
 *   校验：联明股份 10-29→10-30 用新浪收盘算 = -9.99%，与 market_metrics 的收盘涨幅逐位一致。
 *
 * ⚠️ 新浪是【不复权】价：只有在窗口内没有除权除息时，相邻两日比值才等于真实涨跌幅。
 *   所以它只做兜底（腾讯全挂时），且只用于「原料表腿不够」的那几只票 —— 数量小、可人工复核。
 */
async function fetchBarsSina(code, datalen) {
  const c = String(code || '').trim();
  if (!/^\d{6}$/.test(c)) throw new Error('代码不合法: ' + code);
  const sym = (/^(6|9)/.test(c) ? 'sh' : (/^(4|8|92)/.test(c) ? 'bj' : 'sz')) + c;
  const u = 'https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData'
    + '?symbol=' + sym + '&scale=240&ma=no&datalen=' + (datalen || 120);
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, 8000);
  try {
    const r = await fetch(u, {
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://finance.sina.com.cn/' },
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error('sina HTTP ' + r.status);
    const arr = await r.json();
    const out = [];
    (arr || []).forEach(function (b) {
      const dt = String((b && b.day) || '').slice(0, 10);
      const close = Number(b && b.close);
      if (!dt || !Number.isFinite(close) || close <= 0) return;
      out.push({ ymd: dt, close: close });
    });
    out.sort(function (a, b2) { return a.ymd < b2.ymd ? -1 : (a.ymd > b2.ymd ? 1 : 0); });
    if (out.length === 0) throw new Error('sina 空序列');
    return out;
  } finally { clearTimeout(timer); }
}

/** 日线 → 逐日涨幅腿 Map<YYYY-MM-DD, pct>（全精度，相邻收盘之比） */
function legsFromBars(bars) {
  const m = new Map();
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1].close;
    const cur = bars[i].close;
    if (!(prev > 0) || !(cur > 0)) continue;
    const p = (cur / prev - 1) * 100;
    if (!Number.isFinite(p)) continue;
    m.set(bars[i].ymd, p);
  }
  return m;
}

// ── 主流程 ───────────────────────────────────────────────────────────────────────────
async function main() {
  const today = todayYmd();
  const holidays = await loadHolidaySet();
  const cal = calendarBack(today, DAYS + PROBE_DAYS + 20, holidays);
  const todayIdx = cal.indexOf(today);
  if (todayIdx < 0) throw new Error('日历里找不到今天 ' + today + '（假期表把今天标成假期了？）');

  let targetsDates = cal.slice(Math.max(0, todayIdx - DAYS + 1), todayIdx + 1);
  if (ONLY_DATE) targetsDates = [ONLY_DATE];
  const mm0 = bjMinutes();
  console.log('今天 =', today, '｜北京时刻 =', Math.floor(mm0 / 60) + ':' + String(mm0 % 60).padStart(2, '0'));
  console.log('目标日 =', targetsDates[0], '~', targetsDates[targetsDates.length - 1], '（' + targetsDates.length + ' 天）');

  // ⚠️ 今天还没收盘 ⇒ 日线最后一根是现价，⛔ 不能当成「今天收盘腿」写进结果表
  //   （写进去 = 把盘中价固化成收盘口径，还会覆盖 9:25 预计算写的 auc 行，第二天早上全歪）。
  const closedYet = (today !== targetsDates[targetsDates.length - 1]) || mm0 >= 15 * 60 + 30;
  if (!closedYet) {
    targetsDates = targetsDates.filter(function (d) { return d < today; });
    console.log('⚠️ 今天还没收盘（北京 ' + Math.floor(mm0 / 60) + ':' + String(mm0 % 60).padStart(2, '0')
      + ' < 15:30）⇒ 本次不写今天，只补历史日');
  }
  if (targetsDates.length === 0) { console.log('没有要补的日期'); return; }

  const inList = encodeURIComponent('(' + targetsDates.map(function (d) { return '"' + d + '"'; }).join(',') + ')');

  // ① T 腿来源：market_metrics（收盘覆盖门控）+ auction_watchlist
  const mm = await sbGet('market_metrics?select=stock,date,change_pct,auc_pct_chg,code&date=in.' + inList + '&limit=50000');
  const wl = await sbGet('auction_watchlist?select=stock,date,change_pct,code&date=in.' + inList + '&limit=50000');
  console.log('market_metrics 行 =', mm.length, '｜名单行 =', wl.length);

  /** date -> Map<stock, {c:number, gate:boolean}> */
  const tLegs = new Map();
  targetsDates.forEach(function (d) { tLegs.set(d, new Map()); });
  let gated = 0, ungated = 0;
  mm.forEach(function (r) {
    const d = String(r.date || '');
    const s = String(r.stock || '').trim();
    const map = tLegs.get(d);
    if (!map || !s) return;
    const c = numPct(r.change_pct);
    if (c === null) return;
    const a = numPct(r.auc_pct_chg);
    // 门控：change_pct 与 auc_pct_chg 不同 ⇒ 收盘覆盖流程确实写过它（详见 backfill-daily-pct.mjs）
    const g = (a === null || Math.abs(c - a) >= 0.011);
    if (g) gated++; else ungated++;
    map.set(s, { c: c, gate: g });
  });
  wl.forEach(function (r) {
    const d = String(r.date || '');
    const s = String(r.stock || '').trim();
    const map = tLegs.get(d);
    if (!map || !s || map.has(s)) return;
    const c = numPct(r.change_pct);
    if (c === null) return;
    map.set(s, { c: c, gate: true });
  });
  console.log('T 腿候选：门控通过', gated, '条 / 未覆盖（只作兜底）', ungated, '条');

  // ② 历史腿：逐日腿原料表（区间 = 最早目标日的探针首日 ~ 最新目标日）
  const spanFrom = calendarBack(targetsDates[0], PROBE_DAYS + 10, holidays)[0];
  const lastDate = targetsDates[targetsDates.length - 1];
  const dailyRows = await sbGet('stock_daily_pct?select=date,stock,pct&date=gte.' + spanFrom
    + '&date=lte.' + lastDate + '&limit=200000');
  const dailyLegs = new Map();
  dailyRows.forEach(function (r) {
    const s = String(r.stock || '').trim();
    const d = String(r.date || '');
    const v = numPct(r.pct);
    if (!s || !d || v === null) return;
    if (!dailyLegs.has(s)) dailyLegs.set(s, new Map());
    dailyLegs.get(s).set(d, v);
  });
  console.log('逐日腿表：', spanFrom, '~', lastDate, '共', dailyRows.length, '行 /', dailyLegs.size, '只票');

  // ③ 结果表现状（既用来对拍，也用来圈定「看板可能会出现」的票）
  const exist = await sbGet('stock_range20_pct?select=date,stock,pct,days,leg&date=in.' + inList + '&limit=50000');
  const existClose = exist.filter(function (r) { return r.leg === 'close'; });
  const existAll = new Map();      // date|stock -> row（任意口径）
  exist.forEach(function (r) { existAll.set(String(r.date) + '|' + String(r.stock).trim(), r); });
  console.log('结果表现有行 =', exist.length, '（close', existClose.length, '/ auc', exist.length - existClose.length, '）');

  // ④ 股票全集 = T 腿名单 ∪ 原料表 ∪ 结果表里出现过的票
  const codeOf = new Map();
  mm.forEach(function (r) {
    const s = String(r.stock || '').trim();
    const c = String(r.code || '').trim();
    if (s && /^\d{6}$/.test(c) && !codeOf.has(s)) codeOf.set(s, c);
  });
  wl.forEach(function (r) {
    const s = String(r.stock || '').trim();
    const c = String(r.code || '').trim();
    if (s && /^\d{6}$/.test(c) && !codeOf.has(s)) codeOf.set(s, c);
  });
  const poolSet = new Set();
  const inScope = new Set();
  tLegs.forEach(function (map) { map.forEach(function (_, s) { poolSet.add(s); inScope.add(s); }); });
  exist.forEach(function (r) { const s = String(r.stock || '').trim(); if (s) { poolSet.add(s); inScope.add(s); } });
  dailyLegs.forEach(function (_, s) { poolSet.add(s); });

  // 缺代码的补一次（stockcodemap → market_metrics.code）
  let noCode = Array.from(poolSet).filter(function (s) { return !codeOf.has(s); });
  if (noCode.length > 0) {
    for (let i = 0; i < noCode.length; i += 100) {
      const chunk = noCode.slice(i, i + 100);
      const list = '(' + chunk.map(function (n) { return '"' + n.replace(/"/g, '').replace(/[()]/g, '') + '"'; }).join(',') + ')';
      try {
        const cm = await sbGet('stockcodemap?select=stock,code&stock=in.' + encodeURIComponent(list));
        cm.forEach(function (r) {
          const s = String(r.stock || '').trim();
          const c = String(r.code || '').trim();
          if (s && /^\d{6}$/.test(c) && !codeOf.has(s)) codeOf.set(s, c);
        });
      } catch (e) { /* 补不到就算了，下面统计 */ }
    }
    noCode = Array.from(poolSet).filter(function (s) { return !codeOf.has(s); });
    for (let i = 0; i < noCode.length; i += 100) {
      const chunk = noCode.slice(i, i + 100);
      const list = '(' + chunk.map(function (n) { return '"' + n.replace(/"/g, '').replace(/[()]/g, '') + '"'; }).join(',') + ')';
      try {
        const rows = await sbGet('market_metrics?select=stock,code&stock=in.' + encodeURIComponent(list) + '&limit=50000');
        rows.forEach(function (r) {
          const s = String(r.stock || '').trim();
          const c = String(r.code || '').trim();
          if (s && /^\d{6}$/.test(c) && !codeOf.has(s)) codeOf.set(s, c);
        });
      } catch (e) { /* 同上 */ }
    }
  }
  console.log('股票全集 =', poolSet.size, '只（缺代码', Array.from(poolSet).filter(function (s) { return !codeOf.get(s); }).length, '只）');

  // ⑤ 定向补日线的候选：在「看板可能出现」的范围内、且原料表腿数明显不够的票
  //    ⚠️ 只在 inScope（名单 / 结果表里的票）里挑，⛔ 不要 414 只全拉（会被 WAF 挡，见文件头）
  const qtCodes = new Map();     // stock -> code
  inScope.forEach(function (s) {
    const m = dailyLegs.get(s);
    const n = m ? m.size : 0;
    if (n >= WIN_DAYS) return;                  // 腿够 ⇒ 不需要日线
    const c = codeOf.get(s);
    if (c) qtCodes.set(s, c);
  });
  console.log('需要补日线的票 =', qtCodes.size, '只（原料表腿数 < ' + WIN_DAYS + '）');
  const barsOf = new Map();      // stock -> Map(date -> pct)（全精度）
  const srcOf = new Map();       // stock -> 'qt' | 'sina'（落库来源列，sina 需人工复核）
  if (qtCodes.size > 0) {
    const gapRef = { next: 0 };
    const list = Array.from(qtCodes.entries());
    const sinaStocks = [];
    let i = 0, ok = 0, failed = 0;
    const failures = [];
    const worker = async function () {
      for (;;) {
        const k = i++;
        if (k >= list.length) return;
        const s = list[k][0], c = list[k][1];
        try {
          // 腾讯优先；被 WAF 挡 / 取不到时退新浪（见 fetchBarsSina 的口径说明）
          let bars, src = 'qt';
          try {
            bars = await fetchBarsQt(c, spanFrom, today, gapRef);
          } catch (e1) {
            bars = await fetchBarsSina(c, 160);
            src = 'sina';
          }
          barsOf.set(s, legsFromBars(bars));
          srcOf.set(s, src);
          if (src === 'sina') sinaStocks.push(s);
          ok++;
        } catch (e) {
          failed++;
          if (failures.length < 10) failures.push(s + '(' + c + '): ' + (e && e.message || e));
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    console.log('定向补日线：成功', ok, '失败', failed);
    failures.forEach(function (s) { console.log('  ✘ ' + s); });
    if (sinaStocks.length > 0) {
      // ⚠️ 新浪是不复权价：窗口内若正好有除权除息，那一天算出来的涨幅会偏大（其余日子不受影响）。
      //   ⇒ 落库标 src='sina' 留痕；下次腾讯通道恢复后重跑本脚本，会把这条腿换成前复权的真值。
      console.log('  ⚠️ 以下', sinaStocks.length, '只用新浪（不复权）兜底，除权日那根腿需复核：'
        + sinaStocks.join('、'));
    }
  }

  // ⑥ 每只票的完整腿集合：原料表打底，日线覆盖（全精度）
  const fullLegs = new Map();
  const allStocks = new Set(poolSet);
  barsOf.forEach(function (_, s) { allStocks.add(s); });
  allStocks.forEach(function (s) {
    const m = new Map();
    const a = dailyLegs.get(s);
    if (a) a.forEach(function (v, d) { m.set(d, v); });
    const b = barsOf.get(s);
    if (b) b.forEach(function (v, d) { m.set(d, v); });
    if (m.size > 0) fullLegs.set(s, m);
  });

  /**
   * 某只票在展示日 T 的「T 腿」（收盘口径）。
   * 优先级：日线(T) → 门控 metrics → 原料表自己的 T 行 → 未门控 metrics → 名单。
   *   · 日线最准（全精度），只有「腿不够的候选票」才有；
   *   · 门控 metrics = 收盘覆盖流程写进去的当日收盘涨幅（与前端 resolveT20Leg 同源）；
   *   · 原料表的 T 行：历史日它本来就是当日收盘涨幅（今天那根永远不写，见 backfill-daily-pct.mjs）。
   * ⛔ 全都没有 ⇒ null，这只票当天【不写行】（否则就是把「截至昨天」的窗口冒充今天，§10）。
   */
  function resolveTLeg(s, d) {
    const b = barsOf.get(s);
    if (b && b.has(d)) return { v: b.get(d), src: srcOf.get(s) || 'qt' };
    const row = (tLegs.get(d) || new Map()).get(s);
    if (row && row.gate) return { v: row.c, src: 'metrics' };
    const dm = dailyLegs.get(s);
    if (dm && dm.has(d)) return { v: dm.get(d), src: 'daily' };
    if (row) return { v: row.c, src: 'metrics-raw' };
    return { v: null, src: 'none' };
  }

  /** 与 range20.js#compound20 逐字一致：从最近一天往前挑，凑满 20 根该票自己的腿即止 */
  function compoundAt(s, probe, tDate) {
    const legs = fullLegs.get(s);
    if (!legs) return null;
    const tl = resolveTLeg(s, tDate);
    if (tl.v === null) return null;
    const merged = new Map(legs);
    merged.set(tDate, tl.v);
    const list = [];
    for (let i = probe.length - 1; i >= 0 && list.length < WIN_DAYS; i--) {
      const d = probe[i];
      if (!merged.has(d)) continue;
      const v = merged.get(d);
      if (v === null || v === undefined || isNaN(v)) continue;
      list.push(v);
    }
    if (list.length === 0) return null;
    list.reverse();
    let acc = 1;
    for (let i = 0; i < list.length; i++) acc *= (1 + list[i] / 100);
    const pct = (acc - 1) * 100;
    if (!Number.isFinite(pct)) return null;
    return { pct: pct, days: list.length, tSrc: tl.src };
  }

  // ⑦ 逐日算（目标 = 「看板可能出现」且当天能定出 T 腿的票）
  const outRows = [];
  const dailyFill = [];
  const perDate = [];
  const srcCnt = { qt: 0, metrics: 0, daily: 0, 'metrics-raw': 0, none: 0 };
  targetsDates.forEach(function (d) {
    const idx = cal.indexOf(d);
    if (idx < 0) { perDate.push({ date: d, n: 0, full: 0, short: 0, none: 0, note: '不在日历里' }); return; }
    const probe = cal.slice(Math.max(0, idx - PROBE_DAYS + 1), idx + 1);
    let n = 0, full = 0, short = 0, none = 0;
    // 目标 = 当天名单/行情里的票 ∪ 结果表里当天已有的票（后者是「看板确实显示过它」的证据）。
    //   ⛔ 不要把 inScope 整个铺进去：那会给一批从没上过榜的票写行，表膨胀且 truth 无从校验。
    //   ⛔ 定不出 T 腿的票不写：那等于把「截至昨天」的窗口冒充成今天（§10）。
    const candidates = new Set();
    (tLegs.get(d) || new Map()).forEach(function (_, s) { candidates.add(s); });
    exist.forEach(function (r) {
      if (String(r.date) === d) {
        const s = String(r.stock || '').trim();
        if (s) candidates.add(s);
      }
    });
    // ★★ [R20-POOL 2026-10-30] 历史日按【全池】写，不只写当天名单。
    //   为什么（前端 range20-leaders 的请求数直接取决于它）：
    //     「20日涨幅前五/前十（总龙）」的候选池 = 近 20 日正式名单并集 ≈ 400 只，
    //     结果表只覆盖几十只时，它仍要把剩下 ~350 只的逐日腿从原料表读回来（5~16 个请求）。
    //     写满全池后它只需读「云端没覆盖的那几十只」⇒ 1~2 个请求。
    //   ⛔ 今天（== today）不按全池写：今天很多票没有收盘腿（不在名单里就没有当天行），
    //     写了就是「截至昨天」的窗口冒充今天（§10）。今天的覆盖靠 9:25 预计算写 auc 行。
    if (d < today) allStocks.forEach(function (s) { if (fullLegs.has(s)) candidates.add(s); });
    candidates.forEach(function (s) {
      const r = compoundAt(s, probe, d);
      if (!r) { none++; srcCnt.none++; return; }
      srcCnt[r.tSrc]++;
      outRows.push({
        date: d,
        stock: s,
        pct: r.pct.toFixed(2),
        days: r.days,
        leg: 'close',
        updated_at: new Date().toISOString(),
      });
      n++;
      if (r.days >= WIN_DAYS) full++; else short++;
    });
    perDate.push({ date: d, n: n, full: full, short: short, none: none });
  });

  // ⑦.5 原料表缺口补齐：把「这些票在这些天」的腿写进去（已有的一律不动，幂等）。
  //   ⛔ 只写【今天之前】：今天那根日线在盘中是现价，写进原料表会被明天当成"今天的收盘腿"用，
  //     静默算错（同 data/stock-daily-pct.js 与 backfill-daily-pct.mjs 的纪律）。
  //   ⛔ 没拉过日线的票不补（宁可少补，⛔ 不拿 metrics 的 0.00% 顶替 —— 停牌日会被当成平盘腿占窗口）。
  barsOf.forEach(function (days, s) {
    const have = dailyLegs.get(s);
    days.forEach(function (v, d) {
      if (d >= today || d < spanFrom) return;
      if (have && have.has(d)) return;
      dailyFill.push({
        date: d,
        stock: s,
        pct: (v < 0 ? '' : '+') + v.toFixed(2),
        src: srcOf.get(s) || 'qt',
        updated_at: new Date().toISOString(),
      });
    });
  });

  console.log('\n日期        写入行  满窗(20)  短窗  无T腿(跳过)  名单');
  perDate.forEach(function (x) {
    const wlCnt = (tLegs.get(x.date) || new Map()).size;
    console.log(x.date + '  ' + String(x.n).padStart(6) + '  ' + String(x.full).padStart(8) + '  '
      + String(x.short).padStart(4) + '  ' + String(x.none).padStart(10) + '  ' + String(wlCnt).padStart(5)
      + (x.note ? ('  ' + x.note) : ''));
  });
  console.log('T 腿来源分布：日线', srcCnt.qt, '｜门控 metrics', srcCnt.metrics,
    '｜原料表', srcCnt.daily, '｜未门控 metrics', srcCnt['metrics-raw']);
  console.log('结果表待写 =', outRows.length, '行；原料表待补缺口 =', dailyFill.length, '行');

  // ⑧ 对拍：与库里已有 close 行逐条比
  const byKey = new Map();
  outRows.forEach(function (r) { byKey.set(r.date + '|' + r.stock, r); });
  let same = 0, diff = 0, notCalc = 0;
  const diffs = [];
  let maxAbs = 0;
  existClose.forEach(function (r) {
    const key = String(r.date) + '|' + String(r.stock).trim();
    const mine = byKey.get(key);
    if (!mine) { notCalc++; return; }
    const dd = Math.abs(Number(r.pct) - Number(mine.pct));
    if (dd > maxAbs) maxAbs = dd;
    if (dd <= 0.06 && Number(r.days) === Number(mine.days)) same++;
    else {
      diff++;
      diffs.push({ s: key + ' 库内 ' + r.pct + '(d' + r.days + ') / 复算 ' + mine.pct + '(d' + mine.days + ')', d: dd });
    }
  });
  // 差异按绝对值从大到小排：≤0.06 的是「2 位小数复利 vs 全精度复利」的正常舍入差，
  // 真正要盯的是 >0.2 的（那才是「库内行是缺腿时算出来的陈旧值」，必须覆盖）。
  diffs.sort(function (a, b) { return b.d - a.d; });
  console.log('\n对拍（库内已有 close 行 ' + existClose.length + ' 条）：一致 ' + same
    + '｜不一致 ' + diff + '｜未复算 ' + notCalc + '｜最大偏差 ' + maxAbs.toFixed(3));
  diffs.slice(0, 12).forEach(function (x) { console.log('  ✘ ' + x.s); });
  if (!RUN || CHECK) {
    console.log('\n' + (CHECK ? '--check 模式' : '干跑') + '：未写库。加 --run 真跑。');
    return;
  }

  // ⑨ 写库
  //
  // 🔴 写入策略（别改成「无脑全覆盖」）：结果表里已有的 close 行是【真实前端算出来的】，
  //   那批值来自同花顺/腾讯日线的**全精度**腿；而本脚本的腿来自 `stock_daily_pct`（2 位小数），
  //   复利 20 次会累积 ~0.02~0.05 的舍入差（实测 4045 条里 1131 条有这个量级的差，无一超过 0.06）。
  //   两者都「对」，但前者更精确 ⇒ 只要库内那行【腿比本脚本更全或一样全】且数值差在容差内，
  //   就保留原值，⛔ 不要用略粗的值把它盖掉。
  //   真正该覆盖的只有两种：
  //     ① 口径不对（行是 leg='auc'）——收盘口径下它不该被命中；
  //     ② 陈旧（腿比现在少 / 数值差 > 0.2）——那是缺腿时算出来的，会误导对账。
  const toWrite = [];
  let keptCnt = 0, fixLegCnt = 0, fixStaleCnt = 0;
  outRows.forEach(function (r) {
    const ex = existAll.get(r.date + '|' + r.stock);
    if (!ex) { toWrite.push(r); return; }
    if (ex.leg !== 'close') { toWrite.push(r); fixLegCnt++; return; }
    const dd = Math.abs(Number(ex.pct) - Number(r.pct));
    const exDays = Number(ex.days) || 0;
    if (exDays >= r.days && dd <= 0.2) { keptCnt++; return; }
    toWrite.push(r);
    fixStaleCnt++;
  });
  console.log('\n写入计划：新增 ' + (toWrite.length - fixLegCnt - fixStaleCnt)
    + ' 行｜覆盖 auc 行 ' + fixLegCnt + ' 行｜修正陈旧行 ' + fixStaleCnt
    + ' 行｜保留库里更精确的值 ' + keptCnt + ' 行');

  let w1 = 0;
  for (let i = 0; i < dailyFill.length; i += UPSERT_CHUNK) {
    const chunk = dailyFill.slice(i, i + UPSERT_CHUNK);
    await sbUpsert('stock_daily_pct', 'date,stock', chunk);
    w1 += chunk.length;
    console.log('  ↳ stock_daily_pct 已写 ' + w1 + '/' + dailyFill.length);
  }
  let w2 = 0;
  for (let i = 0; i < toWrite.length; i += UPSERT_CHUNK) {
    const chunk = toWrite.slice(i, i + UPSERT_CHUNK);
    await sbUpsert('stock_range20_pct', 'date,stock', chunk);
    w2 += chunk.length;
    console.log('  ↳ stock_range20_pct 已写 ' + w2 + '/' + toWrite.length);
  }
  console.log('\n=== 完成 ===');
  console.log('stock_daily_pct 补缺口 ' + w1 + ' 行｜stock_range20_pct 写入 ' + w2 + ' 行（leg=close）');
  console.log('\n自检：');
  console.log('  select date, leg, count(*) from stock_range20_pct where date >= \'' + targetsDates[0]
    + '\' group by date, leg order by date, leg;');
}

main().catch(function (e) {
  console.error('❌ ' + (e && e.stack || e));
  process.exit(1);
});
