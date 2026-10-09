// dragon-rank-change.test.js — 「龙标名次变化」徽标的回归用例
//
// ⭐ [DRAGON-RANK-CHANGE 2026-10-09 用户口径] 用户给出的两笔账就是本文件的验收基准：
//    「昨天是龙一，今天开出来是龙三，那就是 1-3=-2，代表下滑了 2 个名次」
//    「昨日是龙五，今日是龙二，上升了 5-2=3，代表上升了 3 个名次，龙二 +3」
//    「数字前有加减号，不用背景色，上升用红色，下降用绿色」
//    「买点和卖点看板都要标。要简洁，其它不变。」
//   ⛔ 改公式 / 改符号 / 改配色口径之前，先把本文件跑一遍。
//
// 覆盖：① 名次差（含用户两笔账）；② §10 缺值一律不显示（绝不补 0 / 不给 '-'）；
//      ③ 换题材不可比（§10）；④ 行字段写回；⑤ 状态发布 / 清空语义；⑥ CSS 配色没被写反。

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getDragonLabel } from '../auction/dragon-rank.js';
import {
  DRAGON_DELTA_TONE_UP,
  DRAGON_DELTA_TONE_DOWN,
  dragonRankChangeState,
  publishPrevDragonRank,
  clearPrevDragonRank,
  formatDragonRankDelta,
  dragonDeltaOf,
  applyDragonRankChange
} from './dragon-rank-change.js';

const CSS_PATH = fileURLToPath(new URL('../../assets/css/decision-board.css', import.meta.url));

/** 造一条龙位表的行（computeDragonRankMap 的输出形状：{rank, seq, pct, topic, groupSize}） */
function mkRank(topic, rank) {
  return { rank: rank, seq: rank, pct: 10 - rank, topic: topic, groupSize: 8 };
}

/** 造一张龙位表 */
function mkMap(rows) {
  const m = new Map();
  Object.keys(rows).forEach(function(name) { m.set(name, rows[name]); });
  return m;
}

describe('formatDragonRankDelta：名次差的唯一实现（§6）', () => {
  it('⭐ 用户账①：昨日龙一 → 今日龙三 ⇒ 1-3 = -2（下降 2 名，绿）', () => {
    const d = formatDragonRankDelta(1, 3);
    expect(d.delta).toBe(-2);
    expect(d.text).toBe('-2');                       // 负号是数字自带的，⛔ 不另加符号
    expect(d.tone).toBe(DRAGON_DELTA_TONE_DOWN);
    expect(DRAGON_DELTA_TONE_DOWN).toBe('down');
  });

  it('⭐ 用户账②：昨日龙五 → 今日龙二 ⇒ 5-2 = +3（上升 3 名，红）', () => {
    const d = formatDragonRankDelta(5, 2);
    expect(d.delta).toBe(3);
    expect(d.text).toBe('+3');                       // 正数必须【显式带 +】（用户原话「数字前有加减号」）
    expect(d.tone).toBe(DRAGON_DELTA_TONE_UP);
    expect(DRAGON_DELTA_TONE_UP).toBe('up');
  });

  it('名次没变化 ⇒ 不显示（用户口径「要简洁」；不是「未知」，是「无需标注」）', () => {
    expect(formatDragonRankDelta(3, 3)).toBeNull();
    expect(formatDragonRankDelta(1, 1)).toBeNull();
  });

  it('§10：任一侧缺名次 ⇒ null（⛔ 绝不补 0 算出一个假的变化值）', () => {
    const bad = [null, undefined, 0, '', '  ', 'abc', NaN, -1];
    bad.forEach(function(v) {
      expect(formatDragonRankDelta(v, 3), '今日名次=' + String(v)).toBeNull();
      expect(formatDragonRankDelta(3, v), '昨日名次=' + String(v)).toBeNull();
    });
    expect(formatDragonRankDelta(null, null)).toBeNull();
  });

  it('云端回来的字符串名次也认（stock_range_pct / 名册里都是字符串）', () => {
    expect(formatDragonRankDelta('5', '2').text).toBe('+3');
    expect(formatDragonRankDelta('1', '3').text).toBe('-2');
  });

  it('跨 10 名之外照样算（龙十一 / 龙十二…不能只支持个位数）', () => {
    expect(formatDragonRankDelta(12, 3).text).toBe('+9');
    expect(formatDragonRankDelta(2, 12).text).toBe('-10');
  });
});

