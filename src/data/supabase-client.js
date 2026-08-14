import { _setGetSupabaseFn } from './auction-data.js';
import { _setGetStocksDataFn } from './session-and-shield.js';
﻿import { createClient } from '@supabase/supabase-js';
import { useAuctionStore } from '../stores/auctionStore.js';
import { state } from '../logic/app-state.js';
        import { _dbgLog } from './debug-log.js';
        import { normalizeAuctionNotes } from './auction-data.js';
        import { syncStocksDataToStore } from './session-and-shield.js';

        state.allData = null; // §6：置空仅为触发下方内存缓存重建入口；allData 是 CACHE（非真相源），请勿当 DB 读。
        // bidding（竞价变化）内存缓存：与 allData 的 null-reset 周期解耦。
        // allData 在很多地方会被设为 null 强制"从 localStorage 重新加载"，
        // 但 bidding 已不落 localStorage，若跟着一起清空会在切换页面可见性等
        // 场景下短暂闪烁清空。这个变量始终持有同一份引用，只由云端
        // pullBiddingFromTable/pullBiddingForDate 或本地编辑保存来更新。
        state._biddingMemCache = null;
        // 记录当前正在推送到 bidding_data 表的日期，防止推送过程中被 Realtime/启动拉取覆盖。
        state._biddingPushInFlight = new Set();
        // 记录有本地待推送编辑的 bidding 日期（保存开始时加入，推送结束时移除）。
        state._biddingDirtyDates = new Set();
        state._topicCache = null;
        state._topicCacheBuilt = false;
        // 记录用户手动展开的股票（按股票名），用于 renderAuction 重新渲染后恢复展开状态。
        // 按分组（auction / hot）各自独立存储：此前两个tab共用同一个Set，会导致在一个tab
        // 点开的股票，若在另一个tab恰好同名，切换tab时被莫名展开；且共用同一个"最多记忆8个"
        // 上限时，在一个tab点得多了还会把另一个tab里已展开的悄悄挤掉——这正是"热门股票tab
        // 交互感觉不一样/展开状态莫名其妙"的原因。
        state._expandedAuctionStocksByGroup = { auction: new Set(), hot: new Set() };
        // 按分组取对应的展开状态 Set；传入 'hot' 得到热门股票分组的，其余（包括 'auction' 或
        // currentGroup 变量）都得到早盘竞价分组的。
        function _getAuctionStore() { try { return useAuctionStore(); } catch { return null; } }
