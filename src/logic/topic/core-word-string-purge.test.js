import { describe, it, expect } from 'vitest';
import {
  splitTopicSegments,
  purgeNoteText,
  purgeTopicsText,
  planTopicStringPurge
} from './core-word-string-purge.js';

/**
 * [CORE-PURGE-STRING 2026-11-17 用户口径] 删除核心词 ⇒ 同步清理竞价名单的 note / topics。
 *
 * 用户原话（逐字）：
 *   「我希望我删除核心词后，连同同义词一起删除，之前有过同义词的股票的题材窜中的同义词也一起删除，
 *     也就是早盘竞价看板的股票双击竞价量出来的那个note字段和和单击昨日成交量列显示的那个toast，
 *     也要把对应的同义词删除，其它题材窜要保留，这个特别注意，不要误删，也不要错删，
 *     也就是说这几个地方要同步。比如东方海洋，细分题材有(水产品,农业,东方,羊字辈)，
 *     我删除核心词东方后，变成只显示东方海洋(水产品,农业,羊字辈)，
 *     我删除羊字辈核心词后，变成显示(水产品,农业)」
 *
 * 这些用例就是那句话的可执行版本。⛔ 任何一条变红都说明「删核心词」又开始连坐 / 又开始漏删。
 */
describe('[CORE-PURGE-STRING] 删核心词 ⇒ 只摘掉 note 里整段相同的题材', () => {
  // 用户原例的真实库内数据（auction_watchlist 2026-11-12 东方海洋）
  const NOTE_ORIENTAL = '10.02%(水产品,农业,东方,羊字辈)';

  it('① 用户原例：删「东方」⇒ 只剩 水产品 / 农业 / 羊字辈，涨幅前缀不动', () => {
    const r = purgeNoteText(NOTE_ORIENTAL, ['东方']);
    expect(r.text).toBe('10.02%(水产品,农业,羊字辈)');
    expect(r.removed).toEqual(['东方']);
  });

  it('② 用户原例续：再删「羊字辈」⇒ 只剩 水产品 / 农业', () => {
    const r = purgeNoteText('10.02%(水产品,农业,羊字辈)', ['羊字辈']);
    expect(r.text).toBe('10.02%(水产品,农业)');
    expect(r.removed).toEqual(['羊字辈']);
  });

  it('③ 名字本身也算命中词（不只是同义词）', () => {
    const r = purgeNoteText('+1.63%(通信,AI应用,东方)', ['东方', '东']);
    expect(r.text).toBe('+1.63%(通信,AI应用)');
    expect(r.removed).toEqual(['东方']);
  });

  it('④ 同义词列表里的词同样要删（用户「连同同义词一起删除」）', () => {
    const r = purgeNoteText('-2.39%(芯片,物流,东方)', ['东方系', '东方']);
    expect(r.text).toBe('-2.39%(芯片,物流)');
    expect(r.removed).toEqual(['东方']);
  });

  it('⑤ 大小写不敏感：删「gpu」也要摘掉「GPU」', () => {
    const r = purgeNoteText('1%(算力,GPU,液冷)', ['gpu']);
    expect(r.text).toBe('1%(算力,液冷)');
    expect(r.removed).toEqual(['GPU']);
  });

  it('⑥ ⛔ 不按子串连坐：删「稀土」不动「稀土永磁」', () => {
    const r = purgeNoteText('2%(稀土永磁,小金属)', ['稀土']);
    expect(r.text).toBe('2%(稀土永磁,小金属)');
    expect(r.removed).toEqual([]);
  });

  it('⑦ 全角逗号 / 全角括号同样能切分（库内真实存在 `-0.89%(物流，外贸)`）', () => {
    expect(purgeNoteText('-0.89%(物流，外贸)', ['东方']).text).toBe('-0.89%(物流，外贸)');
    expect(purgeNoteText('-0.89%（物流，外贸，东方）', ['东方']).text).toBe('-0.89%(物流,外贸)');
  });

  it('⑧ 括号里删空 ⇒ 整个括号丢掉（⛔ 不留 `()`），涨幅与其它文本原样', () => {
    const r = purgeNoteText('涨停(东方)', ['东方']);
    expect(r.text).toBe('涨停');
    expect(r.removed).toEqual(['东方']);
  });

  it('⑨ 多个括号段各自处理，互不影响', () => {
    const r = purgeNoteText('3%(A,东方)(B,羊字辈)', ['东方']);
    expect(r.text).toBe('3%(A)(B,羊字辈)');
  });

  it('⑩ 没有括号（停牌 / 只有涨幅）⇒ 原样返回，且不算改动', () => {
    expect(purgeNoteText('停牌', ['东方'])).toEqual({ text: '停牌', removed: [] });
    expect(purgeNoteText('', ['东方'])).toEqual({ text: '', removed: [] });
    expect(purgeNoteText(null, ['东方'])).toEqual({ text: '', removed: [] });
  });
});

