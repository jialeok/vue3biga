// tencent-snapshot.js — 腾讯行情快照（ETF 唯一来源）
//
// ============================================================================
// [ETF-TENCENT 2026-11-13] 为什么 Worker 必须单独走腾讯拿 ETF
// ----------------------------------------------------------------------------
// 事故：竞价变化看板「收盘」列的 `大盘ETF` / `板块ETF` 两行【长期为空】，
//   用户报障原话「这两天收盘列都没有数据，只有 9:15~9:25 那几列有」。
//
// 生产取证（`.tmpdiag/_etf-snap-probe.mjs`，2026-11-13 直打 fuyao-proxy）：
//     · `/api/a-share/prices/snapshot?thscodes=510300.SH` → `code=3001 Target not found`
//     · `/api/a-share/prices/snapshot?thscodes=510300.SZ` → `code=3001 Target not found`
//     · `/api/a-share/prices/snapshot?thscodes=159995.SZ` → `code=3001 Target not found`
//     · 混批（2 沪 ETF + 1 深 ETF + 1 个股）→ `code=0 item=1`（**坏代码被静默丢弃**，只回个股）
//     · `/api/a-share-index/prices/snapshot?thscodes=510300.SH` → 同样 `Target not found`
//   ⇒ **同花顺 A 股快照接口根本不含 ETF，与代码后缀无关。**
//     所以「把 5 开头从 .SZ 改成 .SH」修不了这两行（我第一版就是这么误判的，已纠正）。
//     后续批次日志 `个股/ETF 快照可用 61/110` 也印证：61 = 883410 的 51 只 + 883901 的 10 只，
//     110 − 61 = 49 正好是全部 ETF ⇒ **49 只一只都没拿到**，不是缺几只。
//
// 前端为什么正常：`src/logic/bidding/helpers.js#fetchBiddingSnapshotToForm` 里
//   ETF 走的是 `https://qt.gtimg.cn/q=sh510300,sz159995,...`（腾讯行情），
//   只有个股 / 指数走同花顺。Worker 侧当年照抄了「个股 + ETF 混一个批次」的写法，
//   于是浏览器有值、云端恒定空 —— 这正是「我这边一直好好的，你们改了才坏」的由来。
//
// 实测（同日，49 只真实 ETF 代码全打一遍）：**腾讯 49/49 全中**，字段 32 = 涨幅%。
//   `sh510300=-0.75` / `sz159995=-2.04` / `sh512480=-2.46` …（与 11-13 收盘一致，时间戳
//   `20261113161454`，现价 0.769 / 昨收 0.785 ⇒ -2.038% 自洽）
//
// 【红线】
//   ⛔ 读失败 ≠ 0：任何一只没拿到就不放进 pctMap，调用方据此「不给该行赋值」（§10）。
//   ⛔ 不猜值：涨跌幅只认上游字段，绝不拿同花顺个股口径 / 竞价涨幅冒充收盘。
//   ⛔ 失败不连坐：本模块抛错由调用方 catch，只记日志，不影响个股 / 指数两路。
// ============================================================================

const TENCENT_SNAPSHOT_URL = 'https://qt.gtimg.cn/q=';
const TENCENT_TIMEOUT_MS = 9000;
// 腾讯地址是 GET query，49 只 ETF × 9 字符 ≈ 441 字符已足够；留到 60 只/批仍远低于 URL 上限。
const TENCENT_BATCH_SIZE = 60;
// ⚠️ [BUNDLE-SCANNER] 这里【不能】写成正则字面量 `/v_([a-z]{2}\d{6})="([^"]*)"/g`。
//   `workers/_check_bundle.mjs` 的顶层声明扫描器是个简易字符串状态机，
//   它【不识别正则字面量】：正则体里一旦出现 `"`，扫描器会从那个引号起误入「双引号字符串」
//   状态并长期失步 —— 其后所有顶层声明都扫不到，出包体检就把本来存在的
//   `dispatch` / `jsonResponse` 报成「缺必需标识符」而拒绝出包（fail-safe，但会卡住 CI）。
//   改用字符串拼 RegExp：引号落在真实字符串里，状态机认得。
//   该局限的原文档见 workers/_check_bundle.mjs 末尾「已知局限（2026-09-15 实测）」。
const TENCENT_LINE_SRC = 'v_([a-z]{2}\\d{6})="([^"]*)"';

/**
 * 6 位代码 / thscode → 腾讯行情 symbol。
 * 口径与前端 helpers.js#biddingGetTencentPcts 完全一致（`.SZ` → sz，其余 → sh），
 * 不带后缀时按 A 股板块规则推断（5/6/9 → sh，其余 → sz）。
 * @param {string} code  '510300.SH' | '159995.SZ' | '510300'
 * @returns {string} 'sh510300' | 'sz159995' | ''（非法）
 */
