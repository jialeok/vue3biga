// src/logic/auction/volume-cell.test.js
// [VOL-CELL 2026-11-04] 「竞价量(万) / 昨成交量(万)」显示口径的单测。
//
// 用户报障原话：「UI上还是显示0或者-，但是五日趋势图当天是有竞价量和昨日成交量的」
// 这里锁住三条：
//   ① 有值不许被四舍五入成 0（0.4 万手 = 400 手，小盘票竞价很常见）；
//   ② 空值 / 无法解析 ⇒ '-'（§10 缺 ≠ 0）；
//   ③ ≥1 仍然取整（既有 UI 口径不变，§11 默认无行为）。
import { describe, it, expect } from 'vitest';
import { formatVolumeCell } from './view-helpers.js';

describe('formatVolumeCell（竞价量显示口径）', () => {
  it('0 < v < 1 保留 1 位小数，绝不抹成 0', () => {
    expect(formatVolumeCell('0.4')).toBe('0.4');
    expect(formatVolumeCell(0.46)).toBe('0.5');
    expect(formatVolumeCell('0.04')).toBe('0.0');
  });

  it('≥1 取整（既有口径不变）', () => {
    expect(formatVolumeCell('193')).toBe(193);
    expect(formatVolumeCell('7.3')).toBe(7);
    expect(formatVolumeCell(15556)).toBe(15556);
  });

  it('空值 / 无法解析 ⇒ 横杠（§10 缺 ≠ 0）', () => {
    expect(formatVolumeCell('')).toBe('-');
    expect(formatVolumeCell(null)).toBe('-');
    expect(formatVolumeCell(undefined)).toBe('-');
    expect(formatVolumeCell('abc')).toBe('-');
  });

  it('字符串 0 保持 0（真·0 是事实；假 0 已在 Data 层归一为缺失）', () => {
    expect(formatVolumeCell('0')).toBe(0);
  });
});