describe('[CORE-PURGE-STRING] topics 列的清理口径', () => {
  it('① 基本情形：删东方 ⇒ 物流,外贸', () => {
    expect(purgeTopicsText('物流,外贸,东方', ['东方'])).toEqual({ text: '物流,外贸', removed: ['东方'] });
  });

  it('② 全删空 ⇒ 如实返回空串（是否允许由计划层判 blocked，本函数不擅自保留）', () => {
    expect(purgeTopicsText('东方', ['东方'])).toEqual({ text: '', removed: ['东方'] });
  });

  it('③ 数组形态也认（内存行可能是数组）', () => {
    expect(purgeTopicsText(['水产品', '农业', '东方'], ['东方']).text).toBe('水产品,农业');
  });

  it('④ 没命中 ⇒ 原样返回（逐字相同，上层可据此跳过该行不写请求）', () => {
    expect(purgeTopicsText('物流,外贸', ['东方'])).toEqual({ text: '物流,外贸', removed: [] });
  });
});

describe('[CORE-PURGE-STRING] 计划层：影响面 / 跳过 / 按天统计', () => {
  /** 库里读回来的真实行（2026-11-10 ~ 11-16） */
  function realRows() {
    return [
      { date: '2026-11-12', stock: '东方海洋', note: '10.02%(水产品,农业,东方,羊字辈)', topics: '水产品,农业,东方,羊字辈' },
      { date: '2026-11-12', stock: '日出东方', note: '5.26%(家电,热泵,东方)', topics: '家电,热泵,东方' },
      { date: '2026-11-16', stock: '日出东方', note: '-10.00%(家电,热泵,东方)', topics: '家电,热泵,东方' },
      // ⚠️ 真实存在的「note 没有、topics 有」：删词只该改 topics 一列
      { date: '2026-11-10', stock: '东方创业', note: '-0.89%(物流，外贸)', topics: '物流,外贸,东方' }
    ];
  }

  it('① 删「东方」⇒ 4 行命中、3 只股票、3 个交易日', () => {
    const plan = planTopicStringPurge(realRows(), ['东方']);
    expect(plan.affectedRows).toBe(4);
    expect(plan.affectedStocks).toBe(3);
    expect(plan.dateCount).toBe(3);
    expect(plan.dates).toEqual(['2026-11-10', '2026-11-12', '2026-11-16']);
    // 3 行 note+topics 各 1 个 + 东方创业只有 topics 1 个 ⇒ 2+2+2+1 = 7
    expect(plan.removedWords).toBe(7);
  });

  it('② 东方海洋那行：note 与 topics 都要变成三个题材', () => {
    const plan = planTopicStringPurge(realRows(), ['东方']);
    const row = plan.rows.find(function(r) { return r.stock === '东方海洋'; });
    expect(row.newNote).toBe('10.02%(水产品,农业,羊字辈)');
    expect(row.newTopics).toBe('水产品,农业,羊字辈');
  });

  it('③ 东方创业那行：note 一个字不动，只改 topics（⛔ 不许顺手把 note 也改写）', () => {
    const plan = planTopicStringPurge(realRows(), ['东方']);
    const row = plan.rows.find(function(r) { return r.stock === '东方创业'; });
    expect(row.newNote).toBe('-0.89%(物流，外贸)');
    expect(row.newTopics).toBe('物流,外贸');
  });

  it('④ 删「羊字辈」⇒ 只命中东方海洋一行（其余票不受影响）', () => {
    const plan = planTopicStringPurge(realRows(), ['羊字辈']);
    expect(plan.affectedRows).toBe(1);
    expect(plan.rows[0].stock).toBe('东方海洋');
    expect(plan.rows[0].newNote).toBe('10.02%(水产品,农业,东方)');
  });

  it('⑤ 幂等：删过之后再删同一个词 ⇒ 0 行', () => {
    const after = planTopicStringPurge(realRows(), ['东方']).rows.map(function(r) {
      return { date: r.date, stock: r.stock, note: r.newNote, topics: r.newTopics };
    });
    expect(planTopicStringPurge(after, ['东方']).affectedRows).toBe(0);
  });

  it('⑥ §11 护栏：整行题材只有这个词 ⇒ 进 blocked，⛔ 不清空', () => {
    const rows = [{ date: '2026-11-14', stock: '某票', note: '-5.00%(东方)', topics: '东方' }];
    const plan = planTopicStringPurge(rows, ['东方']);
    expect(plan.affectedRows).toBe(0);
    expect(plan.blocked).toEqual([{ date: '2026-11-14', stock: '某票', removed: ['东方', '东方'] }]);
  });

  it('⑦ §11 护栏只拦「整行清空」：note 里还有别的题材就照删', () => {
    const rows = [{ date: '2026-11-14', stock: '某票', note: '-5.00%(东方,农业)', topics: '东方' }];
    const plan = planTopicStringPurge(rows, ['东方']);
    expect(plan.blocked).toEqual([]);
    expect(plan.affectedRows).toBe(1);
    expect(plan.rows[0].newNote).toBe('-5.00%(农业)');
    expect(plan.rows[0].newTopics).toBe('');
  });

  it('⑧ 空输入 / 空词表 ⇒ 空计划（不抛错、不产生写请求）', () => {
    expect(planTopicStringPurge(null, ['东方']).affectedRows).toBe(0);
    expect(planTopicStringPurge([], ['东方']).affectedRows).toBe(0);
    expect(planTopicStringPurge(realRows(), []).affectedRows).toBe(0);
  });

  it('⑨ splitTopicSegments 与 note/helpers 的清洗口径一致（+ 、 ； 都算分隔）', () => {
    expect(splitTopicSegments('A+B、C；D，E,F')).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
    expect(splitTopicSegments('  ')).toEqual([]);
    expect(splitTopicSegments(undefined)).toEqual([]);
  });
});
