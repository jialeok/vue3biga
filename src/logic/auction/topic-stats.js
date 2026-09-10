// topic-stats.js — 题材分组统计条（Logic 层纯函数，§15 独立业务模块 / §21 模板不做重型计算）
//
// 产品口径（2026-09-10）：
//   - 只在【题材 toggle 单独开启】时显示（与 topicOnlyMode 同源：题材开且无其它主排序参与）；
//   - 每个题材（界面一个色块）上方一行小字，排版与展开面板「趋势图上方小字」一致，但背景色统一，
//     方便视觉上把题材与题材分开；
//   - 内容：题材名 / 数量 / 一字 / 竞价高开 / 龙头 / 龙头竞价涨幅 / 龙头十日涨幅；
//   - 龙头 = 组内「近 10 个交易日区间涨幅」最高者（与龙一徽章同源）；
//     组内全无区间涨幅（如次新股/刚进名单的新票）时退化为「竞价涨幅最高者」，
//     此时【十日】段不显示——§10 禁止用 0 或 '-' 伪装成有数据。
//
// 设计红线：
//   1) 纯函数，不读 state、不发请求、不碰 DOM（Logic 层 §4）；
//   2) 统计只基于【实际参与渲染的行】传入，与 sortByTopicGroups 的分组口径同源，
//      不另起一套名单，杜绝"统计条数字和下面的行数对不上"；
//   3) 任何一段数据缺失就【不输出该段】，绝不补 0 或 '-'；
//   4) 【显示门槛】与 buildTopicColorMap 口径一致：只有「真正成组」的题材（非其它 + 至少 2 只）
//      才产出统计条——单只股票的题材没有统计意义，出条只会让列表变乱（2026-09-10 修订）。

/** 成组门槛：与 buildTopicColorMap(minCount=2) 同源——不足 2 只不成一个题材块 */
export const TOPIC_STATS_MIN_GROUP = 2;

/**
 * 按题材分组统计。
 * @param {Array<{topic:string, name:string, isYiZi?:boolean, aucPct?:number|null, rangePct?:number|null}>} entries
 *        必须按【最终渲染顺序】传入（组内顺序无所谓，但组必须连续——与渲染一致才能保证 count 正确）
 * @param {{minGroupSize?:number, includeOther?:boolean}} [opts]
 *        minGroupSize 默认 2：不足该数量的题材组直接不产出（调用方拿到 undefined → 不渲染统计条）；
 *        includeOther 默认 false：「其它」不是真题材，与配色口径一致，不统计。
 * @returns {Map<string, {topic:string, count:number, yiziCount:number, highOpenCount:number,
 *                        leader:string, leaderAucPct:number|null, leaderRangePct:number|null}>}
 */
export function buildTopicStatsMap(entries, opts) {
  const out = new Map();
  if (!entries || entries.length === 0) return out;
  const minSize = (opts && opts.minGroupSize) || TOPIC_STATS_MIN_GROUP;
  const includeOther = !!(opts && opts.includeOther);

  const groups = new Map();
  entries.forEach(function(e) {
    if (!e || !e.name) return;
    const topic = (e.topic || '').trim() || '其它';
    if (!includeOther && topic === '其它') return;
    if (!groups.has(topic)) groups.set(topic, []);
    groups.get(topic).push(e);
  });

  groups.forEach(function(arr, topic) {
    // 单只股票的题材（或未达门槛）不产出统计条 → 调用方 get 到 undefined → 不渲染
    if (arr.length < minSize) return;
    let yizi = 0;
    let highOpen = 0;
    let leader = '';
    let leaderAucPct = null;
    let leaderRangePct = null;
    let leaderAucBest = null; // 区间涨幅全缺时的回退龙头

    arr.forEach(function(e) {
      if (e.isYiZi) yizi++;
      const auc = _num(e.aucPct);
      if (auc !== null && auc >= 0) highOpen++;

      const rp = _num(e.rangePct);
      if (rp !== null) {
        // 主口径：区间涨幅最高者为龙头
        if (leaderRangePct === null || rp > leaderRangePct) {
          leaderRangePct = rp;
          leader = e.name;
          leaderAucPct = auc;
        }
      } else if (auc !== null && (leaderAucBest === null || auc > leaderAucBest)) {
        leaderAucBest = auc;
      }
    });

    if (leader === '' && leaderAucBest !== null) {
      // 组内无任何区间涨幅数据（新票/次新股）：退化为竞价涨幅最高者，十日段留空
      arr.forEach(function(e) {
        if (leader !== '') return;
        if (_num(e.aucPct) === leaderAucBest) { leader = e.name; leaderAucPct = leaderAucBest; }
      });
    }

    out.set(topic, {
      topic: topic,
      count: arr.length,
      yiziCount: yizi,
      highOpenCount: highOpen,
      leader: leader,
      leaderAucPct: leaderAucPct,
      leaderRangePct: leaderRangePct
    });
  });
  return out;
}

/**
 * 统计条 → UI 布局（§21：格式化在 Logic 层做完，模板只负责 v-for 渲染）。
 *
 * 排版契约（2026-09-10）：整条【隐形】分左右两格，中间无分隔线：
 *   左格（窄）：题材名，字号更大更显眼；
 *   右格（宽）：上下两行
 *       第一行 —— 数量 / 一字 / 竞价高开
 *       第二行 —— 龙头 / 竞价 / 十日
 *
 * 缺失的段直接不产出（§10）；第二行整段没有内容时返回空数组，由组件自行塌陷为单行。
 * @param {object|null} stats
 * @returns {{topic:string, row1:Array<{key:string,label:string,value:string,tone?:string}>,
 *            row2:Array<{key:string,label:string,value:string,tone?:string}>}|null}
 *          tone: 'up' | 'down' | '' —— 用于涨红跌绿（A 股口径）
 */
export function formatTopicStatsLayout(stats) {
  if (!stats) return null;
  const row1 = [];
  const row2 = [];
  row1.push({ key: 'count', label: '数量', value: String(stats.count || 0) });
  row1.push({ key: 'yizi', label: '一字', value: String(stats.yiziCount || 0) });
  row1.push({ key: 'high', label: '竞价高开', value: String(stats.highOpenCount || 0) });
  if (stats.leader) {
    row2.push({ key: 'leader', label: '龙头', value: stats.leader });
    const lp = _num(stats.leaderAucPct);
    if (lp !== null) row2.push({ key: 'lpct', label: '竞价', value: _fmtPct(lp), tone: _tone(lp) });
    const lr = _num(stats.leaderRangePct);
    if (lr !== null) row2.push({ key: 'lrng', label: '十日', value: _fmtPct(lr), tone: _tone(lr) });
  }
  return { topic: stats.topic || '其它', row1: row1, row2: row2 };
}

/** 增量渲染指纹令牌：统计条内容变化时必须让「该组第一行」重派生 */
export function topicStatsSignature(stats) {
  if (!stats) return '';
  return [stats.topic, stats.count, stats.yiziCount, stats.highOpenCount,
    stats.leader, _num(stats.leaderAucPct), _num(stats.leaderRangePct)].join(',');
}

function _num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

function _tone(n) {
  return n > 0 ? 'up' : (n < 0 ? 'down' : '');
}

function _fmtPct(n) {
  return (n >= 0 ? '+' : '') + Number(n).toFixed(2) + '%';
}
