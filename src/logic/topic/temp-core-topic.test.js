import { describe, it, expect } from 'vitest';
import {
  TEMP_CORE_TRADING_DAYS,
  endDateOf,
  isTempCoreActiveOn,
  effectiveCoreTopicsFor,
  hiddenTempCoreTokensOn,
  filterHiddenTopicText,
  filterHiddenNoteTopics,
  coreTopicTokenSet,
  tempCoreWindowDates,
  collectTempCoreHits
} from './temp-core-topic.js';

// 交易日链：11-12(四) → 11-13(五) → 11-16(一)；11-17 是第 4 个交易日。
const DAYS = ['2026-11-12', '2026-11-13', '2026-11-16', '2026-11-17'];
function nextTradingDay(d) {
  const i = DAYS.indexOf(d);
  return i >= 0 && i + 1 < DAYS.length ? DAYS[i + 1] : null;
}

const BASE = [
  { name: '农业,水产品', synonyms: ['东方海洋', '水产品'] },
  { name: '大消费', synonyms: ['消费'] }
];
const TEMP = {
  id: 1,
  name: '东方',
  synonyms: ['东方海洋', '东方环宇', '日出东方'],
  startDate: '2026-11-12',
  disabledFrom: null
};

describe('临时核心词 · 按日期生效（规则 〇·a）', () => {
  it('交易日数 = 设置日 + 后 2 天，共 3 天（用户拍板）', () => {
    expect(TEMP_CORE_TRADING_DAYS).toBe(3);
    expect(endDateOf('2026-11-12', 3, nextTradingDay)).toBe('2026-11-16');
  });

  it('endDateOf 跳过周末（未注入假期日历时）', () => {
    // 2026-11-13 周五 ⇒ 后 2 个交易日 = 11-16 周一、11-17 周二
    expect(endDateOf('2026-11-13', 3)).toBe('2026-11-17');
  });

  it('设置日非法 ⇒ 末日为空，⛔ 不猜日期', () => {
    expect(endDateOf('', 3, nextTradingDay)).toBe('');
    expect(endDateOf('20261112', 3, nextTradingDay)).toBe('');
  });

  it('【§11 零行为变化】临时表为空 ⇒ 返回 base 原引用', () => {
    expect(effectiveCoreTopicsFor('2026-11-13', BASE, [], nextTradingDay)).toBe(BASE);
  });

  it('【历史不受影响】设置日之前 ⇒ 返回 base 原引用', () => {
    expect(effectiveCoreTopicsFor('2026-11-11', BASE, [TEMP], nextTradingDay)).toBe(BASE);
  });

  it('【未来不受影响】第 4 个交易日起 ⇒ 返回 base 原引用', () => {
    expect(effectiveCoreTopicsFor('2026-11-17', BASE, [TEMP], nextTradingDay)).toBe(BASE);
    expect(effectiveCoreTopicsFor('2026-12-01', BASE, [TEMP], nextTradingDay)).toBe(BASE);
  });

  it('【生效区间】设置日 / D+1 / D+2 三天都按临时题材归类', () => {
    ['2026-11-12', '2026-11-13', '2026-11-16'].forEach(function(d) {
      const eff = effectiveCoreTopicsFor(d, BASE, [TEMP], nextTradingDay);
      expect(eff).not.toBe(BASE);
      expect(eff.some(function(c) { return c.name === '东方'; })).toBe(true);
      expect(BASE.some(function(c) { return c.name === '东方'; })).toBe(false); // ⛔ 不改原数组
    });
  });

  it('【关停】关停当日（含）之后全部失效；关停前的日期仍生效', () => {
    const stopped = Object.assign({}, TEMP, { disabledFrom: '2026-11-13' });
    expect(isTempCoreActiveOn(stopped, '2026-11-12', nextTradingDay)).toBe(true);
    expect(effectiveCoreTopicsFor('2026-11-13', BASE, [stopped], nextTradingDay)).toBe(BASE);
    expect(effectiveCoreTopicsFor('2026-11-16', BASE, [stopped], nextTradingDay)).toBe(BASE);
  });

  it('【恢复】清空关停日 ⇒ 区间内重新生效', () => {
    const resumed = Object.assign({}, TEMP, { disabledFrom: null });
    expect(effectiveCoreTopicsFor('2026-11-16', BASE, [resumed], nextTradingDay)).not.toBe(BASE);
  });

  it('关停日早于设置日 ⇒ 整段失效', () => {
    const stopped = Object.assign({}, TEMP, { disabledFrom: '2026-11-10' });
    expect(effectiveCoreTopicsFor('2026-11-12', BASE, [stopped], nextTradingDay)).toBe(BASE);
  });

  it('同名临时词整条覆盖主流词（生效期换同义词，过期自动换回）', () => {
    const base = BASE.concat([{ name: '东方', synonyms: ['旧词'] }]);
    const eff = effectiveCoreTopicsFor('2026-11-13', base, [TEMP], nextTradingDay);
    const hit = eff.filter(function(c) { return c.name === '东方'; });
    expect(hit).toHaveLength(1);
    expect(hit[0].synonyms).toEqual(TEMP.synonyms);
    expect(effectiveCoreTopicsFor('2026-11-17', base, [TEMP], nextTradingDay)).toBe(base);
  });

  it('多条临时词按 id 稳定追加（§6 不随加载顺序漂移）', () => {
    const b = { id: 2, name: '贝', synonyms: ['贝因美'], startDate: '2026-11-12', disabledFrom: null };
    const a = Object.assign({}, b, { id: 1, name: '阿', synonyms: ['阿城'] });
    const eff1 = effectiveCoreTopicsFor('2026-11-13', BASE, [b, a], nextTradingDay);
    const eff2 = effectiveCoreTopicsFor('2026-11-13', BASE, [a, b], nextTradingDay);
    expect(eff1.map(function(c) { return c.name; })).toEqual(eff2.map(function(c) { return c.name; }));
  });

  it('日期读不到 ⇒ 判不出 ⇒ 不生效（§10）', () => {
    expect(isTempCoreActiveOn(TEMP, '', nextTradingDay)).toBe(false);
    expect(effectiveCoreTopicsFor('', BASE, [TEMP], nextTradingDay)).toBe(BASE);
    expect(effectiveCoreTopicsFor('2026-11-13', BASE, [Object.assign({}, TEMP, { startDate: 'x' })], nextTradingDay)).toBe(BASE);
  });

  // [TEMP-CORE-DEDUP 2026-11-26] 实测库里「羊字辈」被添加两次（id 4 / 5 完全同参）⇒
  //   有效词表必须只出一份，否则同一题材在分组里出现两条、统计翻倍。
  it('同名临时词重复多行 ⇒ 有效词表只保留一份（按 id 取第一条）', () => {
    // 11-18(三) → 11-19(四) → 11-20(五) → 11-23(一)：本用例自己的交易日链
    const CHAIN = ['2026-11-18', '2026-11-19', '2026-11-20', '2026-11-23'];
    function nextInChain(d) {
      const i = CHAIN.indexOf(d);
      return i >= 0 && i + 1 < CHAIN.length ? CHAIN[i + 1] : null;
    }
    const a = { id: 4, name: '羊字辈', synonyms: ['羊字辈'], startDate: '2026-11-18', disabledFrom: null };
    const b = { id: 5, name: '羊字辈', synonyms: ['羊字辈'], startDate: '2026-11-18', disabledFrom: null };
    ['2026-11-18', '2026-11-19', '2026-11-20'].forEach(function(d) {
      const eff = effectiveCoreTopicsFor(d, BASE, [b, a], nextInChain);
      expect(eff.filter(function(c) { return c.name === '羊字辈'; })).toHaveLength(1);
    });
    // 区间末之后（11-23）⇒ 已过期，回主流题材
    const expired = effectiveCoreTopicsFor('2026-11-23', BASE, [b, a], nextInChain);
    expect(expired.filter(function(c) { return c.name === '羊字辈'; })).toHaveLength(0);
  });
});

