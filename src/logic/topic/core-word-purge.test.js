import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { coreWordTokens, planCoreWordPurge } from './core-word-purge.js';
import { state } from '../app-state.js';
import { getTopicLibraryDigest } from '../../data/stock-topics.js';
import {
  buildRulesFingerprint,
  resolvePlanSnapshotFreshness
} from '../topicvolratio/plan-snapshot-rules.js';

/**
 * [CORE-PURGE 2026-11-14 用户口径] 删除核心词 ⇒ 同步清理股票题材库。
 *
 * 用户原话（逐字）：
 *   「我的意思是我删除核心词后，关联的同义词一起删除，比如东方海洋有羊字辈，东方，水产品，农业，
 *     这四个细分题材，我删除羊字辈题材，它只剩下东方，水产品，农业这三个题材，我再删除东方，
 *     它只剩下水产品，农业这两个题材。这两个细分题材，因为我没有删除关联的核心词，所以要完整保留。」
 *   「一个题材词算不算被这个核心词命中」→ 精确等于才删。
 *
 * 这些用例就是那句话的可执行版本：⛔ 任何一条变红都说明「删核心词」又开始连坐了。
 */
describe('[CORE-PURGE] 删除核心词 ⇒ 只摘掉精确相同的细分题材', () => {
  /** 用户原话里那只票：四个细分题材 */
  function libOriental() {
    return { 东方海洋: new Set(['羊字辈', '东方', '水产品', '农业']) };
  }

  it('① 用户原例：删「羊字辈」⇒ 东方海洋 只剩 东方 / 水产品 / 农业', () => {
    const plan = planCoreWordPurge(libOriental(), { name: '羊字辈', synonyms: ['羊字辈'] });
    expect(plan.affectedStocks).toBe(1);
    expect(plan.rows[0].stock).toBe('东方海洋');
    expect(plan.rows[0].removed).toEqual(['羊字辈']);
    expect(plan.rows[0].kept).toEqual(['东方', '水产品', '农业']);
  });

  it('② 用户原例续：再删「东方」⇒ 只剩 水产品 / 农业（没删核心词的题材完整保留）', () => {
    const afterFirst = { 东方海洋: new Set(['东方', '水产品', '农业']) };
    const plan = planCoreWordPurge(afterFirst, { name: '东方', synonyms: ['东方'] });
    expect(plan.rows[0].kept).toEqual(['水产品', '农业']);
    expect(plan.rows[0].removed).toEqual(['东方']);
  });

  it('③ 幂等：同一个核心词删第二次 ⇒ 0 命中、0 行（不会误伤）', () => {
    const lib = { 东方海洋: new Set(['东方', '水产品', '农业']) };
    const plan = planCoreWordPurge(lib, { name: '羊字辈', synonyms: ['羊字辈'] });
    expect(plan.affectedStocks).toBe(0);
    expect(plan.rows).toEqual([]);
  });

  it('④ 核心词名本身也算命中词（不只是同义词）', () => {
    const lib = { A: new Set(['羊字辈', '外贸']), B: new Set(['外贸']) };
    const plan = planCoreWordPurge(lib, { name: '羊字辈', synonyms: [] });
    expect(plan.rows.map(r => r.stock)).toEqual(['A']);
    expect(plan.rows[0].kept).toEqual(['外贸']);
  });

  it('⑤ 同义词数组一起删（核心词「半导体」的同义词「GPU」）', () => {
    const lib = { A: new Set(['GPU', '英伟达概念', '算力']) };
    const plan = planCoreWordPurge(lib, { name: '半导体', synonyms: ['GPU', '英伟达概念'] });
    expect(plan.rows[0].removed).toEqual(['GPU', '英伟达概念']);
    expect(plan.rows[0].kept).toEqual(['算力']);
  });

  it('⑥ 大小写 / 首尾空白归一：gpu 也算 GPU', () => {
    const lib = { A: new Set([' gpu ', '算力']) };
    const plan = planCoreWordPurge(lib, { name: '半导体', synonyms: ['GPU'] });
    expect(plan.rows[0].removed).toEqual(['gpu']);
    expect(plan.rows[0].kept).toEqual(['算力']);
  });

  it('⑦ 精确口径：只是包含不删，并如实记进 substringOnly', () => {
    const lib = { 北方稀土: new Set(['稀土永磁', '小金属']), 某票: new Set(['第三代半导体']) };
    const plan = planCoreWordPurge(lib, { name: '稀土', synonyms: [] });
    expect(plan.affectedStocks).toBe(0);
    expect(plan.substringOnly.map(s => s.stock)).toContain('北方稀土');
    // 换成「半导体」也一样：第三代半导体 ≠ 半导体
    const plan2 = planCoreWordPurge(lib, { name: '半导体', synonyms: [] });
    expect(plan2.rows).toEqual([]);
    expect(plan2.substringOnly.map(s => s.stock)).toContain('某票');
  });

  it('⑧ §11 保护：摘完会变空的股票【跳过】，绝不把整只股票的题材清空', () => {
    const lib = { 只有羊字辈: new Set(['羊字辈']), 正常票: new Set(['羊字辈', '外贸']) };
    const plan = planCoreWordPurge(lib, { name: '羊字辈', synonyms: ['羊字辈'] });
    expect(plan.affectedStocks).toBe(1);
    expect(plan.rows.map(r => r.stock)).toEqual(['正常票']);
    expect(plan.blocked.map(b => b.stock)).toEqual(['只有羊字辈']);
  });

  it('⑨ 其它题材原样保留、顺序不变（⛔ 不排序、不去重、不覆盖）', () => {
    const lib = { A: new Set(['外贸', '羊字辈', '氢能源']) };
    const plan = planCoreWordPurge(lib, { name: '羊字辈', synonyms: ['羊字辈'] });
    // 用户原话点名的那只票：阳光照明（外贸，氢能源，羊字辈）⇒ 删完 = （外贸，氢能源）
    expect(plan.rows[0].kept).toEqual(['外贸', '氢能源']);
  });

  it('⑩ 空核心词 / 空库 / 全库无命中 ⇒ 空计划，不发任何写请求', () => {
    expect(planCoreWordPurge(libOriental(), { name: '', synonyms: [] }).affectedStocks).toBe(0);
    expect(planCoreWordPurge(null, { name: '羊字辈' }).affectedStocks).toBe(0);
    expect(planCoreWordPurge({}, { name: '羊字辈' }).totalStocks).toBe(0);
    expect(planCoreWordPurge(libOriental(), { name: '不存在', synonyms: [] }).affectedStocks).toBe(0);
  });

  it('⑪ coreWordTokens：名 + 同义词去重（忽略大小写），保留原始大小写', () => {
    expect(coreWordTokens({ name: '羊字辈', synonyms: ['羊字辈', ' 羊字辈 ', ''] })).toEqual(['羊字辈']);
    expect(coreWordTokens({ name: 'AI应用', synonyms: ['ai应用', '人工智能'] })).toEqual(['AI应用', '人工智能']);
    expect(coreWordTokens(null)).toEqual([]);
  });

  it('⑫ 大批量核心词的影响面可算（电子/通信/算力 类场景不崩、不漏）', () => {
    const lib = {};
    for (let i = 0; i < 500; i++) lib['票' + i] = new Set(['算力', '液冷', '其它' + i]);
    const plan = planCoreWordPurge(lib, { name: '电子/通信/算力', synonyms: ['算力', '液冷'] });
    expect(plan.totalStocks).toBe(500);
    expect(plan.affectedStocks).toBe(500);
    expect(plan.removedWords).toBe(1000);
    expect(plan.rows[0].kept).toEqual(['其它0']);
  });
});

