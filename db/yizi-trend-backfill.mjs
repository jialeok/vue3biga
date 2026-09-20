// yizi-trend-backfill.mjs — 「竞价一字」【趋势 / 十日涨幅】历史回填驱动
//
// 配套文件：
//   db/create_yizi_trend.sql                     建表（yizi_trend）
//   db/yizi-backfill.mjs                         另半个：回填【一字池】auction_yizi（本脚本不碰它）
//   supabase/functions/auction-yizi-fetch/index.ts  /trend 路由（本脚本调它）
//
// 为什么还要有第二个脚本：
//   用户的两个症状分别落在两张表上，二者必须【分开补、且有先后】：
//     ·「切到历史日期一片空白 / 只数不对」  → auction_yizi（一字池快照）→ 用 db/yizi-backfill.mjs
//     ·「趋势图很多断点 / 十日涨幅不全」    → yizi_trend（四条腿缓存）→ 用【本脚本】
//   ⛔ 顺序不能倒：/trend 没传 stocks 时会自己去读 auction_yizi(date) 当池子，
//      那天池子还是空的 ⇒ 直接回 skipped='no-pool'，白跑一趟（不烧额度，但白等一个冷却）。
//
// 为什么一个 /trend 能补一大片（额度的关键）：
//   /trend?date=T&window=10 是「一次请求覆盖【整个窗口】」—— 抓的是
//   [T-9, T] 共 10 个交易日 × 当日池内全部股票，所以补齐某一天 = 顺带把前面 9 天也铺上。
//   ⚠️ 一次 /trend 最多打【两条腿】= 最多 2 次上游请求（daily_auc 竞价腿 + daily K线腿）。
//
// 四条铁律（与 db/yizi-backfill.mjs 逐字一致，⛔ 别放松任何一条）：
//   ① 默认【演练】= 0 请求，只打印计划；加 --run 才真的抓。
//   ② 间隔 ≥ 90s：Edge 侧有 COOLDOWN_MS=90s 冷却闸门，连发只会被闸门挡回（白等）。
//   ③ 止损：遇到「额度」/ 403 / RATE_LIMIT / quotaExhausted 立即停止后续请求，不 continue 白烧额度。
//   ④ 【缺口驱动】优先：/trend 自己会先读库判缺口，已齐就直接回 skipped='cache-complete'（0 上游请求）
//      ⇒ 重复跑同一批日期【不重复消耗额度】，明天接着跑即可续补。
//
// 【锚点跳跃】为什么必须跳、不能一天一天挨着试（2026-09-20 修正）：
//   一次 /trend?date=T&window=10 覆盖的是 [T-9, T] 共 10 个交易日，
//   所以下一个「还有新东西可补」的锚点必然是 T-10，而不是 T-1。
//   ⛔ 挨着试的后果：第 2 次调用落在上次的窗口里 ⇒ 回 cache-complete（0 收益、白等一个 95s 冷却），
//      30 个交易日里永远只能铺到【最新那 10 天】，更早的 20 天永远补不上 —— 正是「趋势图断点」的残留。
//   ✅ 于是：本次调用【真的补到 / 已齐】⇒ 索引直接 += WINDOW；该日【没有池子】⇒ 只 += 1（继续找有池的锚点）。
//
// 额度：猫抓免费档 10 次/天（北京 0 点重置），其中：
//   · 每日 09:25 自动抓取固定占 1 次（最高优先级，谁也不许抢）；
//   · Edge 的 /trend 另有【本日 6 次上游请求】预算闸门（budget.usedRequests / budget.cap 可见）；
//   · 09:20~09:30 保护窗口内一律不发上游请求。
//   ⇒ 本脚本默认只跑 --max=3（≈ 6 次上游请求 = 恰好用满趋势预算），留额度给池子回填。
//
// 用法（本机直连不通，必须带代理）：
//   node db/yizi-trend-backfill.mjs                                  # 演练
//   HTTPS_PROXY=http://127.0.0.1:7897 NODE_USE_ENV_PROXY=1 \
//     node db/yizi-trend-backfill.mjs --run --days=45 --window=10 --max=3
//
// ⚠️ 本脚本【不持任何 apikey】：SUPABASE_URL / ANON_KEY 运行时从 src/data/supabase-client.js 读取
//    （单一真相，避免把密钥再抄一份到 db/ 里）。/trend 路由本就不校验 token，anon 即可。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ---- 参数 ----
const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const num = (k, d) => {
  const a = argv.find((x) => x.startsWith(k + '='));
  const v = Number(a ? a.split('=')[1] : NaN);
  return isFinite(v) ? v : d;
};
const RUN = has('--run');
const DAYS = num('--days', 45);        // 回看自然日数（30 个交易日 ≈ 42~45 自然日）
const WINDOW = num('--window', 10);    // 趋势窗口（= 十日涨幅的存储窗口，最大 15）
const MAX = num('--max', 3);           // 本次最多【真正抓取】几天
const GAP = num('--gap', 95);          // 间隔秒（必须 > Edge 的 90s 冷却）

