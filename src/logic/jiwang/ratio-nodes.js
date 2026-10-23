// ratio-nodes.js — 「昨收盘结果(跌:涨)」→「昨日跌涨」简化比 +「昨日情绪」节点判定
//
// ══════════════════════════════════════════════════════════════════════════════════════
// 需求口径（用户 2026-10-23 原话）：
//   「昨收盘结果那里是跌家数和涨家数比（原数值），我想实现的是，把昨日跌涨和这个联系上，
//     自动填入显示。比如昨收盘结果是 4999：535 这个比值是 9.3，四舍五入取整，是 9，
//     那么昨日跌涨自动填上 9：1，也就是说昨日跌涨简化。」
//   「如果是昨收盘结果 3364：1918，实际值是 1.76，那就是 3：2，因为我这边主流分为
//     1：2，2：1，2：3，3：2，1：4，4：1 等比较主流的，你看靠近哪个最多，就用哪个，
//     1.76 更接近 3：2，所以用它，超过 4：1，就可以四舍五入，低于 1：4 也可以四舍五入，
//     因为 1：4 和 4：1 是节点，在昨日情绪那里自动选节点，低于 1：4 也是节点，
//     比如 1：5，1：6 等，高于 4：1 也是，比如 7：1，8：1 等」
//
// 三段式规则（全部是对 跌/涨 这一个比值做运算）：
//   ① 比值 ≥ 4  → 四舍五入成 N:1（4:1 本身是节点，往外延伸到 7:1 / 8:1 / 9:1 …）
//   ② 比值 ≤ 1/4 → 四舍五入成 1:N（1:4 本身是节点，往外延伸到 1:5 / 1:6 …）
//   ③ 1/4 < 比值 < 4 → 就近吸附到标准节点表；**平局取较小的一方**
//
// ⚠️ 为什么第 ③ 段必须先四舍五入到 2 位再比：
//   3364/1918 = 1.7539（用户口算成 1.76）。直接拿 1.7539 比，距 2.0 只差 0.246、
//   距 1.5 差 0.254 ⇒ 会被判成 2:1，与用户口径（3:2）相反。
//   取 2 位小数后 = 1.75，距 1.5 与距 2.0 都是 0.25 ⇒ 平局，按「取较小」落到 3:2。
//   这正是用户手算的方式，所以本模块以 round(2) 为准，不是随手凑数。
//
// ⛔ 本模块是纯函数：不读 Supabase、不碰 Vue、不写任何缓存（§3/§4/§6）。
// ══════════════════════════════════════════════════════════════════════════════════════

/**
 * 标准节点表（跌:涨），按比值升序 —— **顺序即平局裁决**：先到先得 = 取较小的一方。
 * 与 views/JiwangBoard.vue 的「昨日跌涨」下拉选项同源，⛔ 不要在 UI 里再抄一份。
 */
export const SHOUGU_RATIO_NODES = [
  { label: '1:4', value: 0.25 },
  { label: '1:3', value: 1 / 3 },
  { label: '1:2', value: 0.5 },
  { label: '2:3', value: 2 / 3 },
  { label: '1:1', value: 1 },
  { label: '3:2', value: 1.5 },
  { label: '2:1', value: 2 },
  { label: '3:1', value: 3 },
  { label: '4:1', value: 4 }
];

/** 标准节点的 label 列表（下拉默认项 / 判定「是不是标准节点」） */
export const SHOUGU_RATIO_LABELS = SHOUGU_RATIO_NODES.map(function (n) { return n.label; });

/** 低于此值 = 「1:4 以下」，走 1:N 延伸；高于此值走 N:1 延伸 */
export const SHOUGU_RATIO_MIN = 0.25;
export const SHOUGU_RATIO_MAX = 4;

/** 吸附前的取整位数（用户手算口径 = 2 位小数，见头注释） */
const RATIO_ROUND_DIGITS = 2;

/**
 * 解析「昨收盘结果」→ 跌/涨 比值。
 *
 * @param {string|number} input      形如 '4999:535'（跌:涨）；或只传跌家数、把涨家数放第二参
 * @param {string|number} [zhangRaw] 涨家数（可选）
 * @returns {number|null} 比值；解析不出来 ⇒ null（⛔ 不返回 0，§10 不拿 0 冒充）
 */
export function parseShouguRatio(input, zhangRaw) {
  let dieRaw = input;
  let zhangValue = zhangRaw;

  if (zhangValue === undefined) {
    // 中文输入法下用户很容易打出全角「：」，这里统一成半角再切
    const s = String(input == null ? '' : input).trim().replace(/：/g, ':');
    if (!s || s.indexOf(':') < 0) return null;
    const parts = s.split(':');
    if (parts.length !== 2) return null;
    dieRaw = parts[0];
    zhangValue = parts[1];
  }

  const die = Number(String(dieRaw == null ? '' : dieRaw).trim());
  const zhang = Number(String(zhangValue == null ? '' : zhangValue).trim());
  // 涨家数必须 > 0 才能做分母；跌家数允许 0（全红盘 ⇒ 比值 0 ⇒ 1:N 延伸分支）
  if (!Number.isFinite(die) || !Number.isFinite(zhang)) return null;
  if (die < 0 || zhang <= 0) return null;
  return die / zhang;
}

