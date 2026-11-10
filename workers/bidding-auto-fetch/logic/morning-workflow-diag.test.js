// morning-workflow-diag.test.js — [CLOUD-0927-HEAL 2026-11-11] 锁住「完整性汇总引用作用域外变量」
//
// 事故复盘：给 9:25 的 buildCompletenessSummary 加组B 读失败判据时，直接写了
//   `const groupBReadFailures = [prevWlRes, todayWlRes, tagRes, dragonRes, range20Res]...`
//   但这 5 个 settled 结果是 **fetchAndWriteWatchlist 内部的局部变量**，runMorning 作用域里
//   根本不存在 ⇒ 线上 9:25 一跑到汇总就 ReferenceError ⇒ 整轮早盘崩、一张表都不写。
//   worker 侧单测没覆盖 runMorning 主路径，vitest 全绿；是 `eslint no-undef` 抓到的。
//
// 契约：组B 的诊断只能由 fetchAndWriteWatchlist 通过返回值 `groupBDiag` 显式带出，
//   runMorning 从 watchlistResult 解构使用；⛔ 不许在 runMorning 里直接引用组B 局部变量。
//
// 本文件用纯文本静态锁（不 import morning-workflow.js，避免拉起整张 Worker 依赖图），
// 与 cron-map.test.js 同一套路。CI 另有一道 `npx eslint src workers --quiet` 兜底。

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, 'morning-workflow.js'), 'utf8');
const AT = SRC.indexOf('export async function runMorning');
const HELPERS = SRC.slice(0, AT);          // fetchAndWriteWatchlist 等辅助函数
const RUN_MORNING = SRC.slice(AT);         // runMorning 是文件里最后一个顶层函数

const GROUP_B_LOCALS = ['prevWlRes', 'todayWlRes', 'tagRes', 'dragonRes', 'range20Res'];

describe('9:25 组B 诊断的跨函数契约（防 ReferenceError 整轮崩）', () => {
  it('① runMorning 存在且是文件最后一个顶层函数（切片前提成立）', () => {
    expect(AT).toBeGreaterThan(0);
    expect(RUN_MORNING).toContain('buildCompletenessSummary(');
  });

  it('② fetchAndWriteWatchlist 必须把组B 诊断装进 groupBDiag 并显式带出', () => {
    expect(HELPERS).toContain('const groupBDiag = {');
    expect(HELPERS).toContain('groupBReadFailures: groupBReadFailures');
    expect(HELPERS).toContain('dragonRosterEmpty: dragonRosterEmpty');
    // 三个正常/降级返回点都要带出（error 分支也带，共 4 处引用）
    const carried = HELPERS.match(/groupBReadFailures: groupBDiag\.groupBReadFailures/g) || [];
    expect(carried.length).toBeGreaterThanOrEqual(3);
  });

  it('③ runMorning 必须从 watchlistResult 解构这三项，而不是自己重算', () => {
    expect(RUN_MORNING).toMatch(/const \{[^}]*groupBReadFailures,\s*dragonRosterEmpty,\s*prevDay[^}]*\}\s*=\s*watchlistResult/s);
    expect(RUN_MORNING).toContain('groupBReadFailures: groupBReadFailures');
  });

  it('④ ★ runMorning 里绝不许出现 fetchAndWriteWatchlist 的组B 局部变量', () => {
    GROUP_B_LOCALS.forEach(name => {
      // 注释里提到名字可以（事故复盘注释），但代码引用（标识符后跟 . / , / [ / ) / 空格比较符）不行。
      const codeUse = new RegExp('(^|[^A-Za-z0-9_./\'-])' + name + '\\s*(?:\\.|,|\\]|\\)|===|!==|&&|\\|\\|)', 'm');
      expect(RUN_MORNING.match(codeUse)).toBeNull();
    });
  });

  it('⑤ 组B 读失败/龙头空必须真的进完整性汇总，不能只打日志', () => {
    expect(RUN_MORNING).toContain('groupBReadFailures: groupBReadFailures');
    expect(RUN_MORNING).toContain('dragonRosterEmpty: dragonRosterEmpty');
    expect(HELPERS).toContain('x.groupBReadFailures');
  });
});