// ---- 从前端单一真相里取 URL / ANON（不抄密钥）----
const clientSrc = readFileSync(join(ROOT, 'src/data/supabase-client.js'), 'utf8');
const pick = (name) => {
  const m = clientSrc.match(new RegExp(name + "\\s*=\\s*'([^']+)'"));
  return m ? m[1] : '';
};
const SUPABASE_URL = pick('SUPABASE_URL');
const ANON_KEY = pick('SUPABASE_ANON_KEY');
if (!SUPABASE_URL || !ANON_KEY) {
  console.error('❌ 未能从 src/data/supabase-client.js 解析出 SUPABASE_URL / SUPABASE_ANON_KEY');
  process.exit(1);
}
const TREND_URL = SUPABASE_URL + '/functions/v1/auction-yizi-fetch/trend';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');
const beijingToday = () => {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
};
/** 回看 DAYS 个自然日里的【工作日】（粗筛：真 holiday 由 Edge 自己判，回 no-pool 时跳过即可） */
function candidateDates() {
  const out = [];
  const end = new Date(beijingToday() + 'T00:00:00Z');
  for (let i = 0; i < DAYS; i++) {
    const d = new Date(end.getTime() - i * 86400000);
    const wd = d.getUTCDay();
    if (wd === 0 || wd === 6) continue;
    out.push(d.toISOString().slice(0, 10));
  }
  return out; // 由近到远
}

/** 是否在「今天之内」——今天的一字池要等 9:25 抓取，历史回填不该掺和 */
function isToday(d) {
  return d === beijingToday();
}

async function callTrend(date) {
  const url = new URL(TREND_URL);
  url.searchParams.set('date', date);
  url.searchParams.set('window', String(WINDOW));
  const resp = await fetch(url.toString(), {
    method: 'GET',
    headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + ANON_KEY, 'Content-Type': 'application/json' }
  });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { json = null; }
  if (!resp.ok) return { __httpError: 'HTTP ' + resp.status + ' ' + text.slice(0, 200) };
  return json || {};
}

/** 上游「额度/限流」类错误判据（与 Edge / db/yizi-backfill.mjs 同口径） */
function isQuotaMsg(msg) {
  return /额度|quota|RATE_LIMIT|请求次数超限|toomany|403/i.test(String(msg || ''));
}

