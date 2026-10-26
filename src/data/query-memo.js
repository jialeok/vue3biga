// query-memo.js — 云端读取的「单飞 + 极短缓存」统一实现（Data 层公共设施，§32 / §6）
//
// 🔴 【为什么需要这个文件，而不是每个 data/*.js 各写一份】
//   §6 单一真相 + §2 三层收口：同一件事（把「并发的同一次查询合并、把几十毫秒内的重复读取吃掉」）
//   在多个文件里各写一遍 = 口径会漂移（TTL 不同、失败是否缓存不同、作废时机不同），
//   而且下次有人修 bug 只会修自己看到的那一份。⇒ 唯一实现放这里，各表只声明「用哪个 TTL」。
//
// 🔴 【为什么是「单飞 + 短 TTL」，而不是长缓存】
//   · 这些表全是行情 / 业务数据，Realtime 会推变更、别的设备也会写。
//     长 TTL 会让用户看到旧值（"我改了怎么没变"）—— 那比慢几毫秒严重得多。
//   · 真正的浪费不是「反复读同一份最新值」，而是：
//       ① 同一渲染周期内 N 个组件各自 mount，几乎同时发起【完全相同】的查询；
//       ② 相隔几十~几百毫秒的串行重复（不同看板 mount 时间差）。
//     ⇒ ①用 _inflight（零延迟收益最大），②用短 TTL 窗口。两者都不是"缓存业务数据"，
//        只是"合并同一瞬间的同一请求"。
//
// 🔴 【红线】
//   · 读取失败【绝不】写入缓存（§10：失败不能变成"之后一直返回空"）。
//   · 任何写路径必须调 memo.bust()，否则紧接着的读取会拿到旧值（那就是"保存了但显示没变"）。
//   · 返回值可能是共享引用 —— 调用方【只读】，⛔ 不得原地修改（要改就 copy 一份）。
//
// 用法：
//   import { createQueryMemo } from './query-memo.js';
//   const _memo = createQueryMemo({ name: 'market_metrics', ttlMs: 1500 });
//   export function readX(date) {
//     return _memo.run(date, function() { /* 真正的查询（返回 Promise） */ });
//   }
//   // 写完之后：
//   _memo.bust(date);

/**
 * 创建一个「按 key 单飞 + 短 TTL」的读取合并器。
 *
 * @param {{name:string, ttlMs?:number}} opts
 *   name  — 仅用于诊断日志（表名 / 语义名），不含任何敏感信息
 *   ttlMs — 成功结果的复用时窗（毫秒）。默认 1200ms：
 *           「同一屏内多个组件先后 mount」通常在这个量级内完成。
 *           行情类建议 1000~2000；字典/题库类（极少变）可以到 30000。
 * @returns {{run:function(string, function():Promise):Promise, bust:function(string), reset:function():void, stats:function():object}}
 */
export function createQueryMemo(opts) {
    const cfg = opts || {};
    const NAME = cfg.name || 'query';
    const TTL = (Number(cfg.ttlMs) > 0) ? Number(cfg.ttlMs) : 1200;

    /** key → Promise（正在飞行中的合并点） */
    const inflight = new Map();
    /** key → {at:number, value:*}（成功结果，仅 TTL 内有效） */
    const cache = new Map();
    /** 仅供诊断：命中 / 合并 / 实发 计数 */
    const stat = { hit: 0, merged: 0, issued: 0 };

    function run(key, producer) {
        const k = String(key);
        const now = Date.now();

        const hit = cache.get(k);
        if (hit && (now - hit.at) < TTL) {
            stat.hit++;
            return Promise.resolve(hit.value);
        }

        const fly = inflight.get(k);
        if (fly) {
            stat.merged++;
            return fly;
        }

        stat.issued++;
        let p;
        try {
            p = Promise.resolve(producer());
        } catch (e) {
            // 同步抛错也必须原样传出去（§10：不能吞掉变成空数据）
            p = Promise.reject(e);
        }
        const tracked = p.then(function(value) {
            // ⚠️ 只有成功才写缓存。失败路径直接落到下面 catch，缓存保持原样（不会污染成 null/空）。
            cache.set(k, { at: Date.now(), value: value });
            return value;
        }).finally(function() {
            inflight.delete(k);
        });

        inflight.set(k, tracked);
        return tracked;
    }

    function bust(key) {
        cache.delete(String(key));
    }

    function reset() {
        inflight.clear();
        cache.clear();
        stat.hit = 0; stat.merged = 0; stat.issued = 0;
    }

    function stats() {
        return { name: NAME, ttlMs: TTL, inflight: inflight.size, cached: cache.size,
                 hit: stat.hit, merged: stat.merged, issued: stat.issued };
    }

    return { run: run, bust: bust, reset: reset, stats: stats };
}
