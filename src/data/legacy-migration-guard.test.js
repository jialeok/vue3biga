/**
 * [MIGRATE-SHADOW-POLLUTION 2026-11-19 用户报障回归锁]
 *
 * 用户原话：「早盘竞价看板第一页历史日期默认莫名其妙多了很多票，这个非常严重。我之前都强调好几次了。
 *   它主要分成龙头组，常规组，观察组，20天补，30天补，这这几组，股票不可能每天超过100只的，
 *   为什么增那么多，就算增补的也没有增那么多。最主要来源就是上面显示的那个同花顺最近多板n只，
 *   这个是原始来源。」
 *
 * 云端取证（逐日聚合 created_at，见 `.tmpdiag/_v23-scope.mjs`）：每个历史日期都有 32~85 行的
 * created_at 晚于该行 date，source='worker'/'numcat'、updated_by='main'、obs_auto_added=false。
 * ⇒ 影子行情行被 `migrateAuctionToTable` 当成正式成员写进了 auction_watchlist。
 *
 * 本文件把修复钉死（静态锁：这段代码依赖「字段不存在」的语义，无法用单测造出真实分支）：
 *   ① 准入判据必须是**严格** `in_watchlist === true`；
 *   ② ⛔ 不许再出现 `in_watchlist !== false`（新模型无此字段 ⇒ undefined 会被当成正式成员）；
 *   ③ 新表已有数据 ⇒ 必须**直接返回、不写任何东西**（拆表早已完成）。
 * 违背任意一条 ⇒ 历史日期就会继续「越翻越多票」。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('./legacy-migration.js', import.meta.url), 'utf8');
const FN_START = SRC.indexOf('export async function migrateAuctionToTable');
const FN_END = SRC.indexOf('export async function', FN_START + 10);
const FN = SRC.slice(FN_START, FN_END > 0 ? FN_END : SRC.length);

describe('migrateAuctionToTable — 绝不能把影子行转正（历史日期票数暴涨的真因）', () => {
  it('① 准入判据必须是严格 `in_watchlist === true`（旧模型的显式正式成员）', () => {
    expect(FN).toContain('item.in_watchlist === true');
  });

  it('② ⛔ 可执行代码里不许再出现 `in_watchlist !== false` 这种「缺失也算真」的判据', () => {
    // 注释里会引用这个旧判据做说明（带 ⛔ 警示），所以只检查**去掉 // 注释后**的代码。
    const code = FN.split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');
    expect(code).not.toContain('item.in_watchlist !== false');
  });

  it('③ 新表已有数据 ⇒ 必须直接 return（不写任何行），并补上迁移标记', () => {
    // 探测分支里既有「读一行」也有「有数据就 return」
    expect(FN).toContain("from('auction_watchlist').select('date').limit(1)");
    const probeIdx = FN.indexOf('probe.length > 0');
    expect(probeIdx).toBeGreaterThan(0);
    const markIdx = FN.indexOf("localStorage.setItem('_auction_table_migrated', '1')", probeIdx);
    expect(markIdx).toBeGreaterThan(probeIdx);
    const retIdx = FN.indexOf('return;', markIdx);
    expect(retIdx).toBeGreaterThan(markIdx);
    // 这个 return 必须在「真正写库那段」之前（否则等于没拦）
    const writeIdx = FN.indexOf('upsertAuctionWatchlist');
    expect(writeIdx === -1 || retIdx < writeIdx || FN.indexOf('.upsert(', markIdx) > retIdx).toBe(true);
  });

  it('④ 读失败（§10 读不到 ≠ 空表）⇒ 也不许走迁移写入分支', () => {
    expect(FN).toContain('probeErr');
    const errIdx = FN.indexOf('probeErr.message');
    expect(errIdx).toBeGreaterThan(0);
    expect(FN.indexOf('return;', errIdx)).toBeGreaterThan(errIdx);
  });
});
