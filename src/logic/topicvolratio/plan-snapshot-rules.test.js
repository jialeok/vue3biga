/**
 * [REVISABLE 2026-11-11] 选股结论存档「可修订」语义的契约单测。
 *
 * 用户原话：「既然历史日期能计算出来，能计算出来就要存起来啊……
 *   核心词的同义词更变……选票结果有更换，这是很合理的……这是我本身纠错行为……
 *   所以建表时要注意，结果不是一成不变的。我希望历史日期既然能计算出来也要存起来。」
 *
 * 本测试锁三条整类红线：
 *   ① 规则指纹基于【内容】：核心词同义词增删改必然改变指纹，且同一内容跨调用 / 跨会话恒定；
 *   ② 存档新鲜度：核心词没加载完绝不判过期（首屏默认词表会误覆盖好存档）；
 *   ③ 写入准入：读档失败绝不覆盖；stale 即使选票没变也必须写一次更新 rules_sig。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  TVRB_RULES_VERSION,
  TVRB_INPUTS_VERSION,
  buildRulesFingerprint,
  buildInputsFingerprint,
  isInputsFingerprintComplete,
  resolvePlanSnapshotFreshness,
  shouldPersistPlanSnapshot
} from './plan-snapshot-rules.js';

function topics() {
  return [
    { name: 'AI应用', synonyms: ['人工智能', 'AI', '大模型'] },
    { name: '文化传媒', synonyms: ['传媒', '短剧'] }
  ];
}

describe('buildRulesFingerprint · 规则输入指纹（基于内容，不基于内存版本号）', function() {
  it('① 同一份核心词表 ⇒ 指纹恒定（跨调用 / 跨对象引用）', function() {
    const a = buildRulesFingerprint(topics());
    const b = buildRulesFingerprint(topics());
    expect(a).toBe(b);
    expect(a).toBe('v' + TVRB_RULES_VERSION + ':' + a.split(':')[1]);
    expect(a.split(':')[1]).toMatch(/^[0-9a-f]{8}$/);
  });

  it('② 🔴 用户增删改同义词 ⇒ 指纹必变（题材分组变化 ⇒ 结论应跟着变）', function() {
    const base = buildRulesFingerprint(topics());
    const added = topics(); added[0].synonyms.push('算力');
    const removed = topics(); removed[1].synonyms.pop();
    const edited = topics(); edited[0].synonyms[1] = 'AIGC';
    expect(buildRulesFingerprint(added)).not.toBe(base);
    expect(buildRulesFingerprint(removed)).not.toBe(base);
    expect(buildRulesFingerprint(edited)).not.toBe(base);
  });

  it('③ 增删 / 改名核心词 ⇒ 指纹必变', function() {
    const base = buildRulesFingerprint(topics());
    const add = topics(); add.push({ name: '机器人', synonyms: ['减速器'] });
    const del = topics(); del.pop();
    const rename = topics(); rename[0].name = 'AI应用2';
    expect(buildRulesFingerprint(add)).not.toBe(base);
    expect(buildRulesFingerprint(del)).not.toBe(base);
    expect(buildRulesFingerprint(rename)).not.toBe(base);
  });

  it('④ 空表 / null / 怪数据也返回稳定非空指纹，⛔ 不抛异常', function() {
    expect(buildRulesFingerprint([])).toBe(buildRulesFingerprint([]));
    expect(buildRulesFingerprint(null)).toBe(buildRulesFingerprint(undefined));
    // ★ [RULES-BUMP-GUARD] 前缀跟着 TVRB_RULES_VERSION 走，⛔ 不写死版本号（bump 时不用改测试）
    expect(buildRulesFingerprint([null, {}, { name: 'X', synonyms: null }]))
      .toMatch(new RegExp('^v' + TVRB_RULES_VERSION + ':'));
  });

  it('⑤ 同义词顺序调整也算一次编辑（保守，结论不变时由幂等写兜住）', function() {
    const base = buildRulesFingerprint(topics());
    const swapped = topics(); swapped[0].synonyms.reverse();
    expect(buildRulesFingerprint(swapped)).not.toBe(base);
  });
});

describe('resolvePlanSnapshotFreshness · 存档是否已因规则变更而过期', function() {
  // ⚠️ [SNAPSHOT-INPUTS] 现在有效的存档必须同时带 rulesSig + inputsSig 才算「元数据齐全」。
  const hit = { status: 'hit', rulesSig: 'v1:aaaaaaaa', inputsSig: 'v1:111' };
  const COMPLETE = 'v1:111';

  it('① 🔴 核心词还没从云端加载完 ⇒ 判 hit（⛔ 不许拿首屏默认词表误判过期）', function() {
    expect(resolvePlanSnapshotFreshness(hit, {
      rulesSig: 'v1:bbbbbbbb', coreTopicsLoaded: false, inputsSig: COMPLETE
    })).toBe('hit');
  });

  it('② 当前指纹算不出来 ⇒ 判 hit（§10 算不出 ≠ 变了）', function() {
    expect(resolvePlanSnapshotFreshness(hit, {
      rulesSig: '', coreTopicsLoaded: true, inputsSig: COMPLETE
    })).toBe('hit');
  });

  it('③ 指纹相同（规则 + 输入完整度都相同）⇒ hit（历史复盘稳定，不重算、不覆盖）', function() {
    expect(resolvePlanSnapshotFreshness(hit, {
      rulesSig: 'v1:aaaaaaaa', coreTopicsLoaded: true, inputsSig: COMPLETE
    })).toBe('hit');
  });

  it('④ 🔴 指纹不同 ⇒ stale（用户改了同义词 ⇒ 允许按新规则重算并修订存档）', function() {
    expect(resolvePlanSnapshotFreshness(hit, {
      rulesSig: 'v1:bbbbbbbb', coreTopicsLoaded: true, inputsSig: COMPLETE
    })).toBe('stale');
  });

  it('⑤ 旧存档没记 rules_sig（升级前的行）⇒ stale，重算一次自愈补齐元数据', function() {
    expect(resolvePlanSnapshotFreshness({ status: 'hit', rulesSig: '', inputsSig: COMPLETE }, {
      rulesSig: 'v1:aaaaaaaa', coreTopicsLoaded: true, inputsSig: COMPLETE
    })).toBe('stale');
  });

  it('⑥ 不是有效存档状态 ⇒ unknown（本判据不管，由说明区各自处理）', function() {
    expect(resolvePlanSnapshotFreshness({ status: 'empty' }, {
      rulesSig: 'v1:aaaaaaaa', coreTopicsLoaded: true
    })).toBe('unknown');
    expect(resolvePlanSnapshotFreshness(null, {})).toBe('unknown');
  });
});

/**
 * [SNAPSHOT-INPUTS 2026-11-11] 11-11 P0 实证的整类红线。
 *
 * 事故：`stock_range20_pct` 当天 auc 腿 0 行（云端预填撞 42P10 全灭）⇒ 20 日补位池空，
 *   结论在【输入残缺】时定稿并按 `rules_sig` 命中 ⇒ 永久 hit ⇒ 数据补齐后屏幕也不变。
 * 用户体感：「昨天刚修好今天又不见」「越改越乱」。
 * ⇒ 存档必须记住「这份结论是在什么完整度上算出来的」，数据补齐后自动重算覆盖。
 */
