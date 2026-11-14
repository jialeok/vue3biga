// useAbnormalDeviation.js — 「官方偏离值」的取数编排（Logic 接线层，§5 依赖方向：Composable → Data / Logic）
//
// ══════════════════════════════════════════════════════════════════════════════════════
// 【用户口径（2026-11-14 原话）】
//   「这些在买点侧，也说明下，很重要，特别是竞价时，或者收盘后，我看一遍股票或者市场前十，
//     就知道怎么参考了。你看怎么设计比较合理，包括UI显示，和每天监控时间点。」
//
// ⇒ 三个时点，两条口径，一套纯函数（⛔ 不许各算一套）：
//
//   ┌ 时点 ─────────────┬ 末腿口径 ──────────────┬ 数据来源 ─────────────────────┐
//   │ 9:25 / 9:26 竞价   │ 今日竞价涨幅顶替末腿    │ stock_daily_pct + 指数腿      │
//   │ 收盘后 16:00       │ 今日收盘腿（库里自带）  │ stock_daily_pct + 指数腿      │
//   │ 复盘历史日         │ 该日收盘腿              │ 同上（asOf = 那一天）         │
//   └────────────────────┴────────────────────────┴───────────────────────────────┘
//   ⚠️ 指数腿在竞价时点【没有当日值】（指数没有集合竞价成交价）⇒ 按「指数不动」处理，
//      与用户 11-13 那句「九阳股份 30 日偏离 199.9 ⇒ 周一只要不跌就构成严重异常波动」
//      完全同一口径。文案里要写明（deviation.js#deviationDetailLine 已写）。
//
// ── 红线 ────────────────────────────────────────────────────────────────────────
//   · ⛔ 只读：不写库、不改 stock_daily_pct、不改任何选股结论；
//   · §10：日腿读失败 / 指数缺腿 ⇒ meta.ready 如实反映，⛔ 绝不把「没算出来」当「没有异动」；
//   · §32：只有 names / asOf 变化才重算；同一份入参命中会话缓存（data 层各自带缓存）；
//   · 切日期竞态：`_seq` 序号闸，晚回来的旧请求一律丢弃（与组合式里那些 `xxxDate === d` 同一条红线）。
// ══════════════════════════════════════════════════════════════════════════════════════

import { ref, shallowRef } from 'vue';
import { readDailyPctRowsFor } from '../data/stock-daily-pct.js';
import {
  readIndexLegsForDates, indexLegsOf, indexLegsGapText, shiftYmd
} from '../data/index-daily-pct.js';
import {
  buildDeviationMap, deviationCellTexts, deviationDetailLine, deviationIndexLabel,
  DEV_FORMULA_LINES, DEV_INDEX_NOTE_LINES, DEV_NEED_HINT,
  DEV_STAGE_NEAR, DEV_STAGE_SEVERE, DEV_STAGE_WATCH
} from '../logic/auction/abnormal-deviation.js';
import { _dbgLog } from '../data/debug-log.js';

/** 窗口向前取多少自然日：30 交易日 ≈ 42 自然日，留到 75 天以防长假 */
const LOOKBACK_DAYS = 75;

function _emptyMeta(asOf) {
  return {
    asOf: asOf || '',
    ready: 0,
    total: 0,
    src: '',
    loading: false,
    basis: '',
    error: '',
    note: '',
    // ★ [ABN-DEV-UX 2026-11-14] 面板顶部「计算公式」三行 —— 用户「我自己也要验证下」。
    //   静态常量，视图只 v-for（§21 模板零计算）。
    formulaLines: DEV_FORMULA_LINES,
    // ★ [IDX-LABEL 2026-11-14] 「对应指数是什么」说明（用户「顺便在提示板上面说明下」）。
    //   与公式块分开排版：这块回答「减的是谁」，公式块回答「怎么减」。
    indexNoteLines: DEV_INDEX_NOTE_LINES
  };
}

