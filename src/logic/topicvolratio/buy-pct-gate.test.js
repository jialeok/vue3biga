/**
 * [BUY-PCT-GATE 2026-10-31] 买点侧「9:26 竞价口径未就绪 ⇒ 先不出票」的判据单测。
 *
 * 锁的是三件事（都是会「静默买错票」的红线）：
 *   ① 没读过这一天 ⇒ 必须挂占位（⛔ 不许先拿收盘口径出票）；
 *   ② 读过的日期 ≠ 展示日（切日期那一帧）⇒ 仍然挂占位（⛔ 不许拿 A 日的口径当 B 日用）；
 *   ③ 读过的日期 = 展示日（成功或失败都算）⇒ 放行（⛔ 不许因为一次读失败把买点侧永久锁死）。
 */
import { describe, it, expect } from 'vitest';
import { isBuyPctPending } from './buy-pct-gate.js';

const D = '2026-10-30';
const PREV = '2026-10-29';

describe('isBuyPctPending · 买点侧 9:26 口径门控', function() {
  it('① 还没读过这一天（resolvedDate 为空）⇒ 挂占位', function() {
    expect(isBuyPctPending({ date: D, resolvedDate: '' })).toBe(true);
  });

  it('② 切日期那一帧：读过的还是【上一个展示日】⇒ 仍然挂占位（§10 不拿旧日期顶替）', function() {
    expect(isBuyPctPending({ date: D, resolvedDate: PREV })).toBe(true);
    // ⛔ 这一条是关键：把判据写成 `if (!resolvedDate) return true` 会在这里变成 false ⇒ 用旧日期选股
    expect(isBuyPctPending({ date: D, resolvedDate: PREV })).not.toBe(false);
  });

  it('③ 读过的就是这一天（成功 / 失败都算读过）⇒ 放行', function() {
    expect(isBuyPctPending({ date: D, resolvedDate: D })).toBe(false);
  });

  it('没给展示日 ⇒ 不归本门控管（空态由「未就绪」那一路负责）', function() {
    expect(isBuyPctPending({ date: '', resolvedDate: D })).toBe(false);
    expect(isBuyPctPending({})).toBe(false);
    expect(isBuyPctPending(null)).toBe(false);
  });

  it('空值 / undefined 不能抛错（首帧参数可能缺）', function() {
    expect(isBuyPctPending({ date: D })).toBe(true);
    expect(isBuyPctPending({ date: undefined, resolvedDate: undefined })).toBe(false);
  });

  it('日期带空格也能认亲（读回来的字符串常带空白）', function() {
    expect(isBuyPctPending({ date: ' ' + D + ' ', resolvedDate: D })).toBe(false);
    expect(isBuyPctPending({ date: D, resolvedDate: PREV + ' ' })).toBe(true);
  });
});