describe('[CORE-PURGE-SYNC] 清理后必须联动提示板与选股结果', () => {
  const CORE = [{ name: '羊字辈', synonyms: ['羊字辈'] }, { name: '农业', synonyms: ['种业'] }];

  /** 造一份「清理前」的题材库（真实形态：Set<题材>） */
  function seedBefore() {
    return {
      东方海洋: new Set(['羊字辈', '东方', '水产品', '农业']),
      阳光照明: new Set(['外贸', '氢能源', '羊字辈']),
      红太阳: new Set(['羊字辈', '农业'])
    };
  }

  it('① 删掉「羊字辈」后，题材库内容指纹必须变（这是全看板联动的唯一触发器）', () => {
    const prev = state._cloudTopicsCache;
    try {
      state._cloudTopicsCache = seedBefore();
      const before = getTopicLibraryDigest();
      expect(before.startsWith('tl1:')).toBe(true);

      // 用真实计划算出「清理后的库」，再像 pushStockTopicsBatch 那样落到缓存
      const plan = planCoreWordPurge(state._cloudTopicsCache, { name: '羊字辈', synonyms: ['羊字辈'] });
      expect(plan.affectedStocks).toBe(3);
      plan.rows.forEach(function(r) { state._cloudTopicsCache[r.stock] = new Set(r.kept); });

      const after = getTopicLibraryDigest();
      expect(after).not.toBe(before);
      expect(after.startsWith('tl1:')).toBe(true);
    } finally {
      state._cloudTopicsCache = prev;
    }
  });

  it('② 指纹一变 ⇒ 存档判 stale，且【历史日也重算】（提示板/选股跟着刷新的根）', () => {
    const prev = state._cloudTopicsCache;
    try {
      state._cloudTopicsCache = seedBefore();
      const sigBefore = buildRulesFingerprint(CORE, getTopicLibraryDigest());
      const plan = planCoreWordPurge(state._cloudTopicsCache, { name: '羊字辈', synonyms: ['羊字辈'] });
      plan.rows.forEach(function(r) { state._cloudTopicsCache[r.stock] = new Set(r.kept); });
      const sigAfter = buildRulesFingerprint(CORE, getTopicLibraryDigest());
      expect(sigAfter).not.toBe(sigBefore);

      const snap = { status: 'hit', rulesSig: sigBefore, inputsSig: 'v1:111' };
      // 【题材库那一段】变了必须 stale（历史日也一样）—— 用户「删了题材，选股和提示板要跟着变」。
      // ★ [RULES-BUMP-ALL 2026-11-14] 起历史日与今天同一判据，`allowRulesInvalidation` 已删除。
      expect(resolvePlanSnapshotFreshness(snap, {
        rulesSig: sigAfter, coreTopicsLoaded: true, inputsSig: 'v1:111'
      })).toBe('stale');
    } finally {
      state._cloudTopicsCache = prev;
    }
  });

  it('③ 只改核心词表（不动题材库）⇒ v14 起历史日也重算（[RULES-BUMP-ALL] 推翻旧护栏）', () => {
    const prev = state._cloudTopicsCache;
    try {
      state._cloudTopicsCache = seedBefore();
      const digest = getTopicLibraryDigest();
      const sigBefore = buildRulesFingerprint(CORE, digest);
      const CORE2 = [{ name: '羊字辈', synonyms: ['羊字辈', '羊年概念'] }, CORE[1]];
      const sigAfter = buildRulesFingerprint(CORE2, digest);
      expect(sigAfter).not.toBe(sigBefore);
      const snap = { status: 'hit', rulesSig: sigBefore, inputsSig: 'v1:111' };
      // 用户 2026-11-14 明确要求：规则/核心词变了，历史日也按新规则重算一遍。
      expect(resolvePlanSnapshotFreshness(snap, {
        rulesSig: sigAfter, coreTopicsLoaded: true, inputsSig: 'v1:111'
      })).toBe('stale');
    } finally {
      state._cloudTopicsCache = prev;
    }
  });

  it('④ 清理完必须整库重拉（否则 _cloudTopicsCache 为 null 时指纹恒空 ⇒ 什么都不刷新）', () => {
    const src = readFileSync('src/logic/topic/core-word-purge.js', 'utf8');
    expect(src).toContain('loadCloudTopics');
    // 顺序：先批量写 → 再整库重拉 → 再回读校验
    const iWrite = src.indexOf('await pushStockTopicsBatch(');
    const iReload = src.indexOf('await loadCloudTopics()');
    const iVerify = src.indexOf('const tokenSet = new Set(plan.tokens)');
    expect(iWrite).toBeGreaterThan(-1);
    expect(iReload).toBeGreaterThan(iWrite);
    expect(iVerify).toBeGreaterThan(iReload);
    // 验证读的是 UI 也在读的那一份（§6 单一真相）
    expect(src).toContain('state._cloudTopicsCache');
  });

  it('⑤ 提示板/选股消费的是「重算后的 plan」，不许读旧存档里的题材名', () => {
    // 存档被判 stale 后必须解冻并重算 —— 判据在组合式里，这里锁住那两个动作都在
    const board = readFileSync('src/composables/useTopicVolRatioBoard.js', 'utf8');
    expect(board).toContain('_buyPublished.value = null');
    // 当前指纹必须依赖题材库版本（否则清理后 computed 不重算）
    expect(board).toContain('void getTopicLibraryVersion()');
    expect(board).toContain('buildRulesFingerprint(getCoreTopics(), getTopicLibraryDigest())');
  });
});

