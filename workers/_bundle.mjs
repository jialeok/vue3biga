// 简易 ESM 单文件打包器（用于 Cloudflare Dashboard 复制粘贴部署）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { audit } from './_check_bundle.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workersRoot = __dirname;
const outDir = path.join(workersRoot, '_bundled');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const IMPORT_RE = /^\s*import\s+(?:[\s\S]*?)\s+from\s+['"]([^'"]+)['"]\s*;?\s*$/gm;

function stripAndClean(content) {
  // [FIX 2026-09-10] 用与 collect() 完全相同的规则【整体】删除 import 语句。
  // 原实现是逐行判断 `^\s*import\s`，只能处理单行 import —— 遇到多行 import
  //   import {
  //     a, b
  //   } from './x.js';
  // 只会删掉第一行，剩下 `} from './x.js';` 残留在产物里 → 语法错误（且报错位置极难定位）。
  IMPORT_RE.lastIndex = 0;
  const src = content.replace(IMPORT_RE, '');
  const lines = src.split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    const c = line
      .replace(/^\s*export\s+async\s+function\s/, 'async function ')
      .replace(/^\s*export\s+function\s/, 'function ')
      .replace(/^\s*export\s+const\s/, 'const ')
      .replace(/^\s*export\s+let\s/, 'let ')
      .replace(/^\s*export\s+class\s/, 'class ');
    out.push(c);
  }
  return out.join('\n');
}

function collect(entryFile) {
  const visited = new Set();
  const order = [];
  function visit(file) {
    const key = path.resolve(file).toLowerCase();
    if (visited.has(key)) return;
    visited.add(key);
    const content = fs.readFileSync(file, 'utf8');
    const dir = path.dirname(file);
    let m;
    IMPORT_RE.lastIndex = 0;
    while ((m = IMPORT_RE.exec(content)) !== null) {
      const resolved = path.resolve(dir, m[1]);
      if (fs.existsSync(resolved)) visit(resolved);
    }
    order.push(file);
  }
  visit(entryFile);
  return order;
}

const workers = [
  {
    Name: 'bidding-auto-fetch', Dir: 'bidding-auto-fetch',
    // 早盘 worker 的核心顶层标识符 —— 缺一个就说明拼接漏了模块，必须拦下
    Expect: ['beijingNow', 'beijingToday', 'runMorning', 'runClose', 'dispatch',
      'jsonResponse', 'CONFIG', 'fetchLadderConstituents', 'numcatDailyAuc'],
  },
  { Name: 'bidding-board-worker-a', Dir: 'bidding-board-worker-a', Expect: [] },
  { Name: 'bidding-board-worker-b', Dir: 'bidding-board-worker-b', Expect: [] },
];

const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
let failed = 0;
for (const w of workers) {
  const entry = path.join(workersRoot, w.Dir, 'index.js');
  if (!fs.existsSync(entry)) { console.log('skip (no entry):', w.Name); continue; }
  const deps = collect(entry);

  // [DEPLOY-GUARD 2026-09-15] 头部写死「总行数」自检位。
  //   事故：用户把新包粘到旧代码下面（编辑器没先清空）→ 第 1117 行报
  //   `Identifier 'beijingNow' has already been declared`（= 旧包 1110 行 + 8）。
  //   粘贴后只要核对总行数，就能一眼发现「粘重了」。
  const headerLines = [
    `// ===== ${w.Name} — 单文件打包版（用于 Cloudflare Dashboard 复制粘贴）=====`,
    `// 生成时间: ${stamp}`,
    '// 注意: 此文件自动生成，请勿手动编辑',
    '//',
    '// ⚠️ 部署自检（粘贴前务必做完这三步）:',
    '//   1) 编辑器【先全选 (Ctrl+A) 再删除】清空后，再粘贴本文件 ——',
    '//      若把本文件粘在旧代码下面，会报 Identifier \'beijingNow\' has already been declared',
    '//      （实测行号 = 旧文件行数 + 8）。',
    '//   2) 粘贴后核对编辑器总行数 = __TOTAL__（少了=没粘全，约翻倍=粘重了）。',
    '//   3) Ctrl+F 搜「function beijingNow」→ 必须恰好 1 处。',
    '',
  ];

  const bodyParts = [];
  for (const dep of deps) {
    const rel = path.relative(workersRoot, dep).split(path.sep).join('/');
    bodyParts.push(`// ────── ${rel} ──────`);
    bodyParts.push(stripAndClean(fs.readFileSync(dep, 'utf8')));
    bodyParts.push('');
  }
  const bodyStr = bodyParts.join('\n');
  const total = headerLines.length + bodyStr.split('\n').length;
  const headerStr = headerLines.map(l => l.replace('__TOTAL__', String(total))).join('\n');
  const final = headerStr + '\n' + bodyStr;

  // [DEPLOY-GUARD] 出包前强制体检：顶层重名 / 顶层 import 残留 / `} from` 残留 / 必需标识符缺失。
  //   任何一项不通过就【不写文件、非零退出】—— 宁可不出包，也不出一个部署必炸的包。
  const a = audit(final, w.Expect || []);
  const actualLines = final.split('\n').length;
  if (!a.ok || actualLines !== total) {
    failed++;
    console.error(`  ❌ ${w.Name} 体检不通过，已拒绝写出：`);
    if (a.dups.length) console.error('     顶层重名:', a.dups.map(([n, v]) => n + '(' + v.length + ')').join(', '));
    if (a.topImport) console.error('     顶层 import 残留');
    if (a.residualFrom) console.error('     `} from` 残留');
    if (a.missing.length) console.error('     缺必需标识符:', a.missing.join(', '));
    if (actualLines !== total) console.error(`     行数自检不符: 声明 ${total} / 实际 ${actualLines}`);
    continue;
  }

  const outFile = path.join(outDir, `${w.Name}.js`);
  fs.writeFileSync(outFile, final, { encoding: 'utf8' });
  console.log(`  -> ${outFile} (${actualLines} lines, ${final.length} chars) ✅ 顶层重名 0 处`);
}
if (failed > 0) {
  console.error(`\n❌ 有 ${failed} 个产物体检未通过，禁止部署。`);
  process.exit(1);
}
console.log('Done!');
