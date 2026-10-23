import { describe, it, expect } from 'vitest';
import {
  SHOUGU_RATIO_NODES,
  SHOUGU_RATIO_LABELS,
  parseShouguRatio,
  ratioToDiezhang,
  ratioToQingxu,
  deriveFromShougu
} from './ratio-nodes.js';

// 用户 2026-10-23 给的原始需求，本文件的每一个断言都直接对应其中一句：
//   「比如昨收盘结果是 4999：535 这个比值是 9.3，四舍五入取整，是 9，那么昨日跌涨自动填上 9：1」
//   「如果是 3364：1918，实际值是 1.76，那就是 3：2 …… 1.76 更接近 3：2，所以用它」
//   「低于 1：4 也是节点，比如 1：5，1：6 等，高于 4：1 也是，比如 7：1，8：1 等」

describe('ratio-nodes / 节点表', () => {
  it('标准节点固定 9 个，且与 UI 下拉同源', () => {
    expect(SHOUGU_RATIO_LABELS).toEqual(['1:4', '1:3', '1:2', '2:3', '1:1', '3:2', '2:1', '3:1', '4:1']);
  });

  it('节点表必须按比值升序（平局裁决依赖这个顺序）', () => {
    const values = SHOUGU_RATIO_NODES.map((n) => n.value);
    const sorted = values.slice().sort((a, b) => a - b);
    expect(values).toEqual(sorted);
  });
});

describe('ratio-nodes / parseShouguRatio', () => {
  it('解析 "跌:涨"', () => {
    expect(parseShouguRatio('4999:535')).toBeCloseTo(9.3439, 3);
    expect(parseShouguRatio('3364:1918')).toBeCloseTo(1.7539, 3);
  });

  it('全角冒号 / 空格 / 数字类型都能解析', () => {
    expect(parseShouguRatio(' 4999 : 535 ')).toBeCloseTo(9.3439, 3);
    expect(parseShouguRatio('3364：1918')).toBeCloseTo(1.7539, 3);
    expect(parseShouguRatio(3364, 1918)).toBeCloseTo(1.7539, 3);
  });

  it('★ 解析不出来必须返回 null，⛔ 不许返回 0（§10 不拿 0 冒充）', () => {
    expect(parseShouguRatio('')).toBeNull();
    expect(parseShouguRatio(':')).toBeNull();
    expect(parseShouguRatio('还没填')).toBeNull();
    expect(parseShouguRatio('4999:0')).toBeNull();   // 涨家数 0 不能做分母
    expect(parseShouguRatio('abc:535')).toBeNull();
  });
});

describe('ratio-nodes / ratioToDiezhang（用户两个原始例子）', () => {
  it('★ 4999:535 ⇒ 9:1（比值 9.3 四舍五入取整 9）', () => {
    expect(ratioToDiezhang(parseShouguRatio('4999:535'))).toBe('9:1');
  });

  it('★ 3364:1918 ⇒ 3:2（不是 2:1：取 2 位小数后 1.75 与 1.5/2.0 等距，平局取小）', () => {
    expect(ratioToDiezhang(parseShouguRatio('3364:1918'))).toBe('3:2');
  });

  it('1:4 / 4:1 本身是节点，边界要落在节点上而不是溢出', () => {
    expect(ratioToDiezhang(4)).toBe('4:1');
    expect(ratioToDiezhang(0.25)).toBe('1:4');
    expect(ratioToDiezhang(3.9)).toBe('4:1');   // 就近 4:1
    expect(ratioToDiezhang(0.26)).toBe('1:4');  // 就近 1:4
  });

  it('低于 1:4 ⇒ 1:N 延伸（1:5 / 1:6 …）', () => {
    expect(ratioToDiezhang(0.2)).toBe('1:5');
    expect(ratioToDiezhang(1 / 6)).toBe('1:6');
    expect(ratioToDiezhang(1 / 10)).toBe('1:10');
  });

  it('高于 4:1 ⇒ N:1 延伸（7:1 / 8:1 …）', () => {
    expect(ratioToDiezhang(7)).toBe('7:1');
    expect(ratioToDiezhang(8.2)).toBe('8:1');
    expect(ratioToDiezhang(12.4)).toBe('12:1');
  });

  it('区间内就近吸附', () => {
    expect(ratioToDiezhang(1)).toBe('1:1');
    expect(ratioToDiezhang(0.5)).toBe('1:2');
    expect(ratioToDiezhang(2)).toBe('2:1');
    expect(ratioToDiezhang(3)).toBe('3:1');
    expect(ratioToDiezhang(0.34)).toBe('1:3');
    expect(ratioToDiezhang(1.4)).toBe('3:2');
    expect(ratioToDiezhang(2.4)).toBe('2:1');
  });

  it('★ 平局必须取较小的一方（升序先到先得），否则 1.75 会翻成 2:1', () => {
    expect(ratioToDiezhang(1.75)).toBe('3:2');   // 与 1.5 / 2.0 等距
    expect(ratioToDiezhang(1.25)).toBe('1:1');   // 与 1.0 / 1.5 等距
  });

  it('非法入参 ⇒ 空串，⛔ 不拿 1:1 冒充', () => {
    expect(ratioToDiezhang(NaN)).toBe('');
    expect(ratioToDiezhang(-1)).toBe('');
    expect(ratioToDiezhang(undefined)).toBe('');
    expect(ratioToDiezhang(0)).toBe('');          // 全红盘：1/r 发散，没有对应节点
  });
});

