// [FAKE-GREEN 2026-11-06] 部署后线上复核
//   CI 报 success ≠ Cloudflare 真的换了脚本。曾出现过：wrangler 因 Node 20 直接退出，
//   但 `... | tee` 返回 0 ⇒ 三个 job 全绿、线上仍是旧版（2 条 cron、无新函数）。
//   本脚本直接读 Cloudflare API 的「线上脚本内容」+「线上 cron」，断言与仓库 toml 一致。
//
//   本地也能跑：
//     CLOUDFLARE_API_TOKEN=xxx CLOUDFLARE_ACCOUNT_ID=xxx node workers/verify-deploy.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOKEN = process.env.CLOUDFLARE_API_TOKEN || process.env.CF_TOKEN;
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CF_ACCOUNT;
const SCRIPT = 'bidding-auto-fetch';
const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/${SCRIPT}`;

if (!TOKEN || !ACCOUNT) {
  console.error('::error::缺少 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID');
  process.exit(1);
}

// toml 的 [triggers] 是唯一真相；从文件读，避免复核脚本与 toml 各写一份迟早漂移
function expectedCrons() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const toml = fs.readFileSync(path.join(here, 'wrangler-bidding-auto-fetch.toml'), 'utf8');
  const m = /crons\s*=\s*\[([^\]]+)\]/.exec(toml);
  if (!m) throw new Error('wrangler-bidding-auto-fetch.toml 里找不到 [triggers] crons');
  return [...m[1].matchAll(/"([^"]+)"/g)].map(x => x[1]).sort();
}

// 本次上线必须能在【线上脚本】里看到的标识符。
// ⛔ 只写本轮新增、且线上目前确实没有的项 —— 才能证明真的换了版本，而不是读到缓存旧脚本。
const REQUIRED = [
  'runLadderRecheck',       // 9:26 最近多板 883410 二次确认 + 猫抓补新进票
  'runRange20Prefill',      // 9:26 云端补 20 日涨幅（0 上游请求）
  'runDailyLegsHeal',       // 逐日腿云端补齐，替掉本机 08:00 定时任务
  'isRetriableFuyaoError',  // 883410「Data source unavailable」现在会被重试
  'ladder26',               // 新 cron 分发点
  'metrics_close',          // 云端收盘腿标记（本机脚本写的是 src='metrics'）
  'runBiddingCloseWrite',   // [2026-11-07] 竞价变化看板「收盘」列纯云端幂等落库
  'computeBiddingCloseValues', // 收盘取值口径：前端 / Worker 共用同一份纯函数
  'runJiwangCloseWrite',    // [2026-11-08] 昨收盘结果(跌:涨) 云端落库 + 10 日窗口回补
  'alignWindowTargets',     // 用真实交易日窗口推「下一交易日」，0 额外请求
  // [2026-11-10] 20 日涨幅逐日腿改 Range 分页（根治 limit=1000 静默截断 ⇒ 冰山冷热迟到）。
  // ⚠️ 它是 supabase-write.js 错误消息里的字符串字面量 ⇒ 打包/压缩后仍在线上脚本里，
  //    能硬证明这次真的换了版本（⛔ 别换成注释里的标记，注释会被 esbuild 删掉）。
  '[R20-LEGS-PAGED]',
  // [2026-11-11] 9:27 云端自愈 cron + 20 日涨幅二次补缺 + 半截名单闸门。
  //   ⚠️ 字符串字面量（在 index.js 的 console.log / range20-prefill.js 的日志里），
  //      注释会被 esbuild 删掉，只有它能证明「这一版真的上线了」。
  //   ⚠️ cron 条数由 expectedCrons() 直读 toml 断言，不需要在这里列第 4 条。
  '[CLOUD-0927-HEAL]'
];

async function cf(url, accept) {
  const headers = { Authorization: 'Bearer ' + TOKEN };
  if (accept) headers.Accept = accept;
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url} → ${text.slice(0, 200)}`);
  return text;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const want = expectedCrons();
  console.log('期望 cron  :', JSON.stringify(want));
  console.log('必需标识符:', JSON.stringify(REQUIRED));

  // Cloudflare 部署后 API 有秒级传播延迟 ⇒ 最多等 3 轮，每轮间隔 10s
  let lastErr = null;
  for (let i = 1; i <= 3; i++) {
    try {
      const script = await cf(API);
      const missing = REQUIRED.filter(k => !script.includes(k));
      console.log(`第 ${i} 轮：线上脚本 ${script.length} 字节，缺标识符 ${JSON.stringify(missing)}`);
      if (missing.length === 0) {
        const raw = await cf(API + '/schedules', 'application/json');
        const json = JSON.parse(raw);
        const holder = (json && json.result) || {};
        const list = Array.isArray(holder) ? holder : (holder.schedules || []);
        const got = list.map(s => s.cron).filter(Boolean).sort();
        console.log('线上 cron  :', JSON.stringify(got));
        if (JSON.stringify(got) !== JSON.stringify(want)) {
          throw new Error('cron 不一致：期望 ' + JSON.stringify(want) + ' 实得 ' + JSON.stringify(got));
        }
        console.log(`✅ 线上复核通过：脚本含全部 ${REQUIRED.length} 个新标识符，cron ${got.length} 条与 toml 一致`);
        return;
      }
      lastErr = new Error('线上脚本仍缺 ' + JSON.stringify(missing) + '（部署未生效或读到旧版本）');
    } catch (e) {
      lastErr = e;
    }
    if (i < 3) { console.log('  10s 后重试…'); await sleep(10000); }
  }
  throw lastErr;
}

main().catch(e => {
  console.error('::error::线上复核失败：' + (e && e.message ? e.message : String(e)));
  console.error('  ⇒ CI 不能判绿。检查顺序：deploy 步骤日志 → API Token 是否具备 Workers Scripts:Read → 线上脚本版本');
  process.exit(1);
});
