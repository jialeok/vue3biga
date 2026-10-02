// [TOPIC-SEP 2026-10-02] 题材词分隔符 / 核心词归一化的回归测试。
//
// 事故原型（⛔ 改这些用例前先读一遍）：
//   核心词管理弹窗的 splitSynonyms 只认 [,，]，而股票侧标签拆分用的是 [,，、;；]（含【顿号】）。
//   ⇒ 用户粘贴「工业互联网、智能制造、工业软件…」时被当成【一整项】存进 synonyms；
//      匹配是子串匹配(topic.includes(synonym))，整串永远匹配不上 ⇒ 这些词静默全部失效。
//   实测脏数据：核心词「工业4.0」的 synonyms[0] 就是这么一整串，
//      结果连「工业4.0」这个标签自身都匹配不到它（只能靠同组的「机器人概念」间接进组）。

import { describe, it, expect } from 'vitest';
import { TOPIC_WORD_SEP_RE, splitTopicWords, normalizeCoreTopics } from './rules.js';

describe('TOPIC_WORD_SEP_RE（题材词分隔符 · §6 唯一定义）', () => {
  it('⭐ 认全四种分隔符：英文逗号 / 中文逗号 / 【顿号】/ 分号', () => {
    ['a,b', 'a，b', 'a、b', 'a;b', 'a；b'].forEach(function(s) {
      expect(s.split(TOPIC_WORD_SEP_RE)).toEqual(['a', 'b']);
    });
  });

  it('🔴 反派回归：顿号【必须】被拆开（这正是「工业4.0」失效的原因）', () => {
    // 这串正是云端核心词「工业4.0」里实际存在的脏数据
    const dirty = '工业互联网、智能制造、工业软件、数控机床、机器人、人形机器人、减速器、传感器、高端制造';
    const parts = dirty.split(TOPIC_WORD_SEP_RE);
    expect(parts.length).toBe(9);
    expect(parts[0]).toBe('工业互联网');
    expect(parts[8]).toBe('高端制造');
  });
});

describe('splitTopicWords（题材词拆分 · 唯一实现）', () => {
  it('去空白、去空串', () => {
    expect(splitTopicWords(' 人工智能 ， 、 算力 ,, ')).toEqual(['人工智能', '算力']);
  });

  it('去重（忽略大小写），但保持原顺序', () => {
    expect(splitTopicWords('机器人,机器人,ROBOT,减速器')).toEqual(['机器人', 'ROBOT', '减速器']);
  });

  it('§10：空值 / 非字符串 → 空数组（⛔ 绝不返回 ["" ] 之类伪装成有数据）', () => {
    [null, undefined, '', '   ', ',,,、；;'].forEach(function(v) {
      expect(splitTopicWords(v)).toEqual([]);
    });
  });
});

describe('normalizeCoreTopics（云端脏数据自愈）', () => {
  it('⭐ 把「顿号粘成一整串」的 synonym 拆开（读进来就自愈，不用等用户重存）', () => {
    const dirty = [{
      name: '工业4.0',
      synonyms: [
        '工业互联网、智能制造、工业软件、数控机床、机器人、人形机器人、减速器、传感器、高端制造',
        '机器人概念', 'PEEK', '新材料'
      ]
    }];
    const out = normalizeCoreTopics(dirty);
    expect(out[0].name).toBe('工业4.0');
    expect(out[0].synonyms).toEqual([
      '工业互联网', '智能制造', '工业软件', '数控机床', '机器人',
      '人形机器人', '减速器', '传感器', '高端制造', '机器人概念', 'PEEK', '新材料'
    ]);
  });

  it('拆完后【逐个】都能被子串匹配命中（这是拆分的唯一目的）', () => {
    const out = normalizeCoreTopics([{ name: 'X', synonyms: ['机器人概念、减速器、人形机器人'] }]);
    expect(out[0].synonyms).toEqual(['机器人概念', '减速器', '人形机器人']);
    // 模拟匹配：股票标签「人形机器人」现在能命中了（拆之前整串匹配不上）
    const tag = '人形机器人';
    expect(out[0].synonyms.some(function(s) { return tag.indexOf(s) >= 0; })).toBe(true);
  });

  it('去重：拆开后重复的条目只留一个', () => {
    const out = normalizeCoreTopics([{ name: 'Y', synonyms: ['机器人、减速器', '减速器', '减速器'] }]);
    expect(out[0].synonyms).toEqual(['机器人', '减速器']);
  });

  it('干净的 synonym 不被改动（⛔ 别为了自愈把正常数据也重写一遍）', () => {
    const clean = [{ name: '新能源汽车', synonyms: ['汽车零部件', '智能驾驶', '尊界新品'] }];
    expect(normalizeCoreTopics(clean)[0].synonyms).toEqual(['汽车零部件', '智能驾驶', '尊界新品']);
  });

  it('§10：非法输入 → 原样/空（⛔ 不抛异常、不静默造数据）', () => {
    expect(normalizeCoreTopics(null)).toEqual([]);
    expect(normalizeCoreTopics([])).toEqual([]);
    expect(normalizeCoreTopics([{ name: '', synonyms: [] }])[0].name).toBe('');
  });

  it('synonyms 缺失 / 非数组 ⇢ 归一化为 []（⛔ 不保留 undefined 让下游崩溃）', () => {
    expect(normalizeCoreTopics([{ name: 'Z' }])[0].synonyms).toEqual([]);
  });
});
