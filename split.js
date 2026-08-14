// §16 domain splitter — extracts exported functions + consts into domain modules.
const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');

const APP_CORE = path.resolve('src/logic/app-core.js');
const LOGIC_DIR = path.resolve('src/logic');

const DOMAIN = process.argv[2];
if (!DOMAIN) { console.error('usage: node split.js <domain>'); process.exit(1); }

// Moved function names per domain
const MOVED = {
  jiwang: ['markJiwangDirty', 'getTodayJiwang'],
  stocks: ['searchTickerCodeByName', 'autoCompleteMissingStockCodes', 'importStockCodeMap',
           'extractCodeFromFuyaoItem', 'getStockHistoryTopics', 'replaceConceptFromPaste'],
  auction: ['getAuctionData', 'getTodayAuction', 'getTodayGroupList', 'markAuctionDirty',
            'patchAuctionField', 'patchAuctionFieldBatch', '_sanitizeAuctionPatch', '_splitAuctionPatch',
            '_mergeAuctionPatchLocal', 'clearAuctionDateData', 'deleteAuctionDateData', 'mergeAuctionDateRows',
            'clearAllAuctionDates', 'repairAuctionInWatchlistForDate', 'reconcileAuctionWatchlistFromLocalStorage',
            'reconcileAuctionWatchlist', 'backupAuctionData', 'rollbackAuctionData', 'importAuctionFromPaste',
            'parseVolumeOnlyText', 'splitHistoryFillLine', 'importAuctionHistoryFill', 'fetchLadderConstituentsMain',
            'fetchDayVolumes', 'fillYesterdayVolumeFromThs', 'fillTodayYesterdayVolumeFromThs',
            '_fillTodayYesterdayVolumeFromThsImpl', 'fillYesterdayYesterdayVolumeFromThs',
            '_fillYesterdayYesterdayVolumeFromThsImpl', 'fetchChangePctFromThs', '_fetchChangePctFromThsImpl',
            'fillAuctionHistoryGapPctFromThs', 'fillAuctionHistoryGapYestVolumeFromThs', 'fillYesterdayAuctionFromNumcat',
            'fetchTodayAuctionFromNumcat', 'fetchAllAuctionFromNumcat', 'fetchThreeDaysAuctionFromNumcat',
            'fetchFiveDaysAuctionFromNumcat', 'fillTopicsFromNumcat', 'fetchMonitorWarningFromNumcat',
            'fetchAuctionFromNumcat', 'runAuctionApiDiagnostics'],
  hotspot: ['getHotspotData', 'getHotAuctionData', '_openHotAuctionShield', '_closeHotAuctionShield',
            '_sanitizeHotPatch', '_splitHotPatch', '_mergeHotPatchLocal', 'patchHotField', 'patchHotFieldBatch',
            'backupHotStocksData', 'importHotFromPaste', 'replaceHotConceptFromPaste'],
};

// Moved top-level const/var declarations per domain (by declarator name)
const MOVED_CONSTS = {
  auction: ['AUCTION_WATCHLIST_FIELDS', 'AUCTION_METRICS_FIELDS', 'AUCTION_PATCHABLE_FIELDS', '_auctionFirstClearDumped'],
  hotspot: ['HOT_WATCHLIST_FIELDS', 'HOT_METRICS_FIELDS', 'HOT_PATCHABLE_FIELDS'],
};

// Internal app-core helpers that must be exported so domain modules can import them.
const EXPORT_THESE = ['_getAuctionStore', '_guardStack', '_guardAssertDate', '_dumpAuctionSnapshot'];

const movedNames = new Set(MOVED[DOMAIN] || []);
const movedConstNames = new Set(MOVED_CONSTS[DOMAIN] || []);

let src = fs.readFileSync(APP_CORE, 'utf8');
const origLen = src.length;

const ast = parser.parse(src, {
  sourceType: 'module',
  plugins: ['objectRestSpread', 'optionalChaining', 'nullishCoalescingOperator',
            'classProperties', 'logicalAssignment', 'numericSeparator', 'dynamicImport',
            'topLevelAwait', 'bigInt', 'importMeta'],
  attachComment: false,
});

// Collect top-level definitions (own names) in app-core.
const topDefs = new Map(); // name -> {exported, node}
const importLines = []; // raw import statements (lines starting with 'import ')
for (const node of ast.program.body) {
  if (node.type === 'ImportDeclaration') {
    importLines.push({ start: node.start, end: node.end });
    continue;
  }
  if (node.type === 'ExportNamedDeclaration' && node.declaration) {
    const d = node.declaration;
    if (d.type === 'FunctionDeclaration' && d.id) {
      topDefs.set(d.id.name, { exported: true, node });
    } else if (d.type === 'VariableDeclaration') {
      for (const decl of d.declarations) {
        if (decl.id && decl.id.type === 'Identifier') topDefs.set(decl.id.name, { exported: true, node });
      }
    }
  } else if (node.type === 'FunctionDeclaration' && node.id) {
    topDefs.set(node.id.name, { exported: false, node });
  } else if (node.type === 'VariableDeclaration') {
    for (const decl of d_declarations(node)) {
      if (decl.id && decl.id.type === 'Identifier') topDefs.set(decl.id.name, { exported: false, node });
    }
  }
}
function d_declarations(d) { return d.declarations; }

