        // ===== stockcodemap 表操作（股票名↔代码映射唯一真相源，取代旧的本地 localStorage.stockCodeMap）=====
        // 内存缓存 _scMapCache 保留（读取性能），但不再落 localStorage；跨设备一致性靠 Realtime 订阅维护。

        // 全量加载 stockcodemap 到内存缓存，返回 {stockName: code}
        export async function pullStockCodeMapFromCloud() {
            const sb = window.getSupabase();
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
                window._scMapCache = await window.pullStockCodeMapFromCloud();
                console.log('stockcodemap 加载完成:', Object.keys(window._scMapCache).length, '只股票');
            } catch (e) {
                console.warn('window.loadCloudStockCodeMap 失败:', e && e.message);
                if (!window._scMapCache) window._scMapCache = {};
            }
        }

        // 同步读取单只股票代码（渲染/业务逻辑路径用，读内存缓存，不发请求）
        export function getStockCode(name) {
            if (!name) return '';
            const n = String(name).trim();
            if (window._scMapCache && window._scMapCache[n]) return window._scMapCache[n];
            return '';
        }

        // upsert 一批 {stock, code} 到云端 stockcodemap，并同步更新内存缓存
        export async function upsertStockCodeMap(pairs) {
            if (!pairs || pairs.length === 0) return;
            const sb = window.getSupabase();
            const now = new Date().toISOString();
            const rows = pairs
                .filter(function(p) { return p && p.stock && p.code; })
                .map(function(p) { return { stock: p.stock.trim(), code: String(p.code).trim(), updated_at: now }; })
                .filter(function(p) { return p.stock && p.code; });
            if (rows.length === 0) return;
            const { error } = await sb.from('stockcodemap')
                .upsert(rows, { onConflict: 'stock' });
            if (error) throw error;
            if (!window._scMapCache) window._scMapCache = {};
            rows.forEach(function(r) { window._scMapCache[r.stock] = r.code; });
        }

        // 启动 stockcodemap 表的 Realtime 订阅（跨设备同步，直接更新内存缓存，无需整表重拉）
        export function startStockCodeMapRealtime() {
            window.stopStockCodeMapRealtime();
            try {
                const sb = window.getSupabase();
                window._scMapChannel = sb
                    .channel('stockcodemap_changes')
                    .on('postgres_changes', {
                        event: '*', schema: 'public', table: 'stockcodemap'
                    }, function(payload) {
                        if (!window._scMapCache) window._scMapCache = {};
                        if (payload.eventType === 'DELETE') {
                            const oldStock = payload.old && payload.old.stock;
                            if (oldStock) delete window._scMapCache[oldStock.trim()];
                        } else {
                            const row = payload.new;
                            if (row && row.stock && row.code) {
                                window._scMapCache[row.stock.trim()] = String(row.code).trim();
                            }
                        }
                    })
                    .subscribe();
                console.log('stockcodemap Realtime 订阅已启动');
            } catch (e) { window._dbgLog('[AUCTION-ERR] stockcodemap Realtime 订阅失败 ' + (e && e.message || e)); }
        }

        export function stopStockCodeMapRealtime() {
            if (window._scMapChannel) {
                try { window.getSupabase().removeChannel(window._scMapChannel); } catch(e) {}
                window._scMapChannel = null;
            }
        }
