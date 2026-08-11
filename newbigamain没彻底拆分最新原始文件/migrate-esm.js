// migrate-esm.js — 全量 ES module 迁移脚本
// 策略：所有顶层 let/const/var 改为 window.xxx，所有顶层 function 加 export，
// 所有跨文件变量引用改为 window.xxx，创建 entry.js 统一导入
const fs = require('fs');
const path = require('path');
const { globSync } = require('glob');

// ── 配置 ──
const SRC_DIR = 'src';
const files = globSync('src/**/*.js').sort();
console.log(`找到 ${files.length} 个 JS 文件`);

// ── 工具：简易 tokenizer，区分代码/字符串/注释 ──
function tokenize(code) {
  const tokens = [];
  let i = 0;
  while (i < code.length) {
    // 跳过空白
    if (/\s/.test(code[i])) { i++; continue; }
    // 行注释
    if (code[i] === '/' && code[i+1] === '/') {
      let j = i + 2;
      while (j < code.length && code[j] !== '\n') j++;
      tokens.push({ type: 'comment', value: code.slice(i, j), start: i, end: j });
      i = j; continue;
    }
    // 块注释
    if (code[i] === '/' && code[i+1] === '*') {
      let j = i + 2;
      while (j < code.length && !(code[j] === '*' && code[j+1] === '/')) j++;
      j += 2;
      tokens.push({ type: 'comment', value: code.slice(i, j), start: i, end: j });
      i = j; continue;
    }
    // 字符串
    if (code[i] === '"' || code[i] === "'" || code[i] === '`') {
      const quote = code[i];
      let j = i + 1;
      while (j < code.length) {
        if (code[j] === '\\') { j += 2; continue; }
        if (code[j] === quote) { j++; break; }
        if (quote === '`' && code[j] === '$' && code[j+1] === '{') {
          // 模板字面量内插：跳到匹配的 }
          let depth = 1; j += 2;
          while (j < code.length && depth > 0) {
            if (code[j] === '{') depth++;
            if (code[j] === '}') depth--;
            j++;
          }
          continue;
        }
        j++;
      }
      tokens.push({ type: 'string', value: code.slice(i, j), start: i, end: j });
      i = j; continue;
    }
    // 正则字面量（简化判断：前一个非空白字符不是标识符字符或）
    if (code[i] === '/' && i > 0) {
      let prev = i - 1;
      while (prev > 0 && /\s/.test(code[prev])) prev--;
      if (!/[a-zA-Z0-9_$)\]]/.test(code[prev])) {
        let j = i + 1;
        while (j < code.length && code[j] !== '/') {
          if (code[j] === '\\') { j += 2; continue; }
          j++;
        }
        j++; // 跳过闭合 /
        while (j < code.length && /[gimsuy]/.test(code[j])) j++;
        tokens.push({ type: 'regex', value: code.slice(i, j), start: i, end: j });
        i = j; continue;
      }
    }
    // 其他代码字符
    let j = i;
    while (j < code.length && !/\s/.test(code[j]) &&
           code[j] !== '"' && code[j] !== "'" && code[j] !== '`' &&
           !(code[j] === '/' && (code[j+1] === '/' || code[j+1] === '*'))) j++;
    tokens.push({ type: 'code', value: code.slice(i, j), start: i, end: j });
    i = j;
  }
  return tokens;
}

// ── 1. 收集所有顶层声明 ──
const globalVars = new Set();
const globalFuncs = new Set();
const fileInfos = [];