export function _getExpandedStocksSet(dataSource) {
            const key = dataSource === 'hot' ? 'hot' : 'auction';
            return state._expandedAuctionStocksByGroup[key];
        }

        // 将 _expandedAuctionStocksByGroup 同步到 Vue store，保持响应式路径与 DOM 路径一致。
        // 用内容级 diff 同步（而非整体换引用），相同内容不触发响应式，避免递归循环。
        export function _syncExpandedStocksToStore(dataSource) {
            if (typeof _getAuctionStore() === 'undefined' || !_getAuctionStore()) return;
            try {
                const key = dataSource === 'hot' ? 'hot' : 'auction';
                const sourceSet = state._expandedAuctionStocksByGroup[key];
                const storeSet = _getAuctionStore().expandedStocks;
                if (!(storeSet instanceof Set)) { _getAuctionStore().expandedStocks = new Set(sourceSet); return; }
                storeSet.forEach(function(item) { if (!sourceSet.has(item)) storeSet.delete(item); });
                sourceSet.forEach(function(item) { if (!storeSet.has(item)) storeSet.add(item); });
            } catch (e) {}
        }

        // ============================================================
        // Supabase 云同步配置
        // ============================================================
        export const SUPABASE_URL = 'https://tonqfgeyxnnwicjopshn.supabase.co';
        export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRvbnFmZ2V5eG5ud2ljam9wc2huIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2NjY3NzEsImV4cCI6MjA5NDI0Mjc3MX0.el-W10JIjr9iQXEKNxV7nLNdhZfOQp6waTY7ZSH27Jg';
        export const PASSWORD_HASH = '717eed5d297ecfe2025e282551032a9b0b74cc122f402e709466d24635b55770';
        state.SUPABASE_URL = SUPABASE_URL;
        state.SUPABASE_ANON_KEY = SUPABASE_ANON_KEY;
        // biga8450 的 SHA-256 哈希（用于密码验证，原始密码不存代码里）
        state.PASSWORD_HASH = PASSWORD_HASH;

        state._supabaseClient = null;
        export function getSupabase() {
            if (!state._supabaseClient) {
                state._supabaseClient = createClient(state.SUPABASE_URL, state.SUPABASE_ANON_KEY);
            }
            return state._supabaseClient;
        }
        _setGetSupabaseFn(getSupabase);

        // 防抖推送计时器
        state._pushDebounceTimer = null;

        // ============================================================
        // 密码验证（SHA-256 哈希比对）
        // ============================================================
        // 纯 JS SHA-256 兜底实现（FIPS 180-4）。
        // 背景：crypto.subtle 仅在安全上下文（HTTPS / localhost / file://）可用，
        // 通过 http://局域网IP 访问（手机连电脑本地服务）时 crypto.subtle 为 undefined，
        // 没有此兜底时 sha256() 抛 TypeError，登录按钮"无反应、无提示"。
        function _sha256Rotr(x, n) { return ((x >>> n) | (x << (32 - n))) >>> 0; }
        function _sha256PureJs(bytes) {
            const K = [
                0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
                0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
                0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
                0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
                0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
                0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
                0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
                0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
            ];
            let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
            let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
            const l = bytes.length;
            const bitLen = l * 8;
            const padded = new Uint8Array((((l + 8) >> 6) + 1) << 6);
            padded.set(bytes);
            padded[l] = 0x80;
            const dv = new DataView(padded.buffer);
            dv.setUint32(padded.length - 4, bitLen >>> 0);
            dv.setUint32(padded.length - 8, Math.floor(bitLen / 4294967296));
            const w = new Uint32Array(64);
            for (let i = 0; i < padded.length; i += 64) {
                for (let t = 0; t < 16; t++) w[t] = dv.getUint32(i + t * 4);
                for (let t = 16; t < 64; t++) {
                    const s0 = (_sha256Rotr(w[t - 15], 7) ^ _sha256Rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3)) >>> 0;
                    const s1 = (_sha256Rotr(w[t - 2], 17) ^ _sha256Rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10)) >>> 0;
                    w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
                }
                let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
                for (let t = 0; t < 64; t++) {
                    const S1 = (_sha256Rotr(e, 6) ^ _sha256Rotr(e, 11) ^ _sha256Rotr(e, 25)) >>> 0;
                    const ch = ((e & f) ^ (~e & g)) >>> 0;
                    const t1 = (h + S1 + ch + K[t] + w[t]) >>> 0;
                    const S0 = (_sha256Rotr(a, 2) ^ _sha256Rotr(a, 13) ^ _sha256Rotr(a, 22)) >>> 0;
                    const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
                    const t2 = (S0 + maj) >>> 0;
                    h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
                }
                h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
                h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
            }
            return [h0, h1, h2, h3, h4, h5, h6, h7].map(h => h.toString(16).padStart(8, '0')).join('');
        }
        export async function sha256(str) {
            const data = new TextEncoder().encode(str);
            if (crypto && crypto.subtle) {
                const buf = await crypto.subtle.digest('SHA-256', data);
                return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
            }
            // 非安全上下文（http://局域网IP 等）：走纯 JS 实现
            return _sha256PureJs(data);
        }

// ============================================================
// 共享工具函数 — 供 data/ 和 logic/ 层共用
// ============================================================
export function getNumericVolume(val) {
    if (val === '' || val === null || val === undefined) return null;
    const n = parseFloat(val);
    if (isNaN(n)) return null;
    return n;
}

