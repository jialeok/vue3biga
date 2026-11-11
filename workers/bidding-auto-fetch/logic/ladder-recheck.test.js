// ladder-recheck.test.js — [LADDER26 2026-11-06] 9:26 云端二次确认的纯函数回归锁
//
// 锁住四件「错一次就是 P0」的事实：
//   ① 9:25 已写足量真实名单 ⇒ 9:26 必须 0 请求跳过（不重复烧猫抓额度）；
//   ② 只有猫抓量比缺失 / 整行缺失才进补抓名单，且「只补量比」的行绝不覆盖其它字段；
//   ③ 兜底名单 source=worker-fallback 不算「真实名单达标」，必须触发二次确认；
//   ④ 竞价量比只认猫抓 —— 本模块不得出现任何同花顺量比字段。
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  countRealLadderRows,
  needsLadderRecheck,
  pickNumcatTargets,
  buildAucMetricsWriteRows
} from './ladder-recheck.js';
import { MIN_LADDER_ROWS } from './ladder-heal.js';

const TODAY = '2026-11-06';
const NOW = '2026-11-06T01:26:05.000Z';

function realRows(n, source) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      name: '票' + i,
      code: String(600000 + i),
      source: source || 'worker',
      obs_auto_added: false
    });
  }
  return out;
}

describe('countRealLadderRows / needsLadderRecheck', () => {
  it('足量真实名单 ⇒ 9:26 直接跳过（0 上游请求、0 猫抓额度）', () => {
    const rows = realRows(MIN_LADDER_ROWS);
    expect(countRealLadderRows(rows)).toBe(MIN_LADDER_ROWS);
    expect(needsLadderRecheck(rows)).toBe(false);
  });

  it('只差一行也要二次确认（门槛是 >=，不是 >）', () => {
    expect(needsLadderRecheck(realRows(MIN_LADDER_ROWS - 1))).toBe(true);
  });

  it('兜底名单 / 观察组壳行 / 无 code 行都不算真实名单', () => {
    const rows = realRows(MIN_LADDER_ROWS + 5, 'worker-fallback')
      .concat(realRows(10, 'worker').map(r => Object.assign({}, r, { obs_auto_added: true })))
      .concat(realRows(10, 'worker').map(r => Object.assign({}, r, { code: '' })));
    expect(countRealLadderRows(rows)).toBe(0);
    expect(needsLadderRecheck(rows)).toBe(true);
  });

  it('空表 / null 也要二次确认（9:25 整轮没跑成的场景）', () => {
    expect(needsLadderRecheck([])).toBe(true);
    expect(needsLadderRecheck(null)).toBe(true);
  });
});

describe('pickNumcatTargets', () => {
  const ladder = [
    { name: 'A', code: '600001' },
    { name: 'B', code: '600002' },
    { name: 'C', code: '600003' },
    { name: 'D', code: '600004' }
  ];

  it('无行→整行补；有行缺量比→只补量比；已有量比→完全不碰', () => {
    const metrics = [
      { name: 'B', code: '600002', auc_vol_ratio: '' },
      { name: 'C', code: '600003', auc_vol_ratio: '3.21' }
    ];
    const t = pickNumcatTargets(ladder, metrics);
    expect(t.symbols).toEqual(['600001', '600002', '600004']);
    expect(t.fullRows).toEqual([
      { name: 'A', code: '600001' },
      { name: 'D', code: '600004' }
    ]);
    expect(t.ratioOnly).toEqual([{ name: 'B', code: '600002' }]);
  });

  it('全都有量比 ⇒ symbols 为空（调用方据此跳过，绝不白烧 1 次猫抓额度）', () => {
    const metrics = ladder.map(x => ({ name: x.name, code: x.code, auc_vol_ratio: '1.00' }));
    expect(pickNumcatTargets(ladder, metrics).symbols).toEqual([]);
  });

  it('过滤非法 code、按 code 去重；量比 null / undefined / 空白都算缺失', () => {
    const t = pickNumcatTargets(
      [{ name: 'X', code: '' }, { name: 'A', code: '600001' }, { name: 'A2', code: '600001' }],
      [{ name: 'A', code: '600001', auc_vol_ratio: null }]
    );
    expect(t.symbols).toEqual(['600001']);
    expect(t.ratioOnly).toHaveLength(1);
  });

  // ★★ [RANGE20-RATIO-HEAL 2026-11-11] 20 日涨幅补位票不写 watchlist、不在 ladder 里。
  //   旧实现只遍历 ladder ⇒ 它们「有行但缺量比」时 9:26 永远补不到（青岛食品事故）。
  it('★★ ladder 为空 + includeAllRows ⇒ 当日已有行但缺量比的票仍进入补抓', () => {
    const metrics = [
      { name: '青岛食品', code: '001219', auc_vol_ratio: '' },
      { name: '海洋王', code: '002724', auc_vol_ratio: '1.94' },
    ];
    const off = pickNumcatTargets(null, metrics);
    expect(off.symbols).toEqual([]);                 // 没开开关 ⇒ 一个都不补（旧行为）
    const on = pickNumcatTargets(null, metrics, { includeAllRows: true });
    expect(on.symbols).toEqual(['001219']);          // 只补缺的那只，已有量比的不碰
    expect(on.ratioOnly).toEqual([{ name: '青岛食品', code: '001219' }]);
    expect(on.fullRows).toEqual([]);                 // ⛔ 不新建整行
  });

  it('includeAllRows 与 ladder 叠加时按 code 去重，不重复请求同一只票', () => {
    const ladder = [{ name: '青岛食品', code: '001219' }];
    const metrics = [{ name: '青岛食品', code: '001219', auc_vol_ratio: '' }];
    const on = pickNumcatTargets(ladder, metrics, { includeAllRows: true });
    expect(on.symbols).toEqual(['001219']);
    expect(on.ratioOnly).toHaveLength(1);
  });

  it('includeAllRows 只收 6 位 code 的行（ths-patch 壳行无 code 时不能白烧额度）', () => {
    const metrics = [
      { name: '无码票', code: '', auc_vol_ratio: '' },
      { name: '青岛食品', code: '001219', auc_vol_ratio: '' },
    ];
    const on = pickNumcatTargets(null, metrics, { includeAllRows: true });
    expect(on.symbols).toEqual(['001219']);
  });
});

