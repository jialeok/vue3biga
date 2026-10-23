// trend-patch-merge.js — 趋势图「同花顺补缺值」的合并语义（Logic 层纯函数，§3/§4）
//
// 【为什么单独抽出来 —— 2026-10-23 用户报障】
//   现象：「新华传媒(600825，带『20天』标) 趋势面板，展示日当天五条线全空，
//         昨天就说过，今天还是没有。」
//   库证据：market_metrics 里 600825 在 10-19 ~ 10-22 每天都有完整行，**唯独 10-23 没有**
//          （它在当天是 range20 补位注入行，不在 worker 9:25 抓取名单里 ⇒ 没有任何人写这一行）。
//   上游证据：同花顺 K 线 + auction/snapshot?stage=final 当天数据完全可用
//          （实测 volume=941.21 万股、yestVolume=16617.78、changePct=+4.05%、aucPctChg=-3.78%、aucVolRatio=2.59）。
//   ⇒ 数据不缺，是【渲染层把它擦掉了】：
//       展开一只票时面板被多条腿异步重画，谁后到谁生效：
//         ① 主腿 hydrate                 → paint(原始 history)      —— 当天 null
//         ② 补缺腿 ensureTrendPatch       → paint(合并后的 history) —— 当天有数 ✅
//         ③ 封单量腿 ensureLimitPoolDays  → paint(原始 history)      —— ⛔ 把 ② 整片擦回 null
//       ③ 与 ② 谁先完成纯看网络 ⇒ 表现为「有时有、有时没有」，而绝大多数时候是 ③ 后到 ⇒ 一直空。
//   修法（本文件的语义）：补缺值不再「一次性塞进某次 paint」，而是落进一份**独立的补缺仓库**
//   （股票名 → 日期 → 值），此后任何一次 paint 都先套一遍仓库 ⇒ 腿的先后顺序不再影响结果。
//   把这三段语义抽成纯函数放 Logic 层，是为了能用测试把「只填 null 位」「今天整天替换」锁死（§22）。
//
// 【三条语义各自的红线】
//   · mergeTrendPatch  —— 只填 null 位：库里已有值的字段一律不覆盖（§6，不用同花顺冒充库内真相）。
//   · putTrendPatch    —— 「今天」整天替换、「历史日」浅合并：
//                         盘中 K 线收盘价一直在动，收盘后要能覆盖成收盘涨幅（用户口径
//                         「收盘后再覆盖涨幅」）；历史日的上游不会变，多补只补缺不覆盖已有。
//   · trendNeedsPatch  —— 四腿任一缺即补：旧口径「量与涨幅【都】缺才算缺」会漏掉
//                         「当天行只有 change_pct、没有 volume/竞价涨幅」的半残行
//                         （2026-09-28 事故同款：worker 只回写了涨幅快照）⇒ 那些行永远不走补缺。
//                         多触发不会覆盖已有值，代价只是可能多一次请求（结果有会话缓存，§32 兜住）。

/** 「有值」的统一判据：null / undefined / 空白串 都算缺（⛔ 0 与 '0' 算有值，不拿 0 冒充缺，§10） */
export function hasTrendValue(v) {
    return v !== null && v !== undefined && String(v).trim() !== '';
}

/**
 * 该日是否需要走同花顺补缺 —— 五条腿【任一】缺即为真。
 *
 * 为什么把 aucVolRatio 也算进来：量比那张图单独成线，缺一天就是断点，
 * 而它和 aucPctChg 同源于同一次快照请求（零额外额度），顺带补上没有代价。
 *
 * @param {{volume:*, yestVolume:*, changePct:*, aucPctChg:*, aucVolRatio:*}} h 趋势 history 的一行
 * @returns {boolean}
 */
export function trendNeedsPatch(h) {
    if (!h) return false;
    return !hasTrendValue(h.volume) ||
        !hasTrendValue(h.changePct) ||
        !hasTrendValue(h.yestVolume) ||
        !hasTrendValue(h.aucPctChg);
}

