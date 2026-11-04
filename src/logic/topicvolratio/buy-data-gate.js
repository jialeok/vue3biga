/**
 * 【题材量比 · 买点侧】数据缺失 ⇒ 禁止选股（硬空仓）的唯一判据（纯函数，§15 可单测）。
 *
 * ★★ [TVRB-DATA-GATE 2026-11-04 用户口径 · 第七轮]
 *
 * 用户原话：
 *   「题材没有平均量比的时候，题材量比看板选股就不能选票了，应该空仓或者提醒用户修复程序数据，
 *     那里应该有一个专门的提示板，写出不能选票的理由。我上次问题不是交代了，还交代了选股条件的
 *     数据缺失，也不能选票，比如竞价量比，20日涨幅，10日涨幅缺失等，数据缺失都不要选股，要有提示，
 *     如果竞价量比缺失选出的票本身就是错误的，只会误导，要有提示行。不要把股票放进去了，这是个常识」
 *
 * 🔴【为什么必须有这道闸门 —— 它与 buy-settle 是两件完全不同的事】
 *   · `buy-settle.js` 管的是「**还没到**」：数据在路上，等几秒就齐 ⇒ 挂「结果确认中」占位。
 *   · 本文件管的是「**根本不会有**」：该日的这份数据整体缺失（上游没给 / 读失败 / 口径决定当天不给）
 *     ⇒ 再等一万年也等不来 ⇒ 必须直接给结论【今天不能选股】，并写清缺什么、怎么修。
 *   ⛔ 两者混用是最坏的结果：把「永远缺失」做成「一直在等」，用户就会看到一句永远不消失的
 *     「结果确认中」，然后某次网络兜底放行后**把票放出来** —— 那正是用户说的「选出的票本身就是错误的」。
 *
 * 🔴【为什么「缺数据就不选」是常识而不是过度保守】
 *   本看板的选股规则本质上全是**阈值判据**：
 *     · 题材平均竞价量比 ≥ 25 / < 25         → 决定「今天能不能开仓」（第十九条 / 空仓提醒）
 *     · 十日涨幅的名次                       → 决定「龙几」「进没进前十」「够不够候补」
 *     · 20 日涨幅前五 / 前十                 → 决定退潮判定的总龙、弱势切抱团、补涨题材
 *   这些判据**没有一项有默认值**。数据缺了就只剩两条路：
 *     ① 当成 0 / 当成空 ⇒ 算出「量比极低 / 名次很后」⇒ 结论是**编出来的**；
 *     ② 跳过该判据 ⇒ 退化成「不看这条规则」⇒ 结论也是**编出来的**。
 *   ⇒ 所以本文件的口径是 fail-closed：**缺 ⇒ 一只都不选**，并把原因摆在屏幕上（用户要的「提示行」）。
 *     §10「读取失败 / 缺失 ≠ 0、宁缺勿错」在这里的具体落地。
 *
 * 🔴【判据的粒度：整表缺失 vs 个别票缺值（⛔ 别把两者混为一谈）】
 *   本文件只判【整表级缺失】。个别票缺一个值（比如某只票没有十日涨幅）**不在这里拦** ——
 *   那是规则层逐票的 §10 行为（`rank === null` ⇒ 该票不参与龙位、不顺延），拦它等于让看板永远空着。
 *   ⇒ 所以判据是「**覆盖率**」而不是「有没有一个 null」。
 *
 *   阈值与实测证据（2026-11-04 直连生产库逐日核过，⛔ 别凭感觉调）：
 *     | 数据 | 正常日 | 本次事故日（11-04） |
 *     |---|---|---|
 *     | 竞价量比 `market_metrics.auc_vol_ratio` | 10-28~11-03 **每天 100%** | **0%**（猫抓对当天不返回四要素）|
 *     | 十日涨幅 `stock_range_pct.range_pct`    | 有行即有值，**100%** | 池内约 65%（正常波动，不是缺失）|
 *     | 20 日涨幅 `stock_range20_pct`           | 有行即有值，**100%** | 正常 |
 *   ⇒ 量比用 50%、十日涨幅用 30%：两者都能把「整表缺失（≈0%）」与「个别票缺值（65%~100%）」干净分开。
 *   ⚠️ 十日涨幅阈值刻意比量比低得多：它天然允许个别票没有（新股 / 停牌 / 补位票），
 *     65% 这种覆盖率**必须放行**，否则看板天天空仓 —— 那会把这条规则变成噪音。
 *
 * @param {object} ctx
 *   date           展示日 YYYY-MM-DD（只用于文案，⛔ 不参与判定）
 *   rows           选股池的【全部行】（`rec.topics[].members` 摊平）。
 *                  每行只需 `{ name, aucVolRatio, pct }`：
 *                    · `aucVolRatio` 当日竞价量比（缺 ⇒ null）
 *                    · `pct`        十日涨幅（缺 ⇒ null）
 *   range20Ready   该日「20 日涨幅前五」的结论到没到（`hasRange20LeadersVerdictForDate(d)`）
 *   range20Count   该日 20 日涨幅前五的条数
 *   range20GaveUp  上游已经放弃（硬兜底放行）⇒ `range20Ready === false` 时按【缺失】处理
 *                  （⛔ 不能既没结论又当成有：那等于拿空榜当「今天没有龙头」）
 * @returns {{
 *   blocked:boolean,
 *   items:Array<{key:string,label:string,why:string,fix:string,stat:string}>,
 *   headline:string, detail:string, shortText:string,
 *   stats:{rows:number, ratio:{n:number,k:number}, range10:{n:number,k:number}}
 * }}
 */
