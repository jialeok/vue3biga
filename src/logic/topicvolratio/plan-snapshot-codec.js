// plan-snapshot-codec.js — 「题材量比」选股结论快照的【唯一】编解码器（Logic 层，纯函数）
//
// ★★ [TVRB-PLAN-SNAPSHOT 2026-11-11] 为什么需要它：
//   `buildTopicVolRatioPlan` 的 out 不是纯 JSON —— 里面有 `buyNames: new Set()`，
//   规则层还会挂 Map / Date / Vue 响应式 Proxy。直接 JSON.stringify 会把 Set 变成 `{}`，
//   读回来就是一份「看起来能渲染、实际少了票」的残缺结论（§10 静默丢数据）。
//   ⇒ 编解码必须收口在一处，且【读回后必须做结构校验】：
//     解码失败 / 结构不符 ⇒ 判「快照损坏」，走恒竞价口径重算 + 可见警示，⛔ 绝不当成空快照。
//
// §6 单一真相：这张快照是【定稿那一刻屏幕上那份 plan】，不是行情数据、不是重算中间态。
// §10：encode/decode 的任何失败都显式返回 {ok:false, reason}，⛔ 不抛含糊异常、不返回 {} 顶替。

const TAG_SET = '__tvrbSet';
const TAG_MAP = '__tvrbMap';
const TAG_DATE = '__tvrbDate';
const MAX_DEPTH = 40;

/**
 * 单份定稿存档的体积上限（字节）。
 * 正常一份 plan 在几十 KB 量级；异常数据（规则层误挂了整份候选池 / 递归装饰）不该撑爆 jsonb
 * 或拖慢手机端读档 ⇒ 超过就【不存档 + 留痕】，而展示本身不受影响（§10 禁止静默）。
 */
export const PLAN_SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;

function _isSet(v) {
  return (v instanceof Set) || Object.prototype.toString.call(v) === '[object Set]';
}
function _isMap(v) {
  return (v instanceof Map) || Object.prototype.toString.call(v) === '[object Map]';
}
function _isDate(v) {
  return (v instanceof Date) || Object.prototype.toString.call(v) === '[object Date]';
}

/**
 * 把 plan 编成【可安全存进 jsonb 的纯对象】。
 *   · Set / Map / Date ⇒ 带标记的对象，decode 时还原；
 *   · 函数 / symbol / undefined ⇒ 丢弃该属性（数组位置补 null，保持下标）；
 *   · NaN / Infinity ⇒ null（⛔ 不让 JSON 把它们悄悄变成 null 还无感）；
 *   · 循环引用 ⇒ 丢这一支（WeakSet 沿路径检测，同一对象出现在两处仍允许重复）；
 *   · 深度 > MAX_DEPTH ⇒ 截断，防异常数据把栈打爆。
 *
 * @param {object} plan
 * @returns {{ok:boolean, plain?:object, reason?:string, bytes?:number}}
 */
export function encodePlanSnapshot(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    return { ok: false, reason: 'plan-not-object' };
  }
  if (!Array.isArray(plan.blocks) || !plan.buy || typeof plan.buy !== 'object') {
    return { ok: false, reason: 'plan-shape-invalid' };
  }
  const onPath = new WeakSet();

  function visit(v, depth) {
    if (depth > MAX_DEPTH) return null;
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (v === undefined || typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint') {
      return undefined;
    }
    if (_isSet(v)) {
      const o = {};
      o[TAG_SET] = Array.from(v).map(function (x) {
        const r = visit(x, depth + 1);
        return r === undefined ? null : r;
      });
      return o;
    }
    if (_isMap(v)) {
      const o = {};
      o[TAG_MAP] = Array.from(v.entries()).map(function (pair) {
        const k = visit(pair[0], depth + 1);
        const val = visit(pair[1], depth + 1);
        return [k === undefined ? null : k, val === undefined ? null : val];
      });
      return o;
    }
    if (_isDate(v)) {
      const o = {};
      o[TAG_DATE] = isFinite(v.getTime()) ? v.toISOString() : '';
      return o;
    }
    if (Array.isArray(v)) {
      return v.map(function (x) {
        const r = visit(x, depth + 1);
        return r === undefined ? null : r;
      });
    }
    if (typeof v === 'object') {
      if (onPath.has(v)) return null;
      onPath.add(v);
      const o = {};
      Object.keys(v).forEach(function (k) {
        const r = visit(v[k], depth + 1);
        if (r !== undefined) o[k] = r;
      });
      onPath.delete(v);
      return o;
    }
    return null;
  }

  try {
    const plain = visit(plan, 0);
    if (!plain || typeof plain !== 'object') return { ok: false, reason: 'encode-empty' };
    // 真正存 jsonb 前再过一次原生序列化：这一步能抓到 replacer 漏掉的怪值（如 BigInt / 循环残留）
    const json = JSON.stringify(plain);
    if (!json || json === '{}') return { ok: false, reason: 'encode-empty' };
    return { ok: true, plain: plain, bytes: json.length };
  } catch (e) {
    return { ok: false, reason: 'encode-throw: ' + ((e && e.message) || String(e)) };
  }
}

/** 结构校验：读回来的对象必须像一份能上屏的 plan（§10 残缺快照不得当结论使用） */
export function isUsablePlanSnapshot(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return false;
  if (!Array.isArray(plan.blocks)) return false;
  if (!plan.buy || typeof plan.buy !== 'object' || Array.isArray(plan.buy)) return false;
  if (!Array.isArray(plan.notes)) return false;
  if (typeof plan.pickCount !== 'number' || !isFinite(plan.pickCount)) return false;
  return true;
}

/**
 * 把库里读回的纯对象还原成 plan（Set / Map / Date 还原）。
 * @param {object|string} raw
 * @returns {{ok:boolean, plan?:object, reason?:string}}
 */
export function decodePlanSnapshot(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch (e) {
      return { ok: false, reason: 'bad-json' };
    }
  }
  if (!obj || typeof obj !== 'object') return { ok: false, reason: 'not-object' };

  // ⚠️ 库里存的是【已编码】的纯对象；只有带标记的结构才还原，其它原样返回。
  function revive(v, depth) {
    if (depth > MAX_DEPTH || v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(function (x) { return revive(x, depth + 1); });
    const keys = Object.keys(v);
    if (keys.length === 1 && Array.isArray(v[TAG_SET])) {
      return new Set(v[TAG_SET].map(function (x) { return revive(x, depth + 1); }));
    }
    if (keys.length === 1 && Array.isArray(v[TAG_MAP])) {
      const m = new Map();
      v[TAG_MAP].forEach(function (pair) {
        if (Array.isArray(pair)) m.set(revive(pair[0], depth + 1), revive(pair[1], depth + 1));
      });
      return m;
    }
    if (keys.length === 1 && typeof v[TAG_DATE] === 'string') {
      const d = new Date(v[TAG_DATE]);
      return isFinite(d.getTime()) ? d : null;
    }
    const o = {};
    keys.forEach(function (k) { o[k] = revive(v[k], depth + 1); });
    return o;
  }

  try {
    const plan = revive(obj, 0);
    if (!isUsablePlanSnapshot(plan)) return { ok: false, reason: 'shape-invalid' };
    return { ok: true, plan: plan };
  } catch (e) {
    return { ok: false, reason: 'decode-throw: ' + ((e && e.message) || String(e)) };
  }
}