describe('buildInputsFingerprint · 输入完整度指纹', function() {
  it('① 三位顺序固定：竞价榜 | 量比 | 补位池；全达标 = v1:111', function() {
    expect(buildInputsFingerprint({ aucBoardReady: true, volRatioOk: true, poolOk: true }))
      .toBe('v' + TVRB_INPUTS_VERSION + ':111');
    expect(buildInputsFingerprint({ aucBoardReady: false, volRatioOk: true, poolOk: true }))
      .toBe('v' + TVRB_INPUTS_VERSION + ':011');
    expect(buildInputsFingerprint({ aucBoardReady: true, volRatioOk: false, poolOk: true }))
      .toBe('v' + TVRB_INPUTS_VERSION + ':101');
    expect(buildInputsFingerprint({ aucBoardReady: true, volRatioOk: true, poolOk: false }))
      .toBe('v' + TVRB_INPUTS_VERSION + ':110');
  });

  it('② 缺省 / null / 非 true 一律记 0（⛔ 不许把「不知道」当「完整」）', function() {
    expect(buildInputsFingerprint(null)).toBe('v' + TVRB_INPUTS_VERSION + ':000');
    expect(buildInputsFingerprint({ aucBoardReady: 1, volRatioOk: 'yes', poolOk: {} }))
      .toBe('v' + TVRB_INPUTS_VERSION + ':000');
  });

  it('③ isInputsFingerprintComplete 只认 v<数字>:111', function() {
    expect(isInputsFingerprintComplete('v1:111')).toBe(true);
    expect(isInputsFingerprintComplete('v2:111')).toBe(true);
    expect(isInputsFingerprintComplete('v1:110')).toBe(false);
    expect(isInputsFingerprintComplete('')).toBe(false);
    expect(isInputsFingerprintComplete('111')).toBe(false);
    expect(isInputsFingerprintComplete(null)).toBe(false);
  });
});

