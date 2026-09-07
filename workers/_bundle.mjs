// 简易 ESM 单文件打包器（用于 Cloudflare Dashboard 复制粘贴部署）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workersRoot = __dirname;
const outDir = path.join(workersRoot, '_bundled');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const IMPORT_RE = /^\s*import\s+(?:[\s\S]*?)\s+from\s+['"]([^'"]+)['"]\s*;?\s*$/gm;

function stripAndClean(content) {
  const lines = content.split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    if (/^\s*import\s+/.test(line)) continue;
    let c = line
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
  { Name: 'bidding-auto-fetch', Dir: 'bidding-auto-fetch' },
  { Name: 'bidding-board-worker-a', Dir: 'bidding-board-worker-a' },
  { Name: 'bidding-board-worker-b', Dir: 'bidding-board-worker-b' },
];

const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
for (const w of workers) {
  const entry = path.join(workersRoot, w.Dir, 'index.js');
  if (!fs.existsSync(entry)) { console.log('skip (no entry):', w.Name); continue; }
  const deps = collect(entry);
  const parts = [
    `// ===== ${w.Name} — 单文件打包版（用于 Cloudflare Dashboard 复制粘贴）=====`,
    `// 生成时间: ${stamp}`,
    '// 注意: 此文件自动生成，请勿手动编辑',
    '',
  ];
  for (const dep of deps) {
    const rel = path.relative(workersRoot, dep).split(path.sep).join('/');
    parts.push(`// ────── ${rel} ──────`);
    parts.push(stripAndClean(fs.readFileSync(dep, 'utf8')));
    parts.push('');
  }
  const final = parts.join('\n');
  const outFile = path.join(outDir, `${w.Name}.js`);
  fs.writeFileSync(outFile, final, { encoding: 'utf8' });
  console.log(`  -> ${outFile} (${final.split('\n').length} lines, ${final.length} chars)`);
}
console.log('Done!');
