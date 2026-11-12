// leader-diverge-cloud.test.js — [LD-CLOUD 2026-11-13] 第二十五条「云端预计算」的接线静态锁
//
// 为什么用「静态锁」而不是跑一遍链路：
//   这条链跨了三个运行环境（Cloudflare Worker 写 → Supabase 表 → 浏览器读 → 规则层判），
//   单测里既没有 Worker 也没有库。历史教训（11-10 那批）说明：**漏接一根线，全站静默**——
//   不报错、不告警，只是那句话永远不出现。所以这里把「线必须存在」钉死。
//
// 锁住的六根线：
//   ① 建表 SQL 存在，且主键是 (date, stock)；
//   ② 前端 Data 层只读这张表（date + stock 双条件），⛔ 不 upsert / 不 delete；
//   ③ 组合式：import 了读取器 → 有 ensureLeaderDivergeDays → 它被调用 → 注入走唯一入口；
//   ④ 规则层：`ebbCtx.leaderDiverge` 只在 kind==='second' 时放宽（首次分歧 / 趋势不放宽）；
//   ⑤ Worker：分发点 divergedays + 9:27 与 16:00 各调一次；
//   ⑥ 部署闸门：verify-deploy 的 REQUIRED 与 deploy-worker 的 paths 都要覆盖新文件。
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';

function read(p) {
  return readFileSync(p, 'utf8');
}

describe('[LD-CLOUD] 建表 SQL', () => {
  const SQL = 'db/create_tvrb_leader_diverge.sql';

  it('表存在，且主键是 (date, stock)（一天一只总龙一行）', () => {
    expect(existsSync(SQL)).toBe(true);
    const s = read(SQL);
    expect(s).toContain('create table if not exists tvrb_leader_diverge');
    expect(s).toMatch(/primary key \(date, stock\)/);
  });

  it('判定结论列齐全（kind / qualified / dragon_days / 首次 / 二次 / 逐日留痕）', () => {
    const s = read(SQL);
    ['kind', 'qualified', 'dragon_days', 'first_date', 'second_date',
      'boards_after_first', 'leg_phase', 'rows'].forEach(function (c) {
      expect(s).toContain(c);
    });
  });
});

describe('[LD-CLOUD] 前端 Data 层（只读一行）', () => {
  const F = 'src/data/leader-diverge-days.js';

  it('表名与列清单在文件里，且按 date + stock 双条件查', () => {
    const s = read(F);
    expect(s).toContain("'tvrb_leader_diverge'");
    expect(s).toContain(".eq('date'");
    expect(s).toContain(".eq('stock'");
  });

  it('⛔ 绝不写库：对这张表只有一次 .from()，而且是 .select()', () => {
    const s = read(F);
    const hits = s.split('.from(LEADER_DIVERGE_TABLE)').length - 1;
    expect(hits).toBe(1);
    expect(s).toContain('.from(LEADER_DIVERGE_TABLE)\n      .select(COLS)');
    expect(s).not.toContain('.upsert(');
    expect(s).not.toContain('.insert(');
  });

  it('§10：读失败 throw；只有「表不存在」按无记录处理', () => {
    const s = read(F);
    expect(s).toContain('throw error');
    expect(s).toContain('PGRST205');
  });

  it('返回形状与规则层读的键逐字对齐（kind / qualified / dragonDays / secondDate / boardsAfterFirst）', () => {
    const s = read(F);
    ['kind:', 'qualified:', 'dragonDays:', 'firstDate:', 'secondDate:', 'boardsAfterFirst:']
      .forEach(function (k) { expect(s).toContain(k); });
  });
});

describe('[LD-CLOUD] 组合式接线', () => {
  const C = 'src/composables/useTopicVolRatioBoard.js';
  const s = read(C);

  it('import 了云端判定读取器', () => {
    expect(s).toContain("from '../data/leader-diverge-days.js'");
    expect(s).toContain('readLeaderDivergeDay');
  });

  it('有 ensureLeaderDivergeDays，并且在按日期的主链路上被调用', () => {
    expect(s).toContain('function ensureLeaderDivergeDays(');
    expect(s).toContain('void ensureLeaderDivergeDays(d);');
  });

  it('注入走唯一入口 _ebbCtxWithLeaderDiverge（⛔ 直接在模板里拼 ebbCtx）', () => {
    expect(s).toContain('function _ebbCtxWithLeaderDiverge(');
    expect(s).toContain('ebbCtx: _ebbCtxWithLeaderDiverge(rec.ebbCtx, d)');
    // 唯一入口必须同时核对「日期」与「同名总龙」，否则等于拿 A 日结论改今天
    expect(s).toContain('leaderDivergeDate.value !== d');
    expect(s).toContain('leaderName !== String(row.stock');
  });

  it('总龙一身份取自 ensureRange20Leaders（与退潮判定同一份事实，§6）', () => {
    const i = s.indexOf('function ensureLeaderDivergeDays(');
    const seg = s.slice(i, i + 2200);
    expect(seg).toContain('ensureRange20Leaders(d)');
    expect(seg).toContain('leaderDivergeStock.value = stock');
  });
});

describe('[LD-CLOUD] 规则层消费口径', () => {
  it('只有 kind=second 才放宽「前两日连板」闸门（首次分歧 / 趋势一字不动）', () => {
    const s = read('src/logic/topicvolratio/tvrb-ebb.js');
    expect(s).toContain("dv.kind === 'second' && dv.qualified !== false");
    expect(s).toContain('leaderDiverge');
    // 二次分歧提示语必须落到提示板
    expect(s).toContain('二次分歧 · 等同退潮');
  });
});

describe('[LD-CLOUD] Worker 侧', () => {
  const IDX = 'workers/bidding-auto-fetch/index.js';
  const s = read(IDX);

  it('分发点 divergedays 存在且在 /fetch 白名单里', () => {
    expect(s).toContain("point === 'divergedays'");
    expect(s).toContain("'divergedays'");
  });

  it('9:27 snapshot 与 16:00 close 各调一次（intraday / close 两阶段）', () => {
    expect(s).toContain('runLeaderDivergeDays');
    expect(s).toContain("phase: 'intraday'");
    expect(s).toContain("phase: 'close'");
    expect(s).toContain('leaderDivergeWritten');
    expect(s).toContain('leaderDivergeCloseWritten');
  });

  it('部署后复核（verify-deploy）把这轮的新标识符列进 REQUIRED', () => {
    const v = read('workers/verify-deploy.mjs');
    expect(v).toContain("'runLeaderDivergeDays'");
    expect(v).toContain("'divergedays'");
    expect(v).toContain("'tvrb_leader_diverge'");
  });

  it('deploy-worker 的 paths 覆盖云端判定 import 的整条纯函数链（否则改了不重新部署 = 假绿）', () => {
    const y = read('.github/workflows/deploy-worker.yml');
    [
      'src/logic/auction/auction-leg-pct.js',
      'src/logic/auction/auction-leg-board.js',
      'src/logic/auction/range20-board-consts.js',
      'src/logic/topicvolratio/leader-diverge.js',
      'src/logic/decision/auction-share.js'
    ].forEach(function (p) { expect(y).toContain(p); });
  });
});
