// yizi-backfill.mjs — 「竞价一字」历史回填驱动（只经已部署的 Edge Function 转发，本地不持有 key）
//
// 配套文件：
//   db/create_auction_yizi.sql           建表
//   db/supabase_auction_yizi_cron.sql    每交易日北京 09:25 自动抓取（只覆盖「当天」）
//   supabase/functions/auction-yizi-fetch/index.ts   抓取函数（本脚本调它的 /fetch?date= 手动补抓口）
//   → 本脚本负责【历史补数】：把过去 N 个交易日的快照逐日回填进 auction_yizi。
//
// 为什么走 Edge Function 而不是直连 numcat.net：
//   本小号 key（NUMCAT_API_KEY_YIZI）只存在于 Supabase Secrets，本地没有副本；
//   走 auction-yizi-fetch/fetch?date=… 既不暴露 key，也复用生产同一套字段映射与写库口径。
//
// 三条铁律（REFERENCE.md §猫抓直连/限流）：
//   ① 默认【演练】= 0 请求，只打印计划；加 --run 才真的抓。
//   ② 请求间隔 ≥ 20s（免费档连发 4 次即 RATE_LIMIT_EXCEEDED）。
//   ③ 止损：遇到「额度」/403/RATE_LIMIT 立即停止后续请求，不 continue 白烧额度。
//
// 额度提醒：猫抓免费档 = 每日 10 次（按 key 计，北京 0 点重置）。
//   已抓成功的日期会留在 auction_yizi 表里 → 重跑自动跳过，**重跑 0 额度**。
//   ⚠️ 每日 09:25 的自动抓取也要占 1 次 → 本脚本默认 --max=7，留缓冲。
//
// ⚠️ 本机直连不通，必须带代理环境变量跑（Node 22.22 已支持 NODE_USE_ENV_PROXY）：
//   HTTPS_PROXY=http://127.0.0.1:7897 NODE_USE_ENV_PROXY=1 node db/yizi-backfill.mjs --run
//
// 用法：
//   node db/yizi-backfill.mjs                    # 演练：列出待补日期与预计消耗
//   node db/yizi-backfill.mjs --run               # 执行（上限 7 次/次运行）
//   node db/yizi-backfill.mjs --run --days=30 --max=7 --gap=22

const SUPABASE_URL = 'https://tonqfgeyxnnwicjopshn.supabase.co';
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRvbnFmZ2V5eG5ud2ljam9wc2huIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2NjY3NzEsImV4cCI6MjA5NDI0Mjc3MX0.el-W10JIjr9iQXEKNxV7nLNdhZfOQp6waTY7ZSH27Jg';
const FN = SUPABASE_URL + '/functions/v1/auction-yizi-fetch/fetch';
const TOKEN = '123456';

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const num = (k, d) => { const a = argv.find((x) => x.startsWith(k + '=')); return a ? Number(a.split('=')[1]) : d; };

const RUN = has('--run');
const DAYS = num('--days', 30);      // 回看自然日数
// 默认 7：猫抓免费档每日 10 次，且每日 09:25 自动抓取固定占 1 次 → 留 2 次缓冲，不把额度打满
const MAX = num('--max', 7);        // 本次最多消耗几次额度
const GAP = num('--gap', 22);       // 请求间隔秒

// 本机走代理（直连不通，见 REFERENCE / 2026-09-18 取证）
const PROXY = process.env.HTTPS_PROXY || process.env.https_proxy || '';

function beijingToday() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
}

/** 近 N 自然日内的「工作日」候选（本区间 2026-08-19~09-18 无 A 股法定节假日；
 *  真遇到节假日，上游会返回上一交易日 → 函数按 tradedate 丢弃 → written=0，不会写脏行） */
function weekdayCandidates(days) {
  const out = [];
  const base = Date.parse(beijingToday() + 'T00:00:00Z');
  for (let i = 0; i < days; i++) {
    const t = base - i * 86400000;
    const d = new Date(t);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const p = (n) => String(n).padStart(2, '0');
    out.push(d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()));
  }
  return out; // 由近到远
}

async function supa(path, init) {
  const h = Object.assign({ apikey: ANON, Authorization: 'Bearer ' + ANON }, (init && init.headers) || {});
  const res = await fetch(SUPABASE_URL + path, Object.assign({}, init, { headers: h }));
  const txt = await res.text();
  if (!res.ok) throw new Error('Supabase ' + res.status + ' ' + txt.slice(0, 300));
  return txt ? JSON.parse(txt) : null;
}

