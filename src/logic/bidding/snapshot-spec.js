// snapshot-spec.js — 竞价变化看板「快照取值口径」唯一真相（§6）
//
// [BIDDING-CLOSE-CLOUD 2026-11-07] 为什么抽这个文件：
//   原来 BIDDING_SECTOR_ETFS / biddingEtfToSnapshotCode / 收盘列的计算规则
//   全部是 src/logic/bidding/helpers.js 里的私有常量，只有【浏览器】能用。
//   结果「收盘」列只能靠浏览器 fetchBiddingSnapshotToForm() 自动填表单 + 人工点保存，
//   一旦某天没点保存，bidding_data.close 就永久空白 ⇒ 次日 jiwang_data 的
//   「昨多板K线」推导不出来（2026-11-04 事故）。
//   现在把口径抽到纯模块，前端与 Cloudflare Worker 16:00 轮共用同一份实现：
//   Worker 直接把收盘值幂等 upsert 到 bidding_data.close，不再依赖人工点保存。
//
// ⛔ 本文件必须保持【零浏览器依赖 / 零 DOM / 零 Vue】，否则 Worker 打包会炸。

export const LADDER_THSCODE = '883410.TI';
export const TOP10_THSCODE = '883901.TI';
export const MAIN_INDEX_THSCODE = '000001.SH';

/** 「板块ETF」行的 48 个观察标的（含 3 个指数） */
export const BIDDING_SECTOR_ETFS = [
  { code: '560780', name: '半导体设备ETF' }, { code: '159995', name: '芯片ETF华夏' },
  { code: '512480', name: '半导体ETF国' }, { code: '159732', name: '消费电子ETF' },
  { code: '515880', name: '通信ETF国泰' }, { code: '560800', name: '数字经济ETF' },
  { code: '159819', name: '人工智能ETF' }, { code: '159206', name: '卫星ETF永赢' },
  { code: '515750', name: '科技50ETF' }, { code: '159608', name: '稀有金属ETF' },
  { code: '159998', name: '计算机ETF天弘' }, { code: '561160', name: '电池ETF富国' },
  { code: '159857', name: '光伏ETF天弘' }, { code: '516780', name: '稀土ETF华泰' },
  { code: '562500', name: '机器人ETF华夏' }, { code: '515400', name: '大数据ETF富国' },
  { code: '560860', name: '工业有色ETF' }, { code: '516510', name: '云计算ETF易' },
  { code: '516390', name: '新能源车ETF' }, { code: '563010', name: '电信ETF易方达' },
  { code: '159875', name: '新能源ETF嘉实' }, { code: '516100', name: '金融科技ETF' },
  { code: '886078', name: '商业航天' }, { code: '512660', name: '军工ETF国泰' },
  { code: '560280', name: '工程机械ETF' }, { code: '515230', name: '软件ETF国泰' },
  { code: '159996', name: '家电ETF国泰' }, { code: '885939', name: '海峡两岸' },
  { code: '159227', name: '航空航天ETF' }, { code: '518880', name: '黄金ETF华安' },
  { code: '1A0001', name: '上证指数' }, { code: '159869', name: '游戏ETF华夏' },
  { code: '515150', name: '一带一路ETF' }, { code: '516620', name: '影视ETF国泰' },
  { code: '515120', name: '创新药ETF广发' }, { code: '516910', name: '物流ETF富国' },
  { code: '159842', name: '券商ETF银华' }, { code: '159666', name: '交通运输ETF' },
  { code: '512200', name: '房地产ETF南方' }, { code: '159766', name: '旅游ETF富国' },
  { code: '562600', name: '医疗器械ETF' }, { code: '159611', name: '电力ETF广发' },
  { code: '167301', name: '保险主题LOF' }, { code: '159825', name: '农业ETF富国' },
  { code: '159309', name: '油气ETF汇添富' }, { code: '512690', name: '酒ETF鹏华' },
  { code: '515220', name: '煤炭ETF国泰' }, { code: '159887', name: '银行ETF富国' }
];

/** 「大盘ETF」行的 4 个宽基 ETF */
export const BIDDING_BIG_ETFS = ['510500', '512100', '510300', '510050'];

