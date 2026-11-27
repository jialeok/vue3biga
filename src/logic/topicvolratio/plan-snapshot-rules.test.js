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

/** [SW-CACHE] sw.js 的 CACHE 版本号。断言写成「≥ 基线」：
 *  既能抓住「改了文案却忘记 bump」（版本还停在旧号，一定小于基线），
 *  又不用每轮发布都回来改数字（旧的精确断言每轮都要改 4 处，改漏就是假红）。 */
function _swCacheNo(text) {
  const m = /var CACHE = 'biga-static-v(\d+)'/.exec(String(text || ''));
  return m ? Number(m[1]) : 0;
}

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

  it('版本常量已 bump（[DEV-RULE-AUC-ONLY] 选股侧偏离一律竞价 ⇒ 11-24 华东重机解灰 ⇒ 历史日重算）', () => {
    // ★★ [YIZI-NO-SHIFT 2026-11-20 用户口径] 竞价一字【照选 + 占一档】取代「顺延下一龙位」
    //   ⇒ 选股结论会变（11-20 盛剑科技 / 兴欣新材就是这一条翻的）⇒ 历史日必须重算，版本 27 → 28。
    // ★★ [DEV-RULE 2026-11-25 用户口径] 监管异动从「自定义十日涨幅 ＞ 97%」换成「官方严重异常波动」
    //   ⇒ 异动日整体位移（11-12 → 11-11 等）⇒ 历史日必须按新口径重算覆盖，版本 28 → 29。
    // ★★ [MARKET-DRAGON-ONLY / ROW-GRAY / HOT-TOPIC-SYNC] 29 → 30 → 31 → 32（各次选股结论变化）。
    // ★★ [DEV-RULE-AUC-ONLY 2026-11-25 用户报障] 选股侧偏离值一律 9:25 竞价，历史日不再吃收盘
    //   ⇒ 11-24 华东重机（收盘 near / 竞价 watch）解除灰化、回到买点侧 ⇒ 32 → 33。
    // ★★ [CASE-1123-HAILI 2026-11-26] 第二十九条通道文案与判定一致化 + 在列次数门控只认真数据
    //   （11-23 海立股份的说明从「按龙位」改成「题材内选票」）⇒ 存档文案变 ⇒ 33 → 34。
    // ★★ [ABN-TB-MKTDRAGON 2026-11-26 用户口径] 第三十四条·延伸的 D-2 触发源收成【市龙一】
    //   （11-24 北纬科技不是市龙一 ⇒ 不再触发「异动第三天」）⇒ 选股结论变 ⇒ 34 → 35。
    // ★★ [TEMP-CORE-SCOPE 2026-11-27 用户报障] 前五事实化的题材串按该日隔离未生效的临时题材
    //   （11-12 提示板不再出现 11-18 才建的「羊字辈」）⇒ 老题材 / 新题材结论变 ⇒ 35 → 36。
    // ★★ [EBB-TOPIC-MEMBER 2026-11-27 用户口径] 第二十条买点侧分流：二次确认退潮的排除粒度从
    //   【题材块】细化到【题材字段】（11-16 大消费 4 只 − 日出东方 = 3 只 < 4 ⇒ 大消费不入选）
    // ★★ [EBB-TOPIC-TEMP 2026-11-27 用户口径] 二次确认退潮的禁买词集合 = 总龙原有题材 + 当日生效
    //   且总龙自己也沾的临时题材词（11-16 日出东方灰化 + 【题材退潮不选】）⇒ 38 → 39。
    //   ⇒ 选股结论变 ⇒ 36 → 37 → 38 → 39。
    expect(TVRB_RULES_VERSION).toBe(44);
  });

  // ★★ [ABN-MAINBOARD-GUARD 2026-11-14] 第三十四条「全场十日涨幅最高票」只认主板。
  //   用户原话（逐字）：「我要求的是主板的异动的有提醒，非主板就不要考虑在里面，
  //   像历史日期的10月28日，为什么把非主板的也考虑在里面呢……只有主板的才有这个条件。」
  //   配套约束：候选池【一行未改】仍是 883410 + 观察组 + 龙头组 + 20 日补位
  //   （用户明确否决过「收窄成 883410 名单」的提议：「不要乱改啊……不要画蛇添足。」）
  it('[ABN-MAINBOARD-GUARD] 三十四·b 的 D-2 触发源必须走 30 日榜（⛔ 不许再「十日涨幅挑最高票」）', () => {
    const plan = readFileSync('src/logic/topicvolratio/tvrb-plan.js', 'utf8');
    // ① 工厂仍住在规则层（`tvrb-plan.js`）并对外导出 —— 判据唯一来源，⛔ 不许在视图里另写一份
    expect(plan).toContain('export function makeAbnMainBoardFilter');
    // ② ★★ [MARKET-DRAGON-ONLY 2026-11-25] 用点从「两个」收回到「一个」：
    //   第三十四条的触发源已固定为市龙一（30 日榜本身只主板 ⇒ 结构性满足），
    //   所以 **显示层兜底（abnormal-overlay）里不应再出现这层过滤** —— 出现就说明
    //   有人把「扫全市场挑最高票」那套错口径又接了回来。
    const overlay = readFileSync('src/logic/topicvolratio/abnormal-overlay.js', 'utf8');
    // ⚠️ 断言必须锁【调用/导入形态】，⛔ 不能锁裸标识符：头注释里还会提到这两个名字
    //   （记的是「为什么删掉」的历史），锁裸词会把一段正当注释判成违规 —— 本项目踩过这个坑。
    expect(overlay).not.toContain('makeAbnMainBoardFilter(');
    expect(overlay).not.toContain('pickRedLineSource(');
    expect(overlay).not.toContain("import { resolveAbnormalFact, pickRedLineSource }");
    // ③ ★★ [ABN-TB-MKTDRAGON 2026-11-26 用户口径] 三十四·b 的 D-2 触发源已收成【市龙一】：
    //   必须复用 `buildTvrbAuctionBoard30`（9:26 竞价口径 30 日榜第 1 名·主板），
    //   ⛔ 不许再从「D-2 十日涨幅 Map」里挑最高票 —— 那正是 11-24 北纬科技误触发的来源。
    const board = readFileSync('src/composables/useTopicVolRatioBoard.js', 'utf8');
    expect(board).toContain('buildTvrbAuctionBoard30(pair[0], pair[1])');
    expect(board).not.toContain('maxRangePctOf(abnPrev2');
    expect(board).not.toContain('makeAbnMainBoardFilter(');
    expect(plan).toContain('export function maxRangePctOf');
    // ④ ★★ [MARKET-DRAGON-ONLY 2026-11-25] 第三十四条的触发源：唯一 = 市龙一
    //   （`ebbCtx.mktDragon1`，来自 30 日涨幅榜第 1 名·主板）。「从一批票里挑越线最严重那只」
    //   的函数与它的依赖必须消失 —— 它们就是 11-24 误报全场空仓的直接来源。
    const abn = readFileSync('src/logic/topicvolratio/abnormal-10d.js', 'utf8');
    // ⚠️ 同样锁【调用/导入形态】，⛔ 不锁裸词（头注释里正当地提到这两个名字，记的是删除理由）
    expect(abn).not.toContain('export function pickRedLineSource');
    expect(abn).not.toContain('pickSevereDeviation(');
    expect(abn).not.toContain('pickSevereDeviation }');
    expect(abn).not.toContain('export function pickAbnormalSource');   // 旧「十日涨幅最高票」已废除
    expect(abn).not.toContain('ABNORMAL_KIND_STOCK');                  // 「入选票异动」形态已删除
    expect(plan).toContain('o.ebbCtx.mktDragon1');
    // ⑤ ⛔ 不许把候选池收窄成「只有 883410 / 只有观察组」——用户点名禁止画蛇添足
    expect(plan).not.toContain('883410');
    expect(overlay).not.toContain('883410');
  });

  // ★★ [CAP-97-GUARD 2026-11-26 用户口径：旧自定义阈值彻底退役]
  //   用户原话：「我今天都去掉自定义的设定95%了，怎么还提到自定义的监管异动，不是已经去除干净了吗？
  //     现在都是以官方偏离值为准了……不需要保留之前自定义那个规则了。」
  //   ⇒ 本用例从「常量仍在」【反向改成】「常量必须不存在」：
  //     旧常量只要还留在仓库里，就会有人拿它写文案，进而被读成「现役禁选上限」——
  //     本轮事故（界面上还在讲 97%）就是这么来的。⛔ 别再改回 toBe(97)。
  it('[CAP-97-GUARD] 旧自定义阈值常量必须已删除 + 版本链未倒退', async () => {
    const consts = await import('./tvrb-constants.js');
    expect(consts.TVRB_RANGE10_CAP).toBeUndefined();
    expect(consts.TVRB_RANGE10_ABNORMAL).toBeUndefined();
    const raw = readFileSync('src/logic/topicvolratio/tvrb-constants.js', 'utf8');
    expect(raw).not.toMatch(/export const TVRB_RANGE10_CAP/);
    expect(raw).not.toMatch(/export const TVRB_RANGE10_ABNORMAL/);
    expect(TVRB_RULES_VERSION).toBeGreaterThanOrEqual(10);
    const sw = readFileSync('public/sw.js', 'utf8');
    expect(_swCacheNo(sw)).toBeGreaterThanOrEqual(67);   // [SW-CACHE] ≥ 本轮基线即可，⛔ 不用每轮改数字
  });

  // ★★ [FULL-MARKET-GUARD 2026-11-13 用户当场纠正] 整类护栏：
  //   ＞红线 不许再被做成「票级顺延」，否则 11-13 那次「我理解错了」会原样复发。
  //   ★★ [DEV-RULE 2026-11-25 口径整体替换] 判据从「十日涨幅 ＞ 97%」换成「官方严重异常波动」，
  //     并新增一条同样重要的反向锁：**near（逼近红线）不许引发全场空仓** ——
  //     用户原话：「不含「偏离放大（留意）」，因为这个不是很严重」。
  it('[FULL-MARKET-GUARD] severe 才全场空仓、near 只禁这一只：判据 + 无票级顺延 + 手册口径', async () => {
    const { isOverOfficialRedLine, isDeviationNearOrOver, resolveAbnormalFact } =
      await import('./abnormal-10d.js');
    // 夹具只造「档位」这一件事（阈值 → 档位的换算由 deviation-rule-facts.test.js 用真实
    //   computeDeviation 锁），本用例锁的是【后果】。
    const near = { ok: true, stage: 'near', dev10: 95.2, dev30: null };
    const severe = { ok: true, stage: 'severe', dev10: 100.14, dev30: null };
    const unknown = { ok: false, stage: 'unknown', dev10: null, dev30: null };
    // ④ near ⇒ 只进第三十六条（这只票不买），不构成监管异动（⛔ 不空仓）
    expect(isDeviationNearOrOver(near)).toBe(true);
    expect(isOverOfficialRedLine(near)).toBe(false);
    expect(resolveAbnormalFact({
      leaderName: 'L', leaderDevToday: near, leaderDevPrev: near
    }).show).toBe(false);
    // ② severe 才构成监管异动 ⇒ 第三十四条全场空仓
    expect(isDeviationNearOrOver(severe)).toBe(true);
    expect(isOverOfficialRedLine(severe)).toBe(true);
    expect(resolveAbnormalFact({
      leaderName: 'L', leaderDevToday: severe, leaderDevPrev: severe
    }).show).toBe(true);
    // ③ §10 判不出 ⇒ 两个判据都 false，⛔ 不许把「没算出来」当成「越线」也不当成「安全」
    expect(isDeviationNearOrOver(unknown)).toBe(false);
    expect(isOverOfficialRedLine(unknown)).toBe(false);
    expect(isOverOfficialRedLine(null)).toBe(false);
    // ④ ★★ [MARKET-DRAGON-ONLY 2026-11-25] 「入选票触发」这一支**已删除**：
    //   市龙一自己判不出 / 没越线时，多传一份 rows 也不许改变结论。
    //   ⛔ 用户原话：「不是每只股票一异动，都要提示这个的，因为很多股票都不是市龙一……
    //     他们只是属于个股异动，和题材无关。」
    expect(resolveAbnormalFact({
      leaderName: 'L', leaderDevToday: unknown, leaderDevPrev: unknown,
      rows: [{ name: '逼近票', dev: near }]
    }).show).toBe(false);
    const byStock = resolveAbnormalFact({
      leaderName: 'L', leaderDevToday: unknown, leaderDevPrev: unknown,
      rows: [{ name: '越线票', dev: severe }]
    });
    expect(byStock.show).toBe(false);      // ★ 旧口径这里是 true + kind='stock'（11-24 误报的入口）
    expect(byStock.kind).toBe('');
    // ⑤ ⛔ 不许再有「跳过该龙位、顺延下一只」的票级实现
    const blocks = readFileSync('src/logic/topicvolratio/tvrb-blocks.js', 'utf8');
    expect(blocks).not.toContain('skippedAbnormal.map');
    expect(blocks).toContain('skippedAbnormalNames: []');
    // ⑥ 规则手册写明「波及所有票 / 整片灰」，⛔ 不再写「顺延下一只」当结论
    const lines = readFileSync('src/logic/topicvolratio/tvrb-rules-lines.js', 'utf8');
    expect(lines).toContain('波及所有票');
    expect(lines).toContain('整片灰');
    // ⑦ 大字标语同样要写清「整个市场整片灰」（屏幕第一眼能看到的唯一一句）
    const abn = readFileSync('src/logic/topicvolratio/abnormal-10d.js', 'utf8');
    expect(abn).toContain('整个市场整片灰');
    // ⑧ 三件套版本链（★ [ABN-TB 2026-11-17] 第三十四条延伸上线 ⇒ 20 → 21；
    //   ★★ [RULE-35 2026-11-18] 第三十五条【30日涨幅抱团】上线【改变选股结论】⇒ 21 → 22；
    //   ★★ [RULE-35-SETTLE 2026-11-19] 第三十五条定稿门控 + 成员行兜底修复 ⇒ 22 → 23；
    //   ★★ [RULE-35-SRC 2026-11-19] 30 日榜数据源优先级修复（空 Map 挡住结果表）⇒ 23 → 24；
    //   ★★ [RULE-35-FORWARD 2026-11-19] 第三十五条的池子参数没转发 + 那一块没有渲染通道 ⇒ 24 → 25；
    //   ★★ [BUYABLE-COUNT 2026-11-19] 「选股 N 只」改数能下单的只数（pickCount 是屏幕上直接看到的数字）⇒ 25 → 26）
    //   ★★ [YIZI-NO-SHIFT 2026-11-20] 竞价一字【照选 + 占一档】取代「顺延下一龙位」⇒ 选股结论变 ⇒ 26 → 27 → 28
    //   ★★ [DEV-RULE 2026-11-25] 监管异动换官方偏离值口径（异动日位移 11-12 → 11-11）⇒ 28 → 29
    //   ★★ [MARKET-DRAGON-ONLY 2026-11-25] 第三十四条只认市龙一 ⇒ 29 → 30
    //   ★★ [ROW-GRAY 2026-11-25] 第三十六条补【行级灰块】渲染旗子 ⇒ 30 → 31
    //   ★★ [HOT-TOPIC-SYNC 2026-11-25] hot 派生题材缓存重建（11-25 大消费补 4 只）⇒ 31 → 32
    //   ★★ [DEV-RULE-AUC-ONLY 2026-11-25] 选股侧偏离一律竞价（11-24 华东重机解灰）⇒ 32 → 33
    //   ★★ [CASE-1123-HAILI 2026-11-26] 第二十九条通道文案 + 在列次数门控 ⇒ 33 → 34
    //   ★★ [ABN-TB-MKTDRAGON 2026-11-26] 三十四·b 的 D-2 触发源收成市龙一 ⇒ 34 → 35
    //   ★★ [TEMP-CORE-SCOPE 2026-11-27] 前五事实化按该日隔离未生效的临时题材（11-12 不再取羊字辈）⇒ 35 → 36
    //   ★★ [EBB-TOPIC-MEMBER 2026-11-27] 退潮题材排除粒度：题材块 → 题材字段（11-16 大消费不入选）⇒ 36 → 37 → 38
    //   ★★ [EBB-TOPIC-TEMP 2026-11-27] 禁买集合 = 原有题材 + 临时题材牵连（11-16 日出东方灰化）⇒ 38 → 39
    expect(TVRB_RULES_VERSION).toBe(44);
    expect(_swCacheNo(readFileSync('public/sw.js', 'utf8'))).toBeGreaterThanOrEqual(67);
  });

  // ★★ [ROW-GRAY 2026-11-25 用户报障] 「逼近红线不买」只打标签、没有那一只股票的灰色块。
  //   三段契约必须同时存在，缺一段就又回到「标签说不能买、看板上还是彩色可买」：
  //   Logic 下发旗子 → UI 只给这一行挂类 → CSS 用既有灰化值渲染（⛔ 不灰整个题材块）。
  it('[ROW-GRAY] 第三十六条的行级灰化从 Logic 到 UI 到 CSS 闭环', () => {
    const plan = readFileSync('src/logic/topicvolratio/tvrb-plan.js', 'utf8');
    expect(plan).toContain('p.noBuyRowGray = true');
    const vue = readFileSync('src/components/topicvolratio/TvrbBuyBlock.vue', 'utf8');
    expect(vue).toContain("'tvrb-row-nobuy-gray': p.noBuyRowGray");
    expect(vue).not.toContain("'tvrb-row-nobuy-gray': block.noBuyRowGray"); // ⛔ 只灰行，不灰块
    const css = readFileSync('src/assets/css/topic-vol-ratio-board.css', 'utf8');
    expect(css).toContain('.tvrb-row.tvrb-row-nobuy-gray');
    expect(css).toContain('grayscale(1)');
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
    // ⚠️ [TDAY-FREEZE 2026-11-16] 这一句从单行 return 变成了带分支的块（先判 freezeSettledDay），
    //   所以按「判据首行」定位，⛔ 不再匹配整句 return。
    const iTop = src.indexOf('if (curTop && oldTop !== curTop) {');
    const iBase = src.indexOf("if (oldBase === curBase) return 'hit';");
    expect(iTop).toBeGreaterThan(-1);
    expect(iBase).toBeGreaterThan(iTop);
    // ⛔ 不许再出现「先按 base 相等分叉，再在里面比 top」的旧写法
    expect(src).not.toContain('if (oldBase === curBase) {\n      // 只差题材库那一段');
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// ★★ [TDAY-FREEZE 2026-11-16 用户报障 · 整类修复] **当天已定稿 ⇒ 题材库段变化不改当天结论**。
//
// 用户原话（逐字）：「今天11月16日，题材量比选股不知道为什么？每到收盘又变了，
//   早上还是北纬科技，文投控股，日出东方，现在收盘又变成了我只有日出东方了，
//   之前修过好几次，我都说了按照竞价口径来，收盘后也不能变，现在为什么还在变？
//   是不是我手动导入涨跌停看板股票题材原因？还是什么原因？」
//
// 库内取证（11-16 真实时间戳，不是推测）：
//   · `tvrb_plan_snapshot(2026-11-16)`：`created_at=01:27:54Z`(09:27 北京) `revision=1`
//     ⇒ `settled_at=08:27:01Z`(16:27 北京) `revision=2` ⇒ 选票从 3 只变 1 只
//   · `stock_topics` 在 `08:25:08Z ~ 08:25:15Z`(16:25 北京) 被写入 10 行
//   · 那 10 只票【全部不在】当日 51 只 `auction_watchlist` 名单里
// ⇒ 题材内容对「当天选股」零信息增益，但指纹变了 ⇒ 旧实现无条件 stale ⇒ 白重算一次。
//
// ⛔ 冻结范围严格三条（越界就是新 bug）：
//   ① 只冻结【题材库段】；base 段（规则版本 / 核心词）照旧比，用户主动改规则必须立即生效；
//   ② 只冻结【今天】的存档（调用方按 `date === 今天` 传 freezeSettledDay）；
//   ③ 只冻结【输入完整】(v1:111)的存档；残缺结论仍允许数据补齐后自愈一次（§10）。
// ══════════════════════════════════════════════════════════════════════════════════════════
describe('tvrb · [TDAY-FREEZE] 当天定稿不被题材库导入戳穿', () => {
  const CORE = [{ name: 'AI应用', synonyms: ['人工智能'] }];
  const SIG_A = buildRulesFingerprint(CORE, 'tl1:aaaa1111');
  const SIG_B = buildRulesFingerprint(CORE, 'tl1:bbbb2222');   // 同一份核心词，只是个股题材串变了
  const SIG_RULE = 'v99:ffffffff:tl1:aaaa1111';                // base 段也变了（模拟 bump / 改核心词）

  it('① 🔴 今天 + 输入完整 + 只有题材库段变 ⇒ hit（11-16 那 10 行导入不该改今天的票）', () => {
    expect(resolvePlanSnapshotFreshness(
      { status: 'hit', rulesSig: SIG_A, inputsSig: 'v1:111' },
      { rulesSig: SIG_B, coreTopicsLoaded: true, inputsSig: 'v1:111', freezeSettledDay: true }
    )).toBe('hit');
  });

  it('② 🔴 今天 + 输入完整 + base 段也变了（用户主动改核心词 / bump）⇒ 仍 stale', () => {
    expect(resolvePlanSnapshotFreshness(
      { status: 'hit', rulesSig: SIG_A, inputsSig: 'v1:111' },
      { rulesSig: SIG_RULE, coreTopicsLoaded: true, inputsSig: 'v1:111', freezeSettledDay: true }
    )).toBe('stale');
  });

  it('③ 🔴 今天 + 竞价榜没就绪(v1:0xx) ⇒ 不冻结，仍 stale（11-11 那类残缺必须自愈）', () => {
    expect(resolvePlanSnapshotFreshness(
      { status: 'hit', rulesSig: SIG_A, inputsSig: 'v1:011' },
      { rulesSig: SIG_B, coreTopicsLoaded: true, inputsSig: 'v1:111', freezeSettledDay: true }
    )).toBe('stale');
    // 没记 inputs_sig 的老行同理（不完整 ⇒ 不冻结）
    expect(resolvePlanSnapshotFreshness(
      { status: 'hit', rulesSig: SIG_A, inputsSig: '' },
      { rulesSig: SIG_B, coreTopicsLoaded: true, inputsSig: 'v1:111', freezeSettledDay: true }
    )).toBe('stale');
  });

  it('④ 🔴 历史日（freezeSettledDay 缺省 / false）⇒ 行为与原来逐字一致：题材库变就 stale', () => {
    const snap = { status: 'hit', rulesSig: SIG_A, inputsSig: 'v1:111' };
    const opts = { rulesSig: SIG_B, coreTopicsLoaded: true, inputsSig: 'v1:111' };
    expect(resolvePlanSnapshotFreshness(snap, opts)).toBe('stale');
    expect(resolvePlanSnapshotFreshness(snap, Object.assign({}, opts, { freezeSettledDay: false }))).toBe('stale');
  });

  it('⑤ 今天 + 题材库段没变 ⇒ 与冻结开关无关（§11 零行为变化）', () => {
    const snap = { status: 'hit', rulesSig: SIG_A, inputsSig: 'v1:111' };
    const opts = { rulesSig: SIG_A, coreTopicsLoaded: true, inputsSig: 'v1:111', freezeSettledDay: true };
    expect(resolvePlanSnapshotFreshness(snap, opts)).toBe('hit');
  });

  it('⑥ 🔴 接线锁：composable 两处都必须按「这一天是不是今天」传，⛔ 不许写死 true', () => {
    const comp = readFileSync('src/composables/useTopicVolRatioBoard.js', 'utf8');
    const hits = comp.match(/freezeSettledDay:[^\n]*/g) || [];
    expect(hits.length).toBe(2);                                  // _loadPlanSnapshot + _recheckPlanSnapshotFreshness
    hits.forEach(function(line) {
      expect(line).toContain('_getLocalTodayStr()');               // 必须与「今天」比较
      expect(line).not.toMatch(/freezeSettledDay:\s*true\b/);      // ⛔ 写死 true 会把历史日也冻住
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// ★★ [TDAY-CLOSE-FREEZE 2026-11-16 第二轮] 「数据晚到」不许改今天的票 —— 11-16 事故的完整链条。
//
// 真实时间戳（库内取证，不是推测）：
//   09:27:54 定稿 revision 1（大消费 1 只 + AI应用 2 只 = 3 只）
//   09:26:29 ~ 11:09:29 当天 `stock_range20_pct` 的 auc 腿才陆续写完（70 行分 ~100 分钟）
//   ⇒ 09:27 第二十九条的候补池 / 在列次数未就绪 ⇒ §10 放行（代码原话「数据到货后会自动重判」）
//   16:00 收盘流程重写量比；16:25 用户导入题材 ⇒ 存档重算 ⇒ 池子已就绪 ⇒ AI应用 量比 16.62 < 25
//   ⇒ 整块作废 ⇒ 候补落在北纬科技（竞价一字买不进）⇒ 空仓 ⇒ 只剩日出东方 1 只
//
// 用户原话：「我都说了按照竞价口径来，收盘后也不能变，现在为什么还在变？」
// ⇒ 今天这份【完整输入】的定稿，只允许被两件事推翻：① 规则段变了（用户主动）；② 当时竞价榜就没就绪。
// ══════════════════════════════════════════════════════════════════════════════════════════
describe('tvrb · [TDAY-CLOSE-FREEZE] 数据晚到不改今天的票', () => {
  const SIG = 'v18:79cb50e9:tl1:d285102e';
  const snapOf = function(inputsSig) {
    return { status: 'hit', rulesSig: SIG, inputsSig: inputsSig };
  };
  const optsOf = function(inputsSig, freeze) {
    return { rulesSig: SIG, coreTopicsLoaded: true, inputsSig: inputsSig, freezeSettledDay: freeze !== false };
  };

  it('① 🔴 今天 + 存档时竞价榜已就绪(第1位=1) + 池子/量比后来补齐 ⇒ hit（11-16 的形状）', () => {
    // 09:27 第二十九条 因补位池没就绪被 §10 放行 ⇒ 存档 v1:110；收盘后池子齐了 ⇒ v1:111
    expect(resolvePlanSnapshotFreshness(snapOf('v1:110'), optsOf('v1:111', true))).toBe('hit');
    expect(resolvePlanSnapshotFreshness(snapOf('v1:101'), optsOf('v1:111', true))).toBe('hit');
    expect(resolvePlanSnapshotFreshness(snapOf('v1:111'), optsOf('v1:111', true))).toBe('hit');
  });

  it('② 🔴 例外必须保留：存档当时【竞价榜没就绪】(第1位=0) ⇒ 不冻结，照旧自愈（11-11 残缺）', () => {
    expect(resolvePlanSnapshotFreshness(snapOf('v1:011'), optsOf('v1:111', true))).toBe('stale');
    expect(resolvePlanSnapshotFreshness(snapOf('v1:000'), optsOf('v1:111', true))).toBe('stale');
    // 当前也还是 0 ⇒ 停在 ⑤「数据没齐不抖动」
    expect(resolvePlanSnapshotFreshness(snapOf('v1:011'), optsOf('v1:010', true))).toBe('hit');
  });

  it('③ 今天 + 存档本身不完整 / 没记 inputs_sig ⇒ 不冻结（§10 残缺结论允许自愈一次）', () => {
    expect(resolvePlanSnapshotFreshness(
      { status: 'hit', rulesSig: SIG, inputsSig: '' }, optsOf('v1:111', true)
    )).toBe('stale');
    // 当前仍不完整 ⇒ 停在 ⑤「数据没齐 ⇒ 不抖动」，压根到不了冻结那一段（§10）
    expect(resolvePlanSnapshotFreshness(snapOf('v1:110'), optsOf('v1:110', true))).toBe('hit');
  });

  it('④ 历史日（freezeSettledDay=false）⇒ 与原来逐字一致：输入完整度一变就 stale', () => {
    expect(resolvePlanSnapshotFreshness(snapOf('v1:110'), optsOf('v1:111', false))).toBe('stale');
    expect(resolvePlanSnapshotFreshness(snapOf('v1:111'), optsOf('v1:111', false))).toBe('hit');
  });

  it('⑤ 规则段变了 ⇒ 今天也照样重算（冻结不豁免用户主动改规则）', () => {
    expect(resolvePlanSnapshotFreshness(
      { status: 'hit', rulesSig: SIG, inputsSig: 'v1:110' },
      { rulesSig: 'v19:aaaaaaaa:tl1:d285102e', coreTopicsLoaded: true, inputsSig: 'v1:111', freezeSettledDay: true }
    )).toBe('stale');
  });

  it('⑥ 降级模式（库里没 inputs_sig 列）不受影响', () => {
    expect(resolvePlanSnapshotFreshness(
      { status: 'hit', rulesSig: SIG, inputsSig: '' },
      { rulesSig: SIG, coreTopicsLoaded: true, inputsSig: 'v1:111', freezeSettledDay: true, inputsSigSupported: false }
    )).toBe('hit');
  });
});
