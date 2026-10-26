// ths-today-patch.js — 用同花顺临时补「今天」的竞价行情（Logic 层）
//
// 【用户口径 / 2026-10-26】
//   「为什么额度会用尽呢？……你用同花顺接口临时补下数据」
//   —— 猫抓（numcat）每天只有 10 次额度（见 workers/.../logic/close-workflow.js 的实测记录），
//      今天 09:25 两把 key 一启动就 403 ⇒ market_metrics 当天 0 行 ⇒ 全站看板"加载中"。
//      同花顺（fuyao）通道**免费、不限量**，项目里本来就有两条腿：
//        · K 线 historical  → 涨幅 / 开盘涨幅(=9:25 竞价成交价) / 昨日成交量
//        · 竞价快照 snapshot?stage=final → 竞价量 / 竞价涨幅 / 竞价量比（仅当天有）
//      本模块把它们组装成「补今天的 market_metrics」，一次性让所有看板恢复。
//
// 【与 logic/auction/trend-patch.js 的区别（⛔ 别搞混）】
//   trend-patch 是**纯展示**补缺，红线写着「⛔ 不写 market_metrics」。
//   本模块是**用户显式点击后写库**的临时补救（用户明确要求），两者不是一回事。
//
// 【安全约束（逐条都必须守住）】
//   · ⛔ 只 upsert，绝不 delete（§11）。
//   · ⛔ 只填【空字段】：库里已有值一律不覆盖（幂等；重复点也只补仍为空的行）。
//   · ⛔ 双重日期闸门：快照 data_status 必须 'final' 且服务端日期 == 目标日
//        （否则会把上一交易日的竞价量写到今天头上 —— trend-patch 里记过这个坑）。
//   · ⛔ 只允许补「今天」（历史日有自己的补拉链路，不从这里走）。
//   · §10：读名单 / 读库 / 写库 任一步失败都向上抛，绝不伪装成"已补好"。
//   · §32：模块级单飞，连点只跑一次；不自动触发，只能由用户按钮调用。
import { readAuctionRoster, readAuctionMetrics, upsertAuctionMetrics, AUCTION_SCOPE } from '../../data/auction-metrics-patch.js';
import { fetchFuyaoDailyPctRange } from '../../data/stock-range-pct.js';
import { fuyaoApiGet, tickerToThscode } from '../../data/api/fuyao-proxy.js';
import { computeKlineDayPatch } from './trend-patch.js';
import { beijingTodayStr } from './auction-pull-window.js';
import { _dbgLog } from '../../data/debug-log.js';

/** 快照接口单批上限（与 suspend.js / trend-patch.js 同一契约：40 个 thscode） */
const SNAPSHOT_CHUNK = 40;

const _inflight = new Map();

// ── 格式化：与库内既有行的字符串口径逐字一致（见 2026-10-23 真实样例行） ──────────────
//   change_pct / auc_pct_chg : "+10.00%" / "-3.77%"（带符号 + 两位小数 + %）
//   volume / yest_volume     : "612" / "6137"（整数，单位万股）
//   auc_vol_ratio / auc_turnover : "55.18" / "2.27"（两位小数，无单位）
//
// ⚠️ 三个函数都先把「空串 / 纯空白」判成缺失 —— 否则 Number('') === 0 会把"没有值"
//    写成 "0.00%"/"0"，那是**编造数据**（§10 宁缺勿错）。
function _miss(v) {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '') || !isFinite(Number(v));
}

export function fmtPct(v) {
  if (_miss(v)) return null;
  const n = Number(v);
  return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
}
export function fmtIntVol(v) {
  if (_miss(v)) return null;
  const n = Number(v);
  return n > 0 ? String(Math.round(n)) : null;
}
export function fmtRatio(v) {
  if (_miss(v)) return null;
  return Number(v).toFixed(2);
}

/** 库里这个字段算不算"空"（null / undefined / 空串 / 纯空白） */
function _isEmpty(v) {
  return v === null || v === undefined || String(v).trim() === '';
}

/** 拉竞价快照（分批），返回 { items, timestamp, dataStatus } */
async function _fetchSnapshot(thscodes) {
  const out = [];
  let timestamp = 0;
  let dataStatus = '';
  for (let i = 0; i < thscodes.length; i += SNAPSHOT_CHUNK) {
    const chunk = thscodes.slice(i, i + SNAPSHOT_CHUNK);
    const data = await fuyaoApiGet('/api/a-share/auction/snapshot', {
      thscodes: chunk.join(','),
      stage: 'final',
    });
    if (i === 0) {
      timestamp = Number(data && data.timestamp) || 0;
      dataStatus = String((data && data.data_status) || '');
    }
    const arr = (data && data.item) || [];
    for (let k = 0; k < arr.length; k++) out.push(arr[k]);
  }
  return { items: out, timestamp: timestamp, dataStatus: dataStatus };
}