async function main() {
  console.log('=== 竞价一字【趋势 / 十日涨幅】历史回填【' + (RUN ? '执行' : '演练 / 0 请求') + '】 ===');
  console.log('今天(北京) =', beijingToday(), '| 回看 =', DAYS, '自然日 | 窗口 =', WINDOW,
    '交易日 | 本次上限 =', MAX, '天 | 间隔 =', GAP, 's');
  console.log('代理 =', process.env.HTTPS_PROXY || process.env.https_proxy || '（未设置，本机直连大概率不通）');
  console.log('Edge  =', TREND_URL);
  console.log('');

  const dates = candidateDates().filter((d) => !isToday(d));
  console.log('候选工作日', dates.length, '个：', dates.join('  '));
  console.log('');

  if (!RUN) {
    console.log('（演练模式，未发任何请求。加 --run 执行；已补齐的日期会被 Edge 判为 cache-complete，0 额度）');
    return;
  }

  const done = [];     // 真抓到东西的日期
  const complete = []; // 已齐、0 消耗
  const noPool = [];   // 池子还没补 → 先跑 db/yizi-backfill.mjs
  const failed = [];
  let stopReason = '';

  // 🔴 索引是【手动推进】的（不是 i++）：补完一整个窗口后要跳过 WINDOW 个交易日，见文件头的「锚点跳跃」。
  let i = 0;
  while (i < dates.length) {
    const d = dates[i];
    if (done.length >= MAX) { stopReason = '达到本次上限 ' + MAX + ' 个锚点（留额度给明日 / 池子回填）'; break; }
    process.stdout.write('[' + (done.length + 1) + '/' + MAX + '] ' + d + ' … ');
    let r;
    try {
      r = await callTrend(d);
    } catch (e) {
      console.log('❌ 请求异常: ' + (e && e.message ? e.message : e));
      if (isQuotaMsg(e && e.message)) { stopReason = '额度/限流 → 止损'; break; }
      failed.push(d);
      i += 1;
      await sleep(GAP * 1000);
      continue;
    }
    if (r.__httpError) {
      console.log('❌ ' + r.__httpError);
      if (isQuotaMsg(r.__httpError)) { stopReason = '额度/限流 → 止损'; break; }
      failed.push(d);
      i += 1;
      await sleep(GAP * 1000);
      continue;
    }
    const skipped = String(r.skipped || '');
    const reqs = Number(r.requests) || 0;
    const written = Number(r.fetched && r.fetched.written) || 0;
    const budget = r.budget || {};
    const tag = '池=' + (r.poolSize || 0) + ' 请求=' + reqs + ' 写入=' + written +
      ' 预算=' + (budget.usedRequests || '?') + '/' + (budget.cap || '?');

    if (r.quotaExhausted) {
      console.log('🛑 小号今日额度已用完 → 立即止损（0 点重置后自动继续）');
      stopReason = '小号额度耗尽';
      break;
    }
    if (skipped === 'budget' || skipped === 'cooldown' || skipped === 'protect-window') {
      console.log('⏸ 闸门生效（' + skipped + '）→ 停止本轮，别白试 ' + tag);
      stopReason = 'Edge 闸门：' + skipped;
      break;
    }
    if (skipped === 'no-pool' || skipped === 'no-code' || !r.poolSize) {
      console.log('⏭ 该日一字池为空（' + (skipped || 'no-pool') + '）→ 需先跑 db/yizi-backfill.mjs 补池子');
      noPool.push(d);
      i += 1; // 池子空 ≠ 这一带没东西，继续逐个往前找有池的锚点
      await sleep(1000);
      continue;
    }
    if (skipped === 'cache-complete' || reqs === 0) {
      console.log('✅ 已齐（0 额度消耗）' + tag);
      complete.push(d);
      i += WINDOW; // 这一窗已铺满，下一锚点跳到 10 个交易日之前
      await sleep(1000);
      continue;
    }
    console.log('✅ 补到 ' + written + ' 行（' + tag + '）→ 下一锚点跳 ' + WINDOW + ' 个交易日');
    done.push(d);
    i += WINDOW;
    if (done.length < MAX) await sleep(GAP * 1000);
  }

  console.log('\n===== 汇总 =====');
  console.log('本次补到 ' + done.length + ' 天：' + (done.join('  ') || '无'));
  console.log('原本已齐 ' + complete.length + ' 天（0 额度）：' + (complete.join('  ') || '无'));
  if (noPool.length) console.log('缺池子 ' + noPool.length + ' 天（先补池）：' + noPool.join('  '));
  if (failed.length) console.log('失败 ' + failed.length + ' 天：' + failed.join('  '));
  if (stopReason) console.log('停止原因：' + stopReason);
  console.log('\n→ 明天 0 点额度重置后，重跑同一条命令即可续补（已齐的日期 0 消耗，自动跳过）。');
}

main().catch((e) => {
  console.error('未预期异常：', e);
  process.exit(1);
});