// 手动维护的已知全局变量（来自分析报告）
const knownSharedVars = new Set([
  'allData', '_biddingMemCache', '_topicCache', '_topicCacheBuilt',
  '_expandedAuctionStocksByGroup', 'SUPABASE_URL', 'SUPABASE_ANON_KEY',
  'PASSWORD_HASH', '_supabaseClient', '_pushDebounceTimer',
  '_sessionToken', '_realtimeChannel', '_justPushed', '_justPushedAuction',
  '_auctionRealtimeChannel', '_justPushedAuctionCounter', '_justPushedAuctionTimer',
  '_Vue', 'auctionStore', '_auctionFullRowCache_DELETED', '_auctionMemCache',
  '_dailyHighlightsCache', '_highlightsTableAvailable', '_highlightsPushTimer',
  '_hotHighlightsPushTimer', '_highlightsChannel', '_stockTopicsChannel',
  '_cloudTopicsCache', '_scMapChannel', '_scMapCache',
  '_biddingTableAvailable', '_biddingRealtimeChannel', '_marketMetricsRealtimeChannel',
  '_justPushedBidding', '_justPushedHighlights', '_justPushedHotHighlights',
  '_jiwangMemCache', '_jiwangTableAvailable', '_jiwangRealtimeChannel',
  '_justPushedJiwang', '_jiwangPushTimers', 'hotStockList', '_hotFullRowCache',
  '_hotHighlightsCache', '_hotHighlightsTableAvailable', '_hotHighlightsChannel',
  'currentGroup', '_justPushedHotAuction', '_justPushedHotAuctionCounter',
  '_justPushedHotAuctionTimer', '_hotAuctionData', '_hotAuctionTableAvailable',
  '_hotAuctionRealtimeChannel', '_hotTrendsRealtimeChannel',
  '_marketMetricsHotRealtimeChannel', '_hotTrendsTableAvailable', '_hotTrendsCache',
  '_hotTrendsReloadTimer', '_justPushedHotTrends', '_hotNumcatDebugSnapshots',
  '_hotWatchlistIndex', '_auctionWatchlistIndex', '_auctionRealtimeTimer',
  '_pendingRealtimeDates', '_pendingAuctionReload', '_histRowMapCache',
  '_auctionTableAvailable', '_marketMetricsTableAvailable', '_lastPushedAuctionStatus',
  'FUYAO_PROXY_BASE', 'FUYAO_DIRECT_BASE', 'LADDER_THSCODE', 'NUMCAT_PROXY_URL',
  'HOT_MERGE_FIELDS', '_hotAuctionRealtimeTimer', '_pendingHotRealtimeDates',
  '_pendingHotReload', '_hotHighlightsReloadTimer',
  '_DBG_LOG_KEY', '_dbgFlushTimer',
]);

for (const file of files) {
  const content = fs.readFileSync(file, 'utf8');
  // 找顶层 function 声明
  const funcRegex = /^(\s*)function\s+([a-zA-Z0-9_$]+)/gm;
  let m;
  while ((m = funcRegex.exec(content)) !== null) {
    globalFuncs.add(m[2]);
  }
  // 找顶层 let/const/var 声明
  const varRegex = /^(\s*)(let|const|var)\s+([a-zA-Z0-9_$]+)/gm;
  while ((m = varRegex.exec(content)) !== null) {
    if (knownSharedVars.has(m[3])) {
      globalVars.add(m[3]);
    }
  }
  fileInfos.push({ file, content });
}

console.log(`全局函数: ${globalFuncs.size}, 全局变量: ${globalVars.size}`);