/**
 * 比值 → 「昨日跌涨」简化比 label（如 '9:1' / '3:2' / '1:6'）。
 *
 * @param {number} ratio 跌/涨
 * @returns {string} 简化比；ratio 非法 ⇒ ''（⛔ 不返回 '1:1' 冒充）
 */
export function ratioToDiezhang(ratio) {
  if (!Number.isFinite(ratio) || ratio < 0) return '';

  const factor = Math.pow(10, RATIO_ROUND_DIGITS);
  const r = Math.round(ratio * factor) / factor;

  // ① 高于 4:1（含）⇒ N:1 延伸，N 四舍五入且至少为 4
  if (r >= SHOUGU_RATIO_MAX) {
    const n = Math.round(r);
    return (n > SHOUGU_RATIO_MAX ? n : SHOUGU_RATIO_MAX) + ':1';
  }

  // ② 低于 1:4（含）⇒ 1:N 延伸，N 四舍五入且至少为 4
  if (r <= SHOUGU_RATIO_MIN) {
    // 跌家数为 0（全红盘）时 1/r 发散，没有对应的 1:N 节点 ⇒ 如实返回 ''
    if (r === 0) return '';
    const n = Math.round(1 / r);
    return '1:' + (n > SHOUGU_RATIO_MAX ? n : SHOUGU_RATIO_MAX);
  }

  // ③ 区间内 ⇒ 就近吸附；`<` 严格小于 ⇒ 平局保留升序里先到的（较小的一方）
  let bestLabel = '';
  let bestDiff = Infinity;
  for (let i = 0; i < SHOUGU_RATIO_NODES.length; i++) {
    const node = SHOUGU_RATIO_NODES[i];
    const diff = Math.abs(r - node.value);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestLabel = node.label;
    }
  }
  return bestLabel;
}

/**
 * 比值 → 「昨日情绪」节点判定。
 *
 * 🔴 判据来自历史真值反推（2026-10-23 查 jiwang_data 全表核对）：
 *   10-13 4325:1167 → 填 4:1  → 节点
 *   10-15 4496:979  → 填 5:1  → 节点
 *   10-16 5108:430  → 填 10:1 → 节点
 *   10-09 3748:1698 → 填 2:1  → 非节点
 *   10-20 3129:2275 → 填 3:2  → 非节点
 *   10-22 3364:1981 → 填 3:2  → 非节点
 *   10-12 2145:3297 → 填 2:3  → 非节点
 *   10-08 2567:2824 → 填 1:1  → 非节点
 * ⇒ **「节点」= 情绪到了极端（简化后 ≥ 4:1 或 ≤ 1:4），「非节点」= 中间档位。**
 *   与用户原话「1:4 和 4:1 是节点……低于 1:4 也是节点（1:5、1:6），高于 4:1 也是（7:1、8:1）」完全自洽。
 *
 * ⚠️ 必须拿【简化后的 label】判，不能拿原始比值判：
 *   10-13 原始 3.706 还没到 4，但它简化后是 4:1 ⇒ 用户填的就是「节点」。
 *
 * @param {number} ratio 跌/涨
 * @returns {'节点'|'非节点'|''} ratio 非法 ⇒ ''（⛔ 不猜）
 */
export function ratioToQingxu(ratio) {
  const label = ratioToDiezhang(ratio);
  if (!label) return '';
  const parts = label.split(':');
  const a = Number(parts[0]);
  const b = Number(parts[1]);
  if (!(a > 0) || !(b > 0)) return '';
  const v = a / b;
  return (v >= SHOUGU_RATIO_MAX || v <= SHOUGU_RATIO_MIN) ? '节点' : '非节点';
}

/**
 * 一键：从「昨收盘结果」字符串同时算出跌涨简化比与情绪节点。
 * UI 只调这一个函数，避免两处各解析一遍（§6 同一实现）。
 *
 * @param {string|number} input 形如 '4999:535'
 * @returns {{ratio:number, diezhang:string, qingxu:string}|null}
 */
export function deriveFromShougu(input) {
  const ratio = parseShouguRatio(input);
  if (ratio === null) return null;
  const diezhang = ratioToDiezhang(ratio);
  if (!diezhang) return null;
  return { ratio: ratio, diezhang: diezhang, qingxu: ratioToQingxu(ratio) };
}