export function _moduleKey(name) {
    return 'stockApp_' + state.DATA_VERSION + '_' + name;
}

        // ===== loadAllData + getStocksData + getJiwangData + getBiddingData（从 logic/app-core.js 移至 data 层）=====
        const _MODULE_KEYS = ['stocks', 'auction', 'jiwang', 'rank', 'multi', 'hotspot', 'pattern', 'bidding', 'tagTitles', 'holidays', 'tradingDays'];

        // ============================================================
        // §6 allData 收敛红线（ARCHITECTURE §6）
        // allData = in-memory CACHE only, NOT a source of truth.
        // 权威数据在 Supabase 表 + Pinia store。请勿像读数据库那样读 allData。
        // 重建后 state.allData[key] 与各域 _xxxMemCache 是「同一份引用」（见下方分支），
        // 因此读 allData 本质就是读内存缓存别名；业务读写应走各域 Data 层 getter
        // （getStocksData / getJiwangData / getBiddingData / getRankData 等），
        // 不要新增绕过 getter 的 state.allData.xxx 直读。
        // ============================================================
        export function loadAllData() {
            if (state.allData && state._allDataLastRebuildAt && (Date.now() - state._allDataLastRebuildAt < 500)) {
                if (typeof _dbgLog === 'function') {
                    _dbgLog('[RANK-CACHE] window.loadAllData 500ms内短路，避免重复重建 state.allData');
                }
                return state.allData;
            }
            if (!state.allData) {
                if (typeof _dbgLog === 'function') {
                    state._allDataRebuildCount = (state._allDataRebuildCount || 0) + 1;
                    _dbgLog('[RANK-CACHE] window.loadAllData 重建 state.allData（第' + state._allDataRebuildCount + '次）。注：各域 _xxxMemCache 引用不变，rank 经 state._rankMemCache 保持稳定，不受 allData=null 连坐；仅当某日期数组被原地替换时该日期缓存失效）｜来源:' + (new Error().stack || '').split('\n').slice(2, 4).join(' <- '));
                }
                if (!localStorage.getItem(_moduleKey('_migrated'))) {
                    state._migrateFromV41();
                }
                const hasPartitioned = localStorage.getItem(_moduleKey('stocks')) !== null;
                if (hasPartitioned) {
                    state.allData = {};
                    _MODULE_KEYS.forEach(key => {
                        if (key === 'bidding') {
                            if (!state._biddingMemCache) state._biddingMemCache = {};
                            state.allData[key] = state._biddingMemCache;
                            return;
                        }
                        if (key === 'jiwang') {
                            if (!state._jiwangMemCache) state._jiwangMemCache = {};
                            state.allData[key] = state._jiwangMemCache;
                            return;
                        }
                        if (key === 'auction') {
                            state.allData[key] = state._auctionMemCache;
                            return;
                        }
                        if (key === 'stocks' || key === 'rank' || key === 'multi' ||
                            key === 'hotspot' || key === 'pattern' || key === 'tagTitles') {
                            const cache = state['_' + key + 'MemCache'];
                            if (cache) {
                                state.allData[key] = cache;
                                return;
                            }
                        }
                        const raw = localStorage.getItem(_moduleKey(key));
                        if (raw !== null) {
                            try {
                                state.allData[key] = JSON.parse(raw);
                            } catch (e) {
                                state.allData[key] = (key === 'holidays' || key === 'tradingDays') ? [] : {};
                            }
                        } else {
                            state.allData[key] = (key === 'holidays' || key === 'tradingDays') ? [] : {};
                        }
                    });
                    if (!state.allData.notesNormalized) {
                        normalizeAuctionNotes();
                        state.allData.notesNormalized = true;
                    }
                } else {
                    if (!state._biddingMemCache) state._biddingMemCache = {};
                    if (!state._jiwangMemCache) state._jiwangMemCache = {};
                    if (!state._stocksMemCache) state._stocksMemCache = {};
                    if (!state._rankMemCache) state._rankMemCache = {};
                    if (!state._multiMemCache) state._multiMemCache = {};
                    if (!state._hotspotMemCache) state._hotspotMemCache = {};
                    if (!state._patternMemCache) state._patternMemCache = {};
                    if (!state._tagTitlesMemCache) state._tagTitlesMemCache = {};
                    state.allData = { // §6：重建内存缓存；各字段指向对应 _xxxMemCache（同一引用）
                        stocks: state._stocksMemCache, jiwang: state._jiwangMemCache, rank: state._rankMemCache, multi: state._multiMemCache,
                        hotspot: state._hotspotMemCache, pattern: state._patternMemCache, bidding: state._biddingMemCache, tagTitles: state._tagTitlesMemCache,
                        auction: state._auctionMemCache, holidays: [], tradingDays: []
                    };
                }
            }
            syncStocksDataToStore();
            state._allDataLastRebuildAt = Date.now();
            return state.allData;
        }

        export function getStocksData() { return state._stocksMemCache || (loadAllData().stocks || {}); }
        _setGetStocksDataFn(getStocksData);
        export function getJiwangData() { const d = loadAllData(); return d ? d.jiwang : {}; }
        export function getBiddingData() { const d = loadAllData(); return (d && d.bidding) || {}; }
        export function getEtfData() {
            try { return JSON.parse(localStorage.getItem('stockEtfData') || '{}'); }
            catch (e) { return {}; }
        }
        export function getBiddingDirtyDates() { return state._biddingDirtyDates; }
        export function getBiddingPushInFlight() { return state._biddingPushInFlight; }