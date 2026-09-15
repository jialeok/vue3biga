import { describe, it, expect } from 'vitest';
import { pickTopicLeaders, buildTopicGroupsFromPool, planRosterReconcile } from './dragon-leader-pick.js';

// 便捷构造：股票名 → {pct}
function rp(entries) {
  const m = new Map();
  Object.keys(entries).forEach(function(k) { m.set(k, { pct: entries[k] }); });
  return m;
}

describe('pickTopicLeaders 龙头评选（题材成员>=3 选区间涨幅最高）', () => {
  it('成员>=3 → 选出区间涨幅最高者，并带上题材/成员数', () => {
    const groups = [
      { topic: '机器人', stocks: [{ stock: '甲' }, { stock: '乙' }, { stock: '丙' }] }
    ];
    const out = pickTopicLeaders(groups, rp({ 甲: 5.1, 乙: 31.7, 丙: 12.0 }), 3, () => 'SH600000');
    expect(out).toHaveLength(1);
    expect(out[0].topic).toBe('机器人');
    expect(out[0].stock).toBe('乙');
    expect(out[0].pct).toBe(31.7);
    expect(out[0].groupSize).toBe(3);
    expect(out[0].code).toBe('SH600000');
  });

  it('成员 < 3 → 不评选（需求：三只及以上）', () => {
    const groups = [
      { topic: 'A', stocks: [{ stock: '甲' }, { stock: '乙' }] },
      { topic: 'B', stocks: [{ stock: '丙' }] }
    ];
    expect(pickTopicLeaders(groups, rp({ 甲: 99, 乙: 1, 丙: 88 }), 3, () => '')).toEqual([]);
  });

  it('【红线】区间涨幅缺失的成员不参与比较，绝不当 0 选成龙头', () => {
    const groups = [
      { topic: 'T', stocks: [{ stock: '最差' }, { stock: '缺值' }, { stock: '较好' }] }
    ];
    // 若「缺值(null)」被当作 0，它就会压过 -8.2 / -3.0 被选成龙头（正是要禁止的错值）。
    const out = pickTopicLeaders(groups, rp({ 最差: -8.2, 缺值: null, 较好: -3.0 }), 3, () => '');
    expect(out).toHaveLength(1);
    expect(out[0].stock).toBe('较好');
    expect(out[0].pct).toBe(-3.0);
  });

  it('一个题材内所有成员都无值 → 该题材本次无龙头（不产出空行）', () => {
    const groups = [
      { topic: 'T', stocks: [{ stock: '甲' }, { stock: '乙' }, { stock: '丙' }] }
    ];
    expect(pickTopicLeaders(groups, rp({ 甲: null, 乙: null, 丙: null }), 3, () => '')).toEqual([]);
    // 区间涨幅表整体为空（Map 为空）→ 同样不评选
    expect(pickTopicLeaders(groups, new Map(), 3, () => '')).toEqual([]);
  });

  it('同幅 → 取分组顺序中先出现的（稳定，不引入随机性）', () => {
    const groups = [
      { topic: 'T', stocks: [{ stock: '先' }, { stock: '后' }, { stock: '尾' }] }
    ];
    const out = pickTopicLeaders(groups, rp({ 先: 20, 后: 20, 尾: 20 }), 3, () => '');
    expect(out[0].stock).toBe('先');
  });

  it('多个题材各自选一只；行上自带的 code 优先于兜底解析函数', () => {
    const groups = [
      { topic: 'A', stocks: [{ stock: '甲', code: 'OWN' }, { stock: '乙' }, { stock: '丙' }] },
      { topic: 'B', stocks: [{ stock: '丁' }, { stock: '戊' }, { stock: '己' }] }
    ];
    const out = pickTopicLeaders(groups, rp({ 甲: 30, 乙: 10, 丙: 1, 丁: 2, 戊: 9, 己: 3 }), 3, () => 'FB');
    expect(out.map(function(r) { return r.topic + ':' + r.stock; })).toEqual(['A:甲', 'B:戊']);
    expect(out[0].code).toBe('OWN'); // 行上自带 → 不被兜底覆盖
    expect(out[1].code).toBe('FB');  // 行上缺失 → 用兜底解析
  });

  it('非法输入（undefined / 空 stocks）不抛错', () => {
    expect(pickTopicLeaders(null, rp({}), 3, () => '')).toEqual([]);
    expect(pickTopicLeaders([{ topic: 'T' }, null], rp({}), 3, () => '')).toEqual([]);
  });
});

