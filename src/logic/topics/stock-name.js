// stock-name.js — 股票名归一化（纯函数叶子，§15 独立业务模块）
//
// 存在的唯一理由（真实事故，2026-09-18）：
//   共享题材库 stock_topics 的键是**用户/上游最后写入时的原始名字**，
//   而各个看板的当日名单来自另一条链路（同花顺 / 猫抓 / 涨停池）。两条链路的
//   「同一只股票」可能长得不一样 —— 实测同一份 09-18 涨停池 77 只里，有 3 只
//   明明在库里有题材却被判成「无题材」：
//     名单里      库里
//     七 匹 狼  ↔  七匹狼          （名称中间被插了空格）
//     万  科Ａ  ↔  万科A           （空格 + 全角字母）
//     远 望 谷  ↔  远望谷          （名称中间被插了空格）
//   ⇒ 题材匹配失败 ⇒ 看板显示「无题材」⇒ 用户以为库里没有 ⇒ 手动重复导入。
//
// 归一化口径（三条，顺序不重要，都是幂等）：
//   ① 去掉**所有**空白（含首尾、中间、全角空格 U+3000、不换行空格 U+00A0）
//   ② 全角字母/数字 → 半角（Ａ→A、１→1）；全角括号 `（）` → 半角
//   ③ 统一大写（`万科a` 与 `万科A` 视为同一只）
//
// ⛔ 不要在这里做「模糊匹配 / 拼音 / 编辑距离」—— 股票名很短，误配的代价是
//    「A 股票的题材挂到 B 股票身上」，比漏配严重得多。只做确定性归一。
// ⛔ 本模块是纯函数：不读 state、不发请求、不碰 DOM、不写库。

/** 需要剔除的空白字符：半角空格 / 全角空格 / 制表 / 不换行空格 / 各类 Unicode 空白 */
const WHITESPACE_RE = /[\s\u3000\u00a0\u2000-\u200b\ufeff]+/g;

/** 全角 → 半角的码位偏移量（ASCII 可见字符区 0xFF01~0xFF5E 与 0x21~0x7E 一一对应） */
const FULLWIDTH_OFFSET = 0xfee0;

/**
 * 股票名归一化（确定性、幂等）。
 *
 * @param {*} raw 原始名称（任意类型，非字符串会先 String() 再处理）
 * @returns {string} 归一化后的名字；入参为空时返回 `''`
 */
export function normalizeStockName(raw) {
    if (raw === null || raw === undefined) return '';
    let s = String(raw).replace(WHITESPACE_RE, '');
    if (!s) return '';
    // 全角字母/数字/符号 → 半角
    if (/[\uff01-\uff5e]/.test(s)) {
        s = s.replace(/[\uff01-\uff5e]/g, function(c) {
            return String.fromCharCode(c.charCodeAt(0) - FULLWIDTH_OFFSET);
        });
    }
    // 全角空格已在上一步被剔除；全角括号 `（）` 落在 0xFF08/0xFF09（在 0xFF01~0xFF5E 内）已被转成 `()`。
    return s.toUpperCase();
}

/**
 * 两个名字是否指向同一只股票（归一化后比较）。
 *
 * ⚠️ 只用于「同一只票的名字变体」判定，**不要**用它去查库（查库请用 normalizeStockName 建索引）。
 *
 * @param {*} a
 * @param {*} b
 * @returns {boolean}
 */
export function isSameStockName(a, b) {
    const na = normalizeStockName(a);
    if (!na) return false;
    return na === normalizeStockName(b);
}