describe('dragonDeltaOf：一根行上的徽标字段（含「不可比」的全部情形）', () => {
  const today = mkMap({ 甲股: mkRank('AI应用', 1), 乙股: mkRank('AI应用', 3), 丙股: mkRank('农业', 5) });

  it('昨日龙三 → 今日龙一 ⇒ 行上得到 +2 / up / 说明文字写清两个名次', () => {
    const prev = mkMap({ 甲股: mkRank('AI应用', 3) });
    const f = dragonDeltaOf({ name: '甲股' }, prev, today);
    expect(f.text).toBe('+2');
    expect(f.tone).toBe('up');
    // 悬停说明里的名次文案由 getDragonLabel 派生（避免两处分叉）
    expect(f.title).toContain(getDragonLabel(3));
    expect(f.title).toContain(getDragonLabel(1));
    expect(f.title).toContain('上升 2 个名次');
  });

  it('下降方向：昨日龙一 → 今日龙三 ⇒ -2 / down / 「下降 2 个名次」', () => {
    const prev = mkMap({ 乙股: mkRank('AI应用', 1) });
    const f = dragonDeltaOf({ name: '乙股' }, prev, today);
    expect(f.text).toBe('-2');
    expect(f.tone).toBe('down');
    expect(f.title).toContain('下降 2 个名次');
  });

  it('§10 今日没有龙位（如创业板 / 科创板弃权、或今天不在成组题材里）⇒ 空字段', () => {
    const prev = mkMap({ 丁股: mkRank('AI应用', 2) });
    const f = dragonDeltaOf({ name: '丁股' }, prev, today);
    expect(f).toEqual({ text: '', tone: '', title: '' });
  });

  it('§10 昨日没有龙位（不在任何成组题材里）⇒ 空字段，⛔ 不拿今日名次当「没变化」', () => {
    const f = dragonDeltaOf({ name: '甲股' }, mkMap({}), today);
    expect(f).toEqual({ text: '', tone: '', title: '' });
  });

  it('§10 昨日龙位表还没算出来（null / 空表）⇒ 空字段', () => {
    expect(dragonDeltaOf({ name: '甲股' }, null, today)).toEqual({ text: '', tone: '', title: '' });
    expect(dragonDeltaOf({ name: '甲股' }, new Map(), today)).toEqual({ text: '', tone: '', title: '' });
    expect(dragonDeltaOf({ name: '甲股' }, mkMap({ 甲股: mkRank('AI应用', 2) }), null).text).toBe('');
  });

  it('🔴 §10 昨今【不在同一个题材】⇒ 不可比、不显示（龙位是题材内的相对名次，换题材相减没有意义）', () => {
    // 丙股：昨日归在「AI应用」且是龙一，今日归在「农业」是龙五 ——
    // 两个名次分属两张排行榜（不同题材、不同竞争者），相减出来的是个看着很像真的假数字。
    const prev = mkMap({ 丙股: mkRank('AI应用', 1) });
    const f = dragonDeltaOf({ name: '丙股' }, prev, today);
    expect(f).toEqual({ text: '', tone: '', title: '' });
    // 反证：同一份「昨日龙一」只要题材一致，就该照常给出 1-5 = -4（说明上面那条拦的是【题材】、不是名次）
    const sameTopic = dragonDeltaOf({ name: '丙股' }, mkMap({ 丙股: mkRank('农业', 1) }), today);
    expect(sameTopic.text).toBe('-4');
    expect(sameTopic.tone).toBe('down');
  });

  it('名次没变 ⇒ 空字段', () => {
    const prev = mkMap({ 甲股: mkRank('AI应用', 1) });
    const f = dragonDeltaOf({ name: '甲股' }, prev, today);
    expect(f).toEqual({ text: '', tone: '', title: '' });
  });

  it('空名 / 缺行 ⇒ 空字段，不抛错（模板遍历每行都会调它）', () => {
    const prev = mkMap({ 甲股: mkRank('AI应用', 3) });
    expect(dragonDeltaOf(null, prev, today).text).toBe('');
    expect(dragonDeltaOf({ name: '' }, prev, today).text).toBe('');
    expect(dragonDeltaOf({}, prev, today).text).toBe('');
  });
});

