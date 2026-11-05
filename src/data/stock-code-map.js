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
         * ★★ [CODE-CACHE-WRITE 2026-11-05] 把已解析到的「名称→代码」写回内存缓存（**只写内存，不发请求**）。
         *
         * 谁用：`data/stock-code-resolver.js` 的多级兜底解析出结果后调这里回写，
         *   让后续**同步**路径（`getStockCode` / 视图层壳行注入）也能命中 —— 0 请求、0 延迟。
         *
         * 为什么不在 resolver 里直接改 `state._scMapCache`：
         *   内存缓存的**唯一写入者**必须是本模块（§6 单一真相）。否则「谁都能改缓存」，
         *   下次又会出现「两个地方各写一份、写法还不一样」的老毛病。
         *   持久化（写云端 stockcodemap）仍走 `upsertStockCodeMap`，⛔ 本函数绝不落库。
         *
         * §40：只收 6 位数字代码；其余一律丢弃（不猜、不补零）。
         *
         * @param {Iterable<{stock:string, code:string}>|Map<string,string>|Object} pairs
         * @returns {number} 实际写入条数
         */
        export function rememberStockCodes(pairs) {
            if (!state._scMapCache) state._scMapCache = {};
            let n = 0;
            const put = function(name, code) {
                const s = String(name || '').trim();
                const c = String(code || '').trim();
                if (!s || !/^\d{6}$/.test(c)) return;
                if (state._scMapCache[s] === c) return;
                state._scMapCache[s] = c;
                n++;
            };
            if (pairs instanceof Map) {
                pairs.forEach(function(c, s) { put(s, c); });
            } else if (pairs && typeof pairs === 'object') {
                // 兼容 resolveCodesByNames 的 {名称: 代码} 返回形状
                Object.keys(pairs).forEach(function(s) { put(s, pairs[s]); });
            }
            return n;
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