describe('resolvePlanSnapshotFreshness · 输入完整度自愈（11-11 整类修复）', function() {
  const DONE = 'v1:111';

  it('① 🔴 存档没记 inputs_sig（上一版写的历史行）⇒ stale，自愈一次（11-11 21:22 那条就是这种）', function() {
    expect(resolvePlanSnapshotFreshness(
      { status: 'hit', rulesSig: 'v1:aaaaaaaa', inputsSig: '' },
      { rulesSig: 'v1:aaaaaaaa', coreTopicsLoaded: true, inputsSig: DONE }
    )).toBe('stale');
  });

  it('② 🔴🔴 存档是「auc 腿缺失 / 补位池空」时算的（v1:110），数据补齐后 ⇒ stale ⇒ 重算覆盖', function() {
    expect(resolvePlanSnapshotFreshness(
      { status: 'hit', rulesSig: 'v1:aaaaaaaa', inputsSig: 'v1:110' },
      { rulesSig: 'v1:aaaaaaaa', coreTopicsLoaded: true, inputsSig: DONE }
    )).toBe('stale');
    expect(resolvePlanSnapshotFreshness(
      { status: 'hit', rulesSig: 'v1:aaaaaaaa', inputsSig: 'v1:011' },
      { rulesSig: 'v1:aaaaaaaa', coreTopicsLoaded: true, inputsSig: DONE }
    )).toBe('stale');
  });

  it('③ 当前输入还算不出来 / 仍不完整 ⇒ 判 hit（⛔ 数据没齐就不许反复重算覆盖）', function() {
    const snap = { status: 'hit', rulesSig: 'v1:aaaaaaaa', inputsSig: 'v1:110' };
    expect(resolvePlanSnapshotFreshness(snap, {
      rulesSig: 'v1:aaaaaaaa', coreTopicsLoaded: true, inputsSig: ''
    })).toBe('hit');
    expect(resolvePlanSnapshotFreshness(snap, {
      rulesSig: 'v1:aaaaaaaa', coreTopicsLoaded: true, inputsSig: 'v1:110'
    })).toBe('hit');
    expect(resolvePlanSnapshotFreshness(snap, {
      rulesSig: 'v1:aaaaaaaa', coreTopicsLoaded: true, inputsSig: 'v1:100'
    })).toBe('hit');
  });

  it('④ 规则变更优先于输入完整度（两个都变了也只判一次 stale）', function() {
    expect(resolvePlanSnapshotFreshness(
      { status: 'hit', rulesSig: 'v1:aaaaaaaa', inputsSig: 'v1:110' },
      { rulesSig: 'v1:bbbbbbbb', coreTopicsLoaded: true, inputsSig: DONE }
    )).toBe('stale');
  });

  it('⑤ 输入完整度完全一致 ⇒ hit（不制造无意义重算，§32）', function() {
    expect(resolvePlanSnapshotFreshness(
      { status: 'hit', rulesSig: 'v1:aaaaaaaa', inputsSig: DONE },
      { rulesSig: 'v1:aaaaaaaa', coreTopicsLoaded: true, inputsSig: DONE }
    )).toBe('hit');
  });

  it('⑥ 🔴 库里还没有 inputs_sig 列（降级模式）⇒ 忽略这一位判 hit（⛔ 不许每次开页面都重算）', function() {
    expect(resolvePlanSnapshotFreshness(
      { status: 'hit', rulesSig: 'v1:aaaaaaaa', inputsSig: '' },
      { rulesSig: 'v1:aaaaaaaa', coreTopicsLoaded: true, inputsSig: DONE, inputsSigSupported: false }
    )).toBe('hit');
    // 但规则指纹变了仍然要判 stale（降级只豁免「输入完整度」这一位，不豁免规则）
    expect(resolvePlanSnapshotFreshness(
      { status: 'hit', rulesSig: 'v1:aaaaaaaa', inputsSig: '' },
      { rulesSig: 'v1:bbbbbbbb', coreTopicsLoaded: true, inputsSig: DONE, inputsSigSupported: false }
    )).toBe('stale');
  });
});