export function tencentSymOf(code) {
  const raw = String(code || '').trim();
  if (!raw) return '';
  const dot = raw.lastIndexOf('.');
  const bare = dot > 0 ? raw.slice(0, dot) : raw;
  const suffix = dot > 0 ? raw.slice(dot + 1).toUpperCase() : '';
  if (!/^\d{6}$/.test(bare)) return '';
  if (suffix === 'SH') return 'sh' + bare;
  if (suffix === 'SZ') return 'sz' + bare;
  if (suffix === 'BJ') return ''; // 北交所不在腾讯 qt 口径内，不硬凑
  // 无后缀：5/6/9 开头是沪市（5 = 沪市 ETF/LOF，6 = 沪市个股，9 = 沪市 B 股），其余深市
  return (bare.charAt(0) === '5' || bare.charAt(0) === '6' || bare.charAt(0) === '9' ? 'sh' : 'sz') + bare;
}

/**
 * 纯函数：解析腾讯行情文本 → { pctMap, stats }
 *
 * 上游是 `text/html; charset=GBK`，我们只取 ASCII 结构的 `v_<symbol>="字段~字段~…"`。
 * 为了不让 GBK 解码问题干扰，调用方应传【字节补 latin1 后的字符串】（见 decodeLatin1）。
 * 中文名变乱码无所谓 —— 数值字段（33 = 涨幅%）全是 ASCII。
 *
 * @param {string} text
 * @returns {{pctMap: Record<string, number>, stats: {itemsReturned:number, emptyField:number}}}
 */
export function parseTencentSnapshot(text) {
  const pctMap = {};
  const stats = { itemsReturned: 0, emptyField: 0 };
  const re = new RegExp(TENCENT_LINE_SRC, 'g');
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    const sym = m[1];
    const fields = m[2].split('~');
    stats.itemsReturned++;
    // 字段 32（0 基）= 涨跌幅 %。安全兜底：没有就按 现价(3) / 昨收(4) 算。
    let pct = fields.length > 32 ? Number(fields[32]) : NaN;
    if (!isFinite(pct) || (fields[32] === '' && fields.length > 4)) {
      const curr = Number(fields[3]);
      const prev = Number(fields[4]);
      pct = (isFinite(curr) && isFinite(prev) && prev > 0) ? ((curr - prev) / prev) * 100 : NaN;
    }
    if (!isFinite(pct)) { stats.emptyField++; continue; }
    const bare = sym.slice(2);
    // key 用【带后缀 thscode】—— 与前端 biddingGetTencentPcts 一致，
    // computeBiddingCloseValues 的 biddingPctLookup 先按完整 thscode 找，命中最快。
    pctMap[bare + (sym.slice(0, 2) === 'sz' ? '.SZ' : '.SH')] = Math.round(pct * 100) / 100;
  }
  return { pctMap, stats };
}

/** 字节 → latin1 字符串（保持 1:1，不触发 UTF-8 解码替换），分块避免超长参数栈 */
function decodeLatin1(buf) {
  const bytes = new Uint8Array(buf);
  let out = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK);
    out += String.fromCharCode.apply(null, slice);
  }
  return out;
}

/**
 * 拉一批 ETF 的收盘涨幅。
 *
 * @param {string[]} codes 带后缀 thscode（见 src/logic/bidding/snapshot-spec.js#biddingEtfToSnapshotCode）
 * @param {{timeoutMs?:number}} [opts]
 * @returns {Promise<{pctMap: Record<string, number>, stats: object}>}
 *   stats: { totalInput, batches, batchOk, batchFail, itemsReturned, emptyField, success }
 *   ⛔ 整批失败不抛错，只累计 batchFail —— 调用方按 pctMap 缺项留空（§10）。
 */
export async function fetchTencentSnapshotPcts(codes, opts) {
  const list = Array.from(new Set((codes || []).map(c => String(c || '').trim()).filter(Boolean)));
  const symPairs = list
    .map(c => ({ code: c, sym: tencentSymOf(c) }))
    .filter(p => p.sym);
  const stats = {
    totalInput: list.length,
    symbolOk: symPairs.length,
    batches: 0,
    batchOk: 0,
    batchFail: 0,
    itemsReturned: 0,
    emptyField: 0,
    success: 0
  };
  const pctMap = {};
  const timeoutMs = (opts && opts.timeoutMs) || TENCENT_TIMEOUT_MS;

  for (let i = 0; i < symPairs.length; i += TENCENT_BATCH_SIZE) {
    const chunk = symPairs.slice(i, i + TENCENT_BATCH_SIZE);
    const url = TENCENT_SNAPSHOT_URL + chunk.map(p => p.sym).join(',');
    stats.batches++;
    try {
      const fetchOpts = { headers: { 'User-Agent': 'Mozilla/5.0' } };
      if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
        fetchOpts.signal = AbortSignal.timeout(timeoutMs);
      }
      const resp = await fetch(url, fetchOpts);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const text = decodeLatin1(await resp.arrayBuffer());
      const parsed = parseTencentSnapshot(text);
      stats.batchOk++;
      stats.itemsReturned += parsed.stats.itemsReturned;
      stats.emptyField += parsed.stats.emptyField;
      Object.assign(pctMap, parsed.pctMap);
    } catch (e) {
      stats.batchFail++;
      console.warn('[TENCENT-ETF] 批次 ' + (stats.batches) + ' 失败（该批留空，不写 0）: ' + (e && e.message));
    }
  }
  stats.success = Object.keys(pctMap).length;
  return { pctMap, stats };
}