export function resolveBuyDataGate(ctx) {
  const o = ctx || {};
  const rows = Array.isArray(o.rows) ? o.rows.filter((r) => r && r.name) : [];
  const n = rows.length;
  const rc = _cover(rows, (r) => _num(r.aucVolRatio));
  const pc = _cover(rows, (r) => _num(r.pct));
  const items = [];

  // ① 选股池本身是空的 —— 连「有几只票」都不知道，任何选股结论都是编的
  if (n === 0) {
    items.push({
      key: 'pool',
      label: '题材名单',
      why: '这一天的题材分组 / 竞价名单一行都没有读出来 ⇒ 连「有哪些票」都不知道，' +
        '下面的规则一条都无从下手。',
      fix: '先看早盘竞价第一页今天有没有名单（没有 ⇒ 是 9:25 抓取那一步没跑成）；' +
        '名单正常但本板为空 ⇒ 是本板的题材分组读取失败，请刷新重试。',
      stat: '0 只'
    });
  }

  // ② 竞价量比 —— 本看板的【核心输入】，缺了等于整个「题材量比」这个定义都不成立
  if (n > 0 && rc.ratio < TVRB_DATA_GATE_MIN_RATIO_COVER) {
    items.push({
      key: 'auc_vol_ratio',
      label: '竞价量比',
      why: '题材平均竞价量比（≥ 25 才开仓 / < 25 空仓）、题材之间的排名、' +
        '以及「题材龙一量比」这几条规则全都只吃这一个字段。它缺了，' +
        '选出来的票和空仓提醒都是**编出来的**——这正是会把人带进错票的那一类错误。',
      fix: '竞价量比按口径只认猫抓（`daily_auc.auc_vol_ratio`），' +
        '而猫抓对【当天】不返回这个字段 ⇒ 盘中（9:25 ~ 收盘）它本来就是空的。' +
        '收盘后 16:30 云端会用猫抓回填；最迟次日 9:25 补齐。' +
        '若【历史日】也缺 ⇒ 是云端回填没跑成，需要执行 `?display=1` 补数。',
      stat: rc.k + ' / ' + n + ' 只（' + _pct(rc.ratio) + '）'
    });
  }

  // ③ 十日涨幅 —— 龙位（龙一/龙二/龙几）、前十名次、十日涨幅候补的唯一输入
  if (n > 0 && pc.ratio < TVRB_DATA_GATE_MIN_RANGE10_COVER) {
    items.push({
      key: 'range10',
      label: '十日涨幅',
      why: '本看板的「龙几」、进没进前十、够不够第二十九条候补，全部由十日涨幅的名次决定。' +
        '整表读不出来时，龙位与名次都算不出 ⇒ 选哪一只、选几只都是猜的。',
      fix: '十日涨幅由云端按「逐日收盘涨幅腿」复利算好写库（`stock_range_pct`），正常不依赖任何上游请求。' +
        '整表为空通常是该日的腿表没跑完。执行 Edge Function `?range10=1` 可当天补算。',
      stat: pc.k + ' / ' + n + ' 只（' + _pct(pc.ratio) + '）'
    });
  }

  // ④ 20 日涨幅前五 —— 退潮判定的总龙、弱势切抱团、补涨题材、分歧买点的共同输入
  const _r20Missing = (o.range20Count > 0) ? false : (o.range20Ready === true || o.range20GaveUp === true);
  if (_r20Missing) {
    items.push({
      key: 'range20',
      label: '20 日涨幅前五',
      why: '退潮判定的「总龙一」就是 20 日涨幅第 1 名；弱势切抱团、补涨题材、总龙首次分歧' +
        '这三条买点也全都要看前五 / 前十的名次。榜是空的 ⇒ 这些规则要么不生效、要么按错的票算。',
      fix: '20 日涨幅同样由云端复利算好写库（`stock_range20_pct`）。' +
        '榜为空基本是当天那条链路没跑完：执行 Edge Function（`?healOnly=1` 或 `?range20=1`）重算一次。',
      stat: '前五 0 只'
    });
  }

  const stats = { rows: n, ratio: rc, range10: pc };
  // 放行时也要带上 stats：提示板之外，排障 / 自检需要知道「当时覆盖率是多少」。
  // ⚠️ 这里**不返回 TVRB_DATA_GATE_NONE**：那个单例的 stats 是常量，
  //    带上它会让「放行」与「实际覆盖率」两件事对不上（统计失真比多建一个对象危险得多）。
  if (items.length === 0) {
    return { blocked: false, items: [], headline: '', detail: '', shortText: '', stats: stats };
  }

  const labels = items.map((it) => it.label).join('、');
  return {
    blocked: true,
    items: items,
    headline: '⛔ 今日不能选股 · 空仓',
    // 底部总述：把「为什么宁可不选」讲成一句人话（用户要的「写出不能选票的理由」）
    detail: '缺数据时选出来的票**本身就是错的**（阈值判据没有默认值，缺了就只剩「当 0」或「跳过规则」' +
      '两种编造方式）⇒ 按本项目口径宁可不选：买点侧一只票都不给，等数据补齐后再看。' +
      '卖点侧不受影响（卖出不吃这些输入）。',
    // 标题栏用的极短文案（用户习惯扫一眼标题栏就知道今天什么状态）
    shortText: labels + '缺失',
    stats: stats
  };
}