// ── 2. 转换每个文件 ──
for (const { file, content } of fileInfos) {
  // 跳过 remaining-boards.js（已 IIFE 封装）
  if (file.includes('remaining-boards.js')) {
    console.log(`跳过（已 IIFE）: ${file}`);
    continue;
  }

  let lines = content.split('\n');
  const newLines = [];

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    let line = lines[lineIdx];
    const trimmed = line.trimStart();
    const indent = line.substring(0, line.length - trimmed.length);

    // 跳过空行和注释
    if (trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
      newLines.push(line);
      continue;
    }

    // 添加 export 到 function 声明
    if (/^function\s/.test(trimmed) && !trimmed.startsWith('export ')) {
      const match = trimmed.match(/^function\s+\*?\s*([a-zA-Z0-9_$]+)/);
      if (match && globalFuncs.has(match[1])) {
        line = indent + 'export ' + trimmed;
        newLines.push(line);
        continue;
      }
    }

    // 转换 let/const/var 声明为 window.xxx
    const declMatch = trimmed.match(/^(let|const|var)\s+([a-zA-Z0-9_$]+)\s*=\s*(.*)$/);
    if (declMatch && knownSharedVars.has(declMatch[2])) {
      const varName = declMatch[2];
      const value = declMatch[3];
      // 处理多行声明（以分号结尾或未闭合）
      line = indent + 'window.' + varName + ' = ' + value;
      newLines.push(line);
      continue;
    }
    // 无初始化的声明
    const declNoInitMatch = trimmed.match(/^(let|const|var)\s+([a-zA-Z0-9_$]+)\s*;?\s*$/);
    if (declNoInitMatch && knownSharedVars.has(declNoInitMatch[2])) {
      line = indent + 'window.' + declNoInitMatch[2] + ' = undefined;';
      newLines.push(line);
      continue;
    }

    // 替换变量引用为 window.xxx
    // 用 tokenizer 区分字符串/注释
    const tokens = tokenize(line);
    let newLine = '';
    for (const token of tokens) {
      if (token.type === 'code') {
        // 替换标识符
        let val = token.value;
        val = val.replace(/\b([a-zA-Z0-9_$]+)\b/g, (match, name, offset) => {
          if (!knownSharedVars.has(name)) return match;
          // 检查前一个字符是否是 .
          if (offset > 0 && val[offset - 1] === '.') return match;
          // 检查是否是 window.xxx 已有的
          if (offset >= 6 && val.substring(offset - 7, offset) === 'window.') return match;
          // 不要替换声明关键字
          if (['let', 'const', 'var', 'function', 'export', 'import', 'from', 'as', 'typeof', 'new', 'delete', 'void', 'in', 'of', 'class', 'extends', 'super', 'this', 'true', 'false', 'null', 'undefined', 'NaN', 'Infinity'].includes(name)) return match;
          return 'window.' + name;
        });
        newLine += val;
      } else {
        newLine += token.value;
      }
    }
    newLines.push(newLine);
  }

  fs.writeFileSync(file, newLines.join('\n'), 'utf8');
  console.log(`转换: ${file}`);
}

// ── 3. 创建 entry.js ──
const importLines = [];
const assignLines = [];

for (const file of files) {
  const relPath = './' + file.replace(/\\/g, '/').replace(/^src\//, '');
  const modName = '_mod_' + path.basename(file).replace(/[^a-zA-Z0-9]/g, '_') + '_' + fileInfos.indexOf(fileInfos.find(f => f.file === file));
  importLines.push(`import * as ${modName} from '${relPath}';`);
  assignLines.push(`try { Object.assign(window, ${modName}); } catch(e) { console.warn('Failed to assign ${file}:', e.message); }`);
}

const entryContent = `// entry.js — Vite ES module 入口
// 所有模块的导出都挂到 window 上，保持全局作用域兼容
${importLines.join('\n')}

${assignLines.join('\n')}
`;

fs.writeFileSync('src/entry.js', entryContent, 'utf8');
console.log('创建 src/entry.js');

// ── 4. 更新 index.html ──
let html = fs.readFileSync('index.html', 'utf8');
// 收集所有 src/ script 标签
const scriptRegex = /(\s*)<script\s+src="(src\/[^"]*)"><\/script>\s*\n/g;
let firstMatch = true;
html = html.replace(scriptRegex, (match, indent, src) => {
  if (firstMatch) {
    firstMatch = false;
    return indent + '<script type="module" src="src/entry.js"></script>\n';
  }
  return '';
});
fs.writeFileSync('index.html', html, 'utf8');
console.log('更新 index.html');
console.log('完成！');