// Build set of all top-level defined names (own names only).
const allTopNames = new Set(topDefs.keys());

// Global set of ALL moved names (this + other domains) so cross-domain refs resolve.
const allMovedNames = new Set([...Object.values(MOVED).flat(), ...Object.values(MOVED_CONSTS).flat()]);

// Collect referenced identifiers + local declared names within a function node.
function collectRefs(fnNode) {
  const refs = new Set();
  const locals = new Set();
  function addLocalFromPattern(p) {
    if (!p) return;
    if (p.type === 'Identifier') locals.add(p.name);
    else if (p.type === 'ObjectPattern') p.properties.forEach(pr => addLocalFromPattern(pr.value));
    else if (p.type === 'ArrayPattern') p.elements.forEach(addLocalFromPattern);
    else if (p.type === 'AssignmentPattern') addLocalFromPattern(p.left);
    else if (p.type === 'RestElement') addLocalFromPattern(p.argument);
  }
  function walk(n, isProp, isKey) {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(x => walk(x, isProp, isKey)); return; }
    if (n.type === 'Identifier') {
      if (!isProp && !isKey) refs.add(n.name);
    }
    // recurse children
    for (const key of Object.keys(n)) {
      if (key === 'start' || key === 'end' || key === 'loc' || key === 'range' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') continue;
      const child = n[key];
      if (key === 'property' && n.type === 'MemberExpression' && !n.computed) {
        // property is a non-computed member key: skip as reference
        walk(child, true, false);
        continue;
      }
      if (key === 'key' && (n.type === 'ObjectProperty' || n.type === 'ObjectMethod' || n.type === 'ClassProperty') && !n.computed) {
        walk(child, false, true);
        continue;
      }
      if ((n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression') && key === 'params') {
        if (Array.isArray(child)) child.forEach(p => addLocalFromPattern(p));
        continue;
      }
      if (n.type === 'FunctionDeclaration' && key === 'id' && n.id) { locals.add(n.id.name); continue; }
      if (n.type === 'VariableDeclarator' && key === 'id') { addLocalFromPattern(child); continue; }
      walk(child, false, false);
    }
  }
  walk(fnNode, false, false);
  return { refs, locals };
}

// Gather slices to remove (functions + consts) and source code to move.
const removeRanges = []; // {start,end}
const movedCode = []; // source text (dedented)

// functions
for (const node of ast.program.body) {
  let fnName = null;
  if (node.type === 'ExportNamedDeclaration' && node.declaration && node.declaration.type === 'FunctionDeclaration' && node.declaration.id) {
    fnName = node.declaration.id.name;
  } else if (node.type === 'FunctionDeclaration' && node.id) {
    fnName = node.id.name;
  }
  if (fnName && movedNames.has(fnName)) {
    const fnDecl = node.type === 'ExportNamedDeclaration' ? node.declaration : node;
    const end = fnDecl.body.end; // exact position after the function body's closing '}'
    removeRanges.push({ start: node.start, end: end });
    movedCode.push(dedent(src.slice(node.start, end)));
  }
}

// consts: find VariableDeclaration nodes containing a moved declarator
for (const node of ast.program.body) {
  if (node.type === 'ExportNamedDeclaration' && node.declaration && node.declaration.type === 'VariableDeclaration') {
    const d = node.declaration;
    if (d.declarations.some(decl => decl.id && decl.id.type === 'Identifier' && movedConstNames.has(decl.id.name))) {
      removeRanges.push({ start: node.start, end: node.end });
      movedCode.push('export ' + dedent(src.slice(node.start, node.end)));
    }
  } else if (node.type === 'VariableDeclaration') {
    if (node.declarations.some(decl => decl.id && decl.id.type === 'Identifier' && movedConstNames.has(decl.id.name))) {
      removeRanges.push({ start: node.start, end: node.end });
      movedCode.push('export ' + dedent(src.slice(node.start, node.end)));
    }
  }
}

if (movedNames.size === 0 && movedConstNames.size === 0) {
  console.error('No functions/consts configured for domain ' + DOMAIN);
  process.exit(1);
}

// Determine referenced app-core staying names + cross-domain imports
const appCoreImports = new Set(); // staying top-level defs to import from '../app-core.js'
const domainImports = new Map(); // domainName -> Set(names)

// For each moved function, analyze refs (against its own AST node).
function findFnNode(name) {
  for (const node of ast.program.body) {
    if (node.type === 'ExportNamedDeclaration' && node.declaration && node.declaration.type === 'FunctionDeclaration' && node.declaration.id && node.declaration.id.name === name) return node.declaration;
    if (node.type === 'FunctionDeclaration' && node.id && node.id.name === name) return node;
  }
  return null;
}

for (const fnName of movedNames) {
  const fnNode = findFnNode(fnName);
  if (!fnNode) { console.error('WARN: function not found: ' + fnName); continue; }
  const { refs, locals } = collectRefs(fnNode);
  for (const r of refs) {
    if (locals.has(r)) continue;
    if (allMovedNames.has(r)) {
      if (movedNames.has(r) || movedConstNames.has(r)) {
        // same domain -> local, no import
      } else {
        let owner = null;
        for (const dom of Object.keys(MOVED)) if (MOVED[dom].includes(r)) owner = dom;
        if (!owner) for (const dom of Object.keys(MOVED_CONSTS)) if (MOVED_CONSTS[dom].includes(r)) owner = dom;
        if (owner && owner !== DOMAIN) {
          if (!domainImports.has(owner)) domainImports.set(owner, new Set());
          domainImports.get(owner).add(r);
        }
      }
      continue;
    }
    if (allTopNames.has(r)) {
      // staying app-core def -> import from app-core
      appCoreImports.add(r);
    }
  }
}

// Export internal helpers if referenced (applied to newSrc AFTER rebuild to avoid shifting AST offsets)
const exportTheseNow = [...appCoreImports].filter(h => EXPORT_THESE.includes(h));

// Build domain module content
let mod = '';
// copy external import lines, rewriting relative paths one level deeper (domain is nested in src/logic/<domain>/)
for (const imp of importLines) {
  let line = src.slice(imp.start, imp.end);
  line = line.replace(/(from\s+['"])(\.\.?\/)/g, function(m, p1, p2) {
    return p1 + (p2 === './' ? '../' : '../../');
  });
  mod += line + '\n';
}
// domain sibling imports
for (const [dom, names] of domainImports) {
  mod += "import { " + [...names].join(', ') + " } from '../" + dom + '/' + dom + ".js';\n";
}
// app-core staying imports
if (appCoreImports.size > 0) {
  mod += "import { " + [...appCoreImports].join(', ') + " } from '../app-core.js';\n";
}
mod += '\n';
mod += '// §16 域拆分：' + DOMAIN + ' 域（原 app-core.js 迁出）\n';
for (const c of movedCode) {
  mod += c + '\n\n';
}

const modPath = path.join(LOGIC_DIR, DOMAIN, DOMAIN + '.js');
fs.mkdirSync(path.dirname(modPath), { recursive: true });
fs.writeFileSync(modPath, mod);
console.log('Wrote ' + modPath + ' (' + mod.length + ' bytes)');
console.log('  app-core staying imports: ' + [...appCoreImports].join(', '));
console.log('  domain imports: ' + [...domainImports.entries()].map(([k,v]) => k+':'+[...v].join('|')).join(' ; '));

// Rebuild app-core: remove slices, append re-export
removeRanges.sort((a, b) => a.start - b.start);
// remove ranges (from end to start to keep offsets valid)
let newSrc = src;
for (let i = removeRanges.length - 1; i >= 0; i--) {
  const { start, end } = removeRanges[i];
  newSrc = newSrc.slice(0, start) + newSrc.slice(end);
}
// Also drop a single blank line that may be left adjacent (optional). Append re-export at end.
const allMoved = [...movedNames, ...movedConstNames];
newSrc = newSrc.replace(/\s+$/, '') + '\n\n// §16 域拆分：' + DOMAIN + ' 域函数已迁出至 ./' + DOMAIN + '/' + DOMAIN + '.js\n';
newSrc += "export { " + allMoved.join(', ') + " } from './" + DOMAIN + '/' + DOMAIN + ".js';\n";

// Now apply the export keywords for internal helpers (length change is safe here)
for (const h of exportTheseNow) {
  const re = new RegExp('(?<!export\\s)function ' + h + '\\s*\\(');
  if (re.test(newSrc)) newSrc = newSrc.replace(re, 'export function ' + h + '(');
}

fs.writeFileSync(APP_CORE, newSrc);
console.log('app-core.js: ' + origLen + ' -> ' + newSrc.length + ' bytes (removed ' + (origLen - newSrc.length) + ')');

function dedent(text) {
  return text.split('\n').map(line => line.replace(/^ {1,8}/, '')).join('\n');
}

// Manual brace matcher: from the first '{' at/after openIdx, find the matching '}'.
function findBlockEnd(s, openIdx) {
  let depth = 0;
  let i = openIdx;
  if (i < 0 || s[i] !== '{') return openIdx + 1;
  let inStr = null;
  while (i < s.length) {
    const ch = s[i];
    if (inStr) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === inStr) inStr = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; i++; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return i + 1; }
    i++;
  }
  return s.length;
}
