// code-helpers.js — stocks 域「纯函数」叶子模块（零 import）
//
// [§16 / §5 2026-09-14 新增] 从 stocks.js 抽出 extractCodeFromFuyaoItem。
//
// 原因（不是重构洁癖，是修一个真实 ReferenceError）：
// auction-ths.js 的两处同花顺成分股处理直接调用了 extractCodeFromFuyaoItem()，
// 但该函数定义在 stocks.js 里且 auction-ths.js 从未 import 它 —— 一旦走到该分支
// （fetchLadderConstituentsMain），即抛 `ReferenceError: extractCodeFromFuyaoItem is not defined`。
//
// 为什么不让 auction-ths.js 直接 import stocks.js：依赖图实测 stocks.js 可以到达 auction-ths.js
// （stocks.js → ../auction/sort-rules.js / stock-sync.js → … → auction.js → auction-ths.js），
// 反向 import 会形成**环形依赖**，Rollup 会拆成互相依赖的 chunk（本项目已经因同类原因出现过
// "circular dependency between chunks … broken execution order" 警告）。
// 因此把这个纯函数下沉到零依赖叶子模块：定义处（stocks.js）保持 barrel 再导出，
// 外部 import 路径零破坏；消费方（auction-ths.js）直接 import 叶子，依赖方向恒为「域 → 叶子」。

/**
 * 从同花顺/fuyao 接口返回的单只证券对象里提取 6 位股票代码。
 * 纯函数，无任何副作用与外部依赖。
 * @param {{ticker?:string, thscode?:string}|null|undefined} item
 * @returns {string} 6 位代码；提取不到时返回空串（不抛错）
 */
export function extractCodeFromFuyaoItem(item) {
    if (!item) return '';
    if (item.ticker) return String(item.ticker).trim();
    if (item.thscode) {
        const code = String(item.thscode).trim().replace(/\..*$/, '');
        if (/^\d{6}$/.test(code)) return code;
    }
    return '';
}
