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
// [RULES-BUMP-GUARD 2026-11-12] 规则版本升级（bump `TVRB_RULES_VERSION`）只让【今天】的存档过期。
//
// 背景：第二十八条收紧（同题材择优）会改变选股结论（11-12：光洋股份 → 襄阳轴承）。
//   不 bump ⇒ 那份按旧规则定稿的存档永久 hit ⇒ 屏幕上一直是错的那只；
//   bump 又不能让【历史日】跟着重算 —— 历史日的库内行情会被收盘覆盖，重算会改写复盘结论。
// ══════════════════════════════════════════════════════════════════════════════════════════
describe('tvrb · [RULES-BUMP-GUARD] 规则升级只让今天过期，历史日保持定稿', () => {
  const SNAP = { status: 'hit', rulesSig: 'v1:aaaaaaaa', inputsSig: 'v1:111' };
  const OPTS = { rulesSig: 'v2:bbbbbbbb', coreTopicsLoaded: true, inputsSig: 'v1:111' };

  it('今天（allowRulesInvalidation !== false）⇒ stale（按新规则重算并修订存档）', () => {
    expect(resolvePlanSnapshotFreshness(SNAP, OPTS)).toBe('stale');
    expect(resolvePlanSnapshotFreshness(SNAP, Object.assign({}, OPTS, { allowRulesInvalidation: true }))).toBe('stale');
  });

  it('历史日（allowRulesInvalidation === false）⇒ hit（保持那一份定稿，⛔ 不被新规则改写）', () => {
    expect(resolvePlanSnapshotFreshness(SNAP, Object.assign({}, OPTS, { allowRulesInvalidation: false }))).toBe('hit');
  });

  it('规则没变时该选项不影响任何既有判据（§11 零行为变化）', () => {
    const same = { status: 'hit', rulesSig: 'v2:bbbbbbbb', inputsSig: 'v1:111' };
    expect(resolvePlanSnapshotFreshness(same, Object.assign({}, OPTS, { allowRulesInvalidation: false }))).toBe('hit');
    const broken = { status: 'hit', rulesSig: 'v2:bbbbbbbb', inputsSig: 'v1:110' };
    expect(resolvePlanSnapshotFreshness(broken, Object.assign({}, OPTS, { allowRulesInvalidation: false }))).toBe('stale');
  });

  it('版本常量已 bump 到 8（监管异动升级为显示层总约束 = v8）', () => {
    expect(TVRB_RULES_VERSION).toBe(8);
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

  it('composable 两处调用都带上该选项（静态锁：漏一处 ⇒ 历史日会被改写）', () => {
    const src = readFileSync('src/composables/useTopicVolRatioBoard.js', 'utf8');
    const n = (src.match(/allowRulesInvalidation: /g) || []).length;
    expect(n).toBe(2);
    expect(src).toContain('allowRulesInvalidation: key === _bjTodayKey()');
    expect(src).toContain('allowRulesInvalidation: d === _bjTodayKey()');
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════
// ★★ [TOPIC-LIB-SIG 2026-11-12 用户口径] 题材库（个股题材）变了 ⇒ **历史日也要重算**。
//
// 用户原话：「比如我在今天改了题材，我希望历史日期题材量比选股也会根据这个题材改变做改变……
//   之前那些选票也要根据我手动改的题材变化」。
// ⚠️ 与 [RULES-BUMP-GUARD] 恰好相反：规则/核心词变了只重算今天，题材库变了连历史一起重算。
// ══════════════════════════════════════════════════════════════════════════════════════════
describe('tvrb · [TOPIC-LIB-SIG] 题材库指纹变了 ⇒ 历史日也重算', () => {
  const CORE = [{ name: 'AI应用', synonyms: ['人工智能'] }];

  it('指纹第二段相同、第三段不同 ⇒ stale（哪怕 allowRulesInvalidation=false）', () => {
    const oldSig = buildRulesFingerprint(CORE, 'tl1:aaaa1111');
    const newSig = buildRulesFingerprint(CORE, 'tl1:bbbb2222');
    const snap = { status: 'hit', rulesSig: oldSig, inputsSig: 'v1:111' };
    const opts = {
      rulesSig: newSig, coreTopicsLoaded: true, inputsSig: 'v1:111',
      allowRulesInvalidation: false                       // 历史日
    };
    expect(resolvePlanSnapshotFreshness(snap, opts)).toBe('stale');
  });

  it('题材库没变 ⇒ hit（不抖动）', () => {
    const sig = buildRulesFingerprint(CORE, 'tl1:aaaa1111');
    const snap = { status: 'hit', rulesSig: sig, inputsSig: 'v1:111' };
    const opts = { rulesSig: sig, coreTopicsLoaded: true, inputsSig: 'v1:111', allowRulesInvalidation: false };
    expect(resolvePlanSnapshotFreshness(snap, opts)).toBe('hit');
  });

  it('当前算不出题材库指纹（空）⇒ hit（§10：算不出来 ≠ 变了）', () => {
    const snap = { status: 'hit', rulesSig: 'v3:bbbbbbbb:tl1:aaaa1111', inputsSig: 'v1:111' };
    const opts = {
      rulesSig: 'v3:bbbbbbbb', coreTopicsLoaded: true, inputsSig: 'v1:111',
      allowRulesInvalidation: false
    };
    expect(resolvePlanSnapshotFreshness(snap, opts)).toBe('hit');
  });

  it('老存档没有第三段（升级前的行）⇒ 自愈一次（stale）', () => {
    const snap = { status: 'hit', rulesSig: 'v3:bbbbbbbb', inputsSig: 'v1:111' };
    const opts = {
      rulesSig: 'v3:bbbbbbbb:tl1:aaaa1111', coreTopicsLoaded: true, inputsSig: 'v1:111',
      allowRulesInvalidation: false
    };
    expect(resolvePlanSnapshotFreshness(snap, opts)).toBe('stale');
  });

  it('指纹确定性：内容相同 ⇒ 跨调用恒相同；内容不同 ⇒ 不同', () => {
    expect(buildRulesFingerprint(CORE, 'tl1:aaaa1111')).toBe(buildRulesFingerprint(CORE, 'tl1:aaaa1111'));
    expect(buildRulesFingerprint(CORE, 'tl1:aaaa1111')).not.toBe(buildRulesFingerprint(CORE, 'tl1:bbbb'));
  });
});