describe('buildAucMetricsWriteRows', () => {
  const parsed = [
    {
      stock: 'A', code: '600001', volume: '1.2', change_pct: '+2.00%', yest_volume: '9',
      auc_pct_chg: '+2.00%', um_vol: '', open_bid_pct: '1.10',
      auc_vol_ratio: '5.43', auc_turnover: '0.80'
    },
    {
      stock: 'B', code: '600002', volume: '', change_pct: '', yest_volume: '',
      auc_pct_chg: '', um_vol: '', open_bid_pct: '', auc_vol_ratio: '2.10', auc_turnover: ''
    }
  ];
  const targets = {
    fullRows: [{ name: 'A', code: '600001' }],
    ratioOnly: [{ name: 'B', code: '600002' }]
  };

  it('新票写整行，但只带猫抓实际给了值的字段（空值不覆盖成 ""）', () => {
    const rows = buildAucMetricsWriteRows(parsed, TODAY, NOW, targets);
    const full = rows.find(r => r.stock === 'A');
    expect(full.scope).toBe('auction');
    expect(full.source).toBe('worker');
    expect(full.auc_vol_ratio).toBe('5.43');
    expect(full.volume).toBe('1.2');
    expect(full.um_vol).toBeUndefined();       // 空值不带 ⇒ merge 不抹已有值
    expect(full.updated_by).toBe('auto-fetch-worker');
  });

  it('已有票只带 auc_vol_ratio 一列，⛔ 不带 volume / change_pct / source（§11）', () => {
    const rows = buildAucMetricsWriteRows(parsed, TODAY, NOW, targets);
    const ratio = rows.find(r => r.stock === 'B');
    expect(Object.keys(ratio).sort()).toEqual(
      ['auc_vol_ratio', 'date', 'scope', 'stock', 'updated_at', 'updated_by'].sort()
    );
    expect(ratio.auc_vol_ratio).toBe('2.10');
    expect(ratio.volume).toBeUndefined();
    expect(ratio.source).toBeUndefined();
  });

  it('猫抓没给量比 / 没这只票 ⇒ 一行都不写（宁缺勿错，⛔ 不拿同花顺顶替）', () => {
    const rows = buildAucMetricsWriteRows(
      [{ stock: 'A', code: '600001', auc_vol_ratio: '' }], TODAY, NOW, targets
    );
    expect(rows).toEqual([]);
  });
});

// ============================================================================
// [AUC-RATIO-NUMCAT-ONLY · 用户 2026-10-26 / 11-04 / 11-06 三次铁口径]
// 静态架构锁：worker 侧任何【非测试源码】都不得把同花顺 auction_volume_ratio
// 赋给库内 auc_vol_ratio。单条动态单测只能锁一个函数，加新入口时容易漏，故全量扫源码。
// 注释里提到「已删除 / 永远不许」是允许的：先把注释行剥掉，只检查可执行代码。
// ============================================================================
describe('竞价量比唯一来源（静态锁）', () => {
  function sourceFiles() {
    const dirs = [
      fileURLToPath(new URL('./', import.meta.url)),
      fileURLToPath(new URL('../data/', import.meta.url))
    ];
    const out = [];
    dirs.forEach(dir => {
      readdirSync(dir).forEach(f => {
        if (f.endsWith('.js') && !f.endsWith('.test.js')) out.push(dir + '/' + f);
      });
    });
    out.push(fileURLToPath(new URL('../index.js', import.meta.url)));
    return out;
  }

  function executableCode(src) {
    return src.split(/\r?\n/).filter(line => {
      const t = line.trim();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
    }).map(line => line.replace(/\/\/.*$/, '')).join('\n');
  }

  it('worker 侧所有非测试源码：⛔ 不存在 auc_vol_ratio ← 同花顺 auction_volume_ratio', () => {
    const offenders = [];
    sourceFiles().forEach(f => {
      const code = executableCode(readFileSync(f, 'utf8'));
      if (/auc_vol_ratio\s*[:=][^;,\n]*auction_volume_ratio/.test(code)
        || /auction_volume_ratio[^;,\n]*=>\s*auc_vol_ratio/.test(code)) {
        offenders.push(f);
      }
    });
    expect(offenders).toEqual([]);
  });

  it('9:26 补抓模块不得引入同花顺竞价快照（从依赖上封死兜底路径）', () => {
    const code = executableCode(readFileSync(
      fileURLToPath(new URL('./ladder-recheck.js', import.meta.url)), 'utf8'
    ));
    expect(code).not.toContain('fetchAuctionSnapshot');
    expect(code).not.toContain('auction_volume_ratio');
    expect(code).toContain('numcatDailyAuc');   // 唯一合法来源
  });
});