describe('[CORE-PURGE-GUARD] 接线与护栏（静态锁）', () => {
  it('删除链路必须：先预览影响面 → 删核心词 → 再清题材库 → 回读验证', () => {
    const modal = readFileSync('src/components/CoreTopicModal.vue', 'utf8');
    const start = modal.indexOf('async function doDeleteCoreTopic(');
    const end = modal.indexOf('async function runPurge(');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const seg = modal.slice(start, end);
    // 顺序：预览（只读）→ commit（删核心词）→ 清题材库
    const iPreview = seg.indexOf('previewCoreWordPurge(core)');
    const iCommit = seg.indexOf('await commit(next');
    const iPurge = seg.indexOf('await runPurge(core)');
    expect(iPreview).toBeGreaterThan(-1);
    expect(iCommit).toBeGreaterThan(iPreview);
    expect(iPurge).toBeGreaterThan(iCommit);
    // ⛔ 预览失败必须直接 return（什么都不删），不能继续往下走
    expect(seg).toContain('已取消删除（未做任何改动）');
    // 清理用幂等函数（内部：读→计划→写→回读校验）
    const purgeSrc = readFileSync('src/logic/topic/core-word-purge.js', 'utf8');
    expect(purgeSrc).toContain('export async function purgeCoreWordFromLibrary');
    expect(modal).toContain('purgeCoreWordFromLibrary(core)');
  });

  it('题材库批量写入：键集三列完全一致（PGRST102 教训）+ 必须 bust 缓存 + 必须 bump 指纹版本', () => {
    const src = readFileSync('src/data/stock-topics.js', 'utf8');
    expect(src).toContain('export async function pushStockTopicsBatch');
    // 键集一致：body 三键，⛔ 不带 code（否则把库里已有代码清空）
    expect(src).toContain('return { stock: String(r.stock).trim(), topics: topics.join(\',\'), updated_at: nowIso };');
    expect(src).toContain('bustStockTopicsCache();');
    expect(src).toContain('state._topicLibVersion = (state._topicLibVersion || 0) + 1;');
    expect(src).toContain('state._topicCacheNorm = buildNormalizedTopicIndex(state._topicCache);');
  });

  it('§10/§11：读到 0 只股票必须中止（异常快照保护），不是「空数据所以不用删」', () => {
    const src = readFileSync('src/logic/topic/core-word-purge.js', 'utf8');
    expect(src).toContain('题材库读到 0 只股票（疑似读取异常），已中止');
    // 计划必须区分「精确删」与「只是包含」
    expect(src).toContain('substringOnly');
    expect(src).toContain('blocked');
    // 写后必须回读校验
    expect(src).toContain('verified');
  });

  it('⛔ 编辑核心词（改名/改同义词）本轮不做同步改写：saveEdit 仍只写 core_topics', () => {
    const modal = readFileSync('src/components/CoreTopicModal.vue', 'utf8');
    const start = modal.indexOf('async function saveEdit()');
    const end = modal.indexOf('function deleteCoreTopic(');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const seg = modal.slice(start, end);
    // 仍走 commit（= saveCoreTopics，只写 core_topics 一张表）
    expect(seg).toContain('await commit(next');
    expect(seg).not.toContain('purgeCoreWordFromLibrary');
    expect(seg).not.toContain('previewCoreWordPurge');
  });
});