describe('ratio-nodes / ratioToQingxu（用 jiwang_data 历史真值反推的判据）', () => {
  // 每一行都是数据库里【用户亲手填过】的真实组合：跌:涨 → 已填跌涨 → 已填情绪
  // ⛔ 这四条「节点」和四条「非节点」就是判据本身，改代码不许把它们弄反。
  // ⚠️ expectDiezhang 是【严格四舍五入】的结果；historical 是当年用户手工填的原文。
  //    5108:430 = 11.88 ⇒ 严格算是 12:1，当年手填 10：1（估了个整十）。
  //    差异正是用户要求「自动算」的动机：手填会随手取整，自动算不会。
  const HISTORY = [
    { shougu: '4325:1167', expectDiezhang: '4:1', qingxu: '节点', historical: '4:1' },
    { shougu: '4496:979', expectDiezhang: '5:1', qingxu: '节点', historical: '5：1' },
    { shougu: '5108:430', expectDiezhang: '12:1', qingxu: '节点', historical: '10：1' },
    { shougu: '3748:1698', expectDiezhang: '2:1', qingxu: '非节点', historical: '2:1' },
    { shougu: '3129:2275', expectDiezhang: '3:2', qingxu: '非节点', historical: '3:2' },
    { shougu: '3364:1981', expectDiezhang: '3:2', qingxu: '非节点', historical: '3:2' },
    { shougu: '2145:3297', expectDiezhang: '2:3', qingxu: '非节点', historical: '2:3' },
    { shougu: '2567:2824', expectDiezhang: '1:1', qingxu: '非节点', historical: '1:1' }
  ];

  it('★ 8 条历史真值：情绪判定必须逐条复现，跌涨必须等于严格四舍五入值', () => {
    HISTORY.forEach((row) => {
      const d = deriveFromShougu(row.shougu);
      expect(d, row.shougu).not.toBeNull();
      expect(d.diezhang, row.shougu + ' 跌涨').toBe(row.expectDiezhang);
      expect(d.qingxu, row.shougu + ' 情绪（当年手填 ' + row.historical + '）').toBe(row.qingxu);
    });
  });

  it('★ 三节点边界 4:1 / 1:4 本身算「节点」，往外延伸也算', () => {
    expect(ratioToQingxu(4)).toBe('节点');       // 4:1
    expect(ratioToQingxu(0.25)).toBe('节点');    // 1:4
    expect(ratioToQingxu(8)).toBe('节点');       // 8:1
    expect(ratioToQingxu(0.2)).toBe('节点');     // 1:5
  });

  it('★ 中间档位一律「非节点」（1:1 / 2:1 / 3:2 / 2:3 / 1:2）', () => {
    expect(ratioToQingxu(1)).toBe('非节点');
    expect(ratioToQingxu(2)).toBe('非节点');
    expect(ratioToQingxu(1.5)).toBe('非节点');
    expect(ratioToQingxu(2 / 3)).toBe('非节点');
    expect(ratioToQingxu(0.5)).toBe('非节点');
  });

  it('★ 判据看【简化后的 label】不看原始比值：3.706 原值没到 4，但简化成 4:1 ⇒ 节点', () => {
    expect(ratioToQingxu(4325 / 1167)).toBe('节点');
    expect(ratioToDiezhang(4325 / 1167)).toBe('4:1');
  });

  it('比值非法 ⇒ 空串（⛔ 不猜节点/非节点）', () => {
    expect(ratioToQingxu(NaN)).toBe('');
  });
});

describe('ratio-nodes / deriveFromShougu（UI 只调这一个）', () => {
  it('一次返回 ratio + diezhang + qingxu', () => {
    expect(deriveFromShougu('4999:535')).toEqual({ ratio: 4999 / 535, diezhang: '9:1', qingxu: '节点' });
    expect(deriveFromShougu('3364:1918')).toEqual({ ratio: 3364 / 1918, diezhang: '3:2', qingxu: '非节点' });
  });

  it('解析失败 ⇒ null', () => {
    expect(deriveFromShougu('')).toBeNull();
    expect(deriveFromShougu('0:0')).toBeNull();
  });
});