// ============================================================================
// 2026-09-14 回归：分组口径必须与「单独打开题材 toggle」一致
// 用户实测：9/11 题材 toggle 里「大消费」龙一=国芳集团 96.04%、龙二=桂林旅游 60.23%，
// 但 9/14 龙头组里桂林旅游也在 —— 因为旧实现用【第二页】口径分组（一只票可属多个题材），
// 桂林旅游另属某个题材并当上了那个题材的龙头。修正后：一只票只归一个主题材 → 一个题材只有一只龙头。
// ============================================================================
describe('buildTopicGroupsFromPool 分组口径（一只票只归一个题材 / 不评"其它"）', () => {
  const pool = [
    { stock: '国芳集团', code: 'SH600086' },
    { stock: '桂林旅游', code: 'SH600976' },
    { stock: '大消费甲' },
    { stock: '无题材乙' }
  ];
  // 模拟题材 toggle 的归属解析：桂林旅游虽然也命中"旅游"，但主题材是"大消费"（只归一个）
  const topicByStock = { 国芳集团: '大消费', 桂林旅游: '大消费', 大消费甲: '大消费', 无题材乙: '其它' };
  const resolveTopic = (row) => topicByStock[row.stock] || '其它';

  it('用户实测场景：大消费只产出唯一一只龙头（国芳集团），桂林旅游不入选', () => {
    const groups = buildTopicGroupsFromPool(pool, resolveTopic, () => 'FB');
    expect(groups).toHaveLength(1);                 // '其它' 不建组
    expect(groups[0].topic).toBe('大消费');
    expect(groups[0].stocks.map(s => s.stock)).toEqual(['国芳集团', '桂林旅游', '大消费甲']);

    const picked = pickTopicLeaders(groups, rp({ 国芳集团: 96.04, 桂林旅游: 60.23, 大消费甲: 12 }), 3, () => '');
    expect(picked).toHaveLength(1);
    expect(picked[0].topic).toBe('大消费');
    expect(picked[0].stock).toBe('国芳集团');       // ← 修好的关键断言
    expect(picked[0].pct).toBe(96.04);
  });

  it('"其它" 不参与评选（它不是题材）', () => {
    const onlyOther = [{ stock: 'A' }, { stock: 'B' }, { stock: 'C' }];
    const groups = buildTopicGroupsFromPool(onlyOther, () => '其它', () => '');
    expect(groups).toEqual([]);
    expect(pickTopicLeaders(groups, rp({ A: 99, B: 98, C: 97 }), 3, () => '')).toEqual([]);
  });

  it('同名只保留一次（双保险），空行/无名行被丢弃', () => {
    const messy = [{ stock: '甲' }, { stock: ' 甲 ' }, { stock: '   ' }, null, { noStock: 1 }, { stock: '乙' }];
    const groups = buildTopicGroupsFromPool(messy, () => 'T', () => '');
    expect(groups).toHaveLength(1);
    expect(groups[0].stocks.map(s => s.stock)).toEqual(['甲', '乙']);
  });

  it('code 取值：行上自带优先，缺失用兜底解析', () => {
    const groups = buildTopicGroupsFromPool([{ stock: '甲', code: 'OWN' }, { stock: '乙' }], () => 'T', () => 'FB');
    expect(groups[0].stocks).toEqual([{ stock: '甲', code: 'OWN' }, { stock: '乙', code: 'FB' }]);
  });

  it('无解析器 / 空池 → 返回空分组（宁缺勿错，不瞎猜题材）', () => {
    expect(buildTopicGroupsFromPool(pool, null, () => '')).toEqual([]);
    expect(buildTopicGroupsFromPool([], () => 'T', () => '')).toEqual([]);
    expect(buildTopicGroupsFromPool(null, () => 'T', () => '')).toEqual([]);
  });

  it('解析器返回空串 → 丢弃（不建空名题材组）', () => {
    expect(buildTopicGroupsFromPool([{ stock: '甲' }], () => '', () => '')).toEqual([]);
  });
});

