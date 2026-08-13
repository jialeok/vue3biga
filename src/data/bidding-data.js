import { _emit } from '../stores/eventBus.js';
import { state } from '../logic/app-state.js';
        // ===== bidding_data 表操作（竞价变化看板独立表）=====

        import { getSupabase, _moduleKey, getBiddingData } from './supabase-client.js';
        import { _dbgLog } from './debug-log.js';
        import { _openAuctionShield, _closeAuctionShield } from './session-and-shield.js';

        // 清理竞价变化行：封单家数只应出现在 9:25（内部字段 time925，对应 bidding_data 表 DB 列 time925）列，收盘列不应有值
        export function sanitizeBiddingRow(row) {
            if (!row) return row;
            if (row.name && row.name.trim() === '封单家数') {
                row.close = '';
            }
            return row;
        }

        // 从 bidding_data 表全量读取，返回 {date: [rows]}
        export async function pullBiddingFromTable() {
            const sb = getSupabase();
            const result = {};
            let offset = 0;
            const pageSize = 1000;
            while (true) {
                const { data, error } = await sb.from('bidding_data')
                    .select('"date",name,time915,time920,time925,"change",close')
                    .range(offset, offset + pageSize - 1);
                if (error) throw error;
                if (!data || data.length === 0) break;
                data.forEach(function(row) {
                    if (!row || !row.date || !row.name) return;
                    // 兼容旧行名：'9点25分封单家数' -> '封单家数'
                    if (row.name.trim() === '9点25分封单家数') row.name = '封单家数';
                    sanitizeBiddingRow(row);
                    if (!result[row.date]) result[row.date] = [];
                    var item = {
                        name: row.name,
                        time915: row.time915 || '',
                        time920: row.time920 || '',
                        time925: row.time925 || '',
                        change: row.change || '',
                        close: row.close || ''
                    };
                    result[row.date].push(item);
                });
                if (data.length < pageSize) break;
                offset += pageSize;
            }
            state._biddingTableAvailable = true;
            return result;
        }

        // 拉取单日 bidding 数据并合并到本地
        export async function pullBiddingForDate(date) {
            if (!date) return;
            // [BUG-FIX] 如果该日期正在推送到云端，跳过本次拉取，避免把云端的旧/空值覆盖本地新编辑。
            if (state._biddingPushInFlight && state._biddingPushInFlight.has(date)) {
                _dbgLog('[BIDDING-PULL] 跳过 ' + date + '，该日期正在推送中');
                return;
            }
            const sb = getSupabase();
            const { data, error } = await sb.from('bidding_data')
                .select('name,time915,time920,time925,"change",close')
                .eq('"date"', date);
            if (error) throw error;
            if (!data || data.length === 0) return;
            const rows = data.map(function(row) {
                // 兼容旧行名：'9点25分封单家数' -> '封单家数'
                if (row.name && row.name.trim() === '9点25分封单家数') row.name = '封单家数';
                sanitizeBiddingRow(row);
                return {
                    name: row.name,
                    time915: row.time915 || '',
                    time920: row.time920 || '',
                    time925: row.time925 || '',
                    change: row.change || '',
                    close: row.close || ''
                };
            });
            // 直接写入持久内存缓存（bidding 已不落 localStorage）
            const biddingData = getBiddingData();
            biddingData[date] = rows;
            state._biddingTableAvailable = true;
        }

        // 当日竞价变化数据 UPSERT 到 bidding_data 表

        export async function pushBiddingToCloud(date) {
            // 注：不再用 _biddingTableAvailable 做早退保护。该表已长期稳定使用，
            // 之前"表不可用时跳过"是为了兼容表还没建好的过渡期，但这个标记要等
            // 应用启动时的整体云端同步全部跑完才会置 true，如果同步过程中前面
            // 某一步失败，甚至可能永远不会置 true——保存会静默失败、不报任何错，
            // 这正是"保存后能看到、一刷新就消失"的根源。真正需要保护的场景
            // （表确实不存在）交给下面的 try/error 处理即可。
            state._justPushedBidding = true; // 标记自己推送，5秒内忽略 Realtime 通知
            setTimeout(function() { state._justPushedBidding = false; }, 5000);
            if (date) {
                state._biddingPushInFlight.add(date);
                state._biddingDirtyDates.add(date);
            }
            try {
                const sb = getSupabase();
                const biddingData = getBiddingData()[date] || [];
                if (biddingData.length === 0) return;
                const now = new Date().toISOString();
                const rows = biddingData.filter(function(r) { return r && r.name; }).map(function(item) {
                    sanitizeBiddingRow(item);
                    return {
                        date: date,
                        name: item.name,
                        time915: item.time915 || '',
                        time920: item.time920 || '',
                        time925: item.time925 || '',
                        change: item.change || '',
                        close: item.close || '',
                        updated_at: now
                    };
                });
                if (rows.length === 0) return;
                // [安全网] 避免空表单/空模板覆盖云端已有数据。如果所有行的业务字段均为空，
                // 大概率是"本地数据未加载就保存"或"误点保存"，此时跳过 upsert 并告警。
                const hasAnyValue = rows.some(function(r) {
                    return (r.time915 && r.time915.trim() !== '') ||
                           (r.time920 && r.time920.trim() !== '') ||
                           (r.time925 && r.time925.trim() !== '') ||
                           (r.change && r.change.trim() !== '') ||
                           (r.close && r.close.trim() !== '');
                });
                if (!hasAnyValue) {
                    _dbgLog('[BIDDING-PUSH] 跳过 ' + date + ' 的空数据推送，避免覆盖云端已有数据');
                    console.warn('[BIDDING-PUSH] 跳过空数据推送:', date);
                    return;
                }
                const { error } = await sb.from('bidding_data')
                    .upsert(rows, { onConflict: 'date,name' });
                if (error) throw error;
                state._biddingTableAvailable = true; // 推送成功即证明表可用
                // 推送成功：该日期的本地编辑已同步，可从脏标记中移除
                if (date) state._biddingDirtyDates.delete(date);
                _dbgLog('[BIDDING-PUSH] 成功推送 ' + date + ' 共 ' + rows.length + ' 行');
            } finally {
                if (date) state._biddingPushInFlight.delete(date);
            }
        }

        // 删除"云端有但本地表单里没有"的行（用户在编辑表单里点"删"掉的行）。
        // 之前 pushBiddingToCloud 只 upsert 不 delete：表单里删掉一行再保存，云端那行还在，
        // 下次拉取又"复活"——表现为"删也删不掉"。保存成功后调用本函数把多余的行真正删掉。
        // 安全前提：表单行来自 getTodayBidding()（云端全量），Worker 自动写入的行也在表单里，
        // 只有用户手动点"删"的行才会进入删除名单。
        export async function syncBiddingDeletionsToCloud(date) {
            if (date) state._biddingPushInFlight.add(date);
            try {
                const sb = getSupabase();
                const localNames = new Set((getBiddingData()[date] || [])
                    .map(function(r) { return ((r && r.name) || '').trim(); })
                    .filter(function(n) { return n; }));
                const { data: cloudRows, error } = await sb.from('bidding_data')
                    .select('name').eq('date', date);
                if (error) throw error;
                const toDelete = (cloudRows || [])
                    .map(function(r) { return ((r && r.name) || '').trim(); })
                    .filter(function(n) { return n && !localNames.has(n); });
                if (toDelete.length === 0) return;
                state._justPushedBidding = true; // 删除也会触发 Realtime，同样屏蔽
                setTimeout(function() { state._justPushedBidding = false; }, 5000);
                const { error: delErr } = await sb.from('bidding_data')
                    .delete().eq('date', date).in('name', toDelete);
                if (delErr) throw delErr;
                _dbgLog('[BIDDING-DELETE] 成功删除 ' + date + ' 的 ' + toDelete.length + ' 个幽灵行: ' + toDelete.join(','));
            } finally {
                if (date) state._biddingPushInFlight.delete(date);
            }
        }

        // 删除 bidding_data 表中某天的全部数据（用于"清除当天数据"功能）。
        // 之前该操作只清内存，云端表行还在，下次刷新/Realtime 会把数据"复活"。
        export async function deleteBiddingFromCloud(date) {
            if (!date) return;
            state._justPushedBidding = true;
            setTimeout(function() { state._justPushedBidding = false; }, 5000);
            const sb = getSupabase();
            const { error } = await sb.from('bidding_data').delete().eq('date', date);
            if (error) throw error;
        }

        // 删除 auction_watchlist 与 market_metrics(scope='auction') 中某天的全部数据
        // （阶段四 Bug 3 修复：与 bidding 对齐，"清空当日数据"原本只 delete allData.auction[state.currentDate]，
        //  云端行还在，下次刷新/Realtime 会把数据"复活"）
        export async function deleteAuctionFromCloud(date) {
            if (!date) return;
            if (!state._auctionTableAvailable && !state._marketMetricsTableAvailable) return;
            _openAuctionShield();
            try {
                const sb = getSupabase();
                let beforeCount = 0;
                if (state._auctionTableAvailable) {
                    const beforeRes = await sb.from('auction_watchlist')
                        .select('stock', { count: 'exact', head: true })
                        .eq('date', date);
                    beforeCount += (beforeRes.count || 0);
                }
                if (state._marketMetricsTableAvailable) {
                    const beforeRes = await sb.from('market_metrics')
                        .select('stock', { count: 'exact', head: true })
                        .eq('date', date)
                        .eq('scope', 'auction');
                    beforeCount += (beforeRes.count || 0);
                }
                _dbgLog('[AUCTION-DELETE] 准备删除 ' + date + ' 的云端行，删除前 ' + beforeCount + ' 条');

                if (state._auctionTableAvailable) {
                    const { error } = await sb.from('auction_watchlist').delete().eq('date', date);
                    if (error) throw error;
                }
                if (state._marketMetricsTableAvailable) {
                    const { error } = await sb.from('market_metrics')
                        .delete()
                        .eq('date', date)
                        .eq('scope', 'auction');
                    if (error) throw error;
                }

                // 校验：必须真的删掉，防止列名引号/RLS 等导致 delete 返回成功却未命中
                let afterCount = 0;
                if (state._auctionTableAvailable) {
                    const afterRes = await sb.from('auction_watchlist')
                        .select('stock', { count: 'exact', head: true })
                        .eq('date', date);
                    afterCount += (afterRes.count || 0);
                }
                if (state._marketMetricsTableAvailable) {
                    const afterRes = await sb.from('market_metrics')
                        .select('stock', { count: 'exact', head: true })
                        .eq('date', date)
                        .eq('scope', 'auction');
                    afterCount += (afterRes.count || 0);
                }
                if (afterCount > 0) {
                    throw new Error('delete 执行后仍有 ' + afterCount + ' 条记录残留（删除前 ' + beforeCount + ' 条）');
                }
                _dbgLog('[AUCTION-DELETE] 已删除 ' + date + ' 的 ' + beforeCount + ' 条云端行');
            } finally {
                _closeAuctionShield(2000);
            }
        }

        // 一次性迁移：将本地 allData.bidding 灌入 bidding_data 表
        export async function migrateBiddingToTable() {
            if (localStorage.getItem('_bidding_table_migrated') === '1') {
                state._biddingTableAvailable = true; // 已迁移过，标记表可用
                return;
            }
            // 直接读取本机 localStorage 里现存的旧快照（可能是拆表前，或本次修复前遗留的）。
            // loadAllData()/getBiddingData() 已改为不再读取 localStorage 的 bidding 数据，
            // 所以这里必须绕过它们，直接读原始 key，避免把设备上现存的本地数据白白漏掉。
            let biddingData = {};
            try {
                const raw = localStorage.getItem(_moduleKey('bidding'));
                if (raw) biddingData = JSON.parse(raw) || {};
            } catch (e) { biddingData = {}; }
            const dates = Object.keys(biddingData).filter(function(d) {
                return Array.isArray(biddingData[d]) && biddingData[d].length > 0;
            });
            if (dates.length === 0) {
                // 本地无数据，检查表是否可用（尝试读一行）
                try {
                    const sb = getSupabase();
                    const { data, error } = await sb.from('bidding_data').select('"date"').limit(1);
                    if (!error) {
                        state._biddingTableAvailable = true;
                        localStorage.setItem('_bidding_table_migrated', '1');
                        console.log('[迁移] 本地无 bidding 数据，bidding_data 表已就绪');
                    }
                } catch(e) { console.warn('[迁移] bidding_data 表不可用:', e.message); }
                return;
            }
            const sb = getSupabase();
            const now = new Date().toISOString();
            let totalRows = 0;
            let hadError = false;
            for (let di = 0; di < dates.length; di++) {
                var date = dates[di];
                var rows = biddingData[date].filter(function(r) { return r && r.name; }).map(function(item) {
                    // 迁移旧本地数据时清理：封单家数的收盘列不应有值
                    sanitizeBiddingRow(item);
                    return {
                        date: date,
                        name: item.name,
                        time915: item.time915 || '',
                        time920: item.time920 || '',
                        time925: item.time930 || '',
                        change: item.change || '',
                        close: item.close || '',
                        updated_at: now
                    };
                });
                if (rows.length === 0) continue;
                try {
                    var { error } = await sb.from('bidding_data')
                        .upsert(rows, { onConflict: 'date,name', ignoreDuplicates: true });
                    if (error) {
                        console.warn('[迁移] bidding_data 日期', date, '失败:', error.message);
                        hadError = true;
                    } else {
                        totalRows += rows.length;
                    }
                } catch(e) {
                    console.warn('[迁移] bidding_data 日期', date, '异常:', e.message);
                    hadError = true;
                }
            }
            if (!hadError) {
                state._biddingTableAvailable = true;
                localStorage.setItem('_bidding_table_migrated', '1');
                // 迁移确认成功后清除本地旧快照，云端表从此是唯一数据源
                try { localStorage.removeItem(_moduleKey('bidding')); } catch (e) {}
                console.log('[迁移] bidding_data 迁移完成:', totalRows, '行');
            }
        }

        // 启动 bidding_data 表的 Realtime 订阅（其它设备保存时自动刷新）
        export function startBiddingRealtime() {
            stopBiddingRealtime();
            try {
                const sb = getSupabase();
                state._biddingRealtimeChannel = sb
                    .channel('bidding_data_changes')
                    .on('postgres_changes', {
                        event: '*', schema: 'public', table: 'bidding_data'
                    }, function(payload) {
                        if (state._justPushedBidding) return; // 自己刚推的，忽略
                        const row = payload.new || payload.old;
                        if (!row || !row.date) return;
                        const changedDate = row.date;
                        // 拉取该日期的最新竞价数据并刷新看板
                        pullBiddingForDate(changedDate).then(function() {
                            if (changedDate === state.currentDate) _emit('data:realtime-update', { boards: 'bidding' });
                        }).catch(function(e) { _dbgLog('[AUCTION-ERR] Bidding Realtime 拉取失败 ' + (e && e.message || e)); });
                    })
                    .subscribe();
                console.log('Bidding Realtime 订阅已启动');
            } catch (e) { _dbgLog('[AUCTION-ERR] Bidding Realtime 订阅失败 ' + (e && e.message || e)); }
        }

        export function stopBiddingRealtime() {
            if (state._biddingRealtimeChannel) {
                try { getSupabase().removeChannel(state._biddingRealtimeChannel); } catch(e) {}
                state._biddingRealtimeChannel = null;
            }
        }

        // 竞价变化看板固定行顺序（写死，去掉旧模板/localStorage 逻辑）。
        // 前台展示与后台编辑弹窗统一按此顺序，避免按插入顺序 / DB 扫描顺序乱序。
        export const BIDDING_ROW_ORDER = [
            '最近多板%',
            '最近多板%time26',
            '板块ETF(48)',
            '昨日资金前十',
            '大盘ETF',
            '大盘（%）',
            '封单家数',
            '账号溢价'
        ];

        // 按固定顺序排序竞价行；列表中未出现的行（如用户自定义行）保持原相对顺序追加在末尾。
        export function orderBiddingRows(rows) {
            if (!Array.isArray(rows)) return rows;
            const idxOf = new Map();
            BIDDING_ROW_ORDER.forEach(function(n, i) { idxOf.set(n, i); });
            const placed = [];
            const unknown = [];
            rows.forEach(function(r) {
                const name = (r && r.name || '').trim();
                if (idxOf.has(name)) {
                    const pos = idxOf.get(name);
                    if (placed[pos] === undefined) placed[pos] = r;
                    else unknown.push(r); // 同名重复行，多余者追加末尾
                } else {
                    unknown.push(r);
                }
            });
            const result = [];
            for (let i = 0; i < BIDDING_ROW_ORDER.length; i++) {
                if (placed[i] !== undefined) result.push(placed[i]);
            }
            unknown.forEach(function(r) { result.push(r); });
            return result;
        }

        // 默认模板（仅用于诊断展示）。不再读写 localStorage 模板，直接返回写死的固定顺序。
        export function getDefaultBiddingTemplate() {
            return BIDDING_ROW_ORDER.map(function(n) { return { name: n }; });
        }

        export async function fetchBiddingCloudRows(date) {
            const sb = getSupabase();
            const { data, error } = await sb.from('bidding_data')
                .select('name,time915,time920,time925,"change",close')
                .eq('date', date);
            if (error) throw error;
            // [字段映射] DB 列已统一为 time925（实际存 9:25 竞价数据），内部直接使用 time925
            return (data || []).map(function(r) {
                const result = {};
                Object.keys(r).forEach(function(k) { if (k !== 'time925') result[k] = r[k]; });
                result.time925 = r.time925 || '';
                return result;
            });
        }
