// _check_bundle.mjs — 单文件打包产物体检（可 CLI 运行，也可被 _bundle.mjs import）
//
// 为什么需要它：`_bundle.mjs` 把所有模块拼进【同一个作用域】，所以任何顶层标识符
// 重名都会在 Cloudflare 部署时报 `Identifier 'X' has already been declared`。
//
// 最阴的一种重名不是打包器产生的，而是【部署时把新旧两份代码粘在一起】：
//   旧内容占 1..N 行，新内容又从第 1 行开始 → 第二个 `function beijingNow`
//   落在全局第 N+8 行。2026-09-15 真实事故：旧包 1110 行 + 新包 → 报错行号 1117。
//   本脚本能把这个类别一次性扫出来（含行号），避免再靠肉眼找。
//
// CLI: node workers/_check_bundle.mjs [bundlePath]

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/**
 * 扫描【顶层】标识符声明。
 * @returns {Map<string, {line:number, kind:string}[]>}
 */
export function scanTopLevelDecls(src) {
  const decls = new Map();
  let depth = 0;
  let i = 0;
  let line = 1;
  let state = 'code'; // code | line-comment | block-comment | sq | dq | tpl
  let stmtStart = 0;

  const push = (name, lineNo, kind) => {
    if (!decls.has(name)) decls.set(name, []);
    decls.get(name).push({ line: lineNo, kind });
  };

  const atTopStmtPos = (idx) => {
    let j = idx - 1;
    while (j >= 0 && (src[j] === ' ' || src[j] === '\t')) j--;
    return j < 0 || src[j] === '\n' || src[j] === ';' || src[j] === '}';
  };

  // 去掉语句头部的空白与注释，否则 `// xxx\nfunction f()` 匹配不到
  const stripLeadingNoise = (s) => {
    let out = s;
    for (;;) {
      const before = out;
      out = out.replace(/^\s+/, '');
      out = out.replace(/^\/\*[\s\S]*?\*\//, '');
      out = out.replace(/^\/\/[^\n]*\n?/, '');
      if (out === before) break;
    }
    return out;
  };

  const re = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/;

  while (i < src.length) {
    const c = src[i];
    const c2 = src.substr(i, 2);
    if (c === '\n') line++;

    if (state === 'code') {
      if (c2 === '//') { state = 'line-comment'; i += 2; continue; }
      if (c2 === '/*') { state = 'block-comment'; i += 2; continue; }
      if (c === "'") { state = 'sq'; i++; continue; }
      if (c === '"') { state = 'dq'; i++; continue; }
      if (c === '`') { state = 'tpl'; i++; continue; }

      if (c === '{' || c === '(' || c === '[') {
        if (depth === 0 && (c === '{' || c === '(')) {
          const chunk = src.slice(stmtStart, i);
          const head = stripLeadingNoise(chunk);
          if (atTopStmtPos(stmtStart + (chunk.length - head.length))) {
            const m = re.exec(head);
            if (m) {
              const declLine = src.slice(0, stmtStart + (chunk.length - head.length)).split('\n').length;
              push(m[2], declLine, m[1]);
            }
          }
        }
        depth++;
      } else if (c === '}' || c === ')' || c === ']') {
        depth = Math.max(0, depth - 1);
        if (depth === 0) stmtStart = i + 1;
      } else if (c === ';' && depth === 0) {
        stmtStart = i + 1;
      }
      i++;
      continue;
    }

    if (state === 'line-comment') { if (c === '\n') state = 'code'; i++; continue; }
    if (state === 'block-comment') { if (c2 === '*/') { state = 'code'; i += 2; } else i++; continue; }
    if (state === 'sq' || state === 'dq') {
      if (c === '\\') { i += 2; continue; }
      if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"')) state = 'code';
      i++;
      continue;
    }
    if (state === 'tpl') {
      if (c === '\\') { i += 2; continue; }
      if (c === '`') state = 'code';
      i++;
      continue;
    }
    i++;
  }
  return decls;
}

export const MUST_BE_UNIQUE = [
  'beijingNow', 'beijingToday', 'beijingTodayCompact', 'runMorning', 'runClose',
  'dispatch', 'jsonResponse', 'CONFIG', 'fetchLadderConstituents', 'numcatDailyAuc',
];

/**
 * ⚠️ 已知局限（2026-09-15 实测，勿踩）：本扫描器的字符串状态机【不识别正则字面量】。
 *    源码里只要出现「正则内含引号」，例如 `s.replace(/"/g, '')`，扫描器会从那个 `"` 起
 *    误入「双引号字符串」状态并长期失步 —— 其后所有顶层声明都扫不到，于是出包体检把
 *    一堆本来存在的标识符报成「缺必需标识符」（`_bundle.mjs` 的 Expect 会直接失败）。
 *    · 症状：`❌ <worker> 体检不通过：缺必需标识符: runMorning, runClose, dispatch ...`
 *      而实际代码明明有这些函数、`node --check` 也通过。
 *    · 处置：把 worker 源码里的 `/"/g` 改写成 `split('"').join('')` 这类不含引号的正则写法。
 *    · 方向性：该失步只会「漏扫 → 误报缺标识符 → 拒绝出包」，属于【fail-safe】，
 *      不会让带顶层重名的产物溜出去；但也意味着它是"宁可错杀"，排查时先怀疑这条。
 */

/** 纯函数体检：不做 node --check（避免递归子进程开销由调用方决定）
 *  @param src 打包产物源码
 *  @param expect 必须存在的顶层标识符（不同 worker 各不相同；传 [] 表示只查重名/残留）
 */
export function audit(src, expect = MUST_BE_UNIQUE) {
  const decls = scanTopLevelDecls(src);
  const dups = [...decls.entries()].filter(([, v]) => v.length > 1);
  const dupNames = dups.map(([n]) => n);
  const missing = expect.filter(n => !decls.has(n));
  const topImport = /^\s*import\s/m.test(src);
  const residualFrom = /\}\s*from\s*['"]/.test(src);
  const ok = dups.length === 0 && !topImport && !residualFrom && missing.length === 0;
  return { decls, dups, dupNames, missing, topImport, residualFrom, ok };
}

function main() {
  const file = process.argv[2] || 'workers/_bundled/bidding-auto-fetch.js';
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split('\n');

  let syntaxOk = true;
  let syntaxErr = '';
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (e) {
    syntaxOk = false;
    syntaxErr = (e.stderr || e.stdout || '').toString().split('\n').slice(0, 4).join('\n');
  }

  const a = audit(src);

  console.log('=== 体检报告:', file.replace(/\\/g, '/'));
  console.log('行数                        :', lines.length);
  console.log('module(有 export default)   :', /export\s+default/.test(src));
  console.log('node --check                :', syntaxOk ? '✅ 通过' : '❌ 失败\n' + syntaxErr);
  console.log('顶层 import 残留            :', a.topImport ? '❌ 有' : '✅ 无');
  console.log('`} from` 残留               :', a.residualFrom ? '❌ 有' : '✅ 无');
  console.log('顶层声明总数                :', a.decls.size);
  console.log('顶层重名                    :', a.dups.length === 0 ? '✅ 无' : '❌ ' + a.dups.length + ' 处');
  for (const [name, where] of a.dups) {
    console.log('   ❌', name, '→', where.map(w => w.line + ':' + w.kind).join('  |  '));
  }
  console.log('必需标识符齐全              :', a.missing.length === 0 ? '✅ 是' : '❌ 缺 ' + a.missing.join(', '));
  const bn = (a.decls.get('beijingNow') || []);
  console.log('beijingNow 声明             :', bn.length, '次 →', bn.map(b => b.line + ':' + b.kind).join(', ') || '（0 次）');

  const ok = syntaxOk && a.ok;
  console.log('\n结论:', ok ? '✅ 产物干净，可以部署' : '❌ 产物有问题，禁止部署');
  process.exit(ok ? 0 : 1);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main();