/** 非 6 位数字代码 → 指数 thscode（其余按 5 开头=SH / 其它=SZ 走个股快照） */
export const BIDDING_INDEX_CODES = {
  '886078': '886078.TI',
  '885939': '885939.TI',
  '1A0001': MAIN_INDEX_THSCODE
};

export function biddingEtfToSnapshotCode(code) {
  const c = String(code || '').trim();
  if (BIDDING_INDEX_CODES[c]) return { thscode: BIDDING_INDEX_CODES[c], type: 'index' };
  if (c.charAt(0) === '5') return { thscode: c + '.SH', type: 'stock' };
  return { thscode: c + '.SZ', type: 'stock' };
}

/** 把 48 个观察标的拆成「个股/ETF 快照代码」与「指数快照代码」两组 */
export function biddingSnapshotCodeGroups() {
  const etfCodes = [];
  const indexCodes = [];
  BIDDING_SECTOR_ETFS.forEach(function (e) {
    const c = biddingEtfToSnapshotCode(e.code);
    if (c.type === 'index') indexCodes.push(c.thscode);
    else etfCodes.push(c.thscode);
  });
  const allIndexCodes = Array.from(new Set(indexCodes.concat([MAIN_INDEX_THSCODE])));
  return { etfCodes, indexCodes, allIndexCodes };
}

/**
 * 同花顺快照一条 item 的涨跌幅（number）。
 * 上游偶发给成正的「跌」，用 price_change / current_price vs prev_close 纠符号。
 * 前端与 Worker 必须用同一份，否则同一时刻两端口径会分叉。
 */
export function normalizeFuyaoSnapshotPct(it) {
  if (!it) return null;
  const raw = it.price_change_ratio_pct;
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!isFinite(n)) return null;
  const priceChange = it.price_change !== undefined && it.price_change !== null ? Number(it.price_change) : null;
  const curr = it.current_price !== undefined && it.current_price !== null ? Number(it.current_price) : null;
  const prev = it.prev_close !== undefined && it.prev_close !== null ? Number(it.prev_close) : null;
  const isActuallyDown = (priceChange !== null && priceChange < 0) || (curr !== null && prev !== null && curr < prev);
  if (isActuallyDown && n > 0) return -n;
  return n;
}

/** 快照值可能是 number（前端）或 '+1.23%'（worker fetchSnapshotChangePct），统一成 number */
export function biddingNumOf(v) {
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/%/g, '').replace(/,/g, '').trim());
  return isFinite(n) ? n : null;
}

/**
 * 快照 map 的 key 形态两端口径不同，这里统一兼容：
 *   · 前端 fuyao /api/a-share/prices/snapshot → item.thscode（'600519.SH'）
 *   · Worker fetchSnapshotChangePct → 6 位代码（'600519'）
 *   · 腾讯行情 → 'sh600519' 解析后前端转成 '600519.SH'
 * 先按完整 thscode 找，再退回去后缀的纯代码。
 */
export function biddingPctLookup(map, thscode) {
  if (!map) return undefined;
  const k = String(thscode || '');
  if (map[k] !== undefined) return map[k];
  const bare = k.replace(/\..*$/, '');
  if (bare !== k && map[bare] !== undefined) return map[bare];
  return undefined;
}

/**
 * 由各路快照算出「收盘列」各行的值。
 * 返回 key 与 useBiddingBoard.fetchSnapshot() 的 values 完全同名（板块ETF 用短名，
 * 由 resolveBiddingRowTargets 负责映射到库里真实的 '板块ETF(48)' 行）。
 *
 * ⛔ 任何一路没数据就【不给该行赋值】（§10：读取失败 ≠ 0），调用方只填空不造值。
 */