/**
 * 用同花顺补齐「今天」的竞价行情并写库。
 *
 * @param {string} [date] 目标日（缺省 = 北京今天）；⛔ 只接受今天
 * @param {{onProgress?:(stage:string,done:number,total:number)=>void, requestTimeoutMs?:number}} [opts]
 * @returns {Promise<{ok:boolean, date:string, roster:number, patchedRows:number, filled:{pct:number,vol:number,ratio:number}, reason?:string, logs:string[]}>}
 */
export async function patchTodayAuctionFromThs(date, opts) {
  const o = opts || {};
  const logs = [];
  const log = function(m) { logs.push(m); _dbgLog('[THS-PATCH] ' + m); };
  const report = function(stage, done, total) {
    if (typeof o.onProgress === 'function') {
      try { o.onProgress(stage, done, total); } catch (e) { /* 进度回调失败不影响主流程 */ }
    }
  };

  const today = beijingTodayStr();
  const d = date || today;
  if (d !== today) {
    // ⛔ 只补今天：历史日有专门的按天补拉链路，不走这条"临时救急"
    return { ok: false, date: d, roster: 0, patchedRows: 0, filled: { pct: 0, vol: 0, ratio: 0 }, reason: '只允许补今天（' + today + '），收到 ' + d, logs: logs };
  }

  const fly = _inflight.get(d);
  if (fly) return fly;

  const p = (async function() {
    // ① 今天应该有哪些票（正式名单）—— 读失败直接抛（§10）
    const roster = await readAuctionRoster(d);
    if (roster.length === 0) {
      log('名单为空（auction_watchlist ' + d + ' 无行）⇒ 无可补对象');
      return { ok: false, date: d, roster: 0, patchedRows: 0, filled: { pct: 0, vol: 0, ratio: 0 }, reason: '当天名单为空', logs: logs };
    }
    // 只有 6 位代码的才能查上游（§40 不猜代码）
    const targets = roster
      .map(function(r) { return { stock: String(r.stock || '').trim(), code: String(r.code || '').trim() }; })
      .filter(function(t) { return t.stock && /^\d{6}$/.test(t.code); });
    log('名单 ' + roster.length + ' 只，其中带 6 位代码 ' + targets.length + ' 只');
    if (targets.length === 0) {
      return { ok: false, date: d, roster: roster.length, patchedRows: 0, filled: { pct: 0, vol: 0, ratio: 0 }, reason: '名单没有可用代码', logs: logs };
    }

    // ② 库里现状 —— 决定"哪些字段还空着"
    const existing = await readAuctionMetrics(d);
    const byStock = new Map();
    existing.forEach(function(r) {
      const k = String(r.stock || '').trim();
      if (k) byStock.set(k, r);
    });
    log('库内已有 ' + existing.length + ' 行（缺字段的会被补，已有的绝不覆盖）');

    // ③ K 线腿：涨幅 / 开盘涨幅(竞价) / 昨日成交量 —— 一次请求三样，0 猫抓额度
    report('kline', 0, targets.length);
    const openOut = new Map();
    const volOut = new Map();
    let pctMap = null;
    try {
      pctMap = await fetchFuyaoDailyPctRange(
        targets,
        [d],
        { requestTimeoutMs: o.requestTimeoutMs || 20000, openOut: openOut, volOut: volOut }
      );
    } catch (e) {
      // §10：K 线腿失败只降级这一腿（快照腿照走），但不伪装成"没有数据"
      log('❌ K 线腿失败（涨幅/竞价涨幅/昨量本次补不上）: ' + (e && e.message || e));
    }

    // ④ 快照腿：竞价量 / 竞价涨幅(终态) / 竞价量比 —— 仅当天有，必须过双重闸门
    report('snapshot', 0, targets.length);
    let snapByName = new Map();
    try {
      const snap = await _fetchSnapshot(targets.map(function(t) { return tickerToThscode(t.code); }));
      const snapYmd = snap.timestamp > 0
        ? new Date(snap.timestamp + 8 * 3600 * 1000).toISOString().slice(0, 10) : '';
      if (snap.dataStatus !== 'final' || snapYmd !== d) {
        // 闸门拒绝：⛔ 绝不把上一交易日的竞价量写到今天头上
        log('⚠️ 快照闸门拒绝（data_status=' + snap.dataStatus + ' 服务端日=' + snapYmd + ' 目标日=' + d + '）⇒ 竞价量/量比本次不补');
      } else {
        // 双键登记：响应里的 thscode 带 .SH/.SZ 后缀，裸码也要能命中
        const nameOf = {};
        targets.forEach(function(t) {
          nameOf[t.code] = t.stock;
          const ths = tickerToThscode(t.code);
          if (ths !== t.code) nameOf[ths] = t.stock;
        });
        (snap.items || []).forEach(function(it) {
          if (!it || !it.thscode) return;
          const name = nameOf[String(it.thscode).trim()] || nameOf[String(it.thscode).split('.')[0]];
          if (!name) return;
          // 同名的后写覆盖先写（同一只票只应有一条）
          snapByName.set(name, it);
        });
        log('快照命中 ' + snapByName.size + '/' + targets.length + ' 只（data_status=final，服务端日 ' + snapYmd + '）');
      }
    } catch (e) {
      log('❌ 快照腿失败（竞价量/量比本次补不上）: ' + (e && e.message || e));
    }

    // ⑤ 组装：只放「库里为空 + 上游拿到了」的字段
    const ymd = d.replace(/-/g, '');
    const rows = [];
    const filled = { pct: 0, vol: 0, ratio: 0 };
    targets.forEach(function(t) {
      const cur = byStock.get(t.stock) || null;
      const keep = pctMap ? pctMap.get(t.stock) : null;
      const k = computeKlineDayPatch(
        ymd,
        keep || null,
        openOut.get(t.stock) || null,
        volOut.get(t.stock) || null
      );
      const snap = snapByName.get(t.stock) || null;

      // 基础键 —— 新行要带 code / source；已有行只带键（其余字段靠 merge 保留原值）
      const row = { date: d, stock: t.stock, code: t.code, scope: AUCTION_SCOPE };
      if (!cur) {
        // 如实标注来源，⛔ 不冒充 worker（追溯时能一眼分清哪些是临时补的）
        row.source = 'ths-patch';
        row.updated_by = 'ths-patch';
      }

      // 涨幅
      if (!cur || _isEmpty(cur.change_pct)) {
        const v = fmtPct(k.changePct);
        if (v !== null) { row.change_pct = v; filled.pct++; }
      }
      // 竞价涨幅：快照终态值优先（K线 open 换算是兜底）
      if (!cur || _isEmpty(cur.auc_pct_chg)) {
        const fromSnap = snap && snap.auction_pct != null && isFinite(Number(snap.auction_pct))
          ? Number(snap.auction_pct) : null;
        const v = fmtPct(fromSnap !== null ? fromSnap : k.aucPctChg);
        if (v !== null) row.auc_pct_chg = v;
      }
      // 昨日成交量（万股）
      if (!cur || _isEmpty(cur.yest_volume)) {
        const v = fmtIntVol(k.yestVolume);
        if (v !== null) row.yest_volume = v;
      }
      // 竞价量（手 → 万股）
      if (!cur || _isEmpty(cur.volume)) {
        const raw = snap && snap.auction_volume != null && isFinite(Number(snap.auction_volume))
          ? Number(snap.auction_volume) / 100 : null;
        const v = fmtIntVol(raw);
        if (v !== null) { row.volume = v; filled.vol++; }
      }
      // 竞价量比
      if (!cur || _isEmpty(cur.auc_vol_ratio)) {
        const raw = snap && snap.auction_volume_ratio != null && isFinite(Number(snap.auction_volume_ratio))
          ? Number(snap.auction_volume_ratio) : null;
        const v = fmtRatio(raw);
        if (v !== null) { row.auc_vol_ratio = v; filled.ratio++; }
      }

      // 没有任何一个字段要补 ⇒ 不提交（省请求，也让"全部已完整"能被观察到）
      const hasPayload = Object.keys(row).some(function(key) {
        return key !== 'date' && key !== 'stock' && key !== 'code' && key !== 'scope';
      });
      if (hasPayload) rows.push(row);
    });

    report('write', 0, rows.length);
    if (rows.length === 0) {
      log('✅ 库内字段已完整，无需补写');
      return { ok: true, date: d, roster: roster.length, patchedRows: 0, filled: filled, reason: '已完整', logs: logs };
    }

    // ⑥ 写库（只 upsert，⛔ 不 delete）
    const written = await upsertAuctionMetrics(rows);
    log('✅ 补写 ' + written + ' 行（其中涨幅 ' + filled.pct + '、竞价量 ' + filled.vol + '、量比 ' + filled.ratio + '）');
    report('done', written, rows.length);
    return { ok: true, date: d, roster: roster.length, patchedRows: written, filled: filled, logs: logs };
  })().finally(function() {
    _inflight.delete(d);
  });

  _inflight.set(d, p);
  return p;
}

/** 仅供测试 / 诊断 */
export function _resetThsPatchForTest() {
  _inflight.clear();
}