/** 未触发时的稳定返回值（同一引用 ⇒ 不白白触发下游重算 / 重渲染，§19） */
export const TVRB_DATA_GATE_NONE = Object.freeze({
  blocked: false,
  items: Object.freeze([]),
  headline: '',
  detail: '',
  shortText: '',
  stats: Object.freeze({ rows: 0, ratio: Object.freeze({ n: 0, k: 0 }), range10: Object.freeze({ n: 0, k: 0 }) })
});

/**
 * 竞价量比覆盖率下限（低于它 ⇒ 判为「整表缺失」）。
 * 实测：正常日 100%，事故日 0% ⇒ 50% 能把两者干净分开（见文件头那张表）。
 */
export const TVRB_DATA_GATE_MIN_RATIO_COVER = 0.5;

/**
 * 十日涨幅覆盖率下限 —— 刻意比量比低得多。
 * 它天然允许个别票没有（新股 / 停牌 / 补位票），实测事故日仍有约 65%（正常波动）
 * ⇒ 阈值若也取 50%，就会把「个别缺值」误判成「整表缺失」，看板天天空仓。
 */
export const TVRB_DATA_GATE_MIN_RANGE10_COVER = 0.3;

/** 覆盖率统计：k = 有值的行数，n = 总行数，ratio = k / n（n=0 时 ratio=0） */
function _cover(rows, pick) {
  let k = 0;
  rows.forEach((r) => {
    if (pick(r) !== null) k++;
  });
  return { n: rows.length, k: k, ratio: rows.length > 0 ? (k / rows.length) : 0 };
}

/** 数值归一：空串 / null / 非数字 ⇒ null（§10：缺值绝不折成 0） */
function _num(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 覆盖率 → 百分比文案（0 位小数即可，这里是给人看个量级） */
function _pct(v) {
  const n = _num(v);
  return n === null ? '—' : (n * 100).toFixed(0) + '%';
}
