// range30-leaders-firstpaint.test.js — 「30天补」首帧直出（打开就有，不再等 6.8 秒粗筛）
//
// ══════════════════════════════════════════════════════════════════════════════════════
// 用户 2026-11-18 原话
//   「打开30日涨幅toggle时，有30天补标签的票很久才出现，优化下响应速度，不然要等好久，
//     才出来……20天补的票出来跟快，基本打开就出来了，30日补的票为什么那么慢」
// ══════════════════════════════════════════════════════════════════════════════════════
// 实测病根（本地跑真实 Supabase，⛔ 不是推测）：
//   · `ensureRange30Leaders` 的第一次 `_publish` 在**粗筛 + 精算全部跑完之后**：
//       粗筛 `readDailyPctRowsFor(池 286 只, 60 天前, T)` = 9 个串行请求 / 8566 行 / **6800ms**；
//       精算 `await ensureRange30()` 还会打腾讯；
//   · 而 `stock_range30_pct` 读一天只要 **409ms**，且实测对候选池「池内缺 0」
//       （11-18 池 286/缺 0、11-17 池 282/缺 0、11-13 池 304/缺 0）。
//   ⇒ 先用云端表直出首帧，再决定要不要跑粗筛。
//
// 本文件锁死的事项（⛔ 改动前先读完）：
//   ① 首帧 `_publish(d, fastTop)` 必须出现在 `readDailyPctRowsFor(...)` 【之前】——
//      顺序一反过来，「等很久才出现」立刻回归；
//   ② 云端表覆盖完整 ⇒ 直接返回，⛔ 不许再跑粗筛精算（§32 不做无效请求）；
//   ③ 首帧出了块之后，后面任何「空结论」都⛔ 不许把它抹掉（§10：算不出来 ≠ 今天没有补位）；
//   ④ 兜底路径（粗筛 + 精算）必须保留 —— 云端表缺票时仍然要去补。
//
// 行为不变的证据（本次手工用真实数据跑过，前三日新旧口径前五**逐位一致**）：
//   11-18 冰山冷热 140.97 / 九阳股份 126.96 / 文投控股 84.76 / 东方海洋 83.74 / 龙江交通 76.39
//   11-17 九阳股份 177.46 / 冰山冷热 127.45 / 东方海洋 107.00 / 文投控股 104.24 / 阳光照明 74.31
//   11-13 九阳股份 184.88 / 东方海洋 136.27 / 襄阳轴承 104.03 / 文投控股 101.18 / 冰山冷热 98.65

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { RANGE30_LEADER_TOP_N, RANGE30_LEADER_PRESELECT, RANGE30_LEADER_COARSE_MIN_LEGS } from './range30-leaders.js';

const ROOT = process.cwd();
const SRC = fs.readFileSync(path.join(ROOT, 'src/logic/auction/range30-leaders.js'), 'utf8');
const norm = (s) => s.replace(/\s+/g, ' ');

describe('[R30-FIRSTPAINT] 首帧必须比粗筛先发出来', () => {
  it('首帧 _publish(d, fastTop) 必须在 readDailyPctRowsFor 之前（顺序反了就是「等很久才出现」）', () => {
    const iFast = norm(SRC).indexOf('_publish(d, fastTop);');
    const iCoarse = norm(SRC).indexOf('readDailyPctRowsFor(poolNames, probeDates[0], d)');
    expect(iFast).toBeGreaterThan(-1);
    expect(iCoarse).toBeGreaterThan(-1);
    expect(iFast).toBeLessThan(iCoarse);
  });

  it('首帧来源必须是云端结果表（readRange30Rows），⛔ 不是逐日腿原料表', () => {
    expect(norm(SRC)).toContain(
      "import { readRange30Rows } from '../../data/stock-range30-cache.js';"
    );
    expect(norm(SRC)).toContain('cloudMap = await readRange30Rows(d);');
    expect(norm(SRC)).toContain('const fastTop = _rankFromCloud(pool, cloudMap, RANGE30_LEADER_TOP_N);');
  });

  it('云端表覆盖完整 ⇒ 直接结束，⛔ 不许再跑粗筛/精算', () => {
    expect(norm(SRC)).toContain('if (cloudMissing === 0 && fastTop.length > 0) {');
    expect(norm(SRC)).toContain('⇒ 跳过粗筛/精算');
  });

  it('排名口径必须与最终结论一致：门槛 RANGE30_MIN_LEGS + 只主板', () => {
    const i = SRC.indexOf('function _rankFromCloud(');
    expect(i).toBeGreaterThan(-1);
    const body = norm(SRC.slice(i, i + 2000));
    expect(body).toContain('minDays: RANGE30_MIN_LEGS,');
    expect(body).toContain('mainBoardOnly: true');
    expect(body).toContain('limit: limit');
  });
});

describe('[R30-FIRSTPAINT] ★ 反证：首帧出了块之后不许被「空结论」抹掉', () => {
  it('`_publish(d, [])` 只有两处（非交易日闸门 + 粗筛归零），后者必须被 fastTop 判据护住', () => {
    const empties = norm(SRC).split('_publish(d, []);').length - 1;
    expect(empties).toBe(2);
    // ① 非交易日闸门：进函数就返回，不可能抹掉首帧
    expect(norm(SRC)).toContain('if (_notTradable(d)) { _publish(d, []);');
    // ② 粗筛归零：必须判 fastTop
    expect(norm(SRC)).toContain('if (fastTop.length === 0) _publish(d, []);');
  });

  it('最终发布也必须带护栏：空 top 只在没有首帧时才发', () => {
    expect(norm(SRC)).toContain('if (top.length > 0 || fastTop.length === 0) _publish(d, top);');
    const finals = norm(SRC).split('_publish(d, top);').length - 1;
    expect(finals).toBe(1);
  });
});

describe('[R30-FIRSTPAINT] 兜底路径必须保留（云端表缺票时仍要去补）', () => {
  it('粗筛 / 精算 / 近似降级三段都还在', () => {
    expect(norm(SRC)).toContain('const dailyLegs = legs20FromDaily(pool, probeDates, dailyMap);');
    expect(norm(SRC)).toContain(
      'compound20(dailyLegs, probeDates, { windowDays: RANGE30_WINDOW_DAYS })'
    );
    expect(norm(SRC)).toContain('await ensureRange30(d, coarseTop, { force: force });');
    expect(norm(SRC)).toContain('approx: true');
  });

  it('常量别动：前五 / 粗筛留 20 / 粗筛门槛 3 根腿', () => {
    expect(RANGE30_LEADER_TOP_N).toBe(5);
    expect(RANGE30_LEADER_PRESELECT).toBe(20);
    expect(RANGE30_LEADER_COARSE_MIN_LEGS).toBe(3);
  });
});