describe('shouldPersistPlanSnapshot · 写库准入（§11 覆盖保护 + §32 幂等）', function() {
  it('① 🔴 读档失败 / 表不存在 ⇒ 绝不覆盖（不知道库里原来有没有好存档）', function() {
    expect(shouldPersistPlanSnapshot({ status: 'error' }).write).toBe(false);
    expect(shouldPersistPlanSnapshot({ status: 'error' }).reason).toBe('read-failed');
    expect(shouldPersistPlanSnapshot({ status: 'unavailable' }).write).toBe(false);
  });

  it('② 存档有效 / 读取中 / 状态未知 ⇒ 不写', function() {
    ['hit', 'loading', 'weird'].forEach(function(st) {
      expect(shouldPersistPlanSnapshot({ status: st }).write).toBe(false);
    });
  });

  it('③ 🔴 任何日期只要【表里确实没有】且算出干净定稿 ⇒ 写（不再限今天）', function() {
    const r = shouldPersistPlanSnapshot({ status: 'empty', selectionSig: '', nextSelectionSig: 'nA|b|p1|x' });
    expect(r.write).toBe(true);
    expect(r.reason).toBe('first-or-changed');
  });

  it('④ 结论没变 ⇒ 幂等跳过（§32 不制造无意义写请求）', function() {
    const r = shouldPersistPlanSnapshot({
      status: 'empty', selectionSig: 'nA|b|p1|x', nextSelectionSig: 'nA|b|p1|x'
    });
    expect(r.write).toBe(false);
    expect(r.reason).toBe('selection-unchanged');
  });

  it('⑤ 结论变了 ⇒ 写', function() {
    expect(shouldPersistPlanSnapshot({
      status: 'empty', selectionSig: 'nA|b|p1|x', nextSelectionSig: 'nB|b|p1|x'
    }).write).toBe(true);
  });

  it('⑥ 🔴🔴 stale 即使选票一模一样也【必须写一次】更新 rules_sig（否则无限重算）', function() {
    const r = shouldPersistPlanSnapshot({
      status: 'stale', selectionSig: 'nA|b|p1|x', nextSelectionSig: 'nA|b|p1|x'
    });
    expect(r.write).toBe(true);
    expect(r.reason).toBe('rules-changed');
  });

  it('⑦ 存档损坏 ⇒ 允许用干净结论修复覆盖', function() {
    expect(shouldPersistPlanSnapshot({ status: 'corrupt' }).reason).toBe('repair-corrupt');
    expect(shouldPersistPlanSnapshot({ status: 'corrupt' }).write).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// ★★ [RULES-BUMP-ALL 2026-11-14 用户口径] 规则版本升级（bump `TVRB_RULES_VERSION`）⇒ **任何日期都重算**。
//
// 用户原话（逐字）：「这不是很合理吧，我之前那次因为切换日期它总是换结果，我想它一次给结果，
//   切换日期也不用结果总是换来换去会误导判断，他们才冻住，这不是我想要的，**这个和规则没有关吧**？
//   你重算一遍」
// ⇒ 推翻既有的 [RULES-BUMP-GUARD]（那条只让今天过期、历史日保持定稿）。
//   当初冻住历史日的真实目的只是「同一天反复重算导致结果飘移」，与「规则升级要不要回算历史」无关。
//   「不飘移」由别处保证：内容 hash 指纹 + revision 幂等 + shouldPersistPlanSnapshot 的「结论没变不写」。
// ══════════════════════════════════════════════════════════════════════════════════════════
describe('tvrb · [RULES-BUMP-ALL] 规则升级后历史日也重算', () => {
  const SNAP = { status: 'hit', rulesSig: 'v1:aaaaaaaa', inputsSig: 'v1:111' };
  const OPTS = { rulesSig: 'v2:bbbbbbbb', coreTopicsLoaded: true, inputsSig: 'v1:111' };

  it('规则变了 ⇒ stale（今天与历史日同一判据，⛔ 不再有「历史日例外」）', () => {
    expect(resolvePlanSnapshotFreshness(SNAP, OPTS)).toBe('stale');
  });

  it('⛔ 已删除 `allowRulesInvalidation` 入参：传 false 也不再能冻结历史日（回归锁）', () => {
    // 旧实现：allowRulesInvalidation === false ⇒ 'hit'（历史日保持定稿）。
    // 用户本轮明确否决 ⇒ 即使老调用方还传这个键，也必须判 stale。
    expect(resolvePlanSnapshotFreshness(SNAP, Object.assign({}, OPTS, { allowRulesInvalidation: false }))).toBe('stale');
    expect(resolvePlanSnapshotFreshness(SNAP, Object.assign({}, OPTS, { allowRulesInvalidation: true }))).toBe('stale');
    const src = readFileSync('src/logic/topicvolratio/plan-snapshot-rules.js', 'utf8');
    expect(src).not.toContain("if (o.allowRulesInvalidation === false) return 'hit';");
    // composable 两处调用点也不许再传
    const comp = readFileSync('src/composables/useTopicVolRatioBoard.js', 'utf8');
    expect((comp.match(/allowRulesInvalidation: /g) || []).length).toBe(0);
    // ⚠️ 只锁【调用形态】：保留的注释里还会提到 `_bjTodayKey`（记录这条护栏的历史），那不算调用。
    expect(comp).not.toContain('_bjTodayKey() {');
  });

  it('规则没变时不受影响（§11 零行为变化）', () => {
    const same = { status: 'hit', rulesSig: 'v2:bbbbbbbb', inputsSig: 'v1:111' };
    expect(resolvePlanSnapshotFreshness(same, OPTS)).toBe('hit');
    const broken = { status: 'hit', rulesSig: 'v2:bbbbbbbb', inputsSig: 'v1:110' };
    expect(resolvePlanSnapshotFreshness(broken, OPTS)).toBe('stale');
  });

  it('版本常量已 bump 到 14（[RULES-BUMP-ALL] + [MID-TOP20] 都改了选股结论 = v14）', () => {
    expect(TVRB_RULES_VERSION).toBe(15);
  });

  // ★★ [ABN-MAINBOARD-GUARD 2026-11-14] 第三十四条「全场十日涨幅最高票」只认主板。
  //   用户原话（逐字）：「我要求的是主板的异动的有提醒，非主板就不要考虑在里面，
  //   像历史日期的10月28日，为什么把非主板的也考虑在里面呢……只有主板的才有这个条件。」
  //   配套约束：候选池【一行未改】仍是 883410 + 观察组 + 龙头组 + 20 日补位
  //   （用户明确否决过「收窄成 883410 名单」的提议：「不要乱改啊……不要画蛇添足。」）
  it('[ABN-MAINBOARD-GUARD] 6 处异动取数全部带主板过滤，且过滤只按板块不按名单收窄', () => {
    const plan = readFileSync('src/logic/topicvolratio/tvrb-plan.js', 'utf8');
    const eligibleLine = 'makeAbnMainBoardFilter(isMainBoardRankEligible, getStockCode)';
    // ① 工厂在规则层就位，且只依赖「板块资格 + 代码查询」两件事
    expect(plan).toContain(eligibleLine);
    expect(plan).toContain('export function makeAbnMainBoardFilter');
    // ② 规则层三处候选池一律走过滤后的 maxRangePctOf
    expect(plan).toContain('maxRangePctOf(o.pctMap, _abnEligible)');
    expect(plan).toContain('maxRangePctOf(o.prevAuctionLeg10, _abnEligible)');
    expect(plan).toContain('maxRangePctOf(o.prevRange10, _abnEligible)');
    // ③ 显示层总约束同样过滤（历史定稿日走另一条路，漏了就等于没改）
    const overlay = readFileSync('src/logic/topicvolratio/abnormal-overlay.js', 'utf8');
    expect(overlay).toContain(eligibleLine);
    expect(overlay).toContain('maxRangePctOf(x.todayMap, eligible)');
    expect(overlay).toContain('maxRangePctOf(x.prevAucMap, eligible)');
    expect(overlay).toContain('maxRangePctOf(x.prevCloseMap, eligible)');
    // ④ ⛔ 不许把候选池收窄成「只有 883410 / 只有观察组」——用户点名禁止画蛇添足
    expect(plan).not.toContain('883410');
    expect(overlay).not.toContain('883410');
  });

  // ★★ [CAP-97 2026-11-13 晚间] 阈值改动必须三件套同时落地，漏一件就等于没改：
  //   ① 常量 97  ② 规则指纹 bump  ③ sw.js CACHE 换名。
  it('[CAP-97-GUARD] 禁选上限 = 97，且规则指纹 / SW 缓存都已随阈值升级', async () => {
    const { TVRB_RANGE10_CAP, TVRB_RANGE10_ABNORMAL } = await import('./tvrb-constants.js');
    expect(TVRB_RANGE10_CAP).toBe(97);
    expect(TVRB_RANGE10_ABNORMAL).toBe(100);
    expect(TVRB_RULES_VERSION).toBeGreaterThanOrEqual(10);
    const sw = readFileSync('public/sw.js', 'utf8');
    expect(sw).toContain("var CACHE = 'biga-static-v56'");
  });

  // ★★ [FULL-MARKET-GUARD 2026-11-13 用户当场纠正] 整类护栏：
  //   ＞97% 不许再被做成「票级顺延」，否则 11-13 那次「我理解错了」会原样复发。
  it('[FULL-MARKET-GUARD] near 与 abnormal 后果相同：全场禁买判据 + 无票级顺延 + 手册口径', async () => {
    const { isOverRange10Cap, resolveAbnormalFact } = await import('./abnormal-10d.js');
    // ① 97~100 与 ≥100 都判【全场禁买】
    expect(isOverRange10Cap(98)).toBe(true);
    expect(isOverRange10Cap(101)).toBe(true);
    expect(isOverRange10Cap(97)).toBe(false);
    expect(resolveAbnormalFact({ leaderName: 'L', leaderPctToday: 98, leaderPctPrev: 70, rows: [] }).show).toBe(true);
    // ② ⛔ 不许再有「跳过该龙位、顺延下一只」的票级实现
    const blocks = readFileSync('src/logic/topicvolratio/tvrb-blocks.js', 'utf8');
    expect(blocks).not.toContain('skippedAbnormal.map');
    expect(blocks).toContain('skippedAbnormalNames: []');
    // ③ 规则手册写明「全场整片灰 / 波及所有票」，⛔ 不再写「顺延下一只」当结论
    const lines = readFileSync('src/logic/topicvolratio/tvrb-rules-lines.js', 'utf8');
    expect(lines).toContain('波及到所有的票');
    expect(lines).toContain('整个市场【整片灰');
    // ④ 三件套版本链
    expect(TVRB_RULES_VERSION).toBe(15);
    expect(readFileSync('public/sw.js', 'utf8')).toContain("var CACHE = 'biga-static-v56'");
  });

  // ★★ [RULE-BUMP-GUARD 2026-11-13] 用户报障「现在刷新并没有生效」的整类根因锁。
  //   第三十四条上线时 `TVRB_RULES_VERSION` 忘了 bump ⇒ 11-13 那份 v6 定稿存档 rules_sig
  //   与当前指纹一致 ⇒ resolvePlanSnapshotFreshness 判 hit ⇒ 直接读旧结论，新规则永不参与重算。
  //   ⛔ 以后凡改了选股结论（龙位 / 买点通道 / 空仓标语），必须同步 bump 本常量，否则改了等于没改。
  it('[RULE-BUMP-GUARD] 规则手册已含第三十四条 ⇒ 规则版本不得停留在 v6', () => {
    const lines = readFileSync('src/logic/topicvolratio/tvrb-rules-lines.js', 'utf8');
    expect(lines).toContain('第三十四');
    expect(TVRB_RULES_VERSION).toBeGreaterThanOrEqual(7);
  });

  it('[SW-BUMP-GUARD] 规则版本变了 ⇒ sw.js 的 CACHE 名必须同步换掉', () => {
    // 只锁【单向】：规则升级却没换缓存名 ⇒ 手机端仍吃旧 index.html / 旧 JS。
    // 反过来（只换缓存名、规则没变）是合法的前端修版，⛔ 不能在这里误伤。
    const sw = readFileSync('public/sw.js', 'utf8');
    const m = /var CACHE = 'biga-static-v(\d+)'/.exec(sw);
    expect(m).not.toBeNull();
    if (TVRB_RULES_VERSION > 6) {
      expect(Number(m[1])).toBeGreaterThan(41);
    }
  });

});

// ══════════════════════════════════════════════════════════════════════════════════════════
// ★★ [TOPIC-LIB-SIG 2026-11-12 用户口径] 题材库（个股题材）变了 ⇒ **历史日也要重算**。
//
// 用户原话：「比如我在今天改了题材，我希望历史日期题材量比选股也会根据这个题材改变做改变……
//   之前那些选票也要根据我手动改的题材变化」。
// ⚠️ [RULES-BUMP-ALL 2026-11-14] 起两者一致：规则/核心词变了、题材库变了，**都连历史一起重算**。
// ══════════════════════════════════════════════════════════════════════════════════════════
describe('tvrb · [TOPIC-LIB-SIG] 题材库指纹变了 ⇒ 历史日也重算', () => {
  const CORE = [{ name: 'AI应用', synonyms: ['人工智能'] }];

  it('指纹第二段相同、第三段不同 ⇒ stale（历史日也一样）', () => {
    const oldSig = buildRulesFingerprint(CORE, 'tl1:aaaa1111');
    const newSig = buildRulesFingerprint(CORE, 'tl1:bbbb2222');
    const snap = { status: 'hit', rulesSig: oldSig, inputsSig: 'v1:111' };
    const opts = { rulesSig: newSig, coreTopicsLoaded: true, inputsSig: 'v1:111' };
    expect(resolvePlanSnapshotFreshness(snap, opts)).toBe('stale');
  });

  it('题材库没变 ⇒ hit（不抖动）', () => {
    const sig = buildRulesFingerprint(CORE, 'tl1:aaaa1111');
    const snap = { status: 'hit', rulesSig: sig, inputsSig: 'v1:111' };
    const opts = { rulesSig: sig, coreTopicsLoaded: true, inputsSig: 'v1:111' };
    expect(resolvePlanSnapshotFreshness(snap, opts)).toBe('hit');
  });

  it('当前算不出题材库指纹（空）⇒ hit（§10：算不出来 ≠ 变了）', () => {
    const snap = { status: 'hit', rulesSig: 'v3:bbbbbbbb:tl1:aaaa1111', inputsSig: 'v1:111' };
    const opts = { rulesSig: 'v3:bbbbbbbb', coreTopicsLoaded: true, inputsSig: 'v1:111' };
    expect(resolvePlanSnapshotFreshness(snap, opts)).toBe('hit');
  });

  it('老存档没有第三段（升级前的行）⇒ 自愈一次（stale）', () => {
    const snap = { status: 'hit', rulesSig: 'v3:bbbbbbbb', inputsSig: 'v1:111' };
    const opts = { rulesSig: 'v3:bbbbbbbb:tl1:aaaa1111', coreTopicsLoaded: true, inputsSig: 'v1:111' };
    expect(resolvePlanSnapshotFreshness(snap, opts)).toBe('stale');
  });

  it('指纹确定性：内容相同 ⇒ 跨调用恒相同；内容不同 ⇒ 不同', () => {
    expect(buildRulesFingerprint(CORE, 'tl1:aaaa1111')).toBe(buildRulesFingerprint(CORE, 'tl1:aaaa1111'));
    expect(buildRulesFingerprint(CORE, 'tl1:aaaa1111')).not.toBe(buildRulesFingerprint(CORE, 'tl1:bbbb'));
  });

  // ★★ [CORE-PURGE-SYNC 2026-11-14 用户报障] 11-05 回归：
  //   用户原话「比如11月5日，还显示羊字辈题材选择理由，我都删除了，为什么还显示呢？」
  //   库内：11-05 存档 = `v11:d83ebd81:tl1:7404491d`，当时规则版本已 bump 到 12。
  //   旧实现先比 base 段（v11≠v12）⇒ 直接落到「规则升级」分支 ⇒ 历史日 hit
  //   ⇒ **永远走不到「题材库变了」那一支**，历史日的题材更新被规则版本升级永久挡住。
  it('★ 11-05 回归：规则版本段变了 + 题材库段也变了 ⇒ 历史日必须 stale', () => {
    const snap = { status: 'hit', rulesSig: 'v11:d83ebd81:tl1:7404491d', inputsSig: 'v1:111' };
    const opts = {
      rulesSig: 'v12:11112222:tl1:99998888',   // 规则 bump v11→v12 + 删了题材（指纹变）
      coreTopicsLoaded: true, inputsSig: 'v1:111'
    };
    expect(resolvePlanSnapshotFreshness(snap, opts)).toBe('stale');
  });

  it('★ [RULES-BUMP-ALL] 规则版本变了、题材库没变 ⇒ 现在【也】stale（历史日不再冻结）', () => {
    const snap = { status: 'hit', rulesSig: 'v11:d83ebd81:tl1:7404491d', inputsSig: 'v1:111' };
    const opts = { rulesSig: 'v12:11112222:tl1:7404491d', coreTopicsLoaded: true, inputsSig: 'v1:111' };
    // 用户 2026-11-14 明确要求「规则和冻历史没有关系，你重算一遍」⇒ 这里从 'hit' 改成 'stale'。
    expect(resolvePlanSnapshotFreshness(snap, opts)).toBe('stale');
  });

  it('★ 判据顺序锁：题材库段的比较必须在 base 段之前（否则规则一 bump 历史就永久不更新）', () => {
    const src = readFileSync('src/logic/topicvolratio/plan-snapshot-rules.js', 'utf8');
    const iTop = src.indexOf("if (curTop && oldTop !== curTop) return 'stale';");
    const iBase = src.indexOf("if (oldBase === curBase) return 'hit';");
    expect(iTop).toBeGreaterThan(-1);
    expect(iBase).toBeGreaterThan(iTop);
    // ⛔ 不许再出现「先按 base 相等分叉，再在里面比 top」的旧写法
    expect(src).not.toContain('if (oldBase === curBase) {\n      // 只差题材库那一段');
  });
});