export function computeBiddingCloseValues(input) {
  const src = input || {};
  const ladderCodes = src.ladderCodes || [];
  const top10Codes = src.top10Codes || [];
  const stockPcts = src.stockPcts || {};
  const etfPcts = src.etfPcts || {};
  const indexPcts = src.indexPcts || {};
  const values = {};

  const ladderVals = ladderCodes
    .map(c => biddingNumOf(biddingPctLookup(stockPcts, c)))
    .filter(v => v !== null);
  if (ladderVals.length > 0) {
    values['最近多板%'] = (ladderVals.reduce((a, b) => a + b, 0) / ladderVals.length).toFixed(2);
  }

  let sectorRed = 0;
  let sectorSeen = 0;
  BIDDING_SECTOR_ETFS.forEach(function (e) {
    const c = biddingEtfToSnapshotCode(e.code);
    const raw = c.type === 'index'
      ? biddingPctLookup(indexPcts, c.thscode)
      : biddingPctLookup(etfPcts, c.thscode);
    const v = biddingNumOf(raw);
    if (v === null) return;
    sectorSeen++;
    if (v > 0) sectorRed++;
  });
  // 一只都没取到 ⇒ 不写 0（0 家上涨是合法值，但「没数据」不是）
  if (sectorSeen > 0) values['板块ETF'] = String(sectorRed);

  if (top10Codes.length > 0) {
    let top10Red = 0;
    let top10Seen = 0;
    top10Codes.forEach(function (c) {
      const v = biddingNumOf(biddingPctLookup(stockPcts, c));
      if (v === null) return;
      top10Seen++;
      if (v > 0) top10Red++;
    });
    if (top10Seen > 0) values['昨日资金前十'] = String(top10Red);
  }

  const bigVals = BIDDING_BIG_ETFS
    .map(c => biddingNumOf(biddingPctLookup(etfPcts, c + '.SH')))
    .filter(v => v !== null);
  if (bigVals.length > 0) {
    values['大盘ETF'] = (bigVals.reduce((a, b) => a + b, 0) / bigVals.length).toFixed(2);
  }

  const mainIdx = biddingNumOf(biddingPctLookup(indexPcts, MAIN_INDEX_THSCODE));
  if (mainIdx !== null) values['大盘（%）'] = mainIdx.toFixed(2);

  return values;
}

/**
 * 把 values 映射到【库中真实存在的行】，并只挑 close 仍为空的行。
 *
 * ★ 幂等 / 数据安全（§11）：已有非空 close 一律不覆盖 —— 用户手工修正优先于云端自动值。
 * ★ 不硬编码 '板块ETF(48)' 这种带数字后缀的行名，从 existingRows 里找前缀匹配。
 *
 * ★★ [OVERWRITE 2026-11-13] 唯一例外：显式 `opts.overwrite === true` 才允许改写已有非空值。
 *   为什么必须留这个口子：11-13 的 `板块ETF(48)` 收盘被旧逻辑写成 `0`（48 个标的没有一个上涨，
 *   物理上不可能），而正确值是 `8`。「不覆盖」把它永久冻住了 —— 错值一旦落库就再也修不掉，
 *   用户看到的永远错的。但默认必须仍然关闭：⛔ cron / 自动轮永远拿不到这个开关，
 *   只有人拿着 token 手动 `&overwrite=1` 才能触发，且【同值不写】避免无意义 upsert。
 *
 * @param {Array<{name:string,close?:string|null}>} existingRows 当天 bidding_data 已有行
 * @param {Record<string,string>} values computeBiddingCloseValues 的结果
 * @param {{overwrite?:boolean}} [opts]
 * @returns {Array<{name:string,close:string,from:string}>}
 */
export function resolveBiddingRowTargets(existingRows, values, opts) {
  const v = values || {};
  const allowOverwrite = !!(opts && opts.overwrite);
  const out = [];
  (existingRows || []).forEach(function (row) {
    const name = String((row && row.name) || '').trim();
    if (!name) return;
    const cur = (row && row.close !== null && row.close !== undefined) ? String(row.close).trim() : '';
    const closed = cur !== '';
    let from = '';
    let value;
    if (v[name] !== undefined) { value = v[name]; from = name; }
    else if (name.indexOf('板块ETF') === 0 && v['板块ETF'] !== undefined) { value = v['板块ETF']; from = '板块ETF'; }
    if (value === undefined || value === null || String(value).trim() === '') return;
    const next = String(value).trim();
    if (closed) {
      // 默认绝不覆盖；显式 overwrite 时也只在「值真的不同」才写
      if (!allowOverwrite || next === cur) return;
      out.push({ name: name, close: next, from: from, overwritten: cur });
      return;
    }
    out.push({ name: name, close: next, from: from });
  });
  return out;
}
