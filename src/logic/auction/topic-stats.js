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
//   3) 任何一段数据缺失就【不输出该段】，绝不补 0 或 '-'。

/**
 * 按题材分组统计。
 * @param {Array<{topic:string, name:string, isYiZi?:boolean, aucPct?:number|null, rangePct?:number|null}>} entries
 *        必须按【最终渲染顺序】传入（组内顺序无所谓，但组必须连续——与渲染一致才能保证 count 正确）
 * @param {{includeOther?:boolean}} [opts] includeOther=false 时丢弃「其它」组（默认保留）
 * @returns {Map<string, {topic:string, count:number, yiziCount:number, highOpenCount:number,
 *                        leader:string, leaderAucPct:number|null, leaderRangePct:number|null}>}
 */
export function buildTopicStatsMap(entries, opts) {
  const out = new Map();
  if (!entries || entries.length === 0) return out;
  const includeOther = !opts || opts.includeOther !== false;

  const groups = new Map();
  entries.forEach(function(e) {
    if (!e || !e.name) return;
    const topic = (e.topic || '').trim() || '其它';
    if (!includeOther && topic === '其它') return;
    if (!groups.has(topic)) groups.set(topic, []);
    groups.get(topic).push(e);
  });

  groups.forEach(function(arr, topic) {
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
 * 统计条 → UI 片段（§21：格式化在 Logic 层做完，模板只负责 v-for 渲染）。
 * 缺失的段直接不产出（§10）。
 * @param {object|null} stats
 * @returns {Array<{key:string, label:string, value:string, tone?:string}>}
 *          tone: 'up' | 'down' | '' —— 用于涨红跌绿（A 股口径）
 */
export function formatTopicStatsSegments(stats) {
  if (!stats) return [];
  const seg = [];
  seg.push({ key: 'topic', label: '', value: stats.topic || '其它' });
  seg.push({ key: 'count', label: '数量', value: String(stats.count || 0) });
  seg.push({ key: 'yizi', label: '一字', value: String(stats.yiziCount || 0) });
  seg.push({ key: 'high', label: '竞价高开', value: String(stats.highOpenCount || 0) });
  if (stats.leader) {
    seg.push({ key: 'leader', label: '龙头', value: stats.leader });
    if (stats.leaderAucPct !== null && stats.leaderAucPct !== undefined && !isNaN(stats.leaderAucPct)) {
      seg.push({ key: 'lpct', label: '竞价', value: _fmtPct(stats.leaderAucPct), tone: stats.leaderAucPct > 0 ? 'up' : (stats.leaderAucPct < 0 ? 'down' : '') });
    }
    if (stats.leaderRangePct !== null && stats.leaderRangePct !== undefined && !isNaN(stats.leaderRangePct)) {
      seg.push({ key: 'lrng', label: '十日', value: _fmtPct(stats.leaderRangePct), tone: stats.leaderRangePct > 0 ? 'up' : (stats.leaderRangePct < 0 ? 'down' : '') });
    }
  }
  return seg;
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

function _fmtPct(n) {
  return (n >= 0 ? '+' : '') + Number(n).toFixed(2) + '%';
}