async function existingCounts() {
  const txt = await supa('/rest/v1/auction_yizi?select=date&limit=20000');
  const m = new Map();
  for (const r of txt) m.set(r.date, (m.get(r.date) || 0) + 1);
  return m;
}

function quotaHit(s) {
  return /额度|quota|RATE_LIMIT|请求次数超限|403/i.test(s || '');
}

async function main() {
  console.log('=== 竞价一字 历史回填' + (RUN ? '【执行】' : '【演练 / 0 请求】') + ' ===');
  console.log('今天(北京) =', beijingToday(), '| 回看 =', DAYS, '自然日 | 本次上限 =', MAX, '次 | 间隔 =', GAP, 's');
  console.log('代理 =', PROXY || '(无，直连)');

  const have = await existingCounts();
  console.log('\n表中已有日期：', have.size ? [...have.entries()].map(([d, n]) => d + '(' + n + ')').join('  ') : '(空)');

  const cand = weekdayCandidates(DAYS);
  const todo = cand.filter((d) => !have.has(d));
  console.log('\n候选工作日 ' + cand.length + ' 个，其中已存在 ' + (cand.length - todo.length) + ' 个 → 待补 ' + todo.length + ' 天');
  console.log('待补（由近到远）：', todo.join('  ') || '(无)');

  if (todo.length === 0) { console.log('\n✅ 无需回填。'); return; }
  const plan = todo.slice(0, MAX);
  console.log('\n本次计划抓取 ' + plan.length + ' 天（预计消耗 ' + plan.length + ' 次额度）：' + plan.join('  '));
  if (todo.length > plan.length) {
    console.log('⚠️ 剩余 ' + (todo.length - plan.length) + ' 天未列入本次 —— 免费档每日 10 次，明天再跑同样的命令即可续补（已抓到的会自动跳过，0 额外消耗）。');
  }
  if (!RUN) { console.log('\n（演练模式，未发任何请求。加 --run 执行）'); return; }

  const okDays = [];
  const skipDays = [];
  const failDays = [];
  for (let i = 0; i < plan.length; i++) {
    const d = plan[i];
    process.stdout.write('\n[' + (i + 1) + '/' + plan.length + '] ' + d + ' … ');
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 240000);
      const res = await fetch(FN + '?token=' + TOKEN + '&date=' + d + '&once=1', {
        headers: { apikey: ANON, Authorization: 'Bearer ' + ANON },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      const body = await res.json().catch(() => ({}));
      const w = Number(body.written || 0);
      const dm = Number(body.droppedDateMismatch || 0);
      if (body.ok && w > 0) { console.log('✅ 写入 ' + w + ' 行'); okDays.push(d); }
      else if (body.ok && w === 0 && dm > 0) { console.log('⏭ 非交易日（上游只给到 ' + (body.datesSeen || []).join('/') + '）'); skipDays.push(d); }
      else {
        const msg = String(body.error || body.message || JSON.stringify(body).slice(0, 200));
        console.log('❌ ' + msg);
        failDays.push(d + ' → ' + msg);
        if (quotaHit(msg)) { console.log('\n🛑 命中额度/限流 → 立即止损，停止后续请求（避免白烧）。'); break; }
      }
    } catch (e) {
      const msg = String((e && e.message) || e);
      console.log('❌ 请求异常：' + msg);
      failDays.push(d + ' → ' + msg);
      if (quotaHit(msg)) { console.log('\n🛑 命中额度/限流 → 立即止损。'); break; }
    }
    if (i < plan.length - 1) {
      process.stdout.write('   等待 ' + GAP + 's（防突发限流）…');
      await new Promise((r) => setTimeout(r, GAP * 1000));
      console.log(' ok');
    }
  }

  const after = await existingCounts();
  console.log('\n===== 汇总 =====');
  console.log('成功 ' + okDays.length + ' 天：' + (okDays.join(' ') || '无'));
  console.log('跳过(非交易日) ' + skipDays.length + ' 天：' + (skipDays.join(' ') || '无'));
  console.log('失败 ' + failDays.length + ' 天：' + (failDays.join(' | ') || '无'));
  console.log('\n表内现有日期：');
  [...after.entries()].sort().reverse().forEach(([d, n]) => console.log('  ' + d + '  ' + n + ' 只'));
  const still = todo.filter((d) => !after.has(d));
  if (still.length) console.log('\n仍未补：' + still.join(' ') + '\n→ 明天再跑 `node .tmpdiag/yizi_backfill.mjs --run` 续补（已抓日期自动跳过）。');
  else console.log('\n🎉 回看区间已全部补齐。');
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