// ============================================================================
// 2026-09-15 回归：名册「整表对齐」的删除判定
// 用户实测：9/15 那次评选因共享题材库未就绪，把 33/39 只股票误分到「其它」→ 只写出 1 行
// （AI应用→桂林旅游）；而 dragon_leaders 主键 (date,topic) + upsert「只增不删」
//   + 「名册非空即视为已评选」⇒ 这行残缺被永久冻结，9/16 整天只显示 1 只龙头。
// 修法：权威评选后必须清掉「本次已不成立（成员数 < 3）」的题材行（小范围、精确匹配，§11）。
// ============================================================================
describe('planRosterReconcile 整表对齐（删过期题材行 / 一致则零写入）', () => {
  const row = (topic, stock, rangePct, groupSize) => ({ topic, stock, rangePct, groupSize });

  it('【核心回归】残缺名册（只剩 1 题材）→ 清掉已不成立的旧题材行', () => {
    const existing = [
      row('AI应用', '桂林旅游', 52.18, 3),
      row('农业', '新农开发', 19.22, 9),      // ← 本次分组里成员已不足门槛（分类退化时代的残留）
      row('化工', '九鼎新材', 34.04, 4)
    ];
    const picked = [{ topic: 'AI应用', stock: '桂林旅游', pct: 52.18, groupSize: 3 }];
    const plan = planRosterReconcile(existing, picked, new Set(['AI应用']));
    expect(plan.expired.slice().sort()).toEqual(['农业', '化工'].sort());
    expect(plan.unchanged).toBe(false);
  });

  it('【§10】成员数够但暂时查不到区间涨幅的题材 → 保留旧行，绝不当成「没有龙头」删掉', () => {
    const existing = [row('半导体', '崇达技术', 43.18, 6)];
    // 本次 半导体 仍然达门槛（在 qualifyingTopics 里），只是这一轮 pick 没产出（涨幅值缺失）
    const plan = planRosterReconcile(existing, [], new Set(['半导体']));
    expect(plan.expired).toEqual([]);         // ← 关键：不删
    expect(plan.unchanged).toBe(false);       // 行数不一致 → 仍需走写路径（但不会删）
  });

  it('名册与本次结果逐字段一致 → unchanged（零写入，避免每次开看板刷 updated_at）', () => {
    const existing = [
      row('农业', '新农开发', 19.22, 9),
      row('AI应用', '上海电影', 27.45, 3)
    ];
    const picked = [
      { topic: 'AI应用', stock: '上海电影', pct: 27.45, groupSize: 3 },
      { topic: '农业', stock: '新农开发', pct: 19.22, groupSize: 9 }
    ];
    const plan = planRosterReconcile(existing, picked, new Set(['农业', 'AI应用']));
    expect(plan.expired).toEqual([]);
    expect(plan.unchanged).toBe(true);
  });

  it('同题材换龙头 / 涨幅变化 / 成员数变化 → 均判为需写入', () => {
    const base = [row('农业', '新农开发', 19.22, 9)];
    const quals = new Set(['农业']);
    expect(planRosterReconcile(base, [{ topic: '农业', stock: '百大集团', pct: 36.83, groupSize: 9 }], quals).unchanged).toBe(false);
    expect(planRosterReconcile(base, [{ topic: '农业', stock: '新农开发', pct: 20.00, groupSize: 9 }], quals).unchanged).toBe(false);
    expect(planRosterReconcile(base, [{ topic: '农业', stock: '新农开发', pct: 19.22, groupSize: 10 }], quals).unchanged).toBe(false);
    // 云端 range_pct 是 text（可能形如 "+19.22"），与数值 19.22 视为相同（<0.005 容差）→ 不写
    expect(planRosterReconcile([row('农业', '新农开发', '19.22', 9)], [{ topic: '农业', stock: '新农开发', pct: 19.22, groupSize: 9 }], quals).unchanged).toBe(true);
  });

  it('空名册 + 空结果 → unchanged（无龙头且本来就没有 → 不必写）', () => {
    expect(planRosterReconcile([], [], new Set())).toEqual({ expired: [], unchanged: true });
  });

  it('名册为空但本次选出了龙头 → 需写入', () => {
    const plan = planRosterReconcile([], [{ topic: '农业', stock: '甲', pct: 5, groupSize: 3 }], new Set(['农业']));
    expect(plan.expired).toEqual([]);
    expect(plan.unchanged).toBe(false);
  });

  it('非法输入（null/undefined/缺 qualifyingTopics）不抛错', () => {
    expect(planRosterReconcile(null, null, null)).toEqual({ expired: [], unchanged: true });
    expect(planRosterReconcile(undefined, [{ topic: 'T', stock: '甲', pct: 1, groupSize: 3 }], undefined)).toEqual({ expired: [], unchanged: false });
  });
});