describe('临时词关停后隐藏股票后面的标签（只过滤显示，不删库）', () => {
  const STOPPED = { id: 1, name: '东方', synonyms: ['东方', '羊字辈'], startDate: '2026-11-12', disabledFrom: '2026-11-13' };

  it('未关停 ⇒ 不隐藏任何标签', () => {
    expect(hiddenTempCoreTokensOn('2026-11-12', [TEMP], nextTradingDay).size).toBe(0);
  });

  it('关停当日及之后（区间内）⇒ 隐藏 name + 全部同义词', () => {
    ['2026-11-13', '2026-11-16'].forEach(function(d) {
      const ban = hiddenTempCoreTokensOn(d, [STOPPED], nextTradingDay);
      expect(ban.has('东方')).toBe(true);
      expect(ban.has('羊字辈')).toBe(true);
    });
  });

  it('设置日之前（历史日）⇒ 隔离（历史日期不许用临时题材）', () => {
    const ban = hiddenTempCoreTokensOn('2026-11-11', [STOPPED], nextTradingDay);
    expect(ban.has('东方')).toBe(true);
    expect(ban.has('羊字辈')).toBe(true);
  });

  it('区间末之后（未来日）⇒ 隔离（未来日期也不许用临时题材）', () => {
    const ban = hiddenTempCoreTokensOn('2026-11-17', [STOPPED], nextTradingDay);
    expect(ban.has('东方')).toBe(true);
    expect(filterHiddenTopicText('水产品,农业,东方,羊字辈', ban)).toBe('水产品,农业');
  });

  it('精确匹配：只摘「东方」，不动「东方通信」「东方财富」', () => {
    const ban = hiddenTempCoreTokensOn('2026-11-13', [STOPPED], nextTradingDay);
    expect(filterHiddenTopicText('水产品,农业,东方,羊字辈', ban)).toBe('水产品,农业');
    expect(filterHiddenTopicText('通信,东方通信,东方财富', ban)).toBe('通信,东方通信,东方财富');
  });

  it('隐藏集合为空 ⇒ 题材串逐字节不变（§11）', () => {
    expect(filterHiddenTopicText('水产品,农业,东方', new Set())).toBe('水产品,农业,东方');
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════
// [TEMP-CORE 窗口延续 2026-11-17] 用户实测 bug 的回归锁：
//   「11-12 设的临时核心词东方，区间 12~16，只有 12 号生效，13/16 的题材分类里没有东方」
//   根因 = 标签供给：12 号 note 里有「东方」，13/16 note 是空的（回退共享库 = 物流,外贸）。
//   ⇒ 窗口内任意一天命中过该词的票，当天也必须归入该题材。
// ══════════════════════════════════════════════════════════════════════════════════════
describe('临时题材 · 窗口内标签延续（修「只有设置日生效」）', () => {
  const W = { name: '东方', synonyms: ['东方'], dates: ['2026-11-12', '2026-11-13', '2026-11-16'] };

  it('窗口 = 设置日 + 后 2 个交易日（11-12 → 11-13 → 11-16）', () => {
    expect(tempCoreWindowDates(TEMP, nextTradingDay)).toEqual(['2026-11-12', '2026-11-13', '2026-11-16']);
  });

  it('已关停 ⇒ 窗口截到关停前一日', () => {
    const stopped = Object.assign({}, TEMP, { disabledFrom: '2026-11-13' });
    expect(tempCoreWindowDates(stopped, nextTradingDay)).toEqual(['2026-11-12']);
  });

  it('设置日非法 ⇒ 窗口为空（⛔ 不猜日期）', () => {
    expect(tempCoreWindowDates({ name: '东方', startDate: '' }, nextTradingDay)).toEqual([]);
  });

  it('【核心回归】设置日有标签、第 2/3 天 note 为空 ⇒ 仍算命中（不再掉组）', () => {
    const topicsByDate = {
      '2026-11-12': {
        '东方创业': ['物流', '外贸', '东方'],
        '东方通信': ['通信', 'AI应用', '东方'],
        '东方海洋': ['水产品', '农业', '东方', '羊字辈']
      },
      '2026-11-13': {
        '东方创业': ['物流', '外贸'],          // 当天 note 空 ⇒ 回退共享库，没有「东方」
        '东方通信': ['通信', 'AI应用'],
        '东方海洋': ['水产品', '农业']
      },
      '2026-11-16': {
        '东方创业': ['物流', '外贸'],
        '日出东方': ['家电', '热泵']           // 设置日没打标 ⇒ 不补（不靠股票名猜）
      }
    };
    const hits = collectTempCoreHits([W], topicsByDate);
    expect(Array.from(hits.get('东方') || []).sort()).toEqual(['东方创业', '东方通信', '东方海洋'].sort());
    expect(hits.get('东方').has('日出东方')).toBe(false);
  });

  it('窗口内没有任何命中 ⇒ 返回空 Map（分组旧行为不变）', () => {
    const hits = collectTempCoreHits([W], { '2026-11-13': { '东方创业': ['物流', '外贸'] } });
    expect(hits.size).toBe(0);
  });

  it('同义词也参与命中（羊字辈）', () => {
    const w2 = { name: '羊字辈', synonyms: ['羊字辈'], dates: ['2026-11-12'] };
    const hits = collectTempCoreHits([w2], { '2026-11-12': { '东方海洋': ['水产品', '羊字辈'] } });
    expect(hits.get('羊字辈').has('东方海洋')).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════
// [TEMP-CORE-SCOPE 2026-11-27 用户口径] 临时题材只在生效窗口内可用：
//   「临时题材只在有效期那里生效，历史日期怎么会生效呢？……历史日期就没办法用临时题材了，
//     未来日期也没办法用，只有指定的时间可以。」
//   事故：11-18 才建的临时题材「羊字辈」，11-12 的选择理由 / 双击竞价量备注 / 昨日成交量 toast
//   全都看得到 —— 因为题材库 stock_topics 一票一行（跨日期共享）、note 是 11-18 打标时回灌的。
//   ⇒ 显示 / 派生层必须按【该行所属交易日】把这词隔离掉，且⛔ 不动任何业务表。
// ══════════════════════════════════════════════════════════════════════════════════════
describe('临时题材 · 日期隔离（历史日 / 未来日都不许出现）', () => {
  // 真实库快照：11-18 建的「羊字辈」，11-12 的题材串里确实带着它
  const YANG = { id: 4, name: '羊字辈', synonyms: ['羊字辈'], startDate: '2026-11-18', disabledFrom: null };
  const CHAIN = ['2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-23'];
  const nextInChain = (d) => {
    const i = CHAIN.indexOf(d);
    return i >= 0 && i + 1 < CHAIN.length ? CHAIN[i + 1] : null;
  };

  it('11-12（设置日之前）⇒ 隔离，题材串里摘掉「羊字辈」其余保留', () => {
    const ban = hiddenTempCoreTokensOn('2026-11-12', [YANG], nextInChain, []);
    expect(ban.has('羊字辈')).toBe(true);
    expect(filterHiddenTopicText('水产品,农业,东方,羊字辈', ban)).toBe('水产品,农业,东方');
  });

  it('窗口内三天（11-18/19/20）⇒ 不隔离', () => {
    ['2026-11-18', '2026-11-19', '2026-11-20'].forEach(function(d) {
      expect(hiddenTempCoreTokensOn(d, [YANG], nextInChain, []).size).toBe(0);
    });
  });

  it('窗口之后（11-23）⇒ 隔离', () => {
    expect(hiddenTempCoreTokensOn('2026-11-23', [YANG], nextInChain, []).has('羊字辈')).toBe(true);
  });

  it('【主流词豁免】临时词与主流核心词同名/同义 ⇒ 永不隔离（不会误伤主流大类）', () => {
    const NONG = { id: 9, name: '农业', synonyms: ['水产品'], startDate: '2026-11-18', disabledFrom: null };
    const mainstream = [{ name: '农业', synonyms: ['种业', '水产品'] }];
    const ban = hiddenTempCoreTokensOn('2026-11-12', [NONG], nextInChain, mainstream);
    expect(ban.has('农业')).toBe(false);
    expect(ban.has('水产品')).toBe(false);
  });

  it('coreTopicTokenSet：name + 同义词全部转小写 token', () => {
    const set = coreTopicTokenSet([{ name: '农业', synonyms: ['Water', '种业'] }]);
    expect(set.has('农业')).toBe(true);
    expect(set.has('water')).toBe(true);
    expect(set.has('种业')).toBe(true);
  });

  it('日期读不出 ⇒ 空集合（§10 不猜，不误伤任何标签）', () => {
    expect(hiddenTempCoreTokensOn('', [YANG], nextInChain, []).size).toBe(0);
  });

  it('note 文本过滤：只摘括号内的整段，涨幅前缀与其它括号段一字不动', () => {
    const ban = hiddenTempCoreTokensOn('2026-11-12', [YANG], nextInChain, []);
    expect(filterHiddenNoteTopics('-1.60%(外贸,氢能源,羊字辈)', ban)).toBe('-1.60%(外贸,氢能源)');
    expect(filterHiddenNoteTopics('10.02%(水产品,农业,东方,羊字辈)', ban)).toBe('10.02%(水产品,农业,东方)');
    // 括号里只有这个词 ⇒ 整个括号去掉（⛔ 不留空括号）
    expect(filterHiddenNoteTopics('+2.91%(羊字辈)', ban)).toBe('+2.91%');
    // 无括号 / 空 token ⇒ 原样
    expect(filterHiddenNoteTopics('3.42%', ban)).toBe('3.42%');
    expect(filterHiddenNoteTopics('3.42%(羊字辈)', new Set())).toBe('3.42%(羊字辈)');
    // 只是包含（子串）不删
    expect(filterHiddenNoteTopics('1.0%(羊字辈概念)', ban)).toBe('1.0%(羊字辈概念)');
  });
});
