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
import {
  TVRB_RULES_VERSION,
  buildRulesFingerprint,
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
    expect(buildRulesFingerprint([null, {}, { name: 'X', synonyms: null }])).toMatch(/^v1:/);
  });

  it('⑤ 同义词顺序调整也算一次编辑（保守，结论不变时由幂等写兜住）', function() {
    const base = buildRulesFingerprint(topics());
    const swapped = topics(); swapped[0].synonyms.reverse();
    expect(buildRulesFingerprint(swapped)).not.toBe(base);
  });
});

describe('resolvePlanSnapshotFreshness · 存档是否已因规则变更而过期', function() {
  const hit = { status: 'hit', rulesSig: 'v1:aaaaaaaa' };

  it('① 🔴 核心词还没从云端加载完 ⇒ 判 hit（⛔ 不许拿首屏默认词表误判过期）', function() {
    expect(resolvePlanSnapshotFreshness(hit, {
      rulesSig: 'v1:bbbbbbbb', coreTopicsLoaded: false
    })).toBe('hit');
  });

  it('② 当前指纹算不出来 ⇒ 判 hit（§10 算不出 ≠ 变了）', function() {
    expect(resolvePlanSnapshotFreshness(hit, {
      rulesSig: '', coreTopicsLoaded: true
    })).toBe('hit');
  });

  it('③ 指纹相同 ⇒ hit（历史复盘稳定，不重算、不覆盖）', function() {
    expect(resolvePlanSnapshotFreshness(hit, {
      rulesSig: 'v1:aaaaaaaa', coreTopicsLoaded: true
    })).toBe('hit');
  });

  it('④ 🔴 指纹不同 ⇒ stale（用户改了同义词 ⇒ 允许按新规则重算并修订存档）', function() {
    expect(resolvePlanSnapshotFreshness(hit, {
      rulesSig: 'v1:bbbbbbbb', coreTopicsLoaded: true
    })).toBe('stale');
  });

  it('⑤ 旧存档没记 rules_sig（升级前的行）⇒ stale，重算一次自愈补齐元数据', function() {
    expect(resolvePlanSnapshotFreshness({ status: 'hit', rulesSig: '' }, {
      rulesSig: 'v1:aaaaaaaa', coreTopicsLoaded: true
    })).toBe('stale');
  });

  it('⑥ 不是有效存档状态 ⇒ unknown（本判据不管，由说明区各自处理）', function() {
    expect(resolvePlanSnapshotFreshness({ status: 'empty' }, {
      rulesSig: 'v1:aaaaaaaa', coreTopicsLoaded: true
    })).toBe('unknown');
    expect(resolvePlanSnapshotFreshness(null, {})).toBe('unknown');
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