describe('applyDragonRankChange：字段写回行上（§21 模板只 {{ }}）', () => {
  const today = mkMap({ 甲股: mkRank('AI应用', 1) });

  it('有可比名次 ⇒ 三个字段齐全', () => {
    const row = { name: '甲股' };
    applyDragonRankChange(row, mkMap({ 甲股: mkRank('AI应用', 4) }), today);
    expect(row.dragonDeltaText).toBe('+3');
    expect(row.dragonDeltaTone).toBe('up');
    expect(row.dragonDeltaTitle).toBeTruthy();
  });

  it('无可比 ⇒ 三个字段都是【空串】（模板 v-if 一个判断就够，⛔ 不是 null / '-'）', () => {
    const row = { name: '甲股' };
    applyDragonRankChange(row, null, today);
    expect(row.dragonDeltaText).toBe('');
    expect(row.dragonDeltaTone).toBe('');
    expect(row.dragonDeltaTitle).toBe('');
  });
});

describe('dragonRankChangeState：前一交易日龙位表的发布 / 清空（§6 一份 / §10 不猜）', () => {
  it('发布后 loaded = true，且日期与表都是发布的那一份', () => {
    publishPrevDragonRank('2026-10-08', mkMap({ 甲股: mkRank('AI应用', 1) }));
    expect(dragonRankChangeState.date).toBe('2026-10-08');
    expect(dragonRankChangeState.loaded).toBe(true);
    expect(dragonRankChangeState.map.get('甲股').rank).toBe(1);
    const v = dragonRankChangeState.version;
    clearPrevDragonRank();
    expect(dragonRankChangeState.loaded).toBe(false);
    expect(dragonRankChangeState.date).toBe('');
    expect(dragonRankChangeState.map.size).toBe(0);
    expect(dragonRankChangeState.version).toBeGreaterThan(v);   // 换引用 → 驱动看板重算
  });

  it('发布非 Map 的脏值 ⇒ 落成空 Map、但 loaded 仍为 true（避免反复重试）', () => {
    publishPrevDragonRank('2026-10-08', null);
    expect(dragonRankChangeState.map.size).toBe(0);
    expect(dragonRankChangeState.loaded).toBe(true);
    clearPrevDragonRank();
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════
   样式红线：用户明确指定「上升用红色，下降用绿色」，而这类【配色对调】是改样式时最容易
   顺手改错、且没有任何逻辑测试能发现的一类事故（符号还是对的，颜色反了 → 读成完全相反的结论）。
   所以这里直接读 CSS 断言两个配色档的色值方向，把它钉死在测试里。
   ══════════════════════════════════════════════════════════════════════════════════════ */
describe('CSS：名次变化的配色方向（上升红 / 下降绿，A 股口径）', () => {
  const css = fs.readFileSync(CSS_PATH, 'utf8');

  function blockOf(selector) {
    const i = css.indexOf(selector);
    expect(i, '样式里找不到 ' + selector).toBeGreaterThan(-1);
    const open = css.indexOf('{', i);
    const close = css.indexOf('}', open);
    return css.slice(open, close);
  }

  it('.dcb-dragon-delta 本体【不给底色】（用户原话「不用背景色」）', () => {
    const body = blockOf('.dcb-dragon-delta {');
    expect(body).not.toContain('background');
    expect(body).not.toContain('border');
  });

  it('上升档 = 红（#dc2626 系）；下降档 = 绿（#16a34a 系）—— ⛔ 别改成涨绿跌红', () => {
    expect(blockOf('.dcb-dragon-delta-up').toLowerCase()).toContain('#dc2626');
    expect(blockOf('.dcb-dragon-delta-down').toLowerCase()).toContain('#16a34a');
  });
});