/** 腿 Map（票名 → {日期→涨幅}）里出现过的全部交易日（升序） */
function _datesOf(dailyMap) {
  const set = new Set();
  if (dailyMap && typeof dailyMap.forEach === 'function') {
    dailyMap.forEach(function (dayMap) {
      if (dayMap && typeof dayMap.forEach === 'function') {
        dayMap.forEach(function (_v, d) { if (d) set.add(String(d).slice(0, 10)); });
      }
    });
  }
  return Array.from(set).sort();
}

/** 档位 → 面板行色调（视图只读字符串，§21） */
function _toneOf(fact) {
  if (!fact || fact.ok !== true) return '';
  if (fact.stage === DEV_STAGE_SEVERE) return 'severe';
  if (fact.stage === DEV_STAGE_NEAR) return 'near';
  if (fact.stage === DEV_STAGE_WATCH) return 'watch';
  return 'normal';
}

/**
 * @returns {{
 *   devMap: object, meta: object, load: Function, rowsFor: Function, clear: Function
 * }}
 */
export function useAbnormalDeviation() {
  const devMap = shallowRef(new Map());
  const meta = shallowRef(_emptyMeta(''));
  let _seq = 0;

  function clear() {
    _seq++;
    devMap.value = new Map();
    meta.value = _emptyMeta('');
  }

  /**
   * 拉一次偏离值。
   * @param {object} o
   * @param {string[]} o.names 要算的票（买点侧选中票 + 市场前十）
   * @param {string} o.asOf 窗口末日（当天 = 今日）
   * @param {function(string):string} o.codeOf 票名 → 6 位代码
   * @param {'close'|'auction'} [o.basis='close']
   * @param {function(string):(number|string|null)} [o.todayPctOf] 仅竞价时点传
   * @returns {Promise<void>}
   */
  async function load(o) {
    const opt = o || {};
    const names = Array.from(new Set((opt.names || [])
      .map(function (n) { return String(n || '').trim(); })
      .filter(Boolean)));
    const asOf = String(opt.asOf || '').slice(0, 10);
    const basis = opt.basis === 'auction' ? 'auction' : 'close';
    if (names.length === 0 || !asOf) { clear(); return; }

    const my = ++_seq;
    meta.value = Object.assign(_emptyMeta(asOf), { loading: true, basis: basis, total: names.length });

    try {
      const from = shiftYmd(asOf, -LOOKBACK_DAYS);
      const daily = await readDailyPctRowsFor(names, from, asOf);
      if (my !== _seq) return;                                  // 切日期了，丢弃
      if (!daily) {
        // §10：读失败 ≠ 没有数据。⛔ 不拿空 Map 顶替，也不清空已有结果（可能是同一份数据的旧值）
        meta.value = Object.assign(_emptyMeta(asOf), {
          basis: basis, total: names.length,
          error: '逐日涨幅腿（stock_daily_pct）读取失败'
        });
        _dbgLog('[ABN-DEV] ' + asOf + ' 逐日腿读取失败 ⇒ 本次偏离值判不出（§10）');
        return;
      }

      const dates = _datesOf(daily);
      const idxRes = await readIndexLegsForDates(dates, {});
      if (my !== _seq) return;

      const idxLegs = new Map();
      idxRes.map.forEach(function (_m, code) { idxLegs.set(code, indexLegsOf(idxRes.map, code, asOf)); });

      const built = buildDeviationMap({
        names: names,
        dailyByStock: daily,
        indexLegs: idxLegs,
        codeOf: typeof opt.codeOf === 'function' ? opt.codeOf : function () { return ''; },
        asOf: asOf,
        todayPctOf: typeof opt.todayPctOf === 'function' ? opt.todayPctOf : null,
        basis: basis
      });
      if (my !== _seq) return;

      devMap.value = built.map;
      const gapNote = indexLegsGapText(idxRes);
      meta.value = Object.assign(_emptyMeta(asOf), {
        basis: basis,
        ready: built.ready,
        total: built.total,
        src: idxRes.src,
        error: idxRes.ready ? '' : (idxRes.error || '指数腿未就绪'),
        note: gapNote
      });
      _dbgLog('[ABN-DEV] ' + asOf + ' 偏离值覆盖 ' + built.ready + '/' + built.total +
        '（指数腿来源 ' + idxRes.src + '，口径 ' + basis + '）');
    } catch (e) {
      if (my !== _seq) return;
      meta.value = Object.assign(_emptyMeta(asOf), {
        basis: basis, total: names.length,
        error: (e && e.message) || String(e)
      });
      _dbgLog('[ABN-DEV] ' + asOf + ' 计算失败：' + ((e && e.message) || e));
    }
  }

  /**
   * 面板行（市场前十 / 买点票）—— 按传入顺序出，判不出的票【仍然出行但数值为 —】，
   * ⛔ 不隐藏（§10：缺数据必须看得见，不能当成「没有异动」悄悄消失）。
   *
   * @param {string[]} names 有序票名
   * @returns {Array<{name:string, indexLabelText:string, indexLabelTitle:string,
   *   dev10Text:string, dev30Text:string} &
   *   {gapText:string, calcText:string, needValueText:string, needHintText:string,
   *    needTone:string, gapTailText:string, indexMoveText:string, stageText:string,
   *    stage:number|string, tone:string, ok:boolean, title:string}>}
   */
  function rowsFor(names) {
    const out = [];
    const m = devMap.value;
    (names || []).forEach(function (raw) {
      const name = String(raw || '').trim();
      if (!name) return;
      const f = (m instanceof Map) ? m.get(name) : null;
      const needText = f && f.ok ? (f.needValueText || '') : '';
      // 🔴 [ABN-CHECK 2026-11-14] 表格列必须与徽标/自核用【同一个已取整的数】：
      //   真实库九阳 11-13 dev30=199.9592，固定 1 位会印成 +200.0%（看着像已越线），
      //   而徽标是 +199.96% ⇒ 三个地方打架。统一走 deviationCellTexts。
      const cells = (f && f.ok) ? deviationCellTexts(f) : null;
      const idxLabel = f ? deviationIndexLabel(f) : { text: '', title: '' };
      out.push({
        name: name,
        ok: !!(f && f.ok === true),
        // ★ [IDX-LABEL] 票名后那枚「对应指数」小标签：每行各自那一个，判不出 ⇒ 空串（§10）
        indexLabelText: idxLabel.text,
        indexLabelTitle: idxLabel.title,
        dev10Text: cells ? cells.dev10Text : '—',
        dev30Text: cells ? cells.dev30Text : '—',
        gapText: f && f.ok ? (f.gapText || '') : '未就绪',
        // ★ [IDX-MOVE 2026-11-14 用户定的第二行顺序]
        //   主段「股价再涨约 +5.2%（同期指数不动 · 条件估算）」→ 灰字「自核…」→
        //   灰字「距 200% 差 14.5 点」→ 灰字「指数 ±1% ⇒ 需涨 …（β…）」。
        //   ⛔ 点差不再抢主位，但仍是能与徽标相加核对的那个数。
        needValueText: needText,
        needHintText: needText ? DEV_NEED_HINT : '',
        needTone: (f && f.ok && f.needAlert) ? 'alert' : '',   // 接近警示 ⇒ 数值标红（§21 判据在 Logic）
        calcText: f && f.ok ? (f.calcText || '') : '',
        gapTailText: needText ? (f.gapShort || '') : '',
        indexMoveText: f && f.ok ? (f.indexMoveText || '') : '',
        stage: f && f.ok ? f.stage : '',
        stageText: f && f.ok ? (f.stageText || '') : '',
        tone: _toneOf(f),
        need10: f && f.ok ? f.need10 : null,
        need30: f && f.ok ? f.need30 : null,
        // ★ [ABN-DEV-UNIT 2026-11-14] 悬停给【完整说明】：两张偏离值 + 指数同期 + 距红线 +
        //   「自核：30 日偏离 = 个股区间涨幅 − 指数区间涨幅；股价每再涨 1%，偏离约增加 N 个点」+ 口径。
        //   用户就是靠这一句自己验「差 14.5 个点为什么只值 +5.2%」，⛔ 别只给一行摘要。
        title: f && f.ok ? deviationDetailLine(f) : '偏离值未就绪（指数腿或逐日腿缺）'
      });
    });
    return out;
  }

  return { devMap: devMap, meta: meta, load: load, rowsFor: rowsFor, clear: clear };
}
