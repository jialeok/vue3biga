// cron-map.test.js — [CLOUD-0927-HEAL 2026-11-11] 锁住「映射在、cron 不在」这一类事故
//
// 事故复盘：`index.js#cronToPoint` 从 2026-11-04 起就有 `'27 1': 'snapshot'` 映射，
//   `range-heal.js` 的 9:27 云端自愈逻辑也完整实现，但 `wrangler.toml` 里**从来没挂这条 cron**
//   ⇒ 自愈从未自动跑过 ⇒ 9:25 失败时当天十日涨幅只能等有人打开网页触发前端自愈。
//   用户硬口径「最迟 9:27、我早上只用手机看网页、电脑可能关机」因此一直是空的。
//
// 本文件用纯文本静态锁（不 import index.js，避免拉起整张 Worker 依赖图）：
//   ① toml 里每条 cron 的「分 时」必须在 cronToPoint 的 MAP 里有对应 point；
//   ② MAP 里除保留的 9:35 手动映射外，每个键都必须在 toml 里真的挂了 cron；
//   ③ 9:27 必须是 snapshot，且星期段必须是 Cloudflare 的 2-6（周一~周五）。
//
// ⛔ 以后新增 cron 必须同时改 toml + MAP，否则这里直接红。

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOML = fs.readFileSync(path.join(HERE, '../wrangler-bidding-auto-fetch.toml'), 'utf8');
const INDEX = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');

/** toml [triggers] 的 crons 是唯一真相（与 verify-deploy.mjs#expectedCrons 同源） */
function crons() {
  const m = /crons\s*=\s*\[([^\]]+)\]/.exec(TOML);
  if (!m) throw new Error('wrangler-bidding-auto-fetch.toml 里找不到 [triggers] crons');
  return [...m[1].matchAll(/"([^"]+)"/g)].map(x => x[1]);
}

/** index.js 里 `const MAP = { '25 1': 'morning', ... }` 的键值 */
function mapEntries() {
  const m = /const\s+MAP\s*=\s*\{([\s\S]*?)\}/.exec(INDEX);
  if (!m) throw new Error('index.js 里找不到 cronToPoint 的 MAP');
  return [...m[1].matchAll(/'([^']+)'\s*:\s*'([^']+)'/g)].map(x => ({ key: x[1], point: x[2] }));
}

describe('[CLOUD-0927-HEAL] cron ↔ point 映射必须双向一致', () => {
  it('★ 9:27 snapshot 必须真的挂在 toml 上（本次事故的根因）', () => {
    const list = crons();
    expect(list).toContain('27 1 * * 2-6');
    expect(mapEntries().some(e => e.key === '27 1' && e.point === 'snapshot')).toBe(true);
  });

  it('★ toml 每条 cron 都能被 cronToPoint 识别（否则这一趟白跑）', () => {
    const keys = new Set(mapEntries().map(e => e.key));
    crons().forEach(function(c) {
      const parts = c.trim().split(/\s+/);
      expect(keys.has(parts[0] + ' ' + parts[1])).toBe(true);
    });
  });

  it('★ MAP 里每个自动时点都在 toml 挂着（⛔ 不许再出现「映射在、cron 不在」）', () => {
    // '35 1' 是刻意保留的手动/自建触发器映射，文档明确不占 cron 额度
    const MANUAL_ONLY = new Set(['35 1']);
    const list = crons();
    const scheduled = new Set(list.map(c => {
      const p = c.trim().split(/\s+/);
      return p[0] + ' ' + p[1];
    }));
    mapEntries().forEach(function(e) {
      if (MANUAL_ONLY.has(e.key)) return;
      expect(scheduled.has(e.key)).toBe(true);
    });
  });

  it('工作日一律用 Cloudflare 的 2-6（⛔ 别按标准 cron 写成 1-5）', () => {
    crons().forEach(function(c) {
      expect(c.trim().split(/\s+/)[4]).toBe('2-6');
    });
  });

  it('免费账户 5 条上限：[CLOSE-POST] 起用满 5 条，⛔ 不静默超配', () => {
    expect(crons().length).toBeLessThanOrEqual(5);
    expect(crons().length).toBe(5);
  });

  // ★★ [CLOSE-POST 2026-11-13] 收盘列全空事故（生产日志实证）：
  //   Cloudflare 免费版单次 invocation 只有 50 次 subrequest；16:00 主轮跑完
  //   runClose + snapshotPatch + dailyLegsHeal 已接近上限，再挂「收盘列 / 记忘 / LD」必爆
  //   `Too many subrequests` ⇒ 收盘列写不进 close、连运行日志都发不出去。
  //   ⇒ 拆成 16:00 close + 16:03 closepost 两次独立 invocation。
  it('[CLOSE-POST] 16:03 独立 cron 真的挂上，且映射为 closepost', () => {
    expect(crons()).toContain('3 8 * * 2-6');
    expect(mapEntries().some(e => e.key === '3 8' && e.point === 'closepost')).toBe(true);
  });

  it('[CLOSE-POST] 三个补写任务只在 closepost 分支，⛔ 不许再塞回 16:00 close 轮', () => {
    const closeBranch = /if \(point === 'close'\) \{([\s\S]*?)\n  \}\n  if \(point === 'closepost'\)/.exec(INDEX);
    expect(closeBranch).not.toBeNull();
    const closeBody = closeBranch[1];
    ['runBiddingCloseWrite', 'runJiwangCloseWrite', 'runLeaderDivergeDays'].forEach(function(fn) {
      expect(closeBody).not.toContain('await ' + fn);
    });
    const postBranch = /if \(point === 'closepost'\) \{([\s\S]*?)\n  \}\n  if \(point === 'snapshot'\)/.exec(INDEX);
    expect(postBranch).not.toBeNull();
    ['runBiddingCloseWrite', 'runJiwangCloseWrite', 'runLeaderDivergeDays', 'persistRunResult']
      .forEach(function(fn) { expect(postBranch[1]).toContain(fn); });
    // 手动回补白名单也要放行，否则出事故时无法在 Actions 里立即补
    expect(INDEX).toContain("'close', 'closepost', 'extras'");
  });

  it('[CLOSE-POST] 线上复核 REQUIRED 与运行日志验收字段都带上了', () => {
    const verify = fs.readFileSync(path.join(HERE, '../verify-deploy.mjs'), 'utf8');
    expect(verify).toContain("'closepost'");
    expect(INDEX).toContain('biddingCloseWritten: r.biddingCloseWritten');
    expect(INDEX).toContain('leaderDivergeCloseWritten: r.leaderDivergeCloseWritten');
  });

  it('9:27 这一趟必须含三段云端动作且落 bidding_fetch_log', () => {
    expect(INDEX).toContain('runSnapshotPatchUntilFinal');   // ① 竞价字段补漏
    expect(INDEX).toContain('runRangePctHeal');              // ② 十日涨幅
    expect(INDEX).toContain('runRange20Prefill');            // ③ 20 日涨幅二次补缺
    expect(INDEX).toContain('persistRunResult');             // 运行日志
    expect(INDEX).toContain('[CLOUD-0927-HEAL]');            // 上线标记（字符串字面量）
  });
});