/**
 * 【纯函数】把补缺仓库里某只票的值合并进 history —— **只填 null 位**。
 *
 * 返回新数组、不改入参（便于任意次重画反复调用）。
 * 库里已有值的字段一律保留原值（§6：同花顺补缺值只是展示层兜底，不是库内真相）。
 *
 * @param {Array<{date:string}>} history 趋势 history（正序，元素含 date）
 * @param {Object|null|undefined} byDate 该票的补缺仓库：{ 'YYYY-MM-DD' -> {volume,...} }
 * @returns {Array} 合并后的新数组；无补缺值时原样返回入参（零拷贝快路径）
 */
export function mergeTrendPatch(history, byDate) {
    if (!Array.isArray(history) || !byDate) return history;
    const keys = Object.keys(byDate);
    if (keys.length === 0) return history;
    return history.map(function(h) {
        if (!h) return h;
        const p = byDate[h.date];
        if (!p) return h;
        const out = Object.assign({}, h);
        const FIELDS = ['volume', 'yestVolume', 'changePct', 'aucPctChg', 'aucVolRatio'];
        for (let i = 0; i < FIELDS.length; i++) {
            const k = FIELDS[i];
            if (hasTrendValue(out[k])) continue;             // 库内有值 ⇒ 不覆盖
            if (p[k] !== null && p[k] !== undefined) out[k] = p[k];
        }
        return out;
    });
}

/**
 * 【纯函数】写入补缺仓库（不可变更新）。
 *
 * · 「今天」（todayYmd）→ **整天替换**：盘中 K 线收盘价一直在动，必须允许后到的收盘涨幅覆盖掉
 *   先前补的盘中涨幅（用户口径「收盘后再覆盖涨幅」）。
 * · 历史日 → **浅合并**：上游不会变，多次补缺只补齐缺的字段，不抹掉已补到的。
 *
 * @param {Object|null|undefined} cur 该票当前仓库 { 'YYYY-MM-DD' -> {...} }
 * @param {Map<string, object>|Object} incoming 本次补到的值（Map 或普通对象：日期 -> 值）
 * @param {string} todayYmd 北京「今天」'YYYY-MM-DD'
 * @returns {Object} 新的仓库对象（不改入参）
 */
export function putTrendPatch(cur, incoming, todayYmd) {
    const next = Object.assign({}, cur || {});
    if (!incoming) return next;
    const pairs = [];
    if (typeof incoming.forEach === 'function' && typeof incoming.get === 'function') {
        incoming.forEach(function(v, d) { pairs.push([d, v]); });
    } else {
        Object.keys(incoming).forEach(function(d) { pairs.push([d, incoming[d]]); });
    }
    pairs.forEach(function(pair) {
        const d = pair[0];
        const v = pair[1];
        if (!d || !v) return;
        if (d === todayYmd) {
            // 今天：整天替换（盘中值已过时，⛔ 不与收盘值混用）
            next[d] = Object.assign({}, v);
            return;
        }
        // 历史日：浅合并，且**只并入非空字段**。
        // 🔴 不能直接 Object.assign —— 补缺结果里「本次没补到的腿」是显式的 null，
        //   直接合并会把上一次已经补到的值抹成 null（本函数初版就踩了这个，
        //   由 trend-patch-merge.test.js「历史日：浅合并」用例抓住）。
        const merged = Object.assign({}, next[d] || {});
        Object.keys(v).forEach(function(k) {
            if (v[k] !== null && v[k] !== undefined) merged[k] = v[k];
        });
        next[d] = merged;
    });
    return next;
}

/**
 * 北京「今天」'YYYY-MM-DD'（补缺仓库判「今天」用；与 trend-patch.js 的 _beijingTodayYmd 同口径）。
 * @returns {string}
 */
export function beijingTodayYmd(nowMs) {
    const ms = (nowMs === undefined || nowMs === null) ? Date.now() : nowMs;
    return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
