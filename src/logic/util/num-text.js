// num-text.js — 数据库「文本型数字」的统一解析（§6 单一实现）
//
// 【为什么需要它 · 2026-11-13 线上实证】
//   `market_metrics.auc_pct_chg` / `change_pct` 存的是**带百分号的字符串**：
//     '+2.30%' / '-0.84%' / '+10.02%'
//   而 `Number('+2.30%') === NaN`。原来各处直接 `Number(v)` 后再 `isFinite` 判否 ⇒ 静默变 null。
//   后果（第二十五条）：
//     D1「竞价低开（aucPct < 0）」和 D2「高开低走收绿（aucPct > 0 且 closePct < 0）」
//     两类判据**永远不会触发**，只剩 D3「占比塌陷」在工作 —— 而且**完全不报错**。
//   实测现场：`point=divergedays` 写入 tvrb_leader_diverge 的 11-13 那行，
//     逐日留痕 20 天的 `aucPct` 全是 null（同期库里 `auc_pct_chg` 明明有 '+2.30%'），
//     于是「11-04 高开 +4.68% 却收 −4.09%」这种最典型的 D2 分歧被判成了「不是分歧」。
//
// ⚠️ 单测为什么没抓到：夹具里全是数字（`R('2026-11-04', 4.68, -4.09, 14.93, false)`），
//    而真实数据是字符串。⇒ 凡「来自 DB 文本列」的数值，夹具必须用**真实形态**，
//    本文件配套的 num-text.test.js 与 leader-diverge.test.js 的 [NUM-TEXT] 用例就是补这一课。
//
// 规则（宁缺勿错，§10）：
//   · null / undefined ⇒ null（缺数据不是 0）
//   · 数字 ⇒ 原样（非有限数 ⇒ null）
//   · 字符串 ⇒ 去掉 `%`、千分位 `,`/`，`、全/半角空白、全/半角 `+` 后再 parse
//   · 解析不出来（'-'、'—'、'N/A'、''）⇒ null
//   · ⛔ 绝不返回 0 冒充「没有」

/**
 * @param {*} v 原始值（DB 里的 text / numeric / null）
 * @returns {number|null} 有限数；否则 null
 */
export function numOfText(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const s = String(v)
    .replace(/[%％]/g, '')
    .replace(/[,，]/g, '')
    .replace(/[\s\u3000]/g, '')
    .replace(/^[+＋]/, '');
  if (s === '') return null;
  const n = Number(s);
  return isFinite(n) ? n : null;
}
