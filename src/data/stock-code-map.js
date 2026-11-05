import { state } from '../logic/app-state.js';
        // ===== stockcodemap 表操作（股票名↔代码映射唯一真相源，取代旧的本地 localStorage.stockCodeMap）=====
        // 内存缓存 _scMapCache 保留（读取性能），但不再落 localStorage；跨设备一致性靠 Realtime 订阅维护。

        import { getSupabase } from './supabase-client.js';
        import { _dbgLog } from './debug-log.js';

        // 全量加载 stockcodemap 到内存缓存，返回 {stockName: code}
        export async function pullStockCodeMapFromCloud() {
            const sb = getSupabase();
            const allRows = [];
            let from = 0;
            const pageSize = 1000;
            while (true) {
                const { data, error } = await sb.from('stockcodemap')
                    .select('stock,code')
                    .range(from, from + pageSize - 1);
                if (error) throw error;
                if (!data || data.length === 0) break;
                allRows.push(...data);
                if (data.length < pageSize) break;
                from += pageSize;
            }
            const result = {};
            allRows.forEach(function(row) {
                if (row && row.stock && row.code) {
                    result[row.stock.trim()] = row.code.trim();
                }
            });
            return result;
        }

        // 从云端加载 stockcodemap 到内存缓存（非阻塞，失败只打日志，缓存保持为空对象兜底）
        export async function loadCloudStockCodeMap() {
            try {
                state._scMapCache = await pullStockCodeMapFromCloud();
                console.log('stockcodemap 加载完成:', Object.keys(state._scMapCache).length, '只股票');
            } catch (e) {
                console.warn('loadCloudStockCodeMap 失败:', e && e.message);
                if (!state._scMapCache) state._scMapCache = {};
            }
        }

        // 同步读取单只股票代码（渲染/业务逻辑路径用，读内存缓存，不发请求）
        export function getStockCode(name) {
            if (!name) return '';
            const n = String(name).trim();
            if (state._scMapCache && state._scMapCache[n]) return state._scMapCache[n];
            return '';
        }

        /**
         * ★★ [CODE-ON-DEMAND 2026-11-05] 内存缓存里查不到的股票名，按需去 `stockcodemap` 补一次。
         *
         * 为什么需要（E2E 实测踩到）：
         *   观察组壳行（上海洗霸 / 大洋电机）在页面加载早期 `state._scMapCache` 还没装到它们，
         *   `getStockCode` 返回 '' ⇒ 补数层按「没有 6 位代码就不能查上游」把它们过滤掉
         *   ⇒ 这两只的竞价量永远补不上（日志：「展示名单 78 只，其中带 6 位代码 76 只」）。
         *   缓存是异步装的，等它自己到货是不可靠的；这里按名精确补一次（1 个请求）。
         *
         * §40：只查表，⛔ 不猜代码；查不到就如实返回空，调用方照旧跳过。
         * §10：读失败向上抛，⛔ 不伪装成「这只票没有代码」。
         *
         * @param {string[]} names 股票名数组
         * @returns {Promise<Map<string,string>>} 名字 → 6 位代码（只含查到的）
         */
        export async function resolveStockCodes(names) {
            const want = Array.from(new Set((names || []).map(function(n) { return String(n || '').trim(); })
                .filter(function(n) { return n && !getStockCode(n); })));
            const out = new Map();
            if (want.length === 0) return out;
            const sb = getSupabase();
            const { data, error } = await sb.from('stockcodemap').select('stock,code').in('stock', want);
            if (error) throw error;
            if (!state._scMapCache) state._scMapCache = {};
            (data || []).forEach(function(row) {
                if (!row || !row.stock || !row.code) return;
                const n = String(row.stock).trim();
                const c = String(row.code).trim();
                if (!n || !/^\d{6}$/.test(c)) return;
                state._scMapCache[n] = c;   // 顺手把缓存补上，后续同步读也能命中
                out.set(n, c);
            });
            _dbgLog('[CODE-ON-DEMAND] 按名补代码 ' + out.size + '/' + want.length
                + (out.size ? '：' + Array.from(out.keys()).slice(0, 8).join(',') : ''));
            return out;
        }

        // upsert 一批 {stock, code} 到云端 stockcodemap，并同步更新内存缓存
        export async function upsertStockCodeMap(pairs) {
            if (!pairs || pairs.length === 0) return;
            const sb = getSupabase();
            const now = new Date().toISOString();
            const rows = pairs
                .filter(function(p) { return p && p.stock && p.code; })
                .map(function(p) { return { stock: p.stock.trim(), code: String(p.code).trim(), updated_at: now }; })
                .filter(function(p) { return p.stock && p.code; });
            if (rows.length === 0) return;
            const { error } = await sb.from('stockcodemap')
                .upsert(rows, { onConflict: 'stock' });
            if (error) throw error;
            if (!state._scMapCache) state._scMapCache = {};
            rows.forEach(function(r) { state._scMapCache[r.stock] = r.code; });
        }

        // 启动 stockcodemap 表的 Realtime 订阅（跨设备同步，直接更新内存缓存，无需整表重拉）
        export function startStockCodeMapRealtime() {
            stopStockCodeMapRealtime();
            try {
                const sb = getSupabase();
                state._scMapChannel = sb
                    .channel('stockcodemap_changes')
                    .on('postgres_changes', {
                        event: '*', schema: 'public', table: 'stockcodemap'
                    }, function(payload) {
                        if (!state._scMapCache) state._scMapCache = {};
                        if (payload.eventType === 'DELETE') {
                            const oldStock = payload.old && payload.old.stock;
                            if (oldStock) delete state._scMapCache[oldStock.trim()];
                        } else {
                            const row = payload.new;
                            if (row && row.stock && row.code) {
                                state._scMapCache[row.stock.trim()] = String(row.code).trim();
                            }
                        }
                    })
                    .subscribe();
                console.log('stockcodemap Realtime 订阅已启动');
            } catch (e) { _dbgLog('[AUCTION-ERR] stockcodemap Realtime 订阅失败 ' + (e && e.message || e)); }
        }

        export function stopStockCodeMapRealtime() {
            if (state._scMapChannel) {
                try { getSupabase().removeChannel(state._scMapChannel); } catch(e) {}
                state._scMapChannel = null;
            }
        }
